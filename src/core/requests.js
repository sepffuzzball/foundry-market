// Request handling for the market over ChatMessage.
// Players whisper request messages (flagged `market`) at the GM(s). The active
// GM's client processes them and whispers a response back. Requests carry NO
// private shop data; responses expose only allowlisted public shop fields and
// visible inventory fields, never item `system` data.
//
// Guard rule (as required): only the active GM processes, and the hook's
// `userId` is trusted as the requester - never the sender recorded inside the
// payload.

import {
  TYPOGRAPHY_OPTIONS,
  DENSITY_OPTIONS,
  ANIMATION_OPTIONS,
  WELCOME_MESSAGE_MAX,
  ACCENT_COLOR_RE,
  MAX_SHOP_NPCS,
  MAX_COMMERCE_VALUATIONS,
  SERVICE_NAME_MAX,
  SERVICE_DESCRIPTION_MAX,
  normalizePriceBreakdown,
  sanitizeMediaPath,
  assertMarketId,
} from '../services/model.js';
import { normalizeTheme } from '../themes/registry.js';
import { quoteSocial } from '../social/pricing.js';
import { getPersonality } from '../social/personalities.js';
import { isShopTrading, stockView, activeMarketEvents } from '../automation/policy.js';
import { canAccessEntry, quoteSpecial } from '../advanced/policy.js';
import { fingerprintItem } from '../advanced/valuation.js';

export const PUBLIC_SHOP_FIELDS = [
  'id',
  'name',
  'locationId',
  'locationName',
  'description',
  'theme',
  'owner',
  'appearance',
  'open',
  'closedReason',
  'marketEvents',
  'specials',
  'services',
  'preordersEnabled',
  'theftEnabled',
  'approvedItems',
];
export const PUBLIC_ENTRY_FIELDS = [
  'id',
  'name',
  'img',
  'price',
  'quantity',
  'stockMode',
  'visible',
  'publicDescription',
  'category',
  'rarity',
  'stockLabel',
  'available',
  'specialId',
  'specialPrice',
  'canPreorder',
  'canAttemptTheft',
];

export function pickFields(obj, fields) {
  const out = {};
  if (!obj) return out;
  for (const field of fields) {
    if (field in obj) out[field] = obj[field];
  }
  return out;
}

/**
 * Reduce a raw commerce purchase result to the safe, allowlisted response
 * fields. Never leaks the raw ledger record (replay/conflict `record`,
 * `existing`, `expected`, `conflict`, etc.) regardless of the internal
 * commerce outcome. Only `{status, ledgerId, error, total, quantity,
 * compensation}` is ever exposed.
 */
export function publicPurchaseResult(result = {}) {
  const record = result.record || {};
  const existing = result.existing || {};
  return {
    status: result.status,
    ledgerId: result.ledgerId ?? record.id ?? existing.id,
    error: result.error,
    total: result.total ?? record.totalPrice ?? existing.totalPrice,
    quantity: result.quantity ?? record.quantity ?? existing.quantity,
    compensation: result.compensation ?? record.compensation ?? existing.compensation,
    priceBreakdown: result.priceBreakdown ?? record.priceBreakdown ?? existing.priceBreakdown ?? null,
  };
}

/**
 * Allowlisted stable error codes a public sell result may expose verbatim.
 * Anything else - a raw adapter/store exception message, an internal detail
 * string, or an unknown future code - collapses to the generic `server-error`
 * so a player never sees a stack trace or a `[market] ...` detail.
 */
const SELL_RESULT_ERROR_CODES = new Set([
  'server-error',
  'order-read-failed',
  'shop-read-failed',
  'actor-read-failed',
  'order-create-failed',
  'shop-not-found',
  'actor-not-found',
  'item-not-found',
  'item-not-an-item',
  'item-parent-mismatch',
  'adapter-unsupported',
  'delivery-mode-unsupported',
  'stacked-item',
  'quantity-path-invalid',
  'item-price-failed',
  'quote-overflow',
  'no-offer',
  'insufficient-merchant-funds',
  'invalid-world-time',
  'shop-closed',
  'not-active-gm',
  'conflicting duplicate payload',
  'order-pending',
  'order-commit-missing',
  'shop-write-missing',
  'item-delete-failed',
]);

/**
 * Map an arbitrary sell-result error to a stable, bounded code. A known code is
 * kept; a known code followed by an internal detail after a colon (e.g.
 * `order-read-failed: <detail>`) keeps only the bounded code; any raw exception
 * message, detail string, or unknown code collapses to `server-error`. Malicious
 * or noisy text is never echoed to the player.
 */
function sanitizeSellResultError(error) {
  const value = typeof error === 'string' ? error : String(error);
  if (SELL_RESULT_ERROR_CODES.has(value)) return value;
  // A known code may carry an internal detail after a colon; keep the bounded
  // code and drop the detail (never a raw message/stack).
  const prefix = value.split(':')[0].trim();
  if (SELL_RESULT_ERROR_CODES.has(prefix)) return prefix;
  return 'server-error';
}

/**
 * Reduce a raw selling-service result to the safe, allowlisted response fields.
 * Never leaks the private `conflict`/`expected`/`existing` carrybacks the
 * idempotency resolution uses internally, the raw advanced-order record, or the
 * order `details` (the item `snapshot`, `payout`/`fundsBefore`, and the
 * `compensation` markers a failed/needsRecovery sell accumulates). Only
 * `{status, error, orderId, payout, buybackEntryId, itemName}` is ever exposed,
 * and each value is a plain bounded scalar - `payout` stays the raw non-negative
 * minor-unit integer, everything else is coerced to a string. The `error` is
 * always a stable bounded code (see `sanitizeSellResultError`), never a raw
 * exception message.
 */
export function publicSellResult(result = {}) {
  const out = { status: result.status };
  if (result.error != null) out.error = sanitizeSellResultError(result.error);
  if (result.orderId != null) out.orderId = String(result.orderId);
  const originalStatus = sanitizeAdvancedOriginalStatus(result.originalStatus);
  if (originalStatus != null) out.originalStatus = originalStatus;
  if (result.payout != null) out.payout = result.payout;
  if (result.buybackEntryId != null) out.buybackEntryId = String(result.buybackEntryId);
  if (result.itemName != null) out.itemName = String(result.itemName);
  return out;
}

// ------------------------------------------------- M5 advanced request safety
//
// The four M5 advanced services (cart, service, preorder, theft) each return a
// rich transaction result carrying PRIVATE carrybacks the idempotency resolution
// uses internally - `conflict`, `expected`, `existing`, `details`, the
// `compensation` markers, the raw advanced-order `record`, the `outcome`, and a
// barter `barter`/`delivered` breakdown. None of that may reach a player whisper
// or the GM UI, so each result is reduced through a per-type public sanitizer.
// The status and error code are both bounded: a known stable code passes, a
// code with an internal `: <detail>` suffix keeps only the bounded prefix, and
// anything unknown collapses to `server-error`. The `detail` string (a bounded
// human message for `insufficient-funds` / `service-refused`) is the only free
// text ever echoed, capped at 200 chars.

