// Tests for the M4 GM-only automation runner in `src/automation/service.js`.
//
// These are still pure Node tests: no Foundry globals, only a fake store, a fake
// lock (or the real commerce lock), and injected dependencies. They cover the
// store mutation rules (single atomic update, no partial failure), the restock
// set-to-target with no stock reduction, the travel location preflight, the
// purchase race lock, idempotency, GM gating, failure without cycle
// advancement, and bounded return shapes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAutomationService } from '../src/automation/service.js';
import {
  normalizeShop,
  normalizeInventoryEntry,
  normalizeLocation,
  makeId,
} from '../src/services/model.js';
import { createCommerce, createLockMap } from '../src/services/commerce.js';
import { timeAt } from '../src/automation/policy.js';

const BASE = timeAt(0, 0); // 0 (Monday 00:00)

function makeEntry(overrides = {}) {
  return normalizeInventoryEntry({
    id: 'entry1',
    itemUuid: 'Compendium.books.Item.potion',
    snapshot: 'a small red potion',
    name: 'Potion',
    quantity: 10,
    stockMode: 'finite',
    price: 100,
    ...overrides,
  });
}

function makeShop({ open = true, locationId = 'home', inventory, automation, id = 'shop1', name = 'General Store' } = {}) {
  return normalizeShop({
    id,
    name,
    locationId,
    open,
    inventory: inventory ?? [],
    automation: automation ?? {},
  });
}

function createFakeStore({ shops = [], locations = [] } = {}) {
  const shopMap = new Map(shops.map((s) => [s.id, s]));
  const locMap = new Map(locations.map((l) => [l.id, l]));
  const calls = { listShops: 0, findShop: 0, updateShop: 0, listLocations: 0 };
  const store = {
    calls,
    _shops: shopMap,
    _locations: locMap,
    async listShops() {
      calls.listShops += 1;
      return [...shopMap.values()];
    },
    async findShop(id) {
      calls.findShop += 1;
      return shopMap.get(id) || null;
    },
    async listLocations() {
      calls.listLocations += 1;
      return [...locMap.values()];
    },
    async updateShop(id, patch) {
      calls.updateShop += 1;
      const current = shopMap.get(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      shopMap.set(id, next);
      return next;
    },
  };
  return store;
}

function makeService({ store, runShopExclusive, gmActive = true, now } = {}) {
  return createAutomationService({
    store,
    runShopExclusive,
    isActiveGM: () => gmActive,
    now,
    logger: { error: () => {} },
  });
}

// ---------------------------------------------------------------- restocks

test('runShop restocks a due finite entry to its target and advances lastCycle', async () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const store = createFakeStore({ shops: [shop] });
  const service = makeService({ store, now: () => BASE + 3600 });

  const summary = await service.runShop(shop.id);
  assert.equal(summary.status, 'ok');
  assert.equal(summary.restocked, 1);
  assert.equal(summary.locationId, 'home');

  const stored = store._shops.get(shop.id);
  assert.equal(stored.inventory[0].quantity, 20);
  assert.equal(stored.inventory[0].restock.lastCycle, 1);
  assert.equal(stored.automation.diagnostics.lastStatus, 'ok');
  assert.equal(stored.automation.diagnostics.lastRestocked, 1);
  assert.equal(stored.automation.diagnostics.lastLocationId, 'home');
  assert.equal(store.calls.updateShop, 1);
});

