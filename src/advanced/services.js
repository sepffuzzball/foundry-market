// M5 GM-authoritative service booking and manual fulfillment.
//
// A bookable `shop.commerce.services[]` entry has NO automatic mechanical
// effect: booking debits the player once, grants the finite merchant funds the
// price, and records a `booked` advanced order. The service is only "completed"
// when the GM later calls `fulfill`, which records the acknowledgement (the GM
// manually confirms delivery outside the module) and moves the order from
// `booked` to `fulfilled`. No item is delivered or created by either path.
//
// This module is a Node-importable companion to `src/advanced/selling.js` and
// follows the same discipline: it is GM-gated (`isActiveGM` before any store
// read), never trusts a client-supplied price (the price is re-read from the
// stored service), runs under the SAME per-shop lock a purchase uses
// (`runShopExclusive`), persists an `advancedOrder` BEFORE any effect so a
// replayed request can be resolved idempotently, and never claims transactional
// atomicity - it is a compensating, idempotent order mirroring the M1 purchase
// ledger in shape. The M1 purchase/ledger path, the request handler and the UI
// are untouched in this slice: this module only reads `findShop`/
// `findAdvancedOrderByKey`/`findAdvancedOrder` and writes `updateShop`/
// `createAdvancedOrder`/`updateAdvancedOrder` (plus the injected actor/adapter).
//
// Money is always expressed in non-negative integer minor units. The player is
// debited `service.price` exactly once; finite merchant funds GAIN the price
// (a safe-overflow check refuses the booking before any effect rather than
// wrapping), and `null` funds stay unlimited (no funds patch is written).
//
// No Foundry globals are referenced at import time; only the injected deps and
// the pure helpers are used.

import { assertMarketId, makeId } from '../services/model.js';
import { assertMinorUnits } from '../services/pricing.js';
import { fnv1a } from '../services/commerce.js';
import { isShopTrading } from '../automation/policy.js';

/**
 * Coerce `value` to a safe integer world-time second, or return null when the
 * clock value is invalid (NaN/undefined/Infinity/non-safe). An invalid server
 * time must fail the booking closed (`invalid-world-time`) before any effect
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
 * Deterministic intent fingerprint for a service booking. Only the fields that
 * make a book request unique (shop, service, actor, requester) are included so
 * two requests with the same intent produce the same hash and can be safely
 * replayed. `requester` is the authenticated player user id (never the payload).
 */
function computeBookIntentHash({ shopId, serviceId, actorId, requester }) {
  const canonical = JSON.stringify({
    shopId: String(shopId),
    serviceId: String(serviceId),
    actorId: String(actorId),
    requester: String(requester),
  });
  return fnv1a(canonical);
}

/**
 * Deterministic intent fingerprint for a GM fulfillment acknowledgement. The
 * action is fully determined by the original order id, so only `orderId` is
 * hashed; the executing GM is deliberately excluded so a different GM repeating
 * the same request replays rather than conflicting.
 */
function computeFulfillIntentHash({ orderId }) {
  const canonical = JSON.stringify({ orderId: String(orderId) });
  return fnv1a(canonical);
}

