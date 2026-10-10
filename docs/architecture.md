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
3. Validates: shop exists and is trading, entry exists and `visible`, stock is
   sufficient (skip for `unlimited`), and the actor's wallet covers the quoted
   total. When the runtime passed `getWorldTime`, the trading gate runs
   `isShopTrading(shop, worldTime)` **inside** the existing per-shop lock and
   returns the standard `'shop-closed'` failure when the shop is manually closed,
   outside its hours, or the travelling merchant has not arrived; without
   `getWorldTime` the legacy `shop.open` toggle is used unchanged. The world time
   is always read server-side via `getWorldTime()` - never a client clock - and
   coerce to a safe integer second before it reaches the pure policy. When the runtime supplied `getSocial`, the price is quoted through
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
                      appearance, open, closedReason, marketEvents]
PUBLIC_ENTRY_FIELDS = [id, name, img, price, quantity, stockMode, visible,
                       publicDescription, category, rarity, stockLabel,
                       available]
```

The public shop projection sanitizes the `appearance` object before sending it
(media paths collapse to `''` when invalid, the accent color must be empty or a
strict `#rrggbb`, radio fields fall back to documented defaults, and
`welcomeMessage` is capped), so a player catalog never leaks an invalid or
untrusted styling value. The public `owner` string is synchronized from the
primary (first) NPC, so when that primary is marked `visible: false` the public
owner is blanked (`''`) rather than leaking a hidden NPC's identity; the public
merchant projection likewise only exposes NPCs with `visible !== false`.

M4 adds the trading/presence and stock-display projection to this public surface.
When a valid world time is resolved server-side, `publicShop` computes the
authoritative `open` and `locationId` from `isShopTrading` (which folds in the
manual toggle, business hours and travel presence - so a travel-enabled shop never
falsely reports its base place), emits a sanitized `closedReason`
(`manually-closed` / `outside-hours` / `not-arrived`, or `null` when open) and
projects only the currently-visible active market events as `{id, title,
description}` (never `startAt`/`endAt`/`visible` or the raw event config). Entries
are projected through `stockView`, so a `low`/`hidden` entry exposes `quantity:
null` with only a `stockLabel` and an `available` flag - the real count is never
leaked outside `exact` mode - while an `exact` entry keeps its true `quantity`.
Both catalog variants reuse the same projection helpers. The base catalog and the
personalized catalog each derive `canBuy` from `!quote.refused && available &&
shop.open (projected)`, so a closed shop or an out-of-stock/hidden entry is never
buyable; the personalized `canBuy` also requires the entry to be in stock and the
projected shop to be open. Without a world time the legacy `shop.open`/
`shop.locationId` projection is preserved and `marketEvents` is an empty array -
the raw `automation` config (days/hours, travel, restock, `stockVisibility`,
private event list) is never leaked either way.

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

## Shop automation (M4, in progress)

M4 adds the **declarative shop automation schema**, the **pure** scheduling /
presence / stock-display policies, and now also wires them into the **authoritative
purchase path, both catalog variants and the active-GM runtime tick**. The
automation/hours/travel/stock-visibility fields are backward-compatible additions
(no `SCHEMA_VERSION` bump, stays `1`), and a shop or inventory entry carrying no
automation fields normalizes to the documented defaults so existing records load
unchanged operationally. The runtime is fully opt-in: an un-wired `createCommerce`
without `getWorldTime` keeps the legacy `shop.open` gate byte-for-byte, and a
catalog request without a world time keeps its legacy open/location projection.

### Automation schema (`src/services/model.js`)

`normalizeShop` returns a new `automation` object:

- `hours` - `{ enabled, days: int[0..6], openMinute, closeMinute }`.
  `days` holds at most 7 valid **unique** day indexes (0 = Monday ..... 6 =
  Sunday), `openMinute`/`closeMinute` are 0..1439, and equal values mean a
  full-day opening. Applies only when `enabled` is true.
- `travel` - `{ enabled, locationIds: string[2..10], anchorTime, intervalSeconds,
  lastCycle }`. A travelling merchant schedule. When enabled, `locationIds` must
  hold 2..10 **unique** non-empty local ids (each at most 120 chars);
  `anchorTime` is a signed safe-integer world-time second; `intervalSeconds` is
  3600..31536000; `lastCycle` is -1 .. `Number.MAX_SAFE_INTEGER`.
