// Unit tests for the GM-only portable backup export/import service
// (`src/storage/backup.js`). These tests drive the real store logic against an
// in-memory document store (no Foundry globals) and exercise the GM gate, the
// export/import roundtrip, dry-run planning (no writes), invalid-input
// rejection with zero writes, collision-safe id remapping, the sequential
// createLocations-then-createShops ordering, partial-failure reporting up to a
// store write, GM-handover interruption, and the GM-private export that never
// leaks operational runtime records (ledger/reputation/advanced orders).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/storage/store.js';
import { createBackupService } from '../src/storage/backup.js';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  MAX_BACKUP_BYTES,
} from '../src/storage/backup-format.js';
import { makeId } from '../src/services/model.js';

// ---------------------------------------------------------------- helpers

function loc({ id, name = 'Town', createdAt = 1 } = {}) {
  return { id, name, description: '', theme: '', createdAt };
}

function shop({
  id,
  name = 'General Store',
  locationId = 'L1',
  npcs = [],
  inventory = [],
  commerce = {},
  automation = {},
  createdAt = 1,
} = {}) {
  return {
    id,
    name,
    locationId,
    description: '',
    theme: '',
    owner: '',
    open: true,
    npcs,
    inventory,
    commerce,
    automation,
    createdAt,
  };
}

function entry({
  id = 'e1',
  name = 'Potion',
  price = 10,
  quantity = 5,
  itemUuid = 'Actor.potion',
  snapshot = '',
  access = {},
} = {}) {
  return {
    id,
    itemUuid,
    snapshot,
    name,
    img: '',
    quantity,
    stockMode: 'finite',
    price,
    visible: true,
    access,
  };
}

function rawV1({ locations = [], shops = [] } = {}) {
  return { format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, locations, shops };
}

function createFakeDocAccess() {
  const docs = new Map();
  let seq = 0;
  return {
    docs,
    async listJournalEntries() {
      return [...docs.values()];
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

function makeBackupService({ gmActive = true, isActiveGM: gmFn, logger, makeId: mkId } = {}) {
  const access = createFakeDocAccess();
  const store = createStore(access);
  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: gmFn || (() => gmActive),
    makeId: mkId || makeId,
    logger: logger || { error: () => {} },
  });
  return { service, store, access };
}

function makeFakeStore() {
  const locations = new Map();
  const shops = new Map();
  const calls = [];
  return {
    calls,
    locations,
    shops,
    async listLocations() {
      return [...locations.values()];
    },
    async listShops() {
      return [...shops.values()];
    },
    async createLocation(record) {
      calls.push(`loc:${record.id}`);
      locations.set(record.id, record);
      return record;
    },
    async createShop(record) {
      calls.push(`shop:${record.id}`);
      shops.set(record.id, record);
      return record;
    },
  };
}

// ---------------------------------------------------------------- GM gate

test('export and import return not-active-gm without touching the store when not the active GM', async () => {
  let reads = 0;
  const store = {
    async listLocations() {
      reads += 1;
      return [];
    },
    async listShops() {
      reads += 1;
      return [];
    },
  };
  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: () => false,
    makeId,
    logger: { error: () => {} },
  });

  const exported = await service.exportPortable();
  assert.deepEqual(exported, { status: 'error', error: 'not-active-gm' });

  const imported = await service.importPortable(
    rawV1({ locations: [loc({ id: 'L1' })], shops: [shop({ id: 'S1', locationId: 'L1' })] })
  );
  assert.deepEqual(imported, { status: 'error', error: 'not-active-gm' });

  assert.equal(reads, 0, 'no store read before the GM check');
});

// ---------------------------------------------------------------- roundtrip

