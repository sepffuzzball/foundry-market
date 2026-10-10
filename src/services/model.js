// Market record schemas, normalization and validation.
//
// This module is intentionally free of any Foundry globals so it can be
// imported by Node for tests. Only plain data helpers live here.

import { normalizeTheme } from '../themes/registry.js';
import { isValidPersonality } from '../social/personalities.js';
import { clampReputation } from '../social/reputation.js';

export const SCHEMA_VERSION = 1;
export const LOCATION_KIND = 'location';
export const SHOP_KIND = 'shop';
export const LEDGER_KIND = 'ledger';
export const REPUTATION_KIND = 'reputation';
export const REPUTATION_EVENT_KIND = 'reputationEvent';

export const STOCK_MODES = ['finite', 'unlimited', 'non-restocking'];
export const LEDGER_STATUSES = ['pending', 'committed', 'failed', 'needsRecovery'];
export const OWNER_LEVEL = 3;

// M2 appearance validation constants. These are shared with the request layer so
// the public catalog can sanitize appearance without duplicating the allowed
// values and length caps.
export const TYPOGRAPHY_OPTIONS = ['classic', 'display', 'modern'];
export const DENSITY_OPTIONS = ['comfortable', 'compact'];
export const ANIMATION_OPTIONS = ['full', 'subtle', 'off'];

export const MEDIA_PATH_MAX = 300;
export const WELCOME_MESSAGE_MAX = 500;
export const PUBLIC_DESCRIPTION_MAX = 1000;
export const CATEGORY_MAX = 120;
export const RARITY_MAX = 60;

// ---- M3 social constants ---------------------------------------------------
// A shop carries at most one primary NPC and up to MAX_SHOP_NPCS total. The
// primary (first) NPC is the shop owner on a legacy shop and the name/portrait
// are kept synchronized with the legacy `owner` string.
export const MAX_SHOP_NPCS = 3;
export const NPC_GREETING_MAX = 500;

// Basis-point adjustments are bounded. Reputation and shop markup are read from
// the same range used by the social pricing engine.
export const SOCIAL_BPS_MIN = -9000;
export const SOCIAL_BPS_MAX = 50000;

// Combined adjustment envelope for a social price breakdown. Each component
// (shop/personality/reputation/haggle) is individually bounded to
// [SOCIAL_BPS_MIN, SOCIAL_BPS_MAX], but quoteSocial sums them additively, so the
// combined `adjustmentBps` may span the full sum of those bounds and must be
// validated against these combined bounds, not the per-component ones.
export const SOCIAL_COMBINED_BPS_MIN = -36000;
export const SOCIAL_COMBINED_BPS_MAX = 200000;

// ---- M4 shop automation constants ----------------------------------------
// The shop `automation` object carries declared business hours, a travelling
// merchant schedule, plain-text market events and GM-run diagnostics. It is
// purely declarative data validated below; the deterministic decisions derived
// from it live in `src/automation/policy.js` (no runtime/UI here).
export const MAX_AUTOMATION_EVENTS = 10;
export const AUTOMATION_EVENT_TITLE_MAX = 100;
export const AUTOMATION_EVENT_DESCRIPTION_MAX = 400;
export const TRAVEL_LOCATION_MIN = 2;
export const TRAVEL_LOCATION_MAX = 10;
export const AUTOMATION_INTERVAL_MIN = 3600;
export const AUTOMATION_INTERVAL_MAX = 31536000;
export const STOCK_VISIBILITIES = ['exact', 'low', 'hidden'];
export const HOURS_DAY_MIN = 0;
export const HOURS_DAY_MAX = 6;
export const HOURS_MINUTE_MIN = 0;
export const HOURS_MINUTE_MAX = 1439;
// Restock/stock-visibility metadata lives on each inventory entry, never on the
// shop, so it rides the existing per-entry schema without a version bump.
export const LOW_STOCK_THRESHOLD = 3;
export const RESTOCK_TARGET_MIN = 1;

export const ACCENT_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Only local asset paths under the Foundry asset roots are allowed. The path
// must be printable ASCII and exclude quotes, parentheses, backslash, percent,
// colon, and any query/fragment (`?`, `#`), and must not contain a `..`
// segment. A single allowed media path is at most MEDIA_PATH_MAX chars.
const MEDIA_PATH_BAD_CHARS = /["'()\\%:?#]/;
const MEDIA_PATH_ROOT = /^(?:\.\/)?(?:modules|worlds|systems|icons)\//;
const MEDIA_PATH_DOTDOT = /(?:^|\/)\.\.(?:\/|$)/;

const ID_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a compact, Foundry-style base62 id. Uses the Web Crypto API which
 * is available both in the browser and in modern Node (>= 20).
 */
export function makeId(length = 16) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ID_CHARS[byte % ID_CHARS.length];
  return out;
}

