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

function makePersistentShopStore(shops, locations = []) {
  const map = new Map();
  for (const s of shops) map.set(s.id, structuredClone(s));
  return {
    _shops: map,
    _locations: locations,
    listLocations: async () => structuredClone(locations),
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

// A fake inventory row that additionally carries the M4 per-entry stock
// visibility and restock controls. The manager only reads these when the row
// actually exposes them, so this helper is used only by the M4 entry tests.
function fakeTrM4(entryId, values = {}) {
  const base = fakeTr(entryId, values);
  const tr = base.closest();
  const origQ = tr.querySelector;
  const m4 = {
    '[name="stockVisibility"]': { value: values.stockVisibility ?? 'exact' },
    '[name="restockEnabled"]': {
      type: 'checkbox',
      checked: values.restockEnabled ?? false,
    },
    '[name="restockTarget"]': {
      type: 'number',
      value: String(values.restockTarget ?? 1),
    },
    '[name="restockAnchorTime"]': {
      type: 'number',
      value: String(values.restockAnchorTime ?? 0),
    },
    '[name="restockIntervalSeconds"]': {
      type: 'number',
      value: String(values.restockIntervalSeconds ?? 86400),
    },
  };
  tr.querySelector = (sel) => m4[sel] || origQ(sel);
  return base;
}

// ---- M4 automation editor form fakes --------------------------------------------

// A minimal fake DOM element whose `querySelector`/`querySelectorAll` resolve
// only the named selectors a test wires. `querySelectorAll` returns the value
// for a selector only when the test stored an array there.
function fakeElement(selectors = {}) {
  return {
    querySelector: (sel) => selectors[sel] || null,
    querySelectorAll: (sel) => (Array.isArray(selectors[sel]) ? selectors[sel] : []),
  };
}

function fakeCheckbox({ checked = false, value = '' } = {}) {
  return { type: 'checkbox', checked, value };
}

function fakeNumber(value) {
  return { type: 'number', value: String(value ?? '') };
}

function fakeTextField(value) {
  return { type: 'text', value: String(value ?? '') };
}

function fakeSelect(value) {
  return { type: 'select', value: String(value ?? '') };
}

function fakeTextarea(value) {
  return { type: 'textarea', value: String(value ?? '') };
}

function fakeHoursCard(values = {}) {
  const dayFields = (values.days || []).map(([value, checked]) =>
    fakeCheckbox({ checked, value: String(value) })
  );
  return fakeElement({
    '[name="hoursEnabled"]': fakeCheckbox({ checked: values.enabled !== false }),
    '[name="hoursDay"]': dayFields,
    '[name="openMinute"]': fakeNumber(values.openMinute ?? 0),
    '[name="closeMinute"]': fakeNumber(values.closeMinute ?? 0),
  });
}

function fakeTravelCard(values = {}) {
  const locFields = (values.locationIds || []).map((id) =>
    fakeCheckbox({ checked: true, value: String(id) })
  );
  return fakeElement({
    '[name="travelEnabled"]': fakeCheckbox({ checked: values.enabled !== false }),
    '[name="travelLocationId"]': locFields,
    '[name="travelAnchorTime"]': fakeNumber(values.anchorTime ?? 0),
    '[name="travelIntervalSeconds"]': fakeNumber(values.intervalSeconds ?? 86400),
  });
}

function fakeEventEditor(event) {
  const el = fakeElement({
    '[name="eventTitle"]': fakeTextField(event.title ?? ''),
    '[name="eventDescription"]': fakeTextarea(event.description ?? ''),
    '[name="eventStartAt"]': fakeNumber(event.startAt ?? 0),
    '[name="eventEndAt"]': fakeNumber(event.endAt ?? 1),
    '[name="eventVisible"]': fakeCheckbox({ checked: event.visible === true }),
  });
  el.dataset = { eventId: String(event.id) };
  return el;
}

function fakeEventList(editors) {
  return fakeElement({
    '.event-editor-list [data-event-id]': editors,
  });
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

// ---- M5 commerce/special/service editor form fakes --------------------------------

// A fake `.commerce-panel` element exposing only the top-level commerce fields the
// manager reads on save (funds, rates, preorders, theft). `querySelector` returns
// null for a field that is not wired, so a test can omit a control to exercise the
// concrete fallback (e.g. an empty merchantFunds field).
function fakeCommercePanel(values = {}) {
  const checks = {
    '[name="unlimitedFunds"]': fakeCheckbox({ checked: values.unlimitedFunds === true }),
    '[name="preordersEnabled"]': fakeCheckbox({ checked: values.preordersEnabled === true }),
    '[name="theftEnabled"]': fakeCheckbox({ checked: values.theftEnabled === true }),
  };
  const nums = {
    '[name="merchantFunds"]': fakeNumber(values.merchantFunds ?? 0),
    '[name="buyRateBps"]': fakeNumber(values.buyRateBps ?? 0),
    '[name="buybackRateBps"]': fakeNumber(values.buybackRateBps ?? 0),
    '[name="depositBps"]': fakeNumber(values.depositBps ?? 0),
    '[name="maxPerActor"]': fakeNumber(values.maxPerActor ?? 1),
  };
  return fakeElement({ ...checks, ...nums });
}

// A fake service editor row. The manager reads `[data-service-id]` rows via
// `querySelectorAll`; each row must expose `dataset.serviceId` and the named inputs.
function fakeServiceRow(serviceId, values = {}) {
  const row = fakeElement({
    '[name="serviceName"]': fakeTextField(values.name ?? ''),
    '[name="serviceDescription"]': fakeTextarea(values.description ?? ''),
    '[name="servicePrice"]': fakeNumber(values.price ?? 0),
    '[name="serviceVisible"]': fakeCheckbox({ checked: values.visible !== false }),
    '[name="serviceEnabled"]': fakeCheckbox({ checked: values.enabled !== false }),
  });
  row.dataset = { serviceId: String(serviceId) };
  return row;
}

// A fake special editor row, mirroring the service row but with the special fields.
function fakeSpecialRow(specialId, values = {}) {
  const row = fakeElement({
    '[name="specialTitle"]': fakeTextField(values.title ?? ''),
    '[name="specialDescription"]': fakeTextarea(values.description ?? ''),
    '[name="specialPrice"]': fakeNumber(values.price ?? 0),
    '[name="specialVisible"]': fakeCheckbox({ checked: values.visible !== false }),
    '[name="specialEntryId"]': fakeSelect(values.entryId ?? ''),
    '[name="specialActorUuids"]': fakeTextField(values.actorUuids ?? ''),
  });
  row.dataset = { specialId: String(specialId) };
  return row;
}

// A fake inventory row that additionally carries the M5 access gate controls
// (backroom mode, actor UUIDs, minimum reputation). The manager only reads these
// when the row actually exposes them, so this helper is used only by the M5
// access-gate entry tests. Setting `withMinReputation: false` omits the
// accessMinReputation control so the persisted value is preserved.
function fakeTrAccess(entryId, values = {}) {
  const base = fakeTr(entryId, values);
  const tr = base.closest();
  const origQ = tr.querySelector;
  const access = {
    '[name="accessMode"]': fakeSelect(values.accessMode ?? 'public'),
    '[name="accessActorUuids"]': fakeTextField(values.accessActorUuids ?? ''),
  };
  if (values.withMinReputation !== false) {
    access['[name="accessMinReputation"]'] = fakeNumber(values.accessMinReputation ?? 0);
  }
  tr.querySelector = (sel) => access[sel] || origQ(sel);
  return base;
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
        { id: 'e1', name: 'A', itemUuid: 'Item.a1', price: 10, quantity: 10, stockMode: 'finite' },
        { id: 'e2', name: 'B', itemUuid: 'Item.a2', price: 20, quantity: 20, stockMode: 'finite' },
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
        inventory: [{ id: 'e1', name: 'Potion', itemUuid: 'Item.p1', price: 10, quantity: 1, stockMode: 'finite' }],
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
        { id: 'e1', name: 'Potion', itemUuid: 'Item.p1', price: 10, quantity: 10, stockMode: 'finite' },
        { id: 'e2', name: 'Bread', itemUuid: 'Item.p2', price: 20, quantity: 20, stockMode: 'finite' },
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
        inventory: [{ id: 'e1', name: 'Potion', itemUuid: 'Item.p1', price: 10, quantity: 1, stockMode: 'finite' }],
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
  assert.match(attrs, /available/, 'detail button disables for out-of-stock entries');
  assert.match(attrs, /canBuy/, 'detail button disables for a Hated/unavailable entry');
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

test('runtime api.quotePrice returns null for an inaccessible backroom to a player but quotes it for the GM', async () => {
  const modules = {};
  globalThis.game.modules = { get: (id) => (modules[id] || (modules[id] = {})) };
  globalThis.game.settings = { register: () => {}, registerMenu: () => {} };
  globalThis.game.journal = { filter: () => [], get: () => null };

  await import('../src/core/main.js');
  fireHook('init');

  const api = globalThis.game.modules.get('market').api;
  const shop = {
    id: 's1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    social: { primaryPersonality: 'honest', shopMarkupBps: 0, individualWeight: 70, partyWeight: 30, partyId: '' },
    inventory: [
      { id: 'backroom', name: 'Secret', price: 100, quantity: 5, visible: true, access: { mode: 'backroom', actorUuids: ['Actor.alice'], minReputation: -100 } },
      { id: 'public', name: 'Open', price: 50, quantity: 5, visible: true },
    ],
  };
  const owner = { id: 'a1', uuid: 'Actor.bob', testUserPermission: () => true };
  const stranger = { id: 'a2', uuid: 'Actor.alice', testUserPermission: () => false };
  const origActors = globalThis.game.actors;
  globalThis.game.actors = { get: (id) => (id === 'a1' ? owner : id === 'a2' ? stranger : null) };
  const { store } = await import('../src/storage/store.js');
  const origFindShop = store.findShop;
  store.findShop = async () => shop;
  try {
    // Non-GM player owns a1 (Actor.bob) but is not allowlisted for the backroom.
    globalThis.game.user = { id: 'u1', isGM: false };
    assert.equal(await api.quotePrice('s1', 'backroom', 'a1', 1), null, 'a player cannot quote an inaccessible backroom');
    assert.ok(await api.quotePrice('s1', 'public', 'a1', 1), 'a player can quote a public entry');
    // The GM may quote any entry, including the inaccessible backroom.
    globalThis.game.user = { id: 'gm1', isGM: true };
    const gmBackroom = await api.quotePrice('s1', 'backroom', 'a1', 1);
    assert.ok(gmBackroom, 'the GM may quote an inaccessible backroom');
    assert.equal(gmBackroom.unitPrice, 100);
    // A nonowned actor cannot probe either entry (returns null before any rep read).
    globalThis.game.user = { id: 'u1', isGM: false };
    assert.equal(await api.quotePrice('s1', 'backroom', 'a2', 1), null, 'a nonowned actor cannot probe the backroom');
    assert.equal(await api.quotePrice('s1', 'public', 'a2', 1), null, 'a nonowned actor cannot probe a public entry');
  } finally {
    store.findShop = origFindShop;
    globalThis.game.actors = origActors;
  }
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

// ---- M4: GM automation editor (hours / travel / events / diagnostics) ----------

test('manager derives the M4 automation editor context from the selected shop', async () => {
  const store = makePersistentShopStore(
    [
      {
        id: 'shop1',
        name: 'S',
        locationId: 'loc1',
        open: true,
        inventory: [],
        automation: {
          hours: { enabled: true, days: [0, 2], openMinute: 480, closeMinute: 960 },
          travel: { enabled: true, locationIds: ['loc1', 'loc2'], anchorTime: 100, intervalSeconds: 86400, lastCycle: 5 },
          events: [
            { id: 'ev1', title: 'Bazaar', description: 'Big sale', startAt: 100, endAt: 200, visible: true },
            { id: 'ev2', title: 'Hidden', description: '', startAt: 300, endAt: 400, visible: false },
          ],
          diagnostics: { lastRunAt: 1700000000, lastStatus: 'ok', lastError: '', lastRestocked: 3, lastLocationId: 'loc1' },
        },
      },
    ],
    [
      { id: 'loc1', name: 'Town' },
      { id: 'loc2', name: 'Road' },
    ]
  );
  const app = new MarketManager({
    deps: {
      store,
      systemId: () => 'dnd5e',
      isGM: () => true,
      isActiveGM: () => true,
      listTables: async () => [
        { uuid: 'Table.loot', name: 'Loot' },
        { uuid: 'Table.trash', name: 'Trash' },
      ],
      listActors: () => [],
    },
  });
  await app._refreshData();
  const ctx = app._prepareContext();
  // weekday checkerboard reflects the declared open days
  assert.equal(ctx.weekdays.length, 7, 'seven weekday rows');
  assert.equal(ctx.weekdays[0].selected, true, 'Monday selected');
  assert.equal(ctx.weekdays[1].selected, false, 'Tuesday not selected');
  assert.equal(ctx.weekdays[2].selected, true, 'Wednesday selected');
  assert.deepEqual(
    ctx.weekdays.map((d) => ({ id: d.id, label: d.label })),
    [
      { id: 0, label: 'Monday' },
      { id: 1, label: 'Tuesday' },
      { id: 2, label: 'Wednesday' },
      { id: 3, label: 'Thursday' },
      { id: 4, label: 'Friday' },
      { id: 5, label: 'Saturday' },
      { id: 6, label: 'Sunday' },
    ],
    'weekday ids/labels in canonical order'
  );
  // travel options are projected from the live location list
  assert.equal(ctx.travelLocationOptions.length, 2);
  assert.equal(ctx.travelLocationOptions[0].id, 'loc1');
  assert.equal(ctx.travelLocationOptions[0].selected, true);
  assert.equal(ctx.travelLocationOptions[1].id, 'loc2');
  assert.equal(ctx.travelLocationOptions[1].selected, true);
  // event rows carry the world-time window as numbers
  assert.equal(ctx.eventRows.length, 2);
  assert.equal(ctx.eventRows[0].id, 'ev1');
  assert.equal(ctx.eventRows[0].startAt, 100);
  assert.equal(ctx.eventRows[0].endAt, 200);
  assert.equal(ctx.eventRows[0].visible, true);
  assert.equal(ctx.eventRows[1].visible, false);
  // draw tables are the injected list, never a raw document
  assert.equal(ctx.drawTables.length, 2);
  assert.equal(ctx.drawTables[0].uuid, 'Table.loot');
  assert.equal(ctx.drawTables[1].name, 'Trash');
  // diagnostics are sanitized (formatted date + status, no raw record)
  assert.equal(ctx.automationDiagnostics.lastStatus, 'ok');
  assert.equal(ctx.automationDiagnostics.lastRestocked, 3);
  assert.equal(ctx.automationDiagnostics.lastLocationId, 'loc1');
  assert.equal(ctx.automationDiagnostics.lastRunAt, '2023-11-14 22:13');
  assert.equal(ctx.automationDiagnostics.lastError, '');
  assert.equal(ctx.isActiveGM, true, 'active-GM flag derived from deps');
});

test('manager save-hours patches only automation.hours with normalized values', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    automation: {
      hours: { enabled: false, days: [1, 3], openMinute: 0, closeMinute: 0 },
      travel: { enabled: true, locationIds: ['loc1', 'loc2'], anchorTime: 10, intervalSeconds: 86400, lastCycle: 2 },
      events: [{ id: 'ev1', title: 'T', description: '', startAt: 1, endAt: 2, visible: true }],
      diagnostics: { lastRunAt: 1, lastStatus: 'ok', lastError: '', lastRestocked: 5, lastLocationId: 'loc1' },
    },
  };
  const { app, store } = (() => {
    const s = makePersistentShopStore([shop]);
    const a = new MarketManager({ deps: { store: s, systemId: () => 'dnd5e', isGM: () => true } });
    a._data.selectedShopId = 'shop1';
    a._refreshData = async () => {};
    a.render = async () => {};
    a.element = { querySelector: (sel) => (sel === '.automation-hours' ? fakeHoursCard({ enabled: true, days: [[0, true], [2, true]], openMinute: 600, closeMinute: 1020 }) : null) };
    return { app: a, store: s };
  })();
  await app._onSaveHours({}, {}, {});
  const saved = store._shops.get('shop1');
  assert.equal(saved.automation.hours.enabled, true);
  assert.deepEqual(saved.automation.hours.days, [0, 2], 'checked weekdays in DOM order');
  assert.equal(saved.automation.hours.openMinute, 600);
  assert.equal(saved.automation.hours.closeMinute, 1020);
  // travel/events/diagnostics preserved
  assert.equal(saved.automation.travel.locationIds[0], 'loc1');
  assert.equal(saved.automation.travel.lastCycle, 2);
  assert.equal(saved.automation.events[0].id, 'ev1');
  assert.equal(saved.automation.diagnostics.lastRestocked, 5);
});

test('manager save-hours surfaces an invalid minute without writing', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    automation: { hours: { enabled: false, days: [], openMinute: 0, closeMinute: 0 } },
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  app._data.selectedShopId = 'shop1';
  let rendered = 0;
  app.render = async () => {
    rendered += 1;
  };
  app._refreshData = async () => {};
  app.element = {
    querySelector: (sel) =>
      sel === '.automation-hours' ? fakeHoursCard({ enabled: true, days: [[0, true]], openMinute: 2000, closeMinute: 0 }) : null,
  };
  await app._onSaveHours({}, {}, {});
  assert.match(app._data.notice, /between 0 and 1439/, 'invalid minute surfaced in the notice');
  assert.equal(store._shops.get('shop1').automation.hours.openMinute, 0, 'no write on invalid hours');
  assert.ok(rendered > 0, 'error path re-renders to keep the unsaved form');
});

test('manager save-travel patches only automation.travel and preserves the shop location', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    automation: {
      hours: { enabled: false, days: [], openMinute: 0, closeMinute: 0 },
      travel: { enabled: false, locationIds: [], anchorTime: 0, intervalSeconds: 86400, lastCycle: -1 },
    },
  };
  const store = makePersistentShopStore(
    [shop],
    [
      { id: 'loc1', name: 'Town' },
      { id: 'loc2', name: 'Road' },
      { id: 'loc3', name: 'Camp' },
    ]
  );
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  app.element = {
    querySelector: (sel) =>
      sel === '.automation-travel'
        ? fakeTravelCard({ enabled: true, locationIds: ['loc1', 'loc3'], anchorTime: 42, intervalSeconds: 7200 })
        : null,
  };
  await app._onSaveTravel({}, {}, {});
  const saved = store._shops.get('shop1');
  assert.equal(saved.automation.travel.enabled, true);
  assert.deepEqual(saved.automation.travel.locationIds, ['loc1', 'loc3']);
  assert.equal(saved.automation.travel.anchorTime, 42);
  assert.equal(saved.automation.travel.intervalSeconds, 7200);
  assert.equal(saved.automation.travel.lastCycle, -1, 'identity changed -> lastCycle reset');
  assert.equal(saved.locationId, 'loc1', 'shop base location untouched until the runner moves it');
});

test('manager save-travel preserves lastCycle when the schedule identity is unchanged', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    automation: {
      hours: { enabled: false, days: [], openMinute: 0, closeMinute: 0 },
      travel: {
        enabled: true,
        locationIds: ['loc1', 'loc2'],
        anchorTime: 42,
        intervalSeconds: 7200,
        lastCycle: 3,
      },
    },
  };
  const store = makePersistentShopStore(
    [shop],
    [
      { id: 'loc1', name: 'Town' },
      { id: 'loc2', name: 'Road' },
    ]
  );
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  app.element = {
    querySelector: (sel) =>
      sel === '.automation-travel'
        ? fakeTravelCard({ enabled: true, locationIds: ['loc1', 'loc2'], anchorTime: 42, intervalSeconds: 7200 })
        : null,
  };
  await app._onSaveTravel({}, {}, {});
  assert.equal(store._shops.get('shop1').automation.travel.lastCycle, 3, 'unchanged schedule keeps lastCycle');
});

