// Unit tests for the M3 GM reputation persistence (store) and the manual
// GM mutation service.
//
// These tests drive the real store/social-service logic against an in-memory
// document store (no Foundry globals), plus one test that exercises the real
// default singleton's GM-only journal creation against a stubbed `game`.
//
// They cover: record privacy (GM-only JournalEntries), invalid id rejection,
// score clamping, independent actor/party scoring, event/history list ordering,
// idempotent duplicate-request handling (replay + conflict), unauthorized
// (non-GM) rejection, update-failure / needsRecovery recovery, and the pending
// replay hardening (score-diverged, no clobber of a newer score, blocking a new
// event on an unresolved one, and a changed reason being a conflict).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStore,
  store as defaultStore,
} from '../src/storage/store.js';
import {
  makeId,
  normalizeReputation,
  normalizeReputationEvent,
  normalizeShop,
  assertSubjectId,
  REPUTATION_KIND,
  REPUTATION_EVENT_KIND,
} from '../src/services/model.js';
import { createReputationService } from '../src/social/service.js';

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
  return createStore(createFakeDocAccess());
}

function makeService(store, opts = {}) {
  return createReputationService({
    store,
    runShopExclusive: opts.runShopExclusive || ((shopId, fn) => fn()),
    isGM: opts.isGM || (() => true),
    now: opts.now || (() => 1000),
    makeId: opts.makeId || makeId,
  });
}

async function createShop(store, social = {}) {
  return store.createShop({ name: 'General Store', locationId: 'loc1', social });
}

// ------------------------------------------------------- record privacy

