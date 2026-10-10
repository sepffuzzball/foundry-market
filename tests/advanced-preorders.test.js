// Unit tests for the M5 GM-authoritative out-of-stock pre-order with paid
// deposit in `src/advanced/preorders.js`.
//
// These are pure Node tests (no Foundry globals) using a fake store, a fake
// actor, and a fake adapter, plus the real lock map so a pre-order can be shown
// to share the per-shop lock with purchases. They cover the place/fulfill/cancel
// success paths and their exact side effects (deposit charged exactly once,
// finite merchant funds, no stock reservation, and the separate idempotent
// fulfill/cancel action orders), the validation gates (preorders disabled,
// stock-sufficient, insufficient stock, restricted/hidden entry, Hated
// reputation, insufficient funds, insufficient merchant funds, max-per-actor),
// the replay/conflict/needsRecovery idempotency, the GM-only and ownership gates,
// the compensation paths (debit/deliver/credit/refund/shop-write/status failure
// injection), and the shared per-shop lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPreorderCommerce } from '../src/advanced/preorders.js';
import {
  computePlaceIntentHash,
  computeFulfillIntentHash,
  computeCancelIntentHash,
} from '../src/advanced/preorders.js';
import { normalizeShop, makeId } from '../src/services/model.js';
import { createLockMap } from '../src/services/commerce.js';

// ---------------------------------------------------------------- helpers

export function makeEntry(overrides = {}) {
  const {
    id = 'entry1',
    name = 'Potion',
    price = 100,
    quantity = 0,
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
    deliveredIds: [],
    removedIds: [],
    async update() {
      return this;
    },
  };
}

export function makeAdapter({
  supported = true,
  debitThrows = false,
  debitAppliesThenThrows = false,
  creditThrows = false,
  creditAppliesThenThrows = false,
  failDeliveryOn = null,
  removeFails = false,
} = {}) {
  let deliverCount = 0;
  const adapter = {
    supported,
    deliveryMode: 'embedded',
    quantityPath: '',
    removedIds: [],
    async getBalance(actor) {
      return actor.wallet || 0;
    },
    async debit(actor, amount) {
      if (debitThrows) throw new Error('debit failed');
      if (actor.wallet < amount) throw new Error('insufficient funds');
      actor.wallet = (actor.wallet || 0) - amount;
      if (debitAppliesThenThrows) throw new Error('debit applied then threw');
      return { amount, newBalance: actor.wallet };
    },
    async credit(actor, amount) {
      if (creditThrows) throw new Error('credit failed');
      actor.wallet = (actor.wallet || 0) + amount;
      if (creditAppliesThenThrows) throw new Error('credit applied then threw');
      return { amount, newBalance: actor.wallet };
    },
    async deliverItem(actor, item, { quantity = 1 } = {}) {
      deliverCount += 1;
      if (failDeliveryOn != null && deliverCount === failDeliveryOn) {
        throw new Error('deliver failed');
      }
      const createdId = `delivered-${makeId()}`;
      actor.deliveredIds.push(createdId);
      return { id: createdId, item };
    },
    async removeItem(actor, id) {
      if (removeFails) throw new Error('remove failed');
      adapter.removedIds.push(id);
      actor.removedIds.push(id);
      return true;
    },
  };
  return adapter;
}

export function makeShop({
  inventory = [],
  funds = null,
  open = true,
  depositBps = 2500,
  maxPerActor = 3,
  preordersEnabled = true,
} = {}) {
  return normalizeShop({
    id: 'shop1',
    name: 'General Store',
    locationId: 'home',
    open,
    inventory,
    commerce: {
      funds,
      preorders: { enabled: preordersEnabled, depositBps, maxPerActor },
    },
  });
}

