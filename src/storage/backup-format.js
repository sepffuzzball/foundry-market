// Portable import/export format for the market core.
//
// This module is pure and Node-importable (no Foundry globals, no store writes,
// no runtime). It validates and normalizes a self-contained
// "foundry-market-portable" backup and plans a collision-safe import into a
// target world, remapping every top-level cross-reference so an imported backup
// can never silently reference a stale id from another world.
//
// The portable backup carries ONLY locations and shops. Ledger records,
// reputation records/events and advanced orders are deliberately EXCLUDED as
// they are not portable across worlds (they are idempotency-keyed runtime
// state). The backup is explicitly GM-private: every shop is written in full
// normalized form, including private item snapshots, per-entry access gates,
// `commerce.valuations`, and all `automation` config - never a player-facing
// `publicShop` projection. Shop actor references (NPC actorUuid, entry access,
// specials and valuation actorUuid) are kept as-is and reported as potentially
// stale, because the import cannot remap a world Actor UUID it does not know.

import {
  normalizeLocation,
  normalizeShop,
  makeId as defaultMakeId,
  assertMarketId,
} from '../services/model.js';

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_FORMAT = 'foundry-market-portable';

// A single portable backup is bounded to these top-level record counts.
export const MAX_BACKUP_LOCATIONS = 1000;
export const MAX_BACKUP_SHOPS = 1000;

// The serialized UTF-8 payload may be at most 5 MiB. This bound is enforced
// against the RAW input (before any normalization), so an oversized backup -
// including an oversized field the normalizer would discard - is rejected
// without ever deep-cloning or traversing it. The effectful service that
// reads a backup request/file must cap that read to MAX_BACKUP_BYTES as well,
// so an over-large payload is refused before it is even parsed into memory.
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

// Generated import ids are bounded to the same 120-char market id rule the
// schema uses (REPUTATION_ID_MAX) so they never violate the identifier format.
const ID_MAX = 120;

/**
 * Serialize `raw` to a JSON string while validating that it is a plain,
 * JSON-serializable tree, and return the UTF-8 byte length.
 *
 * The walk never mutates the caller's objects (no sentinel property is added to
 * any node), so a deeply frozen, non-extensible valid input is accepted as-is.
 * Cycle detection uses an ancestor WeakSet plus an explicit path stack rather
 * than a per-object marker. The walk itself rejects invalid values (functions,
 * non-plain prototypes, BigInt) and circular references with the offending path,
 * so the raw backup is validated AND size-bounded BEFORE any deep clone or
 * normalization. This keeps an oversized raw payload - including an oversized
 * field a normalizer would discard - off the slow clone/traversal path. The
 * walk is refused as soon as a problem is found, so an over-large or malformed
 * input fails fast rather than being fully traversed.
 *
 * Throws on any function, any non-plain object prototype (Date, RegExp, Map,
 * Set, class instance), any circular reference, and any BigInt (which
 * `JSON.stringify` rejects outright).
 */
