// Player storefront application (Foundry VTT v14).
//
// The storefront never touches the GM's private store: every catalog and
// purchase goes through the request channel (`api.request`) and responses are
// matched by `requestId`. Only a GM-created whisper is trusted (the chat
// hook's `userId` must be a GM). Actors offered for purchase are those the
// current user owns (`actor.testUserPermission(game.user, OWNER)`).

import { makeId, ACCENT_COLOR_RE, sanitizeMediaPath } from '../services/model.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const OWNER_LEVEL = 3; // CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
const CURRENCY_LABELS = { dnd5e: 'cp' };

/**
 * Build a stable-enough request id for correlating a response. The prefix is
 * only used for readability; the id must be supplied to the response so the
 * player can match it. Never reused across requests.
 */
export function newRequestId(prefix = 'mk') {
  return `${prefix}-${makeId(12)}`;
}

/**
 * Check whether a chat message is a market response whisper created by a GM.
 * @param {object} message
 * @param {string} userId  hook-provided message creator id
 * @param {Function} isGM (userId) => boolean
 * @returns {boolean}
 */
export function isMarketResponseFromGM(message, userId, isGM) {
  const flag = message?.flags?.market;
  if (!flag || flag.type !== 'response') return false;
  if (!isGM(userId)) return false;
  return true;
}

export class MarketStorefront extends HandlebarsApplicationMixin(ApplicationV2) {
  static PARTS = {
    storefront: {
      template: 'modules/market/templates/shop.hbs',
      id: 'storefront',
      scrollable: [''],
    },
  };