export function assertString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw new Error(`[market] '${label}' must be a string, got ${typeof value}`);
  }
  if (!allowEmpty && value.trim() === '') {
    throw new Error(`[market] '${label}' must not be empty`);
  }
  return value;
}

export function assertInteger(value, label, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`[market] '${label}' must be a safe integer, got ${value}`);
  }
  if (value < min) {
    throw new Error(`[market] '${label}' must be >= ${min}, got ${value}`);
  }
  return value;
}

export function assertPositiveInteger(value, label) {
  return assertInteger(value, label, { min: 1 });
}

export function assertBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new Error(`[market] '${label}' must be a boolean, got ${typeof value}`);
  }
  return value;
}

export function assertStockMode(value) {
  if (!STOCK_MODES.includes(value)) {
    throw new Error(
      `[market] 'stockMode' must be one of ${STOCK_MODES.join(', ')}, got ${value}`
    );
  }
  return value;
}

export function assertLedgerStatus(value) {
  if (!LEDGER_STATUSES.includes(value)) {
    throw new Error(
      `[market] ledger status must be one of ${LEDGER_STATUSES.join(', ')}, got ${value}`
    );
  }
  return value;
}

/**
 * Whether `value` is an acceptable local media path. Empty (optional) is always
 * acceptable. A non-empty value must be a printable-ASCII local path under
 * `modules/`, `worlds/`, `systems/` or `icons/` (with an optional `./` prefix),
 * must not contain quotes, parentheses, backslash, percent, colon, a `..`
 * segment or a query/fragment, and must be at most MEDIA_PATH_MAX long.
 */
export function isValidMediaPath(value) {
  const v = String(value ?? '').trim();
  if (v === '') return true;
  if (v.length > MEDIA_PATH_MAX) return false;
  if (!/^[\x20-\x7e]*$/.test(v)) return false;
  if (MEDIA_PATH_BAD_CHARS.test(v)) return false;
  if (MEDIA_PATH_DOTDOT.test(v)) return false;
  return MEDIA_PATH_ROOT.test(v);
}

/**
 * Return a safe media path for public projection. Never throws: an empty value
 * stays empty, a valid local path is trimmed and returned, and any invalid value
 * collapses to '' so an unsafe path cannot leak into a player-facing catalog.
 */
export function sanitizeMediaPath(value) {
  const v = String(value ?? '').trim();
  if (v === '') return '';
  return isValidMediaPath(v) ? v : '';
}

function assertMediaPath(value, label) {
  const v = String(value ?? '').trim();
  if (v !== '' && !isValidMediaPath(v)) {
    throw new Error(
      `[market] '${label}' must be a local media path under modules/, worlds/, systems/ or icons/ ` +
        `(printable ASCII, no quotes/parentheses/backslash/percent/dot-dot segment/query/colon), got '${v}'`
    );
  }
  return v;
}

function assertAccentColor(value) {
  const v = String(value ?? '').trim();
  if (v === '') return '';
  if (!ACCENT_COLOR_RE.test(v)) {
    throw new Error(
      `[market] 'appearance.accentColor' must be empty or a #rrggbb hex color, got '${v}'`
    );
  }
  return v;
}

/**
 * Normalize a shop appearance object to a known, validated shape. Radio-style
 * fields fall back to their documented defaults when unrecognized; media paths
 * and the accent color are strict and throw on an invalid GM save. Strings are
 * capped (welcomeMessage at WELCOME_MESSAGE_MAX).
 */
export function normalizeAppearance(raw = {}) {
  return {
    backgroundImage: assertMediaPath(raw.backgroundImage, 'appearance.backgroundImage'),
    ownerPortrait: assertMediaPath(raw.ownerPortrait, 'appearance.ownerPortrait'),
    accentColor: assertAccentColor(raw.accentColor),
    typography: TYPOGRAPHY_OPTIONS.includes(raw.typography) ? raw.typography : 'classic',
    density: DENSITY_OPTIONS.includes(raw.density) ? raw.density : 'comfortable',
    animation: ANIMATION_OPTIONS.includes(raw.animation) ? raw.animation : 'full',
    music: assertMediaPath(raw.music, 'appearance.music'),
    soundEffect: assertMediaPath(raw.soundEffect, 'appearance.soundEffect'),
    welcomeMessage: String(raw.welcomeMessage ?? '').slice(0, WELCOME_MESSAGE_MAX),
  };
}

/**
 * A snapshot is valid item data only when it parses to a non-null object with a
 * non-empty `name`. Anything else (empty, a plain summary string, an array, a
 * JSON scalar) is not usable as a delivery source. This mirrors the commerce
 * fallback so the schema always agrees with what the purchase path can deliver.
 * Returns the parsed object, or null when the snapshot is not usable.
 */
export function parseItemData(snapshot) {
  if (!snapshot) return null;
  let parsed;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.name !== 'string' || parsed.name.trim() === '') return null;
  return parsed;
}

