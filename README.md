# Foundry Market

A marketplace core module for Foundry Virtual Tabletop v14. Locations, shops and
inventory are stored in GM-only JournalEntry flags; purchases are executed only
by the active GM through an idempotent, compensating ledger; and requests flow
over ChatMessage (no raw socket).

This is a **prerelease developer preview** covering **Milestone 1 (M1)** through
**Milestone 6 (M6)**, all **implemented locally and unit-tested in Node but not
yet verified against a live Foundry VTT 14 install**. It delivers the functional
core plus the M1 end-to-end UI wiring (market manager, player storefront, canvas
shop markers), the M2 shop theming/appearance and storefront interactions, the M3
social/NPC/reputation engine and wiring (user-reported as tested successfully,
though its deferred items remain), the M4 shop automation (scheduled business
hours, finite periodic restock, travel rotation among locations, exact/low/hidden
stock visibility, time-window display-only market events, GM automation
diagnostics, and GM-only RollTable inventory generation), the M5 advanced
commerce configuration and GM-authoritative trade services - whole-item
sell/buyback, manual service booking, single-payer multi-line carts with an
optional whole embedded barter Item, finite merchant funds, backroom
actor/reputation access, deposit-backed out-of-stock pre-orders, GM-adjudicated
theft, and actor special offers - and the M6 dynamic dnd5e currency conversion,
the DC20/Twodsix first-class system adapters, a portable GM-private backup and
the deterministic concurrency/recovery + benchmark/accessibility review. The
runtime has **not** been executed against a live Foundry VTT 14 install yet - it
is wired and unit-tested in Node only, and M5/M6 are likewise Node-tested only
(see "Risks" for what is still deferred and what a real v14 runtime must
confirm).

## Requirements

- Foundry VTT **14** (minimum, verified and maximum are all `14`).
- No dependencies on any game system or other module.
- Node >= 22 only if you want to run the offline tests (`npm test`).

## Install / load

This is a **prerelease developer preview** distributed as a standard Foundry
add-on module zip. There is no build or transpile step - the manifest ships
`src/core/main.js` as the ESM entry and the browser loads the ESM directly. A
`npm run build` step only packages the release zip; it does not transform the
runtime source.

### Install via the module manifest (recommended)

1. On the Foundry **Setup** screen, open **Add-on Modules**.
2. Click **Install Module** and paste the **manifest URL**:

   ```
   https://raw.githubusercontent.com/sepffuzzball/foundry-market/main/module.json
   ```

   Foundry reads the manifest, which pins module id `market`, version `0.1.11`
   and the **download URL** it uses to fetch the module zip:

   ```
   https://github.com/sepffuzzball/foundry-market/releases/download/0.1.11/module.zip
   ```

3. Install, then enable the `market` module in the target world.

