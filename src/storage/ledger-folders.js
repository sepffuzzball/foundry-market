// Ledger folder organizer.
//
// The market keeps one GM-only JournalEntry per purchase ledger record. This
// module maintains a canonical, GM-side folder hierarchy under a single root
// folder ("Market Ledgers") and moves each ledger journal into the child folder
// matching its current status:
//
//   committed     -> Success
//   failed        -> Failure
//   pending       -> Pending
//   needsRecovery -> Needs Recovery
//
// The hierarchy is only ever read/created/mutated by the active GM. Folder
// creation is serialized on a local promise queue so concurrent organizes never
// create a duplicate hierarchy, and folders are located by document type +
// exact `flags.market.ledgerRole` + exact parent id - never by name - so an
// unrelated folder that happens to be named "Success" (or "Market Ledgers") is
// never reused.
//
// This module is intentionally free of any Foundry global; the live `game.folders`
// collection and the Folder document class are injected, so it can be exercised
// under Node against a fake in-memory collection.

const FOLDER_TYPE = 'JournalEntry';
const SCOPE = 'market';
const LEDGER_KIND = 'ledger';

export const LEDGER_FOLDER_ROLES = {
  root: 'ledger-root',
  success: 'ledger-success',
  failure: 'ledger-failure',
  pending: 'ledger-pending',
  needsRecovery: 'ledger-needs-recovery',
};

const ROOT_NAME = 'Market Ledgers';

// Status -> child folder role.
const STATUS_ROLE = {
  committed: LEDGER_FOLDER_ROLES.success,
  failed: LEDGER_FOLDER_ROLES.failure,
  pending: LEDGER_FOLDER_ROLES.pending,
  needsRecovery: LEDGER_FOLDER_ROLES.needsRecovery,
};

// Child folder display name per role.
const ROLE_NAME = {
  [LEDGER_FOLDER_ROLES.success]: 'Success',
  [LEDGER_FOLDER_ROLES.failure]: 'Failure',
  [LEDGER_FOLDER_ROLES.pending]: 'Pending',
  [LEDGER_FOLDER_ROLES.needsRecovery]: 'Needs Recovery',
};

export const LEDGER_FOLDER_STATUSES = Object.keys(STATUS_ROLE);

/**
 * Resolve the folder id on a journal document. Prefers the raw source folder
 * (`_source.folder`) so even a stale/legacy object with no live parent document
 * reports its persisted folder, and falls back to the resolved `folder` field
 * (`doc.folder?.id` / `doc.folder?._id`, or a raw string id). Returns null when
 * the journal has no folder.
 */
export function journalFolderId(doc) {
  if (!doc) return null;
  const sourceFolder = doc._source?.folder;
  if (sourceFolder != null) return sourceFolder;
  const folder = doc.folder;
  if (folder == null) return null;
  if (typeof folder === 'string') return folder;
  return folder?.id ?? folder?._id ?? null;
}

/**
 * Build a ledger folder organizer for a single client.
 *
 * @param {object} opts
 * @param {object} opts.folders Live Folder collection (filter/get/iterable).
 * @param {object} opts.FolderClass Folder document class with static `create`.
 * @param {() => boolean} [opts.isActiveGM] Whether this client's user is the
 *   active GM; re-checked before every read/create/move.
 * @param {object} [opts.logger] Logger for warning on a failed creation.
 * @returns {{ organize(doc, status): Promise<string|null>, journalFolderId(doc): string|null,
 *            flush(): Promise<void> }}
 */
