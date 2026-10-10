# Project Status

## Milestone 1 - Market core (prerelease developer preview, in progress)

M1 is a **prerelease developer preview** of the `market` module for Foundry VTT
v14. It delivers the functional core, written as native browser ESM (no build /
transpile). It has no dependency on any game system or other module. The core plus the first end-to-end UI wiring
(manager, storefront, canvas markers) is wired and unit-tested in Node. Those
tests run in a plain Node process and mock the Foundry boundaries - the
`game`/`Hooks`/`CONST` globals, the `JournalEntry` document class and the actor
document API - so they exercise the module's own logic in isolation rather than
a live Foundry VTT 14 runtime. For that reason M1 is not claimed complete: it
has **not** been exercised against a live Foundry VTT 14 install yet. The manual
smoke checklist in `docs/smoke-test.md` is the intended real-runtime check.

### Implemented

- Manifest `module.json` (id `market`, Foundry 14 min/verified/max, ES modules,
  `socket: false`, `styles: ["styles/market.css"]`, plus `manifest`/`url`/
  `download` release pointers, with `version` `0.1.3`).
- UI wiring (`src/ui/manager.js`, `src/ui/storefront.js`,
  `src/canvas/placements.js`): a GM-only market manager, a player storefront and
  canvas shop markers, all built on `HandlebarsApplicationMixin(ApplicationV2)`.
  The manager lists/creates locations and shops, edits shop details and
  inventory (quantity / price / stock mode / visibility persisted via the
  store), adds items by UUID or searchable picker or drag-drop, removes entries,
  places a canvas marker and opens a storefront preview. `DEFAULT_OPTIONS.actions`
  reference callable static wrappers (built by `static _action(method)`) that use
  runtime `this` to delegate to the matching instance `_on...` method; GM text
  entry uses `window.prompt` (no `Dialog.prompt` dependency). Every manager
  inventory/meta write runs inside `runShopExclusive(shopId, ...)` and re-reads
  the shop, so it cannot overwrite a concurrent purchase's stock change. The
  storefront never reads the private store - it requests the catalog via the
  request channel, correlates the response by `requestId`, trusts only
  GM-authored whispers, and disables purchase without an active GM / while
  pending / when closed or out of stock. Canvas markers are created only by the
  GM as a public JournalEntry (default OBSERVER) plus a Scene Note with
  `flags.market.shopId`; the shop is verified to exist before the journal is
  created and a failed Note creation removes the marker journal best-effort.
  Clicking a marker opens the storefront and suppresses the journal sheet.
  Request/response ChatMessages use `style: CONST.CHAT_MESSAGE_STYLES.OOC` (never
  obsolete `CONST.CHAT_MESSAGE_TYPES.WHISPER`) while keeping the `whisper` list.
- Storage (`src/storage/store.js`): locations, shops and a purchase ledger
  persisted in GM-only JournalEntry flags via a single module-scoped flag
  object per record, with the journal entries created explicitly GM-only via
  `ownership: { default: 0 }`. Exposes `listLocations/createLocation/updateLocation`,
  `listShops/createShop/updateShop/addInventoryEntry/findShop`, plus ledger
  helpers, all behind an injectable `docAccess` adapter.
- Schema + normalization (`src/services/model.js`): records validated to safe
  integer minor units; stock modes validated; ids generated locally.
- Pricing (`src/services/pricing.js`): pure, integer-only quoting, parsing,
  add/subtract.
- Adapters (`src/adapters/index.js`): `getAdapter(systemId)`, `GenericAdapter`
  (GM-configured dot-paths, reserved-segment + numeric safety, two delivery
  modes), `Dnd5eAdapter` (cp/sp/ep/gp/pp in integer copper, item
  `system.price.value/denomination`, finite fractional `value` converted to
  copper only when exactly representable, sub-copper rejected, integer overflow
  detected on all currency conversions), and `Daggerheart`/`DC20`/`Twodsix`
  subclasses that explicitly report unsupported until the generic paths are
  configured (no guessed paths). Item delivery preserves `item.toObject()`
  minus `_id`/`ownership`/`folder`/`sort` without mutating the source.
- Commerce (`src/services/commerce.js`): GM-only `purchase(...)` that re-reads
  shop/actor, resolves the item source from `itemUuid` or a valid snapshot
  (refusing an entry with neither), validates open/visible/stock/funds (quoted
  total overflow recorded as `failed`), persists a `pending` ledger record
  before charging, then charge -> deliver -> decrement -> commit. It tracks
  explicit phase flags so compensation undoes only what was applied (wallet,
  delivered item, and stock), marks `needsRecovery` when any compensation step
  fails, and leaves the record `pending` (logged) if the final ledger status
  write fails so a replay never silently implies success. Per-shop queue
  serialization and ledger idempotency keyed `userId:requestId` (rejects
  conflicting duplicate payloads; a pending replay surfaces as `pending`). It
  also exports `runShopExclusive(shopId, fn)`, which shares the same per-shop
  lock with the GM manager inventory edits. `createLedger` returns
  `{ record, created }`; when the key already exists in the persisted ledger the
  purchase NEVER charges and resolves to replay / pending / conflict. Does not
  claim transactional atomicity.
- Requests (`src/core/requests.js`): `market`-flagged ChatMessage requests
  (catalog/purchase), processed only by the active GM, trusting the hook's
  `userId` (never the payload sender), with allowlisted public-only responses.
  Purchase responses only expose the safe `{status, ledgerId, error, total,
  quantity, compensation}` fields, never the raw ledger record, and remote
  purchase requests without a stable `requestId` are rejected rather than
  auto-generated. The `snapshot` field is no longer exposed publicly. No raw
  socket.
- Runtime (`src/core/main.js`): registers init/ready, GM adapter path settings,
  and exposes `game.modules.get('market').api` with `store/commerce/getAdapter/
  request`.
- Tests (`tests/core.test.js`) using `node:test`, with injection/mocks: pricing,
  adapter conversions, path & numeric security, item delivery stripping,
  idempotency/queue serialization, compensation, needsRecovery, catalog
  allowlisting.

### Build / test commands

- `npm test` -> `node --test tests/`
- `npm run lint` -> `node --check` on every JS source file
- `npm run build` -> `sh scripts/package.sh`, which requires the standard `zip`
  binary and produces `dist/module.zip` (module.json at the archive root, plus
  `src/`, `templates/`, `styles/`, `README.md`, `docs/` - only paths that
  exist; `tests/`, `graphify-out/`, `node_modules/`, `.git/` and `dist/` are
  excluded) and `dist/module.json` (byte-for-byte identical to `module.json`).
  Running it does not transform the runtime source; it only packages the release
  asset.

### Release / distribution