/** Shared bounded error codes produced by every advanced service. */
const ADVANCED_COMMON_ERROR_CODES = new Set([
  'server-error',
  'not-active-gm',
  'invalid-world-time',
  'shop-closed',
  'order-read-failed',
  'shop-read-failed',
  'actor-read-failed',
  'order-create-failed',
  'order-list-failed',
  'shop-not-found',
  'actor-not-found',
  'actor-not-owned',
  'adapter-unsupported',
  'balance-read-failed',
  'rep-read-failed',
  'insufficient-funds',
  'insufficient-merchant-funds',
  'service-refused',
  'total-overflow',
  'funds-overflow',
  'item-price-failed',
  'quote-overflow',
  'no-offer',
  'stacked-item',
  'delivery-mode-unsupported',
  'quantity-path-invalid',
  'too-many-lines',
  'duplicate-entry',
  'special-unavailable',
  'barter-item-not-found',
  'barter-item-not-an-item',
  'barter-item-parent-mismatch',
  'barter-item-remove-failed',
  'conflicting duplicate payload',
  'order-pending',
  'order-commit-missing',
  'shop-write-missing',
  'order-not-found',
  'entry-not-found',
  'entry-hidden',
  'entry-restricted',
  'insufficient-stock',
  'item-source-failed',
  'item-source-missing',
]);

const CART_ERROR_CODES = new Set([...ADVANCED_COMMON_ERROR_CODES, 'lines must be an array']);

const SERVICE_ERROR_CODES = new Set([
  ...ADVANCED_COMMON_ERROR_CODES,
  'service-not-found',
  'service-disabled',
  'service-hidden',
  'invalid-price',
  'order-not-service',
  'order-not-booked',
  'fulfilled-order-inconsistent',
  'gm-required',
  'requester-required',
  'fulfill-commit-missing',
]);

const PREORDER_ERROR_CODES = new Set([
  ...ADVANCED_COMMON_ERROR_CODES,
  'preorders-disabled',
  'stock-sufficient',
  'max-preorders-reached',
  'order-not-preorder',
  'order-not-booked',
  'cancelled-order-inconsistent',
  'fulfilled-order-inconsistent',
  'quote-deposit-failed',
  'gm-required',
  'fulfill-commit-missing',
  'cancel-commit-missing',
]);

const THEFT_ERROR_CODES = new Set([
  ...ADVANCED_COMMON_ERROR_CODES,
  'theft-disabled',
  'entry-backroom',
  'out-of-stock',
  'order-not-theft',
  'success-required',
  'gm-required',
  'resolved-order-inconsistent',
  'resolve-commit-missing',
  'resolve-in-flight',
]);

/** Bounded per-type status sets. An unrecognized status collapses to `error`. */
const CART_STATUSES = new Set(['committed', 'replay', 'conflict', 'needsRecovery', 'error']);
const SERVICE_STATUSES = new Set([
  'booked',
  'fulfilled',
  'replay',
  'conflict',
  'needsRecovery',
  'error',
]);
const PREORDER_STATUSES = new Set([
  'booked',
  'fulfilled',
  'cancelled',
  'replay',
  'conflict',
  'needsRecovery',
  'error',
]);
const THEFT_STATUSES = new Set([
  'booked',
  'committed',
  'failed',
  'replay',
  'conflict',
  'needsRecovery',
  'error',
]);

function sanitizeAdvancedStatus(status, statusSet) {
  return statusSet.has(status) ? status : 'error';
}

/**
 * The recorded advanced-order statuses a replay `originalStatus` field may
 * carry. Any other value (or a non-string) is dropped so a player or GM UI never
 * sees an arbitrary leaked status string; the recognized values are exactly the
 * persisted `ADVANCED_ORDER_STATUSES`.
 */
const ADVANCED_ORIGINAL_STATUSES = new Set([
  'pending',
  'committed',
  'booked',
  'fulfilled',
  'cancelled',
  'failed',
  'needsRecovery',
]);

/**
 * Map an arbitrary advanced-service error to a stable bounded code. Mirrors
 * `sanitizeSellResultError`: a known code is kept verbatim, a known code with an
 * internal detail after a colon keeps only the bounded prefix, and any raw
 * exception message / unknown code collapses to `server-error`. Never echoes a
 * stack trace or a `[market] ...` detail to a player.
 */
function sanitizeAdvancedError(error, codeSet) {
  const value = typeof error === 'string' ? error : String(error);
  if (codeSet.has(value)) return value;
  const prefix = value.split(':')[0].trim();
  if (codeSet.has(prefix)) return prefix;
  return 'server-error';
}

function sanitizeAdvancedOriginalStatus(value) {
  return typeof value === 'string' && ADVANCED_ORIGINAL_STATUSES.has(value)
    ? value
    : undefined;
}

