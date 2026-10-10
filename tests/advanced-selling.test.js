// Unit tests for the M5 GM-authoritative embedded-Item buyback sale in
// `src/advanced/selling.js`.
//
// These are pure Node tests (no Foundry globals) using a fake store, a fake
// actor (with an embedded Items collection), and a fake adapter, plus the real
// lock map so a sell can be shown to share the per-shop lock with purchases.
// They cover the success path and its exact side effects, idempotent replay,
// the duplicate-identity conflict, GM gating, ownership, the one-whole-item
// stack rule, finite merchant funds, a zero offer, and the compensation paths
// for a failed delete / credit / shop write / commit, including the shared lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSellingService } from '../src/advanced/selling.js';
import { quoteSell, quoteBuyback } from '../src/advanced/policy.js';
import { normalizeShop, makeId } from '../src/services/model.js';
import { createCommerce, createLockMap, fnv1a } from '../src/services/commerce.js';
import { fingerprintItem } from '../src/advanced/valuation.js';

// ---------------------------------------------------------------- helpers

export function makeItem(overrides = {}) {
  const {
    id = 'item1',
    name = 'Potion',
    img = 'icons/potion.png',
    quantity = 1,
    system = {},
  } = overrides;
  const item = {
    id,
    name,
    img,
    documentName: 'Item',
    system: { ...system, quantity },
    toObject() {
      return { _id: this.id, name: this.name, img: this.img, system: { ...this.system } };
    },
  };
  return item;
}

export function createMockActor({
  item = null,
  deleteFails = false,
  createEmbeddedFails = false,
  deleteReturnsIdButKeepsItem = false,
  restoreDropsId = false,
} = {}) {
  const items = new Map();
  const actor = {
    id: 'actor1',
    name: 'Player',
    wallet: 0,
    items,
    // Track exactly which embedded effects were requested, so a replay that
    // re-applies them is caught.
    deletedIds: [],
    createdDocs: [],
    async deleteEmbeddedDocuments(name, ids) {
      if (deleteFails) throw new Error('delete failed');
      if (deleteReturnsIdButKeepsItem) {
        // The API resolves and returns the ids, but the item stays live on the
        // actor (a returned deletion id alone is insufficient).
        actor.deletedIds.push(...ids);
        return ids.slice();
      }
      const removed = [];
      for (const id of ids) {
        if (items.has(id)) {
          removed.push(id);
          items.delete(id);
        }
      }
      actor.deletedIds.push(...ids);
      return removed;
    },
    async createEmbeddedDocuments(name, data) {
      if (createEmbeddedFails) throw new Error('create failed');
      // Preserve a supplied id/_id so a compensated restore is findable again by
      // its original id (Foundry keeps an embedded document's id on restore).
      // Unless `restoreDropsId` is set, which simulates the restore not keeping
      // the original id so the post-restore verify must fail.
      const docs = data.map((d) => {
        const baseId = d.id || d._id || makeId();
        const id = restoreDropsId ? `${baseId}-restored` : baseId;
        return { ...d, id };
      });
      for (const doc of docs) items.set(doc.id, doc);
      actor.createdDocs.push(...docs);
      return docs;
    },
    async update() {
      return actor;
    },
  };
  if (item) {
    item.parent = actor;
    items.set(item.id, item);
  }
  return actor;
}

export function makeAdapter({
  minorUnits = 100,
  creditFails = false,
  creditAppliesThenThrows = false,
} = {}) {
  return {
    supported: true,
    minorUnits,
    async getItemPrice() {
      return { minorUnits };
    },
    async getBalance(actor) {
      return actor.wallet || 0;
    },
    async credit(actor, amount) {
      if (creditFails) throw new Error('credit failed');
      actor.wallet = (actor.wallet || 0) + amount;
      if (creditAppliesThenThrows) throw new Error('credit failed after apply');
      return { amount, newBalance: actor.wallet };
    },
    async debit(actor, amount) {
      actor.wallet = (actor.wallet || 0) - amount;
      return { amount, newBalance: actor.wallet };
    },
    async deliverItem(actor, item, { quantity = 1 } = {}) {
      return { id: `delivered-${makeId()}`, item };
    },
    async removeItem() {
      return true;
    },
  };
}

export function makeShop({ funds = null, open = true, name = 'General Store', valuations = [] } = {}) {
  return normalizeShop({
    id: 'shop1',
    name,
    locationId: 'home',
    open,
    commerce: { funds, valuations },
  });
}

