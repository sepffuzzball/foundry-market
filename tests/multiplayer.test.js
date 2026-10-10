// M6 concurrency / recovery validation.
//
// These are pure Node tests (no Foundry globals) that drive the real market
// services - commerce purchase, cart checkout, selling, preorders, theft,
// automation - through a shared fake store and a controllable per-shop lock.
//
// The module deliberately does NOT claim distributed/transactional atomicity.
// This suite validates the concrete, deterministic boundaries of that claim:
//
//   - 50 simultaneous purchase/cart/automation operations on ONE shop share the
//     per-shop lock and never oversell or double-debit; replay is idempotent.
//   - Two shops operate independently (separate locks, no cross-contamination).
//   - A GM handoff while an automation / sell / cart operation is queued behind
//     another writer refuses the queued operation (no stale write).
//   - Replay and pending/needsRecovery across request ids cannot redo effects for
//     preorder or theft.
//   - An injected update that applies-then-throws is recovered (escalated to
//     needsRecovery, never reported as a clean success).
//   - Two INDEPENDENT GM service instances (separate lock maps) on the same fake
//     store: the store's atomic read-then-create masks the race, so no
//     double-charge; a gated read/create interleaving reproduces the documented
//     multi-GM non-atomic window deterministically.
//
// No flaky nondeterministic race is asserted: every interleaving is forced with
// explicit gates or counted in aggregate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCommerce, createLockMap } from '../src/services/commerce.js';
import { createCartCommerce } from '../src/advanced/cart.js';
import { createSellingService } from '../src/advanced/selling.js';
import { createPreorderCommerce } from '../src/advanced/preorders.js';
import { createTheftCommerce } from '../src/advanced/theft.js';
import { createAutomationService } from '../src/automation/service.js';
import {
  normalizeShop,
  normalizeInventoryEntry,
  normalizeAdvancedOrder,
  makeId,
} from '../src/services/model.js';
import {
  handleMarketChatMessage,
  publicPurchaseResult,
  publicCartResult,
} from '../src/core/requests.js';
import { fingerprintItem } from '../src/advanced/valuation.js';
import { timeAt } from '../src/automation/policy.js';

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A two-party barrier used to force a deterministic interleaving. */
function makeBarrier(parties) {
  let arrived = 0;
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return {
    promise,
    arrive() {
      arrived += 1;
      if (arrived >= parties) release();
      return promise;
    },
  };
}

function makeEntry(overrides = {}) {
  return normalizeInventoryEntry({
    id: 'entry1',
    name: 'Potion',
    price: 100,
    quantity: 10,
    stockMode: 'finite',
    visible: true,
    itemUuid: '',
    snapshot: JSON.stringify({
      name: 'Potion',
      img: 'icons/potion.png',
      system: { quantity: 1 },
    }),
    ...overrides,
  });
}

function makeActor({ id = 'actor1', wallet = 1000, uuid = 'Actor.actor1', items = [], ownedBy } = {}) {
  const itemMap = new Map();
  for (const spec of items) {
    const doc = makeEmbeddedItem({ ...spec, parent: null });
    itemMap.set(doc.id, doc);
  }
  const actor = {
    id,
    name: 'Player',
    uuid,
    wallet,
    items: itemMap,
    deliveredIds: [],
    removedIds: [],
    async update() {
      return this;
    },
  };
  return { actor, ownership: ownedBy || id };
}

function makeEmbeddedItem({ id = 'item1', name = 'Barter Item', img = '', extraSystem = {}, parent = null } = {}) {
  const data = {
    _id: id,
    name,
    img,
    type: 'gear',
    system: { quantity: 1, ...extraSystem },
  };
  return {
    id,
    documentName: 'Item',
    parent,
    _data: data,
    toObject() {
      return JSON.parse(JSON.stringify(data));
    },
  };
}

function makeShop(overrides = {}) {
  const {
    id = 'shop1',
    name = 'General Store',
    open = true,
    inventory = [makeEntry()],
    funds = 0,
    preorders = { enabled: true, depositBps: 2500, maxPerActor: 3 },
    theft = { enabled: true },
    automation,
  } = overrides;
  return normalizeShop({
    id,
    name,
    locationId: 'home',
    open,
    inventory,
    automation: automation ?? {},
    commerce: { funds, preorders, theft },
  });
}

/**
 * A single-store stand-in for the market persistence. It supports shops,
 * ledgers and advanced orders, exposes listShops/listLocations/listAdvancedOrders
 * (needed by automation and the preorder pending-action guard), and carries
 * fault-injection flags (fail / null / applies-then-throws) plus optional
 * read-then-create gates on `createLedger` / `createAdvancedOrder`.
 *
 * Ledger / order idempotency is implemented by scanning (read-then-create). The
 * default path has NO await between the existence scan and the insert, so it is
 * atomic in JS and masks the JournalEntry race. A `hooks.beforeCreateXxx` gate
 * forces a genuine non-atomic interleaving in the race test.
 */
