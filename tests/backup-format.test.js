// Unit tests for the pure portable import/export backup format. No Foundry
// globals and no store writes are required; all normalization and import
// planning is driven directly against the pure module.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  MAX_BACKUP_LOCATIONS,
  MAX_BACKUP_SHOPS,
  MAX_BACKUP_BYTES,
  normalizeBackup,
  planBackupImport,
} from '../src/storage/backup-format.js';
import {
  normalizeLocation,
  normalizeShop,
  makeId,
} from '../src/services/model.js';

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
  description = '',
  createdAt = 1,
} = {}) {
  return {
    id,
    name,
    locationId,
    description,
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
  itemUuid = '',
  snapshot,
  access = {},
  restock,
  visible = true,
} = {}) {
  const snap =
    snapshot !== undefined ? snapshot : JSON.stringify({ name });
  return {
    id,
    name,
    price,
    quantity,
    stockMode: 'finite',
    visible,
    itemUuid,
    snapshot: snap,
    access,
    restock,
  };
}

function rawV1({ locations, shops, formatVersion = 1 } = {}) {
  return {
    format: BACKUP_FORMAT,
    formatVersion,
    locations: locations || [],
    shops: shops || [],
  };
}

// Recursively freeze a plain JSON tree so a test can prove a valid backup is
// accepted unchanged (a normalization bug that mutates/deduplicates the input
// would throw or add a sentinel property on a non-extensible object).
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

const defaultsWarnings = [];

// ---------------------------------------------------------------- format

test('normalizeBackup returns the canonical v1 shape from a valid v1 backup', () => {
  const rawLocation = loc({ id: 'L1', name: 'Town' });
  const rawShop = shop({
    id: 'S1',
    name: 'General Store',
    locationId: 'L1',
    inventory: [entry({ id: 'e1', access: {} })],
  });
  const raw = rawV1({ locations: [rawLocation], shops: [rawShop] });

  const out = normalizeBackup(raw);
  assert.equal(out.format, BACKUP_FORMAT);
  assert.equal(out.formatVersion, BACKUP_FORMAT_VERSION);
  assert.ok(Array.isArray(out.locations) && out.locations.length === 1);
  assert.ok(Array.isArray(out.shops) && out.shops.length === 1);
  assert.ok(Array.isArray(out.warnings));
  assert.deepEqual(out.warnings, defaultsWarnings);

  // The normalized clones are the canonical normalize() outputs.
  const expectedLocation = normalizeLocation(rawLocation);
  const expectedShop = normalizeShop(rawShop);
  assert.deepEqual(out.locations[0], expectedLocation);
  assert.deepEqual(out.shops[0], expectedShop);
});

test('normalizeBackup never mutates the input backup (v1)', () => {
  const rawLocation = loc({ id: 'L1', name: 'Town' });
  const rawShop = shop({ id: 'S1', name: 'Store', locationId: 'L1' });
  const raw = rawV1({ locations: [rawLocation], shops: [rawShop] });
  const before = JSON.stringify(raw);

  const out = normalizeBackup(raw);

  assert.equal(JSON.stringify(raw), before, 'input raw unchanged');
  // The output is a deep clone: mutating it never changes the input.
  out.locations[0].name = 'Mutated';
  out.shops[0].name = 'Mutated';
  assert.equal(raw.locations[0].name, 'Town');
  assert.equal(raw.shops[0].name, 'Store');
  assert.equal(raw.locations[0].id, 'L1');
  assert.equal(raw.shops[0].id, 'S1');
});

test('normalizeBackup accepts a deeply frozen valid input and adds no sentinel property', () => {
  const rawLocation = loc({ id: 'L1', name: 'Town' });
  const rawShop = shop({
    id: 'S1',
    name: 'Store',
    locationId: 'L1',
    inventory: [entry({ id: 'e1', access: {} })],
  });
  const raw = rawV1({ locations: [rawLocation], shops: [rawShop] });
  deepFreeze(raw);

  const out = normalizeBackup(raw);

  assert.equal(out.format, BACKUP_FORMAT);
  assert.equal(out.formatVersion, BACKUP_FORMAT_VERSION);
  assert.deepEqual(out.locations[0], normalizeLocation(rawLocation));
  assert.deepEqual(out.shops[0], normalizeShop(rawShop));
  // No sentinel property was added to any caller-owned object while walking the
  // raw tree (the deep freeze would have thrown if it had tried to).
  assert.equal('__marketBackupPath' in raw, false);
  assert.equal('__marketBackupPath' in raw.locations, false);
  assert.equal('__marketBackupPath' in raw.locations[0], false);
  assert.equal('__marketBackupPath' in raw.shops[0].inventory[0], false);

  // planBackupImport also handles the frozen valid input without mutating it.
  const plan = planBackupImport(raw, { makeId: () => 'G' });
  assert.equal(plan.locations.length, 1);
  assert.equal(plan.shops.length, 1);
  assert.equal(plan.shops[0].locationId, plan.locations[0].id);
});

