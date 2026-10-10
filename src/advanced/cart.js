// M5 GM-authoritative safe multi-item cart checkout.
//
// A "cart" is a single actor buying a selection of inventory entries from one
// shop at once. It is a COMPENSATING, idempotent advanced-order transaction that
// mirrors the M1 purchase ledger in shape and deliberately does NOT claim
// distributed/transactional atomicity - it records phases and undoes what it can
// best-effort, escalating to `needsRecovery` when a compensating step is itself
// uncertain.
//
// Single payer, no unauthorized debit: ONLY the request's `actorId` is debited.
// No other party is charged. A "group cart" today is interpreted as a single
// payer accumulating a shared selection; a future explicit cost-sharing / consent
// model (splitting the total across several actors) is NOT implemented here. The
// docs state this boundary explicitly - no other contributor is charged.
//
// This module is a Node-importable companion to `src/advanced/selling.js` and
// `src/advanced/services.js` and follows the same discipline: it is GM-gated
// (`isActiveGM` before any store read, re-checked inside the lock and at every
// await boundary that can observe a handover), never trusts a client-supplied
// price (the price is re-read from the STORED entry), runs under the SAME
// per-shop lock a purchase uses (`runShopExclusive`), persists an `advancedOrder`
// of kind `cart` BEFORE any effect so a replayed request resolves idempotently,
// and never claims transactional atomicity.
//
// Money is always expressed in non-negative integer minor units. The total is
// summed with BigInt/safe-integer checks so an extreme quote never silently
// wraps; the acting player's balance must cover the total before any debit; and
// finite merchant `commerce.funds` GAIN the total (a safe-overflow check refuses
// the checkout before any effect rather than wrapping). `null` funds stay
// unlimited (no funds patch is written). An optional item-for-price `barterItemId`
// tender is only credited at the GM-approved valuation of the player-owned Item
// (never its own system `price`); until a GM-authored valuation approval
// mechanism is wired, a barter checkout refuses `gm-approval-required` BEFORE the
// pending order and any effect, so an astronomically inflated system price can
// never buy goods for free.
//
// No Foundry globals are referenced at import time; only the injected deps and
// the pure helpers are used.

import { assertMarketId, makeId, parseItemData, normalizeInventoryEntry } from '../services/model.js';
import { fnv1a } from '../services/commerce.js';
import { isShopTrading } from '../automation/policy.js';
import { canAccessEntry, quoteSell, quoteBuyback, quoteSpecial } from './policy.js';
import { quote, assertMinorUnits } from '../services/pricing.js';
import { quoteSocial } from '../social/pricing.js';
import { readPath } from '../adapters/index.js';

export const CART_MAX_LINES = 20;
export const CART_MAX_QUANTITY = 100;

/**
 * Coerce `value` to a safe integer world-time second, or return null when the
 * clock value is invalid (NaN/undefined/Infinity/non-safe). An invalid server
 * time must fail the checkout closed (`invalid-world-time`) before any effect
 * rather than collapse to week zero and silently trade.
 */
function safeWorldTime(value) {
  if (Number.isFinite(value)) {
    const floored = Math.floor(value);
    if (Number.isSafeInteger(floored)) return floored;
  }
  return null;
}

/**
 * A cart line quantity must be a safe integer in 1..CART_MAX_QUANTITY. Anything
 * else is a malformed request and fails before any effect.
 */
function assertCartQuantity(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`[market] '${label}' must be a safe integer, got ${value}`);
  }
  if (value < 1 || value > CART_MAX_QUANTITY) {
    throw new Error(
      `[market] '${label}' must be between 1 and ${CART_MAX_QUANTITY}, got ${value}`
    );
  }
  return value;
}

const BARTER_ITEM_ID_MAX = 120;
const BARTER_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * Normalize the optional `barterItemId` payload field. An absent/blank value
 * collapses to '' (no barter). A present value must be a string of at most 120
 * chars, free of control characters - the same market-id discipline used
 * elsewhere. Throws a clean (prefixed) error on a malformed value so the caller
 * surfaces it as a fail-closed validation error.
 */
function assertOptionalMarketId(value, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new Error(`[market] '${label}' must be a string, got ${typeof value}`);
  }
  const v = value.trim();
  if (v === '') return '';
  if (v.length > BARTER_ITEM_ID_MAX) {
    throw new Error(
      `[market] '${label}' must be at most ${BARTER_ITEM_ID_MAX} chars, got ${v.length}`
    );
  }
  if (BARTER_CONTROL_CHAR_RE.test(v)) {
    throw new Error(`[market] '${label}' must not contain control characters`);
  }
  return v;
}

/**
 * Find a stored `commerce.specials` entry by exact id on the (normalized) shop.
 * Returns null when the shop carries no commerce/specials or no offer matches.
 * The caller validates the rest (visibility, exact entry, actor allowlist) so a
 * forged/unknown specialId resolves to null and fails the checkout closed.
 */
function findShopSpecial(shop, specialId) {
  const specials = shop?.commerce?.specials;
  if (!Array.isArray(specials)) return null;
  return specials.find((s) => s && s.id === specialId) || null;
}

/**
 * Extract a non-negative safe integer minor-unit value from an adapter price
 * result, which may be a bare number or an object carrying `minorUnits`. Throws
 * on anything that is not a safe non-negative integer.
 */
function extractMinorUnits(result, label) {
  let value;
  if (typeof result === 'number') {
    value = result;
  } else if (
    result &&
    typeof result === 'object' &&
    typeof result.minorUnits === 'number'
  ) {
    value = result.minorUnits;
  } else {
    throw new Error(`[market] '${label}' did not carry a numeric minorUnits value`);
  }
  return assertMinorUnits(value, label);
}

/**
 * Resolve the GM-approved valuation for a player-owned Item tendered as barter in
 * non-negative safe integer minor units, or return `{ entry: null, amount: null }`
 * when no valuation is approved yet. The checkout NEVER credits a bartered Item at
 * its own (player inflatable) system `price`; it credits only the GM-approved
 * valuation. A missing (`getApprovedValuation` not wired) or throwing read is
 * treated as "not approved" so the checkout fails closed `gm-approval-required`
 * BEFORE the pending order and any effect, rather than falling back to the item's
 * own price.
 *
 * The runtime injects `valuationService.getApprovedValuation`, which returns the
 * FULL validated valuation entry (so the checkout can consume it at commit - a
 * single approval must never mint repeated payouts). A test fixture may instead
 * inject a bare number (amount-only, `entry: null`); both are normalized here.
 * `shop` is passed through as the second argument but an injected callback may
 * ignore it.
 */