export function createFakeStore({ shop } = {}) {
  const shops = new Map();
  if (shop) shops.set(shop.id, shop);
  const orders = new Map(); // by id
  const ordersByKey = new Map();
  const state = {
    findShopCalls: 0,
    updateShopCalls: 0,
    findOrderCalls: 0,
    createOrderCalls: 0,
    updateOrderCalls: 0,
    failUpdateShop: false,
    applyThenFailUpdateShop: false,
    nullUpdateShop: false,
    failStatuses: new Set(),
    applyThenFailStatuses: new Set(),
    nullStatuses: new Set(),
  };
  const store = {
    state,
    _shops: shops,
    _orders: orders,
    _ordersByKey: ordersByKey,
    async findShop(id) {
      state.findShopCalls += 1;
      return shops.get(id) || null;
    },
    async updateShop(id, patch) {
      state.updateShopCalls += 1;
      if (state.applyThenFailUpdateShop) {
        state.applyThenFailUpdateShop = false;
        const current = shops.get(id);
        if (!current) return null;
        const next = { ...current, ...patch };
        shops.set(id, next);
        throw new Error('shop update applied then failed');
      }
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
      return ordersByKey.get(key) || null;
    },
    async findAdvancedOrder(id) {
      return orders.get(id) || null;
    },
    async listAdvancedOrders({ shopId, actorId, status, kind, limit = 100, offset = 0 } = {}) {
      let records = [...orders.values()];
      if (shopId != null) records = records.filter((r) => r.shopId === shopId);
      if (actorId != null) records = records.filter((r) => r.actorId === actorId);
      if (status != null) records = records.filter((r) => r.status === status);
      if (kind != null) records = records.filter((r) => r.kind === kind);
      records = records.sort((a, b) => b.createdAt - a.createdAt);
      const safeLimit = Math.max(0, Math.min(limit, 100));
      const safeOffset = Math.max(0, offset);
      return records.slice(safeOffset, safeOffset + safeLimit);
    },
    async createAdvancedOrder(record) {
      state.createOrderCalls += 1;
      const normalized = { ...record, id: record.id || makeId() };
      const existing = ordersByKey.get(normalized.key);
      if (existing) return { record: existing, created: false };
      ordersByKey.set(normalized.key, normalized);
      orders.set(normalized.id, normalized);
      return { record: normalized, created: true };
    },
    async updateAdvancedOrder(id, patch) {
      state.updateOrderCalls += 1;
      if (patch.status && state.applyThenFailStatuses.has(patch.status)) {
        state.applyThenFailStatuses.delete(patch.status);
        const rec = orders.get(id);
        if (!rec) return null;
        const next = { ...rec, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
        orders.set(id, next);
        if (ordersByKey.get(next.key) === rec) ordersByKey.set(next.key, next);
        throw new Error('status write applied then failed');
      }
      if (patch.status && state.failStatuses.has(patch.status)) {
        state.failStatuses.delete(patch.status);
        throw new Error('status write failed');
      }
      if (patch.status && state.nullStatuses.has(patch.status)) {
        state.nullStatuses.delete(patch.status);
        return null;
      }
      const rec = orders.get(id);
      if (!rec) return null;
      const next = { ...rec, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
      orders.set(id, next);
      if (ordersByKey.get(next.key) === rec) ordersByKey.set(next.key, next);
      return next;
    },
  };
  return store;
}

export function makePreorderCommerce({
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
} = {}) {
  return createPreorderCommerce({
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
    logger: { error: () => {} },
  });
}

export function placePayload(overrides = {}) {
  return {
    shopId: 'shop1',
    entryId: 'entry1',
    actorId: 'actor1',
    quantity: 1,
    requestId: 'req-1',
    ...overrides,
  };
}

export function actionPayload(orderId, overrides = {}) {
  return { orderId, requestId: 'req-1', ...overrides };
}

// ---------------------------------------------------------------- place success

test('place charges the deposit exactly once and grants finite merchant funds, no stock reserved', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.place(placePayload(), 'gm1');

  assert.equal(res.status, 'booked');
  assert.ok(res.orderId);
  assert.equal(res.entryId, 'entry1');
  assert.equal(res.quantity, 1);
  assert.equal(res.total, 100);
  assert.equal(res.deposit, 25); // ceil(100 * 2500 / 10000)
  assert.equal(res.remaining, 75);

  // Actor debited exactly the deposit once.
  assert.equal(actor.wallet, 1000 - 25);

  // Finite merchant funds gained the deposit in a single shop write.
  assert.equal(store.state.updateShopCalls, 1);
  assert.equal(store._shops.get('shop1').commerce.funds, 1025);

  // The order was committed `booked` with a bounded public outcome.
  const order = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(order.kind, 'preorder');
  assert.equal(order.status, 'booked');
  assert.equal(order.phase, 'final');
  assert.equal(order.deposit, 25);
  assert.equal(order.remaining, 75);
  assert.deepEqual(order.outcome, {
    orderId: res.orderId,
    entryId: 'entry1',
    quantity: 1,
    total: 100,
    deposit: 25,
    remaining: 75,
  });

  // NO stock was reserved: the entry quantity stays 0.
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 0);
});

test('place on unlimited stock refuses as stock-sufficient', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', name: 'Potion', price: 100, stockMode: 'unlimited' }),
    ],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'stock-sufficient');
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(actor.wallet, 1000);
});

test('place on an in-stock finite entry refuses as stock-sufficient', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 5 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload({ quantity: 2 }), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'stock-sufficient');
});

test('place on a finite entry that cannot serve the quantity is allowed', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 1 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload({ quantity: 2 }), 'gm1');
  assert.equal(res.status, 'booked');
});

// ---------------------------------------------------------------- place gates

test('place fails closed when preorders are disabled', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    preordersEnabled: false,
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'preorders-disabled');
  assert.equal(actor.wallet, 1000);
});

test('place refuses a hidden entry and a restricted entry', async () => {
  const hidden = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0, visible: false })],
    funds: null,
  });
  const actor1 = createMockActor({ wallet: 1000 });
  let store = createFakeStore({ shop: hidden });
  let service = makePreorderCommerce({ store, actor: actor1, adapter: makeAdapter() });
  let res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'entry-hidden');

  // restricted via a backroom entry the actor cannot access
  const restricted = makeShop({
    inventory: [
      makeEntry({
        id: 'entry1',
        price: 100,
        quantity: 0,
        access: { mode: 'backroom', actorUuids: [], minReputation: 10 },
      }),
    ],
    funds: null,
  });
  const actor2 = createMockActor({ wallet: 1000, uuid: 'Actor.other' });
  store = createFakeStore({ shop: restricted });
  service = makePreorderCommerce({
    store,
    actor: actor2,
    adapter: makeAdapter(),
    getSocial: async () => ({ individual: 0, party: 0, score: -100 }),
  });
  res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'entry-restricted');
});

test('place refuses a Hated reputation as service-refused', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter: makeAdapter(),
    // An effective reputation of -100 falls in the Hated band, which refuses.
    getSocial: async () => ({ individual: -100, party: 0, score: -100 }),
  });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'service-refused');
  assert.equal(actor.wallet, 1000);
  assert.equal(store.state.updateShopCalls, 0);
});

test('place refuses insufficient funds for the deposit', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 10 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'insufficient-funds');
  assert.equal(actor.wallet, 10);
  assert.equal(store.state.updateShopCalls, 0);
});

test('place refuses when the actor already hit the max-per-actor cap', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: null,
    maxPerActor: 1,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  // Seed one live booked preorder for the same actor+entry.
  store.createAdvancedOrder({
    key: 'preorder:gm1:seed',
    kind: 'preorder',
    status: 'booked',
    phase: 'final',
    shopId: 'shop1',
    userId: 'gm1',
    actorId: 'actor1',
    entryId: 'entry1',
    quantity: 1,
    total: 100,
    deposit: 25,
    remaining: 75,
    intentHash: 'x',
    details: {},
    outcome: {},
  });
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'max-preorders-reached');
});

