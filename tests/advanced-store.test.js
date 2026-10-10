// Unit tests for the M5 GM-private advanced-commerce order record store.
//
// These tests drive the real store logic against an in-memory document store (no
// Foundry globals), plus one test that exercises the real default singleton's
// GM-only journal creation against a stubbed `game`. They cover: GM-only
// JournalEntry privacy and the no-schema-bump guarantee, the order being stored
// in its OWN journal (never embedded in the shop record), idempotent create on
// the key, updates (mutable fields apply, immutable fields are preserved, a
// missing id returns null), strict normalization (unknown kind/status/phase,
// bad ids, quantity/total bounds, intentHash bounds, plain-bounded details/
// outcome, error cap), safe newest-first ordering + filtering + 100-record cap +
// optional paging, world-actor-id acceptance for actorId, and the immutable-field
// contract on update.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStore,
  store as defaultStore,
} from '../src/storage/store.js';
import {
  makeId,
  normalizeAdvancedOrder,
  ADVANCED_ORDER_KIND,
  ADVANCED_ORDER_KINDS,
  ADVANCED_ORDER_STATUSES,
  ADVANCED_ORDER_PHASES,
  ADVANCED_ORDER_DETAILS_MAX,
  ADVANCED_ORDER_OUTCOME_MAX,
  ADVANCED_ORDER_ERROR_MAX,
  SCHEMA_VERSION,
} from '../src/services/model.js';

// ---------------------------------------------------------------- helpers

function createFakeDocAccess() {
  const docs = new Map();
  let seq = 0;
  return {
    docs,
    async listJournalEntries() {
      return Array.from(docs.values());
    },
    async getJournalEntry(id) {
      return docs.get(id) || null;
    },
    async createJournalEntry({ name, flags }) {
      const id = `journal-${++seq}`;
      const doc = { id, name, flags };
      docs.set(id, doc);
      return doc;
    },
    async updateJournalEntry(doc, patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'flags') doc.flags = { ...doc.flags, ...value };
        else doc[key] = value;
      }
      return doc;
    },
  };
}

function createTestStore() {
  const access = createFakeDocAccess();
  const store = createStore(access);
  return { store, access };
}

function makeOrder(overrides = {}) {
  return {
    key: 'gm1:req1',
    kind: 'service',
    status: 'pending',
    phase: 'recorded',
    shopId: 'shop1',
    userId: 'user1',
    actorId: 'Actor.abc',
    entryId: 'entry1',
    relatedOrderId: '',
    quantity: 1,
    total: 100,
    deposit: 0,
    remaining: 100,
    createdAt: 100,
    updatedAt: 100,
    intentHash: 'shorthash',
    details: { note: 'book' },
    outcome: { ok: true },
    ...overrides,
  };
}

// ------------------------------------------------------- record privacy

test('advanced orders are stored in their own GM-only JournalEntries with no schema bump', async () => {
  const created = [];
  const journalDocs = [];
  globalThis.game = {
    journal: {
      documentClass: {
        create: async (data) => {
          const doc = { id: makeId(), ...data };
          journalDocs.push(doc);
          created.push(data);
          return doc;
        },
      },
      filter: () => journalDocs,
      get: (id) => journalDocs.find((d) => d.id === id) || null,
    },
  };
  try {
    const result = await defaultStore.createAdvancedOrder(makeOrder());
    const rec = result.record;
    assert.ok(rec.id, 'order persisted');
    assert.equal(rec.kind, 'service');

    assert.equal(created.length, 1, 'one journal for the order');
    assert.equal(
      created[0].ownership.default,
      0,
      'the journal is created explicitly GM-only'
    );
    assert.equal(
      created[0].flags.market.schemaVersion,
      SCHEMA_VERSION,
      'no schema version bump'
    );
    assert.equal(created[0].flags.market.kind, ADVANCED_ORDER_KIND);
    assert.equal(created[0].flags.market.record.id, rec.id);
    // The order is never embedded in a shop record: it is a standalone journal.
    assert.equal(created[0].flags.market.record.orders === undefined, true);
  } finally {
    delete globalThis.game;
  }
});