function boundedAdvancedString(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

/**
 * Cap the outcome line items at 20 (the cart line cap) and reduce each to the
 * bounded `{entryId, name, quantity, specialId?, specialPrice?}`. Never leaks
 * the private `itemUuid`/`snapshot`/`createdId` per-line breakdown.
 */
function sanitizeCartItems(items) {
  return items.slice(0, 20).map((it) => {
    const out = {};
    if (it?.entryId != null) out.entryId = boundedAdvancedString(it.entryId, 120);
    if (it?.name != null) out.name = boundedAdvancedString(it.name, 200);
    if (Number.isFinite(it?.quantity)) out.quantity = it.quantity;
    if (it?.specialId != null) out.specialId = boundedAdvancedString(it.specialId, 120);
    if (Number.isFinite(it?.specialPrice)) out.specialPrice = it.specialPrice;
    return out;
  });
}

/** The only free text echoed for a cart/preorder error (bounded to 200 chars). */
function advancedDetail(error, detail) {
  if (error !== 'insufficient-funds' && error !== 'service-refused') return undefined;
  return boundedAdvancedString(detail, 200);
}

/**
 * Reduce a raw cart checkout result to the safe public fields. Only
 * `{status, error?, orderId?, total?, quantity?, barterCredit?, cashPaid?,
 * items?, detail?}` is ever exposed - never the `conflict`/`expected`/`existing`
 * carrybacks, the `record`/`outcome`, or the `barter`/`delivered` internals.
 */
export function publicCartResult(result = {}) {
  const out = { status: sanitizeAdvancedStatus(result.status, CART_STATUSES) };
  if (result.error != null) out.error = sanitizeAdvancedError(result.error, CART_ERROR_CODES);
  if (result.orderId != null) out.orderId = boundedAdvancedString(result.orderId, 120);
  const originalStatus = sanitizeAdvancedOriginalStatus(result.originalStatus);
  if (originalStatus != null) out.originalStatus = originalStatus;
  if (Number.isFinite(result.total)) out.total = result.total;
  if (Number.isFinite(result.quantity)) out.quantity = result.quantity;
  if (Number.isFinite(result.barterCredit)) out.barterCredit = result.barterCredit;
  if (Number.isFinite(result.cashPaid)) out.cashPaid = result.cashPaid;
  if (Array.isArray(result.items)) out.items = sanitizeCartItems(result.items);
  const detail = advancedDetail(out.error, result.detail);
  if (detail !== undefined) out.detail = detail;
  return out;
}

/**
 * Reduce a raw service booking/fulfillment result to the safe public fields. Only
 * `{status, error?, orderId?, serviceId?, serviceName?, price?}` is ever exposed -
 * never the `conflict`/`expected`/`existing` carrybacks, the `record`/`outcome`,
 * or the private `details` (service price/name snapshot, `fundsBefore`,
 * `compensation`).
 */
export function publicServiceResult(result = {}) {
  const out = { status: sanitizeAdvancedStatus(result.status, SERVICE_STATUSES) };
  if (result.error != null) out.error = sanitizeAdvancedError(result.error, SERVICE_ERROR_CODES);
  if (result.orderId != null) out.orderId = boundedAdvancedString(result.orderId, 120);
  const originalStatus = sanitizeAdvancedOriginalStatus(result.originalStatus);
  if (originalStatus != null) out.originalStatus = originalStatus;
  if (result.serviceId != null) out.serviceId = boundedAdvancedString(result.serviceId, 120);
  if (result.serviceName != null) out.serviceName = boundedAdvancedString(result.serviceName, 200);
  if (Number.isFinite(result.price)) out.price = result.price;
  return out;
}

/**
 * Reduce a raw preorder place/fulfill/cancel result to the safe public fields.
 * Only `{status, error?, orderId?, entryId?, quantity?, total?, deposit?,
 * remaining?, detail?}` is ever exposed - never the `conflict`/`expected`/
 * `existing` carrybacks, the `record`/`outcome`, or the order `details` (item
 * snapshot, `unitPrice`, `itemUuid`, `fundsBefore`, `compensation`).
 */
export function publicPreorderResult(result = {}) {
  const out = { status: sanitizeAdvancedStatus(result.status, PREORDER_STATUSES) };
  if (result.error != null) {
    out.error = sanitizeAdvancedError(result.error, PREORDER_ERROR_CODES);
  }
  if (result.orderId != null) out.orderId = boundedAdvancedString(result.orderId, 120);
  const originalStatus = sanitizeAdvancedOriginalStatus(result.originalStatus);
  if (originalStatus != null) out.originalStatus = originalStatus;
  if (result.entryId != null) out.entryId = boundedAdvancedString(result.entryId, 120);
  if (Number.isFinite(result.quantity)) out.quantity = result.quantity;
  if (Number.isFinite(result.total)) out.total = result.total;
  if (Number.isFinite(result.deposit)) out.deposit = result.deposit;
  if (Number.isFinite(result.remaining)) out.remaining = result.remaining;
  const detail = advancedDetail(out.error, result.detail);
  if (detail !== undefined) out.detail = detail;
  return out;
}

/**
 * Reduce a raw theft claim/resolve result to the safe public fields. Only
 * `{status, error?, orderId?, entryId?, success?}` is ever exposed - never the
 * `conflict`/`expected`/`existing` carrybacks, the raw advanced-order `record`,
 * or the `details`/`compensation` markers. `success` is copied only as an actual
 * boolean.
 */
export function publicTheftResult(result = {}) {
  const out = { status: sanitizeAdvancedStatus(result.status, THEFT_STATUSES) };
  if (result.error != null) out.error = sanitizeAdvancedError(result.error, THEFT_ERROR_CODES);
  if (result.orderId != null) out.orderId = boundedAdvancedString(result.orderId, 120);
  const originalStatus = sanitizeAdvancedOriginalStatus(result.originalStatus);
  if (originalStatus != null) out.originalStatus = originalStatus;
  if (result.entryId != null) out.entryId = boundedAdvancedString(result.entryId, 120);
  if (typeof result.success === 'boolean') out.success = result.success;
  return out;
}

/**
 * The allowlisted scalar fields of a GM-private advanced-order record. Everything
 * else - the `details` (item snapshot, `unitPrice`, `fundsBefore`,
 * `compensation`), the `outcome`, any `payload`/snapshot, and the raw
 * `intentHash`/`key` forward-compat fields the idempotency layer uses - is
 * stripped so a GM summary never exposes a private snapshot even to the manager
 * UI.
 */
export const ADVANCED_ORDER_SCALAR_FIELDS = [
  'id',
  'key',
  'kind',
  'status',
  'phase',
  'shopId',
  'actorId',
  'entryId',
  'relatedOrderId',
  'quantity',
  'total',
  'deposit',
  'remaining',
  'userId',
  'createdAt',
  'updatedAt',
  'error',
];

/**
 * Project a raw stored advanced-order record to the bounded scalar summary. Never
 * emits `details`/`outcome`/`payload`/snapshot objects or the private `intentHash`
 * (only meaningful for idempotency resolution), so the GM order list stays free
 * of private snapshot data.
 */
export function publicAdvancedOrder(record) {
  return pickFields(record || {}, ADVANCED_ORDER_SCALAR_FIELDS);
}

/**
 * Non-throwing sanitizer for the public projection of a shop appearance. Even if
 * an invalid value somehow reached a stored shop, this never leaks it to a
 * player: media paths collapse to '', the accent color must be empty or a strict
 * `#rrggbb`, radio fields fall back to their documented defaults, and
 * welcomeMessage is capped.
 */
function sanitizeAppearance(appearance = {}) {
  return {
    backgroundImage: sanitizeMediaPath(appearance.backgroundImage),
    ownerPortrait: sanitizeMediaPath(appearance.ownerPortrait),
    accentColor:
      typeof appearance.accentColor === 'string' && ACCENT_COLOR_RE.test(appearance.accentColor)
        ? appearance.accentColor
        : '',
    typography: TYPOGRAPHY_OPTIONS.includes(appearance.typography)
      ? appearance.typography
      : 'classic',
    density: DENSITY_OPTIONS.includes(appearance.density) ? appearance.density : 'comfortable',
    animation: ANIMATION_OPTIONS.includes(appearance.animation) ? appearance.animation : 'full',
    music: sanitizeMediaPath(appearance.music),
    soundEffect: sanitizeMediaPath(appearance.soundEffect),
    welcomeMessage: String(appearance.welcomeMessage ?? '').slice(0, WELCOME_MESSAGE_MAX),
  };
}

/**
 * Sanitized `closedReason` enum admitted by M4 trading. `isShopTrading` only
 * ever reports one of these (plus `'open'`); anything else collapses to null so
 * an unknown future reason never leaks to a player.
 */
const CLOSED_REASONS = new Set(['manually-closed', 'outside-hours', 'not-arrived']);

function sanitizeClosedReason(reason) {
  if (reason === 'open') return null;
  return CLOSED_REASONS.has(reason) ? reason : null;
}

/**
 * Non-throwing sanitizer for a projected market event id. The event list may
 * arrive from an unnormalized fixture whose id is an object, an empty string, an
 * oversized string, or a control-bearing string; a public projection must never
 * leak a non-scalar id. A valid market id (non-empty string, at most
 * REPUTATION_ID_MAX, no control chars) is returned; anything else collapses to ''
 * so the event stays visible with a safe empty id.
 */
function sanitizeEventId(value) {
  if (typeof value !== 'string') return '';
  try {
    return assertMarketId(value, 'marketEvents[].id');
  } catch {
    return '';
  }
}

/**
 * Project the visible active market events at `worldTime` to the safe public
 * shape `{id, title, description}`. Never leaks `startAt`/`endAt`/`visible` or
 * the raw event config; event text is plain (the UI escapes it). The projected
 * `id` is always a validated scalar string (an invalid raw id collapses to ''),
 * even when the shop is an unnormalized fixture.
 */
function projectMarketEvents(shop, worldTime) {
  return activeMarketEvents(shop, worldTime).map((e) => ({
    id: sanitizeEventId(e.id),
    title: String(e.title ?? ''),
    description: String(e.description ?? ''),
  }));
}

/**
 * Resolve the request-context world time. `ctx.worldTime` is a getter (the
 * runtime supplies the same `() => Math.floor(game.time.worldTime)` used by
 * commerce); a numeric value is also accepted for direct injection. Returns:
 *   - a safe integer second when the source is valid;
 *   - null when the source is PRESENT but invalid (NaN/undefined/Infinity/
 *     unsafe), so the catalog fails closed as a correlated server-error;
 *   - undefined when no time source is present, preserving the legacy no-time
 *     behavior.
 */
function resolveWorldTime(ctx) {
  const wt = ctx?.worldTime;
  if (wt == null) return undefined;
  let value;
  if (typeof wt === 'function') {
    value = wt();
  } else {
    value = wt;
  }
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (Number.isSafeInteger(value)) return value;
  const floored = Math.floor(value);
  return Number.isSafeInteger(floored) ? floored : null;
}

/**
 * Resolve a safe, player-facing location name for a projected `locationId`.
 * Only a single string is ever exposed - never the full location list nor the
 * private `travel.locationIds` config. A non-array location list, a missing
 * location, or a legacy context with no location list all collapse to '' (never
 * a stale base name), and the name is bounded to 100 characters. The value is
 * rendered through Handlebars `{{ }}` in the storefront template, which escapes
 * it, so it is never Html-injected.
 */
function resolveLocationName(locations, locationId) {
  if (!locationId || !Array.isArray(locations)) return '';
  const match = locations.find((loc) => loc && loc.id === locationId);
  return String((match && match.name) || '').slice(0, 100);
}

/** Allowlisted public shop view. Never includes raw flags or hidden columns. */
export function publicShop(shop, opts = {}) {
  const out = pickFields(shop, PUBLIC_SHOP_FIELDS);
  // Never supply unvalidated raw input: normalize the theme (fails closed to
  // general-store), keep owner a plain string, and sanitize the appearance.
  out.theme = normalizeTheme(shop?.theme);
  // The `owner` string and `appearance.ownerPortrait` are synchronized from the
  // primary (first) NPC. When that primary is marked invisible it must not leak
  // its name or portrait in the public shop, so blank both rather than exposing
  // a hidden NPC's identity. All other appearance fields and the visible-NPC
  // merchant projection are left untouched.
  const npcs = Array.isArray(shop?.npcs) ? shop.npcs : [];
  const primaryHidden = npcs.length > 0 && npcs[0]?.visible === false;
  out.owner = primaryHidden ? '' : String(shop?.owner ?? '');
  const appearance = sanitizeAppearance(shop?.appearance);
  if (primaryHidden) appearance.ownerPortrait = '';
  out.appearance = appearance;
  // M4 trading/presence projection. With a valid world time the authoritative
  // `open`/`locationId` come from `isShopTrading` (which folds in manual close,
  // hours and travel), plus a sanitized `closedReason` and the visible active
  // events. Without a time the legacy `shop.open`/`shop.locationId` behavior is
  // preserved and `marketEvents` is an empty array - never leaking the days/hours
  // config or the private event list.
  const worldTime = opts?.worldTime;
  const hasTime = typeof worldTime === 'number' && Number.isFinite(worldTime);
  if (hasTime) {
    const trading = isShopTrading(shop, worldTime);
    out.open = trading.open;
    out.locationId = trading.locationId || '';
    out.closedReason = sanitizeClosedReason(trading.reason);
    out.marketEvents = projectMarketEvents(shop, worldTime);
  } else {
    out.marketEvents = [];
  }
  // Resolve the safe current location name for the projected locationId (the one
  // `isShopTrading` may have rotated for a travel-enabled shop). Only this single
  // string is exposed; the full location list and `travel.locationIds` stay
  // private. A missing/unknown location or a legacy context without a location
  // list collapses to ''.
  out.locationName = resolveLocationName(opts?.locations, out.locationId);
  // The public `specials` list is NEVER derived from a top-level shop field (the
  // raw `commerce.specials` config stays private). It defaults to an empty list
  // here and is overridden by the catalog builders with a sanitized projection.
  out.specials = [];
  // The M6 `approvedItems` allowlist is the only GM-authored valuation surface a
  // player storefront may see. It is NEVER derived from the raw
  // `commerce.valuations` (which stays private and carries the actorUuid and the
  // tamper-detecting fingerprint); it defaults to an empty list here and is only
  // populated by the personalized catalog builder with a matching, still-valid
  // `{itemId, amount}` projection. A base (non-personalized) catalog never
  // exposes any approval.
  out.approvedItems = [];
  // M5 public surface. Only the enabled+visible service projection escapes, and
  // the two commerce booleans are read from the validated `shop.commerce` config
  // - never the raw object. Private merchant funds / buy-buyback rates /
  // depositBps / maxPerActor / special actor lists stay internal.
  out.services = publicServices(shop);
  out.preordersEnabled = shop?.commerce?.preorders?.enabled === true;
  out.theftEnabled = shop?.commerce?.theft?.enabled === true;
  return out;
}

/**
 * Project a single visible inventory entry with only allowlisted public fields.
 * `itemUuid`, snapshot, `stockVisibility`, `restock` and any item `system` data
 * are deliberately excluded. The `quantity`/`stockLabel`/`available` come from
 * `stockView`, so a non-exact entry never leaks a real count; an exact entry
 * keeps its true `quantity`.
 */
export function publicInventoryEntry(entry) {
  const out = pickFields(entry, PUBLIC_ENTRY_FIELDS);
  const view = stockView(entry);
  out.quantity = view.quantity;
  out.stockLabel = view.stockLabel;
  out.available = view.available;
  return out;
}

/**
 * Visible inventory entries with only allowlisted public fields. `itemUuid`,
 * any item `system` data and the private per-entry `access` gate are
 * deliberately excluded from the catalog. A `backroom` entry is omitted from
 * the base (non-personalized) catalog entirely - it is only exposed once an
 * actor's eligibility is known (see handleCatalog).
 */
export function publicInventory(shop) {
  const visible = (shop?.inventory || []).filter(
    (e) => e.visible && e.access?.mode !== 'backroom'
  );
  return visible.map((e) => publicInventoryEntry(e));
}

/**
 * Project the public `specials` list for a catalog context and cross-reference
 * inventory entries that exactly one eligible offer targets.
 *
 * A special is eligible only when it is visible (`visible !== false`), its
 * reference entry is present in THIS `inventory` (so a backroom-only offer is
 * omitted from the base catalog, and a personalized-only offer is exposed only
 * when the actor may access the entry), and `quoteSpecial` permits it for
 * `actorUuid` (an empty allowlist permits any actor; an actor-specific offer is
 * hidden from the base catalog where `actorUuid` is null). Only the allowlisted
 * `{id,title,description,entryId,price}` is ever exposed - never the raw
 * `visible`/`actorUuids`/commerce config.
 *
 * The returned list is the public projection, and EVERY listed special's `price`
 * is produced by `quoteSpecialPrice(entry, special)` - the raw configured price
 * for the base catalog, a social quote for a personalized catalog - never the
 * raw `special.price` in the personalized case. As a side effect, when EXACTLY
 * ONE eligible offer targets an entry that entry gains `specialId`/
 * `specialPrice` from the SAME quoted price (an ambiguous multi-offer entry
 * keeps the separate list and the storefront chooses later). The callback may
 * throw; the caller fails closed on a quote overflow.
 */
function projectSpecials(shop, inventory, actorUuid, quoteSpecialPrice) {
  const raw = Array.isArray(shop?.commerce?.specials)
    ? shop.commerce.specials
    : [];
  const list = [];
  const byEntry = new Map();
  for (const special of raw) {
    if (!special || special.visible === false) continue;
    const entry = inventory.find((e) => e && e.id === special.entryId);
    if (!entry) continue;
    if (quoteSpecial(entry, special, actorUuid) === null) continue;
    // The effective price is ALWAYS produced by the callback - the raw configured
    // price for the base catalog, the social quote for a personalized catalog -
    // so the public list price and any single-offer cross-reference always agree.
    // `quoteSpecialPrice` may throw (a quote overflow); the caller fails closed.
    const price = quoteSpecialPrice(entry, special);
    list.push({
      id: special.id,
      title: special.title,
      description: special.description,
      entryId: special.entryId,
      price,
    });
    const bucket = byEntry.get(special.entryId) || [];
    bucket.push({ entry, special, price });
    byEntry.set(special.entryId, bucket);
  }
  for (const bucket of byEntry.values()) {
    if (bucket.length !== 1) continue;
    const { entry, special, price } = bucket[0];
    entry.specialId = special.id;
    entry.specialPrice = price;
  }
  return list;
}

/**
 * Public merchant projection for a player-facing storefront. Only visible NPCs
 * are exposed, at most MAX_SHOP_NPCS, each sanitized to
 * `{name, role, portrait, greeting, personality: {label, hint}}` - never the
 * `actorUuid` or any private social config. On a legacy shop the primary NPC
 * was already minted by `normalizeShop` from the `owner` string, so this
 * safely projects the resolved `shop.npcs`. Media paths are sanitized so an
 * invalid portrait collapses to ''.
 */
export function publicMerchants(shop) {
  const npcs = Array.isArray(shop?.npcs) ? shop.npcs : [];
  const out = [];
  for (const npc of npcs) {
    if (npc.visible === false) continue;
    if (out.length >= MAX_SHOP_NPCS) break;
    const personality = getPersonality(npc.personality);
    out.push({
      name: String(npc.name ?? ''),
      role: String(npc.role ?? ''),
      portrait: sanitizeMediaPath(npc.portrait),
      greeting: String(npc.greeting ?? ''),
      personality: { label: personality.label, hint: personality.description },
    });
  }
  return out;
}

/**
 * Build the public `approvedItems` allowlist for a personalized catalog: the up
 * to `MAX_COMMERCE_VALUATIONS` `{itemId, amount}` pairs for which a GM has
 * approved a sell/barter valuation for THIS actor, and whose approval is STILL
 * valid.
 *
 * Each candidate must:
 *   - belong to the actor's own embedded Items (the actor UUID matches the
 *     stored valuation's `actorUuid`, and the item's id matches the valuation's
 *     `itemId`), so a valuation authored for another character is never offered
 *     to this one;
 *   - still be the item the GM approved, so `fingerprintItem(item)` equals the
 *     fingerprint recorded at approval time (a later player mutation of
 *     price/name/type/system/flags invalidates the approval and the item is
 *     dropped from the list);
 *   - be a live document that can be fingerprinted at all (an item with no
 *     `toObject()` is dropped, never a hard failure).
 *
 * Only `{itemId, amount}` is ever exposed - never the raw valuation `id`, the
 * `actorUuid`, or the private `fingerprint`. The list is deduped by `itemId` and
 * capped at `MAX_COMMERCE_VALUATIONS` (the valuation cap). A downstream item
 * mutation simply disappears from the list, so a player storefront never offers
 * an item whose approval no longer matches the item actually owned. The actor
 * may be a minimal `{uuid}` projection with no embedded items; that yields an
 * empty list.
 */
export function approvedItemsFor(shop, actor) {
  const valuations = Array.isArray(shop?.commerce?.valuations)
    ? shop.commerce.valuations
    : [];
  if (valuations.length === 0) return [];
  const actorUuid = actor?.uuid;
  if (actorUuid == null) return [];
  const items = Array.isArray(actor?.items)
    ? actor.items
    : actor?.items && typeof actor.items.values === 'function'
      ? Array.from(actor.items.values())
      : actor?.items && typeof actor.items[Symbol.iterator] === 'function'
        ? Array.from(actor.items)
        : [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item) continue;
    const itemId = item.id ?? item._id;
    if (itemId == null) continue;
    const entry = valuations.find(
      (v) => v.actorUuid === actorUuid && v.itemId === itemId
    );
    if (!entry) continue;
    let fingerprint;
    try {
      fingerprint = fingerprintItem(item);
    } catch {
      continue;
    }
    if (fingerprint !== entry.fingerprint) continue;
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    out.push({ itemId, amount: entry.amount });
    if (out.length >= MAX_COMMERCE_VALUATIONS) break;
  }
  return out;
}