test('reputation records and events are stored in GM-only journal entries', async () => {
  const created = [];
  const journalDocs = [];
  globalThis.game = {
    journal: {
      // Foundry V14 `JournalEntry.create` is the document class static; the
      // default store's doc access must use it (not the collection `.create`).
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
    const rec = await defaultStore.upsertReputation({
      shopId: 'shop1',
      scope: 'actor',
      subjectId: 'Actor.abc',
      score: 20,
    });
    assert.ok(rec.id, 'record persisted');

    const result = await defaultStore.createReputationEvent({
      key: 'gm1:req1',
      shopId: 'shop1',
      scope: 'actor',
      subjectId: 'Actor.abc',
      previous: 0,
      delta: 20,
      next: 20,
      source: 'gm',
    });
    assert.equal(result.created, true);
    assert.ok(result.record.id, 'event persisted');

    assert.equal(created.length, 2, 'one journal for the record, one for the event');
    assert.ok(
      created.every((c) => c.ownership && c.ownership.default === 0),
      'every reputation journal is created explicitly GM-only'
    );
  } finally {
    delete globalThis.game;
  }
});

// ------------------------------------------------------------ store records

test('upsertReputation creates then updates in place, preserving the id', async () => {
  const store = createTestStore();
  assert.equal(await store.getReputation('shop1', 'actor', 'Actor.abc'), null);

  const created = await store.upsertReputation({
    shopId: 'shop1',
    scope: 'actor',
    subjectId: 'Actor.abc',
    score: 20,
  });
  assert.ok(created.id);
  assert.equal(created.score, 20);
  assert.equal(created.scope, 'actor');
  assert.equal(created.subjectId, 'Actor.abc');

  const read = await store.getReputation('shop1', 'actor', 'Actor.abc');
  assert.equal(read.id, created.id);
  assert.equal(read.score, 20);

  const updated = await store.upsertReputation({
    shopId: 'shop1',
    scope: 'actor',
    subjectId: 'Actor.abc',
    score: 35,
    updatedAt: 99,
  });
  assert.equal(updated.id, created.id, 'same persistent id on update');
  assert.equal(updated.score, 35);
  assert.equal(updated.updatedAt, 99);

  // getReputation should resolve to exactly one record for the triple.
  assert.deepEqual(await store.getReputation('shop1', 'actor', 'Actor.abc'), updated);
  // A different subject is independent.
  assert.equal(await store.getReputation('shop1', 'actor', 'Actor.xyz'), null);
});

test('record score is clamped into [-100, 100]', () => {
  assert.equal(normalizeReputation({ shopId: 's', scope: 'actor', subjectId: 'Actor.a', score: 150 }).score, 100);
  assert.equal(normalizeReputation({ shopId: 's', scope: 'actor', subjectId: 'Actor.a', score: -200 }).score, -100);
  assert.equal(normalizeReputation({ shopId: 's', scope: 'actor', subjectId: 'Actor.a', score: 25 }).score, 25);
});

test('store rejects invalid shop/subject ids', async () => {
  const store = createTestStore();
  await assert.rejects(
    () => store.upsertReputation({ shopId: '', scope: 'actor', subjectId: 'Actor.a' }),
    /shopId.*must not be empty/
  );
  await assert.rejects(
    () => store.upsertReputation({ shopId: 's', scope: 'actor', subjectId: '' }),
    /subjectId.*must not be empty/
  );
  // Actor subject ids must be a world Actor UUID.
  await assert.rejects(
    () => store.upsertReputation({ shopId: 's', scope: 'actor', subjectId: 'not-an-actor' }),
    /Actor\\./
  );
  // Party/faction ids must be safe slug chars, no path separators.
  await assert.rejects(
    () => store.upsertReputation({ shopId: 's', scope: 'party', subjectId: 'party/one' }),
    /safe id/
  );
  assert.equal(assertSubjectId('party', 'party_one-2'), 'party_one-2');
});

test('records for different entities are independent', async () => {
  const store = createTestStore();
  await store.upsertReputation({ shopId: 's', scope: 'actor', subjectId: 'Actor.a', score: 20 });
  await store.upsertReputation({ shopId: 's', scope: 'actor', subjectId: 'Actor.b', score: -5 });
  await store.upsertReputation({ shopId: 's', scope: 'party', subjectId: 'party1', score: 40 });

  assert.equal((await store.getReputation('s', 'actor', 'Actor.a')).score, 20);
  assert.equal((await store.getReputation('s', 'actor', 'Actor.b')).score, -5);
  assert.equal((await store.getReputation('s', 'party', 'party1')).score, 40);
  // Different shop scope is independent too.
  assert.equal(await store.getReputation('other', 'actor', 'Actor.a'), null);
});

// ------------------------------------------------------------- store events

test('store creates/finds/updates reputation events and lists latest first', async () => {
  const store = createTestStore();
  const first = await store.createReputationEvent({
    key: 'gm1:req1',
    shopId: 'shop1',
    scope: 'actor',
    subjectId: 'Actor.a',
    previous: 0,
    delta: 10,
    next: 10,
    source: 'gm',
    createdAt: 100,
  });
  assert.equal(first.created, true);

  const second = await store.createReputationEvent({
    key: 'gm1:req2',
    shopId: 'shop1',
    scope: 'actor',
    subjectId: 'Actor.a',
    previous: 10,
    delta: -5,
    next: 5,
    source: 'gm',
    createdAt: 200,
  });
  assert.equal(second.created, true);

  // Same key returns the existing record, never a second JournalEntry.
  const again = await store.createReputationEvent({
    key: 'gm1:req1',
    shopId: 'shop1',
    scope: 'actor',
    subjectId: 'Actor.a',
    previous: 0,
    delta: 10,
    next: 10,
    source: 'gm',
  });
  assert.equal(again.created, false);
  assert.equal(again.record.id, first.record.id);

  assert.equal((await store.findReputationEventByKey('gm1:req1')).id, first.record.id);
  assert.equal(await store.findReputationEventByKey('gm1:nope'), null);

  const updated = await store.updateReputationEvent(first.record.id, { status: 'committed' });
  assert.equal(updated.status, 'committed');

  const list = await store.listReputationEvents({ shopId: 'shop1' });
  assert.equal(list.length, 2);
  // Latest first by createdAt.
  assert.ok(list[0].createdAt >= list[1].createdAt);
  assert.ok(!('gm1:req2' === list[0].key && 'gm1:req1' === list[1].key) || list[0].createdAt > list[1].createdAt);

  const filtered = await store.listReputationEvents({ shopId: 'shop1', subjectId: 'Actor.a' });
  assert.equal(filtered.length, 2);
  const none = await store.listReputationEvents({ shopId: 'shop1', subjectId: 'Actor.zzz' });
  assert.equal(none.length, 0);
});

test('event normalization validates source/scope/key and caps reason', () => {
  assert.throws(
    () => normalizeReputationEvent({ key: '', shopId: 's', scope: 'actor', subjectId: 'Actor.a' }),
    /key/
  );
  assert.throws(
    () => normalizeReputationEvent({ key: 'k', shopId: 's', scope: 'actor', subjectId: 'Actor.a', source: 'bogus' }),
    /source/
  );
  assert.throws(
    () => normalizeReputationEvent({ key: 'k', shopId: 's', scope: 'bad', subjectId: 'Actor.a' }),
    /scope/
  );
  const ev = normalizeReputationEvent({
    key: 'k',
    shopId: 's',
    scope: 'actor',
    subjectId: 'Actor.a',
    previous: 0,
    delta: 5,
    next: 5,
    reason: 'x'.repeat(250),
    source: 'gm',
  });
  assert.equal(ev.reason.length, 200, 'reason capped at 200');
});

// ------------------------------------------------------------- service

test('adjust rejects a non-GM caller before any read/write', async () => {
  const store = createTestStore();
  const shop = await createShop(store);
  const service = makeService(store, { isGM: () => false });
  const result = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 10, requestId: 'r1' },
    'player'
  );
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'not-a-gm');
  assert.equal(await store.getReputation(shop.id, 'actor', 'Actor.a'), null, 'no write happened');
});