/**
 * Resolve an already-persisted SERVICE booking order for the current intent.
 * Never applies a side effect:
 *   - same key + same intentHash on a `booked`/`fulfilled` order => replay its
 *     recorded outcome (a fulfilled service is still a completed booking).
 *   - same key + same intentHash on a `pending`/`needsRecovery` order =>
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
  if (existing.status === 'booked' || existing.status === 'fulfilled') {
    const outcome = existing.outcome || {};
    return {
      status: 'replay',
      orderId: existing.id,
      originalStatus: existing.status,
      serviceId: outcome.serviceId,
      serviceName: outcome.serviceName,
      price: outcome.price,
    };
  }
  if (existing.status === 'pending' || existing.status === 'needsRecovery') {
    return {
      status: 'needsRecovery',
      orderId: existing.id,
      error: existing.error || 'order-pending',
    };
  }
  // failed / committed / cancelled -> a terminal replay of the record.
  return { status: 'replay', orderId: existing.id, originalStatus: existing.status };
}

export function createServiceCommerce(deps) {
  const {
    store,
    runShopExclusive,
    isActiveGM = () => true,
    getActor,
    actorOwnedBy,
    getAdapter,
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
        `[market] failed to persist service phase '${phase}' for order ${orderId}`,
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
   * The trading gate for a service booking. Must be re-read at transaction time
   * (never trusting a request snapshot) and is returned as an error string, or
   * null when trading. The world time is always read server-side (`resolveClock`)
   * - never a client clock. An invalid clock time fails closed as
   * `invalid-world-time` BEFORE any effect.
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
   * The price to charge `actor` for `serviceId`, including the finite-funds
   * overflow guard. Returns an error string, or null on success. Uses the
   * STORED service price (`service.price`) - never a client-supplied price.
   */
  function priceGate(service) {
    try {
      return { price: assertMinorUnits(service.price, 'service.price') };
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * Book a service for a player-owned actor. `requesterId` is the authenticated
   * player user id (the idempotency-key prefix, ownership principal and order
   * `userId`), never a payload field. The active GM executes on behalf of the
   * player, so `isActiveGM` gates every entry point.
   */
  function book(payload = {}, requesterId) {
    let shopId;
    let serviceId;
    let actorId;
    let requestId;
    try {
      shopId = assertMarketId(payload.shopId, 'shopId');
      serviceId = assertMarketId(payload.serviceId, 'serviceId');
      actorId = assertMarketId(payload.actorId, 'actorId');
      requestId = payload.requestId
        ? assertMarketId(payload.requestId, 'requestId')
        : makeId();
    } catch (err) {
      return Promise.resolve({ status: 'error', error: err.message });
    }
    const requester = String(requesterId ?? '').trim();
    if (requester === '') {
      return Promise.resolve({
        status: 'error',
        error: 'requester-required',
      });
    }
    const key = `service:${requester}:${requestId}`;
    const intentHash = computeBookIntentHash({
      shopId,
      serviceId,
      actorId,
      requester,
    });

    // GM gate BEFORE any store read. A player watching the app never triggers a
    // read or a write.
    if (!isActiveGM()) {
      return Promise.resolve({ status: 'error', error: 'not-active-gm' });
    }

    return runShopExclusive(shopId, () =>
      bookLocked({ shopId, serviceId, actorId, requester, key, intentHash })
    );
  }

  async function bookLocked(ctx) {
    const { shopId, serviceId, actorId, requester, key, intentHash } = ctx;

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
      return resolveExistingOrder(existing, intentHash);
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

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 3. Re-read the service from the STORED shop (enabled + visible). Never
    //    trust a request-level price or snapshot.
    const services = Array.isArray(shop.commerce && shop.commerce.services)
      ? shop.commerce.services
      : [];
    const service = services.find((s) => s.id === serviceId);
    if (!service) return { status: 'error', error: 'service-not-found' };
    if (service.enabled === false) {
      return { status: 'error', error: 'service-disabled' };
    }
    if (service.visible === false) {
      return { status: 'error', error: 'service-hidden' };
    }
    const priceCheck = priceGate(service);
    if (priceCheck.error) return { status: 'error', error: 'invalid-price' };
    const price = priceCheck.price;

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 4. Re-read the actor and verify ownership.
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

    // 5. Trading gate (world clock read server-side, fail closed).
    const gateError = tradingError(shop);
    if (gateError) return { status: 'error', error: gateError };

    // 6. Adapter must be supported and the actor's balance must cover the price.
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
    if (balance < price) {
      return { status: 'error', error: 'insufficient-funds' };
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 7. Finite merchant funds GAIN the price. Refuse on a safe-integer overflow
    //    BEFORE any effect rather than wrapping. `null` funds stay unlimited.
    const funds = shop.commerce ? shop.commerce.funds : null;
    const finiteFunds = funds != null;
    const fundsBefore = funds;
    if (finiteFunds) {
      const gained = fundsBefore + price;
      if (!Number.isSafeInteger(gained)) {
        return { status: 'error', error: 'funds-overflow' };
      }
    }

    // 8. Persist the PENDING order BEFORE charging.
    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    const orderRecord = {
      key,
      kind: 'service',
      status: 'pending',
      phase: 'recorded',
      shopId,
      userId: requester,
      actorId,
      entryId: '',
      quantity: 1,
      total: price,
      deposit: 0,
      remaining: 0,
      intentHash,
      details: {
        serviceId,
        serviceName: service.name,
        price,
        fundsBefore,
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

    // 9. Effects: debit -> debited -> funds patch -> credited -> commit ->
    //    final. Any failure AFTER pending goes through best-effort compensation
    //    below; never silently double-debits.
    let debited = false;
    let shopWriteAttempted = finiteFunds;
    let uncertain = false;
    try {
      activeGmOrThrow();

      // Debit. A throwing debit may STILL have applied, so a throwing debit is
      // ALWAYS rolled back (never trusted); the balance verdict only decides
      // whether the player must be refunded and whether recovery is uncertain.
      try {
        await adapter.debit(actor, price);
        debited = true;
      } catch (err) {
        const verdict = await debitVerdict({
          adapter,
          actor,
          price,
          before: balance,
        });
        debited = verdict.debited;
        if (verdict.uncertain) uncertain = true;
        throw err;
      }

      activeGmOrThrow();
      if (!(await setPhase(orderId, 'debited'))) uncertain = true;

      // Finite merchant funds gain the price in a SINGLE shop patch. For
      // unlimited (`null`) funds there is no write.
      if (finiteFunds) {
        shopWriteAttempted = true;
        const commerce = { ...shop.commerce, funds: fundsBefore + price };
        // A throwing or null-returning write may still have applied its funds
        // patch. `shopWriteAttempted` (never `shopWriteApplied`) drives the
        // compensation re-read, so an uncertain write is re-evaluated against
        // the persisted shop rather than assumed.
        const shopWritten = await store.updateShop(shopId, { commerce });
        if (shopWritten == null) throw new Error('shop-write-missing');
      }

      activeGmOrThrow();
      if (!(await setPhase(orderId, 'credited'))) uncertain = true;

      // Commit. Only claim `booked` when the terminal write actually persisted a
      // record. A throwing OR null-returning write is NOT assumed failed: either
      // may STILL have landed, so the order is re-read by id before any
      // compensation. A landed `booked` is a success (never refunded), a
      // reliably-pending order is compensated, and an unavailable/ambiguous state
      // is needsRecovery WITHOUT refunding the debit or restoring funds.
      const outcome = {
        serviceId,
        serviceName: service.name,
        price,
        orderId,
      };
      let committedRecord;
      try {
        committedRecord = await store.updateAdvancedOrder(orderId, {
          status: 'booked',
          phase: 'final',
          outcome,
        });
      } catch (err) {
        return resolveBookedCommit({
          orderId,
          outcome,
          err,
          uncertain,
          compensateCtx: {
            orderId,
            shopId,
            actor,
            price,
            fundsBefore,
            finiteFunds,
            serviceId,
            serviceName: service.name,
            debited,
            shopWriteAttempted,
            balanceBefore: balance,
            adapter,
          },
        });
      }
      if (committedRecord == null) {
        return resolveBookedCommit({
          orderId,
          outcome,
          err: new Error('order-commit-missing'),
          uncertain: true,
          compensateCtx: {
            orderId,
            shopId,
            actor,
            price,
            fundsBefore,
            finiteFunds,
            serviceId,
            serviceName: service.name,
            debited,
            shopWriteAttempted,
            balanceBefore: balance,
            adapter,
          },
        });
      }
      return {
        status: 'booked',
        orderId,
        serviceId,
        serviceName: service.name,
        price,
      };
    } catch (err) {
      return compensate({
        err,
        orderId,
        shopId,
        actor,
        price,
        fundsBefore,
        finiteFunds,
        serviceId,
        serviceName: service.name,
        debited,
        shopWriteAttempted,
        balanceBefore: balance,
        uncertain,
        adapter,
      });
    }
  }

  /**
   * The balance verdict for a throwing debit: whether the debit actually applied
   * (so compensation must refund) and whether the state is uncertain. `before`
   * is the balance captured before the debit (already read on the success path;
   * re-read here when unknown). Returns `{ debited, uncertain }`:
   *   - balance unchanged               => `{ debited: false, uncertain: false }`
   *   - balance decreased by exactly price
   *                                     => `{ debited: true, uncertain: false }`
   *   - balance diverged (or could not be re-read)
   *                                     => uncertain.
   */
  async function debitVerdict({ adapter, actor, price, before }) {
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
    if (after === before - price) return { debited: true, uncertain: false };
    return { debited: false, uncertain: true };
  }

  /**
   * Best-effort recovery after a pending service order was persisted and an
   * effect (or the final commit) failed. Undoes exactly what may have been
   * applied and never double-compensates: a fully successful compensation
   * records `failed`, an uncertain/failed one records `needsRecovery`. A failure
   * to write the terminal status leaves the record `pending` (a replay then
   * surfaces it).
   */
  async function compensate(ctx) {
    const {
      err,
      orderId,
      shopId,
      actor,
      price,
      fundsBefore,
      finiteFunds,
      serviceId,
      serviceName,
      debited,
      shopWriteAttempted,
      balanceBefore,
      uncertain = false,
      adapter,
    } = ctx;
    const compensation = [];
    let uncertainOutcome = uncertain;

    if (debited) {
      try {
        await adapter.credit(actor, price);
        compensation.push('credit-refunded');
      } catch (e) {
        compensation.push('credit-refund-failed');
        uncertainOutcome = true;
      }
      // The refunded wallet must be back to the recorded pre-debit balance. A
      // mismatch (or an unreadable balance) means the player's money is
      // unresolved, so the order is escalated rather than claimed cleaned.
      if (balanceBefore != null) {
        try {
          const after = await adapter.getBalance(actor);
          if (after !== balanceBefore) uncertainOutcome = true;
        } catch (e) {
          uncertainOutcome = true;
        }
      }
    }

    // Funds patch compensation. Triggered whenever a finite-funds shop patch was
    // attempted (the write may have thrown or returned null while STILL applying
    // the gain). Compare the current funds to the recorded `fundsBefore` and the
    // expected `fundsBefore + price` so a known no-write never falsely claims a
    // restore and a mixed/unknown state is escalated rather than assumed.
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
          const expected = fundsBefore + price;
          if (currentFunds === fundsBefore) {
            // known no-write: nothing to undo.
            compensation.push('shop-unwritten');
          } else if (currentFunds === expected) {
            // known full-write: restore funds in the same update, then verify.
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
          serviceId,
          serviceName,
          price,
          fundsBefore,
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
        `[market] failed to persist service compensation for order ${orderId}`,
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
   * Resolve a terminal `booked` commit write that threw or returned null. The
   * write may STILL have persisted the booking, so the order is re-read by id
   * BEFORE any compensation:
   *   - a `booked` order carrying the same intent outcome => the commit landed;
   *     report success (never refund the player or restore merchant funds).
   *   - a reliably `pending` order => the write never landed; run the existing
   *     compensation.
   *   - the re-read throws, or the order is missing / in an ambiguous state =>
   *     needsRecovery WITHOUT refunding the debit or restoring merchant funds
   *     (a possibly-delivered booking must never be undone).
   */
  async function resolveBookedCommit({ orderId, outcome, err, uncertain, compensateCtx }) {
    let reread;
    try {
      reread = await store.findAdvancedOrder(orderId);
    } catch (e) {
      return {
        status: 'needsRecovery',
        orderId,
        error: String((err && err.message) || err),
        compensation: [],
      };
    }
    if (!reread) {
      return {
        status: 'needsRecovery',
        orderId,
        error: String((err && err.message) || err),
        compensation: [],
      };
    }
    const landed =
      reread.status === 'booked' &&
      !!reread.outcome &&
      reread.outcome.serviceId === outcome.serviceId &&
      reread.outcome.serviceName === outcome.serviceName &&
      reread.outcome.price === outcome.price;
    if (landed) {
      return {
        status: 'booked',
        orderId,
        serviceId: reread.outcome.serviceId,
        serviceName: reread.outcome.serviceName,
        price: reread.outcome.price,
      };
    }
    if (reread.status === 'pending') {
      return compensate({
        ...compensateCtx,
        err,
        uncertain,
      });
    }
    // Ambiguous terminal/unknown state: do not compensate.
    return {
      status: 'needsRecovery',
      orderId,
      error: String((err && err.message) || err),
      compensation: [],
    };
  }

  /**
   * Resolve an already-persisted service FULFILLMENT acknowledgement for the
   * current intent. Never re-runs the service (fulfillment has no mechanical
   * effect). The verdict is based on the ORIGINAL order's status, as the spec
   * requires: a fulfilled original replays as success; a still-booked original
   * with only a pending/needsRecovery record needsRecovery.
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
    const orderFulfilled = !!(order && order.kind === 'service' && order.status === 'fulfilled');

    if (orderFulfilled) {
      // The fulfillment already happened; record the acknowledgement as
      // committed if it is still pending/needsRecovery (best-effort, no re-run).
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
        originalStatus: 'fulfilled',
        serviceId: order.outcome?.serviceId ?? outcome.serviceId,
        serviceName: order.outcome?.serviceName ?? outcome.serviceName,
        price: order.total != null ? order.total : outcome.price,
      };
    }

    if (existing.status === 'committed') {
      // The record claims committed but the original is not fulfilled: an
      // inconsistent record needing manual reconciliation.
      return { status: 'needsRecovery', orderId, error: 'fulfilled-order-inconsistent' };
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
   * Replay the fulfillment of an original order that is already `fulfilled`
   * (with no confirmatory fulfill record, e.g. the acknowledgement was never
   * persisted). Returns a clean replay result.
   */
  function fulfilledReplay(order) {
    const outcome = order.outcome || {};
    return {
      status: 'replay',
      orderId: order.id,
      originalStatus: order.status,
      serviceId: outcome.serviceId,
      serviceName: outcome.serviceName,
      price: order.total != null ? order.total : outcome.price,
    };
  }

  /**
   * Record a GM's manual fulfilment acknowledgement for a booked service order.
   * `gmUserId` is the executing GM user id (never a payload field) and is the
   * fulfillment record's `userId`. The GM manually confirms delivery elsewhere;
   * this only records the acknowledgement and moves the order to `fulfilled`.
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
    const key = `service-fulfill:${orderId}:${requestId}`;
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

    // 1. Idempotency re-read of the fulfillment record BEFORE any state change.
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

    // 2. Look up the original order. It must be a `service` kind; a `booked`
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
    if (order.kind !== 'service') {
      return { status: 'error', error: 'order-not-service' };
    }
    if (order.status === 'fulfilled') {
      return fulfilledReplay(order);
    }
    if (order.status !== 'booked') {
      return { status: 'error', error: 'order-not-booked' };
    }

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 3. Require the shop and actor to still exist (the order may outlive them).
    let shop;
    try {
      shop = await store.findShop(order.shopId);
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

    if (!isActiveGM()) return { status: 'error', error: 'not-active-gm' };

    // 4. Persist the PENDING fulfillment acknowledgement BEFORE any effect.
    const fulfillRecord = {
      key,
      kind: 'service',
      status: 'pending',
      phase: 'recorded',
      shopId: order.shopId,
      userId: gmUser,
      actorId: order.actorId,
      entryId: '',
      relatedOrderId: orderId,
      quantity: 1,
      total: order.total,
      deposit: 0,
      remaining: 0,
      intentHash,
      details: {
        serviceId: order.outcome?.serviceId,
        serviceName: order.outcome?.serviceName,
        price: order.total,
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
      // A create-race handed back an existing fulfillment record for the same
      // key; resolve idempotently and never re-run.
      return resolveExistingFulfill(record, intentHash, orderId);
    }
    const fulfillId = record.id;

    // 5. Two writes: mark the original `fulfilled`, then the acknowledgment
    //    `committed`. If EITHER fails the fulfill is `needsRecovery`; the service
    //    itself is never re-run and the original status is re-checked on replay.
    let uncertain = false;
    try {
      activeGmOrThrow();
      const updatedOriginal = await store.updateAdvancedOrder(orderId, {
        status: 'fulfilled',
        phase: 'final',
      });
      if (updatedOriginal == null) {
        uncertain = true;
        throw new Error('order-commit-missing');
      }

      activeGmOrThrow();
      const outcome = {
        orderId,
        serviceId: order.outcome?.serviceId,
        serviceName: order.outcome?.serviceName,
        price: order.total,
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
        serviceId: outcome.serviceId,
        serviceName: order.outcome?.serviceName,
        price: order.total,
      };
    } catch (err) {
      return finalizeFulfillFailure({
        err,
        orderId,
        fulfillId,
        uncertain,
      });
    }
  }

  /**
   * Best-effort finalize of a failed fulfillment. The original may already be
   * `fulfilled` while the acknowledgement write failed, so the recovery boundary
   * is best-effort: mark the acknowledgment `needsRecovery` and surface the
   * original status for manual reconciliation. Never re-runs the service.
   */
  async function finalizeFulfillFailure({ err, orderId, fulfillId, uncertain }) {
    let responseStatus = 'needsRecovery';
    try {
      await store.updateAdvancedOrder(fulfillId, {
        status: 'needsRecovery',
        phase: 'final',
        error: String((err && err.message) || err),
      });
    } catch (e) {
      // The acknowledgment record could not even be marked; it stays `pending`.
    }
    if (uncertain) responseStatus = 'needsRecovery';
    return {
      status: responseStatus,
      orderId,
      error: String((err && err.message) || err),
    };
  }

  return { book, fulfill };
}

export default createServiceCommerce;
