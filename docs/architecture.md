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
  `openManager()`, `openShop(shopId)`, `placeShop(shopId)`, and
  `registerTheme(metadata)`.

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
- Shop: `id, name, locationId, description, theme, owner, open,
  appearance {}, inventory[], createdAt`. The `appearance` object (M2) carries
  only validated styling fields - `backgroundImage`, `ownerPortrait`,
  `accentColor`, `typography`, `density`, `animation`, `music`, `soundEffect`
  and `welcomeMessage` - and is always normalized to documented defaults before
  persistence. M3 adds a `npcs[]` array (at most three NPCs, the first being
  the primary owner) and a `social` object (personality weights, party id,
  shop markup and auto-purchase settings) to every shop.
- Inventory entry: `id, itemUuid, snapshot, name, img, quantity, stockMode
  ('finite'|'unlimited'|'non-restocking'), price (non-negative integer minor
  units), visible, publicDescription, category, rarity`. `itemUuid` may be empty
  when the entry is backed by a snapshot alone, and `snapshot` is the serialized
  item data used as a delivery fallback when the `itemUuid` is absent or deleted.
  The public-facing `publicDescription`/`category`/`rarity` fields are empty by
  default (the item's internal system description is never auto-exposed); the GM
  fills them in the manager inventory row.
- Ledger: `id, key, status, payloadHash, userId, shopId, entryId, actorId,
  quantity, unitPrice, totalPrice, priceBreakdown, payload, outcome, error,
  compensation, createdAt, updatedAt`. `priceBreakdown` is the validated
  social-pricing breakdown from a social purchase (or `null` on the legacy
  non-social path) and is also mirrored into the stored `outcome`.

All integer fields (prices, quantities, balances) are validated as non-negative
safe integers, and integer overflow of quotes and currency conversions is
detected rather than silently wrapping. No floats are ever produced in the
ledger. A dnd5e item price may be a finite fractional `value` (e.g. `0.1` gp)
and is converted to copper only when it is exactly representable (`0.1` gp ->
`10` cp); sub-copper values (`0.005` gp = `0.5` cp) are rejected.

## Social data layer (M3)

M3 adds the social data model and the **pure** reputation/pricing engine, and
wires it into the authoritative catalog and purchase pricing. `quoteSocial` is a
standalone pure function used by both the catalog and the purchase path; once
the runtime supplies a reputation service the purchase path quotes through
`quoteSocial` (instead of the M1/M2 integer `quote`) and refuses a Hated
reputation, while an un-wired runtime keeps the original M1/M2 quote path
byte-for-byte. M2 shop shape is preserved and `SCHEMA_VERSION` stays `1` - the
additions are backward-compatible fields, so there is no schema migration.

### NPC and social schema

`src/services/model.js` now normalizes two new shop fields:

- `shop.npcs` - an array of at most `MAX_SHOP_NPCS` (3) NPCs, each
  `{ id, name, role, actorUuid, portrait, greeting, personality, visible }`.
  `name` is required; `role`/`actorUuid`/`greeting` default to `''`, `portrait`
  is validated by the same strict local media-path rules as the shop
  appearance, `personality` falls back to `'honest'`, and extra NPCs beyond 3
  are dropped.
- `shop.social` - `{ primaryPersonality, secondaryPersonality, secondaryWeight,
  individualWeight, partyWeight, partyId, shopMarkupBps, autoPurchase }`.
  `primaryPersonality` defaults to `'honest'` and must be one of the ten ids;
  `secondaryPersonality` is `''` or one of the ten; `secondaryWeight` is an
  integer in [0, 100]. `individualWeight` and `partyWeight` are integers in
  [0, 100] that **must sum to 100** when both are supplied (if only one is
  supplied the other is derived as `100 - it`), so the split is always a strict
  percent. `partyId` is empty by default, `shopMarkupBps` is bounded to
  [-9000, 50000], and `autoPurchase` is
  `{ enabled, minimumSpend, cooldownSeconds, delta }` with non-negative safe
  integer fields and `delta >= 1`.

The legacy `owner` string is preserved. On a legacy shop (no `npcs` field) the
primary NPC is created from the existing `owner` string; the returned `owner`
string is kept synchronized from the first NPC, and an owner change made through
the manager's legacy owner field is applied to the primary NPC so no existing
owner edit is lost.

The primary (owner) NPC id on a legacy shop is **deterministic**, derived from the
stable shop id as `owner-<shopId>`, not regenerated on every read. `normalizeShop`
generates (or retains) the shop id once and threads it into NPC resolution, so
re-normalizing the same shop always yields the same primary NPC id, and changing
the owner name keeps that id stable (only the `name` changes). A new shop whose
`owner` is missing or empty has **zero** NPCs; the primary owner NPC is created
only once the GM specifies an owner. `store.updateShop` follows the same owner
sync: when a caller patches `npcs` without an explicit `owner`, the owner is
derived from the new primary NPC's name **before** normalization (so a
primary-NPC rename through the store API is never overwritten by a stale
persisted owner), an explicit `owner` always wins, and a non-array `npcs` patch
is rejected.