export function createFakeStore({ shop } = {}) {
  const shops = new Map();
  if (shop) shops.set(shop.id, shop);
  const orders = new Map();
  const ledgers = new Map();
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
    _ledgers: ledgers,
    async findLedgerByKey(key) {
      return ledgers.get(key) || null;
    },
    async createLedger(record) {
      const normalized = { ...record, id: record.id || makeId() };
      const existing = ledgers.get(normalized.key);
      if (existing) return { record: existing, created: false };
      ledgers.set(normalized.key, normalized);
      return { record: normalized, created: true };
    },
    async updateLedger(id, patch) {
      for (const [key, rec] of ledgers) {
        if (rec.id === id) {
          ledgers.set(key, { ...rec, ...patch, updatedAt: patch.updatedAt ?? Date.now() });
          return ledgers.get(key);
        }
      }
      return null;
    },
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
        // Simulate the terminal commit write returning no persisted record, so
        // the service must never claim committed.
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

export function makeService({
  store,
  actor,
  adapter,
  isActiveGM = () => true,
  actorOwnedBy = () => true,
  now = null,
  runShopExclusive,
  getActor,
  getApprovedValuation,
} = {}) {
  return createSellingService({
    store,
    runShopExclusive: runShopExclusive || ((shopId, fn) => fn()),
    isActiveGM,
    getActor: getActor || (async (id) => (actor && actor.id === id ? actor : null)),
    actorOwnedBy,
    getAdapter: () => adapter,
    // Test fixture: a GM-approved valuation, so the effectful sale path stays
    // exercisable. When the shop fixture carries a matching GM-private valuation for
    // this actor+item, the entry (with its fingerprint verified) is returned so the
    // sale consumes it at commit; when no valuation is seeded, the fixture falls
    // back to the adapter's numeric minor-unit value (legacy behavior). The runtime
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
        if (!entry) return adapter.minorUnits ?? 100;
        let fp;
        try {
          fp = fingerprintItem(item);
        } catch {
          return null;
        }
        return fp === entry.fingerprint ? entry : null;
      }),
    now,
    makeId,
    logger: { error: () => {} },
  });
}

export function basePayload(overrides = {}) {
  return {
    shopId: 'shop1',
    actorId: 'actor1',
    itemId: 'item1',
    requestId: 'req-1',
    userId: 'unused-user',
    ...overrides,
  };
}

// Mirror the service's canonical intent hash so a synthetic persisted order can
// carry the exact hash a real request would compute for the same identity.
export function intentHashFor(itemId, requester = 'gm1') {
  return fnv1a(
    JSON.stringify({ shopId: 'shop1', actorId: 'actor1', itemId, requester })
  );
}

// ---------------------------------------------------------------- success

test('sell commits a whole embedded item for buyback and applies exactly the effects', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem({ name: 'Potion' }) });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');

  assert.equal(res.status, 'committed');
  assert.equal(res.payout, quoteSell(100, shop));
  assert.ok(res.buybackEntryId);
  assert.equal(res.itemName, 'Potion');
  assert.equal(res.orderId, res.orderId);

  // Actor credited, item removed, single shop write.
  const payout = res.payout;
  assert.equal(actor.wallet, payout);
  assert.equal(actor.items.get('item1'), undefined);
  assert.equal(actor.deletedIds.length, 1);
  assert.equal(actor.deletedIds[0], 'item1');
  assert.equal(store.state.updateShopCalls, 1);

  // Shop funds decremented and the buyback listing appended exactly once.
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory.length, 1);
  const entry = stored.inventory[0];
  assert.equal(entry.id, res.buybackEntryId);
  assert.equal(entry.itemUuid, '');
  assert.equal(entry.quantity, 1);
  assert.equal(entry.stockMode, 'non-restocking');
  assert.equal(entry.visible, true);
  assert.ok(JSON.parse(entry.snapshot).name === 'Potion');
  assert.equal(entry.price, quoteBuyback(payout, shop));
  assert.equal(entry.access.mode, 'public');
  assert.equal(stored.commerce.funds, 100 - payout);

  // Order committed with the documented outcome and private details.
  const order = store._orders.get(`sell:gm1:req-1`);
  assert.equal(order.status, 'committed');
  assert.equal(order.phase, 'final');
  assert.deepEqual(order.outcome, { payout, buybackEntryId: res.buybackEntryId, itemName: 'Potion' });
  assert.equal(order.details.payout, payout);
  assert.equal(order.details.fundsBefore, 100);
  assert.equal(order.kind, 'sell');
  assert.equal(order.quantity, 1);
});

test('sell with unlimited funds leaves commerce.funds null and decrements nothing', async () => {
  const shop = makeShop({ funds: null });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'committed');
  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.funds, null);
  const order = store._orders.get(`sell:gm1:req-1`);
  assert.equal(order.details.fundsBefore, null);
});

// ------------------------------------------------------- idempotency / conflict