> **`0.1.8` was published as a patch prerelease** (it corrected the dnd5e
> currency conversion interpretation and sanitized the purchase failure
> reporting, after `0.1.7` failed a live dnd5e purchase with
> `balance-read-failed` because `Dnd5eAdapter` misread
> `CONFIG.DND5E.currencies[d].conversion` - which is **UNITS PER GP** (e.g.
> `cp.conversion === 100`, `gp.conversion === 1`) - as a GP-per-unit value).
> **`0.1.9` was published** and added the Ledger folder organizer (see "Ledger
> folder organization" below).
> **The `0.1.9` live dnd5e retest looked like a failure but was diagnosed as a
> stale browser-loaded adapter module, not a code bug**: the previously imported
> `Dnd5eAdapter` in the browser was a cached older module that still used the
> pre-fix factors (the old `0.1`/`100` reading), while a fresh, cache-busted load
> of the current adapter succeeded. So the published / server code for `0.1.9` is
> correct - the retest hit browser/Foundry module caching, not a
> `balance-read-failed`. After any update, **hard-refresh / reopen ALL Foundry
> tabs and clients** (not just the one that looks stale) and then perform a
> **NEW purchase** rather than trusting an attempt made by the previously cached
> adapter. The dnd5e conversion fix is carried forward into `0.1.11` but still
> needs a valid live retest (the `0.1.9` attempt was invalidated by the cache -
> see `docs/smoke-test.md` section 22).
> **The `0.1.10` prerelease was published** and adds the GM-readable purchase ledger
> pages (see "Ledger summary page" below): each GM-private purchase-ledger
> journal gains a module-owned `Purchase summary` text page with the status /
> attempted buy / quoted copper price (or `Not quoted`) / failure reason and
> diagnostic `detail` / compensation / timestamps, with the diagnostic never sent
> to players. Existing ledger journals are backfilled with a summary page by the
> active GM's `ready`/GM-handover sweep; that sweep only reads and renders - it
> never replays or re-executes an old transaction, so an old failed purchase is
> left exactly as recorded and never charged again, and the diagnostic `detail`
> lives only on the GM-private page/record (never in player chat). It does **not**
> claim a live purchase/folder/page success by itself - the real-
> runtime confirmation is `docs/smoke-test.md` (see the adapter-cache and
> ledger-page sections). The `0.1.10` `download` URL is live (the release action
> uploaded `module.zip` and `module.json` to the GitHub release for tag
> `0.1.10`). **Diagnosing a
> purchase failure:** the per-user purchase ledger Journal
> (`Ledger:<user>:<requestId>`, created by the default store) is the expected
> **GM-private** audit/idempotency record - one per request - not an extra sale
> and not a bug. Check that journal's `error`/`detail` fields rather than treating
> each `Ledger:` entry as a spurious transaction.
> **The prospective `0.1.11` patch prerelease** adds the M6 dnd5e storefront
> display-only **`>1 gp` formatting**: for dnd5e the player storefront renders an
> entry price strictly above one gold piece as an exact decimal gp string (50000
> cp -> `'500 gp'`, 101 cp -> `'1.01 gp'`) and every other amount stays in copper
> (100 cp -> `'100 cp'`, 0 cp -> `'0 cp'`), through the exported
> `formatDnd5eDisplayPrice(copper, config?)` formatter. The conversion is
> **display-only** and data-driven through the same validated
> `CONFIG.DND5E.currencies` / `opts.currencyConfig` factors: the raw numeric
> `price`/`total` fields, the request payloads, the sort order and the ledger /
> copper arithmetic are never changed, so **the amount a player is charged and the
> amount a GM typed are unchanged** by the rendered label. The rendering is
> **offline / Node-tested only** (covered by the automated `npm test` suite); a
> live Foundry VTT 14 confirmation is **still pending** - the intended real-runtime
> check is `docs/smoke-test.md` section 22.4, including a live retest of an entry
> named e.g. **Banded Mail at 50000 cp rendering as `'500 gp'`** and the boundary
> cases **100 cp staying `'100 cp'`** and **101 cp rendering `'1.01 gp'`**. This
> patch prerelease is **prospective until the `0.1.11` tag is published**: the
> `0.1.11` `download` URL is live only once the release action uploads
> `module.zip` and `module.json` to the GitHub release for tag `0.1.11`. Until
> then, install the module by pointing Foundry at this repository directory as a
> module source, or from the published `0.1.10` release. It does **not** claim to
> replace the user's prior live purchase/folder/page success - those are recorded
> separately in `docs/smoke-test.md` (sections 7, 23.1-23.6, 26) and remain
> valid; only the live dnd5e `>1 gp` storefront rendering is still pending.

### Enable in a world

Open **Settings > Manage Modules**, tick **market**, then **reload the world**.
On load, `game.modules.get('market').api` is exposed with `store`, `commerce`,
`getAdapter`, `request`, `openManager`, `openShop`, `placeShop`,
`registerTheme`.

### Open the GM Market Manager

Open **Settings > Module Settings** and select the **Market** menu entry (the
module registers a settings menu), or use the Journal sidebar Market button, or
run:

```js
game.modules.get('market').api.openManager();
```

### Create a shop/Item and place a scene marker

1. In the Market Manager, create a **location** and then a **shop** under it.
2. Add an **inventory entry** to the shop: add an Item by UUID, via the
   searchable world/compendium picker, or by drag-dropping an Item onto the
   shelf. Set the entry's **price**, **quantity**, **stock mode** and
   **visibility**.
3. To let players reach the shop from the map, **drag the shop element onto the
   scene** (or use "Place shop"). This creates a public marker JournalEntry plus
   a Scene Note. Clicking the Note opens the player storefront for that shop.

### Player actor purchase

1. A player who **owns an Actor with funds** clicks the scene marker (or runs
   `game.modules.get('market').api.openShop(shopId)`).
2. In the storefront, select the owned Actor, choose an entry and quantity, then
   **Buy**. The active GM executes the transaction and whispers the result; the
   actor's wallet is debited, the item is delivered, and the shop's stock
   decrements.

### Ledger folder organization

The default store keeps **one GM-only JournalEntry per purchase ledger record**
(`Ledger:<user>:<requestId>`) in GM-only JournalEntry flags. To keep that
private audit/idempotency journal manageable, the module automatically files
each ledger journal into a single **`Market Ledgers`** root folder under the
Journal directory, with one child per status:

- `Market Ledgers > Success` - a `committed` ledger record.
- `Market Ledgers > Failure` - a `failed` ledger record.
- `Market Ledgers > Pending` - a `pending` ledger record.
- `Market Ledgers > Needs Recovery` - a `needsRecovery` ledger record.

The **active GM** (re-checked before every folder read/create/move) creates the
root/child hierarchy lazily as ledger journals are written, moves each journal
into the child matching its **current** persisted status, and reruns a bounded
sweep over every ledger journal on the active GM's `ready` and on a GM handover
to this client - so an un-filed ledger journal (including a legacy/schema-v0
one) is recovered rather than lost. Folders are located by document type + exact
`flags.market.ledgerRole` + exact parent id, never by name, so renaming a child
or creating an unrelated folder named `Market Ledgers` does not break placement.

The folder organizer is **scoped strictly to ledger journals**: it only ever
moves a journal's `folder` field, never deletes a ledger journal, never changes
its record/status/idempotency, and never touches the marker/shop/reputation/
advanced-order journals - so the `Market Ledgers` hierarchy never hides or
reorganizes unrelated journals. Ledger data is preserved and stays **GM-only**
(`ownership: { default: 0 }`). The placement is **best-effort and never
awaited**: `createLedger`/`updateLedger` fire it as a detached task after the
flag write, so a folder create/move that never settles or throws can never delay
or fail a persisted ledger write; an un-filed journal is recovered by the
startup/handover sweep instead.

### Ledger summary page

To make the GM-side audit trail readable without probing the raw JSON, each ledger
journal also carries a module-owned **`Purchase summary`** text page (a
`JournalEntryPage` of type `text`, flagged `flags.market.ledgerSummary: true`)
rendered by the active GM when the journal is written. The page shows the attempt
status, the item/actor/shop names and ids, quantity, the quoted unit/total in
copper (or `Not quoted` for a pre-quote failure), the reason code and diagnostic
detail on a failure, any compensation, and created/updated timestamps. All
dynamic data is escaped and bounded, the raw `payload`/`outcome` objects are
never dumped, and an unknown shop/actor/item falls back to its stable id. The
diagnostic `detail` string is bounded (max 500 chars) and is **never** sent to
players - the public purchase response exposes only the safe error code.

The summary is **best-effort and never awaited**, exactly like the folder
placement: a page create/update failure is logged and never fails the ledger
write, writes are serialized per journal so a committed update always re-renders
over a stale pending page, and only the module-owned page is ever touched (a GM
page added to the same journal is never replaced). The startup / GM-handover
sweep backfills a summary page for any existing journal that lacks one, but that
sweep only reads and renders - it never replays or re-executes the transaction,
so an old failed purchase stays exactly as recorded and is never charged again.
The diagnostic `detail` is written only to the GM-private page and ledger record
- never into a player chat/response, which exposes only the safe error code.

### Setup examples

**dnd5e** - the built-in adapter. Currency is integer copper and item prices are
read from `system.price.value`/`denomination`, so no configuration is needed
beyond Items whose price is set. Since M6 the conversion is **data-driven**: the
adapter reads the live `CONFIG.DND5E.currencies` (or an explicit
`opts.currencyConfig`) and treats each denomination's `conversion` as UNITS per
gold piece (e.g. `cp.conversion === 100` means 100 copper = 1 gp), deriving the
per-denomination copper factor as `conversion.cp / conversion[d]` using exact
BigInt rationals - never binary float rounding - so a GM-configured exchange rate
is honoured while every existing integer-copper record reads/writes unchanged.
A config whose ratios do not resolve to whole copper pieces fails closed before
any wallet write.

```js
game.modules.get('market').api.getAdapter('dnd5e'); // supported
```

**dc20rpg** and **twodsix** - first-class adapters selected automatically by
system id. `dc20rpg` uses `system.currency.{cp,sp,gp,pp}` and
`system.price.value/currency` (default `gp`); `twodsix` (Traveller) uses the
numeric `system.financeValues.cash` and item `system.price` in credits. Neither
needs configuration, and they ignore the generic path settings. Each is written
against the documented system schema and validated with **offline fixtures** (a
source-backed adapter for dc20rpg 0.10.7.0 and Twodsix 7.7.0); the live runtime
field access is **not yet verified against a real system install**.

```js
game.modules.get('market').api.getAdapter('dc20rpg'); // supported
game.modules.get('market').api.getAdapter('twodsix');  // supported
```

If you need custom (non-first-class) behavior for one of these systems, opt into
the configurable fallback explicitly with `getAdapter('generic', config)`; the
generic paths are never applied to a first-class system adapter.

**generic** - the configurable fallback. Configure the world-scoped settings
under `market` before use (wallet/price dot-paths, delivery mode):

```js
game.settings.set('market', 'genericWallet', 'flags.wallet.balance');
game.settings.set('market', 'genericPrice', 'system.price.value');
game.settings.set('market', 'genericDeliveryMode', 'embedded');
```

**daggerheart** - Daggerheart carries **no native item price**, so the module
never guesses a price path. The `daggerheart` adapter is an explicitly
unsupported generic subclass and reports `supported === false` until you
configure the generic wallet/price/delivery paths (above). Once configured it
reports support and the storefront can transact, using only the GM-configured
generic path - never an invented one.

### Risks

- **Live Foundry VTT 14 runtime is not yet tested.** M1/M2/M3/M4/M5/M6 are wired
  and unit-tested in Node only (the mocks install `game`/`Hooks`/`CONST`,
  `JournalEntry` and the actor document API), so the exact
  `ApplicationV2`/`HandlebarsApplicationMixin` UI, the `dropCanvasData` hook
  shapes, the v14 `FilePicker` constructor, the
  `foundry.audio.AudioHelper.play` call, the `updateWorldTime` automation sweep,
  the RollTable `drawMany` call, the M5 advanced-order request/response flow, the
  live DC20/Twodsix/Daggerheart adapter field access, the backup import
  store writes, the ledger folder organizer's live `Folder.create`/move and the
  GM-only ledger summary page's live `JournalEntryPage` create/update
  should be re-checked against a real v14 install. Run
  `docs/smoke-test.md` before trusting a live economy. The M2 CSS themes and
  interactions are Node-tested only, and the themes ship no bundled audio.
  **No live M5/M6 verification has been done yet** - the M5 services/UI and the
  M6 dynamic conversion, the DC20/Twodsix adapters, the M6 key/focus/reduced-motion
  accessibility CSS and the M6 portable backup manager panel are Node-tested only.
- **Concurrency across GMs is best-effort.** The per-shop lock serializes
  purchases within one client only; across multiple GM clients the ledger is the
  only cross-client guard and it is a read-then-create, not a server-side CAS.
  Under a GM handover or concurrent multi-GM processing both clients can charge.
- **No live use yet.** The module has been exercised in tests only; the smoke
  checklist is the intended first real-runtime check.

### Explicit limitations

- **The "group cart" is one payer.** There are no shared participant
  contributions and no split payments: only the request `actorId` is ever
  debited, a group cart is a single payer accumulating a shared selection, and
  no other contributor is charged.
- **Services are fulfilled manually.** Booking a service debits the player once
  and grants finite merchant funds the price, then records a `booked` order; it
  never delivers/creates an `Item` and never auto-completes - the GM must call
  `fulfill` to mark it `fulfilled` (an acknowledgement only).
- **Theft is GM-adjudicated.** A theft claim records an `awaiting-gm` order with
  no effects; there is no automatic system-skill roll, no automatic reputation
  penalty, and no item is granted until the GM's `resolve` decides success.
- **No map marker travel relocation.** M4 travel rotation changes only the shop's
  logical `locationId`; the Scene Note / canvas marker stays where the GM placed
  it.
- **Generic path-delivery item selling/barter is unsupported.** An item sale and a
  cart barter tender both delete an embedded `Item`, so a GenericAdapter
  configured for non-embedded path delivery is refused
  (`delivery-mode-unsupported`).
- **No live M5/M6 verification.** See the first Risks bullet.
- **The local shop lock is not cross-GM atomic.** Cross-GM atomicity is
  best-effort; the deterministic Node concurrency/recovery suite reproduces the
  documented double-charge race on purpose, but it is **not** a distributed
  guarantee - verifying and hardening it against two live GM clients is still open.
- **Daggerheart requires explicit generic config.** Daggerheart has no native
  item price, so the `daggerheart` adapter stays `supported === false` until you
  configure the generic wallet/price/delivery paths; no price path is guessed.
- **DC20/Twodsix live field access is unverified.** The DC20/Twodsix adapters and
  the generic-fallback paths are validated against **offline fixtures**; the real
  system install field access has not been exercised on a live Foundry VTT 14
  runtime yet.
- **Schema-v0 Journal data is not auto-migrated.** The M6 portable backup
  migration rewrites only the backup file's own `version: 0` payload to v1
  (`BACKUP FORMAT` migration). A pre-existing market JournalEntry carrying the
  older `schemaVersion: 0` is not rewritten in place - it is simply not
  enumerated, so any such journal is not auto-migrated.

## What works (M1/M2/M3/M4/M5/M6)

- **UI (wired, not system-tested)**:
  - **Market Manager** (`MarketManager`, GM-only): create/select locations and
    shops, edit shop details and inventory, add items by UUID or via a
    searchable world/compendium picker, drag-drop Items onto the shelf, edit
    quantity/price/stock mode/visibility, remove entries, place a canvas marker
    and open a player preview. Opened from the Journal sidebar button, the
    Settings > Market menu, or `game.modules.get('market').api.openManager()`.
  - **Manager M2 additions**: the manager also edits the shop's theme and
    appearance (owner portrait, background image, accent color, typography,
    density, animation, music, sound effect, welcome message) from the fixed
    8-theme registry, previews the change against the unsaved form before saving
    (never persists), clears the preview on location/shop switch, and browses a
    local media file with the official v14
    `foundry.applications.apps.FilePicker` (audio for music/sound effect, image
    otherwise). A chosen media path is captured into the unsaved draft and
    invalidates any stale preview, so the selection survives an inventory-action
    re-render and can be saved; an invalid picked path is rejected with a notice
    and never erases the previous valid path. Invalid media/accent values surface
    a notice without writing to the store. The inventory rows expose
    `publicDescription`, `category` and `rarity`, saved under the same per-shop
    lock; added items default these to empty (the item system description is not
    auto-exposed).
  - **Player Storefront** (`MarketStorefront`): requests the catalog through the
    request channel, correlates the response by `requestId`, only trusts
    GM-authored responses, never reads the private store, offers only actors
    the player owns, and disables purchase while there is no active GM / the
    request is pending / the shop is closed / an entry is out of stock.
    Opened via `api.openShop(shopId)` or by clicking a canvas marker.
  - **Storefront M2 additions**: the catalog view is derived from the visible
    public inventory with category tabs (All + every distinct category), search
    by name/category/rarity/description, sorting by featured/name/price, and an
    inspectable item detail panel (click or Enter/Space) that only tracks an
    entry that is in the current catalog. The player can toggle background music
    on (played locally via `foundry.audio.AudioHelper.play`, never over the
    socket, and stopped on toggle-off/close/catalog change/error) and a one-shot
    purchase `soundEffect` plays only when sound is enabled and the path is
    valid. The purchase quantity is bound to state (defaults to `1`) and is
    retained across search/sort/filter/detail re-renders, so it is never reset
    while the player is browsing; a purchase validates it as a positive safe
    integer and rejects an invalid value rather than silently flooring. The
    storefront sizes itself to the full viewport after first render (no browser
    Fullscreen API permission request) and cleans up its resize handler on close.
    The M1 purchase flow is unchanged.
  - **M3 UI additions (manager + storefront)**: the social/NPC/reputation wiring.
    The manager persists shop social settings from `.social-panel`
    (`normalizeShopSocial`, weights must sum to 100, shop markup is a signed
    basis-point integer), manages a merchant roster capped at three (add persists
    immediately under the per-shop lock; save validates each row; remove never
    deletes the shop), and exposes a GM-only reputation editor that loads the
    selected actor's effective reputation plus committed history and calls the
    GM-only `reputation.adjust` with a fresh idempotency `requestId`. The
    storefront requests a personalized per-actor catalog (sending `actorId`,
    auto-selecting the initial actor, clearing per-actor data on switch,
    correlating the response by `requestId` + echoed `actorId` so a stale-actor
    response is discarded), refuses a `canBuy false` (Hated) entry in
    `_requestPurchase`, maps a `service-refused` error to a readable message, and
    derives display-only `priceLines` and a `relationship.modifierText` from the
    public response - never leaking private store data. The M1 purchase flow and
    the M2 layout/themes are unchanged.
  - **Canvas markers** (`src/canvas/placements.js`): dragging a shop element
    onto the canvas (or clicking "Place shop") creates a public marker
    JournalEntry (default OBSERVER) plus a Scene Note with no private store
    data. Clicking the marker opens the storefront; a stale marker for a deleted
    shop reports the missing shop. `registerPlacements` wires `dropCanvasData`
    and `activateNote`.
- **Store** (`game.modules.get('market').api.store`): create/update/list
  locations and shops, add inventory entries, look up a shop, and access the
  purchase ledger. All persisted in GM-only JournalEntry flag data. Records are
  normalized and validated to safe integer minor units.
- **Ledger folder organizer** (`src/storage/ledger-folders.js`): the active GM
  lazily creates a single `Market Ledgers` root under the Journal directory with
  `Success`/`Failure`/`Pending`/`Needs Recovery` children and files each
  GM-private ledger journal into the child matching its current status, moving
  an existing ledger journal on a status change and rerunning a bounded sweep
  over every ledger journal on the active GM's `ready`/GM-handover (recovering
  un-filed legacy journals). Folders are located by role + parent id, never by
  name; the organizer only ever moves a journal's `folder`, never deletes a
  ledger journal, never alters its record/status/idempotency and never touches
  the marker/shop/reputation/advanced-order journals (so it never hides
  unrelated journals). It is best-effort and never awaited, so a folder
  create/move failure cannot block or fail a persisted ledger write.