function createUnifiedStore({ shops = [], locations = [] } = {}) {
  const shopMap = new Map(shops.map((s) => [s.id, s]));
  const locMap = new Map(locations.map((l) => [l.id, l]));
  const ledgerRecords = [];
  const orderRecords = [];
  const state = {
    findShopCalls: 0,
    updateShopCalls: 0,
    findLedgerCalls: 0,
    createLedgerCalls: 0,
    findOrderCalls: 0,
    createOrderCalls: 0,
    failUpdateShop: false,
    nullUpdateShop: false,
    updateShopAppliesThenThrows: false,
    failLedgerCommit: false,
    nullLedgerCommit: false,
    ledgerCommitAppliesThenThrows: false,
    failOrderCommit: false,
    nullOrderCommit: false,
    orderCommitAppliesThenThrows: false,
  };
  const hooks = {
    beforeCreateLedger: null,
    beforeCreateOrder: null,
  };

  const store = {
    state,
    hooks,
    _shops: shopMap,
    _locations: locMap,
    _ledgers: ledgerRecords,
    _orders: orderRecords,

    async listLocations() {
      return [...locMap.values()];
    },
    async listShops() {
      return [...shopMap.values()];
    },
    async findShop(id) {
      state.findShopCalls += 1;
      return shopMap.get(id) || null;
    },
    async updateShop(id, patch) {
      state.updateShopCalls += 1;
      const current = shopMap.get(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      shopMap.set(id, next);
      if (state.updateShopAppliesThenThrows) {
        state.updateShopAppliesThenThrows = false;
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
      return next;
    },

    async findLedgerByKey(key) {
      state.findLedgerCalls += 1;
      return ledgerRecords.find((r) => r.key === key) || null;
    },
    async createLedger(record) {
      state.createLedgerCalls += 1;
      const existing = ledgerRecords.find((r) => r.key === record.key);
      if (existing) return { record: existing, created: false };
      if (hooks.beforeCreateLedger) await hooks.beforeCreateLedger(record);
      const rec = { ...record, id: record.id || makeId() };
      ledgerRecords.push(rec);
      return { record: rec, created: true };
    },
    async updateLedger(id, patch) {
      const rec = ledgerRecords.find((r) => r.id === id);
      if (!rec) return null;
      const next = { ...rec, ...patch, updatedAt: patch.updatedAt ?? rec.updatedAt };
      const index = ledgerRecords.indexOf(rec);
      ledgerRecords[index] = next;
      if (state.ledgerCommitAppliesThenThrows && patch.status === 'committed') {
        state.ledgerCommitAppliesThenThrows = false;
        throw new Error('ledger commit applied then failed');
      }
      if (state.failLedgerCommit && patch.status === 'committed') {
        state.failLedgerCommit = false;
        throw new Error('ledger commit failed');
      }
      if (state.nullLedgerCommit && patch.status === 'committed') {
        state.nullLedgerCommit = false;
        return null;
      }
      return next;
    },

    async findAdvancedOrderByKey(key) {
      state.findOrderCalls += 1;
      return orderRecords.find((r) => r.key === key) || null;
    },
    async findAdvancedOrder(id) {
      return orderRecords.find((r) => r.id === id) || null;
    },
    async listAdvancedOrders({ shopId, actorId, status, kind, limit = 100, offset = 0 } = {}) {
      let records = [...orderRecords];
      if (shopId != null) records = records.filter((r) => r.shopId === shopId);
      if (actorId != null) records = records.filter((r) => r.actorId === actorId);
      if (status != null) records = records.filter((r) => r.status === status);
      if (kind != null) records = records.filter((r) => r.kind === kind);
      records = records.sort((a, b) => b.createdAt - a.createdAt);
      return records.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, Math.min(limit, 100)));
    },
    async createAdvancedOrder(record) {
      state.createOrderCalls += 1;
      const normalized = normalizeAdvancedOrder(record);
      const existing = orderRecords.find((r) => r.key === normalized.key);
      if (existing) return { record: existing, created: false };
      if (hooks.beforeCreateOrder) await hooks.beforeCreateOrder(normalized);
      const rec = { ...normalized, id: normalized.id || makeId() };
      orderRecords.push(rec);
      return { record: rec, created: true };
    },
    async updateAdvancedOrder(id, patch) {
      const rec = orderRecords.find((r) => r.id === id);
      if (!rec) return null;
      const next = { ...rec, ...patch, updatedAt: patch.updatedAt ?? rec.updatedAt };
      // Immutable fields are forced back, mirroring the real store.
      next.key = rec.key;
      next.kind = rec.kind;
      next.shopId = rec.shopId;
      next.actorId = rec.actorId;
      next.userId = rec.userId;
      next.intentHash = rec.intentHash;
      const index = orderRecords.indexOf(rec);
      orderRecords[index] = next;
      if (state.orderCommitAppliesThenThrows && patch.status === 'committed') {
        state.orderCommitAppliesThenThrows = false;
        throw new Error('order commit applied then failed');
      }
      if (state.failOrderCommit && patch.status === 'committed') {
        state.failOrderCommit = false;
        throw new Error('order commit failed');
      }
      if (state.nullOrderCommit && patch.status === 'committed') {
        state.nullOrderCommit = false;
        return null;
      }
      return next;
    },
  };

  return store;
}