function rawBackupJsonBytes(raw) {
  // Walk the raw tree WITHOUT mutating the caller's objects: no sentinel
  // property is ever added to a node (so a deeply frozen, non-extensible input
  // is accepted unchanged), and circular detection uses an ancestor WeakSet plus
  // an explicit path stack instead of a per-object marker. The walk rejects
  // functions, non-plain prototypes, BigInt and circular references before
  // `JSON.stringify` runs, then measures the serialized UTF-8 size on the
  // already-validated tree - so an oversized raw payload is still refused before
  // any deep clone or normalization.
  const ancestors = new WeakSet();
  const pathStack = [];

  function pathOf() {
    let out = 'backup';
    for (const seg of pathStack) {
      out += seg.array ? `[${seg.key}]` : `.${seg.key}`;
    }
    return out;
  }

  function walk(node) {
    if (node === undefined) return; // dropped by JSON.stringify
    const t = typeof node;
    if (t === 'bigint') {
      throw new Error(
        `[market] '${pathOf()}' contains a BigInt, which is not valid JSON`
      );
    }
    if (t === 'function') {
      throw new Error(`[market] '${pathOf()}' must not contain functions`);
    }
    if (t !== 'object' || node === null) return;

    const proto = Object.getPrototypeOf(node);
    if (!Array.isArray(node) && proto !== Object.prototype && proto !== null) {
      throw new Error(
        `[market] '${pathOf()}' must be a plain object, got ` +
          `'${proto?.constructor?.name || 'null'}' prototype`
      );
    }
    if (ancestors.has(node)) {
      throw new Error(`[market] '${pathOf()}' contains a circular reference`);
    }
    ancestors.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        pathStack.push({ array: true, key: String(i) });
        walk(node[i]);
        pathStack.pop();
      }
    } else {
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (child === undefined) continue; // dropped by JSON.stringify
        pathStack.push({ array: false, key });
        walk(child);
        pathStack.pop();
      }
    }
    ancestors.delete(node);
  }

  walk(raw);
  return utf8ByteLength(JSON.stringify(raw));
}

/**
 * Whether any shop carries a world Actor UUID reference that cannot be remapped
 * on import (NPC actorUuid, per-entry access actorUuids, specials actorUuids or
 * any commerce valuation). Used to surface a staleness warning.
 */
function hasActorReferences(shops) {
  for (const shop of shops) {
    for (const npc of shop.npcs || []) {
      if (npc.actorUuid) return true;
    }
    for (const entry of shop.inventory || []) {
      if (entry.access?.actorUuids?.length) return true;
    }
    for (const special of shop.commerce?.specials || []) {
      if (special.actorUuids?.length) return true;
    }
    if (shop.commerce?.valuations?.length) return true;
  }
  return false;
}

function hasActorReferencesAny(backup) {
  return hasActorReferences(backup.shops || []);
}

/**
 * Validate and normalize a portable backup.
 *
 * Accepts a v1 `{ format: 'foundry-market-portable', formatVersion: 1,
 * locations, shops }` backup, or a v0 legacy `{ version: 0, locations, shops }`
 * backup (migrated to v1 only when every source object is a valid
 * location/shop that normalizes). Rejects future/unknown format versions. Every
 * location and shop is re-normalized into a deep, plain, safe clone; the input
 * is never mutated. The result is `{ format, formatVersion, locations, shops,
 * warnings }`.
 *
 * @param {object} raw - the raw backup payload.
 * @returns {{ format: string, formatVersion: number, locations: object[],
 *   shops: object[], warnings: string[] }} the deep-normalized safe clones.
 */
