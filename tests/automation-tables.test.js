// Tests for the M4 GM-only RollTable item inventory generation service in
// `src/automation/tables.js`.
//
// These are pure Node tests: no Foundry globals, only a fake store, a fake
// RollTable, an injected `resolveResult` and `getAdapter`. They cover the
// active-GM gate, count/uuid validation, skipping text and non-Item results,
// UUID dedupe (within a draw and against the live shop) under the shared per-shop
// lock, the 20-result cap, the price-0 fallback when the adapter is unsupported
// or throws, a zero-addition success with no write, and a failed draw that writes
// nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTableInventoryService } from '../src/automation/tables.js';
import {
  normalizeShop,
  normalizeInventoryEntry,
} from '../src/services/model.js';

function makeShop({ inventory = [] } = {}) {
  return normalizeShop({
    id: 'shop1',
    name: 'General Store',
    locationId: 'home',
    open: true,
    inventory,
  });
}

function makeItem({ uuid = 'Item.a', name = 'Sword', img = 'icons/sword.png' } = {}) {
  return {
    documentName: 'Item',
    uuid,
    name,
    img,
    toObject() {
      return { name, img, system: {} };
    },
  };
}

function makeTable({ results = [], loadHandler } = {}) {
  return {
    documentName: 'RollTable',
    async drawMany(count, opts) {
      if (loadHandler) return loadHandler(count, opts);
      return { results };
    },
  };
}

function createFakeStore({ shop = null } = {}) {
  const calls = { findShop: 0, updateShop: 0 };
  const store = {
    calls,
    _shop: shop,
    async findShop(id) {
      calls.findShop += 1;
      return store._shop;
    },
    async updateShop(id, patch) {
      calls.updateShop += 1;
      if (!store._shop) return null;
      store._shop = { ...store._shop, ...patch };
      return store._shop;
    },
  };
  return store;
}

function makeService({
  store,
  table = makeTable(),
  getTable,
  resolveResult = async () => null,
  adapter,
  getAdapter = () => adapter || { async getItemPrice() { return 100; } },
  runShopExclusive,
  gmActive = true,
} = {}) {
  let seq = 0;
  return createTableInventoryService({
    store,
    runShopExclusive,
    isActiveGM: () => gmActive,
    getTable: getTable || (async () => table),
    resolveResult,
    getAdapter,
    makeId: () => `gen-id-${(seq += 1)}`,
    logger: { warn() {}, error() {} },
  });
}

// ---------------------------------------------------------------- GM gate

test('generate guards on active GM before any table or store read', async () => {
  let tableCalls = 0;
  const store = createFakeStore({ shop: makeShop() });
  const service = makeService({
    store,
    gmActive: false,
    getTable: async () => {
      tableCalls += 1;
      return makeTable({ results: [] });
    },
  });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 3 });
  assert.deepEqual(res, { status: 'idle', shopId: 'shop1' });
  assert.equal(store.calls.findShop, 0, 'no store read for a non-active GM');
  assert.equal(tableCalls, 0, 'no table read for a non-active GM');
});

// ---------------------------------------------------------------- validation

test('generate validates count as an integer in 1..20', async () => {
  const store = createFakeStore({ shop: makeShop() });
  const service = makeService({ store });

  for (const bad of [0, -1, 21, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5']) {
    const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: bad });
    assert.equal(res.status, 'error');
    assert.equal(res.error, 'invalid-count');
    assert.equal(store.calls.findShop, 0, `no store read for an invalid count ${bad}`);
  }

  // Valid boundary counts proceed to the store read.
  for (const good of [1, 20]) {
    const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: good });
    assert.notEqual(res.status, 'error');
  }
  assert.equal(store.calls.findShop, 2, 'valid counts reach the store read');
});

