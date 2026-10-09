// Unit tests for the M1 UI wiring and the model/request correlation fixes.
//
// The UI modules reference `foundry.applications.api` at class-definition time,
// so a minimal mock is installed before they are imported. No live Foundry
// runtime is required.

import { test } from 'node:test';
import assert from 'node:assert/strict';

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
globalThis.Hooks = { on() {}, off() {} };
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
    listShops: async () => shops,
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
  };
  const tr = {
    dataset: { entryId },
    querySelector: (sel) => fields[sel] || null,
  };
  return { closest: () => tr, dataset: tr.dataset };
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
