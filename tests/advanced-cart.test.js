// Unit tests for the M5 GM-authoritative safe multi-item cart checkout in
// `src/advanced/cart.js`.
//
// These are pure Node tests (no Foundry globals) using a fake store, a fake
// actor, and a fake adapter, plus the real lock map so a checkout can be shown to
// share the per-shop lock with purchases. They cover the two-line success path
// and its exact side effects, canonical sorted-intent idempotency, the validation
// gates (duplicate line, fake actor, restricted/hidden entry, Hated reputation,
// insufficient funds, insufficient stock), the compensation paths (a second-line
// delivery failure that refunds and removes the first, a shop update failure, an
// ambiguous recovery that escalates to needsRecovery), the overflow and merchant
// funds guards, and the shared per-shop lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCartCommerce } from '../src/advanced/cart.js';
import { normalizeShop, makeId } from '../src/services/model.js';
import { createLockMap } from '../src/services/commerce.js';
import { fingerprintItem } from '../src/advanced/valuation.js';

// ---------------------------------------------------------------- helpers

export function makeEntry(overrides = {}) {
  const {
    id = 'entry1',
    name = 'Potion',
    price = 100,
    quantity = 10,
    stockMode = 'finite',
    visible = true,
    itemUuid = '',
    snapshot = JSON.stringify({ name, img: 'icons/potion.png', system: { quantity: 1 } }),
    access,
  } = overrides;
  return {
    id,
    name,
    price,
    quantity,
    stockMode,
    visible,
    itemUuid,
    snapshot,
    access,
  };
}

export function createMockActor({ wallet = 1000, uuid = 'Actor.actor1' } = {}) {
  return {
    id: 'actor1',
    name: 'Player',
    uuid,
    wallet,
    items: new Map(),
    async update() {
      return this;
    },
  };
}

/**
 * Build a minimal embedded-Item document for the mock actor. `toObject()` returns
 * a fresh copy of the item data (carrying `_id`/`system`), so the barter tender and
 * the shop buyback listing both behave like a real Foundry embedded Item.
 */
export function makeEmbeddedItem({
  id,
  name = 'Barter Item',
  img = '',
  quantity = 1,
  parent = null,
  extraSystem = {},
} = {}) {
  const data = {
    _id: id,
    name,
    img,
    type: 'gear',
    system: { quantity, ...extraSystem },
  };
  return {
    id,
    documentName: 'Item',
    parent,
    _data: data,
    toObject() {
      return structuredClone(data);
    },
  };
}

/**
 * A mock actor that carries embedded Items and supports delete/create of embedded
 * documents, so the barter tender removal and its compensation restore can be
 * exercised. `items` is an array of `makeEmbeddedItem` specs.
 */
export function makeBarterActor({ wallet = 1000, uuid = 'Actor.actor1', items = [] } = {}) {
  const actor = createMockActor({ wallet, uuid });
  const itemMap = new Map();
  for (const spec of items) {
    const doc = makeEmbeddedItem({ ...spec, parent: actor });
    itemMap.set(doc.id, doc);
  }
  actor.items = itemMap;
  actor.deletedIds = [];
  actor.restoredIds = [];
  actor.deleteEmbeddedDocuments = async (type, ids) => {
    for (const id of ids) {
      if (itemMap.get(id)) actor.deletedIds.push(id);
      itemMap.delete(id);
    }
  };
  actor.createEmbeddedDocuments = async (type, dataArray, { keepId = false } = {}) => {
    const created = [];
    for (const data of dataArray) {
      const id = keepId && data._id ? data._id : data._id || makeId();
      const doc = makeEmbeddedItem({
        id,
        name: data.name || 'Barter Item',
        img: data.img || '',
        quantity: data.system?.quantity ?? 1,
        parent: actor,
      });
      itemMap.set(id, doc);
      created.push(doc);
      if (keepId) actor.restoredIds.push(id);
    }
    return created;
  };
  return actor;
}

export function makeAdapter({
  failDeliveryOn = null,
  removeFails = false,
  creditFails = false,
  itemPrice = 100,
  deliveryMode = 'embedded',
  quantityPath = '',
  debitThrows = false,
} = {}) {
  let deliverCount = 0;
  const adapter = {
    supported: true,
    deliveryMode,
    quantityPath,
    itemPrice,
    removedIds: [],
    async getBalance(actor) {
      return actor.wallet || 0;
    },
    async getItemPrice(item) {
      return { minorUnits: itemPrice };
    },
    async debit(actor, amount) {
      if (debitThrows) throw new Error('debit failed');
      if (actor.wallet < amount) throw new Error('insufficient funds');
      actor.wallet = (actor.wallet || 0) - amount;
      return { amount, newBalance: actor.wallet };
    },
    async credit(actor, amount) {
      if (creditFails) throw new Error('credit failed');
      actor.wallet = (actor.wallet || 0) + amount;
      return { amount, newBalance: actor.wallet };
    },
    async deliverItem(actor, item, { quantity = 1 } = {}) {
      deliverCount += 1;
      if (failDeliveryOn != null && deliverCount === failDeliveryOn) {
        throw new Error('deliver failed');
      }
      return { id: `delivered-${makeId()}`, item };
    },
    async removeItem(actor, id) {
      if (removeFails) throw new Error('remove failed');
      adapter.removedIds.push(id);
      return true;
    },
  };
  return adapter;
}

export function makeShop({
  inventory = [],
  funds = null,
  open = true,
  specials = [],
  valuations = [],
} = {}) {
  return normalizeShop({
    id: 'shop1',
    name: 'General Store',
    locationId: 'home',
    open,
    inventory,
    commerce: { funds, specials, valuations },
  });
}