// ---------------------------------------------------------------- migration

test('normalizeBackup migrates a v0 legacy backup to v1', () => {
  const rawLocation = loc({ id: 'L1', name: 'Town' });
  const rawShop = shop({ id: 'S1', name: 'Store', locationId: 'L1' });
  const legacy = { version: 0, locations: [rawLocation], shops: [rawShop] };

  const out = normalizeBackup(legacy);

  assert.equal(out.format, BACKUP_FORMAT);
  assert.equal(out.formatVersion, BACKUP_FORMAT_VERSION);
  assert.deepEqual(out.locations[0], normalizeLocation(rawLocation));
  assert.deepEqual(out.shops[0], normalizeShop(rawShop));
  assert.deepEqual(out.warnings, defaultsWarnings);
});

test('normalizeBackup migration is identical to an explicit v1 backup', () => {
  const rawLocation = loc({ id: 'L1', name: 'Town' });
  const rawShop = shop({ id: 'S1', name: 'Store', locationId: 'L1' });
  const legacy = { version: 0, locations: [rawLocation], shops: [rawShop] };
  const explicit = rawV1({ locations: [rawLocation], shops: [rawShop] });

  assert.deepEqual(normalizeBackup(legacy), normalizeBackup(explicit));
});

test('normalizeBackup rejects a v0 legacy backup with an invalid source object', () => {
  // A shop missing its name must fail closed rather than being migrated.
  const badShop = shop({ id: 'S1', locationId: 'L1' });
  delete badShop.name;
  assert.throws(
    () => normalizeBackup({ version: 0, locations: [loc({ id: 'L1' })], shops: [badShop] }),
    /shop\.name/
  );
  // A location missing its name must fail closed too.
  const badLoc = { id: 'L1', createdAt: 1 };
  assert.throws(
    () => normalizeBackup({ version: 0, locations: [badLoc], shops: [] }),
    /location\.name/
  );
});

// ---------------------------------------------------------------- unknown format

test('normalizeBackup rejects a non-object / non-array top level', () => {
  assert.throws(() => normalizeBackup(null), /plain object/);
  assert.throws(() => normalizeBackup([]), /plain object/);
  assert.throws(() => normalizeBackup('x'), /plain object/);
  assert.throws(() => normalizeBackup(() => ({})), /plain object/);
});

test('normalizeBackup rejects an unknown format marker', () => {
  assert.throws(
    () => normalizeBackup({ format: 'other', locations: [], shops: [] }),
    /unsupported backup format/
  );
  assert.throws(
    () => normalizeBackup({ locations: [], shops: [] }),
    /unsupported backup format/
  );
});

test('normalizeBackup rejects a future and an unknown format version', () => {
  assert.throws(
    () => normalizeBackup(rawV1({ formatVersion: 2 })),
    /future backup format version/
  );
  assert.throws(
    () => normalizeBackup({ format: BACKUP_FORMAT, formatVersion: 0, locations: [], shops: [] }),
    /unsupported backup format version 0/
  );
  assert.throws(
    () => normalizeBackup({ format: BACKUP_FORMAT, formatVersion: '1', locations: [], shops: [] }),
    /unsupported backup format version/
  );
});

// ---------------------------------------------------------------- caps

