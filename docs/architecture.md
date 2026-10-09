# Foundry Market - Architecture

This document describes M1 (Milestone 1) of the Foundry Market module: the
marketplace core. M1 is deliberately content-free: no UI, no templates, no
systems dependencies. It provides persistence, a GM-executed purchase
transaction with an idempotent ledger, and system adapters. All later
milestones build on this core.

## Module identity

- `module.json` declares the `market` module, Foundry minimum / verified /
  maximum version `14`, native ES modules (`src/core/main.js`), `socket: false`
  (no raw socket for authenticated requests), and bundles `styles/market.css`.
- `game.modules.get('market').api` is set during `init`. It exposes:
  `store`, `commerce`, `getAdapter(systemId, opts)`, `request(payload)`,
  `openManager()`, `openShop(shopId)`, and `placeShop(shopId)`.

## Storage model

All market data lives in GM-only `JournalEntry` documents, one per record:

- One `JournalEntry` per location.
- One `JournalEntry` per shop.
- One `JournalEntry` per purchase transaction (the ledger).

The payload is stored in module flags under the `market` scope:

```js
{
  schemaVersion: 1,
  kind: 'location' | 'shop' | 'ledger',
  record: { ...normalized record... }
}
```

Because the module owns these journals and creates them as the GM, and because
they are never placed in a player-visible folder or shared, players never see
them in the Journal sidebar. Only the market code reads/writes them. Deleting a
journal (by a GM) is how you remove a location/shop/ledger entry for M1.

`src/storage/store.js` exposes `createStore(docAccess)` plus a default singleton
backed by `game.journal`. Journal creation uses the document class static
`JournalEntry.create` (not the collection `.create`); an injected
collection-style create is accepted by the test harness. `createLedger` returns
`{ record, created }` so a caller can detect whether its idempotency key already
existed (and therefore must never charge). Exported functions: `listLocations`, `createLocation`,
`updateLocation`, `listShops`, `createShop`, `updateShop`, `addInventoryEntry`,
`findShop`, and the ledger helpers `listLedgers`, `findLedgerByKey`,
`createLedger`, `updateLedger`.

Records are normalized before persistence (`src/services/model.js`):

- Location: `id, name, description, theme, createdAt`.
- Shop: `id, name, locationId, description, theme, owner, open, inventory[],
  createdAt`.
- Inventory entry: `id, itemUuid, snapshot, name, img, quantity, stockMode
  ('finite'|'unlimited'|'non-restocking'), price (non-negative integer minor
  units), visible`. `itemUuid` may be empty when the entry is backed by a
  snapshot alone, and `snapshot` is the serialized item data used as a delivery
  fallback when the `itemUuid` is absent or deleted.
- Ledger: `id, key, status, payloadHash, userId, shopId, entryId, actorId,
  quantity, unitPrice, totalPrice, payload, outcome, error, compensation,
  createdAt, updatedAt`.

All integer fields (prices, quantities, balances) are validated as non-negative
safe integers, and integer overflow of quotes and currency conversions is
detected rather than silently wrapping. No floats are ever produced in the
ledger. A dnd5e item price may be a finite fractional `value` (e.g. `0.1` gp)
and is converted to copper only when it is exactly representable (`0.1` gp ->
`10` cp); sub-copper values (`0.005` gp = `0.5` cp) are rejected.

## Identity

- Every recorded object (location, shop, inventory entry, ledger record) gets a
  compact base62 `id` (16 chars) via `makeId()`.
- The **original source item** for an inventory entry is referenced only by
  `itemUuid` (a `Compendium.*`/world UUID). The marketplace never stores the
  item's full `system` data; it resolves the UUID at purchase time with
  `fromUuid()`.
- The **executing GM** is `game.users.activeGM.id`, and only that user's client
  processes requests (see Requests).
- The **purchasing user** is the `userId` passed by the request hook. It is used
  both for the idempotency key and for the actor ownership check.

