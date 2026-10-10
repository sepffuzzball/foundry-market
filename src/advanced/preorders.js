// M5 GM-authoritative out-of-stock pre-order with paid deposit.
//
// A pre-order lets a player put a deposit on an inventory entry that is currently
// out of stock (or under-stocked for the requested quantity). The deposit is paid
// immediately; NO stock is reserved, so stock remains available to other buyers
// and the shop's recorded quantity is left untouched until fulfillment. The order
// stays `booked` and is GM-only until the GM either (a) fulfills it - charging the
// remaining balance, delivering the item and decrementing stock - or (b) cancels
// it - refunding the deposit and decrementing finite merchant funds.
//
// Like the other M5 advanced services this is a COMPENSATING, idempotent
// advanced-order transaction on top of the GM-private `advancedOrder` records. It
// deliberately does NOT claim distributed/transactional atomicity - it records
// phases, applies effects one at a time, and best-effort undoes what it can,
// escalating to `needsRecovery` when a compensating step is itself uncertain.
//
// This module is a Node-importable companion to `src/advanced/cart.js` and
// `src/advanced/services.js` and follows the same discipline: it is GM-gated
// (`isActiveGM` before any store read, re-checked inside the lock and at every
// await boundary that can observe a handover), never trusts a client-supplied
// price (the total is re-read from the STORED entry and quoted at the current
// reputation), runs under the SAME per-shop lock a purchase uses
// (`runShopExclusive`), persists an `advancedOrder` BEFORE any effect so a
// replayed request resolves idempotently, and never claims transactional
// atomicity. The `fulfill` and `cancel` actions additionally persist their OWN
// separate `preorder-fulfill` / `preorder-cancel` action orders keyed by
// `target + requestId`, so a repeated GM action never delivers twice nor refunds
// twice.
//
// Money is always expressed in non-negative integer minor units. The deposit is
// charged exactly once at `place`, finite merchant `commerce.funds` GAIN the
// deposit; at `fulfill` the REMAINING balance is charged once and finite merchant
// funds GAIN that (and stock is decremented); at `cancel` the deposit is refunded
// once and finite merchant funds are DECREMENTED by it. A `null` `commerce.funds`
// stays unlimited (no funds patch is written).
//
// No Foundry globals are referenced at import time; only the injected deps and
// the pure helpers are used.

import {
  assertMarketId,
  makeId,
  parseItemData,
  PREORDER_MAX_PER_ACTOR_DEFAULT,
} from '../services/model.js';
import { quote } from '../services/pricing.js';
import { fnv1a } from '../services/commerce.js';
import { isShopTrading } from '../automation/policy.js';
import { canAccessEntry, quoteDeposit } from './policy.js';
import { quoteSocial } from '../social/pricing.js';

export const PREORDER_MAX_QUANTITY = 20;

/**
 * Coerce `value` to a safe integer world-time second, or return null when the
 * clock value is invalid (NaN/undefined/Infinity/non-safe). An invalid server
 * time must fail the operation closed (`invalid-world-time`) before any effect
 * rather than collapse to week zero and silently trade.
 */
function safeWorldTime(value) {
  if (Number.isFinite(value)) {
    const floored = Math.floor(value);
    if (Number.isSafeInteger(floored)) return floored;
  }
  return null;
}

/**
 * A pre-order quantity must be a safe integer in 1..PREORDER_MAX_QUANTITY.
 * Anything else is a malformed request and fails before any effect.
 */
function assertQuantity(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`[market] '${label}' must be a safe integer, got ${value}`);
  }
  if (value < 1 || value > PREORDER_MAX_QUANTITY) {
    throw new Error(
      `[market] '${label}' must be between 1 and ${PREORDER_MAX_QUANTITY}, got ${value}`
    );
  }
  return value;
}

/**
 * Deterministic intent fingerprint for a pre-order place. Only the fields that
 * make a place request unique (shop, entry, actor, quantity, requester) are
 * included so two requests with the same intent produce the same hash and can be
 * safely replayed. `requester` is the authenticated executing user id (never a
 * payload field).
 */
export function computePlaceIntentHash({ shopId, entryId, actorId, quantity, requester }) {
  const canonical = JSON.stringify({
    shopId: String(shopId),
    entryId: String(entryId),
    actorId: String(actorId),
    quantity: Number(quantity),
    requester: String(requester),
  });
  return fnv1a(canonical);
}

/**
 * Deterministic intent fingerprint for a GM fulfillment action. The action is
 * fully determined by the original order id, so only `orderId` is hashed; the
 * executing GM is deliberately excluded so a different GM repeating the same
 * request replays rather than conflicts.
 */
export function computeFulfillIntentHash({ orderId }) {
  const canonical = JSON.stringify({ orderId: String(orderId) });
  return fnv1a(canonical);
}

/**
 * Deterministic intent fingerprint for a GM cancellation action. The action is
 * fully determined by the original order id, so only `orderId` is hashed; the
 * executing GM is deliberately excluded so a different GM repeating the same
 * request replays rather than conflicts.
 */
export function computeCancelIntentHash({ orderId }) {
  const canonical = JSON.stringify({ orderId: String(orderId) });
  return fnv1a(canonical);
}

/**
 * Whether a re-read advanced order matches the IMMUTABLE quote/order outcome a
 * pre-order place intended to commit. Only the order id and the immutable quote
 * fields (entryId, quantity, total, deposit, remaining) are compared; these can
 * never change after the pending record is created, so a `booked` record that
 * matches is definitive proof the terminal `booked` write actually persisted.
 */
export function matchesBookedOutcome(order, outcome) {
  return !!(
    order &&
    outcome &&
    order.id === outcome.orderId &&
    order.entryId === outcome.entryId &&
    order.quantity === outcome.quantity &&
    order.total === outcome.total &&
    order.deposit === outcome.deposit &&
    order.remaining === outcome.remaining
  );
}

/**
 * Resolve an already-persisted PRE-ORDER place order for the current intent.
 * Never applies a side effect:
 *   - same key + same intentHash on a `booked`/`fulfilled`/`cancelled` order =>
 *     replay its recorded outcome (a fulfilled/cancelled pre-order is still a
 *     completed place; never recharges the deposit).
 *   - same key + same intentHash on a `pending`/`needsRecovery` order =>
 *     `needsRecovery` (manual recovery; no effect applied, never recharges).
 *   - same key + same intentHash on any other terminal status => replay.
 *   - same key + different intentHash => `conflict` (the request changed).
 */
function resolveExistingPlaceOrder(existing, intentHash) {
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
  const outcome = existing.outcome || {};
  if (existing.status === 'booked' || existing.status === 'fulfilled' || existing.status === 'cancelled') {
    return {
      status: 'replay',
      orderId: existing.id,
      originalStatus: existing.status,
      entryId: existing.entryId,
      quantity: outcome.quantity ?? existing.quantity ?? 0,
      total: outcome.total ?? existing.total ?? 0,
      deposit: outcome.deposit ?? existing.deposit ?? 0,
      remaining: outcome.remaining ?? existing.remaining ?? 0,
    };
  }
  if (existing.status === 'pending' || existing.status === 'needsRecovery') {
    return {
      status: 'needsRecovery',
      orderId: existing.id,
      error: existing.error || 'order-pending',
    };
  }
  // failed / committed -> a terminal replay of the record.
  return { status: 'replay', orderId: existing.id, originalStatus: existing.status };
}