test('manager save-travel rejects an unknown destination without writing', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
  };
  const store = makePersistentShopStore(
    [shop],
    [
      { id: 'loc1', name: 'Town' },
      { id: 'loc2', name: 'Road' },
    ]
  );
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  app.element = {
    querySelector: (sel) =>
      sel === '.automation-travel'
        ? fakeTravelCard({ enabled: true, locationIds: ['loc1', 'locX'], anchorTime: 10, intervalSeconds: 7200 })
        : null,
  };
  await app._onSaveTravel({}, {}, {});
  assert.match(app._data.notice, /Unknown travel destination: locX/);
  assert.equal(store._shops.get('shop1').automation, undefined, 'no shop write on an unknown destination');
});

test('manager add-event appends a default event and enforces the ten-event cap', async () => {
  const events = Array.from({ length: 9 }, (_, i) => ({
    id: `ev${i}`,
    title: `E${i}`,
    description: '',
    startAt: i,
    endAt: i + 1,
    visible: true,
  }));
  const shop = { id: 'shop1', name: 'S', locationId: 'loc1', open: true, inventory: [], automation: { events } };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true, now: () => 1000 } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await app._onAddEvent({}, {}, {});
  let saved = store._shops.get('shop1');
  assert.equal(saved.automation.events.length, 10, 'a 10th event appended');
  const added = saved.automation.events[9];
  assert.equal(added.title, 'New event');
  assert.equal(added.description, '');
  assert.equal(added.startAt, 1000, 'default start at current world time');
  assert.equal(added.endAt, 87400, 'default end is start + a day');
  assert.equal(added.visible, false, 'a new event is hidden until saved visible');
  assert.ok(added.id, 'a fresh id is generated');
  await app._onAddEvent({}, {}, {});
  saved = store._shops.get('shop1');
  assert.equal(saved.automation.events.length, 10, 'still at most ten events');
  assert.equal(app._data.notice, 'A shop can have at most ten events.');
});

test('manager remove-event removes only the target event', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    automation: {
      hours: { enabled: false, days: [], openMinute: 0, closeMinute: 0 },
      events: [
        { id: 'ev1', title: 'Keep', description: '', startAt: 1, endAt: 2, visible: true },
        { id: 'ev2', title: 'Drop', description: '', startAt: 3, endAt: 4, visible: true },
      ],
    },
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await app._onRemoveEvent({}, { dataset: { eventId: 'ev2' } }, {});
  const saved = store._shops.get('shop1');
  assert.deepEqual(saved.automation.events.map((e) => e.id), ['ev1']);
  assert.equal(saved.automation.events[0].title, 'Keep');
});

test('manager save-events fails closed on a row id not in the persisted list and never deletes missing events', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    automation: {
      hours: { enabled: true, days: [0], openMinute: 60, closeMinute: 120 },
      travel: { enabled: true, locationIds: ['loc1', 'loc2'], anchorTime: 10, intervalSeconds: 86400, lastCycle: 0 },
      diagnostics: { lastRunAt: 1, lastStatus: 'ok', lastError: '', lastRestocked: 2, lastLocationId: 'loc1' },
      events: [
        { id: 'ev1', title: 'Old1', description: 'd1', startAt: 100, endAt: 200, visible: true },
        { id: 'ev2', title: 'Old2', description: 'd2', startAt: 300, endAt: 400, visible: false },
      ],
    },
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  app._data.selectedShopId = 'shop1';
  let refreshed = 0;
  app._refreshData = async () => {
    refreshed += 1;
  };
  app.render = async () => {};
  const editors = [
    fakeEventEditor({ id: 'ev1', title: 'New1', description: 'nd1', startAt: 111, endAt: 222, visible: true }),
    // forged id: not in the persisted event id set -> fail closed, no write
    fakeEventEditor({ id: 'forged', title: 'Ghost', description: '', startAt: 5, endAt: 6, visible: true }),
  ];
  app.element = { querySelectorAll: () => [], querySelector: () => null };
  app.element.querySelectorAll = (sel) => (sel === '.event-editor-list [data-event-id]' ? editors : []);
  await app._onSaveEvents({}, {}, {});
  const saved = store._shops.get('shop1');
  assert.equal(saved.automation.events.length, 2, 'forged id failed closed; neither event was written');
  assert.equal(saved.automation.events.find((e) => e.id === 'ev1').title, 'Old1', 'ev1 is unchanged (no write)');
  assert.equal(saved.automation.events.find((e) => e.id === 'ev2').title, 'Old2', 'ev2 not in the DOM is preserved, not deleted');
  assert.match(app._data.notice, /no longer matches a saved event/, 'fail-closed notice surfaced');
  assert.equal(refreshed, 0, 'no data refresh after a fail-closed (form preserved)');
  // diagnostics/travel/hours preserved
  assert.equal(saved.automation.diagnostics.lastStatus, 'ok');
  assert.equal(saved.automation.travel.enabled, true);
  assert.equal(saved.automation.hours.enabled, true);
});

test('manager save-events merges edits by id and preserves a concurrently added event', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    automation: {
      events: [
        { id: 'ev1', title: 'Old1', description: 'd1', startAt: 100, endAt: 200, visible: true },
        { id: 'ev2', title: 'Old2', description: 'd2', startAt: 300, endAt: 400, visible: false },
        // Added by another source between the DOM read and the persisted write; not
        // in the DOM rows and must be retained.
        { id: 'ev3', title: 'Concurrent', description: 'added elsewhere', startAt: 500, endAt: 600, visible: true },
      ],
    },
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  const editors = [
    fakeEventEditor({ id: 'ev1', title: 'New1', description: 'nd1', startAt: 111, endAt: 222, visible: true }),
    fakeEventEditor({ id: 'ev2', title: 'New2', description: 'nd2', startAt: 333, endAt: 444, visible: true }),
  ];
  app.element = { querySelector: () => null, querySelectorAll: () => [] };
  app.element.querySelectorAll = (sel) => (sel === '.event-editor-list [data-event-id]' ? editors : []);
  await app._onSaveEvents({}, {}, {});
  const saved = store._shops.get('shop1');
  const byId = Object.fromEntries(saved.automation.events.map((e) => [e.id, e]));
  assert.equal(saved.automation.events.length, 3, 'no event is deleted by a save');
  assert.equal(byId.ev1.title, 'New1', 'edit applied to ev1');
  assert.equal(byId.ev1.description, 'nd1');
  assert.equal(byId.ev1.startAt, 111);
  assert.equal(byId.ev1.endAt, 222);
  assert.equal(byId.ev2.title, 'New2', 'edit applied to ev2');
  assert.ok(byId.ev3, 'concurrently added ev3 is retained');
  assert.equal(byId.ev3.title, 'Concurrent', 'ev3 is unchanged');
  assert.equal(byId.ev3.startAt, 500);
  assert.equal(app._data.notice, '', 'no fail-closed notice on a valid merge');
});

test('manager save-events preserves the unsaved form when a window is invalid', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    automation: { events: [{ id: 'ev1', title: 'T', description: '', startAt: 100, endAt: 200, visible: true }] },
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true } });
  app._data.selectedShopId = 'shop1';
  let refreshed = 0;
  app._refreshData = async () => {
    refreshed += 1;
  };
  app.render = async () => {};
  // endAt <= startAt -> normalizeAutomationEvent throws
  const editors = [fakeEventEditor({ id: 'ev1', title: 'T', description: '', startAt: 100, endAt: 50, visible: true })];
  app.element = { querySelector: () => null, querySelectorAll: () => [] };
  app.element.querySelectorAll = (sel) => (sel === '.event-editor-list [data-event-id]' ? editors : []);
  await app._onSaveEvents({}, {}, {});
  assert.match(app._data.notice, /endAt must be > startAt/, 'invalid event window surfaced');
  assert.equal(refreshed, 0, 'no data refresh on a validation error (form preserved)');
  assert.equal(store._shops.get('shop1').automation.events[0].endAt, 200, 'no write on invalid events');
});

