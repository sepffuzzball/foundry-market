// M5 GM-authoritative sale of one whole embedded Item for buyback.
//
// The player asks the shop to buy back a single Item they own; the shop pays the
// player and takes the item into its own inventory as a `non-restocking` buyback
// listing. This is GM-only and effectful, but it deliberately does NOT claim
// transactional atomicity - it is a compensating idempotent order, mirroring the
// M1 purchase ledger in shape.
//
// Like the purchase path, every state change is sequenced under the SAME per-shop
// lock a purchase uses (`runShopExclusive(shopId, ...)`), the shop and actor are
// re-read at transaction time (never trusting a request snapshot), and an
// `advancedOrder` record is persisted BEFORE any effect so a replayed request can
// be resolved idempotently. The requester is always the executing
// `authenticatedUserId` (never the request's `userId` payload field), which is
// used both for the idempotency key and the actor-ownership check.
//
// Money is always expressed in non-negative integer minor units. The shop pays
// `quoteSell(itemPrice, shop)` and lists the item for resale at
// `quoteBuyback(payout, shop)`, where `itemPrice` is the GM-approved valuation of
// the player-owned Item (never its own system `price`). Until a GM-authored
// valuation approval mechanism is wired, no such valuation exists, so the sale
// refuses closed `gm-approval-required` before the pending order / any effect.
//
// The active-GM guard is re-checked at every await boundary that can observe a GM
// handover: at sellLocked entry before any read, immediately before the pending
// create, and before each effect. On a handover after the pending order but
// before all effects are applied, the former GM stops applying effects and the
// order is marked `failed` when safe (nothing uncertain applied) or
// `needsRecovery` when a compensating step itself is uncertain - no effect runs
// on behalf of a former GM.
//
// No Foundry globals are referenced at import time; only the injected deps and
// the pure helpers are used.

import { normalizeInventoryEntry, assertMarketId } from '../services/model.js';
import { assertMinorUnits } from '../services/pricing.js';
import { quoteSell, quoteBuyback } from './policy.js';
import { isShopTrading } from '../automation/policy.js';
import { fnv1a } from '../services/commerce.js';
import { readPath } from '../adapters/index.js';

/**
 * Coerce `value` to a safe integer world-time second, or return null when the
 * clock value is invalid (NaN/undefined/Infinity/non-safe). An invalid server
 * time must fail the sell closed (`invalid-world-time`) before any effect rather
 * than collapse to week zero and silently trade.
 */
function safeWorldTime(value) {
  if (Number.isFinite(value)) {
    const floored = Math.floor(value);
    if (Number.isSafeInteger(floored)) return floored;
  }
  return null;
}

/**
 * Deterministic intent fingerprint over the fields that make a sell request
 * unique. Only shopId/actorId/itemId/requester are included so two requests with
 * the same intent produce the same hash and can be safely replayed.
 */
function computeIntentHash({ shopId, actorId, itemId, requester }) {
  const canonical = JSON.stringify({
    shopId: String(shopId),
    actorId: String(actorId),
    itemId: String(itemId),
    requester: String(requester),
  });
  return fnv1a(canonical);
}

/**
 * Whether `actor` still carries an embedded `Item` with `itemId`. Used only as a
 * defensive live check - never to mutate.
 */
function itemStillPresent(actor, itemId) {
  return !!(actor.items && actor.items.get && actor.items.get(itemId));
}

/**
 * Extract a non-negative safe integer minor-unit value from an adapter price
 * result, which may be a bare number or an object carrying `minorUnits`. Throws
 * on anything that is not a safe non-negative integer.
 */
function extractMinorUnits(result, label) {
  let value;
  if (typeof result === 'number') {
    value = result;
  } else if (result && typeof result === 'object' && typeof result.minorUnits === 'number') {
    value = result.minorUnits;
  } else {
    throw new Error(`[market] '${label}' did not carry a numeric minorUnits value`);
  }
  return assertMinorUnits(value, label);
}