test('normalizeBackup enforces the 1000 location / 1000 shop caps', () => {
  const manyLocs = Array.from({ length: MAX_BACKUP_LOCATIONS + 1 }, (_, i) =>
    loc({ id: `L${i}`, name: `Town ${i}` })
  );
  assert.throws(
    () => normalizeBackup(rawV1({ locations: manyLocs, shops: [] })),
    /at most 1000 locations/
  );

  const manyShops = Array.from({ length: MAX_BACKUP_SHOPS + 1 }, (_, i) =>
    shop({ id: `S${i}`, name: `Store ${i}`, locationId: 'L1' })
  );
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [loc({ id: 'L1' })], shops: manyShops })),
    /at most 1000 shops/
  );

  // Exactly at the cap is accepted.
  const atCapLocs = Array.from({ length: MAX_BACKUP_LOCATIONS }, (_, i) =>
    loc({ id: `L${i}`, name: `Town ${i}` })
  );
  const atCapShops = Array.from({ length: MAX_BACKUP_SHOPS }, (_, i) =>
    shop({ id: `S${i}`, name: `Store ${i}`, locationId: 'L1' })
  );
  const out = normalizeBackup(rawV1({ locations: atCapLocs, shops: atCapShops }));
  assert.equal(out.locations.length, MAX_BACKUP_LOCATIONS);
  assert.equal(out.shops.length, MAX_BACKUP_SHOPS);
});

// ---------------------------------------------------------------- duplicate ids

test('normalizeBackup rejects duplicate location ids', () => {
  const locations = [loc({ id: 'L1' }), loc({ id: 'L1' })];
  assert.throws(
    () => normalizeBackup(rawV1({ locations, shops: [] })),
    /duplicate location id 'L1'/
  );
});

test('normalizeBackup rejects duplicate shop ids', () => {
  const shops = [
    shop({ id: 'S1', locationId: 'L1' }),
    shop({ id: 'S1', locationId: 'L1' }),
  ];
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [loc({ id: 'L1' })], shops })),
    /duplicate shop id 'S1'/
  );
});

// ---------------------------------------------------------------- missing references

test('normalizeBackup rejects a shop referencing a missing location', () => {
  const shops = [shop({ id: 'S1', locationId: 'MISSING' })];
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [loc({ id: 'L1' })], shops })),
    /shop 'S1' references missing location 'MISSING'/
  );
});

test('normalizeBackup rejects a shop with an empty location reference', () => {
  const shops = [shop({ id: 'S1', locationId: '' })];
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [loc({ id: 'L1' })], shops })),
    /missing location ''/
  );
});

test('normalizeBackup rejects travel locationIds that reference a missing location', () => {
  const automation = {
    travel: {
      enabled: true,
      locationIds: ['L1', 'MISSING'],
      intervalSeconds: 86400,
      lastCycle: -1,
    },
  };
  const shops = [shop({ id: 'S1', locationId: 'L1', automation })];
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [loc({ id: 'L1' })], shops })),
    /travel references missing location 'MISSING'/
  );
});

// ---------------------------------------------------------------- deep invalid

test('normalizeBackup rejects a deep invalid nested field', () => {
  // An inventory entry with no name fails closed.
  const badEntry = { id: 'e1', itemUuid: '', snapshot: JSON.stringify({ name: 'Potion' }) };
  const shops = [shop({ id: 'S1', locationId: 'L1', inventory: [badEntry] })];
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [loc({ id: 'L1' })], shops })),
    /entry\.name/
  );

  // An inventory entry with no item source (no uuid and no snapshot) fails closed.
  const noSource = { id: 'e1', name: 'Potion', itemUuid: '' };
  const shops2 = [shop({ id: 'S1', locationId: 'L1', inventory: [noSource] })];
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [loc({ id: 'L1' })], shops: shops2 })),
    /entry\.itemUuid/
  );

  // A location with no name fails closed.
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [{ id: 'L1', createdAt: 1 }], shops: [] })),
    /location\.name/
  );

  // A non-array locations field fails closed.
  assert.throws(
    () => normalizeBackup(rawV1({ locations: 'nope', shops: [] })),
    /backup\.locations must be an array/
  );
});

// ---------------------------------------------------------------- plain JSON only

test('normalizeBackup rejects functions anywhere in the payload', () => {
  const fields = { fn: () => 1 };
  const locations = [{ id: 'L1', name: 'Town', createdAt: 1, ...fields }];
  assert.throws(
    () => normalizeBackup(rawV1({ locations, shops: [] })),
    /must not contain functions/
  );
});

test('normalizeBackup rejects non-plain object prototypes', () => {
  class Foo {}
  const f = new Foo();
  f.id = 'L1';
  f.name = 'Town';
  f.createdAt = 1;
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [f], shops: [] })),
    /plain object/
  );

  const withDate = loc({ id: 'L2', name: 'Town' });
  withDate.when = new Date();
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [withDate], shops: [] })),
    /plain object/
  );
});

