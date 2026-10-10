// Unit tests for the M1 UI wiring and the model/request correlation fixes.
//
// The UI modules reference `foundry.applications.api` at class-definition time,
// so a minimal mock is installed before they are imported. No live Foundry
// runtime is required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseItemData,
  normalizeInventoryEntry,
} from '../src/services/model.js';
import {
  handleMarketChatMessage,
  responseMessageData,
} from '../src/core/requests.js';
import { createLockMap } from '../src/services/commerce.js';

// ---- Foundry global stubs (installed before importing the UI modules) --------

class ApplicationV2 {
  static DEFAULT_OPTIONS = {};
  constructor(options = {}) {
    this.options = { ...this.constructor.DEFAULT_OPTIONS, ...options };
    this._element = null;
  }
  get element() {
    return this._element;
  }
  set element(value) {
    this._element = value;
  }
  async render({ force = false } = {}) {
    if (this._onRender) await this._onRender();
    return this;
  }
  async close() {
    if (this._onClose) await this._onClose();
  }
}

const HandlebarsApplicationMixin = (Base) =>
  class extends Base {
    static DEFAULT_OPTIONS = { ...(Base.DEFAULT_OPTIONS || {}) };
  };

globalThis.foundry = {
  applications: {
    api: { ApplicationV2, HandlebarsApplicationMixin },
  },
};
const _hookRegistry = {};
globalThis.Hooks = {
  on(event, fn) {
    (_hookRegistry[event] ||= []).push(fn);
  },
  off() {},
  once(event, fn) {
    (_hookRegistry[event] ||= []).push({ once: true, fn });
  },
};
function fireHook(event) {
  for (const entry of _hookRegistry[event] || []) {
    if (typeof entry === 'function') entry();
    else entry.fn();
  }
}
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3, OBSERVER: 2 } };
globalThis.game = {
  user: { id: 'u1', isGM: false },
  users: {
    activeGM: { id: 'gm1' },
    get: (id) => (id === 'gm1' ? { id: 'gm1', isGM: true } : { id, isGM: false }),
  },
  system: { id: 'dnd5e' },
  actors: [],
};

const { MarketManager } = await import('../src/ui/manager.js');
const {
  MarketStorefront,
  newRequestId,
  isMarketResponseFromGM,
} = await import('../src/ui/storefront.js');
const placements = await import('../src/canvas/placements.js');

// ---- helpers ----------------------------------------------------------------

function makePurchaseMessage(request) {
  return {
    flags: {
      market: {
        type: 'request',
        request: { type: 'purchase', ...request },
      },
    },
  };
}

function makeCatalogMessage(request) {
  return {
    flags: {
      market: {
        type: 'request',
        request: { type: 'catalog', ...request },
      },
    },
  };
}

function makeCtx(overrides = {}) {
  return {
    activeGMId: () => 'gm1',
    currentUserId: () => 'gm1',
    gmIds: () => ['gm1'],
    respond: async () => {},
    ...overrides,
  };
}

// ---- model: itemUuid-optional snapshot validation --------------------------

test('parseItemData accepts real item JSON and rejects summaries/scalars', () => {
  const ok = parseItemData(JSON.stringify({ name: 'Potion', type: 'consumable' }));
  assert.deepEqual(ok, { name: 'Potion', type: 'consumable' });
  assert.equal(parseItemData('A small red potion'), null, 'plain string is not item data');
  assert.equal(parseItemData(''), null);
  assert.equal(parseItemData('[1,2]'), null, 'array is not item data');
  assert.equal(parseItemData('"hi"'), null, 'JSON scalar is not item data');
  assert.equal(parseItemData(JSON.stringify({ name: '   ' })), null, 'blank name rejected');
});

test('normalizeInventoryEntry allows an empty itemUuid when a valid snapshot exists', () => {
  const entry = normalizeInventoryEntry({
    name: 'Potion',
    snapshot: JSON.stringify({ name: 'Potion', type: 'consumable' }),
    price: 10,
    quantity: 2,
    itemUuid: '',
  });
  assert.equal(entry.itemUuid, '');
  assert.equal(entry.name, 'Potion');
});

test('normalizeInventoryEntry rejects an empty itemUuid without a valid snapshot', () => {
  assert.throws(
    () =>
      normalizeInventoryEntry({ name: 'Potion', itemUuid: '', snapshot: 'plain text' }),
    /itemUuid/
  );
  assert.throws(
    () => normalizeInventoryEntry({ name: 'Potion', itemUuid: '', snapshot: '' }),
    /itemUuid/
  );
});

test('normalizeInventoryEntry still requires a non-empty name', () => {
  assert.throws(() => normalizeInventoryEntry({ itemUuid: 'Compendium.a.Item.x' }), /name/);
});

// ---- requests: requestId/shopId correlation echo ---------------------------

test('catalog response echoes requestId and shopId', async () => {
  const responses = [];
  const ctx = makeCtx({
    store: {
      findShop: async (id) => ({
        id,
        name: 'S',
        open: true,
        inventory: [
          { id: 'e1', visible: true, name: 'P', img: '', price: 10, quantity: 5, stockMode: 'finite' },
        ],
      }),
    },
    respond: async (data) => responses.push(data.flags.market.response),
  });
  const message = makeCatalogMessage({ shopId: 'shop1', requestId: 'cat-req-1' });
  const data = await handleMarketChatMessage(message, 'user1', ctx);
  assert.equal(data.requestId, 'cat-req-1');
  assert.equal(data.shopId, 'shop1');
  assert.equal(data.type, 'catalog');
  assert.equal(data.inventory.length, 1);
});

test('catalog error response still echoes the correlation fields', async () => {
  const ctx = makeCtx({
    store: { findShop: async () => null },
    respond: async () => {},
  });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'missing', requestId: 'cat-req-2' }),
    'user1',
    ctx
  );
  assert.equal(data.error, 'shop-not-found');
  assert.equal(data.requestId, 'cat-req-2');
  assert.equal(data.shopId, 'missing');
});

test('purchase response echoes requestId/shopId and keeps the result sanitized', async () => {
  const commerce = {
    purchase: async () => ({
      status: 'committed',
      ledgerId: 'L1',
      record: { id: 'L1', key: 'k', totalPrice: 200, quantity: 2 },
      outcome: { foo: 'bar' },
    }),
  };
  const ctx = makeCtx({
    commerce,
    respond: async () => {},
  });
  const data = await handleMarketChatMessage(
    makePurchaseMessage({
      shopId: 'shop1',
      entryId: 'e1',
      actorId: 'a1',
      quantity: 2,
      requestId: 'buy-req-1',
    }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'purchase');
  assert.equal(data.requestId, 'buy-req-1');
  assert.equal(data.shopId, 'shop1');
  assert.equal(data.result.status, 'committed');
  assert.equal(data.result.ledgerId, 'L1');
  assert.equal(data.result.total, 200);
  assert.ok(!('record' in data.result), 'raw record still hidden');
  assert.ok(!('outcome' in data.result), 'raw outcome still hidden');
});

test('responseMessageData embeds the correlated response for a UI to read', () => {
  const data = responseMessageData({
    whisper: ['gm1'],
    data: { type: 'catalog', requestId: 'r1', shopId: 's1', shop: { id: 's1' }, inventory: [] },
  });
  assert.equal(data.flags.market.type, 'response');
  assert.equal(data.flags.market.response.requestId, 'r1');
  assert.equal(data.flags.market.response.shopId, 's1');
});

// ---- storefront: GM verification + request correlation ----------------------

test('newRequestId is unique and prefixed', () => {
  const a = newRequestId('catalog');
  const b = newRequestId('catalog');
  assert.match(a, /^catalog-/);
  assert.notEqual(a, b);
});

test('isMarketResponseFromGM verifies flag type and GM author', () => {
  const isGM = (id) => id === 'gm1';
  const responseMsg = { flags: { market: { type: 'response', response: { requestId: 'r' } } } };
  assert.equal(isMarketResponseFromGM(responseMsg, 'gm1', isGM), true);
  assert.equal(isMarketResponseFromGM(responseMsg, 'u1', isGM), false, 'non-GM author ignored');
  const requestMsg = { flags: { market: { type: 'request' } } };
  assert.equal(isMarketResponseFromGM(requestMsg, 'gm1', isGM), false);
  const plain = { flags: {} };
  assert.equal(isMarketResponseFromGM(plain, 'gm1', isGM), false);
});

test('storefront correlates a catalog response by requestId and renders shop', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app._loaded = true;
  const inventory = [{ id: 'e1', name: 'Potion', price: 10, quantity: 5, stockMode: 'finite', img: '' }];
  app._onCatalogResponse({
    type: 'catalog',
    requestId: 'cat',
    shopId: 'shop1',
    shop: { id: 'shop1', name: 'S', open: true },
    inventory,
  });
  assert.equal(app._data.shop.name, 'S');
  assert.equal(app._data.inventory.length, 1);
  assert.equal(app._pendingCatalogRequestId, null);
  assert.equal(app._data.loading, false);
});

test('storefront surfaces a shop-not-found catalog error without private data', () => {
  const app = new MarketStorefront({ shopId: 'gone', deps: {} });
  app._loaded = true;
  app._onCatalogResponse({ type: 'error', requestId: 'cat', shopId: 'gone', error: 'shop-not-found' });
  assert.equal(app._data.shop, null);
  assert.equal(app._data.inventory.length, 0);
  assert.equal(app._data.error, 'shop-not-found');
  assert.equal(app._data.notice.includes('shop not found'), true);
});

test('storefront auto-refreshes the catalog after a committed purchase', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app._loaded = true;
  let refreshed = false;
  app._requestRefresh = () => {
    refreshed = true;
    return Promise.resolve();
  };
  app._data.pending = true;
  app._onPurchaseResponse({
    type: 'purchase',
    requestId: 'buy',
    shopId: 'shop1',
    result: { status: 'committed' },
  });
  assert.equal(app._data.pending, false);
  assert.equal(app._data.feedback, 'Purchase complete.');
  assert.equal(refreshed, true, 'catalog refresh triggered without reopening');
});

test('storefront disables purchase flow and shows error feedback on failure', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app._loaded = true;
  app._data.pending = true;
  app._onPurchaseResponse({
    type: 'purchase',
    result: { status: 'failed', error: 'insufficient-funds' },
  });
  assert.equal(app._data.pending, false);
  assert.equal(app._data.feedback.includes('Not enough gold'), true);
});

test('storefront offers only owned actors and never reads the private store', () => {
  const owned = [
    { id: 'a1', name: 'Tank', testUserPermission: () => true },
    { id: 'a2', name: 'Other', testUserPermission: () => false },
  ];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: { ownedActors: () => owned.filter((a) => a.testUserPermission({ id: 'u1' }, 3)) },
  });
  const actors = app._ownedActors();
  assert.equal(actors.length, 1);
  assert.equal(actors[0].id, 'a1');
});

// ---- manager: data refresh & item add ---------------------------------------

function makeStore({ locations = [], shops = [] } = {}) {
  const added = [];
  return {
    _added: added,
    listLocations: async () => locations,
    listShops: async ({ locationId } = {}) =>
      locationId ? shops.filter((s) => s.locationId === locationId) : shops,
    createLocation: async (data) => ({ id: `loc-${data.name}`, ...data }),
    createShop: async (data) => ({ id: `shop-${data.name}`, ...data, inventory: [] }),
    updateShop: async (id, patch) => ({ id, ...patch }),
    findShop: async (id) => shops.find((s) => s.id === id) || null,
    addInventoryEntry: async (shopId, entryData) => {
      const entry = { id: 'new-entry', ...entryData };
      added.push({ shopId, entryData });
      return entry;
    },
  };
}

test('manager populates default location/shop and inventoryCount from the store', async () => {
  const store = makeStore({
    locations: [{ id: 'loc1', name: 'Town' }],
    shops: [
      { id: 'shop1', name: 'Store', locationId: 'loc1', open: true, inventory: [{ id: 'e1' }] },
    ],
  });
  const app = new MarketManager({
    deps: { store, systemId: () => 'dnd5e', isGM: () => true },
  });
  await app._refreshData();
  assert.equal(app._data.selectedLocationId, 'loc1');
  assert.equal(app._data.selectedShopId, 'shop1');
  assert.equal(app._data.selectedShop.name, 'Store');
  assert.equal(app._data.shops[0].inventoryCount, 1);
});

test('manager adds an item using the adapter price and snapshot', async () => {
  const store = makeStore();
  const source = {
    name: 'Potion',
    img: 'icons/p.png',
    toObject: () => ({ _id: 'i1', name: 'Potion', system: { price: { value: 2, denomination: 'gp' } } }),
  };
  const adapter = {
    supported: true,
    getItemPrice: async () => ({ amount: 2, denomination: 'gp', minorUnits: 200 }),
  };
  const app = new MarketManager({
    deps: {
      store,
      systemId: () => 'dnd5e',
      getAdapter: () => adapter,
      fromUuid: async () => source,
    },
  });
  app._data.selectedShopId = 'shop1';
  await app._addItemByUuid('Compendium.a.Item.potion');
  assert.equal(store._added.length, 1);
  const { shopId, entryData } = store._added[0];
  assert.equal(shopId, 'shop1');
  assert.equal(entryData.itemUuid, 'Compendium.a.Item.potion');
  assert.equal(entryData.price, 200);
  assert.equal(entryData.name, 'Potion');
  assert.equal(JSON.parse(entryData.snapshot).name, 'Potion');
});