- `events` - at most `MAX_AUTOMATION_EVENTS` (10) items, each
  `{ id, title (<= 100), description (<= 400), startAt, endAt, visible }` with
  safe-integer times and `endAt > startAt`. The `id` is validated with the same
  market-id rule the schema uses elsewhere (a non-empty string, at most 120
  chars, free of control characters) and is generated when absent; an object or
  oversized/control-bearing id fails closed at GM save. The public projection
  only ever emits a validated scalar string id. Only plain text is stored; the UI
  escapes through Handlebars.
- `diagnostics` - runtime bookkeeping `{ lastRunAt, lastStatus, lastError,
  lastRestocked, lastLocationId }`; it is not part of the decision logic.

Per-entry M4 fields are normalized on the **inventory entry**:

- `restock` - `{ enabled, target, intervalSeconds, anchorTime, lastCycle }`.
  Only meaningful for a `finite` entry; a restock on any other stock mode is
  normalized to `enabled: false`. `target` defaults to the current quantity
  (floored to 1) and is any positive safe integer up to
  `Number.MAX_SAFE_INTEGER` - a GM-edited quantity above the target is kept, and a
  scheduled restock never reduces stock.
- `stockVisibility` - `'exact' | 'low' | 'hidden'`, default `'exact'`.

Validation is strict and fails closed: a malformed nested value (an out-of-range
day/minute/interval, a non-positive event window, an invalid local id, an
inconsistent interval) throws at GM save rather than silently dropping data,
while a shop/entry with no automation fields normalizes to the defaults.

### Automation policies (`src/automation/policy.js`)

`src/automation/policy.js` is a **pure** module (no Foundry globals, Node-importable)
exporting deterministic helpers. Time is expressed as a world-time in seconds on
the game world's own relative clock, where `0` is Monday 00:00 (never the Unix
epoch). Day 0 is Monday and the weekday index is `floor(worldTime / 86400) %
7`; `timeAt(0, 0)` returns `0`. Every helper reads a normalized shop record and
never mutates it:

- `withinHours(shop, time)` - whether the shop is inside its declared hours.
  Windows are `[openMinute, closeMinute)` (inclusive open, exclusive close);
  an equal open/close is a full-day open; an overnight window (open > close) is
  controlled by the **opening day**, which stays open until the next morning's
  close.
- `isShopTrading(shop, time)` - returns `{ open, reason, locationId }` with
  reason `'manually-closed' | 'outside-hours' | 'not-arrived' | 'open'`. This
  combines the manual `open` toggle, hours, and travel presence. Once travel is
  enabled and the merchant has arrived, the reported `locationId` is the travel
  location rotated by cycle through `locationIds` for **every** outcome -
  including `manually-closed` and `outside-hours` - so a travel-enabled shop
  never falsely reports its base place to the public. Before the travel anchor
  the merchant has not arrived, and `not-arrived` is only the outcome when the
  shop is manually open and inside its hours (otherwise `manually-closed` or
  `outside-hours` prevails); before the anchor the `locationId` stays the shop's
  own base id.
- `cycleAt(config, time)` and `dueCycle(config, time)` - `cycleAt` returns 0
  before the anchor and `floor((time - anchor) / interval)` (clamped to the
  non-negative safe-integer range) after it. `dueCycle` returns `null` before the
  anchor or when the current cycle is already `<= lastCycle` (nothing new to
  apply); otherwise it returns the due cycle.
- `stockView(entry)` - the public stock projection. `exact` exposes the true
  count; `low` and `hidden` expose `quantity: null` and only a label, so the
  public catalog never leaks a real count outside exact mode. `low` labels
  `Available` / `Low stock` (threshold <= 3) / `Out of stock`; `hidden` labels
  `Available` / `Out of stock`. An `unlimited` entry is always available.
- `activeMarketEvents(shop, time)` - the visible events whose `[startAt, endAt)`
  window contains the time, sorted by `startAt` ascending.