### Personalities

`src/social/personalities.js` defines ten fixed presets
(`honest`, `greedy`, `generous`, `helpful`, `suspicious`, `scornful`, `proud`,
`desperate`, `shrewd`, `eccentric`), each with a `label`, `description`, integer
mechanics (`markupBps`, `haggleDifficulty`, `deceptionPenalty`, `repeatBonus`)
and at least two `greetings`. The mechanical numbers are deliberately distinct
across presets. `getPersonality(id)` never throws and falls back to `honest`;
`isValidPersonality(id)` rejects unknown and prototype-chain names;
`effectivePersonality(primary, secondary?, secondaryWeight)` blends the four
mechanics between a primary and optional secondary personality as
`round((a * (100 - w) + b * w) / 100)` (weighted, rounded to the nearest
integer), returning the primary's identity metadata and exact mechanics when
there is no secondary or the weight is 0.

### Reputation tiers

`src/social/reputation.js` defines an ordered band table of eleven
thresholds from -100 (Hated) to 100 (Loved), each carrying a basis-point price
modifier and a `refused` flag (only Hated refuses). The default modifiers are:
Hated (refused, +4000), Despised (+3500), Hostile (+2500), Distrusted (+1500),
Disliked (+1000), Neutral (0), Friendly (-500), Trusted (-750), Liked (-1000),
Admired (-1250), and Loved (-1500) - worse reputation surcharges more, better
reputation discounts more, and the band table is strictly monotonic.
`clampReputation` clamps a
score to [-100, 100] (non-finite collapses to 0); `reputationBand` maps a score
to the highest matching band; `effectiveReputation(individual, party, { individualWeight, partyWeight, partyId })` blends an individual and a party
score as `round((individual * individualWeight + party * partyWeight) /
(individualWeight + partyWeight))`, is 100% individual when `partyId` is empty,
and treats a missing record as 0.

### Social pricing engine

`src/social/pricing.js` exposes `quoteSocial(entry, quantity, { shop, scores,
haggleBps })`. The price order is: base item price (`entry.price`) -> additive
shop/personality/reputation/haggle basis points **once** (no compounding)
-> integer unit rounding **up** at the minor unit -> quantity. All integer math
uses BigInt intermediates so it is lossless, a free base stays 0, a positive
base is never rounded below 1 minor unit, and the final total is checked against
`Number.MAX_SAFE_INTEGER`. Each bps component is bounded to [-9000, 50000], but
because the four are summed additively the combined `adjustmentBps` is validated
against the full envelope [-36000, 200000] (4 x -9000 up to 4 x 50000) and
retains the actual raw sum for a transparent breakdown. For a combined discount
of 100% or more (`adjustmentBps <= -10000`) the price factor is clamped to zero
before the min-1 rounding, so a positive base is never priced at zero or
negative, while a free base stays 0. The returned object carries `unitBase`,
`quantity`, `baseTotal`, the four individual `*Bps` values, `adjustmentBps`,
`unitPrice`, `total`, `band: { title, threshold }` and `refused` (true only for a
Hated reputation, which reports a refusal rather than throwing).

### GM reputation persistence & service

`src/storage/store.js` and `src/social/service.js` add GM-owned reputation
persistence and **manual** GM adjustment. The runtime wires the service into the
catalog and purchase paths (see Requests and Purchase transaction), and the
GM-only API wrapper (see API surface) is exposed from `src/core/main.js`.

**Record kinds.** Two new record kinds are added alongside `location`/`shop`/
`ledger`, both stored in their **own** GM-only `JournalEntry` (created with
`ownership: { default: 0 }`, so players never see them), with **no** schema
version bump (`SCHEMA_VERSION` stays `1`):

- `reputation` - `{ id, shopId, scope: 'actor'|'party'|'faction', subjectId,
  score, updatedAt }`. Keyed by the `(shopId, scope, subjectId)` triple; the
  score is a signed integer clamped into [-100, 100].
