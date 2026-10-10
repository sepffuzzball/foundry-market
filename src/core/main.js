// Market core entry point (Foundry VTT v14). Native browser ESM, no build step.
//
// Responsibilities:
//   - Register the GM-only store singleton (locations/shops/ledger).
//   - Register settings for the generic adapter path configuration.
//   - Build the commerce service wired to the live game API.
//   - Expose game.modules.get('market').api with store/commerce/getAdapter/request.
//   - Handle player requests via ChatMessage (no raw socket).
//   - Wire the M1 UI: market manager (GM), player storefront and canvas markers.

import { makeId, normalizePriceBreakdown } from '../services/model.js';
import { createCommerce } from '../services/commerce.js';
import { createReputationService } from '../social/service.js';
import { quoteSocial } from '../social/pricing.js';
import { getAdapter } from '../adapters/index.js';
import { requestMessageData, attachMarketHandler } from './requests.js';
import { store } from '../storage/store.js';
import { MarketManager } from '../ui/manager.js';
import { MarketStorefront } from '../ui/storefront.js';
import { registerPlacements, createMarketMarker } from '../canvas/placements.js';
import { registerTheme } from '../themes/registry.js';

const MODULE_ID = 'market';

function registerSettings() {
  game.settings.register(MODULE_ID, 'genericWallet', {
    name: 'Generic wallet path',
    hint: 'Dot-path to the integer wallet on the actor (minor units). Required to enable the generic adapter, e.g. flags.foundry-wallet.balance',
    scope: 'world',
    config: true,
    type: String,
    default: '',
  });
  game.settings.register(MODULE_ID, 'genericPrice', {
    name: 'Generic item price path',
    hint: 'Dot-path to the integer item price (minor units), e.g. system.price.value. Required to enable the generic adapter.',
    scope: 'world',
    config: true,
    type: String,
    default: '',
  });
  game.settings.register(MODULE_ID, 'genericPriceDenomination', {
    name: 'Generic item price denomination path',
    hint: 'Optional dot-path to the item price denomination string (informational only).',
    scope: 'world',
    config: true,
    type: String,
    default: '',
  });
  game.settings.register(MODULE_ID, 'genericDeliveryMode', {
    name: 'Generic item delivery mode',
    hint: 'How a purchased item is delivered: embedded (create an Item on the actor) or path (push into a configured array).',
    scope: 'world',
    config: true,
    type: String,
    choices: { embedded: 'Embedded Item', path: 'Array path' },
    default: 'embedded',
  });
  game.settings.register(MODULE_ID, 'genericDeliveryPath', {
    name: 'Generic delivery array path',
    hint: 'When delivery mode is "path", the actor array to append the item into.',
    scope: 'world',
    config: true,
    type: String,
    default: '',
  });
  game.settings.register(MODULE_ID, 'genericQuantityPath', {
    name: 'Generic item quantity path',
    hint: 'Optional dot-path on the item at which to set the purchased quantity.',
    scope: 'world',
    config: true,
    type: String,
    default: '',
  });
}

function registerSettingsMenu() {
  game.settings.registerMenu(MODULE_ID, 'openMarket', {
    label: 'Open Market Manager',
    hint: 'Manage market locations, shops and inventory (GM).',
    icon: 'fas fa-store',
    type: MarketManager,
    restricted: true,
  });
}

/**
 * Resolve whether `userId` owns `actor` (or is a GM). Used by the commerce
 * purchase path, the catalog actor guard and the public read/quote API methods.
 */
function actorOwnedBy(actor, userId) {
  if (!actor) return false;
  const user = game.users.get(userId);
  if (!user) return false;
  if (user.isGM) return true;
  // Prefer the document API because it resolves the default ownership
  // level for players rather than reading a raw ownership map that may not
  // carry an entry for the user (falling back to `default`).
  if (typeof actor.testUserPermission === 'function') {
    const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    return actor.testUserPermission(user, owner);
  }
  const level = actor.ownership?.[userId];
  return typeof level === 'number' && level >= 3; // CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
}

/**
 * Return the effective reputation of `actor` against `shop` through the live
 * reputation service. Shared by the commerce purchase path (pre-debit social
 * quote) and the catalog/quote API surface. Throws when the service is not yet
 * built (it is created after commerce in `init`; this is only ever called at
 * request/purchase time, well after startup).
 */
async function getSocialEffective(shop, actor) {
  if (!repService) {
    throw new Error('[market] reputation service not ready');
  }
  return repService.getEffective(shop, actor.uuid);
}