test('generate validates a non-empty table uuid of at most 200 chars', async () => {
  const store = createFakeStore({ shop: makeShop() });
  const service = makeService({ store });

  for (const bad of ['', '   ', 'x'.repeat(201), 42, null, undefined]) {
    const res = await service.generate({ shopId: 'shop1', tableUuid: bad, count: 3 });
    assert.equal(res.status, 'error');
    assert.equal(res.error, 'invalid-table-uuid');
    assert.equal(store.calls.findShop, 0, `no store read for an invalid uuid ${bad}`);
  }

  const ok = await service.generate({ shopId: 'shop1', tableUuid: 'x'.repeat(200), count: 3 });
  assert.notEqual(ok.status, 'error');
});

// ---------------------------------------------------------------- skip text / non-item

test('generate skips text results and document results that do not resolve to a valid Item', async () => {
  const store = createFakeStore({ shop: makeShop() });
  const resultOk = {
    type: 'document',
    key: 'ok',
  };
  const table = makeTable({
    results: [
      { type: 'text', text: 'flavor text' },
      { type: 'document', key: 'null' },
      { type: 'document', key: 'actor' },
      { type: 'document', key: 'noid' },
      { type: 'document', key: 'notoobject' },
      resultOk,
    ],
  });
  const okItem = makeItem({ uuid: 'Item.ok', name: 'Axe' });
  const resolveResult = async (r) => {
    if (r.key === 'null') return null;
    if (r.key === 'actor') return { documentName: 'Actor', uuid: 'Actor.x' };
    if (r.key === 'noid') return { documentName: 'Item', uuid: '', name: 'NoId' };
    if (r.key === 'notoobject') return { documentName: 'Item', uuid: 'Item.z', name: 'NoTo' };
    if (r.key === 'ok') return okItem;
    return null;
  };
  const service = makeService({ store, table, resolveResult });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 6 });
  assert.equal(res.status, 'ok');
  assert.equal(res.added, 1);
  assert.equal(res.invalid, 1, 'the text result is invalid');
  assert.equal(res.skipped, 4, 'null/actor/noid/notoobject are all skipped');
  assert.equal(res.duplicate, 0);
  assert.equal(store.calls.updateShop, 1, 'one write for the single added entry');

  const stored = store._shop;
  assert.equal(stored.inventory.length, 1);
  assert.equal(stored.inventory[0].itemUuid, 'Item.ok');
  assert.equal(stored.inventory[0].name, 'Axe');
  assert.equal(stored.inventory[0].quantity, 1);
  assert.equal(stored.inventory[0].stockMode, 'finite');
  assert.equal(stored.inventory[0].visible, true);
  assert.equal(stored.inventory[0].price, 100);
  assert.ok(stored.inventory[0].id, 'an entry id is generated');
  assert.equal(typeof stored.inventory[0].snapshot, 'string');
  assert.ok(stored.inventory[0].snapshot.includes('name'), 'snapshot is the serialized item');
});

test('generate skips a result whose resolution throws without aborting the draw', async () => {
  const store = createFakeStore({ shop: makeShop() });
  const table = makeTable({
    results: [
      { type: 'document', key: 'boom' },
      { type: 'document', key: 'ok' },
    ],
  });
  const resolveResult = async (r) => {
    if (r.key === 'boom') throw new Error('resolve failed');
    return makeItem({ uuid: 'Item.ok', name: 'Axe' });
  };
  const service = makeService({ store, table, resolveResult });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 2 });
  assert.equal(res.status, 'ok');
  assert.equal(res.added, 1);
  assert.equal(res.skipped, 1, 'a resolving throw is skipped individually');
  assert.equal(res.invalid, 0);
  assert.equal(res.duplicate, 0);
  assert.equal(store.calls.updateShop, 1, 'the other result is still added');
});

// ---------------------------------------------------------------- duplicates + lock

