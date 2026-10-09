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
  `download` release pointers, with `version` `0.1.1`).
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
- Download URL (from the manifest): `https://github.com/sepffuzzball/foundry-market/releases/download/0.1.1/module.zip`

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
GitHub release was created, so the `0.1.0` download URL is superseded by `0.1.1`.
The `0.1.1` release URL is only functional once that tag's `release` job has
completed and published the `0.1.1` GitHub release (the workflow now sets up
Node 22, where `crypto.getRandomValues` is available). Until then, install by
pointing Foundry at the repo directory as a module source, or from the published
release once it exists.

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