export function createFakeStore({ shop } = {}) {
  const shops = new Map();
  if (shop) shops.set(shop.id, shop);
  const orders = new Map();
  const state = {
    findShopCalls: 0,
    updateShopCalls: 0,
    findOrderCalls: 0,
    createOrderCalls: 0,
    updateOrderCalls: 0,
    failUpdateShop: false,
    nullUpdateShop: false,
    failOrderCommit: false,
    nullOrderCommit: false,
    commitAppliesThenThrows: false,
    failFindOrder: false,
  };
  const store = {
    state,
    _shops: shops,
    _orders: orders,
    async findShop(id) {
      state.findShopCalls += 1;
      return shops.get(id) || null;
    },
    async updateShop(id, patch) {
      state.updateShopCalls += 1;
      if (state.failUpdateShop) {
        state.failUpdateShop = false;
        throw new Error('shop update failed');
      }
      if (state.nullUpdateShop) {
        state.nullUpdateShop = false;
        return null;
      }
      const current = shops.get(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      shops.set(id, next);
      return next;
    },
    async findAdvancedOrderByKey(key) {
      state.findOrderCalls += 1;
      return orders.get(key) || null;
    },
    async createAdvancedOrder(record) {
      state.createOrderCalls += 1;
      const normalized = { ...record, id: record.id || makeId() };
      const existing = orders.get(normalized.key);
      if (existing) return { record: existing, created: false };
      // Mirror the store's fail-closed normalizer: an oversized `details` must
      // throw BEFORE any effect is recorded (the checkout must fail before debit).
      if (JSON.stringify(normalized.details || {}).length > 64 * 1024) {
        throw new Error("'advancedOrder.details' must be at most 65536 chars");
      }
      orders.set(normalized.key, normalized);
      return { record: normalized, created: true };
    },
    async updateAdvancedOrder(id, patch) {
      state.updateOrderCalls += 1;
      if (state.failOrderCommit && patch.status === 'committed') {
        state.failOrderCommit = false;
        throw new Error('commit failed');
      }
      if (state.nullOrderCommit && patch.status === 'committed') {
        state.nullOrderCommit = false;
        return null;
      }
      // Apply-then-throw commit: persist the patch, then throw, exactly as a store
      // that commits and loses the reply before the caller observes it.
      const appliedThenThrew =
        state.commitAppliesThenThrows && patch.status === 'committed';
      if (appliedThenThrew) state.commitAppliesThenThrows = false;
      for (const [key, rec] of orders) {
        if (rec.id === id) {
          const next = { ...rec, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
          orders.set(key, next);
          if (appliedThenThrew) throw new Error('commit failed after apply');
          return next;
        }
      }
      if (appliedThenThrew) throw new Error('commit failed after apply');
      return null;
    },
    async findAdvancedOrder(id) {
      if (state.failFindOrder) {
        state.failFindOrder = false;
        throw new Error('read failed');
      }
      for (const rec of orders.values()) {
        if (rec.id === id) return rec;
      }
      return null;
    },
  };
  return store;
}

export function makeCartCommerce({
  store,
  actor,
  adapter,
  isActiveGM = () => true,
  actorOwnedBy = () => true,
  getSocial,
  getWorldTime,
  now = null,
  fromUuid,
  getActor,
  runShopExclusive,
  getApprovedValuation,
} = {}) {
  return createCartCommerce({
    store,
    runShopExclusive: runShopExclusive || ((shopId, fn) => fn()),
    isActiveGM,
    getActor: getActor || (async (id) => (actor && actor.id === id ? actor : null)),
    actorOwnedBy,
    getAdapter: () => adapter,
    fromUuid: fromUuid || (async () => null),
    getSocial,
    getWorldTime,
    now,
    // Test fixture: a GM-approved valuation, so the effectful barter path stays
    // exercisable. When the shop fixture carries a matching GM-private valuation for
    // this actor+item, the entry (with its fingerprint verified) is returned so the
    // checkout consumes it at commit; when no valuation is seeded, the fixture falls
    // back to the adapter's numeric item-price value (legacy behavior). The runtime
    // (no `getApprovedValuation`) refuses `gm-approval-required`.
    getApprovedValuation:
      getApprovedValuation ??
      (async (item, shopArg) => {
        const shop =
          shopArg || (store && store._shops && store._shops.get('shop1')) || null;
        const valuations =
          (shop && shop.commerce && Array.isArray(shop.commerce.valuations)
            ? shop.commerce.valuations
            : []) || [];
        const entry = valuations.find(
          (v) => v.actorUuid === 'Actor.actor1' && v.itemId === (item && item.id)
        );
        if (!entry) return adapter.itemPrice ?? 100;
        let fp;
        try {
          fp = fingerprintItem(item);
        } catch {
          return null;
        }
        return fp === entry.fingerprint ? entry : null;
      }),
    logger: { error: () => {} },
  });
}

export function basePayload(overrides = {}) {
  return {
    shopId: 'shop1',
    actorId: 'actor1',
    lines: [{ entryId: 'entry1', quantity: 2 }],
    requestId: 'req-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------- success

test('checkout commits a two-line cart and applies exactly the effects', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 10 }),
      makeEntry({ id: 'entry2', name: 'Sword', price: 500, quantity: 5 }),
    ],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }, { entryId: 'entry2', quantity: 1 }] }),
    'gm1'
  );

  assert.equal(res.status, 'committed');
  assert.ok(res.orderId);
  assert.equal(res.total, 700); // 100*2 + 500*1
  assert.equal(res.quantity, 3);
  assert.deepEqual(
    res.items.map((i) => ({ entryId: i.entryId, quantity: i.quantity })),
    [
      { entryId: 'entry1', quantity: 2 },
      { entryId: 'entry2', quantity: 1 },
    ]
  );

  // Actor debited once by the total.
  assert.equal(actor.wallet, 1000 - 700);

  // Single shop write decremented stock and incremented finite merchant funds.
  assert.equal(store.state.updateShopCalls, 1);
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory.find((e) => e.id === 'entry1').quantity, 8);
  assert.equal(stored.inventory.find((e) => e.id === 'entry2').quantity, 4);
  assert.equal(stored.commerce.funds, 1700);

  // Order committed with the documented bounded outcome.
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.kind, 'cart');
  assert.equal(order.status, 'committed');
  assert.equal(order.phase, 'final');
  assert.deepEqual(order.outcome, {
    total: 700,
    quantity: 3,
    barterCredit: 0,
    cashPaid: 700,
    items: [
      { entryId: 'entry1', name: 'Potion', quantity: 2 },
      { entryId: 'entry2', name: 'Sword', quantity: 1 },
    ],
  });
  assert.equal(order.total, 700);
  assert.equal(order.quantity, 3);
  // The private line breakdown is bounded and carries per-line snapshots.
  assert.equal(order.details.lines.length, 2);
  assert.equal(order.details.lines[0].entryId, 'entry1');
  assert.ok(order.details.lines[0].snapshot);
});

// ------------------------------------------------------- idempotency / sorting

test('a cart replayed with lines in a different order is a no-op replay, not a conflict', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 10 }),
      makeEntry({ id: 'entry2', name: 'Sword', price: 500, quantity: 5 }),
    ],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const first = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry2', quantity: 1 }, { entryId: 'entry1', quantity: 2 }] }),
    'gm1'
  );
  assert.equal(first.status, 'committed');

  const writes = store.state.updateShopCalls;
  const wallet = actor.wallet;

  // Same requestId/intent, lines reordered -> replay (hash sorted by entryId).
  const again = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }, { entryId: 'entry2', quantity: 1 }] }),
    'gm1'
  );
  assert.equal(again.status, 'replay');
  assert.equal(again.orderId, first.orderId);
  assert.equal(again.total, first.total);
  assert.equal(actor.wallet, wallet);
  assert.equal(store.state.updateShopCalls, writes);
  assert.equal(store._orders.size, 1);
});

test('a replayed committed cart never recharges or re-decrements', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const first = await service.checkout(basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }] }), 'gm1');
  assert.equal(first.status, 'committed');
  const wallet = actor.wallet;
  const writes = store.state.updateShopCalls;
  const qty = store._shops.get('shop1').inventory[0].quantity;

  const replay = await service.checkout(basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }] }), 'gm1');
  assert.equal(replay.status, 'replay');
  assert.equal(actor.wallet, wallet);
  assert.equal(store.state.updateShopCalls, writes);
  assert.equal(store._shops.get('shop1').inventory[0].quantity, qty);
});