function buildCommerce() {
  return createCommerce({
    store,
    getActor: (id) => (id ? game.actors.get(id) : null),
    fromUuid: (uuid) => (uuid ? fromUuid(uuid) : null),
    getAdapter: () =>
      getAdapter(String(game.system.id || 'generic'), {
        resolver: (key) => game.settings.get(MODULE_ID, key),
      }),
    systemId: () => String(game.system.id || 'generic'),
    isGM: (userId) => {
      const user = game.users.get(userId);
      return !!user && user.isGM;
    },
    actorOwnedBy,
    logger: console,
    now: () => Date.now(),
    makeId,
    getSocial: getSocialEffective,
  });
}

function buildRequestContext(commerce) {
  return {
    commerce,
    store,
    activeGMId: () => game.users.activeGM?.id || null,
    currentUserId: () => game.user.id,
    gmIds: () => game.users.filter((u) => u.isGM).map((u) => u.id),
    respond: (data) =>
      ChatMessage.create({ ...data, style: CONST.CHAT_MESSAGE_STYLES.OOC }),
    getActor: (id) => (id ? game.actors.get(id) : null),
    actorOwnedBy,
    getSocial: getSocialEffective,
  };
}

function buildUiDeps() {
  const api = game.modules.get(MODULE_ID)?.api;
  return {
    api,
    store,
    getAdapter: (systemId, opts) =>
      getAdapter(systemId || String(game.system.id || 'generic'), {
        ...(opts || {}),
        resolver: (key) => game.settings.get(MODULE_ID, key),
      }),
    fromUuid: (uuid) => (uuid ? fromUuid(uuid) : null),
    systemId: () => String(game.system.id || 'generic'),
    request: (payload) => (api && api.request ? api.request(payload) : null),
    isGM: (userId) => {
      const user = game.users.get(userId);
      return !!user && user.isGM;
    },
    hasActiveGM: () => !!game.users.activeGM,
    openShop: (shopId) => (api && api.openShop ? api.openShop(shopId) : null),
    placeShop: (shopId) => (api && api.placeShop ? api.placeShop(shopId) : null),
    runShopExclusive: (shopId, fn) =>
      api?.commerce?.runShopExclusive ? api.commerce.runShopExclusive(shopId, fn) : null,
  };
}

/** Create a public market marker at the current canvas center (GM-only). */
function placeShopMarker(shopId) {
  // GM-only, consistent with the canvas drop path (`handleCanvasDrop`).
  if (!game.user?.isGM) return Promise.resolve(null);
  const scene = canvas?.scene || game.scenes?.viewed || null;
  if (!scene) return Promise.resolve(null);
  const x = canvas?.center?.x ?? scene?.width / 2 ?? 0;
  const y = canvas?.center?.y ?? scene?.height / 2 ?? 0;
  // `createMarketMarker` verifies the shop exists before creating the public
  // journal, so a deleted shop does not leak a marker with no backing shop.
  return createMarketMarker({
    shopId,
    x,
    y,
    scene,
    findShop: (id) => store.findShop(id),
  });
}

