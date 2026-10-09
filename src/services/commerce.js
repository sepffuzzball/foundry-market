// Purchase orchestration for the market core.
//
// `purchase()` is GM-only: it re-reads shop/actor/source data at transaction
// time, serializes purchases per shop, records an idempotency ledger entry
// BEFORE charging (status `pending`), then charges -> delivers -> decrements
// stock -> commits. Failures are compensated best-effort (refund currency,
// remove a delivered item); if compensation itself fails the ledger is marked
// `needsRecovery`. The core does NOT claim transactional atomicity - it is a
// compensating ledger, and the docs explain the recovery boundary.
//
// No Foundry globals are referenced at import time.

import {
  normalizeLedgerRecord,
  assertPositiveInteger,
  parseItemData,
} from './model.js';
import { quote } from './pricing.js';

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
    if (!shop.open) {
      return recordFailure({ key, userId, payload: requestPayload, error: 'shop-closed' });
    }
    if (!entry.visible) {
      return recordFailure({ key, userId, payload: requestPayload, error: 'entry-hidden' });
    }
    if (entry.stockMode !== 'unlimited' && entry.quantity < qty) {
      return recordFailure({ key, userId, payload: requestPayload, error: 'insufficient-stock' });
    }

    let total;
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
    const adapter = getAdapter(systemId());
    if (!adapter || !adapter.supported) {
      return recordFailure({
        key,
        userId,
        payload: requestPayload,
        error: 'adapter-unsupported',
        detail: adapter ? adapter.unsupportedReason || '' : 'no adapter',
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
      });
    }
    if (balance < total) {
      return recordFailure({
        key,
        userId,
        payload: requestPayload,
        error: 'insufficient-funds',
        detail: `need ${total}, have ${balance}`,
        extra: { totalPrice: total, balance },
      });
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
          shopId,
          entryId,
          actorId,
          quantity: qty,
          unitPrice: entry.price,
          totalPrice: total,
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
    let stockUpdated = false;
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

      if (entry.stockMode !== 'unlimited') {
        const remaining = entry.quantity - qty;
        if (remaining < 0) {
          throw new Error('insufficient-stock-after-reserve');
        }
        const inventory = shop.inventory.map((e) =>
          e.id === entryId ? { ...e, quantity: remaining } : e
        );
        await store.updateShop(shopId, { inventory });
        stockUpdated = true;
      }

      const outcome = {
        createdItemId: created?.id ?? null,
        unitPrice: entry.price,
        total,
        quantity: qty,
      };
      await store.updateLedger(rec.id, {
        status: 'committed',
        updatedAt: now(),
        outcome,
      });
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
      if (stockUpdated) {
        // Stock was already decremented, so restore it to the original count.
        try {
          const restored = shop.inventory.map((e) =>
            e.id === entryId ? { ...e, quantity: entry.quantity } : e
          );
          await store.updateShop(shopId, { inventory: restored });
          compensation.push('stock-restored');
        } catch (e) {
          compensation.push('stock-restore-failed');
          needsRecovery = true;
        }
      }
      const status = needsRecovery ? 'needsRecovery' : 'failed';
      try {
        await store.updateLedger(rec.id, {
          status,
          updatedAt: now(),
          error: String((err && err.message) || err),
          compensation,
          outcome: {
            createdItemId: created?.id ?? null,
            unitPrice: entry.price,
            total,
            quantity: qty,
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
      };
    }
  }

  return { purchase, runShopExclusive };
}

export default createCommerce;