This **prerelease developer preview** is installed by pointing Foundry at the
manifest URL; the manifest in turn carries the download URL used to fetch the
module zip.

- Manifest URL (install): `https://raw.githubusercontent.com/sepffuzzball/foundry-market/main/module.json`
- Download URL (from the manifest): `https://github.com/sepffuzzball/foundry-market/releases/download/0.1.3/module.zip`

The release is driven by `.github/workflows/release.yml`, which runs on pushes to
`main`, on tags matching `[0-9]*`, and on `workflow_dispatch`. The `build` job
runs `npm test`, `npm run lint`, `npm run build` and uploads the `dist/` build
artifact (that is the branch artifact). A `release` job runs only for version
tags, depends on `build`, requires `contents: write`, verifies the tag equals
`module.json` `version` (failing otherwise), and creates or updates the GitHub
release as a **prerelease** with assets `dist/module.json` and
`dist/module.zip`. Because `release` `needs: build`, no untested code is ever
released: the tag build's tests/lint/build must pass before the tag's release is
created.

**Status: unverified in a live Foundry VTT 14 runtime.** The `0.1.0` release URL
was never published because that tag's CI preview failed: both `0.1.0` runs of the
`Release` workflow died in the `build` job's `npm test` step with `crypto is
undefined` at `src/services/model.js:24` (`crypto.getRandomValues`), because the
workflow ran on Node 18 where the Web Crypto global is not available. No `0.1.0`
GitHub release was created, so the `0.1.0` download URL is superseded by `0.1.1`,
which was published as a prerelease (the workflow now sets up Node 22, where
`crypto.getRandomValues` is available).

The **`0.1.2` release was published** as a prerelease (tag `0.1.2`, carrying
`module.json` and `module.zip` release assets), so the `0.1.2` download URL is
live and installable. The **`0.1.3` release is being prepared but not yet
published**: the `0.1.3` download URL is live only once that tag's `release` job
completes and publishes the `0.1.3` GitHub release. Until then, install by
pointing Foundry at the repo directory as a module source, or from the published
`0.1.3` release once it exists.

### Known issues / caveats

- The UI is wired against the ApplicationV2 API and unit-tested in Node, but has
  **not** been run against a live Foundry VTT 14 install; the exact
  `HandlebarsApplicationMixin`/PARTS/action dispatch and the `dropCanvasData`
  hook shapes should be re-checked there. The `npm test` suite installs mocks of
  the Foundry boundaries (`game`/`Hooks`/`CONST`, `JournalEntry`, the actor
  document API) instead of a live runtime, so passing tests do not establish V14
  behavior - run the manual checklist in `docs/smoke-test.md` for that.
- The `Daggerheart`/`DC20`/`Twodsix` adapters only report support once the GM
  configures the generic adapter path settings.
- Generic path updates assume object (non-array-index) path segments for the
  wallet and item price.
- Compensation is best-effort; `needsRecovery` ledger entries require manual
  reconciliation using the recorded `currency-refund-failed`,
  `item-remove-failed` and `stock-restore-failed` markers.
- One JournalEntry per purchase in the ledger; no compaction/pruning yet.
- The per-shop lock serializes purchases and GM manager edits within one client.
  Across multiple GM clients the lock is per-client, so the ledger is the only
  cross-client guard - and it is best-effort, not a distributed guarantee.
  `createLedger` reports whether the idempotency key already existed and the
  purchase never charges when it returns `created: false`, but that check is a
  JournalEntry read-then-create (not a server-side compare-and-swap). Under a GM
  handover / concurrent multi-GM processing both clients can see "no record"
  before either persists one and both charge, potentially overselling stock or
  double-debiting a wallet.
- `finite` and `non-restocking` stock modes both currently decrement; the
  restock-policy difference is a later milestone.

---

## Milestone 2 - Shop theming, appearance & storefront interactions (prerelease, in progress)

M2 extends M1 with the shop appearance schema, the fixed 8-theme CSS registry, and
the corresponding manager/storefront interactions: a GM can set a theme and
appearance (owner portrait, background, accent color, typography, density,
animation, music, sound effect, welcome message), preview the change before
saving, and browse a local media file; a player can browse a themed storefront,
filter/search/sort the catalog, inspect an item, and opt in to background music.
The M1 purchase flow and its per-shop lock/ledger are preserved and still
Node-tested.

M2 is **not** yet verified against a live Foundry VTT 14 runtime. The M2 CSS
themes and interactions are Node-tested only (mocked `game`/`CONST`/`Hooks`
boundaries); the exact `foundry.audio.AudioHelper.play` API call, the v14
`FilePicker` constructor, and the `ApplicationV2` action dispatch (including a
`data-action` on a `select` for sorting) should be re-checked there. The themes
ship **no bundled audio**: every theme's `defaultSound` is empty, so background
music plays only if the GM sets `appearance.music` and the player toggles sound
on.

### Implemented (M2)

- Appearance schema (`src/services/model.js`): `normalizeAppearance` validates
  media paths and the accent color strictly (throwing on a bad GM save) and
  normalizes typography/density/animation radio fields to documented defaults;
  media-path sanitizing (`sanitizeMediaPath`) is shared with the request layer.
- Theme registry (`src/themes/registry.js`): the fixed 8-theme set
  (`THEME_IDS`/`THEMES`/`getTheme`/`normalizeTheme`), display-only metadata
  (label/blurb/icon glyph/hyphenated `cssClass`), no bundled audio. Plus a safe
  `registerTheme(metadata)` extension surface: it validates a lower-case slug id,
  rejects a duplicate (including prototype-chain names `__proto__`/
  `constructor`/`prototype`) and enforces label/blurb/icon type and length caps,
  sanitizes an optional `defaultSound` through the media-path sanitizer, and writes
  only to the in-memory `THEMES`/`THEME_IDS` (never mutating a built-in or writing
  to the store). `getTheme`/`normalizeTheme` immediately recognize a registered
  theme, the manager theme dropdown and storefront `theme-<id>` class react to it,
  and a `resetThemes()` helper restores the exact built-in 8 for tests.
- Manager appearance editing + preview (`src/ui/manager.js`): theme/appearance
  fields, `preview-appearance` (validated unsaved current form, never persisted,
  including the current owner/description/open from the form),
  `reset-preview` (clears both the draft and the preview), preview and draft
  cleared on location/shop switch, and a separate `_data.draftShop` + `editingShop`
  form context that preserves unsaved inputs across re-renders (a rejected
  save/preview retains the raw input for correction; a successful save clears the
  draft). The draft is also captured live on any change to a shop-details/
  appearance field (no re-render) and invalidates any stale preview, so an
  unsaved edit survives an inventory-action re-render untouched. When a preview
  is active the `.preview-panel` receives the validated accent color and
  background image (strict `#rrggbb` and a validated local media path only, stale
  styles cleared on re-render). `browse-media` using the official v14
  `foundry.applications.apps.FilePicker` (audio for music/sound effect, image
  otherwise), validation errors surfaced in the notice with no store write; a
  valid picker selection is captured into the unsaved draft and invalidates any
  stale preview so the chosen media survives an inventory-action re-render and can
  be saved, while an invalid picked path leaves the previous valid input untouched.
  Inventory rows expose `publicDescription`/`category`/`rarity`, saved under the
  existing per-shop lock; `_addItemByUuid` defaults them to empty.
