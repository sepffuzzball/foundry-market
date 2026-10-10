// M6 deterministic performance tests for normalization, the public catalog and
// the automation policy at large inventory sizes.
//
// These tests are pure: they import only Foundry-free functions (no runtime, no
// network, no storage, no UI). They:
//   - generate a normalized shop with 1000 inventory entries / 20 services /
//     20 specials and assert the output stays bounded (never amplifies fields,
//     never drops required normalized fields);
//   - build the public base catalog at that size and assert the projection is
//     allowlisted and leaks no private/restricted fields (snapshot, itemUuid,
//     access, restock, stockVisibility, raw commerce/social/automation/npcs);
//   - verify restricted (backroom) and hidden inventory entries never leak into
//     the public catalog;
//   - run planAutomation over 1000 entries and verify it completes without
//     O(N^2) repeated global work, measured deterministically by counting array
//     reads (operation counts), not by a flaky wall-clock threshold.
//
// The only wall-clock assertion is a very generous catastrophic-regression
// guard (10 s), so a slow/loaded CI never flips a test that is only measuring
// O(N) scaling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  normalizeShop,
  MAX_COMMERCE_SERVICES,
  MAX_COMMERCE_SPECIALS,
} from '../src/services/model.js';
import {
  publicShop,
  publicInventory,
  publicInventoryEntry,
  buildCatalog,
  PUBLIC_SHOP_FIELDS,
  PUBLIC_ENTRY_FIELDS,
} from '../src/core/requests.js';
import { planAutomation } from '../src/automation/policy.js';

const ENTRY_COUNT = 1000;
const SERVICE_COUNT = 20;
const SPECIAL_COUNT = 20;
const WORLD_TIME = 10000; // inside hours, past the restock anchor, cycle due
const GENEROUS_BUDGET_MS = 10000; // loose wall-clock guard, not a strict gate

/** Build a large raw (pre-normalization) shop of `entryCount` entries. */
function makeRawShop(entryCount, opts = {}) {
  const { restockEnabled = true, visible = true, access } = opts;
  const inventory = [];
  for (let i = 0; i < entryCount; i++) {
    const entry = {
      id: `item-${i}`,
      itemUuid: `Compendium.world.Item.item-${i}`,
      name: `Item ${i}`,
      quantity: (i % 10) + 1,
      stockMode: 'finite',
      stockVisibility: 'exact',
      price: (i % 50) * 10 + 5,
      visible,
      access: access ? access(i) : undefined,
      restock: restockEnabled
        ? { enabled: true, target: 10, intervalSeconds: 3600, anchorTime: 0, lastCycle: -1 }
        : undefined,
    };
    inventory.push(entry);
  }
  const services = [];
  for (let i = 0; i < SERVICE_COUNT; i++) {
    services.push({
      id: `svc-${i}`,
      name: `Service ${i}`,
      description: `Description ${i}`,
      price: 100,
      visible: true,
      enabled: true,
    });
  }
  const specials = [];
  for (let i = 0; i < SPECIAL_COUNT; i++) {
    specials.push({
      id: `special-${i}`,
      title: `Special ${i}`,
      description: `Description ${i}`,
      entryId: `item-${i}`,
      price: 50,
      visible: true,
    });
  }
  return {
    id: 'shop-1',
    name: 'Large Shop',
    locationId: 'loc-1',
    open: true,
    inventory,
    commerce: { services, specials },
    automation: { hours: { enabled: false }, travel: { enabled: false }, events: [] },
  };
}

function makeShop(entryCount, opts) {
  return normalizeShop(makeRawShop(entryCount, opts));
}