test('runShop never reduces stock when quantity is at or above target', async () => {
  const entry = makeEntry({
    quantity: 25,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const store = createFakeStore({ shops: [shop] });
  const service = makeService({ store, now: () => BASE + 3600 });

  const summary = await service.runShop(shop.id);
  assert.equal(summary.status, 'ok');
  const stored = store._shops.get(shop.id);
  assert.equal(stored.inventory[0].quantity, 25); // max(25,20) -> no reduction
  assert.equal(stored.inventory[0].restock.lastCycle, 1);
});

test('runShop is idle (no write) for a disabled or non-finite restock', async () => {
  const shop = makeShop({
    inventory: [
      makeEntry({
        id: 'disabled',
        quantity: 5,
        restock: { enabled: false, target: 20, intervalSeconds: 3600, anchorTime: BASE },
      }),
      makeEntry({
        id: 'unlimited',
        stockMode: 'unlimited',
        quantity: 5,
        restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE },
      }),
    ],
  });
  const store = createFakeStore({ shops: [shop] });
  const service = makeService({ store, now: () => BASE + 3600 });

  const summary = await service.runShop(shop.id);
  assert.equal(summary.status, 'idle');
  assert.equal(store.calls.updateShop, 0);
  assert.equal(store._shops.get(shop.id).inventory[0].quantity, 5);
});

test('runShop only advances a single due cycle (no catch-up loop, no backward time)', async () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: 3 },
  });
  const shop = makeShop({ inventory: [entry] });
  const store = createFakeStore({ shops: [shop] });
  const service = makeService({ store, now: () => BASE + 2 * 3600 });

  const summary = await service.runShop(shop.id); // cycle 2 <= lastCycle 3
  assert.equal(summary.status, 'idle');
  assert.equal(store.calls.updateShop, 0);
});

// ---------------------------------------------------------------- travel

test('runShop applies a due travel rotation to an existing location', async () => {
  const shop = makeShop({
    locationId: 'home',
    automation: {
      travel: { enabled: true, locationIds: ['loc-a', 'loc-b'], anchorTime: BASE, intervalSeconds: 3600, lastCycle: -1 },
    },
  });
  const store = createFakeStore({
    shops: [shop],
    locations: [normalizeLocation({ id: 'loc-a', name: 'A' }), normalizeLocation({ id: 'loc-b', name: 'B' })],
  });
  const service = makeService({ store, now: () => BASE + 3600 });

  const summary = await service.runShop(shop.id);
  assert.equal(summary.status, 'ok');
  assert.equal(summary.locationId, 'loc-b');
  const stored = store._shops.get(shop.id);
  assert.equal(stored.locationId, 'loc-b');
  assert.equal(stored.automation.travel.lastCycle, 1);
  assert.equal(stored.automation.diagnostics.lastStatus, 'ok');
  assert.equal(stored.automation.diagnostics.lastLocationId, 'loc-b');
});

test('runShop fails a due travel with a missing location and applies no partial state', async () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({
    locationId: 'home',
    inventory: [entry],
    automation: {
      travel: { enabled: true, locationIds: ['loc-a', 'loc-b'], anchorTime: BASE, intervalSeconds: 3600, lastCycle: -1 },
    },
  });
  const store = createFakeStore({
    shops: [shop],
    locations: [normalizeLocation({ id: 'loc-a', name: 'A' })],
  });
  const service = makeService({ store, now: () => BASE + 3600 });

  const summary = await service.runShop(shop.id);
  assert.equal(summary.status, 'error');
  assert.equal(summary.error, 'travel-location-missing');

  const stored = store._shops.get(shop.id);
  // No restock, no travel advancement, base location unchanged.
  assert.equal(stored.inventory[0].quantity, 5);
  assert.equal(stored.inventory[0].restock.lastCycle, -1);
  assert.equal(stored.automation.travel.lastCycle, -1);
  assert.equal(stored.locationId, 'home');
  // Diagnostics-only write, preserving inventory / location / travel cycles.
  assert.equal(stored.automation.diagnostics.lastStatus, 'error');
  assert.equal(stored.automation.diagnostics.lastError, 'travel-location-missing');
  assert.equal(stored.automation.diagnostics.lastRestocked, 0);
  assert.equal(stored.automation.diagnostics.lastLocationId, 'home');
});

// ---------------------------------------------------------------- atomicity

test('runShop mutates the shop atomically in a single store.updateShop', async () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const store = createFakeStore({ shops: [shop] });
  let patch = null;
  const original = store.updateShop.bind(store);
  store.updateShop = async (id, p) => {
    patch = p;
    return original(id, p);
  };
  const service = makeService({ store, now: () => BASE + 3600 });

  const summary = await service.runShop(shop.id);
  assert.equal(summary.status, 'ok');
  assert.equal(store.calls.updateShop, 1);
  assert.ok(patch);
  assert.ok(patch.inventory, 'inventory is written in the same atomic patch');
  assert.equal(typeof patch.locationId, 'string');
  assert.ok(patch.automation, 'automation (incl. diagnostics + travel cycle) is written atomically');
  assert.equal(patch.automation.diagnostics.lastStatus, 'ok');
});

