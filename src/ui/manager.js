// GM market manager application (Foundry VTT v14).
//
// GM-only. Lists locations/shops, edits shop details and inventory, adds items
// via a native searchable picker or a UUID input, accepts drag-dropped Items,
// and places/opens shops. All reads/writes go through the GM's private store.
//
// The application can be opened in two ways:
//   - `game.modules.get('market').api.openManager()` (deps injected by main.js)
//   - a Settings menu entry registered by main.js (no deps) - in which case it
//     falls back to reading `game.modules.get('market').api` and Foundry globals.

import { shopDragData } from '../canvas/placements.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const CURRENCY_LABELS = { dnd5e: 'cp' };

export class MarketManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static PARTS = {
    manager: {
      template: 'modules/market/templates/manager.hbs',
      id: 'manager',
      scrollable: [''],
    },
  };

  // Build a CALLABLE static action wrapper. The wrapper is stored in the static
  // DEFAULT_OPTIONS.actions map; at dispatch time ApplicationV2 calls it with
  // `this` bound to the live application instance, so it can delegate to the
  // matching instance `_on...` method. This avoids referencing an undefined
  // instance method from a static context.
  static _action(method) {
    return function (event, target, data) {
      return this[method](event, target, data);
    };
  }

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: ['market-manager-app'],
    title: 'Foundry Market',
    // Sensible large default dimensions; `position` sets the default width/height
    // and `window.resizable` lets the GM resize. Content layout is viewport-aware.
    position: { width: 1000, height: 760 },
    window: { ...(super.DEFAULT_OPTIONS?.window || {}), resizable: true },
    actions: {
      'create-location': this._action('_onCreateLocation'),
      'select-location': this._action('_onSelectLocation'),
      'create-shop': this._action('_onCreateShop'),
      'select-shop': this._action('_onSelectShop'),
      'save-shop': this._action('_onSaveShop'),
      'add-item-picker': this._action('_onTogglePicker'),
      'add-item-uuid': this._action('_onAddItemUuid'),
      'add-item': this._action('_onAddItem'),
      'save-entry': this._action('_onSaveEntry'),
      'delete-entry': this._action('_onDeleteEntry'),
      'place-shop': this._action('_onPlaceShop'),
      'open-shop': this._action('_onOpenShop'),
    },
  };

  constructor(options = {}) {
    super(options);
    this._deps = options.deps || {};
    this._loaded = false;
    this._data = {
      locations: [],
      shops: [],
      selectedLocationId: null,
      selectedShopId: null,
      selectedShop: null,
      currencyLabel: this._currencyLabel(),
      stockModes: ['finite', 'unlimited', 'non-restocking'],
      pickerOpen: false,
      pickerItems: [],
      notice: '',
    };
  }

  // ---- lazy dependency accessors (fall back to live globals) -----------------

  get _store() {
    return this._deps.store || this._api()?.store;
  }

  _api() {
    return this._deps.api || game?.modules?.get?.('market')?.api;
  }

  _systemId() {
    if (this._deps.systemId) return this._deps.systemId();
    return String(game?.system?.id || '');
  }

  _isGM() {
    if (this._deps.isGM) {
      const userId = game?.user?.id;
      return !!userId && this._deps.isGM(userId);
    }
    return !!game?.user?.isGM;
  }

  _getAdapter() {
    const make = this._deps.getAdapter || this._api()?.getAdapter;
    if (make) return make(this._systemId());
    return null;
  }

  async _fromUuid(uuid) {
    if (this._deps.fromUuid) return this._deps.fromUuid(uuid);
    if (typeof fromUuid === 'function') return fromUuid(uuid);
    return null;
  }

  async _listItems() {
    if (this._deps.listItems) return this._deps.listItems();
    const out = [];
    const seen = new Set();
    for (const item of game.items ?? []) {
      if (item.uuid && !seen.has(item.uuid)) {
        seen.add(item.uuid);
        out.push({ uuid: item.uuid, name: item.name, img: item.img || '' });
      }
    }
    for (const pack of game.packs ?? []) {
      if (pack.documentClass?.name !== 'Item') continue;
      const docs = await pack.getDocuments();
      for (const item of docs) {
        const uuid = item.uuid || `${pack.collection}.${item.id}`;
        if (seen.has(uuid)) continue;
        seen.add(uuid);
        out.push({ uuid, name: item.name, img: item.img || '' });
      }
    }
    return out;
  }

  _openShop(shopId) {
    if (this._deps.openShop) return this._deps.openShop(shopId);
    return this._api()?.openShop?.(shopId);
  }

  _placeShop(shopId) {
    if (this._deps.placeShop) return this._deps.placeShop(shopId);
    return this._api()?.placeShop?.(shopId);
  }

  // Shared per-shop coordination lock. Purchases and GM inventory edits share
  // this lock by shop, so a purchase and a manager edit can never overwrite
  // each other's inventory. Falls back to an uncoordinated run when the lock is
  // not injected (e.g. unit tests).
  get _runShopExclusive() {
    if (this._deps.runShopExclusive) return this._deps.runShopExclusive;
    return this._api()?.commerce?.runShopExclusive;
  }

  _withShopLock(shopId, fn) {
    const run = this._runShopExclusive;
    if (typeof run === 'function') return run(shopId, fn);
    return fn();
  }

  _getDragEventData(event) {
    if (this._deps.getDragEventData) return this._deps.getDragEventData(event);
    if (typeof TextEditor !== 'undefined') return TextEditor.getDragEventData(event);
    return {};
  }

  // GM text entry. Uses the native `window.prompt` (no V1 `Dialog.prompt`
  // dependency, no raw HTML interpolation). Tests can inject their own via
  // `deps.promptText` / `deps.promptNumber`.
  _promptText(label, { defaultValue = '' } = {}) {
    if (this._deps.promptText) return this._deps.promptText(label, { defaultValue });
    return Promise.resolve(window.prompt(label, defaultValue));
  }

  _promptNumber(label, { defaultValue = 0 } = {}) {
    if (this._deps.promptNumber) return this._deps.promptNumber(label, { defaultValue });
    const raw = window.prompt(`${label} (integer)`, String(defaultValue));
    if (raw == null) return Promise.resolve(null);
    const n = Number(raw);
    return Promise.resolve(Number.isFinite(n) ? n : null);
  }

  // ---- context / lifecycle -------------------------------------------------

  _prepareContext(options) {
    return this._data;
  }

  async _onRender(event) {
    if (!this._loaded) {
      await this._refreshData();
      this._loaded = true;
      this.render({ force: true });
      return;
    }
    this._bindDnd();
  }

  _currencyLabel() {
    return CURRENCY_LABELS[this._systemId()] || '';
  }

  // ---- data refresh ---------------------------------------------------------

  async _refreshData() {
    // Fail closed for a non-GM user: show an empty manager with a clear notice
    // instead of reading the private store a player cannot edit.
    if (!this._isGM()) {
      this._data = {
        ...this._data,
        locations: [],
        shops: [],
        selectedLocationId: null,
        selectedShopId: null,
        selectedShop: null,
        notice: 'Only the Game Master can manage the market.',
      };
      return;
    }
    const locations = await this._store.listLocations();
    let selectedLocationId = this._data.selectedLocationId;
    if (!selectedLocationId && locations.length) {
      selectedLocationId = locations[0].id;
    }
    const shops = await this._store.listShops({
      locationId: selectedLocationId || undefined,
    });
    const shopsView = shops.map((s) => ({
      ...s,
      inventoryCount: Array.isArray(s.inventory) ? s.inventory.length : 0,
    }));
    let selectedShopId = this._data.selectedShopId;
    if (!shopsView.find((s) => s.id === selectedShopId)) {
      selectedShopId = shopsView[0]?.id || null;
    }
    const selectedShop = shopsView.find((s) => s.id === selectedShopId) || null;
    this._data = {
      ...this._data,
      locations,
      shops: shopsView,
      selectedLocationId,
      selectedShopId,
      selectedShop,
      currencyLabel: this._currencyLabel(),
      stockModes: ['finite', 'unlimited', 'non-restocking'],
      notice: '',
    };
  }

  async _refreshPickerItems() {
    const items = await this._listItems();
    this._data.pickerItems = items;
  }

  // ---- actions --------------------------------------------------------------

  async _onCreateLocation(event, target, data) {
    const name = await this._promptText('Location name');
    if (!name) return;
    await this._store.createLocation({ name });
    await this._refreshData();
    this.render({ force: true });
  }

  async _onSelectLocation(event, target, data) {
    const id = target?.dataset?.locationId || data?.dataset?.locationId;
    this._data.selectedLocationId = id;
    this._data.selectedShopId = null;
    await this._refreshData();
    this.render({ force: true });
  }

  async _onCreateShop(event, target, data) {
    const locationId = this._data.selectedLocationId;
    if (!locationId) {
      this._data.notice = 'Create a location before adding a shop.';
      this.render({ force: true });
      return;
    }
    const name = await this._promptText('Shop name');
    if (!name) return;
    const shop = await this._store.createShop({ name, locationId });
    this._data.selectedShopId = shop.id;
    await this._refreshData();
    this.render({ force: true });
  }

  async _onSelectShop(event, target, data) {
    const id = target?.dataset?.shopId || data?.dataset?.shopId;
    this._data.selectedShopId = id;
    await this._refreshData();
    this.render({ force: true });
  }

  async _onSaveShop(event, target, data) {
    const shopId = this._data.selectedShopId;
    const shop = this._data.selectedShop;
    if (!shopId || !shop) return;
    // _readShopForm excludes inventory, so the metadata patch can never clobber
    // stock that a concurrent purchase or add-item just changed. The per-shop
    // lock still serializes the read+merge+write against purchases.
    const patch = this._readShopForm();
    await this._withShopLock(shopId, async () => {
      const next = await this._store.updateShop(shopId, patch);
      if (!next) {
        this._data.notice = 'Shop not found when saving.';
      }
    });
    await this._refreshData();
    this.render({ force: true });
  }

  async _onTogglePicker(event, target, data) {
    this._data.pickerOpen = !this._data.pickerOpen;
    this._data.notice = '';
    if (this._data.pickerOpen && this._data.pickerItems.length === 0) {
      await this._refreshPickerItems();
    }
    this.render({ force: true });
  }

  async _onAddItemUuid(event, target, data) {
    const uuid = String(this._readField('itemUuid') || '').trim();
    if (!uuid) return;
    return this._addItemByUuid(uuid);
  }

  async _onAddItem(event, target, data) {
    const uuid = target?.dataset?.uuid || data?.dataset?.uuid;
    if (!uuid) return;
    return this._addItemByUuid(uuid);
  }

  async _onSaveEntry(event, target, data) {
    const tr = target?.closest?.('tr');
    if (!tr) return;
    const entryId = tr.dataset.entryId;
    if (!entryId) return;
    const price = this._readNumber(tr, 'price');
    const quantity = this._readNumber(tr, 'quantity');
    const stockMode = this._readFieldIn(tr, 'stockMode');
    const visible = this._readChecked(tr, 'visible');
    if (price == null || quantity == null || !stockMode) return;
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    // Re-read the shop inside the shared per-shop lock and alter only the
    // target entry, so a concurrent purchase's stock decrement is never lost.
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        this._data.notice = 'Shop not found when saving.';
        return;
      }
      const inventory = shop.inventory.map((e) =>
        e.id === entryId
          ? { ...e, price, quantity, stockMode, visible: visible !== false }
          : e
      );
      await this._store.updateShop(shopId, { inventory });
    });
    await this._refreshData();
    this.render({ force: true });
  }

  async _onDeleteEntry(event, target, data) {
    const entryId = target?.dataset?.entryId || data?.dataset?.entryId;
    if (!entryId) return;
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    // Re-read the shop inside the shared per-shop lock and drop only the target
    // entry, preserving any stock change made by a concurrent purchase.
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) return;
      const inventory = shop.inventory.filter((e) => e.id !== entryId);
      await this._store.updateShop(shopId, { inventory });
    });
    await this._refreshData();
    this.render({ force: true });
  }

  async _onPlaceShop(event, target, data) {
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    await this._placeShop(shopId);
  }

  async _onOpenShop(event, target, data) {
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    await this._openShop(shopId);
  }

  // ---- item add helper ------------------------------------------------------

  async _addItemByUuid(uuid) {
    const source = await this._fromUuid(uuid);
    if (!source) {
      this._data.notice = `Item not found: ${uuid}`;
      this.render({ force: true });
      return;
    }
    const snapshot = JSON.stringify(source.toObject());
    const adapter = this._getAdapter();
    let minorUnits;
    if (adapter && adapter.supported) {
      const price = await adapter.getItemPrice(source);
      minorUnits = price.minorUnits;
    } else {
      const manual = await this._promptNumber('Item price (minor units)', {
        defaultValue: 0,
      });
      if (manual == null) return;
      minorUnits = manual;
    }
    const shopId = this._data.selectedShopId;
    // Append under the shared per-shop lock so an add-item never clobbers a
    // concurrent purchase's stock change (addInventoryEntry re-reads + writes).
    await this._withShopLock(shopId, () =>
      this._store.addInventoryEntry(shopId, {
        itemUuid: uuid,
        snapshot,
        name: source.name,
        img: source.img || '',
        price: minorUnits,
        quantity: 1,
        stockMode: 'finite',
        visible: true,
      })
    );
    this._data.notice = '';
    this._data.pickerOpen = false;
    await this._refreshData();
    this.render({ force: true });
  }

  // ---- form reading ----------------------------------------------------------

  _readField(name) {
    const el = this.element?.querySelector?.(`[name="${name}"]`);
    return this._fieldValue(el);
  }

  _fieldValue(el) {
    if (!el) return undefined;
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') return el.value === '' ? undefined : Number(el.value);
    return el.value;
  }

  _readNumber(scope, name) {
    const el = scope?.querySelector?.(`[name="${name}"]`);
    const v = this._fieldValue(el);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  _readFieldIn(scope, name) {
    return scope?.querySelector?.(`[name="${name}"]`)?.value;
  }

  _readChecked(scope, name) {
    return !!scope?.querySelector?.(`[name="${name}"]`)?.checked;
  }

  _readShopForm() {
    return {
      name: this._readField('name'),
      owner: this._readField('owner'),
      theme: this._readField('theme'),
      description: this._readField('description'),
      open: this._readField('open'),
    };
  }

  // ---- drag / drop wiring -----------------------------------------------------

  _bindDnd() {
    const root = this.element;
    if (!root) return;
    root.querySelectorAll('[data-shop-id]').forEach((el) => {
      el.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', shopDragData(el.dataset.shopId));
        event.dataTransfer.effectAllowed = 'copy';
      });
    });
    const dropZone = root.querySelector('[data-drop-zone]');
    if (dropZone) {
      dropZone.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      });
      dropZone.addEventListener('drop', async (event) => {
        event.preventDefault();
        const data = this._getDragEventData(event);
        if (data?.type === 'Item' && data.uuid) {
          await this._addItemByUuid(data.uuid);
        }
      });
    }
    const pickerSearch = root.querySelector('[name="pickerSearch"]');
    if (pickerSearch) {
      pickerSearch.addEventListener('input', () => this._filterPicker(pickerSearch.value));
    }
  }

  _filterPicker(term) {
    const query = String(term || '').trim().toLowerCase();
    const root = this.element;
    if (!root) return;
    root.querySelectorAll('.picker-item').forEach((item) => {
      const label = item.querySelector('span:last-child')?.textContent || '';
      const hay = `${label} ${item.querySelector('img')?.alt || ''}`.toLowerCase();
      item.style.display = !query || hay.includes(query) ? '' : 'none';
    });
  }
}

export default MarketManager;