test('an advanced order is stored in its own journal, never embedded in the shop', async () => {
  const { store, access } = createTestStore();
  const shop = await store.createShop({ name: 'General Store', locationId: 'loc1' });
  await store.createAdvancedOrder(makeOrder({ shopId: shop.id }));

  const docs = Array.from(access.docs.values());
  const shopDoc = docs.find((d) => d.flags?.market?.kind === 'shop');
  const orderDoc = docs.find((d) => d.flags?.market?.kind === ADVANCED_ORDER_KIND);
  assert.ok(shopDoc, 'shop journal exists');
  assert.ok(orderDoc, 'order journal exists separately');
  assert.equal(orderDoc.name, `Advanced Order: gm1:req1`);
  assert.equal(shopDoc.flags.market.record.orders === undefined, true);
  assert.equal(shopDoc.flags.market.record.inventory.length, 0);
  assert.equal(orderDoc.flags.market.record.id, (await store.findAdvancedOrderByKey('gm1:req1')).id);
  // The shop record was not mutated by the order write.
  assert.deepEqual((await store.findShop(shop.id)).inventory, []);
});

// ------------------------------------------------------------ store records

test('store creates and finds advanced orders by key and id', async () => {
  const { store } = createTestStore();
  const created = await store.createAdvancedOrder(makeOrder());
  assert.equal(created.created, true);

  const byKey = await store.findAdvancedOrderByKey('gm1:req1');
  assert.equal(byKey.id, created.record.id);
  const byId = await store.findAdvancedOrder(created.record.id);
  assert.equal(byId.id, created.record.id);
  assert.equal(await store.findAdvancedOrder('nope'), null);
  assert.equal(await store.findAdvancedOrderByKey('nope'), null);
});

test('createAdvancedOrder is idempotent on the key and never creates a second journal', async () => {
  const { store, access } = createTestStore();
  const first = await store.createAdvancedOrder(makeOrder());
  assert.equal(first.created, true);

  const again = await store.createAdvancedOrder(makeOrder());
  assert.equal(again.created, false, 'same key returns existing order');
  assert.equal(again.record.id, first.record.id, 'same persisted order returned');

  const orderDocs = Array.from(access.docs.values()).filter(
    (d) => d.flags?.market?.kind === ADVANCED_ORDER_KIND
  );
  assert.equal(orderDocs.length, 1, 'exactly one journal for the key');
});

// --------------------------------------------------------------- updates

test('updateAdvancedOrder applies mutable fields, preserves immutable fields, and null on missing', async () => {
  const { store } = createTestStore();
  const created = await store.createAdvancedOrder(makeOrder());
  const id = created.record.id;

  const updated = await store.updateAdvancedOrder(id, {
    kind: 'cart',
    status: 'committed',
    phase: 'final',
    quantity: 3,
    total: 300,
    deposit: 50,
    remaining: 250,
    error: 'noted',
    updatedAt: 999,
  });
  assert.equal(updated.id, id);
  assert.equal(updated.status, 'committed', 'status is mutable');
  assert.equal(updated.phase, 'final', 'phase is mutable');
  assert.equal(updated.quantity, 3, 'quantity is mutable');
  assert.equal(updated.total, 300, 'total is mutable');
  assert.equal(updated.deposit, 50, 'deposit is mutable');
  assert.equal(updated.remaining, 250, 'remaining is mutable');
  assert.equal(updated.error, 'noted', 'error is mutable');
  assert.equal(updated.updatedAt, 999, 'updatedAt is mutable');
  // Immutable fields are forced back to the persisted values.
  assert.equal(updated.key, 'gm1:req1', 'key immutable');
  assert.equal(updated.kind, 'service', 'kind immutable');
  assert.equal(updated.shopId, 'shop1', 'shopId immutable');
  assert.equal(updated.userId, 'user1', 'userId immutable');
  assert.equal(updated.actorId, 'Actor.abc', 'actorId immutable');
  assert.equal(updated.intentHash, 'shorthash', 'intentHash immutable');
  assert.equal(updated.createdAt, created.record.createdAt, 'createdAt immutable');
  assert.equal(updated.id, id, 'id immutable');

  assert.equal(
    await store.updateAdvancedOrder('not-an-id', { status: 'committed' }),
    null,
    'a missing order returns null'
  );
});