test('place refuses an entry with no resolvable item source', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', price: 100, quantity: 0, itemUuid: 'Item.missing', snapshot: 'not-json' }),
    ],
    funds: null,
  });
  // The uuid does not resolve (fromUuid null) and the snapshot is invalid JSON,
  // so no source can be resolved and the place fails closed.
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'item-source-missing');
});

test('place validates quantity range before any effect', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({ store, actor, adapter: makeAdapter() });

  const tooFew = await service.place(placePayload({ quantity: 0 }), 'gm1');
  assert.equal(tooFew.status, 'error');

  const tooMany = await service.place(placePayload({ quantity: 21 }), 'gm1');
  assert.equal(tooMany.status, 'error');
  assert.equal(actor.wallet, 1000);
});

// ---------------------------------------------------------------- place idempotency

test('a booked pre-order replays with no re-charge and no re-write', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const first = await service.place(placePayload(), 'gm1');
  assert.equal(first.status, 'booked');
  const wallet = actor.wallet;
  const writes = store.state.updateShopCalls;

  const again = await service.place(placePayload(), 'gm1');
  assert.equal(again.status, 'replay');
  assert.equal(again.orderId, first.orderId);
  assert.equal(again.deposit, first.deposit);
  assert.equal(actor.wallet, wallet);
  assert.equal(store.state.updateShopCalls, writes);
  assert.equal(store._orders.size, 1);
});

test('a pending pre-order replay surfaces needsRecovery and never recharges', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({ store, actor, adapter: makeAdapter() });

  // Simulate an interrupted run that left a pending pre-order with intent.
  const intentHash = computePlaceIntentHash({
    shopId: 'shop1',
    entryId: 'entry1',
    actorId: 'actor1',
    quantity: 1,
    requester: 'gm1',
  });
  await store.createAdvancedOrder({
    key: 'preorder:gm1:req-1',
    kind: 'preorder',
    status: 'pending',
    phase: 'recorded',
    shopId: 'shop1',
    userId: 'gm1',
    actorId: 'actor1',
    entryId: 'entry1',
    quantity: 1,
    total: 100,
    deposit: 25,
    remaining: 75,
    intentHash,
    details: {},
    outcome: {},
    error: '',
  });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(actor.wallet, 1000);
  assert.equal(store.state.updateShopCalls, 0);
});

test('same key with a changed quantity is a conflict and applies no effect', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({ store, actor, adapter: makeAdapter() });

  const first = await service.place(placePayload({ quantity: 1 }), 'gm1');
  assert.equal(first.status, 'booked');
  const wallet = actor.wallet;

  const conflict = await service.place(placePayload({ quantity: 2 }), 'gm1');
  assert.equal(conflict.status, 'conflict');
  assert.equal(actor.wallet, wallet);
});

// ---------------------------------------------------------------- place compensation

test('a throwing debit leaves a failed pre-order with no deposit moved', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter({ debitThrows: true });
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload(), 'gm1');
  // The debit threw without applying, so there is nothing to refund; the order
  // is simply failed and no funds moved.
  assert.equal(res.status, 'failed');
  assert.equal(actor.wallet, 1000);
  assert.equal(store._shops.get('shop1').commerce.funds, 1000);
  const order = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.deepEqual(order.details.compensation, []);
});

test('a debit that applies then throws is rolled back via balance verification', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter({ debitAppliesThenThrows: true });
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload(), 'gm1');
  // The debit applied then threw; compensation refunds it, so the wallet is
  // restored, and the finite merchant funds write never happened.
  assert.equal(res.status, 'failed');
  assert.equal(actor.wallet, 1000);
  assert.equal(store._shops.get('shop1').commerce.funds, 1000);
  const order = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('deposit-refunded'));
});

test('a merchant-funds shop write failure restores the deposit and marks needsRecovery-agnostic failed', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  store.state.failUpdateShop = true;
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'failed');
  // The debit was applied (deposit taken) so compensation refunds it.
  assert.equal(actor.wallet, 1000);
  const order = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('deposit-refunded'));
});

test('a status write failure on the booked commit escapes to needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  store.state.nullStatuses.add('booked');
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  // effects applied, order not booked: needsRecovery reflects the state.
  const order = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
  assert.equal(order.deposit, 25);
});

test('a booking commit that applies then throws returns booked, retaining deposit and merchant funds', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  // The final `booked` commit APPLIES then throws. The place must re-read the
  // original, see the booking actually persisted, and return `booked` WITHOUT
  // refunding the deposit or restoring merchant funds - a persisted booking is
  // never undone just because the write threw after it landed.
  store.state.applyThenFailStatuses.add('booked');
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'booked');
  assert.equal(res.entryId, 'entry1');
  assert.equal(res.quantity, 1);
  assert.equal(res.total, 100);
  assert.equal(res.deposit, 25);
  assert.equal(res.remaining, 75);

  // Deposit stayed debited and merchant funds stayed gained: NO reversal.
  assert.equal(actor.wallet, 1000 - 25);
  assert.equal(store._shops.get('shop1').commerce.funds, 1025);
  // The order is genuinely booked, never failed/needsRecovery.
  const order = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(order.status, 'booked');
  assert.equal(order.phase, 'final');
  assert.deepEqual(order.outcome, {
    orderId: res.orderId,
    entryId: 'entry1',
    quantity: 1,
    total: 100,
    deposit: 25,
    remaining: 75,
  });
});