function makeUnifiedAdapter({ creditFails = false, removeFails = false, deliverFails = false, debitFails = false } = {}) {
  let deliverCount = 0;
  const adapter = {
    supported: true,
    deliveryMode: 'embedded',
    quantityPath: '',
    removedIds: [],
    async getBalance(actor) {
      return actor.wallet || 0;
    },
    async getItemPrice() {
      return { minorUnits: 100 };
    },
    async debit(actor, amount) {
      if (debitFails) throw new Error('debit failed');
      if ((actor.wallet || 0) < amount) throw new Error('insufficient funds');
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
      if (deliverFails) throw new Error('deliver failed');
      const id = `delivered-${makeId()}`;
      actor.deliveredIds.push(id);
      return { id, item };
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

/** Neutral social quote that leaves the base price unchanged. */
const neutralSocial = async () => ({ individual: 0, party: 0, score: 0 });

/** A GM-approved valuation fixture that never refuses (cash checkouts only). */
const nullApprovedValuation = async () => 100;

/**
 * Wire the full set of services over a shared store and, optionally, a single
 * shared per-shop lock. When `sharedLock` is true a single lock map is injected
 * into commerce AND wrapped for the advanced/automation services so every
 * writer on the same shop serializes. Passing `share` per service in lieu is not
 * supported: the whole harness is either shared-lock or independent-lock.
 */
function makeHarness({ store, shop, actor, adapter, sharedLock = true, isActiveGM = () => true } = {}) {
  const lockMap = sharedLock ? createLockMap() : null;
  const runShopExclusive = lockMap
    ? (shopId, fn) => lockMap.run(`shop:${shopId}`, fn)
    : (shopId, fn) => fn();
  const getActor = async (id) => (actor && actor.id === id ? actor : null);
  const actorOwnedBy = (a, userId) => {
    if (typeof actor.ownedBy === 'function') return actor.ownedBy(a, userId);
    return a.id === actor.id;
  };

  const commerce = createCommerce({
    store,
    getActor,
    fromUuid: async () => null,
    getAdapter: () => adapter,
    systemId: () => 'dnd5e',
    isGM: () => true,
    actorOwnedBy,
    logger: { error: () => {} },
    now: () => 1000,
    makeId,
    ...(lockMap ? { lockMap } : {}),
  });

  const cart = createCartCommerce({
    store,
    runShopExclusive,
    isActiveGM,
    getActor,
    actorOwnedBy,
    getAdapter: () => adapter,
    fromUuid: async () => null,
    getSocial: neutralSocial,
    getApprovedValuation: nullApprovedValuation,
    now: () => 1000,
    logger: { error: () => {} },
  });

  const selling = createSellingService({
    store,
    runShopExclusive,
    isActiveGM,
    getActor,
    actorOwnedBy,
    getAdapter: () => adapter,
    getApprovedValuation: async () => 100,
    now: () => 1000,
    makeId,
    logger: { error: () => {} },
  });

  const preorders = createPreorderCommerce({
    store,
    runShopExclusive,
    isActiveGM,
    getActor,
    actorOwnedBy,
    getAdapter: () => adapter,
    fromUuid: async () => null,
    getSocial: neutralSocial,
    now: () => 1000,
    logger: { error: () => {} },
  });

  const theft = createTheftCommerce({
    store,
    runShopExclusive,
    isActiveGM,
    getActor,
    actorOwnedBy,
    getAdapter: () => adapter,
    fromUuid: async () => null,
    getSocial: neutralSocial,
    now: () => 1000,
    logger: { error: () => {} },
  });

  const automation = createAutomationService({
    store,
    runShopExclusive,
    isActiveGM,
    now: () => timeAt(0, 0) + 3600,
    logger: { error: () => {} },
  });

  return { lockMap, runShopExclusive, commerce, cart, selling, preorders, theft, automation };
}

function activateShop(store, shop) {
  store._shops.set(shop.id, shop);
}

// ================================================================ 1. request path

test('authenticated GM request path processes multiple actors/users with public-only responses', async () => {
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 10 })] });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor: actor1 } = makeActor({ id: 'actor1', uuid: 'Actor.actor1', wallet: 1000, ownedBy: 'user1' });
  const { actor: actor2 } = makeActor({ id: 'actor2', uuid: 'Actor.actor2', wallet: 1000, ownedBy: 'user2' });
  const harness = makeHarness({
    store,
    actor: actor1,
    adapter,
    sharedLock: true,
  });
  // getActor must resolve both actors; actorOwnedBy must enforce ownership.
  harness.commerce = createCommerce({
    store,
    getActor: async (id) => (id === 'actor1' ? actor1 : id === 'actor2' ? actor2 : null),
    fromUuid: async () => null,
    getAdapter: () => adapter,
    systemId: () => 'dnd5e',
    isGM: () => true,
    actorOwnedBy: (a, userId) => {
      if (a.id === 'actor1') return userId === 'user1';
      if (a.id === 'actor2') return userId === 'user2';
      return false;
    },
    logger: { error: () => {} },
    now: () => 1000,
    makeId,
  });

  const requests = [];
  const responses = [];
  const ctx = {
    activeGMId: () => 'gm1',
    currentUserId: () => 'gm1',
    gmIds: () => ['gm1'],
    respond: async (data) => {
      requests.push(data);
      responses.push(data.flags.market.response);
    },
    commerce: harness.commerce,
    getActor: async (id) => (id === 'actor1' ? actor1 : id === 'actor2' ? actor2 : null),
    actorOwnedBy: (a, userId) => {
      if (a.id === 'actor1') return userId === 'user1';
      if (a.id === 'actor2') return userId === 'user2';
      return false;
    },
  };

  const msg1 = {
    flags: { market: { type: 'request', request: { type: 'purchase', shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, requestId: 'req-user1' } } },
  };
  const msg2 = {
    flags: { market: { type: 'request', request: { type: 'purchase', shopId: 'shop1', entryId: 'entry1', actorId: 'actor2', quantity: 1, requestId: 'req-user2' } } },
  };
  const r1 = await handleMarketChatMessage(msg1, 'user1', ctx);
  const r2 = await handleMarketChatMessage(msg2, 'user2', ctx);

  assert.equal(r1.type, 'purchase');
  assert.equal(r1.result.status, 'committed');
  assert.equal(r2.type, 'purchase');
  assert.equal(r2.result.status, 'committed');
  // Only allowlisted fields escape; never a raw ledger record.
  assert.equal('record' in r1.result, false);
  assert.equal('existing' in r1.result, false);
  assert.equal('conflict' in r1.result, false);
  assert.equal('expected' in r1.result, false);
  assert.equal(r1.result.quantity, 1);
  assert.equal(r1.result.total, 100);
  assert.equal(actor1.wallet, 900, 'actor1 debited exactly once');
  assert.equal(actor2.wallet, 900, 'actor2 debited exactly once');
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory[0].quantity, 8, 'both decrements applied serially under the shared lock');
  // The hook userId is trusted as the requester, never the payload.
  const byKey = store._ledgers.filter((r) => r.key.startsWith('user1:req-user1') || r.key.startsWith('user2:req-user2'));
  assert.equal(byKey.length, 2, 'one ledger per request');
});