test('normalizeBackup rejects circular references', () => {
  const l = loc({ id: 'L1', name: 'Town' });
  l.self = l;
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [l], shops: [] })),
    /circular reference/
  );
});

test('normalizeBackup rejects BigInt values', () => {
  const l = loc({ id: 'L1', name: 'Town' });
  l.big = 1n;
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [l], shops: [] })),
    /BigInt/
  );
});

// ---------------------------------------------------------------- serialized size

test('normalizeBackup rejects a payload exceeding the 5 MiB UTF-8 bound', () => {
  const big = 'a'.repeat(MAX_BACKUP_BYTES + 100);
  const raw = rawV1({
    locations: [loc({ id: 'L1' })],
    shops: [shop({ id: 'S1', locationId: 'L1', description: big })],
  });
  assert.throws(() => normalizeBackup(raw), /exceeds .* bytes UTF-8/);
});

// ---------------------------------------------------------------- private export

test('the portable backup is GM-private and never a player projection', () => {
  const valuation = {
    id: 'v1',
    actorUuid: 'Actor.abc',
    itemId: 'Item.1',
    amount: 100,
    fingerprint: 'aaaaaaaaaaaaaaaa',
  };
  const inventory = [
    entry({
      id: 'e1',
      name: 'Potion',
      access: { mode: 'backroom', minReputation: -50 },
      restock: { enabled: true, target: 5, intervalSeconds: 3600, lastCycle: 3 },
    }),
  ];
  const rawShop = shop({
    id: 'S1',
    locationId: 'L1',
    inventory,
    commerce: { valuations: [valuation], funds: 100 },
    automation: { travel: { enabled: true, locationIds: ['L1', 'L2'], intervalSeconds: 86400, lastCycle: 4 } },
  });
  const out = normalizeBackup(
    rawV1({ locations: [loc({ id: 'L1' }), loc({ id: 'L2' })], shops: [rawShop] })
  );
  const s = out.shops[0];

  // Private item snapshots, per-entry access gates and restock config survive.
  assert.equal(s.inventory[0].snapshot, JSON.stringify({ name: 'Potion' }));
  assert.equal(s.inventory[0].access.mode, 'backroom');
  assert.equal(s.inventory[0].restock.enabled, true);
  assert.equal(s.inventory[0].restock.lastCycle, 3);

  // GM-private valuations + funds and the automation config survive.
  assert.equal(s.commerce.valuations.length, 1);
  assert.equal(s.commerce.valuations[0].actorUuid, 'Actor.abc');
  assert.equal(s.commerce.funds, 100);
  assert.equal(s.automation.travel.enabled, true);
  assert.equal(s.automation.travel.lastCycle, 4);

  // Actor references surface a staleness warning.
  assert.ok(out.warnings.some((w) => /Actor UUID/i.test(w)));
});

// ---------------------------------------------------------------- import planning

test('planBackupImport gives every imported record a fresh distinct id', () => {
  const raw = rawV1({
    locations: [loc({ id: 'L1' }), loc({ id: 'L2' })],
    shops: [
      shop({
        id: 'S1',
        locationId: 'L1',
        automation: { travel: { enabled: true, locationIds: ['L1', 'L2'], intervalSeconds: 86400, lastCycle: 5 } },
        inventory: [entry({ id: 'e1' })],
      }),
    ],
  });
  const backup = normalizeBackup(raw);

  let seq = 0;
  const makeId = () => `N${seq++}`;
  const plan = planBackupImport(backup, {
    existingLocationIds: [],
    existingShopIds: [],
    makeId,
  });

  assert.deepEqual(plan.locations.map((l) => l.id), ['N0', 'N1']);
  assert.deepEqual(plan.shops.map((s) => s.id), ['N2']);
  // Every top-level id is fresh and distinct.
  const ids = [...plan.locations.map((l) => l.id), ...plan.shops.map((s) => s.id)];
  assert.equal(new Set(ids).size, ids.length);
});