test('an unreadable re-read after a throwing booking commit escalates needsRecovery with deposit/funds retained', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  // The final `booked` commit throws cleanly (did NOT persist), and the follow-up
  // re-read of the original is UNAVAILABLE (throws). The place must NOT reverse
  // the deposit debit or the merchant-funds gain; it escalates to needsRecovery
  // and attempts a safe marker without overwriting a genuinely booked record.
  store.state.failStatuses.add('booked');
  let rereadUnavailable = false;
  const origFind = store.findAdvancedOrder.bind(store);
  store.findAdvancedOrder = async (id) => {
    if (!rereadUnavailable) {
      rereadUnavailable = true;
      throw new Error('re-read unavailable');
    }
    return origFind(id);
  };
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  // No reversal: the deposit stayed debited and merchant funds stayed gained.
  assert.equal(actor.wallet, 1000 - 25);
  assert.equal(store._shops.get('shop1').commerce.funds, 1025);
  // Not falsely marked failed; the safe marker recorded needsRecovery (the record
  // was still pending, never a matching booked) and the deposit amount is intact.
  const order = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
  assert.equal(order.deposit, 25);
  // No reversal entries were written (nothing was compensated/refunded).
  assert.deepEqual(order.outcome, {});
});

// ---------------------------------------------------------------- auth / gm gate

test('the non-active-GM gate runs no store read and no effect', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    isActiveGM: () => false,
  });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'not-active-gm');
  assert.equal(store.state.findShopCalls, 0);
  assert.equal(store.state.createOrderCalls, 0);
});

test('an actor not owned by the requester is refused before any order', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: null,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    actorOwnedBy: () => false,
  });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'actor-not-owned');
  assert.equal(store.state.createOrderCalls, 0);
});

test('a malformed quantity fails closed before any read', async () => {
  const shop = makeShop({});
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({ store, actor: createMockActor(), adapter: makeAdapter() });

  const res = await service.place(placePayload({ quantity: 'x' }), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(store.state.findShopCalls, 0);
});

// ---------------------------------------------------------------- fulfill

test('fulfill charges the remaining once, delivers, decrements stock, and gains funds', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');
  // The deposit was charged once; no stock was reserved yet.
  assert.equal(actor.wallet, 975);
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 0);

  // Restore stock (the out-of-stock item has since been replenished), then
  // fulfill.
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  const res = await service.fulfill(
    actionPayload(placed.orderId),
    'gm1'
  );

  assert.equal(res.status, 'fulfilled');
  assert.equal(res.orderId, placed.orderId);
  assert.equal(res.quantity, 1);
  assert.equal(res.remaining, 75);

  // Remaining charged once, on top of the deposit.
  assert.equal(actor.wallet, 975 - 75);
  // Delivered one item.
  assert.equal(actor.deliveredIds.length, 1);
  assert.equal(store.state.updateShopCalls, 2); // place wrote once, fulfill wrote once
  // Stock decremented from 5 to 4, and merchant funds gained 75.
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 4);
  assert.equal(store._shops.get('shop1').commerce.funds, 1025 + 75);

  // The original was marked fulfilled and the action committed separately.
  const original = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(original.status, 'fulfilled');
  const action = store._ordersByKey.get(`preorder-fulfill:${placed.orderId}:req-1`);
  assert.equal(action.kind, 'preorder-fulfill');
  assert.equal(action.status, 'committed');
  assert.equal(action.relatedOrderId, placed.orderId);
  assert.equal(action.remaining, 75);
});

test('fulfill refuses when stock is insufficient now', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload({ quantity: 2 }), 'gm1');
  assert.equal(placed.status, 'booked');

  // Stock restored to only 1, but quantity is 2.
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 1 }));
  store._shops.set('shop1', current);

  const res = await service.fulfill(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'insufficient-stock');
  // No second charge, no delivery, stock untouched. Quantity 2 => total 200,
  // deposit 50, so the wallet held the 50 deposit and nothing more was taken.
  assert.equal(actor.wallet, 1000 - 50);
  assert.equal(actor.deliveredIds.length, 0);
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 1);
});

test('fulfill refuses when the actor cannot cover the remaining balance', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');
  // The wallet covered the 25 deposit; now drop it below the 75 remaining so the
  // fulfill must fail closed before any effect.
  actor.wallet = 30;
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  const res = await service.fulfill(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'insufficient-funds');
  assert.equal(actor.deliveredIds.length, 0);
});

test('an already-fulfilled pre-order replays with no second delivery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  const first = await service.fulfill(actionPayload(placed.orderId, { requestId: 'f1' }), 'gm1');
  assert.equal(first.status, 'fulfilled');
  const wallet = actor.wallet;
  const writes = store.state.updateShopCalls;
  const delivered = actor.deliveredIds.length;

  const again = await service.fulfill(actionPayload(placed.orderId, { requestId: 'f1' }), 'gm1');
  assert.equal(again.status, 'replay');
  assert.equal(actor.wallet, wallet);
  assert.equal(store.state.updateShopCalls, writes);
  assert.equal(actor.deliveredIds.length, delivered);
});

test('fulfill requires a preorder kind and a booked status', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({ store, actor, adapter });

  // A non-preorder order.
  const o = await store.createAdvancedOrder({
    key: 'x:1',
    kind: 'service',
    status: 'booked',
    phase: 'final',
    shopId: 'shop1',
    userId: 'gm1',
    actorId: 'actor1',
    entryId: 'entry1',
    quantity: 1,
    total: 100,
    deposit: 0,
    remaining: 0,
    intentHash: 'x',
    details: {},
    outcome: {},
  });
  let res = await service.fulfill(actionPayload(o.record.id), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'order-not-preorder');

  // A preorder in the wrong status.
  const p = await store.createAdvancedOrder({
    key: 'preorder:gm1:p',
    kind: 'preorder',
    status: 'pending',
    phase: 'recorded',
    shopId: 'shop1',
    userId: 'gm1',
    actorId: 'actor1',
    entryId: 'entry1',
    quantity: 1,
    total: 100,
    deposit: 25,
    remaining: 75,
    intentHash: 'x',
    details: {},
    outcome: {},
  });
  res = await service.fulfill(actionPayload(p.record.id), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'order-not-booked');
});

// ---------------------------------------------------------------- fulfill compensation

