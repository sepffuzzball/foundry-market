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
  `download` release pointers, with `version` `0.1.4`).
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
  total overflow recorded as `failed`), verifies that a finite
  `shop.commerce.funds` can gain `total` without integer overflow before any
  effect (overflow recorded as `failed`/`merchant-funds-overflow`, no debit),
  and - on success - gains ordinary direct-Buy revenue into finite merchant funds
  by writing stock and funds in ONE `store.updateShop` patch (legacy `null`
  funds stay unlimited and keep the stock-only write; no write at all when both
  stock and funds are unlimited). It then persists a `pending` ledger record
  before charging, and charge -> deliver -> shop write -> commit. A `null`
  `updateShop` (or `updateLedger` commit) return is treated as a failure rather
  than a false success. It tracks explicit phase flags so compensation undoes
  only what was applied (wallet, delivered item, and the shop write). Shop
  compensation re-reads the current shop and compares entry quantity and funds to
  the recorded before/after values: a known no-write is reported as
  `shop-unwritten`, a known complete write restores the exact old stock and old
  funds in a single update (verify-failed/mixed/unknown escalate, and a legacy
  unlimited-funds shop keeps the `stock-restored`/`stock-restore-failed`
  markers), and a mixed/unknown state marks `needsRecovery` rather than falsely
  claiming success. It marks `needsRecovery` when any compensation step fails,
  and leaves the record `pending` (logged) if the final ledger status write fails
  so a replay never silently implies success. Per-shop queue serialization and
  ledger idempotency keyed `userId:requestId` (rejects conflicting duplicate
  payloads; a pending replay surfaces as `pending`). It also exports
  `runShopExclusive(shopId, fn)`, which shares the same per-shop lock with the GM
  manager inventory edits. `createLedger` returns `{ record, created }`; when the
  key already exists in the persisted ledger the purchase NEVER charges and
  resolves to replay / pending / conflict. Does not claim transactional
  atomicity.
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
- Download URL (from the manifest): `https://github.com/sepffuzzball/foundry-market/releases/download/0.1.4/module.zip`

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

The **`0.1.3` release was published** as a prerelease (tag `0.1.3`, carrying
`module.json` and `module.zip` release assets), so the `0.1.3` download URL is
live and installable. The **`0.1.4` release is being prepared but not yet
published**: the `0.1.4` download URL is live only once that tag's `release` job
completes and publishes the `0.1.4` GitHub release. Until then, install by
pointing Foundry at the repo directory as a module source, or from the published
`0.1.4` release once it exists.

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

## Milestone 3 - Social data & reputation/pricing engine (user-reported tested successfully; deferred features remain)

M3 is **user-reported as tested successfully** on a live Foundry VTT 14 runtime,
so its wired social/NPC/reputation flows are acknowledged working; the deferred
M3 items (haggling, automatic purchase reputation gains, faction/trait rules,
configurable band thresholds, per-NPC reputation UI, cross-system social roll,
and auto-purchase settings in the storefront) are **still not built** and remain
open. **Status: user-reported tested; deferred features remain.**

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

---

## Milestone 5 - Advanced commerce configuration & GM-authoritative advanced trade (feature implemented locally; live Foundry VTT 14 smoke pending)

M5 is **implemented and Node-tested locally, but not yet verified against a live
Foundry VTT 14 install** - so it is **not** claimed complete until the user runs
the `docs/smoke-test.md` M5 sections on a real v14 runtime and confirms the
behavior. The advanced commerce configuration schema, the per-entry `access`
gate, the GM-private advanced-order records, and the GM-authoritative advanced
trade services (whole-item sell/buyback, manual service booking, single-payer
multi-line cart checkout with optional whole-item barter, deposit-backed
out-of-stock pre-orders, GM-adjudicated theft, and actor special offers) are all
in place and unit-tested, but none of it has been exercised in a live Foundry VTT
14 runtime yet.

M5 adds the validated advanced commerce configuration schema, the **pure**
access/quotation policies, and **wires per-entry access eligibility into the
catalog, purchase and quote surfaces**. The M5 slices added GM-private
advanced-order records and the GM-authoritative services that act on them -
starting with a sell/buyback service (`src/advanced/selling.js`) that executes
one whole embedded-Item sale against those records. The M1/M2 public purchase
path is otherwise unchanged, but the manager and storefront UI surfaces are
extended (see the M5 manager and storefront bullets below). The shop `commerce`
object and the per-entry `access` gate are normalized by `src/services/model.js`,
and the deterministic access decisions derived from them live in
`src/advanced/policy.js` (`canAccessEntry`). `SCHEMA_VERSION` stays `1` and a
shop/entry carrying no M5 fields normalizes to the documented defaults, so
existing records load unchanged operationally. Finite merchant funds now also
gain ordinary M1 direct-Buy revenue (see the M1 commerce bullet).

### Implemented (M5)

- Commerce configuration schema (`src/services/model.js`): `normalizeShop` returns
  a `commerce` object `{ funds, buyRateBps, buybackRateBps, services, specials,
  preorders, theft, valuations }`. `funds` is `null` (unlimited) or a non-negative safe
  integer; `buyRateBps`/`buybackRateBps` are basis-point rates bounded to
  `[0, 20000]` with `buybackRateBps >= buyRateBps` (defaults `5000`/`12000`);
  `services` and `specials` each hold at most 20 entries (more than 20 throws, no
  slicing); `preorders` is `{ enabled, depositBps, maxPerActor }` with
  `depositBps` in `[0, 20000]` and `maxPerActor >= 1`; `theft` is
  `{ enabled }`. `valuations` holds at most 100 GM-authored per-item valuations,
  each `{ id (<= 120), actorUuid (matching `/^Actor\.[A-Za-z0-9]+$/`), itemId
  (<= 120), amount (positive safe integer minor units), fingerprint (lowercase
  hex, 16..128 chars) }`, unique by `(actorUuid, itemId)` (a duplicate pair keeps
  the newest entry) and never projected into the public catalog. Service entries are `{ id, name (<= 100), description
  (<= 400), price, visible, enabled, manualFulfillment }` (bookable only, no
  automatic effect); specials are `{ id, title (<= 100), description (<= 400),
  entryId (''), price, visible, actorUuids (<= 20) }` with a GM-configured price
  offer on an existing inventory `entryId`. Every special/service/valuation `id` is
  generated via `makeId` when absent and preserved when supplied.
- Per-entry private access (`src/services/model.js`): each inventory entry now
  carries `access` `{ mode ('public' | 'backroom', default 'public'),
  actorUuids (<= 20 world Actor UUIDs), minReputation (-100) }`. `actorUuids`
  entries must match `/^Actor\.[A-Za-z0-9]+$/`; `minReputation` is bounded to
  `[-100, 100]`; more than 20 `actorUuids` throws (no slicing). An unknown
  `mode` falls back to `public`.
- Pure advanced commerce policies (`src/advanced/policy.js`): a Node-importable,
  Foundry-free module with deterministic, side-effect-free helpers.
  `canAccessEntry(entry, { actorUuid, score })` gates access: a legacy entry
  (no `access`) is public and requires only `visible`; a `public` entry is
  accessible only when also `visible`; a `backroom` entry is accessible by an
  allowlisted actor UUID OR (when `minReputation` is above -100) a reputation
  `score >= minReputation`, and an empty allowlist with `minReputation: -100`
  denies everyone (so a GM-created backroom is never accidentally public).
  `visibleEntriesFor(shop, actorUuid, score)` projects only `visible` entries the
  actor may access. Integer quotes use BigInt intermediates and are checked
  against `Number.MAX_SAFE_INTEGER` (overflow throws rather than wrapping):
  `quoteSell` floors `itemPrice * buyRateBps / 10000` (0 when `itemPrice` is 0),
  `quoteBuyback` ceils `paid * buybackRateBps / 10000`, `quoteDeposit` ceils
  `total * depositBps / 10000`, caps at `total` and floors a positive deposit at
  1 minor unit returning `{ deposit, remaining }`, and `quoteSpecial` reports the
  configured `special.price` only for a matching `entryId` and an eligible actor
  (empty allowlist = any actor), without overriding the existing purchase quote.
