// GM-only portable backup export/import service for the market core.
//
// This module sits on top of the pure `src/storage/backup-format.js` module and
// wires it to the store. It is the ONLY module that reads/writes the store on
// behalf of a portable backup: `exportPortable()` snapshots every location and
// shop into a self-contained `foundry-market-portable` backup, and
// `importPortable(raw)` validates/plans/imports a backup into the current world.
//
// The import is deliberately GM-only and serialized on a single in-flight
// client. Every store read and write happens only while the calling user is the
// active GM (re-checked immediately before EVERY store read AND before every
// create), so a GM handover can never cause a non-GM client to write, and an
// export/import can never leak a market store read into a player session.
// `importPortable` is serialized on a module-scoped in-flight promise chain, so
// two concurrent imports (or an import racing a re-import) run one at a time on
// this client; a second import waits on the first rather than interleaving
// creates. The world read, id planning and collision preflight all run INSIDE the
// serialized run, so a queued import plans against the world the prior import
// already wrote (fresh ids never collide across concurrent imports).
//
// The backup is GM-private: it carries the FULL normalized shop records (item
// snapshots, per-entry access gates, `commerce.valuations`, commerce and
// automation config), never a player-facing `publicShop` projection. Ledger
// records, reputation records/events and advanced orders are operational runtime
// state that is deliberately excluded as not portable across worlds.
//
// Constraints honoured here:
//  - Never deletes/drops an existing record. Import only ever creates fresh
//    ids (planned away from every existing/source id), so no live record is
//    overwritten or removed. Existing shop `updateShop`/one-shop locks are not
//    relevant: importing fresh ids never updates an existing record.
//  - No cross-GM transactional import is promised. If an import is interrupted
//    after some writes (a create returned null/mismatched, a create threw, or a
//    GM handover) the records written so far REMAIN (no automatic rollback) and
//    the result reports `partial` with the bounded set of created ids. A create
//    that persisted then threw/null is detected by re-reading the store
//    (`findShop` for a shop, `listLocations` for a location): if the id is
//    present it is recorded in the partial id list, so the outcome never hides a
//    write that actually landed. A backup that fails validation/planning before
//    any write reports `error` with no raw exception string in the result.
//  - No UI/runtime change: this service is created by callers (runtime wiring
//    lands later) and its methods are Node-testable with a real store.

import {
  normalizeBackup,
  planBackupImport,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  MAX_BACKUP_LOCATIONS,
  MAX_BACKUP_SHOPS,
} from './backup-format.js';

// Module-scoped in-flight import chain. Import is serialized globally on this
// client (matching the "single active-GM import" contract); the chain is kept
// alive across rejections so one failed run never wedges later ones.
let importQueue = Promise.resolve();

