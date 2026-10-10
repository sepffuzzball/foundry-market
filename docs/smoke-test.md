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

1. As the **player**, click the Scene Note created in section 4.

**Expected**

- The **Market Storefront** opens instead of the Journal sheet (the Note handler
  suppresses the default journal).
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

## 18. Summary / verdict

Record a pass/fail + notes row for each section. Take **all** sections (1-17) as
the minimum signal for M1/M2/M3/M4 - do not claim completion on the strength of
`npm test` alone (that only mocks the Foundry boundaries). If you are about to
run a real economy, treat sections 1, 4 (UI/hook shapes), 12 (last-item
contention), 15.3/15.4 (M2 action dispatch), 16.4 (M3 personalized quote), 17.5
(M4 active-GM automation) and the multi-GM concurrency note as mandatory, and
confirm the two blockers in the intro are addressed before you trust a live
economy to the module.
