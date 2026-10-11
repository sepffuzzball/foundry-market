// Purchase orchestration for the market core.
//
// `purchase()` is GM-only: it re-reads shop/actor/source data at transaction
// time, serializes purchases per shop, records an idempotency ledger entry
// BEFORE charging (status `pending`), then charges -> delivers -> writes the
// shop (decrement finite/non-restocking stock and, when merchant funds are
// finite, gain the ordinary direct-Buy revenue in the same patch) -> commits.
// Failures are compensated best-effort (refund currency, remove a delivered
// item, restore the shop by re-reading entry quantity and funds); if
// compensation itself fails the ledger is marked `needsRecovery`. The core does
// NOT claim transactional atomicity - it is a compensating ledger, and the docs
// explain the recovery boundary.
//
// No Foundry globals are referenced at import time.

import {
  normalizeLedgerRecord,
  normalizePriceBreakdown,
  assertPositiveInteger,
  parseItemData,
} from './model.js';
import { quote } from './pricing.js';
import { quoteSocial as defaultQuoteSocial } from '../social/pricing.js';
import { isShopTrading } from '../automation/policy.js';
import { canAccessEntry } from '../advanced/policy.js';

export function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Deterministic hash of a purchase payload. Only the fields that make a
 * request unique are included so two requests with the same intent produce the
 * same hash and can be safely replayed.
 */
export function payloadHash(payload) {
  const canonical = JSON.stringify({
    shopId: String(payload?.shopId ?? ''),
    entryId: String(payload?.entryId ?? ''),
    actorId: String(payload?.actorId ?? ''),
    quantity: Number(payload?.quantity ?? 1),
  });
  return fnv1a(canonical);
}

/**
 * Idempotency resolution. Returns:
 *   { decision: 'create' }                          - no prior record, proceed
 *   { decision: 'replay', record }                  - same key + same payload
 *   { decision: 'conflict', expected, existing }    - same key, different payload
 */
export function resolveIdempotency(existing, payload) {
  if (!existing) return { decision: 'create' };
  const hash = payloadHash(payload);
  if (existing.payloadHash === hash) return { decision: 'replay', record: existing };
  return { decision: 'conflict', expected: existing.payloadHash, existing };
}

/**
 * Create a per-key lock so operations sharing a key run strictly serially.
 */
export function createLockMap() {
  const chains = new Map();
  function run(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(key, next);
    return next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
  }
  return { run };
}

const defaultLockMap = createLockMap();

/**
 * Per-shop coordination key. Purchases and GM manager inventory edits use the
 * SAME key so they run strictly serially against one shop - no lost stock
 * decrement or clobbered inventory can occur between the two writers.
 */
function shopLockKey(shopId) {
  return `shop:${shopId}`;
}

/**
 * Resolve a `getWorldTime()` result to a safe integer second, or null when the
 * clock value is invalid (NaN/undefined/Infinity/non-safe). The runtime never
 * trusts a client clock; an invalid server time must fail the purchase closed as
 * `invalid-world-time` before any debit rather than collapse to 0 (Monday 00:00)
 * and silently trade. Only used on the opt-in `getWorldTime` path; the legacy
 * path never reads this.
 */
function safeWorldTime(value) {
  if (Number.isFinite(value)) {
    const floored = Math.floor(value);
    if (Number.isSafeInteger(floored)) return floored;
  }
  return null;
}

/**
 * Resolve a resolved idempotency outcome into a safe purchase response. Returns
 * undefined for a `create` decision (caller proceeds).
 *   - replay of a `pending` record => surfaced as `pending` (manual recovery).
 *   - replay of a terminal record  => `replay` with the recorded outcome.
 *   - conflict                     => `conflict` error, never charged.
 */
function idempotentOutcome(resolved) {
  if (!resolved) return undefined;
  if (resolved.decision === 'replay') {
    const record = resolved.record;
    if (record.status === 'pending') {
      return {
        status: 'pending',
        ledgerId: record.id,
        total: record.totalPrice,
        quantity: record.quantity,
        error: 'ledger-pending',
      };
    }
    return { status: 'replay', record };
  }
  if (resolved.decision === 'conflict') {
    return {
      status: 'conflict',
      conflict: true,
      error: 'conflicting duplicate payload',
      expected: resolved.expected,
      existing: resolved.existing,
    };
  }
  return undefined;
}