export function createPreorderCommerce(deps) {
  const {
    store,
    runShopExclusive,
    isActiveGM = () => true,
    getActor,
    actorOwnedBy,
    getAdapter,
    fromUuid,
    getSocial,
    getWorldTime,
    now,
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
   * `null`/missing return (the order is gone) is reported as `false` so the
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
        `[market] failed to persist preorder phase '${phase}' for order ${orderId}`,
        err
      );
      return false;
    }
  }

  /**
   * Page through ALL advanced orders matching `filter`, respecting the store's
   * 100-record page cap. The store never returns more than 100 orders per page,
   * so any caller that needs the COMPLETE set (rather than a bounded preview)
   * must iterate offset by offset. Non-positive pages are clamped by the store.
   */
  async function listAllAdvancedOrders(filter = {}, step = 100) {
    const out = [];
    let offset = 0;
    for (;;) {
      const page = await store.listAdvancedOrders({ ...filter, limit: step, offset });
      out.push(...page);
      if (page.length < step) break;
      offset += step;
    }
    return out;
  }

  /**
   * Find a live `preorder-fulfill` OR `preorder-cancel` action for `originalId`
   * that is still pending or needsRecovery. Used to refuse a NEW action key while
   * an in-flight or uncertain action for the same original order exists, so a
   * second GM request never runs a second fulfillment or cancellation - even when
   * the requestId differs or the kinds cross (a pending fulfill blocks a new
   * cancel, and vice versa) because both act on the same original.
   */
  async function findPendingActionForOriginal(kinds, shopId, originalId) {
    const kindList = Array.isArray(kinds) ? kinds : [kinds];
    for (const kind of kindList) {
      const pages = await listAllAdvancedOrders({ shopId, kind });
      for (const action of pages) {
        if (
          action.relatedOrderId === originalId &&
          (action.status === 'pending' || action.status === 'needsRecovery')
        ) {
          return action;
        }
      }
    }
    return null;
  }

  /**
   * Resolve the world clock used for the trading gate. Prefers the authoritative
   * server-side `getWorldTime` (the M4 trading/presence clock); falls back to
   * `now` for compatibility, and to no clock (legacy `shop.open` toggle) when
   * neither is supplied.
   */
  function resolveClock() {
    if (typeof getWorldTime === 'function') return getWorldTime();
    if (typeof now === 'function') return now();
    return null;
  }

  /**
   * The trading gate. Re-read at transaction time (never trusting a request
   * snapshot); returned as an error string, or null when trading. An invalid
   * clock fails closed `invalid-world-time` BEFORE any effect.
   */
  function tradingError(shop) {
    const clockValue = resolveClock();
    if (clockValue != null) {
      const worldTime = safeWorldTime(clockValue);
      if (worldTime == null) return 'invalid-world-time';
      const trading = isShopTrading(shop, worldTime);
      if (!trading.open) return 'shop-closed';
      return null;
    }
    return shop.open === false ? 'shop-closed' : null;
  }

  /**
   * Resolve the item source for an entry. Prefers the live `itemUuid`; if it is
   * absent or deleted (fromUuid returns null) falls back to a valid snapshot.
   * Returns null when both are missing, which forbids the place/fulfill.
   */
  async function resolveItemSource(entry) {
    const uuid = typeof entry.itemUuid === 'string' ? entry.itemUuid.trim() : '';
    if (uuid) {
      const source = await fromUuid(uuid);
      if (source) return source;
    }
    const snapshot = parseItemData(entry.snapshot);
    if (snapshot) return snapshot;
    return null;
  }

  /**
   * The balance verdict for a throwing debit: whether the debit actually applied
   * (so compensation must refund) and whether the state is uncertain. `before`
   * is the balance captured before the debit. Returns `{ debited, uncertain }`.
   */
  async function debitVerdict({ adapter, actor, amount, before }) {
    if (before == null) {
      try {
        before = await adapter.getBalance(actor);
      } catch (err) {
        return { debited: false, uncertain: true };
      }
    }
    let after = null;
    try {
      after = await adapter.getBalance(actor);
    } catch (err) {
      return { debited: false, uncertain: true };
    }
    if (after === before) return { debited: false, uncertain: false };
    if (after === before - amount) return { debited: true, uncertain: false };
    return { debited: false, uncertain: true };
  }

  /**
   * The balance verdict for a throwing credit: whether the credit actually
   * applied (so compensation must debit it back) and whether the state is
   * uncertain. `before` is the balance captured before the credit. Returns
   * `{ credited, uncertain }`.
   */
  async function creditVerdict({ adapter, actor, amount, before }) {
    if (before == null) {
      try {
        before = await adapter.getBalance(actor);
      } catch (err) {
        return { credited: false, uncertain: true };
      }
    }
    let after = null;
    try {
      after = await adapter.getBalance(actor);
    } catch (err) {
      return { credited: false, uncertain: true };
    }
    if (after === before) return { credited: false, uncertain: false };
    if (after === before + amount) return { credited: true, uncertain: false };
    return { credited: false, uncertain: true };
  }

  /**
   * Attempt an actor wallet credit and VERIFY it resolved with the expected
   * balance increase. A throwing credit may still have applied, so the balance is
   * read before and after and the delta is matched exactly. Returns `{ ok }`
   * where `ok=false` means the resolution is uncertain (or the intended refund
   * did not actually reach the player), so the caller must surface needsRecovery
   * rather than a terminal `failed`. When `getBalance` is unavailable the credit
   * is trusted without verification.
   */
  async function resolveWalletCredit(adapter, actor, amount) {
    if (typeof adapter.getBalance !== 'function') {
      try {
        await adapter.credit(actor, amount);
        return { ok: true };
      } catch (e) {
        return { ok: false };
      }
    }
    let before;
    try {
      before = await adapter.getBalance(actor);
    } catch (e) {
      return { ok: false };
    }
    try {
      await adapter.credit(actor, amount);
    } catch (e) {
      // A throwing credit may still have applied; the verdict decides below.
    }
    const verdict = await creditVerdict({ adapter, actor, amount, before });
    if (verdict.uncertain) return { ok: false };
    // A refund only compensates correctly when the balance actually moved as
    // intended; a no-op (balance unchanged) means the refund did not reach the
    // player, so the recovery is uncertain.
    return { ok: verdict.credited };
  }

  /**
   * Attempt an actor wallet debit and VERIFY it resolved with the expected
   * balance decrease. Mirrors `resolveWalletCredit` for debits (used to take back
   * a refunded deposit during cancel compensation). Returns `{ ok }`.
   */
  async function resolveWalletDebit(adapter, actor, amount) {
    if (typeof adapter.getBalance !== 'function') {
      try {
        await adapter.debit(actor, amount);
        return { ok: true };
      } catch (e) {
        return { ok: false };
      }
    }
    let before;
    try {
      before = await adapter.getBalance(actor);
    } catch (e) {
      return { ok: false };
    }
    try {
      await adapter.debit(actor, amount);
    } catch (e) {
      // A throwing debit may still have applied; the verdict decides below.
    }
    const verdict = await debitVerdict({ adapter, actor, amount, before });
    if (verdict.uncertain) return { ok: false };
    return { ok: verdict.debited };
  }

  // ------------------------------------------------------------------ place

  /**
   * Place an out-of-stock pre-order for a player-owned actor. `requesterId` is
   * the authenticated player user id (the idempotency-key prefix, ownership
   * principal and order `userId`), never a payload field. The active GM executes
   * on behalf of the player, so `isActiveGM` gates every entry point.
   */
  function place(payload = {}, authenticatedUserId) {
    let shopId;
    let entryId;
    let actorId;
    let quantity;
    let requestId;
    try {
      shopId = assertMarketId(payload.shopId, 'shopId');
      entryId = assertMarketId(payload.entryId, 'entryId');
      actorId = assertMarketId(payload.actorId, 'actorId');
      quantity = assertQuantity(payload.quantity ?? 1, 'quantity');
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
    const key = `preorder:${requester}:${requestId}`;
    const intentHash = computePlaceIntentHash({
      shopId,
      entryId,
      actorId,
      quantity,
      requester,
    });

    // GM gate BEFORE any store read. A player watching the app never triggers a
    // read or a write.
    if (!isActiveGM()) {
      return Promise.resolve({ status: 'error', error: 'not-active-gm' });
    }

    return runShopExclusive(shopId, () =>
      placeLocked({ shopId, entryId, actorId, quantity, requester, key, intentHash })
    );
  }

  async function placeLocked(ctx) {
    const { shopId, entryId, actorId, quantity, requester, key, intentHash } = ctx;

    // 0. Re-check the active-GM guard before ANY read.
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
      return resolveExistingPlaceOrder(existing, intentHash);
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 2. Re-read the shop inside the lock (never trust the request).
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
    const preorders = shop.commerce && shop.commerce.preorders;
    if (!preorders || preorders.enabled !== true) {
      return { status: 'error', error: 'preorders-disabled' };
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 3. Re-read the actor and verify ownership.
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

    // 4. Trading gate (world clock read server-side, fail closed).
    const gateError = tradingError(shop);
    if (gateError) return { status: 'error', error: gateError };

    // 5. Resolve the entry from the STORED shop (visible + accessible) and quote
    //    it at the current shop/actor reputation - never a client price.
    let effective;
    if (getSocial) {
      try {
        effective = await getSocial(shop, actor);
      } catch (err) {
        return {
          status: 'error',
          error: `rep-read-failed: ${(err && err.message) || err}`,
        };
      }
    }
    const entry = shop.inventory.find((e) => e.id === entryId);
    if (!entry) return { status: 'error', error: 'entry-not-found' };
    if (entry.visible === false) return { status: 'error', error: 'entry-hidden' };
    const repScore = effective?.score ?? -100;
    if (!canAccessEntry(entry, { actorUuid: actor?.uuid, score: repScore })) {
      return { status: 'error', error: 'entry-restricted' };
    }

    // 6. The pre-order is only meaningful when stock is insufficient (never for
    //    an unlimited entry). A finite/non-restocking entry that can serve the
    //    quantity right now should just be bought, not pre-ordered.
    if (entry.stockMode === 'unlimited') {
      return { status: 'error', error: 'stock-sufficient' };
    }
    if (entry.quantity >= quantity) {
      return { status: 'error', error: 'stock-sufficient' };
    }

    // 7. No duplicate live booked pre-orders beyond the shop's maxPerActor cap.
    //    The store returns at most 100 orders per page, so page through ALL
    //    `preorder` orders for this actor rather than trusting a bounded preview
    //    - otherwise a shop with >100 preorders could exceed the cap silently.
    let preorderCount = 0;
    try {
      const booked = await listAllAdvancedOrders({ shopId, actorId, kind: 'preorder' });
      for (const o of booked) {
        if (o.entryId === entryId && o.status === 'booked') preorderCount += 1;
      }
    } catch (err) {
      return {
        status: 'error',
        error: `order-list-failed: ${(err && err.message) || err}`,
      };
    }
    const maxPerActor = preorders.maxPerActor ?? PREORDER_MAX_PER_ACTOR_DEFAULT;
    if (preorderCount >= maxPerActor) {
      return { status: 'error', error: 'max-preorders-reached' };
    }

    // 8. The item source must resolve NOW via UUID/snapshot so fulfillment knows
    //    what to deliver even after the stock is replenished.
    let source;
    try {
      source = await resolveItemSource(entry);
    } catch (err) {
      return {
        status: 'error',
        error: `item-source-failed: ${(err && err.message) || err}`,
      };
    }
    if (!source) return { status: 'error', error: 'item-source-missing' };

    // 9. Quote the authoritative total at the current rep and split deposit.
    let total;
    let unitPrice;
    if (getSocial) {
      let q;
      try {
        q = quoteSocial(entry, quantity, {
          shop,
          scores: { individual: effective?.individual, party: effective?.party },
        });
      } catch (err) {
        return {
          status: 'error',
          error: `total-overflow: ${(err && err.message) || err}`,
        };
      }
      if (q.refused) {
        return {
          status: 'error',
          error: 'service-refused',
          detail: 'shop reputation is Hated',
        };
      }
      total = q.total;
      unitPrice = q.unitPrice;
    } else {
      try {
        total = quote(entry, quantity);
      } catch (err) {
        return {
          status: 'error',
          error: `total-overflow: ${(err && err.message) || err}`,
        };
      }
      unitPrice = entry.price;
    }

    let depositSplit;
    try {
      depositSplit = quoteDeposit(total, shop);
    } catch (err) {
      return {
        status: 'error',
        error: `quote-deposit-failed: ${(err && err.message) || err}`,
      };
    }
    const { deposit, remaining } = depositSplit;

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 10. Adapter must be supported and the actor's balance must cover the
    //     deposit (not the total - the remainder is paid at fulfillment).
    const adapter = getAdapter();
    if (!adapter || !adapter.supported) {
      return { status: 'error', error: 'adapter-unsupported' };
    }
    let balance;
    try {
      balance = await adapter.getBalance(actor);
    } catch (err) {
      return {
        status: 'error',
        error: `balance-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (balance < deposit) {
      return {
        status: 'error',
        error: 'insufficient-funds',
        detail: `need deposit ${deposit}, have ${balance}`,
      };
    }

    // 11. Finite merchant funds GAIN the deposit. Refuse on a safe-integer
    //     overflow BEFORE any effect rather than wrapping. `null` funds stay
    //     unlimited (no funds patch written).
    const funds = shop.commerce ? shop.commerce.funds : null;
    const finiteFunds = funds != null;
    const fundsBefore = funds;
    let fundsAfter = null;
    if (finiteFunds) {
      const gained = Number(BigInt(funds) + BigInt(deposit));
      if (!Number.isSafeInteger(gained)) {
        return { status: 'error', error: 'funds-overflow' };
      }
      fundsAfter = gained;
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 12. Persist the PENDING order BEFORE charging.
    const details = {
      entryId,
      name: entry.name,
      quantity,
      total,
      deposit,
      remaining,
      unitPrice,
      itemUuid: entry.itemUuid || '',
      snapshot: entry.snapshot || '',
      fundsBefore,
    };
    const orderRecord = {
      key,
      kind: 'preorder',
      status: 'pending',
      phase: 'recorded',
      shopId,
      userId: requester,
      actorId,
      entryId,
      relatedOrderId: '',
      quantity,
      total,
      deposit,
      remaining,
      intentHash,
      details,
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
      // A create-race handed back an existing pre-order for the same key;
      // resolve idempotently and NEVER apply an effect.
      return resolveExistingPlaceOrder(order, intentHash);
    }
    const orderId = order.id;

    // 13. Effects: debit deposit -> debited -> merchant funds patch -> credited
    //     -> commit `booked` -> final. Any failure AFTER pending goes through
    //     best-effort compensation; never silently double-debits.
    let debited = false;
    let shopWriteAttempted = false;
    let uncertain = false;
    let bookingWriteFailed = false;
    let outcome = null;
    try {
      activeGmOrThrow();

      // Debit the deposit ONCE. A throwing debit may STILL have applied, so it is
      // ALWAYS rolled back (never trusted); the balance verdict only decides
      // whether the player must be refunded and whether the state is uncertain.
      try {
        await adapter.debit(actor, deposit);
        debited = true;
      } catch (err) {
        const verdict = await debitVerdict({
          adapter,
          actor,
          amount: deposit,
          before: balance,
        });
        debited = verdict.debited;
        if (verdict.uncertain) uncertain = true;
        throw err;
      }

      activeGmOrThrow();
      if (!(await setPhase(orderId, 'debited'))) uncertain = true;

      // Finite merchant funds gain the deposit in a SINGLE shop patch. For
      // unlimited (`null`) funds there is no write. Whether the write throws or
      // returns null, the compensation re-reads the shop and restores a
      // known-applied write or marks needsRecovery for mixed/uncertain - never a
      // terminal `failed` while residual funds remain.
      if (finiteFunds) {
        shopWriteAttempted = true;
        const commerce = { ...shop.commerce, funds: fundsAfter };
        const shopWritten = await store.updateShop(shopId, { commerce });
        if (shopWritten == null) throw new Error('shop-write-missing');
      }

      activeGmOrThrow();
      if (!(await setPhase(orderId, 'credited'))) uncertain = true;

      // Commit. Only claim `booked` when the terminal write actually persisted a
      // record: a `null` return means the commit is uncertain, and a THROWING
      // write may STILL have landed (apply-then-throw). Either way the original
      // order is re-read by id BEFORE any compensation, so a persisted matching
      // `booked` is never refunded or fund-restored.
      outcome = { orderId, entryId, quantity, total, deposit, remaining };
      let committedRecord = null;
      try {
        committedRecord = await store.updateAdvancedOrder(orderId, {
          status: 'booked',
          phase: 'final',
          outcome,
        });
      } catch (commitErr) {
        bookingWriteFailed = true;
        throw commitErr;
      }
      if (committedRecord == null) {
        uncertain = true;
        bookingWriteFailed = true;
        throw new Error('order-commit-missing');
      }
      return {
        status: 'booked',
        orderId,
        entryId,
        quantity,
        total,
        deposit,
        remaining,
      };
    } catch (err) {
      if (err && err.message === 'order-commit-missing') uncertain = true;
      if (bookingWriteFailed) {
        // The final `booked` write threw or returned null and may still have
        // landed. Re-read the original order by id BEFORE compensating: return
        // `booked` for a persisted matching booking, compensate only when the
        // record is reliably still pending, and escalate (no reversal) when the
        // re-read is unavailable or ambiguous while safely marking without
        // overwriting a genuine `booked`.
        return resolveUncertainBooking({
          err,
          orderId,
          shopId,
          actor,
          deposit,
          debited,
          shopWriteAttempted,
          finiteFunds,
          fundsBefore,
          fundsAfter,
          details,
          uncertain,
          adapter,
          outcome,
        });
      }
      return compensatePlace({
        err,
        orderId,
        shopId,
        actor,
        deposit,
        debited,
        shopWriteAttempted,
        finiteFunds,
        fundsBefore,
        fundsAfter,
        details,
        uncertain,
        adapter,
      });
    }
  }

  /**
   * Best-effort recovery after a pending pre-order place was persisted and an
   * effect (or the final commit) failed. Undoes exactly what may have been
   * applied and never double-compensates: the player is credited the deposit only
   * if the debit applied, and merchant funds are restored only when the single
   * shop patch actually applied - decided by comparing the CURRENT shop funds to
   * the recorded before/after. No stock was reserved, so there is never a stock
   * restore. A fully successful compensation records `failed`, an uncertain one
   * records `needsRecovery`.
   */
  async function compensatePlace(ctx) {
    const {
      err,
      orderId,
      shopId,
      actor,
      deposit,
      debited,
      shopWriteAttempted,
      finiteFunds,
      fundsBefore,
      fundsAfter,
      details,
      uncertain = false,
      adapter,
    } = ctx;
    const compensation = [];
    let uncertainOutcome = uncertain;

    if (debited) {
      const resolved = await resolveWalletCredit(adapter, actor, deposit);
      if (resolved.ok) {
        compensation.push('deposit-refunded');
      } else {
        compensation.push('deposit-refund-verify-failed');
        uncertainOutcome = true;
      }
    }

    // A shop write was ATTEMPTED (the merchant funds patch was issued). Whether it
    // threw or returned null, it may still have landed, so re-read the shop and
    // compare to the recorded before/after. Restore a known-applied write, leave a
    // known-unwritten write alone, and surface needsRecovery for any mixed or
    // uncertain state - never a terminal `failed` while residual funds remain.
    if (finiteFunds && shopWriteAttempted) {
      try {
        const current = await store.findShop(shopId);
        if (!current) {
          compensation.push('shop-missing');
          uncertainOutcome = true;
        } else {
          const currentFunds =
            current.commerce && current.commerce.funds != null
              ? current.commerce.funds
              : null;
          if (currentFunds === fundsBefore) {
            compensation.push('shop-unwritten');
          } else if (currentFunds === fundsAfter) {
            const commerce = { ...current.commerce, funds: fundsBefore };
            const returned = await store.updateShop(shopId, { commerce });
            const verified = !!(
              returned &&
              returned.commerce &&
              returned.commerce.funds === fundsBefore
            );
            if (verified) {
              compensation.push('shop-restored');
            } else {
              compensation.push('shop-restore-verify-failed');
              uncertainOutcome = true;
            }
          } else {
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
          ...details,
          error: String((err && err.message) || err),
          compensation,
          updatedAt: now ? now() : Date.now(),
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
        `[market] failed to persist preorder place compensation for order ${orderId}`,
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
   * Decide what to do when the FINAL `booked` commit of a pre-order place threw
   * or returned null. The write may still have landed (apply-then-throw), so the
   * original order is re-read by id BEFORE any compensation:
   *   - a persisted `booked` order matching the immutable quote/outcome fields =>
   *     return `booked` with NO deposit refund and NO merchant-fund restore;
   *   - a record reliably still `pending` => the terminal write did NOT land, so
   *     the normal compensation runs (refund deposit, restore funds, mark);
   *   - an unavailable or ambiguous re-read (throws, order missing, or status is
   *     neither a matching booked nor a reliable pending) => return
   *     `needsRecovery` with NO reversal (deposit and merchant funds retained)
   *     and attempt a `needsRecovery` marker only when it will not overwrite a
   *     genuinely `booked` record.
   */
  async function resolveUncertainBooking(ctx) {
    const { err, orderId, outcome, ...comp } = ctx;
    const compensationCtx = { ...comp, orderId, err };

    let current = null;
    let rereadFailed = false;
    try {
      current = await store.findAdvancedOrder(orderId);
    } catch (e) {
      rereadFailed = true;
    }

    // The booking actually persisted and matches the immutable quote, so the
    // order IS booked. Never refund, never restore merchant funds.
    if (
      !rereadFailed &&
      current &&
      current.status === 'booked' &&
      matchesBookedOutcome(current, outcome)
    ) {
      return {
        status: 'booked',
        orderId,
        entryId: outcome.entryId,
        quantity: outcome.quantity,
        total: outcome.total,
        deposit: outcome.deposit,
        remaining: outcome.remaining,
      };
    }

    // Reliably still pending: the terminal write did NOT persist. Compensate.
    if (!rereadFailed && current && current.status === 'pending') {
      return compensatePlace(compensationCtx);
    }

    // Unavailable or ambiguous. No reversal - the deposit and merchant funds are
    // retained. Attempt a safe marker without overwriting a genuine booked.
    await attemptSafeNeedsRecoveryMarker(orderId, outcome);
    return {
      status: 'needsRecovery',
      orderId,
      error: String((err && err.message) || err),
    };
  }

  /**
   * Best-effort marker for an uncertain booking commit. Only writes
   * `needsRecovery` when a re-read confirms the record is NOT already a matching
   * `booked`, so a genuinely-persisted booking is never overwritten. A record
   * that is a matching `booked`, or that is gone (null), is left untouched;
   * failures are swallowed because the marker is diagnostic only.
   */
  async function attemptSafeNeedsRecoveryMarker(orderId, outcome) {
    try {
      let current = null;
      let readOk = true;
      try {
        current = await store.findAdvancedOrder(orderId);
      } catch (e) {
        readOk = false;
      }
      if (readOk) {
        if (current == null) return; // record gone; nothing to mark
        if (current.status === 'booked' && matchesBookedOutcome(current, outcome)) {
          return; // genuine booked; never overwrite
        }
      }
      // Re-read was unavailable OR the record is not a matching booked: attempt
      // the marker. Best-effort.
      let marked = null;
      try {
        marked = await store.updateAdvancedOrder(orderId, {
          status: 'needsRecovery',
          phase: 'final',
          error: 'booking-write-uncertain',
        });
      } catch (markErr) {
        // best-effort marker
      }
      if (marked == null) return; // record gone; nothing marked
    } catch (e) {
      // best-effort marker
    }
  }

  // ------------------------------------------------------------------ fulfill

  /**
   * Resolve an already-persisted `preorder-fulfill` action record for the current
   * intent. Never re-delivers. The verdict is based on the ORIGINAL order's
   * status, as the spec requires: a fulfilled original replays as success, a
   * still-booked original with only a pending/needsRecovery action surfaces
   * `needsRecovery`.
   */
  async function resolveExistingFulfill(existing, intentHash, orderId) {
    if (existing.intentHash !== intentHash) {
      return {
        status: 'conflict',
        conflict: true,
        orderId,
        error: 'conflicting duplicate payload',
        expected: existing.intentHash,
        existing,
      };
    }
    const outcome = existing.outcome || {};
    let order = null;
    try {
      order = await store.findAdvancedOrder(orderId);
    } catch (err) {
      order = null;
    }
    const orderFulfilled = !!(
      order && order.kind === 'preorder' && order.status === 'fulfilled'
    );

    if (orderFulfilled) {
      // The fulfillment already happened; finalize a still-pending action record
      // best-effort, never re-running.
      if (existing.status === 'pending' || existing.status === 'needsRecovery') {
        try {
          await store.updateAdvancedOrder(existing.id, {
            status: 'committed',
            phase: 'final',
          });
        } catch (e) {
          // non-fatal: the acknowledgement write is best-effort
        }
      }
      return {
        status: 'replay',
        orderId,
        originalStatus: order.status,
        entryId: order.entryId || outcome.entryId,
        quantity: order.quantity != null ? order.quantity : outcome.quantity,
        total: order.total != null ? order.total : outcome.total,
        remaining: order.remaining != null ? order.remaining : outcome.remaining,
        deposit: order.deposit != null ? order.deposit : outcome.deposit,
      };
    }

    if (existing.status === 'committed') {
      // The record claims committed but the original is not fulfilled: an
      // inconsistent record needing manual reconciliation.
      return {
        status: 'needsRecovery',
        orderId,
        error: 'fulfilled-order-inconsistent',
      };
    }
    if (existing.status === 'pending' || existing.status === 'needsRecovery') {
      return {
        status: 'needsRecovery',
        orderId,
        error: existing.error || 'order-pending',
      };
    }
    // Some other terminal status on a still-booked original.
    return { status: 'needsRecovery', orderId, error: 'order-not-booked' };
  }

  /**
   * Replay the fulfillment of an original order that is already `fulfilled`.
   * Returns a clean replay result.
   */
  function fulfilledReplay(order) {
    const outcome = order.outcome || {};
    return {
      status: 'replay',
      orderId: order.id,
      originalStatus: order.status,
      entryId: order.entryId || outcome.entryId,
      quantity: order.quantity != null ? order.quantity : outcome.quantity,
      total: order.total != null ? order.total : outcome.total,
      remaining: order.remaining != null ? order.remaining : outcome.remaining,
      deposit: order.deposit != null ? order.deposit : outcome.deposit,
    };
  }

  /**
   * Fulfill a booked pre-order: charge the REMAINING balance, deliver the item,
   * decrement stock, and gain the remaining merchant funds. `gmUserId` is the
   * executing GM user id (never a payload field) and is the action order's
   * `userId`.
   */
  function fulfill(payload = {}, gmUserId) {
    let orderId;
    let requestId;
    try {
      orderId = assertMarketId(payload.orderId, 'orderId');
      requestId = payload.requestId
        ? assertMarketId(payload.requestId, 'requestId')
        : makeId();
    } catch (err) {
      return Promise.resolve({ status: 'error', error: err.message });
    }
    const gmUser = String(gmUserId ?? '').trim();
    if (gmUser === '') {
      return Promise.resolve({ status: 'error', error: 'gm-required' });
    }
    const key = `preorder-fulfill:${orderId}:${requestId}`;
    const intentHash = computeFulfillIntentHash({ orderId });

    if (!isActiveGM()) {
      return Promise.resolve({ status: 'error', error: 'not-active-gm' });
    }

    // The lock is per-shop; the order's shopId is not in the payload, so read the
    // order once to find it. This read happens only after the GM gate, and the
    // authoritative re-read occurs inside the lock.
    return Promise.resolve().then(async () => {
      let preOrder;
      try {
        preOrder = await store.findAdvancedOrder(orderId);
      } catch (err) {
        return {
          status: 'error',
          error: `order-read-failed: ${(err && err.message) || err}`,
        };
      }
      if (!preOrder) return { status: 'error', error: 'order-not-found' };
      const shopId = preOrder.shopId;
      return runShopExclusive(shopId, () =>
        fulfillLocked({ orderId, requestId, gmUser, key, intentHash })
      );
    });
  }

  async function fulfillLocked(ctx) {
    const { orderId, requestId, gmUser, key, intentHash } = ctx;

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 1. Idempotency re-read of the fulfillment action BEFORE any state change.
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
      return resolveExistingFulfill(existing, intentHash, orderId);
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 2. Look up the original order. It must be a `preorder` kind; a `booked`
    //    original proceeds, an already-`fulfilled` one replays as success.
    let order;
    try {
      order = await store.findAdvancedOrder(orderId);
    } catch (err) {
      return {
        status: 'error',
        error: `order-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (!order) return { status: 'error', error: 'order-not-found' };
    if (order.kind !== 'preorder') {
      return { status: 'error', error: 'order-not-preorder' };
    }
    if (order.status === 'fulfilled') {
      return fulfilledReplay(order);
    }
    if (order.status !== 'booked') {
      return { status: 'error', error: 'order-not-booked' };
    }
    const shopId = order.shopId;

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 2b. Before creating a NEW fulfill action key, page through EVERY
    //     `preorder-fulfill` AND `preorder-cancel` action for this original order.
    //     If any is pending or needsRecovery, a fulfillment (or a competing
    //     cancellation) is already in flight or uncertain; surface needsRecovery
    //     and NEVER run a second fulfillment - even when the requestId differs.
    let staleAction;
    try {
      staleAction = await findPendingActionForOriginal(
        ['preorder-fulfill', 'preorder-cancel'],
        shopId,
        orderId
      );
    } catch (err) {
      return {
        status: 'error',
        error: `order-list-failed: ${(err && err.message) || err}`,
      };
    }
    if (staleAction) {
      return {
        status: 'needsRecovery',
        orderId,
        error: staleAction.error || 'order-pending',
      };
    }

    // 3. Require the shop, actor and entry to still exist.
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

    let actor;
    try {
      actor = await getActor(order.actorId);
    } catch (err) {
      return {
        status: 'error',
        error: `actor-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (!actor) return { status: 'error', error: 'actor-not-found' };

    const entry = shop.inventory.find((e) => e.id === order.entryId);
    if (!entry) return { status: 'error', error: 'entry-not-found' };
    // A finite/non-restocking entry must be able to serve the quantity now; an
    // unlimited entry always can.
    if (entry.stockMode !== 'unlimited' && entry.quantity < order.quantity) {
      return { status: 'error', error: 'insufficient-stock' };
    }

    // 4. Validate the item source NOW (the stock may have been replenished since
    //    the place).
    let source;
    try {
      source = await resolveItemSource(entry);
    } catch (err) {
      return {
        status: 'error',
        error: `item-source-failed: ${(err && err.message) || err}`,
      };
    }
    if (!source) return { status: 'error', error: 'item-source-missing' };

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 5. Adapter must be supported and the actor's balance must cover the
    //    REMAINING balance only (the deposit was already paid at place).
    const adapter = getAdapter();
    if (!adapter || !adapter.supported) {
      return { status: 'error', error: 'adapter-unsupported' };
    }
    let balance;
    try {
      balance = await adapter.getBalance(actor);
    } catch (err) {
      return {
        status: 'error',
        error: `balance-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (balance < order.remaining) {
      return {
        status: 'error',
        error: 'insufficient-funds',
        detail: `need remaining ${order.remaining}, have ${balance}`,
      };
    }

    // 6. Finite merchant funds GAIN the remaining. Refuse on a safe-integer
    //    overflow BEFORE any effect. `null` funds stay unlimited.
    const funds = shop.commerce ? shop.commerce.funds : null;
    const finiteFunds = funds != null;
    const fundsBefore = funds;
    let fundsAfter = null;
    if (finiteFunds) {
      const gained = Number(BigInt(funds) + BigInt(order.remaining));
      if (!Number.isSafeInteger(gained)) {
        return { status: 'error', error: 'funds-overflow' };
      }
      fundsAfter = gained;
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 7. Persist the PENDING fulfillment action BEFORE any effect, keyed by
    //    target + requestId so a repeated fulfill never delivers a second time.
    const fulfillRecord = {
      key,
      kind: 'preorder-fulfill',
      status: 'pending',
      phase: 'recorded',
      shopId: order.shopId,
      userId: gmUser,
      actorId: order.actorId,
      entryId: order.entryId,
      relatedOrderId: orderId,
      quantity: order.quantity,
      total: order.total,
      deposit: order.deposit,
      remaining: order.remaining,
      intentHash,
      details: {
        entryId: order.entryId,
        name: entry.name,
        quantity: order.quantity,
        total: order.total,
        deposit: order.deposit,
        remaining: order.remaining,
        fundsBefore,
      },
      outcome: {},
    };
    let createdResult;
    try {
      createdResult = await store.createAdvancedOrder(fulfillRecord);
    } catch (err) {
      return {
        status: 'error',
        error: `order-create-failed: ${(err && err.message) || err}`,
      };
    }
    const record = createdResult.record;
    if (!createdResult.created) {
      // A create-race handed back an existing action for the same key; resolve
      // idempotently and never re-deliver or re-charge.
      return resolveExistingFulfill(record, intentHash, orderId);
    }
    const fulfillId = record.id;

    // 8. Effects: debit remaining -> debited -> deliver -> transferred -> shop
    //    write (stock + funds) -> stocked -> mark original fulfilled -> mark
    //    action committed. Any failure AFTER pending goes through best-effort
    //    compensation below.
    let debited = false;
    const delivered = [];
    let shopWriteAttempted = false;
    let uncertain = false;
    let originalMarked = false;
    try {
      activeGmOrThrow();

      // Debit the remaining ONCE. A throwing debit may STILL have applied, so it
      // is ALWAYS rolled back (never trusted).
      try {
        await adapter.debit(actor, order.remaining);
        debited = true;
      } catch (err) {
        const verdict = await debitVerdict({
          adapter,
          actor,
          amount: order.remaining,
          before: balance,
        });
        debited = verdict.debited;
        if (verdict.uncertain) uncertain = true;
        throw err;
      }

      activeGmOrThrow();
      if (!(await setPhase(fulfillId, 'debited'))) uncertain = true;

      // Deliver the quantity and record the created id so compensation can
      // remove it. A SUCCESSFUL response that carries no safe created id (a null,
      // undefined or empty id) means the item may exist but cannot be removed, so
      // the fulfill is marked uncertain - never a clean refund/remove. A delivery
      // that THROWS may still have delivered an item with an unknown id, so the
      // line is recorded with a null createdId (uncertain) and the fulfill FORCES
      // needsRecovery rather than a clean refund-and-failed.
      activeGmOrThrow();
      try {
        const created = await adapter.deliverItem(actor, source, {
          quantity: order.quantity,
        });
        const createdId =
          created && created.id != null && created.id !== '' ? created.id : null;
        if (createdId == null) uncertain = true;
        delivered.push({ entryId: order.entryId, createdId });
      } catch (deliverErr) {
        delivered.push({ entryId: order.entryId, createdId: null });
        uncertain = true;
        throw deliverErr;
      }

      activeGmOrThrow();
      if (!(await setPhase(fulfillId, 'transferred'))) uncertain = true;

      // ONE shop write inside the lock: decrement finite / non-restocking stock
      // and gain the remaining merchant funds. An unlimited entry never changes
      // stock. Whether the write throws or returns null, compensation re-reads
      // the shop and restores a known-applied write or marks needsRecovery for
      // mixed/uncertain - never a terminal `failed` while residual stock/funds.
      let newInventory = shop.inventory;
      if (entry.stockMode !== 'unlimited') {
        newInventory = shop.inventory.map((e) =>
          e.id === entry.id ? { ...e, quantity: e.quantity - order.quantity } : e
        );
      }
      let commerce = shop.commerce;
      if (finiteFunds) commerce = { ...commerce, funds: fundsAfter };
      shopWriteAttempted = true;
      const shopWritten = await store.updateShop(shopId, {
        inventory: newInventory,
        commerce,
      });
      if (shopWritten == null) throw new Error('shop-write-missing');

      activeGmOrThrow();
      if (!(await setPhase(fulfillId, 'stocked'))) uncertain = true;

      // Mark the original fulfilled. If the write throws or returns null, the
      // effects may still be applied; re-read the original to decide. When it is
      // actually fulfilled despite the exception, never undo - escalate.
      try {
        const updatedOriginal = await store.updateAdvancedOrder(orderId, {
          status: 'fulfilled',
          phase: 'final',
        });
        if (updatedOriginal == null) {
          uncertain = true;
          throw new Error('order-commit-missing');
        }
        originalMarked = true;
      } catch (originalErr) {
        let currentOriginal = null;
        try {
          currentOriginal = await store.findAdvancedOrder(orderId);
        } catch (e) {
          currentOriginal = null;
        }
        if (
          currentOriginal &&
          currentOriginal.kind === 'preorder' &&
          currentOriginal.status === 'fulfilled'
        ) {
          originalMarked = true;
          uncertain = true;
        } else if (!currentOriginal) {
          // The re-read itself threw or the original is missing: the `fulfilled`
          // write may STILL have landed, so NEVER undo the applied effects
          // (debit, delivery, stock/funds) - escalate the action instead. Mark
          // the original as if it were terminal so compensation is skipped and
          // the action becomes needsRecovery; the unresolved-action guard blocks
          // any future related action for this original.
          originalMarked = true;
          uncertain = true;
        }
        throw originalErr;
      }

      activeGmOrThrow();
      const outcome = {
        orderId,
        entryId: order.entryId,
        quantity: order.quantity,
        total: order.total,
        deposit: order.deposit,
        remaining: order.remaining,
      };
      const committedRecord = await store.updateAdvancedOrder(fulfillId, {
        status: 'committed',
        phase: 'final',
        outcome,
      });
      if (committedRecord == null) {
        uncertain = true;
        throw new Error('fulfill-commit-missing');
      }
      return {
        status: 'fulfilled',
        orderId,
        entryId: outcome.entryId,
        quantity: outcome.quantity,
        total: outcome.total,
        remaining: outcome.remaining,
        deposit: outcome.deposit,
      };
    } catch (err) {
      if (err && (err.message === 'order-commit-missing' || err.message === 'fulfill-commit-missing')) {
        uncertain = true;
      }
      return compensateFulfill({
        err,
        orderId,
        fulfillId,
        shopId,
        actor,
        entryId: order.entryId,
        entry,
        quantity: order.quantity,
        remaining: order.remaining,
        debited,
        delivered,
        shopWriteAttempted,
        finiteFunds,
        fundsBefore,
        fundsAfter,
        uncertain,
        originalMarked,
        adapter,
      });
    }
  }

  /**
   * Best-effort recovery after a pending fulfill action was persisted and an
   * effect (or the final commit) failed. When the original was NOT yet marked
   * fulfilled, we undo exactly what may have been applied: credit the actor back
   * the remaining only if the debit applied, remove delivered lines, and restore
   * stock/funds only when the single shop write actually applied - leaving the
   * original `booked` when safely undone. When the ORIGINAL WAS successfully
   * marked fulfilled (only the action commit failed), the effects are already
   * done and the original is fulfilled, so no compensation runs and the action is
   * escalated. A fully successful undo records `failed`, an uncertain one records
   * `needsRecovery`.
   */
  async function compensateFulfill(ctx) {
    const {
      err,
      orderId,
      fulfillId,
      shopId,
      actor,
      entryId,
      entry,
      quantity,
      remaining,
      debited,
      delivered,
      shopWriteAttempted,
      finiteFunds,
      fundsBefore,
      fundsAfter,
      uncertain = false,
      originalMarked,
      adapter,
    } = ctx;

    // The original was already marked fulfilled: the fulfillment happened, only
    // the action record is not committed. Do NOT undo effects; escalate the
    // action and leave the original fulfilled.
    if (originalMarked) {
      let responseStatus = 'needsRecovery';
      try {
        await store.updateAdvancedOrder(fulfillId, {
          status: 'needsRecovery',
          phase: 'final',
          error: String((err && err.message) || err),
        });
      } catch (e) {
        // The action record could not even be marked; it stays `pending`.
      }
      return {
        status: responseStatus,
        orderId,
        error: String((err && err.message) || err),
        compensation: uncertain ? ['action-mark-uncertain'] : [],
      };
    }

    const compensation = [];
    let uncertainOutcome = uncertain;

    if (debited) {
      // Verify the refund resolved on the actor wallet with the expected
      // before/after balance; an unresolved refund is a manual-reconcile case.
      const resolved = await resolveWalletCredit(adapter, actor, remaining);
      if (resolved.ok) {
        compensation.push('remaining-refunded');
      } else {
        compensation.push('remaining-refund-verify-failed');
        uncertainOutcome = true;
      }
    }

    // Delivered lines are removed in reverse. A line with no safe created id - a
    // success response that returned no id, or a delivery that may have created an
    // item before throwing - cannot be removed, so it is left for manual
    // reconciliation and NEVER passed to the adapter as a null/undefined id.
    for (let i = delivered.length - 1; i >= 0; i--) {
      const { createdId } = delivered[i];
      if (createdId == null) {
        compensation.push('item-unknown');
        uncertainOutcome = true;
        continue;
      }
      try {
        await adapter.removeItem(actor, createdId);
        compensation.push('item-removed');
      } catch (e) {
        compensation.push('item-remove-failed');
        uncertainOutcome = true;
      }
    }

    // Shop stock/funds restoration, whenever the single shop write was ATTEMPTED.
    // A write that threw or returned null may still have landed, so re-read the
    // shop and compare to this fulfill's recorded before/after - never a guess.
    // Restore a known-applied write, leave a known-unwritten one alone, and
    // surface needsRecovery for any mixed/uncertain residual stock/funds.
    if (shopWriteAttempted) {
      try {
        const current = await store.findShop(shopId);
        if (!current) {
          compensation.push('shop-missing');
          uncertainOutcome = true;
        } else {
          let anyApplied = false;
          let anyNotApplied = false;
          let mixed = false;
          if (entry.stockMode !== 'unlimited') {
            const curr = current.inventory.find((e) => e.id === entryId);
            if (!curr) {
              mixed = true;
            } else if (curr.quantity === entry.quantity - quantity) {
              anyApplied = true;
            } else if (curr.quantity === entry.quantity) {
              anyNotApplied = true;
            } else {
              mixed = true;
            }
          }
          const currentFunds = current.commerce ? current.commerce.funds : null;
          const fundsChanged = finiteFunds && fundsAfter !== fundsBefore;
          if (fundsChanged) {
            if (currentFunds === fundsAfter) {
              anyApplied = true;
            } else if (currentFunds === fundsBefore) {
              anyNotApplied = true;
            } else {
              mixed = true;
            }
          }
          if (!mixed && !anyApplied) {
            anyNotApplied = true;
          }

          if (mixed) {
            compensation.push('shop-state-mixed');
            uncertainOutcome = true;
          } else if (anyApplied && anyNotApplied) {
            compensation.push('shop-state-mixed');
            uncertainOutcome = true;
          } else if (anyApplied) {
            // Known full-write: restore this fulfill's exact entry and funds in
            // the SAME update, then verify.
            let restoredInventory = current.inventory.map((e) =>
              e.id === entryId && entry.stockMode !== 'unlimited'
                ? { ...e, quantity: entry.quantity }
                : e
            );
            let commerce = current.commerce;
            if (finiteFunds) commerce = { ...commerce, funds: fundsBefore };
            const returned = await store.updateShop(shopId, {
              inventory: restoredInventory,
              commerce,
            });
            const verified = !!(
              returned &&
              (entry.stockMode === 'unlimited' ||
                (() => {
                  const r = returned.inventory.find((x) => x.id === entryId);
                  return r && r.quantity === entry.quantity;
                })()) &&
              (!finiteFunds ||
                (returned.commerce && returned.commerce.funds === fundsBefore))
            );
            if (verified) {
              compensation.push('shop-restored');
            } else {
              compensation.push('shop-restore-verify-failed');
              uncertainOutcome = true;
            }
          } else {
            // No observable change: nothing to undo.
            compensation.push('shop-unwritten');
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
      const updated = await store.updateAdvancedOrder(fulfillId, {
        status,
        phase: 'final',
        error: String((err && err.message) || err),
        details: {
          compensation,
          updatedAt: now ? now() : Date.now(),
        },
      });
      if (updated == null) {
        responseStatus = 'needsRecovery';
        compensation.push('order-write-missing');
      }
    } catch (e) {
      logger?.error?.(
        `[market] failed to persist preorder fulfill compensation for order ${fulfillId}`,
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

  // ------------------------------------------------------------------ cancel

  /**
   * Resolve an already-persisted `preorder-cancel` action record for the current
   * intent. Never re-refunds. The verdict is based on the ORIGINAL order's
   * status: a cancelled original replays as success, an inconsistent committed
   * record or a still-booked original with a pending action surfaces
   * `needsRecovery`.
   */
  async function resolveExistingCancel(existing, intentHash, orderId) {
    if (existing.intentHash !== intentHash) {
      return {
        status: 'conflict',
        conflict: true,
        orderId,
        error: 'conflicting duplicate payload',
        expected: existing.intentHash,
        existing,
      };
    }
    const outcome = existing.outcome || {};
    let order = null;
    try {
      order = await store.findAdvancedOrder(orderId);
    } catch (err) {
      order = null;
    }
    const orderCancelled = !!(
      order && order.kind === 'preorder' && order.status === 'cancelled'
    );

    if (orderCancelled) {
      if (existing.status === 'pending' || existing.status === 'needsRecovery') {
        try {
          await store.updateAdvancedOrder(existing.id, {
            status: 'committed',
            phase: 'final',
          });
        } catch (e) {
          // non-fatal: the acknowledgement write is best-effort
        }
      }
      return {
        status: 'replay',
        orderId,
        originalStatus: order.status,
        entryId: order.entryId || outcome.entryId,
        quantity: order.quantity != null ? order.quantity : outcome.quantity,
        total: order.total != null ? order.total : outcome.total,
        deposit: order.deposit != null ? order.deposit : outcome.deposit,
        remaining: order.remaining != null ? order.remaining : outcome.remaining,
      };
    }

    if (existing.status === 'committed') {
      return {
        status: 'needsRecovery',
        orderId,
        error: 'cancelled-order-inconsistent',
      };
    }
    if (existing.status === 'pending' || existing.status === 'needsRecovery') {
      return {
        status: 'needsRecovery',
        orderId,
        error: existing.error || 'order-pending',
      };
    }
    return { status: 'needsRecovery', orderId, error: 'order-not-booked' };
  }

  /**
   * Cancel a booked pre-order: refund the deposit and decrement finite merchant
   * funds. `gmUserId` is the executing GM user id (never a payload field) and is
   * the action order's `userId`.
   */
  function cancel(payload = {}, gmUserId) {
    let orderId;
    let requestId;
    try {
      orderId = assertMarketId(payload.orderId, 'orderId');
      requestId = payload.requestId
        ? assertMarketId(payload.requestId, 'requestId')
        : makeId();
    } catch (err) {
      return Promise.resolve({ status: 'error', error: err.message });
    }
    const gmUser = String(gmUserId ?? '').trim();
    if (gmUser === '') {
      return Promise.resolve({ status: 'error', error: 'gm-required' });
    }
    const key = `preorder-cancel:${orderId}:${requestId}`;
    const intentHash = computeCancelIntentHash({ orderId });

    if (!isActiveGM()) {
      return Promise.resolve({ status: 'error', error: 'not-active-gm' });
    }

    return Promise.resolve().then(async () => {
      let preOrder;
      try {
        preOrder = await store.findAdvancedOrder(orderId);
      } catch (err) {
        return {
          status: 'error',
          error: `order-read-failed: ${(err && err.message) || err}`,
        };
      }
      if (!preOrder) return { status: 'error', error: 'order-not-found' };
      const shopId = preOrder.shopId;
      return runShopExclusive(shopId, () =>
        cancelLocked({ orderId, requestId, gmUser, key, intentHash })
      );
    });
  }

  async function cancelLocked(ctx) {
    const { orderId, requestId, gmUser, key, intentHash } = ctx;

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 1. Idempotency re-read of the cancel action BEFORE any state change.
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
      return resolveExistingCancel(existing, intentHash, orderId);
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 2. Look up the original order.
    let order;
    try {
      order = await store.findAdvancedOrder(orderId);
    } catch (err) {
      return {
        status: 'error',
        error: `order-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (!order) return { status: 'error', error: 'order-not-found' };
    if (order.kind !== 'preorder') {
      return { status: 'error', error: 'order-not-preorder' };
    }
    if (order.status === 'cancelled') {
      return {
        status: 'replay',
        orderId,
        originalStatus: order.status,
        entryId: order.entryId,
        quantity: order.quantity,
        total: order.total,
        deposit: order.deposit,
        remaining: order.remaining,
      };
    }
    if (order.status === 'fulfilled') {
      return { status: 'error', error: 'order-not-booked' };
    }
    if (order.status !== 'booked') {
      return { status: 'error', error: 'order-not-booked' };
    }
    const shopId = order.shopId;

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 2b. Before creating a NEW cancel action key, page through EVERY
    //     `preorder-cancel` AND `preorder-fulfill` action for this original order.
    //     If any is pending or needsRecovery, a cancellation (or a competing
    //     fulfillment) is already in flight or uncertain; surface needsRecovery
    //     and NEVER run a second cancellation - even when the requestId differs.
    let staleAction;
    try {
      staleAction = await findPendingActionForOriginal(
        ['preorder-cancel', 'preorder-fulfill'],
        shopId,
        orderId
      );
    } catch (err) {
      return {
        status: 'error',
        error: `order-list-failed: ${(err && err.message) || err}`,
      };
    }
    if (staleAction) {
      return {
        status: 'needsRecovery',
        orderId,
        error: staleAction.error || 'order-pending',
      };
    }

    // 3. Require the shop and actor to still exist.
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

    let actor;
    try {
      actor = await getActor(order.actorId);
    } catch (err) {
      return {
        status: 'error',
        error: `actor-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (!actor) return { status: 'error', error: 'actor-not-found' };

    // 4. Finite merchant funds must still hold the deposit to refund it. Reject
    //    BEFORE any effect when they do not. `null` funds stay unlimited.
    const funds = shop.commerce ? shop.commerce.funds : null;
    const finiteFunds = funds != null;
    if (finiteFunds && funds < order.deposit) {
      return { status: 'error', error: 'insufficient-merchant-funds' };
    }
    const fundsBefore = funds;
    let fundsAfter = null;
    if (finiteFunds) {
      fundsAfter = funds - order.deposit;
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 5. Adapter must be supported (needed to credit the deposit).
    const adapter = getAdapter();
    if (!adapter || !adapter.supported) {
      return { status: 'error', error: 'adapter-unsupported' };
    }

    // 6. Persist the PENDING cancel action BEFORE any effect, keyed by
    //    target + requestId so a repeated cancel never refunds twice.
    let balance;
    try {
      balance = await adapter.getBalance(actor);
    } catch (err) {
      return {
        status: 'error',
        error: `balance-read-failed: ${(err && err.message) || err}`,
      };
    }
    const cancelRecord = {
      key,
      kind: 'preorder-cancel',
      status: 'pending',
      phase: 'recorded',
      shopId: order.shopId,
      userId: gmUser,
      actorId: order.actorId,
      entryId: order.entryId,
      relatedOrderId: orderId,
      quantity: order.quantity,
      total: order.total,
      deposit: order.deposit,
      remaining: order.remaining,
      intentHash,
      details: {
        entryId: order.entryId,
        quantity: order.quantity,
        total: order.total,
        deposit: order.deposit,
        remaining: order.remaining,
        fundsBefore,
      },
      outcome: {},
    };
    let createdResult;
    try {
      createdResult = await store.createAdvancedOrder(cancelRecord);
    } catch (err) {
      return {
        status: 'error',
        error: `order-create-failed: ${(err && err.message) || err}`,
      };
    }
    const record = createdResult.record;
    if (!createdResult.created) {
      return resolveExistingCancel(record, intentHash, orderId);
    }
    const cancelId = record.id;

    // 7. Effects: credit deposit -> credited -> merchant funds patch -> stocked
    //    -> mark original cancelled -> mark action committed. Any failure AFTER
    //    pending goes through best-effort compensation below.
    let credited = false;
    let shopWriteAttempted = false;
    let uncertain = false;
    let originalMarked = false;
    try {
      activeGmOrThrow();

      // Credit the deposit ONCE. A throwing credit may STILL have applied, so it
      // is ALWAYS rolled back (never trusted).
      try {
        await adapter.credit(actor, order.deposit);
        credited = true;
      } catch (err) {
        const verdict = await creditVerdict({
          adapter,
          actor,
          amount: order.deposit,
          before: balance,
        });
        credited = verdict.credited;
        if (verdict.uncertain) uncertain = true;
        throw err;
      }

      activeGmOrThrow();
      if (!(await setPhase(cancelId, 'credited'))) uncertain = true;

      // Finite merchant funds lose the deposit in a SINGLE shop patch. No stock
      // was reserved, so there is never a stock restore on cancel. Whether the
      // write throws or returns null, compensation re-reads the shop and restores
      // a known-applied write or marks needsRecovery for mixed/uncertain - never
      // a terminal `failed` while residual funds remain.
      if (finiteFunds) {
        shopWriteAttempted = true;
        const commerce = { ...shop.commerce, funds: fundsAfter };
        const shopWritten = await store.updateShop(shopId, { commerce });
        if (shopWritten == null) throw new Error('shop-write-missing');
      }

      activeGmOrThrow();
      if (!(await setPhase(cancelId, 'stocked'))) uncertain = true;

      // Mark the original cancelled. If the write throws or returns null, the
      // refund may still be done; re-read the original to decide. When it is
      // actually cancelled despite the exception, never undo - escalate.
      try {
        const updatedOriginal = await store.updateAdvancedOrder(orderId, {
          status: 'cancelled',
          phase: 'final',
        });
        if (updatedOriginal == null) {
          uncertain = true;
          throw new Error('order-commit-missing');
        }
        originalMarked = true;
      } catch (originalErr) {
        let currentOriginal = null;
        try {
          currentOriginal = await store.findAdvancedOrder(orderId);
        } catch (e) {
          currentOriginal = null;
        }
        if (
          currentOriginal &&
          currentOriginal.kind === 'preorder' &&
          currentOriginal.status === 'cancelled'
        ) {
          originalMarked = true;
          uncertain = true;
        } else if (!currentOriginal) {
          // The re-read itself threw or the original is missing: the `cancelled`
          // write may STILL have landed, so NEVER undo the applied effects (the
          // deposit credit / merchant-funds decrement) - escalate the action
          // instead. Mark the original as if it were terminal so compensation is
          // skipped and the action becomes needsRecovery; the unresolved-action
          // guard blocks any future related action for this original.
          originalMarked = true;
          uncertain = true;
        }
        throw originalErr;
      }

      activeGmOrThrow();
      const outcome = {
        orderId,
        entryId: order.entryId,
        quantity: order.quantity,
        total: order.total,
        deposit: order.deposit,
        remaining: order.remaining,
      };
      const committedRecord = await store.updateAdvancedOrder(cancelId, {
        status: 'committed',
        phase: 'final',
        outcome,
      });
      if (committedRecord == null) {
        uncertain = true;
        throw new Error('cancel-commit-missing');
      }
      return {
        status: 'cancelled',
        orderId,
        entryId: outcome.entryId,
        quantity: outcome.quantity,
        total: outcome.total,
        deposit: outcome.deposit,
        remaining: outcome.remaining,
      };
    } catch (err) {
      if (err && (err.message === 'order-commit-missing' || err.message === 'cancel-commit-missing')) {
        uncertain = true;
      }
      return compensateCancel({
        err,
        orderId,
        cancelId,
        shopId,
        actor,
        deposit: order.deposit,
        credited,
        shopWriteAttempted,
        finiteFunds,
        fundsBefore,
        fundsAfter,
        uncertain,
        originalMarked,
        adapter,
        details: cancelRecord.details,
      });
    }
  }

  /**
   * Best-effort recovery after a pending cancel action was persisted and an
   * effect (or the final commit) failed. When the original was NOT yet marked
   * cancelled, we undo exactly what may have been applied: debit the actor back
   * the deposit only if the credit applied, and restore merchant funds only when
   * the single shop patch actually applied - leaving the original `booked` when
   * safely undone. When the original WAS successfully marked cancelled (only the
   * action commit failed), the refund is already done and the original cancelled,
   * so no compensation runs and the action is escalated. A fully successful undo
   * records `failed`, an uncertain one records `needsRecovery`.
   */
  async function compensateCancel(ctx) {
    const {
      err,
      orderId,
      cancelId,
      shopId,
      actor,
      deposit,
      credited,
      shopWriteAttempted,
      finiteFunds,
      fundsBefore,
      fundsAfter,
      uncertain = false,
      originalMarked,
      adapter,
      details,
    } = ctx;

    if (originalMarked) {
      let responseStatus = 'needsRecovery';
      try {
        await store.updateAdvancedOrder(cancelId, {
          status: 'needsRecovery',
          phase: 'final',
          error: String((err && err.message) || err),
        });
      } catch (e) {
        // The action record could not even be marked; it stays `pending`.
      }
      return {
        status: responseStatus,
        orderId,
        error: String((err && err.message) || err),
        compensation: uncertain ? ['action-mark-uncertain'] : [],
      };
    }

    const compensation = [];
    let uncertainOutcome = uncertain;

    if (credited) {
      // Verify the debit-back resolved on the actor wallet with the expected
      // before/after balance; an unresolved reversal is a manual-reconcile case.
      const resolved = await resolveWalletDebit(adapter, actor, deposit);
      if (resolved.ok) {
        compensation.push('deposit-debited-back');
      } else {
        compensation.push('deposit-debit-back-verify-failed');
        uncertainOutcome = true;
      }
    }

    if (finiteFunds && shopWriteAttempted) {
      try {
        const current = await store.findShop(shopId);
        if (!current) {
          compensation.push('shop-missing');
          uncertainOutcome = true;
        } else {
          const currentFunds =
            current.commerce && current.commerce.funds != null
              ? current.commerce.funds
              : null;
          if (currentFunds === fundsBefore) {
            compensation.push('shop-unwritten');
          } else if (currentFunds === fundsAfter) {
            const commerce = { ...current.commerce, funds: fundsBefore };
            const returned = await store.updateShop(shopId, { commerce });
            const verified = !!(
              returned &&
              returned.commerce &&
              returned.commerce.funds === fundsBefore
            );
            if (verified) {
              compensation.push('shop-restored');
            } else {
              compensation.push('shop-restore-verify-failed');
              uncertainOutcome = true;
            }
          } else {
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
      const updated = await store.updateAdvancedOrder(cancelId, {
        status,
        phase: 'final',
        error: String((err && err.message) || err),
        details: {
          ...details,
          error: String((err && err.message) || err),
          compensation,
          updatedAt: now ? now() : Date.now(),
        },
      });
      if (updated == null) {
        responseStatus = 'needsRecovery';
        compensation.push('order-write-missing');
      }
    } catch (e) {
      logger?.error?.(
        `[market] failed to persist preorder cancel compensation for order ${cancelId}`,
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

  return { place, fulfill, cancel };
}

export default createPreorderCommerce;