// ---- canvas placements -------------------------------------------------------

test('shopDragData serializes the MarketShop contract', () => {
  const str = placements.shopDragData('shop1');
  assert.deepEqual(JSON.parse(str), { type: 'MarketShop', shopId: 'shop1' });
  assert.equal(placements.parseShopDrag(str).shopId, 'shop1');
  assert.equal(placements.parseShopDrag('not json'), null);
  assert.equal(placements.extractShopId({ type: 'MarketShop', shopId: 'x' }), 'x');
  assert.equal(placements.extractShopId({ type: 'Item', uuid: 'u' }), null);
});

test('createMarketMarker creates a public journal (OBSERVER) and a note with market flags', async () => {
  const createdJournals = [];
  const createdNotes = [];
  const journal = {
    create: async (data) => {
      const doc = { id: 'j-' + createdJournals.length, ...data };
      createdJournals.push(doc);
      return doc;
    },
  };
  const scene = { id: 'scene1' };
  const marker = await placements.createMarketMarker({
    shopId: 'shop1',
    x: 100,
    y: 200,
    scene,
    journal,
    createEmbeddedDocuments: async (_name, notes) => {
      createdNotes.push(...notes);
      return notes;
    },
  });
  assert.equal(marker.id, 'j-0');
  assert.equal(createdJournals[0].ownership.default, 2, 'default OBSERVER');
  assert.deepEqual(createdJournals[0].flags.market, { type: 'MarketShop', shopId: 'shop1' });
  assert.equal(createdNotes.length, 1);
  assert.equal(createdNotes[0].entryId, 'j-0');
  assert.equal(createdNotes[0].iconSize, 48);
  assert.deepEqual(createdNotes[0].flags.market, { shopId: 'shop1' });
  assert.ok(!('inventory' in createdNotes[0].flags.market), 'no private store data on the note');
});

test('handleActivateNote opens the storefront and suppresses the journal', () => {
  let opened = null;
  const note = { document: { flags: { market: { shopId: 'shop1' } } } };
  const handled = placements.handleActivateNote(note, (id) => {
    opened = id;
  });
  assert.equal(handled, false, 'returns false to suppress the default journal sheet');
  assert.equal(opened, 'shop1');
  // A non-market note is not suppressed.
  const plain = { document: { flags: {} } };
  assert.equal(placements.handleActivateNote(plain, () => {}), true);
});

test('handleCanvasDrop is GM-gated and rejects non-market drops', async () => {
  // non-market drop returns null
  const out = await placements.handleCanvasDrop({
    data: { type: 'Item', uuid: 'u' },
    options: {},
    isGM: true,
  });
  assert.equal(out, null);
  // non-GM, market drop => null (no marker)
  const out2 = await placements.handleCanvasDrop({
    data: { type: 'MarketShop', shopId: 'shop1' },
    options: {},
    isGM: false,
  });
  assert.equal(out2, null);
  // GM + market drop => marker created
  const createdJournals = [];
  const journal = {
    create: async (data) => {
      const doc = { id: 'j-' + createdJournals.length, ...data };
      createdJournals.push(doc);
      return doc;
    },
  };
  const scene = { id: 'scene1' };
  const out3 = await placements.handleCanvasDrop({
    data: { type: 'MarketShop', shopId: 'shop1', x: 5, y: 6 },
    options: {},
    isGM: true,
    scene,
    journal,
  });
  assert.ok(out3, 'GM drop creates marker');
  assert.equal(out3.id, 'j-0');
  assert.equal(createdJournals[0].flags.market.shopId, 'shop1');
});

test('createMarketMarker verifies the shop exists before creating a journal', async () => {
  let created = false;
  const journal = {
    create: async (data) => {
      created = true;
      return { id: 'j0', ...data };
    },
  };
  const scene = { id: 'scene1' };
  const result = await placements.createMarketMarker({
    shopId: 'missing',
    x: 1,
    y: 2,
    scene,
    journal,
    findShop: async () => null,
    createEmbeddedDocuments: async () => [],
  });
  assert.equal(result, null, 'missing shop returns no marker');
  assert.equal(created, false, 'no marker journal created for a missing shop');
});

test('createMarketMarker removes the marker journal when Note creation fails', async () => {
  let deleted = false;
  const journal = {
    create: async (data) => ({
      id: 'j0',
      ...data,
      delete: async () => {
        deleted = true;
      },
    }),
  };
  const scene = { id: 'scene1' };
  await assert.rejects(
    placements.createMarketMarker({
      shopId: 'shop1',
      x: 1,
      y: 2,
      scene,
      journal,
      findShop: async () => ({ id: 'shop1', name: 'S' }),
      createEmbeddedDocuments: async () => {
        throw new Error('note failed');
      },
    }),
    /note failed/
  );
  assert.equal(deleted, true, 'marker journal best-effort deleted on Note failure');
});

// ---- ApplicationV2 action handlers are callable static wrappers -------------

test('application action maps are callable static wrappers bound to the instance', async () => {
  // Manager: every action must be a callable function, and calling one with the
  // app as `this` must delegate to the matching instance `_on...` method.
  const managerHandler = MarketManager.DEFAULT_OPTIONS.actions['create-location'];
  assert.equal(typeof managerHandler, 'function', 'manager action must be callable');
  const app = new MarketManager({ deps: {} });
  let called = false;
  app._onCreateLocation = () => {
    called = true;
  };
  await managerHandler.call(app, {}, {}, {});
  assert.equal(called, true, 'manager wrapper delegates to the instance _onCreateLocation');

  const buyHandler = MarketStorefront.DEFAULT_OPTIONS.actions['buy'];
  assert.equal(typeof buyHandler, 'function', 'storefront action must be callable');
  const sf = new MarketStorefront({ shopId: 's1', deps: {} });
  let buyCalled = false;
  sf._onBuy = () => {
    buyCalled = true;
  };
  await buyHandler.call(sf, {}, {}, {});
  assert.equal(buyCalled, true, 'storefront wrapper delegates to the instance _onBuy');

  // No configured action key may reference an undefined value.
  for (const key of Object.keys(MarketManager.DEFAULT_OPTIONS.actions)) {
    assert.equal(
      typeof MarketManager.DEFAULT_OPTIONS.actions[key],
      'function',
      `manager action '${key}' must be callable`
    );
  }
  for (const key of Object.keys(MarketStorefront.DEFAULT_OPTIONS.actions)) {
    assert.equal(
      typeof MarketStorefront.DEFAULT_OPTIONS.actions[key],
      'function',
      `storefront action '${key}' must be callable`
    );
  }
});

// ---- concurrent manager stock editing under the shared shop lock ------------

function makePersistentShopStore(shops) {
  const map = new Map();
  for (const s of shops) map.set(s.id, structuredClone(s));
  return {
    _shops: map,
    listLocations: async () => [],
    listShops: async () => Array.from(map.values()),
    findShop: async (id) => {
      const s = map.get(id);
      return s ? structuredClone(s) : null;
    },
    updateShop: async (id, patch) => {
      const s = map.get(id);
      if (!s) return null;
      const next = { ...s, ...patch };
      map.set(id, next);
      return next;
    },
  };
}

function fakeTr(entryId, values = {}) {
  const fields = {
    '[name="price"]': { type: 'number', value: String(values.price ?? 100) },
    '[name="quantity"]': { type: 'number', value: String(values.quantity ?? 1) },
    '[name="stockMode"]': { value: values.stockMode ?? 'finite' },
    '[name="visible"]': { type: 'checkbox', checked: values.visible !== false },
    '[name="publicDescription"]': { value: values.publicDescription ?? 'A helpful find' },
    '[name="category"]': { value: values.category ?? 'Consumable' },
    '[name="rarity"]': { value: values.rarity ?? 'Common' },
  };
  const tr = {
    dataset: { entryId },
    querySelector: (sel) => fields[sel] || null,
  };
  return { closest: () => tr, dataset: tr.dataset };
}

// A fake shop details form (+ appearance) element. The manager reads these via
// `querySelector('[name="..."]')`; only the named fields a test needs are wired.
function fakeShopForm(values = {}) {
  const textNames = [
    'name',
    'owner',
    'theme',
    'description',
    'ownerPortrait',
    'backgroundImage',
    'accentColor',
    'typography',
    'density',
    'animation',
    'music',
    'soundEffect',
    'welcomeMessage',
  ];
  const fields = {};
  for (const name of textNames) {
    fields[`[name="${name}"]`] = { type: 'text', value: String(values[name] ?? '') };
  }
  fields['[name="open"]'] = { type: 'checkbox', checked: values.open !== false };
  return {
    querySelector: (sel) => fields[sel] || null,
  };
}

test('manager concurrent stock editing does not lose updates under the shared lock', async () => {
  const lockMap = createLockMap();
  const runShopExclusive = (shopId, fn) => lockMap.run('shop:' + shopId, fn);
  const store = makePersistentShopStore([
    {
      id: 'shop1',
      name: 'S',
      locationId: 'loc1',
      open: true,
      inventory: [
        { id: 'e1', name: 'A', price: 10, quantity: 10, stockMode: 'finite' },
        { id: 'e2', name: 'B', price: 20, quantity: 20, stockMode: 'finite' },
      ],
    },
  ]);
  const app = new MarketManager({ deps: { store, runShopExclusive, systemId: () => 'dnd5e' } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await Promise.all([
    app._onSaveEntry({}, fakeTr('e1', { price: 11, quantity: 12 }), {}),
    app._onSaveEntry({}, fakeTr('e2', { price: 22, quantity: 23 }), {}),
  ]);
  const shop = store._shops.get('shop1');
  const e1 = shop.inventory.find((e) => e.id === 'e1');
  const e2 = shop.inventory.find((e) => e.id === 'e2');
  assert.equal(e1.price, 11, 'entry1 price saved');
  assert.equal(e1.quantity, 12, 'entry1 quantity saved');
  assert.equal(e2.price, 22, 'entry2 price saved');
  assert.equal(e2.quantity, 23, 'entry2 quantity saved');
});

// ---- M1 hardening: non-GM manager guard + request failure handling -----------

test('manager fails closed for a non-GM user without touching the store', async () => {
  const store = makeStore({
    locations: [{ id: 'loc1', name: 'Town' }],
    shops: [{ id: 'shop1', name: 'Store', locationId: 'loc1', open: true, inventory: [] }],
  });
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e' } });
  assert.equal(app._isGM(), false, 'default test user is not a GM');
  await app._refreshData();
  assert.equal(app._data.locations.length, 0, 'no locations loaded for non-GM');
  assert.equal(app._data.shops.length, 0, 'no shops loaded for non-GM');
  assert.equal(app._data.selectedShop, null);
  assert.equal(app._data.notice, 'Only the Game Master can manage the market.');
  // With an explicit GM dependency the guard passes and data loads.
  const app2 = new MarketManager({
    deps: { store, systemId: () => 'dnd5e', isGM: () => true },
  });
  assert.equal(app2._isGM(), true);
  await app2._refreshData();
  assert.equal(app2._data.locations.length, 1);
  assert.equal(app2._data.selectedLocationId, 'loc1');
});

test('handleMarketChatMessage answers a sanitized server-error when purchase throws', async () => {
  const responses = [];
  const commerce = {
    purchase: async () => {
      throw new Error('boom at 0xABC');
    },
  };
  const ctx = makeCtx({
    commerce,
    respond: async (data) => responses.push(data.flags.market.response),
  });
  const data = await handleMarketChatMessage(
    makePurchaseMessage({
      shopId: 'shop1',
      entryId: 'e1',
      actorId: 'a1',
      quantity: 1,
      requestId: 'buy-req-err',
    }),
    'user1',
    ctx
  );
  assert.ok(responses.length, 'a response was whispered');
  assert.equal(data.type, 'purchase');
  assert.equal(data.requestId, 'buy-req-err');
  assert.equal(data.shopId, 'shop1');
  assert.equal(data.result.status, 'error');
  assert.equal(data.result.error, 'server-error');
  assert.equal(
    /boom at 0xABC/.test(JSON.stringify(responses[0])),
    false,
    'no exception stack leaks into the whisper'
  );
});

test('handleMarketChatMessage answers a sanitized error when the catalog store throws', async () => {
  const responses = [];
  const ctx = makeCtx({
    store: {
      findShop: async () => {
        throw new Error('store exploded');
      },
    },
    respond: async (data) => responses.push(data.flags.market.response),
  });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', requestId: 'cat-err' }),
    'user1',
    ctx
  );
  assert.ok(responses.length, 'a response was whispered');
  assert.equal(data.type, 'error');
  assert.equal(data.error, 'server-error');
  assert.equal(data.requestId, 'cat-err');
  assert.equal(data.shopId, 'shop1');
  assert.equal(
    /store exploded/.test(JSON.stringify(responses[0])),
    false,
    'no exception stack leaks into the whisper'
  );
});

test('storefront clears loading with an error when the catalog send fails', async () => {
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      hasActiveGM: () => true,
      request: async () => {
        throw new Error('ChatMessage.create failed');
      },
    },
  });
  app.render = async () => {};
  await app._requestCatalog();
  assert.equal(app._data.loading, false, 'loading cleared');
  assert.equal(app._data.error, 'send-failed');
  assert.equal(app._pendingCatalogRequestId, null);
  assert.equal(app._data.notice.includes('could not be sent'), true);
});