test('adjust validates shop existence and params', async () => {
  const store = createTestStore();
  const shop = await createShop(store);
  const service = makeService(store);

  assert.equal((await service.adjust({ shopId: 'missing', scope: 'actor', subjectId: 'Actor.a', delta: 1 }, 'gm1')).error, 'shop-not-found');
  assert.equal((await service.adjust({ shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 1.5 }, 'gm1')).status, 'error');
  assert.equal((await service.adjust({ shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 1, source: 'purchase' }, 'gm1')).status, 'error');
  assert.equal((await service.adjust({ shopId: shop.id, scope: 'actor', subjectId: 'is-a-party', delta: 1 }, 'gm1')).status, 'error');
  assert.equal((await service.adjust({ shopId: shop.id, scope: 'actor', subjectId: 'not-an-actor', delta: 1 }, 'gm1')).status, 'error');
});

test('adjust clamps the score to [-100, 100] and records an event', async () => {
  const store = createTestStore();
  const shop = await createShop(store);
  let clock = 500;
  const service = makeService(store, { now: () => ++clock });

  const r = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 1000, reason: 'heroic', requestId: 'r1' },
    'gm1'
  );
  assert.equal(r.status, 'committed');
  assert.equal(r.record.score, 100);
  assert.equal(r.record.updatedAt, clock);
  assert.equal(r.event.status, 'committed');
  assert.equal(r.event.delta, 1000);
  assert.equal(r.event.next, 100);
  assert.equal(r.event.previous, 0);
  assert.equal(r.event.reason, 'heroic');
  assert.equal(r.event.source, 'gm');

  const neg = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: -1000, requestId: 'r2' },
    'gm1'
  );
  assert.equal(neg.record.score, -100);

  // Event/history is inspectable and latest first.
  const events = await store.listReputationEvents({ shopId: shop.id, subjectId: 'Actor.a' });
  assert.equal(events.length, 2);
  assert.ok(events[0].createdAt > events[1].createdAt);
  assert.equal(events[0].key, 'gm1:r2');
});