test('pending order replay surfaces needsRecovery and never recharges', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  // Simulate an interrupted run that left a pending order with the same intent.
  const intentHash = service.checkout ? null : null;
  // Rebuild the exact hash the service would compute for this intent.
  const { computeCartIntentHash } = await import('../src/advanced/cart.js');
  store._orders.set('cart:gm1:req-1', {
    id: 'ord-pending',
    key: 'cart:gm1:req-1',
    kind: 'cart',
    status: 'pending',
    phase: 'recorded',
    shopId: 'shop1',
    userId: 'gm1',
    actorId: 'actor1',
    quantity: 2,
    total: 200,
    intentHash: computeCartIntentHash({
      shopId: 'shop1',
      actorId: 'actor1',
      lines: [{ entryId: 'entry1', quantity: 2 }],
      requester: 'gm1',
    }),
    details: {},
    outcome: {},
    error: '',
  });

  const res = await service.checkout(basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }] }), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.orderId, 'ord-pending');
  assert.equal(actor.wallet, 1000);
  assert.equal(store.state.updateShopCalls, 0);
});

test('same key with changed lines is a conflict and applies no effect', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', price: 100, quantity: 10 }),
      makeEntry({ id: 'entry2', price: 500, quantity: 5 }),
    ],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const first = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }] }),
    'gm1'
  );
  assert.equal(first.status, 'committed');
  const writes = store.state.updateShopCalls;

  const conflict = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry2', quantity: 1 }] }),
    'gm1'
  );
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.error, 'conflicting duplicate payload');
  assert.equal(conflict.orderId, first.orderId);
  assert.ok(conflict.expected);
  assert.equal(store.state.updateShopCalls, writes);
});

// ------------------------------------------------------ input / auth gates

test('a non-active-GM caller is rejected before any store read', async () => {
  const shop = makeShop({ inventory: [makeEntry()] });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    isActiveGM: () => false,
  });

  const res = await service.checkout(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'not-active-gm');
  assert.equal(store.state.findOrderCalls, 0);
  assert.equal(store.state.findShopCalls, 0);
  assert.equal(store.state.createOrderCalls, 0);
});

test('duplicate entry ids in the lines are rejected before any read effect', async () => {
  const shop = makeShop({ inventory: [makeEntry()] });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({ store, actor, adapter });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }, { entryId: 'entry1', quantity: 2 }] }),
    'gm1'
  );
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'duplicate-entry');
  assert.equal(store.state.createOrderCalls, 0);
});

test('more than CART_MAX_LINES lines is rejected', async () => {
  const inventory = [];
  for (let i = 0; i < 21; i += 1) inventory.push(makeEntry({ id: `entry${i}` }));
  const shop = makeShop({ inventory });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({ store, actor, adapter });

  const lines = inventory.map((e) => ({ entryId: e.id, quantity: 1 }));
  const res = await service.checkout(basePayload({ lines }), 'gm1');
  assert.equal(res.status, 'error');
  assert.match(res.error, /^too-many-lines/);
});

test('a fake actor is rejected as actor-not-found', async () => {
  const shop = makeShop({ inventory: [makeEntry()] });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getActor: async () => null,
  });

  const res = await service.checkout(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'actor-not-found');
  assert.equal(store.state.createOrderCalls, 0);
});

test('an actor the requester does not own is rejected', async () => {
  const shop = makeShop({ inventory: [makeEntry()] });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({ store, actor, adapter, actorOwnedBy: () => false });

  const res = await service.checkout(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'actor-not-owned');
  assert.equal(store.state.createOrderCalls, 0);
});

test('a missing shop is rejected', async () => {
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore(); // no shop
  const service = makeCartCommerce({ store, actor, adapter });

  const res = await service.checkout(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'shop-not-found');
  assert.equal(store.state.createOrderCalls, 0);
});

// --------------------------------------------------------- catalog gates

test('a backroom entry the actor cannot access is restricted', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({
        id: 'entry1',
        price: 100,
        quantity: 10,
        access: { mode: 'backroom', minReputation: 50 },
      }),
    ],
    funds: null,
  });
  const actor = createMockActor({ uuid: 'Actor.actor1' });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }] }), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'entry-restricted');
  assert.equal(store.state.createOrderCalls, 0);
});

test('a hidden entry is rejected as entry-hidden', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', visible: false })],
    funds: null,
  });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }] }), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'entry-hidden');
  assert.equal(store.state.createOrderCalls, 0);
});

test('a Hated-reputation shop refuses the whole checkout as service-refused', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: null,
  });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: -100, party: -100, score: -100 }),
  });

  const res = await service.checkout(basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }] }), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'service-refused');
  assert.equal(store.state.createOrderCalls, 0);
});

test('insufficient stock is rejected before any effect', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 3 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(basePayload({ lines: [{ entryId: 'entry1', quantity: 4 }] }), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'insufficient-stock');
  assert.equal(store.state.createOrderCalls, 0);
});

test('insufficient funds is rejected before any effect', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 50 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }] }), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'insufficient-funds');
  assert.equal(store.state.createOrderCalls, 0);
});

test('an entry with no item source (no itemUuid and no valid snapshot) is rejected', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({
        id: 'entry1',
        price: 100,
        quantity: 10,
        itemUuid: 'Compendium.Deleted.Item.foo',
        snapshot: '',
      }),
    ],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }] }), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'item-source-missing');
});

// ------------------------------------------------------------ compensation

test('a second-line delivery failure refunds and removes the first line', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 10 }),
      makeEntry({ id: 'entry2', name: 'Sword', price: 500, quantity: 5 }),
    ],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter({ failDeliveryOn: 2 });
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }, { entryId: 'entry2', quantity: 1 }] }),
    'gm1'
  );

  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'deliver failed');
  // Actor was debited then refunded.
  assert.equal(actor.wallet, 1000);
  // The first delivered line was removed with a known id; the second line's
  // delivery threw, so its item may or may not have been delivered (unknown id)
  // and the checkout must escalate rather than claim a clean refund.
  assert.equal(adapter.removedIds.length, 1);
  // No shop write was attempted (delivery happens before the shop write).
  assert.equal(store.state.updateShopCalls, 0);
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
  assert.equal(order.phase, 'final');
  assert.ok(order.details.compensation.includes('item-removed:entry1'));
  assert.ok(order.details.compensation.includes('item-unknown:entry2'));
  assert.ok(order.details.compensation.includes('currency-refunded'));
});