- Storefront browsing/detail/sound (`src/ui/storefront.js`): derived catalog
  (categories = All + unique from visible public inventory, never offering a
  category that only appears on a hidden entry; search by name/category/rarity/
  description; sort featured/name/price ascending), inspect/card detail via click
  or Enter/Space, `close-detail`, `filter-category`; a `selectedEntry` resolved
  only against the current derived catalog; both product-card and detail Buy
  buttons disabled on pending / no active GM / out-of-stock; opt-in background
  music and a one-shot purchase `soundEffect` played via
  `foundry.audio.AudioHelper.play` (injected `deps.playSound` for tests), stopped
  on toggle-off/close/catalog-change/error, with a generation token that prevents
  a stale in-flight start from leaking a Sound after a stop, and sound-effect
  playback safe for a synchronous Sound / Promise / synchronous throw. The purchase
  quantity is bound to `_data.quantity` (defaults to `'1'`), updated by the input's
  `input`/`change` events without a re-render, and read back by the template
  `value="{{quantity}}"`, so search/sort/filter/detail re-renders retain the
  player's in-progress quantity and a purchase validates it as a positive safe
  integer (rejecting an invalid value with feedback). Styling is applied in JS after
  render: `--mk-custom-accent` only for a strict `#rrggbb`, `hero.style.backgroundImage`
  only for a validated local path, old styles cleared on re-render/catalog change.
  Full viewport sizing via `setPosition` after first render with a cleaned-up
  resize handler.

### Caveats (M2)

- CSS themes and interactions are Node-tested, **not** verified on a live Foundry
  VTT 14 install.
- No bundled audio assets.
- The manager captures every unsaved details/appearance edit into a
  `_data.draftShop` on any change to a shop form field (input/change), and the
  `editingShop` form context overlays that draft over the persisted
  `selectedShop`; a re-render triggered by an inventory action (open picker,
  add item, edit/remove an inventory row) keeps the draft, so in-progress
  metadata edits are never reset. Inventory rows themselves remain bound to the
  persisted shop (their edits are persisted only by the per-row Save). The
  draft is discarded only on reset, location/shop switch, or a successful Save.
- The storefront re-renders on search/sort/category/detail changes, which is
  handled so the quantity the player typed is retained (bound to `_data.quantity`,
  read back by the template `value="{{quantity}}"`, validated on purchase). The
  actor select still resets to its persisted `selectedActorId` on such a re-render,
  and the search input retains focus and its query.

### Tests (M2)

`tests/ui.test.js` is extended to cover: manager theme/appearance serialization,
preview unsaved/no stale shop, invalid media rejection, public-field inventory
GM edit, storefront category/sort/search/detail derivation (without mutating
`_data.inventory`), sound opt-in & stop/close/catalog-change, purchase sound
effect gating, safe/cleared styling, manager media picker draft preservation
(valid picker -> inventory action -> save, preview invalidation, and an invalid
picker path leaving the previous valid input untouched), storefront quantity
state retention (quantity survives search/filter/inspect/sort and is validated
on purchase), and that the M1 purchase/catalog flows are unaffected.
`tests/themes.test.js` is extended to cover `registerTheme` (slug/duplicate/
prototype-name rejection, metadata type/length caps, defaultSound sanitization,
and immediate recognition by `getTheme`/`normalizeTheme`) plus `resetThemes`
restoring the exact built-in 8.

### Next (not in M1)

- Live Foundry VTT 14 runtime verification of the wired UI and canvas hooks.
- Restock policy distinction and inventory replenishment.
- Generic adapter documentation templates and possibly per-system defaults.
- Recovery tooling to reconcile `needsRecovery` ledger entries.

---

## Milestone 3 - Social data & reputation/pricing engine (in progress)

M3 adds the social data model, a pure reputation/pricing engine, and wires it
into the authoritative catalog and purchase pricing. The M1/M2 integer `quote`
remains the fallback purchase path for an un-wired runtime, but once the runtime
supplies a reputation service the catalog personalizes per-actor prices and the
purchase path quotes through `quoteSocial`, refusing a Hated reputation and
persisting a validated `priceBreakdown`. Critically, M2 shop shape is preserved
and `SCHEMA_VERSION` stays `1` - the new `npcs` and `social` fields are
backward-compatible additions, so no schema migration is required and existing
M2 shops load unchanged.

### Implemented (M3)

- Social engine modules:
  - `src/social/personalities.js`: the ten fixed personality presets
    (`honest`, `greedy`, `generous`, `helpful`, `suspicious`, `scornful`,
    `proud`, `desperate`, `shrewd`, `eccentric`), each with a `label`,
    `description`, integer mechanics (`markupBps`, `haggleDifficulty`,
    `deceptionPenalty`, `repeatBonus`) and at least two `greetings`. The
    mechanical numbers are distinct across presets. `getPersonality(id)` falls
    back to `honest`, `isValidPersonality(id)` rejects unknown and
    prototype-chain names, and `effectivePersonality(primary, secondary?,
    secondaryWeight)` blends the mechanics weighted by `secondaryWeight`
    (rounded to the nearest integer). No D&D-only rolls: the numbers are
    system-agnostic basis points / integers.
  - `src/social/reputation.js`: the ordered reputation band table (11 thresholds
    from -100 Hated to 100 Loved), each with a basis-point price modifier and a
    `refused` flag (only Hated refuses). Exports `clampReputation`,
    `reputationBand` and `effectiveReputation` (weighted individual/party blend,
    100% individual with no party, missing record treated as 0).
  - `src/social/pricing.js`: the pure `quoteSocial(entry, quantity, { shop,
    scores, haggleBps })` engine. Price order is base item price -> additive
    shop/personality/reputation/haggle bps **once** (no compounding) -> integer
    rounding **up** at the unit minor unit -> quantity. All integer math uses
    BigInt intermediates, a free base stays 0, a positive base is never rounded
    below 1 minor unit, and the final total is checked against
    `Number.MAX_SAFE_INTEGER`. Each bps component is bounded to [-9000, 50000],
    but the combined `adjustmentBps` is validated against the full additive
    envelope [-36000, 200000] (4 x -9000 up to 4 x 50000) and retains the actual
    raw sum for a transparent breakdown. For a combined discount of 100% or more
    (`adjustmentBps <= -10000`) the price factor is clamped to zero before the
    min-1 rounding, so a positive base is never priced at zero or negative, while
    a free base stays 0. Returns the full integer breakdown plus `band: { title,
    threshold }` and `refused` (true for a Hated reputation, which reports the
    refusal without throwing).