test('storefront clears loading with an error when the refresh send fails', async () => {
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      hasActiveGM: () => true,
      request: async () => {
        throw new Error('refresh send failed');
      },
    },
  });
  app.render = async () => {};
  await app._requestRefresh();
  assert.equal(app._data.loading, false);
  assert.equal(app._data.error, 'send-failed');
  assert.equal(app._pendingCatalogRequestId, null);
});

test('storefront rejects an invalid quantity without silently flooring', async () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app._data.selectedActorId = 'a1';
  let sent = null;
  app._request = (payload) => {
    sent = payload;
    return Promise.resolve(null);
  };
  app.render = async () => {};
  // Fractional and zero quantities are invalid, not floored/replaced.
  app.element = { querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '2.5' } : null) };
  app._requestPurchase('e1');
  await Promise.resolve();
  assert.equal(sent, null, 'invalid quantity does not send');
  assert.equal(app._data.feedback, 'Quantity must be a positive whole number.');

  app.element = { querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '0' } : null) };
  app._requestPurchase('e1');
  await Promise.resolve();
  assert.equal(sent, null, 'zero quantity does not send');
});

test('storefront sends a validated positive safe integer quantity', async () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: { hasActiveGM: () => true } });
  app._data.selectedActorId = 'a1';
  let sent = null;
  app._readQuantity = () => 3;
  app._request = (payload) => {
    sent = payload;
    return Promise.resolve(null);
  };
  app.render = async () => {};
  app._requestPurchase('e1');
  await Promise.resolve();
  assert.ok(sent, 'valid quantity sends a purchase request');
  assert.equal(sent.quantity, 3);
  assert.equal(sent.entryId, 'e1');
  assert.equal(app._data.pending, true);
});

test('_readQuantity validates a positive safe integer and defaults only when absent', () => {
  const app = new MarketStorefront({ shopId: 's1', deps: {} });
  app.element = { querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '2.5' } : null) };
  assert.equal(app._readQuantity(), null, 'fractional is invalid');
  app.element = { querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '0' } : null) };
  assert.equal(app._readQuantity(), null, 'zero is invalid');
  app.element = { querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '-4' } : null) };
  assert.equal(app._readQuantity(), null, 'negative is invalid');
  app.element = { querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '7' } : null) };
  assert.equal(app._readQuantity(), 7, 'positive safe integer accepted');
  app.element = { querySelector: () => null };
  assert.equal(app._readQuantity(), 1, 'missing field defaults to 1');
});

// ---- M2: manager theme/appearance editing + preview + media browse -------------

test('manager reads a normalized theme and appearance from the shop form', () => {
  const app = new MarketManager({ deps: { systemId: () => 'dnd5e', isGM: () => true } });
  app.element = fakeShopForm({
    theme: 'necromancer',
    accentColor: '#aBcDeF',
    typography: 'display',
    density: 'compact',
    animation: 'subtle',
    backgroundImage: 'modules/forge/img/bg.png',
    ownerPortrait: 'icons/portrait.png',
    music: 'modules/forge/sfx/ambient.ogg',
    soundEffect: 'systems/dnd/sfx/bell.ogg',
    welcomeMessage: 'Welcome!',
  });
  const form = app._readShopForm();
  assert.equal(form.theme, 'necromancer');
  assert.equal(form.appearance.accentColor, '#aBcDeF');
  assert.equal(form.appearance.typography, 'display');
  assert.equal(form.appearance.density, 'compact');
  assert.equal(form.appearance.animation, 'subtle');
  assert.equal(form.appearance.backgroundImage, 'modules/forge/img/bg.png');
  assert.equal(form.appearance.ownerPortrait, 'icons/portrait.png');
  assert.equal(form.appearance.music, 'modules/forge/sfx/ambient.ogg');
  assert.equal(form.appearance.soundEffect, 'systems/dnd/sfx/bell.ogg');
  assert.equal(form.appearance.welcomeMessage, 'Welcome!');
  // An unknown theme still normalizes to a known id.
  app.element = fakeShopForm({ theme: 'pixie-market' });
  assert.equal(app._readShopForm().theme, 'general-store');
});

test('manager saves a normalized theme and appearance under the shop lock', async () => {
  const store = makeStore({
    locations: [{ id: 'loc1', name: 'Town' }],
    shops: [{ id: 'shop1', name: 'Store', locationId: 'loc1', open: true, inventory: [] }],
  });
  const patches = [];
  store.updateShop = async (id, patch) => {
    patches.push({ id, patch });
    return { id, ...patch };
  };
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  await app._refreshData();
  app.element = fakeShopForm({
    name: 'New Store',
    theme: 'necromancer',
    accentColor: '#A1B2C3',
    typography: 'display',
    density: 'compact',
    animation: 'subtle',
    backgroundImage: 'modules/forge/img/bg.png',
    music: 'modules/forge/sfx/ambient.ogg',
    soundEffect: 'systems/dnd/sfx/bell.ogg',
    welcomeMessage: 'Welcome!',
  });
  app.render = async () => {};
  await app._onSaveShop({}, {}, {});
  assert.equal(patches.length, 1, 'one metadata patch written');
  const patch = patches[0].patch;
  assert.equal(patch.theme, 'necromancer');
  assert.equal(patch.appearance.accentColor, '#A1B2C3');
  assert.equal(patch.appearance.typography, 'display');
  assert.equal(patch.appearance.density, 'compact');
  assert.equal(patch.appearance.animation, 'subtle');
  assert.equal(patch.appearance.backgroundImage, 'modules/forge/img/bg.png');
  assert.equal(patch.appearance.music, 'modules/forge/sfx/ambient.ogg');
  assert.equal(patch.appearance.soundEffect, 'systems/dnd/sfx/bell.ogg');
  assert.equal(patch.appearance.welcomeMessage, 'Welcome!');
});

test('manager rejects an invalid media path on save without writing to the store', async () => {
  const store = makeStore({
    locations: [{ id: 'loc1', name: 'Town' }],
    shops: [{ id: 'shop1', name: 'Store', locationId: 'loc1', open: true, inventory: [] }],
  });
  let writes = 0;
  store.updateShop = async (id, patch) => {
    writes++;
    return { id, ...patch };
  };
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  await app._refreshData();
  app.element = fakeShopForm({ backgroundImage: 'https://cdn.example.com/x.png' });
  app.render = async () => {};
  await app._onSaveShop({}, {}, {});
  assert.equal(writes, 0, 'no store write on an invalid media path');
  assert.ok(
    app._data.notice.includes('media path') || app._data.notice.includes('local media'),
    'validation error surfaced in the notice'
  );
});

test('manager appearance preview reflects unsaved form values and never persists', async () => {
  const store = makeStore({
    locations: [{ id: 'loc1', name: 'Town' }],
    shops: [{ id: 'shop1', name: 'Store', locationId: 'loc1', open: true, inventory: [] }],
  });
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  await app._refreshData();
  // The persisted shop has a different theme/accent; the form holds unsaved edits.
  app._data.selectedShop = { ...app._data.selectedShop, theme: 'general-store' };
  app.element = fakeShopForm({ name: 'Preview Name', theme: 'pastry', accentColor: '#FFAA00' });
  app.render = async () => {};
  await app._onPreviewAppearance({}, {}, {});
  assert.ok(app._data.previewShop, 'preview built');
  assert.equal(app._data.previewShop.name, 'Preview Name', 'uses the unsaved form name');
  assert.equal(app._data.previewShop.theme, 'pastry', 'uses the unsaved form theme');
  assert.equal(app._data.previewShop.appearance.accentColor, '#FFAA00', 'uses unsaved accent');
  assert.notEqual(app._data.previewShop.theme, 'general-store', 'not a stale persisted shop');
  // reset-preview clears it.
  await app._onResetPreview({}, {}, {});
  assert.equal(app._data.previewShop, null);
});

test('manager preview is cleared on location/shop switch', async () => {
  const store = makeStore({
    locations: [{ id: 'loc1', name: 'Town' }, { id: 'loc2', name: 'Harbor' }],
    shops: [
      { id: 'shop1', name: 'Store', locationId: 'loc1', open: true, inventory: [] },
      { id: 'shop2', name: 'Market', locationId: 'loc2', open: true, inventory: [] },
    ],
  });
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  await app._refreshData();
  app._data.previewShop = { id: 'shop1', theme: 'pastry' };
  // Switching location clears the preview.
  await app._onSelectLocation({}, { dataset: { locationId: 'loc2' } }, {});
  assert.equal(app._data.previewShop, null, 'cleared on location switch');
  assert.equal(app._data.selectedShopId, 'shop2', 'selected shop followed the location');
});

test('manager browse-media uses the audio picker for music and validates the path', async () => {
  const app = new MarketManager({ deps: { systemId: () => 'dnd5e', isGM: () => true } });
  const types = [];
  app._deps.browseMedia = async (type, setValue) => {
    types.push(type);
    setValue('modules/forge/sfx/ambient.ogg');
    return 'modules/forge/sfx/ambient.ogg';
  };
  app.element = fakeShopForm();
  await app._onBrowseMedia({}, { dataset: { mediaTarget: 'music' } }, {});
  assert.deepEqual(types, ['audio'], 'music uses the audio picker');
  const input = app.element.querySelector('[name="music"]');
  assert.equal(input.value, 'modules/forge/sfx/ambient.ogg');
  assert.equal(app._data.notice, '');
});

test('manager browse-media shows a notice for an invalid chosen path', async () => {
  const app = new MarketManager({ deps: { systemId: () => 'dnd5e', isGM: () => true } });
  app._deps.browseMedia = async (type, setValue) => {
    setValue('https://cdn.example.com/a.png');
    return 'https://cdn.example.com/a.png';
  };
  app.element = fakeShopForm();
  await app._onBrowseMedia({}, { dataset: { mediaTarget: 'backgroundImage' } }, {});
  const input = app.element.querySelector('[name="backgroundImage"]');
  assert.equal(input.value, '', 'invalid path not written to the input');
  assert.ok(app._data.notice.includes('valid local asset path'), 'readable notice shown');
});

test('manager invalid picker selection leaves a previous valid path untouched', async () => {
  const app = new MarketManager({ deps: { systemId: () => 'dnd5e', isGM: () => true } });
  app._deps.browseMedia = async (type, setValue) => {
    setValue('https://cdn.example.com/x.png');
    return 'https://cdn.example.com/x.png';
  };
  // The input already holds a valid path; an invalid picker path must not erase it.
  app.element = fakeShopForm({ backgroundImage: 'modules/forge/img/bg.png' });
  await app._onBrowseMedia({}, { dataset: { mediaTarget: 'backgroundImage' } }, {});
  const input = app.element.querySelector('[name="backgroundImage"]');
  assert.equal(input.value, 'modules/forge/img/bg.png', 'previous valid path preserved');
  assert.ok(app._data.notice.includes('valid local asset path'), 'readable notice shown');
});

test('manager valid picker selection preserves media across an inventory action and save', async () => {
  const store = makeStore({
    locations: [{ id: 'loc1', name: 'Town' }],
    shops: [
      {
        id: 'shop1',
        name: 'Store',
        locationId: 'loc1',
        open: true,
        inventory: [{ id: 'e1', name: 'Potion', price: 10, quantity: 1, stockMode: 'finite' }],
      },
    ],
  });
  const patches = [];
  store.updateShop = async (id, patch) => {
    patches.push({ id, patch });
    return { id, ...patch };
  };
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  app._deps.browseMedia = async (type, setValue) => {
    setValue('modules/forge/img/bg.png');
    return 'modules/forge/img/bg.png';
  };
  app.element = fakeShopForm({ backgroundImage: 'icons/old.png' });
  app.render = async () => {};
  await app._refreshData();
  // A preview is currently shown; a valid picker selection must invalidate it.
  app._data.previewShop = { id: 'shop1', theme: 'pastry' };
  await app._onBrowseMedia({}, { dataset: { mediaTarget: 'backgroundImage' } }, {});
  const bgInput = app.element.querySelector('[name="backgroundImage"]');
  assert.equal(bgInput.value, 'modules/forge/img/bg.png', 'valid chosen path written to the input');
  assert.equal(app._data.notice, '', 'no error notice on a valid selection');
  assert.ok(app._data.draftShop, 'raw draft captured after a valid picker selection');
  assert.equal(
    app._data.draftShop.appearance.backgroundImage,
    'modules/forge/img/bg.png',
    'draft carries the chosen media'
  );
  assert.equal(app._data.previewShop, null, 'stale preview invalidated by a valid picker selection');
  // An inventory action rerender must preserve the chosen media through the draft.
  await app._onSaveEntry({}, fakeTr('e1', { price: 11, quantity: 12 }), {});
  assert.equal(
    app._data.draftShop.appearance.backgroundImage,
    'modules/forge/img/bg.png',
    'chosen media preserved across an inventory rerender'
  );
  // Save persists the chosen media as a metadata patch, not an inventory patch.
  await app._onSaveShop({}, {}, {});
  const metaPatch = patches.find((p) => p.patch.appearance)?.patch;
  assert.ok(metaPatch, 'a metadata patch was written on save');
  assert.equal(metaPatch.appearance.backgroundImage, 'modules/forge/img/bg.png');
});

