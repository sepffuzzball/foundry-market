# Foundry Market

A marketplace core module for Foundry Virtual Tabletop v14. Locations, shops and
inventory are stored in GM-only JournalEntry flags; purchases are executed only
by the active GM through an idempotent, compensating ledger; and requests flow
over ChatMessage (no raw socket).

This is **Milestone 1 (M1)** and a **prerelease developer preview**: the
functional core plus the first end-to-end UI wiring. The market manager (GM),
the player storefront and the canvas shop markers are all wired to the working
core through the request channel and the GM-only store. The runtime has **not**
been executed against a live Foundry VTT 14 install yet - it is wired and
unit-tested in Node only.

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

   Foundry reads the manifest, which pins module id `market`, version `0.1.1`
   and the **download URL** it uses to fetch the module zip:

   ```
   https://github.com/sepffuzzball/foundry-market/releases/download/0.1.1/module.zip
   ```

3. Install, then enable the `market` module in the target world.

> **The `download` URL is not live until the `0.1.1` tag's release action has
> completed** - it must upload `module.zip` and `module.json` to a GitHub release
> for tag `0.1.1`. Until that release exists, install the module by pointing
> Foundry at this repository directory as a module source (the manifest and
> `src/core/main.js` are unchanged), or download the zip from the release once
> it is published.

### Enable in a world

Open **Settings > Manage Modules**, tick **market**, then **reload the world**.
On load, `game.modules.get('market').api` is exposed with `store`, `commerce`,
`getAdapter`, `request`, `openManager`, `openShop`, `placeShop`.

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

### Setup examples

**dnd5e** - the built-in adapter. Currency is integer copper and item prices are
read from `system.price.value`/`denomination`, so no configuration is needed
beyond Items whose price is set:

```js
game.modules.get('market').api.getAdapter('dnd5e'); // supported
```

**generic** - the configurable fallback. Configure the world-scoped settings
under `market` before use (wallet/price dot-paths, delivery mode):

```js
game.settings.set('market', 'genericWallet', 'flags.wallet.balance');
game.settings.set('market', 'genericPrice', 'system.price.value');
game.settings.set('market', 'genericDeliveryMode', 'embedded');
```

### Risks

- **Live Foundry VTT 14 runtime is not yet tested.** M1 is wired and unit-tested
  in Node only (the mocks install `game`/`Hooks`/`CONST`, `JournalEntry` and the
  actor document API), so the exact `ApplicationV2`/`HandlebarsApplicationMixin`
  UI and `dropCanvasData` hook shapes should be re-checked against a real v14
  install. Run `docs/smoke-test.md` before trusting a live economy.
- **Concurrency across GMs is best-effort.** The per-shop lock serializes
  purchases within one client only; across multiple GM clients the ledger is the
  only cross-client guard and it is a read-then-create, not a server-side CAS.
  Under a GM handover or concurrent multi-GM processing both clients can charge.
- **No live use yet.** The module has been exercised in tests only; the smoke
  checklist is the intended first real-runtime check.

## What works (M1)

- **UI (wired, not system-tested)**:
  - **Market Manager** (`MarketManager`, GM-only): create/select locations and
    shops, edit shop details and inventory, add items by UUID or via a
    searchable world/compendium picker, drag-drop Items onto the shelf, edit
    quantity/price/stock mode/visibility, remove entries, place a canvas marker
    and open a player preview. Opened from the Journal sidebar button, the
    Settings > Market menu, or `game.modules.get('market').api.openManager()`.
  - **Player Storefront** (`MarketStorefront`): requests the catalog through the
    request channel, correlates the response by `requestId`, only trusts
    GM-authored responses, never reads the private store, offers only actors
    the player owns, and disables purchase while there is no active GM / the
    request is pending / the shop is closed / an entry is out of stock.
    Opened via `api.openShop(shopId)` or by clicking a canvas marker.
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
  - `generic` - configurable fallback. You (GM) configure dot-paths for the
    wallet and item price plus a delivery mode. Until configured it reports
    `supported === false`.
  - `daggerheart`, `dc20`, `twodsix` - explicitly report **unsupported** until
    you configure the generic adapter paths. No paths are guessed.
  - Item delivery preserves the full `item.toObject()` minus `_id`,
    `ownership`, `folder`, `sort`, and never mutates the source item.
- **Requests** (`api.request(payload)`): send a `catalog` or `purchase` request
  as a ChatMessage whispered to the GMs. The active GM processes it through
  `Hooks.on('createChatMessage', (message, options, userId))` and whispers a
  response back to the requester and all GMs. Responses expose only allowlisted
  public shop fields and visible inventory fields - no item `system` data and no
  `itemUuid`.

## Adapter setup

The Marketplace is currency-agnostic: prices are stored as integer **minor
units** (the smallest currency unit). For dnd5e the minor unit is copper. For
generic systems you choose the integer scale and configure the paths.

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
npm test      # node --test tests/
npm run lint  # node --check on every JS source file
npm run build # sh scripts/package.sh -> dist/module.zip + dist/module.json (requires zip)
```

The module itself has no build step: `npm test` and `npm run lint` are
intentionally dependency-free. `npm run build` only packages the release zip
(release workflow asset); it does not transform the runtime source.

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