test('planBackupImport is collision-safe against existing world ids', () => {
  const backup = normalizeBackup(
    rawV1({ locations: [loc({ id: 'L1' })], shops: [shop({ id: 'S1', locationId: 'L1' })] })
  );

  let seq = 0;
  const makeId = () => `N${seq++}`;
  // 'N0' is already used by an existing location; the import must skip it.
  const plan = planBackupImport(backup, {
    existingLocationIds: ['N0'],
    existingShopIds: [],
    makeId,
  });
  assert.equal(plan.locations[0].id, 'N1');
  assert.equal(plan.shops[0].id, 'N2');
  // The new ids stay within the 120-char bound.
  for (const l of plan.locations) assert.ok(l.id.length <= 120);
  for (const s of plan.shops) assert.ok(s.id.length <= 120);
});

test('planBackupImport remaps locationId, travel ids and embedded NPC shopId', () => {
  const raw = rawV1({
    locations: [loc({ id: 'L1' }), loc({ id: 'L2' })],
    shops: [
      shop({
        id: 'S1',
        name: 'First',
        locationId: 'L1',
        npcs: [{ id: 'n1', name: 'Bob', shopId: 'S2' }],
        automation: { travel: { enabled: true, locationIds: ['L1', 'L2'], intervalSeconds: 86400 } },
      }),
      shop({ id: 'S2', name: 'Second', locationId: 'L2' }),
    ],
  });
  const backup = normalizeBackup(raw);

  let seq = 0;
  const makeId = () => `X${seq++}`;
  const plan = planBackupImport(backup, { makeId });
  const [s1, s2] = plan.shops;

  // Location ids were all remapped.
  const newL1 = plan.locations[0].id;
  const newL2 = plan.locations[1].id;
  assert.equal(s1.locationId, newL1);
  assert.equal(s2.locationId, newL2);
  assert.deepEqual(s1.automation.travel.locationIds, [newL1, newL2]);

  // The embedded NPC shopId reference is remapped to the new shop (not S2).
  const newS2 = plan.shops[1].id;
  assert.equal(s1.npcs[0].shopId, newS2);
  assert.notEqual(s1.npcs[0].shopId, 'S2');

  // Inventory entry ids are preserved (not regenerated).
  assert.equal(s1.inventory[0]?.id ?? 'e1', 'e1');
});

test('planBackupImport preserves inventory entry ids within new shops', () => {
  const raw = rawV1({
    locations: [loc({ id: 'L1' })],
    shops: [shop({ id: 'S1', locationId: 'L1', inventory: [entry({ id: 'keep-me' })] })],
  });
  const backup = normalizeBackup(raw);
  const plan = planBackupImport(backup, { makeId: () => 'G' });
  assert.equal(plan.shops[0].inventory[0].id, 'keep-me');
});

test('planBackupImport resets stale automation clock state and diagnostics', () => {
  const inventory = [
    entry({
      id: 'e1',
      restock: { enabled: true, target: 5, intervalSeconds: 3600, anchorTime: 42, lastCycle: 3 },
    }),
  ];
  const automation = {
    hours: { enabled: true, days: [0, 1], openMinute: 60, closeMinute: 720 },
    travel: { enabled: true, locationIds: ['L1', 'L2'], intervalSeconds: 86400, anchorTime: 7, lastCycle: 9 },
    events: [],
    diagnostics: { lastRunAt: 111, lastStatus: 'ok', lastError: 'x', lastRestocked: 4, lastLocationId: 'L1' },
  };
  const raw = rawV1({
    locations: [loc({ id: 'L1' }), loc({ id: 'L2' })],
    shops: [shop({ id: 'S1', locationId: 'L1', inventory, automation })],
  });
  const backup = normalizeBackup(raw);
  const plan = planBackupImport(backup, { makeId: () => 'G' });
  const s = plan.shops[0];

  // Cycle markers and diagnostics reset to defaults.
  assert.equal(s.inventory[0].restock.lastCycle, -1);
  assert.equal(s.automation.travel.lastCycle, -1);
  assert.deepEqual(s.automation.diagnostics, {
    lastRunAt: null,
    lastStatus: 'never',
    lastError: '',
    lastRestocked: 0,
    lastLocationId: '',
  });

  // Configuration is retained.
  assert.equal(s.inventory[0].restock.target, 5);
  assert.equal(s.inventory[0].restock.intervalSeconds, 3600);
  assert.equal(s.inventory[0].restock.anchorTime, 42);
  assert.equal(s.automation.travel.enabled, true);
  assert.equal(s.automation.travel.anchorTime, 7);
  assert.deepEqual(s.automation.hours.days, [0, 1]);
});