// ---- M2: storefront quantity state retention -------------------------------------

test('storefront quantity input/change updates state without re-rendering', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  let reRendered = false;
  app.render = async () => {
    reRendered = true;
  };
  app._onQuantityChange({ target: { value: '7' } });
  assert.equal(app._data.quantity, '7', 'quantity state updated from the field');
  assert.equal(reRendered, false, 'a quantity change does not re-render');
});

test('storefront retains quantity across search/filter/inspect and purchases with it', async () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: { hasActiveGM: () => true } });
  app._data.selectedActorId = 'a1';
  app._data.quantity = '3';
  let sent = null;
  app._request = (payload) => {
    sent = payload;
    return Promise.resolve(null);
  };
  app.render = async () => {};
  // Search, category filter, inspect and sort rerenders must retain the bound quantity.
  app._onSearchInput('potion');
  assert.equal(app._data.quantity, '3', 'search keeps quantity');
  await app._onFilterCategory({}, { dataset: { category: 'Consumable' } }, {});
  assert.equal(app._data.quantity, '3', 'category filter keeps quantity');
  app._onInspect({}, { dataset: { entryId: 'e1' } }, {});
  assert.equal(app._data.quantity, '3', 'inspect keeps quantity');
  await app._onSortItems({}, { value: 'price' }, {});
  assert.equal(app._data.quantity, '3', 'sort keeps quantity');
  // Purchase sends the retained quantity through the existing safe-integer validation.
  app.element = null;
  app._requestPurchase('e1');
  await Promise.resolve();
  assert.ok(sent, 'purchase request sent');
  assert.equal(sent.quantity, 3, 'purchases with the retained quantity');
});

test('storefront still rejects an invalid quantity held in state', async () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: { hasActiveGM: () => true } });
  app._data.selectedActorId = 'a1';
  let sent = null;
  app._request = (payload) => {
    sent = payload;
    return Promise.resolve(null);
  };
  app.render = async () => {};
  // An invalid integer in state must not send and must surface a feedback error.
  app._data.quantity = '0';
  app.element = null;
  app._requestPurchase('e1');
  await Promise.resolve();
  assert.equal(sent, null, 'zero state quantity does not send');
  assert.equal(app._data.feedback, 'Quantity must be a positive whole number.');
  app._data.quantity = '2.5';
  app._requestPurchase('e1');
  await Promise.resolve();
  assert.equal(sent, null, 'fractional state quantity does not send');
});

// ---- M2: manager GM inventory public fields -------------------------------------

test('manager inventory edit persists public description, category and rarity', async () => {
  const lockMap = createLockMap();
  const runShopExclusive = (shopId, fn) => lockMap.run('shop:' + shopId, fn);
  const store = makePersistentShopStore([
    {
      id: 'shop1',
      name: 'S',
      locationId: 'loc1',
      open: true,
      inventory: [
        { id: 'e1', name: 'Potion', price: 10, quantity: 10, stockMode: 'finite' },
        { id: 'e2', name: 'Bread', price: 20, quantity: 20, stockMode: 'finite' },
      ],
    },
  ]);
  const app = new MarketManager({ deps: { store, runShopExclusive, systemId: () => 'dnd5e' } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await app._onSaveEntry(
    {},
    fakeTr('e1', {
      price: 11,
      quantity: 12,
      publicDescription: 'A sturdy metal axe.',
      category: 'Weapon',
      rarity: 'Uncommon',
    }),
    {}
  );
  const shop = store._shops.get('shop1');
  const e1 = shop.inventory.find((e) => e.id === 'e1');
  const e2 = shop.inventory.find((e) => e.id === 'e2');
  assert.equal(e1.publicDescription, 'A sturdy metal axe.');
  assert.equal(e1.category, 'Weapon');
  assert.equal(e1.rarity, 'Uncommon');
  assert.equal(e2.publicDescription, undefined, 'only the target entry is edited');
  assert.equal(e2.category, undefined);
});

// ---- M2: storefront category / sort / search / detail --------------------------

test('storefront derives categories (All + unique) from visible public inventory', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app._data.shop = { id: 'shop1', appearance: {} };
  app._data.inventory = [
    { id: 'e1', name: 'Axe', category: 'Weapon', rarity: 'Uncommon', publicDescription: 'Sharp', price: 50, quantity: 2, stockMode: 'finite' },
    { id: 'e2', name: 'Potion', category: 'Consumable', rarity: 'Common', publicDescription: 'Heals', price: 10, quantity: 5, stockMode: 'finite' },
    { id: 'e3', name: 'Sword', category: 'Weapon', rarity: 'Rare', publicDescription: 'Fancy', price: 30, quantity: 3, stockMode: 'finite' },
    { id: 'e4', name: 'Hidden', category: 'Weapon', visible: false, price: 5, quantity: 1, stockMode: 'finite' },
  ];
  const ctx = app._prepareContext();
  assert.deepEqual(ctx.categories.map((c) => c.id), ['all', 'Consumable', 'Weapon']);
  assert.equal(ctx.categories[0].active, true, 'All active by default');
  assert.equal(ctx.categories[1].active, false);
  assert.equal(ctx.categories[2].label, 'Weapon');
});

test('storefront filters by category, searches fields and sorts by name/price ascending', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app._data.shop = { id: 'shop1', appearance: {} };
  app._data.inventory = [
    { id: 'e1', name: 'Axe', category: 'Weapon', rarity: 'Uncommon', publicDescription: 'Sharp', price: 50, quantity: 2, stockMode: 'finite' },
    { id: 'e2', name: 'Potion', category: 'Consumable', rarity: 'Common', publicDescription: 'Heals a wound', price: 10, quantity: 5, stockMode: 'finite' },
    { id: 'e3', name: 'Sword', category: 'Weapon', rarity: 'Rare', publicDescription: 'Fancy', price: 30, quantity: 3, stockMode: 'finite' },
  ];
  // Default order is the catalog's original featured order.
  let ctx = app._prepareContext();
  assert.deepEqual(ctx.inventory.map((e) => e.id), ['e1', 'e2', 'e3']);
  // Search by description.
  app._data.search = 'heals';
  ctx = app._prepareContext();
  assert.deepEqual(ctx.inventory.map((e) => e.id), ['e2']);
  // Search by rarity.
  app._data.search = 'rare';
  ctx = app._prepareContext();
  assert.deepEqual(ctx.inventory.map((e) => e.id), ['e3']);
  // Sort by name.
  app._data.search = '';
  app._data.sort = 'name';
  ctx = app._prepareContext();
  assert.deepEqual(ctx.inventory.map((e) => e.id), ['e1', 'e2', 'e3']);
  // Sort by price ascending.
  app._data.sort = 'price';
  ctx = app._prepareContext();
  assert.deepEqual(ctx.inventory.map((e) => e.id), ['e2', 'e3', 'e1']);
  // Category filter.
  app._data.sort = 'featured';
  app._data.categoryFilter = 'Weapon';
  ctx = app._prepareContext();
  assert.deepEqual(ctx.inventory.map((e) => e.id), ['e1', 'e3']);
});

test('storefront selectedEntry only comes from the current catalog and clears when filtered out', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app._data.shop = { id: 'shop1', appearance: {} };
  app._data.inventory = [
    { id: 'e1', name: 'Axe', category: 'Weapon', price: 50, quantity: 2, stockMode: 'finite' },
  ];
  app._data.selectedEntryId = 'e1';
  let ctx = app._prepareContext();
  assert.equal(ctx.selectedEntry.id, 'e1');
  // Filter out the current selection -> detail hides.
  app._data.categoryFilter = 'Armor';
  ctx = app._prepareContext();
  assert.equal(ctx.selectedEntry, null, 'detail cleared when the entry is filtered out');
  // Restore the filter -> detail re-appears (id still tracked).
  app._data.categoryFilter = null;
  ctx = app._prepareContext();
  assert.equal(ctx.selectedEntry.id, 'e1');
  // inspect and close-detail drive the selection through actions.
  app._onInspect({}, { dataset: { entryId: 'e1' } }, {});
  assert.equal(app._data.selectedEntryId, 'e1');
  app._onCloseDetail({}, {}, {});
  assert.equal(app._data.selectedEntryId, null);
});

test('storefront _prepareContext derives inventory without mutating _data.inventory', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app._data.shop = { id: 'shop1', appearance: {} };
  app._data.inventory = [
    { id: 'e1', name: 'A', category: 'C', price: 9, quantity: 1, stockMode: 'finite' },
    { id: 'e2', name: 'B', category: 'C', price: 5, quantity: 1, stockMode: 'finite' },
  ];
  app._data.sort = 'price';
  const ctx = app._prepareContext();
  assert.deepEqual(ctx.inventory.map((e) => e.id), ['e2', 'e1'], 'context inventory is sorted');
  assert.deepEqual(
    app._data.inventory.map((e) => e.id),
    ['e1', 'e2'],
    '_data.inventory untouched by derivation'
  );
  assert.equal(app._data.inventory.length, 2);
});

// ---- M2: storefront sound opt-in / stop + safe styles --------------------------

test('storefront sound toggle plays only on user opt-in and stops on toggle off', async () => {
  const played = [];
  const stopped = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      playSound: async (opts) => {
        played.push(opts);
        return { stop: () => stopped.push(opts.src) };
      },
    },
  });
  app._data.shop = { id: 'shop1', appearance: { music: 'modules/forge/sfx/ambient.ogg' } };
  app._data.soundEnabled = false;
  app.render = async () => {};
  // No play before opt-in.
  assert.equal(played.length, 0);
  await app._onToggleSound({}, {}, {});
  assert.equal(app._data.soundEnabled, true);
  assert.equal(played.length, 1);
  assert.equal(played[0].src, 'modules/forge/sfx/ambient.ogg');
  assert.equal(played[0].loop, true);
  assert.equal(played[0].volume, 0.25);
  await app._onToggleSound({}, {}, {});
  assert.equal(app._data.soundEnabled, false);
  assert.equal(stopped.length, 1, 'toggle off stops the sound');
});

test('storefront stops sound on catalog change and on close', async () => {
  const played = [];
  const stopped = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      playSound: async (opts) => {
        played.push(opts);
        return { stop: () => stopped.push(opts.src) };
      },
    },
  });
  app._data.shop = { id: 'shop1', appearance: { music: 'modules/x/ambient.ogg' } };
  app._data.soundEnabled = true;
  app._soundHandle = { stop: () => stopped.push('old-handle') };
  // Catalog change: stop the old handle, restart because the user opted in.
  app._syncSound();
  await Promise.resolve();
  assert.equal(stopped.length, 1);
  assert.equal(played.length, 1, 'music restarted after catalog change');
  // Close stops whatever is currently playing.
  app._soundHandle = { stop: () => stopped.push('closed-handle') };
  app._onClose();
  assert.equal(stopped.length, 2);
});

test('storefront plays a purchase sound effect only when sound is enabled and path is valid', async () => {
  const played = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      playSound: async (opts) => {
        played.push(opts);
        return { stop: () => {} };
      },
    },
  });
  app._data.shop = { id: 'shop1', appearance: { soundEffect: 'systems/dnd/sfx/bell.ogg' } };
  app._data.soundEnabled = false;
  app._playSoundEffect();
  assert.equal(played.length, 0, 'no sound effect while sound is off');
  app._data.soundEnabled = true;
  app._playSoundEffect();
  assert.equal(played.length, 1);
  assert.equal(played[0].loop, false);
  // Invalid path is ignored.
  app._data.shop.appearance.soundEffect = 'https://cdn/bell.ogg';
  app._playSoundEffect();
  assert.equal(played.length, 1, 'invalid soundEffect path ignored');
});

test('storefront applies a strict accent color and clears stale styles on rerender', () => {
  const hero = { style: { backgroundImage: '' } };
  const props = {};
  const root = {
    style: {
      props,
      setProperty(k, v) {
        props[k] = v;
      },
      removeProperty(k) {
        delete props[k];
      },
    },
    querySelector: (sel) => (sel === '.shop-hero' ? hero : null),
  };
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app.element = root;
  app._data.shop = { id: 'shop1', appearance: { accentColor: '#ABC123', backgroundImage: 'modules/x/bg.png' } };
  app._applyStorefrontStyles();
  assert.equal(props['--mk-custom-accent'], '#ABC123');
  assert.equal(hero.style.backgroundImage, 'url("modules/x/bg.png")');
  // Rerender with an empty accent/bg clears the old values.
  app._data.shop = { id: 'shop1', appearance: { accentColor: '', backgroundImage: '' } };
  app._applyStorefrontStyles();
  assert.equal('--mk-custom-accent' in props, false, 'stale accent cleared');
  assert.equal(hero.style.backgroundImage, '', 'stale background cleared');
  // A non-strict #rrggbb accent is rejected.
  app._data.shop = { id: 'shop1', appearance: { accentColor: 'red', backgroundImage: '' } };
  app._applyStorefrontStyles();
  assert.equal('--mk-custom-accent' in props, false);
});

