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
  MAX_AUTOMATION_EVENTS,
  MAX_COMMERCE_SERVICES,
  MAX_COMMERCE_SPECIALS,
  MAX_SHOP_NPCS,
  makeId,
  normalizeAutomation,
  normalizeCommerce,
  normalizeInventoryEntry,
  normalizeNpc,
  normalizeShopSocial,
} from '../services/model.js';
import { getTheme, THEME_IDS, normalizeTheme, normalizeAppearance, sanitizeMediaPath } from '../themes/registry.js';
import { PERSONALITY_IDS, getPersonality } from '../social/personalities.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const CURRENCY_LABELS = { dnd5e: 'cp' };

// M4 weekday labels, indexed by the schema's day index (0 = Monday .. 6 =
// Sunday). Used only to render the GM's weekly-hours checkerboard.
const WEEKDAY_LABELS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

// The `Run now` / `Generate inventory` buttons are only actionable for the active
// GM (the automation runner and table generator gate on `isActiveGM`). This is
// the notice shown when a non-active GM presses them.
const ACTIVE_GM_MESSAGE = 'Only the active Game Master can run automation.';

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
      // M4: shop automation editor actions.
      'save-hours': this._action('_onSaveHours'),
      'save-travel': this._action('_onSaveTravel'),
      'add-event': this._action('_onAddEvent'),
      'remove-event': this._action('_onRemoveEvent'),
      'save-events': this._action('_onSaveEvents'),
      'run-automation': this._action('_onRunAutomation'),
      'generate-inventory': this._action('_onGenerateInventory'),
      // M5: GM-only commerce settings (funds/rates), service & special editor, and
      // advanced-order manual adjudication.
      'save-commerce': this._action('_onSaveCommerce'),
      'add-service': this._action('_onAddService'),
      'save-services': this._action('_onSaveServices'),
      'remove-service': this._action('_onRemoveService'),
      'add-special': this._action('_onAddSpecial'),
      'save-specials': this._action('_onSaveSpecials'),
      'remove-special': this._action('_onRemoveSpecial'),
      'fulfill-service': this._action('_onFulfillService'),
      'fulfill-preorder': this._action('_onFulfillPreorder'),
      'cancel-preorder': this._action('_onCancelPreorder'),
      'resolve-theft-success': this._action('_onResolveTheftSuccess'),
      'resolve-theft-failure': this._action('_onResolveTheftFailure'),
      'next-orders': this._action('_onNextOrders'),
      'prev-orders': this._action('_onPrevOrders'),
      // M6: GM-only per-Item valuation approval for sell/barter.
      'approve-valuation': this._action('_onApproveValuation'),
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
      // M4 GM-only automation editor context. `drawTables` is populated on each
      // data refresh from `deps.listTables` (or the live game tables/compendium
      // fallback) so the RollTable generator pull-down never trusts an arbitrary
      // raw path; the remaining automation context (weekdays, travel options,
      // event rows, diagnostics) is derived fresh in `_prepareContext`.
      drawTables: [],
      // M5 GM-only advanced order list for the selected shop. Populated
      // asynchronously on each refresh (see `_listAdvancedOrders`); a non-active GM
      // or an unselected shop yields an empty list. `orderPage` is the current
      // 100-record page index and the paging flags drive the next/previous controls.
      advancedOrders: [],
      orderPage: 0,
      hasPreviousOrders: false,
      hasNextOrders: false,
      // M6 GM-authored per-Item valuation context for the selected shop/actor.
      // `valuationActorId` mirrors the reputation Character selector (the valuation
      // panel reuses that very selector), `valuationItems` lists the selected
      // actor's embedded Items (each `{id,name}`) so the GM can pick one to value,
      // and `approvedValuations` projects the private `shop.commerce.valuations`
      // list (never the raw fingerprint) for the selected shop. GM-only.
      valuationItems: [],
      approvedValuations: [],
      valuationActorId: null,
      valuationActorName: '',
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

  // ---- M4 automation lazy accessors -----------------------------------------

  /**
   * Whether the current user is the active GM. The automation runner and the
   * RollTable generator are wired to gate on the ACTIVE GM (not any GM), so the
   * manager must reflect the same guard. Tests inject `deps.isActiveGM`; the
   * runtime falls back to the same predicate main.js uses (this user is the
   * active GM and a GM).
   */
  _isActiveGM() {
    if (this._deps.isActiveGM) return !!this._deps.isActiveGM();
    if (!game?.user?.isGM) return false;
    const active = game?.users?.activeGM;
    return !!active && game.user.id === active.id;
  }

  /**
   * Resolve the current game-world time as a whole second, or 0 when it cannot be
   * read (an invalid server clock collapses to the documented 0 so a new event
   * never gets a bogus timestamp). Used only to seed the default event window.
   */
  _worldTimeNow() {
    if (typeof this._deps.now === 'function') {
      const raw = this._deps.now();
      if (Number.isFinite(raw)) {
        const floored = Math.floor(raw);
        return Number.isSafeInteger(floored) ? floored : 0;
      }
      return 0;
    }
    const t = game?.time?.worldTime;
    if (Number.isFinite(t)) {
      const floored = Math.floor(t);
      return Number.isSafeInteger(floored) ? floored : 0;
    }
    return 0;
  }

  /**
   * List the GM-visible RollTables for the inventory generator as plain
   * `{ uuid, name }` pairs, never a raw document. Tests inject `deps.listTables`;
   * the runtime fallback reads only the world RollTables (`game.tables`) and
   * RollTable compendium packs (`game.packs`), each exposed by its stable UUID.
   */
  async _listTables() {
    if (typeof this._deps.listTables === 'function') return this._deps.listTables();
    const out = [];
    const seen = new Set();
    for (const table of game?.tables ?? []) {
      if (table.uuid && !seen.has(table.uuid)) {
        seen.add(table.uuid);
        out.push({ uuid: table.uuid, name: table.name });
      }
    }
    for (const pack of game?.packs ?? []) {
      if (pack.documentName !== 'RollTable') continue;
      const docs = await pack.getDocuments();
      for (const table of docs) {
        const uuid = table.uuid || `${pack.collection}.${table.id}`;
        if (seen.has(uuid)) continue;
        seen.add(uuid);
        out.push({ uuid, name: table.name });
      }
    }
    return out;
  }

  /**
   * Run the automation runner for the selected shop. Prefers the injected
   * `deps.runAutomation` (tests) and otherwise defers to the GM-only API wrapper
   * `api.automation.runShop`, which in turn re-checks the active GM before any
   * store read/write.
   */
  _runAutomation(shopId) {
    if (typeof this._deps.runAutomation === 'function') return this._deps.runAutomation(shopId);
    return this._api()?.automation?.runShop?.(shopId);
  }

  /**
   * Generate inventory from a RollTable. Prefers the injected
   * `deps.generateInventory` (tests) and otherwise defers to the GM-only
   * `api.generateInventory`, which re-checks the active GM and never trusts
   * caller-supplied Item data (only the bounded result counters are returned).
   */
  _generateInventory(params) {
    if (typeof this._deps.generateInventory === 'function') {
      return this._deps.generateInventory(params);
    }
    return this._api()?.generateInventory?.(params);
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

  // ---- M5 advanced-commerce lazy accessors ------------------------------------

  /**
   * Invoke a GM-only advanced-order adjudication method. Prefers the injected
   * `deps[method]` (tests) and otherwise defers to the `api.advanced[method]`
   * wrapper, which re-checks the active GM before any store read/write. The method
   * names map 1:1 between the injected deps and the api surface
   * (`fulfillService`/`fulfillPreorder`/`cancelPreorder`/`resolveTheft`).
   */
  _advancedCall(method, params) {
    if (typeof this._deps[method] === 'function') return this._deps[method](params);
    return this._api()?.advanced?.[method]?.(params);
  }

  /**
   * List the GM-visible advanced orders for a shop. Prefers the injected
   * `deps.listAdvancedOrders` (tests, returns an array) and otherwise defers to
   * `api.advanced.listOrders`, which is active-GM gated and projects each record
   * through the scalar public sanitizer (`publicAdvancedOrder`) so no private
   * snapshot leaks to the manager UI. A non-active GM or a read failure yields an
   * empty list - the manager still renders context for viewing. `opts` carries the
   * paging/filter parameters (`{ shopId, status, limit, offset }`) so the caller
   * can page through the advanced-order list rather than always fetching the whole
   * 100-record cap.
   */
  async _listAdvancedOrders({ shopId, status, limit, offset } = {}) {
    if (typeof this._deps.listAdvancedOrders === 'function') {
      const orders = await this._deps.listAdvancedOrders({ shopId, status, limit, offset });
      return Array.isArray(orders) ? orders : [];
    }
    const api = this._api();
    if (api?.advanced?.listOrders) {
      const res = await api.advanced.listOrders({ shopId, status, limit, offset });
      if (res?.status === 'ok' && Array.isArray(res.orders)) return res.orders;
      return [];
    }
    if (typeof this._store?.listAdvancedOrders === 'function') {
      const orders = await this._store.listAdvancedOrders({ shopId, status, limit, offset });
      return Array.isArray(orders) ? orders : [];
    }
    return [];
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
    // M4: derive the automation editor context fresh from the selected shop so a
    // re-render never carries a stale weekday/travel/event/diagnostic view. The
    // weekdays checkerboard, the travel destination options, the event rows and
    // the sanitized diagnostics are all derived here; `drawTables` is populated
    // asynchronously on each refresh and only defaulted to [] for safety.
    this._data.weekdays = this._buildWeekdays();
    this._data.travelLocationOptions = this._buildTravelLocationOptions();
    this._data.eventRows = this._buildEventRows();
    this._data.automationDiagnostics = this._sanitizeDiagnostics();
    // M5: derive the commerce editor context (services/specials) fresh from the
    // selected shop so a re-render never carries a stale row set. `advancedOrders`
    // is populated asynchronously on each refresh; here it is only defaulted to an
    // array so an unset value can never crash the render.
    this._data.serviceRows = this._buildServiceRows();
    this._data.specialRows = this._buildSpecialRows();
    if (!Array.isArray(this._data.advancedOrders)) this._data.advancedOrders = [];
    this._data.orderPage = this._data.orderPage || 0;
    this._data.hasPreviousOrders = !!this._data.hasPreviousOrders;
    this._data.hasNextOrders = !!this._data.hasNextOrders;
    // M6: derive the GM-only approved-valuations list fresh from the selected shop
    // so a re-render never carries a stale set, and default the valuation item list
    // to an array so an unset value can never crash the render.
    this._data.approvedValuations = this._buildApprovedValuations();
    if (!Array.isArray(this._data.valuationItems)) this._data.valuationItems = [];
    this._data.isActiveGM = this._isActiveGM();
    if (!Array.isArray(this._data.drawTables)) this._data.drawTables = [];
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

  // ---- M4 automation editor context derivation ------------------------------

  /**
   * Build the weekly-hours checkerboard from the selected shop's declared open
   * days. Each entry carries the schema day index (0..6), a display label and the
   * `selected` flag; the template only ever reads these bounded fields.
   */
  _buildWeekdays() {
    const days = Array.isArray(this._data.selectedShop?.automation?.hours?.days)
      ? this._data.selectedShop.automation.hours.days
      : [];
    return WEEKDAY_LABELS.map((label, id) => ({
      id,
      label,
      selected: days.includes(id),
    }));
  }

  /**
   * Build the travel destination options from the current locations list. Each
   * option carries the location id/name plus a `selected` flag against the
   * shop's configured travel location ids. Only the plain location fields are
   * projected - no internal record leaks into the template.
   */
  _buildTravelLocationOptions() {
    const travel = this._data.selectedShop?.automation?.travel || {};
    const ids = Array.isArray(travel.locationIds) ? travel.locationIds : [];
    return (this._data.locations || []).map((loc) => ({
      id: loc.id,
      name: loc.name,
      selected: ids.includes(loc.id),
    }));
  }

  /**
   * Build the event editor rows from the selected shop's automation events. Each
   * row is a plain copy of the persisted event with its numeric world-time
   * window, so the number inputs bind to the stored seconds rather than any
   * locale date string.
   */
  _buildEventRows() {
    const events = Array.isArray(this._data.selectedShop?.automation?.events)
      ? this._data.selectedShop.automation.events
      : [];
    return events.map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      startAt: e.startAt,
      endAt: e.endAt,
      visible: e.visible !== false,
    }));
  }

  /**
   * Sanitize the persisted automation diagnostics for the template. Only the
   * documented fields are projected and each is defensively coerced to its type;
   * a malformed persisted value can never crash the render or leak a raw record.
   */
  _sanitizeDiagnostics() {
    const d = this._data.selectedShop?.automation?.diagnostics || {};
    return {
      lastRunAt: this._formatDateTime(d.lastRunAt),
      lastStatus: typeof d.lastStatus === 'string' && d.lastStatus !== '' ? d.lastStatus : 'never',
      lastRestocked: Number.isSafeInteger(d.lastRestocked) ? d.lastRestocked : 0,
      lastLocationId: typeof d.lastLocationId === 'string' ? d.lastLocationId : '',
      lastError: typeof d.lastError === 'string' && d.lastError !== '' ? d.lastError : '',
    };
  }

  /**
   * Format a world-time whole-second value as `YYYY-MM-DD HH:mm`, or '' when the
   * value is null/absent (no run yet) or not a valid timestamp.
   */
  _formatDateTime(ts) {
    if (ts == null) return '';
    const n = Number(ts);
    if (!Number.isFinite(n)) return '';
    const d = new Date(n * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }

  // ---- M5 commerce editor context derivation ----------------------------------

  /**
   * Build the service editor rows from the selected shop's commerce.services. Each
   * row is a plain copy of the persisted service exposing only the fields the
   * template reads - never a raw record with internal fields.
   */
  _buildServiceRows() {
    const services = Array.isArray(this._data.selectedShop?.commerce?.services)
      ? this._data.selectedShop.commerce.services
      : [];
    return services.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      price: s.price,
      visible: s.visible,
      enabled: s.enabled,
    }));
  }

  /**
   * Build the special editor rows from the selected shop's commerce.specials. Each
   * row projects the bounded fields plus a comma-joined `actorUuidsText` string
   * (the template binds the actor-UUID input to `special.actorUuidsText`), so the
   * GM sees a human-editable list rather than a raw array.
   */
  _buildSpecialRows() {
    const specials = Array.isArray(this._data.selectedShop?.commerce?.specials)
      ? this._data.selectedShop.commerce.specials
      : [];
    return specials.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      price: s.price,
      visible: s.visible,
      entryId: s.entryId,
      actorUuidsText: Array.isArray(s.actorUuids) ? s.actorUuids.join(', ') : '',
    }));
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
    // Project `accessActorUuidsText` onto the selected shop's inventory entries so
    // the GM editable access-UUID input binds to a comma-joined string, never a raw
    // array. Only the selected shop's table needs this projection; the rail list
    // only reads name/count.
    const selectedShopView = selectedShop
      ? { ...selectedShop, inventory: this._projectInventoryAccess(selectedShop.inventory) }
      : null;
    this._data = {
      ...this._data,
      locations,
      shops: shopsView,
      selectedLocationId,
      selectedShopId,
      selectedShop: selectedShopView,
      currencyLabel: this._currencyLabel(),
      stockModes: ['finite', 'unlimited', 'non-restocking'],
      previewShop: null,
      notice: '',
    };
    // M4: refresh the GM-visible RollTable list for the inventory generator. This
    // is a best-effort read that never blocks the manager; a failure simply leaves
    // the pull-down empty rather than surfacing a hard error.
    try {
      this._data.drawTables = await this._listTables();
    } catch (err) {
      this._data.drawTables = [];
    }
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
    // M6: refresh the GM-only item-valuation context for the same selected actor.
    // The valuation panel reuses the reputation Character selector, so it must
    // stay in sync with the actor selection whenever the data is refreshed.
    await this._loadValuationContext(selectedReputationActorId);
    // M5: refresh the GM-only advanced order list for the selected shop. Start at
    // the first page and recompute the paging flags. Best-effort and active-GM
    // gated (a non-active GM yields an empty list); a read failure leaves the list
    // empty rather than blocking the manager.
    this._data.orderPage = 0;
    await this._refreshOrdersOnly();
  }

  /**
   * Project a comma-joined `accessActorUuidsText` onto each inventory entry (from
   * the entry's access.actorUuids array) so the GM-facing access-UUID input binds
   * to a human-editable string. Other fields are carried through untouched.
   */
  _projectInventoryAccess(inventory) {
    if (!Array.isArray(inventory)) return [];
    return inventory.map((entry) => {
      const actorUuids = Array.isArray(entry.access?.actorUuids)
        ? entry.access.actorUuids
        : [];
      return {
        ...entry,
        accessActorUuidsText: actorUuids.join(', '),
      };
    });
  }

  /**
   * Refresh ONLY the advanced order list for the selected shop, without reloading
   * the shop. A GM order action (fulfill/cancel/resolve) must never reset the GM's
   * unsaved appearance draft or in-progress inventory row edits, so this narrow
   * refresh leaves `selectedShop`/`draftShop`/`previewShop` untouched.
   *
   * It pages through `status: 'booked'` records (the only state a GM can act on)
   * at the 100-record page size, tracking the current `orderPage` so a GM can step
   * back and forward through a large backlog, and exposes `hasPreviousOrders`/
   * `hasNextOrders` to gate the template's next/previous controls. If resolving an
   * order empties the current page the manager steps back to the prior non-empty
   * page rather than stranding the GM on an empty page with no controls.
   */
  async _refreshOrdersOnly() {
    const shopId = this._data.selectedShopId;
    const PAGE_SIZE = 100;
    const page = Math.max(0, this._data.orderPage || 0);
    let orders = [];
    let hasNext = false;
    if (shopId) {
      try {
        orders = await this._listAdvancedOrders({
          shopId,
          status: 'booked',
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        });
        hasNext = orders.length === PAGE_SIZE;
      } catch (err) {
        orders = [];
      }
    }
    this._data.advancedOrders = Array.isArray(orders) ? orders : [];
    this._data.hasPreviousOrders = page > 0;
    this._data.hasNextOrders = hasNext;
    if (this._data.advancedOrders.length === 0 && page > 0) {
      this._data.orderPage = page - 1;
      return this._refreshOrdersOnly();
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
    let failed = false;
    let message = '';
    // Re-read the shop inside the shared per-shop lock and alter only the
    // target entry, so a concurrent purchase's stock decrement is never lost.
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when saving.';
        return;
      }
      const existing = shop.inventory.find((e) => e.id === entryId);
      if (!existing) {
        message = 'Item not found when saving.';
        return;
      }
      const nextEntry = {
        ...existing,
        price,
        quantity,
        stockMode,
        visible: visible !== false,
        publicDescription,
        category,
        rarity,
      };
      // M4 per-entry stock visibility + restock are captured ONLY when the row
      // actually carries the controls. Older tests/fixtures omit them, so the
      // persisted value is preserved rather than reset to a default.
      const stockVisibility = this._readFieldIn(tr, 'stockVisibility');
      if (stockVisibility != null && stockVisibility !== '') {
        nextEntry.stockVisibility = stockVisibility;
      }
      let hasRestockControls = false;
      let identityChanged = false;
      const restock = {
        ...(existing.restock || {}),
        lastCycle: existing.restock?.lastCycle ?? -1,
      };
      if (this._hasField(tr, 'restockEnabled')) {
        hasRestockControls = true;
        const v = this._readChecked(tr, 'restockEnabled');
        if (v !== (restock.enabled || false)) identityChanged = true;
        restock.enabled = v;
      }
      const restockTarget = this._readNumber(tr, 'restockTarget');
      if (restockTarget != null) {
        hasRestockControls = true;
        if (restockTarget !== restock.target) identityChanged = true;
        restock.target = restockTarget;
      }
      const restockAnchorTime = this._readNumber(tr, 'restockAnchorTime');
      if (restockAnchorTime != null) {
        hasRestockControls = true;
        if (restockAnchorTime !== (restock.anchorTime ?? 0)) identityChanged = true;
        restock.anchorTime = restockAnchorTime;
      }
      const restockIntervalSeconds = this._readNumber(tr, 'restockIntervalSeconds');
      if (restockIntervalSeconds != null) {
        hasRestockControls = true;
        if (restockIntervalSeconds !== (restock.intervalSeconds ?? 86400)) identityChanged = true;
        restock.intervalSeconds = restockIntervalSeconds;
      }
      if (identityChanged) restock.lastCycle = -1;
      if (hasRestockControls) nextEntry.restock = restock;
      // M5 per-entry access gate (public/backroom + actor UUIDs + min reputation).
      // Captured ONLY when the row actually carries the controls; otherwise the
      // persisted access (already spread into `nextEntry` from `existing`) is
      // preserved, so an inventory row without backroom controls can never reset a
      // saved gate. The actor UUIDs are comma-split and trimmed, and the persisted
      // `minReputation` is kept when the row omits the field.
      let hasAccessControls = false;
      let entryAccess;
      if (this._hasField(tr, 'accessMode')) {
        hasAccessControls = true;
        const existingAccess = existing.access || {};
        const rawUuids = this._readFieldIn(tr, 'accessActorUuids') || '';
        const actorUuids = rawUuids
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
        const minReputation = this._readNumber(tr, 'accessMinReputation');
        entryAccess = {
          mode: this._readFieldIn(tr, 'accessMode') || 'public',
          actorUuids,
          minReputation: minReputation != null ? minReputation : existingAccess.minReputation,
        };
      }
      if (hasAccessControls) nextEntry.access = entryAccess;
      let normalized;
      try {
        normalized = normalizeInventoryEntry(nextEntry);
      } catch (err) {
        failed = true;
        this._data.notice = err?.message
          ? String(err.message).replace(/^\[market\]\s*/, '')
          : 'Invalid inventory entry.';
        this.render({ force: true });
        return;
      }
      const inventory = shop.inventory.map((e) => (e.id === entryId ? normalized : e));
      await this._store.updateShop(shopId, { inventory });
    });
    if (failed) return;
    await this._refreshData();
    this._data.notice = message;
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

  // ---- M4 shop automation editor handlers --------------------------------------

  /**
   * Resolve the automation editor card (hours/travel) from the live element,
   * falling back to the event target's closest card when the element is not yet
   * attached (e.g. in a unit test). This keeps every read scoped to exactly the
   * hours or travel card, so a same-named input elsewhere can never contaminate
   * the save.
   */
  _automationCard(target, className) {
    const fromElement = this.element?.querySelector?.(className);
    if (fromElement) return fromElement;
    return target?.closest?.(className) || null;
  }

  /**
   * Read every checked value of `name` within `scope`. Returns the raw values in
   * DOM order so a weekday/travel checkerboard can be captured as authored.
   */
  _readCheckedValues(scope, name) {
    if (!scope || typeof scope.querySelectorAll !== 'function') return [];
    const out = [];
    scope.querySelectorAll(`[name="${name}"]`).forEach((el) => {
      if (el.checked) out.push(el.value);
    });
    return out;
  }

  /**
   * Save the weekly-hours card. Reads ONLY the `.automation-hours` card (the
   * enabled checkbox, the checked weekday day indices, and the open/close
   * minutes), then re-reads the shop inside the shared per-shop lock and patches
   * `automation.hours` only - never travel/events/diagnostics. The hour values
   * are strict safe integers validated by `normalizeAutomation`; an invalid value
   * surfaces a notice and leaves the form (and the shop) untouched.
   */
  async _onSaveHours(event, target, data) {
    const card = this._automationCard(target, '.automation-hours');
    if (!card) return;
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    const enabled = this._readChecked(card, 'hoursEnabled');
    const days = this._readCheckedValues(card, 'hoursDay').map((v) => Number(v));
    const openMinute = this._readNumber(card, 'openMinute');
    const closeMinute = this._readNumber(card, 'closeMinute');
    let failed = false;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when saving hours.';
        return;
      }
      let nextAutomation;
      try {
        nextAutomation = normalizeAutomation({
          ...shop.automation,
          hours: { enabled, days, openMinute, closeMinute },
        });
      } catch (err) {
        failed = true;
        this._data.notice = err?.message
          ? String(err.message).replace(/^\[market\]\s*/, '')
          : 'Invalid opening hours.';
        this.render({ force: true });
        return;
      }
      await this._store.updateShop(shopId, { automation: nextAutomation });
    });
    if (failed) return;
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  /**
   * Save the travel card. Reads ONLY the `.automation-travel` card (enabled,
   * selected destination location ids, anchor time and interval), validates the
   * selected ids against a FRESH `store.listLocations()` before any write, then
   * re-reads and patches `automation.travel` only - the shop's own `locationId`
   * is left untouched so a travel shop keeps trading at its base location until
   * the runner moves it. When the schedule identity (enabled/ids/anchor/interval)
   * changes the cycle marker is reset to -1 (the schedule restarts), otherwise the
   * preserved `lastCycle` is kept so a running schedule is never rewound.
   */
  async _onSaveTravel(event, target, data) {
    const card = this._automationCard(target, '.automation-travel');
    if (!card) return;
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    const enabled = this._readChecked(card, 'travelEnabled');
    const selectedIds = this._readCheckedValues(card, 'travelLocationId');
    const anchorTime = this._readNumber(card, 'travelAnchorTime');
    const intervalSeconds = this._readNumber(card, 'travelIntervalSeconds');
    let failed = false;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when saving travel.';
        return;
      }
      // Validate the selected destinations against the CURRENT location list, not
      // a cached one, so a deleted/renamed location can never be written.
      let locations;
      try {
        locations = await this._store.listLocations();
      } catch (err) {
        failed = true;
        this._data.notice = err?.message
          ? String(err.message).replace(/^\[market\]\s*/, '')
          : 'Could not read locations for travel.';
        this.render({ force: true });
        return;
      }
      const validIds = new Set((locations || []).map((loc) => loc.id));
      const unknown = selectedIds.filter((id) => !validIds.has(id));
      if (unknown.length) {
        failed = true;
        this._data.notice = `Unknown travel destination: ${unknown.join(', ')}`;
        this.render({ force: true });
        return;
      }
      const existingTravel = shop.automation?.travel || {};
      const existingIds = Array.isArray(existingTravel.locationIds) ? existingTravel.locationIds : [];
      const identityChanged =
        enabled !== (existingTravel.enabled || false) ||
        JSON.stringify(selectedIds) !== JSON.stringify(existingIds) ||
        anchorTime !== (existingTravel.anchorTime ?? 0) ||
        intervalSeconds !== (existingTravel.intervalSeconds ?? 86400);
      const rawTravel = {
        enabled,
        locationIds: selectedIds,
        anchorTime,
        intervalSeconds,
        lastCycle: identityChanged ? -1 : (existingTravel.lastCycle ?? -1),
      };
      let nextAutomation;
      try {
        nextAutomation = normalizeAutomation({ ...shop.automation, travel: rawTravel });
      } catch (err) {
        failed = true;
        this._data.notice = err?.message
          ? String(err.message).replace(/^\[market\]\s*/, '')
          : 'Invalid travel schedule.';
        this.render({ force: true });
        return;
      }
      await this._store.updateShop(shopId, { automation: nextAutomation });
    });
    if (failed) return;
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  /**
   * Add a new market event. Under the shared per-shop lock the event is appended
   * to the shop's automation events (capped at MAX_AUTOMATION_EVENTS), seeded with
   * a fresh id, a "New event" placard and a 24h window starting at the current
   * valid world time (or 0 when the clock is unreadable). Visibility defaults to
   * false so a just-added event never appears on the storefront until the GM
   * saves it visible.
   */
  async _onAddEvent(event, target, data) {
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    let failed = false;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when adding an event.';
        return;
      }
      const events = Array.isArray(shop.automation?.events) ? shop.automation.events : [];
      if (events.length >= MAX_AUTOMATION_EVENTS) {
        message = 'A shop can have at most ten events.';
        return;
      }
      const startAt = this._worldTimeNow();
      const defaultEvent = {
        id: makeId(),
        title: 'New event',
        description: '',
        startAt,
        endAt: startAt + 86400,
        visible: false,
      };
      let nextAutomation;
      try {
        nextAutomation = normalizeAutomation({
          ...shop.automation,
          events: [...events, defaultEvent],
        });
      } catch (err) {
        failed = true;
        this._data.notice = err?.message
          ? String(err.message).replace(/^\[market\]\s*/, '')
          : 'Could not add the event.';
        this.render({ force: true });
        return;
      }
      await this._store.updateShop(shopId, { automation: nextAutomation });
    });
    if (failed) return;
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  /**
   * Remove a single market event by id, under the shared per-shop lock. Only the
   * matching event is dropped; other events, diagnostics, travel and hours are
   * carried through unchanged.
   */
  async _onRemoveEvent(event, target, data) {
    const eventId = target?.dataset?.eventId || data?.dataset?.eventId;
    if (!eventId) return;
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    let failed = false;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when removing an event.';
        return;
      }
      const events = Array.isArray(shop.automation?.events) ? shop.automation.events : [];
      let nextAutomation;
      try {
        nextAutomation = normalizeAutomation({
          ...shop.automation,
          events: events.filter((e) => e.id !== eventId),
        });
      } catch (err) {
        failed = true;
        this._data.notice = err?.message
          ? String(err.message).replace(/^\[market\]\s*/, '')
          : 'Could not remove the event.';
        this.render({ force: true });
        return;
      }
      await this._store.updateShop(shopId, { automation: nextAutomation });
    });
    if (failed) return;
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  /**
   * Save every event editor row. Each `[data-event-id]` fieldset is read for its
   * title, description, numeric world-time start/end and visibility, validated via
   * `normalizeAutomation`, then patched as `automation.events` only - diagnostics,
   * travel and hours are preserved. Edits are merged by id into the freshly
   * re-read persisted event list, so an event added concurrently (or otherwise
   * absent from the DOM) is never dropped. A DOM row whose id is not in the
   * persisted list fails closed (an error notice, no write) rather than creating
   * or overwriting a record; on a validation error the notice is shown and the
   * unsaved form is left intact (no data refresh, no write).
   */
  async _onSaveEvents(event, target, data) {
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    const root = this.element;
    const editors =
      root && typeof root.querySelectorAll === 'function'
        ? Array.from(root.querySelectorAll('.event-editor-list [data-event-id]'))
        : [];
    const rawEvents = editors.map((ed) => ({
      id: ed.dataset.eventId,
      title: ed.querySelector('[name="eventTitle"]')?.value ?? '',
      description: ed.querySelector('[name="eventDescription"]')?.value ?? '',
      startAt: this._readNumber(ed, 'eventStartAt'),
      endAt: this._readNumber(ed, 'eventEndAt'),
      visible: !!ed.querySelector('[name="eventVisible"]')?.checked,
    }));
    let failed = false;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when saving events.';
        return;
      }
      const persisted = Array.isArray(shop.automation?.events) ? shop.automation.events : [];
      const persistedIds = new Set(persisted.map((e) => e.id));
      // Fail closed on a DOM row whose id is not in the freshly re-read persisted
      // list: never create (or overwrite) from a forged id. Nothing is written.
      const unknown = rawEvents.find((e) => !persistedIds.has(e.id));
      if (unknown) {
        failed = true;
        this._data.notice =
          'One of the event rows no longer matches a saved event, so nothing was saved.';
        this.render({ force: true });
        return;
      }
      // Merge edits by id into the freshly re-read persisted list, so an event
      // added concurrently (or otherwise absent from the DOM) is never dropped.
      const editsById = new Map(rawEvents.map((e) => [e.id, e]));
      const merged = persisted.map((e) =>
        editsById.has(e.id) ? { ...e, ...editsById.get(e.id) } : { ...e }
      );
      let nextAutomation;
      try {
        nextAutomation = normalizeAutomation({ ...shop.automation, events: merged });
      } catch (err) {
        failed = true;
        this._data.notice = err?.message
          ? String(err.message).replace(/^\[market\]\s*/, '')
          : 'Invalid event data.';
        this.render({ force: true });
        return;
      }
      await this._store.updateShop(shopId, { automation: nextAutomation });
    });
    if (failed) return;
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  /**
   * Run the shop automation on demand. Guarded on the active GM (the runner is
   * wired to gate on it, so a non-active GM pressing the button gets a notice and
   * no store read), then delegates to the injected `deps.runAutomation` or the
   * `api.automation.runShop` wrapper. A summary/error is shown in the notice and
   * the data is refreshed so the diagnostics panel reflects the fresh run.
   */
  async _onRunAutomation(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    let result;
    try {
      result = await this._runAutomation(shopId);
    } catch (err) {
      this._data.notice = `Automation run failed: ${(err && err.message) || err}`;
      this.render({ force: true });
      return;
    }
    this._noticeForAutomation(result);
    await this._refreshData();
    this.render({ force: true });
  }

  /**
   * Generate inventory from a RollTable on demand. Guarded on the active GM (the
   * generator is wired to gate on it), reads `tableUuid`/`drawCount` from the
   * `.table-generation` form, validates the count is 1..20, then delegates to the
   * injected `deps.generateInventory` or the `api.generateInventory` wrapper. The
   * result summary (added/skipped/invalid/duplicate) is shown and never trusts
   * client Item data - only the bounded counters the service returns.
   */
  async _onGenerateInventory(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    const form = this.element?.querySelector?.('.table-generation');
    if (!form) return;
    const tableUuid = this._readFieldIn(form, 'rollTableUuid');
    const drawCount = this._readNumber(form, 'drawCount');
    if (drawCount == null || drawCount < 1 || drawCount > 20) {
      this._data.notice = 'Draw count must be between 1 and 20.';
      this.render({ force: true });
      return;
    }
    if (!tableUuid) {
      this._data.notice = 'Choose a roll table to generate from.';
      this.render({ force: true });
      return;
    }
    let result;
    try {
      result = await this._generateInventory({ shopId, tableUuid, count: drawCount });
    } catch (err) {
      this._data.notice = `Inventory generation failed: ${(err && err.message) || err}`;
      this.render({ force: true });
      return;
    }
    this._noticeForGeneration(result);
    await this._refreshData();
    this.render({ force: true });
  }

  _noticeForAutomation(result) {
    if (!result) {
      this._data.notice = 'Automation run returned no result.';
    } else if (result.status === 'ok') {
      this._data.notice = `Automation ran: ${result.restocked || 0} restocked.`;
    } else if (result.status === 'error') {
      this._data.notice = `Automation failed: ${result.error || 'unknown'}.`;
    } else if (result.status === 'idle') {
      this._data.notice = 'Automation is idle.';
    } else {
      this._data.notice = `Automation result: ${result.status || 'unknown'}.`;
    }
  }

  _noticeForGeneration(result) {
    if (!result) {
      this._data.notice = 'Inventory generation returned no result.';
    } else if (result.status === 'ok') {
      this._data.notice =
        `Generated: ${result.added || 0} added, ` +
        `${result.skipped || 0} skipped, ${result.invalid || 0} invalid, ` +
        `${result.duplicate || 0} duplicate.`;
    } else if (result.status === 'error') {
      this._data.notice = `Inventory generation failed: ${result.error || 'unknown'}.`;
    } else if (result.status === 'idle') {
      this._data.notice = 'Inventory generation is idle.';
    } else {
      this._data.notice = `Inventory generation result: ${result.status || 'unknown'}.`;
    }
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

  // ---- M5 commerce settings + service/special editor ---------------------------

  /**
   * Save the commerce settings read from the `.commerce-panel` top fields only
   * (funds, buy/buyback rates, preorders and theft toggles). The `unlimitedFunds`
   * checkbox maps `funds` to null; otherwise a strict safe integer is required
   * (empty falls back to the existing funds, then 0). The existing services and
   * specials (edited via their own add/save/remove actions) are merged from the
   * freshly re-read shop under the shared per-shop lock, then the whole
   * `commerce` object is validated by `normalizeCommerce` - an invalid rate
   * (e.g. buyback < buy) fails closed with a notice and no write.
   */
  async _onSaveCommerce(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    const panel = this.element?.querySelector?.('.commerce-panel');
    if (!panel || typeof panel.querySelector !== 'function') return;
    const merchantFunds = this._readNumber(panel, 'merchantFunds');
    const unlimitedFunds = this._readChecked(panel, 'unlimitedFunds');
    const buyRateBps = this._readNumber(panel, 'buyRateBps');
    const buybackRateBps = this._readNumber(panel, 'buybackRateBps');
    const preordersEnabled = this._readChecked(panel, 'preordersEnabled');
    const depositBps = this._readNumber(panel, 'depositBps');
    const maxPerActor = this._readNumber(panel, 'maxPerActor');
    const theftEnabled = this._readChecked(panel, 'theftEnabled');
    let failed = false;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when saving commerce.';
        return;
      }
      const existing = shop.commerce || {};
      let funds;
      if (unlimitedFunds) {
        funds = null;
      } else if (merchantFunds != null) {
        funds = merchantFunds;
      } else if (existing.funds != null) {
        funds = existing.funds;
      } else {
        funds = 0;
      }
      const rawCommerce = {
        ...existing,
        funds,
        buyRateBps,
        buybackRateBps,
        preorders: { enabled: preordersEnabled, depositBps, maxPerActor },
        theft: { enabled: theftEnabled },
      };
      let nextCommerce;
      try {
        nextCommerce = normalizeCommerce(rawCommerce);
      } catch (err) {
        failed = true;
        this._data.notice = err?.message
          ? String(err.message).replace(/^\[market\]\s*/, '')
          : 'Invalid commerce settings.';
        this.render({ force: true });
        return;
      }
      await this._store.updateShop(shopId, { commerce: nextCommerce });
    });
    if (failed) return;
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  /**
   * Add a new service with safe defaults. The row is persisted immediately under
   * the shared per-shop lock (capped at MAX_COMMERCE_SERVICES) and validated via
   * `normalizeCommerce`, so a just-added blank row never fails normalization.
   */
  async _onAddService(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    let failed = false;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when adding a service.';
        return;
      }
      const services = Array.isArray(shop.commerce?.services) ? shop.commerce.services : [];
      if (services.length >= MAX_COMMERCE_SERVICES) {
        message = 'A shop can have at most twenty services.';
        return;
      }
      const defaultService = {
        id: makeId(),
        name: 'New service',
        description: '',
        price: 0,
        visible: true,
        enabled: true,
      };
      let nextCommerce;
      try {
        nextCommerce = normalizeCommerce({
          ...(shop.commerce || {}),
          services: [...services, defaultService],
        });
      } catch (err) {
        failed = true;
        this._data.notice = err?.message
          ? String(err.message).replace(/^\[market\]\s*/, '')
          : 'Could not add the service.';
        this.render({ force: true });
        return;
      }
      await this._store.updateShop(shopId, { commerce: nextCommerce });
    });
    if (failed) return;
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  /**
   * Save every service editor row. Each `[data-service-id]` fieldset is read for
   * name/description/price/visibility/enabled, validated via `normalizeCommerce`,
   * then patched as `commerce.services` only - the rest of commerce (funds, rates,
   * specials, preorders, theft) is preserved. Edits are merged by id into the
   * freshly re-read persisted list, so a service added concurrently (or otherwise
   * absent from the DOM) is never dropped. A DOM row whose id is not in the
   * persisted list fails closed (a notice, no write). On a validation error the
   * notice is shown and the unsaved form is left intact (no data refresh, no write).
   */
  async _onSaveServices(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    const root = this.element;
    const rows =
      root && typeof root.querySelectorAll === 'function'
        ? Array.from(root.querySelectorAll('[data-service-id]'))
        : [];
    const rawServices = rows.map((row) => ({
      id: row.dataset.serviceId,
      name: row.querySelector('[name="serviceName"]')?.value ?? '',
      description: row.querySelector('[name="serviceDescription"]')?.value ?? '',
      price: this._readNumber(row, 'servicePrice'),
      visible: !!row.querySelector('[name="serviceVisible"]')?.checked,
      enabled: !!row.querySelector('[name="serviceEnabled"]')?.checked,
    }));
    let failed = false;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when saving services.';
        return;
      }
      const persisted = Array.isArray(shop.commerce?.services) ? shop.commerce.services : [];
      const persistedIds = new Set(persisted.map((s) => s.id));
      const unknown = rawServices.find((s) => !persistedIds.has(s.id));
      if (unknown) {
        failed = true;
        this._data.notice =
          'One of the service rows no longer matches a saved service, so nothing was saved.';
        this.render({ force: true });
        return;
      }
      const editsById = new Map(rawServices.map((s) => [s.id, s]));
      // Merge edits by id into the freshly re-read persisted list, so a service
      // added concurrently (or otherwise absent from the DOM) is never dropped.
      const merged = persisted.map((s) =>
        editsById.has(s.id) ? { ...s, ...editsById.get(s.id) } : { ...s }
      );
      let nextCommerce;
      try {
        nextCommerce = normalizeCommerce({ ...(shop.commerce || {}), services: merged });
      } catch (err) {
        failed = true;
        this._data.notice = err?.message
          ? String(err.message).replace(/^\[market\]\s*/, '')
          : 'Invalid service data.';
        this.render({ force: true });
        return;
      }
      await this._store.updateShop(shopId, { commerce: nextCommerce });
    });
    if (failed) return;
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  /**
   * Remove a single service by id, under the shared per-shop lock. Only the
   * matching service is dropped; all other commerce fields are carried through.
   */
  async _onRemoveService(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const serviceId = target?.dataset?.serviceId || data?.dataset?.serviceId;
    if (!serviceId) return;
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when removing a service.';
        return;
      }
      const services = Array.isArray(shop.commerce?.services) ? shop.commerce.services : [];
      const nextCommerce = normalizeCommerce({
        ...(shop.commerce || {}),
        services: services.filter((s) => s.id !== serviceId),
      });
      await this._store.updateShop(shopId, { commerce: nextCommerce });
    });
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  /**
   * Add a new special with safe defaults (`New special`, price 0, no inventory
   * link, no actor gate, hidden-visible). Persisted immediately under the shared
   * per-shop lock and capped at MAX_COMMERCE_SPECIALS; an empty `entryId` passes
   * normalization, so a just-added special never links to a bogus item.
   */
  async _onAddSpecial(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    let failed = false;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when adding a special.';
        return;
      }
      const specials = Array.isArray(shop.commerce?.specials) ? shop.commerce.specials : [];
      if (specials.length >= MAX_COMMERCE_SPECIALS) {
        message = 'A shop can have at most twenty specials.';
        return;
      }
      const defaultSpecial = {
        id: makeId(),
        title: 'New special',
        description: '',
        price: 0,
        visible: true,
        entryId: '',
        actorUuids: [],
      };
      let nextCommerce;
      try {
        nextCommerce = normalizeCommerce({
          ...(shop.commerce || {}),
          specials: [...specials, defaultSpecial],
        });
      } catch (err) {
        failed = true;
        this._data.notice = err?.message
          ? String(err.message).replace(/^\[market\]\s*/, '')
          : 'Could not add the special.';
        this.render({ force: true });
        return;
      }
      await this._store.updateShop(shopId, { commerce: nextCommerce });
    });
    if (failed) return;
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  /**
   * Save every special editor row. Each `[data-special-id]` fieldset is read for
   * title/description/price/inventory link/actor UUIDs/visibility. A non-empty
   * `entryId` must exist in the CURRENT inventory (fail closed otherwise); actor
   * UUIDs are comma-split and trimmed then validated by `normalizeCommerce`. Edits
   * are merged by id into the freshly re-read persisted list - a special added
   * concurrently (or otherwise absent from the DOM) is never dropped, and a DOM row
   * whose id is not in the persisted list fails closed. On any validation error the
   * notice is shown and the unsaved form is left intact (no write, no refresh).
   */
  async _onSaveSpecials(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    const root = this.element;
    const rows =
      root && typeof root.querySelectorAll === 'function'
        ? Array.from(root.querySelectorAll('[data-special-id]'))
        : [];
    const rawSpecials = rows.map((row) => {
      const actorUuids = (row.querySelector('[name="specialActorUuids"]')?.value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      return {
        id: row.dataset.specialId,
        title: row.querySelector('[name="specialTitle"]')?.value ?? '',
        description: row.querySelector('[name="specialDescription"]')?.value ?? '',
        price: this._readNumber(row, 'specialPrice'),
        visible: !!row.querySelector('[name="specialVisible"]')?.checked,
        entryId: row.querySelector('[name="specialEntryId"]')?.value ?? '',
        actorUuids,
      };
    });
    let failed = false;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when saving specials.';
        return;
      }
      const inventoryIds = new Set((shop.inventory || []).map((e) => e.id));
      const missingEntry = rawSpecials.find(
        (sp) => sp.entryId !== '' && !inventoryIds.has(sp.entryId)
      );
      if (missingEntry) {
        failed = true;
        this._data.notice =
          'One of the specials references an inventory item that is no longer available, so nothing was saved.';
        this.render({ force: true });
        return;
      }
      const persisted = Array.isArray(shop.commerce?.specials) ? shop.commerce.specials : [];
      const persistedIds = new Set(persisted.map((s) => s.id));
      const unknownRow = rawSpecials.find((s) => !persistedIds.has(s.id));
      if (unknownRow) {
        failed = true;
        this._data.notice =
          'One of the special rows no longer matches a saved special, so nothing was saved.';
        this.render({ force: true });
        return;
      }
      const editsById = new Map(rawSpecials.map((s) => [s.id, s]));
      const merged = persisted.map((s) =>
        editsById.has(s.id) ? { ...s, ...editsById.get(s.id) } : { ...s }
      );
      let nextCommerce;
      try {
        nextCommerce = normalizeCommerce({ ...(shop.commerce || {}), specials: merged });
      } catch (err) {
        failed = true;
        this._data.notice = err?.message
          ? String(err.message).replace(/^\[market\]\s*/, '')
          : 'Invalid special data.';
        this.render({ force: true });
        return;
      }
      await this._store.updateShop(shopId, { commerce: nextCommerce });
    });
    if (failed) return;
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  /**
   * Remove a single special by id, under the shared per-shop lock. Only the
   * matching special is dropped; all other commerce fields are carried through.
   */
  async _onRemoveSpecial(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const specialId = target?.dataset?.specialId || data?.dataset?.specialId;
    if (!specialId) return;
    const shopId = this._data.selectedShopId;
    if (!shopId) return;
    let message = '';
    await this._withShopLock(shopId, async () => {
      const shop = await this._store.findShop(shopId);
      if (!shop) {
        message = 'Shop not found when removing a special.';
        return;
      }
      const specials = Array.isArray(shop.commerce?.specials) ? shop.commerce.specials : [];
      const nextCommerce = normalizeCommerce({
        ...(shop.commerce || {}),
        specials: specials.filter((s) => s.id !== specialId),
      });
      await this._store.updateShop(shopId, { commerce: nextCommerce });
    });
    await this._refreshData();
    this._data.notice = message;
    this.render({ force: true });
  }

  // ---- M5 advanced-order manual adjudication -----------------------------------

  /**
   * Report the outcome of a GM advanced-order action truthfully. A replay/fulfilled/
   * committed/cancelled status is a success; a needsRecovery/pending status surfaces
   * a recovery warning; an error status surfaces the error. The notice is set on
   * `_data` by the caller, which always follows with an orders-only refresh.
   */
  _noticeForAdvancedAction(action, result) {
    const status = result?.status;
    if (!result) {
      this._data.notice = 'The action returned no result.';
    } else if (status === 'replay') {
      this._data.notice = 'Already processed.';
    } else if (status === 'fulfilled') {
      this._data.notice = 'Order marked fulfilled.';
    } else if (status === 'cancelled') {
      this._data.notice = 'Order cancelled.';
    } else if (status === 'committed') {
      this._data.notice = 'Order resolved.';
    } else if (status === 'needsRecovery' || status === 'pending') {
      this._data.notice = `The action needs recovery${result?.error ? ` (${result.error})` : ''}.`;
    } else if (status === 'error') {
      this._data.notice = `Action failed: ${result?.error || 'unknown'}.`;
    } else {
      this._data.notice = `Action result: ${status || 'unknown'}.`;
    }
  }

  /**
   * Mark a booked service order fulfilled (manual adjudication). Guarded on the
   * active GM, passes a fresh idempotency `requestId` so a double-click never runs
   * the fulfillment twice, then refreshes orders ONLY (never the shop, so unsaved
   * appearance/inventory edits survive).
   */
  async _onFulfillService(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const orderId = target?.dataset?.orderId || data?.dataset?.orderId;
    if (!orderId) return;
    let result;
    try {
      result = await this._advancedCall('fulfillService', { orderId, requestId: makeId() });
    } catch (err) {
      this._data.notice = `Fulfill failed: ${(err && err.message) || err}`;
      await this._refreshOrdersOnly();
      this.render({ force: true });
      return;
    }
    this._noticeForAdvancedAction('fulfill', result);
    await this._refreshOrdersOnly();
    this.render({ force: true });
  }

  /**
   * Fulfill a booked preorder (charge the remaining balance, deliver, decrement).
   * Guarded on the active GM, idempotent via a fresh `requestId`, and refreshes
   * orders ONLY so in-progress manager edits are not reset.
   */
  async _onFulfillPreorder(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const orderId = target?.dataset?.orderId || data?.dataset?.orderId;
    if (!orderId) return;
    let result;
    try {
      result = await this._advancedCall('fulfillPreorder', { orderId, requestId: makeId() });
    } catch (err) {
      this._data.notice = `Preorder fulfill failed: ${(err && err.message) || err}`;
      await this._refreshOrdersOnly();
      this.render({ force: true });
      return;
    }
    this._noticeForAdvancedAction('fulfill-preorder', result);
    await this._refreshOrdersOnly();
    this.render({ force: true });
  }

  /**
   * Cancel a booked preorder (refund the deposit). Guarded on the active GM,
   * idempotent via a fresh `requestId`, and refreshes orders ONLY.
   */
  async _onCancelPreorder(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const orderId = target?.dataset?.orderId || data?.dataset?.orderId;
    if (!orderId) return;
    let result;
    try {
      result = await this._advancedCall('cancelPreorder', { orderId, requestId: makeId() });
    } catch (err) {
      this._data.notice = `Preorder cancel failed: ${(err && err.message) || err}`;
      await this._refreshOrdersOnly();
      this.render({ force: true });
      return;
    }
    this._noticeForAdvancedAction('cancel-preorder', result);
    await this._refreshOrdersOnly();
    this.render({ force: true });
  }

  /**
   * Grant a theft (the active GM decides the player kept the item). `resolveTheft`
   * REQUIRES a typed boolean `success`, so this passes `true`. Refreshes orders only.
   */
  async _onResolveTheftSuccess(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const orderId = target?.dataset?.orderId || data?.dataset?.orderId;
    if (!orderId) return;
    let result;
    try {
      result = await this._advancedCall('resolveTheft', {
        orderId,
        success: true,
        requestId: makeId(),
      });
    } catch (err) {
      this._data.notice = `Theft resolve failed: ${(err && err.message) || err}`;
      await this._refreshOrdersOnly();
      this.render({ force: true });
      return;
    }
    this._noticeForAdvancedAction('resolve-theft', result);
    await this._refreshOrdersOnly();
    this.render({ force: true });
  }

  /**
   * Refuse a theft (the active GM decides the player failed to keep the item).
   * `resolveTheft` requires a typed boolean `success`, so this passes `false`.
   * Refreshes orders only.
   */
  async _onResolveTheftFailure(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const orderId = target?.dataset?.orderId || data?.dataset?.orderId;
    if (!orderId) return;
    let result;
    try {
      result = await this._advancedCall('resolveTheft', {
        orderId,
        success: false,
        requestId: makeId(),
      });
    } catch (err) {
      this._data.notice = `Theft resolve failed: ${(err && err.message) || err}`;
      await this._refreshOrdersOnly();
      this.render({ force: true });
      return;
    }
    this._noticeForAdvancedAction('resolve-theft', result);
    await this._refreshOrdersOnly();
    this.render({ force: true });
  }

  /**
   * `next-orders`. Advance to the next page of the advanced-order list (100-record
   * pages) and re-render the manager, leaving the shop itself untouched.
   */
  async _onNextOrders() {
    const page = Math.max(0, this._data.orderPage || 0);
    this._data.orderPage = page + 1;
    await this._refreshOrdersOnly();
    this.render({ force: true });
  }

  /**
   * `prev-orders`. Step back to the previous page of the advanced-order list,
   * never below the first page, and re-render without touching the shop.
   */
  async _onPrevOrders() {
    const page = Math.max(0, this._data.orderPage || 0);
    this._data.orderPage = Math.max(0, page - 1);
    await this._refreshOrdersOnly();
    this.render({ force: true });
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

  _hasField(scope, name) {
    return !!scope?.querySelector?.(`[name="${name}"]`);
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
    await this._loadValuationContext(id || null);
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

  /**
   * Load the GM-only item-valuation context for `actorId`. Reads the selected
   * actor's embedded Items (each projected to `{id, name}`) so the GM can pick
   * which Item to value, and records the actor's display name for the panel. A
   * missing actor or an absent `.items` yields an empty item list - never a
   * throw. Called alongside `_loadReputation` (they share the same selector).
   */
  async _loadValuationContext(actorId) {
    if (!actorId) {
      this._data.valuationActorId = null;
      this._data.valuationActorName = '';
      this._data.valuationItems = [];
      return;
    }
    const actor = await this._getActor(actorId);
    this._data.valuationActorId = actorId || null;
    if (!actor) {
      this._data.valuationActorName = '';
      this._data.valuationItems = [];
      return;
    }
    const items = Array.isArray(actor.items)
      ? actor.items
      : actor.items && typeof actor.items.values === 'function'
        ? Array.from(actor.items.values())
        : actor.items && typeof actor.items[Symbol.iterator] === 'function'
          ? Array.from(actor.items)
          : [];
    this._data.valuationActorName = actor.name ? String(actor.name) : '';
    this._data.valuationItems = items.map((item) => ({
      id: item.id ?? item._id,
      name: item.name ?? '',
    }));
  }

  /**
   * Project the private `selectedShop.commerce.valuations` list to the bounded
   * shape the template reads (`{id, actorUuid, itemId, amount}`). The raw
   * valuation entries carry a tamper-detecting `fingerprint` that is never
   * exposed to the GM UI; only these scalar fields are. Derived fresh each render
   * so the list always reflects the current selected shop.
   */
  _buildApprovedValuations() {
    const valuations = Array.isArray(this._data.selectedShop?.commerce?.valuations)
      ? this._data.selectedShop.commerce.valuations
      : [];
    return valuations.map((v) => ({
      id: v.id,
      actorUuid: v.actorUuid,
      itemId: v.itemId,
      amount: v.amount,
    }));
  }

  /**
   * `approve-valuation`. Guarded on the active GM, validates a selected
   * character, a chosen Item and a positive whole-number amount, then invokes the
   * GM-only `approveValuation` mutation (via the injected `deps.approveValuation`
   * or the `api.advanced.approveValuation` wrapper, which re-checks the active GM
   * before any store read). On success the shop is refreshed so the newly approved
   * valuation appears in the private list and, on the next catalog request, in the
   * player-facing `approvedItems` allowlist.
   */
  async _onApproveValuation(event, target, data) {
    if (!this._isActiveGM()) {
      this._data.notice = ACTIVE_GM_MESSAGE;
      this.render({ force: true });
      return;
    }
    const shopId = this._data.selectedShopId;
    const actorId = this._data.selectedReputationActorId;
    if (!shopId) return;
    if (!actorId) {
      this._data.notice = 'Choose a character to value an item for.';
      this.render({ force: true });
      return;
    }
    const itemId = (this._readField('valuationItemId') || '').trim();
    if (!itemId) {
      this._data.notice = 'Choose an item to value.';
      this.render({ force: true });
      return;
    }
    const amount = this._readNumber(this.element, 'valuationAmount');
    if (amount == null || !Number.isSafeInteger(amount) || amount < 1) {
      this._data.notice = 'The valuation must be a positive whole number.';
      this.render({ force: true });
      return;
    }
    let result;
    try {
      result = await this._advancedCall('approveValuation', {
        shopId,
        actorId,
        itemId,
        amount,
      });
    } catch (err) {
      this._data.notice = `Valuation failed: ${(err && err.message) || err}`;
      this.render({ force: true });
      return;
    }
    this._noticeForValuation(result);
    await this._refreshData();
    this.render({ force: true });
  }

  _noticeForValuation(result) {
    const status = result?.status;
    if (status === 'approved') {
      const name = typeof result.itemName === 'string' && result.itemName !== ''
        ? ` for ${result.itemName}`
        : '';
      this._data.notice = `Valuation approved${name}.`;
    } else if (status === 'replay') {
      this._data.notice = 'Already approved.';
    } else if (status === 'error') {
      this._data.notice = `Valuation failed: ${result?.error || 'unknown'}.`;
    } else {
      this._data.notice = `Valuation result: ${status || 'unknown'}.`;
    }
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