test('export then import into an empty world reproduces the locations and shops', async () => {
  const { service: source, store: sourceStore } = makeBackupService();
  await sourceStore.createLocation({ id: 'L1', name: 'Town', createdAt: 1 });
  await sourceStore.createLocation({ id: 'L2', name: 'Hamlet', createdAt: 2 });
  await sourceStore.createShop({
    id: 'S1',
    name: 'General Store',
    locationId: 'L1',
    createdAt: 1,
    inventory: [entry({ id: 'e1', name: 'Potion', price: 10, quantity: 5 })],
  });

  const exported = await source.exportPortable();
  assert.equal(exported.status, 'ok');
  assert.equal(exported.backup.locations.length, 2);
  assert.equal(exported.backup.shops.length, 1);

  const { service: target, store: targetStore } = makeBackupService();
  const imported = await target.importPortable(exported.backup);
  assert.equal(imported.status, 'ok');
  assert.equal(imported.createdLocationIds.length, 2);
  assert.equal(imported.createdShopIds.length, 1);

  const targetLocations = await targetStore.listLocations();
  const targetShops = await targetStore.listShops();
  assert.equal(targetLocations.length, 2);
  assert.equal(targetShops.length, 1);

  // The imported shop's location reference resolves to a created location id,
  // and the shop/entry content is preserved (never a player projection).
  assert.ok(
    targetLocations.some((l) => l.id === targetShops[0].locationId),
    'imported shop references a created location'
  );
  assert.equal(targetShops[0].name, 'General Store');
  assert.equal(targetShops[0].inventory[0].price, 10);
  assert.equal(targetShops[0].inventory[0].quantity, 5);
  assert.equal(targetShops[0].inventory[0].itemUuid, 'Actor.potion');
});

// ---------------------------------------------------------------- dry run

test('dryRun returns counts/id mapping/warnings and makes no writes', async () => {
  const { service, store } = makeBackupService();
  const raw = rawV1({
    locations: [loc({ id: 'L1' }), loc({ id: 'L2' })],
    shops: [
      shop({ id: 'S1', locationId: 'L1', inventory: [entry({ id: 'e1' })] }),
      shop({ id: 'S2', locationId: 'L2' }),
    ],
  });

  const res = await service.importPortable(raw, { dryRun: true });
  assert.equal(res.status, 'ok');
  assert.equal(res.dryRun, true);
  assert.equal(res.counts.locations, 2);
  assert.equal(res.counts.shops, 2);
  assert.ok(Array.isArray(res.warnings));
  assert.ok(res.idMap.locations['L1'], 'dry run exposes the source->new location id');
  assert.ok(res.idMap.shops['S1'], 'dry run exposes the source->new shop id');
  assert.equal(res.idMap.locations['L1'], res.idMap.locations['L1']);
  assert.equal(res.idMap.shops['S1'], res.idMap.shops['S1']);
  assert.notEqual(res.idMap.shops['S1'], 'S1');
  assert.notEqual(res.idMap.locations['L1'], 'L1');

  assert.equal((await store.listLocations()).length, 0, 'dry run wrote no locations');
  assert.equal((await store.listShops()).length, 0, 'dry run wrote no shops');
});

// --------------------------------------------------------- invalid, no writes

test('invalid backups return invalid-backup and write nothing', async () => {
  const { service, store } = makeBackupService();

  // A shop referencing a location that is not in the backup.
  const badRef = rawV1({
    locations: [loc({ id: 'L1' })],
    shops: [shop({ id: 'S1', locationId: 'MISSING' })],
  });
  const resBadRef = await service.importPortable(badRef);
  assert.equal(resBadRef.status, 'error');
  assert.equal(resBadRef.error, 'invalid-backup');
  assert.ok(!('message' in resBadRef), 'no raw exception string leaks into the result');

  // Unknown format.
  const resBadFormat = await service.importPortable({
    format: 'not-a-format',
    locations: [],
    shops: [],
  });
  assert.equal(resBadFormat.status, 'error');
  assert.equal(resBadFormat.error, 'invalid-backup');

  // Duplicate location ids.
  const resDup = await service.importPortable(
    rawV1({
      locations: [loc({ id: 'L1' }), loc({ id: 'L1' })],
      shops: [],
    })
  );
  assert.equal(resDup.status, 'error');
  assert.equal(resDup.error, 'invalid-backup');

  // A raw non-object (not a plain object).
  const resScalar = await service.importPortable('nope');
  assert.equal(resScalar.status, 'error');
  assert.equal(resScalar.error, 'invalid-backup');

  // Oversized serialized payload is rejected before any store read.
  const tooBig = rawV1({
    locations: [loc({ id: 'L1', name: 'x'.repeat(MAX_BACKUP_BYTES + 1) })],
    shops: [],
  });
  const resBig = await service.importPortable(tooBig);
  assert.equal(resBig.status, 'error');
  assert.equal(resBig.error, 'invalid-backup');

  assert.equal((await store.listLocations()).length, 0);
  assert.equal((await store.listShops()).length, 0);
});