export function createLedgerFolderOrganizer({
  folders,
  FolderClass,
  isActiveGM = () => true,
  logger = console,
}) {
  // Local serialization queue. Every folder create runs through this promise
  // chain so two concurrent organizes can never both create the root (or the
  // same child) hierarchy.
  let queue = Promise.resolve();

  // Per-journal serialization. Organizes for the SAME journal run one at a time,
  // in addition to the folder-create queue. This guarantees a pending organize
  // racing a concurrent committed update resolves in a well-defined order, so the
  // final folder always reflects the latest persisted status (never a stale one).
  const journalQueues = new Map();

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // Key a journal's serialization on its stable id (never the object identity)
  // when one is available, so two accesses to the same persisted journal - even
  // through distinct document objects - share a single queue. Fall back to the
  // document reference only for a journal with no id.
  function journalKey(doc) {
    const id = doc?.id ?? doc?._id;
    return id != null ? `id:${id}` : doc;
  }

  function enqueueJournal(doc, task) {
    const key = journalKey(doc);
    const prev = journalQueues.get(key) || Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    journalQueues.set(key, tail);
    // Drop the entry once it settles so the map never grows unbounded. A later
    // organize for the same journal starts a fresh, already-completed chain.
    tail.then(() => {
      if (journalQueues.get(key) === tail) journalQueues.delete(key);
    });
    return run;
  }

  // Read the LIVE persisted status off the journal's market flags. Returns null
  // when it is absent or not a recognized ledger status, so the caller falls back
  // to the status argument rather than trusting a possibly-stale value.
  function currentStatusOf(doc) {
    const status = doc?.flags?.[SCOPE]?.record?.status;
    return STATUS_ROLE[status] ? status : null;
  }

  // A journal with no `flags.market.kind` (the organizer is exercised against bare
  // test docs) is treated as a ledger; an explicit non-ledger kind is never moved.
  function isLedgerDoc(doc) {
    const kind = doc?.flags?.[SCOPE]?.kind;
    return kind === undefined || kind === LEDGER_KIND;
  }

  function allFolders() {
    if (Array.isArray(folders)) return folders.slice();
    if (folders && typeof folders.filter === 'function') return folders.filter(() => true);
    if (folders && typeof folders[Symbol.iterator] === 'function') return Array.from(folders);
    return [];
  }

  function folderParentId(folder) {
    const f = folder?.folder;
    if (f == null) return null;
    if (typeof f === 'string') return f;
    return f?.id ?? f?._id ?? null;
  }

  function findFolderByRole(role, parentId) {
    return (
      allFolders().find(
        (f) =>
          f &&
          f.type === FOLDER_TYPE &&
          f.flags?.[SCOPE]?.ledgerRole === role &&
          folderParentId(f) === parentId
      ) || null
    );
  }

  /**
   * Ensure a single folder with a given role/parent exists, creating it only
   * when the current user is still the active GM. Serialized on the queue. On
   * success returns the folder id, otherwise null (no active GM, no FolderClass,
   * or a create that returned nothing).
   */
  function ensureFolder({ name, role, parentId }) {
    return enqueue(async () => {
      if (!isActiveGM()) return null;
      const existing = findFolderByRole(role, parentId);
      if (existing) return existing.id;
      if (!FolderClass || typeof FolderClass.create !== 'function') {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('[market] FolderClass.create unavailable for ledger folder', role);
        }
        return null;
      }
      let created;
      try {
        created = await FolderClass.create({
          name,
          type: FOLDER_TYPE,
          folder: parentId || null,
          flags: { [SCOPE]: { ledgerRole: role } },
        });
      } catch (err) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('[market] ledger folder create failed', role, err);
        }
        return null;
      }
      // Re-check the active GM and re-scan after the await: a GM handover (or a
      // concurrent create) must never leave us trusting a folder that is no
      // longer canonical.
      if (!isActiveGM()) return null;
      const after = findFolderByRole(role, parentId);
      return (after && after.id) || created?.id || null;
    });
  }

  /**
   * Place `doc` into the folder matching `status`, creating the root/child
   * hierarchy as needed. No-ops (returns null) for a non-active GM, for a
   * non-ledger journal, or when the journal is already in the correct folder.
   * Throws on an unknown status.
   *
   * The whole placement is serialized PER JOURNAL (in addition to the shared
   * folder-create queue), so a pending organize racing a concurrent committed
   * update resolves in a deterministic order. Immediately before the move the
   * LIVE persisted status is re-read from the journal's own flags and the target
   * is recomputed, so a status that changed while the folder hierarchy was being
   * created is honoured and the final folder can never lag a committed state.
   */
  async function organize(doc, status) {
    // Validate the caller-supplied status so an unknown status still throws (the
    // documented contract). The live record is only consulted from here on.
    const initialRole = STATUS_ROLE[status];
    if (!initialRole) {
      throw new Error(`[market] unknown ledger status '${status}' for folder placement`);
    }
    if (!isActiveGM()) return null;
    if (!isLedgerDoc(doc)) return null;

    return enqueueJournal(doc, async () => {
      if (!isActiveGM()) return null;
      if (!isLedgerDoc(doc)) return null;

      const rootId = await ensureFolder({
        name: ROOT_NAME,
        role: LEDGER_FOLDER_ROLES.root,
        parentId: null,
      });
      if (!rootId) return null;

      // Prefer the LIVE status; fall back to the caller status only when none is
      // valid. This read happens before the move so a concurrent status change is
      // never resolved against a stale target.
      const liveStatus = currentStatusOf(doc);
      const role = liveStatus ? STATUS_ROLE[liveStatus] : initialRole;
      if (!role) return null;

      const childId = await ensureFolder({
        name: ROLE_NAME[role],
        role,
        parentId: rootId,
      });
      if (!childId) return null;

      if (!isActiveGM()) return null;
      if (!isLedgerDoc(doc)) return null;

      // Re-read immediately before the move. If the status changed while the
      // child folder was being created, recompute the target and ensure the new
      // (correct) folder exists before moving, so a committed status is never
      // left stranded in a Pending folder.
      const finalStatus = currentStatusOf(doc);
      if (finalStatus) {
        const finalRole = STATUS_ROLE[finalStatus];
        if (finalRole && finalRole !== role) {
          const finalChildId = await ensureFolder({
            name: ROLE_NAME[finalRole],
            role: finalRole,
            parentId: rootId,
          });
          if (!finalChildId) return null;
          if (!isActiveGM()) return null;
          if (!isLedgerDoc(doc)) return null;
          if (journalFolderId(doc) === finalChildId) return null;
          await doc.update({ folder: finalChildId });
          return finalChildId;
        }
      }

      // Already in the target folder: a no-op (returns null), never a second
      // `doc.update`.
      if (journalFolderId(doc) === childId) return null;

      await doc.update({ folder: childId });
      return childId;
    });
  }

  /**
   * Resolve once every queued placement (folder-creates and per-journal
   * organizes) has settled. Best-effort; used by the test harness to await the
   * store's fire-and-forget organizes deterministically. Never throws.
   */
  function flush() {
    const tails = [queue];
    for (const tail of journalQueues.values()) tails.push(tail);
    return Promise.all(tails).then(() => undefined);
  }

  return { organize, journalFolderId, flush };
}