test('planBackupImport never mutates the input backup', () => {
  const inventory = [entry({ id: 'e1', restock: { enabled: true, target: 5, intervalSeconds: 3600, lastCycle: 3 } })];
  const automation = { travel: { enabled: true, locationIds: ['L1', 'L2'], intervalSeconds: 86400, lastCycle: 9 } };
  const raw = rawV1({
    locations: [loc({ id: 'L1' }), loc({ id: 'L2' })],
    shops: [shop({ id: 'S1', locationId: 'L1', inventory, automation })],
  });
  const backup = normalizeBackup(raw);
  const before = JSON.stringify(backup);

  const plan = planBackupImport(backup, { makeId: () => 'G' });

  assert.equal(JSON.stringify(backup), before, 'backup unchanged');
  assert.equal(backup.shops[0].automation.travel.lastCycle, 9);
  assert.equal(backup.shops[0].inventory[0].restock.lastCycle, 3);
  assert.equal(backup.shops[0].id, 'S1');
});

test('planBackupImport reports a stale inventory itemUuid source', () => {
  const inventory = [
    entry({ id: 'e1', itemUuid: 'Compendium.books.Item.x', snapshot: JSON.stringify({ name: 'Potion' }) }),
  ];
  const raw = rawV1({
    locations: [loc({ id: 'L1' })],
    shops: [shop({ id: 'S1', locationId: 'L1', inventory })],
  });
  const backup = normalizeBackup(raw);
  const plan = planBackupImport(backup, { makeId: () => 'G' });
  assert.ok(plan.warnings.some((w) => /may be stale/i.test(w)));
  assert.ok(plan.warnings.some((w) => /snapshot/i.test(w)));
});

test('planBackupImport reports a snapshot-only source (no live itemUuid)', () => {
  const inventory = [entry({ id: 'e1', itemUuid: '', snapshot: JSON.stringify({ name: 'Potion' }) })];
  const raw = rawV1({
    locations: [loc({ id: 'L1' })],
    shops: [shop({ id: 'S1', locationId: 'L1', inventory })],
  });
  const backup = normalizeBackup(raw);
  const plan = planBackupImport(backup, { makeId: () => 'G' });
  assert.ok(plan.warnings.some((w) => /no itemUuid/i.test(w)));
  assert.ok(plan.warnings.some((w) => /snapshot/i.test(w)));
});

test('a degenerate constant makeId still yields distinct bounded ids', () => {
  const backup = normalizeBackup(
    rawV1({
      locations: [loc({ id: 'L1' }), loc({ id: 'L2' })],
      shops: [shop({ id: 'S1', locationId: 'L1' })],
    })
  );
  const plan = planBackupImport(backup, { makeId: () => 'X' });
  const ids = [...plan.locations.map((l) => l.id), ...plan.shops.map((s) => s.id)];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.ok(id.length <= 120);
    assert.ok(id.length > 0);
  }
});

// ---------------------------------------------------------------- explicit source ids

test('normalizeBackup requires explicit valid source ids for every location', () => {
  // A location with no id must fail closed (never auto-generate one).
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [loc({ name: 'Town' })], shops: [] })),
    /backup\.locations\[0\]\.id/
  );
  // An empty-string id is not an explicit source id.
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [loc({ id: '' })], shops: [] })),
    /backup\.locations\[0\]\.id/
  );
  // An id violating the market id rule is rejected too.
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [loc({ id: 'a'.repeat(121) })], shops: [] })),
    /backup\.locations\[0\]\.id/
  );
  // A v0 legacy backup is held to the same explicit-id rule.
  assert.throws(
    () => normalizeBackup({ version: 0, locations: [loc({ name: 'Town' })], shops: [] }),
    /backup\.locations\[0\]\.id/
  );
});

test('normalizeBackup requires explicit valid source ids for every shop', () => {
  assert.throws(
    () => normalizeBackup(
      rawV1({ locations: [loc({ id: 'L1' })], shops: [shop({ name: 'Store', locationId: 'L1' })] })
    ),
    /backup\.shops\[0\]\.id/
  );
  // A v0 legacy backup is held to the same explicit-id rule.
  assert.throws(
    () => normalizeBackup(
      { version: 0, locations: [loc({ id: 'L1' })], shops: [shop({ name: 'Store', locationId: 'L1' })] }
    ),
    /backup\.shops\[0\]\.id/
  );
});

// ---------------------------------------------------------------- stale NPC shopId