/**
 * Sanitize an effective-reputation result into the public relationship shape.
 * Never leaks a raw reputation record and never leaks the private `partyId`
 * (which is only meaningful to the GM running the party ledger): only
 * `{score, title, individual, party}` are returned. `score`/`individual`/`party`
 * are integers in [-100, 100]; `title` is the band display title.
 */
export function sanitizeRelationship(effective) {
  if (!effective) return null;
  return {
    score: effective.score,
    title: effective.band?.title ?? '',
    individual: effective.individual,
    party: effective.party,
  };
}

/**
 * Project the public `services` list for the storefront. Only services that are
 * BOTH enabled (`enabled !== false`) and visible (`visible !== false`) are
 * exposed, each sanitized to the allowlisted `{id, name, description, price}` -
 * never the raw `commerce` object or the private `manualFulfillment`/
 * `enabled`/`visible` flags. `name`/`description` are bounded to the schema
 * maxima (so an unnormalized raw input cannot leak an oversized string) and
 * `price` collapses to 0 unless it is a finite non-negative number. The
 * private merchant `funds`, `buyRateBps`/`buybackRateBps` and `preorders`
 * config stay internal to `shop.commerce`.
 */
export function publicServices(shop) {
  const raw = Array.isArray(shop?.commerce?.services) ? shop.commerce.services : [];
  const out = [];
  for (const service of raw) {
    if (!service || service.enabled === false || service.visible === false) continue;
    out.push({
      id: boundedAdvancedString(service.id, 120),
      name: boundedAdvancedString(service.name, SERVICE_NAME_MAX),
      description: boundedAdvancedString(service.description ?? '', SERVICE_DESCRIPTION_MAX),
      price:
        Number.isFinite(service.price) && service.price >= 0 ? service.price : 0,
    });
  }
  return out;
}