- Tests (`tests/advanced-policy.test.js`): covers the commerce/access defaults,
  fail-closed validation (negative/unsafe `funds`, out-of-range and inverted
  rates, >20 services/specials/allowlist uuids rejected rather than sliced,
  invalid actor UUIDs, empty service `name`/special `title`, exceeded
  name/title/description maxima, negative prices, out-of-range `minReputation`
  and `depositBps`, `maxPerActor < 1`), the integer sell/buyback/deposit rounding
  (floor / ceil / cap-at-total / min-1), safe-integer overflow rejection,
  special price quotation (matching entry and eligible actor only) and the
  backroom access restrictions (public requires `visible`, UUID OR reputation
  match, and the empty/-100 deny-all).
- Runtime backroom eligibility (`src/core/requests.js`,
  `src/services/commerce.js`, `src/core/main.js`): the base catalog omits
  `backroom` entries regardless of `visible`; the personalized catalog filters
  visible entries through `canAccessEntry` after actor ownership validation and
  the effective-reputation lookup; the purchase path rejects an inaccessible
  `backroom` entry (`entry-restricted`) before any debit (and fails closed
  without `getSocial` unless the actor UUID is already allowlisted); and
  `api.quotePrice` returns `null` for an inaccessible `backroom` to a player
  while the GM may quote any entry. The private `access`/`actorUuids`/
  `minReputation` and the item snapshot are never leaked to a player.
- M5 merchant specials (catalog + cart): the public catalog `shop` now carries a
  sanitized `specials` list `{id, title, description, entryId, price}` - never the
  raw `visible`/`actorUuids`/commerce config. An offer is exposed only when it is
  visible, `quoteSpecial` permits it for the catalog's actor (an empty allowlist
  allows any actor; an actor-specific offer is hidden from the base catalog where
  the actor uuid is null), and its reference entry is present in that catalog's
  inventory (so a backroom-only offer is omitted from the base catalog). An entry
  is cross-referenced with `specialId`/`specialPrice` only when EXACTLY ONE
  eligible offer targets it (base = raw configured `special.price`; personalized =
  `quoteSocial` on `{ ...entry, price: special.price }`, which fails closed to
  `server-error` on overflow); an ambiguous entry keeps the separate list. The pin
  cart (`src/advanced/cart.js`) accepts an optional per-line `specialId`, includes
  it in the canonical intent hash (a distinct `specialId` on the same key is a
  `conflict`), and inside the lock resolves it against `shop.commerce.specials`
  (exact entry, visible, actor-allowlist via `quoteSpecial`), failing closed
  `special-unavailable` before any debit on a forged/hidden/wrong-entry/
  not-allowlisted offer. A valid offer is quoted through `quoteSocial` on
  `{ ...entry, price: special.price }` (never a client number) and the offer id
  plus charged unit price are persisted on the private `details` line and the
  public outcome item.
- M5 public availability projection (`src/core/requests.js`): `publicShop` now
  always projects `services`, `preordersEnabled` and `theftEnabled`. `services` is
  the `publicServices` projection of only the enabled+visible bookable services,
  each sanitized to `{id, name, description, price}` (`name`/`description` bounded
  to the schema maxima and `price` collapsed to 0 unless a finite non-negative
  number); `preordersEnabled`/`theftEnabled` are read strictly from the validated
  `shop.commerce` config. The raw `commerce` object, merchant `funds`,
  `buyRateBps`/`buybackRateBps`, `depositBps`/`maxPerActor`, the per-service
  `manualFulfillment`/`enabled`/`visible` flags and per-offer `actorUuids` are
  never exposed. Both catalog builders also decorate each projected entry with
  `canPreorder` and `canAttemptTheft` via `applyAvailabilityFlags` (client-side
  request hints; the server stays authoritative). `canPreorder` is true only when
  preorders are enabled, the entry is public or (for a personalized actor)
  accessible, it is a finite/non-restocking entry currently out of stock, the
  shop is open/trading, and (personalized) the social quote is not refused;
  `canAttemptTheft` is true only when theft is enabled, the entry is public
  (never a backroom gate), in stock, and the shop is open/trading. A `backroom`
  entry stays hidden from the base catalog (no entry-level preorder/theft leak)
  and is `canAttemptTheft: false` even in a personalized catalog while remaining
  preorder-eligible when out of stock.
- Tests (`tests/core.test.js`): cover the new public services/flags projection and
  allowlist integrity (no raw `commerce`/`funds`/`buyRateBps`/`buybackRateBps`/
  `depositBps`/`maxPerActor`/`manualFulfillment`/`enabled`/`visible`/`actorUuids`
  leak), `publicServices` bounding and price clamping, the disabled/hidden service
  exclusion, base-catalog `canPreorder`/`canAttemptTheft` for finite in-stock vs
  out-of-stock vs unlimited and for a closed shop, a non-restocking out-of-stock
  entry being preorderable but not buyable, personalized refusal (a Hated quote
  denies preorder) vs an eligible actor, theft requiring public access + in-stock +
  open (a backroom eligible entry is never stealable), and the backroom entry
  staying hidden with no access leak.
- GM-private advanced order records (`src/services/model.js`,
  `src/storage/store.js`): a new `advancedOrder` record kind is added for the
  later M5 direct operations (bookable services, preorder execution, theft,
  specials and funds-aware buying). Each order is stored in its OWN GM-only
  `JournalEntry` (never embedded in the shop record) with **no schema version
  bump** (`SCHEMA_VERSION` stays `1`). `normalizeAdvancedOrder` strictly
  validates the shape - `kind`/`status`/`phase` enums, market-id rules (non-empty
  <= 120 chars, no control characters; `actorId` may be a world actor id rather
  than a Foundry Actor UUID), `quantity >= 1`, non-negative totals, a non-empty
  `intentHash` <= 256 chars, `details` plain bounded JSON <= 64KB (no functions or
  custom prototypes), `outcome` plain bounded JSON <= 8KB, and `error` capped at
  200 chars - failing closed at GM save. The store exposes `findAdvancedOrderByKey`,
  `findAdvancedOrder`, `listAdvancedOrders` (newest first, filtered by
  `shopId`/`actorId`/`status`/`kind`, always capped at 100 results with optional
  `limit`/`offset` paging), `createAdvancedOrder` (idempotent on `key`, returning
  `{ record, created }` - never a second JournalEntry for an existing key; a
  replaying caller verifies the `intentHash`), and `updateAdvancedOrder` (returns
  `null` when missing, and `key`/`kind`/`shopId`/`actorId`/`userId`/
  `intentHash`/`createdAt` are immutable). No cross-GM atomicity is claimed -
  create is a read-then-create like `createLedger`. The M1 ledger and the existing
  purchase path are untouched.
- Tests (`tests/advanced-store.test.js`): cover GM-only journal ownership and the
  no-schema-bump guarantee, the order being stored in its own journal (never
  embedded in the shop record), idempotent create on the key, updates (mutable
  fields apply, immutable fields preserved, missing id returns `null`), strict
  normalization (unknown kind/status/phase, bad ids, quantity/total bounds,
  `intentHash` bounds, plain-bounded `details`/`outcome`, error cap), safe
  newest-first ordering + filtering + 100-record cap + optional paging,
  world-actor-id acceptance for `actorId`, and the immutable-field contract.