- **Ledger summary page** (`src/storage/ledger-summary.js`): a GM-only, readable
  HTML summary of each purchase attempt, maintained as a module-owned
  `Purchase summary` text page (`JournalEntryPage` of type `text`, flagged
  `flags.market.ledgerSummary: true`) on the ledger journal. Renders status /
  attempted buy / shop / quantity / quoted copper unit-total (or `Not quoted`) /
  reason + bounded diagnostic `detail` on failure / compensation / timestamps,
  with all dynamic data clipped and escaped, the raw `payload`/`outcome` never
  dumped, and unknown names falling back to stable ids. The `detail` string is
  bounded (max 500 chars) and is never exposed to players. The sync is
  best-effort and never awaited (guarded on `typeof docAccess.syncLedgerSummary`),
  serialized per journal so a committed update always wins over a stale pending
  render, and never fails the ledger write; the startup / GM-handover sweep
  backfills a summary for any existing journal, and a GM page on the same journal
  is never replaced.
- **Commerce** (`api.commerce`): `purchase({shopId, entryId, actorId, quantity,
  requestId}, authenticatedUserId)` - GM-only. Re-reads fresh data, validates
  open/visible/stock/funds, records a `pending` ledger entry before charging,
  then charge -> deliver -> decrement stock -> commit, with best-effort
  compensation. Ledger idempotency is keyed on `userId:requestId` and rejects
  conflicting duplicate payloads. Per-shop queue serialization prevents stock
  races within one client. Across multiple GM clients the queue is per-client, so
  the ledger is the only cross-client guard and it is best-effort, not a
  distributed guarantee: `createLedger` is a JournalEntry read-then-create (not a
  server-side CAS), and never charges whenever it reports the idempotency key
  already existed. Under a GM handover or concurrent multi-GM processing both
  clients can read "no record" before either persists one and both charge,
  which may oversell stock or double-debit a wallet - a known M1 caveat. The
  module does **not** claim atomicity - compensation is best-effort and a
  `needsRecovery` ledger entry flags anything requiring manual checks.
