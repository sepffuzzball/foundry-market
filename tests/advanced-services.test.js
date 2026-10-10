// Unit tests for the M5 GM-authoritative service booking and manual fulfillment
// in `src/advanced/services.js`.
//
// These are pure Node tests (no Foundry globals) using a fake store, a fake
// actor (with an embedded Items collection so we can assert NO item is created),
// and a fake adapter, plus the real lock map so a booking can be shown to share
// the per-shop lock with purchases. They cover the success path and its exact
// side effects, idempotent replay, the duplicate-identity conflict, GM gating,
// ownership, service lookup (missing/disabled/hidden), the trading gate, finite
// merchant funds and the overflow guard, insufficient funds, debit-error
// compensation, the "no fake Item" guarantee (a book never delivers anything),
// the "booked not fulfilled" contract, GM-only single fulfillment with replay,
// and the fulfillment failure/recovery boundary.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createServiceCommerce } from '../src/advanced/services.js';
import { normalizeShop, makeId } from '../src/services/model.js';
import { createLockMap, fnv1a } from '../src/services/commerce.js';
import { isShopTrading, timeAt } from '../src/automation/policy.js';

// ---------------------------------------------------------------- helpers

export function makeService({
  id = 'svc1',
  name = 'Blacksmithing',
  price = 100,
  visible = true,
  enabled = true,
} = {}) {
  return {
    id,
    name,
    description: '',
    price,
    visible,
    enabled,
    manualFulfillment: true,
  };
}