- GM-authoritative sell/buyback service (`src/advanced/selling.js`): a
  `createSellingService` that executes one effectful GM action on top of the
  advanced-order records - selling a single whole embedded `Item` the player owns
  back to a shop. It is GM-gated (`isActiveGM` before any store read), never
  trusts the payload `userId` (the executing `authenticatedUserId` is the
  ownership principal, idempotency-key prefix and order `userId`), and is fully
  idempotent: the key is `sell:${authenticatedUserId}:${requestId}`, the canonical
  `intentHash` covers `{ shopId, actorId, itemId, requester }`, and a replayed
  request resolves to `replay` (a committed order's recorded outcome), `conflict`
  (same key, different intent), or `needsRecovery` (a still-pending order) without
  re-applying an effect. It validates the shop/actor (re-read under the lock),
  ownership (`actor-not-owned`), the item (`item-not-an-item`, `item-parent-
  mismatch`, `stacked-item` when the count is not a whole item), the GM-approved
  valuation gate (`gm-approval-required` when no `getApprovedValuation` is
  supplied or no matching still-valid GM approval is recorded - never the item's
  own system `price`, which a player can inflate), the adapter quote
  (`quote-overflow`, `no-offer` when payout `<= 0`), merchant
  funds (`insufficient-merchant-funds` for a finite `commerce.funds` below payout;
  `null` is unlimited), the trading gate (`invalid-world-time` on a bad `now()`
  clock; `shop-closed`; the legacy `shop.open` toggle when `now` is absent), the
  generic whole-item rule, and the adapter delivery mode. For a GenericAdapter
  with a configured `quantityPath` the count is read through that path via the
  safe reader on the serialized item and must be the integer `1` (`stacked-item`
  otherwise, `quantity-path-invalid` when the path is missing/unreadable), and a
  non-embedded generic delivery mode is unsupported (`delivery-mode-unsupported`)
  since the sale deletes an embedded `Item`. For a non-generic item the existing
  `system.quantity` check still applies when present. A `pending` order is
  persisted before any effect, then the item is deleted (success requires the
  live `actor.items.get(itemId)` to be `null` AFTER the API resolves - a returned
  deletion id alone is insufficient), the payout is credited, the shop gets a
  single write appending a `non-restocking` buyback listing (empty `itemUuid`,
  snapshot, `quantity: 1`, `price: quoteBuyback(payout, shop)`, `visible: true`)
  and decrementing finite funds, and finally the order is committed with
  `outcome: { payout, buybackEntryId, itemName }` - the commit is only claimed
  when the terminal write persisted a record (`needsRecovery` on a `null`
  return, never committed). Any failure after pending is best-effort
  compensated: the credit is refunded only when balance verification proves it
  applied (a throwing credit is not trusted even if the balance moved), the item
  is restored via `createEmbeddedDocuments(..., { keepId: true })` with a
  post-restore id verify, and the shop write is undone by comparing current
  funds to the recorded `fundsBefore` and whether the listing id exists (known
  no-write vs known full-write, otherwise `shop-state-mixed` escalated to
  `needsRecovery`) - never silently double-crediting or re-running a pending
  order. The active-GM guard is re-checked at every await boundary, so a GM
  handover after the pending order stops the former GM from applying effects and
  marks the order `failed` (safe) or `needsRecovery`, and no cross-client
  uniqueness is claimed - the active-GM shop lock and the read-then-create are
  per-client, so two simultaneous GM clients can both create and both apply
  effects for the same key (deferred to M6 testing). Errors before the pending
  write return a sanitized error with no writes. The M1 purchase path is
  untouched.
- Tests (`tests/advanced-selling.test.js`): cover the success path and its exact
  side effects (single shop write, funds decrement, buyback listing, committed
  order outcome/details), unlimited-funds behavior, idempotent replay (no second
  credit/delete/append), duplicate-identity conflict, pending/needsRecovery and
  failed-order replay, the non-GM gate (no store read), actor ownership, missing
  shop/actor/item, the stacked-item rule, insufficient merchant funds, zero offer
  (`no-offer`), invalid-world-time fail-closed, closed-shop refusal on both clock
  and legacy paths, the generic `quantityPath` whole-item rule (stacked /
  invalid path / non-embedded delivery mode), and every compensation path
  (delete failure item kept, credit failure item restored, shop-write failure
  credit refunded + item restored with the shop unchanged, commit failure full
  refund/restore/entry removal + funds refund, a shop-restore failure escalating
  to `needsRecovery`, a delete that resolves but leaves the item live recorded
  `failed` with no payout, a credit that throws after applying refunded via
  balance verification, a `null` commit write yielding `needsRecovery` and never
  committed, a restore failing to keep the original id escalating to
  `needsRecovery`, a mixed shop state recorded `needsRecovery` not `failed`, and
  a GM handover after the pending order recording `failed` with no effect from
  the former GM). Lock-serialization is shown with two concurrent sells and a
  concurrent commerce purchase + sell sharing the same per-shop lock (max write
  depth 1).
- GM-authored per-Item valuation (`src/advanced/valuation.js`,
  `tests/advanced-valuation.test.js`): the GM-approval authority behind the
  sell/buyback and cart-barter `gm-approval-required` gate. `createValuationService`
  exposes a GM-only `approve({ shopId, actorId, itemId, amount }, gmUserId)` that
  is active-GM gated before any store read, runs under the SAME per-shop lock a
  purchase/sell uses, re-reads the shop and the actor's embedded Item inside the
  lock, validates exactly ONE whole item (`system.quantity === 1` when present;
  the generic `quantityPath` check is deferred), snapshots a canonical
  `fingerprintItem` digest of the full serialized item data, and replaces any
  existing valuation for the same `(actorUuid, itemId)` or appends up to 100
  (dropping the oldest when full) via a SINGLE normalized `store.updateShop`
  commerce patch. The pure `findApprovedValuation(item, shop)` returns the FULL
  validated entry (and the pure `getApprovedValuation` returns just its minor-unit
  `amount`) only when the actor parent UUID, item id and the current item
  fingerprint all match - so a forged/inflated player `price` (or any other item
  mutation) invalidates the stored approval and the sell/barter path refuses
  `gm-approval-required` rather than paying a number that no longer matches the
  owned item. `fingerprintItem` canonicalizes the deterministic key-sorted JSON of
  `item.toObject()` (full source fields including `_id`/`name`/`type`/`system`/
  `flags`), bounds it to 64KB, rejects functions/non-plain prototypes and item
  id mismatches, and hashes with FNV-1a 64-bit (lowercase hex, 16 chars - tamper
  detection, not cryptography). The private `valuations` list is never projected
  into the public catalog (`PUBLIC_SHOP_FIELDS` omits it). The valuation service
  is WIRED into the runtime: `src/core/main.js` constructs
  `createValuationService` and injects its full-entry `getApprovedValuation` into
  both `createSellingService` and `createCartCommerce`, and exposes the GM-only
  `api.advanced.approveValuation`. Each sale/barter resolves the approved entry
  BEFORE the pending order and consumes it at commit - the single shop write
  filters `shop.commerce.valuations` by the entry's `id` in the same patch that
  applies the funds/listing/stock effects, and compensation restores the exact
  consumed entry on a known full-write (leaves it untouched on a known no-write,
  escalates to `needsRecovery` on an uncertain write). A single approval never
  mints repeated payouts. The buy-only cart path never touches a valuation; only
  `barter.consumedValuation` triggers filtering and restoration. Tests cover the
  pure fingerprint helpers, the pure read side (match / wrong actor / wrong id /
  mutated price, full-entry vs amount-only), the approve service (success +
  persisted normalization, the GM gate with no store read, payload validation,
  replace-not-duplicate, the 100-entry cap, one-whole-item refusals, shop/actor/
  write errors), schema normalization (defaults, fail-closed fingerprint/amount/
  actor-UUID, de-dupe keeping the newest), `publicShop` not leaking `valuations`,
  and the sell/cart/barter runtime (consumption-at-commit + restore, one-time
  replay rejection, changed-fingerprint invalidation, no-callback fail-closed)
  plus the active-GM gate on `api.advanced.approveValuation`.
- GM-authoritative service booking & manual fulfillment
  (`src/advanced/services.js`): a `createServiceCommerce` that executes the
  player-facing service book and the GM-only manual fulfillment over the same
  advanced-order records. `book({ shopId, serviceId, actorId, requestId },
  requesterId)` is GM-gated (`isActiveGM` before any store read), runs under the
  SAME per-shop lock a purchase/sell uses, never trusts a client price (the price
  is re-read from the STORED `shop.commerce.services[]` entry and must be
  `enabled` + `visible`), checks adapter support and the actor's live balance,
  re-reads the shop/service/actor inside the lock, enforces the trading gate
  (`isShopTrading` via a server-side `getWorldTime` clock, falling back to
  `now`, with `invalid-world-time`/`shop-closed` fail-closed), and refuses a
  finite-funds overflow (`funds-overflow`) before any effect. The key is
  `service:${requesterId}:${requestId}` with a canonical `intentHash` over
  `{ shopId, serviceId, actorId, requester }`. A `pending` order (kind
  `service`) is persisted BEFORE the single debit; finite merchant funds GAIN the
  price via one `updateShop` patch (unlimited `null` funds write nothing); and the
  order is committed `booked` with
  `outcome: { serviceId, serviceName, price, orderId }`. A throwing debit is
  always rolled back (never trusted), with the balance captured before/compared
  after to decide whether the player must be refunded; any failure after pending
  compensates best-effort (credit refund + funds restore via `fundsBefore`
  comparison), recording `failed` when safe and `needsRecovery` when a
  compensating step is uncertain - a replay of a pending order surfaces
  `needsRecovery` with no effect. A service has NO automatic mechanical effect:
  the order stays `booked`, never `fulfilled`, and never creates/delivers an
  `Item`. `fulfill({ orderId, requestId }, gmUserId)` is GM-only, requires the
  original order to be kind `service` / status `booked` (an already-`fulfilled`
  order replays as success; anything else is `order-not-booked`), requires the
  shop and actor to still exist, uses a DISTINCT key
  `service-fulfill:${orderId}:${requestId}` with an `intentHash` over `{ orderId }`
  (the executing GM is excluded so different GMs replay, not conflict), and
  records the acknowledgement as its own advanced-order record of kind `service`
  with `relatedOrderId` set to the original id: pending -> mark the original
  `fulfilled` -> mark the acknowledgement `committed`. If EITHER write fails the
  fulfill returns `needsRecovery` and never re-runs the service; on replay the
  ORIGINAL order's status is re-checked (already `fulfilled` => replay success,
  otherwise `needsRecovery`). The GM manually confirms delivery outside the
  module; fulfillment only records the acknowledgement.
