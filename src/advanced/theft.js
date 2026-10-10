// M5 GM-authoritative theft adjudication.
//
// A theft is a player's claim to have stolen an inventory entry. Nothing is
// decided at claim time: the player calls `attempt`, which merely reserves a
// GM-private advanced-order record of kind `theft` as `booked` (phase `final`)
// with an `outcome` of `{ orderId, entryId, status: 'awaiting-gm' }`. No item is
// delivered, no stock is decremented, and no currency moves. The record stays
// GM-only until the active GM calls `resolve` with a typed `success` boolean.
//
// `resolve` is GM-only and SELF-DECIDED - it never trusts a client result or
// roll. `success` must be an actual `boolean` (never inferred from a player
// channel or a string), and a missing/non-boolean value fails closed
// (`success-required`). On `success: false` the theft is refused: the original
// order is marked `failed` with `outcome: { success: false }`. On
// `success: true` the GM grants the item: under the per-shop lock the entry's
// stock, item source and actor are re-validated NOW, a pending action is
// persisted BEFORE any effect, the item is delivered once via
// `adapter.deliverItem`, finite / non-restocking stock is decremented by one in
// a single `store.updateShop` patch (an `unlimited` entry is unchanged), and the
// original is marked `committed` with `outcome: { success: true, entryId }` then
// the action `committed`. A failure anywhere after the pending write compensates
// best-effort: the delivered item is removed, finite stock is restored when the
// single shop patch actually applied, and the action escalates to `needsRecovery`
// when a compensating step is itself uncertain.
//
// Like the other M5 advanced services this is a COMPENSATING, idempotent
// advanced-order transaction on top of the GM-private `advancedOrder` records. It
// does NOT claim distributed/transactional atomicity - it records phases, applies
// effects one at a time, and best-effort undoes what it can, escalating to
// `needsRecovery` when a compensating step is itself uncertain.
//
// This module is a Node-importable companion to `src/advanced/cart.js`,
// `src/advanced/services.js` and `src/advanced/preorders.js` and follows the same
// discipline: it is GM-gated (`isActiveGM` before any store read, re-checked
// inside the lock and at every await boundary that can observe a handover), never
// trusts a client-supplied outcome, runs under the SAME per-shop lock a purchase
// uses (`runShopExclusive`), persists an `advancedOrder` BEFORE any effect so a
// replayed request resolves idempotently, and never claims transactional
// atomicity. There is NO theft payout and NO free goods before the GM decision,
// and there is NO system-skill API call or automatic reputation penalty - the
// module only ever grants or refuses a single inventory item.
//
// No Foundry globals are referenced at import time; only the injected deps and
// the pure helpers are used.

import {
  assertMarketId,
  makeId,
  parseItemData,
} from '../services/model.js';
import { fnv1a } from '../services/commerce.js';
import { isShopTrading } from '../automation/policy.js';

export const THEFT_QUANTITY = 1;

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
 * Deterministic intent fingerprint for a theft claim (`attempt`). Only the fields
 * that make a claim unique (shop, entry, actor, requester) are included so two
 * requests with the same intent produce the same hash and can be safely
 * replayed. `requester` is the authenticated executing user id (never a payload
 * field).
 */
export function computeTheftIntentHash({ shopId, entryId, actorId, requester }) {
  const canonical = JSON.stringify({
    shopId: String(shopId),
    entryId: String(entryId),
    actorId: String(actorId),
    requester: String(requester),
  });
  return fnv1a(canonical);
}

/**
 * Deterministic intent fingerprint for a GM theft resolution (`resolve`). The
 * action is fully determined by the original order id AND the decided success, so
 * `success` is included (a changed decision must conflict rather than replay). The
 * executing GM is deliberately excluded so a different GM repeating the same
 * request replays rather than conflicts.
 */
export function computeTheftResolveIntentHash({ orderId, success }) {
  const canonical = JSON.stringify({
    orderId: String(orderId),
    success: success === true ? true : false,
  });
  return fnv1a(canonical);
}