/**
 * Resolve the GM-approved valuation for a player-owned Item in non-negative safe
 * integer minor units, or return `{ entry: null, amount: null }` when no
 * valuation is approved yet.
 *
 * The shop NEVER prices a player-owned Item from its own system `price` (a player
 * can inflate that to mint currency); it pays the GM-approved valuation instead.
 * A missing (`getApprovedValuation` not wired) or throwing read is treated as
 * "not approved" so the sale fails closed `gm-approval-required` BEFORE the
 * pending order or any effect, rather than falling back to the item's own price.
 *
 * The runtime injects `valuationService.getApprovedValuation`, which returns the
 * FULL validated valuation entry (so the sale can consume it at commit - a single
 * approval must never mint repeated payouts). A test fixture may instead inject a
 * bare number (amount-only, `entry: null`); both are normalized here. `shop` is
 * passed through as the second argument but an injected callback may ignore it.
 */
async function resolveApprovedValuation(getApprovedValuation, item, shop, label) {
  if (typeof getApprovedValuation !== 'function') {
    return { entry: null, amount: null };
  }
  let value;
  try {
    value = await getApprovedValuation(item, shop);
  } catch (err) {
    return { entry: null, amount: null };
  }
  if (value == null) return { entry: null, amount: null };
  let entry = null;
  let raw;
  if (typeof value === 'number') {
    raw = value;
  } else if (value && typeof value === 'object' && typeof value.amount === 'number') {
    entry = value;
    raw = value.amount;
  } else if (value && typeof value === 'object' && typeof value.minorUnits === 'number') {
    entry = value;
    raw = value.minorUnits;
  } else {
    return { entry: null, amount: null };
  }
  return { entry, amount: extractMinorUnits(raw, label) };
}

/**
 * Resolve an already-persisted order for the current intent. Never applies a
 * side effect:
 *   - same key + same intentHash on a `committed` order => replay its outcome.
 *   - same key + same intentHash on a `pending` / `needsRecovery` order =>
 *     `needsRecovery` (manual recovery; no effect applied).
 *   - same key + same intentHash on any other terminal status => replay.
 *   - same key + different intentHash => `conflict`.
 */
function resolveExistingOrder(existing, intentHash) {
  if (existing.intentHash !== intentHash) {
    return {
      status: 'conflict',
      conflict: true,
      orderId: existing.id,
      error: 'conflicting duplicate payload',
      expected: existing.intentHash,
      existing,
    };
  }
  if (existing.status === 'committed') {
    const outcome = existing.outcome || {};
    return {
      status: 'replay',
      orderId: existing.id,
      originalStatus: existing.status,
      payout: outcome.payout,
      buybackEntryId: outcome.buybackEntryId,
      itemName: outcome.itemName,
    };
  }
  if (existing.status === 'pending' || existing.status === 'needsRecovery') {
    return {
      status: 'needsRecovery',
      orderId: existing.id,
      error: existing.error || 'order-pending',
    };
  }
  // failed / booked / fulfilled / cancelled -> a terminal replay of the record.
  return { status: 'replay', orderId: existing.id, originalStatus: existing.status };
}