async function resolveApprovedValuation(getApprovedValuation, item, shop, label) {
  if (typeof getApprovedValuation !== 'function') {
    return { entry: null, amount: null };
  }
  let value;
  try {
    value = await getApprovedValuation(item, shop);
  } catch (err) {
    return { entry: null, amount: null };
  }
  if (value == null) return { entry: null, amount: null };
  let entry = null;
  let raw;
  if (typeof value === 'number') {
    raw = value;
  } else if (value && typeof value === 'object' && typeof value.amount === 'number') {
    entry = value;
    raw = value.amount;
  } else if (value && typeof value === 'object' && typeof value.minorUnits === 'number') {
    entry = value;
    raw = value.minorUnits;
  } else {
    return { entry: null, amount: null };
  }
  return { entry, amount: extractMinorUnits(raw, label) };
}

/**
 * Whether `actor` still carries an embedded `Item` with `itemId`. Used only as a
 * defensive live check - never to mutate.
 */
function itemStillPresent(actor, itemId) {
  return !!(actor.items && actor.items.get && actor.items.get(itemId));
}

/**
 * Remove the bartered tender Item and report whether it was actually removed and
 * whether that is uncertain. Mirrors the selling service's delete discipline: a
 * returned resolution is not trusted, only the LIVE `actor.items.get(itemId)`
 * afterwards. Returns `{ removed, uncertain, failed }`:
 *   - API throws + item still live   => `{ removed:false, uncertain:false, failed:true }`
 *   - API throws + item absent       => `{ removed:true, uncertain:true, failed:false }`
 *   - API resolves + item still live => `{ removed:false, uncertain:false, failed:true }`
 *   - API resolves + item absent     => `{ removed:true, uncertain:false, failed:false }`
 */
async function removeTender(actor, itemId) {
  let threw = false;
  try {
    await actor.deleteEmbeddedDocuments('Item', [itemId]);
  } catch (err) {
    threw = true;
  }
  const present = itemStillPresent(actor, itemId);
  if (threw) {
    if (present) return { removed: false, uncertain: false, failed: true };
    return { removed: true, uncertain: true, failed: false };
  }
  if (present) return { removed: false, uncertain: false, failed: true };
  return { removed: true, uncertain: false, failed: false };
}

/**
 * Resolve the optional item-for-price barter tendered by the paying actor.
 * Validates that the actor owns exactly ONE whole embedded `Item` (no stack, no
 * private / path-delivered tender), prices it at the GM-approved valuation (never
 * the player-owned item's own system price), and computes the capped barter
 * credit against the cart gross `total`. Returns `{ barter }` on success or
 * `{ error }` on a fail-closed validation error (`gm-approval-required` when no
 * GM valuation is approved yet); never mutates state.
 */
async function resolveBarter({ adapter, shop, actor, barterItemId, total, getApprovedValuation }) {
  const item =
    actor && actor.items && actor.items.get ? actor.items.get(barterItemId) : null;
  if (!item) return { error: 'barter-item-not-found' };
  if (item.documentName !== 'Item') return { error: 'barter-item-not-an-item' };
  if (typeof item.toObject !== 'function') {
    return { error: 'barter-item-not-an-item' };
  }
  if (item.parent != null && item.parent !== actor) {
    return { error: 'barter-item-parent-mismatch' };
  }
  const snapshotData = item.toObject();

  // Only an embedded-delivery adapter can remove an embedded Item tender. A
  // generic adapter configured for path delivery cannot, so the barter is
  // unsupported.
  if (typeof adapter.deliveryMode === 'string' && adapter.deliveryMode !== 'embedded') {
    return { error: 'delivery-mode-unsupported' };
  }

  // Whole-item rule. A GenericAdapter with a configured `quantityPath` reads the
  // count through that path via the safe reader; anything else consults the dnd5e
  // `system.quantity` when present. Only exactly one whole item may be tendered.
  const quantityPath = adapter.quantityPath;
  if (typeof quantityPath === 'string' && quantityPath !== '') {
    let raw;
    try {
      raw = readPath(snapshotData, quantityPath);
    } catch (err) {
      return { error: 'quantity-path-invalid' };
    }
    if (raw == null || typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { error: 'quantity-path-invalid' };
    }
    if (!Number.isInteger(raw) || raw !== 1) {
      return { error: 'stacked-item' };
    }
  } else if (
    snapshotData &&
    snapshotData.system &&
    snapshotData.system.quantity != null &&
    snapshotData.system.quantity !== 1
  ) {
    return { error: 'stacked-item' };
  }

  // A player-owned barter tender is never credited at its own (player inflatable)
  // system price. Without a GM-approved valuation the checkout fails closed before
  // the pending order / any effect.
  const approved = await resolveApprovedValuation(
    getApprovedValuation,
    item,
    shop,
    'itemPrice'
  );
  const itemPrice = approved.amount;
  if (itemPrice == null) return { error: 'gm-approval-required' };
  const consumedValuation = approved.entry;

  let sellValue;
  try {
    sellValue = quoteSell(itemPrice, shop);
  } catch (err) {
    return { error: 'quote-overflow' };
  }
  // The barter credit is the shop's fair purchase value, capped at the cart gross
  // total - a tender worth more than the cart never pays cash out.
  const barterCredit = Math.min(sellValue, total);
  if (barterCredit <= 0) return { error: 'no-offer' };
  const cashPaid = total - barterCredit;

  let buybackPrice;
  try {
    buybackPrice = quoteBuyback(barterCredit, shop);
  } catch (err) {
    return { error: 'quote-overflow' };
  }

  const buybackEntry = normalizeInventoryEntry({
    id: makeId(),
    itemUuid: '',
    snapshot: JSON.stringify(snapshotData),
    name: snapshotData.name,
    img: snapshotData.img || '',
    quantity: 1,
    stockMode: 'non-restocking',
    price: buybackPrice,
    visible: true,
  });

  return {
    barter: {
      itemId: barterItemId,
      snapshotData,
      snapshot: JSON.stringify(snapshotData),
      barterCredit,
      cashPaid,
      buybackPrice,
      buybackEntry,
      // The exact GM-approved valuation entry consumed by this checkout. At commit
      // it is removed from the shop's private valuations so a single approval can
      // never be replayed into a second credit (e.g. after the item is recreated).
      ...(consumedValuation ? { consumedValuation } : {}),
    },
  };
}