// ==================================================== 2. 50 ops on one shop

test('50 simultaneous purchases on one shop never oversell or double-debit (aggregate invariant)', async () => {
  // Finite stock of 30; 50 distinct qty-1 purchases. Exactly 30 must commit and
  // 20 must fail as insufficient-stock. The exact subset that commits is
  // scheduler-dependent, but the aggregates are deterministic: 30 debits of 100,
  // zero oversell, no double-debit.
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 30 })], funds: 0 });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 10000 });
  const { commerce } = makeHarness({ store, actor, adapter, sharedLock: true });
  const p = () =>
    commerce.purchase(
      {
        shopId: 'shop1',
        entryId: 'entry1',
        actorId: 'actor1',
        quantity: 1,
        requestId: `req-${makeId()}`,
        userId: 'user1',
      },
      'gm1'
    );

  const results = await Promise.all(Array.from({ length: 50 }, p));
  const committed = results.filter((r) => r.status === 'committed').length;
  const insufficient = results.filter((r) => r.status === 'failed' && r.error === 'insufficient-stock').length;
  assert.equal(committed, 30, 'exactly 30 purchases commit');
  assert.equal(insufficient, 20, 'the remaining 20 fail as insufficient-stock');
  assert.equal(actor.wallet, 10000 - 30 * 100, 'exactly 30 purchases were charged (no double-debit)');
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory[0].quantity, 0, 'no oversell: stock cannot go negative');
  const committedLedgers = store._ledgers.filter((r) => r.status === 'committed');
  assert.equal(committedLedgers.length, 30, 'one committed ledger per successful request');
});

test('replay of a committed purchase is idempotent (no second charge, no second ledger)', async () => {
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 10 })] });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000 });
  const { commerce } = makeHarness({ store, actor, adapter, sharedLock: true });
  const payload = { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, requestId: 'fixed', userId: 'user1' };
  const first = await commerce.purchase(payload, 'gm1');
  assert.equal(first.status, 'committed');
  const wallet = actor.wallet;
  const second = await commerce.purchase(payload, 'gm1');
  assert.equal(second.status, 'replay');
  assert.equal(actor.wallet, wallet, 'no second charge');
  assert.equal(store._ledgers.length, 1, 'single ledger record');
});

