// Canvas integration for market shop markers.
//
// A GM can drag a shop element onto the canvas. The drag payload is a
// `text/plain` JSON string `{ "type": "MarketShop", "shopId": "..." }`. On
// `dropCanvasData` only a GM client may create the public marker: a
// JournalEntry (default OBSERVER ownership) plus a Scene Note that points at
// it. The Note carries `flags.market.shopId`; no private store data is copied.
// Clicking the Note fires `activateNote`, which opens the storefront for that
// shop and suppresses the default journal sheet. A stale marker whose shop no
// longer exists still opens a storefront that reports the missing shop.

export const MARKET_SHOP_TYPE = 'MarketShop';
export const MARKET_ICON = 'icons/svg/shop.svg';
export const MARKET_ICON_SIZE = 48;

/**
 * Build the `text/plain` drag payload for a shop element.
 * @param {string} shopId
 * @returns {string} JSON string
 */
export function shopDragData(shopId) {
  return JSON.stringify({ type: MARKET_SHOP_TYPE, shopId: String(shopId ?? '') });
}

/**
 * Parse a drag payload string. Returns null for anything that is not a market
 * shop drag.
 * @param {string} str
 * @returns {{shopId: string}|null}
 */
export function parseShopDrag(str) {
  if (!str) return null;
  let data;
  try {
    data = JSON.parse(str);
  } catch {
    return null;
  }
  if (!data || data.type !== MARKET_SHOP_TYPE) return null;
  if (typeof data.shopId !== 'string' || data.shopId === '') return null;
  return { shopId: data.shopId };
}

/**
 * Extract a market shop id from a parsed drag/drop data object.
 * @param {object} data
 * @returns {string|null}
 */
export function extractShopId(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.type === MARKET_SHOP_TYPE && typeof data.shopId === 'string') {
    return data.shopId;
  }
  return null;
}

/**
 * Resolve the journal create function: prefer the document class static create
 * (Foundry V14 `JournalEntry.create`), then an injected collection-style create
 * (tests), then the live game.journal collection.
 */
function journalCreate(journal, data) {
  const DocumentClass = journal?.documentClass || globalThis.JournalEntry;
  if (DocumentClass && typeof DocumentClass.create === 'function') {
    return DocumentClass.create(data);
  }
  if (journal && typeof journal.create === 'function') {
    return journal.create(data);
  }
  return game.journal.create(data);
}

/**
 * Create a public marker JournalEntry for a market shop. The journal is
 * readable by every player (default OBSERVER) but carries no private store
 * data - only `flags.market = { type: 'MarketShop', shopId }`. If the shop
 * cannot be found, the journal still gets a stable placeholder name.
 *
 * @param {object} opts
 * @param {Function} opts.findShop      async (id) => shop|null
 * @param {string}   opts.shopId
 * @param {Function|object} [opts.journal]  journal collection (game.journal)
 * @returns {Promise<object>} the created journal document
 */
export async function createMarketJournal({ findShop, shopId, journal }) {
  const shop = findShop ? await findShop(shopId) : null;
  const name = shop?.name ? `Market: ${shop.name}` : `Market: ${shopId}`;
  // Default OBSERVER (read) so every player can open the marker; no private
  // store data is carried anywhere - only the market.:shopId flag.
  const observer = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
  return journalCreate(journal, {
    name,
    flags: { market: { type: MARKET_SHOP_TYPE, shopId } },
    ownership: { default: observer },
  });
}

/**
 * Create a public marker (JournalEntry + Scene Note) at (x, y).
 * Returns the created marker journal or null when the entry was skipped.
 *
 * @param {object} opts
 * @param {string}   opts.shopId
 * @param {number}   opts.x
 * @param {number}   opts.y
 * @param {object}   opts.scene        scene document (canvas.scene)
 * @param {Function} [opts.findShop]
 * @param {object}   [opts.journal]
 * @param {Function} [opts.createEmbeddedDocuments] override for tests
 * @returns {Promise<object|null>}
 */
function noopEmbed() {
  return async () => [];
}