/**
 * Normalize an inventory entry. All integer/money fields are validated to be
 * non-negative safe integers so prices and quantities never drift to floats.
 *
 * `itemUuid` may be absent (empty) only when the entry also carries a valid
 * item snapshot as a delivery fallback - matching the commerce purchase path,
 * which can resolve the source from a snapshot when no live UUID exists.
 */
export function normalizeInventoryEntry(raw = {}) {
  const name = assertString(raw.name, 'entry.name');
  const price = assertInteger(raw.price ?? 0, 'entry.price');
  const quantity = assertInteger(raw.quantity ?? 0, 'entry.quantity');
  const stockMode = assertStockMode(raw.stockMode || 'finite');
  const stockVisibility =
    raw.stockVisibility && STOCK_VISIBILITIES.includes(raw.stockVisibility)
      ? raw.stockVisibility
      : 'exact';
  const restock = normalizeRestock(raw.restock, { quantity, stockMode });
  const itemUuid = String(raw.itemUuid ?? '').trim();
  const snapshot = assertString(raw.snapshot ?? '', 'entry.snapshot', {
    allowEmpty: true,
  });
  const snapshotData = parseItemData(snapshot);
  if (itemUuid === '' && !snapshotData) {
    throw new Error(`[market] 'entry.itemUuid' must not be empty without valid snapshot item data`);
  }

  return {
    id: raw.id || makeId(),
    itemUuid,
    snapshot,
    name,
    img: assertString(raw.img ?? '', 'entry.img', { allowEmpty: true }),
    quantity,
    stockMode,
    stockVisibility,
    restock,
    price,
    visible: raw.visible === false ? false : true,
    publicDescription: assertString(raw.publicDescription ?? '', 'entry.publicDescription', {
      allowEmpty: true,
    }).slice(0, PUBLIC_DESCRIPTION_MAX),
    category: assertString(raw.category ?? '', 'entry.category', { allowEmpty: true }).slice(
      0,
      CATEGORY_MAX
    ),
    rarity: assertString(raw.rarity ?? '', 'entry.rarity', { allowEmpty: true }).slice(
      0,
      RARITY_MAX
    ),
  };
}

// ---- M3 social + NPC normalization ----------------------------------------

