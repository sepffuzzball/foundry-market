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
import {
  ACCENT_COLOR_RE,
  MAX_SHOP_NPCS,
  makeId,
  normalizeNpc,
  normalizeShopSocial,
} from '../services/model.js';
import { getTheme, THEME_IDS, normalizeTheme, normalizeAppearance, sanitizeMediaPath } from '../themes/registry.js';
import { PERSONALITY_IDS, getPersonality } from '../social/personalities.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const CURRENCY_LABELS = { dnd5e: 'cp' };

// The shop-details/appearance form fields whose edits must be captured into the
// unsaved draft as the GM types. Inventory row fields (price, quantity, stock
// mode, visibility, public fields) and the picker/uuid/search inputs are NOT in
// this list, so an inventory change never overwrites the captured metadata.
const SHOP_FORM_FIELDS = [
  'name',
  'owner',
  'theme',
  'description',
  'open',
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
      'preview-appearance': this._action('_onPreviewAppearance'),
      'reset-preview': this._action('_onResetPreview'),
      'browse-media': this._action('_onBrowseMedia'),
      'save-social': this._action('_onSaveSocial'),
      'add-npc': this._action('_onAddNpc'),
      'save-npcs': this._action('_onSaveNpcs'),
      'remove-npc': this._action('_onRemoveNpc'),
      'select-reputation-actor': this._action('_onSelectReputationActor'),
      'adjust-reputation': this._action('_onAdjustReputation'),
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
      themeOptions: THEME_IDS.map((id) => ({ id, label: getTheme(id).label })),
      themeMeta: null,
      previewShop: null,
      // Raw, unsaved form inputs for the selected shop. This is captured on a
      // Preview or Save attempt and drives the `editingShop` form bindings so a
      // re-render never resets the GM's in-progress edits. Cleared on reset,
      // shop/location switch and a successful save.
      draftShop: null,
      // M3 social context. `personalityOptions` drives the primary/secondary/NPC
      // personality dropdowns from the canonical preset ids; the reputation editor
      // loads its actors, selected actor, current record and recent history once a
      // character is chosen (see `_loadReputation`).
      personalityOptions: PERSONALITY_IDS.map((id) => ({ id, label: getPersonality(id).label })),
      reputationActors: [],
      selectedReputationActorId: null,
      selectedReputation: null,
      reputationHistory: [],
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

  // ---- M3 social / reputation lazy accessors ---------------------------------

  _listActors() {
    if (this._deps.listActors) return this._deps.listActors();
    const out = [];
    for (const actor of game?.actors ?? []) {
      out.push({ id: actor.id, name: actor.name, uuid: actor.uuid });
    }
    return out;
  }

  _getActor(id) {
    if (this._deps.getActor) return this._deps.getActor(id);
    return game?.actors?.get?.(id) || null;
  }

  _getReputation(shopId, actorId) {
    if (this._deps.getReputation) return this._deps.getReputation(shopId, actorId);
    return this._api()?.getReputation?.(shopId, actorId);
  }

  _adjustReputation(params) {
    if (this._deps.adjustReputation) return this._deps.adjustReputation(params);
    return this._api()?.reputation?.adjust?.(params);
  }

  _formatDate(ts) {
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
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
    // The preview panel is a local, unsaved look at the current form. When no
    // preview is active fall back to the persisted shop theme so the panel is
    // never rendered with stale/missing metadata.
    const themeId = this._data.previewShop?.theme || this._data.selectedShop?.theme;
    this._data.themeMeta = this._themeMetaFor(themeId);
    // The details/appearance form inputs bind to `editingShop`, which reflects a
    // captured unsaved draft when one exists so a re-render never resets the GM's
    // in-progress edits. Inventory rows stay bound to the persisted `selectedShop`.
    this._data.editingShop = this._buildEditingShop();
    return this._data;
  }

  /**
   * Build the shop object used for the details/appearance form bindings. When a
   * captured draft exists it overrides the persisted values for the form fields;
   * otherwise the persisted `selectedShop` is used verbatim. Inventory is always
   * drawn from `selectedShop`, never from this object.
   */
  _buildEditingShop() {
    const persisted = this._data.selectedShop || {};
    const draft = this._data.draftShop;
    if (!draft) return persisted;
    return {
      ...persisted,
      name: draft.name ?? persisted.name,
      owner: draft.owner ?? persisted.owner,
      theme: draft.theme ?? persisted.theme,
      description: draft.description ?? persisted.description,
      open: draft.open ?? persisted.open,
      appearance: this._mergeAppearance(persisted.appearance, draft.appearance),
    };
  }

  _mergeAppearance(base, edits) {
    const out = { ...(base || {}) };
    for (const key of Object.keys(edits || {})) {
      if (edits[key] !== undefined) out[key] = edits[key];
    }
    return out;
  }

  _themeMetaFor(themeId) {
    const meta = themeId ? getTheme(normalizeTheme(themeId)) : null;
    if (!meta) return null;
    return {
      id: meta.id,
      label: meta.label,
      glyph: meta.icon,
      blurb: meta.blurb,
      cssClass: meta.cssClass,
    };
  }

  async _onRender(event) {
    if (!this._loaded) {
      await this._refreshData();
      this._loaded = true;
      this.render({ force: true });
      return;
    }
    this._bindDnd();
    this._bindShopForm();
    this._bindReputationActor();
    this._applyPreviewStyles();
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
        previewShop: null,
        draftShop: null,
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
      previewShop: null,
      notice: '',
    };
    // M3: refresh the reputation-actor selector and, when a character is still
    // selected, re-read their (GM-only) effective reputation and recent history
    // so the editor never shows a stale record for a different actor/shop.
    const actors = this._listActors();
    const kept = this._data.selectedReputationActorId;
    let selectedReputationActorId = actors.find((a) => a.id === kept) ? kept : actors[0]?.id || null;
    this._data.reputationActors = actors;
    this._data.selectedReputationActorId = selectedReputationActorId;
    if (selectedReputationActorId) {
      await this._loadReputation(selectedReputationActorId);
    } else {
      this._data.selectedReputation = null;
      this._data.reputationHistory = [];
    }
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
    this._data.previewShop = null;
    this._data.draftShop = null;
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
    this._data.previewShop = null;
    this._data.draftShop = null;
    await this._refreshData();
    this.render({ force: true });
  }

  async _onSelectShop(event, target, data) {
    const id = target?.dataset?.shopId || data?.dataset?.shopId;
    this._data.selectedShopId = id;
    this._data.previewShop = null;
    this._data.draftShop = null;
    await this._refreshData();
    this.render({ force: true });
  }

  async _onSaveShop(event, target, data) {
    const shopId = this._data.selectedShopId;
    const shop = this._data.selectedShop;
    if (!shopId || !shop) return;
    // Capture the RAW current form into the draft so an invalid save keeps the
    // GM's exact inputs for correction on the next render. `_validateShopForm`
    // excludes inventory, so the metadata patch can never clobber stock that a
    // concurrent purchase or add-item just changed. The per-shop lock still
    // serializes the read+merge+write against purchases. Appearance validation
    // is strict (media path + accent color), and an invalid form must surface in
    // the notice without writing to the store.
    const draft = this._captureShopForm();
    let patch;
    try {
      patch = this._validateShopForm(draft);
    } catch (err) {
      this._data.draftShop = draft;
      this._data.notice = err?.message
        ? String(err.message).replace(/^\[market\]\s*/, '')
        : 'Invalid shop settings.';
      this.render({ force: true });
      return;
    }
    await this._withShopLock(shopId, async () => {
      const next = await this._store.updateShop(shopId, patch);
      if (!next) {
        this._data.notice = 'Shop not found when saving.';
      }
    });
    await this._refreshData();
    // A successful save clears the captured draft; `_refreshData` preserves it
    // across inventory edits, so this explicit reset is what discards it.
    this._data.draftShop = null;
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
    const publicDescription = this._readFieldIn(tr, 'publicDescription');
    const category = this._readFieldIn(tr, 'category');
    const rarity = this._readFieldIn(tr, 'rarity');
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
          ? {
              ...e,
              price,
              quantity,
              stockMode,
              visible: visible !== false,
              publicDescription,
              category,
              rarity,
            }
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

  // ---- appearance preview / media browse --------------------------------------

  /**
   * Build a temporary shop from the CURRENT form (including unsaved appearance
   * edits), normalize it, and render a preview. Never persists; the preview is
   * purely local to this manager session and is discarded on save/switch.
   */
  async _onPreviewAppearance(event, target, data) {
    const shop = this._data.selectedShop;
    if (!shop) return;
    // Capture the RAW form into the draft BEFORE validating so that, if the
    // preview is rejected, the exact input is preserved for correction. The
    // preview is only shown after validation succeeds.
    const draft = this._captureShopForm();
    let form;
    try {
      form = this._validateShopForm(draft);
    } catch (err) {
      this._data.draftShop = draft;
      this._data.notice = err?.message
        ? String(err.message).replace(/^\[market\]\s*/, '')
        : 'Invalid appearance settings.';
      this._data.previewShop = null;
      this.render({ force: true });
      return;
    }
    this._data.draftShop = draft;
    // Preview uses the CURRENT form values (not the persisted shop) for every
    // field the template renders, and only the validated/normalized appearance.
    this._data.previewShop = {
      id: shop.id,
      name: form.name || shop.name,
      owner: form.owner,
      description: form.description,
      open: form.open,
      theme: form.theme,
      appearance: form.appearance,
    };
    this._data.notice = '';
    this.render({ force: true });
  }

  async _onResetPreview(event, target, data) {
    this._data.draftShop = null;
    this._data.previewShop = null;
    this._data.notice = '';
    this.render({ force: true });
  }

  /**
   * Browse for a local media path. music/soundEffect open the audio picker;
   * every other field opens the image picker. Uses the official v14 FilePicker
   * constructor with a callback that writes the chosen path into the matching
   * form input. Tests inject `deps.browseMedia(type, setValue)`.
   */
  async _onBrowseMedia(event, target, data) {
    const fieldName = target?.dataset?.mediaTarget || data?.dataset?.mediaTarget;
    if (!fieldName) return;
    const type = fieldName === 'music' || fieldName === 'soundEffect' ? 'audio' : 'image';
    const setValue = (path) => this._setMediaField(fieldName, path);
    if (typeof this._deps.browseMedia === 'function') {
      const chosen = await this._deps.browseMedia(type, setValue);
      // If the injectable already wrote the input via setValue, treat a truthy
      // return as an additional confirmation (idempotent). A null/undefined
      // return means the picker was cancelled.
      if (chosen && chosen !== true) setValue(chosen);
      return;
    }
    // Official Foundry v14 FilePicker; the callback writes the input directly.
    // Access the picker via the namespaced `foundry.applications.apps.FilePicker`
    // (not the legacy global `FilePicker`), which is the v14 canonical class.
    const Picker = foundry?.applications?.apps?.FilePicker;
    if (typeof Picker === 'function') {
      const picker = new Picker({ type, callback: setValue });
      picker.render(true);
    }
  }

  _setMediaField(fieldName, path) {
    const valid = sanitizeMediaPath(path);
    if (!valid) {
      // Leave the input untouched so a previously chosen valid path is never
      // erased, and surface a readable notice instead.
      this._data.notice = 'Selected file is not a valid local asset path.';
      return;
    }
    const input = this.element?.querySelector?.(`[name="${fieldName}"]`);
    if (input) input.value = valid;
    this._data.notice = '';
    // Capture the chosen media into the unsaved draft and invalidate any stale
    // preview, so an inventory-action re-render preserves the chosen media and
    // the GM can still save it.
    this._onShopFormChange({});
  }

  /**
   * Apply the validated preview appearance to the live `.preview-panel` DOM. The
   * preview shop has already passed `normalizeAppearance` (so its media paths and
   * accent color are safe), but this method re-checks each style defensively:
   * `--mk-custom-accent` is set only for a strict `#rrggbb`, and the background
   * image only for a valid local media path. Any previously applied style is
   * cleared first so a re-render never leaks a stale value from an earlier shop.
   */
  _applyPreviewStyles() {
    const root = this.element;
    if (!root || typeof root.querySelector !== 'function') return;
    const panel = root.querySelector('.preview-panel');
    if (!panel || typeof panel.style === 'undefined') return;
    const appearance = this._data.previewShop?.appearance || {};
    if (typeof panel.style.removeProperty === 'function') {
      panel.style.removeProperty('--mk-custom-accent');
    }
    const accent = appearance.accentColor || '';
    if (ACCENT_COLOR_RE.test(accent) && typeof panel.style.setProperty === 'function') {
      panel.style.setProperty('--mk-custom-accent', accent);
    }
    panel.style.backgroundImage = '';
    const bg = sanitizeMediaPath(appearance.backgroundImage || '');
    if (bg) panel.style.backgroundImage = `url("${bg}")`;
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
        // Public catalog fields default empty: the item's system description is
        // intentionally not auto-exposed. The GM fills these in the inventory row.
        publicDescription: '',
        category: '',
        rarity: '',
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

  /**
   * Capture the RAW current values of every shop-details/appearance form input.
   * This is the unsaved draft: it carries the exact user input (including an
   * invalid media path or accent color) so a rejected preview/save can restore
   * it through `editingShop` for the GM to correct. No validation is performed.
   */
  _captureShopForm() {
    return {
      name: this._readField('name'),
      owner: this._readField('owner'),
      theme: this._readField('theme'),
      description: this._readField('description'),
      open: this._readField('open'),
      appearance: {
        ownerPortrait: this._readField('ownerPortrait'),
        backgroundImage: this._readField('backgroundImage'),
        accentColor: this._readField('accentColor'),
        typography: this._readField('typography'),
        density: this._readField('density'),
        animation: this._readField('animation'),
        music: this._readField('music'),
        soundEffect: this._readField('soundEffect'),
        welcomeMessage: this._readField('welcomeMessage'),
      },
    };
  }

  /**
   * Normalize/validate a captured raw form. Appearance is validated strictly
   * (media paths + accent color) and can throw; the theme always normalizes to a
   * known id. The caller shows the validation error in the notice and skips the
   * store write.
   */
  _validateShopForm(raw) {
    return {
      name: raw.name,
      owner: raw.owner,
      theme: normalizeTheme(raw.theme),
      description: raw.description,
      open: raw.open,
      appearance: normalizeAppearance(raw.appearance),
    };
  }

  _readShopForm() {
    // Read the current form and normalize/validate it, throwing on an invalid
    // appearance value. Reads from the live DOM (used by callers that do not
    // capture a draft, e.g. the tests).
    return this._validateShopForm(this._captureShopForm());
  }

  // ---- M3 social settings -----------------------------------------------------

  /**
   * Read the RAW values of the social settings from the `.social-panel` ONLY.
   * No validation is performed; the caller feeds the result to
   * `normalizeShopSocial` and surfaces any error. Scope is deliberately limited to
   * the social panel so an inventory row or shop-details input with the same name
   * can never contaminate the read.
   */
  _readSocialPanel() {
    const panel = this.element?.querySelector?.('.social-panel');
    if (!panel || typeof panel.querySelector !== 'function') return {};
    const val = (name) => panel.querySelector(`[name="${name}"]`)?.value;
    const num = (name) => {
      const v = val(name);
      if (v === '' || v == null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    return {
      primaryPersonality: val('primaryPersonality'),
      secondaryPersonality: val('secondaryPersonality'),
      secondaryWeight: num('secondaryWeight'),
      individualWeight: num('individualWeight'),
      partyWeight: num('partyWeight'),
      partyId: val('partyId'),
      shopMarkupBps: num('shopMarkupBps'),
    };
  }

  /**
   * Save the social settings read from the `.social-panel`. The values are
   * normalized/validated (weights must sum to 100, the shop markup may be a signed
   * basis-point integer), then written as a metadata patch under the shared
   * per-shop lock. The existing shop's `autoPurchase` (not editable in the panel)
   * is merged into the normalized social before validation, so a social save never
   * resets it to defaults. The primary (first) NPC's personality is synchronized to
   * the social primary personality, and any in-progress unsaved appearance draft is
   * preserved (never cleared by a social save). On a validation error the notice is
   * surfaced and the unsaved panel edit is left intact.
   */
  async _onSaveSocial(event, target, data) {
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    const raw = this._readSocialPanel();
    let message = '';
    let failed = false;
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when saving social settings.';
        return;
      }
      // The social panel exposes only personality/weights/partyId/markup.
      // `autoPurchase` is not editable in the panel, so merge the EXISTING shop's
      // autoPurchase into the normalized social before validating, otherwise a
      // social save silently resets it to defaults. The merged object is validated
      // fresh via `normalizeShopSocial`; on a validation error the notice is shown
      // and the unsaved panel edit is left intact (no data refresh).
      let social;
      try {
        social = normalizeShopSocial({
          ...raw,
          autoPurchase: shop.social?.autoPurchase,
        });
      } catch (err) {
        failed = true;
        this._data.notice = err?.message
          ? String(err.message).replace(/^\[market\]\s*/, '')
          : 'Invalid social settings.';
        this.render({ force: true });
        return;
      }
      const npcs = (shop.npcs || []).map((n, i) =>
        i === 0 ? { ...n, personality: social.primaryPersonality } : n
      );
      await this._store.updateShop(shopId, { social, npcs });
    });
    // The `return` above only exits the lock callback, so a validation failure must
    // be flagged out of the lock: on failure we never refresh (which would reset the
    // GM's unsaved panel edit) and we keep the already-shown validation notice.
    if (failed) return;
    // `_refreshData` is reached only after a successful write (or a shop-not-found
    // message), so an error path never resets the GM's unsaved panel edit.
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  // ---- M3 merchant (NPC) editor -----------------------------------------------

  /**
   * Read every merchant row (`[data-npc-id]`) in the merchant roster. Each row
   * carries the editable NPC inputs; this returns the raw values so the caller can
   * validate and normalize them.
   */
  _readNpcRows() {
    const root = this.element;
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    return Array.from(root.querySelectorAll('.npc-list [data-npc-id]')).map((row) => ({
      id: row.dataset.npcId,
      npcName: row.querySelector('[name="npcName"]')?.value ?? '',
      npcRole: row.querySelector('[name="npcRole"]')?.value ?? '',
      npcActorUuid: row.querySelector('[name="npcActorUuid"]')?.value ?? '',
      npcPortrait: row.querySelector('[name="npcPortrait"]')?.value ?? '',
      npcGreeting: row.querySelector('[name="npcGreeting"]')?.value ?? '',
      npcPersonality: row.querySelector('[name="npcPersonality"]')?.value ?? '',
      npcVisible: !!row.querySelector('[name="npcVisible"]')?.checked,
    }));
  }

  _normalizeNpcRow(row) {
    return normalizeNpc({
      id: row.id,
      name: row.npcName,
      role: row.npcRole,
      actorUuid: row.npcActorUuid,
      portrait: row.npcPortrait,
      greeting: row.npcGreeting,
      personality: row.npcPersonality,
      visible: row.npcVisible,
    });
  }

  /**
   * Add a new merchant row. The row is persisted immediately under the shared
   * per-shop lock so it carries a generated id and survives a re-render; the name
   * defaults to "New merchant" so the canonical NPC normalization (which requires a
   * non-empty name) never rejects a just-added blank row. At most MAX_SHOP_NPCS
   * merchants are allowed.
   */
  async _onAddNpc(event, target, data) {
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when adding a merchant.';
        return;
      }
      if (shop.npcs.length >= MAX_SHOP_NPCS) {
        message = 'A shop can have at most three merchants.';
        return;
      }
      const social = shop.social || {};
      const npc = normalizeNpc({
        name: 'New merchant',
        role: '',
        actorUuid: '',
        portrait: '',
        greeting: '',
        personality: social.primaryPersonality || 'honest',
        visible: true,
      });
      const npcs = [...shop.npcs, npc];
      await this._store.updateShop(shopId, { npcs, owner: npcs[0].name });
    });
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  /**
   * Save the merchant roster read from the DOM. Each row is validated via
   * `normalizeNpc` (an invalid portrait path or a blank name surfaces an error
   * notice instead of writing), the list is capped at MAX_SHOP_NPCS, and the shop
   * is updated under the shared per-shop lock with the synced owner string. The
   * social primary personality is synchronized from the first merchant.
   */
  async _onSaveNpcs(event, target, data) {
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    let npcs;
    try {
      npcs = this._readNpcRows().map((row) => this._normalizeNpcRow(row));
    } catch (err) {
      this._data.notice = err?.message
        ? String(err.message).replace(/^\[market\]\s*/, '')
        : 'Invalid merchant data.';
      this.render({ force: true });
      return;
    }
    npcs = npcs.slice(0, MAX_SHOP_NPCS);
    const owner = npcs.length > 0 ? npcs[0].name : '';
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when saving merchants.';
        return;
      }
      const social = shop.social || {};
      const primaryPersonality = npcs.length > 0 ? npcs[0].personality : social.primaryPersonality;
      await this._store.updateShop(shopId, {
        npcs,
        owner,
        social: { ...social, primaryPersonality },
      });
    });
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  /**
   * Remove a merchant (including the primary). The remaining merchants keep their
   * order, and the `owner` string is reassigned to the new first merchant's name
   * (or '' when the roster becomes empty). When the primary merchant was removed
   * and merchants remain, the promoted first merchant's personality is
   * synchronized into `social.primaryPersonality` within the same lock; when no
   * merchants remain the shop's `social.primaryPersonality` is left unchanged.
   * The shop itself is never deleted.
   */
  async _onRemoveNpc(event, target, data) {
    const npcId = target?.dataset?.npcId || data?.dataset?.npcId;
    if (!npcId) return;
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when removing a merchant.';
        return;
      }
      const npcs = shop.npcs.filter((n) => n.id !== npcId);
      const owner = npcs.length > 0 ? npcs[0].name : '';
      const patch = { npcs, owner };
      // If the removed merchant was the primary, promote the new first NPC and
      // keep the social primary personality in sync with it. When no merchants
      // remain, leave the shop's social primary personality unchanged.
      if (npcs.length > 0) {
        patch.social = { ...(shop.social || {}), primaryPersonality: npcs[0].personality };
      }
      await this._store.updateShop(shopId, patch);
    });
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  // ---- M3 reputation editor ----------------------------------------------------

  /**
   * Load the GM-only reputation view for `actorId`. Obtains the actor's UUID,
   * reads the effective reputation via the API (or injected `deps.getReputation`),
   * and reads the committed/manual event history via the store. Defaults to a
   * Neutral record when no record exists, and never throws - a read failure simply
   * clears the selected record rather than blocking the editor.
   */
  async _loadReputation(actorId) {
    const shopId = this._data.selectedShopId;
    if (!actorId || !shopId) {
      this._data.selectedReputation = null;
      this._data.reputationHistory = [];
      return;
    }
    const actor = await this._getActor(actorId);
    if (!actor) {
      this._data.selectedReputation = null;
      this._data.reputationHistory = [];
      return;
    }
    const uuid = actor.uuid;
    let effective = null;
    try {
      effective = await this._getReputation(shopId, actor.id);
    } catch (err) {
      effective = null;
    }
    let events = [];
    if (typeof this._store?.listReputationEvents === 'function') {
      try {
        events = await this._store.listReputationEvents({
          shopId,
          scope: 'actor',
          subjectId: uuid,
        });
      } catch (err) {
        events = [];
      }
    }
    // Default neutral on a missing record.
    const rep = effective || { score: 0, band: { title: 'Neutral' }, individual: 0, party: 0 };
    this._data.selectedReputation = {
      title: rep.band?.title || 'Neutral',
      score: typeof rep.score === 'number' ? rep.score : 0,
      individual: typeof rep.individual === 'number' ? rep.individual : 0,
      party: typeof rep.party === 'number' ? rep.party : 0,
    };
    // History: only committed (manual/GM) records, most recent first, capped at 10.
    this._data.reputationHistory = events
      .filter((e) => e.status === 'committed')
      .slice(0, 10)
      .map((e) => ({
        reason: String(e.reason ?? ''),
        delta: e.delta,
        createdAt: this._formatDate(e.createdAt),
      }));
  }

  async _onSelectReputationActor(event, target, data) {
    const id = target?.value ?? target?.dataset?.reputationActorId;
    this._data.selectedReputationActorId = id || null;
    await this._loadReputation(id || null);
    this.render({ force: true });
  }

  /**
   * Bind the `change` event on the reputation actor `<select>` so a character
   * choice loads the GM-only reputation view. This replaces the previous
   * `data-action="select-reputation-actor"` click action, which a `<select>` never
   * fires as expected: ApplicationV2 dispatches data-action handlers on click, but
   * a native `<select>` opening/choosing does not produce a click on the element
   * itself, so the selection must drive through its native change event. A stable
   * marker prevents a duplicate listener from stacking when the same DOM node
   * survives a re-render.
   */
  _bindReputationActor() {
    const root = this.element;
    if (!root || typeof root.querySelector !== 'function') return;
    const select = root.querySelector('[name="reputationActorId"]');
    if (!select || typeof select.addEventListener !== 'function') return;
    if (select.__marketReputationBound) return;
    select.__marketReputationBound = true;
    select.addEventListener('change', () => this._onSelectReputationActor(null, select, {}));
  }

  _readReputationAdjust() {
    const root = this.element;
    const deltaField = root?.querySelector?.('[name="reputationDelta"]');
    const reasonField = root?.querySelector?.('[name="reputationReason"]');
    let delta = undefined;
    if (deltaField) {
      const v = deltaField.value;
      delta = v === '' || v == null ? undefined : Number(v);
    }
    return { delta, reason: String(reasonField?.value ?? '').trim() };
  }

  /**
   * Apply a manual GM reputation adjustment for the selected actor. Validates a
   * selected actor, a non-zero signed safe-integer delta and a non-empty reason of
   * at most 200 chars, then invokes the GM-only `reputation.adjust` mutation with a
   * fresh idempotency `requestId` and reloads the reputation view. A
   * pending/recovery outcome surfaces in the notice; a committed or replayed one
   * clears it.
   */
  async _onAdjustReputation(event, target, data) {
    const shopId = this._data.selectedShopId;
    const actorId = this._data.selectedReputationActorId;
    if (!shopId || !actorId) {
      this._data.notice = 'Select a character to adjust.';
      this.render({ force: true });
      return;
    }
    const { delta, reason } = this._readReputationAdjust();
    if (!Number.isSafeInteger(delta) || delta === 0) {
      this._data.notice = 'Adjustment must be a non-zero whole number.';
      this.render({ force: true });
      return;
    }
    if (!reason) {
      this._data.notice = 'A reason is required for a reputation adjustment.';
      this.render({ force: true });
      return;
    }
    if (reason.length > 200) {
      this._data.notice = 'The reason must be 200 characters or fewer.';
      this.render({ force: true });
      return;
    }
    const actor = await this._getActor(actorId);
    if (!actor) {
      this._data.notice = 'Character not found for the reputation adjustment.';
      this.render({ force: true });
      return;
    }
    let result;
    try {
      result = await this._adjustReputation({
        shopId,
        scope: 'actor',
        subjectId: actor.uuid,
        delta,
        reason,
        requestId: makeId(),
      });
    } catch (err) {
      this._data.notice = `Reputation adjustment failed: ${(err && err.message) || err}`;
      this.render({ force: true });
      return;
    }
    const status = result?.status;
    if (status === 'committed' || status === 'replay') {
      this._data.notice = '';
      await this._loadReputation(actorId);
    } else if (status === 'needsRecovery' || status === 'pending') {
      this._data.notice = `Reputation adjustment needs recovery (${result?.error || 'pending'}).`;
      await this._loadReputation(actorId);
    } else {
      this._data.notice = `Reputation adjustment failed (${result?.error || 'unknown'}).`;
    }
    this.render({ force: true });
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

  // ---- unsaved-form capture (live draft) ------------------------------------

  /**
   * Bind `input`/`change` listeners on the shop-details/appearance form fields so
   * an edit captures the raw form into `_data.draftShop` immediately, without a
   * re-render. This is what keeps unsaved metadata alive across the re-renders an
   * inventory action (open picker / add item / edit inventory row) triggers: the
   * draft is preserved by `_refreshData`, and `editingShop` overlays it onto the
   * persisted shop so an in-progress edit is never reset. Inventory row fields
   * are intentionally not bound here - `_captureShopForm` only reads the shop
   * details/appearance inputs anyway. A stable marker prevents a duplicate
   * listener from stacking when the same DOM node survives a re-render.
   */
  _bindShopForm() {
    const root = this.element;
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const handler = (event) => this._onShopFormChange(event);
    for (const name of SHOP_FORM_FIELDS) {
      root.querySelectorAll(`[name="${name}"]`).forEach((el) => {
        if (el.__marketFormBound) return;
        el.__marketFormBound = true;
        if (typeof el.addEventListener === 'function') {
          el.addEventListener('input', handler);
          el.addEventListener('change', handler);
        }
      });
    }
  }

  /**
   * A live edit to any shop-details/appearance field. Captures the RAW current
   * form into the draft (the exact user input, including an invalid value) and
   * invalidates the stale preview. Deliberately does NOT re-render: the draft is
   * only read back by the next re-render (`_prepareContext` -> `editingShop`),
   * and the preview is hidden by that re-render since `previewShop` is now null.
   */
  _onShopFormChange(event) {
    this._data.draftShop = this._captureShopForm();
    this._data.previewShop = null;
  }
}

export default MarketManager;
