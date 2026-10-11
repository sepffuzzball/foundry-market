# Foundry Market - M1 Manual Smoke Test (Foundry VTT v14)

This is a practical, manual checklist for verifying the M1 `market` module
against a live Foundry VTT **14** install. The automated `npm test` suite mocks
the Foundry boundaries (`game`/`Hooks`/`CONST`, `JournalEntry`, the actor
document API) and runs in plain Node, so it cannot prove that the module behaves
under a real Foundry runtime. This checklist is the intended real-runtime check.

It is not exhaustive and not automated: run it by hand, one section at a time,
with a fresh world where you can discard the data. You need at least two browser
clients (one on an **active GM** user, one on a **player** user). The player
client is the one that exercises the storefront.

This checklist targets the current **0.1.8** prerelease. **No live Foundry VTT
14 verification has been run yet** for M1-M6 - the automated `npm test` suite
only mocks the Foundry boundaries, so every section below is the intended manual
real-runtime check and nothing here has yet been confirmed on a live install.

> **Do NOT use the module for a live economy yet.** M1 has not claimed
> completion and two blockers remain before it is safe for real play:
>
> 1. **Multi-GM concurrency is not a distributed guarantee.** The per-shop lock
>    is per-client, so the only cross-client guard is the ledger, and that guard
>    is best-effort (a read-then-create, not a server-side CAS). See
>    `docs/architecture.md`. If two GMs may process purchases at the same time,
>    test that scenario specifically before going live.
> 2. **V14 manual verification is incomplete.** This checklist is how you close
>    that gap. Until you have run it end-to-end and confirmed the
>    `ApplicationV2`/`HandlebarsApplicationMixin` UI and the `dropCanvasData`
>    hook shapes behave in v14, treat the runtime as unverified.

---

## 0. Preconditions

- Foundry VTT **14** installed and running.
- A **world** with a supported system. The default adapter is dnd5e (currency in
  integer copper); `generic` is the configurable fallback. See
  `README.md` -> "Adapter setup".
- Gambling room: the world should have a **Scene** with a **canvas** you can
  drop onto.
- Two users, both able to log in from separate browser tabs/clients:
  - a **GM** user (make it the active GM).
  - a **player** user owning at least one **Actor** with **funds** (currency).
- A source Item to sell. In dnd5e this is an Item whose
  `system.price.value` is set; the marketplace reads that price (in copper) and
  does not require you to type a price in the manager for that path. For
  `generic`, configure the wallet/price paths first.

---

## 1. Installation / loading

1. Install the module. Recommended: on the Foundry Setup screen, **Install
   Module** and paste the manifest URL
   `https://raw.githubusercontent.com/sepffuzzball/foundry-market/main/module.json` -
   Foundry then fetches the release zip from the manifest's `download` field.
   Alternatively, point Foundry at the repository directory whose `module.json`
   is the manifest. `src/core/main.js` is the ESM entry; there is no
   build/transpile step.
2. Enable the `market` module in the world, then reload the world.

**Expected**

- The module loads without console errors.
- No errors on `init`/`ready`.
- `game.modules.get('market').api` is defined in the console and exposes
  `store`, `commerce`, `getAdapter`, `request`, `openManager`, `openShop`,
  `placeShop`.
- The Settings menu shows a "Market" entry (via `registerMenu`) and the Journal
  sidebar shows the Market Manager button.

---

## 2. GM creates two locations and shops

1. As the **GM**, open the **Market Manager** (Journal sidebar button, Settings
   > Market, or `game.modules.get('market').api.openManager()`).
2. Create **location A** and **location B**; give each a name, description and
   theme.
3. Under location A, create **shop 1**; under location B, create **shop 2**.
   Leave both shops `open`.
4. Confirm both shops appear under their locations in the manager list.

**Expected**

- Two locations and two shops are created and listed.
- No duplicate/blank entries; names persist after the manager is reopened (they
  are persisted in GM-only JournalEntry flags).

---

## 3. Add the original source Item and set price/quantity

1. In the manager, open **shop 1**.
2. Add an inventory entry using the **source Item by UUID/searchable picker** (do
   not drop it - use the "add by UUID" or picker path). Choose the real Item from
   the world/compendium. Do **not** rely on a snapshot only - we want the
   `itemUuid` to point at a real document for section 12.
3. Set **price** and **quantity**. For dnd5e, the price is read from the Item's
   `system.price.value`/`denomination`, and you edit quantity/stock mode here.
   For `generic`, set the price via the configured `genericPrice` path.
4. Set **stock mode** to `finite` and **quantity** to a small number (e.g. 2) so
   you can test stock thinning later.
5. Save. Reopen the shop and confirm the entry persists with the values you set.

**Expected**

- The entry is created, references the original Item by UUID, and the edited
  price/quantity/stock mode persist after reopening.
- Editing a quantity/price inside `runShopExclusive` does not clobber a
  concurrent purchase's stock change (no automated way to force a race here, so
  just confirm the values stick).

---

## 4. Drag a shop to the scene (canvas marker)

1. As the **GM**, drag **shop 1** element onto the canvas (or use "Place shop").
2. Confirm a **Scene Note** with the shop icon is created at the drop point.

**Expected**

- A public marker JournalEntry (default `OBSERVER`) plus a Scene Note with
  `flags.market.shopId` is created.
- No private store data is copied into the marker.
- The market storefront does not open just from placing the marker; it opens only
  when the Note is clicked (section 6).

---

## 5. Player controls an Actor with funds

1. As the **player**, confirm the Actor you intend to use is **owned** by you
   (the storefront only offers actors the player owns).
2. Give that Actor enough currency to cover the price of the Item in shop 1 (for
   dnd5e, a wallet balance in copper >= the item price).

**Expected**

- The player cannot buy with an actor they do not own.
- The owned Actor appears in the storefront's actor selector and its wallet
  balance is non-zero (nonzero only if you funded it).

---

## 6. Player opens the shop via the Note

