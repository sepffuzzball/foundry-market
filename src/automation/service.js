// M4 GM-only scheduled automation runner.
//
// `createAutomationService` wires the pure `planAutomation` decisions to a
// GM-only store writer. The service itself is a scheduled runner with no timer
// or game-loop knowledge: the runtime wires it to the active GM's
// `updateWorldTime` tick and the manager's "Run now" (see main.js, manager.js).
// A caller invokes `runAll()` or `runShop(shopId)` and this module performs the
// reads/writes.
//
// Every public entry point guards on `isActiveGM()` BEFORE touching the store,
// so a player watching the app never triggers a read. Purchases and GM manager
// edits use the same per-shop lock via the injected `runShopExclusive`, so a
// concurrent purchase can never interleave with an automation restock rewrite.
//
// No Foundry globals are referenced at import time.

import { planAutomation } from './policy.js';

const ERROR_MAX = 200;

function errorMessage(err) {
  return String((err && err.message) || err || 'unknown');
}

export function createAutomationService(deps = {}) {
  const {
    store,
    runShopExclusive = (_shopId, fn) => fn(),
    isActiveGM = () => true,
    now = () => Math.floor(Date.now() / 1000),
    logger,
  } = deps;

  function gmActive() {
    try {
      return isActiveGM() === true;
    } catch {
      return false;
    }
  }

  // Resolve the world-time to a safe integer second, or null when the clock is
  // invalid (NaN/undefined/Infinity/non-safe). `planAutomation` and the schedule
  // helpers never loop and never run backward, but an invalid `now()` must never
  // silently collapse to week zero (Monday 00:00) and execute a schedule; the
  // runner short-circuits with `invalid-world-time` before any shop read/write.
  function worldTime() {
    const raw = now();
    if (Number.isFinite(raw)) {
      const floored = Math.floor(raw);
      if (Number.isSafeInteger(floored)) return floored;
    }
    return null;
  }

  function boundedError(err) {
    return errorMessage(err).slice(0, ERROR_MAX);
  }

  // Build a freshly-derived diagnostics record. `lastRestocked` is the count of
  // inventory entries actually restocked this run and is always <= inventory
  // length; `lastError` is capped at ERROR_MAX (200) so a long stack line can
  // never bloat a persisted shop.
  function makeDiagnostics({ time, status, error = '', restocked, locationId }) {
    return {
      lastRunAt: time,
      lastStatus: status,
      lastError: String(error || '').slice(0, ERROR_MAX),
      lastRestocked: restocked,
      lastLocationId: locationId || '',
    };
  }

  // A bounded, normalized view of a shop's diagnostics for `getDiagnostics`. It
  // never returns the full shop record, and every field is defensively coerced
  // to its documented type/range.
  function normalizedDiagnostics(shop) {
    const d =
      shop && shop.automation && shop.automation.diagnostics
        ? shop.automation.diagnostics
        : {};
    return {
      lastRunAt: d.lastRunAt == null ? null : d.lastRunAt,
      lastStatus: d.lastStatus || 'never',
      lastError: String(d.lastError ?? '').slice(0, ERROR_MAX),
      lastRestocked: Number.isSafeInteger(d.lastRestocked) ? d.lastRestocked : 0,
      lastLocationId:
        typeof d.lastLocationId === 'string'
          ? d.lastLocationId
          : (shop && shop.locationId) || '',
    };
  }

  // Persist a diagnostics-only failure. Only used for a deterministic preflight
  // failure (a due travel destination that does not exist). It never touches
  // inventory, the shop's own location, or any cycle marker, so a fixed
  // schedule is retried on the next tick rather than advanced into a bad state.
  async function persistDiagnosticsOnly(shop, shopId, time, spec) {
    const nextDiagnostics = makeDiagnostics({
      time,
      status: spec.status,
      error: spec.error,
      restocked: spec.restocked,
      locationId: spec.locationId,
    });
    const automation = { ...shop.automation, diagnostics: nextDiagnostics };
    try {
      const updated = await store.updateShop(shopId, { automation });
      if (updated == null) return 'shop-update-failed';
      return null;
    } catch (err) {
      logger?.error?.('[market] failed to persist automation diagnostics', err);
      return `diagnostics-write-failed: ${errorMessage(err).slice(0, ERROR_MAX)}`;
    }
  }

  async function processShop(shopId) {
    // Re-check the active GM INSIDE the per-shop lock (this runs as the
    // `runShopExclusive` callback). If the GM handed off while this operation was
    // queued behind a purchase (or another writer), return idle without any store
    // read/write - never a stale write after a handoff.
    if (!gmActive()) return { status: 'idle', shopId };
    const time = worldTime();
    // Validate the clock BEFORE any store read/write (after the active-GM guard
    // in runShop). An invalid world time never executes a schedule and never
    // writes diagnostics or cycle markers.
    if (time == null) {
      return { status: 'error', shopId, error: 'invalid-world-time' };
    }

    let shop;
    try {
      shop = await store.findShop(shopId);
    } catch (err) {
      logger?.error?.('[market] failed to read shop for automation', err);
      return { status: 'error', shopId, error: boundedError(err) };
    }
    // A shop removed (or never present) between listShops and this run is
    // skipped, not failed.
    if (!shop) return { status: 'idle', shopId };

    const plan = planAutomation(shop, time);

    // Preflight the travel destination. If a travel cycle is due but the target
    // location no longer exists, fail the whole shop before writing: no restock,
    // no cycle advancement, diagnostics only.
    if (plan.travel) {
      let locations;
      try {
        locations = await store.listLocations();
      } catch (err) {
        logger?.error?.('[market] failed to read locations for automation', err);
        return { status: 'error', shopId, error: boundedError(err) };
      }
      // A malformed non-array location list must not throw in `some`; fail this
      // single shop (never the whole run) and let `runAll` continue.
      if (!Array.isArray(locations)) {
        return { status: 'error', shopId, error: 'invalid-locations' };
      }
      const exists = locations.some((loc) => loc.id === plan.travel.locationId);
      if (!exists) {
        // Re-check the GM immediately before this diagnostics-only write; a
        // handoff means idle with no write (never a stale diagnostics write).
        if (!gmActive()) return { status: 'idle', shopId };
        const writeErr = await persistDiagnosticsOnly(shop, shopId, time, {
          status: 'error',
          error: 'travel-location-missing',
          restocked: 0,
          locationId: shop.locationId,
        });
        if (writeErr) return { status: 'error', shopId, error: writeErr };
        return { status: 'error', shopId, error: 'travel-location-missing' };
      }
    }

    const hasRestock = plan.restocks.length > 0;
    const hasTravel = plan.travel != null;
    if (!hasRestock && !hasTravel) {
      return { status: 'idle', shopId };
    }

    // Build the atomic mutation. Restocks never reduce stock: quantity is
    // clamped up to the target (max) and `lastCycle` is advanced by exactly the
    // single due cycle from the plan (no catch-up loop, no backward time).
    let inventory = shop.inventory;
    if (hasRestock) {
      const dueById = new Map(plan.restocks.map((r) => [r.entryId, r]));
      inventory = inventory.map((entry) => {
        const due = dueById.get(entry.id);
        if (!due) return entry;
        return {
          ...entry,
          quantity: Math.max(entry.quantity, due.target),
          restock: { ...entry.restock, lastCycle: due.cycle },
        };
      });
    }

    let locationId = shop.locationId;
    const automation = { ...shop.automation };
    if (hasTravel) {
      automation.travel = { ...automation.travel, lastCycle: plan.travel.cycle };
      locationId = plan.travel.locationId;
    }

    const restocked = plan.restocks.length;
    automation.diagnostics = makeDiagnostics({
      time,
      status: 'ok',
      error: '',
      restocked,
      locationId,
    });

    // Re-check the GM immediately before the write. A handoff at this point
    // returns idle with no store write (never a stale restock/rotation write).
    if (!gmActive()) return { status: 'idle', shopId };
    try {
      const updated = await store.updateShop(shopId, { inventory, locationId, automation });
      // A null result (the shop was removed between read and write) is a real
      // failure, not a silent success.
      if (updated == null) return { status: 'error', shopId, error: 'shop-update-failed' };
    } catch (err) {
      // The atomic write failed; no cycle markers were persisted, so the next
      // tick retries the same due cycle. We do not attempt a compensation write.
      logger?.error?.('[market] failed to persist automation for shop', err);
      return { status: 'error', shopId, error: boundedError(err) };
    }

    return { status: 'ok', shopId, restocked, locationId };
  }

  function runShop(shopId) {
    if (!gmActive()) return { status: 'idle', shopId };
    return runShopExclusive(shopId, () => processShop(shopId));
  }

  async function runAll() {
    if (!gmActive()) return { status: 'idle', summaries: [] };
    // Validate the clock before listing shops: an invalid world time means no
    // shop is read and no schedule executes.
    const time = worldTime();
    if (time == null) {
      return { status: 'error', error: 'invalid-world-time', summaries: [] };
    }
    let shops;
    try {
      shops = await store.listShops();
    } catch (err) {
      logger?.error?.('[market] failed to list shops for automation', err);
      return { status: 'error', error: boundedError(err), summaries: [] };
    }
    const summaries = [];
    for (const shop of shops) {
      summaries.push(await runShop(shop.id));
    }
    return { status: 'ok', summaries };
  }

  async function getDiagnostics(shopId) {
    if (!gmActive()) return { status: 'idle', diagnostics: [] };
    let shops;
    try {
      shops = shopId ? [await store.findShop(shopId)] : await store.listShops();
    } catch (err) {
      logger?.error?.('[market] failed to read automation diagnostics', err);
      return { status: 'error', error: boundedError(err), diagnostics: [] };
    }
    const diagnostics = [];
    for (const shop of shops) {
      if (!shop) continue;
      diagnostics.push({ shopId: shop.id, ...normalizedDiagnostics(shop) });
    }
    return { status: 'ok', diagnostics };
  }

  return { runAll, runShop, getDiagnostics };
}

export default createAutomationService;
