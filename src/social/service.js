// GM-owned reputation adjustment service (M3 data layer).
//
// This is the ONLY mutation path for reputation in this pass: it is GM-only and
// manual (source 'gm'). It re-reads the shop at write time (never trusts a
// request snapshot), serializes adjustments per shop through the SAME per-shop
// lock purchases and GM manager edits use (`runShopExclusive`), records an
// idempotency event BEFORE changing the score, then applies the score and marks
// the event committed. Failures are best-effort: a failed record update marks
// the event `needsRecovery`, and a failed commit leaves the event `pending`.
// The core does NOT claim transactional atomicity - it is an event log + score,
// and the recovery boundary is inspectable on the event record.
//
// Replay hardening: a pending/needsRecovery event is only auto-finalized when
// it is provably safe against the CURRENT score. If the score already equals the
// event's intended `next`, the event is marked committed (the delta was applied
// earlier). Otherwise the event's `next` is applied only when the current score
// still equals its `previous` AND no LATER committed event has moved this triple;
// any other state returns `needsRecovery` `score-diverged` WITHOUT writing the
// record/event, leaving manual reconciliation to the GM. A NEW event is also
// refused (`needsRecovery`) while any pending/needsRecovery event already exists
// for the same (shop, scope, subject), so unsafe adjustments never stack.
//
// No Foundry globals are referenced at import time.

import {
  assertReputationScope,
  assertReputationSource,
  assertSubjectId,
  assertMarketId,
  assertSignedInteger,
  REPUTATION_REASON_MAX,
} from '../services/model.js';
import {
  clampReputation,
  effectiveReputation,
  reputationBand,
} from './reputation.js';