// ---------------------------------------------------------------- locks

test('runShop delegates to runShopExclusive with the bare shop id', async () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const store = createFakeStore({ shops: [shop] });
  const seen = [];
  const service = createAutomationService({
    store,
    runShopExclusive: (shopId, fn) => {
      seen.push(shopId);
      return fn();
    },
    isActiveGM: () => true,
    now: () => BASE + 3600,
    logger: { error: () => {} },
  });

  await service.runShop(shop.id);
  assert.deepEqual(seen, [shop.id]);
});

test('automation and commerce purchases are serialized by the shared per-shop lock', async () => {
  const entry = makeEntry({
    quantity: 10,
    price: 100,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const ledgers = new Map();
  let depth = 0;
  let maxDepth = 1;
  const store = {
    _shops: new Map([[shop.id, shop]]),
    _ledgers: ledgers,
    async listShops() {
      return [...store._shops.values()];
    },
    async findShop(id) {
      return store._shops.get(id) || null;
    },
    async listLocations() {
      return [];
    },
    async findLedgerByKey(key) {
      return ledgers.get(key) || null;
    },
    async createLedger(rec) {
      const normalized = { ...rec, id: rec.id || makeId() };
      const existing = ledgers.get(normalized.key);
      if (existing) return { record: existing, created: false };
      ledgers.set(normalized.key, normalized);
      return { record: normalized, created: true };
    },
    async updateLedger(id, patch) {
      for (const [key, value] of ledgers) {
        if (value.id === id) {
          ledgers.set(key, { ...value, ...patch });
          return ledgers.get(key);
        }
      }
      return null;
    },
    async updateShop(id, patch) {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      const current = store._shops.get(id);
      if (!current) {
        depth -= 1;
        return null;
      }
      // Yield so a non-serialized second writer could overlap.
      await new Promise((r) => setTimeout(r, 1));
      const next = { ...current, ...patch };
      store._shops.set(id, next);
      depth -= 1;
      return next;
    },
  };

  const lockMap = createLockMap();
  const actor = { id: 'actor1', name: 'Player' };
  const source = { id: 'srcItem', name: 'Potion' };
  const adapter = {
    supported: true,
    async getBalance() {
      return 1000;
    },
    async debit() {
      await new Promise((r) => setTimeout(r, 2));
      return { newBalance: 800 };
    },
    async credit() {
      return {};
    },
    async deliverItem() {
      return { id: 'item1' };
    },
    async removeItem() {
      return {};
    },
  };
  const commerce = createCommerce({
    store,
    getActor: async (id) => (actor.id === id ? actor : null),
    fromUuid: async () => source,
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
    runShopExclusive: commerce.runShopExclusive,
    now: () => BASE + 3600,
  });

  const [purchaseResult, autoSummary] = await Promise.all([
    commerce.purchase({ shopId: shop.id, entryId: 'entry1', actorId: 'actor1', quantity: 2 }, 'gm1'),
    service.runShop(shop.id),
  ]);

  assert.equal(purchaseResult.status, 'committed');
  assert.equal(autoSummary.status, 'ok');
  assert.equal(maxDepth, 1, 'purchase and automation shop writes never overlapped');
  // purchase runs first (10 -> 8), automation runs second (8 -> 20)
  const stored = store._shops.get(shop.id);
  assert.equal(stored.inventory[0].quantity, 20);
  assert.equal(stored.inventory[0].restock.lastCycle, 1);
});

// ---------------------------------------------------------------- idempotency

test('duplicate ticks at the same world time are idempotent', async () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const store = createFakeStore({ shops: [shop] });
  const service = makeService({ store, now: () => BASE + 3600 });

  const first = await service.runShop(shop.id);
  assert.equal(first.status, 'ok');
  assert.equal(store.calls.updateShop, 1);

  const second = await service.runShop(shop.id);
  assert.equal(second.status, 'idle');
  assert.equal(store.calls.updateShop, 1, 'no write on a no-due duplicate tick');

  const stored = store._shops.get(shop.id);
  assert.equal(stored.inventory[0].quantity, 20);
  assert.equal(stored.inventory[0].restock.lastCycle, 1);
});

test('a failed travel run can hand off to a later successful run after the location is restored', async () => {
  const shop = makeShop({
    locationId: 'home',
    automation: {
      travel: { enabled: true, locationIds: ['loc-a', 'loc-b'], anchorTime: BASE, intervalSeconds: 3600, lastCycle: -1 },
    },
  });
  const store = createFakeStore({
    shops: [shop],
    locations: [normalizeLocation({ id: 'loc-a', name: 'A' })],
  });
  const service = makeService({ store, now: () => BASE + 3600 });

  const first = await service.runShop(shop.id);
  assert.equal(first.status, 'error');
  assert.equal(first.error, 'travel-location-missing');

  store._locations.set('loc-b', normalizeLocation({ id: 'loc-b', name: 'B' }));
  const second = await service.runShop(shop.id);
  assert.equal(second.status, 'ok');
  assert.equal(second.locationId, 'loc-b');

  const stored = store._shops.get(shop.id);
  assert.equal(stored.automation.travel.lastCycle, 1);
  assert.equal(stored.locationId, 'loc-b');
  assert.equal(stored.automation.diagnostics.lastStatus, 'ok');
});

// ---------------------------------------------------------------- GM gating

test('automation guards on GM before any store read', async () => {
  const shop = makeShop({});
  const store = createFakeStore({
    shops: [shop],
    locations: [normalizeLocation({ id: 'home', name: 'Home' })],
  });
  const service = makeService({ store, gmActive: false, now: () => BASE + 3600 });

  const all = await service.runAll();
  assert.deepEqual(all, { status: 'idle', summaries: [] });
  assert.equal(store.calls.listShops, 0);

  const one = await service.runShop(shop.id);
  assert.deepEqual(one, { status: 'idle', shopId: shop.id });
  assert.equal(store.calls.findShop, 0);

  const diag = await service.getDiagnostics();
  assert.deepEqual(diag, { status: 'idle', diagnostics: [] });
  assert.equal(store.calls.listShops, 0);
});

// ---------------------------------------------------------------- failures

test('a thrown store.updateShop does not advance cycles and is retried', async () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const store = createFakeStore({ shops: [shop] });
  let fail = true;
  const original = store.updateShop.bind(store);
  store.updateShop = (id, patch) => {
    if (fail) {
      fail = false;
      throw new Error('store write failed');
    }
    return original(id, patch);
  };
  const service = makeService({ store, now: () => BASE + 3600 });

  const first = await service.runShop(shop.id);
  assert.equal(first.status, 'error');
  assert.match(first.error, /store write failed/);
  const stored = store._shops.get(shop.id);
  assert.equal(stored.inventory[0].quantity, 5, 'no partial write');
  assert.equal(stored.inventory[0].restock.lastCycle, -1, 'cycle not advanced');

  const second = await service.runShop(shop.id);
  assert.equal(second.status, 'ok');
  const after = store._shops.get(shop.id);
  assert.equal(after.inventory[0].quantity, 20);
  assert.equal(after.inventory[0].restock.lastCycle, 1);
});