export function createCommerce(deps) {
  const {
    store,
    getActor,
    fromUuid,
    getAdapter,
    systemId,
    isGM,
    actorOwnedBy,
    logger,
    now = () => Date.now(),
    makeId,
    lockMap = defaultLockMap,
    getSocial,
    quoteSocial = defaultQuoteSocial,
    getWorldTime,
  } = deps;

  /**
   * Run `fn` exclusively against a shop. Purchases and GM manager inventory
   * writes share this same lock (by shop), so a purchase and a GM edit can
   * never interleave on the same shop and overwrite each other's inventory.
   */
  function runShopExclusive(shopId, fn) {
    return lockMap.run(shopLockKey(shopId), fn);
  }

  async function recordFailure({ key, userId, payload, error, detail = '', extra = {} }) {
    try {
      const { record } = await store.createLedger(
        normalizeLedgerRecord({
          key,
          userId,
          payloadHash: payloadHash(payload),
          payload,
          status: 'failed',
          error,
          ...extra,
          detail,
        })
      );
      return { status: record.status, ledgerId: record.id, error, detail };
    } catch (err) {
      logger?.error?.('[market] failed to persist failed ledger outcome', err);
      return { status: 'failed', error: `ledger-write-failed: ${(err && err.message) || err}` };
    }
  }

  /**
   * Resolve the item source for an entry. Prefers the live `itemUuid`; if it is
   * absent or deleted (fromUuid returns null) falls back to a valid snapshot.
   * Returns null when both are missing, which forbids the purchase.
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
   * Resolve a terminal `committed` ledger write that threw or returned null. The
   * write may STILL have applied, so the ledger is re-read by key BEFORE any
   * compensation:
   *   - a `committed` ledger carrying the same purchase outcome => the commit
   *     landed; report success (never refund the currency, remove the delivered
   *     item or restore stock/funds).
   *   - a reliably `pending` ledger => the write never landed; return the
   *     'compensate' sentinel so the caller reruns the existing compensation.
   *   - the re-read throws, or the ledger is missing / in an ambiguous state =>
   *     needsRecovery WITHOUT refunding/removing the delivered goods or
   *     restoring stock/funds (a possibly-delivered purchase must never be
   *     undone).
   */
  async function resolveLedgerCommit({ recId, key, outcome, err, total, quantity, priceBreakdown }) {
    let current;
    try {
      current = await store.findLedgerByKey(key);
    } catch (e) {
      return {
        status: 'needsRecovery',
        ledgerId: recId,
        error: String((err && err.message) || err),
        compensation: [],
        total,
        quantity,
        priceBreakdown,
      };
    }
    if (!current) {
      return {
        status: 'needsRecovery',
        ledgerId: recId,
        error: String((err && err.message) || err),
        compensation: [],
        total,
        quantity,
        priceBreakdown,
      };
    }
    const landed =
      current.status === 'committed' &&
      !!current.outcome &&
      current.outcome.unitPrice === outcome.unitPrice &&
      current.outcome.total === outcome.total &&
      current.outcome.quantity === outcome.quantity;
    if (landed) {
      return {
        status: 'committed',
        ledgerId: recId,
        createdItemId: current.outcome.createdItemId ?? outcome.createdItemId ?? null,
        unitPrice: current.outcome.unitPrice,
        total: current.outcome.total,
        quantity: current.outcome.quantity,
        priceBreakdown: current.outcome.priceBreakdown ?? priceBreakdown,
      };
    }
    if (current.status === 'pending') return 'compensate';
    return {
      status: 'needsRecovery',
      ledgerId: recId,
      error: String((err && err.message) || err),
      compensation: [],
      total,
      quantity,
      priceBreakdown,
    };
  }

  /**
   * Execute a purchase. `authenticatedUserId` is the GM user id executing the
   * transaction (the active GM). The request's owning user is `payload.userId`,
   * which is used both for the idempotency key and for the actor ownership check.
   */
  function purchase(payload = {}, authenticatedUserId) {
    const { shopId, entryId, actorId, quantity, requestId } = payload;
    const userId = payload.userId || authenticatedUserId;
    let qty;
    try {
      qty = assertPositiveInteger(quantity, 'quantity');
    } catch (err) {
      return Promise.resolve({ status: 'error', error: err.message });
    }
    const reqId = requestId || makeId();
    const key = `${userId}:${reqId}`;
    const requestPayload = { shopId, entryId, actorId, quantity: qty };

    return runShopExclusive(shopId, () =>
      purchaseLocked({ payload, authenticatedUserId, userId, qty, key, requestPayload })
    );
  }

  async function purchaseLocked(ctx) {
    const { payload, authenticatedUserId, userId, qty, key, requestPayload } = ctx;
    const { shopId, entryId, actorId } = payload;

    // 1. Idempotency (before any state change).
    let existing;
    try {
      existing = await store.findLedgerByKey(key);
    } catch (err) {
      return { status: 'error', error: `ledger-read-failed: ${(err && err.message) || err}` };
    }
    const resolved = resolveIdempotency(existing, requestPayload);
    if (resolved.decision !== 'create') {
      // Replay (or conflict) of an already-recorded transaction. Never charge.
      return idempotentOutcome(resolved);
    }

    // 2. GM-only.
    if (!isGM(authenticatedUserId)) {
      return recordFailure({
        key,
        userId,
        payload: requestPayload,
        error: 'not-a-gm',
        detail: `authenticatedUserId=${authenticatedUserId}`,
      });
    }

    // 3. Re-read shop and actor (never trust request-level snapshots).
    const shop = await store.findShop(shopId);
    if (!shop) {
      return recordFailure({ key, userId, payload: requestPayload, error: 'shop-not-found' });
    }
    const actor = await getActor(actorId);
    if (!actor) {
      return recordFailure({ key, userId, payload: requestPayload, error: 'actor-not-found' });
    }
    if (!actorOwnedBy(actor, userId)) {
      return recordFailure({
        key,
        userId,
        payload: requestPayload,
        error: 'actor-not-owned',
        detail: `userId=${userId}`,
      });
    }

    const entry = shop.inventory.find((e) => e.id === entryId);
    if (!entry) {
      return recordFailure({ key, userId, payload: requestPayload, error: 'entry-not-found' });
    }
    if (getWorldTime) {
      // Opt-in M4 trading/hours/presence gate. Runs inside the existing per-shop
      // lock (purchaseLocked is invoked under runShopExclusive) and NEVER trusts a
      // client clock: the world time is read server-side via `getWorldTime()`.
      // An invalid (NaN/undefined/Infinity/unsafe) server time fails the purchase
      // closed as `invalid-world-time` BEFORE any debit, rather than collapsing to
      // week zero and silently trading. False = shop-closed, exactly as a legacy
      // manually-closed toggle.
      const worldTime = safeWorldTime(getWorldTime());
      if (worldTime == null) {
        return recordFailure({
          key,
          userId,
          payload: requestPayload,
          error: 'invalid-world-time',
        });
      }
      const trading = isShopTrading(shop, worldTime);
      if (!trading.open) {
        return recordFailure({ key, userId, payload: requestPayload, error: 'shop-closed' });
      }
    } else if (!shop.open) {
      return recordFailure({ key, userId, payload: requestPayload, error: 'shop-closed' });
    }
    if (!entry.visible) {
      return recordFailure({ key, userId, payload: requestPayload, error: 'entry-hidden' });
    }
    if (entry.stockMode !== 'unlimited' && entry.quantity < qty) {
      return recordFailure({ key, userId, payload: requestPayload, error: 'insufficient-stock' });
    }

    // Quote. When the runtime supplies `getSocial` (M3 social pricing wired),
    // quote through `quoteSocial` using the actor's effective reputation scores
    // and record a validated priceBreakdown; a Hated reputation refuses the
    // sale (`service-refused`) BEFORE any debit. Without `getSocial` (legacy /
    // un-wired runtime) fall back to the original integer `quote`, which keeps
    // the M1/M2 purchase path byte-for-byte unchanged.
    let unitPrice;
    let total;
    let priceBreakdown = null;
    let refused = false;
    if (getSocial) {
      let effective;
      try {
        effective = await getSocial(shop, actor);
      } catch (err) {
        return recordFailure({
          key,
          userId,
          payload: requestPayload,
          error: 'rep-read-failed',
          detail: (err && err.message) || String(err),
        });
      }
      // M5 backroom gate. After actor ownership AND the effective-reputation
      // lookup, enforce `canAccessEntry` for a `backroom` entry and record
      // `entry-restricted` before any debit - even when a request forges an
      // entryId the actor cannot access. A `public` entry is unaffected.
      if (!canAccessEntry(entry, { actorUuid: actor?.uuid, score: effective?.score })) {
        return recordFailure({
          key,
          userId,
          payload: requestPayload,
          error: 'entry-restricted',
          detail: 'backroom entry not accessible to the actor',
        });
      }
      try {
        const q = quoteSocial(entry, qty, {
          shop,
          scores: { individual: effective?.individual, party: effective?.party },
        });
        unitPrice = q.unitPrice;
        total = q.total;
        priceBreakdown = normalizePriceBreakdown({
          quantity: q.quantity,
          unitBase: q.unitBase,
          baseTotal: q.baseTotal,
          shopBps: q.shopBps,
          personalityBps: q.personalityBps,
          reputationBps: q.reputationBps,
          haggleBps: q.haggleBps,
          adjustmentBps: q.adjustmentBps,
          unitPrice: q.unitPrice,
          total: q.total,
          band: q.band,
          refused: q.refused,
        });
        refused = q.refused;
      } catch (err) {
        return recordFailure({
          key,
          userId,
          payload: requestPayload,
          error: 'total-overflow',
          detail: (err && err.message) || String(err),
        });
      }
    } else {
      // M5 backroom gate on the legacy / un-wired runtime (no `getSocial`).
      // Fail closed for a `backroom` entry unless the actor's UUID is already
      // allowlisted: with no effective reputation the score defaults to -100,
      // which can never satisfy a `minReputation` above -100, so only a UUID
      // allowlist match grants access. A `public` entry is unaffected.
      if (!canAccessEntry(entry, { actorUuid: actor?.uuid, score: -100 })) {
        return recordFailure({
          key,
          userId,
          payload: requestPayload,
          error: 'entry-restricted',
          detail: 'backroom entry not accessible to the actor',
        });
      }
      try {
        total = quote(entry, qty);
      } catch (err) {
        return recordFailure({
          key,
          userId,
          payload: requestPayload,
          error: 'total-overflow',
          detail: (err && err.message) || String(err),
        });
      }
      unitPrice = entry.price;
      priceBreakdown = null;
    }
    if (refused) {
      return recordFailure({
        key,
        userId,
        payload: requestPayload,
        error: 'service-refused',
        detail: 'shop reputation is Hated',
        extra: { quoteKnown: true, totalPrice: total, unitPrice, priceBreakdown },
      });
    }
    const adapter = getAdapter(systemId());
    if (!adapter || !adapter.supported) {
      return recordFailure({
        key,
        userId,
        payload: requestPayload,
        error: 'adapter-unsupported',
        detail: adapter ? adapter.unsupportedReason || '' : 'no adapter',
        extra: { quoteKnown: true, totalPrice: total, unitPrice, priceBreakdown },
      });
    }

    let balance;
    try {
      balance = await adapter.getBalance(actor);
    } catch (err) {
      return recordFailure({
        key,
        userId,
        payload: requestPayload,
        error: 'balance-read-failed',
        detail: (err && err.message) || String(err),
        extra: { quoteKnown: true, totalPrice: total, unitPrice, priceBreakdown },
      });
    }
    if (balance < total) {
      return recordFailure({
        key,
        userId,
        payload: requestPayload,
        error: 'insufficient-funds',
        detail: `need ${total}, have ${balance}`,
        extra: { quoteKnown: true, totalPrice: total, balance, unitPrice, priceBreakdown },
      });
    }

    // Optional finite merchant funds GAIN the total (ordinary direct Buy
    // revenue). Refuse on a safe-integer overflow BEFORE any effect rather than
    // wrapping. `null` funds stay unlimited (no funds patch is written).
    const funds = shop.commerce ? shop.commerce.funds : null;
    const finiteFunds = funds != null;
    const fundsBefore = funds;
    if (finiteFunds) {
      const gained = Number(BigInt(funds) + BigInt(total));
      if (!Number.isSafeInteger(gained)) {
        return recordFailure({
          key,
          userId,
          payload: requestPayload,
          error: 'merchant-funds-overflow',
          detail: `merchant funds ${funds} + total ${total} overflow`,
          extra: { quoteKnown: true, totalPrice: total, funds, unitPrice, priceBreakdown },
        });
      }
    }

    // 4. Persist PENDING record BEFORE charging.
    let ledgerResult;
    try {
      ledgerResult = await store.createLedger(
        normalizeLedgerRecord({
          key,
          userId,
          payloadHash: payloadHash(requestPayload),
          payload: requestPayload,
          status: 'pending',
          quoteKnown: true,
          shopId,
          entryId,
          actorId,
          quantity: qty,
          unitPrice,
          totalPrice: total,
          priceBreakdown,
        })
      );
    } catch (err) {
      return { status: 'error', error: `ledger-create-failed: ${(err && err.message) || err}` };
    }
    const rec = ledgerResult.record;

    // A createLedger race may hand back an existing record for the same key
    // that was written by a concurrent purchase (same or different shop). When
    // that happens the key already exists in the persisted ledger, so we must
    // NEVER charge: resolve to the recorded outcome (replay / pending /
    // conflict) exactly as if we had found it at step 1.
    if (!ledgerResult.created) {
      return idempotentOutcome(resolveIdempotency(rec, requestPayload));
    }

    // Defensive: if the record we just created somehow carries a different
    // payload hash, reject as a conflict before charging anything.
    if (rec.payloadHash && rec.payloadHash !== payloadHash(requestPayload)) {
      return {
        status: 'conflict',
        conflict: true,
        error: 'conflicting duplicate payload',
        expected: rec.payloadHash,
        existing: rec,
      };
    }

    // 5. Charge -> deliver -> decrement stock -> commit. Explicit phase flags
    // track exactly which state changes succeeded so compensation can undo only
    // what was actually applied (and never double-compensate).
    let debited = false;
    let created = null;
    let shopWriteAttempted = false;
    try {
      await adapter.debit(actor, total);
      debited = true;

      const source = await resolveItemSource(entry);
      if (!source) {
        throw new Error(
          'item source not found (no itemUuid and no valid snapshot)'
        );
      }
      const delivered = await adapter.deliverItem(actor, source, { quantity: qty });
      created = delivered;

      // ONE shop write inside the lock: decrement finite/non-restocking stock and,
      // when funds are finite, gain the total (ordinary direct Buy revenue) in the
      // SAME patch so stock and funds never diverge. Never overwrite other fields.
      // When funds are unlimited keep the legacy stock-only behavior; when both
      // stock and funds are unlimited there is no write at all.
      let inventory;
      if (entry.stockMode !== 'unlimited') {
        const remaining = entry.quantity - qty;
        if (remaining < 0) {
          throw new Error('insufficient-stock-after-reserve');
        }
        inventory = shop.inventory.map((e) =>
          e.id === entryId ? { ...e, quantity: remaining } : e
        );
      } else {
        inventory = shop.inventory;
      }

      if (finiteFunds || entry.stockMode !== 'unlimited') {
        const patch = { inventory };
        if (finiteFunds) {
          patch.commerce = { ...shop.commerce, funds: fundsBefore + total };
        }
        shopWriteAttempted = true;
        const updatedShop = await store.updateShop(shopId, patch);
        if (updatedShop == null) {
          throw new Error('shop-update-missing');
        }
      }

      const outcome = {
        createdItemId: created?.id ?? null,
        unitPrice,
        total,
        quantity: qty,
        priceBreakdown,
      };
      let committedRecord;
      try {
        committedRecord = await store.updateLedger(rec.id, {
          status: 'committed',
          updatedAt: now(),
          outcome,
        });
      } catch (err) {
        // A throwing terminal write may STILL have applied. Re-read the ledger by
        // key before compensating: a landed `committed` is success, a pending
        // ledger is compensated (rethrow to run the existing block), and an
        // unavailable/missing/ambiguous ledger is needsRecovery WITHOUT
        // refunding the currency, removing the delivered item or restoring
        // stock/funds.
        const resolution = await resolveLedgerCommit({
          recId: rec.id,
          key,
          outcome,
          err,
          total,
          quantity: qty,
          priceBreakdown,
        });
        if (resolution === 'compensate') throw err;
        return resolution;
      }
      if (committedRecord == null) {
        const resolution = await resolveLedgerCommit({
          recId: rec.id,
          key,
          outcome,
          err: new Error('ledger-commit-missing'),
          total,
          quantity: qty,
          priceBreakdown,
        });
        if (resolution === 'compensate') throw new Error('ledger-commit-missing');
        return resolution;
      }
      return { status: 'committed', ledgerId: rec.id, ...outcome };
    } catch (err) {
      // Best-effort compensation. No atomicity is claimed.
      const compensation = [];
      let needsRecovery = false;
      if (debited) {
        try {
          await adapter.credit(actor, total);
          compensation.push('currency-refunded');
        } catch (e) {
          compensation.push('currency-refund-failed');
          needsRecovery = true;
        }
      }
      if (created) {
        try {
          await adapter.removeItem(actor, created.id);
          compensation.push('item-removed');
        } catch (e) {
          compensation.push('item-remove-failed');
          needsRecovery = true;
        }
      }
      if (shopWriteAttempted) {
        // Shop compensation. Instead of best-effort guessing, re-read the current
        // shop and compare the entry quantity and funds to the recorded
        // before/after values, so a known no-write never falsely claims a restore
        // and a mixed/unknown state is escalated to needsRecovery - never falsely
        // marked failed. Unrelated inventory entries/commerce fields are untouched.
        try {
          const current = await store.findShop(shopId);
          if (!current) {
            compensation.push('shop-missing');
            needsRecovery = true;
          } else {
            const finiteStock = entry.stockMode !== 'unlimited';
            const expectedQtyAfter = entry.quantity - qty;
            const fundsChange = finiteFunds && total !== 0;

            let anyApplied = false;
            let anyNotApplied = false;
            let mixed = false;

            if (finiteStock) {
              const currEntry = current.inventory.find((e) => e.id === entryId);
              if (!currEntry) {
                mixed = true;
              } else if (currEntry.quantity === expectedQtyAfter) {
                anyApplied = true;
              } else if (currEntry.quantity === entry.quantity) {
                anyNotApplied = true;
              } else {
                mixed = true;
              }
            }
            if (fundsChange) {
              const currFunds = current.commerce ? current.commerce.funds : null;
              if (currFunds === fundsBefore + total) {
                anyApplied = true;
              } else if (currFunds === fundsBefore) {
                anyNotApplied = true;
              } else {
                mixed = true;
              }
            }

            if (mixed) {
              compensation.push('shop-state-mixed');
              needsRecovery = true;
            } else if (anyApplied && anyNotApplied) {
              compensation.push('shop-state-mixed');
              needsRecovery = true;
            } else if (anyApplied) {
              // Known complete write: restore exactly the old stock and old funds
              // in a SINGLE update, leaving every unrelated entry/commerce field
              // untouched. Then verify the persisted shop before claiming success.
              const restoredInventory = current.inventory.map((e) =>
                e.id === entryId ? { ...e, quantity: entry.quantity } : e
              );
              const patch = { inventory: restoredInventory };
              if (finiteFunds) {
                patch.commerce = { ...current.commerce, funds: fundsBefore };
              }
              const returned = await store.updateShop(shopId, patch);
              const verified =
                returned != null &&
                (!finiteStock ||
                  (returned.inventory.find((e) => e.id === entryId) || {})
                    .quantity === entry.quantity) &&
                (!finiteFunds ||
                  (returned.commerce && returned.commerce.funds === fundsBefore));
              if (verified) {
                compensation.push(finiteFunds ? 'shop-restored' : 'stock-restored');
              } else {
                compensation.push(
                  finiteFunds
                    ? 'shop-restore-verify-failed'
                    : 'stock-restore-verify-failed'
                );
                needsRecovery = true;
              }
            } else {
              // No observable change: the write never landed (or wrote nothing
              // different), so there is nothing to undo for the shop.
              compensation.push('shop-unwritten');
            }
          }
        } catch (e) {
          compensation.push(
            finiteFunds ? 'shop-restore-failed' : 'stock-restore-failed'
          );
          needsRecovery = true;
        }
      }
      const status = needsRecovery ? 'needsRecovery' : 'failed';
      try {
        await store.updateLedger(rec.id, {
          status,
          updatedAt: now(),
          error: String((err && err.message) || err),
          // Persist the diagnostic detail alongside the error so the GM-only
          // summary page can show the bounded message (the normalizer caps it to
          // LEDGER_DETAIL_MAX). The response/error/status logic is unchanged.
          detail: String((err && err.message) || err),
          compensation,
          outcome: {
            createdItemId: created?.id ?? null,
            unitPrice,
            total,
            quantity: qty,
            priceBreakdown,
          },
        });
      } catch (e) {
        // The status write failed, so the record stays `pending` from creation
        // and a replay will surface it as pending instead of implying success.
        logger?.error?.('[market] failed to persist compensation ledger', e);
      }
      return {
        status,
        ledgerId: rec.id,
        error: String((err && err.message) || err),
        compensation,
        total,
        quantity: qty,
        priceBreakdown,
      };
    }
  }

  return { purchase, runShopExclusive };
}

export default createCommerce;