export function normalizeBackup(raw = {}) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[market] backup must be a plain object');
  }

  // --- format detection -----------------------------------------------------
  if (raw.format === BACKUP_FORMAT) {
    // v1 (or a future/unknown version of the same format).
    if (raw.formatVersion !== BACKUP_FORMAT_VERSION) {
      if (typeof raw.formatVersion === 'number' && raw.formatVersion > BACKUP_FORMAT_VERSION) {
        throw new Error(
          `[market] unsupported future backup format version ${raw.formatVersion}`
        );
      }
      throw new Error(`[market] unsupported backup format version ${raw.formatVersion}`);
    }
  } else if (raw.version === 0) {
    // v0 legacy - migrate below by re-normalizing every record.
  } else {
    throw new Error('[market] unsupported backup format');
  }

  // --- early raw-size bound + plain-JSON safety check -----------------------
  // Serialize the RAW input (validating it is a plain JSON tree) and measure
  // its UTF-8 size BEFORE any deep clone or normalization. An over-large
  // payload - even one whose oversized fields a normalizer would discard - is
  // rejected here rather than after a costly clone/traversal.
  const rawBytes = rawBackupJsonBytes(raw);
  if (rawBytes > MAX_BACKUP_BYTES) {
    throw new Error(
      `[market] backup exceeds ${MAX_BACKUP_BYTES} bytes UTF-8 (${rawBytes})`
    );
  }

  const rawLocations = raw.locations;
  const rawShops = raw.shops;
  if (rawLocations != null && !Array.isArray(rawLocations)) {
    throw new Error('[market] backup.locations must be an array');
  }
  if (rawShops != null && !Array.isArray(rawShops)) {
    throw new Error('[market] backup.shops must be an array');
  }
  const locationsSrc = rawLocations ?? [];
  const shopsSrc = rawShops ?? [];

  if (locationsSrc.length > MAX_BACKUP_LOCATIONS) {
    throw new Error(
      `[market] backup.locations must contain at most ${MAX_BACKUP_LOCATIONS} locations, ` +
        `got ${locationsSrc.length}`
    );
  }
  if (shopsSrc.length > MAX_BACKUP_SHOPS) {
    throw new Error(
      `[market] backup.shops must contain at most ${MAX_BACKUP_SHOPS} shops, ` +
        `got ${shopsSrc.length}`
    );
  }

  // --- deep normalization ---------------------------------------------------
  // Every source location and shop must carry an explicit, valid source id
  // before normalization: normalizeLocation/normalizeShop would otherwise
  // auto-generate a missing id, which is not allowed for a portable backup.
  const locations = locationsSrc.map((loc, i) => {
    if (loc == null || typeof loc !== 'object' || Array.isArray(loc)) {
      throw new Error(`[market] backup.locations[${i}] must be an object`);
    }
    assertMarketId(loc.id, `backup.locations[${i}].id`);
    return normalizeLocation(loc);
  });
  const shops = shopsSrc.map((shop, i) => {
    if (shop == null || typeof shop !== 'object' || Array.isArray(shop)) {
      throw new Error(`[market] backup.shops[${i}] must be an object`);
    }
    assertMarketId(shop.id, `backup.shops[${i}].id`);
    return normalizeShop(shop);
  });

  // --- referential integrity ------------------------------------------------
  const locIds = new Set();
  for (const loc of locations) {
    if (locIds.has(loc.id)) {
      throw new Error(`[market] duplicate location id '${loc.id}'`);
    }
    locIds.add(loc.id);
  }
  const shopIds = new Set();
  for (const shop of shops) {
    if (shopIds.has(shop.id)) {
      throw new Error(`[market] duplicate shop id '${shop.id}'`);
    }
    shopIds.add(shop.id);
  }
  for (const shop of shops) {
    if (!locIds.has(shop.locationId)) {
      throw new Error(
        `[market] shop '${shop.id}' references missing location '${shop.locationId}'`
      );
    }
  }
  for (const shop of shops) {
    for (const lid of shop.automation?.travel?.locationIds || []) {
      if (!locIds.has(lid)) {
        throw new Error(
          `[market] shop '${shop.id}' travel references missing location '${lid}'`
        );
      }
    }
  }
  // An NPC record may carry an embedded shopId cross-reference. When one is
  // present (non-empty) it must point at a shop that exists in this backup;
  // a stale reference from another world fails closed instead of importing.
  for (const shop of shops) {
    for (const npc of shop.npcs || []) {
      if (npc.shopId && !shopIds.has(npc.shopId)) {
        throw new Error(
          `[market] shop '${shop.id}' NPC references missing shop '${npc.shopId}'`
        );
      }
    }
  }

  const result = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    locations,
    shops,
    warnings: [],
  };

  // --- serialized size bound ------------------------------------------------
  const bytes = utf8ByteLength(JSON.stringify(result));
  if (bytes > MAX_BACKUP_BYTES) {
    throw new Error(
      `[market] backup exceeds ${MAX_BACKUP_BYTES} bytes UTF-8 (${bytes})`
    );
  }

  // --- cross-world staleness warnings ---------------------------------------
  if (hasActorReferencesAny(result)) {
    result.warnings.push(
      'Shop references to world Actor UUIDs (NPC actorUuid, entry access, specials, ' +
        'valuations) may be stale when imported into another world.'
    );
  }

  return result;
}

