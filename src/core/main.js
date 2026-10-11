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
import { createSellingService } from '../advanced/selling.js';
import { createCartCommerce } from '../advanced/cart.js';
import { createValuationService } from '../advanced/valuation.js';
import { createServiceCommerce } from '../advanced/services.js';
import { createPreorderCommerce } from '../advanced/preorders.js';
import { createTheftCommerce } from '../advanced/theft.js';
import { createAutomationService } from '../automation/service.js';
import { createTableInventoryService } from '../automation/tables.js';
import { createReputationService } from '../social/service.js';
import { quoteSocial } from '../social/pricing.js';
import { canAccessEntry } from '../advanced/policy.js';
import { getAdapter } from '../adapters/index.js';
import {
  requestMessageData,
  attachMarketHandler,
  publicServiceResult,
  publicPreorderResult,
  publicTheftResult,
  publicAdvancedOrder,
} from './requests.js';
import { store } from '../storage/store.js';
import { createBackupService } from '../storage/backup.js';
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

/**
 * Resolve the configured generic-adapter path settings through the live game
 * settings registry. Shared by the advanced-commerce services so they read the
 * same adapter configuration the purchase/catalog path uses.
 */
function getLiveAdapter() {
  return getAdapter(String(game.system.id || 'generic'), {
    resolver: (key) => game.settings.get(MODULE_ID, key),
  });
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

function buildRequestContext(commerce, selling, advanced = {}) {
  return {
    commerce,
    selling,
    cart: advanced.cart,
    services: advanced.services,
    preorders: advanced.preorders,
    theft: advanced.theft,
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

function exposeApi(commerce, automation, advanced = {}, backup = null) {
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
    // M5 GM-only advanced order resolution. These are the GM's own adjudication
    // methods (manual service fulfillment, preorder fulfill/cancel, theft
    // resolve, and the order list). They are guarded on THIS user being the
    // active GM BEFORE any store read, always execute as `game.user.id` (never a
    // caller-supplied GM id), and each result is run through the SAME per-type
    // public sanitizer the player request channel uses, so no private field leaks
    // to the UI. The raw service/store objects are NOT exposed. `resolveTheft`
    // is deliberately NOT reachable through a player request - only the GM can
    // grant or refuse a theft.
    advanced: {
      fulfillService: (params = {}) => {
        if (!isActiveGM()) return Promise.resolve({ status: 'error', error: 'not-active-gm' });
        const fn = advanced.services?.fulfill;
        return fn
          ? fn(params, game.user.id).then(publicServiceResult)
          : Promise.resolve({ status: 'error', error: 'server-error' });
      },
      fulfillPreorder: (params = {}) => {
        if (!isActiveGM()) return Promise.resolve({ status: 'error', error: 'not-active-gm' });
        const fn = advanced.preorders?.fulfill;
        return fn
          ? fn(params, game.user.id).then(publicPreorderResult)
          : Promise.resolve({ status: 'error', error: 'server-error' });
      },
      cancelPreorder: (params = {}) => {
        if (!isActiveGM()) return Promise.resolve({ status: 'error', error: 'not-active-gm' });
        const fn = advanced.preorders?.cancel;
        return fn
          ? fn(params, game.user.id).then(publicPreorderResult)
          : Promise.resolve({ status: 'error', error: 'server-error' });
      },
      resolveTheft: (params = {}) => {
        if (!isActiveGM()) return Promise.resolve({ status: 'error', error: 'not-active-gm' });
        const fn = advanced.theft?.resolve;
        return fn
          ? fn(params, game.user.id).then(publicTheftResult)
          : Promise.resolve({ status: 'error', error: 'server-error' });
      },
      // M6 GM-only per-Item valuation approval. Guarded on THIS user being the
      // active GM before any store read, always executes as `game.user.id`, and
      // returns only the approved valuation id/itemName/amount (the private
      // fingerprint and the raw entry are never exposed to the caller).
      approveValuation: (params = {}) => {
        if (!isActiveGM()) {
          return Promise.resolve({ status: 'error', error: 'not-active-gm' });
        }
        const fn = advanced.valuations?.approve;
        if (!fn) return Promise.resolve({ status: 'error', error: 'server-error' });
        return fn(params, game.user.id).then((r) =>
          r && r.status === 'approved'
            ? {
                status: 'approved',
                valuationId: r.valuationId,
                itemName: r.itemName,
                amount: r.amount,
              }
            : { status: (r && r.status) || 'error', error: (r && r.error) || 'server-error' }
        );
      },
      listOrders: async (params = {}) => {
        if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };
        try {
          // Limit is bounded to 1..100 (at least one record per page, never more
          // than the documented 100-record cap) and offset must be non-negative;
          // both are validated here before being forwarded to the store so a
          // caller can never request an empty page or a runaway slice.
          const rawLimit = params.limit == null ? 100 : Number(params.limit);
          const limit = Number.isFinite(rawLimit)
            ? Math.max(1, Math.min(Math.floor(rawLimit), 100))
            : 100;
          const rawOffset = params.offset == null ? 0 : Number(params.offset);
          const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
          const records = await store.listAdvancedOrders({
            shopId: params.shopId,
            status: params.status,
            kind: params.kind,
            limit,
            offset,
          });
          return { status: 'ok', orders: records.map(publicAdvancedOrder) };
        } catch (err) {
          return { status: 'error', error: 'server-error' };
        }
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
    // M5 GM-only whole-item sale. Guarded on THIS user being the active GM before
    // any read/write, so a player never triggers a store read or an effect; the
    // executing user is always `game.user.id` (never a caller-supplied GM id).
    // The raw service is NOT exposed - a caller only ever receives the bounded
    // sell result the service returns.
    sellItem: (params = {}) => {
      if (!isActiveGM()) {
        return Promise.resolve({ status: 'error', error: 'not-active-gm' });
      }
      return sellingService.sell(params, game.user.id);
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
      const isGm = !!game.user?.isGM;
      if (!(isGm || actorOwnedBy(actor, game.user.id))) return null;
      const shop = await store.findShop(shopId);
      if (!shop) return null;
      const entry = shop.inventory.find((e) => e.id === entryId);
      if (!entry) return null;
      if (entry.visible === false) return null;
      const effective = await repService.getEffective(shop, actor.uuid);
      // M5: a non-GM caller may only quote an entry their owned actor may access.
      // A `backroom` entry that the actor cannot access returns null (never
      // leaked to a player); the GM may quote any entry.
      if (!isGm && !canAccessEntry(entry, { actorUuid: actor.uuid, score: effective?.score })) {
        return null;
      }
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
    // M6 GM-only portable backup. The raw backup service and the store are NOT
    // exposed: a caller only ever receives the bounded `{status, backup/warnings}`
    // export result or the `{status, dryRun/counts/idMap/warnings}` preview /
    // `{status, createdLocationIds, createdShopIds, warnings}` import result.
    // Each wrapper guards on THIS user being the active GM before delegating, and
    // the service itself re-checks active-GM internally - defense in depth, never
    // the only guard. Backup state is never routed through a player request/chat;
    // the manager owns the export/preview/import UI.
    backup: {
      exportPortable: () => {
        if (!backup) return Promise.resolve({ status: 'error', error: 'server-error' });
        if (!isActiveGM()) return Promise.resolve({ status: 'error', error: 'not-active-gm' });
        return backup.exportPortable();
      },
      importPortable: (raw, opts = {}) => {
        if (!backup) return Promise.resolve({ status: 'error', error: 'server-error' });
        if (!isActiveGM()) return Promise.resolve({ status: 'error', error: 'not-active-gm' });
        return backup.importPortable(raw, opts);
      },
    },
  };
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = api;
  } else {
    console.warn('[market] could not attach api: game.modules missing module id', MODULE_ID);
  }
}

function attachHandler(commerce, selling, advanced) {
  attachMarketHandler(buildRequestContext(commerce, selling, advanced));
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

/**
 * Schedule one best-effort ledger folder sweep. Reentrancy is guarded by a single
 * in-flight promise: while a sweep is running, any further trigger merely requests
 * one follow-up, which runs after the current sweep finishes. This never blocks the
 * request handler (the sweep is not awaited), and the store re-checks the active GM
 * before the read and before each organize. Beyond filing folders, the same sweep
 * also backfills the GM-only ledger summary pages for existing/legacy journals, so
 * a restart or handover is the reconciliation point for any summary that was never
 * written.
 */
function scheduleLedgerFolderSweep() {
  if (ledgerSweepInFlight) {
    ledgerSweepQueued = true;
    return;
  }
  ledgerSweepInFlight = (async () => {
    try {
      await store.organizeLedgerJournals({ isActiveGM });
    } catch (err) {
      // Caught and logged so a bad journal never breaks the request channel.
      console.error('[market] ledger folder sweep failed', err);
    } finally {
      ledgerSweepInFlight = null;
      if (ledgerSweepQueued) {
        ledgerSweepQueued = false;
        scheduleLedgerFolderSweep();
      }
    }
  })();
}

/**
 * Possibly trigger a ledger folder sweep on a GM handover. Reads the active GM at
 * event time (via a microtask, so any computed `game.users.activeGM` state has
 * settled) and only sweeps when the active GM id CHANGED and now equals THIS user's
 * id. No sweep is issued when the active GM is unchanged or is not this client.
 */
function maybeScheduleLedgerFolderSweep() {
  // Defer the read to a microtask: `game.users.activeGM` may be recomputed only
  // after the hook's synchronous event has finished.
  queueMicrotask(() => {
    const current = game.users?.activeGM?.id ?? null;
    if (current === lastLedgerActiveGMId) return; // unchanged
    lastLedgerActiveGMId = current;
    if (current !== game.user?.id) return; // not this client's turn
    if (!game.user?.isGM) return; // non-active GM
    scheduleLedgerFolderSweep();
  });
}

/**
 * Register the GM-handover hooks and record the active GM at startup. Called once
 * from `ready`; the startup placeholder sweep above is handled by the caller.
 */
function registerLedgerUserSweep() {
  Hooks.on('userConnected', () => maybeScheduleLedgerFolderSweep());
  Hooks.on('updateUser', () => maybeScheduleLedgerFolderSweep());
}

let commerceInstance = null;
let automationService = null;
let repService = null;
let tableInventoryService = null;
let sellingService = null;
let cartCommerce = null;
let valuationService = null;
let serviceCommerce = null;
let preorderCommerce = null;
let theftCommerce = null;
let backupService = null;
let automationRunInFlight = null;
let automationRunQueued = false;
// Ledger folder sweep state. `lastLedgerActiveGMId` tracks the active GM id we
// last swept for (or observed), so a `userConnected`/`updateUser` event only
// triggers a sweep when the active GM actually changed AND became THIS user.
// `ledgerSweepInFlight`/`ledgerSweepQueued` coalesce concurrent triggers so a
// handover storm never starts duplicate sweeps.
let lastLedgerActiveGMId = null;
let ledgerSweepInFlight = null;
let ledgerSweepQueued = false;

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
  // M6 GM-authored per-Item valuation for sell/barter. Shares commerce's per-shop
  // lock and active-GM predicate; reads the actor strictly through the live game
  // API. Exposes the GM-only `approve` and the private `getApprovedValuation`
  // read side, which the sell/cart services inject so a player-owned Item is
  // never priced by its own (player-inflatable) system price.
  valuationService = createValuationService({
    store,
    runShopExclusive: commerceInstance.runShopExclusive,
    isActiveGM,
    getActor: (id) => (id ? game.actors.get(id) : null),
    makeId,
    logger: console,
  });
  // M5 GM-authoritative whole-item sale for buyback. Shares commerce's per-shop
  // lock (so a sell and a buy never interleave their shop writes), uses the same
  // active-GM predicate and world-time getter as automation, reads the actor and
  // adapter strictly through the live game API, and resolves each embedded Item
  // through `actor.items.get` (never a caller-constructed id). The sale is priced
  // only by the GM-approved valuation (`getApprovedValuation(item, shop)`), never
  // the item's own system price.
  sellingService = createSellingService({
    store,
    runShopExclusive: commerceInstance.runShopExclusive,
    isActiveGM,
    getActor: (id) => (id ? game.actors.get(id) : null),
    actorOwnedBy,
    getAdapter: () =>
      getAdapter(String(game.system.id || 'generic'), {
        resolver: (key) => game.settings.get(MODULE_ID, key),
      }),
    getApprovedValuation: valuationService.getApprovedValuation,
    now: worldTimeNow,
    makeId,
    logger: console,
  });
  // M5 advanced commerce services (cart / service / preorder / theft). Each
  // shares commerce's per-shop lock (so an advanced order never interleaves a
  // purchase), uses the same active-GM predicate and world-time getter as
  // automation, reads the actor and adapter strictly through the live game API,
  // and resolves UUIDs through `fromUuid` (never a caller-constructed UUID). The
  // service-booker has no social / snapshot needs, so it is built without
  // `getSocial` / `fromUuid`; the cart/preorder/theft services resolve the actor's
  // effective reputation through the live reputation service when they need a
  // personalized quote.
  cartCommerce = createCartCommerce({
    store,
    runShopExclusive: commerceInstance.runShopExclusive,
    isActiveGM,
    getActor: (id) => (id ? game.actors.get(id) : null),
    actorOwnedBy,
    getAdapter: getLiveAdapter,
    fromUuid: (uuid) => (uuid ? fromUuid(uuid) : null),
    getSocial: getSocialEffective,
    getWorldTime: worldTimeNow,
    now: () => Date.now(),
    // The bartered tender is credited only at the GM-approved valuation (never
    // its own system price) and consumed at commit, same as the sell path.
    getApprovedValuation: valuationService.getApprovedValuation,
    logger: console,
  });
  serviceCommerce = createServiceCommerce({
    store,
    runShopExclusive: commerceInstance.runShopExclusive,
    isActiveGM,
    getActor: (id) => (id ? game.actors.get(id) : null),
    actorOwnedBy,
    getAdapter: getLiveAdapter,
    getWorldTime: worldTimeNow,
    now: () => Date.now(),
    logger: console,
  });
  preorderCommerce = createPreorderCommerce({
    store,
    runShopExclusive: commerceInstance.runShopExclusive,
    isActiveGM,
    getActor: (id) => (id ? game.actors.get(id) : null),
    actorOwnedBy,
    getAdapter: getLiveAdapter,
    fromUuid: (uuid) => (uuid ? fromUuid(uuid) : null),
    getSocial: getSocialEffective,
    getWorldTime: worldTimeNow,
    now: () => Date.now(),
    logger: console,
  });
  theftCommerce = createTheftCommerce({
    store,
    runShopExclusive: commerceInstance.runShopExclusive,
    isActiveGM,
    getActor: (id) => (id ? game.actors.get(id) : null),
    actorOwnedBy,
    getAdapter: getLiveAdapter,
    fromUuid: (uuid) => (uuid ? fromUuid(uuid) : null),
    getWorldTime: worldTimeNow,
    now: () => Date.now(),
    logger: console,
  });
  // M6 GM-only portable backup. Shares commerce's per-shop lock runner for
  // interface parity with the other GM services (importing fresh ids never
  // updates an existing shop, so the lock is accepted but not used for writes),
  // uses the same active-GM predicate and the id generator. The service holds
  // the FULL normalized shop records - never a player projection - and is the
  // single GM-private owner of export/import; it is exposed only through the
  // bounded `api.backup` wrappers above.
  backupService = createBackupService({
    store,
    runShopExclusive: commerceInstance.runShopExclusive,
    isActiveGM,
    makeId,
    logger: console,
  });
  exposeApi(commerceInstance, automationService, {
    cart: cartCommerce,
    services: serviceCommerce,
    preorders: preorderCommerce,
    theft: theftCommerce,
    valuations: valuationService,
  }, backupService);
});

Hooks.once('ready', () => {
  attachHandler(commerceInstance, sellingService, {
    cart: cartCommerce,
    services: serviceCommerce,
    preorders: preorderCommerce,
    theft: theftCommerce,
  });
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
  // Startup best-effort ledger folder sweep. Record the active GM id as the
  // baseline for later handover sweeps, then run one sweep now (which no-ops
  // cleanly if this client is not the active GM). Fire-and-forget so it never
  // delays the request handler or storefront wiring; the store re-checks the
  // active GM before the read and before each organize, and a failure is logged,
  // not thrown. The same sweep is re-triggered by `userConnected`/`updateUser`
  // on a GM handover that becomes THIS client. The sweep also backfills the
  // GM-only ledger summary pages, so a startup/handover is the reconciliation
  // point for any journal whose summary was never rendered.
  lastLedgerActiveGMId = game.users?.activeGM?.id ?? null;
  scheduleLedgerFolderSweep();
  registerLedgerUserSweep();
});

// Re-exports for tooling/tests that import this module directly.
export { getAdapter };
export { store };