- `reputationEvent` - `{ id, key, shopId, scope, subjectId, previous, delta,
  next, reason (<= 200), source: 'gm'|'purchase'|'haggle', status:
  'pending'|'committed'|'needsRecovery', createdAt }`. One event per change;
  events are never embedded in a record (no unbounded embedded history).

**Validation.** `shopId`/`subjectId` must be non-empty, at most 120 chars, and
free of control characters. An `actor` `subjectId` must be a Foundry world Actor
UUID (`/^Actor\.[A-Za-z0-9]+$/`); a `party`/`faction` `subjectId` must be a safe
non-empty slug id (letters, digits, dot, underscore, hyphen - no path
separators). `delta` must be a signed safe integer.

**Store methods.** `getReputation(shopId, scope, subjectId)`,
`upsertReputation(record)` (upsert by the `(shopId, scope, subjectId)` triple,
preserving the persisted `id` on update), `findReputationEventByKey(key)`,
`createReputationEvent(record)` returning `{ record, created }` (never creates a
second event for an existing key, mirroring `createLedger`),
`updateReputationEvent(id, patch)`, and `listReputationEvents({ shopId, scope,
subjectId })` sorted latest first (`createdAt` descending).

**Service.** `createReputationService({ store, runShopExclusive, isGM, now,
makeId })` exposes:

- `getEffective(shop, actorUuid)` - loads the actor record and, **only when**
  `shop.social.partyId` is non-empty, the party record, then blends them through
  the pure `effectiveReputation` + `reputationBand`. Returns `{ score, band,
  individual, party, partyId }`.
- `adjust({ shopId, scope, subjectId, delta, reason, requestId, source? },
  gmUserId)` - a manual, **GM-only** mutation (source is `gm` only in this
  slice). It validates `isGM(gmUserId)` before any read/write, validates that the
  shop exists, and runs inside `runShopExclusive(shopId, ...)` - the **same**
  per-shop lock purchases and GM manager edits use, so a reputation write can
  never interleave with a purchase or inventory save for that shop.

  The event log provides idempotency and a recovery boundary. The event key is
  `${gmUserId}:${requestId}`. On a fresh request the service persists a
  `pending` event **before** changing the score, then updates the record and
  marks the event `committed`. A matching replay (same shop/scope/subject/delta/
  reason) is idempotent and never reapplies the delta; the same key with a
  different subject/delta/reason is rejected as a `conflict`. Recovery is
  best-effort: a failed record update marks the event `needsRecovery` (leaving
  the old score), a failed commit leaves the event `pending`, and a retry
  resumes a pending / `needsRecovery` event without re-adding the delta. A
  resumed event is only auto-finalized when it is provably safe against the
  **current** score: if the score already equals the event's intended `next`,
  the event is marked committed (the delta was applied earlier); otherwise the
  event's `next` is applied only when the current score still equals its
  `previous` **and** no later committed event has moved this
  (shop, scope, subject) triple. Any other state returns `needsRecovery`
  `score-diverged` **without** writing the record/event, leaving manual GM
  reconciliation. A new event is likewise refused (`needsRecovery`) while any
  pending/needsRecovery event already exists for the same triple, so unsafe
  adjustments never stack. The core does **not** claim transactional atomicity -
  it is an event log plus a score, and the recovery boundary is inspectable on
  the event record.

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
   total. When the runtime supplied `getSocial`, the price is quoted through
   `quoteSocial` from the actor's **live** effective reputation (never a
   client-supplied price), and the validated `priceBreakdown` is persisted on the
   ledger record and echoed in the purchase response. A Hated reputation is
   refused with `error: 'service-refused'` **before** any debit, persisting the
   refusal breakdown. Any social quote error fails closed as
   `error: 'total-overflow'` (a correlated sanitized `server-error` at the
   request layer). Without `getSocial` (legacy/un-wired runtime) the M1 integer
   `quote` is used and `priceBreakdown` stays `null`. The quote must be a safe
   integer, so an overflowed total is recorded as `failed` with
   `error: 'total-overflow'`.
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
PUBLIC_SHOP_FIELDS = [id, name, locationId, description, theme, owner,
                      appearance, open]
PUBLIC_ENTRY_FIELDS = [id, name, img, price, quantity, stockMode, visible,
                       publicDescription, category, rarity]
