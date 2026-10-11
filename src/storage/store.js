// Persistence for the market core.
//
// Every location, shop and ledger record is stored in the flag data of its own
// dedicated GM-only JournalEntry. The journals are created by the GM and are
// never added to a player-visible folder, so players never see them in the
// Journal sidebar; only the market code reads and writes them.
//
// The record shape within `flags.market` is:
//   { schemaVersion, kind: 'location'|'shop'|'ledger', record: {...} }
//
// All stores go through an injectable `docAccess` adapter so Node tests can
// drive the real logic against an in-memory document store.

import {
  SCHEMA_VERSION,
  LOCATION_KIND,
  SHOP_KIND,
  LEDGER_KIND,
  REPUTATION_KIND,
  REPUTATION_EVENT_KIND,
  ADVANCED_ORDER_KIND,
  LEDGER_STATUSES,
  normalizeLocation,
  normalizeShop,
  normalizeInventoryEntry,
  normalizeLedgerRecord,
  normalizeReputation,
  normalizeReputationEvent,
  normalizeAdvancedOrder,
  makeId,
} from '../services/model.js';
import { createLedgerFolderOrganizer, journalFolderId } from './ledger-folders.js';

const SCOPE = 'market';

function flagScope(doc) {
  return doc?.flags?.[SCOPE];
}

/**
 * Default document-access implementation backed by Foundry's journal
 * collection. Referenced lazily so importing this module under Node never
 * touches `game`.
 */
function defaultDocAccess() {
  // The ledger folder organizer is built lazily, on first use, so importing this
  // module under Node never touches `game`/`globalThis.Folder`. It is only ever
  // reached once the runtime is live and a ledger journal exists.
  let organizer = null;
  function getOrganizer() {
    if (organizer) return organizer;
    organizer = createLedgerFolderOrganizer({
      folders: globalThis.game?.folders,
      FolderClass: globalThis.game?.folders?.documentClass || globalThis.Folder,
      // The active-GM predicate must fail closed (return false) on an absent
      // `game` global rather than throw: the best-effort ledger folder arrange is
      // launched fire-and-forget after the ledger write, so it can settle AFTER
      // the runtime tears `game` down (between persistence and the scheduled
      // background task). Every access is guarded with optional chaining so this
      // closure never throws - it simply reports "not the active GM".
      isActiveGM: () =>
        !!globalThis.game?.user &&
        !!globalThis.game?.user?.isGM &&
        globalThis.game?.user?.id === (globalThis.game?.users?.activeGM?.id ?? null),
      logger: console,
    });
    return organizer;
  }
  return {
    async listJournalEntries() {
      return game.journal.filter((e) => flagScope(e)?.schemaVersion === SCHEMA_VERSION);
    },
    // Enumerate EVERY ledger journal regardless of schema version, so a legacy
    // (schema-v0) ledger journal is still picked up by the folder sweep.
    async listLedgerJournals() {
      return game.journal.filter((e) => flagScope(e)?.kind === LEDGER_KIND);
    },
    async getJournalEntry(id) {
      return game.journal.get(id);
    },
    async createJournalEntry({ name, flags }) {
      // Explicitly GM-only: players get no read permission (`default: 0`),
      // so the market's internal journals never leak into the player sidebar
      // even if they are not placed in a player-hidden folder.
      // Use the document class static `create` (Foundry V14) rather than the
      // collection `.create`, so this works regardless of collection shape.
      const DocumentClass = game.journal?.documentClass || globalThis.JournalEntry;
      return DocumentClass.create({ name, flags, ownership: { default: 0 } });
    },
    async updateJournalEntry(doc, patch) {
      return doc.update(patch);
    },
    async organizeLedgerJournal(doc, status) {
      return getOrganizer().organize(doc, status);
    },
  };
}