test('manager save-entry persists stock visibility and restock and resets lastCycle on identity change', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      {
        id: 'e1',
        name: 'Potion',
        itemUuid: 'Item.p1',
        price: 10,
        quantity: 5,
        stockMode: 'finite',
        stockVisibility: 'exact',
        restock: { enabled: false, target: 5, anchorTime: 0, intervalSeconds: 86400, lastCycle: 4 },
      },
    ],
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, runShopExclusive: (_id, fn) => fn(), systemId: () => 'dnd5e' } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await app._onSaveEntry(
    {},
    fakeTrM4('e1', {
      price: 12,
      quantity: 6,
      stockVisibility: 'low',
      restockEnabled: true,
      restockTarget: 8,
      restockAnchorTime: 60,
      restockIntervalSeconds: 7200,
    }),
    {}
  );
  const saved = store._shops.get('shop1').inventory[0];
  assert.equal(saved.price, 12);
  assert.equal(saved.quantity, 6);
  assert.equal(saved.stockVisibility, 'low', 'stock visibility persisted');
  assert.equal(saved.restock.enabled, true, 'restock enabled persisted');
  assert.equal(saved.restock.target, 8);
  assert.equal(saved.restock.anchorTime, 60);
  assert.equal(saved.restock.intervalSeconds, 7200);
  assert.equal(saved.restock.lastCycle, -1, 'identity changed -> lastCycle reset');
  assert.equal(store._shops.get('shop1').inventory.length, 1, 'only the target entry edited');
});

test('manager save-entry preserves restock lastCycle when the schedule identity is unchanged', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      {
        id: 'e1',
        name: 'Potion',
        itemUuid: 'Item.p1',
        price: 10,
        quantity: 5,
        stockMode: 'finite',
        restock: { enabled: true, target: 5, anchorTime: 60, intervalSeconds: 7200, lastCycle: 4 },
      },
    ],
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, runShopExclusive: (_id, fn) => fn(), systemId: () => 'dnd5e' } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await app._onSaveEntry(
    {},
    fakeTrM4('e1', {
      price: 10,
      quantity: 5,
      restockEnabled: true,
      restockTarget: 5,
      restockAnchorTime: 60,
      restockIntervalSeconds: 7200,
    }),
    {}
  );
  assert.equal(store._shops.get('shop1').inventory[0].restock.lastCycle, 4, 'same schedule keeps lastCycle');
});

test('manager save-entry normalizes an invalid restock without writing', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      {
        id: 'e1',
        name: 'Potion',
        itemUuid: 'Item.p1',
        price: 10,
        quantity: 5,
        stockMode: 'finite',
        restock: { enabled: false, target: 5, anchorTime: 0, intervalSeconds: 86400, lastCycle: 1 },
      },
    ],
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, runShopExclusive: (_id, fn) => fn(), systemId: () => 'dnd5e' } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await app._onSaveEntry(
    {},
    fakeTrM4('e1', {
      price: 10,
      quantity: 5,
      restockEnabled: true,
      restockTarget: 5,
      restockAnchorTime: 0,
      restockIntervalSeconds: 100,
    }),
    {}
  );
  assert.match(app._data.notice, /between 3600/, 'invalid interval surfaced');
  assert.equal(store._shops.get('shop1').inventory[0].restock.intervalSeconds, 86400, 'no write on invalid restock');
});

test('manager run-automation is active-GM gated and surfaces the run summary', async () => {
  let calls = 0;
  const app = new MarketManager({
    deps: { systemId: () => 'dnd5e', isGM: () => true, isActiveGM: () => false },
  });
  app._data.selectedShopId = 'shop1';
  app.render = async () => {};
  app._refreshData = async () => {};
  await app._onRunAutomation({}, {}, {});
  assert.equal(calls, 0, 'no runner call for a non-active GM');
  assert.match(app._data.notice, /active Game Master/);

  const app2 = new MarketManager({
    deps: {
      systemId: () => 'dnd5e',
      isGM: () => true,
      isActiveGM: () => true,
      runAutomation: async (shopId) => {
        calls += 1;
        assert.equal(shopId, 'shop1', 'runner called with the selected shop');
        return { status: 'ok', shopId, restocked: 3, locationId: 'loc2' };
      },
    },
  });
  app2._data.selectedShopId = 'shop1';
  app2.render = async () => {};
  app2._refreshData = async () => {};
  await app2._onRunAutomation({}, {}, {});
  assert.equal(calls, 1, 'runner called for the active GM');
  assert.equal(app2._data.notice, 'Automation ran: 3 restocked.');
});

test('manager run-automation surfaces a runner error without refreshing', async () => {
  const app = new MarketManager({
    deps: {
      systemId: () => 'dnd5e',
      isGM: () => true,
      isActiveGM: () => true,
      runAutomation: async () => ({ status: 'error', shopId: 'shop1', error: 'travel-location-missing' }),
    },
  });
  app._data.selectedShopId = 'shop1';
  let refreshed = 0;
  app._refreshData = async () => {
    refreshed += 1;
  };
  app.render = async () => {};
  await app._onRunAutomation({}, {}, {});
  assert.match(app._data.notice, /travel-location-missing/);
  assert.ok(refreshed >= 1, 'an error summary still refreshes diagnostics');
});

test('manager generate-inventory is active-GM gated and displays the result counters', async () => {
  const app = new MarketManager({
    deps: { systemId: () => 'dnd5e', isGM: () => true, isActiveGM: () => false },
  });
  app._data.selectedShopId = 'shop1';
  app.render = async () => {};
  app._refreshData = async () => {};
  await app._onGenerateInventory({}, {}, {});
  assert.match(app._data.notice, /active Game Master/);

  let params = null;
  const app2 = new MarketManager({
    deps: {
      systemId: () => 'dnd5e',
      isGM: () => true,
      isActiveGM: () => true,
      generateInventory: async (p) => {
        params = p;
        return { status: 'ok', added: 4, skipped: 1, invalid: 2, duplicate: 0 };
      },
    },
  });
  app2._data.selectedShopId = 'shop1';
  app2._refreshData = async () => {};
  app2.render = async () => {};
  app2.element = {
    querySelector: (sel) =>
      sel === '.table-generation'
        ? fakeElement({ '[name="rollTableUuid"]': fakeSelect('Table.loot'), '[name="drawCount"]': fakeNumber(3) })
        : null,
  };
  await app2._onGenerateInventory({}, {}, {});
  assert.deepEqual(params, { shopId: 'shop1', tableUuid: 'Table.loot', count: 3 });
  assert.equal(app2._data.notice, 'Generated: 4 added, 1 skipped, 2 invalid, 0 duplicate.');
});

test('manager generate-inventory validates the draw count before calling the service', async () => {
  let calls = 0;
  const app = new MarketManager({
    deps: {
      systemId: () => 'dnd5e',
      isGM: () => true,
      isActiveGM: () => true,
      generateInventory: async () => {
        calls += 1;
        return { status: 'ok', added: 0, skipped: 0, invalid: 0, duplicate: 0 };
      },
    },
  });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  app.element = {
    querySelector: (sel) =>
      sel === '.table-generation'
        ? fakeElement({ '[name="rollTableUuid"]': fakeSelect('Table.loot'), '[name="drawCount"]': fakeNumber(21) })
        : null,
  };
  await app._onGenerateInventory({}, {}, {});
  assert.equal(calls, 0, 'no service call for an out-of-range count');
  assert.match(app._data.notice, /between 1 and 20/);
});