export async function createMarketMarker({ shopId, x, y, scene, findShop, journal, createEmbeddedDocuments }) {
  // Verify the shop exists before creating a public marker journal, so a stale
  // / deleted shop does not leak a marker with no backing shop. This is optional:
  // when no findShop resolver is injected (e.g. tests) the journal is still
  // created with a stable placeholder name, as before.
  if (findShop) {
    const shop = await findShop(shopId);
    if (!shop) return null;
  }
  const j = await createMarketJournal({ findShop, shopId, journal });
  let embed;
  if (createEmbeddedDocuments) {
    embed = createEmbeddedDocuments;
  } else if (scene && typeof scene.createEmbeddedDocuments === 'function') {
    embed = scene.createEmbeddedDocuments.bind(scene);
  } else {
    embed = noopEmbed();
  }
  try {
    await embed('Note', [
      {
        x,
        y,
        entryId: j.id,
        texture: { src: MARKET_ICON },
        iconSize: MARKET_ICON_SIZE,
        flags: { market: { shopId } },
      },
    ]);
  } catch (err) {
    // Best effort: a marker journal with no Note is useless, so remove the
    // just-created journal rather than leaving a stray entry behind.
    try {
      if (typeof j?.delete === 'function') await j.delete();
    } catch (_err) {
      // Ignore cleanup failures; the original error is the one to surface.
    }
    throw err;
  }
  return j;
}

/**
 * Resolve drop coordinates from a drop event / data object.
 * @param {object} data     parsed drop data
 * @param {object} options  drop options (dropTarget)
 * @param {object} [canvas]
 * @returns {{x:number,y:number}}
 */
function firstFinite(...candidates) {
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function dropCoordinates(data, options, canvas) {
  const target = options?.dropTarget || {};
  const x = firstFinite(data?.x, target.x, canvas?.center?.x ?? 0);
  const y = firstFinite(data?.y, target.y, canvas?.center?.y ?? 0);
  return { x, y };
}

/**
 * Handle a `dropCanvasData` event on the canvas. Only a GM creates the marker.
 * Non-market drops are ignored (returns null).
 *
 * @param {object}   ctx
 * @param {object}   ctx.data        parsed drop data
 * @param {object}   ctx.options     drop canvas options / dropTarget
 * @param {boolean}  ctx.isGM        whether the current user is a GM
 * @param {object}   [ctx.canvas]    canvas (for center fallback)
 * @param {object}   [ctx.scene]     scene to add the Note to
 * @param {Function} [ctx.findShop]
 * @param {object}   [ctx.journal]
 * @returns {Promise<object|null>} marker journal or null
 */
export async function handleCanvasDrop(ctx) {
  const { data, options, isGM } = ctx;
  const shopId = extractShopId(data);
  if (!shopId) return null;
  if (!isGM) return null;
  const { x, y } = dropCoordinates(data, options, ctx.canvas);
  return createMarketMarker({
    shopId,
    x,
    y,
    scene: ctx.scene,
    findShop: ctx.findShop,
    journal: ctx.journal,
  });
}

/**
 * Handle `activateNote`. If the Note is a market marker, open the storefront
 * and suppress the default journal sheet.
 *
 * @param {object}   note       the Note document (or wrapper)
 * @param {Function} openShop   async (shopId) => void
 * @returns {boolean} false when handled (suppresses the default journal sheet),
 *                    true when not a market note (allow default behavior)
 */
export function handleActivateNote(note, openShop) {
  const shopId = note?.document?.flags?.market?.shopId;
  if (!shopId) return true;
  openShop(shopId);
  return false;
}

/**
 * Attach canvas placement hooks. Returns an unregister callback.
 *
 * @param {object}   deps
 * @param {Function} deps.isGM   (userId) => boolean
 * @param {Function} deps.openShop async (shopId) => void
 * @param {Function} [deps.findShop]
 * @param {object}   [deps.journal]
 * @param {object}   [deps.scene]  optional fixed scene
 * @returns {Function}
 */
export function registerPlacements(deps) {
  const onDrop = (canvas, data, options) =>
    handleCanvasDrop({
      data,
      options,
      canvas,
      scene: deps.scene || canvas?.scene,
      isGM: deps.isGM(game.user.id),
      findShop: deps.findShop,
      journal: deps.journal,
    });
  const onActivate = (note /* , options */) =>
    handleActivateNote(note, deps.openShop);
  Hooks.on('dropCanvasData', onDrop);
  Hooks.on('activateNote', onActivate);
  return () => {
    Hooks.off('dropCanvasData', onDrop);
    Hooks.off('activateNote', onActivate);
  };
}

export default registerPlacements;