/**
 * Deterministic intent fingerprint for a cart checkout. Only the fields that make
 * a checkout unique are included (shop, actor, sorted lines, requester) so two
 * requests with the same INTENT produce the same hash and can be safely replayed.
 * Lines are canonicalized by sorting on `entryId` - the order a client sends
 * the lines in never changes the hash, so a reordered-but-identical selection
 * replays rather than conflicts. `requester` is the authenticated executing user
 * id (never a payload field).
 */
export function computeCartIntentHash({ shopId, actorId, lines, requester, barterItemId }) {
  const canonical = JSON.stringify({
    shopId: String(shopId),
    actorId: String(actorId),
    lines: lines
      .map((l) => ({
        entryId: String(l.entryId),
        quantity: Number(l.quantity),
        specialId: String(l.specialId ?? ''),
      }))
      .sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0)),
    requester: String(requester),
    barterItemId: String(barterItemId ?? ''),
  });
  return fnv1a(canonical);
}

/**
 * Resolve an already-persisted cart order for the current intent. Never applies
 * a side effect:
 *   - same key + same intentHash on a `committed` order => replay its recorded
 *     outcome (unchanged, no re-charge).
 *   - same key + same intentHash on a `pending`/`needsRecovery` order =>
 *     `needsRecovery` (manual recovery; no effect applied, never recharges).
 *   - same key + same intentHash on any other terminal status => replay.
 *   - same key + different intentHash => `conflict` (lines changed).
 */
function resolveExistingOrder(existing, intentHash) {
  if (existing.intentHash !== intentHash) {
    return {
      status: 'conflict',
      conflict: true,
      orderId: existing.id,
      error: 'conflicting duplicate payload',
      expected: existing.intentHash,
      existing,
    };
  }
  if (existing.status === 'committed') {
    const outcome = existing.outcome || {};
    const total = outcome.total ?? existing.total ?? 0;
    return {
      status: 'replay',
      orderId: existing.id,
      originalStatus: existing.status,
      total,
      quantity: outcome.quantity ?? existing.quantity ?? 0,
      barterCredit: outcome.barterCredit ?? 0,
      cashPaid: outcome.cashPaid ?? total,
      items: outcome.items || [],
    };
  }
  if (existing.status === 'pending' || existing.status === 'needsRecovery') {
    return {
      status: 'needsRecovery',
      orderId: existing.id,
      error: existing.error || 'order-pending',
    };
  }
  // failed / booked / fulfilled / cancelled -> a terminal replay of the record.
  return { status: 'replay', orderId: existing.id, originalStatus: existing.status };
}

