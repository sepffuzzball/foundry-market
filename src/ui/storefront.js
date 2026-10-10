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
      // M5 storefront controls. `add-to-cart`/`add-special-to-cart`/
      // `remove-from-cart` mutate local cart state only; `checkout-cart`,
      // `book-service`, `place-preorder`, `attempt-theft` and `sell-item` send an
      // authenticated advanced request through `_requestAdvanced`.
      'add-to-cart': this._action('_onAddToCart'),
      'add-special-to-cart': this._action('_onAddSpecialToCart'),
      'remove-from-cart': this._action('_onRemoveFromCart'),
      'checkout-cart': this._action('_onCheckoutCart'),
      'book-service': this._action('_onBookService'),
      'place-preorder': this._action('_onPlacePreorder'),
      'attempt-theft': this._action('_onAttemptTheft'),
      'sell-item': this._action('_onSellItem'),
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
    this._pendingAdvancedRequestId = null;
    this._pendingAdvancedType = null;
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
      // `undefined` means "no actor chosen yet"; only the initial auto-select
      // treats that as "pick the first owned actor" (once). An explicit blank/null
      // selection the player makes must stay blank through later re-renders and
      // request the base public catalog.
      selectedActorId: undefined,
      pending: false,
      loading: false,
      feedback: '',
      notice: '',
      error: null,
      // Per-actor social data projected from the catalog response. `merchants`
      // is the PUBLIC merchant projection and `relationship` is the PUBLIC
      // sanitized relationship; both are cleared on actor switch so a stale
      // actor's personalized prices and standing never bleed into a new one.
      merchants: [],
      relationship: null,
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
      // M5 cart state. `cartLines` is the raw `{entryId, quantity, specialId}`
      // list; the display projection is derived in `_prepareContext` (never
      // mutated here). Cleared on actor switch, on successful cart checkout and
      // when a catalog refresh removes an entry's line.
      cartLines: [],
    };
  }

  // ---- context / lifecycle -------------------------------------------------

  _prepareContext() {
    // Derive the public catalog view from `_data` WITHOUT overwriting
    // `_data.inventory`, which M1 tests and purchase/catalog logic read.
    const list = this._catalogEntries();
    const id = this._data.selectedEntryId;
    // Add a safe, display-only `priceLines` array to each entry so the template
    // never needs to interpret a raw price breakdown. The raw `_data.inventory`
    // entries (and their validated `priceBreakdown`) stay untouched.
    const entries = list.map((e) => ({ ...e, priceLines: this._priceLinesFor(e) }));
    const selectedEntry = (id && entries.find((e) => e.id === id)) || null;
    return {
      ...this._data,
      inventory: entries,
      categories: this._catalogCategories(),
      selectedEntry,
      // The raw `_data.relationship` is the sanitized server projection; augment
      // it with the display `modifierText` and never expose a private record.
      relationship: this._prepareRelationship(),
      merchants: this._data.merchants || [],
      // M5 storefront derivations. These are display/request-hint projections
      // built fresh each render; `_data.inventory` and `_data.cartLines` stay
      // raw and untouched. `sellItems`/`barterItems` read the locally selected
      // OWNED Actor's embedded Items (never the private store), `cartLines`/
      // `cartTotal` come from the sanitized catalog + shop specials (the
      // personalized `shop.specials[].price` when a character is selected), and
      // the preorder/theft selects expose only eligible entries. `cartEstimate`
      // is true when NO character is selected, so the cart totals are a base
      // (non-personalized) estimate and checkout is disabled - the template
      // annotates it rather than presenting the total as a firm quote.
      cartLines: this._cartDisplay(),
      cartTotal: this._cartTotal(),
      cartEstimate: !this._data.selectedActorId,
      sellItems: this._sellableItems(),
      barterItems: this._sellableItems(),
      // `sellEmpty` is true only when a character IS selected but the GM has not
      // approved a valuation for any whole item on it, so the template can show a
      // helpful "ask the GM" message rather than an unexplained empty dropdown.
      sellEmpty: !!this._data.selectedActorId && this._sellableItems().length === 0,
      preorderEntries: (this._data.inventory || []).filter((e) => e.canPreorder),
      theftEntries: (this._data.inventory || []).filter((e) => e.canAttemptTheft),
    };
  }

  /**
   * Build the player-facing relationship view. Adds a human-readable
   * `modifierText` derived from the band title / a catalog quote. Returns null
   * when no relationship was supplied (non-personalized catalog).
   */
  _prepareRelationship() {
    const rel = this._data.relationship;
    if (!rel) return null;
    return {
      ...rel,
      modifierText: this._relationshipModifierText(rel),
    };
  }

  /**
   * Derive a short, non-mechanical description of how the player's standing
   * affects prices. Reads the reputation basis-point modifier from a catalog
   * quote (the same validated price breakdown already sent to the player) so it
   * never claims a number it did not measure; falls back to a neutral phrase when
   * the quote carries no reputation adjustment.
   */
  _relationshipModifierText(rel) {
    const title = rel?.title || '';
    let repBps = null;
    for (const e of this._data.inventory || []) {
      const pd = e?.priceBreakdown;
      if (!pd || typeof pd.reputationBps !== 'number') continue;
      // Prefer the quote whose band title matches this relationship; otherwise
      // keep the most recent reputationBps encountered as a fallback.
      repBps = pd.reputationBps;
      if (pd.band?.title === title) break;
    }
    if (repBps == null || repBps === 0) {
      return title ? `Your standing (${title}) leaves prices unchanged.` : '';
    }
    const pct = repBps / 100;
    const sign = pct > 0 ? '+' : '';
    const verb = pct > 0 ? 'raises' : 'lowers';
    const who = title ? `Your standing (${title})` : 'Your standing';
    return `${who} ${verb} prices by ${sign}${pct}%.`;
  }

  /**
   * Produce a safe `{label, value}` price-line list for a catalog entry from its
   * validated price breakdown. Breaks the raw bps fields into human-readable
   * percentage labels and surfaces the base, per-adjustment and final amounts.
   * Returns an empty array when no breakdown exists (e.g. a non-social quote).
   */
  _priceLinesFor(entry) {
    const pd = entry?.priceBreakdown;
    if (!pd || typeof pd !== 'object') return [];
    const out = [];
    const base = pd.unitBase ?? pd.baseTotal;
    if (typeof base === 'number') out.push({ label: 'Base price', value: String(base) });
    const components = [
      ['Shop', pd.shopBps],
      ['Personality', pd.personalityBps],
      ['Reputation', pd.reputationBps],
      ['Haggle', pd.haggleBps],
    ];
    for (const [label, bps] of components) {
      if (typeof bps === 'number' && bps !== 0) {
        out.push({ label: `${label} adjustment`, value: this._bpsLabel(bps) });
      }
    }
    if (typeof pd.adjustmentBps === 'number') {
      out.push({ label: 'Total adjustment', value: this._bpsLabel(pd.adjustmentBps) });
    }
    const final = pd.unitPrice ?? pd.total;
    if (typeof final === 'number') out.push({ label: 'Final price', value: String(final) });
    return out;
  }

  /**
   * Format a basis-point value as a signed percentage string (e.g. 1500 bps ->
   * '+15%', -500 bps -> '-5%'). Non-finite values render as ''.
   */
  _bpsLabel(bps) {
    if (typeof bps !== 'number' || !Number.isFinite(bps)) return '';
    const pct = bps / 100;
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct}%`;
  }

  async _onRender(event) {
    this._data.hasGM = this._hasActiveGM();
    this._bindControls();
    this._data.actors = this._ownedActors();
    // Auto-select the first owned actor only while no choice has been made yet
    // (`selectedActorId === undefined`). This fires exactly once on the initial
    // render; afterwards an explicit blank/null selection (null) is never
    // overwritten and keeps requesting the base public catalog.
    if (this._data.selectedActorId === undefined && this._data.actors.length) {
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
    // Snapshot the chosen actor BEFORE the re-render below, so the request never
    // reads a stale/auto-selected DOM value from the actor `<select>`. Read only
    // `_data.selectedActorId` (never `_selectedActorId()`/the DOM): an
    // undefined/blank selection normalizes to null, which requests the base
    // public catalog (no personalization, no reputation leak).
    const actorId = this._data.selectedActorId ?? null;
    this._pendingCatalogRequestId = requestId;
    this._data.loading = true;
    this._data.notice = '';
    this.render({ force: true });
    try {
      await this._request({
        type: 'catalog',
        shopId: this._storefrontShopId,
        // Ask for a personalized (per-actor) quote only when an actor is chosen.
        // A null actorId requests the base public catalog instead. The response
        // echoes the same actorId so the storefront can reject a stale response
        // from a previously selected actor.
        actorId,
        requestId,
      });
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
    // A Hated-standing item is flagged `canBuy false` by the server and the
    // template disables the Buy button, but guard the action as well so a
    // programmatic/edge click never sends a doomed purchase.
    const entry = (this._data.inventory || []).find((e) => e.id === entryId);
    if (entry?.canBuy === false) {
      this._data.feedback = 'The shop refuses to serve you at your current standing.';
      this.render({ force: true });
      return;
    }
    if (!this._hasActiveGM()) {
      this._data.feedback = 'A Game Master is not currently connected.';
      this.render({ force: true });
      return;
    }
    const actorId = this._data.selectedActorId;
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

  /**
   * Send an M5 advanced request (cart/service/preorder/theft/sell) through the
   * same request channel as a purchase, sharing the `_data.pending` flag so a
   * player can never fire a second request while one is in flight. Guards on an
   * active GM, a selected actor, an open shop and no pending request, then builds
   * the request with ONLY the server-allowlisted payload fields (never a client
   * `price`/`success`/`roll`), correlates the response by the generated
   * `requestId`, and records the pending advanced id/type so a stale or
   * wrong-actor response can be rejected. The payload is spread verbatim after the
   * correlation fields, so each caller supplies exactly the fields the server
   * allowlists for its request type.
   * @param {string} type one of 'cart' | 'service' | 'preorder' | 'theft' | 'sell'
   * @param {object} [payload] server-allowlisted request body (minus type/requestId)
   * @returns {boolean} true when a request was sent (and pending set)
   */
  _requestAdvanced(type, payload = {}) {
    const actorId = this._data.selectedActorId;
    if (!actorId) {
      this._data.feedback = 'Choose a character to shop as.';
      this.render({ force: true });
      return false;
    }
    if (!this._hasActiveGM()) {
      this._data.feedback = 'A Game Master is not currently connected.';
      this.render({ force: true });
      return false;
    }
    if (!this._data.shop?.open) {
      this._data.feedback = 'The shop is closed.';
      this.render({ force: true });
      return false;
    }
    if (this._data.pending) return false;
    const requestId = newRequestId(type);
    this._pendingAdvancedRequestId = requestId;
    this._pendingAdvancedType = type;
    this._data.pending = true;
    this._data.feedback = '';
    this.render({ force: true });
    this._request({
      type,
      shopId: this._storefrontShopId,
      actorId,
      requestId,
      ...payload,
    }).catch(() => {
      this._data.pending = false;
      this._pendingAdvancedRequestId = null;
      this._pendingAdvancedType = null;
      this._data.feedback = `${this._advancedTypeLabel(type)} request failed to send.`;
      this.render({ force: true });
    });
    return true;
  }

  _advancedTypeLabel(type) {
    const map = { cart: 'Cart', service: 'Service', preorder: 'Preorder', theft: 'Theft', sell: 'Sell' };
    return map[type] || 'Request';
  }

  // ---- chat response correlation -------------------------------------------

  async _onChatMessage(message, options, userId) {
    if (!isMarketResponseFromGM(message, userId, (id) => this._isGM(id))) return;
    const response = message?.flags?.market?.response || {};
    const requestId = response.requestId;
    if (requestId && requestId === this._pendingCatalogRequestId) {
      // Reject a correlated response that was quoted for a DIFFERENT actor (e.g.
      // the GM echoed a stale or forked actorId). A stale requestId is already
      // filtered above, so this is the second correlation guard. `null` matches
      // only the base (non-personalized) catalog.
      if (this._catalogResponseActorMatches(response)) {
        await this._onCatalogResponse(response);
      }
    } else if (requestId && requestId === this._pendingPurchaseRequestId) {
      await this._onPurchaseResponse(response);
    } else if (requestId && requestId === this._pendingAdvancedRequestId) {
      // An advanced response must be correlated on the actor AND the shop id (and
      // is already correlated on requestId above). A response quoted for a
      // different actor or a different shop is discarded so a stale request never
      // mutates the current storefront.
      if (this._advancedResponseMatches(response)) {
        await this._onAdvancedResponse(response);
      }
    }
  }

  /**
   * Correlation guard for an advanced (cart/service/preorder/theft/sell)
   * response. The server echoes the request's `actorId` and `shopId`; both must
   * match the CURRENT selected actor and shop, otherwise the response is stale
   * and ignored (the pending flag stays set until the matching response arrives).
   */
  _advancedResponseMatches(response) {
    const selected = this._data.selectedActorId ?? null;
    const responseActor = response?.actorId ?? null;
    const shopMatch = (response?.shopId ?? null) === this._storefrontShopId;
    return (responseActor ?? null) === selected && shopMatch;
  }

  /**
   * Check that a catalog response was quoted for the currently selected actor.
   * The server echoes the request's `actorId`; a personalized request must come
   * back for the SAME actor or be discarded, and a base (null) response only
   * matches when no actor is selected. A missing echo (`undefined`) normalizes to
   * null so a base catalog still matches.
   */
  _catalogResponseActorMatches(response) {
    // Match against the SAME `_data.selectedActorId` snapshot used to send the
    // request (never the DOM actor `<select>`), so the strict correlation cannot
    // be fooled by a stale DOM value left over from an earlier actor.
    const selected = this._data.selectedActorId ?? null;
    const responseActor = response?.actorId ?? null;
    return (responseActor ?? null) === selected;
  }

  _onCatalogResponse(response) {
    this._pendingCatalogRequestId = null;
    this._data.loading = false;
    // A generalized catalog refresh issued by a GM refresh (or a purchase-triggered
    // refresh) may not carry a selected actor; always accept the public merchant
    // projection and public relationship, but never let private store data leak.
    this._data.merchants = Array.isArray(response.merchants) ? response.merchants : [];
    if (response.type === 'error') {
      this._data.shop = null;
      this._data.inventory = [];
      this._data.relationship = null;
      this._data.error = response.error || 'catalog-error';
      this._data.notice = this._catalogErrorText(response.error);
    } else {
      this._data.shop = response.shop || null;
      // The inventory entries carry the per-actor price quote (`priceBreakdown`,
      // `basePrice`, `canBuy`); store them verbatim so the public catalog view and
      // the later price-line derivation read from the same validated response.
      this._data.inventory = Array.isArray(response.inventory) ? response.inventory : [];
      this._data.relationship = response.relationship || null;
      this._data.error = null;
      this._data.notice = '';
    }
    // A catalog refresh (or an error that emptied the catalog) prunes any cart
    // line whose entry is no longer on display, so a stale line can never be
    // checked out against a missing entry.
    this._pruneCart();
    // Stop any playing loop on a catalog change/error; restart it only if the
    // player explicitly opted in and the new catalog has a valid music path.
    this._syncSound();
    this.render({ force: true });
  }

  /**
   * Drop any cart line whose `entryId` is not present in the current public
   * catalog. Called after every catalog response so a refresh that removes an
   * entry also removes its pending cart line.
   */
  _pruneCart() {
    const present = new Set((this._data.inventory || []).map((e) => e.id));
    this._data.cartLines = (this._data.cartLines || []).filter((l) => present.has(l.entryId));
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

  /**
   * Handle a correlated M5 advanced response. Clears the shared pending flag and
   * the advanced correlation ids, then routes on the echoed `response.type` (or
   * the recorded pending type as a fallback). Feedback is always bounded and
   * truthful: a `booked` service/preorder/theft is reported as booked (never
   * as delivered/fulfilled/resolved), a cart checkout clears the cart only on a
   * committed/replay status, and the catalog is refreshed only after a status that
   * actually moved stock/funds or completed a sale.
   */
  async _onAdvancedResponse(response) {
    const type = response?.type || this._pendingAdvancedType;
    const result = response?.result || { status: 'error' };
    const status = result.status;
    this._data.pending = false;
    this._pendingAdvancedRequestId = null;
    this._pendingAdvancedType = null;
    const clearCart =
      type === 'cart' &&
      (status === 'committed' ||
        (status === 'replay' && result?.originalStatus === 'committed'));
    if (clearCart) this._data.cartLines = [];
    this._data.feedback = this._advancedFeedback(type, result);
    const refresh = this._advancedShouldRefresh(type, result);
    this.render({ force: true });
    if (refresh) this._requestRefresh();
  }

  /**
   * Whether an advanced result is a SUCCESSFUL replay for its type. A replay only
   * means the order reached a terminal success state when its recorded
   * `originalStatus` belongs to the type's success set (cart => committed;
   * service => booked/fulfilled; preorder => booked/fulfilled/cancelled; theft
   * and sell => committed). A replay of an original that persisted `failed`,
   * `needsRecovery` or `pending` is NOT a success and must surface as a recovery
   * failure, never a completed message.
   */
  _isSuccessfulAdvancedReplay(type, result) {
    if (result?.status !== 'replay') return false;
    const original = result?.originalStatus;
    const allowed = {
      cart: ['committed'],
      service: ['booked', 'fulfilled'],
      preorder: ['booked', 'fulfilled', 'cancelled'],
      theft: ['committed'],
      sell: ['committed'],
    }[type];
    return !!allowed && allowed.includes(original);
  }

  _advancedFeedback(type, result) {
    const status = result?.status;
    if (status === 'committed' || status === 'booked' || status === 'fulfilled') {
      if (type === 'cart') return 'Cart checkout complete.';
      if (type === 'service') {
        return status === 'fulfilled' ? 'Service fulfilled.' : 'Service booked.';
      }
      if (type === 'preorder') {
        if (status === 'fulfilled') return 'Preorder fulfilled.';
        if (status === 'booked') return 'Preorder placed.';
        return 'Preorder complete.';
      }
      if (type === 'theft') {
        return status === 'committed' ? 'Theft succeeded!' : 'Theft claim submitted; awaiting the GM.';
      }
      if (type === 'sell') {
        const name = result?.itemName || 'Item';
        const payout = result?.payout;
        const label = this._currencyLabel();
        return typeof payout === 'number'
          ? `Sold ${name} for ${payout} ${label}.`
          : `Sold ${name}.`;
      }
    }
    if (status === 'failed') {
      if (type === 'theft') return 'Theft claim failed.';
    }
    if (status === 'cancelled' && type === 'preorder') return 'Preorder cancelled.';
    if (status === 'replay') {
      if (this._isSuccessfulAdvancedReplay(type, result)) {
        if (type === 'cart') return 'Cart checkout complete.';
        if (type === 'service') {
          return result?.originalStatus === 'fulfilled' ? 'Service fulfilled.' : 'Service booked.';
        }
        if (type === 'preorder') {
          if (result?.originalStatus === 'fulfilled') return 'Preorder fulfilled.';
          if (result?.originalStatus === 'cancelled') return 'Preorder cancelled.';
          return 'Preorder placed.';
        }
        if (type === 'theft') return 'Theft claim submitted; awaiting the GM.';
        if (type === 'sell') {
          const name = result?.itemName || 'Item';
          const payout = result?.payout;
          const label = this._currencyLabel();
          return typeof payout === 'number'
            ? `Sold ${name} for ${payout} ${label}.`
            : `Sold ${name}.`;
        }
      }
      // A replay whose original did not reach a success terminal state (failed /
      // needsRecovery / pending) is a recovery surface, not a completion.
      if (type === 'theft') return 'Theft claim needs recovery.';
      return 'This request is pending recovery; please check the market ledger.';
    }
    if (status === 'conflict') return 'This request was already processed with different contents.';
    if (status === 'needsRecovery') return 'This request is pending recovery; please check the market ledger.';
    return this._advancedErrorText(result);
  }

  _advancedErrorText(result) {
    const map = {
      'insufficient-funds': 'Not enough gold on that character.',
      'insufficient-stock': 'Not enough stock.',
      'shop-closed': 'The shop just closed.',
      'entry-hidden': 'That item is no longer on display.',
      'entry-not-found': 'That item is no longer on display.',
      'entry-restricted': 'You cannot access that item.',
      'actor-not-owned': 'You do not own that character.',
      'actor-not-found': 'Character not found.',
      'adapter-unsupported': 'This system has no price adapter configured.',
      'not-active-gm': 'No active Game Master.',
      'service-refused': 'The shop refused this sale due to your standing.',
      'special-unavailable': 'That offer is no longer available.',
      'item-not-found': 'That item could not be found on your character.',
      'item-not-an-item': 'That is not a valid item.',
      'barter-item-not-found': 'The barter item could not be found on your character.',
      'stacked-item': 'A sold or bartered item must be a single whole item.',
      'no-offer': 'The shop offered nothing for that item.',
      'preorders-disabled': 'Preorders are not enabled at this shop.',
      'theft-disabled': 'Theft is not enabled at this shop.',
      'service-not-found': 'That service is no longer available.',
      'service-disabled': 'That service is not available right now.',
      'server-error': 'The market server hit an error while processing the request.',
      'shop-write-missing': 'The shop vanished while the order was processing, so its effects may need recovery.',
      'gm-approval-required': 'This trade needs a GM-approved price; it is pending until a GM sets the value.',
    };
    return map[result.error] || `Request ${result.status || 'failed'} (${result.error || 'unknown'}).`;
  }

  /**
   * Whether an advanced result should trigger a catalog refresh. Only a status
   * that actually moved stock / funds, completed a sale, or (for a replayed
   * terminal advanced order) may reflect a prior GM resolution should refresh; a
   * fresh theft claim is deliberately a no-op.
   */
  _advancedShouldRefresh(type, result) {
    const status = result?.status;
    if (type === 'cart') {
      return status === 'committed' || this._isSuccessfulAdvancedReplay('cart', result);
    }
    if (type === 'service') {
      return (
        status === 'booked' ||
        status === 'fulfilled' ||
        this._isSuccessfulAdvancedReplay('service', result)
      );
    }
    if (type === 'preorder') {
      return (
        status === 'booked' ||
        status === 'fulfilled' ||
        status === 'cancelled' ||
        this._isSuccessfulAdvancedReplay('preorder', result)
      );
    }
    if (type === 'theft') {
      return status === 'committed' || this._isSuccessfulAdvancedReplay('theft', result);
    }
    if (type === 'sell') {
      return status === 'committed' || this._isSuccessfulAdvancedReplay('sell', result);
    }
    return false;
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
      'service-refused': 'The shop refused this sale due to your standing.',
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
    const id = target?.value ?? target?.dataset?.actorId ?? null;
    const selected = id || null;
    this._data.selectedActorId = selected;
    // Clear the previously quoted per-actor social data (and the stale catalog)
    // so a re-render never shows the previous actor's personalized prices or
    // standing while the new actor's quotes are in flight.
    this._data.relationship = null;
    this._data.merchants = [];
    this._data.inventory = [];
    this._data.selectedEntryId = null;
    // M5: an actor switch also clears the local cart (each actor shops its own
    // basket) and abandons any in-flight request/purchase for the previous actor.
    this._data.cartLines = [];
    this._data.pending = false;
    this._pendingCatalogRequestId = null;
    this._pendingPurchaseRequestId = null;
    this._pendingPurchaseEntryId = null;
    this._pendingAdvancedRequestId = null;
    this._pendingAdvancedType = null;
    this.render({ force: true });
    await this._requestRefresh();
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
      // The actor `<select>` is bound directly (not through `data-action`) so the
      // switch clears the previous actor's personalized catalog and re-quotes.
      actorSelect.addEventListener('change', () => {
        this._onSelectActor(null, actorSelect, {});
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

  // ---- M5 cart / special / service / preorder / theft / sell ------------------

  /**
   * Project the raw `_data.cartLines` to the display shape used by the cart panel.
   * Each line is joined against the sanitized public catalog and the shop specials
   * (never a private price): `name` from the entry, `unitPrice` from the entry
   * price or, for a special line, the offer price, and `total` is the safe
   * unit-price * quantity. A line whose entry is no longer in the catalog is
   * skipped (`_pruneCart` keeps the raw list clean, but this is the display guard).
   */
  _cartDisplay() {
    const inventory = this._data.inventory || [];
    const specials = this._data.shop?.specials || [];
    const byEntry = new Map(inventory.map((e) => [e.id, e]));
    const bySpecial = new Map(specials.map((s) => [s.id, s]));
    const out = [];
    for (const line of this._data.cartLines || []) {
      const entry = byEntry.get(line.entryId);
      if (!entry) continue;
      const special = line.specialId ? bySpecial.get(line.specialId) : null;
      const unitPrice =
        typeof special?.price === 'number' ? special.price : typeof entry.price === 'number' ? entry.price : 0;
      const qty = line.quantity;
      out.push({
        entryId: line.entryId,
        name: entry.name || (special ? special.title : ''),
        quantity: qty,
        unitPrice,
        total: unitPrice * qty,
        specialId: line.specialId || '',
      });
    }
    return out;
  }

  _cartTotal() {
    let total = 0;
    for (const line of this._cartDisplay()) {
      if (Number.isFinite(line.total)) total += line.total;
    }
    return total;
  }

  /**
   * The locally selected OWNED Actor's embedded Items that can be sold or offered
   * as barter. Only an item the GM has approved a buyback valuation for - present
   * in the catalog's `shop.approvedItems` allowlist - is ever offered, and only a
   * WHOLE item qualifies: the server rejects a stacked item (`system.quantity`
   * must be absent or exactly 1), so a stacked item is excluded here too. Never
   * reads the private store, and never exposes a client price (the GM-approved
   * amount is applied server-side).
   */
  _sellableItems() {
    const actor = this._selectedActor();
    if (!actor) return [];
    const approved = this._approvedItemIds();
    const out = [];
    for (const item of this._itemList(actor)) {
      const qty = item?.system?.quantity;
      if (qty != null && qty !== 1) continue;
      // Only an item the GM has approved a valuation for may be sold or bartered.
      if (!approved.has(item.id || item._id)) continue;
      out.push({ id: item.id || item._id, name: item.name });
    }
    return out;
  }

  /**
   * The set of `itemId`s the current catalog allows for sell/barter. This is the
   * public `shop.approvedItems` allowlist (each `{itemId, amount}` projected by
   * the server for the selected actor), never a raw valuation or a client price.
   * A missing/invalid `approvedItems` list yields an empty set, so nothing is
   * offered until a GM has approved at least one item.
   */
  _approvedItemIds() {
    const list = this._data.shop?.approvedItems || [];
    if (!Array.isArray(list)) return new Set();
    return new Set(list.map((a) => a?.itemId).filter((id) => id != null));
  }

  _selectedActor() {
    const actorId = this._data.selectedActorId;
    if (!actorId) return null;
    if (typeof this._deps.getActor === 'function') return this._deps.getActor(actorId) || null;
    const list = game?.actors;
    if (list && typeof list.get === 'function') return list.get(actorId) || null;
    return null;
  }

  _itemList(actor) {
    const items = actor?.items;
    if (!items) return [];
    if (typeof items.values === 'function') return Array.from(items.values());
    if (Array.isArray(items)) return items;
    if (typeof items[Symbol.iterator] === 'function') return Array.from(items);
    return [];
  }

  /**
   * `add-to-cart` on a catalog card. Adds the entry at the player's current
   * quantity to the local cart (merging with an identical non-special line),
   * never sending a request (price is decided server-side at checkout).
   */
  async _onAddToCart(event, target, data) {
    const entryId = target?.dataset?.entryId || data?.dataset?.entryId;
    if (!entryId) return;
    const entry = (this._data.inventory || []).find((e) => e.id === entryId);
    if (!entry) {
      this._data.feedback = 'That item is no longer on display.';
      this.render({ force: true });
      return;
    }
    if (entry.available === false) {
      this._data.feedback = 'That item is currently out of stock.';
      this.render({ force: true });
      return;
    }
    const quantity = this._readCartQuantity();
    if (quantity == null) {
      this._data.feedback = 'Cart quantity must be a whole number between 1 and 100.';
      this.render({ force: true });
      return;
    }
    if (!this._mergeCartLine(entryId, '', quantity)) {
      this._data.feedback = 'Your cart is full (up to 20 distinct items).';
      this.render({ force: true });
      return;
    }
    this._data.feedback = '';
    this.render({ force: true });
  }

  /**
   * `add-special-to-cart` on a special offer card. Resolves the offer to its
   * reference inventory entry (the special must match a visible catalog entry),
   * then adds the line at the player's quantity with the `specialId` so the
   * server can quote the offer price.
   */
  async _onAddSpecialToCart(event, target, data) {
    const specialId = target?.dataset?.specialId || data?.dataset?.specialId;
    if (!specialId) return;
    const special = (this._data.shop?.specials || []).find((s) => s.id === specialId);
    if (!special) {
      this._data.feedback = 'That offer is no longer available.';
      this.render({ force: true });
      return;
    }
    const entry = (this._data.inventory || []).find((e) => e.id === special.entryId);
    if (!entry || entry.visible === false) {
      this._data.feedback = 'That offer is no longer available.';
      this.render({ force: true });
      return;
    }
    const quantity = this._readCartQuantity();
    if (quantity == null) {
      this._data.feedback = 'Cart quantity must be a whole number between 1 and 100.';
      this.render({ force: true });
      return;
    }
    if (!this._mergeCartLine(entry.id, special.id, quantity)) {
      this._data.feedback = 'Your cart is full (up to 20 distinct items).';
      this.render({ force: true });
      return;
    }
    this._data.feedback = '';
    this.render({ force: true });
  }

  /**
   * `remove-from-cart`. Removes the single line addressed by its entry id,
   * leaving every other line intact. Because a cart line is uniquely keyed by
   * `entryId` (a `specialId` only refines that single entry's price), removal is
   * by `entryId` alone and ignores any `specialId`.
   */
  async _onRemoveFromCart(event, target, data) {
    const entryId = target?.dataset?.entryId || data?.dataset?.entryId;
    if (!entryId) return;
    this._data.cartLines = (this._data.cartLines || []).filter((l) => l.entryId !== entryId);
    this._data.feedback = '';
    this.render({ force: true });
  }

  /**
   * `checkout-cart`. Sends the local cart lines (mapped to the server-allowlisted
   * `{entryId, quantity, specialId}` shape, never a client price) plus an optional
   * barter tender. The cart is cleared only on a committed/replay reply, never
   * optimistically before the GM confirms.
   */
  async _onCheckoutCart(event, target, data) {
    const lines = this._data.cartLines || [];
    if (!lines.length) {
      this._data.feedback = 'Your cart is empty.';
      this.render({ force: true });
      return;
    }
    const barterItemId = (this._readField('barterItemId') || '').trim();
    const payload = {
      lines: lines.map((l) => ({ entryId: l.entryId, quantity: l.quantity, specialId: l.specialId || '' })),
    };
    if (barterItemId) payload.barterItemId = barterItemId;
    this._requestAdvanced('cart', payload);
  }

  /**
   * `book-service`. Requests to book a shop service; the GM authoritatively
   * debits the player and the service stays `booked` until the GM fulfills it.
   */
  async _onBookService(event, target, data) {
    const serviceId = target?.dataset?.serviceId || data?.dataset?.serviceId;
    if (!serviceId) return;
    this._requestAdvanced('service', { serviceId });
  }

  /**
   * `place-preorder`. Preorder entry comes from the card's `data-entry-id` or the
   * `preorderEntryId` select. The selected entry must be preorder-eligible.
   */
  async _onPlacePreorder(event, target, data) {
    const entryId = target?.dataset?.entryId || this._readField('preorderEntryId') || data?.dataset?.entryId;
    if (!entryId) {
      this._data.feedback = 'Choose an item to preorder.';
      this.render({ force: true });
      return;
    }
    const entry = (this._data.inventory || []).find((e) => e.id === entryId);
    if (!entry || !entry.canPreorder) {
      this._data.feedback = 'That item cannot be preordered right now.';
      this.render({ force: true });
      return;
    }
    const quantity = this._readQuantity();
    if (quantity == null) {
      this._data.feedback = 'Quantity must be a positive whole number.';
      this.render({ force: true });
      return;
    }
    this._requestAdvanced('preorder', { entryId, quantity });
  }

  /**
   * `attempt-theft`. Theft entry comes from the card's `data-entry-id` or the
   * `theftEntryId` select. The selected entry must be theft-eligible, and only a
   * claim is sent - never a client-supplied outcome.
   */
  async _onAttemptTheft(event, target, data) {
    const entryId = target?.dataset?.entryId || this._readField('theftEntryId') || data?.dataset?.entryId;
    if (!entryId) {
      this._data.feedback = 'Choose an item to attempt.';
      this.render({ force: true });
      return;
    }
    const entry = (this._data.inventory || []).find((e) => e.id === entryId);
    if (!entry || !entry.canAttemptTheft) {
      this._data.feedback = 'That item cannot be stolen right now.';
      this.render({ force: true });
      return;
    }
    this._requestAdvanced('theft', { entryId });
  }

  /**
   * `sell-item`. Reads the selected owned Item id from the `sellItemId` select and
   * asks the GM to buy back one whole item.
   */
  async _onSellItem(event, target, data) {
    const itemId = (this._readField('sellItemId') || '').trim();
    if (!itemId) {
      this._data.feedback = 'Choose an item to sell.';
      this.render({ force: true });
      return;
    }
    this._requestAdvanced('sell', { itemId });
  }

  /**
   * Merge a cart line for `entryId`/`specialId` at `quantity`. A cart line is
   * uniquely identified by its `entryId` - at most one line may ever carry a given
   * entry, regardless of `specialId`. Adding a line for an entry that is already in
   * the cart updates that existing line: its `specialId` is replaced by the
   * incoming `specialId` (an empty string resets it to a regular line) and its
   * quantity is raised by `quantity`, capped at 100. A brand-new distinct entry is
   * only added while fewer than 20 lines are present. Returns false when the cart
   * is full for a new distinct entry.
   */
  _mergeCartLine(entryId, specialId, quantity) {
    const lines = this._data.cartLines || (this._data.cartLines = []);
    const existing = lines.find((l) => l.entryId === entryId);
    if (existing) {
      existing.specialId = specialId || '';
      existing.quantity = Math.min(100, existing.quantity + quantity);
      return true;
    }
    if (lines.length >= 20) return false;
    lines.push({ entryId, quantity, specialId: specialId || '' });
    return true;
  }

  /**
   * A cart quantity is a positive safe integer in 1..100, read through the same
   * live-field/bound-state path as a purchase but capped at the cart maximum.
   * Returns null on an out-of-range/blank-invalid value so the caller can surface
   * validation feedback instead of silently sending a wrong quantity.
   */
  _readCartQuantity() {
    const n = this._readQuantity();
    if (n == null) return null;
    return n <= 100 ? n : null;
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