test('independent actor and party records adjust separately', async () => {
  const store = createTestStore();
  const shop = await createShop(store);
  const service = makeService(store);

  await service.adjust({ shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 20, requestId: 'a1' }, 'gm1');
  await service.adjust({ shopId: shop.id, scope: 'actor', subjectId: 'Actor.b', delta: 5, requestId: 'b1' }, 'gm1');
  await service.adjust({ shopId: shop.id, scope: 'party', subjectId: 'party1', delta: 40, requestId: 'p1' }, 'gm1');

  assert.equal((await store.getReputation(shop.id, 'actor', 'Actor.a')).score, 20);
  assert.equal((await store.getReputation(shop.id, 'actor', 'Actor.b')).score, 5);
  assert.equal((await store.getReputation(shop.id, 'party', 'party1')).score, 40);
});

test('getEffective uses the individual score alone when there is no party', async () => {
  const store = createTestStore();
  const shop = normalizeShop({ name: 'S', locationId: 'loc1' });
  const service = makeService(store);
  await store.upsertReputation({ shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', score: 20 });
  const eff = await service.getEffective(shop, 'Actor.a');
  assert.equal(eff.score, 20);
  assert.equal(eff.individual, 20);
  assert.equal(eff.party, 0);
  assert.equal(eff.partyId, '');
  assert.equal(eff.band.title, 'Friendly');
});

test('getEffective blends actor + party only when a partyId is set', async () => {
  const store = createTestStore();
  const shop = normalizeShop({
    name: 'S',
    locationId: 'loc1',
    social: { partyId: 'party1' },
  });
  const service = makeService(store);
  await store.upsertReputation({ shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', score: 20 });
  await store.upsertReputation({ shopId: shop.id, scope: 'party', subjectId: 'party1', score: 80 });
  const eff = await service.getEffective(shop, 'Actor.a');
  assert.equal(eff.score, 38, 'round((20*70 + 80*30)/100)');
  assert.equal(eff.individual, 20);
  assert.equal(eff.party, 80);
  assert.equal(eff.partyId, 'party1');
});

// ------------------------------------------------------ idempotency/recovery

test('duplicate request replays the committed event without reapplying the delta', async () => {
  const store = createTestStore();
  const shop = await createShop(store);
  const service = makeService(store);

  const first = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 5, requestId: 'dup' },
    'gm1'
  );
  assert.equal(first.status, 'committed');
  assert.equal(first.record.score, 5);

  const second = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 5, requestId: 'dup' },
    'gm1'
  );
  assert.equal(second.status, 'replay');
  assert.equal(second.record.score, 5, 'score not reapplied');
  assert.equal(second.event.status, 'committed');

  const events = await store.listReputationEvents({ shopId: shop.id, subjectId: 'Actor.a' });
  assert.equal(events.length, 1, 'only one event for the key');
});

test('same requestId for a different subject rejects as a conflict', async () => {
  const store = createTestStore();
  const shop = await createShop(store);
  const service = makeService(store);

  await service.adjust({ shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 5, requestId: 'shared' }, 'gm1');
  const conflict = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.b', delta: -3, requestId: 'shared' },
    'gm1'
  );
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.error, 'conflicting duplicate request');
  assert.equal(conflict.existing.subjectId, 'Actor.a');
  assert.equal(await store.getReputation(shop.id, 'actor', 'Actor.b'), null, 'conflict never applies');
});