export function createCartCommerce(deps) {
  const {
    store,
    runShopExclusive,
    isActiveGM = () => true,
    getActor,
    actorOwnedBy,
    getAdapter,
    fromUuid,
    getSocial,
    getWorldTime,
    now,
    getApprovedValuation,
    logger,
  } = deps;

  /**
   * Sentinel thrown when a GM handover is detected mid-flight (after the pending
   * order but before all effects are applied). The former GM must stop applying
   * further effects; compensation undoes whatever was applied and the order is
   * marked `failed` when safe or `needsRecovery` when a compensating step is
   * itself uncertain.
   */
  function activeGmOrThrow() {
    if (!isActiveGM()) {
      const err = new Error('gm-handoff');
      err.code = 'gm-handoff';
      throw err;
    }
  }

  /**
   * Best-effort phase marker. A failed phase write is never fatal: the phase is
   * only a diagnostic, and the final commit sets `phase: 'final'` anyway. A
   * `null`/missing return (the order is gone) is reported as `false` so the
   * caller can flag the order as uncertain; a thrown write is logged and also
   * reported as `false` rather than aborting the sequence.
   */
  async function setPhase(orderId, phase) {
    try {
      const updated = await store.updateAdvancedOrder(orderId, { phase });
      if (updated == null) {
        logger?.warn?.(
          `[market] advanced order ${orderId} was missing during '${phase}' phase write`
        );
        return false;
      }
      return true;
    } catch (err) {
      logger?.error?.(
        `[market] failed to persist cart phase '${phase}' for order ${orderId}`,
        err
      );
      return false;
    }
  }

  /**
   * Resolve the world clock used for the trading gate. Prefers the authoritative
   * server-side `getWorldTime` (the M4 trading/presence clock); falls back to
   * `now` for compatibility, and to no clock (legacy `shop.open` toggle) when
   * neither is supplied.
   */
  function resolveClock() {
    if (typeof getWorldTime === 'function') return getWorldTime();
    if (typeof now === 'function') return now();
    return null;
  }

  /**
   * The trading gate for a cart checkout. Re-read at transaction time (never
   * trusting a request snapshot); returned as an error string, or null when
   * trading. An invalid clock fails closed `invalid-world-time` BEFORE any
   * effect.
   */
  function tradingError(shop) {
    const clockValue = resolveClock();
    if (clockValue != null) {
      const worldTime = safeWorldTime(clockValue);
      if (worldTime == null) return 'invalid-world-time';
      const trading = isShopTrading(shop, worldTime);
      if (!trading.open) return 'shop-closed';
      return null;
    }
    return shop.open === false ? 'shop-closed' : null;
  }

  /**
   * Resolve the item source for an entry. Prefers the live `itemUuid`; if it is
   * absent or deleted (fromUuid returns null) falls back to a valid snapshot.
   * Returns null when both are missing, which forbids the checkout line.
   */
  async function resolveItemSource(entry) {
    const uuid = typeof entry.itemUuid === 'string' ? entry.itemUuid.trim() : '';
    if (uuid) {
      const source = await fromUuid(uuid);
      if (source) return source;
    }
    const snapshot = parseItemData(entry.snapshot);
    if (snapshot) return snapshot;
    return null;
  }

  /**
   * Add two non-negative safe integers with a safe-integer overflow check (never
   * silently wraps). Throws an `total-overflow` error on overflow, which the
   * caller surfaces as a fail-closed validation error before any effect.
   */
  function safeAdd(a, b) {
    const sum = Number(BigInt(a) + BigInt(b));
    if (!Number.isSafeInteger(sum)) {
      throw new Error('total-overflow');
    }
    return sum;
  }

  /**
   * The balance verdict for a throwing debit: whether the debit actually applied
   * (so compensation must refund) and whether the state is uncertain. `before`
   * is the balance captured before the debit. Returns `{ debited, uncertain }`:
   *   - balance unchanged               => `{ debited: false, uncertain: false }`
   *   - balance decreased by exactly amount
   *                                     => `{ debited: true, uncertain: false }`
   *   - balance diverged (or could not be re-read)
   *                                     => uncertain.
   */
  async function debitVerdict({ adapter, actor, amount, before }) {
    if (before == null) {
      try {
        before = await adapter.getBalance(actor);
      } catch (err) {
        return { debited: false, uncertain: true };
      }
    }
    let after = null;
    try {
      after = await adapter.getBalance(actor);
    } catch (err) {
      return { debited: false, uncertain: true };
    }
    if (after === before) return { debited: false, uncertain: false };
    if (after === before - amount) return { debited: true, uncertain: false };
    return { debited: false, uncertain: true };
  }

  /**
   * Execute a GM-authoritative cart checkout. `authenticatedRequesterId` is the
   * authenticated user executing the transaction (the active GM) and is used as
   * the actor-ownership principal, the idempotency-key prefix, and the order
   * `userId`. Never a payload field.
   *
   * `payload` is
   * `{ shopId, actorId, lines: [{ entryId, quantity }], requestId, barterItemId? }`.
   * Only `actorId` is debited; no other contributor is charged. When
   * `barterItemId` is supplied, the actor tenders exactly one whole embedded
   * `Item` as payment credit (capped at the cart gross total); only the cash
   * remainder is debited and no other currency is charged.
   */
  function checkout(payload = {}, authenticatedRequesterId) {
    let shopId;
    let actorId;
    let requestId;
    let lines;
    let barterItemId;
    let requester;
    try {
      shopId = assertMarketId(payload.shopId, 'shopId');
      actorId = assertMarketId(payload.actorId, 'actorId');
      requestId = payload.requestId
        ? assertMarketId(payload.requestId, 'requestId')
        : makeId();
      barterItemId = assertOptionalMarketId(payload.barterItemId, 'barterItemId');
      requester = String(authenticatedRequesterId ?? '').trim();
      if (requester === '') {
        throw new Error('authenticatedUserId must be a non-empty string');
      }
      lines = normalizeLines(payload.lines);
    } catch (err) {
      return Promise.resolve({ status: 'error', error: err.message });
    }

    // GM gate BEFORE any store read. A player watching the app never triggers a
    // read or a write.
    if (!isActiveGM()) {
      return Promise.resolve({ status: 'error', error: 'not-active-gm' });
    }

    const key = `cart:${requester}:${requestId}`;
    const intentHash = computeCartIntentHash({
      shopId,
      actorId,
      lines,
      requester,
      barterItemId,
    });

    return runShopExclusive(shopId, () =>
      checkoutLocked({
        shopId,
        actorId,
        lines,
        requester,
        key,
        intentHash,
        barterItemId,
      })
    );
  }

  /**
   * Normalize and validate the `lines` array. Enforces the documented caps: at
   * most CART_MAX_LINES lines, unique entry ids, and a safe quantity in
   * [1, CART_MAX_QUANTITY] per line. Throws a clean error code (no prefix) so the
   * caller surfaces it as a fail-closed validation error.
   */
  function normalizeLines(rawLines) {
    if (!Array.isArray(rawLines)) {
      throw new Error('lines must be an array');
    }
    if (rawLines.length > CART_MAX_LINES) {
      throw new Error(`too-many-lines (max ${CART_MAX_LINES})`);
    }
    const seen = new Set();
    const out = [];
    for (const raw of rawLines) {
      const entryId = assertMarketId(raw?.entryId, 'lines[].entryId');
      const quantity = assertCartQuantity(raw?.quantity, 'lines[].quantity');
      // An optional per-line special offer id. An absent/blank value collapses to
      // '' (regular pricing); a present value must be a market-id (<= 120 chars,
      // no control chars), same discipline as `barterItemId`.
      const specialId = assertOptionalMarketId(raw?.specialId, 'lines[].specialId');
      if (seen.has(entryId)) {
        throw new Error('duplicate-entry');
      }
      seen.add(entryId);
      out.push({ entryId, quantity, specialId });
    }
    return out;
  }

  async function checkoutLocked(ctx) {
    const { shopId, actorId, lines, requester, key, intentHash, barterItemId } = ctx;

    // 0. Re-check the active-GM guard before ANY read. A handover between the
    //    outer gate and acquiring the lock means a player watching the app still
    //    never triggers a read.
    if (!isActiveGM()) {
      return { status: 'error', error: 'not-active-gm' };
    }

    // 1. Idempotency re-read BEFORE any state change.
    let existing;
    try {
      existing = await store.findAdvancedOrderByKey(key);
    } catch (err) {
      return {
        status: 'error',
        error: `order-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (existing) {
      return resolveExistingOrder(existing, intentHash);
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 2. Re-read the shop inside the lock (never trust the request).
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

    // 3. Re-read the actor and verify ownership.
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
    if (!actorOwnedBy(actor, requester)) {
      return { status: 'error', error: 'actor-not-owned' };
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 4. Trading gate (world clock read server-side, fail closed).
    const gateError = tradingError(shop);
    if (gateError) return { status: 'error', error: gateError };

    // 5. Resolve each line against the STORED shop and quote it at the current
    //    shop/actor reputation, never a client price. A `backroom` entry must be
    //    accessible to the actor; a Hated reputation refuses the whole checkout.
    let effective;
    if (getSocial) {
      try {
        effective = await getSocial(shop, actor);
      } catch (err) {
        return {
          status: 'error',
          error: `rep-read-failed: ${(err && err.message) || err}`,
        };
      }
    }

    const quotes = [];
    const entryChangesByPrimary = new Map();
    for (const line of lines) {
      const entry = shop.inventory.find((e) => e.id === line.entryId);
      if (!entry) return { status: 'error', error: 'entry-not-found' };
      if (entry.visible === false) {
        return { status: 'error', error: 'entry-hidden' };
      }
      if (!canAccessEntry(entry, { actorUuid: actor?.uuid, score: effective?.score ?? -100 })) {
        return { status: 'error', error: 'entry-restricted' };
      }
      if (entry.stockMode !== 'unlimited' && entry.quantity < line.quantity) {
        return { status: 'error', error: 'insufficient-stock' };
      }
      let source;
      try {
        source = await resolveItemSource(entry);
      } catch (err) {
        return {
          status: 'error',
          error: `item-source-failed: ${(err && err.message) || err}`,
        };
      }
      if (!source) return { status: 'error', error: 'item-source-missing' };

      // An optional per-line merchant special. The offer is re-read from the
      // STORED shop - never a client price - and must be an exact match on this
      // entry, still visible, and permitted for the actor via `quoteSpecial`
      // (actor-UUID allowlist). An invalid/unauthorized offer fails the whole
      // checkout closed BEFORE any debit so a forged specialId can never charge
      // the wrong amount.
      let special = null;
      if (line.specialId) {
        const candidate = findShopSpecial(shop, line.specialId);
        const eligible =
          candidate &&
          candidate.visible !== false &&
          candidate.entryId === entry.id &&
          quoteSpecial(entry, candidate, actor?.uuid) !== null;
        if (!eligible) {
          return { status: 'error', error: 'special-unavailable' };
        }
        special = candidate;
      }

      // Quote against a shallow copy carrying the special's configured price so
      // the social engine still applies shop/personality/reputation to the offer
      // price (never a client-supplied number).
      const quoteEntry = special ? { ...entry, price: special.price } : entry;
      let unitPrice;
      let total;
      if (getSocial) {
        let q;
        try {
          q = quoteSocial(quoteEntry, line.quantity, {
            shop,
            scores: { individual: effective?.individual, party: effective?.party },
          });
        } catch (err) {
          return {
            status: 'error',
            error: `total-overflow: ${(err && err.message) || err}`,
          };
        }
        if (q.refused) {
          return {
            status: 'error',
            error: 'service-refused',
            detail: 'shop reputation is Hated',
          };
        }
        unitPrice = q.unitPrice;
        total = q.total;
      } else {
        try {
          total = quote(quoteEntry, line.quantity);
        } catch (err) {
          return {
            status: 'error',
            error: `total-overflow: ${(err && err.message) || err}`,
          };
        }
        unitPrice = quoteEntry.price;
      }

      quotes.push({
        entry,
        source,
        quantity: line.quantity,
        unitPrice,
        total,
        special,
      });
      if (entry.stockMode !== 'unlimited') {
        // Track the exact before/after so compensation can compare its OWN
        // changed quantities rather than guessing.
        entryChangesByPrimary.set(entry.id, {
          entryId: entry.id,
          before: entry.quantity,
          after: entry.quantity - line.quantity,
        });
      }
    }

    // 6. BigInt-safe total sum across all quoted lines.
    let total = 0;
    try {
      for (const q of quotes) {
        total = safeAdd(total, q.total);
      }
    } catch (err) {
      return { status: 'error', error: 'total-overflow' };
    }

    const totalQuantity = quotes.reduce((acc, q) => acc + q.quantity, 0);

    // 7. Adapter must be supported, the optional item-for-price barter tender
    //    resolved, and the player's balance must cover the cash remainder.
    const adapter = getAdapter();
    if (!adapter || !adapter.supported) {
      return { status: 'error', error: 'adapter-unsupported' };
    }

    // 7b. Optional barter: one whole embedded Item owned by the paying actor is
    //     accepted as credit against the cart gross total, capped at the total
    //     (never a cash payout out). Only the cash remainder is ever debited.
    let barter = null;
    let cashPaid = total;
    if (barterItemId) {
      const resolved = await resolveBarter({
        adapter,
        shop,
        actor,
        barterItemId,
        total,
        getApprovedValuation,
      });
      if (resolved.error) return { status: 'error', error: resolved.error };
      barter = resolved.barter;
      cashPaid = barter.cashPaid;
      if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };
    }

    // 7c. The player's live balance must cover the cash remainder (never the
    //     bartered credit - the item already covers that portion).
    let balance;
    try {
      balance = await adapter.getBalance(actor);
    } catch (err) {
      return {
        status: 'error',
        error: `balance-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (balance < cashPaid) {
      return {
        status: 'error',
        error: 'insufficient-funds',
        detail: `need ${cashPaid}, have ${balance}`,
      };
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 8. Optional finite merchant funds GAIN only the cash remainder (the
    //    bartered item is not currency, so the shop's funds never see it). Refuse
    //    on a safe-integer overflow BEFORE any effect rather than wrapping. `null`
    //    funds stay unlimited (no funds patch written).
    const funds = shop.commerce ? shop.commerce.funds : null;
    const finiteFunds = funds != null;
    const fundsBefore = funds;
    let fundsAfter = null;
    if (finiteFunds) {
      const gained = Number(BigInt(funds) + BigInt(cashPaid));
      if (!Number.isSafeInteger(gained)) {
        return { status: 'error', error: 'funds-overflow' };
      }
      fundsAfter = gained;
    }

    // 9. Persist the PENDING order BEFORE charging, with a bounded private line
    //    breakdown (including per-line snapshot fallbacks) in `details`. The
    //    order normalizer enforces the 64KB cap: an overflow makes
    //    `createAdvancedOrder` throw and the checkout fails BEFORE any effect.
    const detailsLines = quotes.map((q) => ({
      entryId: q.entry.id,
      name: q.entry.name,
      quantity: q.quantity,
      unitPrice: q.unitPrice,
      total: q.total,
      itemUuid: q.entry.itemUuid || '',
      snapshot: q.entry.snapshot || '',
      specialId: q.special ? String(q.special.id) : '',
    }));
    const details = {
      lines: detailsLines,
      total,
      fundsBefore,
    };
    if (barter) {
      // The bartered tender snapshot is immutable; it is captured in `details`
      // (private, may be large) so compensation can restore the exact id. The
      // public `outcome` deliberately omits it.
      details.barter = {
        itemId: barter.itemId,
        snapshot: barter.snapshot,
        barterCredit: barter.barterCredit,
        cashPaid: barter.cashPaid,
        buybackEntryId: barter.buybackEntry.id,
        buybackPrice: barter.buybackPrice,
        ...(barter.consumedValuation
          ? { consumedValuation: barter.consumedValuation }
          : {}),
      };
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    const orderRecord = {
      key,
      kind: 'cart',
      status: 'pending',
      phase: 'recorded',
      shopId,
      userId: requester,
      actorId,
      entryId: '',
      quantity: totalQuantity,
      total,
      deposit: 0,
      remaining: total,
      intentHash,
      details,
      outcome: {},
    };
    let createdResult;
    try {
      createdResult = await store.createAdvancedOrder(orderRecord);
    } catch (err) {
      return {
        status: 'error',
        error: `order-create-failed: ${(err && err.message) || err}`,
      };
    }
    const order = createdResult.record;
    if (!createdResult.created) {
      // A create-race handed back an existing cart order for the same key;
      // resolve idempotently and NEVER apply an effect.
      return resolveExistingOrder(order, intentHash);
    }
    const orderId = order.id;

    // 10. Effects (when bartering): remove tender -> bartered -> debit remainder
    //     -> debited -> deliver each line -> transferred -> ONE shop write (stock +
    //     barter listing + funds) -> stocked -> commit -> final. Any failure AFTER
    //     pending goes through best-effort compensation; never silently double-debits
    //     or double-restores.
    let debited = false;
    let delivered = [];
    let shopWriteAttempted = false;
    let uncertain = false;
    let barterRemoved = false;
    const entryChanges = Array.from(entryChangesByPrimary.values());
    try {
      activeGmOrThrow();

      // Barter: remove the tender Item BEFORE the cash debit and record the phase.
      if (barter) {
        const verdict = await removeTender(actor, barter.itemId);
        barterRemoved = verdict.removed;
        if (verdict.uncertain) uncertain = true;
        if (verdict.failed) {
          throw new Error('barter-item-remove-failed');
        }
        activeGmOrThrow();
        if (!(await setPhase(orderId, 'bartered'))) uncertain = true;
      }

      // Debit the cash remainder ONCE. A throwing debit may STILL have applied, so
      // it is ALWAYS rolled back (never trusted); the balance verdict only decides
      // whether the player must be refunded and whether the state is uncertain.
      try {
        await adapter.debit(actor, cashPaid);
        debited = true;
      } catch (err) {
        const verdict = await debitVerdict({
          adapter,
          actor,
          amount: cashPaid,
          before: balance,
        });
        debited = verdict.debited;
        if (verdict.uncertain) uncertain = true;
        throw err;
      }

      activeGmOrThrow();
      if (!(await setPhase(orderId, 'debited'))) uncertain = true;

      // Deliver each line and record the created id so compensation can remove it.
      // A deliverItem call that THROWS may still have delivered an item with an
      // unknown id, so the line is recorded with a null createdId (uncertain) and
      // the checkout is marked uncertain - never a clean refund/remove.
      for (const q of quotes) {
        activeGmOrThrow();
        let created;
        try {
          created = await adapter.deliverItem(actor, q.source, {
            quantity: q.quantity,
          });
        } catch (err) {
          delivered.push({
            entryId: q.entry.id,
            createdId: null,
          });
          uncertain = true;
          throw err;
        }
        delivered.push({
          entryId: q.entry.id,
          createdId: created && (created.id ?? null),
        });
      }

      activeGmOrThrow();
      if (!(await setPhase(orderId, 'transferred'))) uncertain = true;

      // ONE shop write inside the lock: decrement all finite/non-restocking stock,
      // append the barter buyback listing (when bartering), when funds are finite
      // gain only the cash remainder, AND consume the GM-approved barter valuation
      // (remove the exact entry from the private valuations list) when bartering so
      // a single approval can never be replayed into a second credit. Never
      // overwrite other fields.
      const newInventory = shop.inventory.map((e) => {
        const change = entryChangesByPrimary.get(e.id);
        if (change) return { ...e, quantity: change.after };
        return e;
      });
      if (barter) newInventory.push(barter.buybackEntry);
      let commerce = shop.commerce;
      if (finiteFunds) commerce = { ...commerce, funds: fundsAfter };
      if (barter && barter.consumedValuation) {
        const valuations = (commerce && commerce.valuations
          ? commerce.valuations
          : []
        ).filter((v) => v.id !== barter.consumedValuation.id);
        commerce = { ...commerce, valuations };
      }
      shopWriteAttempted = true;
      const shopWritten = await store.updateShop(shopId, {
        inventory: newInventory,
        commerce,
      });
      if (shopWritten == null) throw new Error('shop-write-missing');
      activeGmOrThrow();
      if (!(await setPhase(orderId, 'stocked'))) uncertain = true;

      // Commit. Only claim committed when the terminal write actually persisted a
      // record: a `null` return means the order is gone, so the checkout must be
      // treated as uncertain rather than committed. The safe public outcome adds
      // the bounded `barterCredit`/`cashPaid` - never the raw tender snapshot.
      const outcome = {
        total,
        quantity: totalQuantity,
        barterCredit: barter ? barter.barterCredit : 0,
        cashPaid,
        items: quotes.map((q) => ({
          entryId: q.entry.id,
          name: q.entry.name,
          quantity: q.quantity,
          ...(q.special
            ? { specialId: String(q.special.id), specialPrice: q.unitPrice }
            : {}),
        })),
      };
      let commitErr = null;
      let commitMissing = false;
      try {
        const committedRecord = await store.updateAdvancedOrder(orderId, {
          status: 'committed',
          phase: 'final',
          outcome,
        });
        if (committedRecord == null) {
          commitMissing = true;
          commitErr = new Error('order-commit-missing');
        } else {
          return {
            status: 'committed',
            orderId,
            total,
            quantity: totalQuantity,
            barterCredit: barter ? barter.barterCredit : 0,
            cashPaid,
            items: outcome.items,
          };
        }
      } catch (err) {
        commitErr = err;
      }

      // The terminal committed write threw or returned null. The store may have
      // persisted `committed` and THEN thrown (apply-then-throw), so never blindly
      // reverse effects. Re-read the record by id to learn the truth: a committed
      // record means the checkout succeeded (no compensation); an uncommitted one
      // means compensate as the existing path does; and an unavailable re-read
      // means escalate to needsRecovery without reversing anything.
      let reread = null;
      try {
        reread = await store.findAdvancedOrder(orderId);
      } catch (e) {
        reread = null;
      }

      if (reread && reread.status === 'committed') {
        const recOutcome = reread.outcome || {};
        return {
          status: 'committed',
          orderId,
          total: recOutcome.total ?? total,
          quantity: recOutcome.quantity ?? totalQuantity,
          barterCredit: recOutcome.barterCredit ?? (barter ? barter.barterCredit : 0),
          cashPaid: recOutcome.cashPaid ?? cashPaid,
          items: recOutcome.items || outcome.items,
        };
      }

      if (reread != null) {
        // The record is present but not committed (pending / failed /
        // needsRecovery): a known-uncommitted state, so compensate as before. The
        // outer catch applies best-effort compensation for a thrown commit; the
        // ambiguous commit-missing case is flagged uncertain.
        if (commitMissing) uncertain = true;
        throw commitErr;
      }

      // Re-read unavailable (threw or order missing): cannot confirm the commit.
      // Do NOT reverse any effect - escalate to needsRecovery and mark the record
      // only when safe.
      await markOrderNeedsRecovery(orderId, commitErr);
      return {
        status: 'needsRecovery',
        orderId,
        error: String((commitErr && commitErr.message) || commitErr),
        compensation: [],
      };
    } catch (err) {
      if (err && err.message === 'order-commit-missing') uncertain = true;
      return compensate({
        err,
        orderId,
        shopId,
        actor,
        total,
        cashPaid,
        debited,
        delivered,
        shopWriteAttempted,
        entryChanges,
        finiteFunds,
        fundsBefore,
        fundsAfter,
        details,
        barter,
        barterRemoved,
        uncertain,
        adapter,
        now,
      });
    }
  }

  /**
   * Best-effort recovery after a pending cart order was persisted and an effect
   * (or the final commit) failed. Undoes exactly what may have been applied and
   * never double-compensates: a removed barter tender is restored via
   * `createEmbeddedDocuments('Item', [snapshot], { keepId: true })` verified by
   * `actor.items.get`, delivered lines are removed in reverse, the actor is
   * credited the cash remainder only if the debit applied, and the shop
   * stock/funds/barter-listing are restored only when the single shop write
   * actually applied - decided by comparing the CURRENT shop to the order's OWN
   * before/after entry quantities, funds and buyback-listing presence. A fully
   * successful compensation records `failed`, an uncertain/failed one records
   * `needsRecovery`. A failure to write the terminal status leaves the record
   * `pending` (a replay then surfaces it).
   */
  async function compensate(ctx) {
    const {
      err,
      orderId,
      shopId,
      actor,
      total,
      cashPaid,
      debited,
      delivered,
      shopWriteAttempted,
      entryChanges,
      finiteFunds,
      fundsBefore,
      fundsAfter,
      details,
      barter = null,
      barterRemoved = false,
      uncertain = false,
      adapter,
      now,
    } = ctx;
    const compensation = [];
    let uncertainOutcome = uncertain;

    // Restore the bartered tender first (it was removed before the cash debit).
    // Only run when it was actually removed; keepId restores the original id and
    // the restore is verified with actor.items.get. A still-missing item after the
    // restore is an uncertain recovery.
    if (barterRemoved && barter) {
      try {
        await actor.createEmbeddedDocuments('Item', [barter.snapshotData], {
          keepId: true,
        });
        if (itemStillPresent(actor, barter.itemId)) {
          compensation.push('tender-restored');
        } else {
          compensation.push('tender-restore-id-failed');
          uncertainOutcome = true;
        }
      } catch (e) {
        compensation.push('tender-restore-failed');
        uncertainOutcome = true;
      }
    }

    // Deliveries are removed in reverse order. A line whose delivery threw carries
    // a null createdId - the item may or may not have been delivered, with an
    // unknown id - so it is inherently uncertain, never a clean removal.
    for (let i = delivered.length - 1; i >= 0; i--) {
      const { entryId, createdId } = delivered[i];
      if (createdId == null) {
        compensation.push(`item-unknown:${entryId}`);
        uncertainOutcome = true;
      } else {
        try {
          await adapter.removeItem(actor, createdId);
          compensation.push(`item-removed:${entryId}`);
        } catch (e) {
          compensation.push(`item-remove-failed:${entryId}`);
          uncertainOutcome = true;
        }
      }
    }

    // Credit the player the cash remainder only if the debit was applied. When the
    // adapter exposes getBalance, the refund is VERIFIED: the post-credit balance
    // must be the pre-credit balance plus the refunded amount, else the refund is
    // uncertain (needsRecovery), never a clean currency-refunded.
    if (debited) {
      let refundBefore = null;
      const canVerify = typeof adapter.getBalance === 'function';
      if (canVerify) {
        try {
          refundBefore = await adapter.getBalance(actor);
        } catch (e) {
          // Pre-refund balance unknowable; verification still runs but can only
          // compare when a numeric before was actually read.
        }
      }
      try {
        await adapter.credit(actor, cashPaid);
        compensation.push('currency-refunded');
      } catch (e) {
        compensation.push('currency-refund-failed');
        uncertainOutcome = true;
      }
      if (canVerify) {
        try {
          const refundAfter = await adapter.getBalance(actor);
          if (refundBefore != null && refundAfter !== refundBefore + cashPaid) {
            compensation.push('currency-refund-mismatch');
            uncertainOutcome = true;
          }
        } catch (e) {
          compensation.push('currency-refund-verify-failed');
          uncertainOutcome = true;
        }
      }
    }

    // Shop stock/funds/barter-listing restoration, only when the single shop write
    // was attempted. Decide whether it applied by comparing the current shop to
    // THIS cart's own changed entry quantities, funds, and (when bartering) the
    // presence of the buyback listing - never a best-effort guess.
    if (shopWriteAttempted) {
      try {
        const current = await store.findShop(shopId);
        if (!current) {
          compensation.push('shop-missing');
          uncertainOutcome = true;
        } else {
          let anyApplied = false;
          let anyNotApplied = false;
          let mixed = false;
          for (const change of entryChanges) {
            const curr = current.inventory.find((e) => e.id === change.entryId);
            if (!curr) {
              mixed = true;
            } else if (curr.quantity === change.after) {
              anyApplied = true;
            } else if (curr.quantity === change.before) {
              anyNotApplied = true;
            } else {
              mixed = true;
            }
          }
          const currentFunds = current.commerce ? current.commerce.funds : null;
          const fundsChanged = finiteFunds && fundsAfter !== fundsBefore;
          if (fundsChanged) {
            if (currentFunds === fundsAfter) {
              anyApplied = true;
            } else if (currentFunds === fundsBefore) {
              anyNotApplied = true;
            } else {
              mixed = true;
            }
          }
          // A barter buyback listing that should have been appended is an
          // additional signal of whether the shop write landed. An existing
          // listing counts as applied; a missing one counts as not-applied.
          if (barter) {
            const listingExists = current.inventory.some(
              (e) => e.id === barter.buybackEntry.id
            );
            if (listingExists) anyApplied = true;
            else anyNotApplied = true;
          }
          // A consumed barter valuation (from the real runtime) is removed from the
          // shop's private valuations by the checkout's single shop write. A
          // still-present entry is therefore a no-write signal; an absent entry is
          // an applied signal, exactly like the listing presence above.
          const consumedValuation = barter && barter.consumedValuation;
          const currentValuations = Array.isArray(
            current.commerce && current.commerce.valuations
          )
            ? current.commerce.valuations
            : [];
          if (consumedValuation) {
            const valPresent = currentValuations.some(
              (v) => v.id === consumedValuation.id
            );
            if (valPresent) anyNotApplied = true;
            else anyApplied = true;
          }

          if (mixed) {
            compensation.push('shop-state-mixed');
            uncertainOutcome = true;
          } else if (anyApplied && anyNotApplied) {
            compensation.push('shop-state-mixed');
            uncertainOutcome = true;
          } else if (anyApplied) {
            // Known full-write: restore this cart's exact entries and funds (and
            // remove the barter listing) in the SAME update, then verify the
            // persisted shop before claiming success.
            let restoredInventory = current.inventory.map((e) => {
              const change = entryChanges.find((c) => c.entryId === e.id);
              if (change) return { ...e, quantity: change.before };
              return e;
            });
            if (barter) {
              restoredInventory = restoredInventory.filter(
                (e) => e.id !== barter.buybackEntry.id
              );
            }
            let commerce = current.commerce;
            if (finiteFunds) commerce = { ...commerce, funds: fundsBefore };
            if (consumedValuation) {
              const keptValuations = (commerce && commerce.valuations
                ? commerce.valuations
                : []
              ).filter((v) => v.id !== consumedValuation.id);
              commerce = {
                ...commerce,
                valuations: [...keptValuations, consumedValuation],
              };
            }
            const returned = await store.updateShop(shopId, {
              inventory: restoredInventory,
              commerce,
            });
            const valuationRestored =
              !consumedValuation ||
              (returned &&
                Array.isArray(returned.commerce && returned.commerce.valuations) &&
                returned.commerce.valuations.some((v) => v.id === consumedValuation.id));
            const verified = !!(
              returned &&
              entryChanges.every((c) => {
                const e = returned.inventory.find((x) => x.id === c.entryId);
                return e && e.quantity === c.before;
              }) &&
              (!barter ||
                !returned.inventory.some((x) => x.id === barter.buybackEntry.id)) &&
              (!finiteFunds ||
                (returned.commerce && returned.commerce.funds === fundsBefore)) &&
              valuationRestored
            );
            if (verified) {
              compensation.push('shop-restored');
            } else {
              compensation.push('shop-restore-verify-failed');
              uncertainOutcome = true;
            }
          } else {
            // No observable change (either the write never landed, or it wrote
            // nothing different): nothing to undo.
            compensation.push('shop-unwritten');
          }
        }
      } catch (e) {
        compensation.push('shop-restore-failed');
        uncertainOutcome = true;
      }
    }

    const status = uncertainOutcome ? 'needsRecovery' : 'failed';
    let responseStatus = status;
    try {
      const updated = await store.updateAdvancedOrder(orderId, {
        status,
        phase: 'final',
        error: String((err && err.message) || err),
        details: {
          ...details,
          error: String((err && err.message) || err),
          compensation,
          updatedAt: now ? now() : Date.now(),
        },
      });
      if (updated == null) {
        // The record is missing even for the terminal status write: the call has
        // to surface needsRecovery rather than pretending a persisted record.
        responseStatus = 'needsRecovery';
        compensation.push('order-write-missing');
      }
    } catch (e) {
      logger?.error?.(
        `[market] failed to persist cart compensation for order ${orderId}`,
        e
      );
    }
    return {
      status: responseStatus,
      orderId,
      error: String((err && err.message) || err),
      compensation,
    };
  }

  /**
   * Best-effort terminal marker after the final commit write was ambiguous and the
   * re-read unavailable (it threw or returned null). Never reverses an effect: the
   * committed status may or may not have landed, so only the `needsRecovery` marker
   * is written - and a failed marker write is logged, leaving the record `pending`
   * for a later replay to surface. This is the "safe" escalation: the effects stay
   * applied and the order is left for manual recovery.
   */
  async function markOrderNeedsRecovery(orderId, err) {
    try {
      const updated = await store.updateAdvancedOrder(orderId, {
        status: 'needsRecovery',
        phase: 'final',
        error: String((err && err.message) || err),
      });
      if (updated == null) {
        logger?.warn?.(
          `[market] advanced order ${orderId} was missing while marking cart needsRecovery`
        );
      }
    } catch (e) {
      logger?.error?.(
        `[market] failed to persist cart needsRecovery for order ${orderId}`,
        e
      );
    }
  }

  return { checkout };
}

export default createCartCommerce;
