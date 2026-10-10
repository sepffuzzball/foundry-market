// Unit tests for the M5 GM-authoritative theft adjudication in
// `src/advanced/theft.js`.
//
// These are pure Node tests (no Foundry globals) using a fake store, a fake
// actor, and a fake adapter, plus the real lock map so a theft resolution can be
// shown to share the per-shop lock with purchases. They cover the attempt
// success path and its exact non-effects (no debit, no delivery, no stock change,
// no shop write - the claim only records a GM-private `booked` order), the
// validation gates (theft disabled, hidden/backroom entry, out-of-stock/
// insufficient stock, closed shop, invalid clock, item source missing, actor
// ownership, GM gate), the idempotency (replay/conflict/needsRecovery), the
// resolve GM-only gate and typed-boolean `success` requirement, the success/false
// and success/true effects (mark failed vs deliver one + decrement finite stock +
// mark committed, with a separate `theft-resolve` action order), the no-changes
// before any GM decision, the compensation/needsRecovery paths for delivery,
// shop-write, restore and status failures, and the shared per-shop lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTheftCommerce,
  computeTheftIntentHash,
  computeTheftResolveIntentHash,
  THEFT_QUANTITY,
} from '../src/advanced/theft.js';
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
      actor.wallet = (actor.wallet || 0) - amount;
      return { amount, newBalance: actor.wallet };
    },
    async credit(actor, amount) {
      actor.wallet = (actor.wallet || 0) + amount;
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
  theftEnabled = false,
} = {}) {
  return normalizeShop({
    id: 'shop1',
    name: 'General Store',
    locationId: 'home',
    open,
    inventory,
    commerce: {
      funds,
      theft: { enabled: theftEnabled },
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
    nullUpdateShop: false,
    failStatuses: new Set(),
    nullStatuses: new Set(),
    failKeys: new Set(),
    nullKeys: new Set(),
    failOrderIds: new Set(),
    nullOrderIds: new Set(),
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
      state.findOrderCalls += 1;
      return orders.get(id) || null;
    },
    async listAdvancedOrders({ shopId, actorId, status, kind } = {}) {
      let records = [...orders.values()];
      if (shopId != null) records = records.filter((r) => r.shopId === shopId);
      if (actorId != null) records = records.filter((r) => r.actorId === actorId);
      if (status != null) records = records.filter((r) => r.status === status);
      if (kind != null) records = records.filter((r) => r.kind === kind);
      records = records.sort((a, b) => b.createdAt - a.createdAt);
      return records;
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
      const rec = orders.get(id);
      if (patch.status && state.failStatuses.has(patch.status)) {
        state.failStatuses.delete(patch.status);
        throw new Error('status write failed');
      }
      if (patch.status && state.nullStatuses.has(patch.status)) {
        state.nullStatuses.delete(patch.status);
        return null;
      }
      if (rec && patch.status && state.failKeys.has(rec.key)) {
        state.failKeys.delete(rec.key);
        throw new Error('key write failed');
      }
      if (rec && patch.status && state.nullKeys.has(rec.key)) {
        state.nullKeys.delete(rec.key);
        return null;
      }
      if (state.failOrderIds.has(id)) {
        state.failOrderIds.delete(id);
        throw new Error('order write failed');
      }
      if (state.nullOrderIds.has(id)) {
        state.nullOrderIds.delete(id);
        return null;
      }
      if (!rec) return null;
      const next = { ...rec, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
      orders.set(id, next);
      if (ordersByKey.get(next.key) === rec) ordersByKey.set(next.key, next);
      return next;
    },
  };
  return store;
}

export function makeTheftCommerce({
  store,
  actor,
  adapter,
  isActiveGM = () => true,
  actorOwnedBy = () => true,
  getWorldTime,
  now = null,
  fromUuid,
  getActor,
  runShopExclusive,
} = {}) {
  return createTheftCommerce({
    store,
    runShopExclusive: runShopExclusive || ((shopId, fn) => fn()),
    isActiveGM,
    getActor: getActor || (async (id) => (actor && actor.id === id ? actor : null)),
    actorOwnedBy,
    getAdapter: () => adapter,
    fromUuid: fromUuid || (async () => null),
    getWorldTime,
    now,
    logger: { error: () => {} },
  });
}

export function attemptPayload(overrides = {}) {
  return {
    shopId: 'shop1',
    entryId: 'entry1',
    actorId: 'actor1',
    requestId: 'req-1',
    ...overrides,
  };
}

export function resolvePayload(orderId, overrides = {}) {
  return { orderId, requestId: 'req-1', success: true, ...overrides };
}

// ---------------------------------------------------------------- attempt success / no effects

test('attempt records a booked theft order with NO debit, delivery, stock change or shop write', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', price: 100, quantity: 5 })],
    funds: 1000,
    theftEnabled: true,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const res = await service.attempt(attemptPayload(), 'gm1');

  assert.equal(res.status, 'booked');
  assert.ok(res.orderId);
  assert.equal(res.entryId, 'entry1');

  // Safe public output shape: {status, error, orderId, success?}.
  const keys = Object.keys(res).sort();
  assert.deepEqual(keys, ['entryId', 'orderId', 'status']);

  // No mutation before the GM decision.
  assert.equal(actor.wallet, 1000);
  assert.equal(actor.deliveredIds.length, 0);
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 5);
  assert.equal(store._shops.get('shop1').commerce.funds, 1000);

  const order = store._ordersByKey.get('theft:gm1:req-1');
  assert.equal(order.kind, 'theft');
  assert.equal(order.status, 'booked');
  assert.equal(order.phase, 'final');
  assert.equal(order.quantity, 1);
  assert.equal(order.total, 0);
  assert.equal(order.entryId, 'entry1');
  assert.equal(order.userId, 'gm1');
  assert.equal(order.actorId, 'actor1');
  assert.deepEqual(order.outcome, {
    orderId: order.id,
    entryId: 'entry1',
    status: 'awaiting-gm',
  });
  // The outcome orderId equals the stored id (attempt supplies the id up front).
  assert.equal(order.outcome.orderId, order.id);
});