test('a shop update failure removes deliveries, refunds and leaves the shop untouched', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', price: 100, quantity: 10 }),
      makeEntry({ id: 'entry2', price: 500, quantity: 5 }),
    ],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  store.state.failUpdateShop = true;
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }, { entryId: 'entry2', quantity: 1 }] }),
    'gm1'
  );

  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'shop update failed');
  assert.equal(actor.wallet, 1000, 'player refunded');
  assert.equal(adapter.removedIds.length, 2, 'both deliveries removed');
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory.find((e) => e.id === 'entry1').quantity, 10);
  assert.equal(stored.inventory.find((e) => e.id === 'entry2').quantity, 5);
  assert.equal(stored.commerce.funds, 1000, 'merchant funds unchanged');
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('shop-unwritten'));
  assert.ok(order.details.compensation.includes('currency-refunded'));
});

test('a refund whose verified post-credit balance is wrong escalates to needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  // getBalance reports a fixed value that does NOT reflect the credit, so the
  // verified post-refund balance is wrong and the refund must be flagged uncertain.
  adapter.getBalance = async () => 500;
  const store = createFakeStore({ shop });
  store.state.failUpdateShop = true;
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }] }),
    'gm1'
  );

  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'shop update failed');
  assert.ok(res.compensation.includes('currency-refund-mismatch'));
  assert.ok(res.compensation.includes('shop-unwritten'));
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
});

test('an ambiguous recovery (removeItem failure) escalates to needsRecovery', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', price: 100, quantity: 10 }),
      makeEntry({ id: 'entry2', price: 500, quantity: 5 }),
    ],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter({ failDeliveryOn: 2 });
  adapter.removeItem = async () => {
    throw new Error('remove failed');
  };
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }, { entryId: 'entry2', quantity: 1 }] }),
    'gm1'
  );
  assert.equal(res.status, 'needsRecovery');
  assert.ok(res.compensation.includes('item-remove-failed:entry1'));
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
});

test('a shop-state-mixed compensation (funds diverged) escalates to needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  store.state.failOrderCommit = true;
  // After the failing commit, corrupt the shop so the funds were NOT incremented
  // (a mixed/unknown state compensation cannot safely conclude).
  const origUpdate = store.updateAdvancedOrder.bind(store);
  store.updateAdvancedOrder = async (id, patch) => {
    if (patch.status === 'committed') {
      const current = store._shops.get('shop1');
      current.commerce = { ...current.commerce, funds: 1000 };
    }
    return origUpdate(id, patch);
  };
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }] }), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'commit failed');
  assert.ok(res.compensation.includes('shop-state-mixed'));
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
});

// ------------------------------------------------------------- money guards

test('finite merchant funds gain the total on success and refuse on a safe-integer overflow', async () => {
  // Success: funds recovered from the checkout.
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 5000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const ok = await service.checkout(basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }] }), 'gm1');
  assert.equal(ok.status, 'committed');
  assert.equal(store._shops.get('shop1').commerce.funds, 5200);

  // Overflow: funds near MAX_SAFE_INTEGER plus a modest total overflows.
  const bigFunds = Number.MAX_SAFE_INTEGER - 5;
  const shop2 = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: bigFunds,
  });
  const store2 = createFakeStore({ shop: shop2 });
  const service2 = makeCartCommerce({
    store: store2,
    actor: createMockActor({ wallet: 1000 }),
    adapter: makeAdapter(),
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const overflow = await service2.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }] }),
    'gm1'
  );
  assert.equal(overflow.status, 'error');
  assert.equal(overflow.error, 'funds-overflow');
  assert.equal(store2.state.createOrderCalls, 0);
});

test('a quoted total that overflows a safe integer is rejected before any effect', async () => {
  const big = Number.MAX_SAFE_INTEGER;
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: big, quantity: 10 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: Number.MAX_SAFE_INTEGER });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }] }), 'gm1');
  assert.equal(res.status, 'error');
  assert.ok(res.error.startsWith('total-overflow'));
  assert.equal(store.state.createOrderCalls, 0);
});

test('an oversized details snapshot fails the checkout before any effect (64KB cap)', async () => {
  const bigSnapshot = JSON.stringify({
    name: 'Potion',
    description: 'x'.repeat(70 * 1024),
  });
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10, snapshot: bigSnapshot })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }] }), 'gm1');
  assert.equal(res.status, 'error');
  assert.match(res.error, /^order-create-failed:/);
  // No debit, no delivery, no shop write happened.
  assert.equal(actor.wallet, 1000);
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(store._orders.size, 0);
  assert.equal(store._shops.get('shop1').commerce.funds, 1000);
});

// ------------------------------------------------------------ trading gates

test('a closed shop refuses checkout on both the clock and legacy paths', async () => {
  const shop = makeShop({ inventory: [makeEntry()], open: false });
  const actor = createMockActor();
  const adapter = makeAdapter();

  // Legacy path (no clock).
  const store1 = createFakeStore({ shop });
  const legacy = makeCartCommerce({ store: store1, actor, adapter });
  const r1 = await legacy.checkout(basePayload({ lines: [] }), 'gm1');
  assert.equal(r1.status, 'error');
  assert.equal(r1.error, 'shop-closed');

  // Clock path.
  const store2 = createFakeStore({ shop });
  const clocked = makeCartCommerce({
    store: store2,
    actor,
    adapter,
    getWorldTime: () => 0,
  });
  const r2 = await clocked.checkout(basePayload({ lines: [] }), 'gm1');
  assert.equal(r2.status, 'error');
  assert.equal(r2.error, 'shop-closed');
});

// ---------------------------------------------------------------- shared lock

test('concurrent cart checkouts share the same per-shop lock and never overlap writes', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 10 }),
      makeEntry({ id: 'entry2', name: 'Sword', price: 500, quantity: 5 }),
    ],
    funds: null,
  });
  const actor = createMockActor({ wallet: 5000 });
  const adapter = makeAdapter();
  const lockMap = createLockMap();
  const sharedRunShopExclusive = (shopId, fn) => lockMap.run('shop:' + shopId, fn);

  let depth = 0;
  let maxDepth = 0;
  const store = createFakeStore({ shop });
  const origUpdateShop = store.updateShop.bind(store);
  store.updateShop = async (id, patch) => {
    depth += 1;
    maxDepth = Math.max(maxDepth, depth);
    await new Promise((r) => setTimeout(r, 2));
    const result = await origUpdateShop(id, patch);
    depth -= 1;
    return result;
  };

  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    runShopExclusive: sharedRunShopExclusive,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const [ra, rb] = await Promise.all([
    service.checkout(
      basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }], requestId: 'req-a' }),
      'gm1'
    ),
    service.checkout(
      basePayload({ lines: [{ entryId: 'entry2', quantity: 1 }], requestId: 'req-b' }),
      'gm1'
    ),
  ]);

  assert.equal(ra.status, 'committed');
  assert.equal(rb.status, 'committed');
  assert.equal(maxDepth, 1, 'writes never overlapped under the shared lock');
  assert.equal(store._orders.size, 2, 'both checkouts recorded a committed order');
});

// -------------------------------------------------- M5 item-for-price barter