// ----------------------------------------------------------------- remap

test('import remaps to fresh ids and rewrites references without colliding with existing records', async () => {
  const { service, store } = makeBackupService();

  // Pre-existing world records that share the backup's source ids.
  await store.createLocation({ id: 'L1', name: 'Existing Town', createdAt: 1 });
  await store.createShop({ id: 'S1', name: 'Existing Shop', locationId: 'L1', createdAt: 1 });

  const raw = rawV1({
    locations: [loc({ id: 'L1' }), loc({ id: 'L2' })],
    shops: [
      shop({
        id: 'S1',
        locationId: 'L1',
        inventory: [entry({ id: 'e1', itemUuid: 'Actor.potion' })],
        npcs: [
          { id: 'n1', name: 'Clerk', role: '', portrait: '', greeting: '', actorUuid: 'Actor.npc', visible: true, shopId: 'S2', personality: 'honest' },
        ],
      }),
      shop({ id: 'S2', name: 'Second Shop', locationId: 'L2' }),
    ],
  });

  const res = await service.importPortable(raw);
  assert.equal(res.status, 'ok');
  assert.equal(res.createdLocationIds.length, 2);
  assert.equal(res.createdShopIds.length, 2);

  // Fresh ids never collide with existing or source ids.
  assert.ok(!res.createdLocationIds.includes('L1'));
  assert.ok(!res.createdShopIds.includes('S1'));
  assert.ok(!res.createdShopIds.includes('S2'));

  // Existing records are untouched (never overwritten).
  const existingLoc = await store.listLocations();
  const existingShop = await store.listShops();
  assert.equal(existingLoc.length, 3);
  assert.equal(existingShop.length, 3);

  // The imported S1 (fresh id) got a remapped locationId pointing at a created
  // location, and its NPC shopId reference was remapped through the created S2.
  const importedShops = existingShop.filter((s) => s.name === 'General Store');
  assert.equal(importedShops.length, 1);
  const s1 = importedShops[0];
  assert.ok(res.createdLocationIds.includes(s1.locationId), 'shop.locationId points at a created location');
  assert.notEqual(s1.npcs[0].shopId, 'S2', 'NPC shopId was remapped');
  assert.ok(res.createdShopIds.includes(s1.npcs[0].shopId), 'NPC shopId points at a created shop');

  // Inventory entry ids are preserved (meaningful only within the shop).
  assert.equal(s1.inventory[0].id, 'e1');
});

// ---------------------------------------------------------------- sequential

test('import creates all locations before any shop, sequentially', async () => {
  const store = makeFakeStore();
  // Prove shops only begin once their location exists: reject a shop create
  // whose location was not already created.
  store.createShop = async (record) => {
    store.calls.push(`shop:${record.id}`);
    assert.ok(
      store.locations.has(record.locationId),
      `shop '${record.id}' created before its location '${record.locationId}'`
    );
    store.shops.set(record.id, record);
    return record;
  };

  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: () => true,
    makeId,
    logger: { error: () => {} },
  });

  const raw = rawV1({
    locations: [loc({ id: 'L1' }), loc({ id: 'L2' })],
    shops: [
      shop({ id: 'S1', locationId: 'L1' }),
      shop({ id: 'S2', locationId: 'L2' }),
    ],
  });

  const res = await service.importPortable(raw);
  assert.equal(res.status, 'ok');

  // All location creates precede every shop create.
  const lastLocIndex = store.calls.findLastIndex((c) => c.startsWith('loc:'));
  const firstShopIndex = store.calls.findIndex((c) => c.startsWith('shop:'));
  assert.ok(firstShopIndex > lastLocIndex, 'all locations created before shops start');

  // The two locations are created in backup order (sequential, one awaited at a
  // time), then the two shops.
  const locCalls = store.calls.filter((c) => c.startsWith('loc:'));
  const shopCalls = store.calls.filter((c) => c.startsWith('shop:'));
  assert.equal(locCalls.length, 2);
  assert.equal(shopCalls.length, 2);
  // Shop ids are fresh, but each shop references a created location id.
  const createdLocIds = new Set([...store.locations.keys()]);
  for (const call of shopCalls) {
    const id = call.slice('shop:'.length);
    const sh = store.shops.get(id);
    assert.ok(createdLocIds.has(sh.locationId), `shop '${id}' references a created location`);
  }
});