test('manager automation buttons are disabled when not the active GM', () => {
  const template = readFileSync(new URL('../templates/manager.hbs', import.meta.url), 'utf8');
  assert.match(template, /data-action="run-automation"[^>]*\{\{#unless isActiveGM\}\}disabled/, 'Run now disabled for a non-active GM');
  assert.match(template, /data-action="generate-inventory"[^>]*\{\{#unless isActiveGM\}\}disabled/, 'Generate inventory disabled for a non-active GM');
});

// ---- M4: runtime automation hook only sweeps for the active GM ---------------

test('runtime automation updateWorldTime sweep only runs for the active GM', async () => {
  // Wire enough of the Foundry boundary that main.js can run: module registration
  // for the api attachment, the settings registry, an empty journal for the
  // default store reads, and a world-time clock.
  const modules = {};
  globalThis.game.modules = { get: (id) => (modules[id] || (modules[id] = {})) };
  globalThis.game.settings = { register: () => {}, registerMenu: () => {} };
  globalThis.game.journal = { filter: () => [], get: () => null };
  globalThis.game.time = { worldTime: 1000 };

  // Run ready as the active GM so the runtime wires the automation sweep.
  const prevUser = globalThis.game.user;
  const prevUsers = globalThis.game.users;
  globalThis.game.user = { id: 'gm1', isGM: true };
  globalThis.game.users = Object.assign({}, prevUsers, {
    activeGM: { id: 'gm1' },
    filter: () => [],
  });

  try {
    await import('../src/core/main.js');
    fireHook('init');
    fireHook('ready');
    // Let the startup sweep settle.
    await new Promise((r) => setTimeout(r, 10));

    const { store } = await import('../src/storage/store.js');
    const origListShops = store.listShops;
    let listShopsCalls = 0;
    store.listShops = async (...args) => {
      listShopsCalls += 1;
      return origListShops(...args);
    };

    // A non-active GM tick must not read the store.
    globalThis.game.user = { id: 'player1', isGM: false };
    const before = listShopsCalls;
    fireHook('updateWorldTime');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(listShopsCalls, before, 'a non-active GM tick does not sweep');

    // An active GM tick must sweep.
    globalThis.game.user = { id: 'gm1', isGM: true };
    fireHook('updateWorldTime');
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(listShopsCalls > before, 'an active GM tick sweeps shops');

    store.listShops = origListShops;
  } finally {
    globalThis.game.user = prevUser;
    globalThis.game.users = prevUsers;
  }
});

// ---- M4: runtime GM RollTable inventory generation --------------------------

test('runtime api.generateInventory draws a world Item and a compendium pack Item and skips a non-Item result', async () => {
  // Wire enough of the Foundry boundary that main.js `init` can run, then mock the
  // live game API surface the service reads: a RollTable resolved via `fromUuid`,
  // world Items via `game.items.get`, and a compendium pack via `game.packs.get`.
  const modules = {};
  globalThis.game.modules = { get: (id) => (modules[id] || (modules[id] = {})) };
  globalThis.game.settings = { register: () => {}, registerMenu: () => {}, get: () => '' };
  globalThis.game.journal = { filter: () => [], get: () => null };
  globalThis.game.time = { worldTime: 1000 };

  let drawCalls = 0;
  const table = {
    documentName: 'RollTable',
    async drawMany(count, opts) {
      drawCalls += 1;
      return {
        results: [
          { type: 'document', documentCollection: 'Item', documentId: 'w-1' },
          { type: 'document', documentCollection: 'Pack1', documentId: 'p-1' },
          { type: 'document', documentCollection: 'Pack1', documentId: 'p-2' },
          { type: 'text', text: 'flavor text' },
        ],
      };
    },
  };
  globalThis.fromUuid = async (uuid) => (uuid === 'Table.loot' ? table : null);

  const worldItem = {
    documentName: 'Item',
    uuid: 'Item.w-1',
    name: 'World Potion',
    img: 'icons/potion.png',
    system: { price: { value: 2, denomination: 'gp' } },
    toObject() {
      return { name: this.name, img: this.img, system: this.system };
    },
  };
  const packItem = {
    documentName: 'Item',
    uuid: 'Item.p-1',
    name: 'Pack Axe',
    img: 'icons/axe.png',
    system: { price: { value: 5, denomination: 'gp' } },
    toObject() {
      return { name: this.name, img: this.img, system: this.system };
    },
  };
  globalThis.game.items = { get: (id) => (id === 'w-1' ? worldItem : null) };
  globalThis.game.packs = {
    get: (coll) =>
      coll === 'Pack1'
        ? {
            documentName: 'Item',
            async getDocument(id) {
              if (id === 'p-1') return packItem;
              // A non-Item document resolved from an Item pack must be rejected.
              return { documentName: 'Actor', uuid: 'Actor.p-2', name: 'Npc' };
            },
          }
        : null,
  };

  const prevUser = globalThis.game.user;
  const prevUsers = globalThis.game.users;
  const origItems = globalThis.game.items;
  const origPacks = globalThis.game.packs;
  const origFromUuid = globalThis.fromUuid;
  globalThis.game.user = { id: 'gm1', isGM: true };
  globalThis.game.users = Object.assign({}, prevUsers, {
    activeGM: { id: 'gm1' },
    filter: () => [],
  });

  // Stub the market store on the live singleton; the service reads/writes through
  // it (a real shop persisted in a journal would be overkill for this test).
  const { store } = await import('../src/storage/store.js');
  const origFindShop = store.findShop;
  const origUpdateShop = store.updateShop;
  let findShopCalls = 0;
  const writes = [];
  store.findShop = async (id) => {
    findShopCalls += 1;
    return { id, name: 'Store', locationId: 'loc1', open: true, inventory: [] };
  };
  store.updateShop = async (id, patch) => {
    writes.push({ id, patch });
    return { id, ...patch };
  };

  try {
    await import('../src/core/main.js');
    fireHook('init');

    const api = globalThis.game.modules.get('market').api;
    assert.ok(api, 'module api attached');
    assert.equal(typeof api.generateInventory, 'function', 'generateInventory surface exposed');

    // A non-active GM is rejected before drawing, reading or writing anything.
    globalThis.game.user = { id: 'player1', isGM: false };
    const idle = await api.generateInventory({ shopId: 'shop1', tableUuid: 'Table.loot', count: 3 });
    assert.equal(idle.status, 'error');
    assert.equal(idle.error, 'not-active-gm');
    assert.equal(findShopCalls, 0, 'non-active GM does not read the store');
    assert.equal(drawCalls, 0, 'non-active GM does not draw from the table');
    assert.equal(writes.length, 0, 'non-active GM does not write');

    // The active GM draws, resolves a world Item and a pack Item, and skips the
    // non-Item pack row plus the text row.
    globalThis.game.user = { id: 'gm1', isGM: true };
    const res = await api.generateInventory({ shopId: 'shop1', tableUuid: 'Table.loot', count: 3 });
    assert.equal(res.status, 'ok');
    assert.equal(res.added, 2, 'world Item and pack Item added');
    assert.equal(res.skipped, 1, 'the non-Item pack result is skipped');
    assert.equal(res.invalid, 1, 'the text row is invalid');
    assert.equal(res.duplicate, 0);
    assert.equal(writes.length, 1, 'exactly one atomic write');
    assert.equal(findShopCalls, 1, 'one store read for the active GM');
    assert.equal(drawCalls, 1, 'one table draw for the active GM');

    const inventory = writes[0].patch.inventory;
    assert.equal(inventory.length, 2, 'two entries persisted');
    const uuids = inventory.map((e) => e.itemUuid).sort();
    assert.deepEqual(uuids, ['Item.p-1', 'Item.w-1']);
    const worldEntry = inventory.find((e) => e.itemUuid === 'Item.w-1');
    const packEntry = inventory.find((e) => e.itemUuid === 'Item.p-1');
    assert.equal(worldEntry.price, 200, 'world Item price read (2 gp -> 200 cp)');
    assert.equal(packEntry.price, 500, 'pack Item price read (5 gp -> 500 cp)');
    assert.equal(worldEntry.stockMode, 'finite');
    assert.equal(packEntry.visible, true);

    store.findShop = origFindShop;
    store.updateShop = origUpdateShop;
  } finally {
    store.findShop = origFindShop;
    store.updateShop = origUpdateShop;
    globalThis.game.user = prevUser;
    globalThis.game.users = prevUsers;
    if (origFromUuid === undefined) delete globalThis.fromUuid;
    else globalThis.fromUuid = origFromUuid;
    if (origItems === undefined) delete globalThis.game.items;
    else globalThis.game.items = origItems;
    if (origPacks === undefined) delete globalThis.game.packs;
    else globalThis.game.packs = origPacks;
  }
});

// ---- M5: runtime GM-only sell API guard -------------------------------------

test('runtime api.sellItem is GM-gated and routes only the active GM into the service', async () => {
  // Wire enough of the Foundry boundary that main.js `init` can run, then fire it
  // so the api is attached (module is cached; re-firing re-runs init).
  const modules = {};
  globalThis.game.modules = { get: (id) => (modules[id] || (modules[id] = {})) };
  globalThis.game.settings = { register: () => {}, registerMenu: () => {}, get: () => '' };
  globalThis.game.journal = { filter: () => [], get: () => null };

  await import('../src/core/main.js');
  fireHook('init');

  const api = globalThis.game.modules.get('market').api;
  assert.ok(api, 'module api attached');
  assert.equal(typeof api.sellItem, 'function', 'sellItem surface exposed');

  const prevUser = globalThis.game.user;
  const prevUsers = globalThis.game.users;

  try {
    // Non-active GM: rejected before any read/write.
    globalThis.game.user = { id: 'player1', isGM: false };
    globalThis.game.users = Object.assign({}, prevUsers, {
      activeGM: { id: 'gm1' },
      filter: () => [],
    });
    const idle = await api.sellItem({
      shopId: 'shop1',
      actorId: 'actor1',
      itemId: 'item1',
      requestId: 'r1',
    });
    assert.equal(idle.status, 'error');
    assert.equal(idle.error, 'not-active-gm');

    // Active GM: routes into the live selling service. A missing shop surfaces as
    // shop-not-found, proving the request reached the service with THIS user's id.
    globalThis.game.user = { id: 'gm1', isGM: true };
    const res = await api.sellItem({
      shopId: 'missing',
      actorId: 'actor1',
      itemId: 'item1',
      requestId: 'r2',
    });
    assert.equal(res.status, 'error');
    assert.equal(res.error, 'shop-not-found');
  } finally {
    globalThis.game.user = prevUser;
    globalThis.game.users = prevUsers;
  }
});

// ---- M5: runtime GM-only advanced order API guard -----------------------------

test('runtime api.advanced is GM-gated and routes only the active GM into the advanced services', async () => {
  // Wire enough of the Foundry boundary that main.js `init` can run, then fire it
  // so the api is attached (module is cached; re-firing re-runs init).
  const modules = {};
  globalThis.game.modules = { get: (id) => (modules[id] || (modules[id] = {})) };
  globalThis.game.settings = { register: () => {}, registerMenu: () => {}, get: () => '' };
  globalThis.game.journal = { filter: () => [], get: () => null };

  await import('../src/core/main.js');
  fireHook('init');

  const api = globalThis.game.modules.get('market').api;
  assert.ok(api, 'module api attached');
  assert.equal(typeof api.advanced, 'object', 'advanced surface exposed');

  const { store } = await import('../src/storage/store.js');
  const origListAdvancedOrders = store.listAdvancedOrders;
  let listCalls = 0;
  store.listAdvancedOrders = async () => {
    listCalls += 1;
    return [
      {
        id: 'o1',
        key: 'cart:req-1',
        kind: 'cart',
        status: 'committed',
        phase: 'committed',
        shopId: 'shop1',
        actorId: 'actor1',
        entryId: null,
        relatedOrderId: null,
        quantity: 2,
        total: 200,
        deposit: null,
        remaining: null,
        userId: 'player1',
        createdAt: 100,
        updatedAt: 200,
        error: null,
        details: { unitPrice: 100, fundsBefore: 500, compensation: [] },
        outcome: { total: 200 },
        payload: { lines: [{ entryId: 'e1', quantity: 2 }] },
        intentHash: 'abc123',
      },
    ];
  };

  const prevUser = globalThis.game.user;
  const prevUsers = globalThis.game.users;

  try {
    // Non-active GM: rejected before any store read.
    globalThis.game.user = { id: 'player1', isGM: false };
    globalThis.game.users = Object.assign({}, prevUsers, {
      activeGM: { id: 'gm1' },
      filter: () => [],
    });

    const idleSvc = await api.advanced.fulfillService({ orderId: 'missing' });
    assert.equal(idleSvc.status, 'error');
    assert.equal(idleSvc.error, 'not-active-gm');

    const idlePre = await api.advanced.fulfillPreorder({ orderId: 'missing' });
    assert.equal(idlePre.status, 'error');
    assert.equal(idlePre.error, 'not-active-gm');

    const idleCancel = await api.advanced.cancelPreorder({ orderId: 'missing' });
    assert.equal(idleCancel.status, 'error');
    assert.equal(idleCancel.error, 'not-active-gm');

    const idleTheft = await api.advanced.resolveTheft({ orderId: 'missing', success: true });
    assert.equal(idleTheft.status, 'error');
    assert.equal(idleTheft.error, 'not-active-gm');

    const idleList = await api.advanced.listOrders({ shopId: 'shop1' });
    assert.equal(idleList.status, 'error');
    assert.equal(idleList.error, 'not-active-gm');
    assert.equal(listCalls, 0, 'a non-active GM never reads the advanced-order store');

    // Active GM: routes into the live services (missing order => order-not-found)
    // and listOrders projects through publicAdvancedOrder, stripping private data.
    globalThis.game.user = { id: 'gm1', isGM: true };

    const svc = await api.advanced.fulfillService({ orderId: 'missing' });
    assert.equal(svc.error, 'order-not-found', 'fulfillService reached the service');

    const pre = await api.advanced.fulfillPreorder({ orderId: 'missing' });
    assert.equal(pre.error, 'order-not-found', 'fulfillPreorder reached the service');

    const cancel = await api.advanced.cancelPreorder({ orderId: 'missing' });
    assert.equal(cancel.error, 'order-not-found', 'cancelPreorder reached the service');

    const theft = await api.advanced.resolveTheft({ orderId: 'missing', success: true });
    assert.equal(theft.error, 'order-not-found', 'resolveTheft reached the service');

    const orders = await api.advanced.listOrders({ shopId: 'shop1' });
    assert.equal(orders.status, 'ok');
    assert.equal(orders.orders.length, 1);
    const o = orders.orders[0];
    assert.equal(o.id, 'o1');
    assert.equal(o.kind, 'cart');
    assert.equal(o.status, 'committed');
    assert.equal(o.shopId, 'shop1');
    assert.equal(o.quantity, 2);
    assert.equal(o.total, 200);
    assert.ok(!('details' in o), 'listOrders strips the private details snapshot');
    assert.ok(!('outcome' in o));
    assert.ok(!('payload' in o));
    assert.ok(!('intentHash' in o));
  } finally {
    store.listAdvancedOrders = origListAdvancedOrders;
    globalThis.game.user = prevUser;
    globalThis.game.users = prevUsers;
  }
});

// ---- M6: runtime GM-only valuation approval gate ------------------------------

test('runtime api.advanced.approveValuation is GM-gated and routes only the active GM into the valuation service', async () => {
  const modules = {};
  globalThis.game.modules = { get: (id) => (modules[id] || (modules[id] = {})) };
  globalThis.game.settings = { register: () => {}, registerMenu: () => {}, get: () => '' };
  globalThis.game.journal = { filter: () => [], get: () => null };

  await import('../src/core/main.js');
  fireHook('init');

  const api = globalThis.game.modules.get('market').api;
  assert.equal(typeof api.advanced.approveValuation, 'function', 'approveValuation exposed');

  const { store } = await import('../src/storage/store.js');
  const origFindShop = store.findShop;
  let findCalls = 0;
  store.findShop = async () => {
    findCalls += 1;
    return null;
  };

  const prevUser = globalThis.game.user;
  const prevUsers = globalThis.game.users;
  const prevActors = globalThis.game.actors;

  try {
    // Non-active GM: rejected before any store read.
    globalThis.game.user = { id: 'player1', isGM: false };
    globalThis.game.users = Object.assign({}, prevUsers, {
      activeGM: { id: 'gm1' },
      filter: () => [],
    });

    const idle = await api.advanced.approveValuation({
      shopId: 'shop1',
      actorId: 'actor1',
      itemId: 'item1',
      amount: 42,
    });
    assert.equal(idle.status, 'error');
    assert.equal(idle.error, 'not-active-gm');
    assert.equal(findCalls, 0, 'a non-active GM never reads the shop store');

    // Active GM: routes into the live valuation service. A missing shop surfaces as
    // shop-not-found, proving the request reached the service with THIS user's id.
    globalThis.game.user = { id: 'gm1', isGM: true };
    const res = await api.advanced.approveValuation({
      shopId: 'missing',
      actorId: 'actor1',
      itemId: 'item1',
      amount: 42,
    });
    assert.equal(res.status, 'error');
    assert.equal(res.error, 'shop-not-found');
    assert.ok(findCalls >= 1, 'the active GM reached the shop read');
  } finally {
    store.findShop = origFindShop;
    globalThis.game.user = prevUser;
    globalThis.game.users = prevUsers;
    globalThis.game.actors = prevActors;
  }
});

// ---- M5: storefront cart / special / service / preorder / theft / sell ---------

// Build a GM response whisper for an M5 advanced request so a test can route it
// through `_onChatMessage` without constructing the chat flag shape by hand.
function wrapAdvancedResponse(requestId, type, actorId, shopId, result) {
  const response = { requestId, type, actorId, shopId };
  if (result) response.result = result;
  return {
    flags: {
      market: {
        type: 'response',
        response,
      },
    },
  };
}

test('storefront M5: adds to cart, removes, and checks out with a barter tender', async () => {
  const sent = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: { hasActiveGM: () => true },
  });
  app.render = async () => {};
  app._request = (payload) => {
    sent.push(payload);
    return Promise.resolve(null);
  };
  app._data.selectedActorId = 'a1';
  app._data.shop = { open: true, specials: [], services: [] };
  app._data.inventory = [
    { id: 'e1', name: 'Potion', price: 10, available: true, canBuy: true },
  ];

  // Add e1 at qty 2; the display projection must reflect the merged price.
  app.element = {
    querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '2' } : null),
  };
  await app._onAddToCart({}, { dataset: { entryId: 'e1' } }, {});
  assert.equal(app._data.cartLines.length, 1);
  assert.deepEqual(app._data.cartLines[0], { entryId: 'e1', quantity: 2, specialId: '' });
  const ctx = app._prepareContext();
  assert.equal(ctx.cartLines.length, 1);
  assert.equal(ctx.cartLines[0].total, 20, 'display total derived from the catalog price');
  assert.equal(ctx.cartTotal, 20, 'cart total derived');

  // Merge: adding e1 again at qty 3 raises the line to 5.
  app.element = {
    querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '3' } : null),
  };
  await app._onAddToCart({}, { dataset: { entryId: 'e1' } }, {});
  assert.equal(app._data.cartLines[0].quantity, 5, 'identical line merged');

  // Remove the line.
  await app._onRemoveFromCart({}, { dataset: { entryId: 'e1', specialId: '' } }, {});
  assert.equal(app._data.cartLines.length, 0, 'line removed');

  // Re-add then checkout with a barter tender.
  app.element = {
    querySelector: (sel) => {
      if (sel === '[name="quantity"]') return { value: '2' };
      if (sel === '[name="barterItemId"]') return { value: 'barter-1' };
      return null;
    },
  };
  await app._onAddToCart({}, { dataset: { entryId: 'e1' } }, {});
  assert.equal(app._data.cartLines.length, 1);
  await app._onCheckoutCart({}, {}, {});
  assert.ok(sent.length >= 1, 'a cart request was sent');
  const cart = sent[sent.length - 1];
  assert.equal(cart.type, 'cart');
  assert.equal(cart.actorId, 'a1');
  assert.equal(cart.shopId, 'shop1');
  assert.ok(cart.requestId, 'cart request carries a requestId');
  assert.deepEqual(cart.lines, [{ entryId: 'e1', quantity: 2, specialId: '' }]);
  assert.equal(cart.barterItemId, 'barter-1');
  assert.ok(!('price' in cart), 'cart request never carries a client price');
  assert.ok(!('success' in cart), 'cart request never carries a client success');
  assert.equal(app._data.pending, true);
});

