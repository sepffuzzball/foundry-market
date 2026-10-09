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

## 15. Summary / verdict

Record a pass/fail + notes row for each section. Take **all** sections as the
minimum signal for M1 - do not claim M1 complete on the strength of `npm test`
alone (that only mocks the Foundry boundaries). If you are about to run a real
economy, treat sections 1, 4 (UI/hook shapes), 12 (last-item contention) and
the multi-GM concurrency note as mandatory, and confirm the two blockers in the
intro are addressed before you trust a live economy to the module.