// ---- M2: M1 purchase/catalog flows remain intact -------------------------------

test('storefront purchase response still commits, refreshes and leaves inventory intact', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app._loaded = true;
  let refreshed = false;
  app._requestRefresh = () => {
    refreshed = true;
    return Promise.resolve();
  };
  app._data.pending = true;
  app._data.inventory = [
    { id: 'e1', name: 'A', category: 'C', price: 1, quantity: 1, stockMode: 'finite' },
  ];
  app._data.soundEnabled = false;
  app._onPurchaseResponse({ type: 'purchase', result: { status: 'committed' } });
  assert.equal(app._data.pending, false);
  assert.equal(app._data.feedback, 'Purchase complete.');
  assert.equal(refreshed, true, 'catalog refresh still triggered');
  assert.equal(app._data.inventory.length, 1, '_data.inventory not clobbered by the purchase flow');
});

test('storefront catalog response still correlates and never leaks private fields', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app._loaded = true;
  const inventory = [
    { id: 'e1', name: 'Potion', price: 10, quantity: 5, stockMode: 'finite', img: '', itemUuid: 'Compendium.a.Item.x', system: { value: 1 } },
  ];
  app._onCatalogResponse({
    type: 'catalog',
    requestId: 'cat',
    shopId: 'shop1',
    shop: { id: 'shop1', name: 'S', open: true },
    inventory,
  });
  assert.equal(app._data.shop.name, 'S');
  assert.equal(app._data.inventory.length, 1);
  assert.equal(app._data.inventory[0].itemUuid, 'Compendium.a.Item.x');
  assert.ok(app._data.inventory[0].system, 'item system data is present in the public response');
});

// ---- M2 review: manager unsaved-draft preservation + storefront sound/buttons ---

test('manager preview then save persists the current unsaved form fields', async () => {
  const store = makeStore({
    locations: [{ id: 'loc1', name: 'Town' }],
    shops: [{ id: 'shop1', name: 'Store', locationId: 'loc1', open: true, inventory: [] }],
  });
  const patches = [];
  store.updateShop = async (id, patch) => {
    patches.push(patch);
    return { id, ...patch };
  };
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  await app._refreshData();
  app.element = fakeShopForm({
    name: 'Renamed',
    owner: 'Mira',
    description: 'A fresh description',
    theme: 'pastry',
    accentColor: '#FFAA00',
  });
  app.render = async () => {};
  // Preview captures the current unsaved form and builds a validated preview.
  await app._onPreviewAppearance({}, {}, {});
  assert.equal(app._data.previewShop.name, 'Renamed');
  assert.equal(app._data.previewShop.owner, 'Mira');
  assert.equal(app._data.previewShop.description, 'A fresh description');
  assert.equal(app._data.previewShop.theme, 'pastry');
  assert.equal(app._data.previewShop.appearance.accentColor, '#FFAA00');
  assert.ok(app._data.draftShop, 'draft captured after preview');
  // The persisted shop still has the old values; the draft must carry the edits.
  assert.equal(app._data.selectedShop.name, 'Store');
  // Save persists the current unsaved fields (still present via editingShop).
  await app._onSaveShop({}, {}, {});
  assert.equal(patches.length, 1, 'one metadata patch written');
  const patch = patches[0];
  assert.equal(patch.name, 'Renamed');
  assert.equal(patch.owner, 'Mira');
  assert.equal(patch.description, 'A fresh description');
  assert.equal(patch.theme, 'pastry');
  assert.equal(patch.appearance.accentColor, '#FFAA00');
  assert.equal(app._data.draftShop, null, 'draft cleared after a successful save');
});

test('manager invalid appearance preview keeps the raw draft and shows no preview', async () => {
  const store = makeStore({
    locations: [{ id: 'loc1', name: 'Town' }],
    shops: [{ id: 'shop1', name: 'Store', locationId: 'loc1', open: true, inventory: [] }],
  });
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  await app._refreshData();
  app.element = fakeShopForm({
    name: 'Raw Name',
    backgroundImage: 'https://cdn.example.com/x.png',
  });
  app.render = async () => {};
  await app._onPreviewAppearance({}, {}, {});
  assert.equal(app._data.previewShop, null, 'no preview on an invalid appearance');
  assert.ok(app._data.notice.includes('media path') || app._data.notice.includes('local media'));
  assert.ok(app._data.draftShop, 'raw draft captured on a rejected preview');
  // The editor must keep the exact raw input so the GM can correct it.
  const ctx = app._prepareContext();
  assert.equal(ctx.editingShop.name, 'Raw Name', 'unsaved name retained');
  assert.equal(
    ctx.editingShop.appearance.backgroundImage,
    'https://cdn.example.com/x.png',
    'raw invalid media input retained'
  );
});

test('manager invalid save keeps the raw draft without writing to the store', async () => {
  const store = makeStore({
    locations: [{ id: 'loc1', name: 'Town' }],
    shops: [{ id: 'shop1', name: 'Store', locationId: 'loc1', open: true, inventory: [] }],
  });
  let writes = 0;
  store.updateShop = async (id, patch) => {
    writes++;
    return { id, ...patch };
  };
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  await app._refreshData();
  app.element = fakeShopForm({ name: 'Retained', accentColor: 'red' });
  app.render = async () => {};
  await app._onSaveShop({}, {}, {});
  assert.equal(writes, 0, 'no store write on an invalid accent color');
  assert.ok(app._data.draftShop, 'raw draft kept on a rejected save');
  const ctx = app._prepareContext();
  assert.equal(ctx.editingShop.name, 'Retained', 'name retained after a rejected save');
  assert.equal(ctx.editingShop.appearance.accentColor, 'red', 'raw invalid accent retained');
});

test('manager switching shops resets the unsaved draft and preview', async () => {
  const store = makeStore({
    locations: [{ id: 'loc1', name: 'Town' }],
    shops: [
      { id: 'shop1', name: 'Store', locationId: 'loc1', open: true, inventory: [] },
      { id: 'shop2', name: 'Market', locationId: 'loc1', open: true, inventory: [] },
    ],
  });
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  await app._refreshData();
  app._data.previewShop = { id: 'shop1', theme: 'pastry' };
  app._data.draftShop = { name: 'Unsaved', appearance: {} };
  await app._onSelectShop({}, { dataset: { shopId: 'shop2' } }, {});
  assert.equal(app._data.previewShop, null, 'preview cleared on shop switch');
  assert.equal(app._data.draftShop, null, 'draft cleared on shop switch');
  assert.equal(app._data.selectedShopId, 'shop2');
});

test('manager reset-preview clears both the draft and the preview', async () => {
  const store = makeStore({
    locations: [{ id: 'loc1', name: 'Town' }],
    shops: [{ id: 'shop1', name: 'Store', locationId: 'loc1', open: true, inventory: [] }],
  });
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  await app._refreshData();
  app._data.previewShop = { id: 'shop1', theme: 'pastry' };
  app._data.draftShop = { name: 'Unsaved', appearance: {} };
  await app._onResetPreview({}, {}, {});
  assert.equal(app._data.previewShop, null);
  assert.equal(app._data.draftShop, null);
});

// ---- M2 review: live unsaved-draft capture + preview-panel styling -----------

test('manager live change to a shop form field captures the draft and clears the preview', async () => {
  const app = new MarketManager({ deps: { systemId: () => 'dnd5e', isGM: () => true } });
  app.element = fakeShopForm({ name: 'Edited', theme: 'pastry', accentColor: '#FFAA00' });
  app._data.previewShop = { id: 'shop1', theme: 'pastry' };
  // A live edit to a metadata field captures the RAW form without a re-render and
  // invalidates the stale preview.
  await app._onShopFormChange({});
  assert.ok(app._data.draftShop, 'draft captured on a live field change');
  assert.equal(app._data.draftShop.name, 'Edited');
  assert.equal(app._data.draftShop.theme, 'pastry');
  assert.equal(app._data.draftShop.appearance.accentColor, '#FFAA00');
  assert.equal(app._data.previewShop, null, 'stale preview invalidated on an edit');
});

test('manager unsaved metadata draft survives an inventory action refresh until Save', async () => {
  const store = makeStore({
    locations: [{ id: 'loc1', name: 'Town' }],
    shops: [
      {
        id: 'shop1',
        name: 'Store',
        locationId: 'loc1',
        open: true,
        inventory: [{ id: 'e1', name: 'Potion', price: 10, quantity: 1, stockMode: 'finite' }],
      },
    ],
  });
  const patches = [];
  store.updateShop = async (id, patch) => {
    patches.push({ id, patch });
    return { id, ...patch };
  };
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  await app._refreshData();
  app.element = fakeShopForm({ name: 'Edited Name', theme: 'pastry', accentColor: '#FFAA00' });
  app.render = async () => {};
  await app._onShopFormChange({});
  assert.ok(app._data.draftShop, 'draft captured before any inventory action');
  assert.equal(patches.length, 0, 'no metadata persisted before Save');
  // An inventory save refreshes the data and re-renders; the draft must survive.
  await app._onSaveEntry({}, fakeTr('e1', { price: 11, quantity: 12 }), {});
  assert.ok(app._data.draftShop, 'draft preserved across an inventory save refresh');
  assert.equal(app._data.draftShop.name, 'Edited Name', 'unsaved metadata survived the refresh');
  // The inventory save writes only an inventory patch, never the metadata draft.
  assert.equal(patches.length, 1, 'inventory save wrote only an inventory patch');
  assert.ok(!('name' in patches[0].patch), 'metadata name not persisted by the inventory save');
  assert.ok(!('theme' in patches[0].patch), 'metadata theme not persisted by the inventory save');
  assert.ok(!('appearance' in patches[0].patch), 'metadata appearance not persisted by the inventory save');
  // Save now persists the current unsaved metadata.
  await app._onSaveShop({}, {}, {});
  assert.equal(patches.length, 2, 'metadata persisted only on Save');
  const metaPatch = patches[1].patch;
  assert.equal(metaPatch.name, 'Edited Name');
  assert.equal(metaPatch.theme, 'pastry');
  assert.equal(metaPatch.appearance.accentColor, '#FFAA00');
});

test('manager preview panel applies only validated accent and background styles', async () => {
  const app = new MarketManager({ deps: { systemId: () => 'dnd5e', isGM: () => true } });
  const props = {};
  const panelStyle = {
    backgroundImage: '',
    setProperty(k, v) {
      props[k] = v;
    },
    removeProperty(k) {
      delete props[k];
    },
  };
  const panel = { style: panelStyle };
  const root = {
    querySelector: (sel) => (sel === '.preview-panel' ? panel : null),
    querySelectorAll: () => [],
  };
  app.element = root;
  app._loaded = true;
  app._data.previewShop = {
    id: 'shop1',
    name: 'Preview',
    theme: 'pastry',
    appearance: { accentColor: '#ABC123', backgroundImage: 'modules/x/bg.png' },
  };
  await app._onRender({});
  assert.equal(props['--mk-custom-accent'], '#ABC123', 'valid accent applied');
  assert.equal(panelStyle.backgroundImage, 'url("modules/x/bg.png")', 'valid background applied');
  // An injected invalid accent/background is rejected and any stale style cleared.
  app._data.previewShop = {
    id: 'shop1',
    name: 'Preview',
    theme: 'pastry',
    appearance: { accentColor: 'red', backgroundImage: 'https://cdn.example.com/x.png' },
  };
  await app._onRender({});
  assert.equal('--mk-custom-accent' in props, false, 'invalid accent rejected');
  assert.equal(panelStyle.backgroundImage, '', 'invalid background rejected');
});

test('storefront purchase sound effect handles a synchronous Sound return without .catch', () => {
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: { playSound: () => ({ stop: () => {} }) },
  });
  app._data.shop = { id: 'shop1', appearance: { soundEffect: 'systems/dnd/sfx/bell.ogg' } };
  app._data.soundEnabled = true;
  // A synchronous non-Promise Sound must not throw on `.catch`.
  app._playSoundEffect();
  assert.equal(app._data.notice, '');
});

test('storefront purchase sound effect surfaces a synchronous throw as a notice', () => {
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      playSound: () => {
        throw new Error('audio failed');
      },
    },
  });
  app._data.shop = { id: 'shop1', appearance: { soundEffect: 'systems/dnd/sfx/bell.ogg' } };
  app._data.soundEnabled = true;
  app._playSoundEffect();
  assert.ok(app._data.notice.length > 0, 'sync throw surfaced as a notice');
});

