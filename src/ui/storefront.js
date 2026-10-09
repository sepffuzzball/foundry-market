// Player storefront application (Foundry VTT v14).
//
// The storefront never touches the GM's private store: every catalog and
// purchase goes through the request channel (`api.request`) and responses are
// matched by `requestId`. Only a GM-created whisper is trusted (the chat
// hook's `userId` must be a GM). Actors offered for purchase are those the
// current user owns (`actor.testUserPermission(game.user, OWNER)`).

import { makeId } from '../services/model.js';

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
    },
  };

  constructor(options = {}) {
    super(options);
    this._deps = options.deps || {};
    this._storefrontShopId = options.shopId || options.shop || null;
    this._loaded = false;
    this._pendingCatalogRequestId = null;
    this._pendingPurchaseRequestId = null;
    this._pendingPurchaseEntryId = null;
    this._data = this._initialData();
    this._bindChat = this._onChatMessage.bind(this);
    if (typeof Hooks !== 'undefined') Hooks.on('createChatMessage', this._bindChat);
  }

  _onClose() {
    if (typeof Hooks !== 'undefined') Hooks.off('createChatMessage', this._bindChat);
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
    };
  }

  // ---- context / lifecycle -------------------------------------------------

  _prepareContext() {
    return this._data;
  }

  async _onRender(event) {
    this._data.hasGM = this._hasActiveGM();
    this._bindControls();
    this._data.actors = this._ownedActors();
    if (!this._data.selectedActorId && this._data.actors.length) {
      this._data.selectedActorId = this._data.actors[0].id;
    }
    if (!this._loaded) {
      this._loaded = true;
      await this._requestCatalog();
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
    this.render({ force: true });
  }

  _onPurchaseResponse(response) {
    this._data.pending = false;
    this._pendingPurchaseRequestId = null;
    this._pendingPurchaseEntryId = null;
    const result = response?.result || { status: 'error' };
    if (result.status === 'committed') {
      this._data.feedback = 'Purchase complete.';
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
    const el = this.element?.querySelector?.('[name="quantity"]');
    if (!el) return 1;
    const raw = String(el.value).trim();
    if (raw === '') return 1;
    const n = Number(raw);
    // Reject anything that is not a positive safe integer (no flooring, no
    // silent replacement with a default). Returns null for invalid input so the
    // caller can surface a validation error instead of sending a wrong quantity.
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
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
    if (input) input.addEventListener('input', () => this._filterCatalog(input.value));
    const actorSelect = root.querySelector('select[name="actorId"]');
    if (actorSelect) {
      actorSelect.addEventListener('change', () => {
        this._data.selectedActorId = actorSelect.value;
      });
    }
  }

  _filterCatalog(term) {
    const query = String(term || '').trim().toLowerCase();
    const root = this.element;
    if (!root) return;
    root.querySelectorAll('.product-card').forEach((card) => {
      const name = card.querySelector('.product-info h3')?.textContent || '';
      const imgAlt = card.querySelector('.product-art img')?.alt || '';
      const hay = `${name} ${imgAlt}`.toLowerCase();
      card.style.display = !query || hay.includes(query) ? '' : 'none';
    });
  }
}

export default MarketStorefront;