test('update failure marks the event needsRecovery and a retry resumes without re-applying', async () => {
  const store = createTestStore();
  const shop = await createShop(store);
  const service = makeService(store);

  const originalUpsert = store.upsertReputation.bind(store);
  let fail = true;
  store.upsertReputation = (...args) => {
    if (fail) throw new Error('disk full');
    return originalUpsert(...args);
  };
  store.updateReputationEvent = store.updateReputationEvent.bind(store);

  const r = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 10, requestId: 'rec' },
    'gm1'
  );
  assert.equal(r.status, 'needsRecovery');
  assert.match(r.error, /record-update-failed/);
  const ev = await store.findReputationEventByKey('gm1:rec');
  assert.equal(ev.status, 'needsRecovery');
  assert.equal((await store.getReputation(shop.id, 'actor', 'Actor.a'))?.score, undefined, 'score not applied');

  // Retry after the store recovers; the pending event resumes and commits.
  fail = false;
  const retry = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 10, requestId: 'rec' },
    'gm1'
  );
  assert.equal(retry.status, 'committed');
  assert.equal(retry.record.score, 10, 'delta applied exactly once, not re-added');
  const evAfter = await store.findReputationEventByKey('gm1:rec');
  assert.equal(evAfter.status, 'committed');
  const events = await store.listReputationEvents({ shopId: shop.id, subjectId: 'Actor.a' });
  assert.equal(events.length, 1, 'retry did not create a second event');
});

test('commit failure returns needsRecovery with the event still pending; retry finalizes without re-applying', async () => {
  const store = createTestStore();
  const shop = await createShop(store);
  const service = makeService(store);

  const originalUpdateEvent = store.updateReputationEvent.bind(store);
  let failCommit = true;
  store.updateReputationEvent = (id, patch) => {
    if (patch.status === 'committed' && failCommit) throw new Error('commit write failed');
    return originalUpdateEvent(id, patch);
  };

  const r = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 10, requestId: 'cf' },
    'gm1'
  );
  assert.equal(r.status, 'needsRecovery');
  assert.match(r.error, /event-commit-failed/);
  // The score WAS applied; the event is still pending.
  assert.equal(r.record.score, 10);
  const ev = await store.findReputationEventByKey('gm1:cf');
  assert.equal(ev.status, 'pending');

  failCommit = false;
  const retry = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 10, requestId: 'cf' },
    'gm1'
  );
  assert.equal(retry.status, 'replay');
  assert.equal(retry.record.score, 10, 'delta not reapplied on retry');
  assert.equal(retry.event.status, 'committed');
});

// ------------------------------------------------ pending replay hardening

test('pending replay returns score-diverged when the score moved to an unrelated value', async () => {
  const store = createTestStore();
  const shop = await createShop(store);
  const service = makeService(store);

  // Seed a pending event whose delta was never applied (previous=0, next=5).
  await store.createReputationEvent({
    key: 'gm1:req1',
    shopId: shop.id,
    scope: 'actor',
    subjectId: 'Actor.a',
    previous: 0,
    delta: 5,
    next: 5,
    reason: '',
    source: 'gm',
    status: 'pending',
    createdAt: 1000,
  });
  // An intervening (out-of-band) write moved the score somewhere unrelated.
  await store.upsertReputation({
    shopId: shop.id,
    scope: 'actor',
    subjectId: 'Actor.a',
    score: 8,
    updatedAt: 1001,
  });

  const r = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 5, requestId: 'req1' },
    'gm1'
  );
  assert.equal(r.status, 'needsRecovery');
  assert.equal(r.error, 'score-diverged');
  assert.equal(r.record.score, 8, 'current record returned unreconciled');
  assert.equal(
    (await store.getReputation(shop.id, 'actor', 'Actor.a')).score,
    8,
    'the intervening score is not clobbered'
  );
  // The event stays unresolved for manual reconciliation.
  const ev = await store.findReputationEventByKey('gm1:req1');
  assert.equal(ev.status, 'pending');
});