- Tests (`tests/advanced-services.test.js`): cover the booking success path and
  its exact side effects (one debit, no delivered `Item`, no shop inventory
  entry, the single finite-funds patch and `booked`-not-`fulfilled` order
  outcome), unlimited-funds behavior, idempotent replay (no second debit),
  duplicate-identity conflict, pending and failed-order replay, the non-active-GM
  gate (no store read), actor ownership, missing/disabled/hidden service, the
  closed-shop and invalid-world-time gate on both the clock and legacy paths,
  insufficient funds, the finite-funds safe-integer overflow guard, debit-error
  compensation (a throwing debit and a debit that applies-then-throws refunded via
  balance verification), a failed shop write and a `null` commit both escaping to
  `needsRecovery`, the "no fake Item" contract (`deliverItem`/`removeItem` never
  called), the booked-not-fulfilled contract, and the fulfillment path: GM-only
  single fulfillment with a no-op replay, non-service/not-booked/missing-order
  validation, an already-fulfilled-order replay, missing shop/actor, a failed
  original-status write, and a failed acknowledgement commit (recorded
  `needsRecovery`, original still `fulfilled`, re-checked on replay).
  Lock-serialization is shown with two concurrent bookings sharing the same
  per-shop lock (max write depth 1).
- GM-authoritative safe multi-item cart checkout (`src/advanced/cart.js`,
  `tests/advanced-cart.test.js`): a `createCartCommerce` whose `checkout`
  executes a **single-payer** multi-item checkout - only the request `actorId` is
  debited and no other contributor is charged (a group cart is a single-payer
  shared selection only; explicit cost-sharing/consent is not implemented, so the
  docs state this boundary expressly). `checkout({ shopId, actorId, lines:
  [{ entryId, quantity, specialId? }], requestId, barterItemId? },
  authenticatedRequesterId)` runs under the
  SAME per-shop `runShopExclusive` lock as purchases, is GM-gated before any
  store read and re-checked inside the lock, never trusts a client price (each
  entry is re-read from the STORED shop), rejects a malformed request
  (`too-many-lines` over 20, `duplicate-entry`, quantity outside 1..100, and a
  `barterItemId` longer than 120 chars or carrying control characters) before
  any read, and is idempotent via a key `cart:${requester}:${requestId}` and a
  canonical `intentHash` over `{ shopId, actorId, requester, lines, barterItemId }`
  where lines
  are SORTED by `entryId` and each line normalizes to `{ entryId, quantity, specialId }`
  (a missing `specialId` collapses to `''`), so a reordered-but-identical selection
  replays rather than conflicts; the same key with a DIFFERENT `barterItemId` is a
  `conflict`, never a replay, and the same key with a DISTINCT `specialId` is a
  `conflict` too (the offer changes the charged price). For each line it verifies
  `entry-not-found`/`entry-hidden`/
  `entry-restricted` (backroom access via `canAccessEntry`)/`insufficient-stock`/
  `item-source-missing` (UUID or valid snapshot, same safe parse as the purchase
  path), quotes via `quoteSocial` at the current shop/scores (a Hated reputation
  refuses `service-refused`; a quote overflow is `total-overflow`), sums the
  total with a BigInt/safe-integer check, and refuses a finite-merchant-funds
  safe-integer overflow (`funds-overflow`) before any effect. An optional per-line
  `specialId` selects a merchant special: the offer is re-read from the STORED
  `shop.commerce.specials`, must match the entry exactly, be visible, and be
  actor-allowlist permitted via `quoteSpecial` (an empty `actorUuids` allows any
  actor; eligibility is `!== null` because a 0-price offer is legal), otherwise the
  checkout fails closed `special-unavailable` before any debit. A valid offer is
  quoted through `quoteSocial` on `{ ...entry, price: special.price }` (never a
  client number, and the social adjustment still applies), and the offer id plus
  charged unit price are persisted on the private `details` line and the public
  outcome item. An optional
  `barterItemId` lets the paying actor tender ONE whole embedded `Item` as credit:
  the service reads `actor.items.get`, requires an `Item` with a working
  `toObject()` and no parent mismatch, checks the whole-item rule (a configured
  `adapter.quantityPath` via the safe reader, else dnd5e `system.quantity`; exactly
  1, else `stacked-item`), rejects a generic path-delivery adapter
  (`delivery-mode-unsupported`), prices the item via the GM-approved
  valuation gate (`gm-approval-required` when no `getApprovedValuation` is
  supplied or no matching still-valid approval is recorded - never the item's own
  system `price`, which a player can inflate) -> `quoteSell(.., shop)`, and caps the credit at the cart
  gross total (`no-offer` when the credit is 0) - so a tender worth more than the
  cart never pays cash out. Only the CASH REMAINDER (total minus barter credit) is
  checked against the actor balance and only that is ever debited; finite merchant
  funds gain only that remainder. It persists a pending
  `advancedOrder` (kind `cart`) BEFORE any effect with a bounded private line
  breakdown in `details` (64KB cap; an overflow fails before any effect; a barter
  tender's immutable snapshot and credit also go in `details.barter`, private),
  then in order: remove the barter tender Item (recorded `bartered`, verified by a
  live `actor.items.get`), debit the actor ONCE by the cash remainder (`debited`),
  deliver each line via
  `adapter.deliverItem(actor, source, { quantity })` recording created ids
  (`transferred`), decrement all finite/non-restocking stock, append the barter
  buyback listing (when bartering), and increment
  finite merchant funds in ONE `store.updateShop` inside the lock (`stocked`),
  and commits a bounded outcome `{ total, quantity, barterCredit, cashPaid, items:
  [{ entryId, name, quantity, specialId?, specialPrice? }], orderId }` (the tender snapshot/name stay out of
  the public result). Compensation restores a removed tender FIRST via
  `createEmbeddedDocuments('Item',[snapshot],{keepId:true})` verified by
  `actor.items.get`, removes delivered lines in reverse via
  `adapter.removeItem`, credits the actor the cash remainder only if the debit
  applied, and restores
  shop stock/funds/buyback-listing only when the shop write actually applied -
  decided by comparing the current shop to the cart's OWN changed entry quantities,
  funds and listing presence
  - escalating to `needsRecovery` on any ambiguous state. A pending replay never
  recharges and a committed replay is unchanged; changed lines or a changed
  `barterItemId` conflict.
- Tests (`tests/advanced-cart.test.js`): cover the two-line success path and its
  exact side effects (single debit, two deliveries, one shop write, committed
  outcome), canonical sorted-intent idempotency (reordered lines replay), committed
  and pending replay never recharging, changed-line conflict, the non-active-GM
  gate (no store read), duplicate-entry and too-many-lines caps, missing
  shop/actor/ownership, restricted/hidden entries, Hated refusal, insufficient
  stock/funds, an entry with no resolvable item source, finite merchant funds gain
  and safe-integer funds/total overflow guards, the optional item-for-price barter
  (full-credit tender with no cash moved, partial-credit tender debiting only the
  cash remainder, zero-value `no-offer`, unowned/stacked/delivery-mode-adapter
  rejections, unsupported adapter keeping the tender, barter replay with no
  re-removal/re-debit/re-append, changed `barterItemId` conflict, delivery-failure
  tender restore + cash refund, throwing cash debit rollback, and a mixed shop
  state escalating to needsRecovery), and the compensation paths
  (second-line delivery failure refunding and removing the first line, a shop
  update failure leaving the shop untouched, and ambiguous recoveries escalating
  to needsRecovery). Lock-serialization is shown with two concurrent checkouts
  sharing the same per-shop lock (max write depth 1). The merchant-special paths are
  covered: an actor-allowlisted offer is charged at the stored offer price while a
  client-supplied line `price` is ignored; a forged/hidden/wrong-entry/
  not-allowlisted `specialId` all fail closed `special-unavailable` before any
  debit; the same key with a distinct `specialId` is a conflict while the identical
  one replays; and the offer price is quoted socially (a shop markup is applied to
  the configured special price).
- GM-authoritative out-of-stock pre-orders with paid deposit
  (`src/advanced/preorders.js`, `tests/advanced-preorders.test.js`): a
  `createPreorderCommerce` returning `{ place, fulfill, cancel }`. `place({ shopId,
  entryId, actorId, quantity = 1, requestId }, authenticatedUserId)` places a
  pre-order only when `shop.commerce.preorders.enabled` is true, the entry is
  visible and accessible (`canAccessEntry`), the shop is trading, and the entry is
  genuinely OUT OF STOCK for the requested quantity (a `stockMode === 'unlimited'`
  entry is always `stock-sufficient`, and a finite/non-restocking entry that can
  already serve the quantity is refused rather than pre-ordered). It rejects a
  duplicate live `booked` pre-order beyond
  `shop.commerce.preorders.maxPerActor` for the same actor+entry
  (`max-preorders-reached`), validates the item source NOW via UUID/snapshot
  (`item-source-missing` otherwise), quotes the authoritative total via
  `quoteSocial` at the current reputation (a Hated reputation refuses
  `service-refused`) and splits it with `quoteDeposit` into `{ deposit, remaining }`
  (`quote-deposit-failed` on overflow), charges the DEPOSIT once (the actor's
  balance must cover only the deposit; the remainder is paid at fulfillment, and
  finite merchant funds GAIN the deposit in one patch with a safe-integer
  `funds-overflow` guard), persists a `pending` `advancedOrder` (kind `preorder`)
  BEFORE any effect, and commits `status: 'booked'` with the bounded public outcome
  `{ orderId, entryId, quantity, total, deposit, remaining }` - NO stock is
  reserved. `fulfill({ orderId, requestId }, gmUserId)` is GM-only on a `booked`
  pre-order: it re-reads the order/shop/actor/entry, requires `stock >= quantity`
  and a valid item source, checks the actor's balance for the REMAINING only,
  persists a separate idempotent `preorder-fulfill` action order keyed
  `preorder-fulfill:${orderId}:${requestId}`, then debits the remaining once,
  delivers the quantity, decrements finite/non-restocking stock and gains the
  remaining merchant funds in one shop write, and marks the original `fulfilled`
  and the action `committed` (a repeated fulfill on an already-`fulfilled` original
  replays with no second delivery). `cancel({ orderId, requestId }, gmUserId)` is
  GM-only on a `booked` pre-order: it persists a separate `preorder-cancel` action
  order, refunds the deposit via `adapter.credit` once and decrements finite
  merchant funds by the deposit (refusing `insufficient-merchant-funds` before any
  effect when finite funds no longer cover the deposit), and marks the original
  `cancelled` and the action `committed` (a pre-order cannot be cancelled after it
  is fulfilled). Both action orders are compensating and idempotent: a failing
  fulfill/cancel refunds the wallet, removes the delivery (fulfill only), restores
  stock/funds and leaves the original `booked` when safely undone, escalating to
  `needsRecovery` on an uncertain compensation. No distributed atomicity is
  claimed.
- Tests (`tests/advanced-preorders.test.js`): cover the place success path and its
  exact side effects (deposit debited exactly once, finite merchant funds gain the
  deposit in one patch, no stock reserved, the bounded `booked` outcome and
  `entryId`), the stock-sufficient / unlimited / preorders-disabled gates, hidden /
  restricted / Hated-reputation refusal, insufficient funds for the deposit,
  max-per-actor, an entry with no resolvable item source, quantity-range
  validation, booked/pending replay never recharging and changed-quantity
  conflict, the non-active-GM gate (no store read) and actor ownership, and the
  place compensation paths (throwing debit, debit-then-throw rolled back,
  merchant-funds shop write failure, `null` `booked` commit). For fulfillment it
  covers the remaining-only charge, delivery, stock decrement and merchant funds
  gain; insufficient stock / insufficient remaining balance; already-fulfilled
  replay with no second delivery; non-preorder / not-booked validation; and failure
  injection that refunds the remaining, removes the delivery, restores stock/funds
  and leaves the original booked, plus an ambiguous recovery escalating to
  `needsRecovery`. For cancellation it covers the deposit refund and
  finite-merchant-funds decrement, insufficient-merchant-funds refusal, no double
  refund on replay, the cannot-cancel-after-fulfilled rule, and a failing cancel
  that credits back the deposit and restores merchant funds. Lock-serialization is
  shown with two concurrent place operations sharing the same per-shop lock
  (max write depth 1).
- GM-authoritative theft adjudication (`src/advanced/theft.js`): a
  `createTheftCommerce` returning `{ attempt, resolve }`. `attempt({ shopId,
  entryId, actorId, requestId }, authenticatedUserId)` records a GM-private
  advanced-order of kind `theft` directly as `booked`/`final` (no pending->booked
  transition, because a claim has NO effects to compensate) with a supplied id and
  `outcome: { orderId, entryId, status: 'awaiting-gm' }` - NO item is delivered, NO
  stock is decremented, and NO currency moves. It is GM-gated and runs under the
  SAME per-shop `runShopExclusive` lock a purchase uses, requires
  `shop.commerce.theft.enabled`, the trading gate (`invalid-world-time`/`shop-closed`
  fail-closed), actor ownership, a PUBLIC visible entry (`entry-hidden`; a
  `backroom` entry is refused `entry-backroom` even when the actor is eligible),
  finite positive stock or unlimited (`out-of-stock` on a finite/non-restocking
  zero), and a resolvable item source (`item-source-missing`/`item-source-failed`).
  The key is `theft:${requester}:${requestId}` with a canonical `intentHash` over
  `{ shopId, entryId, actorId, requester }`; the same key replays and a changed
  payload conflicts. `resolve({ orderId, requestId, success }, gmUserId)` is GM-only
  and self-decided: `success` MUST be a typed boolean (`success-required`), never
  inferred from a player channel or a roll, and `gmUserId` is required
  (`gm-required`). A distinct action order of kind `theft` is persisted `pending`
  BEFORE any effect, keyed `theft-resolve:${orderId}:${requestId}` with an
  `intentHash` over `{ orderId, success }` (the decided success is included so a
  changed decision conflicts, never replays; the executing GM is deliberately
  excluded so a different GM repeating the request replays). On `success: false`
  the original is marked `failed`/`outcome: { success: false }` and the action
  committed, with NO delivery, stock change or currency; on `success: true` the
  shop/actor/entry/source are re-validated NOW under the lock
  (`insufficient-stock` on a cleaned-out finite entry), one unit is delivered via
  `adapter.deliverItem(actor, source, { quantity: 1 })`, finite / non-restocking
  stock is decremented by one in a single `store.updateShop` patch (an `unlimited`
  entry is unchanged and needs no write), and the original is marked
  `committed`/`outcome: { success: true, entryId }` then the action `committed`.
  Failure after the pending write compensates best-effort: the delivered item is
  removed via `adapter.removeItem`, finite stock is restored only when the single
  shop patch actually applied (decided by comparing the current entry to this
  grant's own before/after quantity, never a guess), leaving the original `booked`
  and marking the action `failed`, or `needsRecovery` on an ambiguous/uncertain
  step; a committed original with a failed action commit preserves the grant and
  escalates. There is NO theft payout and NO free goods before the GM decision, and
  NO system-skill API call or NO automatic reputation penalty - the module only
  ever grants or refuses a single inventory item. The public result is the safe
  `{ status, error, orderId, success? }` shape; a pending theft order is GM-only.
- Tests (`tests/advanced-theft.test.js`): cover the attempt success path and its
  exact non-effects (no debit, no delivery, no stock change, no shop write, the
  safe public output and the `booked`/`final` order with `{ orderId, entryId,
  status: 'awaiting-gm' }`), the theft-disabled / hidden / backroom / out-of-stock
  / unlimited gates, closed-shop and invalid-clock fail-closed, missing item
  source, the non-active-GM gate (no store read), actor ownership, replay and
  changed-payload conflict, the resolve GM-only gate and typed-boolean `success`
  requirement and `gm-required`, the non-theft-kind refusal, the success:false
  no-effects path and the success:true deliver + finite-stock decrement + commit
  path (and the unlimited no-stock path), the resolve-time `insufficient-stock`
  recheck, idempotent replay with no second delivery and the changed-success
  conflict, and the compensation paths (delivery failure, shop-write failure
  removing the item, `removeItem` failure escalating to `needsRecovery`, and a
  nulled action commit preserving the granted item and escalating).
  Lock-serialization is shown with two concurrent resolutions sharing the same
  per-shop lock (max write depth 1).
- Sell request wiring (`src/core/requests.js`, `src/core/main.js`): the request
  channel now recognizes `request.type === 'sell'` and routes it to the selling
  service with the trusted hook `userId` as the requester (never the payload
  `userId`), pre-validating `shopId`/`actorId`/`itemId`/`requestId` (returning
  clean correlated `missing-shop-id`/`missing-actor-id`/`missing-item-id`/
  `missing-request-id` errors) and projecting the outcome through
  `publicSellResult` to only the allowlisted
  `{status, error, orderId, payout, buybackEntryId, itemName}` - never the raw
  advanced-order record or the idempotency `conflict`/`expected`/`existing`
  carrybacks, nor the order `details`/`compensation`/`outcome`. The active-GM
  request context now carries the selling service (`buildRequestContext` and
  `attachHandler` take it), `requestMessageData` carries `itemId` for a sell
  request, and `serverFailureData` fails closed as a correlated
  `sell`/`server-error`. The runtime API exposes GM-only
  `api.sellItem({ shopId, actorId, itemId, requestId })`, guarded on THIS user
  being the active GM before any read/write and always executing as
  `game.user.id` (never a caller-supplied GM id); a non-active GM resolves
  `{status:'error', error:'not-active-gm'}` and the raw selling service is not
  exposed.
- Advanced order request wiring (`src/core/requests.js`, `src/core/main.js`): the
  request channel now recognizes `request.type` of `cart`/`service`/`preorder`/
  `theft` and routes each to the matching advanced service with the trusted hook
  `userId` as the requester (never the payload `userId`), pre-validating the
  required ids and returning clean correlated
  `missing-shop-id`/`missing-actor-id`/`missing-entry-id`/`missing-service-id`/
  `missing-lines`/`missing-request-id` errors without invoking the service. Each
  result is projected through its own bounded public sanitizer
  (`publicCartResult`, `publicServiceResult`, `publicPreorderResult`,
  `publicTheftResult`) that strips the idempotency carrybacks, the raw order
  record/outcome, and the private `details`/`compensation` internals; the cart
  sanitizer caps the outcome `items` list at 20 and reduces each line to a bounded
  `{entryId, name, quantity, specialId?, specialPrice?}`, and `detail` is only
  emitted for a cart/preorder `insufficient-funds`/`service-refused` error,
  bounded to 200 characters. `handleTheft` calls ONLY `theft.attempt` (never
  `resolve`), so a client-supplied `success` never grants a free item - the GM
  adjudicates through `api.advanced.resolveTheft`. `buildRequestContext` and
  `attachHandler` now carry the four advanced services, `requestMessageData`
  copies only the allowlisted advanced fields (`lines`, `barterItemId`,
  `serviceId`) and never a client-supplied `success`/`price`/`gmUserId`, and
  `serverFailureData` fails closed as a correlated
  `cart`/`service`/`preorder`/`theft`/`server-error`. The runtime API exposes a
  GM-only `api.advanced` surface (`fulfillService`, `fulfillPreorder`,
  `cancelPreorder`, `resolveTheft`, `listOrders`): each method is guarded on THIS
  user being the active GM BEFORE any store read, always executes as
  `game.user.id` (never a caller-supplied GM id), reuses the SAME per-type public
  sanitizer, and `listOrders` projects each stored record through
  `publicAdvancedOrder` to only the bounded scalar fields - stripping the private
  `details`/`outcome`/`payload` and the idempotency `intentHash` - and fails
  closed as `{status:'error', error:'server-error'}` on a store read failure.
  A non-active GM resolves `{status:'error', error:'not-active-gm'}` for every
  method, and the raw service/store objects are not exposed.
- Tests (`tests/core.test.js`, `tests/ui.test.js`): cover the base catalog
  omitting backroom entries, the personalized catalog filtering by allowlist and
  reputation, an unowned actor not being able to probe a backroom-only shop, a
  forged restricted purchase failing closed (`entry-restricted` before any
  debit), a legitimate allowlisted/reputation-qualified purchase committing, the
  legacy no-`getSocial` allowlist/deny behavior, and `quotePrice` returning null
  for an inaccessible backroom to a player (and to a nonowned actor) while the GM
  may quote it.
- Advanced request/test coverage (`tests/core.test.js`, `tests/ui.test.js`): the
  advanced dispatch tests verify each of cart/service/preorder/theft routes to
  its service with the trusted hook `userId` as requester (and never passes a
  payload `userId`), the missing-field pre-validation rejects without invoking the
  service, a player `theft` request ignores a client-supplied `success` and only
  calls `attempt` (never `resolve`), `requestMessageData` copies only the
  allowlisted advanced fields and never `success`/`price`/`gmUserId`, each public
  sanitizer strips the private carrybacks/record/outcome/details, the bounded
  `detail` is only emitted for the documented cart/preorder errors, and
  `publicAdvancedOrder`/`listOrders` strip the private fields. The runtime test
  proves `api.advanced` is GM-gated (a non-active GM resolves `not-active-gm` for
  every method before any store read) and that the active GM routes into the live
  services and a strip-only `listOrders`.
- Storefront M5 controls (`src/ui/storefront.js`, `templates/shop.hbs`,
  `tests/ui.test.js`): the storefront now surfaces the advanced trade controls.
  A local `_data.cartLines` (`{entryId, quantity, specialId}`) holds the basket
  (at most 20 distinct **entry** lines - a line is unique by `entryId`, so at most
  one line may ever carry a given entry regardless of `specialId`; each 1..100, no
  client price), and adding a special over an existing regular entry replaces that
  line's `specialId` in place (keeping the accumulated quantity, never duplicating
  the entry line) while adding a regular entry over an existing line resets its
  `specialId` to `''` retaining the quantity - `remove-from-cart` is by `entryId`
  alone. `_prepareContext` derives the display `cartLines`/`cartTotal` from the sanitized
  catalog + public specials, `sellItems`/`barterItems` from the locally selected
  OWNED Actor's embedded Items (filtered by the server "one whole item" rule -
  `system.quantity` absent or 1), and `preorderEntries`/`theftEntries` from only
  `canPreorder`/`canAttemptTheft` entries. The eight controls (`add-to-cart`,
  `add-special-to-cart`, `remove-from-cart`, `checkout-cart`, `book-service`,
  `place-preorder`, `attempt-theft`, `sell-item`) dispatch through the same static
  `_action` pattern; the authenticated ones route through `_requestAdvanced`,
  which guards on active GM / selected actor / open shop / the shared `pending`
  flag, generates a per-type `requestId`, and sends ONLY the server-allowlisted
  fields (`lines`+`barterItemId` for cart, `serviceId`, `entryId`+`quantity`,
  `entryId`, `itemId`) - never a client `price`/`success`/`roll`. Responses are
  correlated on `requestId` AND rejected unless the echoed `actorId`+`shopId`
  match (`_advancedResponseMatches`), so a stale actor's advanced response never
  mutates the storefront. `_onAdvancedResponse` reports bounded, truthful status
  (a `booked` service/preorder/theft is never reported fulfilled/resolved), gates
  the replay path through `_isSuccessfulAdvancedReplay(type, result)` on the
  echoed `originalStatus` (a replay of a `failed`/`needsRecovery`/`pending`
  original is a recovery surface, never a completed message), clears the cart
  ONLY on a committed checkout or a replay whose `originalStatus` is `committed`,
  and refreshes the catalog only after a status that actually moved stock/funds or
  completed a sale.
  Cart is cleared on actor switch/checkout and pruned when a catalog refresh
  removes an entry. M1 direct `Buy` is preserved (it shares the pending flag but
  never sends cart lines).