/**
 * Decorate a projected public entry with its M5 availability flags. This is the
 * only place the storefront learns whether an entry can be preordered or
 * attempted-theft; it is a client-side REQUEST hint, never an execution outcome.
 *
 * `canPreorder` is true only when the shop has preorders enabled, the entry is
 * public or (for a personalized actor) accessible, it is a finite/non-restocking
 * entry that is currently out of stock, the projected shop is open/trading, and
 * (for a personalized quote) the social quote is not refused. The base catalog
 * has no quote, so `refused` is false there and there is no actor owner.
 *
 * `canAttemptTheft` is true only when the shop has theft enabled, the entry is
 * public (never a backroom gate), it is currently IN stock, and the projected
 * shop is open/trading. A personalized owned-actor request validates
 * availability server-side; this flag is a request permission, not an outcome.
 *
 * `publicEntry` is the projected (allowlisted) entry whose `available` field
 * reflects the `stockView` projection; `rawEntry` is the raw inventory entry so
 * the true `access.mode` and `stockMode` are read (the projection strips
 * `access`). Never mutates the shop or the raw entry.
 */
function applyAvailabilityFlags(
  publicEntry,
  rawEntry,
  shop,
  { open, actorUuid, score, refused, preordersEnabled, theftEnabled } = {}
) {
  const publicAccess = rawEntry?.access?.mode !== 'backroom';
  const accessible = publicAccess || canAccessEntry(rawEntry, { actorUuid, score });
  const outOfStock =
    rawEntry?.stockMode !== 'unlimited' && publicEntry?.available === false;
  publicEntry.canPreorder = !!(
    preordersEnabled &&
    accessible &&
    outOfStock &&
    open &&
    !refused
  );
  publicEntry.canAttemptTheft = !!(
    theftEnabled &&
    publicAccess &&
    publicEntry?.available === true &&
    open
  );
  return publicEntry;
}