test('normalizeBackup rejects an NPC shopId pointing to an unknown source shop', () => {
  const shops = [
    shop({
      id: 'S1',
      locationId: 'L1',
      npcs: [{ id: 'n1', name: 'Bob', shopId: 'MISSING' }],
    }),
  ];
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [loc({ id: 'L1' })], shops })),
    /NPC references missing shop 'MISSING'/
  );
});

test('normalizeBackup accepts an NPC shopId referencing a known source shop', () => {
  const shops = [
    shop({
      id: 'S1',
      locationId: 'L1',
      npcs: [{ id: 'n1', name: 'Bob', shopId: 'S2' }],
    }),
    shop({ id: 'S2', locationId: 'L1' }),
  ];
  const out = normalizeBackup(rawV1({ locations: [loc({ id: 'L1' })], shops }));
  assert.equal(out.shops[0].npcs[0].shopId, 'S2');
});

// ---------------------------------------------------------------- oversized discarded field

test('normalizeBackup rejects an oversized discarded field on the raw input', () => {
  const huge = 'a'.repeat(MAX_BACKUP_BYTES + 100);
  // `extra` is not a location field and the normalizer would drop it, but the
  // raw size bound must still reject the backup before any clone/traversal.
  const rawLoc = { id: 'L1', name: 'Town', createdAt: 1, extra: huge };
  assert.throws(
    () => normalizeBackup(rawV1({ locations: [rawLoc], shops: [] })),
    /exceeds .* bytes UTF-8/
  );
});

// ---------------------------------------------------------------- source-id reservation

test('planBackupImport skips generated ids that collide with reserved source ids', () => {
  const backup = normalizeBackup(
    rawV1({
      locations: [loc({ id: 'L1' })],
      shops: [shop({ id: 'S1', locationId: 'L1' })],
    })
  );
  // The generator's first two values are the backup's own source location and
  // source shop ids. Those are reserved across both namespaces, so they must be
  // skipped and the imported records must stay fresh.
  const seq = ['L1', 'S1', 'N0', 'N1', 'N2'];
  let i = 0;
  const plan = planBackupImport(backup, { makeId: () => seq[i++] });
  assert.deepEqual(plan.locations.map((l) => l.id), ['N0']);
  assert.deepEqual(plan.shops.map((s) => s.id), ['N1']);
});

// ---------------------------------------------------------------- plan always normalizes

test('planBackupImport always normalizes before planning', () => {
  // A v0 legacy backup is normalized and planned.
  const legacy = {
    version: 0,
    locations: [loc({ id: 'L1' })],
    shops: [shop({ id: 'S1', locationId: 'L1' })],
  };
  const plan = planBackupImport(legacy, { makeId: () => 'G' });
  assert.equal(plan.locations.length, 1);
  assert.equal(plan.shops.length, 1);

  // A raw partial array with no format marker is rejected, not accepted.
  assert.throws(
    () => planBackupImport({ locations: [loc({ id: 'L1' })], shops: [] }, { makeId: () => 'G' }),
    /unsupported backup format/
  );

  // A missing source id is rejected while normalizing.
  assert.throws(
    () => planBackupImport(rawV1({ locations: [loc({ name: 'Town' })], shops: [] })),
    /backup\.locations\[0\]\.id/
  );

  // A non-object / array plan input fails closed.
  assert.throws(() => planBackupImport(null), /plain object/);
  assert.throws(() => planBackupImport([]), /plain object/);
});

// ---------------------------------------------------------------- prototype-name ids

test('planBackupImport maps __proto__ and constructor source ids through safely', () => {
  const raw = rawV1({
    locations: [loc({ id: '__proto__' })],
    shops: [shop({ id: 'constructor', locationId: '__proto__' })],
  });
  const backup = normalizeBackup(raw);

  let seq = 0;
  const plan = planBackupImport(backup, { makeId: () => `N${seq++}` });
  assert.equal(plan.locations.length, 1);
  assert.equal(plan.shops.length, 1);

  // The shop's locationId was remapped through the freshly generated location id,
  // never left as the prototype-chain '__proto__' name, and the shop id is fresh.
  assert.equal(plan.shops[0].locationId, plan.locations[0].id);
  assert.notEqual(plan.shops[0].locationId, '__proto__');
  assert.notEqual(plan.locations[0].id, '__proto__');
  assert.notEqual(plan.shops[0].id, 'constructor');
});