- Manager M5 commerce editor & advanced-order adjudication
  (`src/ui/manager.js`, `templates/manager.hbs`, `tests/ui.test.js`): the GM-only
  manager now wires the M5 advanced commerce surface. `DEFAULT_OPTIONS.actions`
  gains fourteen entries (`save-commerce`, `add-service`, `save-services`,
  `remove-service`, `add-special`, `save-specials`, `remove-special`,
  `fulfill-service`, `fulfill-preorder`, `cancel-preorder`,
  `resolve-theft-success`, `resolve-theft-failure`, `next-orders`,
  `prev-orders`), each handled by the same static `_action` wrapper and each
  guarded on `_isActiveGM` (a non-active GM gets the shared `ACTIVE_GM_MESSAGE`
  notice and no read/write), though the manager still renders the editor,
  service/special rows and order list for viewing. `_prepareContext` derives fresh
  `serviceRows`/`specialRows` from the selected shop's `commerce` and sets
  `_data.isActiveGM`; `advancedOrders` is defaulted to `[]` and populated
  best-effort (active-GM gated) via `_listAdvancedOrders`. The advanced-order list
  pages through `status: 'booked'` records at the 100-record page size, tracking
  `_data.orderPage` and exposing `hasPreviousOrders`/`hasNextOrders` to gate the
  `next-orders`/`prev-orders` template controls, and steps back to a prior non-empty
  page if resolving an order empties the current page; the template reads the order
  kind as `order.kind` (the `{{#each}}` block param) and offers action buttons only
  for the actionable kinds (`service`/`preorder`/`theft`), with each button's
  disabled guard referencing `../isActiveGM` so the loop scope never shadows the
  active-GM flag.
  `_onSaveCommerce` reads ONLY the `.commerce-panel` top fields, maps the
  `unlimitedFunds` checkbox to `funds: null`, requires a strict safe integer
  otherwise (falling back to existing funds, then 0), merges the existing
  services/specials from the freshly re-read shop inside the shared per-shop lock,
  validates the whole `commerce` object with `normalizeCommerce` (an inverted
  buyback/buy rate fails closed), and patches only `{ commerce }`. The service and
  special editors persist add/save/remove under the same lock: add is capped at
  `MAX_COMMERCE_SERVICES`/`MAX_COMMERCE_SPECIALS` (20) with valid defaults;
  save merges edits by id into the freshly re-read persisted list (a row absent
  from the DOM is never dropped, a forged row id fails closed) and a non-empty
  special `entryId` must exist in the current inventory; remove drops only the
  matching id. `_onSaveEntry` is extended to read the per-entry `access` gate
  (`accessMode`/`accessActorUuids`/`accessMinReputation`, actor UUIDs comma-split
  and trimmed) only when the row carries the controls, preserving the persisted
  `minReputation` otherwise, and validates it via `normalizeInventoryEntry`.
  The order-adjudication handlers call the GM-only advanced service through
  `_advancedCall` (injected `deps[method]` or `api.advanced[method]`) with a fresh
  `requestId: makeId()` and `data-order-id`; `resolveTheft` is always passed a
  typed boolean `success`. Outcomes are reported truthfully through
  `_noticeForAdvancedAction`, and after an action the manager refreshes **orders
  only** (`_refreshOrdersOnly`), never the shop, so an unsaved appearance draft and
  in-progress inventory edits survive. `_refreshData` projects a comma-joined
  `accessActorUuidsText` onto the selected shop's inventory for GM display. Order
  buttons default to the `booked` status for a service/preorder card (a
  `pending`-status guestim would never match a booked order).