test('storefront stops a delayed-start sound that resolves after toggle off', async () => {
  const stopped = [];
  let resolvePlay;
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      playSound: () =>
        new Promise((resolve) => {
          resolvePlay = resolve;
        }),
    },
  });
  app._data.shop = { id: 'shop1', appearance: { music: 'modules/x/ambient.ogg' } };
  app._data.soundEnabled = false;
  app.render = async () => {};
  // Enable sound: `_startSound` begins but the play promise stays pending.
  const startPromise = app._onToggleSound({}, {}, {});
  assert.equal(app._data.soundEnabled, true);
  assert.equal(app._soundHandle, null, 'handle not installed while in flight');
  // Toggle off before the play resolves -> invalidates the in-flight start.
  await app._onToggleSound({}, {}, {});
  assert.equal(app._data.soundEnabled, false);
  // The delayed play now resolves with a stale Sound; it must be stopped.
  resolvePlay({ src: 'modules/x/ambient.ogg', stop: () => stopped.push('stale') });
  await startPromise;
  await Promise.resolve();
  assert.equal(stopped.length, 1, 'stale resolved sound was stopped');
  assert.equal(app._soundHandle, null, 'no stale handle retained');
});

test('storefront stops a delayed-start sound that resolves after a catalog change', async () => {
  const resolvers = [];
  const stopped = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      playSound: () => new Promise((resolve) => resolvers.push(resolve)),
    },
  });
  app._data.shop = { id: 'shop1', appearance: { music: 'modules/x/ambient.ogg' } };
  app._data.soundEnabled = true;
  app.render = async () => {};
  // First start is in flight (superseded generation).
  const firstStart = app._startSound();
  // A catalog change syncs sound: stop the in-flight start (bumps the token) and
  // restart because the user is still opted in (second in-flight start).
  app._syncSound();
  assert.equal(resolvers.length, 2, 'both the stale and current start are pending');
  // The stale (first) start resolves after the catalog change; its sound is stopped.
  resolvers[0]({ src: 'modules/x/ambient.ogg', stop: () => stopped.push('stale') });
  await firstStart;
  await Promise.resolve();
  assert.equal(stopped.length, 1, 'stale in-flight start stopped after a catalog change');
  // The current start keeps the live handle and is never stopped.
  resolvers[1]({ src: 'modules/x/ambient.ogg', stop: () => {} });
  await Promise.resolve();
  assert.ok(app._soundHandle, 'current generation sound installed');
});

test('storefront stops a delayed-start sound that resolves after close', async () => {
  const stopped = [];
  let resolvePlay;
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      playSound: () =>
        new Promise((resolve) => {
          resolvePlay = resolve;
        }),
    },
  });
  app._data.shop = { id: 'shop1', appearance: { music: 'modules/x/ambient.ogg' } };
  app._data.soundEnabled = true;
  app.render = async () => {};
  const startPromise = app._startSound();
  assert.equal(app._soundHandle, null);
  app._onClose();
  resolvePlay({ src: 'modules/x/ambient.ogg', stop: () => stopped.push('stale') });
  await startPromise;
  await Promise.resolve();
  assert.equal(stopped.length, 1, 'stale resolved sound stopped on close');
  assert.equal(app._soundHandle, null);
});

test('shop template disables the detail Buy button on pending / no GM / out of stock', () => {
  const template = readFileSync(new URL('../templates/shop.hbs', import.meta.url), 'utf8');
  const detailButton = template.match(/data-entry-id="\{\{selectedEntry\.id\}\}"[^>]*>/);
  assert.ok(detailButton, 'detail Buy button found in the shop template');
  const attrs = detailButton[0];
  assert.match(attrs, /pending/, 'detail button disables while a request is pending');
  assert.match(attrs, /hasGM/, 'detail button disables with no active GM');
  assert.match(attrs, /stockMode/, 'detail button disables for out-of-stock entries');
  assert.match(attrs, /quantity/, 'detail button disables for out-of-stock entries');
});

test('storefront categories exclude categories that only appear on hidden entries', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app._data.shop = { id: 'shop1', appearance: {} };
  app._data.inventory = [
    { id: 'e1', name: 'Axe', category: 'Weapon', price: 50, quantity: 2, stockMode: 'finite' },
    { id: 'e2', name: 'Hidden', category: 'Secret', visible: false, price: 5, quantity: 1, stockMode: 'finite' },
  ];
  const ctx = app._prepareContext();
  assert.deepEqual(
    ctx.categories.map((c) => c.id),
    ['all', 'Weapon'],
    'a hidden-only category is not offered as a filter tab'
  );
});

// ---- M3: runtime reputation API guard (injected globals) -----------------------

test('runtime api.reputation.adjust is GM-gated and never accepts a forged GM id', async () => {
  // Wire enough of the Foundry boundary that main.js `init` can run: module
  // registration for the api attachment, settings for register/registerMenu and
  // an empty journal for the default reputation-adjacent store reads.
  const modules = {};
  globalThis.game.modules = { get: (id) => (modules[id] || (modules[id] = {})) };
  globalThis.game.settings = { register: () => {}, registerMenu: () => {} };
  globalThis.game.journal = { filter: () => [], get: () => null };

  await import('../src/core/main.js');
  fireHook('init');

  const api = globalThis.game.modules.get('market').api;
  assert.ok(api);
  assert.ok(api.reputation, 'reputation surface exposed on the module api');
  assert.equal(typeof api.reputation.adjust, 'function');
  assert.equal(typeof api.reputation.getEffective, 'function');
  assert.equal(typeof api.getReputation, 'function');
  assert.equal(typeof api.quotePrice, 'function');

  // Non-GM guard: the wrapper rejects before any read/write.
  globalThis.game.user.isGM = false;
  const r1 = await api.reputation.adjust({
    shopId: 's1',
    scope: 'actor',
    subjectId: 'Actor.a',
    delta: 5,
    requestId: 'r1',
  });
  assert.equal(r1.status, 'error');
  assert.equal(r1.error, 'not-a-gm');

  // GM path: the wrapper always passes THIS user's id (never a forged GM id). A
  // missing shop surfaces as shop-not-found, proving the request was routed into
  // the real service with the authenticated user keys.
  globalThis.game.user.isGM = true;
  const prevGet = globalThis.game.users.get;
  globalThis.game.users.get = (id) => ({ id, isGM: true });
  try {
    const r2 = await api.reputation.adjust({
      shopId: 'missing',
      scope: 'actor',
      subjectId: 'Actor.a',
      delta: 5,
      requestId: 'r2',
    });
    assert.equal(r2.status, 'error');
    assert.equal(r2.error, 'shop-not-found');
  } finally {
    globalThis.game.users.get = prevGet;
  }
});

test('runtime api.reputation.getEffective is GM-only: a non-GM read returns null', async () => {
  // Wire just enough of the Foundry boundary that main.js `init` can run, then
  // re-fire it so the api is attached (module is cached; re-firing the hook
  // re-runs the once-registered init path).
  const modules = {};
  globalThis.game.modules = { get: (id) => (modules[id] || (modules[id] = {})) };
  globalThis.game.settings = { register: () => {}, registerMenu: () => {} };
  globalThis.game.journal = { filter: () => [], get: () => null };
  globalThis.game.actors = { get: () => null };

  await import('../src/core/main.js');
  fireHook('init');

  const api = globalThis.game.modules.get('market').api;
  const shop = { id: 's1', social: { partyId: '' } };

  // Non-GM caller: the wrapper rejects before any service read, so it can never
  // probe another player's reputation.
  globalThis.game.user.isGM = false;
  const rejected = await api.reputation.getEffective(shop, 'Actor.a');
  assert.equal(rejected, null, 'non-GM getEffective read returns null');

  // GM caller: routes into the live reputation service and resolves a value.
  globalThis.game.user.isGM = true;
  const gmResult = await api.reputation.getEffective(shop, 'Actor.a');
  assert.ok(gmResult, 'GM getEffective read resolves the effective reputation');
  assert.equal(typeof gmResult.score, 'number');
});

// ---- M3: manager social / NPC / reputation UI wiring -------------------------

function fakeSocialPanel(values = {}) {
  const textNames = ['primaryPersonality', 'secondaryPersonality', 'partyId'];
  const numNames = ['secondaryWeight', 'individualWeight', 'partyWeight', 'shopMarkupBps'];
  const fields = {};
  for (const name of textNames) {
    fields[`[name="${name}"]`] = { type: 'text', value: String(values[name] ?? '') };
  }
  for (const name of numNames) {
    fields[`[name="${name}"]`] = { type: 'number', value: String(values[name] ?? '') };
  }
  return { querySelector: (sel) => fields[sel] || null };
}

function socialPanelRoot(panel) {
  return {
    querySelector: (sel) => (sel === '.social-panel' ? panel : null),
    querySelectorAll: () => [],
  };
}

function fakeNpcRows(rows = []) {
  const els = rows.map((r) => ({
    dataset: { npcId: r.id },
    querySelector: (sel) => {
      const map = {
        '[name="npcName"]': { value: String(r.npcName ?? '') },
        '[name="npcRole"]': { value: String(r.npcRole ?? '') },
        '[name="npcActorUuid"]': { value: String(r.npcActorUuid ?? '') },
        '[name="npcPortrait"]': { value: String(r.npcPortrait ?? '') },
        '[name="npcGreeting"]': { value: String(r.npcGreeting ?? '') },
        '[name="npcPersonality"]': { value: String(r.npcPersonality ?? '') },
        '[name="npcVisible"]': { type: 'checkbox', checked: r.npcVisible !== false },
      };
      return map[sel] || null;
    },
  }));
  return { querySelectorAll: (sel) => (sel === '.npc-list [data-npc-id]' ? els : []) };
}

// A persistent store exposing the M2/M3 store surface used by the social / NPC /
// reputation editors, including `findShop`, `updateShop` and the GM-only
// `listReputationEvents` read.
function makeM3Store({ shops = [], events = [] } = {}) {
  const map = new Map();
  for (const s of shops) map.set(s.id, structuredClone(s));
  const calls = [];
  return {
    _map: map,
    _calls: calls,
    listLocations: async () => [],
    listShops: async () => Array.from(map.values()),
    findShop: async (id) => {
      const s = map.get(id);
      return s ? structuredClone(s) : null;
    },
    updateShop: async (id, patch) => {
      calls.push({ id, patch });
      const s = map.get(id);
      if (!s) return null;
      const next = { ...s, ...patch };
      map.set(id, next);
      return next;
    },
    listReputationEvents: async ({ shopId, scope, subjectId } = {}) =>
      events.filter(
        (e) =>
          (!shopId || e.shopId === shopId) &&
          (!scope || e.scope === scope) &&
          (!subjectId || e.subjectId === subjectId)
      ),
  };
}

function baseNpc(name, extra = {}) {
  return {
    id: `npc-${name}`,
    name,
    role: '',
    actorUuid: '',
    portrait: '',
    greeting: '',
    personality: 'honest',
    visible: true,
    ...extra,
  };
}

test('manager save-social writes normalized social and syncs the primary NPC personality', async () => {
  const store = makeM3Store({
    shops: [
      {
        id: 'shop1',
        name: 'S',
        locationId: 'loc1',
        open: true,
        inventory: [],
        owner: 'Mira',
        npcs: [baseNpc('Mira', { personality: 'greedy' }), baseNpc('Tavi')],
        social: { primaryPersonality: 'greedy', individualWeight: 70, partyWeight: 30 },
      },
    ],
  });
  const app = new MarketManager({
    deps: { store, isGM: () => true, systemId: () => 'dnd5e' },
  });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  app.element = socialPanelRoot(
    fakeSocialPanel({
      primaryPersonality: 'generous',
      secondaryPersonality: '',
      secondaryWeight: 0,
      individualWeight: 70,
      partyWeight: 30,
      partyId: '',
      shopMarkupBps: 500,
    })
  );
  await app._onSaveSocial({}, {}, {});
  assert.equal(store._calls.length, 1, 'one social patch written');
  const { id, patch } = store._calls[0];
  assert.equal(id, 'shop1');
  assert.equal(patch.social.primaryPersonality, 'generous');
  assert.equal(patch.social.individualWeight, 70);
  assert.equal(patch.social.partyWeight, 30);
  assert.equal(patch.social.shopMarkupBps, 500);
  assert.equal(patch.npcs[0].personality, 'generous', 'primary NPC personality synced');
  assert.equal(patch.npcs[1].personality, 'honest', 'secondary NPC untouched');
});

test('manager save-social surfaces a weight-sum error without writing', async () => {
  const store = makeM3Store({
    shops: [{ id: 'shop1', name: 'S', owner: 'Mira', npcs: [], social: {}, inventory: [] }],
  });
  const app = new MarketManager({
    deps: { store, isGM: () => true, systemId: () => 'dnd5e' },
  });
  app._data.selectedShopId = 'shop1';
  app.render = async () => {};
  app.element = socialPanelRoot(
    fakeSocialPanel({ primaryPersonality: 'honest', individualWeight: 70, partyWeight: 20 })
  );
  await app._onSaveSocial({}, {}, {});
  assert.equal(store._calls.length, 0, 'no write on invalid weights');
  assert.ok(app._data.notice.includes('must equal 100'), 'weight-sum error surfaced');
});