test('a replayed sell for the same key/intent returns the recorded outcome with no new effects', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const first = await service.sell(basePayload(), 'gm1');
  assert.equal(first.status, 'committed');
  const payout = first.payout;
  const buys = actor.deletedIds.length;
  const writes = store.state.updateShopCalls;
  const orderId = first.orderId;

  const again = await service.sell(basePayload(), 'gm1');
  assert.equal(again.status, 'replay');
  assert.equal(again.payout, payout);
  assert.equal(again.buybackEntryId, first.buybackEntryId);
  assert.equal(again.itemName, 'Potion');
  assert.equal(again.orderId, orderId);

  // No second credit / delete / shop append; item not re-deleted, wallet not
  // re-credited, and the buyback listing is still present once.
  assert.equal(actor.wallet, payout);
  assert.equal(actor.deletedIds.length, buys);
  assert.equal(store.state.updateShopCalls, writes);
  assert.equal(store._shops.get('shop1').inventory.length, 1);
  assert.equal(store._orders.size, 1);
});

test('the same key with a different identity is a conflict and applies no effect', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const first = await service.sell(basePayload(), 'gm1');
  assert.equal(first.status, 'committed');

  const conflict = await service.sell(basePayload({ itemId: 'item2' }), 'gm1');
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.error, 'conflicting duplicate payload');
  assert.equal(conflict.orderId, first.orderId);
  assert.ok(conflict.expected, 'carries the persisted intent hash');

  // No effect from the conflicting request.
  assert.equal(actor.wallet, first.payout);
  assert.equal(store._shops.get('shop1').inventory.length, 1);
  assert.equal(store.state.updateShopCalls, 1);
});

test('a replay of a pending order surfaces needsRecovery without applying an effect', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  // Simulate a pending order persisted by an earlier (interrupted) run.
  store._orders.set('sell:gm1:req-1', {
    id: 'ord-pending',
    key: 'sell:gm1:req-1',
    kind: 'sell',
    status: 'pending',
    phase: 'recorded',
    shopId: 'shop1',
    userId: 'gm1',
    actorId: 'actor1',
    intentHash: intentHashFor('item1'),
    details: {},
    outcome: {},
    error: '',
  });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.orderId, 'ord-pending');
  // No credit / delete / shop write happened.
  assert.equal(actor.wallet, 0);
  assert.equal(actor.deletedIds.length, 0);
  assert.equal(store.state.updateShopCalls, 0);
});

test('a replayed failed order returns replay without re-running effects', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  store._orders.set('sell:gm1:req-1', {
    id: 'ord-failed',
    key: 'sell:gm1:req-1',
    kind: 'sell',
    status: 'failed',
    phase: 'final',
    shopId: 'shop1',
    userId: 'gm1',
    actorId: 'actor1',
    intentHash: intentHashFor('item1'),
    details: {},
    outcome: {},
    error: 'item-delete-failed',
  });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'replay');
  assert.equal(res.orderId, 'ord-failed');
  assert.equal(actor.wallet, 0);
  assert.equal(actor.deletedIds.length, 0);
  assert.equal(store.state.updateShopCalls, 0);
});

// ------------------------------------------------------ input / auth gates

test('a non-active-GM caller is rejected before any store read', async () => {
  const shop = makeShop();
  const adapter = makeAdapter();
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({
    store,
    actor,
    adapter,
    isActiveGM: () => false,
  });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'not-active-gm');
  assert.equal(store.state.findOrderCalls, 0);
  assert.equal(store.state.findShopCalls, 0);
  assert.equal(store.state.createOrderCalls, 0);
});

test('an actor the requester does not own is rejected and never records an order', async () => {
  const shop = makeShop();
  const adapter = makeAdapter();
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter, actorOwnedBy: () => false });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'actor-not-owned');
  assert.equal(store.state.createOrderCalls, 0);
  assert.equal(store._orders.size, 0);
});

test('a stacked item (system.quantity !== 1) is rejected', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem({ quantity: 3 }) });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'stacked-item');
  assert.equal(store.state.createOrderCalls, 0);
  assert.equal(store._orders.size, 0);
});

test('a missing item / shop / actor is rejected with no effect', async () => {
  const shop = makeShop();
  const adapter = makeAdapter();
  const actor = createMockActor(); // no items
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'item-not-found');

  const actor2 = createMockActor({ item: makeItem() });
  const store2 = createFakeStore({ shop });
  const service2 = makeService({
    store: store2,
    actor: actor2,
    adapter,
    getActor: async (id) => null,
  });
  const res2 = await service2.sell(basePayload(), 'gm1');
  assert.equal(res2.status, 'error');
  assert.equal(res2.error, 'actor-not-found');

  const actor3 = createMockActor({ item: makeItem() });
  const store3 = createFakeStore(); // no shop
  const service3 = makeService({ store: store3, actor: actor3, adapter });
  const res3 = await service3.sell(basePayload(), 'gm1');
  assert.equal(res3.status, 'error');
  assert.equal(res3.error, 'shop-not-found');
});