test('50 mixed purchase/cart/automation ops under the shared per-shop lock do not oversell or double-debit', async () => {
  const shop = makeShop({
    inventory: [makeEntry({ id: 'entry1', price: 10, quantity: 100 })],
    funds: 0,
    automation: {}, // no due plan -> idle
  });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 10000 });
  const { commerce, cart, automation } = makeHarness({ store, actor, adapter, sharedLock: true });

  let purchaseOps = [];
  for (let i = 0; i < 20; i++) {
    purchaseOps.push(
      commerce.purchase(
        { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, requestId: `p-${i}`, userId: 'user1' },
        'gm1'
      )
    );
  }
  const cartOps = [];
  for (let i = 0; i < 20; i++) {
    cartOps.push(
      cart.checkout(
        { shopId: 'shop1', actorId: 'actor1', lines: [{ entryId: 'entry1', quantity: 1 }], requestId: `c-${i}` },
        'gm1'
      )
    );
  }
  const autoOps = [];
  for (let i = 0; i < 10; i++) {
    autoOps.push(automation.runShop('shop1'));
  }

  const [p, c, a] = await Promise.all([Promise.all(purchaseOps), Promise.all(cartOps), Promise.all(autoOps)]);

  const pCommitted = p.filter((r) => r.status === 'committed').length;
  const cCommitted = c.filter((r) => r.status === 'committed').length;
  const aIdle = a.filter((r) => r.status === 'idle').length;
  assert.equal(pCommitted, 20, 'all purchases commit (stock was sufficient)');
  assert.equal(cCommitted, 20, 'all carts commit (stock was sufficient)');
  assert.equal(aIdle, 10, 'idle automation runs never write');

  const chargedUnits = 20 + 20;
  assert.equal(actor.wallet, 10000 - chargedUnits * 10, 'no double-debit: exactly 40 units charged at price 10');
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory[0].quantity, 100 - chargedUnits, 'stock decremented by exactly the sold units (no oversell, no lost update)');
});

// ============================================================ 3. two shops

test('two shops operate independently under separate per-shop locks', async () => {
  const shop1 = makeShop({ id: 'shop1', inventory: [makeEntry({ id: 'entry1', price: 100, quantity: 10 })], funds: 0 });
  const shop2 = makeShop({ id: 'shop2', inventory: [makeEntry({ id: 'entry1', price: 50, quantity: 10 })], funds: 1000 });
  const store = createUnifiedStore({ shops: [shop1, shop2] });
  const adapter = makeUnifiedAdapter();
  const { actor: actor1 } = makeActor({ id: 'actor1', wallet: 1000 });
  const { actor: actor2 } = makeActor({ id: 'actor2', wallet: 1000 });
  const getActor = async (id) => (id === 'actor1' ? actor1 : id === 'actor2' ? actor2 : null);
  const harness = makeHarness({ store, actor: actor1, adapter, sharedLock: true });
  harness.commerce = createCommerce({
    store,
    getActor,
    fromUuid: async () => null,
    getAdapter: () => adapter,
    systemId: () => 'dnd5e',
    isGM: () => true,
    actorOwnedBy: (a) => a.id === 'actor1' || a.id === 'actor2',
    logger: { error: () => {} },
    now: () => 1000,
    makeId,
    ...(harness.lockMap ? { lockMap: harness.lockMap } : {}),
  });

  const ops = [];
  for (let i = 0; i < 10; i++) {
    ops.push(
      harness.commerce.purchase({ shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, requestId: `s1-${i}`, userId: 'u1' }, 'gm1')
    );
    ops.push(
      harness.commerce.purchase({ shopId: 'shop2', entryId: 'entry1', actorId: 'actor2', quantity: 1, requestId: `s2-${i}`, userId: 'u2' }, 'gm1')
    );
  }
  const results = await Promise.all(ops);
  assert.equal(results.filter((r) => r.status === 'committed').length, 20, 'all 20 commits succeed');
  assert.equal(actor1.wallet, 1000 - 10 * 100, 'shop1 charged 10 at 100 each');
  assert.equal(actor2.wallet, 1000 - 10 * 50, 'shop2 charged 10 at 50 each');
  const s1 = store._shops.get('shop1');
  const s2 = store._shops.get('shop2');
  assert.equal(s1.inventory[0].quantity, 0, 'shop1 stock fully consumed');
  assert.equal(s2.inventory[0].quantity, 0, 'shop2 stock fully consumed');
  assert.equal(s2.commerce.funds, 1000 + 10 * 50, 'shop2 finite funds gained its own revenue only');
  assert.equal(s1.commerce.funds, 0 + 10 * 100, 'shop1 finite funds gained its own revenue only');
});

// =================================================== 4. GM handoff refinement

/** A runShopExclusive that blocks until `release` so an op is "queued". */
function makeQueuedRun(store) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const runShopExclusive = (shopId, fn) => gate.then(() => fn());
  return { runShopExclusive, release };
}