test('storefront M5: cart lines are unique by entry and a special replaces a regular line in place', async () => {
  const sent = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: { hasActiveGM: () => true },
  });
  app.render = async () => {};
  app._request = (payload) => {
    sent.push(payload);
    return Promise.resolve(null);
  };
  app._data.selectedActorId = 'a1';
  app._data.shop = { open: true, specials: [{ id: 'sp1', entryId: 'e1' }], services: [] };
  app._data.inventory = [
    { id: 'e1', name: 'Potion', price: 10, available: true, canBuy: true, visible: true },
  ];

  // Regular e1 at qty 2.
  app.element = { querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '2' } : null) };
  await app._onAddToCart({}, { dataset: { entryId: 'e1' } }, {});
  assert.deepEqual(app._data.cartLines, [{ entryId: 'e1', quantity: 2, specialId: '' }], 'regular line added');

  // Adding the special over the same entry replaces specialId in place, never
  // creating a second line for the same entry, and accumulates the quantity.
  app.element = { querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '3' } : null) };
  await app._onAddSpecialToCart({}, { dataset: { specialId: 'sp1' } }, {});
  assert.equal(app._data.cartLines.length, 1, 'no duplicate line for the same entry');
  assert.equal(app._data.cartLines[0].entryId, 'e1');
  assert.equal(app._data.cartLines[0].specialId, 'sp1', 'special id replaces the regular line');
  assert.equal(app._data.cartLines[0].quantity, 5, 'quantity accumulates in place');

  // Adding the regular entry again resets specialId but keeps the accumulated qty.
  app.element = { querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '1' } : null) };
  await app._onAddToCart({}, { dataset: { entryId: 'e1' } }, {});
  assert.equal(app._data.cartLines.length, 1);
  assert.equal(app._data.cartLines[0].specialId, '', 'regular add resets the special id');
  assert.equal(app._data.cartLines[0].quantity, 6, 'quantity retained after resetting special');

  // Two distinct entries never collapse into one line.
  app.element = { querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '1' } : null) };
  app._data.inventory = [
    { id: 'e1', name: 'Potion', price: 10, available: true, canBuy: true, visible: true },
    { id: 'e2', name: 'Bread', price: 5, available: true, canBuy: true, visible: true },
  ];
  await app._onAddToCart({}, { dataset: { entryId: 'e2' } }, {});
  assert.equal(app._data.cartLines.length, 2, 'different entries remain distinct lines');

  // Removal is by entryId alone, regardless of any specialId on the line.
  await app._onRemoveFromCart({}, { dataset: { entryId: 'e1', specialId: 'sp1' } }, {});
  assert.equal(app._data.cartLines.length, 1, 'remove is by entryId only');
  assert.equal(app._data.cartLines[0].entryId, 'e2');

  // Re-add a unique line and checkout: only unique entry lines are sent and never
  // a client price.
  app.element = { querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '4' } : null) };
  await app._onAddToCart({}, { dataset: { entryId: 'e1' } }, {});
  assert.equal(app._data.cartLines.length, 2);
  await app._onCheckoutCart({}, {}, {});
  assert.ok(sent.length >= 1, 'a cart request was sent');
  const cart = sent[sent.length - 1];
  assert.equal(cart.type, 'cart');
  assert.deepEqual(cart.lines, [
    { entryId: 'e2', quantity: 1, specialId: '' },
    { entryId: 'e1', quantity: 4, specialId: '' },
  ]);
  assert.ok(!('price' in cart), 'cart request never carries a client price');
  assert.equal(app._data.pending, true);
});

test('storefront M5: a special cart line prices from the personalized shop.specials[].price, never entry.specialPrice or raw', async () => {
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: { hasActiveGM: () => true },
  });
  app.render = async () => {};
  app._request = () => Promise.resolve(null);
  app._data.selectedActorId = 'a1';
  // The personalized catalog carry the SOCIAL-QUOTED shop.specials[].price (e.g.
  // 60 and 70 marked up 10%). With no client price ever sent, the display total
  // must agree with the GM checkout quote for those offers.
  app._data.shop = {
    open: true,
    specials: [
      { id: 'sp1', entryId: 'e1', price: 66 },
      { id: 'sp2', entryId: 'e2', price: 77 },
    ],
    services: [],
  };
  // `entry.specialPrice` deliberately disagrees with shop.specials[].price to
  // prove the cart uses the offer list price, never the entry cross-reference.
  app._data.inventory = [
    { id: 'e1', name: 'Potion', price: 100, available: true, canBuy: true, visible: true, specialId: 'sp1', specialPrice: 60 },
    { id: 'e2', name: 'Sword', price: 100, available: true, canBuy: true, visible: true, specialId: 'sp2', specialPrice: 70 },
  ];

  app.element = { querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '2' } : null) };
  await app._onAddSpecialToCart({}, { dataset: { specialId: 'sp1' } }, {});
  app.element = { querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '1' } : null) };
  await app._onAddSpecialToCart({}, { dataset: { specialId: 'sp2' } }, {});

  const ctx = app._prepareContext();
  assert.equal(ctx.cartLines.length, 2);
  const sp1 = ctx.cartLines.find((l) => l.specialId === 'sp1');
  const sp2 = ctx.cartLines.find((l) => l.specialId === 'sp2');
  // Unit/total come from shop.specials[].price (66 / 77), not entry.specialPrice.
  assert.equal(sp1.unitPrice, 66);
  assert.equal(sp1.total, 132);
  assert.equal(sp2.unitPrice, 77);
  assert.equal(sp2.total, 77);
  // The displayed total equals the GM checkout quote for the personalized offers.
  assert.equal(ctx.cartTotal, 132 + 77);
  // With a character selected the cart is NOT an estimate.
  assert.equal(ctx.cartEstimate, false);
});

test('storefront M5: no character selected annotates the cart as an estimate and the checkout is disabled', async () => {
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: { hasActiveGM: () => true },
  });
  app.render = async () => {};
  app._request = () => Promise.resolve(null);
  // No character selected (null) => the base public catalog.
  app._data.selectedActorId = null;
  app._data.shop = {
    open: true,
    specials: [{ id: 'sp1', entryId: 'e1', price: 60 }],
    services: [],
  };
  app._data.inventory = [
    { id: 'e1', name: 'Potion', price: 100, available: true, canBuy: true, visible: true },
  ];
  app._data.cartLines = [{ entryId: 'e1', quantity: 2, specialId: 'sp1' }];

  const ctx = app._prepareContext();
  assert.equal(ctx.cartTotal, 120);
  assert.equal(ctx.cartEstimate, true, 'no-actor cart is annotated as an estimate');
  // The checkout request is guarded: with no actor `_requestAdvanced` refuses and
  // shows the "choose a character" feedback rather than sending.
  const sent = [];
  app._request = (p) => {
    sent.push(p);
    return Promise.resolve(null);
  };
  let sentAny = false;
  app._data.pending = false;
  await app._onCheckoutCart({}, {}, {});
  const sentCart = sent.find((s) => s.type === 'cart');
  assert.ok(!sentCart, 'no cart request is sent without a selected character');
  assert.equal(app._data.feedback, 'Choose a character to shop as.');
  // An explicit empty (undefined) selection is treated the same way.
  app._data.selectedActorId = undefined;
  assert.equal(app._prepareContext().cartEstimate, true);
});

test('storefront M5: an actor switch clears the cart and abandons pending advanced requests', async () => {
  const sent = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      hasActiveGM: () => true,
      request: async (p) => {
        sent.push(p);
        return null;
      },
    },
  });
  app.render = async () => {};
  app._data.selectedActorId = 'a1';
  app._data.shop = { open: true, specials: [], services: [] };
  app._data.cartLines = [{ entryId: 'e1', quantity: 2, specialId: '' }];
  app._data.pending = true;
  app._pendingAdvancedRequestId = 'adv-1';
  app._pendingAdvancedType = 'cart';
  await app._onSelectActor({}, { value: 'a2' }, {});
  assert.equal(app._data.selectedActorId, 'a2');
  assert.equal(app._data.cartLines.length, 0, 'cart cleared on actor switch');
  assert.equal(app._data.pending, false, 'pending abandoned on switch');
  assert.equal(app._pendingAdvancedRequestId, null);
  assert.equal(app._pendingAdvancedType, null);
  assert.ok(sent.length >= 1, 'a catalog refresh was issued');
  const last = sent[sent.length - 1];
  assert.equal(last.type, 'catalog');
  assert.equal(last.actorId, 'a2', 'refresh for the newly selected actor');
});

test('storefront M5: books a service through an authenticated request', async () => {
  const sent = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: { hasActiveGM: () => true },
  });
  app.render = async () => {};
  app._request = (payload) => {
    sent.push(payload);
    return Promise.resolve(null);
  };
  app._data.selectedActorId = 'a1';
  app._data.shop = { open: true, specials: [], services: [{ id: 'svc1', name: 'Repair' }] };
  app._data.inventory = [];
  await app._onBookService({}, { dataset: { serviceId: 'svc1' } }, {});
  assert.ok(sent.length >= 1, 'a service request was sent');
  const req = sent[sent.length - 1];
  assert.equal(req.type, 'service');
  assert.equal(req.serviceId, 'svc1');
  assert.equal(req.actorId, 'a1');
  assert.equal(req.shopId, 'shop1');
  assert.ok(req.requestId, 'service request carries a requestId');
  assert.ok(!('success' in req), 'service never carries a client success');
  assert.ok(!('price' in req), 'service never carries a client price');
  assert.equal(app._data.pending, true);
});

test('storefront M5: derives sellable owned items and sells a selected whole item', async () => {
  const sent = [];
  const actor = {
    items: [
      { id: 'i1', name: 'Sword', system: { quantity: 1 } },
      { id: 'i2', name: 'Shield', system: { quantity: 3 } },
      { id: 'i3', name: 'Ring', system: {} },
    ],
  };
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: { hasActiveGM: () => true, getActor: (id) => (id === 'a1' ? actor : null) },
  });
  app.render = async () => {};
  app._request = (payload) => {
    sent.push(payload);
    return Promise.resolve(null);
  };
  app._data.selectedActorId = 'a1';
  app._data.shop = {
    open: true,
    specials: [],
    services: [],
    // Only GM-approved items may be sold/bartered; i1 and i3 are approved, the
    // stacked i2 is not (and is excluded by the whole-item rule regardless).
    approvedItems: [{ itemId: 'i1', amount: 100 }, { itemId: 'i3', amount: 50 }],
  };
  app._data.inventory = [];
  const ctx = app._prepareContext();
  assert.deepEqual(ctx.sellItems.map((i) => i.id).sort(), ['i1', 'i3'], 'stacked item excluded');
  assert.deepEqual(ctx.barterItems.map((i) => i.id).sort(), ['i1', 'i3'], 'same list for barter');

  app.element = {
    querySelector: (sel) => (sel === '[name="sellItemId"]' ? { value: 'i1' } : null),
  };
  await app._onSellItem({}, {}, {});
  assert.ok(sent.length >= 1, 'a sell request was sent');
  const req = sent[sent.length - 1];
  assert.equal(req.type, 'sell');
  assert.equal(req.itemId, 'i1');
  assert.equal(req.actorId, 'a1');
  assert.equal(req.shopId, 'shop1');
  assert.ok(req.requestId, 'sell request carries a requestId');
  assert.ok(!('price' in req), 'a sell never carries a client price');
  assert.ok(!('success' in req), 'a sell never carries a client success');
});

test('storefront M5: only GM-approved items are offered for sell/barter', async () => {
  const actor = {
    items: [
      { id: 'i1', name: 'Sword', system: { quantity: 1 } },
      { id: 'i3', name: 'Ring', system: {} },
    ],
  };
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: { hasActiveGM: () => true, getActor: (id) => (id === 'a1' ? actor : null) },
  });
  app.render = async () => {};
  app._data.selectedActorId = 'a1';
  app._data.shop = {
    open: true,
    specials: [],
    services: [],
    approvedItems: [{ itemId: 'i1', amount: 100 }],
  };
  app._data.inventory = [];
  const ctx = app._prepareContext();
  assert.deepEqual(ctx.sellItems.map((i) => i.id), ['i1'], 'an unapproved owned item is dropped');
  assert.equal(ctx.sellEmpty, false);
  assert.deepEqual(ctx.barterItems.map((i) => i.id), ['i1'], 'barter dropdown mirrors the allowlist');
});

test('storefront M5: shows the ask-GM message when no item is approved', async () => {
  const actor = {
    items: [
      { id: 'i1', name: 'Sword', system: { quantity: 1 } },
      { id: 'i3', name: 'Ring', system: {} },
    ],
  };
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: { hasActiveGM: () => true, getActor: (id) => (id === 'a1' ? actor : null) },
  });
  app.render = async () => {};
  app._data.selectedActorId = 'a1';
  app._data.shop = { open: true, specials: [], services: [], approvedItems: [] };
  app._data.inventory = [];
  const ctx = app._prepareContext();
  assert.deepEqual(ctx.sellItems, [], 'no approved item => nothing offered');
  assert.equal(ctx.sellEmpty, true, 'no approvals => ask-GM message flag');
  // With no character selected nothing is offered but the ask-GM message is off.
  app._data.selectedActorId = null;
  const ctx2 = app._prepareContext();
  assert.equal(ctx2.sellEmpty, false, 'no actor chosen => no ask-GM message');
});