```

The public shop projection sanitizes the `appearance` object before sending it
(media paths collapse to `''` when invalid, the accent color must be empty or a
strict `#rrggbb`, radio fields fall back to documented defaults, and
`welcomeMessage` is capped), so a player catalog never leaks an invalid or
untrusted styling value. The public `owner` string is synchronized from the
primary (first) NPC, so when that primary is marked `visible: false` the public
owner is blanked (`''`) rather than leaking a hidden NPC's identity; the public
merchant projection likewise only exposes NPCs with `visible !== false`.

No `itemUuid`, no item `system` data, no raw flags are leaked. `snapshot`
(which may carry secret system/GM item data) is deliberately **not** exposed;
it is kept internal as the delivery fallback. A purchase response only ever
returns the safe `{status, ledgerId, error, total, quantity, compensation,
priceBreakdown}` fields - never the raw ledger record (`record`/`existing`/
`expected`) that the commerce layer uses internally. Remote purchase requests
must carry a stable `requestId`; the GM rejects a missing one rather than
auto-generating it.

The catalog handler accepts an optional `request.actorId`. With no actor it
returns the base (non-personalized) public catalog. With an actor, it first
validates the actor exists and is owned by the requester (or a GM) **before**
reading any reputation - an unowned/unknown actor never probes another player's
score or leaks a hidden entry. It then reads the actor's effective reputation,
quotes **visible** entries at quantity 1 through the social engine, and returns
each entry with a personalized `price`, `basePrice`, `priceBreakdown`, and
`canBuy` (false when refused), plus a sanitized `relationship
{score,title,individual,party}` (never a raw reputation record, and never the
private `partyId`, which is only meaningful to the GM running the party ledger).
Private shop `social` config and `actorUuid` are never exposed; the public
merchant projection contains at most three visible NPCs sanitized to
`{name,role,portrait,greeting,personality:{label,hint}}`. Any social quote
failure fails closed as a correlated `server-error` (never a half-personalized
catalog). Responses always echo `requestId`, `shopId`, and `actorId` so a
storefront can reject a response for a stale actor.

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
- `registerTheme(metadata)` - register an additional shop theme in memory. The
  metadata is `{ id, label, blurb, icon, defaultSound? }`; the id must be a
  lower-case slug and is rejected on a duplicate or a prototype-chain name. The
  registered theme is immediately recognized by `getTheme`/`normalizeTheme` and
  appears in the manager theme dropdown and the storefront `theme-<id>` class.
  Purely in-memory: it never writes to the market store, and the supplying module
  must provide the CSS for `theme-<id>` / `.preview-panel.theme-<id>`.
- `reputation` - the runtime reputation service. Exposes `getEffective(shop,
  actorUuid)` (read-only, returns `{score, band, individual, party, partyId}`)
  and `adjust(payload, gmUserId)` (GM-only mutation). `getEffective` is the
  **safest GM-only** read helper: it returns `null` for a non-GM caller
  (`!game.user.isGM`) before any service read, so it can never probe an
  unowned/untrusted actor's private reputation score; public/owned reads go
  through `getReputation`/`quotePrice` instead. The `adjust` wrapper
  rejects a non-GM caller (`!game.user.isGM`) before any read/write and always
  passes `game.user.id` as the acting user - it never trusts a caller-supplied or
  forged GM id. The manual mutation refuses a Hated reputation for the shop.