## Purchase transaction

`commerce.purchase({shopId, entryId, actorId, quantity, requestId}, authenticatedUserId)`
is GM-only (and asserts the authenticated user is a GM). It:

1. Resolves idempotency from the ledger (key `userId:requestId`). A matching
   payload hash replays the recorded outcome; a different payload with the same
   key is rejected as `conflict`. A replay whose record is still `pending`
   surfaces as `pending` (not success), because the original transaction never
   reached a terminal status.
2. Re-reads the shop and the actor - never trusting the request snapshot. The
   item source is resolved from `itemUuid` via `fromUuid()`; if the UUID is
   absent or deleted, it falls back to a valid `snapshot`. If neither resolves
   to valid item data, the purchase is refused rather than guessing.
3. Validates: shop exists and is `open`, entry exists and `visible`, stock is
   sufficient (skip for `unlimited`), and the actor's wallet covers the quoted
   total. The quote must be a safe integer, so an overflowed total is recorded
   as `failed` with `error: 'total-overflow'`.
4. Persists a `pending` ledger record **before** charging.
5. Debits the wallet, delivers the item, decrements stock, then marks the
   ledger `committed`.

A serialized per-shop lock guarantees purchases against the same shop run one
at a time, so stock decrements cannot race. The SAME per-shop lock (`shop` scope)
is shared by GM manager inventory edits (`runShopExclusive(shopId, fn)`), so a
purchase and a manager save/remove/add-item can never interleave and overwrite
each other's inventory.

Cross-GM, the per-shop lock is per-client and does NOT provide atomicity. The
ledger is the only cross-client guard, and it is best-effort rather than a
distributed guarantee. Ledger idempotency is keyed `userId:requestId`. When a
persisted record for that key is found (either at the initial look-up or
returned by `createLedger` when the key already exists) the purchase NEVER
charges: a matching payload replays the recorded outcome (committed -> `replay`,
pending -> `pending` for manual recovery), and a different payload is rejected
as `conflict`.

The fail-closed path relies on `createLedger` reporting `created: false` when
the key already exists in the persisted ledger. `createLedger` is a JournalEntry
read-then-create, NOT a server-side compare-and-swap, so it is not atomic: under
a GM handover or two GM clients processing the same request concurrently, both
can read "no record" before either persists one, and in that window both may
`create` (and therefore both charge), which can oversell stock or double-debit a
wallet. The module degrades by never charging whenever `created: false` is
observed, but the race window itself is a known M1 limitation - the ledger
is a best-effort guard, not a claim of atomicity or distributed correctness. No
cross-client guarantee is claimed.

### Failure / compensation

The core does **not** claim atomicity. Explicit phase flags track which state
changes were actually applied (wallet debited, item delivered, stock
decremented), so compensation undoes exactly what was applied and never
double-compensates. When a later step fails it compensates best-effort:

- If the wallet was debited, it refunds the currency.
- If an item was delivered, it removes the delivered item.
- If stock was decremented, it restores the original quantity.
- If every compensation step succeeds the ledger is `failed`; if any
  compensation step itself fails (including a failed stock restore), the ledger
  is `needsRecovery`.

If the final ledger status write itself fails, the record stays `pending` (from
creation) and is logged, so a later replay surfaces it as `pending` instead of
silently implying success.

A `needsRecovery` record means the transaction may be partially applied and
requires manual (or future automated) reconciliation. The recovery boundary is
stateless and inspectable: read the ledger entry and compare
`currency-refund-failed` / `item-remove-failed` / `stock-restore-failed` markers.

## Adapters

`src/adapters/index.js` exposes `getAdapter(systemId, opts)` and the adapter
classes. An adapter bridges the marketplace's integer minor-unit price to a
system's wallet/item representation:

- `Dnd5eAdapter` - full support. Currency is converted to integer copper
  (`cp/sp/ep/gp/pp`), wallet balance is total copper, and item price is read
  from `item.system.price.value` / `denomination`. A finite fractional `value`
  is converted to copper only when exactly representable (`0.1` gp -> `10` cp);
  sub-copper values are rejected, and all currency conversions detect safe
  integer overflow.
- `GenericAdapter` - configurable fallback. Requires GM-configured dot-paths
  (`walletPath`, `itemPricePath`, optional `itemPriceDenominationPath`,
  `quantityPath`) and a delivery mode (embedded Item creation, or appending to
  a configured array). It reports `supported === false` until configured. It
  rejects reserved path segments (`__proto__`, `constructor`, `prototype`),
  nonnumeric values, and unsafe/non-integer or negative values.
- `DaggerheartAdapter`, `DC20Adapter`, `TwodsixAdapter` - explicitly
  `supported === false` until the GM configures the generic paths. No system
  paths are guessed.

Item delivery always uses the full `item.toObject()` with `_id`, `ownership`,
`folder`, and `sort` stripped, and never mutates the source item.

## Requests (ChatMessage, no socket)

`src/core/requests.js` implements the request channel. Players whisper request
messages to the GM(s); the active GM processes them and whispers a response
back to the requester and all GMs.

- Request and response messages carry `flags.market = { type: 'request' |
  'response', ... }`.
- The handler guards on `game.users.activeGM.id === game.user.id`; only the
  active GM processes.
- The requester is the hook's `userId`, not any sender field inside the payload.
- Responses are allowlisted and public-only:

```
PUBLIC_SHOP_FIELDS = [id, name, locationId, description, theme, open]
PUBLIC_ENTRY_FIELDS = [id, name, img, price, quantity, stockMode, visible]
```

No `itemUuid`, no item `system` data, no raw flags are leaked. `snapshot`
(which may carry secret system/GM item data) is deliberately **not** exposed;
it is kept internal as the delivery fallback. A purchase response only ever
returns the safe `{status, ledgerId, error, total, quantity, compensation}`
fields - never the raw ledger record (`record`/`existing`/`expected`) that the
commerce layer uses internally. Remote purchase requests must carry a stable
`requestId`; the GM rejects a missing one rather than auto-generating it.

Because the channel is ChatMessage plus hooks, there is no raw socket server
and no system/module dependency.

## API surface

`game.modules.get('market').api`:

- `store` - the default store singleton (locations/shops/ledger).
- `commerce` - `{ purchase(...), runShopExclusive(shopId, fn) }`.
- `getAdapter(systemId, opts)` - adapter lookup. Always resolves the world
  settings (`genericWallet` etc.) via `game.settings`, even when requested
  through the settings-menu path which has no injected dependency.
- `request(payload)` - send a market request ChatMessage as the current user.
- `openManager()` - open the GM-only market manager application.
- `openShop(shopId)` - open the storefront for a shop (player or GM preview).
- `placeShop(shopId)` - create a public canvas marker for a shop at the scene
  center. GM-only (consistent with the canvas `dropCanvasData` path); the shop
  must exist, otherwise no marker/journal is created.

The UI applications read the module `api` and Foundry globals lazily, so they
also work when opened by a Settings menu entry (`registerMenu`), which
instantiates them without injected dependencies.

## UI (M1)

The M1 UI is wired on top of the core. It is **not** yet verified against a live
Foundry VTT 14 install - it is unit-tested in Node and uses documented
`ApplicationV2`/`HandlebarsApplicationMixin` hooks.

Both `MarketManager` and `MarketStorefront` are
`HandlebarsApplicationMixin(ApplicationV2)` applications whose static
`DEFAULT_OPTIONS.actions` reference CALLABLE STATIC wrapper functions (built by
a `static _action(method)` helper), not instance methods. Each wrapper uses the
runtime `this` (the live application instance) to delegate to the matching
instance `_on...` method, so an action key never points at an undefined value.
GM text entry uses the native `window.prompt` (no V1 `Dialog.prompt` dependency).
The request/response ChatMessages are created with
`style: CONST.CHAT_MESSAGE_STYLES.OOC` (never the obsolete
`CONST.CHAT_MESSAGE_TYPES.WHISPER`), while keeping the `whisper` recipient list.