export function createReputationService(deps) {
  const {
    store,
    runShopExclusive,
    isGM,
    now = () => Date.now(),
    makeId,
  } = deps;

  function normalizeAdjustParams(params) {
    const scope = assertReputationScope(params.scope);
    const subjectId = assertSubjectId(scope, params.subjectId);
    const shopId = assertMarketId(params.shopId, 'shopId');
    const delta = assertSignedInteger(params.delta, 'delta');
    const reason = String(params.reason ?? '').slice(0, REPUTATION_REASON_MAX);
    const source = assertReputationSource(params.source || 'gm');
    // The public adjust is a manual GM mutation; purchase/haggle-driven sources
    // are a later milestone.
    if (source !== 'gm') {
      throw new Error(`[market] manual adjust only supports source 'gm', got '${source}'`);
    }
    const requestId = params.requestId || makeId();
    return { shopId, scope, subjectId, delta, reason, source, requestId };
  }

  function matches(existing, req) {
    return (
      existing.shopId === req.shopId &&
      existing.scope === req.scope &&
      existing.subjectId === req.subjectId &&
      existing.delta === req.delta &&
      existing.source === req.source &&
      // A changed reason is a different adjustment even with the same key.
      existing.reason === req.reason
    );
  }

  /**
   * True if a `committed` event for the same (shop, scope, subject) triple was
   * created AFTER `existing`. A newer committed event means the score has moved
   * past `existing`'s intent, so applying `existing.next` would clobber it.
   */
  async function hasLaterCommittedEvent(existing) {
    const events = await store.listReputationEvents({
      shopId: existing.shopId,
      scope: existing.scope,
      subjectId: existing.subjectId,
    });
    return events.some(
      (e) =>
        e.id !== existing.id &&
        e.status === 'committed' &&
        e.createdAt > existing.createdAt
    );
  }

  /**
   * Return the first unresolved (pending / needsRecovery) event for the
   * (shop, scope, subject) triple, or null. An unresolved event's `previous`
   * was never applied, so stacking a NEW event on the current score is unsafe.
   */
  async function findUnresolvedEvent(shopId, scope, subjectId) {
    const events = await store.listReputationEvents({ shopId, scope, subjectId });
    return (
      events.find((e) => e.status === 'pending' || e.status === 'needsRecovery') || null
    );
  }

  /**
   * Resolve an existing idempotent event. A matching event is never reapplied:
   * - committed => `replay` with the current record.
   * - pending / needsRecovery => resume. If the record already carries the
   *   event's intended `next` score, just commit the event (the delta was
   *   applied earlier and must not be applied again). Otherwise apply the
   *   previously-intended `next` once, then commit.
   */
  async function finalizeExisting(existing, req) {
    if (!matches(existing, req)) {
      const record = await store.getReputation(req.shopId, req.scope, req.subjectId);
      return { status: 'conflict', error: 'conflicting duplicate request', existing, record };
    }

    const current = await store.getReputation(req.shopId, req.scope, req.subjectId);
    const currentScore = current ? current.score : 0;

    if (existing.status === 'committed') {
      return { status: 'replay', record: current, event: existing };
    }

    // pending / needsRecovery -> resume, never re-add the delta.
    if (currentScore === existing.next) {
      // The earlier attempt already applied the delta; just finalize the event.
      let ev;
      try {
        ev = await store.updateReputationEvent(existing.id, { status: 'committed' });
      } catch (err) {
        return {
          status: 'needsRecovery',
          error: `event-commit-failed: ${(err && err.message) || err}`,
          event: existing,
          record: current,
        };
      }
      return { status: 'replay', record: current, event: ev };
    }

    // Apply the event's intended `next` ONLY when the current score is still
    // exactly `previous` AND no later committed event has already moved the
    // score for this triple. Otherwise the score diverged and needs manual
    // reconciliation - return needsRecovery WITHOUT writing the record/event.
    const laterCommitted = await hasLaterCommittedEvent(existing);
    if (currentScore === existing.previous && !laterCommitted) {
      let updated;
      try {
        updated = await store.upsertReputation({
          shopId: req.shopId,
          scope: req.scope,
          subjectId: req.subjectId,
          score: existing.next,
          updatedAt: now(),
        });
      } catch (err) {
        try {
          await store.updateReputationEvent(existing.id, { status: 'needsRecovery' });
        } catch (_err) {
          // The status write also failed; the event stays pending.
        }
        return {
          status: 'needsRecovery',
          error: `record-update-failed: ${(err && err.message) || err}`,
          event: existing,
          record: current,
        };
      }

      let ev;
      try {
        ev = await store.updateReputationEvent(existing.id, { status: 'committed' });
      } catch (err) {
        return {
          status: 'needsRecovery',
          error: `event-commit-failed: ${(err && err.message) || err}`,
          event: existing,
          record: updated,
        };
      }
      return { status: 'committed', record: updated, event: ev };
    }

    // The score moved to a value we cannot reconcile from this event alone.
    return {
      status: 'needsRecovery',
      error: 'score-diverged',
      event: existing,
      record: current,
    };
  }

  async function adjustLocked(req, gmUserId) {
    const key = `${gmUserId}:${req.requestId}`;

    const existingEvent = await store.findReputationEventByKey(key);
    if (existingEvent) {
      return finalizeExisting(existingEvent, req);
    }

    // A new event must not stack on an unresolved one for the same triple: its
    // `previous` was never applied, so a fresh `previous`/`next` built on the
    // current score would be unsafe. Refuse the mutation (manual reconciliation)
    // until the existing event is resolved through its OWN key.
    const blockingEvent = await findUnresolvedEvent(
      req.shopId,
      req.scope,
      req.subjectId
    );
    if (blockingEvent) {
      const record = await store.getReputation(req.shopId, req.scope, req.subjectId);
      return {
        status: 'needsRecovery',
        error: 'unresolved-reputation-event',
        event: blockingEvent,
        record,
      };
    }

    const nowMs = now();
    const current = await store.getReputation(req.shopId, req.scope, req.subjectId);
    const previous = current ? current.score : 0;
    const next = clampReputation(previous + req.delta);

    // Persist the pending event BEFORE changing the score.
    let eventResult;
    try {
      eventResult = await store.createReputationEvent({
        key,
        shopId: req.shopId,
        scope: req.scope,
        subjectId: req.subjectId,
        previous,
        delta: req.delta,
        next,
        reason: req.reason,
        source: req.source,
        status: 'pending',
        createdAt: nowMs,
      });
    } catch (err) {
      return { status: 'error', error: `event-create-failed: ${(err && err.message) || err}` };
    }
    const event = eventResult.record;

    // A concurrent client may have persisted the same key; never reapply.
    if (!eventResult.created) {
      return finalizeExisting(event, req);
    }

    // Apply the score change.
    let updatedRecord;
    try {
      updatedRecord = await store.upsertReputation({
        shopId: req.shopId,
        scope: req.scope,
        subjectId: req.subjectId,
        score: next,
        updatedAt: nowMs,
      });
    } catch (err) {
      try {
        await store.updateReputationEvent(event.id, { status: 'needsRecovery' });
      } catch (_err) {
        // The status write also failed; the event stays pending.
      }
      return {
        status: 'needsRecovery',
        error: `record-update-failed: ${(err && err.message) || err}`,
        event,
        record: current,
      };
    }

    // Mark the event committed only after the score is safe.
    let committedEvent;
    try {
      committedEvent = await store.updateReputationEvent(event.id, { status: 'committed' });
    } catch (err) {
      return {
        status: 'needsRecovery',
        error: `event-commit-failed: ${(err && err.message) || err}`,
        event,
        record: updatedRecord,
      };
    }
    return { status: 'committed', record: updatedRecord, event: committedEvent };
  }

  /**
   * Apply a manual GM reputation adjustment.
   *
   * `params` = { shopId, scope, subjectId, delta, reason?, requestId?, source? }.
   * `gmUserId` is the authenticated GM. The call must be GM-only: `isGM` is
   * checked before any read/write. The request is idempotent on
   * `${gmUserId}:${requestId}` - a matching replay never reapplies the delta, and
   * the same key with a different subject/delta/reason is rejected as a conflict.
   * A pending/needsRecovery event replay only restores the score when the current
   * score still matches the event's exact `previous`/`next` (see module header);
   * otherwise it returns `needsRecovery` `score-diverged` without writing, and a
   * new event is likewise refused while an unresolved event exists for the triple.
   */
  async function adjust(params = {}, gmUserId) {
    if (!isGM(gmUserId)) {
      return { status: 'error', error: 'not-a-gm' };
    }

    let req;
    try {
      req = normalizeAdjustParams(params);
    } catch (err) {
      return { status: 'error', error: err.message };
    }

    let shop;
    try {
      shop = await store.findShop(req.shopId);
    } catch (err) {
      return { status: 'error', error: `shop-read-failed: ${(err && err.message) || err}` };
    }
    if (!shop) return { status: 'error', error: 'shop-not-found' };

    try {
      return await runShopExclusive(req.shopId, () => adjustLocked(req, gmUserId));
    } catch (err) {
      return { status: 'error', error: `adjust-failed: ${(err && err.message) || err}` };
    }
  }

  /**
   * Load the effective reputation for an actor against a shop, blending the
   * actor record with the shop party record only when `shop.social.partyId` is
   * non-empty. Uses the pure `effectiveReputation` + `reputationBand`.
   */
  async function getEffective(shop, actorUuid) {
    const shopId = shop?.id;
    if (!shopId) {
      throw new Error('[market] getEffective requires a shop with an id');
    }
    const actorRecord = await store.getReputation(shopId, 'actor', actorUuid);
    const partyId = shop?.social?.partyId || '';
    const partyRecord = partyId
      ? await store.getReputation(shopId, 'party', partyId)
      : null;
    const individual = clampReputation(actorRecord?.score ?? 0);
    const party = clampReputation(partyRecord?.score ?? 0);
    const score = effectiveReputation(individual, party, {
      individualWeight: shop?.social?.individualWeight ?? 70,
      partyWeight: shop?.social?.partyWeight ?? 30,
      partyId,
    });
    return {
      score,
      band: reputationBand(score),
      individual,
      party,
      partyId,
    };
  }

  return { adjust, getEffective };
}

export default createReputationService;
