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

### Ledger folder hierarchy (`src/storage/ledger-folders.js`)

The ledger journals are not left loose in the Journal sidebar. A separate,
deliberately Foundry-free module (`src/storage/ledger-folders.js`) maintains a
canonical GM-side folder hierarchy and files each ledger journal according to its
current status. It never touches purchase/ledger persistence - it only moves the
journal's `folder`. The organizer is wired into the default store's doc access,
so the only place it is instantiated is the live runtime; under Node it is
exercised against a fake in-memory folder collection.

The hierarchy is a single root folder `Market Ledgers` with a fixed child per
status. Neither the root nor a child is ever located or reused by name: a folder
is recognized only when it is a `JournalEntry` carrying the exact
`flags.market.ledgerRole` AND the exact parent folder id. An unrelated folder
that happens to be named "Success" or "Market Ledgers" is therefore never reused,
and a duplicate hierarchy can never be created by a name collision.

- `Market Ledgers` (role `ledger-root`) - always the single root, parent null.
- `Success` (role `ledger-success`) - holds `committed` journals.
- `Failure` (role `ledger-failure`) - holds `failed` journals.
- `Pending` (role `ledger-pending`) - holds `pending` journals.
- `Needs Recovery` (role `ledger-needs-recovery`) - holds `needsRecovery` journals.

`createLedgerFolderOrganizer({ folders, FolderClass, isActiveGM, logger })`
returns `{ organize(doc, status), journalFolderId(doc), flush() }`. `organize`
places a journal into the folder matching `status`: it creates the root/child
hierarchy as needed (serialized on a local promise queue so concurrent organizes
can never create a duplicate root), then moves the document. It returns the
target folder id on a successful move, `null` on a no-op (not the active GM, a
non-ledger journal, a failed folder creation, or the journal already in the
correct folder), and throws on an unknown status. Folder creation is scoped
strictly to the active GM, and the predicate is re-checked before every
read/create/move and again after each awaited create, so a GM handover stops a
half-finished placement cleanly.

In addition to the shared folder-create queue, `organize` is serialized **per
journal** (keyed on the journal id, never the object identity): a pending
organize racing a concurrent committed update is resolved in a deterministic
order. Immediately before the move the organizer re-reads the journal's LIVE
persisted status (`flags.market.record.status`, when valid) rather than trusting
the status argument, and recomputes the target folder if the status changed while
the root/child hierarchy was being awaited. The final folder therefore always
matches the latest committed status and can never lag as a stale Pending; a
journal whose status is unknown, or whose `flags.market.kind` is explicitly not
a ledger, is never moved.

The store wires this in as **best-effort and never awaited**: `insertRecord` (for
a `ledger` record only) and `updateLedger` fire the organizer as a detached task
after the flag write, and any folder create/move error is caught and logged so it
can never turn a persisted ledger write into an error or a compensation. The
journal is simply left un-filed, and the ready / handover sweep recovers it.
`flush()` resolves once every queued placement has settled and is used by the
test harness to await the detached organize deterministically.

`defaultDocAccess` builds the organizer lazily on first use with `game.folders`,
`game.folders.documentClass || globalThis.Folder`, an active-GM predicate, and
`console` as the logger, and exposes `organizeLedgerJournal(doc, status)` and
`listLedgerJournals()` (all `game.journal` entries whose `kind === LEDGER_KIND`,
regardless of schema version, so legacy schema-v0 journals are enumerated).
`store.organizeLedgerJournals({ isActiveGM })` is a bounded, never-throwing sweep
that enumerates the ledger-wide journal list (or falls back to the schema-V1-only
list), guards on the active GM before the read and before each organize, skips any
non-ledger / invalid-status / already-filed journal, and counts `moved` /
`failed` / `skipped`. It only ever moves existing ledger journals; it never
deletes one and never touches the marker / shop / reputation / advanced-order
journals that also live in the same collection.