test('barter: a full-credit tender covers the whole cart with no cash moved', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Old Sword', quantity: 1 }],
  });
  const adapter = makeAdapter({ itemPrice: 1000 }); // quoteSell(1000, shop) = 500 >= total 200
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }], barterItemId: 'tender1' }),
    'gm1'
  );

  assert.equal(res.status, 'committed');
  assert.equal(res.barterCredit, 200);
  assert.equal(res.cashPaid, 0);
  // No cash moved: wallet and merchant funds are unchanged.
  assert.equal(actor.wallet, 1000);
  assert.equal(store._shops.get('shop1').commerce.funds, 1000);
  // The tender Item was removed from the actor.
  assert.equal(actor.items.get('tender1'), undefined);
  assert.deepEqual(actor.deletedIds, ['tender1']);
  // A single non-restocking buyback listing was appended via quoteBuyback(credit).
  const listing = store._shops.get('shop1').inventory.find((e) => e.name === 'Old Sword');
  assert.ok(listing);
  assert.equal(listing.stockMode, 'non-restocking');
  assert.equal(listing.quantity, 1);
  assert.equal(listing.itemUuid, '');
  assert.equal(listing.price, 240); // ceil(200 * 12000/10000)
  // The committed outcome is bounded to barterCredit/cashPaid - never the snapshot.
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.outcome.total, 200);
  assert.equal(order.outcome.barterCredit, 200);
  assert.equal(order.outcome.cashPaid, 0);
  assert.equal(order.outcome.snapshot, undefined);
});

test('barter: a partial-credit tender debits only the cash remainder and merchant funds gain only that', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Old Sword', quantity: 1 }],
  });
  const adapter = makeAdapter({ itemPrice: 200 }); // quoteSell(200, shop) = 100
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 3 }], barterItemId: 'tender1' }),
    'gm1'
  );

  assert.equal(res.status, 'committed');
  assert.equal(res.barterCredit, 100);
  assert.equal(res.cashPaid, 200);
  assert.equal(actor.wallet, 800); // 1000 - 200 cash remainder only
  assert.equal(store._shops.get('shop1').commerce.funds, 1200); // 1000 + 200
  assert.equal(actor.items.get('tender1'), undefined);
  const listing = store._shops.get('shop1').inventory.find((e) => e.name === 'Old Sword');
  assert.equal(listing.price, 120); // ceil(100 * 12000/10000)
  assert.equal(listing.stockMode, 'non-restocking');
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.outcome.barterCredit, 100);
  assert.equal(order.outcome.cashPaid, 200);
});

test('barter: a zero-value tender is rejected no-offer before any effect', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Worthless Stone', quantity: 1 }],
  });
  const adapter = makeAdapter({ itemPrice: 0 }); // quoteSell = 0
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }], barterItemId: 'tender1' }),
    'gm1'
  );

  assert.equal(res.status, 'error');
  assert.equal(res.error, 'no-offer');
  assert.equal(store.state.createOrderCalls, 0);
  assert.equal(actor.wallet, 1000);
  assert.equal(store.state.updateShopCalls, 0);
  assert.ok(actor.items.get('tender1'));
});

// ---------------------------------------------- GM valuation approval gate

test('barter: a player-owned tender with an inflated system price gets no currency/goods when no GM valuation is approved', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Overpriced Sword', quantity: 1 }],
  });
  // The adapter would credit the tender at an astronomical price (the exploit), but
  // no GM valuation is approved, so the checkout is refused BEFORE any effect.
  const adapter = makeAdapter({ itemPrice: Number.MAX_SAFE_INTEGER });
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
    getApprovedValuation: async () => null,
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }], barterItemId: 'tender1' }),
    'gm1'
  );

  assert.equal(res.status, 'error');
  assert.equal(res.error, 'gm-approval-required');
  // No debit, no delivery, no tender removal, no store write, no pending order.
  assert.equal(actor.wallet, 1000);
  assert.ok(actor.items.get('tender1'), 'the tender is still owned');
  assert.deepEqual(actor.deletedIds, []);
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(store.state.createOrderCalls, 0);
  assert.equal(store._orders.size, 0);
});

test('barter: a runtime wired without a GM valuation mechanism refuses gm-approval-required before any effect', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Old Sword', quantity: 1 }],
  });
  const adapter = makeAdapter({ itemPrice: 1000 });
  const store = createFakeStore({ shop });
  // Construct the cart service exactly as the runtime does: no `getApprovedValuation`
  // dependency, so a bartered tender is never credited at its own system price.
  const service = createCartCommerce({
    store,
    runShopExclusive: (shopId, fn) => fn(),
    isActiveGM: () => true,
    getActor: async (id) => (actor && actor.id === id ? actor : null),
    actorOwnedBy: () => true,
    getAdapter: () => adapter,
    fromUuid: async () => null,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
    getWorldTime: null,
    now: null,
    logger: { error: () => {} },
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }], barterItemId: 'tender1' }),
    'gm1'
  );

  assert.equal(res.status, 'error');
  assert.equal(res.error, 'gm-approval-required');
  assert.equal(actor.wallet, 1000);
  assert.ok(actor.items.get('tender1'));
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(store._orders.size, 0);
});

// ------------------------------------------- GM valuation consumption

test('barter: a checkout consumes the GM-approved valuation at commit so the same approval cannot mint a second credit', async () => {
  const tender = makeEmbeddedItem({ id: 'tender1', name: 'Old Sword', quantity: 1 });
  const valuation = {
    id: 'val1',
    actorUuid: 'Actor.actor1',
    itemId: 'tender1',
    amount: 500,
    fingerprint: fingerprintItem(tender),
  };
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
    valuations: [valuation],
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Old Sword', quantity: 1 }],
  });
  const adapter = makeAdapter({ itemPrice: 1000 });
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }], barterItemId: 'tender1' }),
    'gm1'
  );

  assert.equal(res.status, 'committed');
  // The GM-approved entry was consumed: it is no longer on the shop's private list.
  assert.deepEqual(store._shops.get('shop1').commerce.valuations, []);
  // The consumed entry is recorded on the order details for any future recovery.
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.details.barter.consumedValuation.id, 'val1');
  assert.equal(order.details.barter.consumedValuation.amount, 500);
});

test('barter: a changed tender price invalidates a stored approval and fails the checkout closed', async () => {
  const tender = makeEmbeddedItem({ id: 'tender1', name: 'Old Sword', quantity: 1 });
  const valuation = {
    id: 'val1',
    actorUuid: 'Actor.actor1',
    itemId: 'tender1',
    amount: 500,
    fingerprint: fingerprintItem(tender),
  };
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
    valuations: [valuation],
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Old Sword', quantity: 1 }],
  });
  // The player inflates the tender price; the stored fingerprint no longer matches.
  actor.items.get('tender1')._data.system.price = 99999;
  const adapter = makeAdapter({ itemPrice: 1000 });
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }], barterItemId: 'tender1' }),
    'gm1'
  );
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'gm-approval-required');
  assert.equal(actor.wallet, 1000);
  assert.ok(actor.items.get('tender1'));
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(store._orders.size, 0);
});