test('storefront M5: approved-only filtering never offers an item for a different actor', async () => {
  const actorA = {
    items: [{ id: 'i1', name: 'Sword', system: { quantity: 1 } }],
  };
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: {
      hasActiveGM: () => true,
      getActor: (id) => (id === 'a1' ? actorA : null),
    },
  });
  app.render = async () => {};
  app._data.selectedActorId = 'a1';
  // The allowlist only carries i1 for this actor; an owned stacked i2 is absent.
  app._data.shop = {
    open: true,
    specials: [],
    services: [],
    approvedItems: [{ itemId: 'i1', amount: 100 }],
  };
  app._data.inventory = [];
  const ctx = app._prepareContext();
  assert.deepEqual(ctx.sellItems.map((i) => i.id), ['i1']);
  // A sell request still carries no client price - the amount is server-side.
  app.element = {
    querySelector: (sel) => (sel === '[name="sellItemId"]' ? { value: 'i1' } : null),
  };
  const sent = [];
  app._request = async (payload) => {
    sent.push(payload);
    return null;
  };
  await app._onSellItem({}, {}, {});
  const req = sent[sent.length - 1];
  assert.equal(req.itemId, 'i1');
  assert.ok(!('price' in req), 'a sell never carries a client price');
  assert.ok(!('amount' in req), 'a sell never carries a client amount');
});

test('manager approves a GM item valuation through the advanced channel and refreshes', async () => {
  const approved = [];
  let refreshed = 0;
  const app = new MarketManager({
    deps: {
      systemId: () => 'dnd5e',
      isGM: () => true,
      isActiveGM: () => true,
      listActors: () => [{ id: 'a1', name: 'A', uuid: 'Actor.a1' }],
      getActor: async (id) => ({ id, uuid: `Actor.${id}`, name: 'A', items: [] }),
      approveValuation: async (params) => {
        approved.push(params);
        return { status: 'approved', valuationId: 'v1', itemName: 'Sword', amount: params.amount };
      },
    },
  });
  app._refreshData = async () => {
    refreshed++;
  };
  app.render = async () => {};
  app._data.selectedShopId = 'shop1';
  app._data.selectedReputationActorId = 'a1';
  app.element = {
    querySelector: (sel) => {
      if (sel === '[name="valuationItemId"]') return { value: 'i1' };
      if (sel === '[name="valuationAmount"]') return { value: '75', type: 'number' };
      return null;
    },
  };
  await app._onApproveValuation({}, {}, {});
  assert.equal(approved.length, 1);
  assert.deepEqual(
    approved[0],
    { shopId: 'shop1', actorId: 'a1', itemId: 'i1', amount: 75 }
  );
  assert.equal(refreshed, 1, 'the shop is refreshed after an approval');
  assert.equal(app._data.notice, 'Valuation approved for Sword.');
});

test('manager valuation action validates a chosen item and a positive amount', async () => {
  const approved = [];
  const app = new MarketManager({
    deps: {
      systemId: () => 'dnd5e',
      isGM: () => true,
      isActiveGM: () => true,
      listActors: () => [{ id: 'a1', name: 'A', uuid: 'Actor.a1' }],
      getActor: async (id) => ({ id, uuid: `Actor.${id}`, name: 'A', items: [] }),
      approveValuation: async (params) => {
        approved.push(params);
        return { status: 'approved', valuationId: 'v1', itemName: 'Sword', amount: 75 };
      },
    },
  });
  app.render = async () => {};
  app._refreshData = async () => {};
  app._data.selectedShopId = 'shop1';
  app._data.selectedReputationActorId = 'a1';
  // No item chosen => no request, and a helpful notice.
  app.element = {
    querySelector: (sel) => {
      if (sel === '[name="valuationItemId"]') return { value: '' };
      if (sel === '[name="valuationAmount"]') return { value: '75', type: 'number' };
      return null;
    },
  };
  await app._onApproveValuation({}, {}, {});
  assert.equal(approved.length, 0, 'no request sent without a chosen item');
  assert.equal(app._data.notice, 'Choose an item to value.');
  // A non-positive (or non-integer) amount is rejected.
  app.element = {
    querySelector: (sel) => {
      if (sel === '[name="valuationItemId"]') return { value: 'i1' };
      if (sel === '[name="valuationAmount"]') return { value: '0', type: 'number' };
      return null;
    },
  };
  await app._onApproveValuation({}, {}, {});
  assert.equal(approved.length, 0);
  assert.equal(app._data.notice, 'The valuation must be a positive whole number.');
  // A valid amount sends the request.
  app.element = {
    querySelector: (sel) => {
      if (sel === '[name="valuationItemId"]') return { value: 'i1' };
      if (sel === '[name="valuationAmount"]') return { value: '5', type: 'number' };
      return null;
    },
  };
  await app._onApproveValuation({}, {}, {});
  assert.equal(approved.length, 1);
  assert.equal(approved[0].amount, 5);
});

test('storefront M5: preorder and theft requests carry no client success or price', async () => {
  const sent = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: { hasActiveGM: () => true },
  });
  app.render = async () => {};
  app._request = (payload) => {
    sent.push(payload);
    return Promise.resolve(null);
  };
  app._data.selectedActorId = 'a1';
  app._data.shop = {
    open: true,
    specials: [],
    services: [],
    preordersEnabled: true,
    theftEnabled: true,
  };
  app._data.inventory = [
    { id: 'e1', name: 'Potion', price: 10, canPreorder: true, canAttemptTheft: true, available: true },
  ];

  // Preorder via the select; quantity 2.
  app.element = {
    querySelector: (sel) => {
      if (sel === '[name="quantity"]') return { value: '2' };
      if (sel === '[name="preorderEntryId"]') return { value: 'e1' };
      return null;
    },
  };
  await app._onPlacePreorder({}, {}, {});
  assert.ok(sent.length >= 1, 'a preorder request was sent');
  let req = sent[sent.length - 1];
  assert.equal(req.type, 'preorder');
  assert.equal(req.entryId, 'e1');
  assert.equal(req.quantity, 2);
  assert.ok(!('success' in req), 'preorder never carries a success');
  assert.ok(!('price' in req), 'preorder never carries a price');

  // Theft via the select (pending reset so the second request can send).
  app._data.pending = false;
  app.element = {
    querySelector: (sel) => (sel === '[name="theftEntryId"]' ? { value: 'e1' } : null),
  };
  await app._onAttemptTheft({}, {}, {});
  req = sent[sent.length - 1];
  assert.equal(req.type, 'theft');
  assert.equal(req.entryId, 'e1');
  assert.ok(!('success' in req), 'theft never carries a client success');
  assert.ok(!('price' in req), 'theft never carries a client price');
});

test('storefront M5: preorder and theft accept a data-entry-id from the product card', async () => {
  const sent = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: { hasActiveGM: () => true },
  });
  app.render = async () => {};
  app._request = (payload) => {
    sent.push(payload);
    return Promise.resolve(null);
  };
  app._data.selectedActorId = 'a1';
  app._data.shop = { open: true, specials: [], services: [] };
  app._data.inventory = [
    { id: 'e1', name: 'Potion', canPreorder: true, canAttemptTheft: true, available: true },
  ];
  app.element = {
    querySelector: (sel) => (sel === '[name="quantity"]' ? { value: '1' } : null),
  };
  await app._onPlacePreorder({}, { dataset: { entryId: 'e1' } }, {});
  assert.equal(sent[sent.length - 1].type, 'preorder');
  assert.equal(sent[sent.length - 1].entryId, 'e1');
  app._data.pending = false;
  await app._onAttemptTheft({}, { dataset: { entryId: 'e1' } }, {});
  assert.equal(sent[sent.length - 1].type, 'theft');
  assert.equal(sent[sent.length - 1].entryId, 'e1');
});

test('storefront M5: rejects a stale advanced response and applies only a matching one', async () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: { isGM: () => true } });
  app.render = async () => {};
  app._request = async () => null;
  app._data.selectedActorId = 'a2';
  app._data.shop = { open: true, specials: [], services: [] };
  app._data.cartLines = [{ entryId: 'e1', quantity: 1, specialId: '' }];
  app._pendingAdvancedRequestId = 'adv-1';
  app._pendingAdvancedType = 'cart';
  app._data.pending = true;

  // Wrong actor: ignored, cart untouched.
  await app._onChatMessage(wrapAdvancedResponse('adv-1', 'cart', 'a1', 'shop1', { status: 'committed' }), {}, 'gm1');
  assert.equal(app._pendingAdvancedRequestId, 'adv-1', 'stale-actor response ignored');
  assert.equal(app._data.cartLines.length, 1, 'cart not cleared by a stale actor');

  // Wrong shop: ignored.
  await app._onChatMessage(wrapAdvancedResponse('adv-1', 'cart', 'a2', 'other-shop', { status: 'committed' }), {}, 'gm1');
  assert.equal(app._pendingAdvancedRequestId, 'adv-1', 'stale-shop response ignored');

  // Matching: applied, cart cleared, refresh issued.
  await app._onChatMessage(wrapAdvancedResponse('adv-1', 'cart', 'a2', 'shop1', { status: 'committed' }), {}, 'gm1');
  assert.equal(app._pendingAdvancedRequestId, null);
  assert.equal(app._data.cartLines.length, 0, 'matched cart clears the cart');
  assert.equal(app._data.pending, false);
  assert.equal(app._data.feedback, 'Cart checkout complete.');
});

test('storefront M5: advanced responses report booked status truthfully', async () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: { hasActiveGM: () => true } });
  app.render = async () => {};
  app._request = async () => null;
  app._data.selectedActorId = 'a1';
  app._data.shop = { open: true, specials: [], services: [] };
  await app._onAdvancedResponse({ type: 'service', result: { status: 'booked' }, actorId: 'a1', shopId: 'shop1' });
  assert.equal(app._data.feedback, 'Service booked.');
  assert.ok(!app._data.feedback.includes('fulfilled'), 'a booked service is not reported fulfilled');

  await app._onAdvancedResponse({ type: 'preorder', result: { status: 'booked' }, actorId: 'a1', shopId: 'shop1' });
  assert.equal(app._data.feedback, 'Preorder placed.');

  await app._onAdvancedResponse({ type: 'theft', result: { status: 'booked' }, actorId: 'a1', shopId: 'shop1' });
  assert.ok(app._data.feedback.includes('awaiting the GM'), 'a theft claim is not pre-resolved');
  assert.ok(!app._data.feedback.includes('succeeded'));
});

test('storefront M5: advanced requests guard on actor, GM, open shop and pending', async () => {
  const sent = [];
  const app = new MarketStorefront({
    shopId: 'shop1',
    deps: { hasActiveGM: () => true },
  });
  app.render = async () => {};
  app._request = (payload) => {
    sent.push(payload);
    return Promise.resolve(null);
  };

  // No actor selected.
  app._data.selectedActorId = null;
  app._data.shop = { open: true };
  let ok = app._requestAdvanced('service', { serviceId: 'svc1' });
  assert.equal(ok, false);
  assert.ok(app._data.feedback.includes('character'), 'no-actor feedback');

  // Selected actor but shop closed.
  app._data.selectedActorId = 'a1';
  app._data.shop = { open: false };
  ok = app._requestAdvanced('service', { serviceId: 'svc1' });
  assert.equal(ok, false);
  assert.ok(app._data.feedback.includes('closed'), 'closed-shop feedback');

  // No active GM.
  app._data.shop = { open: true };
  app._deps.hasActiveGM = () => false;
  ok = app._requestAdvanced('service', { serviceId: 'svc1' });
  assert.equal(ok, false);
  assert.ok(app._data.feedback.includes('Game Master'), 'no-GM feedback');
  app._deps.hasActiveGM = () => true;

  // A pending request blocks another.
  app._data.pending = true;
  ok = app._requestAdvanced('service', { serviceId: 'svc1' });
  assert.equal(ok, false);
  app._data.pending = false;

  // Valid request sends.
  ok = app._requestAdvanced('service', { serviceId: 'svc1' });
  assert.equal(ok, true);
  assert.equal(app._data.pending, true);
  assert.equal(sent[sent.length - 1].type, 'service');
  assert.equal(sent[sent.length - 1].serviceId, 'svc1');
});

test('storefront M5: M1 direct Buy is unaffected by an in-progress cart', async () => {
  const sent = [];
  const app = new MarketStorefront({ shopId: 'shop1', deps: { hasActiveGM: () => true } });
  app.render = async () => {};
  app._request = (payload) => {
    sent.push(payload);
    return Promise.resolve(null);
  };
  app._data.selectedActorId = 'a1';
  app._data.shop = { open: true, specials: [], services: [] };
  app._data.inventory = [{ id: 'e1', name: 'Potion', price: 10, canBuy: true, available: true }];
  app._data.cartLines = [{ entryId: 'e1', quantity: 1, specialId: '' }];
  app._readQuantity = () => 2;
  app._onBuy({}, { dataset: { entryId: 'e1' } }, {});
  await Promise.resolve();
  assert.ok(sent.length >= 1, 'a purchase request was sent');
  const req = sent[sent.length - 1];
  assert.equal(req.type, 'purchase');
  assert.equal(req.entryId, 'e1');
  assert.equal(req.quantity, 2);
  assert.ok(!('lines' in req), 'a direct buy never carries cart lines');
  assert.equal(app._data.cartLines.length, 1, 'cart untouched by a direct buy');
});

