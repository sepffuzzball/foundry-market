// M6 GM-authored per-Item valuation for sell/barter.
//
// A player-owned Item is NEVER priced by its own system `price` (a player can
// inflate that value to mint currency or buy goods). Instead a GM approves a
// private valuation for a specific Item on a specific actor, and the sell/barter
// paths (see `src/advanced/selling.js` and `src/advanced/cart.js`) pay only that
// approved amount. This module builds the GM-only `approve` operation and the
// pure, tamper-detecting read side.
//
// The approved valuations live on the GM-private `shop.commerce.valuations`
// array (validated/normalized by `src/services/model.js`, capped at 100, unique
// per (actorUuid, itemId)). They are NEVER projected into the public catalog
// (`PUBLIC_SHOP_FIELDS` does not include `valuations`).
//
// Tamper detection: each valuation stores a canonical fingerprint of the full
// serialized item data at approval time. Any later mutation of the item
// (price/name/type/system/flags) changes the fingerprint, so
// `getApprovedValuation` refuses the approval rather than paying a number that no
// longer corresponds to the item the player actually owns.
//
// No Foundry globals are referenced at import time; only the injected deps and
// the pure helpers are used.

import {
  assertMarketId,
  assertInteger,
  assertActorUuid,
  MAX_COMMERCE_VALUATIONS,
  makeId,
} from '../services/model.js';

// The actor-UUID pattern the schema enforces for a stored valuation (same rule
// as the rest of the market schema - a world Actor UUID).
const ACTOR_UUID_RE = /^Actor\.[A-Za-z0-9]+$/;

// The canonical serialized item JSON is bounded to 64KB so an unbounded item
// (e.g. an enormous raw HTML body) cannot be re-hashed on every verify.
const FINGERPRINT_JSON_MAX = 64 * 1024;

/**
 * Move a serializable value to a fresh, canonical plain-JSON value. Object keys
 * are sorted depth-first so the same logical item data always yields the same
 * JSON string regardless of insertion order. Fails closed when the value is not
 * plain JSON: a function, Symbol, BigInt, non-finite number, undefined array
 * slot (collapsed to null, mirroring JSON.stringify) or an object with a
 * non-`Object.prototype`/null prototype (a Date/Map/class instance) throws.
 */
function cloneCanonical(value, at) {
  if (value === null) return null;
  const t = typeof value;
  const where = at || 'root';
  if (t === 'boolean' || t === 'string') return value;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`[market] valuation item must be plain JSON (non-finite number at ${where})`);
    }
    return value;
  }
  if (t === 'undefined') return null;
  if (t === 'bigint') {
    throw new Error(`[market] valuation item must be plain JSON (BigInt at ${where})`);
  }
  if (t === 'symbol') {
    throw new Error(`[market] valuation item must be plain JSON (Symbol at ${where})`);
  }
  if (t === 'function') {
    throw new Error(`[market] valuation item must be plain JSON (function at ${where})`);
  }
  if (t === 'object') {
    if (Array.isArray(value)) {
      return value.map((v, i) => cloneCanonical(v, `${where}[${i}]`));
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(
        `[market] valuation item must be plain JSON (custom prototype at ${where})`
      );
    }
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = value[k];
      // Object values that are `undefined` are dropped, matching JSON.stringify,
      // so approve-time and verify-time canonicalization always agree.
      if (v === undefined) continue;
      out[k] = cloneCanonical(v, where === 'root' ? k : `${where}.${k}`);
    }
    return out;
  }
  throw new Error(
    `[market] valuation item has an unsupported value of type '${t}' at ${where}`
  );
}

/**
 * FNV-1a 64-bit hash, returned as lowercase hex (16 chars). Deterministic and
 * pure; used only for tamper detection, never as a cryptographic guarantee.
 */
function fnv1a64(str) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Pure canonical fingerprint of a player-owned embedded Item document.
 *
 * `item` must expose `toObject()`. The returned lower-case hex digest is
 * computed over the deterministic, key-sorted serialization of the FULL item
 * data (including `_id`, `name`, `type`, `system`, `flags`, etc), bounded to
 * 64KB. Throws when:
 *   - `item` has no `toObject()` or its result is not an object;
 *   - the item data contains a function/non-plain prototype (or a
 *     Symbol/BigInt/non-finite number), so it is not stable plain JSON;
 *   - the item's own id disagrees with the serialized `_id` (a stale/mismatched
 *     document must not be fingerprinted);
 *   - the serialized JSON exceeds 64KB.
 *
 * This is a pure helper: it never mutates `item` and never reads the store.
 */