test('attempt on zero finite stock refuses out-of-stock before any effect', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 0 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter: makeAdapter() });

  const res = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'out-of-stock');
  assert.equal(store.state.createOrderCalls, 0);
});

test('attempt on an unlimited entry is always eligible regardless of recorded quantity', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 0, stockMode: 'unlimited' })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter: makeAdapter() });

  const res = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(res.status, 'booked');
  assert.equal(store.state.updateShopCalls, 0);
});

// ---------------------------------------------------------------- attempt gates

test('attempt fails closed when theft is disabled', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 5 })],
    theftEnabled: false,
  });
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter: makeAdapter() });

  const res = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'theft-disabled');
  assert.equal(store.state.createOrderCalls, 0);
});

test('attempt refuses a hidden entry', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 5, visible: false })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter: makeAdapter() });

  const res = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'entry-hidden');
});

test('attempt refuses a backroom entry even when the actor is eligible', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({
        id: 'entry1',
        quantity: 5,
        access: { mode: 'backroom', actorUuids: ['Actor.actor1'], minReputation: -100 },
      }),
    ],
    theftEnabled: true,
  });
  const actor = createMockActor({ uuid: 'Actor.actor1' });
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter: makeAdapter() });

  const res = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'entry-backroom');
});

test('attempt refuses an entry with no resolvable item source', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({
        id: 'entry1',
        quantity: 5,
        itemUuid: 'Item.missing',
        snapshot: 'not-json',
      }),
    ],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter: makeAdapter() });

  const res = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'item-source-missing');
});

test('attempt fails closed on a closed shop and an invalid clock', async () => {
  const closed = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 5 })],
    open: false,
    theftEnabled: true,
  });
  const actor = createMockActor();
  let store = createFakeStore({ shop: closed });
  let service = makeTheftCommerce({ store, actor, adapter: makeAdapter() });
  let res = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'shop-closed');

  // Invalid server clock fails closed before any effect.
  const open = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 5 })],
    theftEnabled: true,
  });
  store = createFakeStore({ shop: open });
  service = makeTheftCommerce({
    store,
    actor,
    adapter: makeAdapter(),
    getWorldTime: () => NaN,
  });
  res = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'invalid-world-time');
  assert.equal(store.state.createOrderCalls, 0);
});

// ---------------------------------------------------------------- attempt auth / gm gate

test('the non-active-GM gate runs no store read and no effect', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({
    store,
    actor,
    adapter: makeAdapter(),
    isActiveGM: () => false,
  });

  const res = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'not-active-gm');
  assert.equal(store.state.findShopCalls, 0);
  assert.equal(store.state.createOrderCalls, 0);
});