The runtime (`src/core/main.js`) drives this sweep only for the active GM: it
runs one bounded startup sweep at `ready`, and it registers `userConnected` /
`updateUser` hooks that track the previous active-GM id. When the active GM id
CHANGES and becomes THIS client's user, it fires a guarded
`store.organizeLedgerJournals({ isActiveGM })` (fire-and-forget, caught) so a GM
handover re-files any journal the previous GM left behind. No sweep is issued
when the active GM is unchanged or is not this client, the active-GM id is read at
event time (deferred to a microtask so Foundry's computed state has settled), and
in-flight sweeps are coalesced into a single follow-up so a handover storm never
runs duplicate work. A GM who becomes inactive during a deferred `Folder.create`
simply does not move the journal (the organizer re-checks the active-GM predicate
after the awaited create).

### Ledger summary pages (`src/storage/ledger-summary.js`)

In addition to the machine-readable `flags.market.record`, the active GM can read a
plain-text summary of each purchase attempt on the journal itself. A deliberately
Foundry-free module (`src/storage/ledger-summary.js`) renders that summary as escaped
HTML and maintains it as a module-owned `JournalEntryPage` of type `text` under the
fixed name `Purchase summary`, marked with `flags.market.ledgerSummary: true`.

The renderer is pure and never touches `game` or the store: `renderLedgerSummary(record,
{ shopName, actorName, itemName })` returns an HTML string that shows Status, the
attempted Buy (item/actor names and ids), Shop, Quantity, the quoted unit/total in
copper when a quote is known, the reason code and diagnostic detail on a
failure, any compensation, and created/updated timestamps. A quote is "known" for a
pending/committed attempt or when the record carries the `quoteKnown` flag (persisted
for every post-quote failure - `service-refused`, `adapter-unsupported`,
`balance-read-failed`, `insufficient-funds`, `merchant-funds-overflow` - even when the
quoted total is `0 cp`), or via the legacy heuristic of a nonzero unit/total or a
structured `priceBreakdown`; a pre-quote failure such as `shop-not-found` or
`actor-not-found` renders `Not quoted`. The Shop line shows a named shop with its
id once (`Name (shop id)`) and an unnamed shop by its id alone (`(shop id)`), never
duplicated. All dynamic data is clipped
and HTML-escaped, the raw `payload`/`outcome` objects are never dumped, unknown
identifiers fall back to stable ids, and item/shop/actor names are best-effort (resolved
from the store's shop record and the live actors collection, or omitted). The ledger
record now also persists an optional, bounded `detail` string (`LEDGER_DETAIL_MAX` =
500) so a failure carries a diagnostic for the GM; it is never sent to players (the
public purchase projection already strips it).

Persistence is best-effort and never awaited, mirroring the folder arrange. The store
schedules a summary sync after `createLedger`/`updateLedger` (and, in the ready/handover
sweep, for existing journals) and guards on `typeof docAccess.syncLedgerSummary ===
'function'`, so an adapter without the optional method is unaffected. Writes are
serialized **per journal** and each task re-reads the LIVE `flags.market.record`
immediately before rendering, so a queued committed render always wins over a stale
pending snapshot. The page is created when absent and updated ONLY when it is the
module-owned page and the content changed; a GM-added page on the same journal is never
replaced. The active-GM predicate is re-checked before the read and after each await,
and any failure is caught and logged so it can never fail the ledger write or the sweep.

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
- Ledger: `id, key, status, quoteKnown, payloadHash, userId, shopId, entryId,
  actorId, quantity, unitPrice, totalPrice, priceBreakdown, payload, outcome,
  error, detail, compensation, createdAt, updatedAt`. `quoteKnown` is a boolean
  that is `true` whenever a quote was successfully produced - pending, committed,
  and every post-quote failure (`service-refused`, `adapter-unsupported`,
  `balance-read-failed`, `insufficient-funds`, `merchant-funds-overflow`), even
  when the quoted total is `0 cp` (a free/fully-discounted item) - and `false`
  (the default) for pre-quote failures and legacy records that predate the flag.
  `priceBreakdown` is the validated
  social-pricing breakdown from a social purchase (or `null` on the legacy
  non-social path) and is also mirrored into the stored `outcome`. `error` is a
  stable bounded failure code; `detail` is an optional bounded (at most 500
  chars) diagnostic string attached to a failed attempt. Neither is exposed to
  players - `detail` is only used by the GM-only ledger summary - but both are
  persisted so the GM can audit a failure.

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
4. When `shop.commerce.funds` is a finite safe integer, verifies **before** any
   effect that `funds + total` stays a safe integer and refuses an overflow as
   `error: 'merchant-funds-overflow'` (recorded as `failed`, no debit), so a
   dangerous wrap is never silently applied. `null` (legacy) funds stay unlimited
   and no funds patch is ever written.
5. Persists a `pending` ledger record **before** charging.
6. Debits the wallet, delivers the item, then updates the shop in ONE
   `store.updateShop` patch - decrementing finite/non-restocking stock and, when
   funds are finite, gaining `total` (ordinary direct-Buy revenue) in the same
   write - and only then marks the ledger `committed`. When funds are unlimited
   the legacy stock-only behavior is preserved (stock decremented alone, and no
   write at all when stock is also unlimited). A `null` return from the shop
   write is treated as a failure, and a `null` return from the ledger commit is
   never reported as committed.

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
changes were actually applied (wallet debited, item delivered, shop write
attempted), so compensation undoes exactly what was applied and never
double-compensates. When a later step fails it compensates best-effort:

- If the wallet was debited, it refunds the currency.
- If an item was delivered, it removes the delivered item.
- If the shop write was attempted (even a write that applied its patch and then
  threw), the current shop is re-read and compared to the recorded before / after
  entry quantity and funds. A known **no-write** (entry quantity and funds both
  unchanged) records `shop-unwritten` with nothing to undo; a known **complete
  write** (both dimensions confirm the new values) restores exactly the old stock
  and old funds in a **single** `store.updateShop`, leaving unrelated inventory
  entries and commerce fields untouched, and verifies the persisted shop before
  recording `shop-restored` (or `stock-restored` for a legacy unlimited-funds
  shop where only stock changed). A **mixed/unknown** state (e.g. stock changed
  but funds did not, or a value diverged) records `shop-state-mixed` and escalates
  to `needsRecovery` rather than falsely claiming a clean restore.
- If every compensation step succeeds the ledger is `failed`; if any
  compensation step itself fails (including a failed shop restore), the ledger
  is `needsRecovery`.

If the final ledger status write itself fails, the record stays `pending` (from
creation) and is logged, so a later replay surfaces it as `pending` instead of
silently implying success.

A `needsRecovery` record means the transaction may be partially applied and
requires manual (or future automated) reconciliation. The recovery boundary is
stateless and inspectable: read the ledger entry and compare
`currency-refund-failed` / `item-remove-failed` / `stock-restore-failed` (legacy
unlimited-funds shop) and `shop-state-mixed` / `shop-restore-failed` /
`shop-missing` (funds-aware shop) markers.

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

### Dynamic dnd5e currency conversion (M6)

`Dnd5eAdapter` no longer hardcodes the classic copper factors. It accepts an
optional `opts.currencyConfig`, which is either a getter function or a plain
object. Each configured denomination must be `{ conversion: <units per gold
piece> }` (a positive finite decimal; official release-6.0.5 uses cp.conversion
=== 100, sp.conversion === 10, ep.conversion === 2, gp.conversion === 1,
pp.conversion === 0.1). When `opts.currencyConfig` is omitted the adapter reads
the live `CONFIG?.DND5E?.currencies` if present;
`CONFIG.DND5E.currencies[d].conversion` is already UNITS PER GP, so it is passed
through with no reciprocal. If neither an explicit config nor a usable `CONFIG`
is available (for example under Node tests) it falls back to a canonical default
that reproduces the legacy factors exactly:
`{ pp: 0.1, gp: 1, ep: 2, sp: 10, cp: 100 }` UNITS-per-gp.

The config is normalized once per wallet operation into per-denomination copper
factors, computed as an exact BigInt rational `conversion.cp / conversion[d]` -
the number of copper pieces equal to one unit of denomination d. A single
snapshot is used for the duration of one `getBalance` / `debit` / `credit` /
`getItemPrice` call, so a config getter that changes mid-operation cannot
produce a torn read. Normalization fails closed (before any wallet update) on: a
missing `cp`/`gp`, a non-finite or non-positive conversion, a factor that is not
a positive safe integer, a `gp` factor below 1, or a ratio that is not a whole
number of copper (fractional-copper factors are rejected). Every configured
denomination is read and written using its factor - no fixed `cp`/`sp`/`ep`/`gp`/
`pp` constants remain in the adapter - so a custom conversion table (for example
`{ cp: 50, gp: 1 }`) is supported. Unknown denominations carrying a nonzero
balance are rejected (fail closed); unknown zero balances are ignored.
`getBalance` reads the configured denominations, `debit`/`credit` write back a
greedy largest-factor-first breakdown across only the configured denominations,
and `getItemPrice` converts `item.system.price.value` using the factor for
`item.system.price.denomination`, multiplying an exact BigInt decimal-rational
value by the factor and rejecting any fractional copper exactly (with no float
tolerance), as well as safe-integer overflow. All decimal parsing is BigInt-
rational based: `decimalToRational` accepts plain and scientific-notation decimal
strings (`1e-7`, `1.23e+4`) exactly, with a bounded exponent and a capped decimal
scale so an unsafe scale (e.g. `1e200`) fails closed instead of building an
unbounded power of ten.

Two module-level helpers are exported for callers that need the same math:

- `dndCurrencyFactors(config)` - returns the per-denomination copper factors
  (for the canonical default this is `{ cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 }`).
- `formatCopperAsGP(copper, config)` - formats an integer copper amount as an
  exact decimal GP string (`125` with the canonical config -> `"1.25"`; with
  `{ cp: { conversion: 50 }, gp: { conversion: 1 } }` -> `"2.5"`). A ratio that
  cannot be rendered as a terminating decimal (never a clean 2^a * 5^b
  denominator) fails closed rather than truncating.
  All arithmetic is BigInt-based, so no floating-point error is introduced.

The legacy `DENOMINATIONS` and `DENOMINATION_FACTOR` exports are unchanged and
continue to exist for callers that do not go through the adapter.

### Portable import/export backup format (M6) (`src/storage/backup-format.js`)

The market core can be exported to and imported from a **portable backup**: a
single, self-contained, plain-JSON payload that captures every location and
every shop in fully normalized form. `src/storage/backup-format.js` is a pure,
Node-importable module (no Foundry globals, no store writes, no runtime) that
validates and normalizes such a backup and plans a collision-safe import into a
target world. It is deliberately decoupled from `src/storage/store.js` - it does
not read or write any JournalEntry, so it can be exercised entirely under Node
and used as a transport/merge layer.

**v1 format.** A v1 backup is `{ format: 'foundry-market-portable',
formatVersion: 1, locations, shops }`, where `locations` and `shops` are the
normalized store records. `normalizeBackup(raw)` returns a deep-normalized,
plain-object clone in exactly this shape (`{ format, formatVersion, locations,
shops, warnings }`) and never mutates its input.

**GM-private, not player projection.** The backup is written from the full
normalized records - never a `publicShop` projection. Every private field a
player storefront would hide is retained: item `snapshot` data, per-entry
`access` gates, `commerce.valuations` (including the private `actorUuid` and
`fingerprint`), `commerce.funds`, the whole `automation` config (hours, travel,
events, diagnostics) and the restock schedules. Nothing a GM or a player sees in
the public catalog is used as the export basis.

**What is excluded.** Ledger records, reputation records/events and advanced
orders are NOT portable (they are idempotency-keyed runtime state tied to a
player/GM and a world) and are deliberately excluded from the backup. Only
locations and shops ride along. Shop actor references that cross into the world
(NPC `actorUuid`, per-entry access actor lists, specials actor lists and every
valuation's `actorUuid`) are retained as-is and surface a `warnings` entry,
because the import cannot remap a world Actor UUID it does not know - so the GM
is told those may be stale rather than having them silently break.

**Validation.** `normalizeBackup` fails closed with a bounded error (never a
silent drop) on all of:
- an unknown/future format - anything other than `format ===
  'foundry-market-portable'` with `formatVersion === 1`; a `formatVersion > 1`
  is reported as a future version, anything else as unsupported.
- a non-object top level, or a `locations`/`shops` that is not an array.
- more than `MAX_BACKUP_LOCATIONS` (1000) locations or `MAX_BACKUP_SHOPS`
  (1000) shops.
- a serialized UTF-8 payload larger than `MAX_BACKUP_BYTES` (5 MiB) - measured
  on the RAW input BEFORE any deep clone/normalization (so an oversized field a
  normalizer would discard is refused without a costly traversal), and again on
  the canonical normalized output after normalization. The raw-size pre-check
  runs as a single `JSON.stringify` after a manual plain-JSON walk.
- a location or shop that does not normalize (for example a missing `name`).
- duplicate location ids or duplicate shop ids.
- a shop whose `locationId` is empty/absent or references a location not
  present in the backup.
- a travel schedule (`automation.travel.locationIds`) that references a
  location not present in the backup.
- any non-plain JSON: a function, a non-plain object prototype (Date, RegExp,
  class instance), a circular reference, or a BigInt anywhere in the payload.
  The raw walk that enforces this never mutates the caller's objects: cycle
  detection uses an ancestor `WeakSet` plus an explicit path stack (never a
  sentinel property), so a deeply frozen, non-extensible valid input is accepted
  unchanged and no `__marketBackupPath` marker is ever added to a node.

**v0 legacy migration.** `normalizeBackup` also accepts a v0 legacy backup,
`{ version: 0, locations, shops }`, and migrates it to v1 - but only when every
source location/shop actually normalizes through `normalizeLocation` /
`normalizeShop`; an invalid v0 source object rejects the whole backup rather
than being silently coerced. That migration is strictly **portable-format
only**: it rewrites the backup file's own `version: 0` payload into the
`formatVersion: 1` shape and re-normalizes every record through the current
schema on import. It is **not** a JournalEntry schema migration. The module's
own `schemaVersion` stored in `flags.market` (see `SCHEMA_VERSION` in
`src/services/model.js`) stays `1`; the store's default doc access only ever
lists JournalEntry flags whose `schemaVersion === SCHEMA_VERSION`, so a
pre-existing journal carrying an older schema-v0 is **not** auto-migrated by
the backup path - it is simply not enumerated, and the import only ever creates
fresh schema-v1 records via `createJournalEntry`. No existing journal is
rewritten in place.

**Import planning.** `planBackupImport(backup, { existingLocationIds,
existingShopIds, makeId })` consumes a validated backup and returns
`{ locations, shops, warnings }` - deep clones that are safe to write into a NEW
world. Every imported top-level location and shop receives a fresh, distinct id
that avoids `existingLocationIds` and `existingShopIds` and is bounded to the
120-char market-id rule, so a backup can never collide with an existing world
record or with another imported record. Shop `locationId` and
`automation.travel.locationIds` are remapped through the new location ids, and
any embedded `shopId` present on an NPC record is remapped through the new shop
ids. The remap and the id reservation all run through `Map`/`Set` key spaces, so
a source id that collides with a prototype name (`__proto__`, `constructor`) is
an ordinary key and maps correctly. Inventory entry ids are preserved - they are only meaningful within a new
shop, never globally. Stale automation clock state is NOT carried across worlds:
each inventory entry's `restock.lastCycle`, each shop's
`automation.travel.lastCycle` and the whole `automation.diagnostics` block are
reset to their defaults while the automation/restock configuration is retained.
If the injected `makeId` is absent, the module uses the schema default; a
degenerate generator that keeps returning a used id still produces distinct,
bounded ids via a deterministic `<base>_<n>` suffix.

**Import warnings ("report, not silently stale").** `planBackupImport` reports
any inventory entry whose item source depends on a reference that may not
resolve in the target world instead of silently accepting it: an entry carrying
an `itemUuid` is reported because the UUID may be stale cross-world (the
retained `snapshot` is the source secondary reference), and an entry with no
`itemUuid` is reported as relying solely on its embedded snapshot (a live item
reference is unsupported for it). The `warnings` channel is the only place this
surfaces; nothing is written elsewhere.

**Tests.** `tests/backup-format.test.js` covers the v1 happy path, v0->v1
migration and migration rejection, deep-invalid and unknown/future format
rejection, the 1000/1000 caps and the 5 MiB size bound (including an oversized
field the normalizer would discard), duplicate id rejection, missing
shop-location and travel-location references, plain-JSON rejection (functions,
non-plain prototypes, cycles, BigInt), acceptance of a deeply frozen valid
backup with no sentinel property added (v1), the GM-private export contract
(private snapshots, access gates, valuations and automation config are
preserved, never a player projection), source immutability of both
`normalizeBackup` and `planBackupImport`, fresh distinct + collision-safe
import ids, locationId/travel/NPC-shopId remapping, inventory entry id
preservation, automation clock-state reset, and the import source-staleness
warnings.

### GM-only portable backup service (M6) (`src/storage/backup.js`)

`src/storage/backup-format.js` is pure; `src/storage/backup.js` is the
effectful layer that actually reads and writes the store on behalf of a portable
backup. `createBackupService({ store, runShopExclusive, isActiveGM, makeId,
logger })` returns `{ exportPortable, importPortable }`. It is deliberately
GM-only and serialized on a single in-flight client. The runtime (`src/core/main.js`)
builds the service in `init` and exposes it only through the bounded
`api.backup.exportPortable`/`importPortable` wrappers (each active-GM guarded
before delegating; the raw service/store are never exposed), and the GM manager
(`src/ui/manager.js`) owns the in-game backup panel - see the manager actions
section below. The methods are also Node-testable against a real store.

**Export.** `exportPortable()` re-checks `isActiveGM()` immediately before EVERY
store read, then lists every location and shop and runs them through
`normalizeBackup` in the canonical v1 shape, returning `{ status: 'ok', backup,
warnings }`. The active-GM predicate is re-checked between the two reads, so a
handover after the locations read stops before reading shops and reports
`not-active-gm` with no private backup returned; no store read ever happens for a
non-active GM. The backup is GM-private in full normalized form (snapshots,
access gates, valuations, commerce and automation config) - never a
`publicShop` projection. Because the export only ever reads location/shop records,
ledger, reputation and advanced order runtime records never appear in the output.

**Import.** `importPortable(raw, { dryRun = false } = {})`:
- Returns `{ status: 'error', error: 'not-active-gm' }` when the caller is not
  the active GM, before touching the store.
- Rejects a non-object `raw` and any invalid/oversized/out-of-format backup via
  `normalizeBackup` - which runs BEFORE any store access (only the active-GM
  check precedes it) - returning `{ status: 'error', error: 'invalid-backup' }`.
- Reads the existing locations/shops, plans fresh collision-safe ids via
  `planBackupImport`, and preflights every cross-reference (a planned shop must
  reference a planned location, travel locationIds must resolve, NPC `shopId`
  must resolve, and no planned id may collide with an existing record). The
  active-GM predicate is re-checked before EVERY one of these store reads, so a
  handover between the locations read and the shops read stops cleanly without
  the second read and reports `not-active-gm` (nothing has been written). Any
  failure at this stage returns `{ status: 'error', error:
  'import-preflight-failed' }`. No raw exception string ever appears in a result.
  For a DRY RUN this world read/plan/preflight happens separately, OUTSIDE the
  serialized write queue; for a REAL import it happens INSIDE the queue (see
  below) so a queued import can only ever plan against the world a prior import
  already wrote.
- With `dryRun: true` it returns `{ status: 'ok', dryRun: true, counts,
  idMap, warnings }` and writes nothing. The reported `idMap` maps source ids to
  the planned fresh ids and is built from null-prototype objects, so a source id
  such as `__proto__` or `constructor` is a safe own key and survives JSON
  serialization of the dry-run result.
- Otherwise the import is queued on a module-scoped in-flight promise so two
  concurrent imports run one at a time on the active-GM client. Inside that
  serialized run the active-GM predicate is re-checked and the world read, id
  planning and collision preflight run FRESH (never against a stale plan built
  outside the queue), so two concurrent imports can never plan against the same
  pre-write world state and generated ids never collide across them. It then
  creates every location first (sequentially), then every shop (sequentially,
  after all locations), re-checking `isActiveGM()` immediately before each
  create. Each create must return a non-null record carrying the planned id; an
  existing record is never overwritten because every planned id is fresh. A
  create that returns null/mismatched or throws, or a GM handover after at least
  one write, returns `{ status: 'partial', createdLocationIds,
  createdShopIds, error: 'import-partial', warnings }` (with the created-id
  lists bounded to the backup caps) - the records written so far REMAIN; there
  is no automatic rollback. A create that throws/null AFTER persisting is
  detected by re-reading the store (`findShop` for a shop, `listLocations` for a
  location, since the store has no `findLocation`): the active GM is re-checked
  before that recovery re-read, and if the planned id is present it is recorded
  in the partial created-id list, so an outcome never hides a write that actually
  landed. On a handover before that recovery re-read the re-read is skipped and
  the partial result carries an `uncertain create` warning (`"the created record
  may not be reported"`), because the import cannot prove whether the write
  landed - it never falsely claims the record was (or was not) created. A
  handover before any write returns `{ status: 'error', error: 'not-active-gm' }`.
  A fully successful import returns `{ status: 'ok', createdLocationIds,
  createdShopIds, warnings }`.

**Constraints.** No record is ever deleted or dropped (import only ever creates
fresh ids). There is **no complete cross-GM atomicity**: an import is not a
transactional, all-or-nothing operation across GM clients. A mid-import
interruption - a create failure or a GM handover after at least one write -
leaves the partial results visible and reports `import-partial` with the bounded
created-id lists; nothing is auto-rolled back, and a handover before any write
returns `not-active-gm` with nothing written. `runShopExclusive` is accepted for
interface parity but is not used - importing fresh ids never updates an existing
shop, so one-shop locks are irrelevant here.

**Tests.** `tests/backup.test.js` covers the GM gate (no store read when not the
active GM), an export/import roundtrip into an empty world, dry-run planning
with no writes, invalid-input rejection with zero writes (including an
oversized payload), collision-safe remapping with preservation of inventory
entry ids and NPC `shopId`/location remapping, the sequential
createLocations-then-createShops ordering, partial-failure reporting after a
store write with no rollback, GM-handover interruption (partial after a write,
not-active-gm before any write), the GM-private export contract that never
leaks ledger/reputation/advanced order records, and the reviewed import-integrity
behaviors: two concurrent imports planned inside the serialized queue generate
distinct ids (driven with a degenerate id generator), a location or shop create
that persists then throws is reported as partial with the truthful persisted id
(no write is hidden), a preflight store-read failure aborts before any write, a
GM handover at every store-read boundary (after the export/import/dry-run
locations read, no second read is made; before a location/shop recovery re-read,
the re-read is skipped and the partial result carries the "the created record may
not be reported" warning), and the dry-run id map safely handling `__proto__` and
`constructor` source ids as null-prototype keys that survive JSON serialization.
`tests/backup-format.test.js` additionally proves `planBackupImport` remaps
`__proto__` and `constructor` source location/shop ids through safely.

- `GenericAdapter` - configurable fallback. Requires GM-configured dot-paths
  (`walletPath`, `itemPricePath`, optional `itemPriceDenominationPath`,
  `quantityPath`) and a delivery mode (embedded Item creation, or appending to
  a configured array). It reports `supported === false` until configured. It
  rejects reserved path segments (`__proto__`, `constructor`, `prototype`),
  nonnumeric values, and unsafe/non-integer or negative values.
- `DC20Adapter` - full support, source-backed against dc20rpg 0.10.7.0
  (`module/dataModel/actorData.mjs` + `module/dataModel/itemData.mjs`). The
  actor wallet is `system.currency.{cp,sp,gp,pp}`, each a non-negative safe
  integer, converted to integer copper (`cp`) minor units with factors 1/10/100/1000
  (there is no `ep` in DC20). Item price is read from
  `system.price.{value,currency}` (currency defaults to `gp`); the marketplace
  ledger uses `cp` minor units and quantity is set on `system.quantity`.
  `getBalance` totals the wallet as `cp`; `debit`/`credit` validate the amount
  and, before `Actor.update`, re-read the wallet, guard safe-integer arithmetic,
  and write back a greedy largest-factor-first denomination breakdown. A nonzero
  unknown wallet denomination, a negative/fractional/overflow value, or an
  unknown price denomination fails closed. Delivery is the generic embedded
  path (`quantityPath: 'system.quantity'`, `deliveryMode: 'embedded'`).
- `TwodsixAdapter` - full support, source-backed against Twodsix 7.7.0
  (`src/module/data/actors/travellerData.js` + `src/module/data/items/gearData.js`).
  The numeric cash balance is `system.financeValues.cash` ONLY - the
  `system.finances.cash` display string is never read. It must be a non-negative
  safe integer: an actor whose cash is missing, non-numeric, negative,
  fractional or beyond a safe integer fails closed (`balance-read-failed`), with
  no fallback to the display string. Item price is `system.price` (non-negative
  safe integer), credits are the only currency unit with no conversion (price
  maps 1:1 to minor units, denomination `credits`), and quantity is set on
  `system.quantity`. `debit`/`credit` write `system.financeValues.cash` with
  safe-integer guards before `Actor.update`. Delivery is the generic embedded
  path (`quantityPath: 'system.quantity'`, `deliveryMode: 'embedded'`).
- `DaggerheartAdapter` - explicitly `supported === false` until the GM
  configures the generic paths. Daggerheart carries no native item price, so no
  system-specific price path is invented. No paths are guessed.

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
                      appearance, open, closedReason, marketEvents, specials,
                      services, preordersEnabled, theftEnabled, locationName,
                      approvedItems]
PUBLIC_ENTRY_FIELDS = [id, name, img, price, quantity, stockMode, visible,
                       publicDescription, category, rarity, stockLabel,
                       available, specialId, specialPrice, canPreorder,
                       canAttemptTheft]
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

M5 extends this public surface with availability *request hints* - never a raw
commerce config and never an execution outcome. `publicShop` always projects
`services` (the enabled+visible bookable-service projection, each sanitized to
`{id, name, description, price}` with `name`/`description` bounded to the schema
maxima and `price` collapsed to 0 when not a finite non-negative number), plus
`preordersEnabled` and `theftEnabled` read strictly from the validated
`shop.commerce` config. The private merchant `funds`, `buyRateBps`/
`buybackRateBps`, `depositBps`/`maxPerActor` and the per-offer special `actorUuids`
stay internal. Each catalog entry gains `canPreorder` and `canAttemptTheft`
computed by `applyAvailabilityFlags` (in `src/core/requests.js`) from the raw
entry (so the true `access.mode` and `stockMode` are read, since the projection
strips `access`) plus the projected shop state:

- `canPreorder` is true only when preorders are enabled, the entry is public or
  (for a personalized actor) accessible, it is a finite/non-restocking entry
  currently out of stock, the projected shop is open/trading, and (for a
  personalized quote) the social quote is not refused. The base catalog has no
  quote and no actor owner, so only the public + preorder-enabled + open + out-of-
  stock conditions gate it.
- `canAttemptTheft` is true only when theft is enabled, the entry is public
  (never a backroom gate), it is currently in stock, and the projected shop is
  open/trading. Both flags are client-side request permissions; the server remains
  authoritative and only an owned-actor request validates availability.

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

M5 adds the `sell` request. A player whisper of `{type:'sell', shopId, actorId,
itemId, requestId}` asks the active GM's client to sell one whole embedded `Item`
the player owns back to the shop. The handler pre-validates the four required
strings and returns clean correlated errors (`missing-shop-id` /
`missing-actor-id` / `missing-item-id` / `missing-request-id`) rather than leaking
the service's internal `[market] '...' must ...` messages; it then calls the
selling service with the trusted hook `userId` as the requester (never the payload
`userId`). The outcome is projected through `publicSellResult` to only
`{status, error, orderId, payout, buybackEntryId, itemName, originalStatus}` -
never the raw advanced-order record, the idempotency `conflict` / `expected` /
`existing` carrybacks, the order `details` (the item `snapshot`, `payout` /
`fundsBefore`, and the `compensation` markers), or the `outcome`/`compensation`
arrays. `originalStatus` is only ever set on a `replay` response and carries the
recorded order status (allowlisted to the persisted advanced-order statuses), so a
replay of a committed sale is distinguishable from one whose original persisted
`failed`/`pending`/`needsRecovery`. Responses echo `requestId`/`shopId`/`actorId`
like every other request, and a server-side failure fails closed as a correlated
`sell`/`server-error`.

M5 also wires the four advanced order requests - `cart`, `service`, `preorder` and
`theft` - into the same hook. Each handler pre-validates its required fields and
returns clean correlated errors (`missing-shop-id`, `missing-actor-id`,
`missing-entry-id`, `missing-service-id`, `missing-lines`,
`missing-request-id`) without invoking the service. The requester is ALWAYS the
trusted hook `userId`, never a payload `userId`, and no `userId` is included in the
payload passed to the service. Each result is projected through its own public
sanitizer (`publicCartResult`, `publicServiceResult`, `publicPreorderResult`,
`publicTheftResult`) so only the allowlisted scalar fields escape to the client -
never the idempotency carrybacks, the raw order record/outcome, or the private
`details`/`compensation` internals. Each sanitizer also projects an `originalStatus`
field on a `replay` response (the recorded order status, allowlisted to the
persisted advanced-order statuses and dropped otherwise), so a player/GM UI can
distinguish a successful terminal replay from a replay of a failed/pending/
needsRecovery original. The cart sanitizer caps the outcome `items`
list at 20 and reduces each line to `{entryId, name, quantity, specialId?,
specialPrice?}`; `detail` is only ever emitted for a cart/preorder
`insufficient-funds`/`service-refused` error and is bounded to 200 characters.
`handleTheft` calls ONLY `theft.attempt` (never `resolve`), so a client-supplied
`success` never grants a free item - the GM adjudicates through
`api.advanced.resolveTheft`. `requestMessageData` copies only the allowlisted
advanced fields (`lines`, `barterItemId`, `serviceId`) and never a client-supplied
`success`/`price`/`gmUserId`.

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
- `sellItem(params)` - M5 GM-only whole-item sale. `params` is
  `{ shopId, actorId, itemId, requestId }`. Guarded on THIS user being the active
  GM before any read/write (a non-active GM resolves
  `{status:'error', error:'not-active-gm'}`), and always executes as
  `game.user.id` - never a caller-supplied GM id. Returns the bounded sell result
  `{ status, error?, orderId?, payout?, buybackEntryId?, itemName? }`; the raw
  selling service is not exposed.
- `advanced` - M5 GM-only advanced order resolution. Every method is guarded on
  THIS user being the active GM BEFORE any store read and always executes as
  `game.user.id` - never a caller-supplied GM id - so the GM's own adjudication
  is authoritative. Each result is run through the SAME per-type public sanitizer
  the player request channel uses, and the raw service/store objects are not
  exposed.
  - `fulfillService(params)` - manual service fulfillment acknowledgement.
    `params` is `{ orderId, requestId? }`. Returns the bounded
    `publicServiceResult` shape.
  - `fulfillPreorder(params)` / `cancelPreorder(params)` - fulfill or cancel a
    booked preorder. `params` is `{ orderId, requestId? }`. Returns the bounded
    `publicPreorderResult` shape.
  - `resolveTheft(params)` - GM grant/refusal of a theft claim. `params` is
    `{ orderId, success, requestId? }` (typed boolean `success`). Returns the
    bounded `publicTheftResult` shape. Deliberately NOT reachable through a player
    request - only the GM can award or refuse the item.
  - `listOrders(params)` - bounded scalar order summary. `params` is
    `{ shopId?, status?, kind?, limit?, offset? }` and reads `store.listAdvancedOrders`
    (newest-first, capped at 100). `limit` is validated to 1..100 (defaulting to 100,
    never requesting an empty page) and `offset` must be non-negative (defaulting to
    0); the validated values are forwarded unchanged to the store so a caller can
    page through a large backlog. Each record is projected through
    `publicAdvancedOrder` to only the allowlisted scalar fields
    (`id, key, kind, status, phase, shopId, actorId, entryId, relatedOrderId,
    quantity, total, deposit, remaining, userId, createdAt, updatedAt, error`),
    stripping the private `details`/`outcome`/`payload`/snapshot and the
    `intentHash`. A store read failure fails closed as a correlated
    `{status:'error', error:'server-error'}`.

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

  M5 additions: the storefront exposes the advanced trade controls. A local
  `_data.cartLines` array of `{entryId, quantity, specialId}` holds the player's
  basket (at most 20 distinct **entry** lines - a line is unique by `entryId`, so
  at most one line may ever carry a given entry regardless of `specialId`; each
  line 1..100, no price is ever carried client-side). Adding a special over an
  existing regular entry replaces that line's `specialId` in place (keeping the
  accumulated quantity, never creating a duplicate entry line), and adding a
  regular entry over an existing line resets its `specialId` to `''` while
  retaining the accumulated quantity. `remove-from-cart` is therefore by `entryId`
  alone. Adding/removing lines is purely local and never sends a request. `_prepareContext` derives the display `cartLines`
  ({entryId, name, quantity, unitPrice, total, specialId}) and a safe-int
  `cartTotal` from the sanitized catalog + public shop specials, plus
  `sellItems`/`barterItems` (the locally selected OWNED Actor's embedded Items
  filtered by the server "one whole item" rule - `system.quantity` absent or 1)
  and `preorderEntries`/`theftEntries` (only `canPreorder`/`canAttemptTheft`
  entries, so the selects never offer an ineligible option). A special line's
  price comes only from the selected actor's personalized `shop.specials[].price`
  (this is the same social-quoted price the GM checkout quote uses) - never
  `entry.specialPrice` or a raw `special.price`. `cartEstimate` is true when NO
  character is selected, since the totals are then a base (non-personalized)
  estimate: the template annotates the cart as an estimate and the checkout
  control is disabled, so the displayed total is never presented as a firm GM
  quote without an actor. Cart state is
  cleared on actor switch, on a successful (committed/replay) cart checkout, and
  pruned from `_data.cartLines` whenever a catalog refresh no longer shows an
  entry.

  The 8 storefront controls (`add-to-cart`, `add-special-to-cart`,
  `remove-from-cart`, `checkout-cart`, `book-service`, `place-preorder`,
  `attempt-theft`, `sell-item`) dispatch through the same static `_action`
  pattern. The authenticated actions all funnel through `_requestAdvanced(type,
  payload)`, which guards on an active GM, a selected actor, an open shop and the
  shared `_data.pending` flag (a future M1 purchase or advanced request cannot
  overlap), generates a per-type `requestId`, and sends ONLY the
  server-allowlisted payload fields - a `cart` sends `lines` (`{entryId,
  quantity, specialId}` mapped from `_data.cartLines`) and an optional
  `barterItemId`; `service` sends `serviceId`; `preorder` sends `entryId` +
  `quantity` (from the card `data-entry-id` or the eligible select); `theft` sends
  `entryId`; `sell` sends `itemId` from the `sellItemId` select. A client
  `price`/`success`/`roll` is never supplied. Responses are correlated by
  `requestId` and rejected unless the echoed `actorId` AND `shopId` match the
  current selection (`_advancedResponseMatches`), so a stale actor's advanced
  response never mutates the storefront. `_onAdvancedResponse` reports the
  bounded, truthful status (a `booked` service/preorder/theft is never reported as
  fulfilled/resolved), and gates the replay path through
  `_isSuccessfulAdvancedReplay(type, result)`, which treats a `replay` as a
  success only when the echoed `originalStatus` belongs to the type's success set
  (cart => committed; service => booked/fulfilled; preorder =>
  booked/fulfilled/cancelled; theft/sell => committed). A replay whose original
  persisted `failed`/`needsRecovery`/`pending` is a recovery surface, never a
  completed message. The cart is cleared ONLY on a committed checkout or a replay
  whose `originalStatus` is `committed` (a failed replay never wipes the basket),
  and the catalog is refreshed only after a status that actually moved stock/funds
  or completed a sale (a theft claim deliberately does not refresh, and a replay
  of a successful terminal advanced order does refresh since it may reflect a
  prior GM resolution).

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
- `Daggerheart` needs GM-configured generic paths before it reports support;
  `DC20`/`Twodsix` are first-class and report support regardless of generic
  path settings (opt into a custom generic configuration explicitly with
  `getAdapter('generic', config)`).
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
- **M5 merchant specials projection (`projectSpecials` in `src/core/requests.js`).**
  The public catalog `shop` carries a `specials` list sanitized to
  `{id, title, description, entryId, price}` - never the raw `visible`/`actorUuids`/
  commerce config. An offer is exposed only when it is visible (`visible !== false`),
  `quoteSpecial` permits it for the catalog's actor, AND its reference entry is
  present in that particular catalog's inventory (so a backroom-only offer is
  omitted from the base catalog even when public, and an actor-specific offer is
  hidden from the base catalog where the actor uuid is null). The base catalog's
  cross-reference (`specialId`/`specialPrice` on an entry) uses the raw configured
  `special.price` only when EXACTLY ONE eligible offer targets the entry; the
  personalized catalog instead social-quotes `{ ...entry, price: special.price }`
  through `quoteSocial` (an overflow fails closed as a correlated `server-error`).
  In BOTH catalogs the effective list `price` is produced ONCE per eligible special
  through the SAME `quoteSpecialPrice` callback used to build the list, and the
  identical value is used for any single-offer entry cross-reference - so the list
  `price` and `entry.specialPrice` always agree, and the raw `special.price` is
  never surfaced directly in the personalized case. An ambiguous entry with more
  than one eligible offer keeps the separate list and is never cross-referenced -
  the storefront chooses later.
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

## Advanced commerce configuration (M5)

M5 adds the **validated advanced commerce configuration** schema, the **pure**
access/quotation policies, and **wires per-entry access eligibility into the
catalog, purchase and quote surfaces**. The shop `commerce` object and the
per-entry `access` gate are normalized by `src/services/model.js`, and the
deterministic access decisions derived from them live in
`src/advanced/policy.js` (`canAccessEntry`). The access gate is now enforced
end-to-end: the base catalog omits `backroom` entries entirely; the personalized
catalog only exposes a `backroom` entry to an actor who may access it; the
purchase path rejects an inaccessible `backroom` entry (`entry-restricted`)
before any debit; and `api.quotePrice` returns `null` for an inaccessible
`backroom` when called by a player (the GM may quote any entry). The
`commerce` configuration object (services/specials/preorders/theft/funds) and the
per-entry `access` gate are normalized by the schema: `SCHEMA_VERSION` stays `1`
and a shop/entry carrying no M5 fields normalizes to the documented defaults, so
existing records load unchanged operationally. The M5 slices then add the
GM-private advanced-order records and the GM-authoritative services that act on
them - whole-item sell/buyback, manual service booking, single-payer multi-line
cart checkout with optional whole-item barter, deposit-backed out-of-stock
pre-orders, GM-adjudicated theft and actor special offers (see the subsections
below). Merchant `commerce.funds` are live, not a deferred quota: an M1 direct
Buy now gains the purchase `total` in the same single shop patch, as do the
advanced cart/service/preorder paths with the currency they collect (a bartered
item is never counted as currency), and a whole-item sale pays out by
decrementing finite merchant funds. `null` (unlimited) funds stay unlimited and
no funds patch is ever written.

### Advanced commerce schema (`src/services/model.js`)

`normalizeShop` returns a new `commerce` object:

- `funds` - `null` (unlimited) or a non-negative safe integer. `null` means the
  shop never runs out of purchasing currency; an integer is the shop's available
  buying funds.
- `buyRateBps` / `buybackRateBps` - basis-point rates bounded to
  `[0, 20000]` (0..200%). `buybackRateBps` must be **>=** `buyRateBps` (the shop
  never pays more to buy back than it charges to buy, and never charges less to
  buy back than it paid out), so a config that would set a buyback below the buy
  rate fails closed at GM save. Defaults are `5000` / `12000`.
- `services` - at most `MAX_COMMERCE_SERVICES` (20) items, each
  `{ id, name (<= 100), description (<= 400), price (non-negative safe
  integer), visible (true), enabled (true), manualFulfillment (true) }`. A
  service is a bookable line item (GM manually fulfills it - no automatic
  effect in this slice). `name` is required; `description` may be empty; scalar
  boolean toggles default to `true`; an absent `id` is generated via `makeId`
  (a supplied id is preserved). More than 20 services throws (no slicing).
- `specials` - at most `MAX_COMMERCE_SPECIALS` (20) items, each
  `{ id, title (<= 100), description (<= 400), entryId (''), price
  (non-negative safe integer), visible (true), actorUuids (<= 20 world Actor
  UUIDs) }`. A special is a GM-configured price offer on an **existing** shop
  inventory `entryId`; `title` is required; `entryId` is empty by default and
  is only meaningful once wired (not in this slice); `actorUuids` is an
  allowlist (empty = any actor). More than 20 specials throws (no slicing).
- `preorders` - `{ enabled (false), depositBps (2500, bounded to [0, 20000]),
  maxPerActor (3, >= 1) }`.
- `theft` - `{ enabled (false) }`.
- `valuations` - at most `MAX_COMMERCE_VALUATIONS` (100) GM-authored per-item
  valuations, each `{ id (<= 120), actorUuid (matching
  `/^Actor\.[A-Za-z0-9]+$/`), itemId (<= 120), amount (positive safe integer
  minor units), fingerprint (lowercase hex, 16..128 chars) }`. A valuation binds
  a world Actor UUID + embedded Item id to a GM-approved minor-unit `amount`,
  tamper-detected by a canonical fingerprint of the serialized item data. They
  are GM-private and never projected into the public catalog
  (`PUBLIC_SHOP_FIELDS` does not include `valuations`). The list is unique by
  `(actorUuid, itemId)` - a raw save with a duplicate pair keeps the newest
  entry for that pair. More than 100 valuations throws (no slicing). See the M6
  GM-authored per-Item valuation service below.

`normalizeInventoryEntry` returns a new `access` gate on each entry:

- `access` - `{ mode ('public' | 'backroom', default 'public'),
  actorUuids (<= 20 world Actor UUIDs), minReputation (-100) }`. `mode`
  falls back to `public` when unknown; `actorUuids` entries must match the world
  Actor-UUID pattern `/^Actor\.[A-Za-z0-9]+$/`; `minReputation` is bounded to
  the reputation range `[-100, 100]`. More than 20 `actorUuids` throws (no
  slicing). A backroom with no allowlist entries and `minReputation: -100` is
  still valid normalized data - it simply denies everyone (see the policy).

Validation is strict and fails closed: an out-of-range rate, an unqualified
buyback rate, a negative/unsafe `funds`, an over-cap array, an invalid actor
UUID, an out-of-range `minReputation`/`depositBps`/`maxPerActor` or an
empty service/special `name`/`title` throws at GM save instead of silently
dropping data, while a shop/entry with no M5 fields normalizes to the defaults.

### Advanced commerce policies (`src/advanced/policy.js`)

`src/advanced/policy.js` is a **pure** module (no Foundry globals,
Node-importable) exporting deterministic, side-effect-free helpers that read a
normalized shop/entry/special and never mutate it:

- `canAccessEntry(entry, { actorUuid, score })` - whether the actor may access
  an entry given its `access` gate. An entry without an `access` block (legacy)
  is public and requires only `visible`. A `public` entry is accessible only
  when it is also `visible`. A `backroom` entry is accessible when the actor's
  UUID is in the allowlist OR (only when `minReputation` is above -100) the
  actor's effective reputation `score` is >= `minReputation`. With an empty
  allowlist and `minReputation: -100` the backroom denies everyone, so a
  GM-created backroom is never accidentally public.
- `visibleEntriesFor(shop, actorUuid, score)` - the pure projection of
  `shop.inventory` that is both `visible` and permitted to the actor. The
  request layer calls `canAccessEntry` directly for per-actor cataloging; this
  convenience helper is offered for callers that want a whole-shop projection.
- `quoteSell(itemPrice, shop)` - the integer price a shop pays to buy an item
  from a player: `floor(itemPrice * buyRateBps / 10000)` via BigInt
  intermediates, 0 when `itemPrice` is 0, checked against
  `Number.MAX_SAFE_INTEGER` (overflow throws).
- `quoteBuyback(paid, shop)` - the integer price a shop pays to buy back goods
  worth `paid`: `ceil(paid * buybackRateBps / 10000)` (rounds up so a player is
  never under-paid), checked for safe-integer overflow.
- `quoteDeposit(total, shop)` - `ceil(total * depositBps / 10000)` capped at
  `total` and floored at 1 minor unit for a positive total, returning
  `{ deposit, remaining }` as non-negative safe integers.
- `quoteSpecial(entry, special, actorUuid)` - the configured `special.price`
  only when the special's `entryId` matches the entry's id AND the actor is
  eligible (an empty `actorUuids` allowlist allows any actor, otherwise the
  actor's UUID must be in the list); otherwise `null`. This is a pure quote -
  it reports the special's price and does **not** override the existing
  `quote(...)` purchase pricing (the purchase path is unchanged in this
  milestone).

Every quote uses BigInt intermediates so no float arithmetic is produced, and
each result is validated against `Number.MAX_SAFE_INTEGER` (overflow throws
rather than wrapping). None of these helpers mutate the shop, entry or special,
and none perform a store write.

### Runtime wiring - backroom eligibility

The per-entry `access` gate is now enforced by the request, purchase and quote
surfaces (no new store write or effectful service beyond the existing ones):

- **Base catalog (`publicInventory` in `src/core/requests.js`).** The
  non-personalized catalog omits any entry whose `access.mode === 'backroom'`
  regardless of `visible`. A `backroom` entry is never shown until an actor's
  eligibility is known; no entry-level `access`/`actorUuids`/`minReputation`
  data leaks into the allowlisted public projection (`PUBLIC_ENTRY_FIELDS` never
  carries `access`).
- **Personalized catalog (`handleCatalog` in `src/core/requests.js`).** After the
  actor is validated as owned by the requester and the effective reputation is
  looked up, each visible entry is further filtered through
  `canAccessEntry(entry, { actorUuid: actor.uuid, score: effective.score })`. A
  `backroom` entry appears only when the actor is allowlisted or meets the
  reputation threshold; an inaccessible entry is omitted (never leaked).
- **Purchase path (`purchaseLocked` in `src/services/commerce.js`).** After the
  actor-ownership check and the effective-reputation lookup, `canAccessEntry` is
  enforced for a `backroom` entry and a failure with error `entry-restricted` is
  recorded BEFORE any debit, even when a client forges an entryId the actor
  cannot access. On a legacy / un-wired runtime with no `getSocial`, access fails
  closed for a `backroom` entry unless the actor's UUID is already allowlisted
  (the score defaults to -100). Public entries are unchanged.
- **Quote API (`quotePrice` in `src/core/main.js`).** A non-GM caller may only
  quote an entry their owned actor can access; an inaccessible `backroom` returns
  `null`. The GM may quote any entry.
- **M5 availability flags (`applyAvailabilityFlags` in `src/core/requests.js`).**
  Both catalog builders decorate each projected entry with `canPreorder` and
  `canAttemptTheft` - client-side request hints, never an execution outcome (the
  server stays authoritative). `publicShop` additionally projects `services`
  (enabled+visible, bounded to `{id,name,description,price}`), `preordersEnabled`
  and `theftEnabled` from the validated `shop.commerce`, never the raw object. The
  raw `commerce` object, merchant `funds`, `buyRateBps`/`buybackRateBps`,
  `depositBps`/`maxPerActor`, the per-service `manualFulfillment`/
  `enabled`/`visible` flags and the per-offer `actorUuids` are never exposed. A
  `backroom` entry is omitted from the base catalog (so no entry-level
  preorder/theft leaks) and, even in a personalized catalog where the actor may
  access it, is `canAttemptTheft: false` (theft is public-only) while remaining
  preorder-eligible when out of stock.

### GM-private advanced-commerce order records (M5)

The M5 backward-slice is schema-and-policy only, without any new store write or
effectful service. To give the later M5 direct operations (bookable services,
preorder execution, theft, specials and funds-aware buying) an idempotent record
to act on, this slice adds GM-private **advanced order records** - a pure store +
schema extension that records the *intent* and its execution phase markers for a
single advanced-commerce action. It does **not** modify the M1 ledger record or
the existing purchase path, and it does **not** add a service or UI.

**Record kind.** One new record kind, `advancedOrder`, is added alongside
`location`/`shop`/`ledger`/`reputation`/`reputationEvent`. Each order is stored in
its **own** GM-only `JournalEntry` (created with `ownership: { default: 0 }`, so
players never see it), never embedded in the shop record - mirroring the ledger
and reputation records, so there is no unbounded embedded history and **no schema
version bump** (`SCHEMA_VERSION` stays `1`).

Order shape (`src/services/model.js` `normalizeAdvancedOrder`):

- `id`, `key` (idempotency key), `kind`
  (`'sell'|'cart'|'service'|'preorder'|'preorder-fulfill'|'preorder-cancel'|
  `'theft'|'special'`), `status` (`'pending'|'committed'|'booked'|'fulfilled'|
  'cancelled'|'failed'|'needsRecovery'`), `phase`
  (`'recorded'|'debited'|'transferred'|'credited'|'stocked'|'bartered'|'final'`).
- `shopId` (required), `userId`, `actorId`, `entryId`, `relatedOrderId`
  (all optional except `shopId`; an absent/empty optional id normalizes to `''`).
  Every id is validated with the shared market-id rule - non-empty (when
  supplied), at most 120 chars, free of control characters. `actorId` may be a
  world actor id that is **not** a Foundry Actor UUID (e.g. `archmage-vhal`), so
  it is validated as a plain market id rather than an `Actor.*` pattern.
- `quantity` (integer `>= 1`), `total`/`deposit`/`remaining` (non-negative safe
  integers), `createdAt`/`updatedAt` (safe integers).
- `intentHash` (non-empty, at most 256 chars) - the caller's intent fingerprint,
  used to detect a replayed create whose payload changed.
- `details` (plain bounded JSON, at most 64KB, no functions or custom
  prototypes), `outcome` (plain bounded JSON, at most 8KB), and `error` (a
  string capped at 200 chars). `details`/`outcome` are deep-cloned to a fresh
  plain object/array, so a JSON-serializable structure is always stored; a
  function, Symbol, BigInt, non-finite number, or an object with a custom
  prototype (a `Date`/`Map`/class instance) fails closed at GM save, and an
  oversized serialization (> 64KB / > 8KB) throws rather than being sliced.

Defaults: `status` `'pending'`, `phase` `'recorded'`, `quantity` 1, totals 0,
`createdAt`/`updatedAt` now, `details`/`outcome` `{}`. An absent/empty optional id
collapses to `''`. Validation is strict and fails closed at GM save - an unknown
kind/status/phase, a bad id, a non-positive quantity, an empty/oversized
`intentHash`, or a non-plain/oversized `details`/`outcome` throws.

**Store methods** (`src/storage/store.js`):

- `findAdvancedOrderByKey(key)` - the order whose `key` matches, or `null`.
- `findAdvancedOrder(id)` - the order by id, or `null`.
- `listAdvancedOrders({ shopId, actorId, status, kind, limit = 100, offset = 0 })`
  - newest first (`createdAt` descending), filtered by the four predicates, and
    always bounded to at most **100** records (the documented cap; `limit` is
    clamped to 100, non-positive collapses to an empty page). Callers may
    optionally pass `limit`/`offset` for paging.
- `createAdvancedOrder(record)` - returns `{ record, created }` and never creates
  a second order for an existing `key` (mirroring `createLedger`). On a replay it
  returns the existing order with `created: false`; a caller that replays is
  expected to verify the `intentHash` before applying any side effect.
- `updateAdvancedOrder(id, patch)` - updates the order in place, or `null` when
  missing. `key`/`kind`/`shopId`/`actorId`/`userId`/`intentHash`/`createdAt` are
  **immutable** - a patch cannot change them (the persisted values are forced
  back). `updatedAt` is bumped to now unless the patch supplies a value.

**Idempotency / atomicity.** Orders are keyed by their `key`, so a replayed
create never duplicates a JournalEntry. As with the ledger, `createAdvancedOrder`
is a JournalEntry read-then-create, **not** a server-side compare-and-swap, so
the module does **not** claim cross-GM atomicity - the same race caveat as
`createLedger` applies. The M1 ledger and the purchase path are untouched: this
slice adds a GM-private record kind and its store helpers only.

**Null shop write.** Every effectful `store.updateShop` call in the advanced
engines (cart, service, preorder place/fulfill/cancel, selling, theft) captures
the returned shop and, when it is `null` (the shop record vanished under the
write), throws `new Error('shop-write-missing')` instead of treating the write as
a silent success. The existing compensation/recovery branches treat that throw as
a shop-write failure (no effect is claimed as applied; funds/stock/deliveries and
the order status are decided by re-reading the current shop, escalating to
`needsRecovery` when the state is mixed or the shop is missing), so a
committed/booked/fulfilled order is never reported on a disappearing write.
`shop-write-missing` is an allowlisted public error code (added to the shared
advanced error-code set and `SELL_RESULT_ERROR_CODES`), so it surfaces through
the public sanitizers and the storefront error text instead of a raw message.

**Tests.** `tests/advanced-store.test.js` covers GM-only journal ownership and the
no-schema-bump guarantee, the order being stored in its own journal (never
embedded in the shop record), idempotent create on the key, updates (mutable
fields apply; immutable fields are preserved; a missing id returns `null`), strict
normalization (unknown kind/status/phase, bad ids, quantity/total bounds,
`intentHash` bounds, plain-bounded `details`/`outcome`, error cap), safe
newest-first ordering + filtering + 100-record cap + optional paging,
world-actor-id acceptance for `actorId`, and the immutable-field contract on
update.

#### M5 GM-authoritative sell / buyback service (`src/advanced/selling.js`)

The M5 order-record slice above is deliberately effect-free. This service gives
the GM an authoritative, idempotent way to execute one effectful action on top of
it: selling a single whole embedded `Item` the player owns back to a shop. The
shop prices the buyback with `quoteSell(itemPrice, shop)` and lists the item for
resale at `quoteBuyback(payout, shop)`; the player is paid the payout; the item is
removed from the player's actor; and the shop's inventory gains a
`non-restocking` buyback listing that is no longer part of that shop's real stock.

**GM-approval gate.** A whole item a player owns is never priced by its own
system `price` (a player can inflate that value) so it can never silently mint
currency or buy goods. Instead the sale resolves a **GM-approved valuation** via
the injected `getApprovedValuation(item)` dependency. With no such mechanism
wired, or with no GM approval yet recorded for the item, the service
fails closed `gm-approval-required` **before** the pending order and any effect,
so no currency or goods move. A legitimate valuation of `0` is approved; only a
missing function or a `null`/`undefined`/throwing result refuses. The runtime
`main.js` supplies `getApprovedValuation` from the M6 valuation service (see the
M6 section), so the fail-closed path applies only when no still-valid approval is
recorded for the item; tests also inject a fixture so the effectful sell path
stays exercisable without a real GM approval.

**Interface.** `createSellingService({ store, runShopExclusive, isActiveGM,
getActor, actorOwnedBy, getAdapter, now, makeId, logger, getApprovedValuation })`
returns `{ sell }`.
`sell({ shopId, actorId, itemId, requestId, userId }, authenticatedUserId)`
returns a `Promise<{ status, ... }>` and never mutates state except through the
injected store/actor/adapter. It is not a request/UI adapter and does not touch
the M1 purchase path.

**Requester authority.** The executing user is always `authenticatedUserId` - the
request's `userId` payload is never trusted. It is used as the actor-ownership
principal (`actorOwnedBy(actor, authenticatedUserId)`), the idempotency key
prefix, and the order's `userId`/intent-hash `requester`. Ownership is checked
against the freshly read actor, so a caller who does not own the actor is refused
(`actor-not-owned`) before any order is written.

**Gate and validation order.** All validation fails before effects. In order:
(1) normalize and validate `shopId`/`actorId`/`itemId`/`requestId` (market-id
rule, `requestId <= 120`; a missing `requestId` is generated with `makeId`), and
require a non-empty `authenticatedUserId`; (2) require `isActiveGM()` - a player
does not even trigger a store read (`not-active-gm`); (3) acquire the per-shop
lock `runShopExclusive(shopId, ...)`; and only then (4) read the existing order,
the shop, and the actor.

**Idempotency.** The order key is `sell:${authenticatedUserId}:${requestId}` and
the canonical `intentHash` covers `{ shopId, actorId, itemId, requester =
authenticatedUserId }` (via `fnv1a` over a stable JSON string). Before any effect
the service re-reads the order by key:
- same key, same `intentHash`, `status === 'committed'` => `replay`, returning the
  recorded `payout`/`buybackEntryId`/`itemName` with no new effect.
- same key, same `intentHash`, `status` pending/`needsRecovery` => `needsRecovery`
  (manual recovery; no effect applied).
- same key, same `intentHash`, any other terminal status => `replay`.
- same key, different `intentHash` => `conflict`, carrying the persisted hash.

Every `replay` response echoes the recorded `originalStatus` (the persisted order
status, e.g. `originalStatus: 'failed'` for a persisted `failed` original). The
public sanitizers project `originalStatus` through `sanitizeAdvancedOriginalStatus`
(allowlisted to the persisted `ADVANCED_ORDER_STATUSES` set, dropped otherwise),
so the storefront can tell a successful terminal replay from a replay of a
failed/pending/needsRecovery original and never reports the latter as complete.

**Validation before the order is written (all fail closed, no order):**
`shop-not-found` / `actor-not-found` / `item-not-found` / `item-not-an-item` /
`item-parent-mismatch` (an embedded parent that is not the actor) /
`stacked-item` (only a whole item is sold) / `gm-approval-required` (no
GM-approved valuation, see the gate above) / `quote-overflow` /
`no-offer` (payout `<= 0`), `insufficient-merchant-funds` (a finite
`commerce.funds` below the payout; `null` means unlimited),
`invalid-world-time` (a non-finite/non-safe `now()` value), `shop-closed`,
`delivery-mode-unsupported` (a GenericAdapter configured for
non-embedded path delivery cannot delete an embedded Item, so the whole-item sale
is unsupported), and `quantity-path-invalid` (a configured `quantityPath` that is
missing, non-numeric, or otherwise unreadable).

**Whole-item rule.** For a GenericAdapter with a configured `quantityPath`, the
count is read through that path via the safe reader (`readPath` from
`src/adapters/index.js`) on the serialized item and must be the integer `1`;
anything else is `stacked-item` and a missing/invalid path is
`quantity-path-invalid`. For a non-generic (dnd5e) item the existing
`item.system.quantity` check applies when present and rejects anything `!== 1`.

**Trading gate.** When `now` is provided, `isShopTrading(shop, safeWorldTime(now()))`
must report the shop open; a bad clock fails closed `invalid-world-time`. When
`now` is absent/null, only the legacy `shop.open` toggle is consulted.

**Ordering of effects (all inside the lock).** A `pending` order must be
persisted before any effect, capturing the serialized item snapshot, payout and
`fundsBefore` in `details`, with an empty `outcome`. Then, with the actor
re-read: (a) `deleteEmbeddedDocuments('Item', [itemId])` - the delete is only
accepted when the LIVE `actor.items.get(itemId)` is `null` AFTER the API
resolves; a returned deletion id alone is insufficient, since the API may
report the id while the item is still live; (b) `adapter.credit(actor, payout)`;
(c) a **single** `store.updateShop` write appending the normalized buyback entry
(empty `itemUuid`, snapshot, `quantity: 1`, `stockMode: 'non-restocking'`,
`price: quoteBuyback(payout, shop)`, `visible: true`), decrementing finite
`commerce.funds`, and filtering the consumed valuation out of
`shop.commerce.valuations` (the GM approval is single-use) in the same call;
(d) committing the order (`status: 'committed'`, `phase:
'final'`, `outcome: { payout, buybackEntryId, itemName }`). Phase markers
(`transferred`/`credited`/`stocked`) are best-effort and never fatal - a null or
thrown phase write is logged and flags the order uncertain, since the final
commit sets `phase: 'final'` anyway. The `buybackEntryId` is generated with
`makeId()` before the shop write so the outcome and any restoration can
reference it. The commit is only claimed `committed` when the terminal write
actually persisted a record: a `null` return from `updateAdvancedOrder` means
the order record is gone, so the service returns `needsRecovery` rather than
claiming committed and compensates the applied effects.

**Credit verification.** A `credit` that throws is not trusted even when it may
have applied. The service captures `adapter.getBalance(actor)` before the
credit and, on a throw, reads the balance again and compares: unchanged means no
debit was applied (nothing is refunded), exactly `before + payout` means the
credit did apply despite throwing (the payout is refunded during compensation),
and any other delta is a divergence that must escalate to `needsRecovery`. This
prevents a silent payout duplication on a later replay. When the before/after
balance cannot be read, the order is treated as uncertain.

**GM handover.** The active-GM guard is re-checked at every await boundary that
can observe a handover: at `sellLocked` entry before any read, immediately
before the pending `createAdvancedOrder`, and before each effect after an await.
On a handover after the pending order but before all effects are applied, the
former GM stops applying further effects and the order is marked `failed` when
safe (nothing uncertain was applied) or `needsRecovery` otherwise - no effect
runs on behalf of a former GM. A handover detected before the pending order is
written returns `not-active-gm` with no store write.

**Compensation.** Any failure after the pending order is written is best-effort
undone, never silently double-credited: refund the credited payout (`adapter.
debit`) only if the balance verification proved the credit applied; restore the
item via `createEmbeddedDocuments('Item', [savedItemData], { keepId: true })`
**only if** it is currently missing, and verify the restored id with
`actor.items.get(itemId)` afterwards - a missing item after restore is
escalated to `needsRecovery`. The shop write compensation no longer guesses:
it compares the current shop funds to the recorded `fundsBefore` and whether the
`buybackEntryId` still exists. A known no-write (no listing and funds equal to
`fundsBefore`) is reported as `shop-unwritten` with no write; a known full-write
(listing exists AND funds equal `fundsBefore - payout`, or unlimited funds)
removes the exact listing and restores the funds in the **same** `updateShop`
and verifies the returned shop and states; any mixed/unknown state is
`shop-state-mixed` and escalates to `needsRecovery` rather than being assumed.
`details.compensation` records the markers applied; a fully successful
compensation records `status: 'failed'`, an uncertain/failed one records
`status: 'needsRecovery'`. A pending order is never re-run by `sell` itself - a
replay surfaces `needsRecovery`. Errors before the pending write return a
sanitized `{ status: 'error', error }` with no writes.

**Cross-client uniqueness.** The active-GM shop lock and the
`createAdvancedOrder` read-then-create are both per-client and do not guarantee
key/entry uniqueness across two simultaneous GM clients. Under a GM handover or
two GM clients processing the same sell concurrently, both clients can read "no
order" for the same key before either persists one, so both may create and both
may apply effects - the same best-effort caveat as `createLedger`. No
cross-client atomicity is claimed; verifying and hardening this against two live
GM clients (and confirming the interplay under the shared per-shop lock) is
deferred to M6 testing.

**Tests.** `tests/advanced-selling.test.js` covers the success path and its exact
side effects (single shop write, funds decrement, buyback listing, committed
order outcome/details), unlimited-funds behavior, idempotent replay (no second
credit/delete/append), duplicate-identity conflict, pending/needsRecovery and
failed-order replay, the non-GM gate (no store read), actor ownership, missing
shop/actor/item, the stacked-item rule, insufficient merchant funds, zero offer
(`no-offer`), the invalid-world-time fail-closed, closed-shop refusal on both the
clock and legacy paths, the generic `quantityPath` whole-item rule (stacked /
invalid path / non-embedded delivery mode), and every compensation path: delete
failure (item kept, `failed`), credit failure (item restored), shop-write failure
(credit refunded + item restored, shop unchanged), commit failure (credit
refunded + item restored + shop entry removed + funds refunded), a shop-restore
failure that escalates to `needsRecovery`, a delete that resolves but leaves the
item live (`failed`, no payout), a credit that throws after applying (balance
verification refunds the payout), a `null` commit write (`needsRecovery`, never
committed), a restore that fails to keep the original id (`needsRecovery`), a
mixed shop state (`needsRecovery`, not `failed`), and a GM handover after the
pending order (`failed`, no effect from the former GM). Lock-serialization is
shown by two concurrent sells and by a concurrent commerce purchase and sell
sharing the same per-shop lock (max write depth 1).

#### M6 GM-authored per-Item valuation (sell/barter) (`src/advanced/valuation.js`)

The GM-approval gate used by the sell/buyback and cart-barter services requires a
per-item valuation authority: a player-owned Item is never priced by its own
player-inflatable system `price`. This module provides that authority. It has two
halves: a GM-only `approve` operation that persists a validated valuation onto the
GM-private `shop.commerce.valuations` array, and a pure, tamper-detecting read
side (`getApprovedValuation`) used by the sell and cart services.

**Interface.** `createValuationService({ store, runShopExclusive, isActiveGM,
getActor, makeId, logger })` returns `{ approve, getApprovedValuation }`.
`approve({ shopId, actorId, itemId, amount }, gmUserId)` returns a
`Promise<{ status, ... }>`. `gmUserId` is accepted for future attribution but is
not used as an ownership principal on this path (the item and actor belong to the
player, not the GM). The returned `getApprovedValuation(item, shop)` is the
injectable read side the sell/cart services consume: it is the pure
`findApprovedValuation` full-entry lookup, so the caller can both read the
approved minor-unit `amount` and CONSUME the entry at commit (see below).

**GM-only and shop lock.** `approve` requires `isActiveGM()` before any store
read (a player watching the app never triggers a read or a write), then runs
exclusively under `runShopExclusive(shopId, ...)`, and re-reads the shop and the
actor's embedded Item at transaction time (never trusting the request). The
active-GM guard is re-checked at every await boundary that can observe a GM
handover, before each read and before the write.

**Validation order (all fail closed, no write):** `shop-not-found` /
`actor-not-found` / `item-not-found` / `item-not-an-item` /
`item-parent-mismatch` (an embedded parent that is not the actor) /
`stacked-item` (only a whole item is valued - `system.quantity` must be `1`
when present; the generic `quantityPath` check is deferred to a later slice) /
`fingerprint-failed` (the item data is not plain JSON, the serialized data
exceeds 64KB, or the document id disagrees with the serialized `_id`) /
`invalid-actor-uuid` (the actor does not carry a well-formed world Actor UUID),
and `shop-write-missing` (the store returned `null`). A malformed payload
(`shopId`/`actorId`/`itemId` not market-ids or `amount` not a positive safe
integer) is rejected before any store read.

**Fingerprint (`fingerprintItem(item)`).** A pure, deterministic helper: it
canonicalizes the FULL `item.toObject()` data (including `_id`, `name`, `type`,
`system`, `flags`) into key-sorted plain JSON (so identical data yields the same
digest regardless of key order), bounds the serialized JSON to 64KB, and hashes
it with FNV-1a 64-bit. It fails closed on non-plain JSON (a function, Symbol,
BigInt, non-finite number, or a Date/Map/class-instance prototype). The digest is
lowercase hex, 16 chars. This is a tamper-detection hash, not a cryptographic
guarantee, and the fingerprint is stored as the GM's authoritative snapshot.

**Persisted normalization.** A single `store.updateShop(shopId, { commerce: {
...shop.commerce, valuations } })` write carries the whole validated commerce
patch, so the valuations are normalized by the schema exactly like every other
commerce field. Approving replaces any existing valuation for the same
`(actorUuid, itemId)` pair (never a duplicate), or appends up to
`MAX_COMMERCE_VALUATIONS` (100), dropping the oldest entry when the list is
already full. Success returns `{ status: 'approved', valuationId, itemName,
amount }`.

**Pure read side (`findApprovedValuation(item, shop)` / `getApprovedValuation`).**
`findApprovedValuation` returns the FULL validated valuation entry only when the
item is embedded on an actor whose `Actor.<id>` uuid matches a stored valuation's
`actorUuid`, the item's document id matches the stored `itemId`, and the canonical
fingerprint of the CURRENT item data matches the stored fingerprint. Any mutation
of the item - most importantly a forged/inflated player `price`, but also a
name/type/system/flags change - changes the fingerprint, so
`findApprovedValuation` returns `null` and the sell/barter path fails closed
`gm-approval-required` rather than paying a number that no longer corresponds to
the item. It never mutates state and never throws (a fingerprinting failure is
treated as "not approved"). The pure exported `getApprovedValuation(item, shop)`
is a convenience wrapper that returns only `entry.amount` (or `null`); the
service's injected `getApprovedValuation` instead returns the FULL entry so the
sell/cart services can consume it at commit.

**Consumption at commit.** A stored valuation is a single-use authority, not a
standing price. Both the whole-item sell (`src/advanced/selling.js`) and the cart
barter tender (`src/advanced/cart.js`) resolve the approved entry BEFORE the
pending order (via the injected `getApprovedValuation`), and carry the consumed
entry (`consumedValuation`) into their single shop write, which filters
`shop.commerce.valuations` by the entry's `id` in the SAME patch that applies the
funds/listing/stock effects. That way the same approval cannot mint repeated
payouts for the same item, even if the item is later recreated and re-approved.
Compensation restores the EXACT consumed entry on a known full-write (so the
shop's valuations list is left exactly as it was), leaves it untouched on a known
no-write, and escalates to `needsRecovery` on an uncertain write, with the
restore verified against the returned shop state. The buy-only cart path never
touches a valuation: only `barter.consumedValuation` triggers filtering and
restoration.

**Catalog privacy and the `approvedItems` allowlist.** The valuations are private:
they live only on the normalized `shop.commerce.valuations` config and are never
included in the `PUBLIC_SHOP_FIELDS` allowlist, so `publicShop` never leaks them to
a player. Instead the personalized catalog builder exposes a derived
`shop.approvedItems` allowlist (this field IS in `PUBLIC_SHOP_FIELDS`): the pure
`approvedItemsFor(shop, actor)` helper projects the up-to-`MAX_COMMERCE_VALUATIONS`
`{itemId, amount}` pairs for which the selected (already actor-owned) character has
a matching, still-valid approval - the stored `actorUuid`/`itemId` must match the
actor and a live embedded Item, and `fingerprintItem(item)` must equal the stored
fingerprint, so a later player mutation of the item (price/name/type/system/flags)
invalidates the approval and the item drops out of the list. Only `{itemId,
amount}` is ever exposed - never the raw valuation `id`, the `actorUuid`, or the
private `fingerprint` - and the base (non-personalized) catalog keeps
`approvedItems: []`. This drives both the player storefront gate and the GM
manager UI: the storefront `_sellableItems`/barter selects only offer whole items
present in `_data.shop.approvedItems` (showing the "Ask the GM to value an item
before selling or bartering it." message when a character is selected and none is
approved), and the manager `.valuation-panel` lets the active GM approve a
valuation for a chosen Character (reusing the reputation Character selector, with
an item select `valuationItemId`, a `valuationAmount` number and a
`approve-valuation` action) so the new approval appears in the private list and,
on the next catalog request, in that character's `approvedItems`.

The sell and cart services are wired to the valuation service's full-entry read
side in `src/core/main.js`: `valuationService = createValuationService(...)` shares
the same per-shop lock and active-GM predicate as commerce, and its
`getApprovedValuation` is injected into both `createSellingService` and
`createCartCommerce`, so a player-owned Item is priced by the approved valuation,
never its own system `price`. The GM-only `api.advanced.approveValuation` is
exposed on the public API surface, active-GM gated before any store read, and
returns only `{ status, valuationId, itemName, amount }` - the private fingerprint
and the raw entry are never surfaced to the caller.

#### M6 GM-only portable backup manager panel (`src/ui/manager.js`, `templates/manager.hbs`)

The manager renders a GM-only backup panel (`.backup-panel`) with three actions
(`export-backup`, `preview-backup`, `import-backup`) plus a file input
(`name="backupFile"`) and a confirmation checkbox (`name="confirmImport"`), all
DOM-scoped (`backup-panel` selectors only) and gated on the active GM - a
non-active GM sees them disabled with a note. Each handler gate is defense in
depth with the `api.backup.*` wrapper above.

- `_onExportBackup` calls `_exportPortable()` (injected `deps.exportPortable`,
  else `api.backup.exportPortable`), then `_downloadBackup(result.backup)`.
  `_downloadBackup` serializes the backup in COMPACT form (no pretty-print),
  measures its UTF-8 byte length against `MAX_BACKUP_BYTES` BEFORE any download,
  and only then downloads the JSON locally via a Blob object URL + temporary
  anchor + `URL.revokeObjectURL`. An export that exceeds the portable bound is
  refused with `{ status: 'error', error: 'export-too-large' }` (no download) and
  the manager surfaces it with a clear notice, so a saved backup is always
  importable back. The backup is never routed through a player request or chat
  message - the manager owns the export surface.
- `_onPreviewBackup` reads the selected `File` only when `file.size <= 5 MiB`
  (the size is checked BEFORE `file.text()`), parses the JSON, and runs
  `importPortable(raw, { dryRun: true })`. It caches the raw backup and the File
  object so a later import can reuse them exactly, and projects only bounded
  counts and at most 20 warnings into `_data.backupPreview`.
- `_onImportBackup` requires BOTH the confirmation checkbox and an existing
  successful preview computed from the currently selected file (a file-change
  handler plus a per-click comparison invalidate a stale preview), then runs
  `importPortable(raw, { dryRun: false })`. On success/partial it reports the
  outcome honestly (bounded created ids and the error code), clears the cached
  raw/file and the confirmation checkbox, and refreshes locations/shops.

`backupSummary`/`backupPreview` are sanitized plain objects - counts, at most 20
warnings and bounded created-id lists - never the raw backup JSON. Export
downloads a local file and never exposes the backup to chat.

**Tests.** `tests/advanced-valuation.test.js` covers the pure `fingerprintItem`
(determinism, key-order independence, full source fields, plain-JSON rejection,
id-mismatch rejection, 64KB bound), the pure `getApprovedValuation` /
`findApprovedValuation` (match, wrong actor, wrong item id, a forged/mutated
player price invalidating an approval, no valuations, the full-entry vs
amount-only split), the GM-only `approve` service (success + persisted
normalization, the GM gate with no store read, payload validation before any
read, replace-not-duplicate, the 100-entry cap dropping the oldest, the
one-whole-item/missing-item/parent-mismatch/fingerprint-failure refusals,
shop/actor/write errors), `normalizeShop` valuation defaults + fail-closed +
uniqueness, and `publicShop` never leaking `valuations` into the catalog.
`tests/advanced-selling.test.js` and `tests/advanced-cart.test.js` cover the
runtime consumption: the injected approved callback + a seeded shop valuation
price the sale/barter at the approved amount, the consumed entry is removed by
the single shop write, compensation restores the exact consumed entry on a
full-write restore, the same approval is rejected on a one-time replay, a
changed/mutated Item fingerprint invalidates the approval,
`gm-approval-required` fails closed when no callback is provided, and
`tests/ui.test.js` covers the active-GM gate on `api.advanced.approveValuation`
(no read/write when a player calls it).

#### M5 GM-authoritative service booking & manual fulfillment (`src/advanced/services.js`)

The sell/buyback service moves a whole embedded `Item` between a player and a shop.
This service instead handles a **bookable `shop.commerce.services[]` entry**, which
has **no automatic mechanical effect**: booking debits the player once, grants the
finite merchant funds the price, and records a `booked` advanced order; the
service is only completed when the GM later calls `fulfill`, which records the
acknowledgement (the GM manually confirms delivery outside the module) and moves
the order from `booked` to `fulfilled`. Neither path delivers, creates, or removes
an `Item` - a service booking must never produce a "fake item".

**Interface.** `createServiceCommerce({ store, runShopExclusive, isActiveGM,
getActor, actorOwnedBy, getAdapter, getWorldTime, now, logger })` returns
`{ book, fulfill }`.

- `book({ shopId, serviceId, actorId, requestId }, requesterId)` - the active GM
  executes a player's service booking. `requesterId` is the **authenticated
  player** user id (never a payload field) and is used as the actor-ownership
  principal, the idempotency-key prefix, and the order `userId`.
- `fulfill({ orderId, requestId }, gmUserId)` - the active GM records a manual
  fulfillment acknowledgement for a `booked` service order. `gmUserId` is the
  executing GM user id (never a payload field) and is the fulfillment record's
  `userId`.

Both return a `Promise<{ status, ... }>`. Public results are bounded to
`{ status, error?, orderId?, serviceId?, serviceName?, price? }` - never the raw
advanced-order record, the idempotency `conflict`/`expected`/`existing`
carrybacks, or the order `details`/`compensation`/`outcome` arrays. Neither
method touches the M1 purchase ledger, the purchase path, or any request/UI
surface; they only read `findShop`/`findAdvancedOrderByKey`/`findAdvancedOrder`
and write `updateShop`/`createAdvancedOrder`/`updateAdvancedOrder` (plus the
injected actor/adapter), and share the per-shop `runShopExclusive` lock with
purchases so a booking and a buy never interleave their shop writes.

**Booking gate and validation.** All validation fails before any effect, in order:
(1) normalize and validate `shopId`/`serviceId`/`actorId`/`requestId` (market-id
rule; a missing `requestId` is generated with `makeId`) and require a non-empty
`requesterId`; (2) require `isActiveGM()` - a player does not even trigger a store
read (`not-active-gm`); (3) acquire the per-shop lock; (4) re-read the existing
order (idempotency), the shop, the service, and the actor. The service is never
trusted from the request: it is re-read from the STORED shop's
`commerce.services[]` by `serviceId` and must exist (`service-not-found`), be
`enabled` (`service-disabled`), and be `visible` (`service-hidden`). Ownership is
checked against the freshly read actor (`actor-not-owned`). The **price** is the
STORED `service.price` - no client-supplied price is ever honored
(`invalid-price` on a non-safe/non-negative value). The adapter must be
`supported` (`adapter-unsupported`) and the actor's live balance must cover the
price before any debit (`balance-read-failed`, `insufficient-funds`).

**Trading gate.** `book` re-checks the shop trading gate server-side: when a world
clock is available (`getWorldTime`, falling back to `now`), the clock is coerced
to a safe integer second and `isShopTrading` must report the shop open; a bad
clock fails closed `invalid-world-time` and a non-open shop returns `shop-closed`.
With no clock, only the legacy `shop.open` toggle is consulted (`shop-closed`).

**Funds overflow guard.** Finite `commerce.funds` GAIN the price. Before any
effect the service checks that `fundsBefore + price` is a safe integer; an
overflow refuses with `funds-overflow` rather than wrapping. `null` funds are
unlimited: the shop is left untouched (no funds patch write).

**Booking idempotency.** The order key is `service:${requesterId}:${requestId}`
and the canonical `intentHash` covers `{ shopId, serviceId, actorId, requester =
requesterId }` (via `fnv1a`). Before any effect the service re-reads the order by
key: same key + same hash on a `booked`/`fulfilled` order => `replay` (a fulfilled
service is still a completed booking) with the recorded outcome; pending or
`needsRecovery` => `needsRecovery` (no effect applied); any other terminal status
=> `replay`; same key + different hash => `conflict`. A `createAdvancedOrder` race
that hands back an existing order for the same key resolves idempotently and
never applies an effect.

**Booking effects (all inside the lock).** A `pending` order (kind `service`,
status `pending`, phase `recorded`, `userId` = requester, `total`/`remaining`
= price, `entryId` = `''`, `details` carrying `serviceId`/`serviceName`/`price`/
`fundsBefore`) is persisted BEFORE charging. Then, with the shop/actor re-read:
(a) `adapter.debit(actor, price)` exactly once - a throwing debit is ALWAYS rolled
back (never trusted), and the balance is captured before/compared after the throw
to decide whether the player must be refunded (a decreased-by-exactly-price balance
means the debit applied and is refunded, an unchanged balance means no refund, and
any divergence, or an unreadable after-balance, escalates to `needsRecovery`);
(b) a best-effort `debited` phase marker; (c) for finite funds a **single**
`store.updateShop(shopId, { commerce: { ...shop.commerce, funds: fundsBefore +
price } })` (unlimited funds write nothing); (d) a best-effort `credited` phase
marker; (e) committing the order (`status: 'booked'`, `phase: 'final'`,
`outcome: { serviceId, serviceName, price, orderId }`). The commit is only claimed
`booked` when the terminal write actually persisted a record - a `null` return
means the order is gone, so the service returns `needsRecovery` and compensates
the applied effects. The service has NO automatic mechanical effect: the order is
`booked`, not `fulfilled`; completion happens only through `fulfill`.

**Booking compensation.** Any failure after the pending order is written is
best-effort undone: refund the price via `adapter.credit(actor, price)` only if
the debit was applied; and, if the finite-funds shop write was applied, restore
`commerce.funds` to the recorded `fundsBefore` by comparing the current funds -
unchanged means no write (no-op), equal to `fundsBefore + price` means restore,
and any mixed/diverged state is `shop-state-mixed` escalated to `needsRecovery`.
`details.compensation` records the markers; a fully successful compensation
records `status: 'failed'`, an uncertain/failed one records `status:
'needsRecovery'`. A failure to write the terminal status leaves the record
`pending` (a replay then surfaces `needsRecovery`), and a replay of a pending
order never re-applies an effect. Errors before the pending write return a
sanitized `{ status: 'error', error }` with no writes.

**Fulfillment flow.** `fulfill` is GM-gated (`isActiveGM` before any store read).
Because the order's `shopId` is not in the payload, the service reads the order
once to find the shop id, then acquires the SAME per-shop lock and re-reads
everything inside it. The original order must be `kind === 'service'`
(`order-not-service`); a `booked` original proceeds, an already `fulfilled`
original replays as success (`replay`) with no new effect, and any other status
returns `order-not-booked`. The shop and actor must still exist (`shop-not-found`/
`actor-not-found`).

**Fulfillment idempotency.** The key is `service-fulfill:${orderId}:${requestId}`,
distinct from the booking key, with an `intentHash` over `{ orderId }` (the
executing GM is deliberately excluded so a different GM repeating the request
replays rather than conflicts). The acknowledgement is itself an advanced-order
record of kind `service` with `relatedOrderId` = the original order id. A pending
acknowledgement is persisted, then the original order is marked `fulfilled`, then
the acknowledgement record is marked `committed`. If EITHER of the two writes
fails the fulfill returns `needsRecovery` and the service is never re-run. On a
replay the original order's status is re-checked: if it is already `fulfilled` the
fulfill replays as success (and a best-effort write attempts to finalize a still-
pending acknowledgement record); otherwise the pending/`needsRecovery`
acknowledgement surfaces `needsRecovery`. The GM manually confirms delivery
outside the module - fulfillment only records the acknowledgement.

**Tests.** `tests/advanced-services.test.js` covers the booking success path and
its exact side effects (one debit, no delivered `Item`, no shop inventory entry,
the single finite-funds patch and `booked`-not-`fulfilled` order outcome),
unlimited-funds behavior, idempotent replay (no second debit), duplicate-identity
conflict, pending and failed-order replay, the non-active-GM gate (no store read),
actor ownership, missing/disabled/hidden service, the closed-shop and
invalid-world-time gate on both the clock and legacy paths, insufficient funds,
the finite-funds safe-integer overflow guard, debit-error compensation (a throwing
debit and a debit that applies-then-throws refunded via balance verification), a
failed shop write and a `null` commit both escaping to `needsRecovery`, the
"no fake Item" contract (deliverItem/removeItem never called), the
booked-not-fulfilled contract, and the fulfillment path: GM-only single
fulfillment with a no-op replay, non-service/not-booked/missing-order validation,
an already-fulfilled-order replay, missing shop/actor, a failed original-status
write, and a failed acknowledgement commit (recorded `needsRecovery`, original
still `fulfilled`, re-checked on replay). Lock-serialization is shown with two
concurrent bookings sharing the same per-shop lock (max write depth 1).

#### M5 GM-authoritative safe multi-item cart checkout (`src/advanced/cart.js`)

The selling and service milestones move one whole item, or a service with no item
at all. This service instead executes a **safe multi-item checkout**: a single
actor buying a selection of inventory entries from one shop in one transaction.
It is another GM-authoritative, idempotent, **compensating** advanced-order
transaction on top of the GM-private `advancedOrder` records; it does **not**
claim distributed/transactional atomicity, only best-effort compensation that
escalates to `needsRecovery` when a compensating step is itself uncertain.

**Single payer, no unauthorized debit.** ONLY the request's `actorId` is debited.
No other party is charged. A "group cart" today is interpreted as a single payer
accumulating a shared selection; the explicit cost-sharing/consent model that
would split the total across several actors is NOT implemented here, so the docs
state this boundary expressly: **no other contributor is charged.**

**Interface.** `createCartCommerce({ store, runShopExclusive, isActiveGM,
getActor, actorOwnedBy, getAdapter, fromUuid, getSocial, getWorldTime, now,
logger, getApprovedValuation })` returns `{ checkout }`.
`checkout({ shopId, actorId, lines: [{ entryId, quantity, specialId? }], requestId, barterItemId? },
authenticatedRequesterId)` returns a `Promise<{ status, ... }>` and never mutates
state except through the injected store/actor/adapter. It does not touch the M1
purchase path, the ledger, or any request/UI surface.

**Requester authority.** The executing user is always `authenticatedRequesterId`
- never a payload field. It is the actor-ownership principal, the idempotency-key
prefix, and the order `userId`. Ownership is checked against the freshly read
actor, so a caller who does not own the actor is refused (`actor-not-owned`)
before any order is written.

**Caps and validation.** The `lines` array must be an array of at most
`CART_MAX_LINES` (20) entries; each `entryId` must be unique across the request
(`duplicate-entry`); each `quantity` must be a safe integer in `1..CART_MAX_QUANTITY`
(100). A missing `requestId` is generated with `makeId`. The optional
`barterItemId`, when present, must be a non-blank string of at most 120 chars with
no control characters - the same market-id discipline used elsewhere - and is
normalized by trimming (an absent/null/blank value collapses to '' meaning "no
barter"). These fail closed with a bounded error before any store read.

**Gate and validation order.** All validation fails before effects. In order:
(1) normalize and validate `shopId`/`actorId`/`lines`/`requestId` and require a
non-empty `authenticatedRequesterId`; (2) require `isActiveGM()` - a player does
not even trigger a store read (`not-active-gm`); (3) acquire the per-shop lock
`runShopExclusive(shopId, ...)`; (4) re-read the existing order (idempotency), the
shop, and the actor inside the lock. The active-GM guard is re-checked after every
await boundary that can observe a handover, including before the pending order is
written and before each effect (`activeGmOrThrow`).

**Intent idempotency.** The order key is `cart:${authenticatedRequesterId}:${requestId}`
and the canonical `intentHash` is `fnv1a` over `{ shopId, actorId, requester,
lines, barterItemId }` where `lines` is **canonicalized by sorting on `entryId`**
and each line is normalized to `{ entryId, quantity, specialId }` (the optional
`specialId` collapses to `''` when absent) - the order a client sends the lines in
never changes the hash, so a reordered-but-identical selection replays rather than
conflicting. `barterItemId` is part of the intent: the same key with a **different**
`barterItemId` is a `conflict`, never a replay, because the tender materially
changes the checkout. A **distinct** `specialId` on a line is also part of the
intent: the same key with a different offer id is a `conflict`, because the offer
changes the charged price. Before any effect the service re-reads
the order by key:
- same key + same `intentHash`, `status === 'committed'` => `replay` with the
  recorded bounded outcome, unchanged (never recharges).
- same key + same `intentHash`, `status` pending/`needsRecovery` => `needsRecovery`
  (manual recovery; no effect applied, never recharges).
- same key + same `intentHash`, any other terminal status => `replay`.
- same key + different `intentHash` => `conflict` (the lines changed), carrying the
  persisted hash.

**No client price.** Each entry is re-read from the STORED `shop.inventory`, never
from the request. For each line the service verifies, in order and before any
effect: `entry-not-found`, `entry-hidden` (`visible === false`), `entry-restricted`
(a `backroom` entry the actor cannot access via `canAccessEntry`, using the actor's
UUID and effective reputation score), `insufficient-stock` (a finite or
non-restocking entry whose recorded quantity is below the line quantity), and
`item-source-missing` (no `itemUuid` that resolves and no valid snapshot).

**Merchant specials (per-line `specialId`).** An optional per-line market-id
`specialId` (at most 120 chars, no control chars - same discipline as
`barterItemId`) asks for a merchant special offer. The offer is re-read from the
STORED `shop.commerce.specials` - never a client price - and must be an exact
match on this entry (`special.entryId === entry.id`), still visible
(`visible !== false`), and permitted for the paying actor via `quoteSpecial`
(the actor-UUID allowlist: an empty `actorUuids` permits any actor, otherwise the
actor's `uuid` must be in the list). An unknown/forged offer id, a hidden offer,
one targeting a different entry, or one the actor is not allowlisted for all fail
the whole checkout closed as `special-unavailable` BEFORE any debit - a forged
`specialId` can never charge the wrong amount. A real `quoteSpecial` price is a
number (a 0-price offer is legal), so eligibility is tested with `!== null`, never
a falsy check. When eligible, the service quotes against a shallow copy
`{ ...entry, price: special.price }` through `quoteSocial` so the offer price still
carries the shop/personality/reputation social adjustment (never a raw number),
and records the resolved special on the quote. The private `details` line and the
public outcome item carry the offer id (and the outcome item the charged unit
price) so both the order record and the safe response identify which offer was
used and what was charged.

**Item source resolution.** Identical to the purchase path: prefer the live
`itemUuid` via `fromUuid`; if absent or deleted, fall back to a valid snapshot
through the shared `parseItemData` safe parser. Both missing forbids the line.

**Quoting.** With `getSocial` wired, the service reads the effective reputation
(`getSocial(shop, actor)`), gates access with the score, and quotes each line via
`quoteSocial(entry, quantity, { shop, scores: { individual, party } })` at the
CURRENT shop/scores. A Hated reputation refuses the whole checkout (`service-refused`)
BEFORE any effect. Without `getSocial` (legacy/un-wired runtime) it fails closed
for a `backroom` entry (score -100) and uses the integer `quote(entry, quantity)`.
A quote overflow fails closed as `total-overflow`.

**Total and balance.** The line totals are summed with a BigInt/safe-integer check
(`total-overflow` on overflow). The adapter must be `supported`
(`adapter-unsupported`), and the actor's live balance must cover the **cash
remainder** - the gross `total`, or `total` minus the capped barter credit when a
`barterItemId` is tendered (`balance-read-failed` / `insufficient-funds`). The
bartered item already covers its portion, so it is never required to appear as
currency. Optional finite merchant `commerce.funds` GAIN only the cash remainder
(never the bartered credit - the item is not currency); before any effect the
service checks `fundsBefore + cashRemainder` is a safe integer, refusing
`funds-overflow` rather than wrapping. `null` funds stay unlimited (no funds patch
written).

**Barter item-for-price.** When `barterItemId` is supplied, the paying actor
tenders ONE whole embedded `Item` as credit against the cart gross total. The
service resolves it inside the shared shop lock, before any effect, and never
mutates state on this path: it reads `actor.items.get(barterItemId)`, requires the
document to be an `Item` with a working `toObject()` (missing item =>
`barter-item-not-found`; non-item/malformed => `barter-item-not-an-item`; a tender
whose `parent` is not the buying actor => `barter-item-parent-mismatch`), and
captures an immutable `toObject()` snapshot. Only an **embedded**-delivery adapter
can remove an embedded tender, so a generic adapter configured for path delivery
rejects the barter fail-closed (`delivery-mode-unsupported`). The whole-item rule
requires exactly one: a configured `adapter.quantityPath` is read through the safe
reader (invalid/unreadable => `quantity-path-invalid`; count not exactly 1 =>
`stacked-item`), otherwise the dnd5e `system.quantity` is consulted when present
(anything but exactly 1 => `stacked-item`); a generic adapter with neither uses no
quantity check. The tender is priced by a **GM-approved valuation**, never the
item's own system `price` (a player can inflate that value): the injected
`getApprovedValuation(item)` dependency resolves the value - another
`gm-approval-required` fail-closed **before** any effect or pending order when no
matching still-valid GM approval is recorded for the item (a `0` valuation is
legitimate; only a missing function or a `null`/`undefined`/throwing result
refuses). The runtime `main.js` supplies `getApprovedValuation` from the M6
valuation service, so this path refuses only when the GM has not yet approved the
tender. The shop's
fair purchase value `quoteSell(itemPrice, shop)` is computed (overflow =>
`quote-overflow`), and the barter credit is `min(sellValue, total)` - capped at the
cart gross total so a tender worth more than the cart NEVER pays cash out. A credit
of 0 rejects the checkout as `no-offer`. Only the cash remainder is debited. The
bartered item becomes a shop **non-restocking** listing priced at
`quoteBuyback(credit)` (overflow => `quote-overflow`) carrying the immutable
snapshot (so the listing never references a stale/deleted UUID) and appended to the
shop inventory in the single shop write. The safe public outcome adds
`barterCredit` and `cashPaid` and deliberately omits the raw tender snapshot/name.

**Ordering of effects (all inside the lock).** A `pending` order (kind `cart`,
status `pending`, phase `recorded`, `entryId` `''`, `total`/`remaining` = total,
`quantity` = sum of line quantities) is persisted BEFORE charging, with a bounded
private line breakdown in `details` (per-line `{ entryId, name, quantity,
unitPrice, total, itemUuid, snapshot, specialId }`) and `total`/`fundsBefore`. When a barter
tender is present, `details.barter` carries the immutable tender snapshot, the
`barterCredit`, the `cashPaid`, the buyback listing id and its price - private data
that may be large, and the basis for restoring the exact tender on compensation.
The public `outcome` deliberately omits it. The order normalizer enforces the 64KB
`details` cap, so an overflow makes `createAdvancedOrder` throw and the checkout
fails BEFORE any effect. Then, with the shop/actor re-read, when bartering the
tender Item is removed FIRST (`actor.deleteEmbeddedDocuments('Item',[id])`),
recording a `bartered` phase; the removal is only trusted after a live
`actor.items.get(itemId)` check, so a returned resolution is not believed and a
still-present item is a hard `barter-item-remove-failed`. Then:
(a) `adapter.debit(actor, cashPaid)` exactly once - only the cash remainder is
debited, never the bartered credit; a throwing debit is ALWAYS rolled back (never
trusted), with a balance verdict deciding whether the player is refunded and
whether the state is uncertain; (b) a best-effort `debited` phase marker;
(c) deliver EACH line via `adapter.deliverItem(actor, source, { quantity })`,
recording the created id so compensation can remove it, with a best-effort
`transferred` phase marker; (d) a **single** `store.updateShop` write decrementing
all finite / non-restocking stock, appending the barter buyback listing (when
bartering), incrementing finite `commerce.funds` by only the cash remainder, and
when bartering filtering the consumed valuation out of `shop.commerce.valuations`
(the GM approval is single-use) in the same call; (e) a best-effort `stocked`
phase marker; (f) committing the order
(`status: 'committed'`, `phase: 'final'`, `outcome: { total, quantity,
barterCredit, cashPaid, items: [{ entryId, name, quantity, specialId?, specialPrice? }], orderId }`). The
public result is bounded: never the raw record or `details`/`compensation`/`outcome`
arrays beyond the documented outcome. The commit is only claimed `committed` when
the terminal write actually persisted a record; a `null` return means
`needsRecovery` and compensates the applied effects.

**Compensation.** Any failure after the pending order is written is best-effort
undone, never silently double-debited: delivered lines are removed in REVERSE
order via `adapter.removeItem(actor, createdId)`; the player is credited the cash
remainder only if the debit was applied (never the bartered credit); and the shop
stock/funds/buyback-listing are restored only when the single shop write actually
applied - decided by comparing the CURRENT shop to this cart's OWN before/after
entry quantities, funds, and buyback-listing presence, never a best-effort guess.
When bartering, a removed tender is restored FIRST via
`actor.createEmbeddedDocuments('Item', [snapshot], { keepId: true })`, verified by
`actor.items.get(itemId)` - restoring the ORIGINAL id (a still-missing item after
the restore is `tender-restore-id-failed`, uncertain). A known no-write (nothing
changed) reports `shop-unwritten`; a known full-write restores the exact entries
and funds, removes the buyback listing, and verifies the persisted shop
(`shop-restored`); any mixed/unknown state escalates `shop-state-mixed`.
`details.compensation` records the markers; a deliver/credit/tender-restore/restore
that itself fails, or an ambiguous shop state, marks the order `needsRecovery`. A
fully successful compensation records `failed`. A failure to write the terminal
status leaves the record `pending` (a replay then surfaces it).

**Tests.** `tests/advanced-cart.test.js` covers the two-line success path and its
exact side effects (single debit, two deliveries, a single shop write that
decrements stock and increments finite funds, and the committed cart order's
bounded outcome), canonical sorted-intent idempotency (reordered lines replay with
no new effect), committed/pending replay never recharging, changed-line conflict,
the non-active-GM gate (no store read), duplicate-entry and too-many-lines caps,
missing shop/actor/ownership, restricted (`backroom`) and hidden entries, Hated
reputation refusal, insufficient stock and funds, an entry with no resolvable item
source, finite merchant funds gain and the safe-integer funds/total overflow
guards, and the compensation paths: a second-line delivery failure that refunds
the total and removes the first delivered line, a shop update failure (deliveries
removed, player refunded, shop untouched), and ambiguous recoveries that escalate
to `needsRecovery` (a removeItem failure and a mixed shop funds state). The same
file also covers the optional item-for-price barter: a full-credit tender that
covers the whole cart with no cash moved, a partial-credit tender that debits only
the cash remainder and gains merchant funds only that, a zero-value tender
rejected as `no-offer`, an unowned tender (`barter-item-not-found`), a stacked
tender (`stacked-item`), a generic delivery-mode tender
(`delivery-mode-unsupported`), an unsupported adapter keeping the tender, a
committed barter checkout replaying with no re-removal/re-debit/re-append, a
changed `barterItemId` on the same key conflicting with no new effect, a delivery
failure after tender removal that restores the tender and refunds the cash
remainder, a throwing cash debit rolling back without double-charging, and an
ambiguous shop state (listing present, funds not gained) escalating to
`needsRecovery`. Lock-serialization is shown with two concurrent checkouts sharing
the same per-shop lock (max write depth 1). The merchant-special paths are covered
too: an actor-allowlisted offer is charged at the stored offer price while a
client-supplied line `price` is ignored; a forged/hidden/wrong-entry/not-allowlisted
`specialId` all fail closed as `special-unavailable` before any debit; the same key
with a distinct `specialId` is a conflict while the identical one replays; and the
offer price is quoted socially (a shop markup is applied to the configured special
price, proving it is never used verbatim).

#### M5 GM-authoritative out-of-stock pre-orders with paid deposit (`src/advanced/preorders.js`)

The cart, sell and service milestones all execute an in-stock exchange. This
service instead handles an **out-of-stock pre-order**: a player puts a paid
deposit on an entry that cannot currently serve the requested quantity (a finite
or non-restocking entry whose recorded quantity is below the quantity requested).
The deposit is charged immediately; **no stock is reserved**, so the shop's
recorded entry quantity is left untouched and the stock stays available to other
buyers. The order is kept `booked` and is GM-only until the GM either fulfills it
(charging the remaining balance, delivering the item and decrementing stock) or
cancels it (refunding the deposit and decrementing finite merchant funds).

Like the other M5 advanced services it is a **compensating, idempotent**
advanced-order transaction on top of the GM-private `advancedOrder` records; it
does **not** claim distributed/transactional atomicity - it records phases and
best-effort undoes what it can, escalating to `needsRecovery` when a compensating
step is itself uncertain.

**Interface.** `createPreorderCommerce({ store, runShopExclusive, isActiveGM,
getActor, actorOwnedBy, getAdapter, fromUuid, getSocial, getWorldTime, now,
logger })` returns `{ place, fulfill, cancel }`:
- `place({ shopId, entryId, actorId, quantity = 1, requestId },
  authenticatedUserId)` returns a `Promise<{ status, ... }>`.
- `fulfill({ orderId, requestId }, gmUserId)` and
  `cancel({ orderId, requestId }, gmUserId)` are the GM-only actions.

The executing user is always the second argument (`authenticatedUserId` /
`gmUserId`) - never a payload field. There is no caller-supplied GM identity: the
passed value is used as the idempotency-key prefix and the order `userId`, and
`isActiveGM` gates every entry point.

**Place gate and validation order.** All validation fails before effects. In
order: (1) normalize and validate `shopId`/`entryId`/`actorId`/`quantity`
(a safe integer in 1..`PREORDER_MAX_QUANTITY` (20)) and `requestId`, and require a
non-empty requester; (2) require `isActiveGM()`; (3) acquire the per-shop lock
`runShopExclusive(shopId, ...)`; (4) re-read the existing order (idempotency), the
shop and the actor inside the lock. The active-GM guard is re-checked after every
await boundary that can observe a handover.

Within the lock the service verifies, in order and before any effect:
`shop-not-found`, `preorders-disabled` (`shop.commerce.preorders.enabled !==
true`), `actor-not-found` / `actor-not-owned` (via `actorOwnedBy`), the trading
gate (`shop-closed` / `invalid-world-time` - an invalid world clock fails closed
BEFORE any effect), `entry-not-found`, `entry-hidden`, `entry-restricted` (a
`backroom` entry the actor cannot access via `canAccessEntry`), `stock-sufficient`
(a `stockMode === 'unlimited'` entry is never out of stock, and a finite /
non-restocking entry whose recorded quantity already serves the quantity should
be bought, not pre-ordered), `max-preorders-reached` (no duplicate live `booked`
pre-order beyond `shop.commerce.preorders.maxPerActor` for the same
actor+`entryId`), `item-source-missing` (no `itemUuid` that resolves and no valid
snapshot - the source is validated NOW so fulfillment knows what to deliver after
the stock is replenished).

**Quoting and deposit.** With `getSocial` wired the service reads the effective
reputation (`getSocial(shop, actor)`) and quotes via `quoteSocial(entry,
quantity, { shop, scores: { individual, party } })` at the CURRENT shop/scores; a
Hated reputation refuses (`service-refused`) before any effect. Without
`getSocial` (legacy/un-wired runtime) it fails closed for a `backroom` entry
(score -100) and uses the integer `quote(entry, quantity)`. The total is then
split with the pure `quoteDeposit(total, shop)` helper
(`quote-deposit-failed` on overflow), yielding `{ deposit, remaining }` where the
deposit is charged now and the remaining is charged at fulfillment.

**Place effects.** The adapter must be `supported` (`adapter-unsupported`) and the
actor's live balance must cover the **deposit** only
(`balance-read-failed` / `insufficient-funds`) - the remainder is paid at
fulfillment. Finite merchant `commerce.funds` GAIN the deposit; a safe-integer
overflow refuses `funds-overflow` before any effect, and `null` funds stay
unlimited (no funds patch). A `pending` `advancedOrder` (kind `preorder`, status
`pending`, phase `recorded`, `entryId` = the entry id, `total`, `deposit`,
`remaining`, bounded `details`) is persisted BEFORE the debit. Then, inside the
lock: (a) `adapter.debit(actor, deposit)` exactly once - a throwing debit is ALWAYS
rolled back (never trusted) via a balance verdict; (b) a best-effort `debited`
phase marker; (c) a single `store.updateShop` gating finite merchant funds GAIN
the deposit (only when funds are finite); (d) a best-effort `credited` phase
marker; and (e) committing `status: 'booked'`, `phase: 'final'`, with the bounded
public outcome `{ orderId, entryId, quantity, total, deposit, remaining }`. The
public result is bounded: never the raw record or `details`. No stock is reserved
(the entry quantity is untouched). A `null` commit return means `needsRecovery`.

**Fulfill.** A GM-only action on a `booked` pre-order. The lock is per-shop, so
the order is read once to find its `shopId` (after the GM gate) and the
authoritative re-read occurs inside the lock. It requires the original to be kind
`preorder` and status `booked` (`order-not-preorder` / `order-not-booked`; an
already-`fulfilled` original replays as success), re-reads the shop, actor and
entry, requires `stock >= quantity` (`insufficient-stock`; an unlimited entry
never fails), re-validates the item source NOW, and checks the actor's balance for
the **remaining only** (`insufficient-funds`). Finite merchant funds GAIN the
remaining (safe-integer `funds-overflow` guard).

Before creating a NEW fulfill action key, the service pages through EVERY
`preorder-fulfill` AND `preorder-cancel` action for the same original order
(`findPendingActionForOriginal(['preorder-fulfill', 'preorder-cancel'], ...)`):
it scans all pages of the store's live `preorder-fulfill` records, then all pages
of the `preorder-cancel` records, for any action with `relatedOrderId` equal to
the original id whose `status` is still `pending` or `needsRecovery`. If one is
found, a fulfillment (or a competing cancellation) is already in flight or
uncertain for that original, so the service surfaces `needsRecovery` and NEVER
runs a second fulfillment - even when the requestId differs or the kinds cross (a
pending fulfill blocks a new cancel, and vice versa). This prevents a second GM
request from double-running an action on an original that is only reachable
through a single `booked` pre-order line. A distinct, idempotent
`advancedOrder` of kind `preorder-fulfill` is persisted as `pending` BEFORE any
effect, keyed `preorder-fulfill:${orderId}:${requestId}` with an `intentHash` over
`{ orderId }` (the executing GM is deliberately excluded so a different GM
repeating the request replays rather than conflicts) and `relatedOrderId` = the
original order id. The effects then run inside the lock: debit the remaining once,
deliver the quantity via `adapter.deliverItem(actor, source, { quantity })`
recording the created id, and a single `store.updateShop` that decrements finite /
non-restocking stock and GAINS the remaining merchant funds, then mark the
original `fulfilled` and the action `committed`. A failing delivery records the
created id; failing effects are compensated best-effort (credit the actor the
remaining only if the debit applied, remove delivered lines, and restore
stock/funds only when the single shop write actually applied - decided by
comparing the current shop to this fulfill's own before/after, never a guess),
leaving the original `booked` when safely undone and marking the action `failed`;
an uncertain compensation marks the action `needsRecovery`. A repeated fulfill on
an already-`fulfilled` original replays with no second delivery.

When marking the original `fulfilled` itself throws (or returns null), the effects
(debit, delivery, stock/funds) may still have landed, so the service re-reads the
original to learn the truth. If it turns out actually `fulfilled`, the effects are
preserved and the action escalates to `needsRecovery`. If the re-read itself
throws or the original is missing (re-read-unavailable), the original is treated
as if it were terminal - compensation is skipped, the applied effects are
preserved, the action escalates to `needsRecovery`, and the unresolved-action
guard (`findPendingActionForOriginal`) blocks any future related action for this
original.

**Cancel.** A GM-only action on a `booked` pre-order. As with fulfill, before
creating a NEW cancel action key the service pages through EVERY
`preorder-cancel` AND `preorder-fulfill` action for the same original order
(`findPendingActionForOriginal(['preorder-cancel', 'preorder-fulfill'], ...)`):
if any is still `pending`/`needsRecovery`, a cancellation (or a competing
fulfillment) is already in flight or uncertain, so the service surfaces
`needsRecovery` and NEVER runs a second cancellation - even when the requestId
differs or the kinds cross. A `preorder-cancel` action
`advancedOrder` is persisted as `pending` before any effect, keyed
`preorder-cancel:${orderId}:${requestId}`, `relatedOrderId` = the original order
id. Before effects, when merchant funds are FINITE the shop must still hold the
deposit (`insufficient-merchant-funds` otherwise); `null` funds stay unlimited.
Then: credit the deposit back via `adapter.credit(actor, deposit)` once, and a
single `store.updateShop` DECREMENTING finite merchant funds by the deposit (no
stock was reserved, so there is never a stock restore), then mark the original
`cancelled` and the action `committed`. Effects are compensated best-effort on
failure (debit the actor back the deposit only if the credit applied, restore
merchant funds only when the shop write actually applied), leaving the original
`booked` when safely undone. A pre-order **cannot** be cancelled after it is
fulfilled (`order-not-booked`), and a repeated cancel on a `cancelled` original
replays with no double refund.

When marking the original `cancelled` itself throws (or returns null), the effects
(deposit credit / merchant-funds decrement) may still have landed, so the service
re-reads the original. If it turns out actually `cancelled`, the effects are
preserved and the action escalates to `needsRecovery`. If the re-read itself
throws or the original is missing (re-read-unavailable), the original is treated
as if it were terminal - compensation is skipped, the applied effects are
preserved, the action escalates to `needsRecovery`, and the unresolved-action
guard (`findPendingActionForOriginal`) blocks any future related action for this
original.

**No cross-GM atomicity.** Same as the other advanced orders: nothing claims
distributed/transactional atomicity; every operation is a read-then-create under
the per-shop lock, and uncertainty escalates to `needsRecovery`.

**Tests.** `tests/advanced-preorders.test.js` covers the place success path and
its exact side effects (deposit debited exactly once, finite merchant funds GAIN
the deposit in one patch, no stock reserved, the bounded `booked` outcome and
`entryId`), the stock-sufficient / unlimited / preorders-disabled gates, hidden /
restricted / Hated-reputation refusal, insufficient funds for the deposit,
max-per-actor, an entry with no resolvable item source, quantity-range
validation, booked/pending replay never recharging and changed-quantity conflict,
the non-active-GM gate (no store read) and actor ownership, and the compensation
paths for a throwing debit, a debit that applies-then-throws, a merchant-funds
shop write failure, and a `null` `booked` commit (all escalating appropriately).
For fulfillment it covers the remaining-only charge, delivery, stock decrement
and merchant funds gain; insufficient stock / insufficient remaining balance;
already-fulfilled replay with no second delivery; non-preorder and not-booked
validation; and failure injection that refunds the remaining, removes the
delivery, restores stock/funds and leaves the original booked, plus an ambiguous
recovery escalating to `needsRecovery`, and the apply-then-throw original status
write with a re-read that SUCCEEDS (effects preserved, `needsRecovery`) and a
re-read that THROWS / is unavailable (compensation skipped, action escalates to
`needsRecovery`, future actions blocked). For cancellation it covers the deposit
refund and finite-merchant-funds decrement, insufficient-merchant-funds refusal,
no double refund on replay, the cannot-cancel-after-fulfilled rule, and a failing
cancel that credits back the deposit and restores merchant funds, plus the
re-read-throws / apply-then-throw `cancelled` original write escalation.
Lock-serialization is shown with two concurrent place operations sharing the same
per-shop lock (max write depth 1).

#### M5 GM-authoritative theft adjudication (`src/advanced/theft.js`)

A theft is a player's claim to have stolen an inventory entry. Nothing is decided
at claim time. `createTheftCommerce` returns `{ attempt, resolve }`.

**Claim (`attempt`).** `attempt({ shopId, entryId, actorId, requestId },
authenticatedRequesterId)` records a GM-private `advancedOrder` of kind `theft`
directly as `booked` / `phase: 'final'` (there is no pending->booked transition to
undo, because a claim has NO effects to compensate) with a supplied id, and an
`outcome` of `{ orderId, entryId, status: 'awaiting-gm' }`. It is GM-gated
(`isActiveGM` before any store read, re-checked under the lock) and runs under
the SAME per-shop `runShopExclusive` lock a purchase uses. It requires
`shop.commerce.theft.enabled`, the trading gate (`isShopTrading` via a
server-side `getWorldTime` clock, falling back to `now`, with
`invalid-world-time`/`shop-closed` fail-closed), actor ownership, the entry
being public AND visible (`entry-hidden`; a `backroom` entry is refused with
`entry-backroom` even when the actor is eligible), finite positive stock or
unlimited (`out-of-stock` on a finite/non-restocking zero), and a resolvable item
source (`item-source-missing`/`item-source-failed`). NO item is delivered, NO
stock is decremented, and NO currency moves. The idempotency key is
`theft:${requester}:${requestId}` with a canonical `intentHash` over
`{ shopId, entryId, actorId, requester }`. The same key replays (a committed/
failed claim is still a completed claim); a changed payload conflicts.

**Adjudication (`resolve`).** `resolve({ orderId, requestId, success },
gmUserId)` is GM-only and SELF-DECIDED. `success` MUST be a typed `boolean`
(`success-required` otherwise) - never inferred from a player channel or a
roll. A distinct, idempotent action `advancedOrder` of kind `theft` is persisted
as `pending` BEFORE any effect, keyed `theft-resolve:${orderId}:${requestId}`
with an `intentHash` over `{ orderId, success }` (the decided success is
included so a changed decision conflicts rather than replays; the executing GM is
deliberately excluded so a different GM repeating the request replays) and
`relatedOrderId` = the original order id.

On `success: false` the refusal applies no delivery: the original is marked
`failed` with `outcome: { success: false }`, then the action `committed`. There is
no re-validation of stock/source because nothing is granted.

On `success: true` the GM grants one unit. Under the per-shop lock the shop,
actor and entry are re-validated NOW and the item source resolved
(`insufficient-stock` when a finite/non-restocking entry has been cleaned out,
`actor-not-found`, `entry-not-found`, `item-source-missing`); the adapter must be
supported. Then: deliver ONE item via `adapter.deliverItem(actor, source, {
quantity: 1 })` recording the created id, then a single `store.updateShop`
patch that decrements finite / non-restocking stock by one (an `unlimited` entry
is unchanged and needs no write), then mark the original `committed` with
`outcome: { success: true, entryId }`, then the action `committed`.

**Compensation.** A failure after the pending write compensates best-effort: the
delivered item is removed via `adapter.removeItem`, finite stock is restored only
when the single shop patch actually applied (decided by comparing the current
entry to this grant's own before/after quantity, never a guess), leaving the
original `booked` when safely undone and marking the action `failed`; an
uncertain compensation marks the action `needsRecovery`. When the original WAS
successfully marked `committed` and only the action commit failed, effects are
preserved and the action escalates to `needsRecovery`. When marking the original
itself throws (or returns null) the service re-reads the original to learn the
truth: if it actually turned `failed` (refusal) or `committed` (grant), the
effects are preserved and the action escalates to `needsRecovery`. If the re-read
itself throws or the original is missing (re-read-unavailable), the original is
treated as if it were terminal - compensation is skipped, the applied effects are
preserved, the action escalates to `needsRecovery`, and the unresolved-action
guard (`findUnresolvedTheftAction`) blocks any future related resolve for this
original.
A repeated `resolve` on an
already-resolved original replays the recorded outcome with no second delivery.
The public result is the safe `{ status, error, orderId, success? }` shape - the
raw advanced-order record and its `details`/`compensation` are never leaked to a
player.

**Boundaries.** There is NO theft payout and NO free goods before the GM decision;
there is NO system-skill API call and NO automatic reputation penalty; the module
only ever grants or refuses a single inventory item. A pending theft order is
GM-only.

**Tests.** `tests/advanced-theft.test.js` covers the attempt success path and its
exact non-effects (no debit, no delivery, no stock change, no shop write, the
safe public output and the `booked`/`final` order with `{ orderId, entryId,
status: 'awaiting-gm' }`), the theft-disabled / hidden / backroom / out-of-stock
/ unlimited gates, closed-shop and invalid-clock fail-closed, missing item
source, the non-active-GM gate (no store read), ownership, replay/conflict, the
resolve GM gate and typed-boolean `success` requirement and `gm-required`, the
non-theft-kind refusal, the success:false no-effects path and the success:true
deliver + finite-stock decrement + commit path (and the unlimited no-stock path),
the resolve-time `insufficient-stock` recheck, idempotent replay with no second
delivery and the changed-success conflict, and the compensation paths (delivery
failure, shop-write failure removing the item, `removeItem` failure escalating to
`needsRecovery`, and a nulled action commit preserving the granted item and
escalating), plus the apply-then-throw original status write with a re-read that
SUCCEEDS (effects preserved, `needsRecovery`) and a re-read that THROWS / is
unavailable (compensation skipped, action escalates to `needsRecovery`, future
related resolves blocked) for both the grant and refusal branches.
Lock-serialization is shown with two concurrent resolutions sharing
the same per-shop lock (max write depth 1).

#### M5 GM manager commerce editor & advanced-order adjudication UI (`src/ui/manager.js`, `templates/manager.hbs`)

The M5 advanced services above are effectful but UI-free. This slice wires the
GM-only **Market Manager** to them: it lets the active GM configure the shop
`commerce` object (funds, buy/buyback rates, preorders, theft) and edit the
`services[]`/`specials[]` lists, edit the per-entry `access` gate from an
inventory row, and adjudicate the GM-private advanced orders that the storefront
requests produce (fulfill a booked service/preorder, cancel a preorder, grant or
refuse a theft). The wiring is active-GM gated exactly like the services it calls:
every M5 manager handler rejects a non-active-GM caller before any read/write and
shows the shared `ACTIVE_GM_MESSAGE` ("Only the active Game Master can run
automation."). The manager is a client, however - it still renders the commerce
editor, service/special rows and the advanced-order list for **viewing**, so a
non-active GM can inspect a shop without being able to mutate it.

**Actions.** `DEFAULT_OPTIONS.actions` gains fourteen M5 entries through the same
static `_action(method)` wrapper: `save-commerce`, `add-service`,
`save-services`, `remove-service`, `add-special`, `save-specials`,
`remove-special`, `fulfill-service`, `fulfill-preorder`, `cancel-preorder`,
`resolve-theft-success`, `resolve-theft-failure`, `next-orders` and `prev-orders`
(the last two page through the advanced-order backlog). `_data.advancedOrders` is
initialized to `[]`, with `_data.orderPage` (the current 100-record page index)
and the derived `hasPreviousOrders`/`hasNextOrders` flags, and `_prepareContext`
derives `serviceRows`/`specialRows` fresh from the selected shop
(`_buildServiceRows`/`_buildSpecialRows`) so a re-render never carries a stale row
set; it defaults `advancedOrders`/`orderPage` and the paging flags and sets
`_data.isActiveGM` so the template can gate the editor and the order buttons.
`_buildServiceRows`/`_buildSpecialRows` project only the bounded fields the
template reads - never a raw record - and the special rows additionally carry a
comma-joined `actorUuidsText` string so the GM-facing actor-UUID input binds to a
human-editable list rather than a raw array.

**Commerce settings (`_onSaveCommerce`).** Reads ONLY the `.commerce-panel` top
fields (merchant funds, buy/buyback rates, preorders/deposit/max-per-actor, theft
toggle). The `unlimitedFunds` checkbox maps `funds` to `null`; otherwise a strict
safe integer is required, falling back to the existing funds when the field is
left empty, then `0`. The existing `services`/`specials` (edited via their own
add/save/remove actions) are merged from the freshly re-read shop under the shared
per-shop lock, the whole `commerce` object is validated by `normalizeCommerce`,
and only `{ commerce }` is patched. An invalid rate (e.g. `buybackRateBps <
buyRateBps`) fails closed with a notice and no write.

**Service and special editors.** `add-service`/`add-special` persist a row with
valid defaults immediately under the shared per-shop lock, capped at
`MAX_COMMERCE_SERVICES`/`MAX_COMMERCE_SPECIALS` (20) - an over-cap add surfaces a
notice rather than throwing. `save-services`/`save-specials` read each
`[data-service-id]`/`[data-special-id]` row, validate through `normalizeCommerce`,
and merge edits **by id** into the freshly re-read persisted list, so a row added
concurrently (or otherwise absent from the DOM) is never dropped; a DOM row whose
id is not in the persisted list fails closed (a notice, no write) rather than
silently creating a new id. `remove-service`/`remove-special` drop only the entry
matching the id, never a row absent from the DOM. A special's non-empty `entryId`
must exist in the CURRENT inventory (fail closed otherwise), and special `actorUuids`
are comma-split and trimmed then validated by `normalizeCommerce`. On any
validation error the unsaved form is left intact (no write, no refresh).

**Per-entry access gate (`_onSaveEntry`).** The existing inventory-row save is
extended to read `accessMode`/`accessActorUuids`/`accessMinReputation` **only when
the row actually carries the controls**, building an `access` object and
validating it via `normalizeInventoryEntry`. Actor UUIDs are comma-split and
trimmed; the persisted `minReputation` is preserved when the row omits the field,
so an inventory row without backroom controls can never reset a saved gate.

**Advanced-order adjudication.** The three order-button handlers read
`data-order-id` and call the GM-only service through `_advancedCall(method, params)`
(prefers the injected `deps[method]`, otherwise `api.advanced[method]`), always
passing a fresh idempotency `requestId: makeId()` so a double-click never runs the
action twice. `fulfill-service` -> `fulfillService`, `fulfill-preorder` ->
`fulfillPreorder`, `cancel-preorder` -> `cancelPreorder`, and both
`resolve-theft-success`/`resolve-theft-failure` -> `resolveTheft` with a **typed**
boolean `success` (`true`/`false`), which `resolveTheft` requires. The outcome is
reported truthfully through `_noticeForAdvancedAction` (a replay/fulfilled/
committed/cancelled status is success; a `needsRecovery`/`pending` status surfaces
a recovery warning; an `error` status surfaces the error). After an action the
manager refreshes **orders only** via `_refreshOrdersOnly`, never the shop, so an
unsaved appearance draft and in-progress inventory row edits survive. On
`_refreshData`, the selected shop's inventory is projected through
`_projectInventoryAccess` to expose a comma-joined `accessActorUuidsText` for GM
display, and the advanced-order list is loaded best-effort through
`_listAdvancedOrders` (active-GM gated; a failure or a non-active GM leaves the
list empty).

**Advanced-order paging & scope.** Because only `booked` orders are actionable,
`_refreshOrdersOnly` requests `status: 'booked'` at the 100-record page size and
tracks the current `_data.orderPage` (started at 0 on `_refreshData`), deriving
`hasPreviousOrders`/`hasNextOrders` to gate the template's `next-orders`/
`prev-orders` controls. The template reads the order kind as `order.kind` (the
`{{#each advancedOrders as |order|}}` block param) and only offers action buttons
for the actionable kinds - `service`, `preorder` and `theft`. The manager never
shows an order button for a `cart` record, and each button's disabled guard
references `../isActiveGM` to step out of the `{{#each}}` scope (the shadowed
`isActiveGM` is undefined inside the loop and would wrongly disable a button for
the active GM). If a GM resolution empties the current page,
`_refreshOrdersOnly` steps back to the prior non-empty page rather than leaving the
GM on an empty page with no controls.

### Known limitations (M5)

- **The "group cart" is a single payer.** `checkout` debits ONLY the request
  `actorId`; there are no shared participant contributions and no split payments.
  A group cart is treated as a single payer accumulating a shared selection until
  an explicit cost-sharing / consent model exists - **no other contributor is
  charged** (see the cart checkout section).
- **Services are fulfilled manually.** A bookable `shop.commerce.services[]` entry
  has NO automatic mechanical effect: `book` debits the player once and grants
  finite merchant funds the price, leaving the order `booked`; it never
  delivers/creates an `Item`, and completion happens only when a GM calls
  `fulfill`, which records the acknowledgement. Neither path delivers, creates, or
  removes an `Item` - a service booking must never produce a "fake item".
- **Theft is GM-adjudicated.** A theft claim has NO effects and NO automatic
  system-skill roll: `attempt` records an `awaiting-gm` order (no delivery, no
  stock change, no currency move), and the GM's `resolve` (a typed `success`
  boolean) grants or refuses ONE unit. There is NO arithmetic check, NO automatic
  reputation penalty, and NO skill API call.
- **No map marker travel relocation (M4).** M4 travel rotation changes only the
  shop's logical `locationId`; the Scene Note / canvas marker stays where the GM
  placed it.
- **Generic path-delivery item selling/barter is unsupported.** Both the
  whole-item sale and the cart barter tender delete an embedded `Item`, so a
  GenericAdapter configured for non-embedded path delivery is refused
  (`delivery-mode-unsupported`).
- **No live M5 verification yet.** The M5 services, the manager commerce editor
  and advanced-order adjudication, and the storefront advanced trade controls are
  wired and Node-tested only; none has been run against a live Foundry VTT 14
  install. Merchant `commerce.funds` are live, not a deferred quota: an M1
  direct Buy and the advanced cart/service/preorder paths gain the collected
  currency in the same shop patch, and a whole-item sale decrements finite funds
  (`null` funds stay unlimited, no funds patch written).
- **The local shop lock is not cross-GM atomic.** The per-shop `runShopExclusive`
  lock and every `createAdvancedOrder` (read-then-create, like `createLedger`)
  are per-client. Across two simultaneous GM clients - or a GM handover - both can
  read "no order" for the same key before either persists one, so both may create
  and both may apply effects. No cross-GM atomicity is claimed; verifying and
  hardening this against two live GM clients is deferred to M6 testing.
- **Valuation approvals are wired, with a GM UI and a player-visible gate only
  Node-tested.** The M6 GM-authored per-Item valuation module
  (`src/advanced/valuation.js`) and the validated `shop.commerce.valuations` schema
  exist and are Node-tested, and `src/core/main.js` constructs the valuation service
  and injects its full-entry `getApprovedValuation` into the selling/cart services,
  so a player-owned Item is priced by the approved valuation, never its own system
  `price`. The manager `.valuation-panel` (reusing the reputation Character selector)
  lets the active GM approve an item valuation, and the storefront's sell/barter
  selects only offer whole items that the personalized catalog exposes in
  `shop.approvedItems` (showing the "Ask the GM to value an item before selling or
  bartering it." message when a character is selected and none is approved). None of
  this wiring has been run against a live Foundry VTT 14 install yet.

### M6 concurrency / recovery validation (`tests/multiplayer.test.js`)

The module deliberately does **not** claim distributed/transactional atomicity.
The per-shop `runShopExclusive` lock and every read-then-create guard
(`createLedger`, `createAdvancedOrder`) are **per-client**: a lock map lives on a
client, so two GM clients never share one, and two clients resolving the same
idempotency key can both observe "no record" before either persists one. The
ledger/advanced-order idempotency is best-effort, the single cross-client guard,
and it is keyed `userId:requestId` (never a server-side compare-and-swap). This
slice exposes those boundaries as deterministic, Node-testable assertions rather
than a flaky live-race probe.

**Test harness.** `tests/multiplayer.test.js` drives the real market services
(commerce purchase, cart checkout, selling, preorders, theft, automation) through
a single unified fake store (`createUnifiedStore`) that supports shops, ledgers
and advanced orders and exposes `listShops`/`listLocations`/
`listAdvancedOrders`. It carries fault-injection flags (`fail`/`null`/
applies-then-throws) and optional `hooks.beforeCreateLedger`/
`hooks.beforeCreateOrder` gates used to force a read-then-create interleaving.
A shared single `lockMap` is injected into commerce and wrapped for the
cart/automation/adjudication services so every writer on one shop serializes;
separate lock maps simulate two independent GM clients. The harness routes every
writer through the same `runShopExclusive` (or a queued gate) and an
authenticating `isActiveGM` predicate.

**Single-shop oversell/debit invariants.** The per-shop lock only ever serializes
concurrent writers; it cannot itself prevent oversell or double-debit on one
client. Under the shared lock, 50 simultaneous purchases on a finite stock of 30
commit exactly 30 and fail exactly 20 as `insufficient-stock`, with no negative
stock and exactly 30 debits. A 50-op mix of 20 purchases, 20 cart checkouts and 10
idle automation runs under the same lock charges exactly the sold units once,
never double-debits or loses a stock update. Both are aggregate assertions - the
exact subset that commits is scheduler-dependent, but the totals are
deterministic - so the test is never flaky.

**Two independent shops.** Separate shop ids get separate locks; interleaved
purchases into shop1 and shop2 each see their own wall count and funds, never
cross-contaminating the other shop's stock or revenue.

**GM handoff at an await boundary.** The active-GM predicate is re-checked after
every await boundary, not only before entry. An operation queued behind another
writer (its `runShopExclusive` gate is still held) that then observes the GM
handed off resolves cleanly with no stale write: a sell returns `not-active-gm`
with no payout/listing, a cart checkout returns `not-active-gm` with no charge/
order, and an automation run returns `idle` with no `updateShop`. No half-applied
write is left behind.

**Replay / pending / needsRecovery across request ids.** Re-issuing the same
request cannot redo preorder or theft effects. A replayed preorder place and a
replayed theft attempt resolve to `replay`/`needsRecovery` with no second debit
and no second order; a persisted order mutated to `needsRecovery` (simulating an
interrupted run) also resolves with no re-debit. A competing preorder fulfill/
cancel issued under a distinct `requestId` while a pending fulfill action already
exists for the same original surfaces `needsRecovery` and never runs, leaving the
original `booked`. The idempotency key is not the only guard - the recorded
status of the existing order is re-read and respected.

**Applies-then-throws recovery.** An injected `updateShop` that applies its patch
and then throws is recovered (recorded `failed`, the wallet refunded, the applied
write restored) and is never reported as a clean success. An injected ledger
commit that applies-then-throws is resolved as `committed` (the debit is kept,
stock stays decremented), because the service re-reads the persisted terminal
status rather than trust the throw. An injected advanced-order commit that
applies-then-throws is likewise recovered via a re-read and reported `committed`,
and a replay of that order never re-debits.

**Multi-GM race boundaries.** Two independent commerce instances (separate lock
maps) on the same fake store never double-charge: the fake store's read-then-
create is atomic in JS (no `await` between the existence scan and the insert), so
the losing client observes `created:false` and never charges - one side commits,
the other surfaces `pending`/`replay`. Because the real JournalEntry store is not
compare-and-swap, a `hooks.beforeCreateLedger` barrier forces BOTH
`createLedger` calls to observe "no record" before either inserts; both return
`created:true` and both charge, reproducing the documented multi-GM double-charge
window deterministically (both `committed`, wallet debited twice for the same
key).

No distributed or transactional atomicity is claimed by any of this: the
aggregate invariants hold because the per-shop lock serializes within a client,
and the one cross-client guard (ledger/advanced-order idempotency) stays
best-effort. The gated interleaving test is the only place the module admits the
double-charge window, and it is reproduced on purpose, not hidden.

## M6 accessibility (keyboard focus, contrast, reduced motion)

The M6 slice hardens the module CSS (`styles/market.css`) for keyboard and
low-vision users. There is no automated a11y test; the verification surface is
the manual keyboard / screen-reader checklist in `docs/smoke-test.md` (M6
section).

- **Keyboard focus is always visible.** Every interactive element - the native
  `button`/`input`/`select`/`textarea`/`a` and the catch-all `[tabindex]` - gets a
  visible `:focus-visible` outline (3px solid, with an offset and a dark halo) on
  both the light manager and the dark storefront, so a keyboard user can always
  see where focus is. Custom controls that hide the native input (the
  `.market-check` box, the `.weekday-option` and the product/entry card surfaces)
  expose their own `:focus-visible` companion styles rather than relying on a
  native outline.
- **Contrast is checked.** The palette keeps text readable on both surfaces - the
  high-contrast light manager (`--mk-ink #29251f` on `--mk-paper #f3eee2`) and
  the dark storefront (`#f4eedf` on `#272821`) - and custom controls
  (`.market-check`, `.weekday-option`) have explicit focus/checked states rather
  than a native UI that can be indistinct. The `.backup-panel` controls get their
  own readable focus outline.
- **Reduced motion is honored.** Both the `.preview-panel` transition/animation
  and the global `@media (prefers-reduced-motion: reduce)` rule disable
  transitions/animations (and set `scroll-behavior: auto`), and the per-app
  `.motion-off`/`.motion-subtle` variants let motion be turned down or off. A user
  who prefers reduced motion therefore never sees the decorative hover/
  animation effects.

## M6 offline performance benchmark (example, machine-dependent)

`scripts/benchmark.mjs` is an **optional, manual** performance report for the pure
Foundry-free work at large inventory sizes: `normalizeShop`, `buildCatalog` and
`planAutomation`. Run it with `npm run benchmark` or
`node scripts/benchmark.mjs [entryCount]`. It warms up then runs 100 measured
iterations per workload and prints a median / p95 (ms) report plus the entry
count to stdout. It never writes files and never touches the store, runtime or
UI.

Two things are deliberately **not** promised:

- The printed numbers are **example timings on the machine they were run on**.
  They are wall-clock seconds measured under whatever CPU/load that machine had,
  not a spec and not a CI gate - do not read a specific millisecond value as a
  guarantee, and never gate CI on them.
- There is **no live Foundry VTT 14 profile yet**. The benchmark exercises the pure
  Node functions only - not the real `game`, `JournalEntry` store, application
  renders (RAF), or the request channel - so it is not a measure of in-game
  performance against a real Foundry install. Those numbers would come only from
  profiling on a live runtime.

What actually matters is the deterministic O(N) guarantee, which is asserted in
`tests/performance.test.js`: at 1000 entries the normalized output is bounded and
the public catalog is allowlisted and leak-free, and `planAutomation` scales
linearly (array-read counts, not wall-clock). That test's only wall-clock
assertion is a very generous 10 s catastrophic-regression guard, so a slow or
loaded CI never flips a test that is merely measuring O(N) scaling.
`package.json`'s `lint` runs `node --check` on `tests/performance.test.js` and
`scripts/benchmark.mjs`, and `npm run benchmark` is the optional manual timing
check.