- **Adapters** (`api.getAdapter(systemId, opts)`):
  - `dnd5e` - supported. Currency is converted to integer copper
    (`cp/sp/ep/gp/pp`); item price comes from `system.price.value/denomination`.
  - `dc20rpg` - supported, source-backed against dc20rpg 0.10.7.0. The wallet is
    `system.currency.{cp,sp,gp,pp}` in integer copper factors 1/10/100/1000 (no
    `ep`), item price comes from `system.price.value/currency` (default `gp`),
    and quantity is read/written on `system.quantity`.
  - `twodsix` - supported, source-backed against Twodsix 7.7.0 (Traveller). The
    numeric cash balance is `system.financeValues.cash` ONLY (never the
    `system.finances.cash` display string), item price is `system.price`, and
    credits are the single currency unit with no conversion.
  - `generic` - configurable fallback. You (GM) configure dot-paths for the
    wallet and item price plus a delivery mode. Until configured it reports
    `supported === false`.
  - `daggerheart` - explicitly reports **unsupported** until you configure the
    generic adapter paths. Daggerheart has no native item price, so no system-
    specific price path is guessed.
  - Item delivery preserves the full `item.toObject()` minus `_id`,
    `ownership`, `folder`, `sort`, and never mutates the source item.
- **Requests** (`api.request(payload)`): send a `catalog` or `purchase` request
  as a ChatMessage whispered to the GMs. The active GM processes it through
  `Hooks.on('createChatMessage', (message, options, userId))` and whispers a
  response back to the requester and all GMs. Responses expose only allowlisted
  public shop fields and visible inventory fields - no item `system` data and no
  `itemUuid`.