// ---------------------------------------------------------------- bounded returns

test('runAll processes shops independently and skips a stale shop id', async () => {
  const a = makeShop({
    id: 'shopA',
    inventory: [
      makeEntry({
        quantity: 5,
        restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
      }),
    ],
  });
  const b = makeShop({ id: 'shopB' });
  const store = createFakeStore({ shops: [a, b] });
  const service = makeService({ store, now: () => BASE + 3600 });

  const all = await service.runAll();
  assert.equal(all.status, 'ok');
  assert.equal(all.summaries.length, 2);
  assert.equal(all.summaries[0].status, 'ok');
  assert.equal(all.summaries[1].status, 'idle');
});

test('runAll skips a shop removed between listShops and processShop', async () => {
  const a = makeShop({
    id: 'shopA',
    inventory: [
      makeEntry({
        quantity: 5,
        restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
      }),
    ],
  });
  const store = createFakeStore({ shops: [a] });
  store.listShops = async () => [store._shops.get('shopA'), { id: 'ghost', name: 'Gone' }];
  const service = makeService({ store, now: () => BASE + 3600 });

  const all = await service.runAll();
  assert.equal(all.status, 'ok');
  assert.equal(all.summaries.length, 2);
  assert.equal(all.summaries[0].status, 'ok');
  assert.equal(all.summaries[1].status, 'idle');
  assert.equal(all.summaries[1].shopId, 'ghost');
});