- `getReputation(shopId, actorId)` - read a single actor's effective reputation
  for a shop. Only callable when the actor is owned by the current user or by a GM
  (a player can never probe another player's actor). This is the sanctioned
  player-facing read path for a personalized reputation; `reputation.getEffective`
  is GM-only.
- `quotePrice(shopId, entryId, actorId, qty)` - quote the social-influenced unit
  and total price for a visible entry for an owned actor, never leaking a hidden
  entry's price.

The UI applications read the module `api` and Foundry globals lazily, so they
also work when opened by a Settings menu entry (`registerMenu`), which
instantiates them without injected dependencies.

## UI (M1/M2)

The UI is wired on top of the core. It is **not** yet verified against a live
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

  M2 additions: the manager edits the shop `appearance` (owner portrait,
  background image, accent color, typography, density, animation, music, sound
  effect, welcome message) and the `theme`, choosing from the theme registry
  (`src/themes/registry.js`). The registry exposes the built-in 8 themes plus a
  safe `registerTheme` surface for external modules (a validated lower-case slug
  id, label/blurb/icon length rules, an optional `defaultSound` sanitized through
  the media-path sanitizer, and rejection of duplicates/prototype names) that
  only updates the in-memory registry - it never mutates a built-in or writes to
  the store, and the supplying module must provide the CSS for `theme-<id>` /
  `.preview-panel.theme-<id>`. `_readShopForm()` returns a normalized
  theme and appearance; appearance validation is strict (media paths and accent
  color) and an invalid form surfaces a notice without writing to the store.
  The manager keeps a separate `_data.draftShop` for raw, unsaved form inputs.
  `preview-appearance`/`save-shop` capture the CURRENT form into the draft, and
  the details/appearance inputs bind to an `editingShop` context that overlays
  the draft over the persisted `selectedShop`, so a re-render never resets the
  GM's in-progress edits; inventory rows stay bound to the persisted
  `selectedShop`. On every `_onRender` the manager also binds `input`/`change`
  listeners to the shop-details/appearance fields only (name, owner, theme,
  description, open and the appearance fields - never the inventory row fields),
  so any edit captures the RAW form into the draft immediately without a
  re-render and invalidates any stale preview. Because `_refreshData` spreads and
  preserves `draftShop`, an inventory-action re-render (open picker, add item,
  edit/remove an inventory row) never resets the GM's unsaved metadata edits. A
  validated `previewShop` (only built after validation
  succeeds, never persisted) uses the normalized appearance and includes the
  current owner/description/open from the form; when a preview is shown,
  `.preview-panel` is styled in JS (`--mk-custom-accent` only for a strict
  `#rrggbb`, `style.backgroundImage` only for a validated local path, any stale
  values cleared on re-render). On `save`, a rejected
  appearance preserves the RAW draft (so the GM can correct the exact bad input)
  and a successful save clears the draft; `reset-preview` clears both the draft
  and the preview, and switching location/shop clears both too. `browse-media`
  opens the official v14 `foundry.applications.apps.FilePicker` (audio for
  music/sound effect, image otherwise) and writes the chosen path into the
  matching input, validating it against the local media-path rules before use. A
  valid picker selection also captures the raw draft (and invalidates any stale
  preview) so the chosen media survives an inventory-action re-render and can be
  saved; an invalid picked path leaves the previous valid input untouched and
  surfaces a notice. The inventory rows expose
  `publicDescription`/`category`/`rarity`, which `_onSaveEntry` reads and
  persists under the same per-shop lock; `_addItemByUuid` defaults these to
  empty (the item's system description is not auto-exposed).

  M3 additions: the manager wires the social settings, merchant (NPC) roster and
  the GM-only reputation editor. `save-social` reads ONLY from `.social-panel`,
  normalizes via `normalizeShopSocial` (the two personality weight fields must
  sum to 100 when both are supplied, the shop markup is a signed basis-point
  integer) and writes a `{social, npcs}` patch under the shared per-shop lock,
  synchronizing the primary (first) NPC's personality to the social primary while
  preserving any unsaved appearance draft. `add-npc` persists a "New merchant"
  immediately under the lock (generated id; owner reassigned) and is capped at
  `MAX_SHOP_NPCS` (three); `save-npcs` reads each `[data-npc-id]` row, validates
  via `normalizeNpc` (an invalid portrait/name surfaces as a notice instead of
  writing), slices to three, and writes `{npcs, owner, social}` with the owner
  string and social primary synced from the first merchant; `remove-npc`
  reassigns the owner to the new primary, syncs `social.primaryPersonality` to
  the promoted first merchant's personality when merchants remain, leaves the
  shop's social primary unchanged when the roster empties, and never deletes the
  shop. The
  reputation editor offers `reputationActors` from `game.actors` (injectable via
  `deps.listActors` for tests), loads the GM-only effective reputation and the
  committed/manual history through the store, and `adjust-reputation` validates a
  non-zero integer delta and a non-empty <=200-character reason before calling
  the GM-only `reputation.adjust` with a fresh idempotency `requestId`.
  Pending/recovery outcomes surface in the notice; a committed one clears it and
  reloads the view.

- **Player Storefront** (`src/ui/storefront.js`, `MarketStorefront`). Requests
  the catalog through `api.request`, correlates the response by `requestId`,
  verifies the response whisper's author is a GM, and never accesses the private
  store. Only actors the current user owns are offered
  (`actor.testUserPermission(game.user, OWNER)`). Purchase is disabled while
  there is no active GM, while a request is pending, or when the shop is closed
  or an entry is out of stock; after a successful purchase the catalog refreshes
  without reopening. A GM preview uses the same request channel.

  M2 additions: the catalog view derives a display-only list in
  `_prepareContext` (without overwriting `_data.inventory`, which the M1
  purchase/catalog flows read) - categories are computed from the visible public
  inventory as All + every distinct non-empty category (a category that only
  appears on a hidden entry is never offered as a filter tab); entries can be
  searched by name/category/rarity/description and sorted by featured (catalog
  order), name or price ascending; and a single entry can be inspected (click or
  Enter/Space on a product card) to show a detail panel that closes with
  `close-detail`. `selectedEntry` is resolved only against the CURRENT derived
  catalog, so it clears when the entry disappears or is hidden. Both the
  product-card and the detail Buy buttons are disabled while a request is
  pending, with no active GM, or for an out-of-stock entry; a closed shop
  already hides the whole catalog. Background music plays only after an explicit
  user toggle (`toggle-sound`), via the documented
  `foundry.audio.AudioHelper.play({src, volume: 0.25, loop: true})`, injected as
  `deps.playSound` for tests; it stops on toggle-off, on app close, and on any
  catalog change/error, and a generation token invalidates any in-flight
  `_startSound` so a stale resolved Sound is stopped rather than leaked as the
  live handle. A one-shot `soundEffect` is attempted on a successful purchase
  only when sound is enabled and the path is valid; it safely handles a
  synchronous Sound return, a Promise, and a synchronous throw (no `.catch` is
  attached to a non-Promise), and playback exceptions surface a readable notice
  without an unhandled rejection and never ride over the socket. The purchase
  quantity is bound to `_data.quantity` (defaults to `'1'`): the quantity input's
  `input`/`change` events update the state without a re-render, the template binds
  `value="{{quantity}}"`, so search/sort/filter/detail re-renders retain the
  player's in-progress quantity, and `_requestPurchase` reads the live field or the
  bound state and validates it as a positive safe integer (rejecting an invalid
  value with feedback rather than silently flooring). Styling is applied
  in JS after render (never inline template interpolation): a CSS variable
  `--mk-custom-accent` is set on the app root only for a strict `#rrggbb` accent
  and cleared on re-render/catalog change, and `hero.style.backgroundImage` is
  set only when the path passes `sanitizeMediaPath`. After the initial render the
  window is positioned to the full viewport (minus a margin) via `setPosition`,
  with a resize handler that is removed on close; no browser Fullscreen API
  permission is requested.

  M3 additions: the storefront requests a personalized catalog.
  `_sendCatalogRequest` snapshots `_data.selectedActorId` (never the actor
  `<select>` DOM) into a local const BEFORE the re-render and sends it as the
  request `actorId` (undefined/blank normalizes to null, which requests the base
  public catalog with no personalization and no reputation leak). The initial
  actor is auto-selected exactly once on open: while no choice has been made
  (`selectedActorId` is `undefined`) the first owned actor is chosen; once the
  player explicitly picks blank/null it stays blank through later re-renders.
  Switching the actor `<select>` routes to `_onSelectActor`, which clears the
  previous actor's relationship, merchant projection, catalog and open detail
  before re-quoting. Responses must match BOTH the awaited `requestId` AND the
  echoed `actorId` (or null), compared against the same `_data.selectedActorId`
  snapshot (never the DOM), so a stale actor's response - even one echoed from a
  stale DOM value - is discarded. `_onCatalogResponse` stores
  only the public `relationship` and `merchants` projections (never private store
  data), and `_prepareContext` derives a display-only `entry.priceLines`
  ({label, value}) from the validated price breakdown (base / per-adjustment /
  final, with basis points formatted as signed percentages) and an augmented
  `relationship.modifierText` from the reputation band or an entry quote. A Hated
  standing is flagged `canBuy false` and both the template Buy buttons and
  `_requestPurchase` reject it; a `service-refused` purchase error maps to a
  readable message. GM reputation adjustments are picked up on the next catalog
  refresh / actor switch, and the storefront never reads the private store.

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

## Known limitations (M1/M2)

- The UI and canvas hooks are wired and Node-tested but not yet verified against
  a live Foundry VTT 14 runtime. The M2 CSS themes and storefront/manager
  interactions are likewise Node-tested only; the `ApplicationV2` action
  dispatch, `FilePicker` and `foundry.audio.AudioHelper.play` calls should be
  re-checked on a real v14 install.
- The themes ship no bundled audio: the `defaultSound` of every registered theme
  is empty, so background music only plays if the GM sets an `appearance.music`
  path and the player toggles sound on.
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