// ------------------------------------------------------------- money gates

test('finite merchant funds below the payout refuse before any effect', async () => {
  const shop = makeShop({ funds: 40 });
  const adapter = makeAdapter({ minorUnits: 100 }); // payout 50
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'insufficient-merchant-funds');
  assert.equal(actor.wallet, 0);
  assert.equal(actor.deletedIds.length, 0);
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(store._orders.size, 0);
});

test('a zero offer (payout 0) is refused as no-offer', async () => {
  const shop = makeShop({ funds: null });
  const adapter = makeAdapter({ minorUnits: 0 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'no-offer');
  assert.equal(store._orders.size, 0);
});

// ---------------------------------------------- GM valuation approval gate

test('a player-owned item with an inflated system price gets no currency/goods when no GM valuation is approved', async () => {
  const shop = makeShop({ funds: 100 });
  // The adapter would price the item astronomically high (the exploit), but the
  // GM valuation is not approved, so the sale is refused BEFORE any effect.
  const adapter = makeAdapter({ minorUnits: Number.MAX_SAFE_INTEGER });
  const actor = createMockActor({ item: makeItem({ name: 'Overpriced', system: { price: { value: 99999, denomination: 'gp' } } }) });
  const store = createFakeStore({ shop });
  const service = makeService({
    store,
    actor,
    adapter,
    getApprovedValuation: async () => null,
  });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'gm-approval-required');
  // No currency credited, no item deleted, no shop write, no pending order.
  assert.equal(actor.wallet, 0);
  assert.ok(actor.items.get('item1'), 'the item is still owned');
  assert.equal(actor.deletedIds.length, 0);
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(store._orders.size, 0);
  assert.equal(store.state.createOrderCalls, 0);
});

test('a runtime wired without a GM valuation mechanism refuses gm-approval-required before any effect', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  // Construct the service exactly as the runtime does: no `getApprovedValuation`
  // dependency, so the player-owned item is never priced from its system value.
  const service = createSellingService({
    store,
    runShopExclusive: (shopId, fn) => fn(),
    isActiveGM: () => true,
    getActor: async (id) => (actor && actor.id === id ? actor : null),
    actorOwnedBy: () => true,
    getAdapter: () => adapter,
    now: null,
    makeId,
    logger: { error: () => {} },
  });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'gm-approval-required');
  assert.equal(actor.wallet, 0);
  assert.ok(actor.items.get('item1'));
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(store._orders.size, 0);
});

// ------------------------------------------- GM valuation consumption

test('a sale consumes the GM-approved valuation at commit so the same approval cannot mint a second payout', async () => {
  const item = makeItem({ name: 'Potion' });
  const valuation = {
    id: 'val1',
    actorUuid: 'Actor.actor1',
    itemId: 'item1',
    amount: 42,
    fingerprint: fingerprintItem(item),
  };
  const shop = makeShop({ funds: 100, valuations: [valuation] });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'committed');
  assert.equal(res.payout, quoteSell(42, shop));
  // The GM-approved entry was consumed: it is no longer on the shop's private list.
  const stored = store._shops.get('shop1');
  assert.deepEqual(stored.commerce.valuations, []);
  // The consumed entry is recorded on the order details for any future recovery.
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.details.consumedValuation.id, 'val1');
  assert.equal(order.details.consumedValuation.amount, 42);
});

test('a changed Item price invalidates a stored approval and fails the sale closed', async () => {
  const item = makeItem({ name: 'Potion' });
  const valuation = {
    id: 'val1',
    actorUuid: 'Actor.actor1',
    itemId: 'item1',
    amount: 42,
    fingerprint: fingerprintItem(item),
  };
  const shop = makeShop({ funds: 100, valuations: [valuation] });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  // The player inflates the item price; the stored fingerprint no longer matches.
  item.system.price = 99999;
  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'gm-approval-required');
  assert.equal(actor.wallet, 0);
  assert.ok(actor.items.get('item1'), 'the item is still owned');
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(store._orders.size, 0);
});