// ---------------------------------------------------------------- partial

test('a shop create failure after locations are written reports partial without rollback', async () => {
  const store = makeFakeStore();
  let shopCreates = 0;
  store.createShop = async (record) => {
    store.calls.push(`shop:${record.id}`);
    shopCreates += 1;
    if (shopCreates === 2) return null; // simulate a store write failure
    store.shops.set(record.id, record);
    return record;
  };

  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: () => true,
    makeId,
    logger: { error: () => {} },
  });

  const raw = rawV1({
    locations: [loc({ id: 'L1' }), loc({ id: 'L2' })],
    shops: [shop({ id: 'S1', locationId: 'L1' }), shop({ id: 'S2', locationId: 'L2' })],
  });

  const res = await service.importPortable(raw);
  assert.equal(res.status, 'partial');
  assert.equal(res.error, 'import-partial');
  assert.equal(res.createdLocationIds.length, 2);
  assert.equal(res.createdShopIds.length, 1);

  // No automatic rollback: the written records remain.
  assert.equal(store.locations.size, 2);
  assert.equal(store.shops.size, 1);
  assert.ok(store.shops.has(res.createdShopIds[0]));
});

// ---------------------------------------------------------------- handoff

test('a GM handover after some writes stops the import and reports partial', async () => {
  let gmActive = true;
  const store = makeFakeStore();
  store.createLocation = async (record) => {
    store.calls.push(`loc:${record.id}`);
    store.locations.set(record.id, record);
    gmActive = false; // hand over after the first location
    return record;
  };

  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: () => gmActive,
    makeId,
    logger: { error: () => {} },
  });

  const raw = rawV1({
    locations: [loc({ id: 'L1' }), loc({ id: 'L2' })],
    shops: [shop({ id: 'S1', locationId: 'L1' })],
  });

  const res = await service.importPortable(raw);
  assert.equal(res.status, 'partial');
  assert.equal(res.error, 'import-partial');
  assert.equal(res.createdLocationIds.length, 1);
  assert.equal(res.createdShopIds.length, 0);
  assert.equal(store.locations.size, 1);
  assert.equal(store.shops.size, 0);
});

test('a handover before the first write reports not-active-gm and writes nothing', async () => {
  let gmChecks = 0;
  const store = makeFakeStore();
  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    // true for the entry gate, false at the very first create re-check.
    isActiveGM: () => {
      gmChecks += 1;
      return gmChecks <= 1;
    },
    makeId,
    logger: { error: () => {} },
  });

  const raw = rawV1({
    locations: [loc({ id: 'L1' })],
    shops: [shop({ id: 'S1', locationId: 'L1' })],
  });

  const res = await service.importPortable(raw);
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'not-active-gm');
  assert.equal(store.locations.size, 0);
  assert.equal(store.shops.size, 0);
});

// -------------------------------------------------- no operational records leak

test('export includes only locations and shops, never ledger/reputation/order records', async () => {
  const { service, store } = makeBackupService();
  await store.createLocation({ id: 'L1', name: 'Town', createdAt: 1 });
  await store.createShop({ id: 'S1', name: 'General Store', locationId: 'L1', createdAt: 1 });

  // Operational runtime records that must NOT appear in a portable backup.
  await store.createLedger({
    key: 'gm:req',
    userId: 'gm',
    shopId: 'S1',
    entryId: 'e1',
    quantity: 1,
    unitPrice: 10,
    totalPrice: 10,
    status: 'committed',
  });
  await store.upsertReputation({
    shopId: 'S1',
    scope: 'actor',
    subjectId: 'Actor.a',
    score: 5,
  });
  await store.createReputationEvent({
    key: 'evt:1',
    shopId: 'S1',
    scope: 'actor',
    subjectId: 'Actor.a',
    reason: 'a test',
    source: 'gm',
    status: 'pending',
  });
  await store.createAdvancedOrder({
    key: 'ord1',
    kind: 'service',
    status: 'pending',
    phase: 'recorded',
    shopId: 'S1',
    userId: 'u',
    actorId: 'Actor.b',
    entryId: 'e1',
    quantity: 1,
    total: 5,
    intentHash: 'shorthash',
  });

  const exported = await service.exportPortable();
  assert.equal(exported.status, 'ok');
  assert.equal(exported.backup.locations.length, 1);
  assert.equal(exported.backup.shops.length, 1);
  // The portable format carries no operational record arrays.
  assert.equal(exported.backup.ledgers, undefined);
  assert.equal(exported.backup.reputation, undefined);
  assert.equal(exported.backup.advancedOrders, undefined);

  // The shop is exported GM-private in full (never a player projection).
  assert.equal(exported.backup.shops[0].name, 'General Store');
  assert.equal(exported.backup.shops[0].locationId, 'L1');
});

