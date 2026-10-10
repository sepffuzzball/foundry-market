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
  normalizePriceBreakdown,
  sanitizeMediaPath,
} from '../services/model.js';
import { normalizeTheme } from '../themes/registry.js';
import { quoteSocial } from '../social/pricing.js';
import { getPersonality } from '../social/personalities.js';

export const PUBLIC_SHOP_FIELDS = [
  'id',
  'name',
  'locationId',
  'description',
  'theme',
  'owner',
  'appearance',
  'open',
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

/** Allowlisted public shop view. Never includes raw flags or hidden columns. */
export function publicShop(shop) {
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
  return out;
}

/**
 * Visible inventory entries with only allowlisted public fields. `itemUuid`
 * and any item `system` data are deliberately excluded from the catalog.
 */
export function publicInventory(shop) {
  const visible = (shop?.inventory || []).filter((e) => e.visible);
  return visible.map((e) => pickFields(e, PUBLIC_ENTRY_FIELDS));
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

export function buildCatalog(shop) {
  return {
    type: 'catalog',
    shop: publicShop(shop),
    inventory: publicInventory(shop),
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
    quantity: payload.quantity,
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
  if (type === 'purchase') {
    return { type: 'purchase', result: { status: 'error', error: 'server-error' } };
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

  // No actor => the base (non-personalized) public catalog. It still carries the
  // public merchant projection for the next UI, but no per-actor pricing.
  const actorId = request.actorId || null;
  if (!actorId) {
    return withCorrelation(buildCatalog(shop), request);
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

  let effective;
  try {
    effective = await ctx.getSocial(shop, actor);
  } catch (err) {
    // Fail closed: a reputation read failure must not leak a half-personalized
    // catalog; answer a correlated sanitized server-error instead.
    return withCorrelation({ type: 'error', error: 'server-error' }, request);
  }
  const scores = { individual: effective?.individual, party: effective?.party };

  // Quote each VISIBLE entry at quantity 1 through the social engine. Hidden
  // entries remain omitted (never personalized, never leaked). Any quote failure
  // fails closed as a correlated server-error.
  const inventory = [];
  for (const entry of shop.inventory || []) {
    if (entry.visible === false) continue;
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
    const publicEntry = pickFields(entry, PUBLIC_ENTRY_FIELDS);
    publicEntry.price = quote.unitPrice;
    publicEntry.basePrice = entry.price;
    publicEntry.priceBreakdown = breakdown;
    publicEntry.canBuy = !quote.refused;
    inventory.push(publicEntry);
  }

  return withCorrelation(
    {
      type: 'catalog',
      shop: publicShop(shop),
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