- **Market Manager** (`src/ui/manager.js`, `MarketManager`, GM-only). Lists
  locations/shops, edits shop details and inventory, adds items by UUID or a
  searchable world/compendium picker, accepts drag-dropped Items (parsed via
  `TextEditor.getDragEventData`), persists quantity/price/stock mode/visibility,
  removes entries, and can place a canvas marker or open a player preview. All
  mutations go through the private store, and every inventory/meta write
  (`save-shop`, `save-entry`, `delete-entry`, `add-item`) runs inside
  `runShopExclusive(shopId, ...)` - the same per-shop lock purchases use - and
  re-reads the shop so a concurrent purchase's stock change is never lost. It is
  reachable from a Journal sidebar button, a `registerMenu` Settings entry, and
  `api.openManager()`.
- **Player Storefront** (`src/ui/storefront.js`, `MarketStorefront`). Requests
  the catalog through `api.request`, correlates the response by `requestId`,
  verifies the response whisper's author is a GM, and never accesses the private
  store. Only actors the current user owns are offered
  (`actor.testUserPermission(game.user, OWNER)`). Purchase is disabled while
  there is no active GM, while a request is pending, or when the shop is closed
  or an entry is out of stock; after a successful purchase the catalog refreshes
  without reopening. A GM preview uses the same request channel.
- **Canvas markers** (`src/canvas/placements.js`). A draggable shop element sets
  `text/plain` JSON `{"type":"MarketShop","shopId":...}`. On `dropCanvasData`
  only a GM creates a public marker JournalEntry (default OBSERVER) plus a Scene
  Note (`flags.market.shopId`, `icons/svg/shop.svg`, iconSize 48) - no private
  store data is copied. The shop is verified to exist before the public journal
  is created (a deleted shop creates no marker), and if Note creation fails the
  just-created marker journal is removed best-effort. Clicking a marker fires
  `activateNote`, which opens the storefront and returns false to suppress the
  default journal; a stale marker whose shop is gone opens a storefront that
  reports the missing shop. The `dropCanvasData` hook shape should be re-checked
  at runtime. `JournalEntry.create` is used for the marker journal, and
  `api.placeShop` is GM-gated like the drop path.

## Known limitations (M1)

- The UI and canvas hooks are wired and Node-tested but not yet verified against
  a live Foundry VTT 14 runtime.
- `Daggerheart`/`DC20`/`Twodsix` need GM-configured generic paths before they
  report support.
- Generic path updates assume object (not array-index) path segments for the
  wallet and price.
- Compensation is best-effort; a `needsRecovery` ledger entry requires manual
  reconciliation (the data needed is recorded in the entry).
- The ledger uses one JournalEntry per purchase; no compaction or pruning.
- The per-shop lock serializes purchases (and GM manager edits) for the same
  shop **within a client**. Across multiple GM clients the lock is per-client,
  so the ledger is the only cross-client guard - and it is best-effort, not a
  distributed guarantee. `createLedger` reports whether the idempotency key
  already existed, and when it returns `created: false` the purchase never
  charges (replay / pending / conflict). Because `createLedger` is a JournalEntry
  read-then-create rather than a server-side compare-and-swap, a GM handover or
  two GM clients processing the same request concurrently can both see "no
  record" before either persists one and both charge, potentially overselling
  stock or double-debiting a wallet; that race window is a known M1 caveat.
  Reusing a single `requestId` for purchases against **different** shops
  concurrently is supported as a conflict, but the two shops do not share
  atomicity.
- Stock modes `finite` and `non-restocking` both decrement; the difference
  (restock policy) is a later milestone.