// ---------------------------------------------------------- import integrity

test('two concurrent imports plan inside the serialized queue and produce distinct ids', async () => {
  // A degenerate id generator that always returns the same value forces the
  // planner's fallback suffix logic. Because the world read + id planning move
  // INSIDE the serialized in-flight import chain, the second import must plan
  // against the world the first import already wrote and never reuse an id.
  const { service } = makeBackupService({ makeId: () => 'X' });
  const raw = rawV1({
    locations: [loc({ id: 'L1' }), loc({ id: 'L2' })],
    shops: [shop({ id: 'S1', locationId: 'L1' }), shop({ id: 'S2', locationId: 'L2' })],
  });

  const [a, b] = await Promise.all([service.importPortable(raw), service.importPortable(raw)]);

  assert.equal(a.status, 'ok', 'first concurrent import succeeds');
  assert.equal(b.status, 'ok', 'second concurrent import succeeds against the written world');

  const locationIds = [...a.createdLocationIds, ...b.createdLocationIds];
  const shopIds = [...a.createdShopIds, ...b.createdShopIds];
  assert.equal(
    new Set(locationIds).size,
    locationIds.length,
    'location ids are distinct across concurrent imports'
  );
  assert.equal(
    new Set(shopIds).size,
    shopIds.length,
    'shop ids are distinct across concurrent imports'
  );
});

test('a location create that persists then throws is reported partial with the persisted id', async () => {
  const store = makeFakeStore();
  let locationCreates = 0;
  store.createLocation = async (record) => {
    store.calls.push(`loc:${record.id}`);
    locationCreates += 1;
    // Persist the record, then throw on the SECOND create so the import cannot
    // trust the create return value - only the re-read can prove the write.
    store.locations.set(record.id, record);
    if (locationCreates === 2) throw new Error('boom');
    return record;
  };

  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: () => true,
    makeId,
    logger: { error: () => {} },
  });

  const raw = rawV1({
    locations: [loc({ id: 'L1' }), loc({ id: 'L2' })],
    shops: [shop({ id: 'S1', locationId: 'L1' })],
  });

  const res = await service.importPortable(raw);
  assert.equal(res.status, 'partial');
  assert.equal(res.error, 'import-partial');
  // The throwing create still landed: the re-read records it truthfully.
  assert.equal(res.createdLocationIds.length, 2);
  assert.equal(res.createdShopIds.length, 0);
  assert.equal(store.locations.size, 2);
  for (const id of res.createdLocationIds) {
    assert.ok(store.locations.has(id), `persisted location '${id}' is reported`);
  }
});

test('a shop create that persists then throws is reported partial with the persisted id', async () => {
  const store = makeFakeStore();
  // Expose findShop so the apply-then-throw re-read can prove the write landed.
  store.findShop = async (id) => store.shops.get(id) || null;
  let shopCreates = 0;
  store.createShop = async (record) => {
    store.calls.push(`shop:${record.id}`);
    shopCreates += 1;
    // Persist the record, then throw on the SECOND create.
    store.shops.set(record.id, record);
    if (shopCreates === 2) throw new Error('boom');
    return record;
  };

  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: () => true,
    makeId,
    logger: { error: () => {} },
  });

  const raw = rawV1({
    locations: [loc({ id: 'L1' })],
    shops: [shop({ id: 'S1', locationId: 'L1' }), shop({ id: 'S2', locationId: 'L1' })],
  });

  const res = await service.importPortable(raw);
  assert.equal(res.status, 'partial');
  assert.equal(res.error, 'import-partial');
  assert.equal(res.createdShopIds.length, 2);
  assert.equal(store.shops.size, 2);
  for (const id of res.createdShopIds) {
    assert.ok(store.shops.has(id), `persisted shop '${id}' is reported`);
  }
});

