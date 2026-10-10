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
import { createAutomationService } from '../automation/service.js';
import { createTableInventoryService } from '../automation/tables.js';
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

/**
 * Whether the current user is the active GM. Both the automation service gate and
 * the runtime tick use this exact predicate, and it is re-checked inside the
 * service on every run, so a GM handover between ticks never triggers a store read.
 */
function isActiveGM() {
  return game.user?.id === game.users.activeGM?.id && game.user?.isGM;
}

/**
 * The authoritative world-time in whole seconds from the Foundry server clock.
 * Never trust a client-supplied time; every M4 trading/automation decision reads
 * this getter. Shared by commerce (`getWorldTime`), the request context
 * (`worldTime`) and the automation service (`now`).
 *
 * An invalid server clock (NaN/undefined/Infinity/non-safe) returns null rather
 * than `Math.floor`-ing a bad value into NaN/Infinity; every consumer already
 * treats a null as `invalid-world-time` and never coerces it to week zero.
 */
function worldTimeNow() {
  const t = game.time?.worldTime;
  if (!Number.isFinite(t)) return null;
  const floored = Math.floor(t);
  return Number.isSafeInteger(floored) ? floored : null;
}

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

/**
 * Resolve a single v14 RollTable document result to a world or compendium Item.
 *
 * Only `type === 'document'` results are usable; a text row (or any other result
 * shape) returns null so the caller can count it invalid. A world Item is
 * addressed when `documentCollection === 'Item'` and is resolved via
 * `game.items.get(documentId)`. Any other collection is treated as a compendium
 * pack id: it is accepted only when `game.packs.get(collection)` exists and the
 * pack is an Item pack (`pack.documentName === 'Item'`) or reports a v14
 * document-class name of `'Item'` (`pack.documentClass?.documentName === 'Item'`),
 * and the document is then fetched via `pack.getDocument(id)`. The resolved
 * document is verified to be an Item before it is returned, so a compendium that
 * advertises an Item class but yields a non-Item row is rejected. We never
 * construct an arbitrary UUID; a missing `documentId`, an unknown collection, or
 * a non-Item pack/document returns null so the caller skips/counts the result.
 */
async function resolveTableResult(result) {
  if (!result || result.type !== 'document') return null;
  const collection = result.documentCollection;
  const id = result.documentId;
  if (typeof id !== 'string' || id === '') return null;
  if (collection === 'Item') {
    return game.items.get(id) || null;
  }
  if (typeof collection === 'string' && collection !== '') {
    const pack = game.packs.get(collection);
    if (pack) {
      const isItemPack =
        pack.documentName === 'Item' || pack.documentClass?.documentName === 'Item';
      if (isItemPack) {
        const doc = await pack.getDocument(id);
        return doc && doc.documentName === 'Item' ? doc : null;
      }
    }
  }
  return null;
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
    getWorldTime: worldTimeNow,
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
    worldTime: worldTimeNow,
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

function exposeApi(commerce, automation) {
  const api = {
    store,
    commerce,
    // M4 GM-only automation surface. Each method guards on the active GM before
    // doing anything, and the raw service/store are NOT exposed - a caller only
    // ever sees the bounded summaries/diagnostics the service returns. The
    // service itself also re-checks active-GM internally, so this is defense in
    // depth, not the only guard.
    automation: {
      runAll: () => {
        if (!isActiveGM()) return Promise.resolve({ status: 'idle', summaries: [] });
        return automation.runAll();
      },
      runShop: (shopId) => {
        if (!isActiveGM()) return Promise.resolve({ status: 'idle', shopId });
        return automation.runShop(shopId);
      },
      getDiagnostics: (shopId) => {
        if (!isActiveGM()) return Promise.resolve({ status: 'idle', diagnostics: [] });
        return automation.getDiagnostics(shopId);
      },
    },
    // M4 GM-only RollTable inventory generation. The raw service and the store are
    // NOT exposed: a caller only ever receives the bounded numbers the service
    // returns. Guarded on THIS user being the active GM before anything is read,
    // so a player never triggers a table draw or a store read, and no
    // caller-supplied GM identity is ever trusted.
    generateInventory: (params = {}) => {
      if (!isActiveGM()) {
        return Promise.resolve({ status: 'error', error: 'not-active-gm' });
      }
      return tableInventoryService.generate(params);
    },
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

/**
 * Schedule one automation sweep. Reentrancy is guarded by a single in-flight
 * promise: while a sweep is running, any tick (or startup) that arrives merely
 * requests one follow-up, which runs after the current sweep finishes. This
 * never blocks the request handler (the sweep is not awaited by the hook), and
 * the active GM is re-checked inside the service before any store access.
 */
function scheduleAutomationRun() {
  if (automationRunInFlight) {
    automationRunQueued = true;
    return;
  }
  automationRunInFlight = (async () => {
    if (!isActiveGM()) {
      automationRunInFlight = null;
      return;
    }
    try {
      await automationService.runAll();
    } catch (err) {
      // Caught and logged so a bad shop never breaks the request channel.
      console.error('[market] automation sweep failed', err);
    } finally {
      automationRunInFlight = null;
      if (automationRunQueued) {
        automationRunQueued = false;
        scheduleAutomationRun();
      }
    }
  })();
}

/**
 * Wire the M4 automation runtime. Registers the `updateWorldTime` hook and
 * runs once at startup when the current user is the active GM. Only the active
 * GM's client drives automation, and any handover is picked up on the next clock
 * tick (or a reload) - we do not attempt a mid-tick re-evaluation.
 */
function registerAutomationRuntime() {
  Hooks.on('updateWorldTime', () => {
    if (isActiveGM()) scheduleAutomationRun();
  });
  if (isActiveGM()) scheduleAutomationRun();
}

let commerceInstance = null;
let automationService = null;
let repService = null;
let tableInventoryService = null;
let automationRunInFlight = null;
let automationRunQueued = false;

Hooks.once('init', () => {
  registerSettings();
  registerSettingsMenu();
  commerceInstance = buildCommerce();
  // Built after commerce so it shares commerce's per-shop lock runner; the SAME
  // lock purchases and GM manager inventory edits use. All automation mutations
  // thus run strictly serially against purchases on that shop.
  automationService = createAutomationService({
    store,
    runShopExclusive: commerceInstance.runShopExclusive,
    isActiveGM,
    now: worldTimeNow,
    logger: console,
  });
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
  // M4 GM-only RollTable inventory generation. Shares commerce's per-shop lock,
  // uses the same active-GM predicate as the automation service, resolves the
  // table strictly through `fromUuid` (never a caller-constructed UUID), and
  // resolves each drawn result through the live game API (world Items +
  // compendium Item packs only).
  tableInventoryService = createTableInventoryService({
    store,
    runShopExclusive: commerceInstance.runShopExclusive,
    isActiveGM,
    getTable: async (tableUuid) => {
      const doc = await fromUuid(tableUuid);
      return doc && doc.documentName === 'RollTable' ? doc : null;
    },
    resolveResult: resolveTableResult,
    getAdapter: () =>
      getAdapter(String(game.system.id || 'generic'), {
        resolver: (key) => game.settings.get(MODULE_ID, key),
      }),
    makeId,
    logger: console,
  });
  exposeApi(commerceInstance, automationService);
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
  registerAutomationRuntime();
});

// Re-exports for tooling/tests that import this module directly.
export { getAdapter };
export { store };