test('an actor not owned by the requester is refused before any order', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({
    store,
    actor,
    adapter: makeAdapter(),
    actorOwnedBy: () => false,
  });

  const res = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'actor-not-owned');
  assert.equal(store.state.createOrderCalls, 0);
});

// ---------------------------------------------------------------- attempt idempotency

test('a booked theft replays with no second order and no effect', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const first = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(first.status, 'booked');
  const writes = store.state.updateShopCalls;
  const creates = store.state.createOrderCalls;

  const again = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(again.status, 'replay');
  assert.equal(again.orderId, first.orderId);
  assert.equal(actor.deliveredIds.length, 0);
  assert.equal(store.state.updateShopCalls, writes);
  assert.equal(store.state.createOrderCalls, creates);
  assert.equal(store._orders.size, 1);
});

test('same key with a changed payload is a conflict and applies no effect', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', quantity: 5 }),
      makeEntry({ id: 'entry2', quantity: 5 }),
    ],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter: makeAdapter() });

  const first = await service.attempt(attemptPayload({ entryId: 'entry1' }), 'gm1');
  assert.equal(first.status, 'booked');

  const conflict = await service.attempt(attemptPayload({ entryId: 'entry2' }), 'gm1');
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.orderId, first.orderId);
  assert.equal(store.state.createOrderCalls, 1);
});

// ---------------------------------------------------------------- resolve success:false

test('resolve success:false marks the original failed and commits a separate action with no effects', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 })],
    funds: 1000,
    theftEnabled: true,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(placed.status, 'booked');

  const res = await service.resolve(
    resolvePayload(placed.orderId, { success: false }),
    'gm1'
  );

  assert.equal(res.status, 'failed');
  assert.equal(res.orderId, placed.orderId);
  assert.equal(res.success, false);
  assert.deepEqual(Object.keys(res).sort(), ['orderId', 'status', 'success']);

  // No delivery, no stock change, no shop write, no funds change.
  assert.equal(actor.deliveredIds.length, 0);
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 5);
  assert.equal(store._shops.get('shop1').commerce.funds, 1000);

  const original = store._ordersByKey.get('theft:gm1:req-1');
  assert.equal(original.status, 'failed');
  assert.equal(original.phase, 'final');
  assert.deepEqual(original.outcome, { success: false });

  const action = store._ordersByKey.get(`theft-resolve:${placed.orderId}:req-1`);
  assert.equal(action.kind, 'theft');
  assert.equal(action.status, 'committed');
  assert.equal(action.relatedOrderId, placed.orderId);
  assert.equal(action.userId, 'gm1');
  assert.deepEqual(action.outcome, { orderId: placed.orderId, success: false });
});

// ---------------------------------------------------------------- resolve success:true

test('resolve success:true delivers one, decrements finite stock, marks committed and commits the action', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 })],
    funds: 1000,
    theftEnabled: true,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(placed.status, 'booked');

  const res = await service.resolve(resolvePayload(placed.orderId), 'gm1');

  assert.equal(res.status, 'committed');
  assert.equal(res.orderId, placed.orderId);
  assert.equal(res.success, true);
  assert.equal(res.entryId, 'entry1');

  // Delivered exactly one item.
  assert.equal(actor.deliveredIds.length, 1);
  // A single shop write decremented stock from 5 to 4.
  assert.equal(store.state.updateShopCalls, 1);
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 4);
  // No currency moved.
  assert.equal(actor.wallet, 1000);

  const original = store._ordersByKey.get('theft:gm1:req-1');
  assert.equal(original.status, 'committed');
  assert.equal(original.phase, 'final');
  assert.deepEqual(original.outcome, { success: true, entryId: 'entry1' });

  const action = store._ordersByKey.get(`theft-resolve:${placed.orderId}:req-1`);
  assert.equal(action.kind, 'theft');
  assert.equal(action.status, 'committed');
  assert.equal(action.relatedOrderId, placed.orderId);
  assert.deepEqual(action.outcome, { orderId: placed.orderId, success: true, entryId: 'entry1' });
});

test('resolve success:true on an unlimited entry delivers but does not change stock', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 0, stockMode: 'unlimited' })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  const res = await service.resolve(resolvePayload(placed.orderId), 'gm1');

  assert.equal(res.status, 'committed');
  assert.equal(actor.deliveredIds.length, 1);
  assert.equal(store.state.updateShopCalls, 0); // no stock patch needed
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 0);
});