- **M4 shop automation** (GM-only, opt-in; `api.automation` plus the manager
  automation editor and the active-GM runtime tick):
  - **Business hours** (`automation.hours`): an `enabled` flag plus at most 7
    unique weekdays (day index 0..6, day 0 = Monday) and
    `openMinute`/`closeMinute` (0..1439). Equal open/close means a full-day
    opening and overnight windows are controlled by the opening day. The
    storefront and purchase path project `open`/`closedReason` from the
    weekday/minute grid; a purchase outside the declared hours fails closed as
    `shop-closed`.
  - **Finite scheduled restock** (per-entry `restock`): only a `finite` entry can
    carry a restock `{ enabled, target, intervalSeconds, anchorTime, lastCycle }`.
    The runner applies a single set-to-target (`quantity = max(current, target)`)
    that never reduces stock, advances `lastCycle` by exactly one due cycle, and
    performs no catch-up loop.
  - **Travel rotation among locations** (`automation.travel`): an `enabled` flag
    with 2..10 destination `locationIds`, an `anchorTime`, an `intervalSeconds`
    (3600..31536000) and a `lastCycle`. When a cycle is due the runner rotates the
    shop's `locationId` to the scheduled destination and advances `lastCycle`, so
    the shop trades from the rotated location. **The canvas marker is not
    automatically relocated** - only the shop's logical `locationId` changes; the
    Scene Note stays where the GM placed it. Once the merchant has arrived the
    projected `locationId`/`open` report the rotated destination (never the base
    place) for every outcome.
  - **Exact / low / hidden stock visibility** (`stockVisibility`): a per-entry
    `'exact' | 'low' | 'hidden'` mode. The public projection never leaks a true
    count in `low`/`hidden` mode (`quantity: null` plus `stockLabel`/`available`
    instead); `exact` keeps the true quantity.
  - **Time-window display-only market events** (`automation.events`): at most
    `MAX_AUTOMATION_EVENTS` (10) plain-text events with a title, description, a
    safe-integer start/end window and a `visible` flag. The public storefront
    projects only the visible **active** events as display-only
    `{id, title, description}`; they never alter pricing or the purchase gate.
  - **GM automation diagnostics** (`automation.diagnostics`): the runner records
    bounded per-shop diagnostics (`lastRunAt`, `lastStatus`, `lastError` capped at
    200 chars, `lastRestocked`, `lastLocationId`) read by
    `api.automation.getDiagnostics`; the raw shop record is never exposed.
  - **GM-only RollTable inventory generation** (`api.generateInventory`): draws
    Items from a world/compendium RollTable (`table.drawMany`) and appends them as
    finite, visible inventory entries via one atomic `store.updateShop`, capping
    the result, deduping against the live inventory, and reporting bounded
    add/skip/invalid/duplicate counters. Active-GM gated: a non-active-GM caller
    gets `not-active-gm` before any read/draw/write.
  - **GM-world clock semantics**: all M4 trading/automation decisions read the
    Foundry **world clock** server-side (`game.time.worldTime`), never a client or
    caller-supplied time. The relative clock is **not** the Unix epoch: day `0` is
    Monday 00:00, and a world time is floored to a safe integer second only when
    it is finite. An invalid clock (NaN/Infinity/non-safe) fails closed as
    `invalid-world-time` rather than collapsing to week zero, and no schedule
    executes.