test('a failing fulfill refunds the remaining, removes delivery, restores stock and funds', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  // Fail the shop write AFTER debit + deliver.
  store.state.failUpdateShop = true;

  const res = await service.fulfill(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'failed');
  // Remaining refunded: wallet back to post-deposit value.
  assert.equal(actor.wallet, 1000 - 25);
  // Delivery removed.
  assert.equal(actor.removedIds.length, 1);
  // Shop untouched (the write failed).
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 5);
  assert.equal(store._shops.get('shop1').commerce.funds, 1025);
  // Original left booked.
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'booked');
  // The action order is failed/needsRecovery; effects undone so failed.
  const action = store._ordersByKey.get(`preorder-fulfill:${placed.orderId}:req-1`);
  assert.equal(action.status, 'failed');
  assert.ok(action.details.compensation.includes('remaining-refunded'));
});

test('an ambiguous fulfill recovery escalates to needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter({ removeFails: true });
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  // A failing shop-write constructor that leaves the order still booked.
  store.state.failUpdateShop = true;

  const res = await service.fulfill(actionPayload(placed.orderId), 'gm1');
  // removeItem (compensating delivery removal) fails => uncertain => needsRecovery.
  assert.equal(res.status, 'needsRecovery');
});

test('a fulfill action-commit failure preserves the fulfilled original and escalates to needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  // The original `fulfilled` write succeeds; the action `committed` write returns
  // null, so the fulfill is uncertain. Effects remain, original stays fulfilled.
  store.state.nullStatuses.add('committed');

  const res = await service.fulfill(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'fulfilled');
  const action = store._ordersByKey.get(`preorder-fulfill:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
  // No second delivery, no double charge.
  assert.equal(actor.deliveredIds.length, 1);
  assert.equal(actor.wallet, 975 - 75);
});

test('a cancel action-commit failure preserves the cancelled original and escalates to needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');

  // The original `cancelled` write succeeds; the action `committed` write returns
  // null, so the cancel is uncertain. The refund is already done, original stays
  // cancelled.
  store.state.nullStatuses.add('committed');

  const res = await service.cancel(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'cancelled');
  const action = store._ordersByKey.get(`preorder-cancel:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
  // No double refund.
  assert.equal(actor.wallet, 1000);
});

// ---------------------------------------------------------------- cancel

test('cancel refunds the deposit and decrements finite merchant funds', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');
  assert.equal(actor.wallet, 975);

  const res = await service.cancel(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'cancelled');
  assert.equal(res.orderId, placed.orderId);
  assert.equal(res.deposit, 25);

  // Deposit refunded.
  assert.equal(actor.wallet, 1000);
  // Finite merchant funds decremented by the deposit.
  assert.equal(store._shops.get('shop1').commerce.funds, 1000);
  // Original cancelled, action committed separately.
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'cancelled');
  const action = store._ordersByKey.get(`preorder-cancel:${placed.orderId}:req-1`);
  assert.equal(action.kind, 'preorder-cancel');
  assert.equal(action.status, 'committed');
  assert.equal(action.relatedOrderId, placed.orderId);
  assert.equal(action.deposit, 25);
});

test('cancel refuses when finite merchant funds cannot cover the deposit', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: 20,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');
  const wallet = actor.wallet;
  // The shop gained the 25 deposit on place, but we simulate it having spent the
  // deposit since (down to 10), so it can no longer refund the 25.
  store._shops.get('shop1').commerce.funds = 10;

  const res = await service.cancel(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'insufficient-merchant-funds');
  assert.equal(actor.wallet, wallet);
  assert.equal(store.state.updateShopCalls, 1); // only the place write
});

test('cancel replays with no double refund on the same key', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  const first = await service.cancel(actionPayload(placed.orderId), 'gm1');
  assert.equal(first.status, 'cancelled');
  const wallet = actor.wallet;
  const writes = store.state.updateShopCalls;

  const again = await service.cancel(actionPayload(placed.orderId), 'gm1');
  assert.equal(again.status, 'replay');
  assert.equal(actor.wallet, wallet);
  assert.equal(store.state.updateShopCalls, writes);
});

test('cancel cannot cancel an already-fulfilled pre-order', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);
  const f = await service.fulfill(actionPayload(placed.orderId, { requestId: 'f1' }), 'gm1');
  assert.equal(f.status, 'fulfilled');

  const res = await service.cancel(actionPayload(placed.orderId, { requestId: 'c1' }), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'order-not-booked');
});

test('a failing cancel credits back the deposit and restores merchant funds', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');
  assert.equal(actor.wallet, 975);

  // Fail the merchant funds patch AFTER the credit.
  store.state.failUpdateShop = true;

  const res = await service.cancel(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'failed');
  // Credit was applied, compensation debits it back -> wallet back to 975.
  assert.equal(actor.wallet, 975);
  // Shop write failed, so funds stay at the post-place 1025.
  assert.equal(store._shops.get('shop1').commerce.funds, 1025);
  // Original still booked.
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'booked');
});

// ---------------------------------------------------------------- shared lock

test('concurrent pre-order operations share the same per-shop lock and never overlap writes', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 }),
      makeEntry({ id: 'entry2', name: 'Sword', price: 500, quantity: 0 }),
    ],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 5000 });
  const adapter = makeAdapter();
  const lockingStore = createFakeStore({ shop });
  const lockMap = createLockMap();
  const sharedRunShopExclusive = (shopId, fn) => lockMap.run('shop:' + shopId, fn);

  let depth = 0;
  let maxDepth = 0;
  const origUpdateShop = lockingStore.updateShop.bind(lockingStore);
  lockingStore.updateShop = async (id, patch) => {
    depth += 1;
    maxDepth = Math.max(maxDepth, depth);
    await new Promise((r) => setTimeout(r, 2));
    const result = await origUpdateShop(id, patch);
    depth -= 1;
    return result;
  };

  const service = makePreorderCommerce({
    store: lockingStore,
    actor,
    adapter,
    runShopExclusive: sharedRunShopExclusive,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const [ra, rb] = await Promise.all([
    service.place(
      placePayload({ entryId: 'entry1', requestId: 'req-a' }),
      'gm1'
    ),
    service.place(
      placePayload({ entryId: 'entry2', requestId: 'req-b' }),
      'gm1'
    ),
  ]);

  assert.equal(ra.status, 'booked');
  assert.equal(rb.status, 'booked');
  assert.equal(maxDepth, 1, 'writes never overlapped under the shared lock');
});