export function createMockActor({ wallet = 1000, item = null } = {}) {
  const items = new Map();
  const actor = {
    id: 'actor1',
    name: 'Player',
    wallet,
    items,
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
  debitFails = false,
  debitAppliesThenThrows = false,
  creditFails = false,
} = {}) {
  return {
    supported: true,
    async getBalance(actor) {
      return actor.wallet || 0;
    },
    async debit(actor, amount) {
      if (debitFails) throw new Error('debit failed');
      actor.wallet = (actor.wallet || 0) - amount;
      if (debitAppliesThenThrows) throw new Error('debit failed after apply');
      return { amount, newBalance: actor.wallet };
    },
    async credit(actor, amount) {
      if (creditFails) throw new Error('credit failed');
      actor.wallet = (actor.wallet || 0) + amount;
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

export function makeShop({
  funds = null,
  open = true,
  services = [makeService()],
  name = 'General Store',
} = {}) {
  return normalizeShop({
    id: 'shop1',
    name,
    locationId: 'home',
    open,
    commerce: { funds, services },
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
    failFulfillCommit: false,
    nullFulfillCommit: false,
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
    async findAdvancedOrder(id) {
      for (const rec of orders.values()) {
        if (rec.id === id) return rec;
      }
      return null;
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
      if (state.failFulfillCommit && patch.status === 'committed') {
        state.failFulfillCommit = false;
        throw new Error('fulfill commit failed');
      }
      if (state.nullFulfillCommit && patch.status === 'committed') {
        state.nullFulfillCommit = false;
        return null;
      }
      if (state.failOrderCommit && patch.status === 'booked') {
        state.failOrderCommit = false;
        throw new Error('commit failed');
      }
      if (state.nullOrderCommit && patch.status === 'booked') {
        return null;
      }
      for (const [key, rec] of orders) {
        if (rec.id === id) {
          const next = { ...rec, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
          orders.set(key, next);
          return next;
        }
      }
      return null;
    },
  };
  return store;
}

export function makeServiceCommerce({
  store,
  actor,
  adapter,
  isActiveGM = () => true,
  actorOwnedBy = () => true,
  getWorldTime,
  now = null,
  runShopExclusive,
  getActor,
} = {}) {
  return createServiceCommerce({
    store,
    runShopExclusive: runShopExclusive || ((shopId, fn) => fn()),
    isActiveGM,
    getActor: getActor || (async (id) => (actor && actor.id === id ? actor : null)),
    actorOwnedBy,
    getAdapter: () => adapter,
    getWorldTime,
    now,
    logger: { error: () => {} },
  });
}

export function baseBookPayload(overrides = {}) {
  return {
    shopId: 'shop1',
    serviceId: 'svc1',
    actorId: 'actor1',
    requestId: 'req-1',
    ...overrides,
  };
}

export function baseFulfillPayload(overrides = {}) {
  return {
    orderId: 'ord-booked',
    requestId: 'freq-1',
    ...overrides,
  };
}

// Mirror the service's canonical book intent hash so a synthetic persisted order
// can carry the exact hash a real request would compute for the same identity.
export function bookIntentHashFor(serviceId = 'svc1', requester = 'player1') {
  return fnv1a(
    JSON.stringify({
      shopId: 'shop1',
      serviceId,
      actorId: 'actor1',
      requester,
    })
  );
}

export function fulfillIntentHashFor(orderId = 'ord-booked') {
  return fnv1a(JSON.stringify({ orderId }));
}

export function bookedOrderRecord(overrides = {}) {
  const { total = 100, price = 100, serviceName = 'Blacksmithing' } = overrides;
  return {
    id: 'ord-booked',
    key: 'service:player1:req-1',
    kind: 'service',
    status: 'booked',
    phase: 'final',
    shopId: 'shop1',
    userId: 'player1',
    actorId: 'actor1',
    entryId: '',
    quantity: 1,
    total,
    deposit: 0,
    remaining: 0,
    intentHash: bookIntentHashFor(),
    details: { serviceId: 'svc1', serviceName, price, fundsBefore: null },
    outcome: { serviceId: 'svc1', serviceName, price, orderId: 'ord-booked' },
    error: '',
    relatedOrderId: '',
  };
}

// ---------------------------------------------------------------- book success

test('book commits, debits the actor exactly once, and never creates an item', async () => {
  const shop = makeShop({ funds: null, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');

  assert.equal(res.status, 'booked');
  assert.equal(res.serviceId, 'svc1');
  assert.equal(res.serviceName, 'Blacksmithing');
  assert.equal(res.price, 100);
  assert.ok(res.orderId);
  assert.equal(actor.wallet, 900, 'player debited exactly once');

  // No fake Item: no item delivered onto the actor and no inventory entry added.
  assert.equal(actor.items.size, 0, 'no item delivered to the actor');
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory.length, 0, 'no shop inventory entry added');
  assert.equal(stored.commerce.funds, null, 'unlimited funds stay null');

  const order = store._orders.get(`service:player1:req-1`);
  assert.equal(order.status, 'booked', 'booked, not fulfilled');
  assert.equal(order.phase, 'final');
  assert.equal(order.kind, 'service');
  assert.equal(order.total, 100);
  assert.deepEqual(order.outcome, {
    serviceId: 'svc1',
    serviceName: 'Blacksmithing',
    price: 100,
    orderId: order.id,
  });
  assert.equal(order.details.price, 100);
});

test('book with finite funds gains the merchant the price via a single shop patch', async () => {
  const shop = makeShop({ funds: 50, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'booked');
  assert.equal(actor.wallet, 900);

  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.funds, 150, 'merchant funds gain the price');
  assert.equal(store.state.updateShopCalls, 1, 'single shop write');
});

// ----------------------------------------------------------- book idempotency

test('a replayed book returns the recorded outcome with no new debit', async () => {
  const shop = makeShop({ funds: null, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  const first = await service.book(baseBookPayload(), 'player1');
  assert.equal(first.status, 'booked');
  const orderId = first.orderId;

  const again = await service.book(baseBookPayload(), 'player1');
  assert.equal(again.status, 'replay');
  assert.equal(again.orderId, orderId);
  assert.equal(again.serviceId, 'svc1');
  assert.equal(again.serviceName, 'Blacksmithing');
  assert.equal(again.price, 100);

  // No second debit.
  assert.equal(actor.wallet, 900, 'not double-debited');
  assert.equal(store._orders.size, 1, 'no duplicate order');
});

test('the same book key with a different service is a conflict with no effect', async () => {
  const shop = makeShop({
    funds: null,
    services: [makeService({ id: 'svc1' }), makeService({ id: 'svc2', name: 'Enchanting' })],
  });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  await service.book(baseBookPayload(), 'player1');
  const conflict = await service.book(baseBookPayload({ serviceId: 'svc2' }), 'player1');
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.error, 'conflicting duplicate payload');
  assert.ok(conflict.expected);
  assert.equal(actor.wallet, 900);
});

test('a replay of a pending book surfaces needsRecovery without an effect', async () => {
  const shop = makeShop({ funds: null, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  store._orders.set('service:player1:req-1', {
    id: 'ord-pending',
    key: 'service:player1:req-1',
    kind: 'service',
    status: 'pending',
    phase: 'recorded',
    shopId: 'shop1',
    userId: 'player1',
    actorId: 'actor1',
    quantity: 1,
    total: 100,
    deposit: 0,
    remaining: 0,
    intentHash: bookIntentHashFor(),
    details: {},
    outcome: {},
    error: '',
  });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.orderId, 'ord-pending');
  assert.equal(actor.wallet, 1000, 'no debit');
  assert.equal(store.state.updateShopCalls, 0, 'no funds patch');
});

test('a replayed failed book returns replay without re-running effects', async () => {
  const shop = makeShop({ funds: null, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  store._orders.set('service:player1:req-1', {
    id: 'ord-failed',
    key: 'service:player1:req-1',
    kind: 'service',
    status: 'failed',
    phase: 'final',
    shopId: 'shop1',
    userId: 'player1',
    actorId: 'actor1',
    quantity: 1,
    total: 100,
    deposit: 0,
    remaining: 0,
    intentHash: bookIntentHashFor(),
    details: {},
    outcome: {},
    error: 'debit-failed',
  });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'replay');
  assert.equal(res.orderId, 'ord-failed');
  assert.equal(actor.wallet, 1000);
});

// ------------------------------------------------------------- book auth gates

test('a non-active-GM book is rejected before any store read', async () => {
  const shop = makeShop({ funds: null, services: [makeService()] });
  const adapter = makeAdapter();
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({
    store,
    actor,
    adapter,
    isActiveGM: () => false,
  });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'not-active-gm');
  assert.equal(store.state.findOrderCalls, 0);
  assert.equal(store.state.findShopCalls, 0);
  assert.equal(store.state.createOrderCalls, 0);
});

test('an actor the requester does not own is rejected and never records an order', async () => {
  const shop = makeShop({ funds: null, services: [makeService()] });
  const adapter = makeAdapter();
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({
    store,
    actor,
    adapter,
    actorOwnedBy: () => false,
  });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'actor-not-owned');
  assert.equal(store.state.createOrderCalls, 0);
});

test('a missing / disabled / hidden service is rejected with no effect', async () => {
  const shop = makeShop({
    funds: null,
    services: [makeService({ id: 'svc1', visible: false })],
  });
  const adapter = makeAdapter();
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  const hidden = await service.book(baseBookPayload(), 'player1');
  assert.equal(hidden.error, 'service-hidden');

  const shop2 = makeShop({
    funds: null,
    services: [makeService({ id: 'svc1', enabled: false })],
  });
  const store2 = createFakeStore({ shop: shop2 });
  const service2 = makeServiceCommerce({ store: store2, actor, adapter });
  const disabled = await service2.book(baseBookPayload(), 'player1');
  assert.equal(disabled.error, 'service-disabled');

  const shop3 = makeShop({ funds: null, services: [makeService({ id: 'other' })] });
  const store3 = createFakeStore({ shop: shop3 });
  const service3 = makeServiceCommerce({ store: store3, actor, adapter });
  const missing = await service3.book(baseBookPayload(), 'player1');
  assert.equal(missing.error, 'service-not-found');
});

test('book with a shared lock serializes against a commerce purchase', async () => {
  const shop = makeShop({ funds: 0, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
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

  const service = makeServiceCommerce({
    store,
    actor,
    adapter,
    runShopExclusive: sharedRunShopExclusive,
  });

  const [a, b] = await Promise.all([
    service.book(baseBookPayload({ requestId: 'req-a' }), 'player1'),
    service.book(baseBookPayload({ requestId: 'req-b' }), 'player1'),
  ]);
  assert.equal(a.status, 'booked');
  assert.equal(b.status, 'booked');
  assert.equal(maxDepth, 1, 'writes never overlapped under the shared lock');
});

// -------------------------------------------------------------- book money gates

test('a closed shop refuses when a world clock is provided', async () => {
  const shop = makeShop({ funds: null, services: [makeService()], open: false });
  const adapter = makeAdapter();
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({
    store,
    actor,
    adapter,
    getWorldTime: () => 0,
  });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'shop-closed');
  assert.equal(store.state.createOrderCalls, 0);
});

test('an invalid world clock fails closed before any effect', async () => {
  const shop = makeShop({ funds: null, services: [makeService()] });
  const adapter = makeAdapter();
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({
    store,
    actor,
    adapter,
    getWorldTime: () => NaN,
  });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.error, 'invalid-world-time');
  assert.equal(store.state.createOrderCalls, 0);
});

test('a closed shop refuses on the legacy path (no world clock)', async () => {
  const shop = makeShop({ funds: null, services: [makeService()], open: false });
  const adapter = makeAdapter();
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'shop-closed');
});

test('insufficient funds refuses before any debit or order', async () => {
  const shop = makeShop({ funds: null, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 50 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'insufficient-funds');
  assert.equal(actor.wallet, 50);
  assert.equal(store.state.createOrderCalls, 0);
});

test('finite merchant funds that would overflow a safe integer refuse with funds-overflow', async () => {
  const huge = Number.MAX_SAFE_INTEGER - 50;
  const shop = makeShop({ funds: huge, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'funds-overflow');
  assert.equal(actor.wallet, 1000, 'no debit');
  assert.equal(store.state.createOrderCalls, 0, 'no order persisted');
});

// ------------------------------------------------------------ book compensation

test('a failed debit is compensated (no charge) and the order is recorded failed', async () => {
  const shop = makeShop({ funds: 50, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter({ debitFails: true });
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'debit failed');
  assert.equal(actor.wallet, 1000, 'no debit applied');
  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.funds, 50, 'no funds patch applied');
  const order = store._orders.get('service:player1:req-1');
  assert.equal(order.status, 'failed');
  assert.equal(order.phase, 'final');
});

test('a debit that applies then throws is refunded in compensation', async () => {
  const shop = makeShop({ funds: 50, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter({ debitAppliesThenThrows: true });
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'debit failed after apply');
  assert.equal(actor.wallet, 1000, 'refunded');
  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.funds, 50, 'funds patch never applied');
  const order = store._orders.get('service:player1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('credit-refunded'));
});

test('a failed shop write refunds the player and records failed (no shop change)', async () => {
  const shop = makeShop({ funds: 50, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  store.state.failUpdateShop = true;
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'shop update failed');
  assert.equal(actor.wallet, 1000, 'credit refunded');
  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.funds, 50, 'shop unchanged');
  const order = store._orders.get('service:player1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('credit-refunded'));
});

test('a null commit write never claims booked and records needsRecovery', async () => {
  const shop = makeShop({ funds: 50, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  store.state.nullOrderCommit = true;
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'order-commit-missing');
  assert.equal(actor.wallet, 1000, 'debit refunded');
  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.funds, 50, 'funds restored');
  const order = store._orders.get('service:player1:req-1');
  assert.equal(order.status, 'needsRecovery');
});

test('a shop funds patch that applies then throws is restored and records failed', async () => {
  const shop = makeShop({ funds: 50, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  // updateShop applies the funds gain, then throws. The booking must not assume
  // the write never landed: compensation re-reads the persisted shop, sees the
  // known full-write (funds = 150) and restores it, concluding a clean `failed`.
  const origUpdateShop = store.updateShop.bind(store);
  let writeCalls = 0;
  store.updateShop = async (id, patch) => {
    writeCalls += 1;
    const next = await origUpdateShop(id, patch);
    if (writeCalls === 1) throw new Error('shop update exploded after apply');
    return next;
  };
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'shop update exploded after apply');
  assert.equal(actor.wallet, 1000, 'player debit refunded');
  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.funds, 50, 'merchant funds restored to pre-book level');
  const order = store._orders.get('service:player1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('shop-restored'));
});

test('a shop funds patch that returns null is re-read and restored, not assumed unwritten', async () => {
  const shop = makeShop({ funds: 50, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  // A null-returning write may STILL have applied the gain. Compensation must
  // re-read the persisted shop rather than trusting the null and skipping the
  // restore (which used to leak the +price into the merchant funds).
  const origUpdateShop = store.updateShop.bind(store);
  store.updateShop = async (id, patch) => {
    const next = await origUpdateShop(id, patch);
    if (patch.commerce && patch.commerce.funds === 150) return null;
    return next;
  };
  store.state.failOrderCommit = true;
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'failed');
  assert.equal(actor.wallet, 1000, 'player debit refunded');
  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.funds, 50, 'merchant funds restored to pre-book level');
  const order = store._orders.get('service:player1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('shop-restored'));
});

test('a compensated wallet that does not return to the original balance records needsRecovery', async () => {
  const shop = makeShop({ funds: 50, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  // getBalance reads the true wallet, but the post-refund verification read
  // reports a diverged balance so the compensated credit cannot be confirmed.
  let balanceReads = 0;
  const origGetBalance = adapter.getBalance.bind(adapter);
  adapter.getBalance = async (actor) => {
    balanceReads += 1;
    const value = await origGetBalance(actor);
    return balanceReads >= 2 ? value + 1 : value;
  };
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  store.state.failOrderCommit = true;
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'commit failed');
  assert.equal(actor.wallet, 1000, 'debit refunded even though verification diverged');
  const order = store._orders.get('service:player1:req-1');
  assert.equal(order.status, 'needsRecovery');
});

// ------------------------------------------------------------ fulfill: happy path

test('a GM can fulfill a booked service exactly once and a replay is a no-op', async () => {
  const shop = makeShop({ funds: null, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  // Preseed an ordered book: a booked advanced order that fulfills will close.
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  const booked = await service.book(baseBookPayload(), 'player1');
  assert.equal(booked.status, 'booked');
  const orderId = booked.orderId;

  const fulfilled = await service.fulfill({ orderId, requestId: 'freq-1' }, 'gm1');
  assert.equal(fulfilled.status, 'fulfilled');
  assert.equal(fulfilled.orderId, orderId);
  assert.equal(fulfilled.serviceName, 'Blacksmithing');
  assert.equal(fulfilled.price, 100);

  const order = store._orders.get('service:player1:req-1');
  assert.equal(order.status, 'fulfilled', 'original order moved to fulfilled');
  assert.equal(order.phase, 'final');

  // The fulfillment acknowledgement was recorded and committed.
  const fulfillRecord = store._orders.get(`service-fulfill:${orderId}:freq-1`);
  assert.equal(fulfillRecord.status, 'committed');
  assert.equal(fulfillRecord.kind, 'service');
  assert.equal(fulfillRecord.relatedOrderId, orderId);
  assert.equal(fulfillRecord.userId, 'gm1');

  // Replaying the SAME fulfill request does not re-run and does not create a
  // second record.
  const replay = await service.fulfill({ orderId, requestId: 'freq-1' }, 'gm2');
  assert.equal(replay.status, 'replay');
  assert.equal(replay.orderId, orderId);
  assert.equal(store._orders.size, 2, 'only the book order and one fulfill record');
});

test('fulfill is GM-only: a non-active GM is rejected before any store read', async () => {
  const shop = makeShop({ funds: null, services: [makeService()] });
  const adapter = makeAdapter();
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  store._orders.set('ord-booked', bookedOrderRecord());
  const service = makeServiceCommerce({
    store,
    actor,
    adapter,
    isActiveGM: () => false,
  });

  const res = await service.fulfill(baseFulfillPayload(), 'gm1');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'not-active-gm');
  assert.equal(store.state.createOrderCalls, 0);
});

// --------------------------------------------------------- fulfill: validation

test('fulfill rejects a missing / non-service / not-booked order', async () => {
  const shop = makeShop({ funds: null, services: [makeService()] });
  const adapter = makeAdapter();
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  const missing = await service.fulfill(baseFulfillPayload({ orderId: 'nope' }), 'gm1');
  assert.equal(missing.status, 'error');
  assert.equal(missing.error, 'order-not-found');

  store._orders.set('ord-bad-kind', {
    ...bookedOrderRecord(),
    id: 'ord-bad-kind',
    kind: 'sell',
  });
  const badKind = await service.fulfill(baseFulfillPayload({ orderId: 'ord-bad-kind' }), 'gm1');
  assert.equal(badKind.status, 'error');
  assert.equal(badKind.error, 'order-not-service');

  store._orders.set('ord-pending', {
    ...bookedOrderRecord(),
    id: 'ord-pending',
    status: 'pending',
  });
  const notBooked = await service.fulfill(baseFulfillPayload({ orderId: 'ord-pending' }), 'gm1');
  assert.equal(notBooked.status, 'error');
  assert.equal(notBooked.error, 'order-not-booked');
});

test('fulfill replays as success when the original is already fulfilled', async () => {
  const shop = makeShop({ funds: null, services: [makeService()] });
  const adapter = makeAdapter();
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  store._orders.set('ord-fulfilled', {
    ...bookedOrderRecord({ id: 'ord-fulfilled' }),
    id: 'ord-fulfilled',
    status: 'fulfilled',
  });
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.fulfill(baseFulfillPayload({ orderId: 'ord-fulfilled' }), 'gm1');
  assert.equal(res.status, 'replay');
  assert.equal(res.orderId, 'ord-fulfilled');
  assert.equal(res.serviceName, 'Blacksmithing');
  assert.equal(res.price, 100);

  // No new record was created (only the seeded order exists).
  assert.equal(store._orders.size, 1);
});

test('fulfill requires the shop and actor to still exist', async () => {
  const shop = makeShop({ funds: null, services: [makeService()] });
  const adapter = makeAdapter();
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  store._orders.set('ord-booked', bookedOrderRecord());
  const service = makeServiceCommerce({
    store,
    actor,
    adapter,
    getActor: async () => null,
  });

  const noActor = await service.fulfill(baseFulfillPayload(), 'gm1');
  assert.equal(noActor.error, 'actor-not-found');

  const store2 = createFakeStore(); // no shop
  store2._orders.set('ord-booked', bookedOrderRecord());
  const service2 = makeServiceCommerce({ store: store2, actor, adapter });
  const noShop = await service2.fulfill(baseFulfillPayload(), 'gm1');
  assert.equal(noShop.error, 'shop-not-found');
});

// --------------------------------------------------------- fulfill: recovery

test('fulfill records needsRecovery when the original-status write fails', async () => {
  const shop = makeShop({ funds: null, services: [makeService()] });
  const adapter = makeAdapter();
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  store._orders.set('ord-booked', bookedOrderRecord());
  // Cause the original 'fulfilled' write to throw.
  const origUpdate = store.updateAdvancedOrder.bind(store);
  let firstStatusWrite = true;
  store.updateAdvancedOrder = async (id, patch) => {
    if (patch.status === 'fulfilled' && firstStatusWrite) {
      firstStatusWrite = false;
      throw new Error('original write failed');
    }
    return origUpdate(id, patch);
  };
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.fulfill(baseFulfillPayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'original write failed');
  // The fulfilment record was created but never committed.
  const rec = store._orders.get(`service-fulfill:ord-booked:freq-1`);
  assert.equal(rec.status, 'needsRecovery');
});

test('fulfill records needsRecovery when the acknowledgement commit fails and re-checks original on replay', async () => {
  const shop = makeShop({ funds: null, services: [makeService()] });
  const adapter = makeAdapter();
  const actor = createMockActor();
  const store = createFakeStore({ shop });
  store._orders.set('service:player1:req-1', bookedOrderRecord());
  store.state.failFulfillCommit = true;
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.fulfill(baseFulfillPayload(), 'gm1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'fulfill commit failed');

  // The original order WAS fulfilled (the acknowledgement commit failed after),
  // and the fulfill record was left pending/needsRecovery.
  const order = store._orders.get('service:player1:req-1');
  assert.equal(order.status, 'fulfilled');
  const rec = store._orders.get(`service-fulfill:ord-booked:freq-1`);
  assert.equal(rec.status, 'needsRecovery');

  // A replay sees the original is fulfilled and returns replay success, never
  // re-running the service.
  const replay = await service.fulfill(baseFulfillPayload(), 'gm1');
  assert.equal(replay.status, 'replay');
  assert.equal(replay.orderId, 'ord-booked');
  assert.equal(store._orders.size, 2);
});

// ------------------------------------------------------- no-fake-item contract

test('booking a service never touches the purchase/delivery path (no fake Item)', async () => {
  // The actor starts with NO embedded Items; the shop starts with no inventory.
  // Booking must not call deliverItem / createEmbeddedDocuments at all.
  const shop = makeShop({ funds: null, services: [makeService({ price: 100 })] });
  let delivered = false;
  const adapter = {
    supported: true,
    async getBalance(actor) {
      return actor.wallet || 0;
    },
    async debit(actor, amount) {
      actor.wallet = (actor.wallet || 0) - amount;
    },
    async credit(actor, amount) {
      actor.wallet = (actor.wallet || 0) + amount;
    },
    async deliverItem() {
      delivered = true;
      return { id: 'fake', item: {} };
    },
    async removeItem() {
      delivered = true;
      return true;
    },
  };
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  await service.book(baseBookPayload(), 'player1');
  assert.equal(delivered, false, 'deliverItem/removeItem never called');
  assert.equal(actor.items.size, 0, 'no embedded Item created on the actor');
  assert.equal(store._shops.get('shop1').inventory.length, 0, 'no inventory entry added');
});

// ------------------------------------------------------- booked-not-fulfilled

test('a booked service is recorded booked (not fulfilled) and a book replay respects that', async () => {
  const shop = makeShop({ funds: null, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'booked');
  const order = store._orders.get('service:player1:req-1');
  assert.equal(order.status, 'booked');
  assert.notEqual(order.status, 'fulfilled');

  // A book replay of an already-fulfilled order is still a replay of the booking.
  store._orders.get('service:player1:req-1').status = 'fulfilled';
  const replay = await service.book(baseBookPayload(), 'player1');
  assert.equal(replay.status, 'replay');
  assert.equal(replay.price, 100);
});

// --------------------------------------------------------- shop-write safety

test('a null merchant-funds write never claims booked and records shop-write-missing', async () => {
  const shop = makeShop({ funds: 50, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  store.state.nullUpdateShop = true;
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  // The funds patch returned null without applying, so the booking must NOT claim
  // `booked`; compensation refunds the debit and records a clean `failed`.
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'shop-write-missing');
  assert.equal(actor.wallet, 1000, 'debit refunded');
  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.funds, 50, 'funds unchanged');
  const order = store._orders.get('service:player1:req-1');
  assert.equal(order.status, 'failed');
  assert.ok(order.details.compensation.includes('shop-unwritten'));
});

// -------------------------------------------------------- replay originalStatus

test('a replayed booked service carries originalStatus booked', async () => {
  const shop = makeShop({ funds: 50, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  await service.book(baseBookPayload(), 'player1');
  const replay = await service.book(baseBookPayload(), 'player1');
  assert.equal(replay.status, 'replay');
  assert.equal(replay.originalStatus, 'booked');
});

test('a replayed failed service carries originalStatus failed', async () => {
  const shop = makeShop({ funds: 50, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  const service = makeServiceCommerce({ store, actor, adapter });

  await service.book(baseBookPayload(), 'player1');
  // A terminal failed original replays as a failed replay carrying 'failed'.
  store._orders.get('service:player1:req-1').status = 'failed';
  const replay = await service.book(baseBookPayload(), 'player1');
  assert.equal(replay.status, 'replay');
  assert.equal(replay.originalStatus, 'failed');
});

// ---------------------------------------- terminal commit re-read (service)

test('a booked commit write that applies then throws is reported booked and never compensated', async () => {
  const shop = makeShop({ funds: 50, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  // The terminal `booked` write APPLIES the state then throws: the booking may
  // STILL have persisted, so the service must re-read rather than assume failed.
  const originalUpdate = store.updateAdvancedOrder.bind(store);
  store.updateAdvancedOrder = async (id, patch) => {
    if (patch.status === 'booked') {
      const res = await originalUpdate(id, patch);
      throw new Error('commit write exploded after apply');
    }
    return originalUpdate(id, patch);
  };
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'booked');
  assert.equal(res.serviceId, 'svc1');
  assert.equal(res.serviceName, 'Blacksmithing');
  assert.equal(res.price, 100);

  // The booking persisted, so NO compensation runs: the debit is kept and the
  // merchant funds gain is kept.
  assert.equal(actor.wallet, 900, 'player debit kept: no compensation');
  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.funds, 150, 'merchant funds gain kept: no compensation');
  const order = store._orders.get('service:player1:req-1');
  assert.equal(order.status, 'booked');
});

test('a booked commit whose re-read is unavailable is needsRecovery without refunding', async () => {
  const shop = makeShop({ funds: 50, services: [makeService({ price: 100 })] });
  const adapter = makeAdapter();
  const actor = createMockActor({ wallet: 1000 });
  const store = createFakeStore({ shop });
  // The terminal `booked` write throws (does not apply), so the order is pending.
  const originalUpdate = store.updateAdvancedOrder.bind(store);
  store.updateAdvancedOrder = async (id, patch) => {
    if (patch.status === 'booked') throw new Error('commit write failed');
    return originalUpdate(id, patch);
  };
  // The post-commit re-read is unavailable (lost read): the booking cannot be
  // confirmed, so it must escalate WITHOUT refunding/restoring.
  store.findAdvancedOrder = async () => {
    throw new Error('order read failed');
  };
  const service = makeServiceCommerce({ store, actor, adapter });

  const res = await service.book(baseBookPayload(), 'player1');
  assert.equal(res.status, 'needsRecovery');
  assert.equal(res.error, 'commit write failed');
  assert.deepEqual(res.compensation, []);
  // No compensation: the debit and the merchant funds gain stay applied.
  assert.equal(actor.wallet, 900, 'debit not refunded');
  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.funds, 150, 'merchant funds gain kept');
  // The order is left pending: a replay will surface it for reconciliation.
  assert.equal(store._orders.get('service:player1:req-1').status, 'pending');
});