- Tests (`tests/ui.test.js`): cover the M5 manager actions - unlimited-funds null
  mapping, a finite funds save, an inverted buyback rate failing closed, service
  and special merge preservation plus forged-row-id fail-closed, a missing special
  `entryId`, actor-UUID validation, add/remove caps and non-active-GM gating,
  template `booked` gating + disabled-for-non-active-GM buttons (asserting the
  order-loop guards step to the parent `../isActiveGM` scope), ordering paging
  (101 booked orders -> 100 on page 0 plus a next page, an old booked order
  reachable on page 1, stepping back, and falling back to a non-empty page when
  the current page empties), `fulfill-service` calling with a `requestId`, the
  non-active-GM guard, typed `resolveTheft` success/failure, `_onSaveEntry` access
  persistence/min-reputation preservation/no-reset, and `_refreshData` projecting
  `accessActorUuidsText`. The storefront M5 suite additionally covers cart-line
  uniqueness by `entryId` (adding a special over a regular entry replaces the line
  in place without a duplicate, a regular add resets the `specialId` back to `''`,
  removal is by `entryId` alone, and checkout sends only unique lines with no
  client price).
- M6 GM valuation UI (`src/ui/manager.js`, `src/ui/storefront.js`,
  `templates/manager.hbs`, `templates/shop.hbs`, `src/core/requests.js`,
  `tests/ui.test.js`, `tests/core.test.js`): the manager gains a `.valuation-panel`
  inside the social panel that reuses the reputation Character selector to choose
  whose items are valued, an item select `valuationItemId`, a `valuationAmount`
  number (`min 1`) and an `approve-valuation` action (active-GM gated, validates
  character/item/positive whole number before calling the GM-only
  `api.advanced.approveValuation`), and the storefront only offers a whole item for
  sell/barter when the personalized catalog includes it in the public
  `shop.approvedItems` allowlist - it never offers an unapproved item and shows the
  "Ask the GM to value an item before selling or bartering it." message when a
  character is selected and none is approved. The requests layer builds
  `approvedItems` only for an owned actor after ownership validation, projecting
  the up-to-100 matching `{itemId, amount}` pairs whose `fingerprintItem(item)`
  matches the stored fingerprint, while the base catalog keeps `[]`.