test('a consumed approval cannot re-pay a recreated item without a new GM valuation', async () => {
  const item = makeItem({ name: 'Potion' });
  const valuation = {
    id: 'val1',
    actorUuid: 'Actor.actor1',
    itemId: 'item1',
    amount: 42,
    fingerprint: fingerprintItem(item),
  };
  const shop = makeShop({ funds: 100, valuations: [valuation] });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item });
  const store = createFakeStore({ shop });
  const service = makeService({
    store,
    actor,
    adapter,
    // Strict approval: only a still-present, fingerprint-matching valuation pays.
    // No numeric fallback, so a consumed approval must reject rather than re-pay.
    getApprovedValuation: async (i, s) => {
      const sh = s || store._shops.get('shop1');
      const vals = (sh && sh.commerce && sh.commerce.valuations) || [];
      const e = vals.find(
        (v) => v.actorUuid === 'Actor.actor1' && v.itemId === (i && i.id)
      );
      return e && fingerprintItem(i) === e.fingerprint ? e : null;
    },
  });

  const first = await service.sell(basePayload(), 'gm1');
  assert.equal(first.status, 'committed');
  assert.equal(store._shops.get('shop1').commerce.valuations.length, 0);
  assert.equal(actor.items.get('item1'), undefined, 'the item was removed');

  // The item is recreated with the same document id, but the approval was consumed
  // at the first sale, so the same approval cannot mint a second payout.
  actor.items.set('item1', item);
  const second = await service.sell(basePayload({ requestId: 'req-2' }), 'gm1');
  assert.equal(second.status, 'error');
  assert.equal(second.error, 'gm-approval-required');
  assert.equal(actor.wallet, first.payout, 'no second credit');
});

test('a failed sale commit restores the exact consumed valuation with the listing and funds', async () => {
  const item = makeItem({ name: 'Potion' });
  const valuation = {
    id: 'val1',
    actorUuid: 'Actor.actor1',
    itemId: 'item1',
    amount: 42,
    fingerprint: fingerprintItem(item),
  };
  const shop = makeShop({ funds: 100, valuations: [valuation] });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item });
  const store = createFakeStore({ shop });
  store.state.failOrderCommit = true;
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'commit failed');
  // Compensation restored the exact consumed valuation alongside the listing/funds.
  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.valuations.length, 1);
  assert.equal(stored.commerce.valuations[0].id, 'val1');
  assert.equal(stored.commerce.valuations[0].amount, 42);
  assert.equal(stored.inventory.length, 0, 'listing removed');
  assert.equal(stored.commerce.funds, 100, 'merchant funds restored');
  const order = store._orders.get('sell:gm1:req-1');
  assert.ok(order.details.compensation.includes('shop-restored'));
});

// --------------------------------------------------------- trading gates

test('an invalid world clock fails closed before any effect', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter, now: () => NaN });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'invalid-world-time');
  assert.equal(store.state.createOrderCalls, 0);
});

test('a closed shop refuses when the world clock is provided', async () => {
  const shop = makeShop({ funds: 100, open: false });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter, now: () => 0 });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'shop-closed');
  assert.equal(store._orders.size, 0);
});

test('a closed shop refuses on the legacy path (no world clock)', async () => {
  const shop = makeShop({ funds: 100, open: false });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter }); // now null

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'shop-closed');
});

// ------------------------------------------------------------ compensation

test('a failed item delete is compensated (item kept) and the order is recorded failed', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem(), deleteFails: true });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'item-delete-failed');
  // The item was never removed, so there is nothing to restore.
  assert.ok(actor.items.get('item1'), 'item still present');
  assert.equal(actor.wallet, 0); // no credit applied
  assert.equal(store.state.updateShopCalls, 0);
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.equal(order.phase, 'final');
});

test('a failed adapter credit restores the deleted item and records failed', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100, creditFails: true });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'credit failed');
  // The item was deleted then restored because it was missing.
  assert.ok(actor.items.get('item1'), 'item restored');
  assert.equal(actor.wallet, 0);
  assert.equal(store.state.updateShopCalls, 0);
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.equal(order.details.compensation[0], 'item-restored');
});

test('a failed shop write refunds the credit, restores the item and records failed (no shop change)', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  store.state.failUpdateShop = true;
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'shop update failed');
  assert.equal(actor.wallet, 0, 'credit refunded');
  assert.ok(actor.items.get('item1'), 'item restored');
  // The write failed before persisting, so the shop has no buyback entry and
  // its funds are unchanged.
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory.length, 0);
  assert.equal(stored.commerce.funds, 100);
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('credit-refunded'));
  assert.ok(order.details.compensation.includes('item-restored'));
});

test('a failed commit refunds, restores the item and the shop, and records failed', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  store.state.failOrderCommit = true;
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'commit failed');
  assert.equal(actor.wallet, 0, 'credit refunded');
  assert.ok(actor.items.get('item1'), 'item restored');
  // The shop write had succeeded, so compensation removes the exact buyback
  // entry and refunds the merchant funds without touching other fields.
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory.length, 0);
  assert.equal(stored.commerce.funds, 100);
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('credit-refunded'));
  assert.ok(order.details.compensation.includes('item-restored'));
  assert.ok(order.details.compensation.includes('shop-restored'));
});