function enqueueImport(run) {
  const result = importQueue.then(run, run);
  importQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

function logError(logger, message, err) {
  logger?.error?.(message, err);
}

// Bound the created-id lists reported on ok/partial results. A portable backup
// is capped at MAX_BACKUP_LOCATIONS / MAX_BACKUP_SHOPS top-level records, so
// these lists can never exceed that bound; the slice makes the bound explicit.
function boundedIds(ids, cap) {
  return ids.slice(0, cap);
}

// A create failure followed by a GM handover means the recovery re-read is
// skipped: the write may or may not have landed. The partial result carries this
// warning rather than falsely claiming the record was (or was not) created. It is
// added at most once so a multi-create interruption never floods the warnings.
function noteUncertainCreate(warnings) {
  const message =
    'a create may have persisted, but the GM handed off before the import could ' +
    're-read the store, so the created record may not be reported';
  if (!warnings.includes(message)) {
    warnings.push(message);
  }
}

/**
 * Create a GM-only portable backup service.
 *
 * @param {object} deps
 * @param {object} deps.store - the market store (`listLocations`, `listShops`,
 *   `createLocation`, `createShop`). Reads only locations/shops, so operational
 *   runtime records (ledger, reputation, advanced orders) never appear in an
 *   export.
 * @param {(shopId: string, fn: () => Promise<any>) => Promise<any>} deps.runShopExclusive
 *   A shop-scoped exclusive runner. Not used by the portable backup (importing
 *   fresh ids never updates an existing shop) but accepted for interface parity
 *   with the other GM services.
 * @param {() => boolean} deps.isActiveGM - whether the caller is the active GM.
 * @param {() => string} deps.makeId - id generator for import planning.
 * @param {{ error?: (...args: any[]) => void }} [deps.logger] - diagnostic sink.
 * @returns {{ exportPortable: () => Promise<object>,
 *   importPortable: (raw: any, opts?: { dryRun?: boolean }) => Promise<object> }}
 */
export function createBackupService({
  store,
  runShopExclusive,
  isActiveGM,
  makeId,
  logger,
}) {
  // --- export ----------------------------------------------------------------
  // Snapshots every location and shop into a self-contained portable backup.
  // The active-GM check happens BEFORE any store read, so a non-GM client never
  // touches the store on export, and it is re-checked immediately after EACH
  // awaited read (locations and shops) and once more after normalizeBackup, so a
  // GM handover - including one that lands during a deferred listShops await - can
  // never leak a half-built private backup. The returned backup is GM-private: it
  // is the full normalized shop records, never a player projection.
  async function exportPortable() {
    // The active-GM predicate is re-checked immediately before EVERY store read,
    // so a handover between them can never leak a half-built (private) backup.
    // No store read happens unless the caller is the active GM.
    if (!isActiveGM()) {
      return { status: 'error', error: 'not-active-gm' };
    }

    let locations;
    let shops;
    try {
      locations = await store.listLocations();
      // Re-check after the awaited locations read: on a handover the export stops
      // without reading shops and reports not-active-gm (nothing was created and
      // no complete private backup is returned).
      if (!isActiveGM()) {
        return { status: 'error', error: 'not-active-gm' };
      }
      shops = await store.listShops();
      // Re-check after the awaited shops read too: a handover that happens DURING
      // the listShops await (the delayed read can resolve back to a player) must
      // stop BEFORE normalizeBackup, so no GM-private backup is returned to a
      // player session.
      if (!isActiveGM()) {
        return { status: 'error', error: 'not-active-gm' };
      }
    } catch (err) {
      logError(logger, '[market] failed to list records for portable export', err);
      return { status: 'error', error: 'export-failed' };
    }

    let backup;
    try {
      backup = normalizeBackup({
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        locations,
        shops,
      });
    } catch (err) {
      logError(logger, '[market] failed to normalize portable export', err);
      return { status: 'error', error: 'export-failed' };
    }

    // Re-check once more after normalizeBackup and before returning: if the GM
    // handed off while the store reads were awaited, the export must not leak a
    // half-built private backup. Nothing has been returned yet, so the only way
    // to report this cleanly is not-active-gm with no backup/warnings.
    if (!isActiveGM()) {
      return { status: 'error', error: 'not-active-gm' };
    }

    return {
      status: 'ok',
      backup,
      warnings: [...backup.warnings],
    };
  }

  // --- import ----------------------------------------------------------------
  // Validates, plans, preflights and (unless dryRun) writes a portable backup
  // into the current world. The result never carries a raw exception string;
  // failures are translated into the documented status/error codes.
  async function importPortable(raw, { dryRun = false } = {}) {
    if (!isActiveGM()) {
      return { status: 'error', error: 'not-active-gm' };
    }

    // Validate/normalize the raw backup BEFORE any store read (only the active-GM
    // check above precedes it). This enforces the object-only, <=5 MiB, format,
    // duplicate-id and referential-integrity bounds before the store is touched.
    let normalized;
    try {
      normalized = normalizeBackup(raw);
    } catch (err) {
      logError(logger, '[market] invalid portable backup', err);
      return { status: 'error', error: 'invalid-backup' };
    }

    if (dryRun) {
      // A dry run reads and plans separately, OUTSIDE the serialized write queue:
      // it only previews the remap, so no record is read with an exclusive lock.
      // The active-GM predicate is re-checked before EVERY read inside the plan,
      // so a handover during the read stops without further reads; because a dry
      // run never writes, a handover here reports not-active-gm (nothing created).
      let world;
      try {
        world = await planIntoCurrentWorld(normalized);
      } catch (err) {
        logError(logger, '[market] portable import preflight failed', err);
        return { status: 'error', error: 'import-preflight-failed' };
      }
      if (world === null) {
        return { status: 'error', error: 'not-active-gm' };
      }
      const planned = world.planned;
      const warnings = [...planned.warnings];
      return {
        status: 'ok',
        dryRun: true,
        counts: {
          locations: planned.locations.length,
          shops: planned.shops.length,
        },
        idMap: buildImportIdMap(normalized, planned),
        warnings,
      };
    }

    // Real import: the world read, id planning and collision preflight ALL move
    // inside the serialized in-flight import chain, so two concurrent imports can
    // never plan against the same pre-write world state. The run never rejects;
    // it reports ok/partial/error as a result object.
    return enqueueImport(() => runRealImport(normalized));
  }

  // Read the current world, plan fresh collision-safe ids, and preflight the
  // planned import. Any failure (including a store read failure) is a before-write
  // failure and never touches a record. Used by BOTH the dry-run preview and the
  // serialized real import (which re-runs it fresh inside the queue so a second
  // concurrent import plans against the world the first one already wrote).
  //
  // The active-GM predicate is re-checked immediately before EVERY store read, so
  // a handover between `listLocations` and `listShops` stops cleanly without the
  // second read. Returns `null` on a handover so the caller can report
  // not-active-gm (nothing has been written yet).
  async function planIntoCurrentWorld(normalized) {
    if (!isActiveGM()) return null;
    const existingLocations = await store.listLocations();
    if (!isActiveGM()) return null;
    const existingShops = await store.listShops();
    const existingLocationIds = existingLocations.map((l) => l.id);
    const existingShopIds = existingShops.map((s) => s.id);
    const planned = planBackupImport(normalized, {
      existingLocationIds,
      existingShopIds,
      makeId,
    });
    preflightPlannedImport(planned, existingLocationIds, existingShopIds);
    return { planned, existingLocationIds, existingShopIds };
  }

  // Executes a real import inside the serialized in-flight queue. The active-GM
  // predicate is re-checked BEFORE any store read (so a handover before the first
  // read reports not-active-gm with nothing read/written), and the world read /
  // id planning / collision preflight run FRESH here - never against a stale
  // plan built outside the queue. Locations are created first, sequentially,
  // then shops (after every location), re-checking the active GM immediately
  // before each create. A create that returns a non-null matching record is
  // recorded; a create that returns null/mismatched or throws may still have
  // persisted, so the store is re-read and the id is recorded if present, then
  // the import reports `partial` - no automatic rollback. Every store read and
  // recovery re-read re-checks the active GM first, so a handover stops cleanly
  // without touching the store again.
  async function runRealImport(normalized) {
    const createdLocationIds = [];
    const createdShopIds = [];

    let planned;
    try {
      if (!isActiveGM()) {
        return { status: 'error', error: 'not-active-gm' };
      }
      const world = await planIntoCurrentWorld(normalized);
      if (world === null) {
        return { status: 'error', error: 'not-active-gm' };
      }
      planned = world.planned;
    } catch (err) {
      logError(logger, '[market] portable import preflight failed', err);
      return { status: 'error', error: 'import-preflight-failed' };
    }
    const warnings = [...planned.warnings];

    for (const location of planned.locations) {
      if (!isActiveGM()) {
        return importOutcome(createdLocationIds, createdShopIds, warnings, 'handoff');
      }
      const outcome = await createLocationRecord(location, createdLocationIds, warnings);
      if (outcome === 'created') continue;
      return importOutcome(createdLocationIds, createdShopIds, warnings, 'create');
    }

    for (const shop of planned.shops) {
      if (!isActiveGM()) {
        return importOutcome(createdLocationIds, createdShopIds, warnings, 'handoff');
      }
      const outcome = await createShopRecord(shop, createdShopIds, warnings);
      if (outcome === 'created') continue;
      return importOutcome(createdLocationIds, createdShopIds, warnings, 'create');
    }

    return {
      status: 'ok',
      createdLocationIds: boundedIds(createdLocationIds, MAX_BACKUP_LOCATIONS),
      createdShopIds: boundedIds(createdShopIds, MAX_BACKUP_SHOPS),
      warnings,
    };
  }

  // Attempt a single location create. Returns 'created' for a clean create that
  // returned a matching record; otherwise 'failed' (a null/mismatched/throw
  // create). On a 'create' failure that does NOT hand over, the location may STILL
  // have persisted - the store is re-read and, if the id is present, it is
  // recorded in `createdLocationIds` so the partial result reports id truthfully.
  // On a handover before that recovery re-read, the read is skipped and an
  // uncertain-partial warning is recorded (the write may or may not have landed);
  // no further store read is attempted.
  async function createLocationRecord(location, createdLocationIds, warnings) {
    let created = null;
    try {
      created = await store.createLocation(location);
    } catch (err) {
      logError(logger, `[market] createLocation failed for '${location.id}'`, err);
    }
    if (created != null && created.id === location.id) {
      createdLocationIds.push(location.id);
      return 'created';
    }
    // The create did not report a clean matching record, so we cannot trust the
    // return value. Re-read the store: the write may have applied and then
    // returned null/mismatched or thrown. Re-check the active GM first so a
    // handover stops without the recovery read and reports the write as
    // uncertain rather than hiding a record that may have landed.
    if (!isActiveGM()) {
      noteUncertainCreate(warnings);
      return 'failed';
    }
    try {
      const locations = await store.listLocations();
      if (locations.some((l) => l.id === location.id)) {
        createdLocationIds.push(location.id);
      }
    } catch (err) {
      logError(logger, `[market] re-read locations for '${location.id}' failed`, err);
    }
    return 'failed';
  }

  // Attempt a single shop create. Returns 'created' for a clean create that
  // returned a matching record; otherwise 'failed' (a null/mismatched/throw
  // create). On a 'create' failure that does NOT hand over, the shop may STILL
  // have persisted - the store is re-read via `findShop` and, if the id is
  // present, it is recorded in `createdShopIds` so the partial result reports the
  // id truthfully. On a handover before that recovery re-read, the read is
  // skipped and an uncertain-partial warning is recorded; no further store read
  // is attempted.
  async function createShopRecord(shop, createdShopIds, warnings) {
    let created = null;
    try {
      created = await store.createShop(shop);
    } catch (err) {
      logError(logger, `[market] createShop failed for '${shop.id}'`, err);
    }
    if (created != null && created.id === shop.id) {
      createdShopIds.push(shop.id);
      return 'created';
    }
    // The create did not report a clean matching record, so we cannot trust the
    // return value. Re-read the store: the write may have applied and then
    // returned null/mismatched or thrown. Re-check the active GM first so a
    // handover stops without the recovery read and reports the write as
    // uncertain rather than hiding a record that may have landed.
    if (!isActiveGM()) {
      noteUncertainCreate(warnings);
      return 'failed';
    }
    try {
      const found = await store.findShop(shop.id);
      if (found != null) {
        createdShopIds.push(shop.id);
      }
    } catch (err) {
      logError(logger, `[market] re-read shop '${shop.id}' failed`, err);
    }
    return 'failed';
  }

  return { exportPortable, importPortable };
}

// Build an ok/partial/error outcome.
//
// A `create` failure (null/mismatched return or a thrown create) is a write-phase
// failure: whatever was written stays (no rollback) and the result is `partial`.
// A GM `handoff` that occurs after at least one write is likewise reported as
// `partial` (the import did not complete), but a handoff before any write means
// no active GM remained and nothing was written - report `not-active-gm`.
function importOutcome(createdLocationIds, createdShopIds, warnings, kind) {
  const hasWrites = createdLocationIds.length > 0 || createdShopIds.length > 0;
  if (kind === 'handoff' && !hasWrites) {
    return { status: 'error', error: 'not-active-gm' };
  }
  return {
    status: 'partial',
    createdLocationIds: boundedIds(createdLocationIds, MAX_BACKUP_LOCATIONS),
    createdShopIds: boundedIds(createdShopIds, MAX_BACKUP_SHOPS),
    error: 'import-partial',
    warnings,
  };
}

// Verify the planned import is internally consistent and collision-safe before
// any write. This is the preflight gate: planBackupImport already remaps ids,
// so these checks are defensive. Any failure here aborts before a store write.
function preflightPlannedImport(planned, existingLocationIds, existingShopIds) {
  const plannedLocationIds = new Set(planned.locations.map((l) => l.id));
  const plannedShopIds = new Set(planned.shops.map((s) => s.id));

  if (plannedLocationIds.size !== planned.locations.length) {
    throw new Error('[market] planned import has duplicate location ids');
  }
  if (plannedShopIds.size !== planned.shops.length) {
    throw new Error('[market] planned import has duplicate shop ids');
  }

  for (const loc of planned.locations) {
    if (existingLocationIds.includes(loc.id)) {
      throw new Error(
        `[market] planned location id '${loc.id}' collides with an existing location`
      );
    }
  }
  for (const shop of planned.shops) {
    if (existingShopIds.includes(shop.id)) {
      throw new Error(
        `[market] planned shop id '${shop.id}' collides with an existing shop`
      );
    }
    if (!plannedLocationIds.has(shop.locationId)) {
      throw new Error(
        `[market] planned shop '${shop.id}' references location '${shop.locationId}' ` +
          'that will not be created'
      );
    }
    for (const lid of shop.automation?.travel?.locationIds || []) {
      if (!plannedLocationIds.has(lid)) {
        throw new Error(
          `[market] planned shop '${shop.id}' travel references location '${lid}' ` +
            'that will not be created'
        );
      }
    }
    for (const npc of shop.npcs || []) {
      if (npc.shopId && !plannedShopIds.has(npc.shopId)) {
        throw new Error(
          `[market] planned shop '${shop.id}' NPC references shop '${npc.shopId}' ` +
            'that will not be created'
        );
      }
    }
  }
}

// Build the source-id -> new-id mapping for a planned import. planBackupImport
// preserves array order, so index correspondence matches; this is the id map a
// dry-run reports so a caller can preview the remap without writing.
//
// The maps are null-prototype (`Object.create(null)`) so a source id such as
// '__proto__' or 'constructor' is a normal own key: on a plain object literal a
// '__proto__' assignment would redirect the prototype instead of storing the
// mapping entry, dropping it from the dry-run result and from JSON serialization.
// A null-prototype map has no prototype chain, so every source id is a safe own
// key and `JSON.stringify` of the dry-run idMap serializes them faithfully.
function buildImportIdMap(normalized, planned) {
  const locationMap = Object.create(null);
  const shopMap = Object.create(null);
  for (let i = 0; i < normalized.locations.length && i < planned.locations.length; i++) {
    const src = normalized.locations[i];
    const dst = planned.locations[i];
    if (src && dst && src.id != null && dst.id != null) {
      locationMap[src.id] = dst.id;
    }
  }
  for (let i = 0; i < normalized.shops.length && i < planned.shops.length; i++) {
    const src = normalized.shops[i];
    const dst = planned.shops[i];
    if (src && dst && src.id != null && dst.id != null) {
      shopMap[src.id] = dst.id;
    }
  }
  return { locations: locationMap, shops: shopMap };
}