test('generate dedupes UUIDs against the current shop inventory under the shop lock', async () => {
  const existing = normalizeInventoryEntry({
    id: 'e1',
    itemUuid: 'Item.dup',
    name: 'Existing',
    quantity: 2,
    price: 50,
    snapshot: '{"name":"Existing"}',
  });
  const store = createFakeStore({ shop: makeShop({ inventory: [existing] }) });
  const seenShops = [];
  let resolveCalls = 0;
  const table = makeTable({
    results: [
      { type: 'document', key: 'dup' },
      { type: 'document', key: 'new' },
    ],
  });
  const resolveResult = async (r) => {
    resolveCalls += 1;
    if (r.key === 'dup') return makeItem({ uuid: 'Item.dup', name: 'Potion' });
    if (r.key === 'new') return makeItem({ uuid: 'Item.new', name: 'Axe' });
    return null;
  };
  const service = makeService({
    store,
    table,
    resolveResult,
    runShopExclusive: (shopId, fn) => {
      seenShops.push(shopId);
      return fn();
    },
  });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 2 });
  assert.equal(res.status, 'ok');
  assert.equal(res.added, 1);
  assert.equal(res.duplicate, 1, 'the existing UUID is deduped');
  assert.equal(res.skipped, 0);
  assert.equal(res.invalid, 0);
  assert.deepEqual(seenShops, ['shop1'], 'generation runs inside the per-shop lock');
  assert.equal(resolveCalls, 2, 'every document result is resolved');

  const stored = store._shop;
  assert.equal(stored.inventory.length, 2, 'existing entry is not overwritten');
  assert.ok(stored.inventory.some((e) => e.itemUuid === 'Item.new'));
  assert.equal(
    stored.inventory.filter((e) => e.itemUuid === 'Item.dup').length,
    1,
    'no duplicate of the existing entry'
  );
  assert.equal(store.calls.updateShop, 1, 'a single atomic write');
});

test('generate dedupes repeated UUIDs within a single draw', async () => {
  const store = createFakeStore({ shop: makeShop() });
  const table = makeTable({
    results: [
      { type: 'document', key: 'a' },
      { type: 'document', key: 'a' },
      { type: 'document', key: 'b' },
    ],
  });
  const resolveResult = async (r) =>
    makeItem({ uuid: `Item.${r.key}`, name: `Item ${r.key}`, img: '' });
  const service = makeService({ store, table, resolveResult });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 3 });
  assert.equal(res.status, 'ok');
  assert.equal(res.added, 2);
  assert.equal(res.duplicate, 1, 'the second occurrence of the same UUID is a duplicate');
  assert.equal(store.calls.updateShop, 1);
  assert.equal(store._shop.inventory.length, 2, 'only unique UUIDs are stored');
});

// ---------------------------------------------------------------- maximum cap

test('generate caps the draw results at 20 and never processes more', async () => {
  const store = createFakeStore({ shop: makeShop() });
  const results = Array.from({ length: 25 }, (_, i) => ({ type: 'document', key: `r${i}` }));
  let resolveCalls = 0;
  const table = makeTable({ results });
  const resolveResult = async (r) => {
    resolveCalls += 1;
    const n = Number(r.key.slice(1));
    return makeItem({ uuid: `Item.r${n}`, name: `Item ${n}`, img: '' });
  };
  const service = makeService({ store, table, resolveResult });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 20 });
  assert.equal(res.status, 'ok');
  assert.equal(res.added, 20);
  assert.equal(res.skipped, 0);
  assert.equal(res.invalid, 0);
  assert.equal(res.duplicate, 0);
  assert.equal(resolveCalls, 20, 'only the capped 20 results are resolved');
  assert.equal(store.calls.updateShop, 1);
  assert.equal(store._shop.inventory.length, 20);
});

// ---------------------------------------------------------------- price fallback