test('a failed shop-restore marks the order needsRecovery', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  store.state.failOrderCommit = true;
  // After the failing commit, the compensation shop-restore updateShop throws.
  let updateShopCount = 0;
  const origUpdateShop = store.updateShop.bind(store);
  store.updateShop = async (id, patch) => {
    updateShopCount += 1;
    if (updateShopCount === 2) throw new Error('shop restore failed');
    return origUpdateShop(id, patch);
  };
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.ok(res.compensation.includes('shop-restore-failed'));
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
});

// ---------------------------------------------------------------- shared lock

test('sells share the same per-shop lock as commerce purchases', async () => {
  const shop = makeShop({ funds: null });
  const adapter = makeAdapter({ minorUnits: 100 });
  // Two distinct items so the two concurrent sells do not fight.
  const itemA = makeItem({ id: 'itemA', name: 'Potion A' });
  const itemB = makeItem({ id: 'itemB', name: 'Potion B' });
  const actor = createMockActor({ item: itemA });
  actor.items.set('itemB', { ...itemB, parent: actor });

  const lockMap = createLockMap();
  function sharedRunShopExclusive(shopId, fn) {
    return lockMap.run('shop:' + shopId, fn);
  }

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

  const service = makeService({ store, actor, adapter, runShopExclusive: sharedRunShopExclusive });

  const [ra, rb] = await Promise.all([
    service.sell(basePayload({ itemId: 'itemA', requestId: 'req-a' }), 'gm1'),
    service.sell(basePayload({ itemId: 'itemB', requestId: 'req-b' }), 'gm1'),
  ]);
  assert.equal(ra.status, 'committed');
  assert.equal(rb.status, 'committed');
  assert.equal(maxDepth, 1, 'writes never overlapped under the shared lock');
  assert.equal(store._orders.size, 2, 'both sells recorded a committed order');
});

test('a commerce purchase and a sell for the same shop are serialized by the same lock', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'General Store',
    locationId: 'home',
    open: true,
    commerce: { funds: null },
    inventory: [
      {
        id: 'entry1',
        name: 'Potion',
        price: 100,
        quantity: 10,
        stockMode: 'finite',
        itemUuid: 'Compendium.books.Item.potion',
        snapshot: '',
      },
    ],
  });
  const adapter = makeAdapter({ minorUnits: 100 });
  // The purchase debits the actor's wallet; give it enough to afford the entry.
  const actor = createMockActor({ item: makeItem({ id: 'itemX', name: 'Potion X' }) });
  actor.wallet = 1000;

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

  // Commerce and the sell service both use the SAME per-shop lock.
  const commerce = createCommerce({
    store,
    getActor: async (id) => (actor.id === id ? actor : null),
    fromUuid: async () => ({ toObject: () => ({ name: 'Potion', system: { quantity: 1 } }) }),
    getAdapter: () => adapter,
    systemId: () => 'dnd5e',
    isGM: () => true,
    actorOwnedBy: () => true,
    logger: { error: () => {} },
    now: () => 1000,
    makeId,
    lockMap,
  });
  const service = makeService({
    store,
    actor,
    adapter,
    runShopExclusive: commerce.runShopExclusive,
  });

  const [purchase, sellRes] = await Promise.all([
    commerce.purchase(
      { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, requestId: 'p1' },
      'gm1'
    ),
    service.sell(basePayload({ itemId: 'itemX', requestId: 'sel1' }), 'gm1'),
  ]);

  assert.equal(purchase.status, 'committed');
  assert.equal(sellRes.status, 'committed');
  assert.equal(maxDepth, 1, 'purchase and sell writes never overlapped');
});

// -------------------------------------------------------- recovery boundary

test('a delete that resolves but leaves the item live records failed without payout', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  // The API resolves and returns the id, but the item is still live on the actor:
  // a returned deletion id alone is not sufficient proof of deletion.
  const actor = createMockActor({ item: makeItem(), deleteReturnsIdButKeepsItem: true });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'item-delete-failed');
  assert.equal(actor.wallet, 0, 'no credit applied');
  assert.ok(actor.items.get('item1'), 'item still present');
  assert.equal(store.state.updateShopCalls, 0, 'no shop write');
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.equal(order.phase, 'final');
});

test('a credit that throws after applying still refunds the payout and records failed', async () => {
  const shop = makeShop({ funds: 100 });
  // credit applies (wallet += payout) then throws; the balance verification must
  // detect the applied debit and refund it during compensation.
  const adapter = makeAdapter({ minorUnits: 100, creditAppliesThenThrows: true });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'credit failed after apply');
  assert.equal(actor.wallet, 0, 'credit refunded');
  assert.ok(actor.items.get('item1'), 'item restored');
  assert.equal(store._shops.get('shop1').inventory.length, 0, 'no shop write');
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('credit-refunded'));
  assert.ok(order.details.compensation.includes('item-restored'));
});