- Schema/normalization (`src/services/model.js`): `normalizeShop` now also
  returns `npcs[]` (at most `MAX_SHOP_NPCS` = 3, first NPC is the primary owner)
  and `social` (personality weights, party id, shop markup, auto-purchase
  settings), with strict bounds and a strict percent sum
  (`individualWeight + partyWeight === 100` when both are supplied). The legacy
  `owner` string is preserved: on a legacy shop the primary NPC is created from
  `owner`, the returned `owner` stays synchronized from the first NPC, and an
  owner change made through the manager's legacy owner field is applied to the
  primary NPC so no existing owner edit is lost. `store.updateShop` derives the
  owner from the new primary NPC when a caller patches `npcs` without an explicit
  `owner` (an explicit `owner` always wins, and a non-array `npcs` patch is
  rejected), so a primary-NPC rename through the store API is never overwritten by
  a stale persisted owner. No schema version bump.
- GM reputation persistence & service (`src/services/model.js`,
  `src/storage/store.js`, `src/social/service.js`): two new record kinds are
  added - `reputation` (a per-entity score keyed by `(shopId, scope, subjectId)`
  with the score clamped to [-100, 100]) and `reputationEvent` (one event per
  change, carrying `previous`/`delta`/`next`, a `reason` capped at 200, a
  `source` of `gm`/`purchase`/`haggle`, and `pending`/`committed`/
  `needsRecovery` status). Each record and each event is stored in its OWN
  GM-only JournalEntry (`ownership: { default: 0 }`), so there is no unbounded
  embedded history and **no schema version bump** (`SCHEMA_VERSION` stays 1).
  `shopId`/`subjectId` are validated non-empty, max 120 chars, free of control
  characters; an `actor` subject id must be a world Actor UUID
  (`/^Actor\.[A-Za-z0-9]+$/`) and a `party`/`faction` id must be a safe slug.
  The store exports `getReputation`, `upsertReputation` (upsert by the
  `(shopId, scope, subjectId)` triple, preserving the persisted id),
  `findReputationEventByKey`, `createReputationEvent` (returns `{record,
  created}`, never duplicating an existing key - mirroring `createLedger`),
  `updateReputationEvent` and `listReputationEvents` (latest first).
  `createReputationService` exposes `getEffective(shop, actorUuid)` (loads the
  actor record and, only when `shop.social.partyId` is non-empty, the party
  record, then blends them via the pure `effectiveReputation` + `reputationBand`)
  and a manual, GM-only `adjust({shopId, scope, subjectId, delta, reason,
  requestId, source?}, gmUserId)`. `adjust` validates `isGM` before any
  read/write, validates the shop exists, and runs inside `runShopExclusive` (the
  SAME per-shop lock purchases / GM manager edits use). It persists a `pending`
  event before changing the score, then updates the record and marks the event
  `committed`. A matching replay is idempotent and never reapplies the delta; the
  same key with a different subject/delta/reason is a `conflict`. A failed record
  update marks the event `needsRecovery` (old score kept) and a failed commit
  leaves the event `pending`; a retry resumes without re-adding the delta.
  Pending replay is hardened against clobbering a newer score: a resumed event is
  only auto-finalized when the current score still equals its intended `next`
  (mark committed) or exactly its `previous` with no later committed event for
  the same (shop, scope, subject) (apply `next` once); any other state returns
  `needsRecovery` `score-diverged` without writing the record/event (manual GM
  reconciliation), and a new event is refused (`needsRecovery`) while any
  pending/needsRecovery event exists for the same triple. No distributed
  atomicity is claimed - it is an event log plus a score.
- Tests (`tests/social.test.js`): covers the 10 distinct presets and
  fallback/blend, reputation tiers/clamp/weights, shop social + NPC
  normalization and legacy owner migration, the NPC limit, invalid-parameter
  rejection, and the pure quote (additive bps, round-up, free base, min-1,
  overflow, refusal), plus the combined-adjustment envelope (a max shop markup +
  greedy personality no longer fails, an extreme negative discount floors at 1
  minor unit without a negative price, and a free base stays 0).
- Tests (`tests/reputation-store.test.js`): covers GM-only journal privacy,
  invalid shop/subject id rejection, score clamping, independent actor/party
  records, create/find/update event + latest-first list ordering, idempotent
  duplicate-request replay and conflict, unauthorized (non-GM) rejection, and
  update-failure / commit-failure `needsRecovery` + retry recovery without
  re-applying the delta.

### Constraints honored

- The M3 wiring is additive and opt-in: `commerce.purchase` gains an optional
  async `getSocial` plus the social `quoteSocial` (used only when `getSocial` is
  present). Without `getSocial` (legacy/un-wired runtime) the M1/M2 integer
  `quote` path is byte-for-byte unchanged and `priceBreakdown` stays `null`.
- The storage layer is extended add-only: the existing location/shop/ledger
  helpers and the M1 `quote` path are untouched; only new `reputation` /
  `reputationEvent` record kinds and their store methods are added. The ledger
  records a validated `priceBreakdown` (or `null`) on social purchases.
- The catalog request handler personalizes only when an owned `actorId` is
  supplied; with no actor it returns the existing base public catalog. No raw
  reputation record, private `social` config, or `actorUuid` is ever leaked.
- No client writes: reputation is read by the GM-side handlers only, and the
  `reputation.adjust` API wrapper is GM-gated (`!game.user.isGM`) and always
  passes `game.user.id`.
- The manager and storefront UI are now wired for social/NPC/reputation: the
  manager edits the social settings, a capped merchant roster and the GM-only
  reputation editor; the storefront requests a personalized per-actor catalog,
  rejects a stale-actor response, and derives display-only `priceLines` and a
  `relationship.modifierText` from the public response. The M1 purchase flow and
  the M2 layout/themes are unchanged.
- No raw socket; no coupling to the M1/M2 transaction semantics beyond the
  opt-in social quote.
- No unbounded embedded history - each reputation record/event is its own
  GM-only JournalEntry.
- No false distributed/transactional atomicity claim - reputation is an event log
  plus a score, and the recovery boundary is inspectable on the event record.
- No D&D-only rolls; all reputation and pricing numbers are system-agnostic.
- No UI placeholders. `SCHEMA_VERSION` remains 1.

### Implemented (M3 wiring)