export function createStore(docAccess) {
  async function listRecords(kind) {
    const docs = await docAccess.listJournalEntries();
    const out = [];
    for (const doc of docs) {
      const f = flagScope(doc);
      if (f?.kind === kind) out.push(normalizeRecordForKind(kind, f.record));
    }
    return out;
  }

  function normalizeRecordForKind(kind, record) {
    if (!record) return null;
    switch (kind) {
      case LOCATION_KIND:
        return normalizeLocation(record);
      case SHOP_KIND:
        return normalizeShop(record);
      case LEDGER_KIND:
        return normalizeLedgerRecord(record);
      case REPUTATION_KIND:
        return normalizeReputation(record);
      case REPUTATION_EVENT_KIND:
        return normalizeReputationEvent(record);
      case ADVANCED_ORDER_KIND:
        return normalizeAdvancedOrder(record);
      default:
        return record;
    }
  }

  async function findJournalByKindAndId(kind, id) {
    const docs = await docAccess.listJournalEntries();
    return (
      docs.find((doc) => {
        const f = flagScope(doc);
        return f?.kind === kind && f.record?.id === id;
      }) || null
    );
  }

  async function findRecordByKindAndId(kind, id) {
    if (!id) return null;
    const doc = await findJournalByKindAndId(kind, id);
    return doc ? normalizeRecordForKind(kind, flagScope(doc).record) : null;
  }

  async function insertRecord(kind, record, name) {
    const flags = { [SCOPE]: { schemaVersion: SCHEMA_VERSION, kind, record } };
    const doc = await docAccess.createJournalEntry({
      name: name || record.name || kind,
      flags,
    });
    // Only the ledger journals are organized into the GM-side folder hierarchy.
    // A folder failure is never allowed to fail the persistence: the record is
    // stored, and the journal is left un-filed (the ready sweep recovers it).
    // The organize is launched best-effort and NEVER awaited - a folder
    // create/move that never settles or throws must not delay or fail the ledger
    // write, so the record is returned immediately.
    if (kind === LEDGER_KIND && typeof docAccess.organizeLedgerJournal === 'function') {
      const status = record.status;
      Promise.resolve()
        .then(() => docAccess.organizeLedgerJournal(doc, status))
        .catch((err) => console.warn('[market] ledger folder organize failed on create', err));
    }
    const stored = flagScope(doc)?.record;
    return normalizeRecordForKind(kind, stored ?? record);
  }

  async function updateRecord(kind, id, nextRecord, name) {
    const doc = await findJournalByKindAndId(kind, id);
    if (!doc) return null;
    const flags = { schemaVersion: SCHEMA_VERSION, kind, record: nextRecord };
    await docAccess.updateJournalEntry(doc, { flags: { [SCOPE]: flags } });
    return normalizeRecordForKind(kind, nextRecord);
  }

  async function listLocations() {
    return listRecords(LOCATION_KIND);
  }

  async function createLocation(data = {}) {
    const record = normalizeLocation(data);
    return insertRecord(LOCATION_KIND, record, record.name);
  }

  async function updateLocation(id, patch = {}) {
    const existing = await findRecordByKindAndId(LOCATION_KIND, id);
    if (!existing) return null;
    const record = normalizeLocation({ ...existing, ...patch });
    return updateRecord(LOCATION_KIND, id, record, record.name);
  }

  async function listShops({ locationId } = {}) {
    const shops = await listRecords(SHOP_KIND);
    if (locationId) return shops.filter((s) => s.locationId === locationId);
    return shops;
  }

  async function createShop(data = {}) {
    const record = normalizeShop(data);
    return insertRecord(SHOP_KIND, record, record.name);
  }

  async function findShop(id) {
    return findRecordByKindAndId(SHOP_KIND, id);
  }

  async function updateShop(id, patch = {}) {
    const existing = await findShop(id);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    // A supplied `npcs` array must be a real array before `normalizeShop` can
    // consume it; reject a scalar instead of silently treating it as empty.
    if (patch.npcs !== undefined && !Array.isArray(patch.npcs)) {
      throw new Error('[market] shop.npcs must be an array');
    }
    // When a caller supplies a new `npcs` array without an explicit `owner`,
    // derive the owner from the new primary NPC BEFORE `normalizeShop`. Without
    // this, `resolveNpcs` re-applies the stale persisted `owner` string onto
    // `npcs[0].name`, silently overwriting a primary-NPC rename made through the
    // store API when the persisted owner still carries the old name. An explicit
    // `patch.owner` always wins.
    if (patch.npcs !== undefined && patch.owner === undefined) {
      next.owner = patch.npcs.length > 0 ? String(patch.npcs[0]?.name || '') : '';
    }
    const record = normalizeShop(next);
    return updateRecord(SHOP_KIND, id, record, record.name);
  }

  async function addInventoryEntry(shopId, entryData = {}) {
    const existing = await findShop(shopId);
    if (!existing) return null;
    const entry = normalizeInventoryEntry(entryData);
    const inventory = [...existing.inventory, entry];
    const record = normalizeShop({ ...existing, inventory });
    await updateRecord(SHOP_KIND, shopId, record, record.name);
    return entry;
  }

  // --- Ledger ----------------------------------------------------------------
  // The ledger is a separate set of GM-only JournalEntries, one per purchase
  // request, keyed for idempotency by `${userId}:${requestId}`.

  async function listLedgers() {
    return listRecords(LEDGER_KIND).map((r) => r);
  }

  async function findLedgerByKey(key) {
    const records = await listRecords(LEDGER_KIND);
    return records.find((r) => r.key === key) || null;
  }

  async function createLedger(record) {
    const normalized = normalizeLedgerRecord(record);
    // Ledger records are keyed by idempotency key, so never create a second
    // record for an existing key (prevents duplicate JournalEntries on a race).
    // Returns `{ record, created }` so callers can tell whether their key
    // already existed (and must NOT charge) versus was newly persisted.
    const existing = await findLedgerByKey(normalized.key);
    if (existing) return { record: existing, created: false };
    const created = await insertRecord(LEDGER_KIND, normalized, `Ledger: ${normalized.key}`);
    return { record: created, created: true };
  }

  async function updateLedger(id, patch = {}) {
    const doc = await findJournalByKindAndId(LEDGER_KIND, id);
    if (!doc) return null;
    const current = normalizeLedgerRecord(flagScope(doc).record);
    const next = normalizeLedgerRecord({ ...current, ...patch });
    const flags = { schemaVersion: SCHEMA_VERSION, kind: LEDGER_KIND, record: next };
    await docAccess.updateJournalEntry(doc, { flags: { [SCOPE]: flags } });
    // First write the flags, then file the journal into its status folder. The
    // organize is launched best-effort and NEVER awaited: a folder error or a
    // never-settling move must never turn a committed ledger write into an error
    // or a compensation - the status is already persisted; the folder is
    // best-effort and the ready sweep / handover sweep recovers it.
    if (typeof docAccess.organizeLedgerJournal === 'function') {
      const status = next.status;
      Promise.resolve()
        .then(() => docAccess.organizeLedgerJournal(doc, status))
        .catch((err) => console.warn('[market] ledger folder organize failed on update', err));
    }
    return next;
  }

  // --- Reputation --------------------------------------------------------------
  // GM-owned, per-entity reputation records and an append-only event log. Each
  // reputation record and each event is stored in its OWN GM-only JournalEntry
  // (mirroring the ledger), so there is no unbounded embedded history and no
  // schema version bump. Records are keyed by the (shopId, scope, subjectId)
  // triple; events are keyed by their idempotency `key`.

  function reputationJournalName(record) {
    return `Reputation: ${record.shopId} ${record.scope}:${record.subjectId}`;
  }

  async function getReputation(shopId, scope, subjectId) {
    const records = await listRecords(REPUTATION_KIND);
    return (
      records.find(
        (r) => r.shopId === shopId && r.scope === scope && r.subjectId === subjectId
      ) || null
    );
  }

  async function upsertReputation(record) {
    const normalized = normalizeReputation(record);
    const existing = await getReputation(
      normalized.shopId,
      normalized.scope,
      normalized.subjectId
    );
    if (existing) {
      // Preserve the persisted id on an update; never create a second record.
      const next = normalizeReputation({ ...normalized, id: existing.id });
      return updateRecord(REPUTATION_KIND, existing.id, next, reputationJournalName(next));
    }
    return insertRecord(REPUTATION_KIND, normalized, reputationJournalName(normalized));
  }

  async function findReputationEventByKey(key) {
    const events = await listRecords(REPUTATION_EVENT_KIND);
    return events.find((e) => e.key === key) || null;
  }

  async function createReputationEvent(record) {
    const normalized = normalizeReputationEvent(record);
    // Keyed by idempotency key; never create a second event for an existing key
    // (prevents duplicate JournalEntries on a race). Returns `{ record, created }`
    // so callers can tell whether their key already existed.
    const existing = await findReputationEventByKey(normalized.key);
    if (existing) return { record: existing, created: false };
    const created = await insertRecord(
      REPUTATION_EVENT_KIND,
      normalized,
      `Reputation Event: ${normalized.key}`
    );
    return { record: created, created: true };
  }

  async function updateReputationEvent(id, patch = {}) {
    const doc = await findJournalByKindAndId(REPUTATION_EVENT_KIND, id);
    if (!doc) return null;
    const current = normalizeReputationEvent(flagScope(doc).record);
    const next = normalizeReputationEvent({ ...current, ...patch });
    const flags = { schemaVersion: SCHEMA_VERSION, kind: REPUTATION_EVENT_KIND, record: next };
    await docAccess.updateJournalEntry(doc, { flags: { [SCOPE]: flags } });
    return next;
  }

  async function listReputationEvents({ shopId, scope, subjectId } = {}) {
    let events = await listRecords(REPUTATION_EVENT_KIND);
    if (shopId != null) events = events.filter((e) => e.shopId === shopId);
    if (scope != null) events = events.filter((e) => e.scope === scope);
    if (subjectId != null) events = events.filter((e) => e.subjectId === subjectId);
    return events.sort((a, b) => b.createdAt - a.createdAt);
  }

  // --- Advanced commerce orders (M5) ---------------------------------------
  // GM-owned, idempotent order records for the later M5 operations (bookable
  // services, preorder execution, theft, specials and funds-aware buying). Each
  // order is stored in its OWN GM-only JournalEntry (mirroring the ledger and
  // reputation records), never embedded in the shop record, with no schema
  // version bump - `SCHEMA_VERSION` stays `1`. Orders are keyed by their
  // idempotency `key`, so a replayed `createAdvancedOrder` for the same key
  // never creates a second JournalEntry (a caller that replays is expected to
  // verify the `intentHash` before applying any side effect). No cross-GM
  // atomicity is claimed: this is a read-then-create, not a server-side CAS.

  async function findAdvancedOrderByKey(key) {
    const records = await listRecords(ADVANCED_ORDER_KIND);
    return records.find((r) => r.key === key) || null;
  }

  async function findAdvancedOrder(id) {
    return findRecordByKindAndId(ADVANCED_ORDER_KIND, id);
  }

  async function listAdvancedOrders(
    { shopId, actorId, status, kind, limit = 100, offset = 0 } = {}
  ) {
    let records = await listRecords(ADVANCED_ORDER_KIND);
    if (shopId != null) records = records.filter((r) => r.shopId === shopId);
    if (actorId != null) records = records.filter((r) => r.actorId === actorId);
    if (status != null) records = records.filter((r) => r.status === status);
    if (kind != null) records = records.filter((r) => r.kind === kind);
    records = records.sort((a, b) => b.createdAt - a.createdAt);
    // Newest first, and the result set is always bounded to at most 100 records
    // (the documented cap). Callers may optionally pass a `limit`/`offset` for
    // paging, but `limit` is clamped to the 100-record ceiling and non-positive
    // values collapse to an empty page rather than a runaway slice.
    const safeLimit = Math.max(0, Math.min(limit, 100));
    const safeOffset = Math.max(0, offset);
    return records.slice(safeOffset, safeOffset + safeLimit);
  }

  async function createAdvancedOrder(record) {
    const normalized = normalizeAdvancedOrder(record);
    // Keyed by idempotency key; never create a second order for an existing key
    // (prevents duplicate JournalEntries on a race). Returns `{ record, created }`
    // so callers can tell whether their key already existed.
    const existing = await findAdvancedOrderByKey(normalized.key);
    if (existing) return { record: existing, created: false };
    const created = await insertRecord(
      ADVANCED_ORDER_KIND,
      normalized,
      `Advanced Order: ${normalized.key}`
    );
    return { record: created, created: true };
  }

  async function updateAdvancedOrder(id, patch = {}) {
    const doc = await findJournalByKindAndId(ADVANCED_ORDER_KIND, id);
    if (!doc) return null;
    const current = normalizeAdvancedOrder(flagScope(doc).record);
    const nextRaw = { ...current, ...patch };
    // Immutable fields: a patch may not change key/kind/shopId/actorId/userId/
    // intentHash/createdAt. They are forced back to the persisted values.
    nextRaw.key = current.key;
    nextRaw.kind = current.kind;
    nextRaw.shopId = current.shopId;
    nextRaw.actorId = current.actorId;
    nextRaw.userId = current.userId;
    nextRaw.intentHash = current.intentHash;
    nextRaw.createdAt = current.createdAt;
    nextRaw.updatedAt = patch.updatedAt ?? Date.now();
    const next = normalizeAdvancedOrder(nextRaw);
    const flags = { schemaVersion: SCHEMA_VERSION, kind: ADVANCED_ORDER_KIND, record: next };
    await docAccess.updateJournalEntry(doc, { flags: { [SCOPE]: flags } });
    return next;
  }

  // --- Ledger folder sweep ---------------------------------------------------
  // Best-effort, GM-only reconciliation of existing ledger journals into their
  // canonical status folders, run once at startup by the active GM (and safe to
  // re-run). The active-GM predicate is re-checked before the read and before
  // each organize, and a handover stops the sweep cleanly. Returns a bounded
  // summary, never throws.

  async function organizeLedgerJournals({ isActiveGM } = {}) {
    const active = typeof isActiveGM === 'function' ? isActiveGM : () => true;
    if (!active()) return { status: 'idle', moved: 0, failed: 0, skipped: 0 };

    const organize = docAccess.organizeLedgerJournal;
    if (typeof organize !== 'function') {
      return { status: 'idle', moved: 0, failed: 0, skipped: 0 };
    }
    // Prefer the ledger-wide enumeration (all schema versions) so legacy schema
    // journals are swept too; fall back to the schema-V1-only list.
    const listFn =
      typeof docAccess.listLedgerJournals === 'function'
        ? docAccess.listLedgerJournals
        : docAccess.listJournalEntries;

    if (!active()) return { status: 'idle', moved: 0, failed: 0, skipped: 0 };
    let docs;
    try {
      docs = await listFn();
    } catch (err) {
      console.warn('[market] ledger folder sweep read failed', err);
      return { status: 'error', moved: 0, failed: 0, skipped: 0 };
    }

    let moved = 0;
    let failed = 0;
    let skipped = 0;
    for (const doc of docs) {
      if (!active()) break;
      const f = flagScope(doc);
      if (f?.kind !== LEDGER_KIND) {
        skipped += 1;
        continue;
      }
      const status = f?.record?.status;
      if (!LEDGER_STATUSES.includes(status)) {
        skipped += 1;
        continue;
      }
      const before = journalFolderId(doc);
      try {
        await organize(doc, status);
        const after = journalFolderId(doc);
        if (after != null && after !== before) moved += 1;
        else skipped += 1;
      } catch (err) {
        failed += 1;
        console.warn('[market] ledger folder organize failed in sweep', err);
      }
    }
    return { status: 'ok', moved, failed, skipped };
  }

  return {
    listLocations,
    createLocation,
    updateLocation,
    listShops,
    createShop,
    updateShop,
    addInventoryEntry,
    findShop,
    listLedgers,
    findLedgerByKey,
    createLedger,
    updateLedger,
    getReputation,
    upsertReputation,
    findReputationEventByKey,
    createReputationEvent,
    updateReputationEvent,
    listReputationEvents,
    findAdvancedOrderByKey,
    findAdvancedOrder,
    listAdvancedOrders,
    createAdvancedOrder,
    updateAdvancedOrder,
    organizeLedgerJournals,
    // Utility used by tests and the runtime to create ids.
    makeId,
  };
}

// The default store instance used at runtime. It wires document access to the
// live game API lazily; no global is touched here.
export const store = createStore(defaultDocAccess());
export default store;