test('pending replay does not clobber a later committed event (score preserved)', async () => {
  const store = createTestStore();
  const shop = await createShop(store);
  const service = makeService(store);

  // Seed a pending event whose delta was never applied (previous=0, next=5) at t=1000.
  await store.createReputationEvent({
    key: 'gm1:req4',
    shopId: shop.id,
    scope: 'actor',
    subjectId: 'Actor.a',
    previous: 0,
    delta: 5,
    next: 5,
    reason: '',
    source: 'gm',
    status: 'pending',
    createdAt: 1000,
  });
  // A LATER committed event now governs this triple; the score still reads 0
  // (which equals the pending event's `previous`).
  await store.createReputationEvent({
    key: 'gm1:later',
    shopId: shop.id,
    scope: 'actor',
    subjectId: 'Actor.a',
    previous: 0,
    delta: 0,
    next: 0,
    reason: '',
    source: 'gm',
    status: 'committed',
    createdAt: 2000,
  });
  await store.upsertReputation({
    shopId: shop.id,
    scope: 'actor',
    subjectId: 'Actor.a',
    score: 0,
    updatedAt: 2001,
  });

  // Replaying the pending event must NOT apply next (5): the later committed
  // event already owns this triple, so it reports score-diverged and leaves the
  // score at 0 instead of clobbering it to 5.
  const r = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 5, requestId: 'req4' },
    'gm1'
  );
  assert.equal(r.status, 'needsRecovery');
  assert.equal(r.error, 'score-diverged');
  assert.equal(
    (await store.getReputation(shop.id, 'actor', 'Actor.a')).score,
    0,
    'later committed score not clobbered'
  );
});

test('adjust refuses to stack a new event while an unresolved event exists for the subject', async () => {
  const store = createTestStore();
  const shop = await createShop(store);
  const service = makeService(store);

  // Force the record update to fail so the first event is left needsRecovery.
  const originalUpsert = store.upsertReputation.bind(store);
  let fail = true;
  store.upsertReputation = (...args) => {
    if (fail) throw new Error('disk full');
    return originalUpsert(...args);
  };

  const first = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 10, requestId: 'a' },
    'gm1'
  );
  assert.equal(first.status, 'needsRecovery');
  const unresolved = await store.findReputationEventByKey('gm1:a');
  assert.equal(unresolved.status, 'needsRecovery');

  // A different requestId for the SAME subject must be refused, not stacked.
  const second = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 5, requestId: 'b' },
    'gm1'
  );
  assert.equal(second.status, 'needsRecovery');
  assert.equal(second.error, 'unresolved-reputation-event');
  assert.equal(second.event.id, unresolved.id, 'the blocking event is surfaced');
  assert.equal(await store.findReputationEventByKey('gm1:b'), null, 'no event for b yet');
  assert.equal(
    await store.getReputation(shop.id, 'actor', 'Actor.a'),
    null,
    'blocked mutation never applied a score'
  );

  // Resolving the unresolved event unblocks the second request.
  fail = false;
  const retryA = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 10, requestId: 'a' },
    'gm1'
  );
  assert.equal(retryA.status, 'committed');
  const retryB = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 5, requestId: 'b' },
    'gm1'
  );
  assert.equal(retryB.status, 'committed');
  assert.equal((await store.getReputation(shop.id, 'actor', 'Actor.a')).score, 15);
});

test('same requestId with a different reason is a conflict', async () => {
  const store = createTestStore();
  const shop = await createShop(store);
  const service = makeService(store);

  const first = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 5, reason: 'first', requestId: 'reasoned' },
    'gm1'
  );
  assert.equal(first.status, 'committed');
  assert.equal(first.event.reason, 'first');

  const r = await service.adjust(
    { shopId: shop.id, scope: 'actor', subjectId: 'Actor.a', delta: 5, reason: 'second', requestId: 'reasoned' },
    'gm1'
  );
  assert.equal(r.status, 'conflict');
  assert.equal(r.error, 'conflicting duplicate request');
  assert.equal(r.existing.reason, 'first');
  assert.equal(r.existing.subjectId, 'Actor.a');
  assert.equal(
    (await store.getReputation(shop.id, 'actor', 'Actor.a')).score,
    5,
    'changed reason never re-applies the delta'
  );
});