test('barter: a consumed approval cannot re-credit a recreated tender without a new GM valuation', async () => {
  const tender = makeEmbeddedItem({ id: 'tender1', name: 'Old Sword', quantity: 1 });
  const valuation = {
    id: 'val1',
    actorUuid: 'Actor.actor1',
    itemId: 'tender1',
    amount: 500,
    fingerprint: fingerprintItem(tender),
  };
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
    valuations: [valuation],
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Old Sword', quantity: 1 }],
  });
  const adapter = makeAdapter({ itemPrice: 1000 });
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
    // Strict approval: only a still-present, fingerprint-matching valuation pays.
    getApprovedValuation: async (i, s) => {
      const sh = s || store._shops.get('shop1');
      const vals = (sh && sh.commerce && sh.commerce.valuations) || [];
      const e = vals.find(
        (v) => v.actorUuid === 'Actor.actor1' && v.itemId === (i && i.id)
      );
      return e && fingerprintItem(i) === e.fingerprint ? e : null;
    },
  });

  const first = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }], barterItemId: 'tender1' }),
    'gm1'
  );
  assert.equal(first.status, 'committed');
  assert.equal(store._shops.get('shop1').commerce.valuations.length, 0);
  assert.equal(actor.items.get('tender1'), undefined, 'the tender was removed');

  // The tender is recreated with the same document id, but the approval was
  // consumed at the first checkout, so the same approval cannot mint a second credit.
  tender.parent = actor;
  actor.items.set('tender1', tender);
  const second = await service.checkout(
    basePayload({
      lines: [{ entryId: 'entry1', quantity: 2 }],
      barterItemId: 'tender1',
      requestId: 'req-2',
    }),
    'gm1'
  );
  assert.equal(second.status, 'error');
  assert.equal(second.error, 'gm-approval-required');
  assert.equal(actor.wallet, 1000, 'no second debit');
});

test('barter: a failed checkout commit restores the exact consumed valuation with the listing and funds', async () => {
  const tender = makeEmbeddedItem({ id: 'tender1', name: 'Old Sword', quantity: 1 });
  const valuation = {
    id: 'val1',
    actorUuid: 'Actor.actor1',
    itemId: 'tender1',
    amount: 500,
    fingerprint: fingerprintItem(tender),
  };
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
    valuations: [valuation],
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Old Sword', quantity: 1 }],
  });
  const adapter = makeAdapter({ itemPrice: 1000 });
  const store = createFakeStore({ shop });
  store.state.failOrderCommit = true;
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }], barterItemId: 'tender1' }),
    'gm1'
  );
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'commit failed');
  // Compensation restored the exact consumed valuation alongside stock/funds/listing.
  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.valuations.length, 1);
  assert.equal(stored.commerce.valuations[0].id, 'val1');
  assert.equal(stored.commerce.valuations[0].amount, 500);
  const order = store._orders.get('cart:gm1:req-1');
  assert.ok(order.details.compensation.includes('shop-restored'));
});

test('barter: a barterItemId the actor does not carry is rejected as barter-item-not-found', async () => {
  const shop = makeShop({ inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })] });
  const actor = makeBarterActor({ items: [{ id: 'tender1', quantity: 1 }] });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }], barterItemId: 'nope' }),
    'gm1'
  );
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'barter-item-not-found');
  assert.equal(store.state.createOrderCalls, 0);
});

test('barter: a stacked tender (system.quantity > 1) is rejected stacked-item', async () => {
  const shop = makeShop({ inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })] });
  const actor = makeBarterActor({ items: [{ id: 'tender1', quantity: 2 }] });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }], barterItemId: 'tender1' }),
    'gm1'
  );
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'stacked-item');
  assert.equal(store.state.createOrderCalls, 0);
});

test('barter: a non-embedded generic delivery mode rejects the barter as delivery-mode-unsupported', async () => {
  const shop = makeShop({ inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })] });
  const actor = makeBarterActor({ items: [{ id: 'tender1', quantity: 1 }] });
  const adapter = makeAdapter({ deliveryMode: 'path' });
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }], barterItemId: 'tender1' }),
    'gm1'
  );
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'delivery-mode-unsupported');
  assert.equal(store.state.createOrderCalls, 0);
});

test('barter: an unsupported adapter is rejected before any effect and the tender is kept', async () => {
  const shop = makeShop({ inventory: [makeEntry()] });
  const actor = makeBarterActor({ items: [{ id: 'tender1', quantity: 1 }] });
  const adapter = makeAdapter();
  adapter.supported = false;
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }], barterItemId: 'tender1' }),
    'gm1'
  );
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'adapter-unsupported');
  assert.equal(store.state.createOrderCalls, 0);
  assert.ok(actor.items.get('tender1'));
});

test('barter: a committed barter checkout replays with no re-removal, re-debit or re-append', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Old Sword', quantity: 1 }],
  });
  const adapter = makeAdapter({ itemPrice: 500 });
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const payload = basePayload({
    lines: [{ entryId: 'entry1', quantity: 2 }],
    barterItemId: 'tender1',
  });

  const first = await service.checkout(payload, 'gm1');
  assert.equal(first.status, 'committed');
  const wallet = actor.wallet;
  const writes = store.state.updateShopCalls;
  const shopSize = store._shops.get('shop1').inventory.length;
  const deletedCount = actor.deletedIds.length;

  const second = await service.checkout(payload, 'gm1');
  assert.equal(second.status, 'replay');
  assert.equal(second.orderId, first.orderId);
  assert.equal(second.barterCredit, first.barterCredit);
  assert.equal(second.cashPaid, first.cashPaid);
  assert.equal(actor.wallet, wallet);
  assert.equal(actor.deletedIds.length, deletedCount);
  assert.equal(store.state.updateShopCalls, writes);
  assert.equal(store._shops.get('shop1').inventory.length, shopSize);
  assert.equal(store._orders.size, 1);
});

test('barter: the same key with a different barterItemId is a conflict with no new effect', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [
      { id: 'tender1', name: 'Sword', quantity: 1 },
      { id: 'tender2', name: 'Shield', quantity: 1 },
    ],
  });
  const adapter = makeAdapter({ itemPrice: 500 });
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const first = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }], barterItemId: 'tender1' }),
    'gm1'
  );
  assert.equal(first.status, 'committed');

  const conflict = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }], barterItemId: 'tender2' }),
    'gm1'
  );
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.error, 'conflicting duplicate payload');
  assert.equal(conflict.orderId, first.orderId);
  assert.equal(store.state.updateShopCalls, 1);
});

