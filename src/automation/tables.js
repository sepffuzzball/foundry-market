// M4 GM-only RollTable item inventory generation service.
//
// `createTableInventoryService` draws Items from a world/compendium RollTable and
// appends them as finite, visible inventory entries to a shop. The service itself
// is UI-free (no chat, no socket); the manager surfaces the GM-only "Roll table
// stock" form and the active-GM `generateInventory` entry point (see main.js,
// manager.js). A caller invokes `generate({ shopId, tableUuid, count })`.
//
// It is GM-gated (re-checks `isActiveGM()`), runs inside the SAME per-shop lock
// purchases and GM manager edits use via the injected `runShopExclusive`, re-reads
// the shop under that lock (so a concurrent purchase's stock change is never
// lost), and performs exactly ONE `store.updateShop` per successful generation -
// and no write at all when no entry was added. Results are capped and every
// counter is a plain number; no raw document is ever returned.
//
// A drawn result is only usable when it is a v14 document result (`result.type
// === 'document'`, i.e. `CONST.TABLE_RESULT_TYPES.DOCUMENT`) whose referenced
// document resolves to a valid world/compendium Item. Resolution is injected via
// `resolveResult`, which MUST verify the source is a world Item
// (`documentCollection === 'Item'`) or a compendium Item pack and return the Item
// document, else null. The service then verifies the resolved Item is a real Item
// (`documentName === 'Item'`, a non-empty `uuid`, and a `toObject()` method)
// before normalizing it into an inventory entry.
//
// A resolved item whose price cannot be read (adapter unsupported or throwing)
// is STILL added with a documented price of 0 - the item is never dropped on a
// price problem.
//
// No Foundry globals are referenced at import time.

import { normalizeInventoryEntry, makeId as makeIdDefault } from '../services/model.js';

const MAX_TABLE_RESULTS = 20;
const TABLE_UUID_MAX = 200;

// Coerce whatever `adapter.getItemPrice(item)` returned into a non-negative safe
// integer minor-unit price, defaulting to 0. The real adapters return an object
// `{ amount, denomination, minorUnits }`; tests may return a plain number. Real
// adapters never return a negative price, but a malformed/unsafe value must never
// leak into an inventory entry, so it collapses to the documented 0 fallback.
function toSafePrice(value) {
  let n;
  if (value && typeof value === 'object') {
    if (typeof value.minorUnits === 'number') n = value.minorUnits;
    else if (typeof value.amount === 'number') n = value.amount;
    else n = Number.NaN;
  } else {
    n = typeof value === 'number' ? value : Number.NaN;
  }
  if (Number.isFinite(n) && n >= 0) {
    const floored = Math.floor(n);
    if (Number.isSafeInteger(floored)) return floored;
  }
  return 0;
}

// Whether a price input is a usable non-negative safe number (or the object form
// carrying one). Used only to decide whether to warn that a 0 price is a fallback
// rather than a genuine zero price from the adapter.
function valueIsUsablePrice(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.floor(value));
  }
  if (value && typeof value === 'object') {
    if (typeof value.minorUnits === 'number') {
      return Number.isFinite(value.minorUnits) && value.minorUnits >= 0;
    }
    if (typeof value.amount === 'number') {
      return Number.isFinite(value.amount) && value.amount >= 0;
    }
  }
  return false;
}