export function buildCatalog(shop, opts = {}) {
  const inventory = publicInventory(shop);
  const shopView = publicShop(shop, { worldTime: opts?.worldTime, locations: opts?.locations });
  // The base (non-personalized) catalog projects the public specials list and
  // cross-references only offers whose reference entry is present here (so a
  // backroom-only offer is omitted) AND that are actor-agnostic or
  // empty-allowlist (an actor-specific offer is hidden because `actorUuid` is
  // null). The cross-reference price is the raw configured price - no social.
  shopView.specials = projectSpecials(
    shop,
    inventory,
    null,
    (_entry, special) => special.price
  );
  // Decorate each projected base entry with its M5 availability flags. The base
  // catalog has no actor owner (`actorUuid` null, `score` undefined, `refused`
  // false), so only the public entry + preorder-enabled + open conditions gate
  // `canPreorder`, and theft requires a currently available public entry.
  const rawByEntry = new Map();
  for (const entry of shop?.inventory || []) rawByEntry.set(entry.id, entry);
  for (const publicEntry of inventory) {
    const rawEntry = rawByEntry.get(publicEntry.id);
    applyAvailabilityFlags(publicEntry, rawEntry, shop, {
      open: shopView.open,
      actorUuid: null,
      score: undefined,
      refused: false,
      preordersEnabled: shopView.preordersEnabled,
      theftEnabled: shopView.theftEnabled,
    });
  }
  return {
    type: 'catalog',
    shop: shopView,
    inventory,
    merchants: publicMerchants(shop),
  };
}

export function isMarketRequestFlag(flag) {
  return !!flag && flag.type === 'request';
}

/**
 * Build the ChatMessage data for a player's market request. The message is
 * whispered to the supplied GM ids. The `requestId` is generated by the caller
 * if not provided so a replay can be idempotent.
 */
export function requestMessageData(payload = {}) {
  const whisper = Array.isArray(payload.whisper) ? payload.whisper : [];
  const request = {
    type: payload.type,
    requestId: payload.requestId,
    shopId: payload.shopId,
    entryId: payload.entryId,
    actorId: payload.actorId,
    itemId: payload.itemId,
    quantity: payload.quantity,
    // M5 advanced requests. `lines` is the cart line array (each carrying an
    // optional per-line `specialId` with it); `barterItemId`/`serviceId` are the
    // cart barter tender and the bookable service. These are the ONLY fields a
    // request copies - never `success`/`price`/`gmUserId` (server/GM-side
    // snapshots a client must not supply).
    lines: payload.lines,
    barterItemId: payload.barterItemId,
    serviceId: payload.serviceId,
  };
  return {
    content: buildRequestContent(payload),
    whisper,
    flags: { market: { type: 'request', request } },
  };
}

export function buildRequestContent(payload = {}) {
  const type = payload.type || 'unknown';
  const shop = payload.shopId ? ` (shop ${payload.shopId})` : '';
  return `Market ${type} request${shop}`;
}

export function buildResponseContent(data = {}) {
  if (data?.type === 'catalog') return 'Market catalog.';
  if (data?.type === 'purchase') {
    const status = data.result?.status || 'error';
    return `Purchase ${status}.`;
  }
  return 'Market response.';
}

/**
 * Data object for a GM response message. Whispered to the requester and all
 * GMs. The response payload is stored in flags so a UI can render it later, and
 * the content is deliberately a short human-readable summary.
 */
export function responseMessageData({ whisper = [], data }) {
  return {
    content: buildResponseContent(data),
    whisper,
    flags: { market: { type: 'response', response: data } },
  };
}

/**
 * Process a chat message. Returns a Promise; resolves `null` when the message
 * is not for the active GM or not a market request, otherwise resolves the
 * response data that was sent.
 */
export async function handleMarketChatMessage(message, userId, ctx) {
  if (ctx.activeGMId() !== ctx.currentUserId()) return null;
  const flag = message?.flags?.market;
  if (!isMarketRequestFlag(flag)) return null;

  // Trust the hook's userId as the requester, not any sender field in payload.
  const requesterId = userId;
  const request = flag.request || {};
  const gmIds = ctx.gmIds();
  const whisper = Array.from(new Set([requesterId, ...gmIds]));

  let data;
  try {
    if (request.type === 'catalog') {
      data = await handleCatalog(request, requesterId, ctx);
    } else if (request.type === 'purchase') {
      data = await handlePurchase(request, requesterId, ctx);
    } else if (request.type === 'sell') {
      data = await handleSell(request, requesterId, ctx);
    } else if (request.type === 'cart') {
      data = await handleCart(request, requesterId, ctx);
    } else if (request.type === 'service') {
      data = await handleService(request, requesterId, ctx);
    } else if (request.type === 'preorder') {
      data = await handlePreorder(request, requesterId, ctx);
    } else if (request.type === 'theft') {
      data = await handleTheft(request, requesterId, ctx);
    } else {
      data = withCorrelation(
        { type: 'error', error: 'unknown-request-type', requestType: request.type },
        request
      );
    }
  } catch (err) {
    // A store/commerce failure (or a miswired ctx) must still answer so the
    // player never sits pending forever. Echo only the correlation fields and a
    // sanitized error code - never the raw exception stack.
    data = withCorrelation(serverFailureData(request.type), request);
  }

  await ctx.respond(responseMessageData({ whisper, data }));
  return data;
}

/**
 * Build a sanitized failure response for a server-side exception. It carries no
 * exception detail, only the correlation fields and a stable `server-error`
 * code, so the player sees a clean message and the stack stays in the GM's
 * console (logged by Foundry) rather than being whispered to the client.
 */