test('storefront M5: catalog refresh prunes cart lines for entries no longer on display', () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: {} });
  app.render = async () => {};
  app._data.cartLines = [
    { entryId: 'e1', quantity: 2, specialId: '' },
    { entryId: 'e2', quantity: 1, specialId: '' },
  ];
  app._data.inventory = [{ id: 'e1', name: 'Potion', price: 10 }];
  app._onCatalogResponse({
    type: 'catalog',
    shop: { id: 'shop1', open: true, specials: [], services: [] },
    inventory: [{ id: 'e1', name: 'Potion', price: 10 }],
    merchants: [],
  });
  assert.equal(app._data.cartLines.length, 1, 'unavailable line pruned');
  assert.equal(app._data.cartLines[0].entryId, 'e1');
});

// ---- M5: manager commerce settings, service/special editor, order actions ----

test('manager save-commerce maps unlimited funds to null and persists valid rates', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    commerce: {
      funds: 100,
      buyRateBps: 100,
      buybackRateBps: 150,
      preorders: { enabled: false, depositBps: 50, maxPerActor: 1 },
      theft: { enabled: false },
      services: [],
      specials: [],
    },
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true, isActiveGM: () => true } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  app.element = {
    querySelector: (sel) =>
      sel === '.commerce-panel'
        ? fakeCommercePanel({
            unlimitedFunds: true,
            buyRateBps: 200,
            buybackRateBps: 250,
            preordersEnabled: true,
            depositBps: 100,
            maxPerActor: 3,
            theftEnabled: true,
          })
        : null,
  };
  await app._onSaveCommerce({}, {}, {});
  const commerce = store._shops.get('shop1').commerce;
  assert.equal(commerce.funds, null, 'unlimited funds maps funds to null');
  assert.equal(commerce.buyRateBps, 200);
  assert.equal(commerce.buybackRateBps, 250);
  assert.equal(commerce.preorders.enabled, true);
  assert.equal(commerce.preorders.depositBps, 100);
  assert.equal(commerce.preorders.maxPerActor, 3);
  assert.equal(commerce.theft.enabled, true);
});

test('manager save-commerce enforces finite funds when unlimited is unchecked', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    commerce: { funds: null, buyRateBps: 100, buybackRateBps: 150, preorders: {}, theft: {} },
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true, isActiveGM: () => true } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  app.element = {
    querySelector: (sel) =>
      sel === '.commerce-panel'
        ? fakeCommercePanel({ merchantFunds: 350, unlimitedFunds: false, buyRateBps: 100, buybackRateBps: 150 })
        : null,
  };
  await app._onSaveCommerce({}, {}, {});
  assert.equal(store._shops.get('shop1').commerce.funds, 350, 'a concrete funds value is persisted');
});

test('manager save-commerce rejects a buyback rate below the buy rate without writing', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    commerce: { funds: 100, buyRateBps: 100, buybackRateBps: 150, preorders: {}, theft: {} },
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true, isActiveGM: () => true } });
  app._data.selectedShopId = 'shop1';
  let refreshed = 0;
  app._refreshData = async () => {
    refreshed += 1;
  };
  app.render = async () => {};
  app.element = {
    querySelector: (sel) =>
      sel === '.commerce-panel'
        ? fakeCommercePanel({ merchantFunds: 100, buyRateBps: 200, buybackRateBps: 150 })
        : null,
  };
  await app._onSaveCommerce({}, {}, {});
  assert.match(app._data.notice, /buybackRateBps/, 'invalid rate surfaced in the notice');
  assert.equal(store._shops.get('shop1').commerce.buyRateBps, 100, 'no write on an invalid rate');
  assert.equal(refreshed, 0, 'no data refresh after a validation error');
});

test('manager save-services merges edits by id and preserves a concurrently added service', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    commerce: {
      services: [
        { id: 'svc1', name: 'Repair', description: '', price: 5, visible: true, enabled: true },
        { id: 'svc2', name: 'Heal', description: '', price: 8, visible: true, enabled: true },
      ],
      specials: [],
    },
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true, isActiveGM: () => true } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  app.element = fakeElement({
    '[data-service-id]': [fakeServiceRow('svc1', { name: 'Repair (updated)', price: 12 })],
  });
  await app._onSaveServices({}, {}, {});
  const services = store._shops.get('shop1').commerce.services;
  assert.equal(services.length, 2, 'no service is deleted by a save');
  const byId = Object.fromEntries(services.map((s) => [s.id, s]));
  assert.equal(byId.svc1.name, 'Repair (updated)', 'edit applied to svc1');
  assert.equal(byId.svc1.price, 12);
  assert.equal(byId.svc2.name, 'Heal', 'svc2 absent from the DOM is preserved, not deleted');
  assert.equal(app._data.notice, '', 'no fail-closed notice on a valid merge');
});

test('manager save-services fails closed on a forged row id and never deletes missing services', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    commerce: { services: [{ id: 'svc1', name: 'Repair', description: '', price: 5, visible: true, enabled: true }], specials: [] },
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true, isActiveGM: () => true } });
  app._data.selectedShopId = 'shop1';
  let refreshed = 0;
  app._refreshData = async () => {
    refreshed += 1;
  };
  app.render = async () => {};
  app.element = fakeElement({
    '[data-service-id]': [
      fakeServiceRow('svc1', { name: 'Repaired' }),
      fakeServiceRow('forged', { name: 'Ghost' }),
    ],
  });
  await app._onSaveServices({}, {}, {});
  const services = store._shops.get('shop1').commerce.services;
  assert.equal(services.length, 1, 'forged id failed closed; nothing was written');
  assert.equal(services[0].name, 'Repair', 'svc1 is unchanged (no write)');
  assert.match(app._data.notice, /no longer matches a saved service/, 'fail-closed notice surfaced');
  assert.equal(refreshed, 0, 'no data refresh after a fail-closed (form preserved)');
});

test('manager save-specials rejects a special whose inventory item is gone', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [{ id: 'e1', name: 'Potion', itemUuid: 'Item.p1', price: 10, quantity: 5, stockMode: 'finite' }],
    commerce: { specials: [{ id: 'sp1', title: 'Deal', description: '', price: 4, visible: true, entryId: 'e1', actorUuids: [] }], services: [] },
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true, isActiveGM: () => true } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  app.element = fakeElement({
    '[data-special-id]': [fakeSpecialRow('sp1', { title: 'Deal', price: 4, entryId: 'ghost', actorUuids: '' })],
  });
  await app._onSaveSpecials({}, {}, {});
  assert.equal(store._shops.get('shop1').commerce.specials[0].entryId, 'e1', 'no write on a missing entry');
  assert.match(app._data.notice, /no longer available/, 'missing-entry notice surfaced');
});

test('manager save-specials validates actor UUIDs through normalization', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [{ id: 'e1', name: 'Potion', itemUuid: 'Item.p1', price: 10, quantity: 5, stockMode: 'finite' }],
    commerce: { specials: [{ id: 'sp1', title: 'Deal', description: '', price: 4, visible: true, entryId: 'e1', actorUuids: [] }], services: [] },
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true, isActiveGM: () => true } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  app.element = fakeElement({
    '[data-special-id]': [
      fakeSpecialRow('sp1', { title: 'Deal', price: 4, entryId: 'e1', actorUuids: 'Actor.abc, notauuid' }),
    ],
  });
  await app._onSaveSpecials({}, {}, {});
  assert.match(app._data.notice, /actorUuids/, 'invalid actor UUID surfaced');
  assert.equal(store._shops.get('shop1').commerce.specials[0].actorUuids.length, 0, 'no write on invalid actor uuids');
});

test('manager save-specials merges edits by id and preserves a concurrently added special', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [{ id: 'e1', name: 'Potion', itemUuid: 'Item.p1', price: 10, quantity: 5, stockMode: 'finite' }],
    commerce: {
      specials: [
        { id: 'sp1', title: 'Old deal', description: '', price: 4, visible: true, entryId: 'e1', actorUuids: [] },
        { id: 'sp2', title: 'Kept deal', description: '', price: 9, visible: true, entryId: 'e1', actorUuids: [] },
      ],
      services: [],
    },
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true, isActiveGM: () => true } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  app.element = fakeElement({
    '[data-special-id]': [fakeSpecialRow('sp1', { title: 'New deal', price: 6, entryId: 'e1', actorUuids: '' })],
  });
  await app._onSaveSpecials({}, {}, {});
  const specials = store._shops.get('shop1').commerce.specials;
  assert.equal(specials.length, 2, 'no special is deleted by a save');
  const byId = Object.fromEntries(specials.map((s) => [s.id, s]));
  assert.equal(byId.sp1.title, 'New deal', 'edit applied to sp1');
  assert.equal(byId.sp1.price, 6);
  assert.equal(byId.sp2.title, 'Kept deal', 'sp2 absent from the DOM is preserved, not deleted');
  assert.equal(app._data.notice, '', 'no fail-closed notice on a valid merge');
});

test('manager source binds the special inventory select directly to the special block parameter', () => {
  // The special editor renders a nested inventory <select> by iterating
  // `../selectedShop.inventory` with a `entry` block parameter. To preselect the
  // entry the special is bound to it must reference the OUTER `special` block
  // parameter directly (lexically scoped). A grandparent `../../special.entryId`
  // path would resolve against the ROOT context, which carries no `special`, so
  // no option would ever be marked selected.
  const template = readFileSync(new URL('../templates/manager.hbs', import.meta.url), 'utf8');
  assert.match(
    template,
    /\(eq special\.entryId entry\.id\)/,
    'the special select compares the special entry id against the iterated entry'
  );
  assert.ok(
    !template.includes('../../special.entryId'),
    'no grandparent-scoped special entry id path remains'
  );
});

test('manager add/remove service and special are active-GM gated and capped', async () => {
  // Non-active GM: no store write, only the notice.
  const store = makePersistentShopStore([
    { id: 'shop1', name: 'S', locationId: 'loc1', open: true, inventory: [], commerce: { services: [], specials: [] } },
  ]);
  const app = new MarketManager({ deps: { store, systemId: () => 'dnd5e', isGM: () => true, isActiveGM: () => false } });
  app._data.selectedShopId = 'shop1';
  app.render = async () => {};
  app._refreshData = async () => {};
  await app._onAddService({}, {}, {});
  assert.equal(store._shops.get('shop1').commerce.services.length, 0, 'non-active GM does not add');
  assert.match(app._data.notice, /active Game Master/);

  // Active GM: add a service, then hit the cap.
  const runShopExclusive = (_id, fn) => fn();
  const store2 = makePersistentShopStore([
    {
      id: 'shop1',
      name: 'S',
      locationId: 'loc1',
      open: true,
      inventory: [],
      commerce: {
        services: Array.from({ length: 20 }, (_, i) => ({ id: `svc${i}`, name: `S${i}`, description: '', price: 1, visible: true, enabled: true })),
        specials: [],
      },
    },
  ]);
  const app2 = new MarketManager({ deps: { store: store2, runShopExclusive, systemId: () => 'dnd5e', isGM: () => true, isActiveGM: () => true } });
  app2._data.selectedShopId = 'shop1';
  app2.render = async () => {};
  app2._refreshData = async () => {};
  await app2._onAddService({}, {}, {});
  assert.equal(store2._shops.get('shop1').commerce.services.length, 20, 'cap enforced');
  assert.equal(app2._data.notice, 'A shop can have at most twenty services.');

  // Remove by id.
  await app2._onRemoveService({}, { dataset: { serviceId: 'svc3' } }, {});
  assert.equal(store2._shops.get('shop1').commerce.services.length, 19, 'only the matching service removed');
  assert.ok(!store2._shops.get('shop1').commerce.services.some((s) => s.id === 'svc3'));
});