test('a handoff while a sell is queued refuses the queued sell (not-active-gm, no writes)', async () => {
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 10 })], funds: 0 });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000, items: [{ id: 'item1', name: 'Sword' }] });
  // Route the item through actor.items so the sale can resolve it.
  const itemMap = new Map();
  const item = makeEmbeddedItem({ id: 'item1', name: 'Sword', parent: actor });
  itemMap.set(item.id, item);
  actor.items = itemMap;

  let active = true;
  const isActiveGM = () => active;
  const harness = makeHarness({ store, actor, adapter, sharedLock: false, isActiveGM });
  // Replace the shared-lock run with the queued gate.
  const { runShopExclusive, release } = makeQueuedRun(store);
  harness.selling = createSellingService({
    store,
    runShopExclusive,
    isActiveGM,
    getActor: async () => actor,
    actorOwnedBy: () => true,
    getAdapter: () => adapter,
    getApprovedValuation: async () => 100,
    now: () => 1000,
    makeId,
    logger: { error: () => {} },
  });

  const before = store.state.updateShopCalls;
  const sellPromise = harness.selling.sell({ shopId: 'shop1', actorId: 'actor1', itemId: 'item1', requestId: 'sell-1' }, 'user1');
  await sleep(0);
  active = false; // GM hands off while the sell is queued behind the gate.
  release();
  const res = await sellPromise;
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'not-active-gm');
  assert.equal(store.state.updateShopCalls, before, 'no store write after handoff');
  assert.equal(actor.wallet, 1000, 'no payout');
});

test('a handoff while a cart checkout is queued refuses the queued checkout (not-active-gm, no writes)', async () => {
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 10 })], funds: 0 });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000 });
  let active = true;
  const isActiveGM = () => active;
  const harness = makeHarness({ store, actor, adapter, sharedLock: false, isActiveGM });
  const { runShopExclusive, release } = makeQueuedRun(store);
  harness.cart = createCartCommerce({
    store,
    runShopExclusive,
    isActiveGM,
    getActor: async () => actor,
    actorOwnedBy: () => true,
    getAdapter: () => adapter,
    fromUuid: async () => null,
    getSocial: neutralSocial,
    getApprovedValuation: nullApprovedValuation,
    now: () => 1000,
    logger: { error: () => {} },
  });

  const beforeWrites = store.state.updateShopCalls;
  const beforeOrders = store._orders.length;
  const cartPromise = harness.cart.checkout({ shopId: 'shop1', actorId: 'actor1', lines: [{ entryId: 'entry1', quantity: 2 }], requestId: 'cart-1' }, 'user1');
  await sleep(0);
  active = false;
  release();
  const res = await cartPromise;
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'not-active-gm');
  assert.equal(store.state.updateShopCalls, beforeWrites, 'no shop write');
  assert.equal(store._orders.length, beforeOrders, 'no order persisted');
  assert.equal(actor.wallet, 1000, 'no charge');
});

test('a handoff while an automation run is queued refuses the queued run (idle, no write)', async () => {
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 10 })], automation: {} });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000 });
  let active = true;
  const isActiveGM = () => active;
  const harness = makeHarness({ store, actor, adapter, sharedLock: false, isActiveGM });
  const { runShopExclusive, release } = makeQueuedRun(store);
  harness.automation = createAutomationService({
    store,
    runShopExclusive,
    isActiveGM,
    now: () => timeAt(0, 0) + 3600,
    logger: { error: () => {} },
  });

  const beforeWrites = store.state.updateShopCalls;
  const runPromise = harness.automation.runShop('shop1');
  await sleep(0);
  active = false;
  release();
  const res = await runPromise;
  assert.equal(res.status, 'idle');
  assert.equal(res.shopId, 'shop1');
  assert.equal(store.state.updateShopCalls, beforeWrites, 'no store write');
});

// =================================== 5. replay / pending / needsRecovery

test('a replayed preorder place never re-debits or re-creates the order', async () => {
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 0 })], preorders: { enabled: true, depositBps: 2500, maxPerActor: 3 } });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000 });
  const { preorders } = makeHarness({ store, actor, adapter, sharedLock: true });
  const payload = { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, requestId: 'pre-1' };
  const first = await preorders.place(payload, 'user1');
  assert.equal(first.status, 'booked');
  const wallet = actor.wallet;
  const orders = store._orders.length;
  const again = await preorders.place(payload, 'user1');
  assert.equal(again.status, 'replay');
  assert.equal(again.orderId, first.orderId);
  assert.equal(actor.wallet, wallet, 'no second debit');
  assert.equal(store._orders.length, orders, 'no second order');
});