test('runAll and getDiagnostics never return unbounded data', async () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({
    inventory: [entry],
    automation: {
      diagnostics: { lastStatus: 'error', lastError: 'x'.repeat(500), lastRestocked: 0, lastLocationId: 'home' },
    },
  });
  const store = createFakeStore({ shops: [shop] });
  const service = makeService({ store, now: () => BASE + 3600 });

  const all = await service.runAll();
  assert.equal(all.status, 'ok');
  assert.equal(all.summaries.length, 1);
  assert.equal(all.summaries[0].status, 'ok');

  const diag = await service.getDiagnostics(shop.id);
  assert.equal(diag.status, 'ok');
  assert.equal(diag.diagnostics.length, 1);
  const d = diag.diagnostics[0];
  assert.deepEqual(
    Object.keys(d).sort(),
    ['lastError', 'lastLocationId', 'lastRestocked', 'lastRunAt', 'lastStatus', 'shopId'].sort()
  );
  assert.ok(d.lastError.length <= 200, 'lastError is capped at 200');
  assert.ok(d.lastRestocked <= 1, 'lastRestocked is bounded by inventory length');
});

test('getDiagnostics returns a normalized summary after a successful run', async () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const store = createFakeStore({ shops: [shop] });
  const service = makeService({ store, now: () => BASE + 3600 });

  await service.runShop(shop.id);
  const diag = await service.getDiagnostics(shop.id);
  assert.equal(diag.status, 'ok');
  assert.equal(diag.diagnostics.length, 1);
  const d = diag.diagnostics[0];
  assert.equal(d.shopId, shop.id);
  assert.equal(d.lastStatus, 'ok');
  assert.equal(d.lastRestocked, 1);
  assert.equal(d.lastLocationId, 'home');
  assert.equal(d.lastError, '');
});

// ---------------------------------------------------------------- invalid world time

test('runShop returns invalid-world-time for an invalid now() and writes nothing', async () => {
  const badTimes = [
    Number.NaN,
    undefined,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  for (const bad of badTimes) {
    const entry = makeEntry({
      quantity: 5,
      restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
    });
    const shop = makeShop({ inventory: [entry] });
    const store = createFakeStore({ shops: [shop] });
    const service = makeService({ store, now: () => bad });

    const summary = await service.runShop(shop.id);
    assert.equal(summary.status, 'error');
    assert.equal(summary.error, 'invalid-world-time');
    assert.equal(store.calls.findShop, 0, 'no shop read before the clock validation');
    assert.equal(store.calls.updateShop, 0, 'no shop write for an invalid clock');

    const stored = store._shops.get(shop.id);
    assert.equal(stored.inventory[0].quantity, 5, 'stock unchanged');
    assert.equal(stored.inventory[0].restock.lastCycle, -1, 'cycle marker not advanced');
  }
});

test('runAll returns invalid-world-time before listing any shop', async () => {
  const shop = makeShop({});
  const store = createFakeStore({
    shops: [shop],
    locations: [normalizeLocation({ id: 'home', name: 'Home' })],
  });
  const service = makeService({ store, now: () => Number.NaN });

  const all = await service.runAll();
  assert.equal(all.status, 'error');
  assert.equal(all.error, 'invalid-world-time');
  assert.deepEqual(all.summaries, []);
  assert.equal(store.calls.listShops, 0, 'no shop read for an invalid clock');
});

// ------------------------------------------------------- active-GM rechecks

test('runShop returns idle when the GM hands off while the queued operation runs inside the lock', async () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const store = createFakeStore({ shops: [shop] });
  const flag = { gm: true };
  const service = createAutomationService({
    store,
    runShopExclusive: (shopId, fn) => {
      // The GM hands off while this operation is queued behind the lock.
      flag.gm = false;
      return fn();
    },
    isActiveGM: () => flag.gm,
    now: () => BASE + 3600,
    logger: { error: () => {} },
  });

  const summary = await service.runShop(shop.id);
  assert.deepEqual(summary, { status: 'idle', shopId: shop.id });
  assert.equal(store.calls.findShop, 0, 'no store read when the GM handed off inside the lock');
  assert.equal(store.calls.updateShop, 0, 'no store write when the GM handed off');
});