- Runtime wiring (`src/core/main.js`): `createReputationService` is constructed
  with `{store, runShopExclusive, isGM, makeId, now}` and the request-handler
  context is extended with `getActor`, `actorOwnedBy`, and `getSocial` (the
  effective-reputation read). No auto-purchase reputation mutation is wired yet.
- API surface (`src/core/main.js`): `api.reputation` exposes read `getEffective`
  and a GM-only `adjust` wrapper (rejects `!game.user.isGM` before any read/write
  and always passes `game.user.id`); `api.getReputation(shopId, actorId)` and
  `api.quotePrice(shopId, entryId, actorId, qty)` are exposed for owned-actors
  only.
- Catalog personalization (`src/core/requests.js`): an optional
  `request.actorId` is validated (exists and owned by the requester or a GM)
  before any reputation read; with an owned actor the handler reads the effective
  reputation, `quoteSocial`s each visible entry at quantity 1, and returns a
  sanitized `relationship` plus per-entry personalized `price`, `basePrice`,
  `priceBreakdown`, and `canBuy`. Hidden entries stay omitted and any quote
  failure fails closed as a correlated `server-error`. Responses echo `actorId`
  so a storefront rejects a stale-actor response.
- Purchase pricing (`src/services/commerce.js`): with `getSocial` present the
  purchase quotes through `quoteSocial` from the actor's live reputation (never a
  client price), refuses a Hated reputation with `service-refused` before any
  debit, and persists the validated `priceBreakdown` in the ledger pending/outcome
  and the purchase response. Compensation uses the charged total.
- Ledger modeling (`src/services/model.js`): `normalizePriceBreakdown` strictly
  validates a breakdown (signed bps fields, non-negative monetary/total fields,
  non-empty band title when a band is present, integer threshold, boolean
  `refused`), bounding the combined `adjustmentBps` to the full additive envelope
  [-36000, 200000] while each component bps field keeps its [-9000, 50000]/min
  bound, and `normalizeLedgerRecord` preserves a validated `priceBreakdown` or
  `null` - never raw arbitrary JSON.
- Tests (`tests/core.test.js`): owned/unowned actor catalog personalization,
  hidden-entry privacy, neutral legacy catalog + legacy-owner merchant projection,
  quote-failure fail-closed, `normalizeLedgerRecord`/`normalizePriceBreakdown`
  validation (including the combined `adjustmentBps` envelope [-36000, 200000]),
  social-discount purchase (charged total + exact ledger breakdown),
  Hated `service-refused` refusal, stale-catalog-not-trusted re-quote, and the
  legacy (no `getSocial`) null-breakdown path.
- UI wiring (`src/ui/manager.js`, `src/ui/storefront.js`,
  `templates/manager.hbs`, `templates/shop.hbs`): the manager persists social
  settings from `.social-panel` via `normalizeShopSocial` under the per-shop lock
  (weights must sum to 100, shop markup is a signed bps integer), merging the
  existing shop's `autoPurchase` (not editable in the panel) back into the
  normalized social before validating so a social save never resets it, and
  leaving the unsaved form intact on a validation error, and adds/edits/removes
  NPCs capped at `MAX_SHOP_NPCS`, syncs the `owner` string and social primary to the
  first merchant on add/save, and on remove-npc reassigns the owner to the
  promoted primary and syncs `social.primaryPersonality` to their personality
  (leaving the shop's social primary unchanged when the roster empties), and
  exposes a GM reputation editor that loads `reputationActors` and reads the
  GM-only effective reputation plus committed history through the store.
  `adjust-reputation` validates a non-zero integer delta and a non-empty
  <=200-char reason before calling the GM-only `reputation.adjust`. The storefront
  snapshots `_data.selectedActorId` (never the actor `<select>` DOM) into the
  catalog request `actorId` (undefined/blank -> null, requesting the base public
  catalog with no reputation leak), auto-selects the first owned actor exactly
  once on open (only while no choice has been made), keeps an explicit
  blank/null selection blank through re-renders, clears per-actor data on switch,
  correlates responses on `requestId` + the echoed `actorId` against the same
  `_data.selectedActorId` snapshot, refuses a `canBuy false` (Hated) entry in
  `_requestPurchase`, maps a `service-refused` error to a readable message, and
  derives display-only `priceLines`/`relationship.modifierText` from the public
  response without leaking private store data.
- Tests (`tests/ui.test.js`): the runtime GM API guard test plus coverage of the
  M3 manager social save (weight-sum error, non-default `autoPurchase` retention,
  and leaving the unsaved form intact on a validation error), NPC
  cap/primary-sync/save-npcs normalization, remove-npc owner reassignment, manual
  reputation adjust validation, and the storefront actor-switch personalized
  quote, privacy, refusal, stale-actor rejection and the unchanged M1 purchase
  flow.

### Remaining M3

M3 is **wired but not complete**. The reputation/pricing engine, the social/NPC
model and the GM reputation/merchant editors are in place, but the following are
still **not yet built**:

- Haggling with a system-native/GM resolution. No haggle mechanic runs yet:
  `haggleDifficulty`/`haggleBps` exist as data, but nothing performs a haggle
  check or negotiates a price.
- Automatic purchase reputation gains with cooldown/anti-farm. A purchase does not
  yet change the buyer's reputation; there is no gain-on-purchase mutation and no
  cooldown / repeat-purchase anti-farm guard.
- Trait/faction reputation rules. Only actor and party records exist; there are no
  faction records or trait-driven modifiers.
- Configurable band thresholds. The 11-threshold reputation band table is fixed;
  it is not yet GM-configurable.
- Per-NPC relationships. NPC-level reputation records and their per-NPC personality
  effect are not yet surfaced in the manager/storefront UI (the editor is wired,
  but NPC-level records are not displayed).
- Cross-system social roll verification. The social and pricing numbers are
  system-agnostic basis points/integers, but no system-native social roll (e.g. a
  D&D/DC20 check) is used or verified.
- Auto-purchase settings surfaced in the storefront.

---

## Milestone 4 - Shop automation schema, policies & GM-only inventory generation (feature implemented locally; live Foundry VTT 14 smoke pending)

M4 is **implemented and Node-tested locally, but not yet verified against a live
Foundry VTT 14 install** - so it is **not** claimed complete until the user runs
the `docs/smoke-test.md` M4 section on a real v14 runtime and confirms the
behavior. The declarative automation schema, the pure scheduling/presence/
stock-display policies, the GM automation editor UI, the active-GM runtime tick
and the RollTable inventory generation entry point are all in place and unit
tested, but none of it has been exercised in a live Foundry VTT 14 runtime yet.

M4 adds the declarative shop automation data model and the **pure** scheduling /
presence / stock-display policies, and now also wires them into the authoritative
purchase path, both catalog variants and the active-GM runtime tick. The
`automation` field is a backward-compatible addition and `SCHEMA_VERSION` stays
`1`, so existing M3 shops and inventory entries load unchanged operationally. The
runtime is fully opt-in: an un-wired `commerce` (no `getWorldTime`) keeps the
legacy `shop.open` gate, and a catalog request without a world time keeps the
legacy open/location projection.

### Implemented (M4)

- Automation schema (`src/services/model.js`): `normalizeShop` now returns an
  `automation` object `{ hours, travel, events, diagnostics }`. `hours` carries an
  `enabled` flag plus at most 7 **unique** day indexes 0..6 (day 0 = Monday) and
  `openMinute`/`closeMinute` in 0..1439 (equal values mean a full-day opening).
  `travel` carries `enabled`, `locationIds` (2..10 unique non-empty local ids,
  each at most 120 chars, when enabled), a signed safe-integer `anchorTime`, an
  `intervalSeconds` in 3600..31536000 and a `lastCycle` in -1..MAX_SAFE_INTEGER.
  `events` holds at most `MAX_AUTOMATION_EVENTS` (10) plain-text events
  (`title` <= 100, `description` <= 400, safe-integer `startAt`/`endAt` with
  `endAt > startAt`, `visible`) whose `id` is validated with the same market-id
  rule used elsewhere (non-empty string, at most 120 chars, no control
  characters) and generated when absent; an object/oversized/control-bearing id
  fails closed at GM save, and the public projection only ever emits a validated
  scalar string id. `diagnostics` is GM-run runtime bookkeeping and
  is not part of the decision logic. Validation is strict and fails closed at GM
  save, while a shop with no `automation` normalizes to documented harmless
  defaults (hours/travel disabled, no events).
- Per-entry M4 fields (`src/services/model.js`): each inventory entry now carries
  `restock` (`{ enabled, target, intervalSeconds, anchorTime, lastCycle }`) and
  `stockVisibility` (`'exact' | 'low' | 'hidden'`, default `'exact'`). A restock
  only applies to a `finite` entry (a restock on any other stock mode normalizes
  to `enabled: false`); `target` defaults to the current quantity floored to 1
  and is any positive safe integer up to `Number.MAX_SAFE_INTEGER` (a GM-edited
  quantity above the target is kept and a scheduled restock never reduces stock).
- Pure automation policies (`src/automation/policy.js`): a Node-importable,
  Foundry-free module with deterministic, side-effect-free helpers. Time is the
  game world's own relative clock, where `0` is Monday 00:00 (never the Unix
  epoch), day 0 is Monday and the weekday index is `floor(worldTime / 86400) % 7`
  (`timeAt(0, 0)` is `0`). `withinHours`
  evaluates the declared hours (inclusive open, exclusive close, equal = full-day,
  overnight windows controlled by the opening day); `isShopTrading` returns
  `{ open, reason, locationId }` combining the manual toggle, hours and travel
  presence - once the merchant has arrived the cycle-rotated `locationId` is
  reported for every outcome (including `manually-closed` and `outside-hours`) so
  a travel-enabled shop never falsely advertises its base place, while
  `not-arrived` is the outcome only when the shop is open and inside its hours
  before the anchor; `cycleAt`/`dueCycle` derive schedule cycles (0 before the
  anchor, clamped non-negative safe integer after, and `null` when the cycle is
  already `<= lastCycle`); `stockView` produces the public stock projection
  without ever leaking a true count in `low`/`hidden` mode; `activeMarketEvents`
  returns the visible active events sorted by start; and `planAutomation` returns
  a pure plan `{ restocks, travel, activeEvents }` that reports every due finite
  restock (even at/above target, carrying the due cycle and target so `lastCycle`
  can advance without reducing stock) by a single set-to-target (no loops, no
  mutation, no fake increment).