- **M5 advanced commerce** (GM-only, opt-in; `api.sellItem` / `api.advanced` plus
  the manager commerce editor and the storefront advanced trade controls). The
  validated `commerce` config (finite/`null` merchant `funds`, `buyRateBps`,
  `buybackRateBps`, `services`, `specials`, `preorders`, `theft`) and the
  per-entry `access` gate are normalized by the schema; the advanced order
  record and the pure access/quotation policies live in `src/advanced/*`:
  - **Whole-item sell/buyback** (`src/advanced/selling.js`): a GM-authoritative,
    idempotent `sell` takes ONE whole embedded `Item` the player owns back to a
    shop, prices the payout at `quoteSell`, appends a `non-restocking` buyback
    listing and decrements finite merchant funds. A stacked (quantity != 1) item
    is refused.
  - **Manual service booking** (`src/advanced/services.js`): `book` debits the
    player once and grants finite merchant funds the price, persisting a `booked`
    order; the service has NO automatic effect - a GM later calls `fulfill`,
    which only records the acknowledgement (no `Item` is created/delivered).
  - **Single-payer multi-line cart checkout** (`src/advanced/cart.js`): a
    `checkout` executes a safe multi-item, single-payer cart - only the request
    `actorId` is debited (only the cash remainder is ever debited), each line is
    re-read from the store, merchant specials are honored per-line, and finite
    merchant funds gain only the cash remainder. An optional `barterItemId`
    tenders ONE whole embedded `Item` as credit capped at the cart gross total
    (a tender worth more than the cart never pays cash out).
  - **Merchant funds** (`commerce.funds`): `null` is unlimited; a finite integer
    is the shop's available buying currency, gained by direct-Buy revenue,
    services, preorder deposits, cart cash remainders and sell payouts, and
    decremented by buybacks and refunds. Overflow is guarded (`funds-overflow`).
  - **Backroom actor/reputation access** (`access` + `src/advanced/policy.js`):
    a per-entry `mode: 'public' | 'backroom'` gate, an optional actor allowlist
    and a `minReputation` are enforced on the catalog, purchase and quote
    surfaces (a `backroom` entry is omitted from the base catalog and only
    appears to an allowlisted or reputation-qualified actor).
  - **Preorders with paid deposit** (`src/advanced/preorders.js`): `place`
    charges a deposit (no stock is reserved), `fulfill` charges the remaining
    balance and delivers, `cancel` refunds the deposit. All three are
    GM-authoritative and idempotent.
  - **GM-adjudicated theft** (`src/advanced/theft.js`): `attempt` records an
    `awaiting-gm` order with no effects; the GM's `resolve` (a typed `success`
    boolean) grants or refuses one unit. There is no automatic system-skill roll
    and no automatic reputation penalty.
  - **Actor special offers** (`specials`): GM-configured price offers on an
    existing inventory `entryId`, each with an optional `actorUuids` allowlist,
    are projected into the catalog and can be quoted/charged per-line; an offer
    is exposed only to an eligible actor and never leaks the raw config.