test('barter: a delivery failure after tender removal restores the tender and refunds the cash remainder', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 10 }),
      makeEntry({ id: 'entry2', name: 'Sword', price: 500, quantity: 5 }),
    ],
    funds: 1000,
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Old Sword', quantity: 1 }],
  });
  const adapter = makeAdapter({ failDeliveryOn: 2, itemPrice: 200 });
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload(
      { lines: [{ entryId: 'entry1', quantity: 2 }, { entryId: 'entry2', quantity: 1 }], barterItemId: 'tender1' },
      'gm1'
    ),
    'gm1'
  );

  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'deliver failed');
  // The tender was removed then restored with its original id (verified by items.get).
  assert.deepEqual(actor.deletedIds, ['tender1']);
  assert.ok(actor.items.get('tender1'));
  assert.ok(res.compensation.includes('tender-restored'));
  assert.ok(res.compensation.includes('currency-refunded'));
  assert.ok(res.compensation.includes('item-removed:entry1'));
  // The second line's delivery threw: its item may or may not have been delivered
  // with an unknown id, so the checkout must escalate to needsRecovery.
  assert.ok(res.compensation.includes('item-unknown:entry2'));
  // No shop write was attempted (delivery fails before the shop write).
  assert.equal(store.state.updateShopCalls, 0);
  // Cash was debited (cash remainder) then refunded.
  assert.equal(actor.wallet, 1000);
});

test('barter: a throwing cash debit rolls back and never double-charges', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Old Sword', quantity: 1 }],
  });
  const adapter = makeAdapter({ itemPrice: 200, debitThrows: true });
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 3 }], barterItemId: 'tender1' }),
    'gm1'
  );

  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'debit failed');
  assert.ok(actor.items.get('tender1'));
  assert.ok(res.compensation.includes('tender-restored'));
  assert.equal(actor.wallet, 1000);
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(adapter.removedIds.length, 0);
});

test('barter: an ambiguous shop state (listing present, funds not gained) escalates to needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Old Sword', quantity: 1 }],
  });
  const adapter = makeAdapter({ itemPrice: 200 });
  const store = createFakeStore({ shop });
  store.state.failOrderCommit = true;
  // After the failing commit, corrupt the shop so the funds were NOT gained (a
  // mixed/unknown state compensation cannot safely conclude).
  const origUpdate = store.updateAdvancedOrder.bind(store);
  store.updateAdvancedOrder = async (id, patch) => {
    if (patch.status === 'committed') {
      const current = store._shops.get('shop1');
      current.commerce = { ...current.commerce, funds: 1000 };
    }
    return origUpdate(id, patch);
  };
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }], barterItemId: 'tender1' }),
    'gm1'
  );

  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'commit failed');
  assert.ok(res.compensation.includes('shop-state-mixed'));
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
});

// ------------------------------------------------------ M5 merchant specials

test('cart applies an actor-allowlisted special at the stored offer price, never a client price', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 10 })],
    funds: null,
    specials: [
      {
        id: 'sp1',
        title: 'Potion Sale',
        description: 'Half price',
        entryId: 'entry1',
        price: 60,
        visible: true,
        actorUuids: ['Actor.actor1'],
      },
    ],
  });
  const actor = createMockActor({ wallet: 1000, uuid: 'Actor.actor1' });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  // A client-side `price` on the line is ignored: the checkout re-reads the
  // stored special's configured price (60), not 999, and not the entry's 100.
  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2, specialId: 'sp1', price: 999 }] }),
    'gm1'
  );
  assert.equal(res.status, 'committed');
  assert.equal(res.total, 120);
  assert.equal(actor.wallet, 1000 - 120);
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.outcome.total, 120);
  assert.equal(order.details.lines[0].specialId, 'sp1');
  assert.deepEqual(order.outcome.items[0].specialId, 'sp1');
  assert.equal(order.outcome.items[0].specialPrice, 60);
});

test('a forged specialId is rejected special-unavailable before any debit', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: null,
    specials: [{ id: 'sp1', title: 'x', entryId: 'entry1', price: 60 }],
  });
  const actor = createMockActor({ wallet: 1000, uuid: 'Actor.actor1' });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1, specialId: 'nope' }] }),
    'gm1'
  );
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'special-unavailable');
  assert.equal(actor.wallet, 1000);
  assert.equal(store.state.createOrderCalls, 0);
  assert.equal(store.state.updateShopCalls, 0);
});

test('a hidden (visible:false) special is rejected special-unavailable', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: null,
    specials: [{ id: 'sp1', title: 'x', entryId: 'entry1', price: 60, visible: false }],
  });
  const actor = createMockActor({ wallet: 1000, uuid: 'Actor.actor1' });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1, specialId: 'sp1' }] }),
    'gm1'
  );
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'special-unavailable');
  assert.equal(store.state.createOrderCalls, 0);
});

test('a special targeting a different entry is rejected special-unavailable', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', price: 100, quantity: 10 }),
      makeEntry({ id: 'entry2', price: 50, quantity: 10 }),
    ],
    funds: null,
    specials: [{ id: 'sp1', title: 'x', entryId: 'entry2', price: 30 }],
  });
  const actor = createMockActor({ wallet: 1000, uuid: 'Actor.actor1' });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1, specialId: 'sp1' }] }),
    'gm1'
  );
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'special-unavailable');
  assert.equal(store.state.createOrderCalls, 0);
});

test('an actor-specific special the actor is not in the allowlist for is rejected special-unavailable', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: null,
    specials: [{ id: 'sp1', title: 'x', entryId: 'entry1', price: 60, actorUuids: ['Actor.other'] }],
  });
  const actor = createMockActor({ wallet: 1000, uuid: 'Actor.actor1' });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1, specialId: 'sp1' }] }),
    'gm1'
  );
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'special-unavailable');
  assert.equal(store.state.createOrderCalls, 0);
});

test('same key with a distinct specialId is a conflict; the same specialId replays', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: null,
    specials: [
      { id: 'sp1', title: 'A', entryId: 'entry1', price: 60 },
      { id: 'sp2', title: 'B', entryId: 'entry1', price: 70 },
    ],
  });
  const actor = createMockActor({ wallet: 1000, uuid: 'Actor.actor1' });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const first = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1, specialId: 'sp1' }] }),
    'gm1'
  );
  assert.equal(first.status, 'committed');
  assert.equal(first.total, 60);

  // Same key but a DIFFERENT specialId is a different intent => conflict, no effect.
  const conflict = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1, specialId: 'sp2' }] }),
    'gm1'
  );
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.conflict, true);
  assert.equal(store.state.updateShopCalls, 1);
  assert.equal(store._orders.size, 1);

  // The identical specialId replays the committed order without re-charging.
  const replay = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1, specialId: 'sp1' }] }),
    'gm1'
  );
  assert.equal(replay.status, 'replay');
  assert.equal(replay.orderId, first.orderId);
  assert.equal(replay.total, 60);
  assert.equal(actor.wallet, 1000 - 60);
});

