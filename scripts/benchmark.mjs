// M6 manual performance benchmark for normalization / public catalog / policy
// at large inventory sizes.
//
// This script is OPTIONAL and manual - run it with `npm run benchmark`, or
// directly with `node scripts/benchmark.mjs [entryCount]`. It imports only
// Foundry-free functions (no runtime, no network), runs warm-up iterations and
// then 100 measured iterations per workload, and prints a median / p95 (ms)
// report plus the entry count to stdout.
//
// It never writes files or leaves artifacts, so it cannot trip a lint/clean
// check. The deterministic O(N) guarantees are asserted in
// `tests/performance.test.js`; this script is a human-facing timing report only,
// so it deliberately uses raw wall-clock timings.

import { performance } from 'node:perf_hooks';

import { normalizeShop } from '../src/services/model.js';
import { buildCatalog } from '../src/core/requests.js';
import { planAutomation } from '../src/automation/policy.js';

const ENTRY_COUNT = Number(process.argv[2]) || 1000;
const SERVICE_COUNT = 20;
const SPECIAL_COUNT = 20;
const WARMUP = 10;
const ITERATIONS = 100;
const WORLD_TIME = 10000; // inside hours, past the restock anchor, cycle due

function makeRawShop(entryCount) {
  const inventory = [];
  for (let i = 0; i < entryCount; i++) {
    inventory.push({
      id: `item-${i}`,
      itemUuid: `Compendium.world.Item.item-${i}`,
      name: `Item ${i}`,
      quantity: (i % 10) + 1,
      stockMode: 'finite',
      stockVisibility: 'exact',
      price: (i % 50) * 10 + 5,
      visible: true,
      restock: { enabled: true, target: 10, intervalSeconds: 3600, anchorTime: 0, lastCycle: -1 },
    });
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

function percentile(sortedSamples, p) {
  if (sortedSamples.length === 0) return 0;
  const index = Math.min(sortedSamples.length - 1, Math.floor(p * sortedSamples.length));
  return sortedSamples[index];
}

function measure(workload) {
  // Warm-up (discarded) so the first JIT/alloc-heavy call does not skew the p95.
  for (let i = 0; i < WARMUP; i += 1) workload();

  const samples = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = performance.now();
    workload();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  };
}

const rawShop = makeRawShop(ENTRY_COUNT);
const shop = normalizeShop(rawShop);

const normalize = measure(() => normalizeShop(rawShop));
const catalog = measure(() => buildCatalog(shop, { worldTime: WORLD_TIME }));
const policy = measure(() => planAutomation(shop, WORLD_TIME));

const report = [
  `foundry-market M6 benchmark`,
  ``,
  `entry count: ${ENTRY_COUNT}`,
  ``,
  `workload        median (ms)   p95 (ms)`,
  `---------------------------------------`,
  `normalization   ${normalize.medianMs.toFixed(3).padStart(9)}   ${normalize.p95Ms.toFixed(3).padStart(7)}`,
  `public catalog  ${catalog.medianMs.toFixed(3).padStart(9)}   ${catalog.p95Ms.toFixed(3).padStart(7)}`,
  `policy          ${policy.medianMs.toFixed(3).padStart(9)}   ${policy.p95Ms.toFixed(3).padStart(7)}`,
  ``,
  `measured over ${ITERATIONS} iterations after ${WARMUP} warmups; wall-clock (not a CI gate)`,
].join('\n');

process.stdout.write(`${report}\n`);