// -------------------------------------------------------------- validation

test('normalize rejects an unknown kind/status/phase', () => {
  assert.throws(() => normalizeAdvancedOrder(makeOrder({ kind: 'bogus' })), /kind/);
  assert.throws(() => normalizeAdvancedOrder(makeOrder({ status: 'bogus' })), /status/);
  assert.throws(() => normalizeAdvancedOrder(makeOrder({ phase: 'bogus' })), /phase/);
});

test('every documented kind/status/phase is accepted', () => {
  for (const kind of ADVANCED_ORDER_KINDS) {
    assert.equal(normalizeAdvancedOrder(makeOrder({ kind })).kind, kind);
  }
  for (const status of ADVANCED_ORDER_STATUSES) {
    assert.equal(normalizeAdvancedOrder(makeOrder({ status })).status, status);
  }
  for (const phase of ADVANCED_ORDER_PHASES) {
    assert.equal(normalizeAdvancedOrder(makeOrder({ phase })).phase, phase);
  }
});

test('the barter checkout phase persists as a recognized advancedOrder phase', () => {
  // A real store rejects an unknown phase, so barter checkout previously never
  // persisted its `bartered` marker (it was silently swallowed as uncertain).
  // 'bartered' is now a documented phase and must normalize cleanly.
  const order = normalizeAdvancedOrder(makeOrder({ phase: 'bartered' }));
  assert.equal(order.phase, 'bartered');
});

test('normalize rejects invalid order/actor/shop/user ids', () => {
  assert.throws(() => normalizeAdvancedOrder(makeOrder({ shopId: '' })), /shopId/);
  assert.throws(
    () => normalizeAdvancedOrder(makeOrder({ shopId: 'x'.repeat(121) })),
    /shopId.*at most 120/
  );
  assert.throws(
    () => normalizeAdvancedOrder(makeOrder({ userId: 'x'.repeat(121) })),
    /userId.*at most 120/
  );
  assert.throws(
    () => normalizeAdvancedOrder(makeOrder({ actorId: 'bad\x01id' })),
    /control/
  );
  assert.throws(
    () => normalizeAdvancedOrder(makeOrder({ entryId: '\x7fid' })),
    /control/
  );
  // Optional ids collapse to '' when absent/empty.
  const n = normalizeAdvancedOrder(
    makeOrder({ userId: '', actorId: undefined, entryId: '', relatedOrderId: null })
  );
  assert.equal(n.userId, '');
  assert.equal(n.actorId, '');
  assert.equal(n.entryId, '');
  assert.equal(n.relatedOrderId, '');
});

test('actorId accepts a world actor id that is not a Foundry Actor UUID', () => {
  const normalized = normalizeAdvancedOrder(makeOrder({ actorId: 'archmage-vhal' }));
  assert.equal(normalized.actorId, 'archmage-vhal');
});