- Tests (`tests/automation.test.js`): covers the automation/default schema,
  business-hour inclusivity (inclusive open / exclusive close) and the
  overnight/day windows, travel before-anchor and cycle rotation (including the
  rotated `locationId` being reported even when manually closed or outside
  hours), the weekday/time grid (including negative world times and `timeAt(0, 0)
  === 0`), schedule max
  limits (events/days/location ids/interval), restock due/backward/same-target-
  and-at-or-above-target (advance without stock loss) and non-restocking, public
  stock privacy labels, event visibility, and automation event `id` validation
  (generated when absent, a valid string preserved, and an object / oversized /
  control-bearing id rejected).
- GM-only automation runner (`src/automation/service.js`): a Node-importable,
  Foundry-free `createAutomationService({ store, runShopExclusive, isActiveGM,
  now, logger })` returning `{ runAll, runShop, getDiagnostics }`. It is a
  scheduled runner - the runtime wires it to the active GM's `updateWorldTime`
  tick and the manager's "Run now" (see the wiring/UI sections below), so the
  service itself carries no timer or game-loop knowledge. It
  guards on `isActiveGM()` BEFORE any store access, and validates `now()` before
  any store read/write - an invalid (NaN/undefined/Infinity/non-safe) clock
  short-circuits with `{ status: 'error', error: 'invalid-world-time' }` (and
  `runAll()` returns the same error without listing shops), never coercing to week
  zero. It uses the same per-shop lock
  as commerce purchases via the injected `runShopExclusive`, re-reads the shop
  inside the lock, and applies a `planAutomation` plan. Restocks apply a single
  set-to-target (`quantity = Math.max(current, target)`) without reducing stock,
  advance `restock.lastCycle` by exactly the single due cycle, and preserve every
  other entry field. A due travel plan is validated against `store.listLocations()`
  before writing; a missing destination fails the whole shop
  (`'travel-location-missing'`) with no restock and no cycle advancement. A
  successful run mutates the shop atomically in one `store.updateShop` carrying
  `{ inventory, locationId, automation }` and persists fresh diagnostics in the
  same write; a thrown `store.updateShop` returns an error summary without a
  compensation write (the due cycle is retried). When there are no due plans the
  service skips the write and returns `{ status: 'idle' }`, and `runAll()`
  processes shops independently and sequentially. `getDiagnostics(shopId?)`
  returns only normalized, bounded per-shop diagnostics (`lastRunAt`,
  `lastStatus`, `lastError` capped at 200 chars, `lastRestocked` counted as
  restocked entries and bounded by inventory length, `lastLocationId`), never the
  full shop record.
- Tests (`tests/automation-service.test.js`): covers the store mutation rules
  (single atomic update, no partial failure), restock set-to-target with no stock
  reduction, single-cycle advancement (no catch-up/backward), travel rotation and
  the missing-location fail-before-write, the shared per-shop lock with commerce
  purchases, idempotent duplicate ticks and failed-travel handoff, GM gating
  (no reads for a non-active GM), a thrown write that does not advance cycles and
  is retried, stale-shop skipping in `runAll`, bounded return shapes, and an
  invalid `now()` clock (NaN/undefined/Infinity/non-safe) failing closed as
  `invalid-world-time` with no shop read or write (`runShop`) and no shop reads
  (`runAll`).