test('a preflight store-read failure aborts before any write', async () => {
  const store = makeFakeStore();
  store.listShops = async () => {
    throw new Error('read-boom');
  };

  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: () => true,
    makeId,
    logger: { error: () => {} },
  });

  const raw = rawV1({
    locations: [loc({ id: 'L1' })],
    shops: [shop({ id: 'S1', locationId: 'L1' })],
  });

  const res = await service.importPortable(raw);
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'import-preflight-failed');
  assert.equal(store.locations.size, 0, 'no location written before the preflight');
  assert.equal(store.shops.size, 0, 'no shop written before the preflight');
  assert.deepEqual(store.calls, [], 'no create attempted before the preflight');
});

// ------------------------------------------------------- GM handoff, read edges

test('a GM handover after the export locations read skips the shops read', async () => {
  let gm = true;
  let shopsRead = 0;
  const store = {
    async listLocations() {
      gm = false; // hand over as soon as the locations read resolves
      return [];
    },
    async listShops() {
      shopsRead += 1;
      return [];
    },
  };
  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: () => gm,
    makeId,
    logger: { error: () => {} },
  });

  const res = await service.exportPortable();
  assert.deepEqual(res, { status: 'error', error: 'not-active-gm' });
  assert.equal(shopsRead, 0, 'listShops is not read after a handover');
  assert.ok(!('backup' in res), 'no private backup is returned after a handover');
});

test('a GM handover during the export shops read stops before any private backup is returned', async () => {
  // A deferred listShops read that toggles the GM gate back to player BEFORE it
  // resolves. The export awaits it, then must re-check and stop before
  // normalizeBackup, so no private (full normalized) backup is returned.
  let gm = true;
  let resolveShops;
  const shopsRead = new Promise((resolve) => {
    resolveShops = resolve;
  });
  const store = {
    async listLocations() {
      return [];
    },
    async listShops() {
      return shopsRead.then(() => {
        gm = false; // toggle the GM gate before the deferred read resolves
        return [];
      });
    },
  };
  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: () => gm,
    makeId,
    logger: { error: () => {} },
  });

  const pending = service.exportPortable();
  resolveShops(); // resolve the deferred shops read, after the GM gate has been toggled
  const res = await pending;

  assert.deepEqual(res, { status: 'error', error: 'not-active-gm' });
  assert.ok(!('backup' in res), 'no private backup is returned after a handover during listShops');
  assert.ok(!('warnings' in res), 'no warnings are returned after a handover during listShops');
  assert.ok(!('locations' in res), 'no locations are returned after a handover during listShops');
  assert.ok(!('shops' in res), 'no shops are returned after a handover during listShops');
});

test('a GM handover after the import world locations read skips the shops read', async () => {
  let gm = true;
  let shopsRead = 0;
  const store = {
    async listLocations() {
      gm = false; // hand over as soon as the locations read resolves
      return [];
    },
    async listShops() {
      shopsRead += 1;
      return [];
    },
  };
  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: () => gm,
    makeId,
    logger: { error: () => {} },
  });

  const res = await service.importPortable(
    rawV1({ locations: [loc({ id: 'L1' })], shops: [] })
  );
  assert.deepEqual(res, { status: 'error', error: 'not-active-gm' });
  assert.equal(shopsRead, 0, 'listShops is not read after a handover');
});

test('a GM handover during a dry-run world read skips the shops read', async () => {
  let gm = true;
  let shopsRead = 0;
  const store = {
    async listLocations() {
      gm = false;
      return [];
    },
    async listShops() {
      shopsRead += 1;
      return [];
    },
  };
  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: () => gm,
    makeId,
    logger: { error: () => {} },
  });

  const res = await service.importPortable(
    rawV1({ locations: [loc({ id: 'L1' })], shops: [] }),
    { dryRun: true }
  );
  assert.deepEqual(res, { status: 'error', error: 'not-active-gm' });
  assert.equal(shopsRead, 0, 'listShops is not read after a handover');
});