export function fingerprintItem(item) {
  if (!item || typeof item.toObject !== 'function') {
    throw new Error('[market] valuation item must expose toObject()');
  }
  const data = item.toObject();
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('[market] valuation item toObject() must be an object');
  }
  const itemId = item.id ?? item._id;
  if (data._id != null && itemId != null && String(data._id) !== String(itemId)) {
    throw new Error(
      `[market] valuation item id mismatch (document id '${itemId}' != data _id '${data._id}')`
    );
  }
  const canonical = cloneCanonical(data, '');
  const json = JSON.stringify(canonical);
  if (json.length > FINGERPRINT_JSON_MAX) {
    throw new Error(
      `[market] valuation item data exceeds ${FINGERPRINT_JSON_MAX} bytes, got ${json.length}`
    );
  }
  return fnv1a64(json);
}

/**
 * Resolve a `Actor.<id>` uuid from a document-like value (an Actor document or
 * an embedded Item's parent). Prefers the document's own `uuid` when it matches
 * the world Actor-UUID pattern; otherwise falls back to `Actor.<id>`. Returns
 * null when neither is available.
 */
function toActorUuid(doc) {
  const u = doc?.uuid;
  if (typeof u === 'string' && ACTOR_UUID_RE.test(u)) return u;
  const id = doc?.id;
  if (typeof id === 'string' && id !== '') return `Actor.${id}`;
  return null;
}

/**
 * Pure, GM-private valuation lookup for a player-owned `item` on a shop.
 *
 * Returns the full validated valuation entry ONLY when ALL of the following hold:
 *   - the item is embedded on an actor (has a `parent`) whose `Actor.<id>`
 *     uuid matches a stored valuation's `actorUuid`;
 *   - the item's document id matches a stored valuation's `itemId`;
 *   - the canonical fingerprint of the CURRENT item data matches the fingerprint
 *     stored at approval time (a forged/mutated player price or any other item
 *     mutation invalidates the approval).
 *
 * Returns `null` when no matching, still-valid approval exists. Never throws
 * (a fingerprinting failure is treated as "not approved"), never mutates state.
 * The caller needs the full entry so sell/barter can CONSUME the approval
 * (remove it from `shop.commerce.valuations` at commit) rather than letting the
 * same approval mint repeated payouts, so this returns the entry, not just the
 * amount.
 */
export function findApprovedValuation(item, shop) {
  const valuations = Array.isArray(shop?.commerce?.valuations)
    ? shop.commerce.valuations
    : [];
  if (valuations.length === 0) return null;
  const actorUuid = toActorUuid(item?.parent);
  if (actorUuid == null) return null;
  const itemId = item?.id ?? null;
  if (itemId == null) return null;
  const entry = valuations.find(
    (v) => v.actorUuid === actorUuid && v.itemId === itemId
  );
  if (!entry) return null;
  let fingerprint;
  try {
    fingerprint = fingerprintItem(item);
  } catch {
    return null;
  }
  if (fingerprint !== entry.fingerprint) return null;
  return entry;
}

/**
 * Pure, GM-private valuation read for a player-owned `item` on a shop.
 *
 * Returns only the approved minor-unit `amount` when
 * `findApprovedValuation(item, shop)` returns a matching, still-valid entry;
 * otherwise returns `null`. Retained as a convenience for callers (and the pure
 * unit tests) that only need the number rather than the consumable entry.
 */
export function getApprovedValuation(item, shop) {
  const entry = findApprovedValuation(item, shop);
  return entry ? entry.amount : null;
}

/**
 * GM-only service that approves a per-Item valuation for sell/barter.
 *
 * `approve({ shopId, actorId, itemId, amount }, gmUserId)`:
 *   - requires the active GM (`isActiveGM`) before any store read;
 *   - runs exclusively under the per-shop lock `runShopExclusive(shopId, ...)`;
 *   - re-reads the shop and the actor's embedded Item (never trusting the
 *     request), validates exactly ONE whole item (`system.quantity === 1` when
 *     present), snapshots the canonical item fingerprint, and replaces any
 *     existing valuation for the same (actorUuid, itemId) or appends up to
 *     MAX_COMMERCE_VALUATIONS (dropping the oldest entry when full);
 *   - writes the whole validated `shop.commerce.valuations` list in a SINGLE
 *     `store.updateShop` commerce patch (normalized by the schema).
 *
 * Exposes `getApprovedValuation(item, shop)`: the GM-private read side that
 * returns the full validated entry for a player-owned item (or null), which the
 * sell/barter services inject and consume at commit so a single approval never
 * mints repeated payouts.
 *
 * Never exposes the valuation to a player/allow a client-side approve: the
 * entry point is GM-gated and the private list is not part of the public
 * catalog.
 */