// ---------------------------------------------------------------- action recovery recovery
//
// The following tests exercise the reviewed release-blocker fixes: paging through
// ALL orders (the store caps at 100 per page), refusing a new fulfill/cancel
// action key while a pending/needsRecovery action for the same original exists
// (even under a different requestId), recovering a shop write that THREW (and may
// have landed) rather than only one that returned a value, forcing needsRecovery
// on a delivery throw with no known created id, escalating (never undoing) when
// the original was actually fulfilled/cancelled despite a throwing write, and
// verifying resolved actor-wallet compensations via getBalance.

test('a pending fulfill action under a different requestId blocks a new fulfill with needsRecovery and no mutation', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  // A concurrent GM persisted a pending fulfill action for the SAME original
  // under a DIFFERENT requestId. The new request must not run a second fulfill.
  const stale = await store.createAdvancedOrder({
    key: `preorder-fulfill:${placed.orderId}:req-other`,
    kind: 'preorder-fulfill',
    status: 'pending',
    phase: 'recorded',
    shopId: 'shop1',
    userId: 'gm-other',
    actorId: 'actor1',
    entryId: 'entry1',
    relatedOrderId: placed.orderId,
    quantity: 1,
    total: 100,
    deposit: 25,
    remaining: 75,
    intentHash: 'x',
    details: {},
    outcome: {},
  });
  assert.equal(stale.created, true);

  const wallet = actor.wallet;
  const writes = store.state.updateShopCalls;
  const delivered = actor.deliveredIds.length;

  const res = await service.fulfill(actionPayload(placed.orderId, { requestId: 'req-new' }), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  // No effect applied: no second debit, no delivery, no shop write, and no new
  // action record was created.
  assert.equal(actor.wallet, wallet);
  assert.equal(store.state.updateShopCalls, writes);
  assert.equal(actor.deliveredIds.length, delivered);
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'booked');
  assert.equal(store._ordersByKey.get(`preorder-fulfill:${placed.orderId}:req-new`), undefined);
});

test('a needsRecovery fulfill action under a different requestId blocks a new fulfill with needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  await store.createAdvancedOrder({
    key: `preorder-fulfill:${placed.orderId}:req-other`,
    kind: 'preorder-fulfill',
    status: 'needsRecovery',
    phase: 'final',
    shopId: 'shop1',
    userId: 'gm-other',
    actorId: 'actor1',
    entryId: 'entry1',
    relatedOrderId: placed.orderId,
    quantity: 1,
    total: 100,
    deposit: 25,
    remaining: 75,
    intentHash: 'x',
    details: {},
    outcome: {},
    error: 'something was uncertain',
  });

  const res = await service.fulfill(actionPayload(placed.orderId, { requestId: 'req-new' }), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(store._ordersByKey.get(`preorder-fulfill:${placed.orderId}:req-new`), undefined);
});

test('a pending cancel action under a different requestId blocks a new cancel with needsRecovery and no mutation', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');

  await store.createAdvancedOrder({
    key: `preorder-cancel:${placed.orderId}:req-other`,
    kind: 'preorder-cancel',
    status: 'pending',
    phase: 'recorded',
    shopId: 'shop1',
    userId: 'gm-other',
    actorId: 'actor1',
    entryId: 'entry1',
    relatedOrderId: placed.orderId,
    quantity: 1,
    total: 100,
    deposit: 25,
    remaining: 75,
    intentHash: 'x',
    details: {},
    outcome: {},
  });

  const wallet = actor.wallet;
  const writes = store.state.updateShopCalls;
  const res = await service.cancel(actionPayload(placed.orderId, { requestId: 'req-new' }), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(actor.wallet, wallet);
  assert.equal(store.state.updateShopCalls, writes);
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'booked');
  assert.equal(store._ordersByKey.get(`preorder-cancel:${placed.orderId}:req-new`), undefined);
});

test('place pages through ALL preorders to enforce the max-per-actor cap beyond 100 orders', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: null,
    maxPerActor: 3,
  });
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  // Seed 150 live booked preorders for this actor+entry - more than one full
  // 100-record page - so a bounded single-page read would miss bookable orders.
  for (let i = 0; i < 150; i += 1) {
    await store.createAdvancedOrder({
      key: `preorder:gm1:seed-${i}`,
      kind: 'preorder',
      status: 'booked',
      phase: 'final',
      shopId: 'shop1',
      userId: 'gm1',
      actorId: 'actor1',
      entryId: 'entry1',
      quantity: 1,
      total: 100,
      deposit: 25,
      remaining: 75,
      intentHash: 'x',
      details: {},
      outcome: {},
    });
  }
  const service = makePreorderCommerce({ store, actor, adapter: makeAdapter() });
  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'max-preorders-reached');
  // No effect applied.
  assert.equal(actor.wallet, 1000);
  assert.equal(store._orders.size, 150);
});

test('a merchant-funds write that lands then throws is restored, never left residual', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  // The single funds patch APPLIES (funds become 1025) and then throws, so the
  // recovery must re-read and restore the known-applied write.
  store.state.applyThenFailUpdateShop = true;
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(actor.wallet, 1000);
  assert.equal(store._shops.get('shop1').commerce.funds, 1000);
  const order = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('deposit-refunded'));
  assert.ok(order.details.compensation.includes('shop-restored'));
});