test('manager save-social retains the existing autoPurchase config', async () => {
  const store = makeM3Store({
    shops: [
      {
        id: 'shop1',
        name: 'S',
        locationId: 'loc1',
        open: true,
        inventory: [],
        owner: 'Mira',
        npcs: [baseNpc('Mira', { personality: 'greedy' })],
        social: {
          primaryPersonality: 'greedy',
          individualWeight: 70,
          partyWeight: 30,
          autoPurchase: { enabled: true, minimumSpend: 500, cooldownSeconds: 3600, delta: 3 },
        },
      },
    ],
  });
  const app = new MarketManager({
    deps: { store, isGM: () => true, systemId: () => 'dnd5e' },
  });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  app.element = socialPanelRoot(
    fakeSocialPanel({
      primaryPersonality: 'generous',
      secondaryPersonality: '',
      secondaryWeight: 0,
      individualWeight: 70,
      partyWeight: 30,
      partyId: '',
      shopMarkupBps: 500,
    })
  );
  await app._onSaveSocial({}, {}, {});
  assert.equal(store._calls.length, 1, 'one social patch written');
  const { patch } = store._calls[0];
  assert.equal(patch.social.primaryPersonality, 'generous');
  assert.deepEqual(
    patch.social.autoPurchase,
    { enabled: true, minimumSpend: 500, cooldownSeconds: 3600, delta: 3 },
    'a non-default autoPurchase survives a social save (not editable in the panel)'
  );
});

test('manager save-social leaves the unsaved form intact on a validation error', async () => {
  const store = makeM3Store({
    shops: [{ id: 'shop1', name: 'S', owner: 'Mira', npcs: [], social: {}, inventory: [] }],
  });
  const app = new MarketManager({
    deps: { store, isGM: () => true, systemId: () => 'dnd5e' },
  });
  app._data.selectedShopId = 'shop1';
  let refreshed = false;
  app._refreshData = async () => {
    refreshed = true;
  };
  app.render = async () => {};
  app.element = socialPanelRoot(
    fakeSocialPanel({ primaryPersonality: 'honest', individualWeight: 70, partyWeight: 20 })
  );
  await app._onSaveSocial({}, {}, {});
  assert.equal(store._calls.length, 0, 'no write on invalid weights');
  assert.ok(app._data.notice.includes('must equal 100'), 'weight-sum error surfaced');
  assert.equal(refreshed, false, 'a validation error leaves the unsaved form intact (no data refresh)');
});

test('manager add-npc persists a new merchant and reassigns the owner', async () => {
  const store = makeM3Store({
    shops: [{ id: 'shop1', name: 'S', owner: '', npcs: [], inventory: [], social: {} }],
  });
  const app = new MarketManager({
    deps: { store, isGM: () => true, systemId: () => 'dnd5e' },
  });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await app._onAddNpc({}, {}, {});
  assert.equal(store._calls.length, 1);
  const { patch } = store._calls[0];
  assert.equal(patch.npcs.length, 1);
  assert.equal(patch.npcs[0].name, 'New merchant');
  assert.ok(patch.npcs[0].id, 'generated id present');
  assert.equal(patch.npcs[0].personality, 'honest', 'defaults to the honest preset');
  assert.equal(patch.owner, 'New merchant', 'owner reassigned to the new primary');
});

test('manager add-npc enforces the three-merchant cap', async () => {
  const store = makeM3Store({
    shops: [
      {
        id: 'shop1',
        name: 'S',
        owner: 'A',
        inventory: [],
        social: {},
        npcs: [baseNpc('A'), baseNpc('B'), baseNpc('C')],
      },
    ],
  });
  const app = new MarketManager({
    deps: { store, isGM: () => true, systemId: () => 'dnd5e' },
  });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await app._onAddNpc({}, {}, {});
  assert.equal(store._calls.length, 0, 'no write at the cap');
  assert.equal(app._data.notice, 'A shop can have at most three merchants.');
});

test('manager save-npcs normalizes rows, caps at three and syncs owner/social', async () => {
  const store = makeM3Store({
    shops: [
      { id: 'shop1', name: 'S', owner: '', npcs: [], inventory: [], social: { primaryPersonality: 'honest' } },
    ],
  });
  const app = new MarketManager({
    deps: { store, isGM: () => true, systemId: () => 'dnd5e' },
  });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  app.element = fakeNpcRows([
    { id: 'a', npcName: 'Mira', npcRole: 'Owner', npcPersonality: 'greedy' },
    { id: 'b', npcName: 'Tavi', npcRole: 'Clerk', npcPersonality: 'honest' },
    { id: 'c', npcName: 'Nia', npcRole: '', npcPersonality: 'generous' },
    { id: 'd', npcName: 'Extra', npcRole: '', npcPersonality: 'proud' },
  ]);
  await app._onSaveNpcs({}, {}, {});
  assert.equal(store._calls.length, 1);
  const { patch } = store._calls[0];
  assert.equal(patch.npcs.length, 3, 'roster capped to three');
  assert.equal(patch.npcs[0].name, 'Mira');
  assert.equal(patch.npcs[1].name, 'Tavi');
  assert.equal(patch.npcs[2].name, 'Nia');
  assert.equal(patch.owner, 'Mira', 'owner synced to the first merchant name');
  assert.equal(patch.social.primaryPersonality, 'greedy', 'social primary synced from the first merchant');
});

test('manager save-npcs surfaces an invalid portrait error without writing', async () => {
  const store = makeM3Store({
    shops: [{ id: 'shop1', name: 'S', owner: '', npcs: [], inventory: [], social: {} }],
  });
  const app = new MarketManager({
    deps: { store, isGM: () => true, systemId: () => 'dnd5e' },
  });
  app._data.selectedShopId = 'shop1';
  app.render = async () => {};
  app.element = fakeNpcRows([
    { id: 'a', npcName: 'Mira', npcPortrait: 'https://cdn.example.com/x.png' },
  ]);
  await app._onSaveNpcs({}, {}, {});
  assert.equal(store._calls.length, 0, 'no write on an invalid portrait');
  assert.ok(
    app._data.notice.includes('media path') || app._data.notice.includes('local media'),
    'validation error surfaced in the notice'
  );
});

test('manager remove-npc reassigns the owner and never deletes the shop', async () => {
  const store = makeM3Store({
    shops: [
      {
        id: 'shop1',
        name: 'S',
        owner: 'Mira',
        inventory: [],
        social: {},
        npcs: [baseNpc('Mira', { personality: 'greedy' }), baseNpc('Tavi')],
      },
    ],
  });
  const app = new MarketManager({
    deps: { store, isGM: () => true, systemId: () => 'dnd5e' },
  });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await app._onRemoveNpc({}, { dataset: { npcId: 'npc-Mira' } }, {});
  assert.equal(store._calls.length, 1, 'a reassignment patch was written');
  const { patch } = store._calls[0];
  assert.equal(patch.npcs.length, 1, 'removed merchant dropped');
  assert.equal(patch.npcs[0].name, 'Tavi', 'remaining merchant kept in order');
  assert.equal(patch.owner, 'Tavi', 'owner reassigned to the new primary');
});

test('manager manual reputation adjustment validates and calls the GM-only adjust', async () => {
  const store = makeM3Store({
    shops: [{ id: 'shop1', name: 'S', owner: '', npcs: [], inventory: [], social: {} }],
    events: [
      {
        shopId: 'shop1',
        scope: 'actor',
        subjectId: 'Actor.a1',
        status: 'committed',
        delta: 5,
        reason: 'Helped the shop',
        createdAt: Date.now(),
      },
    ],
  });
  const adjustCalls = [];
  const app = new MarketManager({
    deps: {
      store,
      isGM: () => true,
      systemId: () => 'dnd5e',
      getActor: async () => ({ id: 'a1', uuid: 'Actor.a1' }),
      getReputation: async () => ({ score: 5, band: { title: 'Friendly' }, individual: 5, party: 0 }),
      adjustReputation: async (params) => {
        adjustCalls.push(params);
        return { status: 'committed' };
      },
    },
  });
  app._data.selectedShopId = 'shop1';
  app._data.selectedReputationActorId = 'a1';
  app.render = async () => {};
  app.element = {
    querySelector: (sel) => {
      if (sel === '[name="reputationDelta"]') return { value: '5' };
      if (sel === '[name="reputationReason"]') return { value: 'Helped the shop' };
      return null;
    },
  };
  await app._onAdjustReputation({}, {}, {});
  assert.equal(adjustCalls.length, 1, 'adjust invoked once');
  const params = adjustCalls[0];
  assert.equal(params.shopId, 'shop1');
  assert.equal(params.scope, 'actor');
  assert.equal(params.subjectId, 'Actor.a1');
  assert.equal(params.delta, 5);
  assert.equal(params.reason, 'Helped the shop');
  assert.ok(params.requestId, 'fresh idempotency requestId supplied');
  assert.equal(app._data.notice, '', 'no notice on a committed adjust');
  assert.equal(app._data.selectedReputation.score, 5, 'reputation reloaded after the adjust');
  assert.equal(app._data.reputationHistory.length, 1, 'committed history reloaded');
  assert.equal(app._data.reputationHistory[0].reason, 'Helped the shop');
});

test('manager reputation adjust rejects a zero delta and a missing reason without invoking the API', async () => {
  const store = makeM3Store({
    shops: [{ id: 'shop1', name: 'S', inventory: [], social: {} }],
  });
  let adjustCalls = 0;
  const app = new MarketManager({
    deps: {
      store,
      isGM: () => true,
      systemId: () => 'dnd5e',
      adjustReputation: async () => {
        adjustCalls++;
        return { status: 'committed' };
      },
    },
  });
  app._data.selectedShopId = 'shop1';
  app._data.selectedReputationActorId = 'a1';
  app.render = async () => {};
  app.element = {
    querySelector: (sel) => {
      if (sel === '[name="reputationDelta"]') return { value: '0' };
      if (sel === '[name="reputationReason"]') return { value: 'No reason' };
      return null;
    },
  };
  await app._onAdjustReputation({}, {}, {});
  assert.equal(adjustCalls, 0, 'no adjust call for a zero delta');
  assert.equal(app._data.notice, 'Adjustment must be a non-zero whole number.');
  app.element = {
    querySelector: (sel) => {
      if (sel === '[name="reputationDelta"]') return { value: '5' };
      if (sel === '[name="reputationReason"]') return { value: '   ' };
      return null;
    },
  };
  await app._onAdjustReputation({}, {}, {});
  assert.equal(adjustCalls, 0, 'no adjust call for a missing reason');
  assert.equal(app._data.notice, 'A reason is required for a reputation adjustment.');
});

// ---- M3: storefront personalized quote / privacy / refusal / staleness ---------

test('storefront actor switch requests a personalized catalog and clears stale per-actor data', async () => {
  const sent = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      hasActiveGM: () => true,
      request: async (payload) => {
        sent.push(payload);
        return null;
      },
    },
  });
  app.render = async () => {};
  app._data.actors = [{ id: 'a1', name: 'A' }, { id: 'a2', name: 'B' }];
  app._data.selectedActorId = 'a1';
  app._data.relationship = { score: 5, title: 'Friendly', individual: 5, party: 0 };
  app._data.merchants = [{ name: 'Mira' }];
  app._data.inventory = [{ id: 'e1', price: 10 }];
  app._data.selectedEntryId = 'e1';
  await app._onSelectActor({}, { value: 'a2' }, {});
  assert.equal(app._data.selectedActorId, 'a2');
  assert.equal(app._data.relationship, null, 'relationship cleared on switch');
  assert.equal(app._data.merchants.length, 0, 'merchants cleared on switch');
  assert.equal(app._data.inventory.length, 0, 'stale catalog cleared on switch');
  assert.equal(app._data.selectedEntryId, null, 'detail cleared on switch');
  assert.ok(sent.length >= 1, 'a catalog request was issued');
  const last = sent[sent.length - 1];
  assert.equal(last.type, 'catalog');
  assert.equal(last.actorId, 'a2', 'personalized actorId sent');
});

test('storefront catalog response rejects a stale actor echo and applies a matching one', async () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: { isGM: () => true } });
  app._loaded = true;
  // A no-op render keeps the response handler from calling `_onRender` (which
  // iterates `game.actors`) as stray async activity after the test ends.
  app.render = async () => {};
  app._pendingCatalogRequestId = 'cat-2';
  app._data.selectedActorId = 'a2';
  app._data.shop = null;
  const stale = {
    flags: {
      market: {
        type: 'response',
        response: {
          requestId: 'cat-2',
          actorId: 'a1',
          shopId: 'shop1',
          type: 'catalog',
          shop: { id: 'shop1', name: 'Old' },
          inventory: [],
        },
      },
    },
  };
  await app._onChatMessage(stale, {}, 'gm1');
  assert.equal(app._data.shop, null, 'a different-actor response is ignored');
  assert.equal(app._pendingCatalogRequestId, 'cat-2', 'pending catalog request preserved');
  const match = {
    flags: {
      market: {
        type: 'response',
        response: {
          requestId: 'cat-2',
          actorId: 'a2',
          shopId: 'shop1',
          type: 'catalog',
          shop: { id: 'shop1', name: 'New' },
          inventory: [{ id: 'e1' }],
          merchants: [],
          relationship: { score: 5, title: 'Friendly', individual: 5, party: 0 },
        },
      },
    },
  };
  await app._onChatMessage(match, {}, 'gm1');
  assert.equal(app._data.shop.name, 'New', 'a matching-actor response is applied');
  assert.equal(app._pendingCatalogRequestId, null);
});