function intInRange(value, min, max, label) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`[market] '${label}' must be a safe integer, got ${value}`);
  }
  if (value < min || value > max) {
    throw new Error(`[market] '${label}' must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function bpsInRange(value, label) {
  return intInRange(value, SOCIAL_BPS_MIN, SOCIAL_BPS_MAX, label);
}

function normalizeAutoPurchase(raw = {}) {
  const enabled = raw.enabled === true ? true : false;
  const minimumSpend = assertInteger(
    raw.minimumSpend ?? 100,
    'shop.social.autoPurchase.minimumSpend'
  );
  const cooldownSeconds = assertInteger(
    raw.cooldownSeconds ?? 86400,
    'shop.social.autoPurchase.cooldownSeconds'
  );
  const delta = assertInteger(raw.delta ?? 1, 'shop.social.autoPurchase.delta', { min: 1 });
  return { enabled, minimumSpend, cooldownSeconds, delta };
}

/**
 * Normalize a shop's `social` object to a known, validated shape. The two
 * personality weight fields must be bounded integers and, when both are
 * supplied, must sum to exactly 100 (a strict percent split). `partyId` is
 * empty by default and a missing secondary personality collapses to ''.
 */
export function normalizeShopSocial(raw = {}) {
  const primaryPersonality = isValidPersonality(raw.primaryPersonality)
    ? raw.primaryPersonality
    : 'honest';
  const secondaryPersonality =
    raw.secondaryPersonality && isValidPersonality(raw.secondaryPersonality)
      ? raw.secondaryPersonality
      : '';
  const secondaryWeight = intInRange(
    raw.secondaryWeight ?? 0,
    0,
    100,
    'shop.social.secondaryWeight'
  );

  const hasIndividual = raw.individualWeight != null;
  const hasParty = raw.partyWeight != null;
  let individualWeight = intInRange(
    raw.individualWeight ?? 70,
    0,
    100,
    'shop.social.individualWeight'
  );
  let partyWeight = intInRange(raw.partyWeight ?? 30, 0, 100, 'shop.social.partyWeight');
  if (hasIndividual && hasParty) {
    if (individualWeight + partyWeight !== 100) {
      throw new Error(
        `[market] shop.social individualWeight + partyWeight must equal 100, got ${individualWeight} + ${partyWeight}`
      );
    }
  } else if (hasIndividual) {
    partyWeight = 100 - individualWeight;
  } else if (hasParty) {
    individualWeight = 100 - partyWeight;
  }

  const partyId = assertString(raw.partyId ?? '', 'shop.social.partyId', { allowEmpty: true });
  const shopMarkupBps = bpsInRange(raw.shopMarkupBps ?? 0, 'shop.social.shopMarkupBps');
  const autoPurchase = normalizeAutoPurchase(raw.autoPurchase);

  return {
    primaryPersonality,
    secondaryPersonality,
    secondaryWeight,
    individualWeight,
    partyWeight,
    partyId,
    shopMarkupBps,
    autoPurchase,
  };
}

/**
 * Normalize a single shop NPC to a known shape. `name` is required; all other
 * fields fall back to documented defaults. The `portrait` is a local media path
 * validated with the same strict media-path rules as the shop appearance, and
 * `personality` falls back to 'honest' when unknown.
 */
export function normalizeNpc(raw = {}) {
  const id = raw.id || makeId();
  const name = assertString(raw.name, 'npcs[].name');
  const role = assertString(raw.role ?? '', 'npcs[].role', { allowEmpty: true });
  const actorUuid = assertString(raw.actorUuid ?? '', 'npcs[].actorUuid', { allowEmpty: true });
  const portrait = assertMediaPath(raw.portrait, 'npcs[].portrait');
  const greeting = assertString(raw.greeting ?? '', 'npcs[].greeting', { allowEmpty: true }).slice(
    0,
    NPC_GREETING_MAX
  );
  const personality = isValidPersonality(raw.personality) ? raw.personality : 'honest';
  const visible = raw.visible === false ? false : true;
  return { id, name, role, actorUuid, portrait, greeting, personality, visible };
}

function ownerNpc(owner, social, shopId) {
  return {
    // The primary (owner) NPC on a legacy shop gets a deterministic id derived
    // from the stable shop id, so re-normalizing the same shop never regenerates
    // it, and an owner name change keeps the same id.
    id: `owner-${shopId}`,
    name: owner,
    role: '',
    actorUuid: '',
    portrait: '',
    greeting: '',
    personality: social.primaryPersonality,
    visible: true,
  };
}

/**
 * Resolve a shop's NPC list and synchronized `owner` string. A shop carries at
 * most MAX_SHOP_NPCS NPCs (extra entries are dropped). The first (primary) NPC
 * is the shop owner: on a legacy shop (no npcs field) it is created from the
 * existing `owner` string, and the returned `owner` string is kept synchronized
 * from the first NPC. When raw NPCs exist alongside a non-empty `owner` string
 * changed through the manager's legacy owner field, the owner value takes
 * precedence and is applied to the primary NPC's name so an owner edit made
 * before NPCs were introduced is never lost.
 *
 * A new shop with no owner (empty `owner` string) has zero NPCs; the primary
 * owner NPC is only created once the GM specifies an owner.
 *
 * `shopId` is the stable shop id, used to derive the deterministic owner NPC id
 * so the same shop always maps to the same primary NPC id.
 */
function resolveNpcs(raw, owner, social, shopId) {
  if (Array.isArray(raw.npcs)) {
    let npcs = raw.npcs.slice(0, MAX_SHOP_NPCS).map(normalizeNpc);
    if (npcs.length === 0 && owner !== '') {
      npcs = [ownerNpc(owner, social, shopId)];
    } else if (npcs.length > 0 && owner !== '') {
      npcs[0] = { ...npcs[0], name: owner };
    }
    const outOwner = npcs.length > 0 ? npcs[0].name : owner;
    return { npcs, owner: outOwner };
  }
  if (owner !== '') {
    return { npcs: [ownerNpc(owner, social, shopId)], owner };
  }
  return { npcs: [], owner: owner };
}

// ---- M4 shop automation normalization --------------------------------------
// The shop `automation` object and per-entry restock/stock-visibility fields are
// validated strictly and fail closed at GM save (a malformed nested field throws
// rather than dropping data). A shop/entry with no automation fields normalizes
// to the documented defaults, so existing records load unchanged.

function assertDayIndex(value, label) {
  return intInRange(value, HOURS_DAY_MIN, HOURS_DAY_MAX, label);
}

function assertMinuteOfDay(value, label) {
  return intInRange(value, HOURS_MINUTE_MIN, HOURS_MINUTE_MAX, label);
}

function assertIntervalSeconds(value, label) {
  return intInRange(value, AUTOMATION_INTERVAL_MIN, AUTOMATION_INTERVAL_MAX, label);
}

// A cycle marker is the index of the last cycle a policy has already applied. It
// may be -1 (nothing applied yet) up to the safe integer ceiling.
function assertCycleMarker(value, label) {
  return intInRange(value, -1, Number.MAX_SAFE_INTEGER, label);
}

function assertAutomationTime(value, label) {
  if (value == null) return 0;
  return assertSignedInteger(value, label);
}

// A travel/restock schedule anchor is a signed world-time second; it may sit in
// the past so a schedule can start mid-stream without a backward clock.
function assertAnchorTime(value, label) {
  if (value == null) return 0;
  return assertSignedInteger(value, label);
}

// Local location ids are non-empty, at most REPUTATION_ID_MAX (120) chars, and
// free of control characters - the same id rule the rest of the schema uses. We
// de-duplicate while preserving order and cap at TRAVEL_LOCATION_MAX. When travel
// is enabled, 2..10 unique ids are required; when disabled an empty list is fine.
function normalizeLocationIds(rawIds, enabled, label) {
  if (!Array.isArray(rawIds)) rawIds = [];
  const ids = [];
  const seen = new Set();
  for (const id of rawIds) {
    const v = assertMarketId(id, label);
    if (seen.has(v)) continue;
    seen.add(v);
    ids.push(v);
    if (ids.length >= TRAVEL_LOCATION_MAX) break;
  }
  if (enabled && (ids.length < TRAVEL_LOCATION_MIN || ids.length > TRAVEL_LOCATION_MAX)) {
    throw new Error(
      `[market] '${label}' must contain ${TRAVEL_LOCATION_MIN}..${TRAVEL_LOCATION_MAX} unique ids when enabled, got ${ids.length}`
    );
  }
  return ids;
}

function normalizeHours(raw = {}) {
  let days;
  if (Array.isArray(raw.days)) {
    const seen = new Set();
    const out = [];
    for (const d of raw.days) {
      const v = assertDayIndex(d, 'automation.hours.days[]');
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    days = out;
  } else {
    days = [0, 1, 2, 3, 4, 5, 6];
  }
  return {
    enabled: raw.enabled === true ? true : false,
    days,
    openMinute: assertMinuteOfDay(raw.openMinute ?? 0, 'automation.hours.openMinute'),
    closeMinute: assertMinuteOfDay(raw.closeMinute ?? 0, 'automation.hours.closeMinute'),
  };
}

function normalizeTravel(raw = {}) {
  const enabled = raw.enabled === true ? true : false;
  return {
    enabled,
    locationIds: normalizeLocationIds(
      raw.locationIds,
      enabled,
      'automation.travel.locationIds[]'
    ),
    anchorTime: assertAnchorTime(raw.anchorTime, 'automation.travel.anchorTime'),
    intervalSeconds: assertIntervalSeconds(
      raw.intervalSeconds ?? 86400,
      'automation.travel.intervalSeconds'
    ),
    lastCycle: assertCycleMarker(raw.lastCycle ?? -1, 'automation.travel.lastCycle'),
  };
}

function normalizeAutomationEvent(raw = {}) {
  const startAt = assertAutomationTime(raw.startAt, 'automation.events[].startAt');
  const endAt = assertAutomationTime(raw.endAt ?? startAt + 1, 'automation.events[].endAt');
  if (endAt <= startAt) {
    throw new Error(
      `[market] 'automation.events[]' endAt must be > startAt, got ${endAt} <= ${startAt}`
    );
  }
  // The event id is validated with the same market-id rule the rest of the
  // schema uses: a non-empty string, at most REPUTATION_ID_MAX (120) chars, and
  // free of control characters. An absent/empty id generates a stable new one; an
  // object or an oversized/control-bearing id fails closed at GM save.
  const rawId = raw.id;
  const id =
    rawId == null || rawId === ''
      ? makeId()
      : assertMarketId(rawId, 'automation.events[].id');
  return {
    id,
    title: assertString(raw.title ?? '', 'automation.events[].title', { allowEmpty: true }).slice(
      0,
      AUTOMATION_EVENT_TITLE_MAX
    ),
    description: assertString(raw.description ?? '', 'automation.events[].description', {
      allowEmpty: true,
    }).slice(0, AUTOMATION_EVENT_DESCRIPTION_MAX),
    startAt,
    endAt,
    visible: raw.visible === false ? false : true,
  };
}

function normalizeDiagnostics(raw = {}) {
  const lastRunAt = raw.lastRunAt == null ? null : assertSignedInteger(raw.lastRunAt);
  return {
    lastRunAt,
    lastStatus: assertString(raw.lastStatus ?? 'never', 'automation.diagnostics.lastStatus', {
      allowEmpty: true,
    }),
    lastError: assertString(raw.lastError ?? '', 'automation.diagnostics.lastError', {
      allowEmpty: true,
    }),
    lastRestocked: assertInteger(raw.lastRestocked ?? 0, 'automation.diagnostics.lastRestocked'),
    lastLocationId: assertString(raw.lastLocationId ?? '', 'automation.diagnostics.lastLocationId', {
      allowEmpty: true,
    }),
  };
}

/**
 * Normalize a shop's `automation` object. Every nested block falls back to a
 * documented default, but a malformed value inside an explicitly supplied block
 * (an out-of-range day/minute/interval, a non-positive event window, an invalid
 * location id, an inconsistent interval) throws so a bad GM save fails closed.
 * Existing records that carry no `automation` field normalize to harmless
 * defaults (hours/travel disabled, no events).
 */
export function normalizeAutomation(raw = {}) {
  return {
    hours: normalizeHours(raw.hours),
    travel: normalizeTravel(raw.travel),
    events: (Array.isArray(raw.events) ? raw.events : [])
      .slice(0, MAX_AUTOMATION_EVENTS)
      .map(normalizeAutomationEvent),
    diagnostics: normalizeDiagnostics(raw.diagnostics),
  };
}

/**
 * Normalize the per-entry `restock` schedule. A restock is only meaningful for a
 * finite-stock entry; if the entry is not finite the schedule is disabled even
 * when the GM toggled it on (the schedule simply never fires). `target` may be
 * any positive safe integer up to Number.MAX_SAFE_INTEGER and is never forced to
 * match the current quantity - a GM-edited quantity above the target is left
 * alone and a scheduled restock never reduces stock.
 */
function normalizeRestock(raw = {}, { quantity, stockMode }) {
  const enabled = raw.enabled === true && stockMode === 'finite' ? true : false;
  const target = intInRange(
    raw.target ?? Math.max(RESTOCK_TARGET_MIN, quantity),
    RESTOCK_TARGET_MIN,
    Number.MAX_SAFE_INTEGER,
    'entry.restock.target'
  );
  return {
    enabled,
    target,
    intervalSeconds: assertIntervalSeconds(
      raw.intervalSeconds ?? 86400,
      'entry.restock.intervalSeconds'
    ),
    anchorTime: assertAnchorTime(raw.anchorTime, 'entry.restock.anchorTime'),
    lastCycle: assertCycleMarker(raw.lastCycle ?? -1, 'entry.restock.lastCycle'),
  };
}

export function normalizeShop(raw = {}) {
  const name = assertString(raw.name, 'shop.name');
  const open = raw.open === false ? false : true;
  const createdAt = Number(raw.createdAt ?? Date.now());
  if (!Number.isSafeInteger(createdAt)) {
    throw new Error('[market] shop.createdAt must be a safe integer');
  }

  const inventory = (Array.isArray(raw.inventory) ? raw.inventory : []).map(
    normalizeInventoryEntry
  );
  const id = raw.id || makeId();
  const owner = assertString(raw.owner ?? '', 'shop.owner', { allowEmpty: true });
  const social = normalizeShopSocial(raw.social);
  const resolved = resolveNpcs(raw, owner, social, id);

  return {
    id,
    name,
    locationId: assertString(raw.locationId ?? '', 'shop.locationId', {
      allowEmpty: true,
    }),
    description: assertString(raw.description ?? '', 'shop.description', {
      allowEmpty: true,
    }),
    theme: normalizeTheme(raw.theme),
    owner: resolved.owner,
    appearance: normalizeAppearance(raw.appearance),
    open,
    inventory,
    npcs: resolved.npcs,
    social,
    automation: normalizeAutomation(raw.automation),
    createdAt,
  };
}

export function normalizeLocation(raw = {}) {
  const name = assertString(raw.name, 'location.name');
  const createdAt = Number(raw.createdAt ?? Date.now());
  if (!Number.isSafeInteger(createdAt)) {
    throw new Error('[market] location.createdAt must be a safe integer');
  }
  return {
    id: raw.id || makeId(),
    name,
    description: assertString(raw.description ?? '', 'location.description', {
      allowEmpty: true,
    }),
    theme: assertString(raw.theme ?? '', 'location.theme', {
      allowEmpty: true,
    }),
    createdAt,
  };
}

/**
 * Validate and normalize a social price breakdown for persistence on a ledger
 * record, or return null when none is supplied. A breakdown contains only plain
 * integer monetary/bps fields, a `band` with a display title and threshold, and
 * a `refused` boolean. Every numeric field must be a safe integer; the band
 * title must be a non-empty string and the threshold a safe integer; `refused`
 * must be a boolean. This never accepts raw arbitrary JSON - an unvalidated
 * breakdown must fail closed rather than leak an unbounded object into the
 * ledger. Returns null for a null/undefined input (legacy/non-social purchase).
 */
export function normalizePriceBreakdown(raw = null) {
  if (raw == null) return null;
  const quantity = assertInteger(raw.quantity ?? 1, 'priceBreakdown.quantity', { min: 1 });
  const unitBase = assertInteger(raw.unitBase ?? 0, 'priceBreakdown.unitBase');
  const baseTotal = assertInteger(raw.baseTotal ?? 0, 'priceBreakdown.baseTotal');
  // Basis-point fields are signed: a reputation/personality/haggle discount is
  // negative (e.g. Loved = -1500) and never below SOCIAL_BPS_MIN.
  const shopBps = assertInteger(raw.shopBps ?? 0, 'priceBreakdown.shopBps', {
    min: SOCIAL_BPS_MIN,
  });
  const personalityBps = assertInteger(
    raw.personalityBps ?? 0,
    'priceBreakdown.personalityBps',
    { min: SOCIAL_BPS_MIN }
  );
  const reputationBps = assertInteger(
    raw.reputationBps ?? 0,
    'priceBreakdown.reputationBps',
    { min: SOCIAL_BPS_MIN }
  );
  const haggleBps = assertInteger(raw.haggleBps ?? 0, 'priceBreakdown.haggleBps', {
    min: SOCIAL_BPS_MIN,
  });
  // The combined adjustment is the additive sum of up to four width-
  // [-9000, 50000] components, so it is bounded by the combined envelope
  // [-36000, 200000], not by the per-component bounds.
  const adjustmentBps = intInRange(
    raw.adjustmentBps ?? 0,
    SOCIAL_COMBINED_BPS_MIN,
    SOCIAL_COMBINED_BPS_MAX,
    'priceBreakdown.adjustmentBps'
  );
  const unitPrice = assertInteger(raw.unitPrice ?? 0, 'priceBreakdown.unitPrice');
  const total = assertInteger(raw.total ?? 0, 'priceBreakdown.total');
  // The `band` is optional (a raw/legacy breakdown may omit it), but when it is
  // present its title must be non-empty. An absent band defaults to a non-empty
  // neutral title so the rest of the validation (e.g. `refused`) still runs.
  const band = raw.band;
  const bandTitle =
    band == null
      ? 'neutral'
      : assertString(band.title ?? '', 'priceBreakdown.band.title');
  const bandThreshold =
    band == null
      ? 0
      : assertInteger(band.threshold ?? 0, 'priceBreakdown.band.threshold', {
          min: -100,
        });
  const refused = assertBoolean(raw.refused ?? false, 'priceBreakdown.refused');

  return {
    quantity,
    unitBase,
    baseTotal,
    shopBps,
    personalityBps,
    reputationBps,
    haggleBps,
    adjustmentBps,
    unitPrice,
    total,
    band: { title: bandTitle, threshold: bandThreshold },
    refused,
  };
}

export function normalizeLedgerRecord(raw = {}) {
  const key = assertString(raw.key, 'ledger.key');
  const status = assertLedgerStatus(raw.status || 'pending');
  const payloadHash = assertString(raw.payloadHash ?? '', 'ledger.payloadHash', {
    allowEmpty: true,
  });
  const quantity = assertInteger(raw.quantity ?? 1, 'ledger.quantity', { min: 1 });
  const unitPrice = assertInteger(raw.unitPrice ?? 0, 'ledger.unitPrice');
  const totalPrice = assertInteger(raw.totalPrice ?? 0, 'ledger.totalPrice');
  const priceBreakdown = normalizePriceBreakdown(raw.priceBreakdown);
  const createdAt = Number(raw.createdAt ?? Date.now());
  const updatedAt = Number(raw.updatedAt ?? createdAt);

  return {
    id: raw.id || makeId(),
    key,
    status,
    payloadHash,
    userId: assertString(raw.userId ?? '', 'ledger.userId', {
      allowEmpty: true,
    }),
    shopId: assertString(raw.shopId ?? '', 'ledger.shopId', {
      allowEmpty: true,
    }),
    entryId: assertString(raw.entryId ?? '', 'ledger.entryId', {
      allowEmpty: true,
    }),
    actorId: assertString(raw.actorId ?? '', 'ledger.actorId', {
      allowEmpty: true,
    }),
    quantity,
    unitPrice,
    totalPrice,
    priceBreakdown,
    payload: raw.payload ?? {},
    outcome: raw.outcome ?? {},
    error: assertString(raw.error ?? '', 'ledger.error', { allowEmpty: true }),
    compensation: (Array.isArray(raw.compensation) ? raw.compensation : []).slice(),
    createdAt,
    updatedAt,
  };
}

// ---- M3 GM reputation persistence -----------------------------------------
// GM-owned, per-entity reputation records and an append-only per-change event
// log. Each record and each event is stored in its OWN GM-only JournalEntry (no
// unbounded embedded history, no schema version bump - SCHEMA_VERSION stays 1).
//
// A reputation record is keyed by the (shopId, scope, subjectId) triple:
//   { id, shopId, scope: 'actor'|'party'|'faction', subjectId, score, updatedAt }
// An event is a single adjustment of a record:
//   { id, key, shopId, scope, subjectId, previous, delta, next, reason,
//     source: 'gm'|'purchase'|'haggle', status: 'pending'|'committed'|
//     'needsRecovery', createdAt }

export const REPUTATION_SCOPES = ['actor', 'party', 'faction'];
export const REPUTATION_SOURCES = ['gm', 'purchase', 'haggle'];
export const REPUTATION_EVENT_STATUSES = ['pending', 'committed', 'needsRecovery'];
export const REPUTATION_ID_MAX = 120;
export const REPUTATION_REASON_MAX = 200;

// Actor subject ids must be a Foundry world Actor UUID (``Actor.<id>``). Party /
// faction ids are safe non-empty slug-like ids (letters, digits, dot, underscore,
// hyphen, no path separators).
const ACTOR_UUID_RE = /^Actor\.[A-Za-z0-9]+$/;
const ID_SLUG_RE = /^[A-Za-z0-9._-]+$/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export function assertSignedInteger(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`[market] '${label}' must be a safe integer, got ${value}`);
  }
  return value;
}

/**
 * Validate a market record id (shopId or subjectId): a non-empty string, at most
 * 120 chars, and free of control characters. Leading/trailing whitespace is
 * trimmed.
 */
export function assertMarketId(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`[market] '${label}' must be a string, got ${typeof value}`);
  }
  const v = value.trim();
  if (v === '') throw new Error(`[market] '${label}' must not be empty`);
  if (v.length > REPUTATION_ID_MAX) {
    throw new Error(
      `[market] '${label}' must be at most ${REPUTATION_ID_MAX} chars, got ${v.length}`
    );
  }
  if (CONTROL_CHAR_RE.test(v)) {
    throw new Error(`[market] '${label}' must not contain control characters`);
  }
  return v;
}

export function assertReputationScope(value) {
  if (!REPUTATION_SCOPES.includes(value)) {
    throw new Error(
      `[market] reputation scope must be one of ${REPUTATION_SCOPES.join(', ')}, got ${value}`
    );
  }
  return value;
}

export function assertReputationSource(value) {
  if (!REPUTATION_SOURCES.includes(value)) {
    throw new Error(
      `[market] reputation source must be one of ${REPUTATION_SOURCES.join(', ')}, got ${value}`
    );
  }
  return value;
}

export function assertReputationEventStatus(value) {
  if (!REPUTATION_EVENT_STATUSES.includes(value)) {
    throw new Error(
      `[market] reputation event status must be one of ${REPUTATION_EVENT_STATUSES.join(', ')}, got ${value}`
    );
  }
  return value;
}

/**
 * Validate a subject id for a given scope. For `actor` it must be a Foundry
 * world Actor UUID; for `party`/`faction` it must be a safe non-empty slug id
 * (no path separators, no arbitrary path traversal).
 */
export function assertSubjectId(scope, value) {
  const v = assertMarketId(value, 'subjectId');
  if (scope === 'actor') {
    if (!ACTOR_UUID_RE.test(v)) {
      throw new Error(
        `[market] 'subjectId' for scope 'actor' must match /^Actor\\.[A-Za-z0-9]+$/, got '${v}'`
      );
    }
  } else if (!ID_SLUG_RE.test(v)) {
    throw new Error(
      `[market] 'subjectId' for scope '${scope}' must be a safe id (letters, digits, dot, underscore, hyphen), got '${v}'`
    );
  }
  return v;
}

/**
 * Normalize a reputation record. The score is clamped into [-100, 100] and
 * rounded to an integer; `updatedAt` defaults to now.
 */
export function normalizeReputation(raw = {}) {
  const shopId = assertMarketId(raw.shopId, 'shopId');
  const scope = assertReputationScope(raw.scope);
  const subjectId = assertSubjectId(scope, raw.subjectId);
  const score = clampReputation(raw.score ?? 0);
  const updatedAt = Number(raw.updatedAt ?? Date.now());
  if (!Number.isSafeInteger(updatedAt)) {
    throw new Error('[market] reputation.updatedAt must be a safe integer');
  }
  return {
    id: raw.id || makeId(),
    shopId,
    scope,
    subjectId,
    score,
    updatedAt,
  };
}

/**
 * Normalize a reputation event. `key` is the idempotency key, `reason` is capped
 * at REPUTATION_REASON_MAX and `delta` must be a signed safe integer. The score
 * fields are clamped into range.
 */
export function normalizeReputationEvent(raw = {}) {
  const key = assertString(raw.key, 'event.key');
  const shopId = assertMarketId(raw.shopId, 'shopId');
  const scope = assertReputationScope(raw.scope);
  const subjectId = assertSubjectId(scope, raw.subjectId);
  const source = assertReputationSource(raw.source || 'gm');
  const status = assertReputationEventStatus(raw.status || 'pending');
  const previous = clampReputation(raw.previous ?? 0);
  const delta = assertSignedInteger(raw.delta ?? 0, 'event.delta');
  const next = clampReputation(raw.next ?? 0);
  const reason = assertString(raw.reason ?? '', 'event.reason', {
    allowEmpty: true,
  }).slice(0, REPUTATION_REASON_MAX);
  const createdAt = Number(raw.createdAt ?? Date.now());
  if (!Number.isSafeInteger(createdAt)) {
    throw new Error('[market] reputationEvent.createdAt must be a safe integer');
  }
  return {
    id: raw.id || makeId(),
    key,
    shopId,
    scope,
    subjectId,
    previous,
    delta,
    next,
    reason,
    source,
    status,
    createdAt,
  };
}