test('normalize requires quantity >= 1 and non-negative totals', () => {
  assert.throws(() => normalizeAdvancedOrder(makeOrder({ quantity: 0 })), /quantity/);
  assert.throws(() => normalizeAdvancedOrder(makeOrder({ quantity: 1.5 })), /quantity/);
  assert.throws(() => normalizeAdvancedOrder(makeOrder({ total: -1 })), /total/);
  assert.throws(() => normalizeAdvancedOrder(makeOrder({ deposit: -1 })), /deposit/);
  assert.throws(() => normalizeAdvancedOrder(makeOrder({ remaining: -1 })), /remaining/);
  const n = normalizeAdvancedOrder(
    makeOrder({ quantity: 1, total: 0, deposit: 0, remaining: 0 })
  );
  assert.equal(n.quantity, 1);
  assert.equal(n.total, 0);
});

test('intentHash must be non-empty and at most 256 chars', () => {
  assert.throws(() => normalizeAdvancedOrder(makeOrder({ intentHash: '' })), /intentHash/);
  assert.throws(
    () => normalizeAdvancedOrder(makeOrder({ intentHash: 'x'.repeat(257) })),
    /intentHash/
  );
  assert.equal(
    normalizeAdvancedOrder(makeOrder({ intentHash: 'x'.repeat(256) })).intentHash.length,
    256
  );
});

test('details/outcome must be plain JSON (no functions or custom prototypes)', () => {
  assert.throws(
    () => normalizeAdvancedOrder(makeOrder({ details: { fn: () => {} } })),
    /function/
  );
  assert.throws(
    () => normalizeAdvancedOrder(makeOrder({ details: new Date() })),
    /plain JSON/
  );
  assert.throws(
    () => normalizeAdvancedOrder(makeOrder({ outcome: { n: NaN } })),
    /non-finite/
  );
  assert.throws(
    () => normalizeAdvancedOrder(makeOrder({ details: { n: Symbol('x') } })),
    /Symbol/
  );
  // Nested arrays, primitives and nulls are fine; a dangerous `__proto__` key is
  // kept as an own property (not leaked onto the prototype chain).
  const details = { list: [1, 'a', true, null] };
  Object.defineProperty(details, '__proto__', {
    value: { nested: 1 },
    enumerable: true,
  });
  const normalized = normalizeAdvancedOrder(
    makeOrder({ details, outcome: { o: 1 } })
  );
  assert.deepEqual(normalized.details.list, [1, 'a', true, null]);
  assert.equal(normalized.details.__proto__.nested, 1, '__proto__ stays an own property');
  assert.deepEqual(normalized.outcome, { o: 1 });
});

test('details/outcome are bounded and throw when oversized', () => {
  assert.throws(
    () => normalizeAdvancedOrder(makeOrder({ details: { blob: 'x'.repeat(ADVANCED_ORDER_DETAILS_MAX) } })),
    /details.*at most/
  );
  assert.throws(
    () => normalizeAdvancedOrder(makeOrder({ outcome: { blob: 'x'.repeat(ADVANCED_ORDER_OUTCOME_MAX) } })),
    /outcome.*at most/
  );
  // A value within the serialized-JSON cap is accepted (JSON overhead excluded).
  const ok = normalizeAdvancedOrder(
    makeOrder({ details: { blob: 'x'.repeat(ADVANCED_ORDER_DETAILS_MAX - 12) } })
  );
  assert.equal(ok.details.blob.length, ADVANCED_ORDER_DETAILS_MAX - 12);
  const okOutcome = normalizeAdvancedOrder(
    makeOrder({ outcome: { blob: 'x'.repeat(ADVANCED_ORDER_OUTCOME_MAX - 12) } })
  );
  assert.equal(okOutcome.outcome.blob.length, ADVANCED_ORDER_OUTCOME_MAX - 12);
});

test('error is capped at 200 chars', () => {
  const normalized = normalizeAdvancedOrder(makeOrder({ error: 'x'.repeat(300) }));
  assert.equal(normalized.error.length, ADVANCED_ORDER_ERROR_MAX);
});

// ---------------------------------------------------- ordering & filtering