- `planAutomation(shop, time)` - a pure plan `{ restocks: [{ entryId, cycle,
  target }], travel: { cycle, locationId } | null, activeEvents }`. Every due
  finite restock-enabled entry is reported **even when its quantity is already
  at or above `target`**, carrying the due `cycle` and `target` so the runtime
  can advance `lastCycle` (applying a set-to-target when below, or merely
  advancing without reducing stock when already at/above); each due entry is
  included exactly once (no loops over many elapsed cycles, no mutation, no
  fake increment, and no stock reduction). Travel is reported only when its
  schedule is due; activeEvents is the visible active event list.

### GM-only automation runner (`src/automation/service.js`)

`src/automation/service.js` is the deterministic writer that applies a
`planAutomation` plan to the store. It is a **GM-only scheduled runner**: the
service module itself is hook-free (no timer or game-loop knowledge), while the
runtime wires it to the active GM's `updateWorldTime` tick and the manager's
"Run now" (see `src/core/main.js`). A caller invokes `runAll()` or
`runShop(shopId)` on its own schedule. Because it is still Foundry-free and
Node-importable, it is exercised by pure Node tests against a fake store.

`createAutomationService({ store, runShopExclusive, isActiveGM, now, logger })`
returns `{ runAll, runShop, getDiagnostics }`. The required contract:

- `now()` returns the world-time in whole seconds used for every decision and
  diagnostics timestamp. An invalid value (NaN/undefined/Infinity/non-safe)
  never coerces to week zero: the runner short-circuits **before any store
  read/write** with `{ status: 'error', error: 'invalid-world-time' }` (and
  `runAll()` returns the same error without listing shops), so a bad clock never
  executes a schedule or corrupts the persisted cycle markers.
- `runShopExclusive(shopId, fn)` is the SAME per-shop lock used by commerce
  purchases (and GM manager inventory edits), so an automation restock can never
  interleave with a purchase and clobber its stock decrement.
- `isActiveGM()` is checked **before any store access**. When it is not the active
  GM, `runShop` returns `{ status: 'idle', shopId }`, `runAll` returns
  `{ status: 'idle', summaries: [] }` and `getDiagnostics` returns
  `{ status: 'idle', diagnostics: [] }` - a player watching the app never
  triggers a read.

Behavior:

- An invalid `now()` (NaN/undefined/Infinity/non-safe) causes `runShop` to fail
  before any store read/write with `{ status: 'error', error:
  'invalid-world-time' }` after the active-GM guard, and `runAll()` to return the
  same error without listing shops. No schedule is executed and no cycle marker
  or diagnostics write occurs.
- `runShop(shopId)` re-reads the shop **inside** the per-shop lock, computes
  `planAutomation(shop, now())`, and applies the plan. A shop removed (or never
  present) is skipped with `{ status: 'idle' }`, not failed.
- Restocks are applied by a single set-to-target **without reducing stock**:
  `quantity = Math.max(current, target)` and `restock.lastCycle = cycle`, with
  every other entry field preserved. Each due entry is handled exactly once - no
  catch-up loop, no backward time (a cycle already `<= lastCycle` is not due).
- A due travel plan is applied only after the destination is validated against
  `store.listLocations()`. If the planned `locationId` does not exist, the shop
  fails (error `'travel-location-missing'`) **before** any write: no restock, no
  cycle advancement, only a diagnostics record that preserves the original
  inventory, location and travel cycle markers so the next tick retries.
- A successful run mutates the shop **atomically** via a single
  `store.updateShop(shopId, { inventory, locationId, automation })` and writes
  the fresh diagnostics in the same write. On a thrown `store.updateShop`, the
  service returns an error summary and does not attempt a compensation write
  (no cycle markers were persisted, so the same due cycle is retried).
- When there are no due plans, the service **skips the write** and returns
  `{ status: 'idle', shopId }`, so a periodic tick never writes on every turn.
- `runAll()` lists shops, then processes each independently, sequentially, under
  its own per-shop lock, and returns a bounded list of per-shop summaries.