- GM-only RollTable inventory generation (`src/automation/tables.js`): a
  Node-importable, Foundry-free `createTableInventoryService({ store,
  runShopExclusive, isActiveGM, getTable, resolveResult, getAdapter, makeId,
  logger })` returning `{ generate }`. `generate({ shopId, tableUuid, count })` is
  GM-gated (returns `{ status: 'idle', shopId }` for a non-active GM before any
  table/store read), validates `count` as an integer 1..20 and `tableUuid` as a
  non-empty string of at most 200 chars, resolves only a world/compendium RollTable
  (`documentName === 'RollTable'`), draws via `table.drawMany(count, { displayChat:
  false })`, consumes only the bounded `draws.results` array capped at 20, resolves
  each document result (`result.type === 'document'`) through the injected
  `resolveResult` (which must verify a world Item `documentCollection === 'Item'`
  or a compendium Item pack), verifies the resolved Item (`documentName ===
  'Item'`, non-empty `uuid`, `toObject()`), dedupes the Item UUID against the
  current shop inventory and within the draw under the shared per-shop lock, and
  appends normalized finite/visible entries via a single `store.updateShop` (no
  write when nothing was added). It never overwrites existing entries, never
  interferes with a purchase, and returns a bounded `{ status: 'ok', added,
  skipped, invalid, duplicate }` (numbers only). A missing/non-RollTable table
  returns `'table-not-found'`, a thrown draw returns `'table-draw-failed'`, and an
  item with an unsupported/throwing/negative/unsafe price is still added with the
  documented price-0 fallback. The service itself is UI-free (no chat, no
  socket); the manager surfaces the GM-only "Roll table stock" form and the
  active-GM `generateInventory` entry point (see the wiring/UI sections below).
- Tests (`tests/automation-tables.test.js`): covers the active-GM gate, count and
  table-uuid validation, skipping text and non-Item results, UUID dedupe (within a
  draw and against the live shop) under the per-shop lock, the 20-result cap, the
  price-0 adapter fallback, a zero-addition success (no write), a thrown draw
  (`table-draw-failed`, no write), and a missing/non-RollTable table
  (`table-not-found`).

### Implemented (M4 wiring)

- Commerce trading gate (`src/services/commerce.js`): `createCommerce` gains an
  optional `getWorldTime`. When supplied, `purchase` resolves the time through
  `safeWorldTime` and, only when it is a valid safe-integer second, computes
  `isShopTrading(shop, worldTime)` INSIDE the existing per-shop lock, returning
  the standard `'shop-closed'` failure when the shop is manually closed, outside
  its hours, or the travelling merchant has not arrived. An invalid server time
  (NaN/undefined/Infinity/non-safe) fails the purchase closed as
  `'invalid-world-time'` before any debit, rather than collapsing to week zero.
  The world time is read server-side via the getter - never a client clock - and
  floored to a safe integer second only when the raw value is finite. Without
  `getWorldTime` the legacy `shop.open` toggle is used unchanged.
- Catalog/request projection (`src/core/requests.js`): `publicShop` gains an opts
  `{ worldTime }`; with a valid server-resolved time it projects `open`/
  `locationId` from `isShopTrading`, a sanitized `closedReason` and the visible
  active `marketEvents` as `{id, title, description}` (the projected `id` is
  always a validated scalar string, collapsing an invalid raw id to `''`);
  without a time it keeps the legacy open/location projection and `marketEvents`
  is `[]`.
  `publicInventoryEntry`/`publicInventory` project each entry through `stockView`
  (non-exact `quantity: null`, plus `stockLabel` and `available`; exact keeps the
  true quantity). `handleCatalog` resolves the world time ONCE server-side
  (`resolveWorldTime`, accepting a `ctx.worldTime` getter or a number): a
  present-but-invalid time fails closed as a correlated `server-error` with no
  catalog; an absent time keeps the legacy no-time behavior. The personalized
  `canBuy` is now `!quote.refused && stockView.available && projectedShop.open`;
  hidden entries remain omitted. `resolveWorldTime`/`publicInventoryEntry` are
  unit-tested but exercised only through the request handler.
- Runtime wiring (`src/core/main.js`): `buildCommerce` supplies
  `getWorldTime: worldTimeNow`; `buildRequestContext` supplies the same
  `worldTime` getter to the request handlers; and `createAutomationService` is
  passed `now: worldTimeNow`. `worldTimeNow` reads `game.time.worldTime`
  server-side and returns `null` when the clock is invalid (NaN/undefined/
  Infinity/non-safe), never `Math.floor`-ing a bad value into NaN/Infinity; every
  consumer treats a null as an invalid world time and fails closed. `init`
  constructs `createAutomationService` after commerce, passing
  `runShopExclusive: commerce.runShopExclusive` (the SAME per-shop lock purchases
  use), `isActiveGM`, `now: worldTimeNow` and `logger: console`. `ready`
  registers `registerAutomationRuntime()`.
- Active-GM automation hook (`src/core/main.js`): `registerAutomationRuntime`
  registers `Hooks.on('updateWorldTime', ...)` and runs one sweep at startup when
  the current user is the active GM. The hook schedules only for the active GM,
  and the service re-checks `isActiveGM()` before any store access. Reentrancy is
  guarded by a single in-flight promise (an arriving tick while a sweep runs sets a
  queued follow-up that runs after the current one). The sweep is not awaited by
  the request handler and a thrown sweep is caught and logged, so it never blocks
  a catalog/purchase response. A GM handover is picked up on the next
  `updateWorldTime` tick (or a reload) - no mid-tick recompute.