/**
 * Resolve an already-persisted theft claim (`attempt`) for the current intent.
 * Never applies a side effect:
 *   - same key + same intentHash on a `booked`/`committed`/`failed` order =>
 *     replay its recorded outcome (a committed/failed theft is still a completed
 *     claim; never re-resolves).
 *   - same key + same intentHash on a `needsRecovery` order => `needsRecovery`
 *     (manual recovery; no effect applied).
 *   - same key + different intentHash => `conflict` (the request changed).
 */
function resolveExistingTheft(existing, intentHash) {
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
  if (existing.status === 'needsRecovery') {
    return {
      status: 'needsRecovery',
      orderId: existing.id,
      error: existing.error || 'order-pending',
    };
  }
  if (existing.status === 'committed') {
    return {
      status: 'replay',
      orderId: existing.id,
      originalStatus: existing.status,
      entryId: outcome.entryId ?? existing.entryId,
      success: outcome.success === true ? true : true,
    };
  }
  if (existing.status === 'failed') {
    return {
      status: 'replay',
      orderId: existing.id,
      originalStatus: existing.status,
      entryId: outcome.entryId ?? existing.entryId,
      success: outcome.success === false ? false : false,
    };
  }
  // booked (awaiting GM) -> replay with no decision yet.
  return {
    status: 'replay',
    orderId: existing.id,
    originalStatus: existing.status,
    entryId: outcome.entryId ?? existing.entryId,
  };
}