function serverFailureData(type) {
  if (
    type === 'purchase' ||
    type === 'sell' ||
    type === 'cart' ||
    type === 'service' ||
    type === 'preorder' ||
    type === 'theft'
  ) {
    return { type, result: { status: 'error', error: 'server-error' } };
  }
  return { type: 'error', error: 'server-error' };
}

/**
 * Echo the request correlation fields (`requestId`, `shopId`) on a response so
 * a UI can match a response back to the request it sent. These are plain
 * strings (never sensitive), which is safe to reflect.
 */
function withCorrelation(data, request) {
  return {
    ...data,
    requestId: request?.requestId ?? null,
    shopId: request?.shopId ?? null,
    actorId: request?.actorId ?? null,
  };
}

async function handleCatalog(request, requesterId, ctx) {
  const notFound = withCorrelation({ type: 'error', error: 'missing-shop-id' }, request);
  if (!request.shopId) return notFound;
  const shop = await ctx.store.findShop(request.shopId);
  if (!shop) {
    return withCorrelation({ type: 'error', error: 'shop-not-found' }, request);
  }

  // Resolve the authoritative world time ONCE here (server-side, never a client
  // clock) so both the base and the personalized catalog use the same trading
  // and event projection. A PRESENT but invalid time fails closed as a correlated
  // server-error (no catalog is projected); an absent time keeps the legacy
  // no-time behavior.
  const worldTime = resolveWorldTime(ctx);
  if (worldTime === null) {
    return withCorrelation({ type: 'error', error: 'server-error' }, request);
  }

  // Resolve the safe current location name from the store's location list AFTER
  // the projected locationId is known (see publicShop). The list is read once here
  // so both the base and the personalized catalog use the same projection; it is
  // never exposed itself - only the single resolved `locationName` string is. A
  // read failure fails closed as a correlated server-error; a legacy context
  // without `listLocations` supplies no list and resolves to ''.
  let locations = [];
  if (typeof ctx.store?.listLocations === 'function') {
    try {
      locations = await ctx.store.listLocations();
    } catch (err) {
      return withCorrelation({ type: 'error', error: 'server-error' }, request);
    }
  }

  // No actor => the base (non-personalized) public catalog. It still carries the
  // public merchant projection for the next UI, but no per-actor pricing.
  const actorId = request.actorId || null;
  if (!actorId) {
    return withCorrelation(buildCatalog(shop, { worldTime, locations }), request);
  }

  // With a requested actor, validate it (must exist and be owned by the
  // requester or a GM) BEFORE reading any reputation, so an untrusted actor can
  // never probe another player's score/quotes.
  const actor = await ctx.getActor(actorId);
  if (!actor) {
    return withCorrelation({ type: 'error', error: 'actor-not-found' }, request);
  }
  if (!ctx.actorOwnedBy(actor, requesterId)) {
    return withCorrelation({ type: 'error', error: 'actor-not-owned' }, request);
  }

  // The authoritative public shop projection is computed once and shared by every
  // entry's `canBuy` (which depends on the projected `open`, not the raw toggle).
  const shopView = publicShop(shop, { worldTime, locations });

  // M6: the GM-authored `approvedItems` allowlist for THIS actor. Built only now
  // that the actor is confirmed owned by the requester and in the personalized
  // path - a base catalog never exposes any approval (it keeps the `[]` default
  // set by `publicShop`). Only the matching, still-fingerprint-valid
  // `{itemId, amount}` pairs are projected; never the raw valuation entry.
  shopView.approvedItems = approvedItemsFor(shop, actor);

  let effective;
  try {
    effective = await ctx.getSocial(shop, actor);
  } catch (err) {
    // Fail closed: a reputation read failure must not leak a half-personalized
    // catalog; answer a correlated sanitized server-error instead.
    return withCorrelation({ type: 'error', error: 'server-error' }, request);
  }
  const scores = { individual: effective?.individual, party: effective?.party };

  // Quote each VISIBLE entry at quantity 1 through the social engine, but only
  // when the actor may ACCESS it: a `backroom` entry is exposed only after
  // actor ownership validation AND the effective-reputation lookup above, using
  // `canAccessEntry` (which checks both the actor-UUID allowlist and the
  // reputation threshold, and still requires `entry.visible`). Hidden entries
  // remain omitted (never personalized, never leaked). Any quote failure fails
  // closed as a correlated server-error.
  const inventory = [];
  for (const entry of shop.inventory || []) {
    if (entry.visible === false) continue;
    if (!canAccessEntry(entry, { actorUuid: actor?.uuid, score: effective?.score })) {
      continue;
    }
    let quote;
    try {
      quote = quoteSocial(entry, 1, { shop, scores });
    } catch (err) {
      return withCorrelation({ type: 'error', error: 'server-error' }, request);
    }
    const breakdown = normalizePriceBreakdown({
      quantity: quote.quantity,
      unitBase: quote.unitBase,
      baseTotal: quote.baseTotal,
      shopBps: quote.shopBps,
      personalityBps: quote.personalityBps,
      reputationBps: quote.reputationBps,
      haggleBps: quote.haggleBps,
      adjustmentBps: quote.adjustmentBps,
      unitPrice: quote.unitPrice,
      total: quote.total,
      band: quote.band,
      refused: quote.refused,
    });
    // The same projection helper as the base catalog (so a non-exact entry never
    // leaks a real count and `stockLabel`/`available` stay consistent), then the
    // per-actor social fields and `canBuy` which also requires the entry to be in
    // stock and the projected shop to be open.
    const publicEntry = publicInventoryEntry(entry);
    publicEntry.price = quote.unitPrice;
    publicEntry.basePrice = entry.price;
    publicEntry.priceBreakdown = breakdown;
    publicEntry.canBuy = !quote.refused && publicEntry.available && shopView.open;
    // M5 availability flags: personalized preorder also requires the quote not to
    // be refused (a Hated actor cannot reserve), while theft stays public-only.
    applyAvailabilityFlags(publicEntry, entry, shop, {
      open: shopView.open,
      actorUuid: actor?.uuid,
      score: effective?.score,
      refused: quote.refused,
      preordersEnabled: shopView.preordersEnabled,
      theftEnabled: shopView.theftEnabled,
    });
    inventory.push(publicEntry);
  }

  // M5 specials: reflect the public projection and cross-reference an entry with
  // `specialId`/`specialPrice` only when EXACTLY ONE eligible offer targets it.
  // The offer must be visible, actor-allowlist permitted for THIS actor, and its
  // reference entry must be in this personalized inventory (so the actor can
  // access it). The cross-referenced price is the special's configured price run
  // through the social engine - never the raw client/number; a quote overflow
  // fails closed as a correlated server-error.
  try {
    shopView.specials = projectSpecials(
      shop,
      inventory,
      actor?.uuid,
      (entry, special) =>
        quoteSocial({ ...entry, price: special.price }, 1, { shop, scores }).unitPrice
    );
  } catch (err) {
    return withCorrelation({ type: 'error', error: 'server-error' }, request);
  }

  return withCorrelation(
    {
      type: 'catalog',
      shop: shopView,
      inventory,
      merchants: publicMerchants(shop),
      relationship: sanitizeRelationship(effective),
    },
    request
  );
}