test('listAdvancedOrders sorts newest first and filters safely', async () => {
  const { store } = createTestStore();
  await store.createAdvancedOrder(makeOrder({ key: 'k1', shopId: 'shop1', kind: 'service', status: 'pending', actorId: 'Actor.a', createdAt: 100 }));
  await store.createAdvancedOrder(makeOrder({ key: 'k2', shopId: 'shop1', kind: 'preorder', status: 'committed', actorId: 'Actor.b', createdAt: 200 }));
  await store.createAdvancedOrder(makeOrder({ key: 'k3', shopId: 'shop2', kind: 'special', status: 'pending', actorId: 'Actor.a', createdAt: 300 }));

  const all = await store.listAdvancedOrders();
  assert.equal(all.length, 3);
  assert.equal(all[0].createdAt, 300, 'newest first');
  assert.equal(all[1].createdAt, 200);
  assert.equal(all[2].createdAt, 100);

  assert.equal((await store.listAdvancedOrders({ shopId: 'shop1' })).length, 2);
  assert.equal((await store.listAdvancedOrders({ actorId: 'Actor.a' })).length, 2);
  assert.equal((await store.listAdvancedOrders({ status: 'pending' })).length, 2);
  assert.equal((await store.listAdvancedOrders({ kind: 'preorder' })).length, 1);
  assert.equal((await store.listAdvancedOrders({ shopId: 'shop1', kind: 'preorder' })).length, 1);
  assert.equal((await store.listAdvancedOrders({ shopId: 'nope' })).length, 0);
  assert.equal((await store.listAdvancedOrders({ kind: 'preorder-fulfill' })).length, 0);
});

test('listAdvancedOrders is capped at 100 and supports offset/limit paging', async () => {
  const { store } = createTestStore();
  for (let i = 0; i < 110; i++) {
    await store.createAdvancedOrder(makeOrder({ key: `key-${i}`, createdAt: i }));
  }
  const capped = await store.listAdvancedOrders();
  assert.equal(capped.length, 100, 'default capped at 100');

  const p1 = await store.listAdvancedOrders({ limit: 25, offset: 0 });
  assert.equal(p1.length, 25);
  const p2 = await store.listAdvancedOrders({ limit: 25, offset: 25 });
  assert.equal(p2.length, 25);
  assert.equal(p1[0].createdAt, 109, 'page starts at exported newest');
  assert.equal(p2[0].createdAt, 84, 'second page continues in order');

  const clamped = await store.listAdvancedOrders({ limit: 500 });
  assert.equal(clamped.length, 100, 'limit is clamped to the 100 cap');

  const last = await store.listAdvancedOrders({ limit: 50, offset: 100 });
  assert.equal(last.length, 10, 'a partial page at the tail');
  const past = await store.listAdvancedOrders({ limit: 50, offset: 200 });
  assert.equal(past.length, 0, 'offset past the end is empty');
});

// ---------------------------------------------------- immutable contract

test('updateAdvancedOrder preserves key/kind/shopId/actorId/userId/intentHash/createdAt', async () => {
  const { store } = createTestStore();
  const created = await store.createAdvancedOrder(
    makeOrder({ key: 'immutable-key', shopId: 's', actorId: 'Actor.z', userId: 'u', intentHash: 'hash1', createdAt: 500 })
  );
  const updated = await store.updateAdvancedOrder(created.record.id, {
    key: 'changed',
    kind: 'theft',
    shopId: 'other',
    actorId: 'Actor.w',
    userId: 'v',
    intentHash: 'hash2',
    createdAt: 999,
    status: 'fulfilled',
  });
  assert.equal(updated.key, 'immutable-key');
  assert.equal(updated.kind, 'service');
  assert.equal(updated.shopId, 's');
  assert.equal(updated.actorId, 'Actor.z');
  assert.equal(updated.userId, 'u');
  assert.equal(updated.intentHash, 'hash1');
  assert.equal(updated.createdAt, 500);
  assert.equal(updated.status, 'fulfilled', 'a mutable field still changed');
});