- GM-only API surface (`src/core/main.js`): `api.automation` exposes `runAll`,
  `runShop(shopId)` and `getDiagnostics(shopId?)`, each guarded on the active GM
  (returning the service's `idle` summary when not). The raw service object and
  the store are NOT exposed - callers only ever receive the bounded summaries/
  diagnostics the service returns.
- GM-only RollTable inventory surface (`src/core/main.js`): `init` constructs
  `createTableInventoryService` after commerce with `store`,
  `runShopExclusive: commerce.runShopExclusive` (the SAME per-shop lock purchases
  and GM manager edits use), `isActiveGM`, `makeId` and `logger: console`, and
  exposes `api.generateInventory({ shopId, tableUuid, count })`. The wrapper is
  guarded on THIS user being the active GM and rejects a non-active-GM caller with
  `{ status: 'error', error: 'not-active-gm' }` BEFORE the resolver or store is
  touched, never trusting a caller-supplied GM identity and never exposing the raw
  service. The injected `getTable` resolves the table strictly through
  `fromUuid(tableUuid)` and accepts only a `documentName === 'RollTable'`
  document; the injected `resolveResult` resolves a v14 document result only to a
  world Item (`documentCollection === 'Item'` -> `game.items.get(documentId)`) or a
  compendium Item pack (`game.packs.get(collection)` exists and is an Item pack via
  `pack.documentName === 'Item'` or `pack.documentClass?.documentName === 'Item'`,
  supporting v14 mock class names, then `pack.getDocument(id)` and verifies the
  resolved document is an Item) - never constructing an arbitrary UUID, and
  rejecting other collections and a missing id. `getAdapter` resolves from the
  configured `game.system` with the market settings resolver, and the store is
  read/written only through `store.findShop`/`store.updateShop`.
- Tests:
  - `tests/core.test.js`: M4 trading - a shop that closes (or a traveller that
    has not arrived) rejects a purchase after the request snapshot but BEFORE any
    charge; a shop inside its declared hours commits; an invalid `getWorldTime`
    (NaN/undefined/Infinity/non-safe) fails the purchase closed as
    `invalid-world-time` before any debit; a non-exact base entry does
    not leak a real quantity (including zero stock, which still buys for a
    restock-enabled `finite` entry); a non-exact personalized entry does not leak
    a quantity and is `canBuy false` at zero stock; only visible active market
    events are projected, with only a validated scalar string id (an invalid raw
    id collapses to `''`); a catalog request with a present-but-invalid
    `ctx.worldTime` fails closed as a correlated `server-error` (no catalog); and
    a request with no world time keeps the legacy empty `marketEvents` projection.
  - `tests/ui.test.js`: the runtime `updateWorldTime` sweep only runs for the
    active GM (a non-active-GM client does not trigger a store read); the runtime
    `api.generateInventory` draws one world Item and one compendium pack Item,
    skips a non-Item pack result and a text row, and rejects a non-active-GM
    caller with `not-active-gm` before any draw, store read or write; the manager
    M4 automation editor is exercised end-to-end (context derivation, save-hours,
    save-travel, add/remove/save-events, per-entry restock/visibility save, the
    active-GM gated run-automation / generate-inventory handlers and the disabled
    button guard for a non-active GM).
- GM automation editor UI (`src/ui/manager.js`, `templates/manager.hbs`): the
  manager now surfaces the M4 automation editor to the GM. `_prepareContext`
  derives `weekdays` (schema day index 0..6 with label/`selected` from
  `automation.hours.days`), `travelLocationOptions` (plain `{id, name, selected}`
  from `_data.locations` against the configured travel ids), `eventRows` (a plain
  copy of each persisted event with its numeric world-time window so the number
  inputs bind to stored seconds, not a locale date string), `automationDiagnostics`
  (only the documented `lastRunAt`/`lastStatus`/`lastRestocked`/`lastLocationId`/
  `lastError` fields, each defensively coerced and `lastRunAt` formatted as
  `YYYY-MM-DD HH:mm`) and `isActiveGM`. `drawTables` is populated asynchronously
  on each refresh by `_listTables()` (tests inject `deps.listTables`; the runtime
  fallback enumerates `game.tables` plus RollTable compendium packs,
  exposing only `{uuid, name}` pairs - never a raw document). `save-hours` and
  `save-travel` scope to their `.automation-hours` / `.automation-travel` card,
  re-read the shop under the shared per-shop lock and patch `automation.hours` /
  `automation.travel` only; travel validates the selected destination ids against
  a FRESH `store.listLocations()` (an unknown id is rejected without a write) and
  resets `lastCycle` to -1 only when the schedule identity changes, otherwise
  preserving the running cycle, and never touches the shop's own `locationId`.
  `add-event` appends a default event (capped at `MAX_AUTOMATION_EVENTS` = 10)
  and `remove-event` drops only the click target. `save-events` reads every
  `[data-event-id]` editor row, drops a forged id (one not in the persisted
  event id set) so a DOM artifact can neither create nor delete a record, and
  patches `automation.events` only; on a validation error it leaves the unsaved
  form intact. `save-entry` now also reads `stockVisibility` and the restock
  controls only when the row carries them (preserving the persisted value
  otherwise), resets `restock.lastCycle` on identity change, normalizes via
  `normalizeInventoryEntry` before writing (an invalid entry surfaces a notice
  with no write) and edits only the target row under the lock. `run-automation`
  and `generate-inventory` are gated on `_isActiveGM()` (deps-injectable, else
  this user is a GM AND `game.users.activeGM`), are rendered disabled via
  `{{#unless isActiveGM}}disabled{{/unless}}`, and delegate to
  `deps.runAutomation`/`deps.generateInventory` (tests) or the GM-only
  `api.automation.runShop` / `api.generateInventory`; the bounded result summary
  or error is shown in the notice and the data is refreshed.

### Constraints honored (M4)

- `SCHEMA_VERSION` remains `1`; M2/M3 shop shape is preserved and old shops
  normalize unchanged operationally.
- The runtime wiring is additive and opt-in: `commerce.purchase` gains an optional
  `getWorldTime` (used only when present - without it the legacy `shop.open` gate
  is byte-for-byte unchanged), the catalog handler resolves a world time only when
  the context provides one, and the M1/M2/M3 purchase pricing and catalog flows
  are otherwise preserved. No client clock is trusted: both commerce and the
  request context read the world time server-side.
- The policy module and the automation runner remain pure and deterministic: no
  Foundry globals, and the runner performs all mutation through a single
  `store.updateShop` per shop.
- The storefront renders only the already-projected `closedReason`/`marketEvents`/
  `stockLabel`/`available` fields without reading the private store. The GM
  automation editor UI (hours/travel/events, per-entry restock/visibility and
  RollTable inventory generation) is now the M4 slice implemented in the manager;
  it reads/writes only through the private store under the shared per-shop lock
  and derives its context from the selected shop, never leaking a raw record.

### Remaining M4

- Live Foundry VTT 14 runtime verification of the wired automation behavior,
  including the `updateWorldTime` sweep driven by the active GM's clock, the
  manager automation editor, the per-entry restock/visibility save, the RollTable
  `drawMany` call and the public trading/stock/event projection on a real
  calendar (the GM automation editor UI and its active-GM guards are implemented
  and Node-tested only).
- M4 does **not** resolve the M3 deferred items - they remain deferred: no haggle
  mechanic, no automatic purchase reputation gains, no faction/trait reputation
  rules, no configurable reputation band thresholds, no per-NPC reputation UI, no
  cross-system social roll, and auto-purchase settings are not surfaced in the
  storefront. They are listed in the M3 "Remaining M3" section above.