test('generate falls back to price 0 when the adapter is unsupported or throws', async () => {
  const scenarios = [
    { name: 'null adapter', getAdapter: () => null },
    { name: 'adapter without getItemPrice', getAdapter: () => ({}) },
    {
      name: 'throwing adapter',
      getAdapter: () => ({
        async getItemPrice() {
          throw new Error('price read failed');
        },
      }),
    },
    {
      name: 'negative price',
      getAdapter: () => ({ async getItemPrice() { return -5; } }),
    },
  ];

  for (const s of scenarios) {
    const store = createFakeStore({ shop: makeShop() });
    const table = makeTable({ results: [{ type: 'document', key: 'ok' }] });
    const resolveResult = async () => makeItem({ uuid: 'Item.ok', name: 'Potion', img: '' });
    const service = makeService({ store, table, resolveResult, getAdapter: s.getAdapter });

    const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 1 });
    assert.equal(res.status, 'ok', s.name);
    assert.equal(res.added, 1, s.name);
    assert.equal(res.skipped, 0, s.name);
    assert.equal(store._shop.inventory[0].price, 0, `${s.name}: price falls back to 0`);
    assert.equal(store._shop.inventory[0].itemUuid, 'Item.ok', `${s.name}: item is still added`);
  }
});

test('generate floors a fractional adapter price to a safe integer minor unit', async () => {
  const store = createFakeStore({ shop: makeShop() });
  const table = makeTable({ results: [{ type: 'document', key: 'ok' }] });
  const resolveResult = async () => makeItem({ uuid: 'Item.ok', name: 'Potion', img: '' });
  const service = makeService({
    store,
    table,
    resolveResult,
    getAdapter: () => ({ async getItemPrice() { return 12.9; } }),
  });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 1 });
  assert.equal(res.status, 'ok');
  assert.equal(store._shop.inventory[0].price, 12);
});

// ---------------------------------------------------------------- zero success

test('generate returns ok with zero additions and writes nothing when a draw yields nothing', async () => {
  const store = createFakeStore({ shop: makeShop() });
  const table = makeTable({ results: [] });
  const resolveResult = async () => null;
  const service = makeService({ store, table, resolveResult });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 3 });
  assert.equal(res.status, 'ok');
  assert.equal(res.added, 0);
  assert.equal(res.skipped, 0);
  assert.equal(res.invalid, 0);
  assert.equal(res.duplicate, 0);
  assert.equal(store.calls.updateShop, 0, 'no write when nothing was added');
  assert.deepEqual(store._shop.inventory, []);
});

test('generate writes nothing when every drawn result is already a duplicate', async () => {
  const existing = normalizeInventoryEntry({
    id: 'e1',
    itemUuid: 'Item.a',
    name: 'Existing',
    quantity: 2,
    price: 50,
    snapshot: '{"name":"Existing"}',
  });
  const store = createFakeStore({ shop: makeShop({ inventory: [existing] }) });
  const table = makeTable({
    results: [
      { type: 'document', key: 'a' },
      { type: 'document', key: 'a' },
    ],
  });
  const resolveResult = async () => makeItem({ uuid: 'Item.a', name: 'Potion', img: '' });
  const service = makeService({ store, table, resolveResult });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 2 });
  assert.equal(res.status, 'ok');
  assert.equal(res.added, 0);
  assert.equal(res.duplicate, 2);
  assert.equal(res.invalid, 0);
  assert.equal(res.skipped, 0);
  assert.equal(store.calls.updateShop, 0, 'no write when nothing was added');
});

// ---------------------------------------------------------------- draw failure

test('generate returns table-draw-failed on a thrown draw and writes nothing', async () => {
  const store = createFakeStore({ shop: makeShop() });
  const table = {
    documentName: 'RollTable',
    async drawMany() {
      throw new Error('boom');
    },
  };
  const service = makeService({ store, table });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 3 });
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'table-draw-failed');
  assert.equal(store.calls.updateShop, 0, 'no write on a failed draw');
});

// ---------------------------------------------------------------- table resolution

test('generate refuses a missing or non-RollTable document as table-not-found', async () => {
  const store = createFakeStore({ shop: makeShop() });

  // null and non-RollTable resolve to table-not-found.
  for (const t of [null, { documentName: 'Actor' }]) {
    const s = makeService({ store: createFakeStore({ shop: makeShop() }), getTable: async () => t });
    const res = await s.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 3 });
    assert.equal(res.status, 'error');
    assert.equal(res.error, 'table-not-found');
  }

  // A valid RollTable resolves and draws.
  const okTable = makeTable({ results: [] });
  const okService = makeService({ store, getTable: async () => okTable });
  const ok = await okService.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 3 });
  assert.equal(ok.status, 'ok');
});