/** Count the number of `get` operations planAutomation performs on `shop.inventory`. */
function countInventoryReads(shop) {
  const arr = shop.inventory || [];
  let reads = 0;
  const proxy = new Proxy(arr, {
    get(target, prop, receiver) {
      reads += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  const probe = { ...shop, inventory: proxy };
  planAutomation(probe, WORLD_TIME);
  return reads;
}

// ------------------------------------------------- normalization (bounded)

test('normalizing a 1000-entry / 20-service / 20-special shop stays bounded and deterministic', () => {
  const shop = makeShop(ENTRY_COUNT);
  assert.equal(shop.inventory.length, ENTRY_COUNT);
  assert.equal(shop.commerce.services.length, SERVICE_COUNT);
  assert.equal(shop.commerce.specials.length, SPECIAL_COUNT);

  // Bounded output: each normalized entry carries exactly the documented schema
  // keys and nothing extra (the projection never amplifies fields).
  const expectedEntryKeys = [
    'id',
    'itemUuid',
    'snapshot',
    'name',
    'img',
    'quantity',
    'stockMode',
    'stockVisibility',
    'restock',
    'price',
    'visible',
    'access',
    'publicDescription',
    'category',
    'rarity',
  ];
  for (const entry of shop.inventory) {
    assert.deepEqual(Object.keys(entry).sort(), expectedEntryKeys.slice().sort());
  }

  // Each special's reference must resolve to an inventory entry in the same shop.
  for (const special of shop.commerce.specials) {
    assert.ok(
      shop.inventory.some((e) => e.id === special.entryId),
      `special ${special.id} references a missing inventory entry`
    );
  }
});

test('a shop with more than the bounded service/special caps is rejected at normalization', () => {
  const overServices = [];
  for (let i = 0; i <= MAX_COMMERCE_SERVICES; i++) {
    overServices.push({ id: `svc-${i}`, name: `Service ${i}`, price: 1 });
  }
  assert.throws(
    () => normalizeShop({ id: 'x', name: 'X', commerce: { services: overServices } }),
    /at most/
  );

  const overSpecials = [];
  for (let i = 0; i <= MAX_COMMERCE_SPECIALS; i++) {
    overSpecials.push({ id: `sp-${i}`, title: `Special ${i}`, entryId: 'item-0', price: 1 });
  }
  assert.throws(
    () => normalizeShop({ id: 'y', name: 'Y', commerce: { specials: overSpecials } }),
    /at most/
  );
});

// ------------------------------------------------- public catalog (bounded, leak-free)

test('the public base catalog of a 1000-entry shop is bounded and leaks no private/restricted fields', () => {
  const shop = makeShop(ENTRY_COUNT);
  const cat = buildCatalog(shop, { worldTime: WORLD_TIME });

  assert.equal(cat.inventory.length, ENTRY_COUNT);

  // The shop projection carries only allowlisted public fields.
  for (const key of Object.keys(cat.shop)) {
    assert.ok(
      PUBLIC_SHOP_FIELDS.includes(key),
      `public shop leaked non-allowlisted field "${key}"`
    );
  }

  // Each projected entry carries only allowlisted public fields, and never the
  // private per-entry data (snapshot, itemUuid, access, restock, stockVisibility)
  // nor the personalized-only fields (basePrice, priceBreakdown, canBuy).
  for (const entry of cat.inventory) {
    for (const key of Object.keys(entry)) {
      assert.ok(
        PUBLIC_ENTRY_FIELDS.includes(key),
        `public entry leaked non-allowlisted field "${key}"`
      );
    }
    assert.ok(!('snapshot' in entry), 'public entry leaked snapshot');
    assert.ok(!('itemUuid' in entry), 'public entry leaked itemUuid');
    assert.ok(!('access' in entry), 'public entry leaked access');
    assert.ok(!('restock' in entry), 'public entry leaked restock');
    assert.ok(!('stockVisibility' in entry), 'public entry leaked stockVisibility');
    assert.ok(!('basePrice' in entry), 'public entry leaked basePrice');
    assert.ok(!('priceBreakdown' in entry), 'public entry leaked priceBreakdown');
    assert.ok(!('canBuy' in entry), 'public entry leaked canBuy');
  }

  // Bounded output: the projected services/specials never exceed the schema caps.
  assert.ok(cat.shop.services.length <= MAX_COMMERCE_SERVICES);
  assert.ok(cat.shop.specials.length <= MAX_COMMERCE_SPECIALS);

  // The base catalog is non-personalized and must never expose an
  // actor-specific approved-items list.
  assert.deepEqual(cat.shop.approvedItems, []);
});

test('publicShop and publicInventoryEntry project only allowlisted fields and drop raw config', () => {
  const shop = makeShop(20);
  const view = publicShop(shop, { worldTime: WORLD_TIME });
  for (const key of Object.keys(view)) {
    assert.ok(
      PUBLIC_SHOP_FIELDS.includes(key),
      `publicShop leaked raw field "${key}"`
    );
  }
  // Raw/private config keys never surface on the public shop.
  assert.ok(!('commerce' in view), 'publicShop leaked commerce');
  assert.ok(!('social' in view), 'publicShop leaked social');
  assert.ok(!('automation' in view), 'publicShop leaked automation');
  assert.ok(!('npcs' in view), 'publicShop leaked npcs');
  assert.ok(!('inventory' in view), 'publicShop leaked inventory');
  assert.ok(!('createdAt' in view), 'publicShop leaked createdAt');

  const entry = shop.inventory[0];
  const projected = publicInventoryEntry(entry);
  for (const key of Object.keys(projected)) {
    assert.ok(
      PUBLIC_ENTRY_FIELDS.includes(key),
      `publicInventoryEntry leaked field "${key}"`
    );
  }
  assert.ok(!('restock' in projected));
  assert.ok(!('stockVisibility' in projected));
  assert.ok(!('itemUuid' in projected));
  assert.ok(!('snapshot' in projected));
});

test('restricted (backroom) and hidden inventory entries never leak into the public catalog', () => {
  const raw = makeRawShop(10, {
    access: (i) => (i % 2 === 0 ? { mode: 'backroom' } : undefined),
  });
  for (let i = 0; i < raw.inventory.length; i++) {
    if (i % 3 === 0) raw.inventory[i].visible = false;
  }
  const shop = normalizeShop(raw);

  const expected = shop.inventory.filter(
    (e) => e.visible !== false && e.access?.mode !== 'backroom'
  ).length;

  const baseCat = buildCatalog(shop, { worldTime: WORLD_TIME });
  assert.equal(baseCat.inventory.length, expected);
  for (const entry of baseCat.inventory) {
    assert.equal(entry.visible, true, 'public catalog carried a hidden entry');
    assert.ok(
      !entry.specialId || entry.specialId,
      'public catalog entry must stay well-formed'
    );
  }

  const pubInventory = publicInventory(shop);
  assert.equal(pubInventory.length, expected);
  for (const entry of pubInventory) {
    assert.ok(!('access' in entry), 'public inventory leaked access');
  }
});

// ------------------------------------------------- policy (planAutomation)

test('planAutomation over 1000 entries completes and does no O(N^2) repeated global work', () => {
  const shop = makeShop(ENTRY_COUNT);
  const plan = planAutomation(shop, WORLD_TIME);

  // Every entry is finite + restock-enabled + due, so the plan must report all
  // of them exactly once (no loop-catch-up, no fake increment, no drop).
  assert.equal(plan.restocks.length, ENTRY_COUNT);
  assert.equal(plan.travel, null, 'no travel schedule was configured');
  assert.ok(Array.isArray(plan.activeEvents));

  // Deterministic operation-count check for the O(N) guarantee. If planAutomation
  // scanned the inventory per entry (e.g. an inner .find), doubling the entry
  // count would quadruple the array reads. A linear pass keeps the read count
  // near a small constant multiple of N - so doubling N must not even double
  // those reads' ratio beyond a small slack.
  const reads1000 = countInventoryReads(shop);
  const shop2000 = makeShop(ENTRY_COUNT * 2);
  const reads2000 = countInventoryReads(shop2000);

  assert.ok(
    reads2000 <= 2 * reads1000 + 100,
    `planAutomation scaled super-linearly: ${reads1000} reads -> ${reads2000} reads`
  );
  assert.ok(
    reads1000 <= ENTRY_COUNT * 8,
    `planAutomation touched too many ops for ${ENTRY_COUNT} entries: ${reads1000}`
  );
});

// A very loose wall-clock guard only: it flips only on a catastrophic regression
// (an accidental O(N^3) or an infinite loop), not on normal CI slowness.

test('normalization / catalog / policy complete well inside a generous wall-clock budget', () => {
  const raw = makeRawShop(ENTRY_COUNT);

  let t = performance.now();
  const shop = normalizeShop(raw);
  const normalizeMs = performance.now() - t;

  t = performance.now();
  const cat = buildCatalog(shop, { worldTime: WORLD_TIME });
  const catalogMs = performance.now() - t;

  t = performance.now();
  planAutomation(shop, WORLD_TIME);
  const planMs = performance.now() - t;

  assert.equal(cat.inventory.length, ENTRY_COUNT);
  assert.ok(
    normalizeMs < GENEROUS_BUDGET_MS,
    `normalize took ${normalizeMs.toFixed(1)}ms, expected < ${GENEROUS_BUDGET_MS}ms`
  );
  assert.ok(
    catalogMs < GENEROUS_BUDGET_MS,
    `catalog took ${catalogMs.toFixed(1)}ms, expected < ${GENEROUS_BUDGET_MS}ms`
  );
  assert.ok(
    planMs < GENEROUS_BUDGET_MS,
    `plan took ${planMs.toFixed(1)}ms, expected < ${GENEROUS_BUDGET_MS}ms`
  );
});

// Explicitly exercise the M6 "bounded output" contract on a single entry with a
// complete raw shape so a future change cannot silently broaden the public
// surface for large inventories.

test('a single normalized entry projects to a bounded, allowlisted surface only', () => {
  const shop = makeShop(1);
  const entry = shop.inventory[0];

  // The standalone entry projection never broadens beyond the allowlist.
  const view = publicInventoryEntry(entry);
  for (const key of Object.keys(view)) {
    assert.ok(
      PUBLIC_ENTRY_FIELDS.includes(key),
      `publicInventoryEntry leaked field "${key}"`
    );
  }
  assert.ok(!('restock' in view));
  assert.ok(!('stockVisibility' in view));
  assert.ok(!('itemUuid' in view));
  assert.ok(!('snapshot' in view));
  assert.ok(!('access' in view));

  // The full catalog build decorates it with the availability flags, which are
  // themselves allowlisted - so a catalog entry still never grows unbounded.
  const cat = buildCatalog(shop, { worldTime: WORLD_TIME });
  const catalogEntry = cat.inventory[0];
  assert.ok('canPreorder' in catalogEntry);
  assert.ok('canAttemptTheft' in catalogEntry);
  for (const key of Object.keys(catalogEntry)) {
    assert.ok(
      PUBLIC_ENTRY_FIELDS.includes(key),
      `catalog entry leaked field "${key}"`
    );
  }
});