test('a GM handover before a location recovery re-read reports partial with an uncertain warning', async () => {
  const createdLocations = new Map();
  let gm = true;
  let listLocationsCalls = 0;
  let locationCreates = 0;
  const store = {
    async listLocations() {
      listLocationsCalls += 1;
      return [...createdLocations.values()];
    },
    async listShops() {
      return [];
    },
    async createLocation(record) {
      createdLocations.set(record.id, record);
      locationCreates += 1;
      if (locationCreates === 2) {
        gm = false; // hand over after the failing create, before the recovery read
        return null;
      }
      return record;
    },
  };
  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: () => gm,
    makeId,
    logger: { error: () => {} },
  });

  const res = await service.importPortable(
    rawV1({ locations: [loc({ id: 'L1' }), loc({ id: 'L2' })], shops: [] })
  );
  assert.equal(res.status, 'partial');
  assert.equal(res.error, 'import-partial');
  assert.equal(res.createdLocationIds.length, 1);
  assert.ok(
    res.warnings.some((w) => w.includes('created record may not be reported')),
    'uncertain create warning is reported'
  );
  // listLocations ran once for the preflight world read; the recovery re-read was
  // skipped, so the count must not advance.
  assert.equal(listLocationsCalls, 1, 'no recovery re-read after a handover');
});

test('a GM handover before a shop recovery re-read reports partial with an uncertain warning', async () => {
  const createdLocations = new Map();
  const createdShops = new Map();
  let gm = true;
  let findShopCalls = 0;
  let shopCreates = 0;
  const store = {
    async listLocations() {
      return [...createdLocations.values()];
    },
    async listShops() {
      return [...createdShops.values()];
    },
    async createLocation(record) {
      createdLocations.set(record.id, record);
      return record;
    },
    async createShop(record) {
      createdShops.set(record.id, record);
      shopCreates += 1;
      if (shopCreates === 2) {
        gm = false; // hand over after the failing create, before the recovery read
        return null;
      }
      return record;
    },
    async findShop(id) {
      findShopCalls += 1;
      return createdShops.get(id) || null;
    },
  };
  const service = createBackupService({
    store,
    runShopExclusive: (id, fn) => fn(),
    isActiveGM: () => gm,
    makeId,
    logger: { error: () => {} },
  });

  const res = await service.importPortable(
    rawV1({
      locations: [loc({ id: 'L1' })],
      shops: [shop({ id: 'S1', locationId: 'L1' }), shop({ id: 'S2', locationId: 'L1' })],
    })
  );
  assert.equal(res.status, 'partial');
  assert.equal(res.error, 'import-partial');
  assert.equal(res.createdShopIds.length, 1);
  assert.ok(
    res.warnings.some((w) => w.includes('created record may not be reported')),
    'uncertain create warning is reported'
  );
  assert.equal(findShopCalls, 0, 'no findShop recovery re-read after a handover');
});

// ------------------------------------------------------- id-map prototype safety

test('dryRun idMap maps __proto__ and constructor source ids safely and serializes', async () => {
  const { service, store } = makeBackupService();
  const raw = rawV1({
    locations: [loc({ id: '__proto__' }), loc({ id: 'constructor' })],
    shops: [shop({ id: 'S1', locationId: '__proto__' })],
  });

  const res = await service.importPortable(raw, { dryRun: true });
  assert.equal(res.status, 'ok');

  const locationMap = res.idMap.locations;
  const shopMap = res.idMap.shops;
  assert.equal(Object.getPrototypeOf(locationMap), null, 'location map has a null prototype');
  assert.equal(Object.getPrototypeOf(shopMap), null, 'shop map has a null prototype');

  assert.equal(typeof locationMap['__proto__'], 'string', 'location __proto__ maps to a new id');
  assert.equal(typeof locationMap['constructor'], 'string', 'location constructor maps to a new id');
  assert.notEqual(locationMap['__proto__'], '__proto__');
  assert.notEqual(locationMap['constructor'], 'constructor');
  assert.equal(typeof shopMap['S1'], 'string', 'shop source id maps to a new id');

  // JSON serialization must retain every mapping entry, including __proto__.
  const serialized = JSON.stringify(res.idMap);
  const parsed = JSON.parse(serialized);
  assert.equal(typeof parsed.locations['__proto__'], 'string', 'serialized __proto__ id is retained');
  assert.equal(typeof parsed.locations['constructor'], 'string', 'serialized constructor id is retained');
  assert.equal(typeof parsed.shops['S1'], 'string', 'serialized shop id is retained');

  assert.equal((await store.listLocations()).length, 0, 'dry run wrote no locations');
  assert.equal((await store.listShops()).length, 0, 'dry run wrote no shops');
});