- `getDiagnostics(shopId?)` has the same GM gate and returns only normalized,
  bounded diagnostics per shop (`lastRunAt, lastStatus, lastError` capped at 200
  chars, `lastRestocked` counted as restocked entries and bounded by inventory
  length, `lastLocationId`) - never the full shop record.
- `lastStatus` is `'ok' | 'error' | 'never'`; a diagnostics-only failure write is
  best-effort and, if that write itself fails, the call returns an error.

### GM-only RollTable inventory generation (`src/automation/tables.js`)

`src/automation/tables.js` is the GM-only service that draws Items from a
world/compendium RollTable and appends them as new inventory entries. It is a
scheduled/editor service: the service module itself carries no timer, no flags,
no socket and no chat, and a caller invokes `generate({ shopId, tableUuid,
count })`. The runtime surfaces it through the manager's GM-only "Roll table
stock" form and the active-GM `api.generateInventory` entry point, not a timer.

`createTableInventoryService({ store, runShopExclusive, isActiveGM, getTable,
resolveResult, getAdapter, makeId, logger })` returns `{ generate }`. The required
contract:

- `isActiveGM()` is checked **before any table or store read**. When it is not the
  active GM, `generate` returns `{ status: 'idle', shopId }` and neither the store
  nor the RollTable is touched - a player watching the app never triggers a read.
- `runShopExclusive(shopId, fn)` is the SAME per-shop lock purchases and GM manager
  edits use, so a generation can never interleave with a purchase and clobber a
  stock decrement.
- `getTable(tableUuid)` resolves only a world/compendium RollTable document. The
  service verifies `table.documentName === 'RollTable'` (or an equivalent safe
  mock) before drawing; a missing or non-RollTable document is refused.
- `table.drawMany(count, { displayChat: false })` is awaited, and only the bounded
  `draws.results` array is consumed - never an unbounded document. The results are
  **capped at 20**, so a misconfigured table can never blow up the read.
- `resolveResult(result)` is injected and MUST verify the source is a world Item
  (`documentCollection === 'Item'`) or a compendium Item pack and return the Item
  document, else `null`. A throw is caught and treated as a skipped item.
- `getAdapter()` returns the system adapter (or null); `adapter.getItemPrice(item)`
  is awaited and coerced to a non-negative safe integer minor unit. An
  unsupported/throwing/negative/unsafe price falls back to **0**, never dropping
  the item - the 0 price is the documented fallback (a warn is logged).
- `makeId()` supplies the entry id; `store.findShop` / `store.updateShop` are the
  only store methods used.

Behavior:

- **Input validation** happens after the GM gate and before any read: `count` must
  be an integer in `1..20` (else `{ status: 'error', error: 'invalid-count' }`) and
  `tableUuid` a non-empty string of at most 200 chars (else
  `{ status: 'error', error: 'invalid-table-uuid' }`).