function exposeApi(commerce) {
  const api = {
    store,
    commerce,
    // Always resolve world settings, even when the adapter is requested through
    // the settings-menu path which has no injected deps.
    getAdapter: (systemId, opts) =>
      getAdapter(systemId || String(game.system.id || 'generic'), {
        ...(opts || {}),
        resolver: (key) => game.settings.get(MODULE_ID, key),
      }),
    request: (payload = {}) => {
      const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);
      const requestId = payload.requestId || makeId();
      // Always target the GM(s), ignoring any caller-supplied `whisper`, so a
      // stray override can never mis-route a request away from the client that
      // must process it. When a GM sends their own request, the GM id list still
      // includes the sender, so the request is processed and answered normally.
      const data = requestMessageData({
        ...payload,
        requestId,
        whisper: gmIds,
      });
      return ChatMessage.create({ ...data, style: CONST.CHAT_MESSAGE_STYLES.OOC });
    },
    // M3 reputation + social pricing surface. `adjust` is GM-only: the service
    // itself is GM-gated, but the API wrapper rejects a non-GM caller up front
    // and always passes THIS user's id (never a caller-supplied, possibly forged
    // GM id). `getEffective` is the safest GM-only read helper: a non-GM caller
    // is rejected (returns null) before any service read, so it can never probe
    // another player's reputation; public/owned reads go through
    // `getReputation`/`quotePrice`, which check actor ownership and return null
    // when the actor is not owned by the current user (or GM) and never leak a
    // hidden entry.
    reputation: {
      getEffective: (shop, actorUuid) => {
        // GM-only: reject a non-GM caller before touching the service (never
        // leaks an unowned/untrusted actor's private reputation score).
        if (!game.user?.isGM) return null;
        return repService.getEffective(shop, actorUuid);
      },
      adjust: (params) => {
        if (!game.user?.isGM) {
          return Promise.resolve({ status: 'error', error: 'not-a-gm' });
        }
        return repService.adjust(params, game.user.id);
      },
    },
    getReputation: async (shopId, actorId) => {
      const actor = game.actors.get(actorId);
      if (!actor) return null;
      if (!(game.user?.isGM || actorOwnedBy(actor, game.user.id))) return null;
      const shop = await store.findShop(shopId);
      if (!shop) return null;
      return repService.getEffective(shop, actor.uuid);
    },
    quotePrice: async (shopId, entryId, actorId, qty) => {
      const actor = game.actors.get(actorId);
      if (!actor) return null;
      if (!(game.user?.isGM || actorOwnedBy(actor, game.user.id))) return null;
      const shop = await store.findShop(shopId);
      if (!shop) return null;
      const entry = shop.inventory.find((e) => e.id === entryId);
      if (!entry) return null;
      if (entry.visible === false) return null;
      const effective = await repService.getEffective(shop, actor.uuid);
      const quote = quoteSocial(entry, qty == null ? 1 : qty, {
        shop,
        scores: { individual: effective.individual, party: effective.party },
      });
      return {
        entryId,
        basePrice: entry.price,
        unitPrice: quote.unitPrice,
        total: quote.total,
        quantity: quote.quantity,
        refused: quote.refused,
        band: quote.band,
        priceBreakdown: normalizePriceBreakdown({
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
        }),
      };
    },
    openManager: () => {
      // GM-only: fail closed (render nothing) rather than constructing the
      // manager for a non-GM user that cannot edit the private store.
      if (!game.user?.isGM) return Promise.resolve(null);
      const app = new MarketManager({ deps: buildUiDeps() });
      return app.render({ force: true });
    },
    openShop: (shopId) => {
      const app = new MarketStorefront({ shopId, deps: buildUiDeps() });
      return app.render({ force: true });
    },
    placeShop: (shopId) => placeShopMarker(shopId),
    registerTheme: (metadata) => registerTheme(metadata),
  };
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = api;
  } else {
    console.warn('[market] could not attach api: game.modules missing module id', MODULE_ID);
  }
}

function attachHandler(commerce) {
  attachMarketHandler(buildRequestContext(commerce));
}

/** Best-effort world-directory entry point: a Market button on the Journal sidebar. */
function registerJournalDirectory() {
  Hooks.on('renderJournalDirectory', (app, html, data) => {
    if (!game.user?.isGM) return;
    const root = html?.[0] || html;
    if (!root || !root.querySelector) return;
    if (root.querySelector('.market-open-manager')) return;
    const btn = document.createElement('button');
    btn.className = 'market-open-manager';
    btn.type = 'button';
    btn.title = 'Open Market Manager';
    btn.textContent = 'Market';
    btn.addEventListener('click', () => {
      const api = game.modules.get(MODULE_ID)?.api;
      if (api?.openManager) api.openManager();
    });
    const header = root.querySelector('.directory-header, .window-header, header');
    (header || root).appendChild(btn);
  });
}

let commerceInstance = null;
let repService = null;

Hooks.once('init', () => {
  registerSettings();
  registerSettingsMenu();
  commerceInstance = buildCommerce();
  repService = createReputationService({
    store,
    runShopExclusive: commerceInstance.runShopExclusive,
    isGM: (userId) => {
      const user = game.users.get(userId);
      return !!user && user.isGM;
    },
    makeId,
    now: () => Date.now(),
  });
  exposeApi(commerceInstance);
});

Hooks.once('ready', () => {
  attachHandler(commerceInstance);
  registerPlacements({
    isGM: (userId) => {
      const user = game.users.get(userId);
      return !!user && user.isGM;
    },
    openShop: (shopId) => {
      const api = game.modules.get(MODULE_ID)?.api;
      if (api?.openShop) return api.openShop(shopId);
    },
    findShop: (id) => store.findShop(id),
  });
  registerJournalDirectory();
});

// Re-exports for tooling/tests that import this module directly.
export { getAdapter };
export { store };