- **M5 request routing** (`src/core/requests.js`, `src/core/main.js`): the
  request channel recognizes `sell`, `cart`, `service`, `preorder` and `theft`
  request types and projects each through a bounded public sanitizer - never the
  raw advanced-order record, the idempotency carrybacks, or the private
  `details`/`compensation`/`outcome`.
- **M6 dynamic dnd5e currency conversion** (`src/adapters/index.js`): the
  `Dnd5eAdapter` no longer hardcodes copper factors. It reads the live
  `CONFIG.DND5E.currencies` (or an explicit `opts.currencyConfig`) and treats
  each denomination's `conversion` as UNITS per gold piece, deriving the copper
  factor as `conversion.cp / conversion[d]` using BigInt rationals and exact
  decimal parsing (including scientific notation) - never binary float rounding -
  with safe-integer overflow detection and fail-closed normalization
  (a missing `cp`/`gp`, a non-finite/non-positive or fractional-copper factor
  throws before any wallet write). The legacy `DENOMINATIONS`/
  `DENOMINATION_FACTOR` exports and the canonical default that reproduces the
  legacy factors are preserved, and `dndCurrencyFactors`/`formatCopperAsGP` are
  exported for callers.
- **M6 storefront dnd5e price display** (`src/ui/storefront.js`,
  `templates/shop.hbs`, `src/adapters/index.js`): for dnd5e the player storefront
  now renders an entry price strictly above one gold piece as an exact decimal gp
  string (e.g. 50000 cp -> '500 gp', 101 cp -> '1.01 gp') and every other amount
  in copper (100 cp stays '100 cp', 0 cp stays '0 cp'), using the new exported
  `formatDnd5eDisplayPrice(copper, config?)` formatter. The conversion is
  **display-only** and data-driven through the same validated
  `CONFIG.DND5E.currencies` / `opts.currencyConfig` factors: the card/detail
  price and base price (`priceDisplay`/`basePriceDisplay`), the price-breakdown
  Base/Final amounts, the service/special offers (`displayPrice`) and the cart
  line/total (`totalDisplay`/`cartTotalDisplay`) are all projected as complete
  formatted strings carrying a unit, while the raw numeric `price`/`total`
  fields and the private `_data` are never touched - so sorting, request
  payloads, ledger arithmetic and copper comparisons are unchanged. A non-dnd5e
  system keeps the numeric value and its existing label exactly. A formatter
  error falls back to the raw copper value with the `cp` label rather than a
  blank price. Node-tested only; pending a live Foundry VTT 14 confirmation
  (this is the prospective `0.1.11` patch prerelease - see the install note
  above).
- **M6 first-class system adapters (offline fixtures, runtime unverified)**:
  `DC20Adapter` (dc20rpg 0.10.7.0: `system.currency.{cp,sp,gp,pp}` in cp factors
  1/10/100/1000, item `system.price.{value,currency}` default `gp`,
  `system.quantity`) and `TwodsixAdapter` (Twodsix 7.7.0: numeric
  `system.financeValues.cash` credits ONLY, item `system.price`, no conversion)
  are selected by system id, need no configuration, and ignore the generic path
  settings. Their schema access is validated against offline fixtures; the real
  system runtime field access is not yet verified. `DaggerheartAdapter` stays an
  explicitly unsupported generic subclass until the GM configures the generic
  paths (no guessed price path).
- **M6 GM-private portable backup + v0->v1 BACKUP FORMAT migration**
  (`src/storage/backup-format.js`, `src/storage/backup.js`): a self-contained,
  plain-JSON `foundry-market-portable` v1 backup of every location and shop in
  fully normalized GM-private form (item snapshots, access gates, valuations,
  commerce funds and the whole automation config - never a `publicShop`
  projection). `normalizeBackup` validates/normalizes and rejects an unknown/
  future format, the 1000/1000 caps, >5 MiB, duplicate ids and any non-plain
  JSON; it also accepts a v0 `{ version: 0, locations, shops }` payload and
  migrates it to v1 - but **only when every source object normalizes**, and that
  migration is strictly **backup-format only** (a pre-existing market JournalEntry
  carrying an older `schemaVersion` is not rewritten in place). `planBackupImport`
  gives every imported record a fresh collision-safe id, remaps
  `locationId`/travel/NPC `shopId` references and resets stale automation clock
  state. The GM-only `createBackupService` (active-GM gated at every store read,
  serialized on one in-flight import, no record ever deleted, no complete
  cross-GM atomicity claimed) exposes `exportPortable`/`importPortable` and is
  surfaced only through the active-GM-gated `api.backup` wrappers and the manager
  backup panel.
- **M6 deterministic concurrency/recovery tests, not cross-GM atomic**
  (`tests/multiplayer.test.js`): a pure Node suite drives the real services
  through a fake store and asserts the exact boundaries of the no-distributed-
  atomicity claim - 50 concurrent purchases on a finite stock of 30 commit
  exactly 30 and fail 20 `insufficient-stock` (no oversell/double-debit), a 50-op
  mixed purchase/cart/automation run charges sold units once, two independent
  shops never contaminate, GM-handoff refusal at an await boundary leaves no stale
  write, applies-then-throws recovery is recoverable, and the gated
  `beforeCreateLedger` barrier reproduces the documented multi-GM double-charge
  window deterministically (the per-shop lock and every read-then-create guard
  are per-client; the ledger is the only best-effort cross-client guard).