async function handlePurchase(request, requesterId, ctx) {
  if (!request.entryId) {
    return withCorrelation(
      { type: 'purchase', result: { status: 'error', error: 'missing-entry-id' } },
      request
    );
  }
  // Remote requests must carry a stable requestId so a replay maps to the same
  // idempotency key. The GM never auto-generates one for a remote request.
  if (!request.requestId) {
    return withCorrelation(
      { type: 'purchase', result: { status: 'error', error: 'missing-request-id' } },
      request
    );
  }
  const authenticatedUserId = ctx.currentUserId();
  const result = await ctx.commerce.purchase(
    {
      shopId: request.shopId,
      entryId: request.entryId,
      actorId: request.actorId,
      quantity: request.quantity,
      requestId: request.requestId,
      userId: requesterId,
    },
    authenticatedUserId
  );
  return withCorrelation(
    { type: 'purchase', result: publicPurchaseResult(result) },
    request
  );
}

async function handleSell(request, requesterId, ctx) {
  // Pre-validate the fields the selling service needs, returning clean correlated
  // errors rather than leaking the service's own `[market] '...' must ...`
  // messages. A remote sell must carry a stable requestId too.
  if (!request.shopId) {
    return withCorrelation(
      { type: 'sell', result: { status: 'error', error: 'missing-shop-id' } },
      request
    );
  }
  if (!request.actorId) {
    return withCorrelation(
      { type: 'sell', result: { status: 'error', error: 'missing-actor-id' } },
      request
    );
  }
  if (!request.itemId) {
    return withCorrelation(
      { type: 'sell', result: { status: 'error', error: 'missing-item-id' } },
      request
    );
  }
  if (!request.requestId) {
    return withCorrelation(
      { type: 'sell', result: { status: 'error', error: 'missing-request-id' } },
      request
    );
  }
  // The requester is ALWAYS the trusted hook userId - never the payload `userId`.
  const result = await ctx.selling.sell(
    {
      shopId: request.shopId,
      actorId: request.actorId,
      itemId: request.itemId,
      requestId: request.requestId,
    },
    requesterId
  );
  return withCorrelation(
    { type: 'sell', result: publicSellResult(result) },
    request
  );
}

async function handleCart(request, requesterId, ctx) {
  // Pre-validate the fields the cart service needs, returning clean correlated
  // errors rather than leaking the service's own `[market] '...' must ...` text.
  if (!request.shopId) {
    return withCorrelation(
      { type: 'cart', result: { status: 'error', error: 'missing-shop-id' } },
      request
    );
  }
  if (!request.actorId) {
    return withCorrelation(
      { type: 'cart', result: { status: 'error', error: 'missing-actor-id' } },
      request
    );
  }
  if (!Array.isArray(request.lines)) {
    return withCorrelation(
      { type: 'cart', result: { status: 'error', error: 'missing-lines' } },
      request
    );
  }
  if (!request.requestId) {
    return withCorrelation(
      { type: 'cart', result: { status: 'error', error: 'missing-request-id' } },
      request
    );
  }
  // The requester is ALWAYS the trusted hook userId - never the payload `userId`.
  const result = await ctx.cart.checkout(
    {
      shopId: request.shopId,
      actorId: request.actorId,
      lines: request.lines,
      requestId: request.requestId,
      barterItemId: request.barterItemId,
    },
    requesterId
  );
  return withCorrelation(
    { type: 'cart', result: publicCartResult(result) },
    request
  );
}

async function handleService(request, requesterId, ctx) {
  if (!request.shopId) {
    return withCorrelation(
      { type: 'service', result: { status: 'error', error: 'missing-shop-id' } },
      request
    );
  }
  if (!request.serviceId) {
    return withCorrelation(
      { type: 'service', result: { status: 'error', error: 'missing-service-id' } },
      request
    );
  }
  if (!request.actorId) {
    return withCorrelation(
      { type: 'service', result: { status: 'error', error: 'missing-actor-id' } },
      request
    );
  }
  if (!request.requestId) {
    return withCorrelation(
      { type: 'service', result: { status: 'error', error: 'missing-request-id' } },
      request
    );
  }
  // The requester is ALWAYS the trusted hook userId - never the payload `userId`.
  const result = await ctx.services.book(
    {
      shopId: request.shopId,
      serviceId: request.serviceId,
      actorId: request.actorId,
      requestId: request.requestId,
    },
    requesterId
  );
  return withCorrelation(
    { type: 'service', result: publicServiceResult(result) },
    request
  );
}

async function handlePreorder(request, requesterId, ctx) {
  if (!request.shopId) {
    return withCorrelation(
      { type: 'preorder', result: { status: 'error', error: 'missing-shop-id' } },
      request
    );
  }
  if (!request.entryId) {
    return withCorrelation(
      { type: 'preorder', result: { status: 'error', error: 'missing-entry-id' } },
      request
    );
  }
  if (!request.actorId) {
    return withCorrelation(
      { type: 'preorder', result: { status: 'error', error: 'missing-actor-id' } },
      request
    );
  }
  if (!request.requestId) {
    return withCorrelation(
      { type: 'preorder', result: { status: 'error', error: 'missing-request-id' } },
      request
    );
  }
  // The requester is ALWAYS the trusted hook userId - never the payload `userId`.
  const result = await ctx.preorders.place(
    {
      shopId: request.shopId,
      entryId: request.entryId,
      actorId: request.actorId,
      quantity: request.quantity,
      requestId: request.requestId,
    },
    requesterId
  );
  return withCorrelation(
    { type: 'preorder', result: publicPreorderResult(result) },
    request
  );
}

async function handleTheft(request, requesterId, ctx) {
  if (!request.shopId) {
    return withCorrelation(
      { type: 'theft', result: { status: 'error', error: 'missing-shop-id' } },
      request
    );
  }
  if (!request.entryId) {
    return withCorrelation(
      { type: 'theft', result: { status: 'error', error: 'missing-entry-id' } },
      request
    );
  }
  if (!request.actorId) {
    return withCorrelation(
      { type: 'theft', result: { status: 'error', error: 'missing-actor-id' } },
      request
    );
  }
  if (!request.requestId) {
    return withCorrelation(
      { type: 'theft', result: { status: 'error', error: 'missing-request-id' } },
      request
    );
  }
  // ONLY claim (`attempt`); NEVER resolve. A client-supplied `success` is ignored
  // here - the GM decides later through `api.advanced.resolveTheft`, so a player
  // whisper can never grant a free item.
  const result = await ctx.theft.attempt(
    {
      shopId: request.shopId,
      entryId: request.entryId,
      actorId: request.actorId,
      requestId: request.requestId,
    },
    requesterId
  );
  return withCorrelation(
    { type: 'theft', result: publicTheftResult(result) },
    request
  );
}

/**
 * Register the `createChatMessage` hook. Returns an unregister function. Only
 * the active GM processes (enforced inside handleMarketChatMessage).
 */
export function attachMarketHandler(ctx) {
  const listener = (message, options, userId) =>
    handleMarketChatMessage(message, userId, ctx);
  Hooks.on('createChatMessage', listener);
  return () => Hooks.off('createChatMessage', listener);
}

export default handleMarketChatMessage;