export function createSellingService(deps) {
  const {
    store,
    runShopExclusive,
    isActiveGM = () => true,
    getActor,
    actorOwnedBy,
    getAdapter,
    getApprovedValuation,
    now = null,
    makeId,
    logger,
  } = deps;

  /**
   * Sentinel thrown when a GM handover is detected mid-flight (after the pending
   * order but before all effects are applied). The former GM must stop applying
   * further effects; compensation undoes whatever was applied and the order is
   * marked `failed` when safe or `needsRecovery` when a compensating step is
   * itself uncertain.
   */
  function activeGmOrThrow() {
    if (!isActiveGM()) {
      const err = new Error('gm-handoff');
      err.code = 'gm-handoff';
      throw err;
    }
  }

  /**
   * Best-effort phase marker. A failed phase write is never fatal: the phase is
   * only a diagnostic, and the final commit sets `phase: 'final'` anyway. A
   * `null`/missing return (the record is gone) is reported as `false` so the
   * caller can flag the order as uncertain; a thrown write is logged and also
   * reported as `false` rather than aborting the sequence.
   */
  async function setPhase(orderId, phase) {
    try {
      const updated = await store.updateAdvancedOrder(orderId, { phase });
      if (updated == null) {
        logger?.warn?.(
          `[market] advanced order ${orderId} was missing during '${phase}' phase write`
        );
        return false;
      }
      return true;
    } catch (err) {
      logger?.error?.(
        `[market] failed to persist sell phase '${phase}' for order ${orderId}`,
        err
      );
      return false;
    }
  }

  function sell(payload = {}, authenticatedUserId) {
    let shopId;
    let actorId;
    let itemId;
    let requestId;
    try {
      shopId = assertMarketId(payload.shopId, 'shopId');
      actorId = assertMarketId(payload.actorId, 'actorId');
      itemId = assertMarketId(payload.itemId, 'itemId');
      requestId = payload.requestId
        ? assertMarketId(payload.requestId, 'requestId')
        : makeId();
    } catch (err) {
      return Promise.resolve({ status: 'error', error: err.message });
    }
    const requester = String(authenticatedUserId ?? '').trim();
    if (requester === '') {
      return Promise.resolve({
        status: 'error',
        error: 'authenticatedUserId must be a non-empty string',
      });
    }
    const key = `sell:${requester}:${requestId}`;
    const intentHash = computeIntentHash({
      shopId,
      actorId,
      itemId,
      requester,
    });

    // GM gate BEFORE any store read. A player watching the app never triggers a
    // read or a write.
    if (!isActiveGM()) {
      return Promise.resolve({ status: 'error', error: 'not-active-gm' });
    }

    return runShopExclusive(shopId, () =>
      sellLocked({ shopId, actorId, itemId, requester, key, intentHash })
    );
  }

  async function sellLocked(ctx) {
    const { shopId, actorId, itemId, requester, key, intentHash } = ctx;

    // 0. Re-check the active-GM guard before ANY read. A handover between the
    //    outer gate and acquiring the lock means a player watching the app still
    //    never triggers a read.
    if (!isActiveGM()) {
      return { status: 'error', error: 'not-active-gm' };
    }

    // 1. Idempotency re-read BEFORE any state change.
    let existing;
    try {
      existing = await store.findAdvancedOrderByKey(key);
    } catch (err) {
      return {
        status: 'error',
        error: `order-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (existing) {
      return resolveExistingOrder(existing, intentHash);
    }

    // After the awaited read the GM may have handed off.
    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 2. Re-read shop and actor inside the lock (never trust the request).
    let shop;
    try {
      shop = await store.findShop(shopId);
    } catch (err) {
      return {
        status: 'error',
        error: `shop-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (!shop) return { status: 'error', error: 'shop-not-found' };

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    let actor;
    try {
      actor = await getActor(actorId);
    } catch (err) {
      return {
        status: 'error',
        error: `actor-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (!actor) return { status: 'error', error: 'actor-not-found' };
    if (!actorOwnedBy(actor, requester)) {
      return { status: 'error', error: 'actor-not-owned' };
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 3. Resolve the embedded Item.
    const item = actor.items && actor.items.get ? actor.items.get(itemId) : null;
    if (!item) return { status: 'error', error: 'item-not-found' };
    if (item.documentName !== 'Item') {
      return { status: 'error', error: 'item-not-an-item' };
    }
    if (typeof item.toObject !== 'function') {
      return { status: 'error', error: 'item-not-an-item' };
    }
    if (item.parent != null && item.parent !== actor) {
      return { status: 'error', error: 'item-parent-mismatch' };
    }
    const savedItemData = item.toObject();

    // 4. Adapter, the "one whole item" rule, and the shop's offer.
    const adapter = getAdapter();
    if (!adapter || !adapter.supported) {
      return { status: 'error', error: 'adapter-unsupported' };
    }

    // A whole embedded-Item sale only works when the adapter delivers embedded
    // Items. A generic adapter configured for path delivery cannot delete an
    // embedded Item, so the whole-item sale is unsupported.
    if (typeof adapter.deliveryMode === 'string' && adapter.deliveryMode !== 'embedded') {
      return { status: 'error', error: 'delivery-mode-unsupported' };
    }

    // Whole-item rule. A GenericAdapter with a configured `quantityPath` reads
    // the count through that path via the safe reader; anything else consults
    // the dnd5e `system.quantity` when present. Only exactly one whole item may
    // be sold.
    const quantityPath = adapter.quantityPath;
    if (typeof quantityPath === 'string' && quantityPath !== '') {
      let raw;
      try {
        raw = readPath(savedItemData, quantityPath);
      } catch (err) {
        return { status: 'error', error: 'quantity-path-invalid' };
      }
      if (raw == null || typeof raw !== 'number' || !Number.isFinite(raw)) {
        return { status: 'error', error: 'quantity-path-invalid' };
      }
      if (!Number.isInteger(raw) || raw !== 1) {
        return { status: 'error', error: 'stacked-item' };
      }
    } else if (
      savedItemData &&
      savedItemData.system &&
      savedItemData.system.quantity != null &&
      savedItemData.system.quantity !== 1
    ) {
      return { status: 'error', error: 'stacked-item' };
    }

    // 4b. GM-approved valuation. A whole-player-owned-item sale never prices the
    //     item from its own (player-inflatable) system `price`; it pays only the
    //     GM-approved `getApprovedValuation(item)`. When no valuation mechanism is
    //     wired, or the GM has not yet approved this item, the sale refuses closed
    //     `gm-approval-required` BEFORE the pending order and any effect, so an
    //     astronomically inflated system price can never mint currency or buy goods.
    const approved = await resolveApprovedValuation(
      getApprovedValuation,
      item,
      shop,
      'itemPrice'
    );
    const itemPrice = approved.amount;
    if (itemPrice == null) {
      return { status: 'error', error: 'gm-approval-required' };
    }
    // The consumed valuation entry (when the runtime supplies a full entry). At
    // commit the exact entry is removed from the shop's private valuations so a
    // single approval can never be replayed into a second payout.
    const consumedValuation = approved.entry;
    let payout;
    try {
      payout = quoteSell(itemPrice, shop);
    } catch (err) {
      return { status: 'error', error: 'quote-overflow' };
    }
    if (payout <= 0) return { status: 'error', error: 'no-offer' };

    // 5. Finite merchant funds must cover the payout.
    const funds = shop.commerce && shop.commerce.funds;
    const finiteFunds = funds != null;
    if (finiteFunds && funds < payout) {
      return { status: 'error', error: 'insufficient-merchant-funds' };
    }

    // 6. Trading gate. With a world clock, use isShopTrading and fail closed on
    //    an invalid time; with no clock, only the legacy `shop.open` toggle.
    if (now != null) {
      const worldTime = safeWorldTime(now());
      if (worldTime == null) {
        return { status: 'error', error: 'invalid-world-time' };
      }
      const trading = isShopTrading(shop, worldTime);
      if (!trading.open) {
        return { status: 'error', error: 'shop-closed' };
      }
    } else if (shop.open === false) {
      return { status: 'error', error: 'shop-closed' };
    }

    // 7. Build the buyback listing so its id is known for the outcome and any
    //    shop restoration. The snapshot is the serialized item data (the same
    //    delivery fallback the purchase path uses).
    const buybackPrice = quoteBuyback(payout, shop);
    const buybackEntry = normalizeInventoryEntry({
      id: makeId(),
      itemUuid: '',
      snapshot: JSON.stringify(savedItemData),
      name: savedItemData.name,
      img: savedItemData.img || '',
      quantity: 1,
      stockMode: 'non-restocking',
      price: buybackPrice,
      visible: true,
    });
    const buybackEntryId = buybackEntry.id;

    // 8. Re-check the GM before creating the pending order. A handover here is
    //    clean: nothing has been persisted, so nothing needs recovery.
    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    const orderRecord = {
      key,
      kind: 'sell',
      status: 'pending',
      phase: 'recorded',
      shopId,
      userId: requester,
      actorId,
      entryId: '',
      quantity: 1,
      total: payout,
      deposit: 0,
      remaining: payout,
      intentHash,
      details: {
        snapshot: JSON.stringify(savedItemData),
        payout,
        fundsBefore: funds,
        ...(consumedValuation ? { consumedValuation } : {}),
      },
      outcome: {},
    };
    let createdResult;
    try {
      createdResult = await store.createAdvancedOrder(orderRecord);
    } catch (err) {
      return {
        status: 'error',
        error: `order-create-failed: ${(err && err.message) || err}`,
      };
    }
    const order = createdResult.record;
    if (!createdResult.created) {
      // A create-race handed back an existing order for the same key; resolve
      // idempotently and NEVER apply an effect.
      return resolveExistingOrder(order, intentHash);
    }
    const orderId = order.id;

    // 9. Effects: delete -> transferred -> credit -> credited -> shop write ->
    //    stocked -> commit -> final. Any failure AFTER pending goes through
    //    best-effort compensation below; never silently double-credits.
    let credited = false;
    let shopWriteAttempted = false;
    let uncertain = false;
    let balanceBefore = null;
    try {
      // Handover guard before the first effect. On a GM handover after the
      // pending order was written, the former GM stops applying effects.
      activeGmOrThrow();

      // Delete. Success requires the live item to be ABSENT after the API
      // resolves - a returned deletion id alone is insufficient, because the
      // adapter may report the id while the item is still live on the actor.
      let deleteResolved = true;
      try {
        await actor.deleteEmbeddedDocuments('Item', [itemId]);
      } catch (err) {
        deleteResolved = false;
      }
      if (!deleteResolved) {
        if (itemStillPresent(actor, itemId)) {
          // The API threw and the item is still live => genuine delete failure.
          throw new Error('item-delete-failed');
        }
        // The API threw but the item is absent => uncertain; compensate.
        uncertain = true;
      } else if (itemStillPresent(actor, itemId)) {
        // The API resolved but the item is still live => failed without payout.
        throw new Error('item-delete-failed');
      }

      activeGmOrThrow();
      if (!(await setPhase(orderId, 'transferred'))) uncertain = true;

      // Credit with balance verification. A credit that throws may STILL have
      // applied its debit, so the balance is captured before and compared after
      // a throw: unchanged means no debit (do NOT refund), incremented by exactly
      // the payout means the credit applied (refund it), and any other delta is
      // a divergence (needsRecovery).
      activeGmOrThrow();
      balanceBefore = null;
      let balanceKnown = false;
      try {
        balanceBefore = await adapter.getBalance(actor);
        balanceKnown = true;
      } catch (err) {
        // balance unknown; cannot verify a throwing credit
      }
      try {
        await adapter.credit(actor, payout);
        credited = true;
      } catch (err) {
        if (balanceKnown) {
          let balanceAfter = null;
          try {
            balanceAfter = await adapter.getBalance(actor);
          } catch (err2) {
            uncertain = true;
          }
          if (uncertain) {
            // after-balance could not be read; treat as uncertain
          } else if (balanceAfter === balanceBefore) {
            // unchanged => no debit applied => leave credited false (no refund)
          } else if (balanceAfter === balanceBefore + payout) {
            // applied => refund in compensation
            credited = true;
          } else {
            // diverged => needsRecovery
            uncertain = true;
          }
        } else {
          uncertain = true;
        }
        // A throwing credit is not trusted even when the balance moved: always
        // roll the sale back so a later replay never double-credits. The balance
        // verdict above decides whether the payout must be refunded.
        throw err;
      }
      activeGmOrThrow();
      if (!(await setPhase(orderId, 'credited'))) uncertain = true;

      // Patch a fresh shop (re-using the one read under the lock, which is
      // authoritative at this point): decrement finite funds, append the buyback
      // listing AND consume the GM-approved valuation (remove the exact entry from
      // the private valuations list) in a SINGLE write. Never overwrite other
      // fields. Consuming the valuation here closes the loop: the same approval
      // cannot be replayed into a second payout even if the item is recreated.
      const inventory = [...shop.inventory, buybackEntry];
      let commerce = shop.commerce;
      if (finiteFunds) {
        commerce = { ...commerce, funds: funds - payout };
      }
      if (consumedValuation) {
        const valuations = (commerce?.valuations || []).filter(
          (v) => v.id !== consumedValuation.id
        );
        commerce = { ...commerce, valuations };
      }
      shopWriteAttempted = true;
      const shopWritten = await store.updateShop(shopId, { inventory, commerce });
      if (shopWritten == null) throw new Error('shop-write-missing');
      activeGmOrThrow();
      if (!(await setPhase(orderId, 'stocked'))) uncertain = true;

      // Commit. Only claim committed when the terminal write actually persisted
      // a record: a `null` return means the order is gone, so the sale must be
      // treated as uncertain rather than committed.
      const outcome = { payout, buybackEntryId, itemName: savedItemData.name };
      let commitErr = null;
      let commitMissing = false;
      try {
        const committedRecord = await store.updateAdvancedOrder(orderId, {
          status: 'committed',
          phase: 'final',
          outcome,
        });
        if (committedRecord == null) {
          commitMissing = true;
          commitErr = new Error('order-commit-missing');
        } else {
          return { status: 'committed', orderId, ...outcome };
        }
      } catch (err) {
        commitErr = err;
      }

      // The terminal committed write threw or returned null. The store may have
      // persisted `committed` and THEN thrown (apply-then-throw), so never blindly
      // reverse effects. Re-read the record by id to learn the truth: a committed
      // record means the sale succeeded (no compensation); an uncommitted one means
      // compensate as the existing path does; and an unavailable re-read means
      // escalate to needsRecovery without reversing anything.
      let reread = null;
      try {
        reread = await store.findAdvancedOrder(orderId);
      } catch (e) {
        reread = null;
      }

      if (reread && reread.status === 'committed') {
        const recOutcome = reread.outcome || {};
        return {
          status: 'committed',
          orderId,
          payout: recOutcome.payout ?? payout,
          buybackEntryId: recOutcome.buybackEntryId ?? buybackEntryId,
          itemName: recOutcome.itemName ?? savedItemData.name,
        };
      }

      if (reread != null) {
        // The record is present but not committed (pending / failed /
        // needsRecovery): a known-uncommitted state, so compensate as before. The
        // outer catch applies best-effort compensation for a thrown commit; the
        // ambiguous commit-missing case is flagged uncertain.
        if (commitMissing) uncertain = true;
        throw commitErr;
      }

      // Re-read unavailable (threw or order missing): cannot confirm the commit.
      // Do NOT reverse any effect - escalate to needsRecovery and mark the record
      // only when safe.
      await markOrderNeedsRecovery(orderId, commitErr);
      return {
        status: 'needsRecovery',
        orderId,
        error: String((commitErr && commitErr.message) || commitErr),
        compensation: [],
      };
    } catch (err) {
      if (err && err.message === 'order-commit-missing') uncertain = true;
      return compensate({
        err,
        orderId,
        shopId,
        actor,
        itemId,
        savedItemData,
        payout,
        funds,
        buybackEntryId,
        credited,
        shopWriteAttempted,
        balanceBefore,
        uncertain,
        adapter,
        consumedValuation,
      });
    }
  }

  /**
   * Best-effort recovery after a pending order was persisted and an effect (or
   * the final commit) failed. Undoes exactly what may have been applied and never
   * double-compensates: a fully successful compensation records `failed`, an
   * uncertain/failed one records `needsRecovery`. A failure to write the terminal
   * status leaves the record `pending` (a replay then surfaces it).
   */
  async function compensate(ctx) {
    const {
      err,
      orderId,
      shopId,
      actor,
      itemId,
      savedItemData,
      payout,
      funds,
      buybackEntryId,
      credited,
      shopWriteAttempted,
      balanceBefore,
      uncertain = false,
      adapter,
      consumedValuation,
    } = ctx;
    const compensation = [];
    let uncertainOutcome = uncertain;

    if (credited) {
      try {
        await adapter.debit(actor, payout);
        compensation.push('credit-refunded');
      } catch (e) {
        compensation.push('credit-refund-failed');
        uncertainOutcome = true;
      }
      // The compensating debit must return the actor's wallet to the balance
      // captured BEFORE the payout was credited. A mismatch (or an unreadable
      // balance) means the payment is unresolved, so the order is escalated to
      // needsRecovery rather than marked terminal `failed`.
      if (balanceBefore != null) {
        try {
          const after = await adapter.getBalance(actor);
          if (after !== balanceBefore) uncertainOutcome = true;
        } catch (e) {
          uncertainOutcome = true;
        }
      }
    }

    // Restore the deleted item ONLY if it is currently missing (idempotent).
    // Preserve the original id via `keepId` and verify the restore actually took:
    // an item still missing after the restore is an uncertain recovery.
    if (!itemStillPresent(actor, itemId)) {
      try {
        await actor.createEmbeddedDocuments('Item', [savedItemData], { keepId: true });
        if (itemStillPresent(actor, itemId)) {
          compensation.push('item-restored');
        } else {
          compensation.push('item-restore-id-failed');
          uncertainOutcome = true;
        }
      } catch (e) {
        compensation.push('item-restore-failed');
        uncertainOutcome = true;
      }
    }

    // Shop compensation. Instead of best-effort "changed" guessing, compare the
    // current funds to the recorded `fundsBefore` and whether the buyback listing
    // identity exists, so a known no-write never falsely claims a restore and a
    // mixed/unknown state is escalated to needsRecovery rather than assumed.
    if (shopWriteAttempted) {
      try {
        const current = await store.findShop(shopId);
        if (!current) {
          compensation.push('shop-missing');
          uncertainOutcome = true;
        } else {
          const listingExists = current.inventory.some((e) => e.id === buybackEntryId);
          const currentFunds = current.commerce ? current.commerce.funds : undefined;
          const beforeFunds = funds;
          const unlimited = beforeFunds == null;
          const fundsUnchanged = unlimited
            ? currentFunds == null
            : currentFunds === beforeFunds;
          const fundsDebited = !unlimited && currentFunds === beforeFunds - payout;
          // A consumed valuation (from the real runtime) is removed from the shop's
          // private valuations by the sale's single shop write. A still-present
          // entry is therefore a signal the write never landed (no-write); an absent
          // entry is a signal it DID land (the valuation was consumed). When no
          // valuation was consumed (numeric test fixture / un-wired read) the signals
          // are not in play and neither branch is blocked.
          const valuations = Array.isArray(current.commerce && current.commerce.valuations)
            ? current.commerce.valuations
            : [];
          const valuationPresent = consumedValuation
            ? valuations.some((v) => v.id === consumedValuation.id)
            : false;
          const noWriteValuationOk = !consumedValuation || valuationPresent;
          const fullWriteValuationOk = !consumedValuation || !valuationPresent;

          if (!listingExists && fundsUnchanged && noWriteValuationOk) {
            // known no-write: the shop write never landed; nothing to undo (and the
            // consumed valuation, if any, is still present - leave it untouched).
            compensation.push('shop-unwritten');
          } else if (listingExists && (unlimited || fundsDebited) && fullWriteValuationOk) {
            // known full-write: remove the exact entry, restore funds AND restore the
            // consumed valuation in the SAME update, then verify the persisted shop.
            const inventory = current.inventory.filter((e) => e.id !== buybackEntryId);
            let commerce = current.commerce;
            if (!unlimited) commerce = { ...commerce, funds: beforeFunds };
            if (consumedValuation) {
              const keptValuations = (commerce && commerce.valuations
                ? commerce.valuations
                : []
              ).filter((v) => v.id !== consumedValuation.id);
              commerce = { ...commerce, valuations: [...keptValuations, consumedValuation] };
            }
            const returned = await store.updateShop(shopId, { inventory, commerce });
            const valuationRestored =
              !consumedValuation ||
              (returned &&
                Array.isArray(returned.commerce && returned.commerce.valuations) &&
                returned.commerce.valuations.some((v) => v.id === consumedValuation.id));
            const verified =
              returned &&
              !returned.inventory.some((e) => e.id === buybackEntryId) &&
              (unlimited ||
                (returned.commerce && returned.commerce.funds === beforeFunds)) &&
              valuationRestored;
            if (verified) {
              compensation.push('shop-restored');
            } else {
              compensation.push('shop-restore-verify-failed');
              uncertainOutcome = true;
            }
          } else {
            // mixed / unknown state: cannot safely conclude; manual recovery.
            compensation.push('shop-state-mixed');
            uncertainOutcome = true;
          }
        }
      } catch (e) {
        compensation.push('shop-restore-failed');
        uncertainOutcome = true;
      }
    }

    const status = uncertainOutcome ? 'needsRecovery' : 'failed';
    let responseStatus = status;
    try {
      const updated = await store.updateAdvancedOrder(orderId, {
        status,
        phase: 'final',
        error: String((err && err.message) || err),
        details: {
          snapshot: JSON.stringify(savedItemData),
          payout,
          fundsBefore: funds,
          ...(consumedValuation ? { consumedValuation } : {}),
          compensation,
        },
      });
      if (updated == null) {
        // The record is missing even for the terminal status write: the call has
        // to surface needsRecovery rather than pretending a persisted record.
        responseStatus = 'needsRecovery';
        compensation.push('order-write-missing');
      }
    } catch (e) {
      logger?.error?.(
        `[market] failed to persist sell compensation for order ${orderId}`,
        e
      );
    }
    return {
      status: responseStatus,
      orderId,
      error: String((err && err.message) || err),
      compensation,
    };
  }

  /**
   * Best-effort terminal marker after the final commit write was ambiguous and the
   * re-read unavailable (it threw or returned null). Never reverses an effect: the
   * committed status may or may not have landed, so only the `needsRecovery` marker
   * is written - and a failed marker write is logged, leaving the record `pending`
   * for a later replay to surface. This is the "safe" escalation: the effects stay
   * applied and the order is left for manual recovery.
   */
  async function markOrderNeedsRecovery(orderId, err) {
    try {
      const updated = await store.updateAdvancedOrder(orderId, {
        status: 'needsRecovery',
        phase: 'final',
        error: String((err && err.message) || err),
      });
      if (updated == null) {
        logger?.warn?.(
          `[market] advanced order ${orderId} was missing while marking sell needsRecovery`
        );
      }
    } catch (e) {
      logger?.error?.(
        `[market] failed to persist sell needsRecovery for order ${orderId}`,
        e
      );
    }
  }

  return { sell };
}

export default createSellingService;