export function createTheftCommerce(deps) {
  const {
    store,
    runShopExclusive,
    isActiveGM = () => true,
    getActor,
    actorOwnedBy,
    getAdapter,
    fromUuid,
    getWorldTime,
    now,
    logger,
  } = deps;

  /**
   * Sentinel thrown when a GM handover is detected mid-flight (after the pending
   * action but before all effects are applied). The former GM must stop applying
   * further effects; compensation undoes whatever was applied and the action is
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
   * caller can flag the record as uncertain; a thrown write is logged and also
   * reported as `false` rather than aborting the sequence.
   */
  async function setPhase(recordId, phase) {
    try {
      const updated = await store.updateAdvancedOrder(recordId, { phase });
      if (updated == null) {
        logger?.warn?.(
          `[market] advanced order ${recordId} was missing during '${phase}' phase write`
        );
        return false;
      }
      return true;
    } catch (err) {
      logger?.error?.(
        `[market] failed to persist theft phase '${phase}' for order ${recordId}`,
        err
      );
      return false;
    }
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
   * Returns null when both are missing, which forbids the claim/resolve.
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
   * Scan every advanced order for the shop (paged 100 at a time) and return the
   * first theft ACTION record (kind `theft`, not the original claim) whose
   * `relatedOrderId` matches `orderId`, whose `key` is not the current resolve
   * key, and which is still `pending` or `needsRecovery`. Such an in-flight action
   * means a previous decision for the SAME original (with a different requestId)
   * is still uncertain, so creating a new resolve action now would double-deliver
   * or double-mark: the caller blocks with `needsRecovery`. Returns null when none
   * is found. Throws on a read failure so the caller surfaces a clean error (no
   * action was created, so a retry is safe).
   */
  async function findUnresolvedTheftAction({ orderId, shopId, key }) {
    const pageSize = 100;
    let offset = 0;
    let firstIdOfPage = null;
    for (;;) {
      const records = await store.listAdvancedOrders({
        shopId,
        kind: 'theft',
        limit: pageSize,
        offset,
      });
      const list = Array.isArray(records) ? records : [];
      for (const r of list) {
        if (
          r &&
          r.kind === 'theft' &&
          r.relatedOrderId === orderId &&
          r.key !== key &&
          (r.status === 'pending' || r.status === 'needsRecovery')
        ) {
          return r;
        }
      }
      if (list.length < pageSize) break;
      const currentFirstId = list.length ? list[0].id : null;
      if (currentFirstId != null && currentFirstId === firstIdOfPage) break;
      firstIdOfPage = currentFirstId;
      offset += pageSize;
    }
    return null;
  }

  // ------------------------------------------------------------------ attempt

  /**
   * Record a theft claim for a player-owned actor. `authenticatedRequesterId` is
   * the authenticated user executing the transaction (the active GM) and is used
   * as the actor-ownership principal and the idempotency-key prefix. Never a
   * payload field. The claim only validates and records; it never mints or moves
   * anything.
   */
  function attempt(payload = {}, authenticatedRequesterId) {
    let shopId;
    let entryId;
    let actorId;
    let requestId;
    try {
      shopId = assertMarketId(payload.shopId, 'shopId');
      entryId = assertMarketId(payload.entryId, 'entryId');
      actorId = assertMarketId(payload.actorId, 'actorId');
      requestId = payload.requestId
        ? assertMarketId(payload.requestId, 'requestId')
        : makeId();
    } catch (err) {
      return Promise.resolve({ status: 'error', error: err.message });
    }
    const requester = String(authenticatedRequesterId ?? '').trim();
    if (requester === '') {
      return Promise.resolve({
        status: 'error',
        error: 'authenticatedUserId must be a non-empty string',
      });
    }
    const key = `theft:${requester}:${requestId}`;
    const intentHash = computeTheftIntentHash({
      shopId,
      entryId,
      actorId,
      requester,
    });

    // GM gate BEFORE any store read. A player watching the app never triggers a
    // read or a write.
    if (!isActiveGM()) {
      return Promise.resolve({ status: 'error', error: 'not-active-gm' });
    }

    return runShopExclusive(shopId, () =>
      attemptLocked({ shopId, entryId, actorId, requester, key, intentHash })
    );
  }

  async function attemptLocked(ctx) {
    const { shopId, entryId, actorId, requester, key, intentHash } = ctx;

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
      return resolveExistingTheft(existing, intentHash);
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 2. Re-read the shop inside the lock (never trust the request) and require
    //    the theft feature to be enabled.
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
    const theft = shop.commerce && shop.commerce.theft;
    if (!theft || theft.enabled !== true) {
      return { status: 'error', error: 'theft-disabled' };
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

    // 5. Resolve the entry from the STORED shop. A theft requires a PUBLIC,
    //    visible entry: a `backroom` entry is never eligible even if the actor
    //    could otherwise access it, and a hidden entry is refused.
    const entry = shop.inventory.find((e) => e.id === entryId);
    if (!entry) return { status: 'error', error: 'entry-not-found' };
    if (entry.visible === false) return { status: 'error', error: 'entry-hidden' };
    const access = entry.access;
    if (access && access.mode === 'backroom') {
      return { status: 'error', error: 'entry-backroom' };
    }

    // 6. Stock must be finite positive or unlimited. Theft takes exactly one.
    if (entry.stockMode !== 'unlimited' && entry.quantity < THEFT_QUANTITY) {
      return { status: 'error', error: 'out-of-stock' };
    }

    // 7. The item source must resolve NOW so the GM decision knows what to
    //    deliver.
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

    // 8. Persist the order DIRECTLY as `booked`/`final` with a supplied id, so
    //    `outcome.orderId` equals the stored id - there is no pending->booked
    //    transition to recover from because attempt has NO effects to compensate.
    const orderId = makeId();
    const details = {
      entryId,
      name: entry.name,
      itemUuid: entry.itemUuid || '',
      snapshot: entry.snapshot || '',
    };
    const orderRecord = {
      id: orderId,
      key,
      kind: 'theft',
      status: 'booked',
      phase: 'final',
      shopId,
      userId: requester,
      actorId,
      entryId,
      relatedOrderId: '',
      quantity: THEFT_QUANTITY,
      total: 0,
      deposit: 0,
      remaining: 0,
      intentHash,
      details,
      outcome: { orderId, entryId, status: 'awaiting-gm' },
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
      // A create-race handed back an existing claim for the same key; resolve
      // idempotently and NEVER apply an effect.
      return resolveExistingTheft(order, intentHash);
    }

    return {
      status: 'booked',
      orderId: order.id,
      entryId,
    };
  }

  // ------------------------------------------------------------------ resolve

  /**
   * Resolve an already-persisted `theft-resolve` action record for the current
   * intent. Never re-delivers and never re-marks. The verdict is based on the
   * ORIGINAL order's status: a committed/failed original replays as the recorded
   * outcome, an inconsistent committed action or a still-booked original with a
   * pending action surfaces `needsRecovery`.
   */
  async function resolveExistingResolve(existing, intentHash, orderId) {
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
    const orderCommitted = !!(order && order.kind === 'theft' && order.status === 'committed');
    const orderFailed = !!(order && order.kind === 'theft' && order.status === 'failed');

    if (orderCommitted || orderFailed) {
      // The resolution already happened; if a still-pending tracking action
      // exists, finalize it best-effort, never re-running.
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
      const orderOutcome = (order && order.outcome) || {};
      const success = orderCommitted
        ? (orderOutcome.success === true ? true : true)
        : (orderOutcome.success === false ? false : false);
      return {
        status: 'replay',
        orderId,
        originalStatus: orderCommitted ? 'committed' : 'failed',
        entryId: orderOutcome.entryId ?? outcome.entryId ?? order?.entryId,
        success,
      };
    }

    if (existing.status === 'committed') {
      // The action claims committed but the original is still booked: an
      // inconsistent record needing manual reconciliation.
      return {
        status: 'needsRecovery',
        orderId,
        error: 'resolved-order-inconsistent',
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
   * Replay a resolve whose ORIGINAL order is already resolved. Returns a clean
   * replay result for the recorded outcome.
   */
  function resolvedReplay(order) {
    const outcome = order.outcome || {};
    const success = order.status === 'committed';
    return {
      status: 'replay',
      orderId: order.id,
      originalStatus: order.status,
      entryId: outcome.entryId ?? order.entryId ?? '',
      success,
    };
  }

  /**
   * Adjudicate a theft claim. `gmUserId` is the executing GM user id (never a
   * payload field) and is the action order's `userId`. `success` MUST be a typed
   * boolean - never inferred from a player channel, message, or result string.
   */
  function resolve(payload = {}, gmUserId) {
    let orderId;
    let requestId;
    let success;
    try {
      orderId = assertMarketId(payload.orderId, 'orderId');
      requestId = payload.requestId
        ? assertMarketId(payload.requestId, 'requestId')
        : makeId();
      success = payload.success;
    } catch (err) {
      return Promise.resolve({ status: 'error', error: err.message });
    }
    const gmUser = String(gmUserId ?? '').trim();
    if (gmUser === '') {
      return Promise.resolve({ status: 'error', error: 'gm-required' });
    }
    if (typeof success !== 'boolean') {
      return Promise.resolve({ status: 'error', error: 'success-required' });
    }
    const key = `theft-resolve:${orderId}:${requestId}`;
    const intentHash = computeTheftResolveIntentHash({ orderId, success });

    if (!isActiveGM()) {
      return Promise.resolve({ status: 'error', error: 'not-active-gm' });
    }

    // The lock is per-shop; the order's shopId is not in the payload, so read the
    // order once to find it. This read happens only after the GM gate, and the
    // authoritative re-read occurs inside the lock.
    return Promise.resolve().then(async () => {
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
      if (order.kind !== 'theft') {
        return { status: 'error', error: 'order-not-theft' };
      }
      const shopId = order.shopId;
      return runShopExclusive(shopId, () =>
        resolveLocked({ orderId, requestId, gmUser, key, intentHash, success })
      );
    });
  }

  async function resolveLocked(ctx) {
    const { orderId, requestId, gmUser, key, intentHash, success } = ctx;

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 1. Idempotency re-read of the resolve action BEFORE any state change.
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
      return resolveExistingResolve(existing, intentHash, orderId);
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 2. Look up the original order. It must be a `theft` kind. An already
    //    resolved (committed/failed) original replays as the recorded outcome.
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
    if (order.kind !== 'theft') {
      return { status: 'error', error: 'order-not-theft' };
    }
    if (order.status === 'committed' || order.status === 'failed') {
      return resolvedReplay(order);
    }
    if (order.status !== 'booked') {
      return { status: 'error', error: 'order-not-booked' };
    }
    const shopId = order.shopId;

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 2b. Before persisting a NEW resolve action, block when an earlier decision
    //     for this SAME original (with a different requestId) is still in flight.
    //     A pending/needsRecovery theft action whose relatedOrderId matches the
    //     original means the previous attempt could not finish; creating another
    //     action would double-deliver or double-mark, so surface needsRecovery.
    let lingering;
    try {
      lingering = await findUnresolvedTheftAction({ orderId, shopId, key });
    } catch (err) {
      return {
        status: 'error',
        error: `order-read-failed: ${(err && err.message) || err}`,
      };
    }
    if (lingering) {
      return {
        status: 'needsRecovery',
        orderId,
        error: lingering.error || 'resolve-in-flight',
      };
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 3. For a GRANT (success:true) re-validate the shop, entry, stock and source
    //    NOW, plus the actor, before any effect - never trust the claim snapshot.
    //    For a REFUSAL (success:false) there is nothing to deliver, so no recheck.
    let shop = null;
    let actor = null;
    let entry = null;
    let source = null;
    if (success === true) {
      try {
        shop = await store.findShop(shopId);
      } catch (err) {
        return {
          status: 'error',
          error: `shop-read-failed: ${(err && err.message) || err}`,
        };
      }
      if (!shop) return { status: 'error', error: 'shop-not-found' };

      try {
        actor = await getActor(order.actorId);
      } catch (err) {
        return {
          status: 'error',
          error: `actor-read-failed: ${(err && err.message) || err}`,
        };
      }
      if (!actor) return { status: 'error', error: 'actor-not-found' };

      entry = shop.inventory.find((e) => e.id === order.entryId);
      if (!entry) return { status: 'error', error: 'entry-not-found' };
      if (entry.stockMode !== 'unlimited' && entry.quantity < THEFT_QUANTITY) {
        return { status: 'error', error: 'insufficient-stock' };
      }
      try {
        source = await resolveItemSource(entry);
      } catch (err) {
        return {
          status: 'error',
          error: `item-source-failed: ${(err && err.message) || err}`,
        };
      }
      if (!source) return { status: 'error', error: 'item-source-missing' };
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 4. The adapter must be supported if we need to deliver (grant only).
    const adapter = getAdapter();
    if (success === true && (!adapter || !adapter.supported)) {
      return { status: 'error', error: 'adapter-unsupported' };
    }

    // 5. Persist the PENDING resolve action BEFORE any effect, keyed by target +
    //    requestId so a repeated GM decision never delivers twice nor marks twice.
    const actionRecord = {
      key,
      kind: 'theft',
      status: 'pending',
      phase: 'recorded',
      shopId,
      userId: gmUser,
      actorId: order.actorId,
      entryId: order.entryId,
      relatedOrderId: orderId,
      quantity: THEFT_QUANTITY,
      total: 0,
      deposit: 0,
      remaining: 0,
      intentHash,
      details: {
        entryId: order.entryId,
        name: order.details && order.details.name ? order.details.name : '',
        quantity: THEFT_QUANTITY,
        itemUuid: order.details && order.details.itemUuid ? order.details.itemUuid : '',
        snapshot: order.details && order.details.snapshot ? order.details.snapshot : '',
      },
      outcome: {},
    };
    let createdResult;
    try {
      createdResult = await store.createAdvancedOrder(actionRecord);
    } catch (err) {
      return {
        status: 'error',
        error: `order-create-failed: ${(err && err.message) || err}`,
      };
    }
    const record = createdResult.record;
    if (!createdResult.created) {
      // A create-race handed back an existing action for the same key; resolve
      // idempotently and never re-deliver or re-mark.
      return resolveExistingResolve(record, intentHash, orderId);
    }
    const actionId = record.id;

    if (success === false) {
      return resolveFalse({
        orderId,
        actionId,
        err: null,
        intentHash,
        actionRecord,
      });
    }
    return resolveTrue({
      orderId,
      actionId,
      shopId,
      shop,
      actor,
      entry,
      source,
      quantity: THEFT_QUANTITY,
      adapter,
      actionRecord,
    });
  }

  /**
   * Execute the REFUSAL branch (success:false): mark the original `failed` with
   * `outcome: { success: false }` and commit the action. No delivery, no stock
   * change, no currency. Returns a clean success or escalates to `needsRecovery`
   * when a status write is itself uncertain.
   */
  async function resolveFalse({ orderId, actionId, intentHash, actionRecord }) {
    let uncertain = false;
    let originalMarked = false;
    try {
      activeGmOrThrow();

      const updatedOriginal = await store.updateAdvancedOrder(orderId, {
        status: 'failed',
        phase: 'final',
        outcome: { success: false },
      });
      if (updatedOriginal == null) {
        uncertain = true;
        throw new Error('order-commit-missing');
      }
      originalMarked = true;

      activeGmOrThrow();
      const outcome = { orderId, success: false };
      const committedRecord = await store.updateAdvancedOrder(actionId, {
        status: 'committed',
        phase: 'final',
        outcome,
      });
      if (committedRecord == null) {
        uncertain = true;
        throw new Error('resolve-commit-missing');
      }
      return {
        status: 'failed',
        orderId,
        success: false,
      };
    } catch (err) {
      if (
        err &&
        (err.message === 'order-commit-missing' || err.message === 'resolve-commit-missing')
      ) {
        uncertain = true;
      }
      // The original status write may have thrown AFTER persisting `failed`. Re-read
      // the original to learn the truth: if it is failed, the refusal is recorded, so
      // retain needsRecovery (the action escalates) instead of clearing the refusal.
      // When the re-read itself throws or the original is missing, the `failed` write
      // may STILL have landed, so do NOT undo anything - escalate to needsRecovery.
      if (!originalMarked) {
        let reread = null;
        try {
          reread = await store.findAdvancedOrder(orderId);
        } catch (e) {
          reread = null;
        }
        if (reread && reread.kind === 'theft' && reread.status === 'failed') {
          originalMarked = true;
        } else if (!reread) {
          // Re-read-unavailable: treat the original as terminal so compensation is
          // skipped and the action escalates; the unresolved-action guard blocks
          // any future related resolve for this original.
          originalMarked = true;
        }
      }
      return compensateResolveFalse({
        err,
        orderId,
        actionId,
        uncertain,
        originalMarked,
        actionRecord,
      });
    }
  }

  /**
   * Best-effort recovery for a failed REFUSAL branch. When the ORIGINAL was not
   * yet marked `failed`, the refusal is safe to record as `failed`. When the
   * original WAS marked `failed` (only the action commit failed), the refusal is
   * already recorded and the action escalates to `needsRecovery`.
   */
  async function compensateResolveFalse({
    err,
    orderId,
    actionId,
    uncertain = false,
    originalMarked,
    actionRecord,
  }) {
    if (originalMarked) {
      let responseStatus = 'needsRecovery';
      try {
        await store.updateAdvancedOrder(actionId, {
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
        success: false,
        error: String((err && err.message) || err),
        compensation: uncertain ? ['action-mark-uncertain'] : [],
      };
    }

    const compensation = [];
    let uncertainOutcome = uncertain;
    const status = uncertainOutcome ? 'needsRecovery' : 'failed';
    let responseStatus = status;
    try {
      const updated = await store.updateAdvancedOrder(actionId, {
        status,
        phase: 'final',
        error: String((err && err.message) || err),
        details: {
          ...actionRecord.details,
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
        `[market] failed to persist theft resolve (false) compensation for order ${actionId}`,
        e
      );
    }
    return {
      status: responseStatus,
      orderId,
      success: false,
      error: String((err && err.message) || err),
      compensation,
    };
  }

  /**
   * Execute the GRANT branch (success:true): deliver one item, decrement finite /
   * non-restocking stock by one (unlimited unchanged) in a single shop patch, mark
   * the original `committed` with `outcome: { success: true, entryId }`, and
   * commit the action. Any failure after the pending write compensates best-
   * effort: remove the delivered item and restore stock only when the single shop
   * patch actually applied.
   */
  async function resolveTrue({
    orderId,
    actionId,
    shopId,
    shop,
    actor,
    entry,
    source,
    quantity,
    adapter,
    actionRecord,
  }) {
    let delivered = [];
    let shopWriteAttempted = false;
    let shopWriteApplied = false;
    let uncertain = false;
    let originalMarked = false;
    try {
      activeGmOrThrow();

      // Deliver one item and record the created id so compensation can remove it.
      // A call that THROWS may still have delivered an item with an unknown id, so
      // the line is recorded with a null createdId (uncertain) and the resolve is
      // marked uncertain - never a clean refund/remove.
      let created;
      try {
        created = await adapter.deliverItem(actor, source, {
          quantity,
        });
      } catch (err) {
        delivered.push({
          entryId: entry ? entry.id : orderId,
          createdId: null,
        });
        uncertain = true;
        throw err;
      }
      delivered.push({
        entryId: entry ? entry.id : orderId,
        createdId: created && (created.id ?? null),
      });

      activeGmOrThrow();
      if (!(await setPhase(actionId, 'transferred'))) uncertain = true;

      // ONE shop write inside the lock: decrement finite / non-restocking stock
      // by one. An unlimited entry never changes stock, so no write is needed.
      if (entry && entry.stockMode !== 'unlimited') {
        const newInventory = shop.inventory.map((e) =>
          e.id === entry.id ? { ...e, quantity: e.quantity - quantity } : e
        );
        shopWriteAttempted = true;
        const shopReturned = await store.updateShop(shopId, {
          inventory: newInventory,
        });
        shopWriteApplied = !!shopReturned;
        if (shopReturned == null) throw new Error('shop-write-missing');
      }

      activeGmOrThrow();
      if (!(await setPhase(actionId, 'stocked'))) uncertain = true;

      // Mark the original committed. A `null`/throw means the effects may still be
      // applied but the original is still `booked` (or missing), so the resolve
      // must be treated as uncertain and compensated.
      const updatedOriginal = await store.updateAdvancedOrder(orderId, {
        status: 'committed',
        phase: 'final',
        outcome: { success: true, entryId: entry ? entry.id : '' },
      });
      if (updatedOriginal == null) {
        uncertain = true;
        throw new Error('order-commit-missing');
      }
      originalMarked = true;

      activeGmOrThrow();
      const outcome = {
        orderId,
        success: true,
        entryId: entry ? entry.id : '',
      };
      const committedRecord = await store.updateAdvancedOrder(actionId, {
        status: 'committed',
        phase: 'final',
        outcome,
      });
      if (committedRecord == null) {
        uncertain = true;
        throw new Error('resolve-commit-missing');
      }
      return {
        status: 'committed',
        orderId,
        success: true,
        entryId: outcome.entryId,
      };
    } catch (err) {
      if (
        err &&
        (err.message === 'order-commit-missing' || err.message === 'resolve-commit-missing')
      ) {
        uncertain = true;
      }
      // The original status write may have thrown AFTER persisting `committed`.
      // Re-read the original to learn the truth: if it committed, the item is
      // already granted and the original is committed, so retain needsRecovery
      // instead of undoing the delivered item and stock. When the re-read itself
      // throws or the original is missing, the `committed` write may STILL have
      // landed, so do NOT undo anything - escalate to needsRecovery.
      if (!originalMarked) {
        let reread = null;
        try {
          reread = await store.findAdvancedOrder(orderId);
        } catch (e) {
          reread = null;
        }
        if (reread && reread.kind === 'theft' && reread.status === 'committed') {
          originalMarked = true;
        } else if (!reread) {
          // Re-read-unavailable: treat the original as terminal so compensation is
          // skipped and the action escalates; the unresolved-action guard blocks
          // any future related resolve for this original.
          originalMarked = true;
        }
      }
      return compensateResolveTrue({
        err,
        orderId,
        actionId,
        shopId,
        actor,
        entryId: entry ? entry.id : '',
        entry,
        quantity,
        delivered,
        shopWriteAttempted,
        shopWriteApplied,
        uncertain,
        originalMarked,
        adapter,
        actionRecord,
      });
    }
  }

  /**
   * Best-effort recovery for a failed GRANT branch. When the original was NOT yet
   * marked `committed`, we undo exactly what may have been applied: remove the
   * delivered item and restore finite stock only when the single shop patch
   * actually applied - leaving the original `booked` when safely undone. When the
   * ORIGINAL WAS successfully marked committed (only the action commit failed), the
   * item is already granted and the original committed, so no compensation runs
   * and the action is escalated. A fully successful undo records `failed`, an
   * uncertain one records `needsRecovery`.
   */
  async function compensateResolveTrue(ctx) {
    const {
      err,
      orderId,
      actionId,
      shopId,
      actor,
      entryId,
      entry,
      quantity,
      delivered,
      shopWriteAttempted,
      shopWriteApplied,
      uncertain = false,
      originalMarked,
      adapter,
      actionRecord,
    } = ctx;

    // The original was already marked committed: the item is granted, only the
    // action record is not committed. Do NOT undo effects; escalate the action
    // and leave the original committed.
    if (originalMarked) {
      let responseStatus = 'needsRecovery';
      try {
        await store.updateAdvancedOrder(actionId, {
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
        success: true,
        error: String((err && err.message) || err),
        compensation: uncertain ? ['action-mark-uncertain'] : [],
      };
    }

    const compensation = [];
    let uncertainOutcome = uncertain;

    // Delivered lines are removed in reverse. A line whose delivery threw carries a
    // null createdId - the item may or may not have been delivered with an unknown
    // id - so it is inherently uncertain, never a clean removal.
    for (let i = delivered.length - 1; i >= 0; i--) {
      const { createdId } = delivered[i];
      if (createdId == null) {
        compensation.push('item-unknown');
        uncertainOutcome = true;
      } else {
        try {
          await adapter.removeItem(actor, createdId);
          compensation.push('item-removed');
        } catch (e) {
          compensation.push('item-remove-failed');
          uncertainOutcome = true;
        }
      }
    }

    // Shop stock restoration, whenever the single shop write was ATTEMPTED. The
    // write may have thrown AFTER applying (or returned null), so decide whether it
    // actually landed by re-reading the current shop and comparing to this grant's
    // own recorded before/after - never a guess and never relying on the throw.
    if (shopWriteAttempted) {
      try {
        const current = await store.findShop(shopId);
        if (!current) {
          compensation.push('shop-missing');
          uncertainOutcome = true;
        } else {
          const isUnlimited = !!entry && entry.stockMode === 'unlimited';
          if (isUnlimited) {
            // No stock was changed for an unlimited entry; nothing to restore.
            compensation.push('shop-unwritten');
          } else {
            const curr = current.inventory.find((e) => e.id === entryId);
            if (!curr) {
              compensation.push('shop-state-mixed');
              uncertainOutcome = true;
            } else if (curr.quantity === entry.quantity - quantity) {
              // Known applied: restore this grant's exact entry quantity.
              const restoredInventory = current.inventory.map((e) =>
                e.id === entryId ? { ...e, quantity: entry.quantity } : e
              );
              const returned = await store.updateShop(shopId, {
                inventory: restoredInventory,
              });
              const verified = !!(
                returned &&
                (() => {
                  const r = returned.inventory.find((x) => x.id === entryId);
                  return r && r.quantity === entry.quantity;
                })()
              );
              if (verified) {
                compensation.push('shop-restored');
              } else {
                compensation.push('shop-restore-verify-failed');
                uncertainOutcome = true;
              }
            } else if (curr.quantity === entry.quantity) {
              compensation.push('shop-unwritten');
            } else {
              compensation.push('shop-state-mixed');
              uncertainOutcome = true;
            }
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
      const updated = await store.updateAdvancedOrder(actionId, {
        status,
        phase: 'final',
        error: String((err && err.message) || err),
        details: {
          ...actionRecord.details,
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
        `[market] failed to persist theft resolve (true) compensation for order ${actionId}`,
        e
      );
    }
    return {
      status: responseStatus,
      orderId,
      success: true,
      error: String((err && err.message) || err),
      compensation,
    };
  }

  return { attempt, resolve };
}

export default createTheftCommerce;