test('runShop returns idle when the GM hands off between the store read and the write', async () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const store = createFakeStore({ shops: [shop] });
  let gm = true;
  const origFind = store.findShop.bind(store);
  store.findShop = async (id) => {
    const s = await origFind(id);
    gm = false; // handoff after the read, before the write
    return s;
  };
  const service = createAutomationService({
    store,
    isActiveGM: () => gm,
    now: () => BASE + 3600,
    logger: { error: () => {} },
  });

  const summary = await service.runShop(shop.id);
  assert.deepEqual(summary, { status: 'idle', shopId: shop.id });
  assert.equal(store.calls.updateShop, 0, 'no write after a mid-run GM handoff');
  const stored = store._shops.get(shop.id);
  assert.equal(stored.inventory[0].quantity, 5, 'stock unchanged');
  assert.equal(stored.inventory[0].restock.lastCycle, -1, 'cycle marker not advanced');
});

// ------------------------------------------------------------- invalid locations

test('runShop returns invalid-locations for a malformed non-array listLocations', async () => {
  const shop = makeShop({
    locationId: 'home',
    automation: {
      travel: { enabled: true, locationIds: ['loc-a', 'loc-b'], anchorTime: BASE, intervalSeconds: 3600, lastCycle: -1 },
    },
  });
  const store = createFakeStore({ shops: [shop] });
  store.listLocations = async () => ({ bogus: true });
  const service = makeService({ store, now: () => BASE + 3600 });

  const summary = await service.runShop(shop.id);
  assert.equal(summary.status, 'error');
  assert.equal(summary.error, 'invalid-locations');
  assert.equal(store.calls.updateShop, 0, 'no write for a malformed location list');
});

test('runAll continues to the next shop after an invalid-locations shop', async () => {
  const a = makeShop({
    id: 'shopA',
    locationId: 'home',
    automation: {
      travel: { enabled: true, locationIds: ['loc-a', 'loc-b'], anchorTime: BASE, intervalSeconds: 3600, lastCycle: -1 },
    },
  });
  const b = makeShop({
    id: 'shopB',
    inventory: [
      makeEntry({
        quantity: 5,
        restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
      }),
    ],
  });
  const store = createFakeStore({ shops: [a, b] });
  store.listLocations = async () => ({ bogus: true });
  const service = makeService({ store, now: () => BASE + 3600 });

  const all = await service.runAll();
  assert.equal(all.status, 'ok');
  assert.equal(all.summaries.length, 2);
  assert.equal(all.summaries[0].status, 'error');
  assert.equal(all.summaries[0].error, 'invalid-locations');
  assert.equal(all.summaries[0].shopId, 'shopA');
  assert.equal(all.summaries[1].status, 'ok');
  assert.equal(all.summaries[1].shopId, 'shopB');
});

// ------------------------------------------------------- shop-update-failed

test('runShop treats a null store.updateShop as shop-update-failed (disappearing shop)', async () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const store = createFakeStore({ shops: [shop] });
  store.updateShop = async () => null;
  const service = makeService({ store, now: () => BASE + 3600 });

  const summary = await service.runShop(shop.id);
  assert.equal(summary.status, 'error');
  assert.equal(summary.error, 'shop-update-failed');
  const stored = store._shops.get(shop.id);
  assert.equal(stored.inventory[0].quantity, 5, 'no partial write on a null update');
  assert.equal(stored.inventory[0].restock.lastCycle, -1, 'cycle marker not advanced');
});

test('runShop treats a null diagnostics-only updateShop as shop-update-failed', async () => {
  const shop = makeShop({
    locationId: 'home',
    automation: {
      travel: { enabled: true, locationIds: ['loc-a', 'loc-b'], anchorTime: BASE, intervalSeconds: 3600, lastCycle: -1 },
    },
  });
  const store = createFakeStore({
    shops: [shop],
    locations: [normalizeLocation({ id: 'loc-a', name: 'A' })],
  });
  store.updateShop = async () => null;
  const service = makeService({ store, now: () => BASE + 3600 });

  const summary = await service.runShop(shop.id);
  assert.equal(summary.status, 'error');
  assert.equal(summary.error, 'shop-update-failed');
});
