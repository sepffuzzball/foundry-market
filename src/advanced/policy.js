// M5 advanced commerce configuration policies and pure quotes.
//
// This module is intentionally free of any Foundry globals so it can be imported
// by Node for tests. Every function here is deterministic and pure: it reads a
// normalized shop record (or a single inventory entry / special) and derives an
// access decision, a visible-entry projection, or an integer quote - and never
// mutates its inputs and never performs a store write. The purchase path is
// untouched in this milestone: these helpers are offered for the GM config and
// public projection, and `quoteSpecial` reports a special's configured price
// without overriding the existing `quote(...)` purchase pricing.
//
// Money is always expressed in non-negative integer "minor units". Quoting uses
// BigInt intermediates so no float arithmetic is ever produced and extreme rates
// cannot silently wrap; each result is checked against Number.MAX_SAFE_INTEGER
// (overflow throws rather than wrapping).

import { assertMinorUnits } from '../services/pricing.js';
import {
  COMMERCE_RATE_DEFAULT_BUY,
  COMMERCE_RATE_DEFAULT_BUYBACK,
  PREORDER_DEPOSIT_BPS_DEFAULT,
} from '../services/model.js';

const BPS_SCALE = 10000n;

function rateBps(shop, field, fallback) {
  const commerce = shop && shop.commerce;
  const value = commerce ? commerce[field] : undefined;
  return value == null ? fallback : value;
}

/**
 * Whether `actorUuid` is allowed to access `entry` given its `access` gate.
 *
 * `context` carries `{ actorUuid, score }` where `score` is the actor's
 * effective reputation for the shop (a number, or undefined when unknown).
 *
 * - A shop inventory entry without an `access` block is public and requires
 *   only that the entry is `visible` (a back-compat default).
 * - A `public` entry is accessible only when it is also `visible`.
 * - A `backroom` entry is accessible when the actor's uuid is in the access
 *   allowlist, OR (when `minReputation` is above -100) the actor's score is
 *   at least `minReputation`. With no allowlist entries and a `minReputation`
 *   of -100 the backroom denies everyone (never accidentally public).
 *
 * Never mutates the entry.
 */
export function canAccessEntry(entry, { actorUuid, score } = {}) {
  if (!entry) return false;
  const access = entry.access;
  if (!access || access.mode !== 'backroom') {
    return entry.visible !== false;
  }
  const uuids = Array.isArray(access.actorUuids) ? access.actorUuids : [];
  const uuidMatch =
    typeof actorUuid === 'string' &&
    actorUuid !== '' &&
    uuids.includes(actorUuid);
  const minRep = Number.isFinite(access.minReputation)
    ? access.minReputation
    : -100;
  const repMatch =
    minRep > -100 &&
    typeof score === 'number' &&
    Number.isFinite(score) &&
    score >= minRep;
  return uuidMatch || repMatch;
}

/**
 * The inventory entries of `shop` that `actorUuid` with effective reputation
 * `score` may see/access: only `visible` entries whose `access` gate permits
 * the actor. Never mutates the shop or any entry.
 */
export function visibleEntriesFor(shop, actorUuid, score) {
  const inventory = Array.isArray(shop && shop.inventory) ? shop.inventory : [];
  return inventory.filter(
    (entry) =>
      entry.visible !== false &&
      canAccessEntry(entry, { actorUuid, score })
  );
}

/**
 * The price the shop will pay to buy `itemPrice` from a player. Uses the shop's
 * `commerce.buyRateBps` to compute `floor(itemPrice * buyRateBps / 10000)` with
 * BigInt intermediates; a zero item price stays 0. Returns a non-negative safe
 * integer; throws on overflow. Never mutates the shop.
 */
export function quoteSell(itemPrice, shop) {
  const price = assertMinorUnits(itemPrice, 'itemPrice');
  if (price === 0) return 0;
  const bps = rateBps(shop, 'buyRateBps', COMMERCE_RATE_DEFAULT_BUY);
  const value = Number((BigInt(price) * BigInt(bps)) / BPS_SCALE);
  if (!Number.isSafeInteger(value)) {
    throw new Error('[market] quoteSell overflowed a safe integer');
  }
  return value;
}

/**
 * The price the shop will pay when buying back `paid` worth of goods from a
 * player. Uses `commerce.buybackRateBps` to compute
 * `ceil(paid * buybackRateBps / 10000)` with BigInt intermediates (rounds up so
 * a player is never under-paid). Returns a non-negative safe integer; throws on
 * overflow. Never mutates the shop.
 */
export function quoteBuyback(paid, shop) {
  const p = assertMinorUnits(paid, 'paid');
  const bps = rateBps(shop, 'buybackRateBps', COMMERCE_RATE_DEFAULT_BUYBACK);
  const numerator = BigInt(p) * BigInt(bps);
  const value = Number((numerator + BPS_SCALE - 1n) / BPS_SCALE);
  if (!Number.isSafeInteger(value)) {
    throw new Error('[market] quoteBuyback overflowed a safe integer');
  }
  return value;
}

/**
 * Quote a preorder deposit on `total`. Uses `commerce.preorders.depositBps` to
 * compute `ceil(total * depositBps / 10000)` with BigInt intermediates, then
 * caps the deposit at `total` (a deposit never exceeds the order) and, for a
 * positive total, floors the deposit at 1 minor unit. Returns
 * `{ deposit, remaining }` as non-negative safe integers. Throws on overflow.
 * Never mutates the shop.
 */
export function quoteDeposit(total, shop) {
  const t = assertMinorUnits(total, 'total');
  const commerce = shop && shop.commerce;
  const bps =
    commerce && commerce.preorders
      ? commerce.preorders.depositBps ?? PREORDER_DEPOSIT_BPS_DEFAULT
      : PREORDER_DEPOSIT_BPS_DEFAULT;
  const numerator = BigInt(t) * BigInt(bps);
  let deposit = Number((numerator + BPS_SCALE - 1n) / BPS_SCALE);
  if (!Number.isSafeInteger(deposit)) {
    throw new Error('[market] quoteDeposit overflowed a safe integer');
  }
  if (deposit > t) deposit = t;
  if (t > 0 && deposit < 1) deposit = 1;
  const remaining = t - deposit;
  if (!Number.isSafeInteger(remaining)) {
    throw new Error('[market] quoteDeposit remaining overflowed a safe integer');
  }
  return { deposit, remaining };
}

/**
 * Report the configured price of a `special` for `entry` and `actorUuid`, or
 * null when the special does not apply. A special applies only when its
 * `entryId` matches the entry's id AND the actor is eligible: an empty
 * `actorUuids` allows any actor, otherwise the actor's uuid must be in the
 * allowlist. This is a pure quote - it reports the GM-configured price and does
 * not override the existing purchase pricing. Never mutates the entry/special.
 */
export function quoteSpecial(entry, special, actorUuid) {
  if (!entry || !special) return null;
  if (special.entryId !== entry.id) return null;
  const uuids = Array.isArray(special.actorUuids) ? special.actorUuids : [];
  if (uuids.length > 0) {
    if (typeof actorUuid !== 'string' || !uuids.includes(actorUuid)) {
      return null;
    }
  }
  return special.price;
}