test('resolve success:true re-checks stock and refuses when it is now gone', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  // Stock runs out before the GM decision.
  const current = store._shops.get('shop1');
  current.inventory = current.inventory.map((e) => ({ ...e, quantity: 0 }));
  store._shops.set('shop1', current);

  const res = await service.resolve(resolvePayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'insufficient-stock');
  assert.equal(actor.deliveredIds.length, 0);
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(store._ordersByKey.get('theft:gm1:req-1').status, 'booked');
});

// ---------------------------------------------------------------- resolve gates

test('resolve only runs for an active GM and requires a typed boolean success', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({
    store,
    actor,
    adapter: makeAdapter(),
    isActiveGM: () => false,
  });

  let res = await service.resolve(resolvePayload('order-x'), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'not-active-gm');
  assert.equal(store.state.findOrderCalls, 0);

  // A non-boolean success fails closed (never inferred from a channel/string).
  const gm = makeTheftCommerce({ store, actor, adapter: makeAdapter() });
  res = await gm.resolve(resolvePayload('order-x', { success: 'true' }), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'success-required');

  res = await gm.resolve(resolvePayload('order-x', { success: 1 }), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'success-required');

  res = await gm.resolve({ orderId: 'order-x', requestId: 'req-1' }, 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'success-required');
});

test('resolve requires a GM user id', async () => {
  const shop = makeShop({ inventory: [makeEntry({ id: 'entry1', quantity: 5 })], theftEnabled: true });
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor: createMockActor(), adapter: makeAdapter() });

  const res = await service.resolve(resolvePayload('order-x', { success: true }), '');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'gm-required');
});

test('resolve refuses an order of a non-theft kind', async () => {
  const shop = makeShop({ inventory: [makeEntry({ id: 'entry1', quantity: 5 })], theftEnabled: true });
  const store = createFakeStore({ shop });
  await store.createAdvancedOrder({
    key: 'service:gm1:req',
    kind: 'service',
    status: 'booked',
    phase: 'final',
    shopId: 'shop1',
    userId: 'gm1',
    actorId: 'actor1',
    entryId: 'entry1',
    quantity: 1,
    total: 0,
    deposit: 0,
    remaining: 0,
    intentHash: 'x',
    details: {},
    outcome: {},
  });
  const service = makeTheftCommerce({ store, actor: createMockActor(), adapter: makeAdapter() });

  const res = await service.resolve(resolvePayload('order-x', { success: true }), 'gm1');
  // order-x does not carry the theft kind once found; resolve reads by id. Use the
  // actual created id.
  const found = await store.findAdvancedOrderByKey('service:gm1:req');
  const res2 = await service.resolve(resolvePayload(found.id, { success: true }), 'gm1');
  assert.equal(res2.status, 'error');
  assert.equal(res2.error, 'order-not-theft');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'order-not-found');
});

// ---------------------------------------------------------------- resolve idempotency

test('a resolved theft replays with no second delivery or write', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  const first = await service.resolve(resolvePayload(placed.orderId), 'gm1');
  assert.equal(first.status, 'committed');
  const delivered = actor.deliveredIds.length;
  const writes = store.state.updateShopCalls;

  const again = await service.resolve(resolvePayload(placed.orderId), 'gm1');
  assert.equal(again.status, 'replay');
  assert.equal(again.success, true);
  assert.equal(actor.deliveredIds.length, delivered);
  assert.equal(store.state.updateShopCalls, writes);
});

test('same resolve key with a changed success is a conflict', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  const first = await service.resolve(resolvePayload(placed.orderId), 'gm1');
  assert.equal(first.status, 'committed');
  const delivered = actor.deliveredIds.length;
  const writes = store.state.updateShopCalls;

  const conflict = await service.resolve(
    resolvePayload(placed.orderId, { success: false }),
    'gm1'
  );
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.orderId, placed.orderId);
  assert.equal(actor.deliveredIds.length, delivered);
  assert.equal(store.state.updateShopCalls, writes);
});

test('resolve with a NEW request id on an already-resolved theft replays the recorded outcome', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  const first = await service.resolve(resolvePayload(placed.orderId), 'gm1');
  assert.equal(first.status, 'committed');

  const replay = await service.resolve(
    resolvePayload(placed.orderId, { requestId: 'req-2', success: false }),
    'gm1'
  );
  // The item was already granted; a conflicting new request replays the truth.
  assert.equal(replay.status, 'replay');
  assert.equal(replay.success, true);
  assert.equal(actor.deliveredIds.length, 1);
});