test('a fulfill shop write that lands then throws restores stock and funds, never residual', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  // The single fulfill shop write (stock + funds) APPLIES then throws.
  store.state.applyThenFailUpdateShop = true;

  const res = await service.fulfill(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(actor.wallet, 1000 - 25);
  assert.equal(actor.removedIds.length, 1);
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 5);
  assert.equal(store._shops.get('shop1').commerce.funds, 1025);
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'booked');
  const action = store._ordersByKey.get(`preorder-fulfill:${placed.orderId}:req-1`);
  assert.equal(action.status, 'failed');
  assert.ok(action.details.compensation.includes('remaining-refunded'));
  assert.ok(action.details.compensation.includes('shop-restored'));
});

test('a delivery that throws without a known created id forces needsRecovery, not refund-and-failed', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter({ failDeliveryOn: 1 });
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  const res = await service.fulfill(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  // The remaining was refunded best-effort, but the delivery outcome is unknown,
  // so the action must be manually reconciled rather than terminal.
  assert.equal(actor.wallet, 1000 - 25);
  assert.equal(actor.deliveredIds.length, 0);
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'booked');
  const action = store._ordersByKey.get(`preorder-fulfill:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 5);
});

test('a successful delivery with no safe created id is uncertain and never calls removeItem(null)', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  // The adapter delivers the item but returns a response with no usable id, so
  // the created item cannot be removed during compensation.
  adapter.deliverItem = async (a, item, opts) => {
    a.deliveredIds.push(`delivered-${makeId()}`);
    return { item };
  };
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  // Fail the shop write AFTER the debit + delivery, so compensation must run
  // while the created id is unknown. The resolve must NOT claim a clean
  // refund-and-failed, and must NOT pass a null id to removeItem.
  store.state.failUpdateShop = true;

  const res = await service.fulfill(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  // Remaining refunded (wallet back to post-deposit), but the item cannot be
  // removed because its id is unknown.
  assert.equal(actor.wallet, 1000 - 25);
  assert.equal(actor.deliveredIds.length, 1, 'the item WAS delivered');
  assert.equal(adapter.removedIds.length, 0, 'removeItem was never called with a null/undefined id');
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'booked');
  const action = store._ordersByKey.get(`preorder-fulfill:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
  assert.ok(action.details.compensation.includes('item-unknown'));
});

test('a delivery that creates an item then throws is uncertain and never calls removeItem(null)', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  // The adapter creates the item, THEN throws - the created id is lost, so the
  // fulfill must escalate rather than refund and claim a clean `failed`.
  adapter.deliverItem = async (a, item, opts) => {
    a.deliveredIds.push(`delivered-${makeId()}`);
    throw new Error('deliver applied then threw');
  };
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  const res = await service.fulfill(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  // Remaining refunded best-effort, but the delivery outcome is unknown.
  assert.equal(actor.wallet, 1000 - 25);
  assert.equal(actor.deliveredIds.length, 1, 'the item WAS created before the throw');
  assert.equal(adapter.removedIds.length, 0, 'removeItem was never called with a null/undefined id');
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'booked');
  const action = store._ordersByKey.get(`preorder-fulfill:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
  assert.ok(action.details.compensation.includes('item-unknown'));
});

test('an original fulfill write that lands then throws is escalated, never undone', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  // The original `fulfilled` write APPLIES then throws. Compensation must re-read
  // the original, see it was fulfilled, and escalate instead of undoing effects.
  store.state.applyThenFailStatuses.add('fulfilled');

  const res = await service.fulfill(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'fulfilled');
  assert.equal(actor.wallet, 975 - 75);
  assert.equal(actor.deliveredIds.length, 1);
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 4);
  assert.equal(store._shops.get('shop1').commerce.funds, 1025 + 75);
  const action = store._ordersByKey.get(`preorder-fulfill:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
});

test('an original cancel write that lands then throws is escalated, never undone', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');

  // The original `cancelled` write APPLIES then throws.
  store.state.applyThenFailStatuses.add('cancelled');

  const res = await service.cancel(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'cancelled');
  assert.equal(actor.wallet, 1000);
  assert.equal(store._shops.get('shop1').commerce.funds, 1000);
  const action = store._ordersByKey.get(`preorder-cancel:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
});

test('a fulfill whose original write lands then throws AND whose re-read is unavailable is escalated, never undone', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  // The original `fulfilled` write APPLIES then throws, and the follow-up re-read
  // of the original also throws (unavailable). Compensation must NOT undo the
  // applied effects - it escalates to needsRecovery and leaves everything intact.
  let reReadUnavailable = false;
  const origUpdate = store.updateAdvancedOrder.bind(store);
  store.updateAdvancedOrder = async (id, patch) => {
    if (id === placed.orderId && patch.status === 'fulfilled') {
      const result = await origUpdate(id, patch); // applies, then throws
      reReadUnavailable = true;
      throw new Error('applied then threw');
    }
    return origUpdate(id, patch);
  };
  const origFind = store.findAdvancedOrder.bind(store);
  store.findAdvancedOrder = async (id) => {
    if (reReadUnavailable) {
      reReadUnavailable = false;
      throw new Error('re-read unavailable');
    }
    return origFind(id);
  };

  const res = await service.fulfill(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'applied then threw');
  // The status write actually landed, so the original is fulfilled and the effects
  // (debit, delivery, stock/funds) are all RETAINED - nothing undone.
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'fulfilled');
  assert.equal(actor.wallet, 975 - 75);
  assert.equal(actor.deliveredIds.length, 1);
  assert.equal(adapter.removedIds.length, 0);
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 4);
  assert.equal(store._shops.get('shop1').commerce.funds, 1025 + 75);
  const action = store._ordersByKey.get(`preorder-fulfill:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
});