> **Status: template parse failure fixed (in `0.1.6`), live retest still pending.**
> The storefront template (`templates/shop.hbs`) previously left the
> `{{#if actors.length}}` block unterminated, so opening the storefront failed at
> render time with a Handlebars parse error ("Parse error ... EOF expecting
> `{{/if}}`"). That block is now closed (shipped in the `0.1.6` patch prerelease)
> and the template is guarded by an
> automated block-balance unit test in `tests/ui.test.js`. It has **not** yet
> been re-confirmed on a live Foundry VTT 14 install - run this section again
> before treating the storefront as verified. Do not mark this section as
> live-tested by the automated suite.

> **Status: with `0.1.6` installed a market map marker click may open the Journal;
> the `0.1.7` routing fix is not yet live-tested.** The `activateNote` handler
> previously read only `note.document.flags.market.shopId`, so a market marker
> whose Note carried no such flag (e.g. a Market journal dragged from the Journal
> sidebar, or a directly-created marker) fell through to the default Journal sheet
> instead of the storefront. The **`0.1.7` prerelease** routes the click via the
> linked `MarketShop` journal when the Note flags are absent: `handleActivateNote`
> now resolves the shop id from the Note's own flags and, when those are absent,
> from the linked JournalEntry (`note.entry`, or via `game.journal.get` on the Note
> document's `entryId`) - but only when that journal is a validated `MarketShop`
> entry, so an ordinary linked Journal note is unaffected. It fails closed (opens
> nothing) when the Note flags and the linked journal disagree, and never lets an
> `openShop` rejection make the hook async. This `0.1.7` fix has **not** yet been
> re-confirmed on a live Foundry VTT 14 install - run both marker paths below
> again. Note the split: a **double-click** on the map marker (the Note activation
> path) is what these steps route to the storefront; a **direct click** on the
> market JournalEntry in the Journal directory is a separate, intentionally
> unhandled path that still opens the plain Journal sheet.

1. As the **player**, click the Scene Note created in section 4 (the double-click
   on the Note after dropping a shop element on the scene). Confirm the
   **Market Storefront** opens, not the Journal sheet.
2. As the **GM**, also drag a Market journal from the Journal sidebar onto the
   scene to create a second marker, then as the **player** click that Note. Confirm
   the storefront opens (the sidebar-drag marker must route the same way).
3. As the **GM** (or player), also open the storefront via the manager's **View
   storefront** button. Immediately confirm the console reports **no
   Handlebars parse failure** (no `Parse error ... EOF expecting {{/if}}`
   message) - a blank/erroring storefront on either path is a regression.

**Expected**

- A **click** (double-click, i.e. the Note activation path) on a market marker -
  whether it was created by dropping a shop element (section 4) or by dragging a
  Market journal from the Journal sidebar - opens the **Market Storefront**
  instead of the Journal sheet (the Note handler suppresses the default journal),
  and the storefront renders without a Handlebars parse failure on **both** the
  Note path and the manager's **View storefront** path.
- A **direct click** on the market JournalEntry in the Journal directory is
  **not** supported in this milestone: it still opens the plain Journal sheet, not
  the storefront. Only the canvas Scene Note routes to the storefront.
- The storefront shows shop 1's catalog, including the entry from section 3.
- The entry's `system` data and `itemUuid` are NOT exposed - only the allowlisted
  public fields (id, name, img, price, quantity, stockMode, visible) are shown.
- Purchase controls are **disabled** only if there is no active GM, the request
  is pending, the shop is closed, or the entry is out of stock. With a healthy
  state they should be enabled.

---

## 7. Buy and confirm currency / stock / item data

1. As the **player**, select the owned Actor (section 5), choose the entry, set a
   valid quantity, and Buy.
2. In the GM and player clients confirm the request/response ChatMessages appear
   (whispered, flagged `market`, OOC style).

**Expected**

- The player's currency decreases by the quoted total (dnd5e: coin totals in
  copper; `generic`: configured wallet integer).
- The Item is delivered to the Actor. Delivery uses the full `item.toObject()`
  with `_id`/`ownership`/`folder`/`sort` stripped, and the **source Item is not
  mutated**.
- The shop's inventory **stock quantity** decreased by the purchased amount.
- A ledger `JournalEntry` is created with a `committed` status for this
  `userId:requestId` key.
- The stored price from the Item was used (not a guessed value).

---

## 8. Hidden entry (visibility off)

1. As the **GM**, edit shop 1's entry and toggle **visible** off.
2. As the **player**, reopen the storefront (or refresh the catalog).

**Expected**

- The hidden entry no longer appears in the player catalog (the public catalog
  is filtered to `visible` entries), while the shop itself still opens.
- A direct purchase targeting the hidden `entryId` is rejected as
  `entry-not-visible` (you can only trigger this via `api.request`/console, since
  the UI does not list the hidden entry).

---

## 9. Closed shop

1. As the **GM**, set shop 1 to **closed** (not `open`), or open shop 2 with
   shop 1 closed, and have the player target shop 1.
2. As the **player**, attempt to buy from shop 1.

**Expected**

- The storefront opens but purchase is **disabled** (or the request is rejected
  as shop-closed), and no currency is moved.
- Reopening shop 1 restores purchases.

---

## 10. Offline / no active GM

1. Log the **GM** user out (or disconnect the active GM so no user is an active
   GM), then, as the **player**, open the storefront and try to buy.

**Expected**

- The storefront disables purchase (no active GM) or the request cannot be
  processed; nothing is charged.
- Logging the GM back in restores purchase ability.

---

## 11. Duplicate request ID

1. As the **player**, issue a purchase with a specific `requestId` (via
   `api.request` or the storefront Buy) and let it succeed.
2. Re-issue the **same** request with the **same** `requestId` and the **same**
   payload.

**Expected**

- The second identical request **never charges again** - it resolves as `replay`
   (or `pending` if the first is still pending) rather than charging twice.
- Issuing the **same** `requestId` with a **different** payload (e.g. different
   quantity) is rejected as `conflict` and does not charge.
- A purchase request with a **missing** `requestId` is rejected rather than
   auto-generated.

---

## 12. Two players contend for the last Item

1. Set shop 1 entry quantity to **1** (stock mode `finite`).
2. Have **two different players** each own an Actor with funds and both attempt
   to buy the last unit, as close to simultaneously as you can manage.

**Expected**

- Exactly **one** purchase succeeds and the stock does **not** go negative.
- The second player either sees the entry as out of stock (purchase disabled) or
  gets a rejection such as `insufficient-stock`; their currency is not debited for
  the failed attempt.
- If you can arrange two GM clients, note that this is the binary-risk scenario
  from section `> Do NOT use...`; the per-shop lock only serializes within one
  client. Verify the ledger guard holds or note the failure.

---

## 13. Reconnect / restart persistence

1. As the **GM**, make some changes (add/rename a shop, edit an entry, make a
   purchase).
2. **Reload the world** (F5) on both the GM and player clients. Do **not**
   recreate data.

**Expected**

- All locations, shops, inventory, and ledger entries **persist** across the
   reload (they live in GM-only JournalEntry flags) - nothing is lost.
- The Market Manager still shows the same data; the storefront still opens the
   shops; the ledger is intact.
- Logging out and back in (or restarting the server) does not change the above.

---

## 14. Deleted source Item -> snapshot fallback

1. Make another entry in shop 1 that is **snapshot-backed**: since the module
   stores a `snapshot` of the item data, do NOT delete the original Item for
   this entry yet.
2. Make a purchase - confirm it uses the `itemUuid` source normally.
3. Now **delete the original source Item** (the one the entry's `itemUuid`
   points to) from the world/compendium, leaving the entry with only its stored
   `snapshot`.
4. As the **player**, buy that entry again.

**Expected**

- The purchase still succeeds by falling back to the stored **snapshot** instead
   of failing because the UUID is gone.
- The delivered Item is a copy of the snapshot data (with the normally-stripped
   fields removed), not a broken reference.

---

## 15. M2 - Theme, appearance and storefront interactions

> **Status: Node-tested only.** The M2 CSS themes and interactions are verified
> by the automated `npm test` suite in Node. This section is the intended
> real-runtime check for the M2 UI: the `ApplicationV2` action dispatch
> (including `data-action` on a `select` for sorting), the v14 `FilePicker`
> constructor and the `foundry.audio.AudioHelper.play` call have NOT yet been
> exercised on a live v14 install.

### 15.1 GM sets a theme and appearance (and previews it)

1. As the **GM**, open the Market Manager, select a shop, and set the **theme**
   preset and an **accent color** (`#rrggbb`), then click **Preview appearance**.
2. Confirm the preview panel updates to reflect the current (unsaved) form -
   including a theme/accent you just typed but have NOT saved.

**Expected**

- The preview reflects the live form, not the last saved shop.
- Clicking **Preview** does NOT persist anything (reopen the shop and the old
  values remain until **Save changes**).
- Switching location or shop clears the preview.
- Entering an invalid accent (e.g. `red`) or an unsupported media path (e.g. an
  `https://` URL) shows a notice and does NOT write to the store.

### 15.2 GM browses a local media file

1. Use the **Browse** button on a music/sound-effect field and confirm it opens
   an **audio** picker; use it on a portrait/background field and confirm it
   opens an **image** picker.
2. Pick a file and confirm the matching input is populated; save and reopen to
   confirm the value persists.

**Expected**

- The correct picker type opens for each field.
- The chosen path is written into the matching input; an invalid/remote path
  shows a notice rather than being saved.

### 15.3 Player browses a themed storefront

1. As the **player**, open a shop whose GM set a theme and appearance. Confirm
   the storefront renders with the theme's art direction, the custom accent
   applied, and the hero background image only if a valid local path was set.
2. Use the **category tabs**, the **search** box and the **sort** dropdown.

**Expected**

- The catalog filters by category, searches by name/category/rarity/description,
  and sorts by featured (catalog order) / name / price (ascending).
- The category tabs list **All** plus every distinct category present in the
  visible public inventory; entries with `visible: false` are absent.

### 15.4 Player inspects an item

1. Click a product card (or focus it and press **Enter**/**Space**); confirm the
   item detail panel opens.
2. Close it with the **×** button. Filter/sort/search so the selected item is
   excluded, then include it again.

**Expected**

- The detail panel shows only that entry's public fields (name, image, category,
  rarity, public description, price); no item `system` data or `itemUuid`.
- The detail hides when the item is filtered out, and the **Buy** button still
  works from both the card and the detail panel.

### 15.5 Player toggles sound (music + purchase effect)

1. As the **player**, toggle **Sound on** in a storefront whose GM set a valid
   `appearance.music` path. Confirm the music plays.
2. Toggle **Sound off** - confirm it stops. Also confirm sound stops when the
   storefront is closed, or when the catalog changes/errors.
3. Leave sound on and make a successful purchase where the GM set a valid
   `soundEffect` path; confirm the one-shot plays.

**Expected**

- Background music plays only after an explicit **toggle**, never automatically.
- The purchase sound effect plays only when sound is enabled AND the path is
  valid; a playback error surfaces a readable notice and is not sent over the
  socket.

### 15.6 Viewport sizing

1. Open the storefront and confirm it fills most of the viewport (minus a margin)
   after the first render. Resize the browser window and confirm it follows.

**Expected**

- No browser Fullscreen API permission prompt is shown.
- The window is sized against the available viewport and resizes with the window.

## 16. M3 - Social, NPC and reputation wiring

> **Status: Node-tested only.** The M3 social/NPC/reputation editor wiring and the
> personalized storefront quote are verified by the automated `npm test` suite in
> Node. This section is the intended real-runtime check.

### 16.1 GM configures the shop social settings

1. As the **GM**, open the Market Manager, select a shop, and set the social
   config (primary/secondary personality, weights that sum to 100, shop markup)
   and click **Save social**.
2. Confirm the values persist after reopening the shop.
3. Enter weights that do NOT sum to 100 (e.g. 70 + 20) and save.

**Expected**

- A valid social config is persisted under the per-shop lock, and the primary
  (first) NPC's personality is synchronized to the chosen social primary without
  touching any still-unsaved appearance draft.
- An invalid weight sum shows a notice and does NOT write to the store.

### 16.2 GM manages the merchant roster

1. Add, edit and remove NPCs in the merchant roster; try to add a fourth.

**Expected**

- At most three merchants; adding a fourth shows a notice.
- Saving normalizes each row (a bad portrait or blank name shows a notice and
  does NOT write), and the owner string + social primary sync from the first
  merchant.
- Removing a merchant never deletes the shop and reassigns the owner to the new
  primary.

### 16.3 GM adjusts a character's reputation

1. As the **GM**, pick a character in the reputation editor, set a non-zero delta
   and a reason, and adjust.

**Expected**

- The reputation record updates, the history shows the committed entry (most
  recent first, capped at 10) and the UI reloads the new standing.
- A zero delta or a missing reason shows a notice and does not call the API.

### 16.4 Player gets a personalized, private-free quote

1. As the **player** owning an Actor, open the storefront and select that Actor.
   Confirm the catalog now shows per-actor prices, a relationship panel with a
   modifier text, and (when browsing an entry) a price breakdown
   (base/adjustments/final, basis points as signed percentages).
2. Switch to a different owned Actor and confirm the previous actor's prices /
   standing do NOT bleed over, and the new quote appears after the refresh.
3. Set the actor's standing to Hated (via the GM reputation editor) and confirm
   the Buy buttons disable and a purchase is refused with a readable message.
4. Confirm the storefront never shows the GM-only party id or a raw reputation
   record.

**Expected**

- No private store data is exposed; only the public merchants and a sanitized
  relationship reach the player.
- A stale actor's catalog response is discarded (correlation on `requestId` +
  `actorId`).

## 17. M4 - GM automation editor (hours, travel, events, restock, inventory generation)

> **Status: Node-tested only.** The M4 GM automation editor UI, the active-GM
> guards, the per-entry restock/visibility save and the RollTable generation
> entry point are verified by the automated `npm test` suite in Node. This
> section is the intended real-runtime check for the manager automation editor,
> the `updateWorldTime` sweep and the RollTable `drawMany` call on a live v14
> install.

### 17.1 GM saves scheduled hours

1. As the **GM**, open the Market Manager, select a shop, and in the "Hours &
   arrivals" card enable **Use scheduled hours**, check some weekdays, set an
   open and close minute, and click **Save hours**.

**Expected**

- The values persist after reopening the shop; the weekday checkerboard reflects
  the saved days and the travel/events/diagnostics are untouched.
- Entering an invalid minute (e.g. `1500`) shows a notice and does NOT write.

### 17.2 GM saves a travel schedule

1. In the "Hours & arrivals" card enable **Enable travel**, check two or more
   destination locations, set an anchor time and an interval, and click **Save
   travel**.

**Expected**

- The travel destinations persist and the shop's own `locationId` is unchanged
  (a travel shop keeps trading at its base until the runner moves it).
- Selecting a destination that was deleted from the locations list shows an
  "Unknown travel destination" notice and does NOT write.
- Changing the schedule identity resets the cycle; re-saving unchanged values
  keeps the cycle marker.

### 17.3 GM adds / removes / saves events

1. Click **Add event**; confirm a "New event" row appears. Edit the title,
   description, start/end (world seconds) and visibility, then click **Save
   events**.

**Expected**

- A shop holds at most ten events; adding an eleventh shows a notice.
- Removing an event removes only that row.
- A saved visible/active event appears in the storefront's public notices; an
  invalid window (end <= start) shows a notice and leaves the form intact (no
  write).

### 17.4 GM sets per-entry stock visibility / restock

1. In an inventory row, set "Player stock" to "Low / available" or "Hidden",
   enable **Auto-restock** and set a target/anchor/interval, then click the row
   **Save**.

**Expected**

- The entry persists the visibility/restock, and the restock cycle resets only
  when the schedule identity changed.
- An invalid restock (e.g. an interval under 3600) shows a notice and does NOT
  write.

### 17.5 GM runs automation on demand

1. In the "Automation" card click **Run now** (as the active GM).

**Expected**

- The summary is shown and the diagnostics panel reflects the fresh run.
- With no active GM the button is disabled and pressing it shows the "Only the
  active Game Master can run automation." notice with no store read.

### 17.6 GM generates inventory from a RollTable

1. In the "Roll table stock" form pick a RollTable, set a draw count in 1..20,
   and click **Generate inventory**.

**Expected**

- The result counters (added / skipped / invalid / duplicate) are shown and the
  new entries appear in the shop inventory.
- A draw count outside 1..20, or no table chosen, shows a notice and does NOT
  call the service.
- The generator is active-GM gated (the button is disabled without the active
  GM).

### 17.7 Player sees projected trading / stock / events

1. As the **player**, open the storefront for a shop whose GM set hours/travel, a
   low/hidden stock entry and a visible active event.

**Expected**

- The storefront reflects the projected `closedReason`, `stockLabel`/
  `available` and active `marketEvents`; a hidden/low entry never leaks a real
  quantity, and a closed / outside-hours / not-arrived shop disables purchase.
- The GM-only automation config (raw days/hours, travel, restock control,
  private event list) is never exposed to the player.

## 18. M5 - Storefront cart, services, preorders, theft and selling

> **Status: Node-tested only.** The M5 storefront controls (cart lines, barter
> checkout, service booking, preorders, theft claims and whole-item selling) are
> verified by the automated `npm test` suite in Node. This section is the
> intended real-runtime check for the ApplicationV2 action dispatch of the new
> `data-action` controls, the owned-Actor embedded-Item reads for the sell/barter
> selects, and the GM-correlated advanced responses.

### 18.1 GM enables the M5 commerce configuration

1. As the **GM**, open the Market Manager, select a shop, and configure the
   advanced commerce options: enable **preorders** (set a deposit basis-points
   and per-actor max), enable **theft**, add at least one **service** and one
   **special**, and set finite merchant **funds** if desired.
2. Ensure at least one inventory entry is **out of stock** (finite/non-restocking
   with quantity 0) so a preorder-eligible option appears, and another is **in
   stock** so a theft-eligible option appears.

**Expected**

- The storefront now shows "Services & special offers", a "Sell an item" /
  "Optional barter item" form (only when the selected Actor owns sellable
  whole Items), and a cart panel after items are added.
- Only entries the catalog flags `canPreorder` / `canAttemptTheft` appear in the
  preorder / theft dropdowns; an ineligible entry never appears there.

### 18.2 Player adds and removes cart lines, then checks out with barter

1. As the **player**, open the storefront, select an owned Actor with funds, set a
   quantity in the Qty field, and click **Add to cart** on an entry. Repeat with a
   different entry and (if configured) an **Add special** on a special offer.
2. Confirm the cart panel lists each line (name, quantity, per-line total) and a
   cart total.
3. Remove one line with **Remove**.
4. Select a whole owned Item in the **Optional barter item** select, then click
   **Checkout cart**.

**Expected**

- Adding a line never sends a request (no GM counter-request appears), lines
  merge by entry+special, at most 20 distinct lines fit, and each line quantity is
  1..100 (an out-of-range quantity surfaces a message and is not sent).
- The cart panel total is a safe client-side pre-computation; the GM's checkout
  is authoritative.
- Removing a line removes only that line.
- Checkout sends a `cart` request with the `lines` and (when chosen) a
  `barterItemId`; the player is debited only the cash remainder and the bartered
  whole Item is taken. On success the cart clears and the catalog refreshes; the
  checkout response never carries a client price.

### 18.3 Player books a service

1. In the **Services & special offers** area, click **Request service** on a
   configured service.
2. Confirm the GM processes the `service` whisper.

**Expected**

- The player is debited the service price once, the service is reported as
  **booked** (not "fulfilled"), and the catalog refreshes. A `booked` response is
  never reported as fulfilled; fulfillment is a separate GM action.

### 18.4 Player places a preorder and a theft claim

1. From a preorder-eligible (out-of-stock) entry, click **Place preorder** (or
   pick it in the preorder select) and confirm a deposit is charged.
2. From a theft-eligible (in-stock) entry, click **Submit theft attempt** (or pick
   it in the theft select).

**Expected**

- The preorder request carries `entryId` + `quantity` and never a client price; a
  `booked` preorder response is reported as "Preorder placed", never fulfilled.
- The theft request claims only (`type: 'theft'`), never a client `success`; the
  response reports "claim submitted; awaiting the GM" and never pre-resolves the
  outcome. No item is delivered, no stock decremented and no currency moves at
  claim time.

### 18.5 Player sells a whole owned Item

1. In the **Sell an item** form, choose a whole owned Item and click **Sell item**.
2. Confirm the GM buys it back.

**Expected**

- The request carries `type: 'sell'` + `itemId` (never a price); the shop pays the
  quoted payout and the Item leaves the Actor. A stacked (quantity != 1) Item is
  not offered in the select.
- On success the catalog refreshes and the feedback reports the sold Item name and
  payout. A Hated/refused or no-offer sale reports the documented bounded error.
- **A GM approval is required first.** The runtime `main.js` now wires the
  valuation service's `getApprovedValuation` into the sell path, so the sale is
  priced by a GM-approved valuation, never the Item's own `price`. If no
  still-valid approval is recorded for the Item, the sell refuses closed
  `gm-approval-required` and the Item stays put; record one first via
  `api.advanced.approveValuation` (a `0` amount is legitimate).

### 18.6 Actor switch / stale responses

1. Switch the actor select and confirm the cart clears, any pending request is
   abandoned, and the catalog re-quotes for the new actor.
2. (Harder to trigger manually) Confirm an advanced response quoted for a
   different actor or a different shop is ignored - it must never mutate the
   current cart/catalog.

### 18.7 Player sells/barters only GM-approved items

1. As the **GM**, approve a valuation for ONE whole owned Item on the player's
   Actor (see section 19.4), and intentionally leave another whole owned Item on
   that Actor without an approval.
2. As the **player**, open the storefront, select that Actor, and inspect the
   **Sell an item** and **Optional barter item** selects.

**Expected**

- Only the Item with a GM-approved valuation appears in the sell/barter selects;
   the unapproved Item is never offered, and the request never carries a client
   price (the GM-approved amount is applied server-side).
- When the selected Actor owns whole Items but none has an approval, the form shows
   the helpful message `Ask the GM to value an item before selling or bartering it.`
   instead of an unexplained empty dropdown.
- The message appears only when a character IS selected - with no character chosen
   the base form is shown, never the "ask the GM" message.

## 19. M5 - GM manager commerce editor and advanced-order adjudication

> **Status: Node-tested only.** The M5 GM manager commerce controls (funds, buy/
> buyback rates, preorders, theft, service/special editor) and the advanced-order
> adjudication methods (fulfill-service, fulfill-preorder, cancel-preorder,
> resolve-theft-success/failure) are verified by the automated `npm test` suite in
> Node. This section is the intended real-runtime check for the manager
> `.commerce-panel`, the service/special row editors, and the GM adjudication of
> the advanced orders that the storefront (section 18) raises.

### 19.1 GM configures commerce settings

1. As the **GM**, open the Market Manager, select a shop, and in the "Commerce
   controls" panel set a finite **Merchant funds**, a **Buy rate**, a **Buyback
   rate**, enable **Accept preorders** (set a deposit and a per-actor max), enable
   **theft**, and click **Save commerce**.

**Expected**

- The values persist after reopening the shop. Entering a **Buyback rate below the
  Buy rate** shows a notice and does NOT write.
- Checking **Unlimited funds** maps **Merchant funds** to an unlimited (null) value;
  unchecking it and leaving **Merchant funds** empty falls back to the previous
  value (or 0).

### 19.2 GM manages services and specials

1. Click **Add service**; confirm a "New service" row appears. Edit the name, price,
   description, visibility and enabled state, then click **Save services**.
2. Click **Add special**; confirm a "New special" row appears. Link it to an
   inventory item, set a price and (optionally) character UUIDs, then click **Save
   specials**.

**Expected**

- A shop holds at most twenty services and twenty specials; adding a twenty-first
  shows a notice.
- Removing a service/special removes only that row.
- A special whose linked inventory item no longer exists shows a notice and does NOT
  write; an invalid character UUID (not matching `Actor.<id>`) fails closed.
- Saving services/specials never deletes a row that is absent from the DOM (e.g.
  added concurrently).

### 19.3 GM adjudicates an advanced order

1. Enable preorders/theft (or add a service) in a shop, then as the **player**
   (section 18) place a service, preorder or theft claim.
2. As the **active GM**, in the Market Manager select that shop and open the
   "Advanced orders" panel. For a **booked** service order click **Mark fulfilled**;
   for a **booked** preorder click **Fulfill** or **Cancel**; for a **booked** theft
   claim click **Resolve success** or **Resolve failure**.

**Expected**

- The order buttons appear only for a `booked` order (a `fulfilled`/`cancelled`/
  `committed`/`failed` order shows no action button).
- The action is reported truthfully in the notice (fulfilled/cancelled/resolved, or
  needs recovery / an error), and the order list refreshes WITHOUT reloading the
  shop, so any unsaved appearance or inventory-row edits are preserved.
- Only the active GM can act: a non-active GM sees the buttons disabled and pressing
  them shows the "Only the active Game Master..." notice with no store read.

### 19.4 GM approves an item valuation (sell/barter)

1. As the **active GM**, open the Market Manager, select a shop, and in the social
   panel's "Item valuations" sub-panel reuse the **Character** selector to choose
   the player Actor whose whole Item is to be valued.
2. Pick the Item, set a positive whole-number approved amount, and click **Approve
   valuation**.

**Expected**

- The action is active-GM gated: a non-active GM sees **Approve valuation** disabled
  and pressing it shows the "Only the active Game Master..." notice with no store
  read.
- Without a chosen character, or without a chosen item, or with an amount that is
  not a positive whole number (`min 1`), a notice is shown and the GM-only
  `approveValuation` is not called.
- On success the shop refresh shows the new valuation in the private list, and the
  next catalog request includes it in the player-facing `approvedItems` allowlist
  so that character can sell/barter the item. Re-approving the same
  `(actorUuid, itemId)` pair replaces the existing entry rather than duplicating
  it.
- Only the active GM can act (a player watching the app never triggers a read or a
  write).

## 20. M5 - GM config, order adjudication, buyback funds/balance, cart/barter/backroom/specials and the recovery checklist

> **Status: Node-tested only.** The M5 advanced services and the manager/
> storefront controls exercised here are verified by the automated `npm test`
> suite in Node. This section is the intended real-runtime check for the
> GM-authoritative advanced trade services - whole-item sell/buyback, manual
> service booking, single-payer cart checkout with optional barter,
> deposit-backed pre-orders, GM-adjudicated theft and actor special offers - and
> for the recovery surfaces.

### 20.1 GM configures advanced commerce and a backroom entry

1. As the **GM**, open the Market Manager, select a shop, and in the "Commerce
   controls" panel set a finite **Merchant funds**, a **Buy rate** and a
   **Buyback rate**, enable **Accept preorders** (deposit basis points + per-actor
   max), enable **theft**, and add a **service** and a **special**. Click **Save
   commerce**.
2. In an inventory row, set the per-entry **Access** to `backroom`, add an owned
   Actor UUID to the allowlist and (optionally) set a `minReputation`.

**Expected**

- The commerce values persist after reopening; an inverted **Buyback rate below
  the Buy rate** shows a notice and does NOT write.
- A `backroom` entry no longer appears in the base (unpersonalized) catalog, and
  appears in a personalized catalog only for an allowlisted actor or one meeting
  `minReputation`. An actor who is neither allowlisted nor above the threshold
  never sees it.
- **No access data leaks.** When a `backroom` entry is projected into a
  personalized catalog, the projected entry never carries the private per-entry
  gate - no `access`, no `actorUuids`/allowlist, no `minReputation`, and no item
  `snapshot`. Only the same allowlisted public fields as any other entry are
  emitted (id, name, img, price, quantity, stockMode, visible, and the catalog's
  decorated availability flags). Confirm by inspecting the storefront response
  for an allowed actor and asserting it matches the bounded public surface.
- An invalid character UUID (not matching `Actor.<id>`) or an out-of-range
  `minReputation`/`depositBps`/`maxPerActor` fails closed with a notice and no
  write.

### 20.2 GM resolves a service / preorder / theft order

1. As the **player**, book a service, place a preorder (deposit charged), and
   submit a theft claim (from sections 18.3/18.4).
2. As the **active GM**, open the same shop's "Advanced orders" panel and act:
   a **booked** service -> **Mark fulfilled**; a **booked** preorder ->
   **Fulfill** or **Cancel**; a **booked** theft claim -> **Resolve success** or
   **Resolve failure**.

**Expected**

- The action buttons appear only for a `booked` order (a `fulfilled`/`cancelled`/
  `committed`/`failed` order shows no action button).
- Fulfilling a service only records the acknowledgement: the order moves to
  `fulfilled` and no `Item` is created or delivered.
- Fulfilling a preorder charges only the **remaining** balance (never the deposit
  again), delivers the items and decrements finite stock; cancelling refunds the
  deposit and decrements finite merchant funds.
- Resolving a theft as success grants ONE item and decrements finite stock; as
  failure it grants nothing. No currency moves either way.
- Only the active GM can act: a non-active GM sees the buttons disabled and
  pressing them shows the "Only the active Game Master..." notice with no store
  read.

### 20.3 Buyback sale: merchant funds / player balance

1. As the **player**, open a shop whose GM set finite **Merchant funds**, select
   an owned Actor with a whole Item, and **Sell item**.
2. Confirm the payout, the Item leaving the Actor, and the shop gaining a
   `non-restocking` buyback listing.

**Expected**

- The player's balance increases by exactly the quoted payout; the Item leaves the
  Actor (a stacked, quantity != 1 Item is not offered).
- Finite merchant funds DECREASE by the payout; with unlimited (`null`) funds the
  shop is never limited. If the finite funds are below the payout the sale is
  refused `insufficient-merchant-funds` with no item removal and no credit.
- Re-running the identical sell (same `requestId`) replays with no second credit,
  no second delete and no second listing.

### 20.4 Cart + barter + backroom + specials

1. As the **player**, in a shop that carries a special on an entry, add that
   special to the cart and confirm the special line uses the offer price (never
   a client-supplied price).
2. Select a whole owned Item in the **Optional barter item** select and
   **Checkout cart**.

**Expected**

- Only the paying `actorId` is debited - a group cart is a single payer, and no
  other contributor is charged.
- Only the CASH remainder (total minus barter credit) is ever debited, never the
  bartered credit; finite merchant funds gain only that cash remainder.
- A tender worth more than the cart gross total never pays cash out (the credit is
  capped at the total).
- A `backroom` entry included in the cart is quoted/charged only when the actor
  may access it; an inaccessible line fails closed `entry-restricted`.
- A forged/hidden/wrong-entry/not-allowlisted `specialId` fails the checkout
  closed `special-unavailable` before any debit.
- **A GM approval is required first.** The runtime `main.js` now wires the
  valuation service's `getApprovedValuation` into the cart path, so the tender is
  priced by a GM-approved valuation. A checkout with a `barterItemId` that has no
  still-valid GM approval refuses closed `gm-approval-required` and nothing is
  debited/removed/delivered; record the approval first via
  `api.advanced.approveValuation`.

### 20.5 Recovery checklist

1. Make a deliberately failing operation (e.g. set finite merchant funds to 0 and
   sell an item; or cancel a preorder whose finite funds no longer cover the
   deposit) and confirm the advanced order is marked `failed` or `needsRecovery`,
   never a false success.
2. Confirm the affected funds/item are not double-applied, and use the recorded
   markers in `details.compensation` to reconcile.

**Expected**

- A `needsRecovery` order is reported as needing manual reconciliation; nothing is
  silently double-credited or double-debited.
- A replay of a failed/pending original surfaces
  `originalStatus: 'failed'`/`'needsRecovery'` and is never reported as complete.

### 20.6 No false automatic effects

**Expected**

- A booked service is reported **booked**, never fulfilled; fulfillment is only the
  GM's manual acknowledgement.
- A theft claim is reported **awaiting the GM**; no item is delivered, no stock
  decremented and no currency moves at claim time - success/failure comes only
  from the GM's `resolve`.
- A preorder `place` charges only the deposit and reserves NO stock; the entry
  quantity is untouched until fulfillment.
- The storefront never reports a plain request (cart add, service/preorder/theft
  submission) as a completed sale - only a committed checkout, a fulfilled
  service, or a resolved theft are reported complete.

## 21. M6 - GM manager portable backup panel

> **Status: Node-tested only.** The M6 portable backup runtime wiring
> (`api.backup`) and the manager `.backup-panel` are Node-tested; confirm the
> export/preview/import flow on a real v14 runtime. A None restore can be
> produced harmlessly as part of this follow-up.

### 21.1 GM exports a backup and downloads it locally

1. As the **GM**, open the **Foundry Market** manager and scroll to the
   **GM backup & restore** panel (section 09).
2. Click **Export backup**.
3. A JSON file downloads locally (browser download, never a chat message).

**Expected**

- The panel shows a "Backup status" summary with the exported location/shop
  counts and any warnings (e.g. cross-world Actor UUID staleness).
- The downloaded file is the COMPACT serialized backup (no pretty-print) and it
  is always under the 5 MiB portable bound, so it can be imported back.
- No message is posted to chat and no player request is sent.
- A non-active GM sees the **Export backup** button disabled plus the note
  "Only the active Game Master can export or import backups."
- An export whose compact serialization exceeds 5 MiB is refused with no
  download and a "backup exceeds 5 MB" note (never saves an un-importable file).

### 21.2 GM previews an import before restoring

1. As the **GM**, create a backup in another (or this) world via
   **Export backup**, then save it as a file.
2. In the manager, choose that file in the **Choose backup JSON (up to 5 MB)**
   file input and click **Preview import**.

**Expected**

- The panel shows an "Import preview" summary: `N locations · N shops will be
  added`, plus any preview warnings.
- Nothing is written (preview is a dry run).
- Choosing a *different* file invalidates the previous preview; the import
  button refuses until the new file is previewed.

### 21.3 GM imports a backup (confirm + preview required)

1. After a successful preview, tick **"I understand this adds records and may
   partially complete."** and click **Import backup**.

**Expected**

- The import runs; the panel reports "Added N locations and N shops" (or a
  partial report with the bounded created ids and `import-partial`).
- Un-ticking the confirm box (or importing without a preview) refuses the import
  with a clear notice and writes nothing.
- On success/partial the locations and shops rails refresh.

### 21.4 Privacy of the exported backup

1. Export a backup for a shop that has private data - a `backroom` entry, an item
   `snapshot`, a `commerce.valuations` record (which carries a private
   `actorUuid`/`fingerprint`), finite merchant `funds` and an `automation` config.
2. Open the downloaded JSON and scan the top-level records.

**Expected**

- The backup is a GM-private write built from the full normalized shop records:
  private item snapshots, per-entry access gates, `commerce.valuations`,
  `commerce.funds` and the whole `automation` config are present - never a
  `publicShop` projection.
- Ledger records, reputation records/events and advanced orders are deliberately
  **excluded** (not portable); they do not appear in the exported JSON.
- Cross-world Actor references (NPC `actorUuid`, access/valuation actor lists)
  stay in the file and surface a staleness warning rather than being silently
  dropped.

### 21.5 Partial-after-write (no rollback, no complete cross-GM atomicity)

1. Start an **Import backup** and, after the first records have been written,
   have the active-GM role change (hand the GM to another client mid-import, or
   make the GM user stop being active after a few creates).
2. Note the report and then reload the world.

**Expected**

- The import reports `{ status: 'partial', createdLocationIds, createdShopIds,
  error: 'import-partial', warnings }` with bounded id lists - never a false
  all-or-nothing success.
- Written records **remain**; nothing is auto-rolled back. The partial locations/
  shops are visible after reload and are listed in the bounded created-id report.
- No complete cross-GM atomicity is claimed: an import is not a transactional
  all-or-nothing operation across GM clients, and a mid-import interruption
  leaves partial results visible with no automatic rollback.

## 22. M6 - Dynamic dnd5e currency conversion and system adapters (live runtime)

> **Status: real live failure diagnosed; code fix offline-tested; `0.1.8`
> retest pending.** A live purchase with `0.1.7` surfaced as `balance-read-failed`
> because the adapter misread `CONFIG.DND5E.currencies[d].conversion` (which is
> UNITS PER GP) as GP per unit. The conversion math and purchase failure reporting
> have been corrected in this **`0.1.8` prerelease** and are verified by the
> automated `npm test` suite in Node; this section is the intended real-runtime
> check on a live v14 install. **Note:** the per-user purchase ledger Journal
> (`Ledger:<user>:<requestId>`, created by the default store) is the expected
> **GM-private** audit/idempotency record - one per request - not an extra sale or
> a bug. Diagnose a purchase failure via that journal's `error`/`detail` fields
> rather than treating each `Ledger:` entry as a spurious transaction.

### 22.1 dnd5e dynamic CONFIG conversion and live 1 gp purchase

1. As the **GM**, use a dnd5e 6.x world. Configure a non-default currency config
   via `opts.currencyConfig` (or rely on the live `CONFIG.DND5E.currencies`).
2. As the **player**, buy an item and confirm the wallet debit and the item price
   are read through the conversion table.
3. As the **player**, purchase a **low-priced item** (e.g. a 1 gp item -
   `system.price.value: 1`, denomination `gp`) and confirm the wallet is debited
   **exactly once**, the Item is delivered **exactly once**, and a
   **committed** ledger record exists. In the GM client, locate the per-request
   ledger Journal (`Ledger:<user>:<requestId>`, created by the default store) and
   confirm it reports `committed` - this GM-private journal is the expected
   audit/idempotency record, one per request, **not** an extra sale or a bug.
4. Force a purchase failure (e.g. an item costing more than the actor's wallet, or
   the `balance-read-failed` path) and confirm the player-facing storefront/whisper
   reports **only a stable bounded code** (e.g. `Purchase failed
   (balance-read-failed).`) - never a raw stack trace or a `[market] ...` detail.
   Inspect the same GM-private ledger journal's `error`/`detail` for the real
   diagnostic; the ledger is where you look, not the chat.

**Expected**

- The read/write uses the live `CONFIG.DND5E.currencies` factors: each
  denomination's `conversion` is UNITS PER GP (e.g. `cp.conversion === 100`,
  `gp.conversion === 1`, `pp.conversion === 0.1`) and the copper factor is
  derived as `conversion.cp / conversion[d]` - never confused with a GP-per-unit
  reciprocal.
- A 1 gp / low-priced dnd5e purchase records **one** wallet debit, **one** item
  delivery and a **committed** ledger record - the `Ledger:<user>:<requestId>`
  GM-private journal. That journal is the expected per-request audit/idempotency
  record, not an extra transaction.
- A failing purchase surfaces only a bounded safe code in the player-facing
  content (never a raw exception message / `[market] ...` detail), while the
  GM-private ledger Journal retains the diagnostic `error`/`detail`.
- No existing integer-copper records break under a GM-configured exchange rate.
- All factor math uses exact decimal-string BigInt rationals, never binary float
  rounding; a config whose ratios do not resolve to whole copper pieces fails
  closed before any wallet write.

### 22.2 DC20 / Twodsix runtime adapter

1. As the **GM**, run the same purchase in a **dc20rpg** world (or the `dc20`
   legacy alias) and in a **Twodsix (Traveller)** world.

**Expected**

- DC20: cp/sp/gp/pp are converted to integer copper (cp) via the adapter, and the
  wallet is debited/credited in that system's representation.
- Twodsix: the wallet is read and written at the configured
  `system.financeValues.cash` credits path.
- Both deliver the purchased Item (embedded) and never mutate the source Item.

### 22.3 Daggerheart (configured generic)

1. As the **GM**, use a **daggerheart** world with the generic adapter paths
   (wallet/price/delivery) left unconfigured, then configure them and reload.

**Expected**

- With the generic paths unconfigured, the marketplace reports the adapter as
  unsupported (`supported === false`) rather than guessing a price path.
- After configuring the generic paths, the adapter reports support and the
  storefront can transact. Daggerheart has no native item price, so no price path
  is invented - only the GM-configured generic path is used.

## 23. M6 - Accessibility (keyboard, screen reader, contrast, reduced motion)

> **Status: CSS + Node-tested only.** The CSS is present in
> `styles/market.css` and the Node suite covers the data/UI logic, but there is
> no automated axe/screen-reader run. This section is the intended manual
> check on a live install and with a screen reader.

### 23.1 Keyboard focus

1. As the **GM**, open the Market Manager; as the **player**, open the storefront.
2. Tab through every interactive element on both surfaces (buttons, inputs,
   selects, textareas, links and any `[tabindex]` element), and through the custom
   controls: the `.market-check` checkbox, the `.weekday-option` weekday picker,
   and the product/entry cards.

**Expected**

- A visible `:focus-visible` outline (3px gold plus a dark halo) is shown on every
  keyboard-focused element on **both** the light manager and the dark storefront.
- The custom controls never rely on colour alone: each shows an explicit
  `:checked` state (gold fill + visible glyph/check with white-on-gold contrast)
  and an explicit `:focus-visible` outline on the styled art.

### 23.2 Screen reader

1. With a screen reader active, navigate the storefront and the manager.

**Expected**

- The custom `.market-check` and `.weekday-option` controls expose an accessible
  name and role and are operable with the keyboard; the 1px visually-hidden native
  inputs are still exposed to assistive tech (they are only visually hidden, never
  removed from the accessibility tree).

### 23.3 Contrast

1. Inspect the manager (light paper) and storefront (dark iron) surfaces against
   the `--mk-*` token palette.

**Expected**

- Text meets a usable contrast ratio on both surfaces (the palette is tuned for
  legibility on the warm-paper and dark-iron backgrounds). Record any contrast
  failures here rather than assuming the themed palette is accessible.

### 23.4 Reduced motion

1. With the OS "reduce motion/transparency" preference enabled, or by toggling the
   `.motion-off` class on the app/preview, resize/open the storefront and trigger
   animations.

**Expected**

- Transitions, animations and smooth scrolling are disabled: the global
  `@media (prefers-reduced-motion: reduce)` rule and the `.motion-off` /
  `.preview-panel.motion-off` overrides both disable them, and the reward/glow
  animation does not run.

## 24. M6 - Performance benchmark (offline, optional)

> **Status: Optional, manual, machine-dependent.** This section is NOT a live
> Foundry VTT 14 profile and is not a CI gate. It is a human-facing timing report.

### 24.1 Run the benchmark

1. From the repository root, run `npm run benchmark` (or
   `node scripts/benchmark.mjs [entryCount]`; default entry count is 1000).

**Expected**

- The script prints a median / p95 (ms) report for normalization, public-catalog
  build and automation policy. The numbers are example wall-clock timings on the
  run machine only - treat them as indicative, not as a pass/fail gate. A live
  Foundry VTT 14 profile is not yet captured.

### 24.2 Guard

1. Run `npm test` and confirm `tests/performance.test.js` passes on a loaded
   machine.

**Expected**

- The deterministic O(N) guarantee is asserted by counting array reads (a Proxy
  probe) and proving `planAutomation` does no O(N^2) repeated global work; the
  only wall-clock assertion is a very generous 10 s catastrophic-regression-only
  guard, so normal CI slowness does not flip it.

## 25. Summary / verdict

Record a pass/fail + notes row for each section. Take **all** sections (1-24) as
the minimum signal for M1/M2/M3/M4/M5/M6 - do not claim completion on the strength
of `npm test` alone (that only mocks the Foundry boundaries). If you are about to
run a real economy, treat sections 1, 4 (UI/hook shapes), 12 (last-item
contention), 15.3/15.4 (M2 action dispatch), 16.4 (M3 personalized quote), 17.5
(M4 active-GM automation), 18.2/18.5 (M5 cart checkout and whole-item selling),
19.3 (M5 GM advanced-order adjudication), 20.2/20.3 (M5 order adjudication and
buyback funds/balance), 20.5 (M5 recovery), 21.3/21.4/21.5 (M6 backup import,
privacy and partial-after-write), 22.1-22.3 (M6 dynamic conversion and system
adapter runtime), 23.1-23.4 (M6 keyboard/screen-reader accessibility) and
the multi-GM concurrency note as mandatory, and confirm the two blockers in the
intro are addressed before you trust a live economy to the module.