// ---------------------------------------------------------------- resolve compensation

test('a delivered-then-failed shop write removes the item and leaves the original booked', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  store.state.failUpdateShop = true;
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  const res = await service.resolve(resolvePayload(placed.orderId), 'gm1');

  assert.equal(res.status, 'failed');
  assert.equal(res.success, true);
  // The delivered item was removed.
  assert.equal(actor.removedIds.length, 1);
  // The shop write failed, so stock is untouched and the original is still booked.
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 5);
  assert.equal(store._ordersByKey.get('theft:gm1:req-1').status, 'booked');
  const action = store._ordersByKey.get(`theft-resolve:${placed.orderId}:req-1`);
  assert.equal(action.status, 'failed');
  assert.ok(action.details.compensation.includes('item-removed'));
});

test('an uncertain recovery (remove fails) escalates to needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const adapter = makeAdapter({ removeFails: true });
  const store = createFakeStore({ shop });
  store.state.failUpdateShop = true; // forces a compensating removeItem
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  const res = await service.resolve(resolvePayload(placed.orderId), 'gm1');

  assert.equal(res.status, 'needsRecovery');
  const action = store._ordersByKey.get(`theft-resolve:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
  assert.ok(action.details.compensation.includes('item-remove-failed'));
});

test('a delivery that throws with an unknown id escalates the action to needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const adapter = makeAdapter({ failDeliveryOn: 1 });
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  const res = await service.resolve(resolvePayload(placed.orderId), 'gm1');

  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.success, true);
  assert.equal(actor.deliveredIds.length, 0);
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 5);
  assert.equal(store._ordersByKey.get('theft:gm1:req-1').status, 'booked');
  const action = store._ordersByKey.get(`theft-resolve:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
  assert.ok(action.details.compensation.includes('item-unknown'));
});

test('a shop-write applied but the action commit fails preserves the granted item and escalates', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 })],
    funds: 1000,
    theftEnabled: true,
  });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  // Fail only the ACTION commit by key (the original key is `theft:...`, the
  // action key is `theft-resolve:...`), so the original `committed` write still
  // succeeds.
  store.state.nullKeys.add(`theft-resolve:${placed.orderId}:req-1`);

  const res = await service.resolve(resolvePayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.success, true);
  // The item was already granted and stock decremented; the original is committed.
  assert.equal(store._ordersByKey.get('theft:gm1:req-1').status, 'committed');
  assert.deepEqual(store._ordersByKey.get('theft:gm1:req-1').outcome, {
    success: true,
    entryId: 'entry1',
  });
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 4);
  // The pending action is escalated rather than committed.
  const action = store._ordersByKey.get(`theft-resolve:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
});

// ---------------------------------------------------------------- attempt + resolve race lock

test('a new resolve key blocks with needsRecovery when an earlier action for the same original is still pending', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter: makeAdapter() });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  // A previous resolve with a DIFFERENT requestId left a pending action for the
  // same original; it must block the new resolve from double-delivering.
  await store.createAdvancedOrder({
    key: `theft-resolve:${placed.orderId}:req-linger`,
    kind: 'theft',
    status: 'pending',
    phase: 'recorded',
    shopId: 'shop1',
    userId: 'gm1',
    actorId: 'actor1',
    entryId: 'entry1',
    relatedOrderId: placed.orderId,
    quantity: THEFT_QUANTITY,
    total: 0,
    deposit: 0,
    remaining: 0,
    intentHash: 'linger',
    details: {},
    outcome: {},
  });

  const res = await service.resolve(
    resolvePayload(placed.orderId, { requestId: 'req-2' }),
    'gm1'
  );

  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.orderId, placed.orderId);
  assert.equal(res.error, 'resolve-in-flight');
  // No delivery, no shop write, and no NEW action was created.
  assert.equal(actor.deliveredIds.length, 0);
  assert.equal(store.state.updateShopCalls, 0);
  assert.equal(store._orders.size, 2); // original booked claim + lingering action
  assert.equal(store._ordersByKey.get('theft:gm1:req-1').status, 'booked');
  assert.equal(store._ordersByKey.get(`theft-resolve:${placed.orderId}:req-2`), undefined);
});

test('a shop update that applies then throws is re-read, restored and reported failed', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  let throwOnce = true;
  const origUpdateShop = store.updateShop.bind(store);
  store.updateShop = async (id, patch) => {
    const result = await origUpdateShop(id, patch); // applies, then throws once
    if (throwOnce) {
      throwOnce = false;
      throw new Error('applied then threw');
    }
    return result;
  };
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  const res = await service.resolve(resolvePayload(placed.orderId), 'gm1');

  assert.equal(res.status, 'failed');
  assert.equal(res.success, true);
  // The item was delivered then removed; the throwing shop write had APPLIED, so
  // compensation re-read the stock, restored the known change and reported failed.
  assert.equal(actor.removedIds.length, 1);
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 5);
  assert.equal(store._ordersByKey.get('theft:gm1:req-1').status, 'booked');
  const action = store._ordersByKey.get(`theft-resolve:${placed.orderId}:req-1`);
  assert.equal(action.status, 'failed');
  assert.ok(action.details.compensation.includes('shop-restored'));
  assert.ok(action.details.compensation.includes('item-removed'));
});

test('an original commit that applies then throws is re-read and the action retains needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  const origUpdate = store.updateAdvancedOrder.bind(store);
  store.updateAdvancedOrder = async (id, patch) => {
    if (id === placed.orderId && patch.status === 'committed') {
      const result = await origUpdate(id, patch); // applies, then throws
      throw new Error('applied then threw');
    }
    return origUpdate(id, patch);
  };

  const res = await service.resolve(resolvePayload(placed.orderId), 'gm1');

  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.success, true);
  assert.equal(res.error, 'applied then threw');
  // The original committed write actually landed, so the item is granted and the
  // original is committed - NOT undone and NOT reported failed.
  assert.equal(store._ordersByKey.get('theft:gm1:req-1').status, 'committed');
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 4);
  assert.equal(actor.deliveredIds.length, 1);
  assert.equal(adapter.removedIds.length, 0);
  const action = store._ordersByKey.get(`theft-resolve:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
});