### M5 review blockers resolved

The seven code-review blockers raised for the M5 advanced commerce slice are all
resolved and covered by the test suite:

- **Null-write compensation.** Every effectful `store.updateShop` in the advanced
  engines (cart, service, preorder place/fulfill/cancel, selling, theft) now
  captures the returned shop and throws `new Error('shop-write-missing')` when it
  is `null`, so a committed/booked/fulfilled order is never reported on a
  disappearing write. The existing compensation/recovery branches treat that throw
  as a shop-write failure (deciding status by re-reading the current shop and
  escalating to `needsRecovery` when mixed/missing), and `shop-write-missing` is
  an allowlisted public error code surfaced by the sanitizers and storefront.
- **Preorder cross-action race.** A `preorder-fulfill` or `preorder-cancel` action
  now scans EVERY `preorder-fulfill` and `preorder-cancel` record for the same
  original order across all pages (`findPendingActionForOriginal`) before creating
  a new action key; a still-pending/needsRecovery action (even of the other kind,
  or with a different requestId) surfaces `needsRecovery` and never re-runs the
  second action.
- **`bartered` phase validation.** `'bartered'` was added to
  `ADVANCED_ORDER_PHASES`, so the successful barter phase validates in the record
  and the compensated fail path is covered too.
- **Replay `originalStatus`.** Replay responses from cart/selling/services/preorders
  carry the recorded `originalStatus`; a persisted `failed` original returns a
  replay with `originalStatus: 'failed'`. The storefront's `_isSuccessfulAdvancedReplay`
  treats a replay as success only for the type's success set and never shows a
  'completed' message on a failed replay.
- **Personalized `publicSpecials` price.** The personalized catalog prices a
  special through `quoteSocial({ ...entry, price: special.price }, 1, { shop,
  scores }).unitPrice` (never the raw `special.price`), while the base raw price is
  kept for the unpriced base catalog; the `specialPrice` on a cross-referenced
  entry and the `shop.specials` price agree for an owned actor.
- **Re-read-throws recovery after a terminal original write.** When the
  original-order `updateAdvancedOrder` status write itself throws after persisting
  (preorder fulfill/cancel, theft grant/refusal), the engine re-reads the original.
  If the re-read confirms the terminal status, effects are preserved and the action
  escalates to `needsRecovery`. If the re-read itself throws or the original is
  missing (re-read-unavailable), the original is treated as terminal so
  compensation is skipped, the applied effects are preserved, the action escalates
  to `needsRecovery`, and the existing unresolved-action guard
  (`findPendingActionForOriginal` for preorders, `findUnresolvedTheftAction` for
  theft) blocks any future related action for that original.