export function createValuationService(deps) {
  const {
    store,
    runShopExclusive,
    isActiveGM = () => true,
    getActor,
    makeId,
    logger,
  } = deps;

  function approve(payload = {}, gmUserId) {
    let shopId;
    let actorId;
    let itemId;
    let amount;
    try {
      shopId = assertMarketId(payload?.shopId, 'shopId');
      actorId = assertMarketId(payload?.actorId, 'actorId');
      itemId = assertMarketId(payload?.itemId, 'itemId');
      amount = assertInteger(payload?.amount, 'amount', { min: 1 });
    } catch (err) {
      return Promise.resolve({ status: 'error', error: err.message });
    }

    // GM gate BEFORE any store read. A player watching the app never triggers a
    // read or a write.
    if (!isActiveGM()) {
      return Promise.resolve({ status: 'error', error: 'not-active-gm' });
    }

    return runShopExclusive(shopId, () =>
      approveLocked({ shopId, actorId, itemId, amount })
    );
  }

  async function approveLocked(ctx) {
    const { shopId, actorId, itemId, amount } = ctx;

    // Re-check the active-GM guard before ANY read.
    if (!isActiveGM()) {
      return { status: 'error', error: 'not-active-gm' };
    }

    // Re-read the shop inside the lock (never trust the request).
    let shop;
    try {
      shop = await store.findShop(shopId);
    } catch (err) {
      return {
        status: 'error',
        error: `shop-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (!shop) return { status: 'error', error: 'shop-not-found' };

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // Re-read the actor and the embedded Item.
    let actor;
    try {
      actor = await getActor(actorId);
    } catch (err) {
      return {
        status: 'error',
        error: `actor-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (!actor) return { status: 'error', error: 'actor-not-found' };

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    const item = actor.items && actor.items.get ? actor.items.get(itemId) : null;
    if (!item) return { status: 'error', error: 'item-not-found' };
    if (item.documentName !== 'Item') {
      return { status: 'error', error: 'item-not-an-item' };
    }
    if (typeof item.toObject !== 'function') {
      return { status: 'error', error: 'item-not-an-item' };
    }
    if (item.parent != null && item.parent !== actor) {
      return { status: 'error', error: 'item-parent-mismatch' };
    }

    // Whole-item rule. Only exactly one whole embedded Item may be valued; the
    // generic `quantityPath` check is deferred to a later slice.
    const data = item.toObject();
    if (
      data &&
      data.system &&
      data.system.quantity != null &&
      data.system.quantity !== 1
    ) {
      return { status: 'error', error: 'stacked-item' };
    }

    // Canonical snapshot fingerprint. A mutated/forged item is rejected here so
    // the stored fingerprint always describes the item actually approved.
    let fingerprint;
    try {
      fingerprint = fingerprintItem(item);
    } catch (err) {
      return {
        status: 'error',
        error: 'fingerprint-failed',
        detail: (err && err.message) || String(err),
      };
    }

    // The actor's `Actor.<id>` uuid is the storage key; it must be well-formed.
    const actorUuid = toActorUuid(actor);
    if (actorUuid == null) return { status: 'error', error: 'invalid-actor-uuid' };
    try {
      assertActorUuid(actorUuid, 'actor.uuid');
    } catch {
      return { status: 'error', error: 'invalid-actor-uuid' };
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // Replace any existing valuation for the same actor+item, or append up to
    // the cap (dropping the oldest entry when the list is already full). Never
    // write a duplicate (actorUuid, itemId) pair.
    const existing = Array.isArray(shop.commerce && shop.commerce.valuations)
      ? shop.commerce.valuations
      : [];
    const newValuation = {
      id: makeId(),
      actorUuid,
      itemId,
      amount,
      fingerprint,
    };
    let valuations = existing;
    const idx = valuations.findIndex(
      (v) => v.actorUuid === actorUuid && v.itemId === itemId
    );
    if (idx >= 0) {
      valuations = valuations.slice();
      valuations[idx] = newValuation;
    } else {
      if (valuations.length >= MAX_COMMERCE_VALUATIONS) {
        valuations = valuations.slice(1);
      }
      valuations = [...valuations, newValuation];
    }

    // A SINGLE shop write carrying the whole validated commerce patch, so the
    // valuations are normalized by the schema in the same way every other
    // commerce field is (never a raw unvalidated object).
    const updatedShop = await store.updateShop(shopId, {
      commerce: { ...shop.commerce, valuations },
    });
    if (updatedShop == null) {
      return { status: 'error', error: 'shop-write-missing' };
    }

    return {
      status: 'approved',
      valuationId: newValuation.id,
      itemName: typeof data?.name === 'string' ? data.name : String(item.name ?? ''),
      amount,
    };
  }

  // The GM-private read side: a pure lookup that returns the full validated
  // entry for a player-owned item on a shop (or null when no still-valid
  // approval exists). The sell/barter services inject this as their
  // `getApprovedValuation(item, shop)` and CONSUME the returned entry at commit,
  // so a single GM approval never mints repeated payouts.
  function getApprovedValuation(item, shop) {
    return findApprovedValuation(item, shop);
  }

  return { approve, getApprovedValuation };
}

export default createValuationService;