test('manager GM order actions only offer manual adjudication for booked orders and disable for a non-active GM', () => {
  const template = readFileSync(new URL('../templates/manager.hbs', import.meta.url), 'utf8');
  // The order cards gate each action on `booked` (services toString to a booked
  // order, not pending).
  assert.match(template, /\{\{#if \(eq order\.status "booked"\)\}\}/, 'order actions gate on booked');
  assert.ok(!template.includes('order.status "pending"'), 'no pending gating remains');
  assert.match(template, /data-action="fulfill-service"[\s\S]*?\{\{#unless (\.\.\/)?isActiveGM\}\}disabled/, 'fulfill-service disabled for non-active GM');
  assert.match(template, /data-action="fulfill-preorder"[\s\S]*?\{\{#unless (\.\.\/)?isActiveGM\}\}disabled/, 'fulfill-preorder disabled for non-active GM');
  assert.match(template, /data-action="cancel-preorder"[\s\S]*?\{\{#unless (\.\.\/)?isActiveGM\}\}disabled/, 'cancel-preorder disabled for non-active GM');
  assert.match(template, /data-action="resolve-theft-success"[\s\S]*?\{\{#unless (\.\.\/)?isActiveGM\}\}disabled/, 'resolve-theft-success disabled for non-active GM');
  assert.match(template, /data-action="resolve-theft-failure"[\s\S]*?\{\{#unless (\.\.\/)?isActiveGM\}\}disabled/, 'resolve-theft-failure disabled for non-active GM');
  // Inside the advancedOrders loop the active-GM scope must step OUT of the
  // `{{#each advancedOrders as |order|}}` block, so every order button references
  // `../isActiveGM` - never the shadowed `isActiveGM` (which is undefined and would
  // disable the button for an active GM).
  assert.ok(template.includes('{{#unless ../isActiveGM}}disabled'), 'order actions use the parent-scope isActiveGM');
  // Bound the scan to the advanced-orders section so legitimate bare guards in the
  // editor/generator sections (outside the loop) do not trip the check.
  const orderBlock = template.slice(
    template.indexOf('data-action="fulfill-service"'),
    template.indexOf('data-action="next-orders"')
  );
  assert.ok(
    !orderBlock.includes('{{#unless isActiveGM}}'),
    'no shadowed isActiveGM guard remains inside the order each loop'
  );
  // The commerce/special/service editor controls are read-only for a non-active GM.
  assert.match(template, /\{\{#unless (\.\.\/)?isActiveGM\}\}disabled/, 'commerce editor controls disabled for non-active GM');
  // The advanced-order list pages through booked records, exposing next/previous.
  assert.match(template, /data-action="next-orders"/, 'next-orders navigation present');
  assert.match(template, /data-action="prev-orders"/, 'prev-orders navigation present');
  assert.ok(template.includes('{{#if hasPreviousOrders}}'), 'prev gated on hasPreviousOrders');
  assert.ok(template.includes('{{#if hasNextOrders}}'), 'next gated on hasNextOrders');
});

test('manager GM order action calls the advanced service with a fresh requestId and reports the outcome', async () => {
  const calls = [];
  const app = new MarketManager({
    deps: {
      systemId: () => 'dnd5e',
      isGM: () => true,
      isActiveGM: () => true,
      fulfillService: async (p) => {
        calls.push(p);
        return { status: 'fulfilled', orderId: p.orderId };
      },
    },
  });
  app._data.selectedShopId = 'shop1';
  let ordersOnly = 0;
  app._refreshOrdersOnly = async () => {
    ordersOnly += 1;
  };
  app.render = async () => {};
  await app._onFulfillService({}, { dataset: { orderId: 'o1' } }, {});
  assert.equal(calls.length, 1, 'the advanced service is called');
  assert.equal(calls[0].orderId, 'o1', 'the order id is passed');
  assert.ok(calls[0].requestId, 'a fresh idempotency requestId is passed');
  assert.equal(app._data.notice, 'Order marked fulfilled.');
  assert.ok(ordersOnly >= 1, 'orders are refreshed (never the shop)');
});

test('manager GM order actions are active-GM gated', async () => {
  let calls = 0;
  const app = new MarketManager({
    deps: {
      systemId: () => 'dnd5e',
      isGM: () => true,
      isActiveGM: () => false,
      fulfillService: async () => {
        calls += 1;
        return { status: 'fulfilled' };
      },
    },
  });
  app._data.selectedShopId = 'shop1';
  app.render = async () => {};
  app._refreshOrdersOnly = async () => {};
  await app._onFulfillService({}, { dataset: { orderId: 'o1' } }, {});
  assert.equal(calls, 0, 'no advanced call for a non-active GM');
  assert.match(app._data.notice, /active Game Master/);
});

test('manager GM order list pages through booked advanced orders (status booked, page size 100) and exposes next/previous', async () => {
  const calls = [];
  const orders = Array.from({ length: 101 }, (_, i) => ({
    id: `o${i}`,
    kind: i % 3 === 0 ? 'service' : i % 3 === 1 ? 'preorder' : 'theft',
    status: 'booked',
    shopId: 'shop1',
    actorId: `actor-${i}`,
    entryId: `entry-${i}`,
    total: 100 + i,
    deposit: 0,
    remaining: 100 + i,
    createdAt: 1000 - i,
  }));
  const app = new MarketManager({
    deps: {
      systemId: () => 'dnd5e',
      isGM: () => true,
      isActiveGM: () => true,
      listAdvancedOrders: async ({ shopId, status, limit, offset }) => {
        calls.push({ shopId, status, limit, offset });
        const start = offset || 0;
        return orders.slice(start, start + limit);
      },
    },
  });
  app.render = async () => {};
  app._data.selectedShopId = 'shop1';

  // First page: exactly 100 booked records, with a next page available.
  await app._refreshOrdersOnly();
  assert.equal(calls.length, 1, 'one paging read');
  assert.equal(calls[0].shopId, 'shop1');
  assert.equal(calls[0].status, 'booked', 'only booked orders are fetched');
  assert.equal(calls[0].limit, 100, 'page size 100');
  assert.equal(calls[0].offset, 0);
  assert.equal(app._data.advancedOrders.length, 100);
  assert.equal(app._data.hasNextOrders, true);
  assert.equal(app._data.hasPreviousOrders, false);

  // Advance to the second page: one remaining record, no further page.
  await app._onNextOrders();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].offset, 100, 'second page offset is 100');
  assert.equal(app._data.advancedOrders.length, 1, 'second page carries the single old order');
  assert.equal(app._data.advancedOrders[0].id, 'o100', 'the old booked order is reachable');
  assert.ok(['service', 'preorder', 'theft'].includes(app._data.advancedOrders[0].kind), 'old order is an actionable kind');
  assert.equal(app._data.hasNextOrders, false);
  assert.equal(app._data.hasPreviousOrders, true);

  // Step back to the first page.
  await app._onPrevOrders();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].offset, 0);
  assert.equal(app._data.advancedOrders.length, 100);
  assert.equal(app._data.hasNextOrders, true);
  assert.equal(app._data.hasPreviousOrders, false);
});

test('manager GM order list steps back to a non-empty page when the current page empties', async () => {
  const orders = Array.from({ length: 100 }, (_, i) => ({
    id: `o${i}`,
    kind: 'service',
    status: 'booked',
    shopId: 'shop1',
    actorId: `actor-${i}`,
    entryId: `entry-${i}`,
    total: 100 + i,
    deposit: 0,
    remaining: 100 + i,
    createdAt: 1000 - i,
  }));
  const app = new MarketManager({
    deps: {
      systemId: () => 'dnd5e',
      isGM: () => true,
      isActiveGM: () => true,
      listAdvancedOrders: async ({ limit, offset }) => {
        const start = offset || 0;
        return orders.slice(start, start + limit);
      },
    },
  });
  app.render = async () => {};
  app._data.selectedShopId = 'shop1';

  // Simulate a GM who navigated to the second page: page 1 is empty (there are
  // exactly 100 records, offset 100 slices to nothing), so a refresh must fall
  // back to the first page instead of stranding the GM on an empty page.
  app._data.orderPage = 1;
  await app._refreshOrdersOnly();
  assert.equal(app._data.orderPage, 0, 'steps back to the first page');
  assert.equal(app._data.advancedOrders.length, 100, 'shows the non-empty first page');
  // Page 0 is exactly full, so the first page itself still offers a next page
  // (the one that just emptied); clicking it self-corrects back to page 0.
  assert.equal(app._data.hasNextOrders, true, 'a full first page still offers next');
  assert.equal(app._data.hasPreviousOrders, false, 'no page before the first');
});

test('manager resolve-theft passes a typed success boolean', async () => {
  const calls = [];
  const app = new MarketManager({
    deps: {
      systemId: () => 'dnd5e',
      isGM: () => true,
      isActiveGM: () => true,
      resolveTheft: async (p) => {
        calls.push(p);
        return { status: 'committed', orderId: p.orderId };
      },
    },
  });
  app._data.selectedShopId = 'shop1';
  app._refreshOrdersOnly = async () => {};
  app.render = async () => {};
  await app._onResolveTheftSuccess({}, { dataset: { orderId: 'o1' } }, {});
  await app._onResolveTheftFailure({}, { dataset: { orderId: 'o1' } }, {});
  assert.equal(calls.length, 2);
  assert.equal(calls[0].success, true, 'resolve success passes a typed true');
  assert.equal(calls[1].success, false, 'resolve failure passes a typed false');
  assert.ok(calls[0].requestId, 'a fresh requestId is passed');
  assert.ok(calls[1].requestId);
  assert.equal(app._data.notice, 'Order resolved.');
});

test('manager save-entry persists the M5 access gate', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      { id: 'e1', name: 'Potion', itemUuid: 'Item.p1', price: 10, quantity: 5, stockMode: 'finite' },
    ],
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, runShopExclusive: (_id, fn) => fn(), systemId: () => 'dnd5e' } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await app._onSaveEntry(
    {},
    fakeTrAccess('e1', { accessMode: 'backroom', accessActorUuids: 'Actor.a1, Actor.b2', accessMinReputation: 2 }),
    {}
  );
  const saved = store._shops.get('shop1').inventory[0];
  assert.equal(saved.access.mode, 'backroom', 'backroom gate persisted');
  assert.deepEqual(saved.access.actorUuids, ['Actor.a1', 'Actor.b2'], 'actor UUIDs split and trimmed');
  assert.equal(saved.access.minReputation, 2);
});

test('manager save-entry preserves the persisted min reputation when the row omits it', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      {
        id: 'e1',
        name: 'Potion',
        itemUuid: 'Item.p1',
        price: 10,
        quantity: 5,
        stockMode: 'finite',
        access: { mode: 'backroom', actorUuids: ['Actor.a1'], minReputation: 5 },
      },
    ],
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, runShopExclusive: (_id, fn) => fn(), systemId: () => 'dnd5e' } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  await app._onSaveEntry(
    {},
    fakeTrAccess('e1', { accessMode: 'backroom', accessActorUuids: '', withMinReputation: false }),
    {}
  );
  const saved = store._shops.get('shop1').inventory[0];
  assert.equal(saved.access.mode, 'backroom');
  assert.deepEqual(saved.access.actorUuids, [], 'empty actor UUID field clears the list');
  assert.equal(saved.access.minReputation, 5, 'omitted min reputation preserves the persisted value');
});

test('manager save-entry without access controls never resets a saved gate', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      {
        id: 'e1',
        name: 'Potion',
        itemUuid: 'Item.p1',
        price: 10,
        quantity: 5,
        stockMode: 'finite',
        access: { mode: 'backroom', actorUuids: ['Actor.a1'], minReputation: 5 },
      },
    ],
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({ deps: { store, runShopExclusive: (_id, fn) => fn(), systemId: () => 'dnd5e' } });
  app._data.selectedShopId = 'shop1';
  app._refreshData = async () => {};
  app.render = async () => {};
  // A plain row (no access controls) - the saved gate must be carried through.
  await app._onSaveEntry({}, fakeTr('e1', { price: 11, quantity: 6 }), {});
  const saved = store._shops.get('shop1').inventory[0];
  assert.equal(saved.access.mode, 'backroom', 'no access controls preserve the persisted mode');
  assert.deepEqual(saved.access.actorUuids, ['Actor.a1']);
  assert.equal(saved.access.minReputation, 5);
});

test('manager refreshData projects accessActorUuidsText onto the selected shop inventory', async () => {
  const shop = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      {
        id: 'e1',
        name: 'Potion',
        itemUuid: 'Item.p1',
        price: 10,
        quantity: 5,
        stockMode: 'finite',
        access: { mode: 'backroom', actorUuids: ['Actor.a1', 'Actor.b2'], minReputation: 2 },
      },
    ],
  };
  const store = makePersistentShopStore([shop]);
  const app = new MarketManager({
    deps: { store, systemId: () => 'dnd5e', isGM: () => true, listActors: () => [] },
  });
  await app._refreshData();
  const entry = app._data.selectedShop.inventory[0];
  assert.equal(entry.accessActorUuidsText, 'Actor.a1, Actor.b2', 'access uuid text projected for GM display');
});


test('storefront M5: a failed cart replay does not clear the cart and surfaces recovery, not completion', async () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: { hasActiveGM: () => true } });
  app.render = async () => {};
  app._request = async () => null;
  app._data.selectedActorId = 'a1';
  app._data.shop = { open: true, specials: [], services: [] };
  app._data.cartLines = [{ entryId: 'e1', quantity: 1, specialId: '' }];
  app._data.pending = true;
  app._pendingAdvancedRequestId = 'adv-1';
  app._pendingAdvancedType = 'cart';

  // The original persisted `failed`, so the replay is a failure, NOT a completed
  // checkout: the cart must be kept and the feedback must not say "complete".
  await app._onAdvancedResponse({
    type: 'cart',
    result: { status: 'replay', originalStatus: 'failed', orderId: 'o1' },
    actorId: 'a1',
    shopId: 'shop1',
  });
  assert.equal(app._data.cartLines.length, 1, 'cart NOT cleared on a failed replay');
  assert.equal(app._data.pending, false);
  assert.ok(app._data.feedback.includes('pending recovery'), 'recovery feedback, not a completion');
  assert.ok(!app._data.feedback.includes('complete'), 'no completed message on a failed replay');
});

test('storefront M5: a committed cart replay clears the cart and reports complete', async () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: { hasActiveGM: () => true } });
  app.render = async () => {};
  app._request = async () => null;
  app._data.selectedActorId = 'a1';
  app._data.shop = { open: true, specials: [], services: [] };
  app._data.cartLines = [{ entryId: 'e1', quantity: 1, specialId: '' }];
  app._data.pending = true;
  app._pendingAdvancedRequestId = 'adv-1';
  app._pendingAdvancedType = 'cart';

  await app._onAdvancedResponse({
    type: 'cart',
    result: { status: 'replay', originalStatus: 'committed', orderId: 'o1' },
    actorId: 'a1',
    shopId: 'shop1',
  });
  assert.equal(app._data.cartLines.length, 0, 'committed replay clears the cart');
  assert.equal(app._data.feedback, 'Cart checkout complete.');
});

test('storefront M5: a needsRecovery cart replay keeps the cart and surfaces recovery', async () => {
  const app = new MarketStorefront({ shopId: 'shop1', deps: { hasActiveGM: () => true } });
  app.render = async () => {};
  app._request = async () => null;
  app._data.selectedActorId = 'a1';
  app._data.shop = { open: true, specials: [], services: [] };
  app._data.cartLines = [{ entryId: 'e1', quantity: 1, specialId: '' }];
  app._data.pending = true;
  app._pendingAdvancedRequestId = 'adv-1';
  app._pendingAdvancedType = 'cart';

  await app._onAdvancedResponse({
    type: 'cart',
    result: { status: 'replay', originalStatus: 'needsRecovery', orderId: 'o1' },
    actorId: 'a1',
    shopId: 'shop1',
  });
  assert.equal(app._data.cartLines.length, 1, 'cart kept on a needsRecovery replay');
  assert.ok(app._data.feedback.includes('pending recovery'));
});