test('a null commit write never claims committed and records needsRecovery', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  store.state.nullOrderCommit = true;
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'order-commit-missing');
  // Effects were applied and then rolled back by compensation.
  assert.equal(actor.wallet, 0, 'credit refunded');
  assert.ok(actor.items.get('item1'), 'item restored');
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory.length, 0, 'buyback entry removed');
  assert.equal(stored.commerce.funds, 100, 'merchant funds restored');
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
});

test('a compensated debit that does not return the payout records needsRecovery, never failed', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  // getBalance reads the true wallet, but the post-refund verification read
  // reports a diverged balance so the payout refund cannot be confirmed.
  let balanceReads = 0;
  const origGetBalance = adapter.getBalance.bind(adapter);
  adapter.getBalance = async (actor) => {
    balanceReads += 1;
    const value = await origGetBalance(actor);
    return balanceReads >= 2 ? value + 1 : value;
  };
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  store.state.failOrderCommit = true;
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'commit failed');
  // The payout was refunded even though the verification diverged; the payment
  // is unresolved, so the terminal status must not be `failed`.
  assert.equal(actor.wallet, 0, 'payout refunded');
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
});

test('compensation keeps the original id and escalates to needsRecovery when the restore does not', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100, creditFails: true });
  // Force a restore that does NOT keep the original id, so the post-restore
  // `actor.items.get(itemId)` verify must fail and escalate to needsRecovery.
  const actor = createMockActor({ item: makeItem(), restoreDropsId: true });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(actor.wallet, 0);
  assert.ok(res.compensation.includes('item-restore-id-failed'));
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
});

test('a mixed shop state (listing present but funds diverged) records needsRecovery, not failed', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  // Force the commit to fail AFTER the shop write succeeded, but corrupt the
  // shop state so the listing exists yet the funds were NOT decremented - a
  // mixed/unknown state that compensation cannot safely conclude.
  store.state.failOrderCommit = true;
  const origUpdate = store.updateAdvancedOrder.bind(store);
  store.updateAdvancedOrder = async (id, patch) => {
    if (patch.status === 'committed') {
      const current = store._shops.get('shop1');
      current.commerce = { ...current.commerce, funds: 100 };
    }
    return origUpdate(id, patch);
  };
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'commit failed');
  assert.ok(res.compensation.includes('shop-state-mixed'));
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
});

test('a GM handover after the pending order marks the order failed and applies no effects', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  let active = true;
  // Flip the active-GM flag the moment the pending order is persisted, so the
  // former GM stops before applying any effect.
  const origCreate = store.createAdvancedOrder.bind(store);
  store.createAdvancedOrder = async (record) => {
    const result = await origCreate(record);
    active = false;
    return result;
  };
  const service = makeService({
    store,
    actor,
    adapter,
    isActiveGM: () => active,
  });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'gm-handoff');
  // No effect from the former GM.
  assert.equal(actor.wallet, 0);
  assert.ok(actor.items.get('item1'), 'item never deleted');
  assert.equal(actor.deletedIds.length, 0);
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(store._shops.get('shop1').inventory.length, 0);
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'failed');
});

test('a generic adapter with a configured quantityPath enforces the one-whole-item rule', async () => {
  const shop = makeShop({ funds: 100 });
  const store = createFakeStore({ shop });

  function genericAdapter({ quantityPath = 'system.quantity', deliveryMode = 'embedded' } = {}) {
    return {
      supported: true,
      systemId: 'generic',
      quantityPath,
      deliveryMode,
      async getItemPrice() {
        return { minorUnits: 100 };
      },
      async getBalance(actor) {
        return actor.wallet || 0;
      },
      async credit(actor, amount) {
        actor.wallet = (actor.wallet || 0) + amount;
        return { amount, newBalance: actor.wallet };
      },
      async debit(actor, amount) {
        actor.wallet = (actor.wallet || 0) - amount;
        return { amount, newBalance: actor.wallet };
      },
      async deliverItem() {
        return { id: 'delivered', item: null };
      },
      async removeItem() {
        return true;
      },
    };
  }

  // quantityPath resolves to 3 => stacked item.
  const stacked = makeService({
    store,
    actor: createMockActor({ item: makeItem({ quantity: 3 }) }),
    adapter: genericAdapter(),
  });
  const stackedRes = await stacked.sell(basePayload(), 'gm1');
  assert.equal(stackedRes.status, 'error');
  assert.equal(stackedRes.error, 'stacked-item');

  // quantityPath resolves to exactly 1 => the item may be sold.
  const okActor = createMockActor({ item: makeItem({ quantity: 1 }) });
  const ok = makeService({
    store: createFakeStore({ shop }),
    actor: okActor,
    adapter: genericAdapter(),
  });
  const okRes = await ok.sell(basePayload(), 'gm1');
  assert.equal(okRes.status, 'committed');

  // quantityPath points at a missing segment => invalid path.
  const missingPath = makeService({
    store: createFakeStore({ shop }),
    actor: createMockActor({ item: makeItem() }),
    adapter: genericAdapter({ quantityPath: 'system.nope' }),
  });
  const missingRes = await missingPath.sell(basePayload(), 'gm1');
  assert.equal(missingRes.status, 'error');
  assert.equal(missingRes.error, 'quantity-path-invalid');

  // A generic adapter with a non-embedded delivery mode is unsupported.
  const pathMode = makeService({
    store: createFakeStore({ shop }),
    actor: createMockActor({ item: makeItem() }),
    adapter: genericAdapter({ deliveryMode: 'path' }),
  });
  const pathRes = await pathMode.sell(basePayload(), 'gm1');
  assert.equal(pathRes.status, 'error');
  assert.equal(pathRes.error, 'delivery-mode-unsupported');
});