function utf8ByteLength(str) {
  return new TextEncoder().encode(str).length;
}

/**
 * Generate a fresh, distinct, 120-char-bounded id that does not collide with
 * any id already in `used`. The callback is the injected id generator; it is
 * called with no argument (the schema default), and any returned value longer
 * than the id bound is truncated. A degenerate generator that keeps returning a
 * used id (for example an exhausted counter) falls back to a deterministic
 * `<base>_<n>` suffix after a bounded number of attempts.
 */
function uniqueId(used, makeIdFn) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let id = makeIdFn();
    if (typeof id !== 'string' || id === '') id = defaultMakeId();
    if (id.length > ID_MAX) id = id.slice(0, ID_MAX);
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  let base = makeIdFn();
  if (typeof base !== 'string' || base === '') base = 'id';
  if (base.length > ID_MAX - 8) base = base.slice(0, ID_MAX - 8);
  let suffix = 0;
  for (;;) {
    const id = `${base}_${suffix}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
    suffix++;
  }
}

/** Deep-clone a plain JSON tree into brand-new plain objects/arrays. */
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const proto = Object.getPrototypeOf(value);
  const out = proto === null ? Object.create(null) : {};
  for (const key of Object.keys(value)) {
    // On an object with a normal prototype, assigning `out['__proto__'] = ...`
    // would redirect the clone's prototype instead of creating an own data
    // property, silently dropping a real `__proto__` field. Define it as an own
    // enumerable data property so a clone never loses such a field.
    if (key === '__proto__') {
      Object.defineProperty(out, '__proto__', {
        value: deepClone(value[key]),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      out[key] = deepClone(value[key]);
    }
  }
  return out;
}

/**
 * Plan a collision-safe import of a backup into a target world.
 *
 * `backup` may be a v1 or v0 backup (or the output of `normalizeBackup`):
 * `planBackupImport` ALWAYS calls `normalizeBackup` first and plans against the
 * normalized data, so a hand-crafted raw partial array is never accepted
 * silently. Every imported top-level location and shop receives a fresh,
 * distinct id that avoids `existingLocationIds`, `existingShopIds` AND every
 * source location/shop id (source ids are reserved across both namespaces, so a
 * generated location id can never collide with a source shop id or vice versa)
 * and is bounded to 120 chars. Shop `locationId` and
 * `automation.travel.locationIds` are remapped through the new location ids,
 * and any embedded `shopId` reference present on an NPC record is remapped
 * through the new shop ids. Inventory entry ids are preserved (they are only
 * meaningful within a shop). Stale automation clock state is not carried across
 * worlds: each inventory entry's `restock.lastCycle`, each shop's
 * `automation.travel.lastCycle` and the whole `automation.diagnostics` block are
 * reset to their defaults while the automation/restock configuration is
 * retained. The input backup is never mutated.
 *
 * Returns `{ locations, shops, warnings }` where `locations`/`shops` are deep
 * clones with the new ids and remapped references, and `warnings` reports any
 * backup-level and inventory-level concerns (cross-world Actor UUID staleness
 * and inventory entries depending on a stale/secondary item source).
 *
 * @param {{ format?: string, formatVersion?: number, version?: number,
 *   locations: object[], shops: object[] }} backup - a portable backup.
 * @param {{ existingLocationIds?: string[], existingShopIds?: string[],
 *   makeId?: () => string }} opts - the target-world id universe and id generator.
 * @returns {{ locations: object[], shops: object[], warnings: string[] }}
 */
export function planBackupImport(
  backup,
  { existingLocationIds = [], existingShopIds = [], makeId = defaultMakeId } = {}
) {
  // Always normalize first: plan against the validated, normalized records and
  // never accept a crafted raw partial array.
  const normalized = normalizeBackup(backup);
  const locations = normalized.locations;
  const shops = normalized.shops;

  const used = new Set();
  for (const id of existingLocationIds) used.add(String(id));
  for (const id of existingShopIds) used.add(String(id));
  // Reserve every source location AND shop id, so freshly generated ids are
  // fresh across either namespace - a generated location id never collides with
  // a source shop id, and a generated shop id never collides with a source
  // location id.
  for (const loc of locations) {
    if (loc?.id != null) used.add(String(loc.id));
  }
  for (const shop of shops) {
    if (shop?.id != null) used.add(String(shop.id));
  }

  // Fresh ids for every location, and the old->new location id map.
  const locationIdMap = new Map();
  const newLocations = [];
  for (const loc of locations) {
    const oldId = loc?.id;
    const newId = uniqueId(used, makeId);
    if (oldId != null) locationIdMap.set(oldId, newId);
    const clone = deepClone(loc);
    clone.id = newId;
    newLocations.push(clone);
  }

  // Fresh ids for every shop (two passes, so NPC shopId references that point
  // at a later shop can be remapped after the full shop id map is known).
  const shopIdMap = new Map();
  for (const shop of shops) {
    if (shop?.id != null) shopIdMap.set(shop.id, uniqueId(used, makeId));
  }

  const newShops = shops.map((shop) => {
    const clone = deepClone(shop);
    clone.id = shopIdMap.get(shop.id) ?? uniqueId(used, makeId);

    // Remap the shop's location reference and the travel schedule location ids.
    if (typeof clone.locationId === 'string') {
      clone.locationId = locationIdMap.get(clone.locationId) ?? clone.locationId;
    }
    const travel = clone.automation?.travel;
    if (travel) {
      if (Array.isArray(travel.locationIds)) {
        travel.locationIds = travel.locationIds.map(
          (lid) => locationIdMap.get(lid) ?? lid
        );
      }
      // Do not carry a stale travel cycle marker across worlds.
      travel.lastCycle = -1;
    }

    // Reset the automation diagnostics to their defaults while retaining the
    // hours/travel/event configuration.
    if (clone.automation) {
      clone.automation.diagnostics = {
        lastRunAt: null,
        lastStatus: 'never',
        lastError: '',
        lastRestocked: 0,
        lastLocationId: '',
      };
    }

    // Reset every inventory entry's restock cycle marker (config retained).
    if (Array.isArray(clone.inventory)) {
      for (const entry of clone.inventory) {
        if (entry?.restock) {
          entry.restock.lastCycle = -1;
        }
      }
    }

    // Remap any embedded shopId reference present on an NPC record.
    if (Array.isArray(clone.npcs)) {
      for (const npc of clone.npcs) {
        if (npc && typeof npc.shopId === 'string') {
          npc.shopId = shopIdMap.get(npc.shopId) ?? npc.shopId;
        }
      }
    }

    return clone;
  });

  return {
    locations: newLocations,
    shops: newShops,
    warnings: [...normalized.warnings, ...buildImportWarnings(shops)],
  };
}

function buildImportWarnings(shops) {
  const warnings = [];
  let staleUuidCount = 0;
  let snapOnlyCount = 0;
  for (const shop of shops) {
    for (const entry of shop.inventory || []) {
      if (entry.itemUuid) {
        staleUuidCount++;
      } else {
        snapOnlyCount++;
      }
    }
  }
  if (staleUuidCount > 0) {
    warnings.push(
      `${staleUuidCount} inventory entr${
        staleUuidCount === 1 ? 'y' : 'ies'
      } reference an itemUuid that may be stale in the target world; the ` +
        'embedded snapshot is the retained source secondary reference.'
    );
  }
  if (snapOnlyCount > 0) {
    warnings.push(
      `${snapOnlyCount} inventory entr${
        snapOnlyCount === 1 ? 'y' : 'ies'
      } have no itemUuid and use an embedded snapshot as the sole source ` +
        '(a live item reference is unsupported for these entries).'
    );
  }
  return warnings;
}