// ------------------------------------------------------- active-GM rechecks

test('generate returns idle when the GM hands off while queued inside the lock', async () => {
  const store = createFakeStore({ shop: makeShop() });
  let gm = true;
  const service = createTableInventoryService({
    store,
    runShopExclusive: (shopId, fn) => {
      // The GM hands off while this operation is queued behind the lock.
      gm = false;
      return fn();
    },
    isActiveGM: () => gm,
    getTable: async () => makeTable({ results: [] }),
    resolveResult: async () => null,
    getAdapter: () => ({ async getItemPrice() { return 0; } }),
    makeId: () => 'gen-id-1',
    logger: { warn() {}, error() {} },
  });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 3 });
  assert.deepEqual(res, { status: 'idle', shopId: 'shop1' });
  assert.equal(store.calls.findShop, 0, 'no store read after a handoff inside the lock');
});

test('generate returns idle when the GM hands off before the draw', async () => {
  const store = createFakeStore({ shop: makeShop() });
  let gm = true;
  let drawCalls = 0;
  const origFind = store.findShop.bind(store);
  store.findShop = async (id) => {
    const s = await origFind(id);
    gm = false; // handoff after the read, before the draw
    return s;
  };
  const table = {
    documentName: 'RollTable',
    async drawMany() {
      drawCalls += 1;
      return { results: [] };
    },
  };
  const service = createTableInventoryService({
    store,
    isActiveGM: () => gm,
    getTable: async () => table,
    resolveResult: async () => null,
    getAdapter: () => ({ async getItemPrice() { return 0; } }),
    makeId: () => 'gen-id-1',
    logger: { warn() {}, error() {} },
  });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 3 });
  assert.deepEqual(res, { status: 'idle', shopId: 'shop1' });
  assert.equal(drawCalls, 0, 'no draw after a handoff before the draw');
  assert.equal(store.calls.updateShop, 0, 'no write before the draw handoff');
});

test('generate returns idle when the GM hands off before the write', async () => {
  const store = createFakeStore({ shop: makeShop() });
  let gm = true;
  const table = makeTable({ results: [{ type: 'document', key: 'ok' }] });
  const service = createTableInventoryService({
    store,
    isActiveGM: () => gm,
    getTable: async () => table,
    resolveResult: async () => {
      gm = false; // handoff while resolving the drawn item, before the write
      return makeItem({ uuid: 'Item.ok', name: 'Axe' });
    },
    getAdapter: () => ({ async getItemPrice() { return 100; } }),
    makeId: () => 'gen-id-1',
    logger: { warn() {}, error() {} },
  });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 1 });
  assert.deepEqual(res, { status: 'idle', shopId: 'shop1' });
  assert.equal(store.calls.updateShop, 0, 'no write after a handoff before the write');
});

// ------------------------------------------------------- shop-update-failed

test('generate treats a null store.updateShop as shop-update-failed', async () => {
  const table = makeTable({ results: [{ type: 'document', key: 'ok' }] });
  const store = {
    _shop: makeShop(),
    calls: { findShop: 0, updateShop: 0 },
    async findShop(id) {
      store.calls.findShop += 1;
      return store._shop;
    },
    async updateShop(id, patch) {
      store.calls.updateShop += 1;
      return null;
    },
  };
  const service = makeService({
    store,
    table,
    resolveResult: async () => makeItem({ uuid: 'Item.ok', name: 'Axe' }),
  });

  const res = await service.generate({ shopId: 'shop1', tableUuid: 'Table.x', count: 1 });
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'shop-update-failed');
  assert.equal(store.calls.updateShop, 1);
});