test('a refusal whose original failed write applies then throws retains needsRecovery', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter: makeAdapter() });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  const origUpdate = store.updateAdvancedOrder.bind(store);
  store.updateAdvancedOrder = async (id, patch) => {
    if (id === placed.orderId && patch.status === 'failed') {
      const result = await origUpdate(id, patch); // applies, then throws
      throw new Error('applied then threw');
    }
    return origUpdate(id, patch);
  };

  const res = await service.resolve(
    resolvePayload(placed.orderId, { success: false }),
    'gm1'
  );

  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.success, false);
  assert.equal(store._ordersByKey.get('theft:gm1:req-1').status, 'failed');
  const action = store._ordersByKey.get(`theft-resolve:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
});

test('a grant whose original commit lands then throws AND whose re-read is unavailable is escalated, never undone', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  // The original `committed` write APPLIES then throws, and the follow-up re-read
  // of the original also throws (unavailable). Compensation must NOT undo the
  // delivered item / stock - it escalates to needsRecovery and leaves them.
  let reReadUnavailable = false;
  const origUpdate = store.updateAdvancedOrder.bind(store);
  store.updateAdvancedOrder = async (id, patch) => {
    if (id === placed.orderId && patch.status === 'committed') {
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

  const res = await service.resolve(resolvePayload(placed.orderId), 'gm1');

  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.success, true);
  assert.equal(res.error, 'applied then threw');
  // The original committed write actually landed, so the item is granted and the
  // original is committed - NOT undone and NOT reported failed.
  assert.equal(store._ordersByKey.get('theft:gm1:req-1').status, 'committed');
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 4);
  assert.equal(actor.deliveredIds.length, 1);
  assert.equal(adapter.removedIds.length, 0);
  const action = store._ordersByKey.get(`theft-resolve:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
});