test('storefront _prepareContext derives priceLines and relationship modifierText without private data', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app._data.shop = { id: 'shop1', appearance: {} };
  const priceBreakdown = {
    quantity: 1,
    unitBase: 100,
    baseTotal: 100,
    shopBps: 1500,
    personalityBps: 0,
    reputationBps: 4000,
    haggleBps: 0,
    adjustmentBps: 5500,
    unitPrice: 155,
    total: 155,
    band: { title: 'Hated', threshold: -100 },
    refused: true,
  };
  app._data.inventory = [
    {
      id: 'e1',
      name: 'Potion',
      category: 'C',
      price: 100,
      quantity: 1,
      stockMode: 'finite',
      canBuy: false,
      priceBreakdown,
      system: { value: 1 },
      itemUuid: 'Compendium.a.Item.x',
    },
  ];
  app._data.relationship = { score: -100, title: 'Hated', individual: -100, party: 0 };
  const ctx = app._prepareContext();
  const lines = ctx.inventory[0].priceLines;
  assert.ok(Array.isArray(lines), 'priceLines derived from the breakdown');
  const byLabel = Object.fromEntries(lines.map((l) => [l.label, l.value]));
  assert.equal(byLabel['Base price'], '100');
  assert.equal(byLabel['Shop adjustment'], '+15%');
  assert.equal(byLabel['Reputation adjustment'], '+40%');
  assert.equal(byLabel['Total adjustment'], '+55%');
  assert.equal(byLabel['Final price'], '155');
  assert.equal(ctx.relationship.title, 'Hated');
  assert.equal(ctx.relationship.score, -100);
  assert.ok(ctx.relationship.modifierText.includes('Hated'), 'modifierText derived from the band');
  assert.ok(ctx.relationship.modifierText.includes('+40%'), 'modifierText reflects the quote');
  assert.ok(!('partyId' in ctx.relationship), 'no private party id leaked');
  assert.ok(!('priceLines' in app._data.inventory[0]), 'raw inventory entry untouched');
});

test('storefront rejects a purchase on a canBuy false (Hated) entry', async () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: { hasActiveGM: () => true } });
  app._data.selectedActorId = 'a1';
  app._data.inventory = [{ id: 'e1', canBuy: false }];
  let sent = null;
  app._request = (payload) => {
    sent = payload;
    return Promise.resolve(null);
  };
  app.render = async () => {};
  app._requestPurchase('e1');
  await Promise.resolve();
  assert.equal(sent, null, 'no purchase request sent');
  assert.ok(app._data.feedback.includes('refuses'), 'refusal feedback surfaced');
});

test('storefront maps a service-refused purchase error to a readable message', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  const text = app._purchaseErrorText({ status: 'failed', error: 'service-refused' });
  assert.ok(text.includes('standing'), 'service-refused mapped to a readable message');
});

test('storefront still purchases a personalized canBuy entry (M1 flow intact)', async () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: { hasActiveGM: () => true } });
  app._data.selectedActorId = 'a1';
  app._data.inventory = [{ id: 'e1', canBuy: true, priceBreakdown: null }];
  let sent = null;
  app._readQuantity = () => 2;
  app._request = (payload) => {
    sent = payload;
    return Promise.resolve(null);
  };
  app.render = async () => {};
  app._requestPurchase('e1');
  await Promise.resolve();
  assert.ok(sent, 'a canBuy entry is purchased');
  assert.equal(sent.entryId, 'e1');
  assert.equal(sent.quantity, 2);
  assert.equal(sent.actorId, 'a1');
});

test('shop template disables the catalog Buy button on a Hated canBuy false entry', () => {
  const template = readFileSync(new URL('../templates/shop.hbs', import.meta.url), 'utf8');
  const cardButton = template.match(/data-action="buy" data-entry-id="\{\{entry\.id\}\}"[^>]*>/);
  assert.ok(cardButton, 'product-card Buy button found in the shop template');
  assert.match(cardButton[0], /entry\.canBuy/, 'card button disables on a canBuy false entry');
});

// ---- M3 final blockers: blank actor UX + staleness + remove-npc sync ---------

test('storefront initial auto-select picks the first owned actor exactly once on first render', async () => {
  const sent = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      hasActiveGM: () => true,
      ownedActors: () => [{ id: 'a1', name: 'A' }, { id: 'a2', name: 'B' }],
      request: async (payload) => {
        sent.push(payload);
        return null;
      },
    },
  });
  app.element = null;
  await app._onRender({});
  assert.equal(app._data.selectedActorId, 'a1', 'first owned actor auto-selected on first render');
  assert.ok(sent.length >= 1, 'a catalog request was issued');
  assert.equal(sent[sent.length - 1].actorId, 'a1', 'catalog requested for the auto-selected actor');
  // A later render (choice already made) does not re-run the auto-select.
  await app._onRender({});
  assert.equal(app._data.selectedActorId, 'a1', 'a later render does not re-select');
});

test('storefront an explicit blank actor selection stays blank and requests the base catalog', async () => {
  const sent = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      hasActiveGM: () => true,
      ownedActors: () => [{ id: 'a1', name: 'A' }],
      request: async (payload) => {
        sent.push(payload);
        return null;
      },
    },
  });
  app.element = null;
  // The player explicitly chose no character (blank/null). This must survive a
  // re-render (no auto-select) and request the base public catalog.
  app._data.selectedActorId = null;
  await app._onRender({});
  assert.equal(app._data.selectedActorId, null, 'an explicit blank stays blank through render');
  assert.ok(sent.length >= 1, 'a catalog request was issued');
  assert.equal(sent[sent.length - 1].actorId, null, 'base public catalog requested (no rep leak)');
});

test('storefront catalog request uses the data actor snapshot, not a stale DOM actor select', async () => {
  const sent = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      hasActiveGM: () => true,
      request: async (payload) => {
        sent.push(payload);
        return null;
      },
    },
  });
  app.render = async () => {};
  app._data.actors = [{ id: 'a1', name: 'A' }, { id: 'a2', name: 'B' }];
  app._data.selectedActorId = 'a2';
  // The actor `<select>` still holds the OLD actor (a1) from before a switch;
  // the catalog request must use the data snapshot, never the DOM value.
  app.element = {
    querySelector: (sel) => (sel === '[name="actorId"]' ? { type: 'select-one', value: 'a1' } : null),
    querySelectorAll: () => [],
  };
  await app._requestCatalog();
  assert.ok(sent.length >= 1, 'a catalog request was issued');
  assert.equal(sent[sent.length - 1].actorId, 'a2', 'uses the data actor, not the stale DOM value');
});

test('storefront correlation matches the data actor even when the DOM actor select is stale', async () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: { isGM: () => true } });
  app._loaded = true;
  app.render = async () => {};
  app._pendingCatalogRequestId = 'cat-9';
  app._data.selectedActorId = 'a2';
  app._data.shop = null;
  // The actor select still reports a1 while the data actor is a2.
  app.element = {
    querySelector: (sel) => (sel === '[name="actorId"]' ? { type: 'select-one', value: 'a1' } : null),
  };
  const stale = {
    flags: {
      market: {
        type: 'response',
        response: {
          requestId: 'cat-9',
          actorId: 'a1',
          shopId: 'shop1',
          type: 'catalog',
          shop: { id: 'shop1', name: 'Old' },
          inventory: [],
        },
      },
    },
  };
  await app._onChatMessage(stale, {}, 'gm1');
  assert.equal(app._data.shop, null, 'a stale-DOM actor response is rejected');
  assert.equal(app._pendingCatalogRequestId, 'cat-9', 'pending catalog request preserved');
  const match = {
    flags: {
      market: {
        type: 'response',
        response: {
          requestId: 'cat-9',
          actorId: 'a2',
          shopId: 'shop1',
          type: 'catalog',
          shop: { id: 'shop1', name: 'New' },
          inventory: [],
        },
      },
    },
  };
  await app._onChatMessage(match, {}, 'gm1');
  assert.equal(app._data.shop.name, 'New', 'a response for the data actor is accepted');
  assert.equal(app._pendingCatalogRequestId, null);
});

test('manager remove-npc promotes the new primary and syncs social primary personality', async () => {
  const store = makeM3Store({
    shops: [
      {
        id: 'shop1',
        name: 'S',
        owner: 'Mira',
        inventory: [],
        social: { primaryPersonality: 'greedy', individualWeight: 70, partyWeight: 30 },
        npcs: [
          baseNpc('Mira', { personality: 'greedy' }),
          baseNpc('Tavi', { personality: 'honest' }),
          baseNpc('Nia', { personality: 'generous' }),
        ],
      },
    ],
  });
  const app = new MarketManager({
    deps: { store, isGM: () => true, systemId: () => 'dnd5e' },
  });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await app._onRemoveNpc({}, { dataset: { npcId: 'npc-Mira' } }, {});
  assert.equal(store._calls.length, 1, 'a reassignment patch was written');
  const { patch } = store._calls[0];
  assert.equal(patch.npcs[0].name, 'Tavi', 'remaining merchant promoted in order');
  assert.equal(patch.owner, 'Tavi', 'owner reassigned to the new primary');
  assert.equal(patch.social.primaryPersonality, 'honest', 'social primary synced to the new primary personality');
  assert.equal(patch.social.individualWeight, 70, 'other social fields preserved');
  assert.equal(patch.social.partyWeight, 30, 'other social fields preserved');
});

test('manager remove-npc keeps the shop social primary unchanged when no merchants remain', async () => {
  const store = makeM3Store({
    shops: [
      {
        id: 'shop1',
        name: 'S',
        owner: 'Mira',
        inventory: [],
        social: { primaryPersonality: 'greedy', individualWeight: 70, partyWeight: 30 },
        npcs: [baseNpc('Mira', { personality: 'greedy' })],
      },
    ],
  });
  const app = new MarketManager({
    deps: { store, isGM: () => true, systemId: () => 'dnd5e' },
  });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await app._onRemoveNpc({}, { dataset: { npcId: 'npc-Mira' } }, {});
  assert.equal(store._calls.length, 1, 'a reassignment patch was written');
  const { patch } = store._calls[0];
  assert.equal(patch.npcs.length, 0, 'roster emptied');
  assert.equal(patch.owner, '', 'owner blanked when no merchants remain');
  assert.ok(!('social' in patch), 'no social patch when the roster is empty (primary left unchanged)');
});

// ---- M3 repair: reputation actor selector uses the native change event ---------

test('manager reputation actor change event loads the actor score and history', async () => {
  const store = makeM3Store({
    shops: [{ id: 'shop1', name: 'S', owner: '', npcs: [], inventory: [], social: {} }],
    events: [
      {
        shopId: 'shop1',
        scope: 'actor',
        subjectId: 'Actor.a2',
        status: 'committed',
        delta: 7,
        reason: 'Great customer',
        createdAt: Date.now(),
      },
    ],
  });
  const app = new MarketManager({
    deps: {
      store,
      isGM: () => true,
      systemId: () => 'dnd5e',
      listActors: () => [
        { id: 'a1', name: 'A', uuid: 'Actor.a1' },
        { id: 'a2', name: 'B', uuid: 'Actor.a2' },
      ],
      getActor: async (id) => ({ id, uuid: `Actor.${id}` }),
      getReputation: async (_shopId, actorId) => ({
        score: actorId === 'a2' ? 7 : 0,
        band: { title: actorId === 'a2' ? 'Friendly' : 'Neutral' },
        individual: actorId === 'a2' ? 7 : 0,
        party: 0,
      }),
    },
  });
  app._data.selectedShopId = 'shop1';
  app._loaded = true;
  let rendered = false;
  app.render = async () => {
    rendered = true;
  };
  const listeners = {};
  let addCount = 0;
  const select = {
    value: '',
    addEventListener(type, fn) {
      addCount++;
      listeners[type] = fn;
    },
  };
  app.element = {
    querySelector: (sel) => (sel === '[name="reputationActorId"]' ? select : null),
    querySelectorAll: () => [],
  };
  // Bind once via _onRender; a second render on the same node must not stack.
  await app._onRender({});
  assert.equal(addCount, 1, 'change listener bound once');
  await app._onRender({});
  assert.equal(addCount, 1, 'no stacked change listener on the same node');
  // The actor `<select>` change event drives the selection (no data-action click).
  select.value = 'a2';
  await listeners.change();
  assert.equal(app._data.selectedReputationActorId, 'a2', 'actor selection captured from the select value');
  assert.equal(app._data.selectedReputation.score, 7, 'actor effective score loaded');
  assert.equal(app._data.selectedReputation.title, 'Friendly');
  assert.equal(app._data.selectedReputation.individual, 7);
  assert.equal(app._data.reputationHistory.length, 1, 'committed history loaded');
  assert.equal(app._data.reputationHistory[0].reason, 'Great customer');
  assert.equal(rendered, true, 'selection re-rendered with the actor record');
});