test('a preorder place left pending/needsRecovery across request ids never re-debits', async () => {
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 0 })], preorders: { enabled: true, depositBps: 2500, maxPerActor: 3 } });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000 });
  const { preorders } = makeHarness({ store, actor, adapter, sharedLock: true });
  const payload = { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, requestId: 'pre-pending' };
  const first = await preorders.place(payload, 'user1');
  assert.equal(first.status, 'booked');
  // Simulate an interrupted run: the persisted order is still pending (or needs
  // recovery). Re-issuing the SAME key must resolve to needsRecovery and never
  // re-debit.
  const rec = store._orders.find((r) => r.key === `preorder:user1:pre-pending`);
  rec.status = 'needsRecovery';
  rec.error = 'order-pending';
  const wallet = actor.wallet;
  const again = await preorders.place({ ...payload, requestId: 'pre-pending' }, 'user1');
  assert.equal(again.status, 'needsRecovery');
  assert.equal(actor.wallet, wallet, 'no re-debit');
  assert.equal(store._orders.length, 1, 'no second order');
});

test('a replayed theft attempt never creates a second claim', async () => {
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 5 })], preorders: { enabled: false }, theft: { enabled: true } });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000 });
  const { theft } = makeHarness({ store, actor, adapter, sharedLock: true });
  const payload = { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', requestId: 'theft-1' };
  const first = await theft.attempt(payload, 'user1');
  assert.equal(first.status, 'booked');
  const orders = store._orders.length;
  const again = await theft.attempt(payload, 'user1');
  assert.match(again.status, /replay|booked/);
  assert.equal(store._orders.length, orders, 'no second claim order');
});

test('a theft attempt left needsRecovery resolves to needsRecovery and never re-creates', async () => {
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 5 })], preorders: { enabled: false }, theft: { enabled: true } });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000 });
  const { theft } = makeHarness({ store, actor, adapter, sharedLock: true });
  const payload = { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', requestId: 'theft-rec' };
  const first = await theft.attempt(payload, 'user1');
  assert.equal(first.status, 'booked');
  const rec = store._orders.find((r) => r.key === `theft:user1:theft-rec`);
  rec.status = 'needsRecovery';
  const orders = store._orders.length;
  const again = await theft.attempt(payload, 'user1');
  assert.equal(again.status, 'needsRecovery');
  assert.equal(store._orders.length, orders, 'no second claim order');
});

test('a competing preorder fulfill/cancel with a different request id does not double-run', async () => {
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 0 })], preorders: { enabled: true, depositBps: 2500, maxPerActor: 3 } });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000 });
  const { preorders } = makeHarness({ store, actor, adapter, sharedLock: true });
  const placed = await preorders.place({ shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, requestId: 'orig' }, 'user1');
  assert.equal(placed.status, 'booked');
  const origin = store._orders.find((r) => r.kind === 'preorder' && r.status === 'booked');

  // Seed a pending fulfill action for the same original (as if a second GM
  // request already started fulfilling it). A cancel with a DIFFERENT requestId
  // must surface needsRecovery and never run.
  store._orders.push(
    normalizeAdvancedOrder({
      id: makeId(),
      key: `preorder-fulfill:${origin.id}:req-2`,
      kind: 'preorder-fulfill',
      status: 'pending',
      phase: 'recorded',
      shopId: 'shop1',
      actorId: 'actor1',
      relatedOrderId: origin.id,
      quantity: 1,
      total: 100,
      deposit: 25,
      remaining: 75,
      userId: 'gm1',
      createdAt: 10,
      intentHash: 'seed',
    })
  );

  const cancel = await preorders.cancel(
    { orderId: origin.id, requestId: 'cancel-different' },
    'gm1'
  );
  assert.equal(cancel.status, 'needsRecovery');
  assert.equal(origin.status, 'booked', 'original preorder untouched');
});

// =============================================== 6. applies-then-throws recovery

test('a shop write that applies-then-throws is recovered (failed, not falsely success)', async () => {
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 10 })], funds: 0 });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000 });
  const { commerce } = makeHarness({ store, actor, adapter, sharedLock: true });
  store.state.updateShopAppliesThenThrows = true;
  const res = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, requestId: 'at-1', userId: 'user1' },
    'gm1'
  );
  assert.equal(res.status, 'failed');
  assert.ok(res.compensation.includes('currency-refunded'), 'currency refunded');
  assert.equal(actor.wallet, 1000, 'no net debit after compensation');
  const ledger = store._ledgers[0];
  assert.equal(ledger.status, 'failed');
  assert.equal(ledger.compensation.includes('shop-restored'), true, 'the applied shop write was restored');
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory[0].quantity, 10, 'stock restored exactly');
});

test('a ledger commit that applies-then-throws is resolved as committed (no compensation)', async () => {
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 10 })], funds: 0 });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000 });
  const { commerce } = makeHarness({ store, actor, adapter, sharedLock: true });
  store.state.ledgerCommitAppliesThenThrows = true;
  const res = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, requestId: 'atc-1', userId: 'user1' },
    'gm1'
  );
  assert.equal(res.status, 'committed');
  assert.equal(actor.wallet, 800, 'debit kept');
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory[0].quantity, 8, 'stock decremented');
});