test('a refusal whose original failed write lands then throws AND whose re-read is unavailable is escalated, never undone', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 })],
    theftEnabled: true,
  });
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter: makeAdapter() });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  // The original `failed` write APPLIES then throws, and the follow-up re-read of
  // the original also throws (unavailable). Compensation must NOT clear the
  // refusal - it escalates to needsRecovery and leaves the original failed.
  let reReadUnavailable = false;
  const origUpdate = store.updateAdvancedOrder.bind(store);
  store.updateAdvancedOrder = async (id, patch) => {
    if (id === placed.orderId && patch.status === 'failed') {
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

  const res = await service.resolve(
    resolvePayload(placed.orderId, { success: false }),
    'gm1'
  );

  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.success, false);
  assert.equal(res.error, 'applied then threw');
  assert.equal(store._ordersByKey.get('theft:gm1:req-1').status, 'failed');
  const action = store._ordersByKey.get(`theft-resolve:${placed.orderId}:req-1`);
  assert.equal(action.status, 'needsRecovery');
});

// ---------------------------------------------------------------- attempt + resolve race lock

test('concurrent theft resolutions share the same per-shop lock and never overlap writes', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 }),
      makeEntry({ id: 'entry2', name: 'Sword', quantity: 5 }),
    ],
    funds: 1000,
    theftEnabled: true,
  });
  const actor = createMockActor();
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

  const service = makeTheftCommerce({
    store: lockingStore,
    actor,
    adapter,
    runShopExclusive: sharedRunShopExclusive,
  });

  const [ra, rb] = await Promise.all([
    service.attempt(attemptPayload({ entryId: 'entry1', requestId: 'req-a' }), 'gm1'),
    service.attempt(attemptPayload({ entryId: 'entry2', requestId: 'req-b' }), 'gm1'),
  ]);
  assert.equal(ra.status, 'booked');
  assert.equal(rb.status, 'booked');

  // Resolve both under the shared lock; the updateShop writes must never overlap.
  const [x, y] = await Promise.all([
    service.resolve(resolvePayload(ra.orderId, { requestId: 'ra' }), 'gm1'),
    service.resolve(resolvePayload(rb.orderId, { requestId: 'rb' }), 'gm1'),
  ]);
  assert.equal(x.status, 'committed');
  assert.equal(y.status, 'committed');
  assert.equal(maxDepth, 1, 'writes never overlapped under the shared lock');
});

// ---------------------------------------------------------------- intent hashes

test('computeTheftIntentHash is deterministic and sensitive to every field', async () => {
  const a = computeTheftIntentHash({
    shopId: 'shop1',
    entryId: 'entry1',
    actorId: 'actor1',
    requester: 'gm1',
  });
  const b = computeTheftIntentHash({
    shopId: 'shop1',
    entryId: 'entry1',
    actorId: 'actor1',
    requester: 'gm1',
  });
  assert.equal(a, b);
  const c = computeTheftIntentHash({
    shopId: 'shop1',
    entryId: 'entry2',
    actorId: 'actor1',
    requester: 'gm1',
  });
  assert.notEqual(a, c);
  assert.equal(THEFT_QUANTITY, 1);
});

test('computeTheftResolveIntentHash includes success but excludes the GM id', async () => {
  const a = computeTheftResolveIntentHash({ orderId: 'o1', success: true });
  const b = computeTheftResolveIntentHash({ orderId: 'o1', success: true });
  assert.equal(a, b);
  const c = computeTheftResolveIntentHash({ orderId: 'o1', success: false });
  assert.notEqual(a, c);
});

// --------------------------------------------------------- shop-write safety

test('a null shop write on a theft resolve throws into compensation and records shop-write-missing', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', name: 'Potion', quantity: 5 })],
    funds: 1000,
    theftEnabled: true,
  });
  const actor = createMockActor({ wallet: 1000 });
  const adapter = makeAdapter();
  const store = createFakeStore({ shop });
  const service = makeTheftCommerce({ store, actor, adapter });

  const placed = await service.attempt(attemptPayload(), 'gm1');
  assert.equal(placed.status, 'booked');

  // The single stock-decrement write returns null without applying. The resolve
  // must NOT claim committed: it throws into compensation, which removes the
  // delivered item and keeps the original booked (no residual stock change).
  store.state.nullUpdateShop = true;
  const res = await service.resolve(resolvePayload(placed.orderId), 'gm1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'shop-write-missing');
  assert.equal(adapter.removedIds.length, 1, 'delivered item removed on compensation');
  assert.equal(store._shops.get('shop1').inventory[0].quantity, 5, 'stock unchanged');
  const original = store._ordersByKey.get('theft:gm1:req-1');
  assert.equal(original.status, 'booked', 'original not falsely marked committed');
  const action = store._ordersByKey.get(`theft-resolve:${placed.orderId}:req-1`);
  assert.equal(action.status, 'failed');
});