- **Personalized special-pricing consistency (catalog + cart).** `projectSpecials`
  now quotes a special's effective price ONCE per eligible special via the same
  `quoteSpecialPrice` callback used to build the list, and uses that identical
  value for the public list `price` AND any single-offer `entry.specialPrice`
  cross-reference - so list and cross-reference always agree and the raw
  `special.price` is never surfaced directly in the personalized case. The
  storefront `_cartDisplay`/`cartTotal` takes a special line's price only from the
  selected actor's personalized `shop.specials[].price` (never `entry.specialPrice`
  or a raw price); when NO character is selected the cart is annotated as an
  estimate and checkout is disabled, so the displayed total always equals the GM
  checkout quote.

### Constraints honored (M5)

- `SCHEMA_VERSION` remains `1`; M2/M3/M4 shop and entry shape is preserved and
  old shops/entries normalize unchanged operationally.
- The advanced-order store is additive: it adds a GM-private `advancedOrder`
  record kind and its store helpers without modifying the M1 ledger record, the
  purchase path, or any commerce/request/UI surface. No cross-GM atomicity is
  claimed - order create is a read-then-create (like `createLedger`), not a
  server-side CAS.
- The sell/buyback service mirrors the same additive discipline: it only reads
  `findShop`/`findAdvancedOrderByKey` and writes `updateShop`/
  `createAdvancedOrder`/`updateAdvancedOrder` (plus the injected actor/adapter),
  never touches the M1 ledger record, the purchase path, or any request/UI
  surface, and shares the per-shop `runShopExclusive` lock with purchases so a
  sell and a buy never interleave their shop writes. Its `sell` is fully
  idempotent (replay/conflict/needsRecovery resolution before effects) and never
  re-applies a pending order's effects.
- The access gate is wired without adding an effectful service or a store write
  beyond the existing ones: `commerce`/`requests`/`runtime` are now touched only
  to enforce `canAccessEntry` on the catalog, purchase and quote surfaces (the
  M1/M2 public purchase path is otherwise unchanged, and `quoteSpecial` still
  only reports a special's price without overriding `quote(...)`). No UI change.
- Validation fails closed: a malformed commerce/access value (out-of-range rate,
  unqualified buyback rate, over-cap array, invalid actor UUID, out-of-range
  reputation/deposit/max-per-actor, empty service/special name/title, unsafe
  `funds`) throws at GM save rather than silently dropping data.
- The cart checkout is single-payer and does not debit any other actor: only the
  request `actorId` is charged/received against, and a group cart is treated as a
  single payer accumulating a shared selection until an explicit cost-sharing /
  consent model exists (documented in `docs/architecture.md`; no other
  contributor is charged). It follows the same additive discipline as the sell and
  service services - it only reads `findShop`/`findAdvancedOrderByKey` and writes
  `updateShop`/`createAdvancedOrder`/`updateAdvancedOrder` (plus the injected
  actor/adapter), never touches the M1 ledger, the purchase path, or any
  request/UI surface, shares the per-shop `runShopExclusive` lock with purchases,
  and never claims distributed atomicity (it is a compensating idempotent order).
  The optional item-for-price barter honors the same boundaries: it is an additive
  `barterItemId` payload field carried through the request channel
  (`requestMessageData`/cart dispatch; no UI control yet), it is part of the
  intent hash, it never pays cash out (the credit is capped at the cart gross
  total; only the cash remainder is debited and only that is gained by merchant
  funds), and it restores the exact tender on compensation via a `keepId`
  snapshot.
- The pre-order service honors the same additive discipline: it only reads
  `findShop`/`findAdvancedOrder`/`findAdvancedOrderByKey`/`listAdvancedOrders` and
  writes `updateShop`/`createAdvancedOrder`/`updateAdvancedOrder` (plus the
  injected actor/adapter), never touches the M1 ledger, the purchase path, or any
  request/UI surface, shares the per-shop `runShopExclusive` lock with purchases,
  and never claims distributed atomicity (it is a compensating, idempotent
  advanced-order transaction that escalates to `needsRecovery` on an uncertain
  compensation). It never reserves stock on place (the entry quantity stays
  untouched until fulfillment), uses only the existing order model statuses and
  kinds (`preorder`/`preorder-fulfill`/`preorder-cancel` + `booked`/`fulfilled`/
  `cancelled`/`committed`/`failed`/`needsRecovery`), and keeps the whole flow
  GM-only with no caller-supplied GM identity - the executing user is always the
  trailing `authenticatedUserId`/`gmUserId` argument and `isActiveGM` gates every
  entry point.

### Remaining M5

- **GM-approved item valuation is wired and surfaced in the UI.** A whole
  item a player owns back to a shop (sell/buyback) and a whole-item barter tender
  are no longer priced from the item's own system `price` (a player can inflate
  that value and silently mint currency or buy goods). The M6 valuation slice
  (`src/advanced/valuation.js`, `tests/advanced-valuation.test.js` + the validated
  `shop.commerce.valuations` schema) provides the GM-authored approval mechanism -
  a pure `fingerprintItem` canonical fingerprint, a GM-only `approve`, and a pure
  `getApprovedValuation`/`findApprovedValuation` read side - and `src/core/main.js`
  now constructs the valuation service and injects its full-entry
  `getApprovedValuation` into the selling/cart services, so a sale/barter is
  priced at the approved valuation and consumes it at commit (a single approval
  never mints repeated payouts). Both paths still fail closed
  `gm-approval-required` before the pending order when no matching still-valid
  approval exists. The GM manager `.valuation-panel` now exposes approval (reusing
  the reputation Character selector; `valuationItemId`/`valuationAmount`/
  `approve-valuation`, active-GM gated), and the personalized catalog projects a
  public `shop.approvedItems` allowlist (`{itemId, amount}` pairs only, built
  from matching actor-owned live Items whose `fingerprintItem` matches the stored
  fingerprint) that drives the storefront: its sell/barter selects only offer a
  whole item present in that allowlist, showing the "Ask the GM to value an item
  before selling or bartering it." message when a character is selected and none
  is approved. No GM price authority stays with the player. The only remaining
  item here is the live runtime verification listed below.
- **Shared funded carts are not built.** A "group cart" is a single payer
  accumulating a shared selection: only the request `actorId` is ever debited,
  and no other contributor is charged. The explicit cost-sharing/consent model
  that would split a total across several actors (each contributing their own
  share to a shared, funded cart) is **not implemented**.
- **Live verification is pending.** The storefront advanced trade controls (cart
  lines, barter checkout, service booking, preorders, theft claims, and
  whole-item selling) and the manager commerce editor + advanced-order
  adjudication are now wired, but neither has been verified against a live
  Foundry VTT 14 runtime. This slice provides the validated configuration, the
  pure access/quotation helpers, the backroom eligibility enforcement on the
  catalog/purchase/quote surfaces, the GM-authoritative whole-item sell/buyback
  service, the GM-authoritative service booking/manual-fulfillment service
  (implemented WITHOUT delivering an item: `book` debits the player once and
  grants the finite merchant funds the price, and the service stays `booked`
  until a GM manually confirms delivery via `fulfill`, which only records the
  acknowledgement - no item is created), the GM-authoritative single-payer cart
  checkout, the GM-authoritative out-of-stock pre-order service with paid deposit
  (place/fulfill/cancel), and the GM-authoritative theft adjudication service
  (attempt/resolve). Merchant `commerce.funds` are live, not a deferred quota:
  an M1 direct Buy and the advanced cart/service/preorder paths gain the
  collected currency in the same shop patch, and a whole-item sale decrements
  finite funds (`null` funds stay unlimited).
- **Cross-client uniqueness for advanced orders (M6).** The active-GM shop lock
  and the `createAdvancedOrder` read-then-create are per-client and do not
  guarantee key/entry uniqueness across two simultaneous GM clients (under a GM
  handover or two GM clients processing the same sell/book concurrently, both
  can read "no order" and both can apply effects). No cross-client atomicity is
  claimed; verifying and hardening this against two live GM clients is deferred
  to M6 testing.