export function createTableInventoryService(deps = {}) {
  const {
    store,
    runShopExclusive = (_shopId, fn) => fn(),
    isActiveGM = () => true,
    getTable,
    resolveResult,
    getAdapter,
    makeId = makeIdDefault,
    logger,
  } = deps;

  function gmActive() {
    try {
      return isActiveGM() === true;
    } catch {
      return false;
    }
  }

  // Validate the request payload BEFORE any table/store read. `count` must be an
  // integer in 1..MAX_TABLE_RESULTS and `tableUuid` a non-empty string of at most
  // TABLE_UUID_MAX chars. Returns an error summary, or null when valid.
  function validate(count, tableUuid) {
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_TABLE_RESULTS) {
      return { status: 'error', error: 'invalid-count' };
    }
    if (
      typeof tableUuid !== 'string' ||
      tableUuid.trim() === '' ||
      tableUuid.length > TABLE_UUID_MAX
    ) {
      return { status: 'error', error: 'invalid-table-uuid' };
    }
    return null;
  }

  async function generateLocked(shopId, tableUuid, count) {
    // Re-check the active GM INSIDE the per-shop lock (this runs as the
    // `runShopExclusive` callback). A handoff while queued means idle with no
    // store read - never a stale generation after the GM left.
    if (!gmActive()) return { status: 'idle', shopId };
    let shop;
    try {
      shop = await store.findShop(shopId);
    } catch (err) {
      logger?.error?.('[market] failed to read shop for table inventory', err);
      return { status: 'error', error: 'shop-read-failed' };
    }
    // A shop removed (or never present) is a no-op success: nothing to write, so
    // do not even bother drawing.
    if (!shop) return { status: 'ok', added: 0, skipped: 0, invalid: 0, duplicate: 0 };

    let table;
    try {
      table = await getTable(tableUuid.trim());
    } catch (err) {
      logger?.error?.('[market] failed to resolve RollTable', err);
      return { status: 'error', error: 'table-resolve-failed' };
    }
    // Only a world/compendium RollTable document is usable (the injected getTable
    // must resolve to one; a non-RollTable or missing document is refused).
    if (!table || table.documentName !== 'RollTable') {
      return { status: 'error', error: 'table-not-found' };
    }

    // Re-check the GM immediately before the draw; a handoff returns idle with
    // no draw (and no write).
    if (!gmActive()) return { status: 'idle', shopId };
    let draws;
    try {
      draws = await table.drawMany(count, { displayChat: false });
    } catch (err) {
      logger?.error?.('[market] failed to draw from RollTable', err);
      return { status: 'error', error: 'table-draw-failed' };
    }

    // Accept only the bounded `results` array, never an unbounded document. Cap at
    // MAX_TABLE_RESULTS (20) so a poorly-configured table can never explode.
    const results = Array.isArray(draws && draws.results)
      ? draws.results.slice(0, MAX_TABLE_RESULTS)
      : [];

    let adapter;
    try {
      adapter = getAdapter();
    } catch {
      adapter = null;
    }

    const existingUuids = new Set((shop.inventory || []).map((entry) => entry.itemUuid));
    const seen = new Set();
    const entries = [];
    let added = 0;
    let skipped = 0;
    let invalid = 0;
    let duplicate = 0;

    for (const result of results) {
      // A result that is not a v14 document row (a text row, or a malformed
      // object) can never become an inventory entry.
      if (!result || result.type !== 'document') {
        invalid += 1;
        continue;
      }

      // Resolution is injected and must verify a world/compendium Item source.
      let item;
      try {
        item = await resolveResult(result);
      } catch (err) {
        skipped += 1;
        logger?.warn?.('[market] table result failed to resolve to an Item', err);
        continue;
      }
      if (!item) {
        skipped += 1;
        continue;
      }
      // The resolved document must be a real Item with a stable UUID and a
      // snapshot-producing toObject(); anything else is skipped, not guessed.
      if (
        item.documentName !== 'Item' ||
        typeof item.uuid !== 'string' ||
        item.uuid === '' ||
        typeof item.toObject !== 'function'
      ) {
        skipped += 1;
        continue;
      }

      const uuid = item.uuid;
      // Dedupe against both this draw and the live shop inventory (read under the
      // shop lock), so a re-draw never stacks a duplicate Item.
      if (seen.has(uuid) || existingUuids.has(uuid)) {
        duplicate += 1;
        continue;
      }

      // Price is best-effort. An unsupported/throwing/negative/unsafe price is
      // documented to fall back to 0 - the item is still added, never dropped.
      let price = 0;
      if (adapter && typeof adapter.getItemPrice === 'function') {
        try {
          const raw = await adapter.getItemPrice(item);
          price = toSafePrice(raw);
          if (price === 0 && !valueIsUsablePrice(raw)) {
            logger?.warn?.(
              '[market] item price unsupported, defaulting to 0',
              item.uuid,
              raw
            );
          }
        } catch (err) {
          logger?.warn?.('[market] item price read failed, defaulting to 0', err);
          price = 0;
        }
      }

      let entry;
      try {
        entry = normalizeInventoryEntry({
          id: makeId(),
          itemUuid: uuid,
          snapshot: JSON.stringify(item.toObject()),
          name: item.name,
          img: item.img,
          quantity: 1,
          stockMode: 'finite',
          price,
          visible: true,
        });
      } catch (err) {
        skipped += 1;
        logger?.warn?.('[market] failed to normalize a drawn inventory entry', err);
        continue;
      }

      seen.add(uuid);
      entries.push(entry);
      added += 1;
    }

    // Persist exactly once, only when there is something new. Appends to the
    // current (locked) inventory, never overwriting existing entries.
    if (entries.length > 0) {
      // Re-check the GM immediately before the write; a handoff returns idle with
      // no write (never a stale inventory append after the GM left).
      if (!gmActive()) return { status: 'idle', shopId };
      try {
        const updated = await store.updateShop(shopId, {
          inventory: [...(shop.inventory || []), ...entries],
        });
        // A null result (the shop was removed between read and write) is a real
        // failure, not a silent success.
        if (updated == null) return { status: 'error', error: 'shop-update-failed' };
      } catch (err) {
        logger?.error?.('[market] failed to persist table inventory for shop', err);
        return { status: 'error', error: 'shop-write-failed' };
      }
    }

    return { status: 'ok', added, skipped, invalid, duplicate };
  }

  async function generate({ shopId, tableUuid, count }) {
    if (!gmActive()) return { status: 'idle', shopId };
    const invalid = validate(count, tableUuid);
    if (invalid) return invalid;
    return runShopExclusive(shopId, () => generateLocked(shopId, tableUuid, count));
  }

  return { generate };
}

export default createTableInventoryService;