- **M6 benchmark / accessibility review** (`scripts/benchmark.mjs`,
  `tests/performance.test.js`, `styles/market.css`): `npm run benchmark` prints a
  median/p95 wall-clock report for normalization, public-catalog build and
  automation policy (example timings on the run machine - not a CI gate; no live
  Foundry profile yet), while `tests/performance.test.js` asserts the deterministic
  O(N) guarantee via Proxy array-read counting plus a very generous 10 s
  catastrophic-regression-only wall-clock guard. `styles/market.css` ships the M6
  keyboard focus (`:focus-visible` outline on both surfaces, explicit
  focus/checked states for the custom controls), a `--mk-*` contrast palette and
  reduced-motion handling (`@media (prefers-reduced-motion: reduce)` + the
  `.motion-off` override) - there is no automated axe/screen-reader run; the
  manual keyboard/screen-reader check is `docs/smoke-test.md` section 23.
- **M1-M5 preserved.** The dynamic conversion, the DC20/Twodsix adapters, the
  portable backup manager panel and the concurrency/recovery/benchmark/
  accessibility work are additive: the M1 purchase flow, the M2 themes/
  interactions, the M3 social/reputation engine, the M4 automation and the M5
  advanced commerce remain intact and Node-tested, with `SCHEMA_VERSION` still
  `1`.

## Extending themes

The built-in 8-theme registry is display-only: a theme is an `id`, a `label`, a
`blurb`, an `icon` glyph and an optional `defaultSound` media path. No stylesheet
is generated by the module; the storefront renders `theme-<id>` (and the manager
preview renders `.preview-panel.theme-<id>`) on the root element, and the CSS for
those selectors lives in `styles/market.css` for the built-ins. An external module
can register its own theme at load time - it is purely in-memory and never writes
to the market store - and then supply matching CSS:

```js
// In an external module's init hook (after the market module's hook runs).
const api = game.modules.get('market')?.api;
api.registerTheme({
  id: 'candy-shop',
  label: 'Candy Shop',
  blurb: 'A sweet shop of confections and spun sugar.',
  icon: '\u2764',
  // optional: a valid local media path; an invalid value is sanitised to ''.
  defaultSound: 'modules/my-module/sfx/candy.ogg',
});
```

```css
/* The external module's own stylesheet. Only the theme-<id> (and optionally
   .preview-panel.theme-<id> for the GM preview) selectors need supplying. */
.theme-candy-shop { --mk-theme-ink:#f7e7ff; --mk-theme-base:#2a1d33; --mk-theme-panel:#3a2a47; --mk-theme-accent:#e07ee0; --mk-theme-muted:#d3b0d6; }
.theme-candy-shop .shop-hero { background:radial-gradient(ellipse at 50% 0,#6b2a6b,#2a1d33 68%); }
```

A theme id must be a lower-case slug (letters/digits separated by single
hyphens) and is rejected if it collides with a built-in id, an already-registered
id, or a prototype-chain name (`__proto__`/`constructor`/`prototype`). Registering
a theme never touches shop data: the GM must still set the `theme` field on a
shop for the storefront to use it.

## Adapter setup

The Marketplace is currency-agnostic: prices are stored as integer **minor
units** (the smallest currency unit). For dnd5e the minor unit is copper, and
since M6 the copper factors are read dynamically from the live
`CONFIG.DND5E.currencies` (or `opts.currencyConfig`), treating each
denomination's `conversion` as UNITS per gold piece and deriving the copper
factor as `conversion.cp / conversion[d]` - never a hardcoded table, never float
rounding - so a GM-configured exchange rate is honoured while existing
integer-copper records read/write unchanged. For generic systems you choose the
integer scale and configure the paths.

Settings (world-scoped, under `market`):

- `genericWallet` - dot-path to the integer wallet on the actor.
- `genericPrice` - dot-path to the integer item price on the item.
- `genericPriceDenomination` - optional dot-path to a denomination string
  (informational).
- `genericDeliveryMode` - `embedded` (create an Item on the actor) or `path`
  (append into a configured array).
- `genericDeliveryPath` - the array to append to when mode is `path`.
- `genericQuantityPath` - optional dot-path on the item to set the purchased
  quantity.

Config example for a generic system that stores wallet in `flags.wallet.balance`
(integer) and item price in `system.price.value`:

```js
game.settings.set('market', 'genericWallet', 'flags.wallet.balance');
game.settings.set('market', 'genericPrice', 'system.price.value');
game.settings.set('market', 'genericDeliveryMode', 'embedded');
```

## Developing / testing

```sh
npm test        # node --test tests/
npm run lint    # node --check on every JS source file
npm run build   # sh scripts/package.sh -> dist/module.zip + dist/module.json (requires zip)
npm run benchmark # node scripts/benchmark.mjs -> optional M6 median/p95 wall-clock report
```

The module itself has no build step: `npm test`, `npm run lint` and
`npm run benchmark` are intentionally dependency-free. `npm run build` only
packages the release zip (release workflow asset); it does not transform the
runtime source.

## Documentation

- `docs/architecture.md` - storage, identity, the purchase transaction,
  failure recovery and limitations.
- `docs/smoke-test.md` - a practical manual smoke checklist to run against a
  live Foundry VTT 14 install before trusting the module in a real game.
- `PROJECT_STATUS.md` - M1 status, known caveats and what is intentionally left
  for later milestones.

## License / art

Released under the **MIT License** (see `LICENSE`). No static copyrighted art is
bundled (item icons come from the source item or are left empty). No third-party
modules or systems are required.