- **Per-shop flow.** `generate` runs inside `runShopExclusive`, re-reads the shop
  (so a concurrent purchase's stock change is never lost), resolves the table,
  draws, and appends. A shop removed (or never present) is a no-op success
  (`{ status: 'ok', added: 0, skipped: 0, invalid: 0, duplicate: 0 }`) with no
  write and no draw.
- **Result classification.** Only a v14 document result
  (`result.type === 'document'`, i.e. `CONST.TABLE_RESULT_TYPES.DOCUMENT`) is
  usable; any other result (text rows, malformed objects) is counted `invalid`.
  A document result that fails to resolve to a valid Item - `resolveResult`
  returns null or throws, or the resolved doc is not an Item
  (`documentName === 'Item'`, a non-empty `uuid`, and a `toObject()` method) - is
  counted `skipped`. Each result is resolved independently; one bad result never
  fails the draw.
- **Dedupe.** A document result whose Item UUID is already in the current shop
  inventory OR already added within this draw is counted `duplicate` and not
  added, so a re-draw never stacks a duplicate Item.
- **Entry normalization.** Each new entry is built via `normalizeInventoryEntry`
  with `{ id: makeId(), itemUuid: item.uuid, snapshot: JSON.stringify(item.toObject()),
  name: item.name, img: item.img, quantity: 1, stockMode: 'finite', price,
  visible: true }`. The snapshot is the serialized item data (the delivery
  fallback), matching the commerce purchase path.
- **Single write, no overwrite.** When at least one entry was added there is
  exactly ONE `store.updateShop(shopId, { inventory: [...current, ...entries] })`
  that appends to the current inventory. When nothing was added (including a
  successful draw that produced no usable Item) no write occurs.
- **Failure.** A thrown `drawMany` returns
  `{ status: 'error', error: 'table-draw-failed' }` with no write; a missing /
  non-RollTable table returns `{ status: 'error', error: 'table-not-found' }`; a
  thrown `getTable` returns `{ status: 'error', error: 'table-resolve-failed' }`
  and a thrown `store.updateShop` returns
  `{ status: 'error', error: 'shop-write-failed' }`.
- **Bounded return.** A successful `generate` returns only numbers:
  `{ status: 'ok', added, skipped, invalid, duplicate }` - never a raw document.

The generator itself is now wired into the runtime API (`api.generateInventory`),
guarded to the active GM; the GM automation editor UI that would surface a button
for it (and any live Foundry VTT 14 verification of `drawMany`) remains later work.
This slice provides the GM-gated, lock-protected, bounded writer plus the runtime
wiring that drives it.

### Runtime, commerce & catalog wiring (M4)

M4 is no longer schema-and-policy-only: this slice also wires the automation
runner into the runtime and folds trading/presence/stock-visibility into the
authoritative purchase path and both catalog variants.

- **Commerce trading gate (`src/services/commerce.js`).** `createCommerce` gains
  an optional `getWorldTime`. When supplied, `purchase` resolves the time through
  `safeWorldTime` and, only when it is a valid safe-integer second, computes
  `isShopTrading(shop, worldTime)` **inside** the existing per-shop lock (so the
  gate can never interleave with a concurrent purchase for the same shop),
  returning the standard `'shop-closed'` failure when the shop is manually closed,
  outside its hours, or the merchant has not arrived. An invalid server time
  (NaN/undefined/Infinity/non-safe) fails the purchase closed as
  `'invalid-world-time'` **before any debit**, rather than collapsing to week zero
  (Monday 00:00) and silently trading. The world time is read server-side via the
  getter - never a client clock - and floored to a safe integer second only when
  the raw value is finite. Without `getWorldTime` the legacy `shop.open` toggle is
  used byte-for-byte.
- **Catalog/request projection (`src/core/requests.js`).** `publicShop` gains an
  opts `{ worldTime }`: with a valid server-resolved time it projects
  `open`/`locationId` from `isShopTrading`, a sanitized `closedReason`, and the
  visible active `marketEvents` as `{id, title, description}` (the projected `id`
  is always a validated scalar string - an invalid raw event id collapses to `''`);
  without a time it keeps the legacy open/location projection and `marketEvents`
  is `[]`.
  `publicInventoryEntry` / `publicInventory` project each entry through
  `stockView` so `quantity` is null in `low`/`hidden` mode, adding `stockLabel`
  and `available` (an `exact` entry keeps its true quantity). `handleCatalog`
  resolves the world time **once** server-side (via `resolveWorldTime`, accepting
  a `ctx.worldTime` getter or a number): a present-but-invalid time
  (NaN/undefined/Infinity/unsafe) fails closed as a correlated `server-error` with
  no catalog; an absent time keeps the legacy no-time behavior. Both the base and
  personalized catalogs use the same projection helpers and the personalized
  `canBuy` is `!quote.refused && stockView.available && projectedShop.open`.
  Hidden entries remain omitted.
- **Runtime wiring (`src/core/main.js`).** `buildCommerce` supplies
  `getWorldTime: worldTimeNow`, and `buildRequestContext` supplies the same
  `worldTime` getter to the request handlers; `createAutomationService` is passed
  `now: worldTimeNow`. `worldTimeNow` reads `game.time.worldTime` server-side and
  returns `null` when the clock is invalid (NaN/undefined/Infinity/non-safe),
  never `Math.floor`-ing a bad value into NaN/Infinity; every consumer treats a
  null as an invalid world time and fails closed. `init` constructs
  `createAutomationService` **after** commerce, passing
  `runShopExclusive: commerce.runShopExclusive` (the SAME per-shop lock loops a
  purchase uses), `isActiveGM`, `now: worldTimeNow`, and
  `logger: console`. `ready` registers `registerAutomationRuntime()`.
- **Active-GM automation hook (`src/core/main.js`).** `registerAutomationRuntime`
  registers `Hooks.on('updateWorldTime', ...)` and runs one sweep at startup when
  the current user is the active GM. The hook only schedules for the active GM,
  and the service re-checks `isActiveGM()` before any store access. Reentrancy is
  guarded by a single in-flight promise: while a sweep runs, an arriving tick just
  sets a queued follow-up flag that is re-dispatched after the current sweep ends.
  The sweep is not awaited by the request handler, so it never blocks a catalog/
  purchase response; a thrown sweep is caught and logged, never propagated. A GM
  handover is picked up on the next `updateWorldTime` tick (or a reload) - no
  mid-tick recompute is attempted.
- **GM-only API surface (`src/core/main.js`).** `api.automation` exposes
  `runAll`, `runShop(shopId)` and `getDiagnostics(shopId?)`, each guarded on the
  active GM (returning the service's `idle` summary when not). The raw service
  object and the store are NOT exposed - callers only ever receive the bounded
  summaries/diagnostics the service returns.
- **GM-only RollTable inventory surface (`src/core/main.js`).** `init` constructs
  `createTableInventoryService` after commerce, passing `store`,
  `runShopExclusive: commerce.runShopExclusive` (the SAME per-shop lock purchases
  and GM manager edits use), `isActiveGM`, `makeId` and `logger: console`, and
  `api.generateInventory({ shopId, tableUuid, count })` is exposed. The wrapper is
  guarded on THIS user being the active GM (`isActiveGM()`) and rejects a
  non-active-GM caller with `{ status: 'error', error: 'not-active-gm' }` BEFORE
  the resolver or store is touched; it never trusts a caller-supplied GM identity
  and never exposes the raw service. The injected `getTable` resolves the table
  strictly through `fromUuid(tableUuid)` and accepts only a
  `documentName === 'RollTable'` document; the injected `resolveResult` resolves a
  v14 document result only to a world Item
  (`documentCollection === 'Item'` -> `game.items.get(documentId)`) or a compendium
  Item pack (`game.packs.get(collection)` exists and is an Item pack, i.e.
  `pack.documentName === 'Item'` or `pack.documentClass?.documentName === 'Item'`,
  supporting v14 mock class names, then `pack.getDocument(id)` and verifies the
  resolved document is an Item) - never constructing an arbitrary UUID, and
  rejecting other collections and a missing id. `getAdapter` resolves from the
  configured `game.system` with the market settings resolver, and the store is
  read/written only through `store.findShop`/`store.updateShop`.

### GM automation editor UI (M4)

The manager now surfaces the M4 automation editor to the GM - this is the UI slice
that closes the GM automation editor gap. The storefront already renders the
server-projected `closedReason`/`stockLabel`/`available` fields and the public
`marketEvents`; the manager editor is GM-only and reads/writes ONLY through the
private store under the shared per-shop lock, so an automation save can never
interleave with a purchase or a manager inventory edit for the same shop.

**Context derivation (`_prepareContext`).** For the selected shop the manager
derives, fresh on every render:

- `weekdays` - `[{id: 0..6, label, selected}]` from `automation.hours.days` (only
  the bounded schema fields, never a raw day record).
- `travelLocationOptions` - plain `{id, name, selected}` pairs from
  `_data.locations` against the shop's configured travel `locationIds`.
- `eventRows` - a plain copy of each persisted event (`id`, `title`,
  `description`, numeric `startAt`/`endAt`, `visible`), so the number inputs bind
  to the stored world-time seconds, not a locale date string.
- `automationDiagnostics` - only the documented `lastRunAt`/`lastStatus`/
  `lastRestocked`/`lastLocationId`/`lastError` fields, each defensively coerced
  (a malformed persisted value can never crash the render) and `lastRunAt`
  formatted as `YYYY-MM-DD HH:mm`, or `''` when absent.
- `isActiveGM` - the active-GM guard flag (see below).

`drawTables` is populated asynchronously on each refresh by `_listTables()`: tests
inject `deps.listTables`, and the runtime fallback enumerates `game.tables` plus
RollTable compendium packs (`game.packs` where `documentName === 'RollTable'`),
exposing only `{uuid, name}` pairs - never a raw document - so the dropdown never
leaks table internals.

**Hours / travel / events / diagnostics.**

- `save-hours` reads ONLY the `.automation-hours` card (the enabled checkbox, the
  checked `hoursDay` indexes, and the open/close minutes), then re-reads the shop
  inside the lock and normalizes/patches `automation.hours` only - travel, events
  and diagnostics pass through unchanged. An invalid minute surfaces a notice and
  leaves the form (and the shop) untouched.
- `save-travel` reads ONLY the `.automation-travel` card, validates the selected
  destination ids against a FRESH `store.listLocations()` before any write (an
  unknown id is rejected with an "Unknown travel destination" notice), computes the
  schedule identity (`enabled`, ids, anchor, interval) and resets `lastCycle` to
  -1 only when that identity changes - otherwise the running `lastCycle` is
  preserved so a live schedule is never rewound. The shop's own `locationId` is
  never touched, so a travel shop keeps trading at its base location until the
  runner moves it.
- `add-event` appends a default event under the lock (a fresh id, a "New event"
  placard, a 24h window starting at the current valid world time or `0` when the
  clock is unreadable, and `visible: false` so it never appears until the GM
  saves it visible), capped at `MAX_AUTOMATION_EVENTS` (ten).
- `remove-event` drops only the event whose id was clicked; other events,
  diagnostics, travel and hours are carried through unchanged.
- `save-events` reads every `.event-editor-list [data-event-id]` fieldset for its
  title/description/numeric world-time start/end/visibility, drops any row whose
  id is not in the persisted shop's exact event id set (a forged DOM id can
  neither create nor delete a record), and patches `automation.events` only. On a
  validation error it shows the notice and leaves the unsaved form intact (no
  refresh, no write).
- The diagnostics list renders only the projected sanitized fields - a raw
  diagnostics record never reaches the template.

**Per-entry stock visibility + restock (`save-entry`).** `_onSaveEntry` now also
reads `stockVisibility` and the restock controls (`restockEnabled`,
`restockTarget`, `restockAnchorTime`, `restockIntervalSeconds`) ONLY when the row
actually carries them - older fixtures omit them, so the persisted value is
preserved rather than reset to a default. It computes the restock identity and
resets `restock.lastCycle` to -1 only when the identity changes, normalizes the
whole entry via `normalizeInventoryEntry` before writing (an invalid entry
surfaces a notice and no write), and edits only the target row under the lock.

**Run now / Generate inventory.** Both `run-automation` and `generate-inventory`
are gated on the active GM: a non-active GM pressing either button gets the
`ACTIVE_GM_MESSAGE` notice and no store read. The handlers re-check
`_isActiveGM()` before any work, then delegate to `deps.runAutomation` /
`deps.generateInventory` (tests) or the GM-only `api.automation.runShop` /
`api.generateInventory`. The bounded result summary (or error) is shown in the
notice and the data is refreshed - for generation the result counters
(`added`/`skipped`/`invalid`/`duplicate`) are shown and client Item data is never
trusted. `generate-inventory` reads `tableUuid`/`drawCount` from the
`.table-generation` form and validates the count is 1..20 before calling the
service.

**Active-GM guards.** Both the `run-automation` and `generate-inventory` buttons
are rendered `disabled` with `{{#unless isActiveGM}}disabled{{/unless}}`, and the
handlers re-check `_isActiveGM()` before any read/write, matching the runner and
generator's own active-GM gate (so a player watching the app never triggers a
store read). `_isActiveGM()` prefers the injectable `deps.isActiveGM` (tests) and
otherwise requires this user to be both a GM and exactly `game.users.activeGM`.

The live Foundry VTT 14 verification of the automatic `updateWorldTime` sweep and
the real-calendar trading/stock/event projection remain later work; this slice
additionally provides the manager automation editor UI (the final M4 UI gap).