test('a cancel whose original write lands then throws AND whose re-read is unavailable is escalated, never undone', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');

  // The original `cancelled` write APPLIES then throws, and the follow-up re-read
  // of the original also throws (unavailable). Compensation must NOT undo the
  // refund / funds decrement - it escalates to needsRecovery and leaves them.
  let reReadUnavailable = false;
  const origUpdate = store.updateAdvancedOrder.bind(store);
  store.updateAdvancedOrder = async (id, patch) => {
    if (id === placed.orderId && patch.status === 'cancelled') {
      const result = await origUpdate(id, patch); // applies, then throws
      reReadUnavailable = true;
      throw new Error('applied then threw');
    }
    return origUpdate(id, patch);
  };
  const origFind = store.findAdvancedOrder.bind(store);
  store.findAdvancedOrder = async (id) => {
    if (reReadUnavailable) {
      reReadUnavailable = false;
      throw new Error('re-read unavailable');
    }
    return origFind(id);
  };

  const res = await service.cancel(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'applied then threw');
  // The status write actually landed, so the original is cancelled and the refund
  // / funds decrement are RETAINED - nothing undone.
  assert.equal(store._ordersByKey.get('preorder:gm1:req-1').status, 'cancelled');
  assert.equal(actor.wallet, 1000);
  assert.equal(store._shops.get('shop1').commerce.funds, 1000);
  const action = store._ordersByKey.get(`preorder-cancel:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
});

test('an unresolved wallet refund credit surfaces needsRecovery, not terminal failed', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  // A credit that does not actually move the player's balance: compensation must
  // verify by getBalance and escalate because the refund did not resolve.
  adapter.credit = async () => {};
  const store = createFakeStore({ shop });
  store.state.failUpdateShop = true;
  const service = makePreorderCommerce({ store, actor, adapter });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(actor.wallet, 1000 - 25);
  const order = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(order.status, 'needsRecovery');
  assert.ok(order.details.compensation.includes('deposit-refund-verify-failed'));
});

test('an unresolved wallet debit-back on cancel surfaces needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');
  assert.equal(actor.wallet, 975);

  // For the cancel, the deposit debit-back that reverses the refund does not
  // actually move the player's balance, and the merchant funds patch fails.
  // Compensation must verify by getBalance and escalate because the reversal did
  // not resolve.
  adapter.debit = async () => {};
  store.state.failUpdateShop = true;

  const res = await service.cancel(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(actor.wallet, 1000); // refund stayed; debit-back did not resolve
  assert.equal(store._shops.get('shop1').commerce.funds, 1025);
  const action = store._ordersByKey.get(`preorder-cancel:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
  assert.ok(action.details.compensation.includes('deposit-debit-back-verify-failed'));
});

// --------------------------------------------------------- shop-write safety

test('place with a null merchant-funds write records shop-write-missing and never claims booked', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  store.state.nullUpdateShop = true;
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  const res = await service.place(placePayload(), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'shop-write-missing');
  assert.equal(actor.wallet, 1000, 'deposit refunded');
  const order = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('shop-unwritten'));
});

test('fulfill with a null shop write records shop-write-missing and leaves the original booked', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  store.state.nullUpdateShop = true;
  const res = await service.fulfill(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.error, 'shop-write-missing');
  assert.equal(res.status, 'failed');
  const original = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(original.status, 'booked', 'original not falsely marked fulfilled');
});

test('cancel with a null shop write records shop-write-missing and leaves the original booked', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');

  store.state.nullUpdateShop = true;
  const res = await service.cancel(actionPayload(placed.orderId), 'gm1');
  assert.equal(res.error, 'shop-write-missing');
  assert.equal(res.status, 'failed');
  const original = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(original.status, 'booked', 'original not falsely marked cancelled');
});

// -------------------------------------------------- cross-action race (M5)

test('a pending fulfill action blocks a new cancel for the same original', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');

  // A fulfillment is in-flight (a live `preorder-fulfill` action still pending).
  await store.createAdvancedOrder({
    key: `preorder-fulfill:${placed.orderId}:f1`,
    kind: 'preorder-fulfill',
    status: 'pending',
    phase: 'recorded',
    shopId: 'shop1',
    relatedOrderId: placed.orderId,
    intentHash: 'synthetic',
    createdAt: Date.now(),
    outcome: {},
    details: {},
  });

  // A NEW cancel request must refuse to run a competing cancellation: it surfaces
  // needsRecovery instead of blindly cancelling while the fulfill is in flight.
  const res = await service.cancel(actionPayload(placed.orderId, { requestId: 'c1' }), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  const original = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(original.status, 'booked');
});

test('a pending cancel action blocks a new fulfill for the same original', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });
  const placed = await service.place(placePayload(), 'gm1');
  assert.equal(placed.status, 'booked');
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 5 }));
  store._shops.set('shop1', current);

  // A cancellation is in-flight (a live `preorder-cancel` action still pending).
  await store.createAdvancedOrder({
    key: `preorder-cancel:${placed.orderId}:c1`,
    kind: 'preorder-cancel',
    status: 'pending',
    phase: 'recorded',
    shopId: 'shop1',
    relatedOrderId: placed.orderId,
    intentHash: 'synthetic',
    createdAt: Date.now(),
    outcome: {},
    details: {},
  });

  const res = await service.fulfill(actionPayload(placed.orderId, { requestId: 'f1' }), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  const original = store._ordersByKey.get('preorder:gm1:req-1');
  assert.equal(original.status, 'booked');
});

// -------------------------------------------------------- replay originalStatus

test('a replayed booked preorder carries originalStatus booked', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  await service.place(placePayload(), 'gm1');
  const replay = await service.place(placePayload(), 'gm1');
  assert.equal(replay.status, 'replay');
  assert.equal(replay.originalStatus, 'booked');
});

test('a replayed failed preorder carries originalStatus failed', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 0 })],
    funds: 1000,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makePreorderCommerce({
    store,
    actor,
    adapter,
    getSocial: async () => ({ individual: 0, party: 0, score: 0 }),
  });

  await service.place(placePayload(), 'gm1');
  store._ordersByKey.get('preorder:gm1:req-1').status = 'failed';
  const replay = await service.place(placePayload(), 'gm1');
  assert.equal(replay.status, 'replay');
  assert.equal(replay.originalStatus, 'failed');
});