  // Build a CALLABLE static action wrapper. At dispatch time ApplicationV2 calls
  // it with `this` bound to the live application instance, so it can delegate to
  // the matching instance `_on...` method. This avoids referencing an undefined
  // instance method from a static context.
  static _action(method) {
    return function (event, target, data) {
      return this[method](event, target, data);
    };
  }

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: ['market-storefront-app'],
    title: 'Market Storefront',
    // Genuinely large, viewport-aware storefront window. `position` carries the
    // default width/height; `window.resizable` lets the user resize around the
    // fixed default (CSS scales content down on small viewports).
    position: { width: 1150, height: 850 },
    window: { ...(super.DEFAULT_OPTIONS?.window || {}), resizable: true },
    actions: {
      buy: this._action('_onBuy'),
      refresh: this._action('_onRefresh'),
      'select-actor': this._action('_onSelectActor'),
      'filter-category': this._action('_onFilterCategory'),
      inspect: this._action('_onInspect'),
      'close-detail': this._action('_onCloseDetail'),
      'toggle-sound': this._action('_onToggleSound'),
      'sort-items': this._action('_onSortItems'),
    },
  };

  constructor(options = {}) {
    super(options);
    this._deps = options.deps || {};
    this._storefrontShopId = options.shopId || options.shop || null;
    this._loaded = false;
    // Monotonic token for background-music starts. Incremented on every stop so
    // an in-flight `_startSound` that resolves later detects it was superseded
    // and stops the stale Sound instead of leaking it as the live handle.
    this._soundGeneration = 0;
    this._soundHandle = null;
    this._pendingCatalogRequestId = null;
    this._pendingPurchaseRequestId = null;
    this._pendingPurchaseEntryId = null;
    this._data = this._initialData();
    this._bindChat = this._onChatMessage.bind(this);
    if (typeof Hooks !== 'undefined') Hooks.on('createChatMessage', this._bindChat);
  }

  _onClose() {
    if (typeof Hooks !== 'undefined') Hooks.off('createChatMessage', this._bindChat);
    this._stopSound();
    this._unbindResize();
  }

  _initialData() {
    return {
      shopId: this._storefrontShopId,
      shop: null,
      inventory: [],
      hasGM: this._hasActiveGM(),
      currencyLabel: this._currencyLabel(),
      actors: [],
      selectedActorId: null,
      pending: false,
      loading: false,
      feedback: '',
      notice: '',
      error: null,
      // Storefront browsing state (M2). These live in `_data`; the display list
      // is derived in `_prepareContext` so M1 callers inspecting `_data.inventory`
      // continue to see the raw catalog.
      sort: 'featured',
      search: '',
      categoryFilter: null,
      selectedEntryId: null,
      soundEnabled: false,
      // The raw purchase-quantity string. Bound to the quantity input/change
      // without a re-render so search/sort/filter/inspect re-renders never reset
      // the player's in-progress quantity. Defaults to '1'.
      quantity: '1',
    };
  }

  // ---- context / lifecycle -------------------------------------------------

  _prepareContext() {
    // Derive the public catalog view from `_data` WITHOUT overwriting
    // `_data.inventory`, which M1 tests and purchase/catalog logic read.
    const list = this._catalogEntries();
    const id = this._data.selectedEntryId;
    const selectedEntry = (id && list.find((e) => e.id === id)) || null;
    return {
      ...this._data,
      inventory: list,
      categories: this._catalogCategories(),
      selectedEntry,
    };
  }

  async _onRender(event) {
    this._data.hasGM = this._hasActiveGM();
    this._bindControls();
    this._data.actors = this._ownedActors();
    if (!this._data.selectedActorId && this._data.actors.length) {
      this._data.selectedActorId = this._data.actors[0].id;
    }
    this._applyStorefrontStyles();
    // Restore search focus/caret after a re-render so search-as-you-type keeps
    // focus (the template rebinds the input value from `_data.search`).
    if (this._focusSearch) {
      const search = this.element?.querySelector?.('input[name="search"]');
      if (search && typeof search.focus === 'function') {
        search.focus();
        if (typeof search.setSelectionRange === 'function') {
          const len = (search.value || '').length;
          search.setSelectionRange(len, len);
        }
      }
      this._focusSearch = false;
    }
    if (!this._loaded) {
      this._loaded = true;
      await this._requestCatalog();
      this._applyViewportPosition();
      this._bindResize();
    }
  }

  _currencyLabel() {
    return CURRENCY_LABELS[this._systemId()] || '';
  }

  _systemId() {
    if (this._deps.systemId) return this._deps.systemId();
    return String(game?.system?.id || '');
  }

  _hasActiveGM() {
    if (this._deps.hasActiveGM) return this._deps.hasActiveGM();
    return !!(game?.users?.activeGM);
  }

  _isGM(userId) {
    if (this._deps.isGM) return this._deps.isGM(userId);
    const user = game?.users?.get?.(userId);
    return !!user && user.isGM;
  }

  _request(payload) {
    if (this._deps.request) return this._deps.request(payload);
    const api = game?.modules?.get?.('market')?.api;
    if (api?.request) return api.request(payload);
    return Promise.resolve(null);
  }

  // ---- actor helpers ---------------------------------------------------------

  _ownedActors() {
    if (this._deps.ownedActors) return this._deps.ownedActors();
    const user = game?.user;
    if (!user) return [];
    const out = [];
    for (const actor of game.actors) {
      let owned = false;
      if (typeof actor.testUserPermission === 'function') {
        const lvl = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? OWNER_LEVEL;
        owned = actor.testUserPermission(user, lvl);
      } else {
        const level = actor.ownership?.[user.id];
        owned = typeof level === 'number' && level >= OWNER_LEVEL;
      }
      if (owned) out.push({ id: actor.id, name: actor.name });
    }
    return out;
  }

  // ---- requests -------------------------------------------------------------

  async _requestCatalog() {
    // Without an active GM no one will answer, so do not leave the storefront in
    // an endless "loading" state - show the no-GM message instead.
    if (!this._hasActiveGM()) {
      this._data.loading = false;
      this._data.notice = 'A Game Master is not currently connected.';
      this.render({ force: true });
      return;
    }
    await this._sendCatalogRequest(newRequestId('catalog'));
  }

  async _requestRefresh() {
    if (!this._hasActiveGM()) {
      this._data.loading = false;
      this._data.notice = 'A Game Master is not currently connected.';
      this.render({ force: true });
      return;
    }
    await this._sendCatalogRequest(newRequestId('refresh'));
  }

  /**
   * Send a catalog request and, if sending the ChatMessage itself fails (e.g.
   * a ChatMessage.create rejection), fail closed: clear the loading state and
   * surface an error instead of leaving the storefront stuck loading.
   */
  async _sendCatalogRequest(requestId) {
    this._pendingCatalogRequestId = requestId;
    this._data.loading = true;
    this._data.notice = '';
    this.render({ force: true });
    try {
      await this._request({ type: 'catalog', shopId: this._storefrontShopId, requestId });
    } catch (err) {
      this._pendingCatalogRequestId = null;
      this._data.loading = false;
      this._data.error = 'send-failed';
      this._data.notice = this._catalogErrorText('send-failed');
      this.render({ force: true });
    }
  }

  _requestPurchase(entryId) {
    if (this._data.pending) return;
    if (!this._hasActiveGM()) {
      this._data.feedback = 'A Game Master is not currently connected.';
      this.render({ force: true });
      return;
    }
    const actorId = this._selectedActorId();
    if (!actorId) {
      this._data.feedback = 'Choose a character to shop as.';
      this.render({ force: true });
      return;
    }
    const quantity = this._readQuantity();
    if (quantity == null) {
      // Do not silently floor/replace an invalid quantity; surface it instead.
      this._data.feedback = 'Quantity must be a positive whole number.';
      this.render({ force: true });
      return;
    }
    const requestId = newRequestId('purchase');
    this._pendingPurchaseRequestId = requestId;
    this._pendingPurchaseEntryId = entryId;
    this._data.pending = true;
    this._data.feedback = '';
    this.render({ force: true });
    this._request({
      type: 'purchase',
      shopId: this._storefrontShopId,
      entryId,
      actorId,
      quantity,
      requestId,
    }).catch(() => {
      this._data.pending = false;
      this._data.feedback = 'Purchase request failed to send.';
      this.render({ force: true });
    });
  }

  // ---- chat response correlation -------------------------------------------

  async _onChatMessage(message, options, userId) {
    if (!isMarketResponseFromGM(message, userId, (id) => this._isGM(id))) return;
    const response = message?.flags?.market?.response || {};
    const requestId = response.requestId;
    if (requestId && requestId === this._pendingCatalogRequestId) {
      await this._onCatalogResponse(response);
    } else if (requestId && requestId === this._pendingPurchaseRequestId) {
      await this._onPurchaseResponse(response);
    }
  }

  _onCatalogResponse(response) {
    this._pendingCatalogRequestId = null;
    this._data.loading = false;
    if (response.type === 'error') {
      this._data.shop = null;
      this._data.inventory = [];
      this._data.error = response.error || 'catalog-error';
      this._data.notice = this._catalogErrorText(response.error);
    } else {
      this._data.shop = response.shop || null;
      this._data.inventory = Array.isArray(response.inventory) ? response.inventory : [];
      this._data.error = null;
      this._data.notice = '';
    }
    // Stop any playing loop on a catalog change/error; restart it only if the
    // player explicitly opted in and the new catalog has a valid music path.
    this._syncSound();
    this.render({ force: true });
  }

  _onPurchaseResponse(response) {
    this._data.pending = false;
    this._pendingPurchaseRequestId = null;
    this._pendingPurchaseEntryId = null;
    const result = response?.result || { status: 'error' };
    if (result.status === 'committed') {
      this._data.feedback = 'Purchase complete.';
      this._playSoundEffect();
      this.render({ force: true });
      // Refresh the catalog without reopening the storefront.
      this._requestRefresh();
    } else {
      this._data.feedback = this._purchaseErrorText(result);
      this.render({ force: true });
    }
  }

  _catalogErrorText(error) {
    if (error === 'shop-not-found') return 'This market has no open door (shop not found).';
    if (error === 'missing-shop-id') return 'No shop selected.';
    if (error === 'send-failed') return 'The catalog request could not be sent. Please try again.';
    return `Could not load the catalog (${error || 'unknown error'}).`;
  }

  _purchaseErrorText(result) {
    const map = {
      'insufficient-funds': 'Not enough gold on that character.',
      'insufficient-stock': 'Not enough stock.',
      'shop-closed': 'The shop just closed.',
      'entry-hidden': 'That item is no longer on display.',
      'actor-not-owned': 'You do not own that character.',
      'actor-not-found': 'Character not found.',
      'adapter-unsupported': 'This system has no price adapter configured.',
      'not-a-gm': 'No active Game Master.',
      'conflicting duplicate payload': 'This request was already processed.',
      'ledger-pending': 'This purchase is pending recovery; please check the market ledger.',
      'server-error': 'The market server hit an error while processing the purchase.',
    };
    return map[result.error] || `Purchase ${result.status || 'failed'} (${result.error || 'unknown'}).`;
  }

  // ---- actions --------------------------------------------------------------

  async _onBuy(event, target, data) {
    const entryId = target?.dataset?.entryId || data?.dataset?.entryId;
    if (!entryId) return;
    this._requestPurchase(entryId);
  }

  async _onRefresh(event, target, data) {
    await this._requestRefresh();
  }

  async _onSelectActor(event, target, data) {
    const id = target?.value ?? target?.dataset?.actorId;
    this._data.selectedActorId = id;
    this.render({ force: true });
  }

  _selectedActorId() {
    const field = this._readField('actorId');
    if (field) return field;
    return this._data.selectedActorId;
  }

  _readQuantity() {
    // Prefer the live field (it is the source of truth while the storefront is
    // on screen and reflects the player's most recent keystroke); fall back to the
    // bound `_data.quantity` state so a re-render never loses an input.
    const el = this.element?.querySelector?.('[name="quantity"]');
    const raw = String(el ? el.value : this._data.quantity ?? '').trim();
    if (raw === '') return 1;
    const n = Number(raw);
    // Reject anything that is not a positive safe integer (no flooring, no
    // silent replacement with a default). Returns null for invalid input so the
    // caller can surface a validation error instead of sending a wrong quantity.
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
  }

  /**
   * A live change to the quantity input. Updates `_data.quantity` so a
   * search/sort/filter/inspect re-render retains the player's in-progress value.
   * Deliberately does NOT re-render - the value is only read back by the next
   * re-render via the template binding.
   */
  _onQuantityChange(event) {
    const value = event?.target?.value;
    if (typeof value === 'string') this._data.quantity = value;
  }

  _readField(name) {
    const el = this.element?.querySelector?.(`[name="${name}"]`);
    if (!el) return undefined;
    if (el.type === 'checkbox') return el.checked;
    return el.value;
  }

  // ---- DOM controls (search filter + actor select) --------------------------

  _bindControls() {
    const root = this.element;
    if (!root) return;
    const input = root.querySelector('input[name="search"]');
    if (input) input.addEventListener('input', () => this._onSearchInput(input.value));
    const sortSelect = root.querySelector('select[name="sort"]');
    if (sortSelect) {
      sortSelect.addEventListener('change', () => this._onSortItems(null, sortSelect, {}));
    }
    const actorSelect = root.querySelector('select[name="actorId"]');
    if (actorSelect) {
      actorSelect.addEventListener('change', () => {
        this._data.selectedActorId = actorSelect.value;
      });
    }
    const quantityInput = root.querySelector('input[name="quantity"]');
    if (quantityInput) {
      quantityInput.addEventListener('input', (event) => this._onQuantityChange(event));
      quantityInput.addEventListener('change', (event) => this._onQuantityChange(event));
    }
    root.querySelectorAll('.product-card').forEach((card) => {
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          this._inspectEntry(card.dataset.entryId);
        }
      });
    });
  }

  _onSearchInput(value) {
    this._focusSearch = true;
    this._filterCatalog(value || '');
  }

  _filterCatalog(term) {
    this._data.search = String(term || '');
    this.render({ force: true });
  }

  // ---- catalog derivation ------------------------------------------------------

  _catalogEntries() {
    const raw = this._data.inventory || [];
    const query = String(this._data.search || '').trim().toLowerCase();
    const category = this._data.categoryFilter || null;
    const list = raw.filter((e) => {
      if (e.visible === false) return false;
      if (category && String(e.category || '') !== category) return false;
      if (query) {
        const hay = [e.name, e.category, e.rarity, e.publicDescription]
          .map((v) => String(v ?? '').toLowerCase())
          .join(' ');
        if (!hay.includes(query)) return false;
      }
      return true;
    });
    return this._sortCatalog(list);
  }

  _sortCatalog(list) {
    const copy = list.slice();
    const mode = this._data.sort || 'featured';
    if (mode === 'name') {
      copy.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    } else if (mode === 'price') {
      copy.sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
    }
    // 'featured' presets the catalog's original order (no reordering).
    return copy;
  }

  _catalogCategories() {
    const entries = this._data.inventory || [];
    const seen = new Set();
    const cats = [];
    for (const e of entries) {
      // Only categories that appear on VISIBLE public entries belong in the
      // filter tabs; a hidden entry's category must not surface a tab that
      // filters the catalog down to nothing.
      if (e.visible === false) continue;
      const c = String(e.category || '').trim();
      if (c && !seen.has(c)) {
        seen.add(c);
        cats.push(c);
      }
    }
    cats.sort((a, b) => a.localeCompare(b));
    const out = [{ id: 'all', label: 'All', active: !this._data.categoryFilter }];
    for (const c of cats) {
      out.push({ id: c, label: c, active: this._data.categoryFilter === c });
    }
    return out;
  }

  // ---- catalog actions ---------------------------------------------------------

  async _onFilterCategory(event, target, data) {
    const id = target?.dataset?.category || data?.dataset?.category;
    if (!id) return;
    this._data.categoryFilter = id === 'all' ? null : id;
    this.render({ force: true });
  }

  async _onInspect(event, target, data) {
    const id = target?.dataset?.entryId || data?.dataset?.entryId;
    if (!id) return;
    this._inspectEntry(id);
  }

  _inspectEntry(id) {
    this._data.selectedEntryId = id;
    this.render({ force: true });
  }

  async _onCloseDetail(event, target, data) {
    this._data.selectedEntryId = null;
    this.render({ force: true });
  }

  async _onSortItems(event, target, data) {
    const value = target?.value ?? data?.value;
    if (!value) return;
    this._data.sort = value;
    this.render({ force: true });
  }

  async _onToggleSound(event, target, data) {
    this._data.soundEnabled = !this._data.soundEnabled;
    if (this._data.soundEnabled) {
      await this._startSound();
    } else {
      this._stopSound();
    }
    this.render({ force: true });
  }

  // ---- sound -------------------------------------------------------------------

  async _startSound() {
    // Capture the generation now so that, if the play promise resolves AFTER a
    // toggle-off / catalog change / close (all of which increment the token via
    // `_stopSound`), the stale resolved Sound is stopped rather than installed
    // as the live handle.
    const token = this._soundGeneration;
    const src = this._data.shop?.appearance?.music || '';
    if (!src) return;
    const valid = sanitizeMediaPath(src);
    if (!valid) {
      this._data.notice = 'The shop music path is not a valid local asset path.';
      return;
    }
    let sound;
    try {
      sound = await this._playSound({ src: valid, volume: 0.25, loop: true });
    } catch (err) {
      this._data.notice = 'Could not play the shop music.';
      return;
    }
    if (token !== this._soundGeneration) {
      // The start was superseded while in flight; a `_stopSound` already ran, so
      // stop this now-stale Sound and keep the handle null.
      this._stopSoundHandle(sound);
      return;
    }
    this._soundHandle = sound;
  }

  /**
   * Safely stop an arbitrary Sound-like handle. Handles a synchronous `stop()`
   * throw and an async rejected `stop()` promise without an unhandled rejection.
   */
  _stopSoundHandle(handle) {
    if (!handle || typeof handle.stop !== 'function') return;
    try {
      const result = handle.stop();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (err) {
      // No-op: a failed stop is not user-facing.
    }
  }

  _stopSound() {
    // Invalidate any in-flight `_startSound`; a stale resolved sound is stopped
    // by its own continuation when it sees the token moved.
    this._soundGeneration += 1;
    this._stopSoundHandle(this._soundHandle);
    this._soundHandle = null;
  }

  _syncSound() {
    this._stopSound();
    if (this._data.soundEnabled) this._startSound();
  }

  _playSound(opts) {
    if (typeof this._deps.playSound === 'function') return this._deps.playSound(opts);
    const AudioHelper = foundry?.audio?.AudioHelper || globalThis.AudioHelper;
    if (AudioHelper && typeof AudioHelper.play === 'function') return AudioHelper.play(opts);
    return Promise.resolve(null);
  }

  _playSoundEffect() {
    if (!this._data.soundEnabled) return;
    const src = this._data.shop?.appearance?.soundEffect || '';
    const valid = sanitizeMediaPath(src);
    if (!valid) return;
    let result;
    try {
      result = this._playSound({ src: valid, volume: 0.25, loop: false });
    } catch (err) {
      // A synchronous throw from a playSound mock/stub surfaces as a notice.
      this._data.notice = 'Could not play the purchase sound effect.';
      return;
    }
    // `_playSound` may return a synchronous Sound object (which has no `.catch`)
    // or a Promise. Only attach a rejection handler to a real thenable so a sync
    // return never throws on `.catch is not a function`, and never leaves an
    // unhandled rejection on a pending promise.
    if (result && typeof result.catch === 'function') {
      result.catch(() => {
        this._data.notice = 'Could not play the purchase sound effect.';
      });
    }
  }

  // ---- storefront styling / viewport --------------------------------------------

  _applyStorefrontStyles() {
    const root = this.element;
    if (!root || typeof root.style === 'undefined') return;
    // Target the `.market-storefront` element (which the app form may wrap);
    // setting the variable anywhere higher would be overridden by the
    // selector's own default declaration.
    const hasClass = typeof root.classList?.contains === 'function';
    let storeRoot = root;
    if (!(hasClass && root.classList.contains('market-storefront'))) {
      const el = typeof root.querySelector === 'function' ? root.querySelector('.market-storefront') : null;
      if (el) storeRoot = el;
    }
    const target = storeRoot && storeRoot.style ? storeRoot : root;
    // Always clear the previous custom accent so a re-render/catalog change never
    // leaks a stale color from an earlier shop.
    target.style.removeProperty('--mk-custom-accent');
    const accent = this._data.shop?.appearance?.accentColor || '';
    if (ACCENT_COLOR_RE.test(accent)) {
      target.style.setProperty('--mk-custom-accent', accent);
    }
    const hero =
      typeof root.querySelector === 'function' ? root.querySelector('.shop-hero') : null;
    if (hero && hero.style) {
      hero.style.backgroundImage = '';
      const bg = sanitizeMediaPath(this._data.shop?.appearance?.backgroundImage || '');
      if (bg) hero.style.backgroundImage = `url("${bg}")`;
    }
  }

  _applyViewportPosition() {
    if (typeof window === 'undefined') return;
    if (typeof this.setPosition !== 'function') return;
    const margin = 40;
    const width = Math.max(320, (window.innerWidth || 0) - margin);
    const height = Math.max(400, (window.innerHeight || 0) - margin);
    this.setPosition({ width, height });
  }

  _bindResize() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    this._resizeHandler = () => this._applyViewportPosition();
    window.addEventListener('resize', this._resizeHandler);
  }

  _unbindResize() {
    if (typeof window === 'undefined' || typeof window.removeEventListener !== 'function') return;
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
  }
}

export default MarketStorefront;