test('cart runs the special price through the social engine (markup applied to the offer)', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: null,
    specials: [{ id: 'sp1', title: 'x', entryId: 'entry1', price: 60 }],
  });
  // A 10% shop markup is applied to the special's configured price (60 -> 66/unit),
  // proving the offer price is quoted socially rather than used verbatim.
  shop.social = { shopMarkupBps: 1000 };
  const actor = createMockActor({ wallet: 1000, uuid: 'Actor.actor1' });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2, specialId: 'sp1' }] }),
    'gm1'
  );
  assert.equal(res.status, 'committed');
  assert.equal(res.total, 132); // 66 * 2
  assert.equal(actor.wallet, 1000 - 132);
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.outcome.items[0].specialPrice, 66);
});

// --------------------------------------------------------- shop-write safety

test('a null shop write on checkout does not claim committed and records shop-write-missing', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  // updateShop returns null without applying the stock/funds patch, as the store
  // does when the shop is absent. The checkout must NOT claim committed: it throws
  // into compensation, which refunds the debit and restores nothing (the write
  // never landed), concluding a clean `failed`.
  store.state.nullUpdateShop = true;
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(basePayload(), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'shop-write-missing');
  assert.equal(actor.wallet, 1000, 'debit refunded');
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.equal(order.error, 'shop-write-missing');
  assert.ok(order.details.compensation.includes('shop-unwritten'));
});

test('a null shop write whose shop is gone is escalated to needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  // The shop exists for the initial read, but vanishes before the single shop
  // write: the write returns null AND the compensation re-read sees no shop, so
  // the checkout must escalate to needsRecovery (never a clean committed/failed).
  let findCalls = 0;
  store.findShop = async () => {
    findCalls += 1;
    return findCalls === 1 ? shop : null;
  };
  store.state.nullUpdateShop = true;
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(basePayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'shop-write-missing');
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
  assert.ok(order.details.compensation.includes('shop-missing'));
});

// ------------------------------------------------------------- barter phases

test('barter checkout persists the bartered phase and commits cleanly', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Old Sword', quantity: 1 }],
  });
  const adapter = makeAdapter({ itemPrice: 1000 });
  const store = createFakeStore({ shop });
  const phaseWrites = [];
  const origUpdate = store.updateAdvancedOrder.bind(store);
  store.updateAdvancedOrder = async (id, patch) => {
    if (patch.phase) phaseWrites.push(patch.phase);
    return origUpdate(id, patch);
  };
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }], barterItemId: 'tender1' }),
    'gm1'
  );
  assert.equal(res.status, 'committed');
  // The barter path must actually persist its `bartered` marker (a real store
  // validates each phase write, and `bartered` is now a recognized phase).
  assert.ok(phaseWrites.includes('bartered'));
  assert.ok(phaseWrites.includes('final'));
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.status, 'committed');
  assert.equal(order.phase, 'final');
});

test('a failed barter checkout records the bartered phase without claiming completion', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 10 }),
      makeEntry({ id: 'entry2', name: 'Sword', price: 500, quantity: 5 }),
    ],
    funds: 1000,
  });
  const actor = makeBarterActor({
    wallet: 1000,
    items: [{ id: 'tender1', name: 'Old Sword', quantity: 1 }],
  });
  const adapter = makeAdapter({ failDeliveryOn: 2, itemPrice: 200 });
  const store = createFakeStore({ shop });
  const phaseWrites = [];
  const origUpdate = store.updateAdvancedOrder.bind(store);
  store.updateAdvancedOrder = async (id, patch) => {
    if (patch.phase) phaseWrites.push(patch.phase);
    return origUpdate(id, patch);
  };
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload(
      { lines: [{ entryId: 'entry1', quantity: 2 }, { entryId: 'entry2', quantity: 1 }], barterItemId: 'tender1' },
      'gm1'
    ),
    'gm1'
  );
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'deliver failed');
  assert.ok(phaseWrites.includes('bartered'), 'the bartered phase was attempted before the failure');
  assert.ok(res.compensation.includes('tender-restored'));
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
});

// -------------------------------------------------------- replay originalStatus

test('a replayed committed cart carries originalStatus committed', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const first = await service.checkout(basePayload(), 'gm1');
  assert.equal(first.status, 'committed');
  const replay = await service.checkout(basePayload(), 'gm1');
  assert.equal(replay.status, 'replay');
  assert.equal(replay.originalStatus, 'committed');
});

test('a replayed failed cart carries originalStatus failed', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  await service.checkout(basePayload(), 'gm1');
  // A terminal failed original replays as a failed replay carrying 'failed'.
  const order = store._orders.get('cart:gm1:req-1');
  order.status = 'failed';
  const replay = await service.checkout(basePayload(), 'gm1');
  assert.equal(replay.status, 'replay');
  assert.equal(replay.originalStatus, 'failed');
});

// -------------------------------------------------- commit-throw recovery

test('a final cart commit that applies then throws is treated as committed and never compensates', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 10 }),
      makeEntry({ id: 'entry2', name: 'Sword', price: 500, quantity: 5 }),
    ],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  // The commit write persists `committed` and THEN throws: the order is committed
  // even though the caller never sees a successful reply.
  store.state.commitAppliesThenThrows = true;
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 2 }, { entryId: 'entry2', quantity: 1 }] }),
    'gm1'
  );

  assert.equal(res.status, 'committed');
  assert.equal(res.total, 700);
  assert.equal(res.quantity, 3);
  assert.deepEqual(
    res.items.map((i) => ({ entryId: i.entryId, quantity: i.quantity })),
    [
      { entryId: 'entry1', quantity: 2 },
      { entryId: 'entry2', quantity: 1 },
    ]
  );
  // Effects are NOT reversed: no refund of the debit, no item removal.
  assert.equal(actor.wallet, 1000 - 700);
  assert.equal(adapter.removedIds.length, 0);
  assert.equal(store.state.updateShopCalls, 1);
  // The persisted record is committed (the apply-then-throw committed it).
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.status, 'committed');
  assert.equal(order.phase, 'final');
  assert.deepEqual(order.outcome, {
    total: 700,
    quantity: 3,
    barterCredit: 0,
    cashPaid: 700,
    items: [
      { entryId: 'entry1', name: 'Potion', quantity: 2 },
      { entryId: 'entry2', name: 'Sword', quantity: 1 },
    ],
  });
});

test('a cart commit whose re-read throws escalates to needsRecovery without reversing effects', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 10 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  // The commit write throws, and the by-id re-read throws too: the checkout cannot
  // confirm whether the order committed, so it must NOT undo the already-applied
  // effects - it escalates instead.
  store.state.failOrderCommit = true;
  store.state.failFindOrder = true;
  const service = makeCartCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.checkout(
    basePayload({ lines: [{ entryId: 'entry1', quantity: 1 }] }),
    'gm1'
  );
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'commit failed');
  assert.deepEqual(res.compensation, []);
  // Effects are NOT reversed: the debit stands and the delivered item is kept.
  assert.equal(actor.wallet, 1000 - 100);
  assert.equal(adapter.removedIds.length, 0);
  // The order was marked needsRecovery (the marker write is safe here).
  const order = store._orders.get('cart:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
  assert.equal(order.error, 'commit failed');
});