test('an advanced-order commit that applies-then-throws is recovered via a re-read (never re-runs)', async () => {
  // A cart checkout commits its order with status 'committed'. If that write
  // applies-then-throws, the service re-reads the record, sees it committed and
  // reports success - it never blindly reverses effects or double-executes.
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 10 })] });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000 });
  const { cart } = makeHarness({ store, actor, adapter, sharedLock: true });
  store.state.orderCommitAppliesThenThrows = true;
  const res = await cart.checkout(
    { shopId: 'shop1', actorId: 'actor1', lines: [{ entryId: 'entry1', quantity: 2 }], requestId: 'at-1' },
    'user1'
  );
  assert.equal(res.status, 'committed');
  assert.equal(actor.wallet, 800, 'debit kept, not refunded');
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory[0].quantity, 8, 'stock decremented once');
  // A replay after an applies-then-throws commit must not re-debit.
  const wallet = actor.wallet;
  const again = await cart.checkout(
    { shopId: 'shop1', actorId: 'actor1', lines: [{ entryId: 'entry1', quantity: 2 }], requestId: 'at-1' },
    'user1'
  );
  assert.equal(again.status, 'replay');
  assert.equal(actor.wallet, wallet, 'no second debit on replay');
});

// ================================================ 7. multi-GM race boundaries

test('two independent GM service instances (separate locks) on the atomic fake store never double-charge', async () => {
  // Two commerce instances with SEPARATE lock maps simulate two GM clients: the
  // per-shop lock does not serialize across clients. The fake store's
  // read-then-create is atomic (no await between the existence scan and the
  // insert), so the losing client observes `created:false` and never charges.
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 10 })] });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000 });
  const base = { store, actor, adapter };
  const commerceA = createCommerce({
    ...base,
    getActor: async () => actor,
    fromUuid: async () => null,
    getAdapter: () => adapter,
    systemId: () => 'dnd5e',
    isGM: () => true,
    actorOwnedBy: () => true,
    logger: { error: () => {} },
    now: () => 1000,
    makeId,
    lockMap: createLockMap(),
  });
  const commerceB = createCommerce({
    ...base,
    getActor: async () => actor,
    fromUuid: async () => null,
    getAdapter: () => adapter,
    systemId: () => 'dnd5e',
    isGM: () => true,
    actorOwnedBy: () => true,
    logger: { error: () => {} },
    now: () => 1000,
    makeId,
    lockMap: createLockMap(),
  });
  const payload = { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, requestId: 'dup', userId: 'user1' };
  const [r1, r2] = await Promise.all([commerceA.purchase(payload, 'gm1'), commerceB.purchase(payload, 'gm1')]);
  const statuses = [r1.status, r2.status];
  assert.ok(statuses.includes('committed'), 'exactly one purchase commits');
  assert.ok(statuses.includes('pending') || statuses.includes('replay'), 'the loser surfaces pending/replay, never double-charging');
  assert.equal(actor.wallet, 900, 'debit applied exactly once');
  const stored = store._shops.get('shop1');
  assert.equal(stored.inventory[0].quantity, 9, 'stock decremented exactly once');
});

test('a gated read/create interleaving reproduces the documented multi-GM non-atomic double-charge deterministically', async () => {
  // Force BOTH clients to observe "no record" before EITHER persists, exactly the
  // JournalEntry read-then-create window. The fake store's atomic-insert model is
  // bypassed with a `beforeCreateLedger` barrier so BOTH `createLedger` calls
  // return `created:true` and BOTH charge: the documented race is reproduced
  // deterministically (not flaky).
  const shop = makeShop({ inventory: [makeEntry({ price: 100, quantity: 10 })] });
  const store = createUnifiedStore({ shops: [shop] });
  const adapter = makeUnifiedAdapter();
  const { actor } = makeActor({ wallet: 1000 });
  const barrier = makeBarrier(2);
  store.hooks.beforeCreateLedger = () => barrier.arrive();

  const base = { store, actor, adapter };
  const mk = () =>
    createCommerce({
      ...base,
      getActor: async () => actor,
      fromUuid: async () => null,
      getAdapter: () => adapter,
      systemId: () => 'dnd5e',
      isGM: () => true,
      actorOwnedBy: () => true,
      logger: { error: () => {} },
      now: () => 1000,
      makeId,
      lockMap: createLockMap(),
    });
  const commerceA = mk();
  const commerceB = mk();
  const payload = { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, requestId: 'race', userId: 'user1' };
  const [r1, r2] = await Promise.all([commerceA.purchase(payload, 'gm1'), commerceB.purchase(payload, 'gm1')]);
  assert.equal(r1.status, 'committed');
  assert.equal(r2.status, 'committed');
  // Both charged -> the exact multi-GM window the docs warn about.
  assert.equal(actor.wallet, 800, 'BOTH request ids charged (double debit in the race window)');
  assert.ok(store._ledgers.filter((r) => r.key === 'user1:race').length >= 2, 'two ledger records persisted for the same key');
});