// --------------------------------------------------------- shop-write safety

test('a null shop write on a sale does not claim committed and records shop-write-missing', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  store.state.nullUpdateShop = true;
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'shop-write-missing');
  assert.equal(actor.wallet, 0, 'credit refunded');
  assert.ok(actor.items.get('item1'), 'item restored');
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory.length, 0, 'no buyback entry persisted');
  assert.equal(stored.commerce.funds, 100, 'funds unchanged');
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('shop-unwritten'));
});

// -------------------------------------------------------- replay originalStatus

test('a replayed committed sale carries originalStatus committed', async () => {
  const shop = makeShop({ funds: null });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem() });
  const store = createFakeStore({ shop });
  const service = makeService({ store, actor, adapter });

  const first = await service.sell(basePayload(), 'gm1');
  assert.equal(first.status, 'committed');
  const replay = await service.sell(basePayload(), 'gm1');
  assert.equal(replay.status, 'replay');
  assert.equal(replay.originalStatus, 'committed');
});

// -------------------------------------------------- commit-throw recovery

test('a final sell commit that applies then throws is treated as committed and never compensates', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem({ name: 'Potion' }) });
  const store = createFakeStore({ shop });
  // The commit write persists `committed` and THEN throws: the sale is committed
  // even though the caller never sees a successful reply.
  store.state.commitAppliesThenThrows = true;
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'committed');
  const payout = quoteSell(100, shop);
  assert.equal(res.payout, payout);
  assert.ok(res.buybackEntryId);
  assert.equal(res.itemName, 'Potion');
  // Effects are NOT reversed: no refund of the credit, no item restore.
  assert.equal(actor.wallet, payout);
  assert.equal(actor.items.get('item1'), undefined, 'item stays deleted after committed sale');
  assert.equal(actor.deletedIds.length, 1);
  assert.equal(store.state.updateShopCalls, 1, 'shop write stands');
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory.length, 1, 'buyback listing stays');
  // The persisted record is committed (the apply-then-throw committed it).
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'committed');
  assert.equal(order.phase, 'final');
  assert.deepEqual(order.outcome, { payout, buybackEntryId: res.buybackEntryId, itemName: 'Potion' });
});

test('a sell commit whose re-read throws escalates to needsRecovery without reversing effects', async () => {
  const shop = makeShop({ funds: 100 });
  const adapter = makeAdapter({ minorUnits: 100 });
  const actor = createMockActor({ item: makeItem({ name: 'Potion' }) });
  const store = createFakeStore({ shop });
  // The commit write throws, and the by-id re-read throws too: the sale cannot
  // confirm whether the order committed, so it must NOT undo the already-applied
  // effects - it escalates instead.
  store.state.failOrderCommit = true;
  store.state.failFindOrder = true;
  const service = makeService({ store, actor, adapter });

  const res = await service.sell(basePayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'commit failed');
  assert.deepEqual(res.compensation, []);
  const payout = store._orders.get('sell:gm1:req-1').details.payout;
  // Effects are NOT reversed: the credit stands, the item stays deleted, and the
  // shop write stands.
  assert.equal(actor.wallet, payout);
  assert.equal(actor.items.get('item1'), undefined);
  assert.equal(actor.deletedIds.length, 1);
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory.length, 1, 'buyback listing stays');
  assert.equal(stored.commerce.funds, 100 - payout, 'merchant funds not refunded');
  // The order was marked needsRecovery (the marker write is safe here).
  const order = store._orders.get('sell:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
  assert.equal(order.error, 'commit failed');
});
