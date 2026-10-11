// Ledger folder organizer unit tests.
//
// The organizer (`src/storage/ledger-folders.js`) is deliberately free of any
// Foundry global - the live `game.folders` collection and the Folder document class
// are injected - so it is exercised here against a fake in-memory folder
// collection and a fake doc. These tests pin the canonical hierarchy, the
// status-to-role mapping, folder location by type + role + parent (never by
// name), the serialized create queue, the active-GM rechecks, and the `organize`
// return contract (target folder id / null no-op / throw on unknown status).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLedgerFolderOrganizer,
  journalFolderId,
  LEDGER_FOLDER_ROLES,
  LEDGER_FOLDER_STATUSES,
} from '../src/storage/ledger-folders.js';

const FOLDER_TYPE = 'JournalEntry';
const SCOPE = 'market';

// Returns `{ folders, data, FolderClass }` where `folders` and `data` both alias
// the live (mutable) folder array the organizer scans, and `FolderClass.create`
// records creates into that same array.
function makeFolders() {
  const folders = [];
  let seq = 0;
  return {
    folders,
    data: folders,
    FolderClass: {
      create: async (data) => {
        const id = `folder-${++seq}`;
        const folder = {
          id,
          name: data.name,
          type: data.type,
          folder: data.folder ?? null,
          flags: data.flags,
        };
        folders.push(folder);
        return folder;
      },
    },
  };
}

function folderParentIdOf(folder) {
  const p = folder?.folder;
  if (p == null) return null;
  if (typeof p === 'string') return p;
  return p?.id ?? p?._id ?? null;
}

function findByRole(folders, role) {
  return (
    folders.find(
      (f) =>
        f.type === FOLDER_TYPE &&
        f.flags?.[SCOPE]?.ledgerRole === role
    ) || null
  );
}

function findByRoleAndParent(folders, role, parentId) {
  return (
    folders.find(
      (f) =>
        f.type === FOLDER_TYPE &&
        f.flags?.[SCOPE]?.ledgerRole === role &&
        folderParentIdOf(f) === parentId
    ) || null
  );
}

function makeDoc({ folder = null } = {}) {
  const doc = {
    _source: { folder },
    updated: [],
    update(patch) {
      if (patch && patch.folder !== undefined) this._source.folder = patch.folder;
      this.updated.push(patch);
      return this;
    },
  };
  return doc;
}

function organizerFor(setup, { isActiveGM = () => true } = {}) {
  return createLedgerFolderOrganizer({
    folders: setup.folders,
    FolderClass: setup.FolderClass,
    isActiveGM,
    logger: { warn: () => {} },
  });
}

test('LEDGER_FOLDER_STATUSES matches the documented status->role mapping', () => {
  assert.deepEqual(
    LEDGER_FOLDER_STATUSES.slice().sort(),
    ['committed', 'failed', 'needsRecovery', 'pending']
  );
});

test('journalFolderId prefers _source.folder over the resolved folder field', () => {
  const doc = makeDoc({ folder: 'src-folder' });
  doc.folder = { id: 'resolved-folder' };
  assert.equal(journalFolderId(doc), 'src-folder');
});

test('journalFolderId falls back to the resolved folder field', () => {
  const doc = makeDoc();
  doc.folder = { id: 'resolved-folder' };
  assert.equal(journalFolderId(doc), 'resolved-folder');
  const strDoc = makeDoc();
  strDoc.folder = 'raw-string-id';
  assert.equal(journalFolderId(strDoc), 'raw-string-id');
});

test('journalFolderId returns null for a doc with no folder', () => {
  assert.equal(journalFolderId(makeDoc()), null);
  assert.equal(journalFolderId(null), null);
});

test('organize creates the root and status child and moves the doc', async () => {
  const setup = makeFolders();
  const organizer = organizerFor(setup);
  const doc = makeDoc();
  const target = await organizer.organize(doc, 'pending');

  const root = findByRole(setup.folders, LEDGER_FOLDER_ROLES.root);
  assert.ok(root, 'root folder created');
  assert.equal(root.name, 'Market Ledgers');
  assert.equal(root.type, FOLDER_TYPE);
  assert.equal(root.flags?.[SCOPE]?.ledgerRole, LEDGER_FOLDER_ROLES.root);

  const child = findByRoleAndParent(setup.folders, LEDGER_FOLDER_ROLES.pending, root.id);
  assert.ok(child, 'pending child folder created under root');
  assert.equal(child.name, 'Pending');
  assert.equal(child.folder, root.id);

  assert.equal(target, child.id);
  assert.equal(journalFolderId(doc), child.id, 'doc moved into the pending folder');
  assert.deepEqual(doc.updated, [{ folder: child.id }]);
});

test('organize reuses an existing folder located by role + parent, not by name', async () => {
  const setup = makeFolders();
  // An unrelated folder named "Market Ledgers" that is NOT the ledger root
  // (wrong role) must not be reused.
  setup.folders.push({
    id: 'decorative-root',
    name: 'Market Ledgers',
    type: FOLDER_TYPE,
    folder: null,
    flags: {},
  });
  const organizer = organizerFor(setup);
  const doc = makeDoc();
  const target = await organizer.organize(doc, 'failed');

  const root = findByRole(setup.folders, LEDGER_FOLDER_ROLES.root);
  assert.notEqual(root.id, 'decorative-root', 'a same-named unrelated folder is not reused');
  assert.equal(setup.folders.filter((f) => f.name === 'Market Ledgers').length, 2);
  assert.ok(target, 'doc moved into the real root/child');
});

test('organize is a no-op (null) when the journal is already in the target folder', async () => {
  const setup = makeFolders();
  const root = await setup.FolderClass.create({
    name: 'Market Ledgers',
    type: FOLDER_TYPE,
    folder: null,
    flags: { [SCOPE]: { ledgerRole: LEDGER_FOLDER_ROLES.root } },
  });
  const success = await setup.FolderClass.create({
    name: 'Success',
    type: FOLDER_TYPE,
    folder: root.id,
    flags: { [SCOPE]: { ledgerRole: LEDGER_FOLDER_ROLES.success } },
  });
  const organizer = organizerFor(setup);
  const doc = makeDoc({ folder: success.id });
  const result = await organizer.organize(doc, 'committed');
  assert.equal(result, null, 'already in the target folder is a no-op');
  assert.deepEqual(doc.updated, [], 'no doc.update is issued');
});

test('organize maps every status to the correct child role', async () => {
  const cases = [
    ['committed', LEDGER_FOLDER_ROLES.success, 'Success'],
    ['failed', LEDGER_FOLDER_ROLES.failure, 'Failure'],
    ['pending', LEDGER_FOLDER_ROLES.pending, 'Pending'],
    ['needsRecovery', LEDGER_FOLDER_ROLES.needsRecovery, 'Needs Recovery'],
  ];
  for (const [status, role, name] of cases) {
    const setup = makeFolders();
    const organizer = organizerFor(setup);
    const doc = makeDoc();
    const target = await organizer.organize(doc, status);
    const root = findByRole(setup.folders, LEDGER_FOLDER_ROLES.root);
    const child = findByRoleAndParent(setup.folders, role, root.id);
    assert.equal(child.name, name, `${status} maps to folder named ${name}`);
    assert.equal(target, child.id);
  }
});

test('organize throws on an unknown status', async () => {
  const organizer = organizerFor(makeFolders());
  await assert.rejects(() => organizer.organize(makeDoc(), 'weird'), /unknown ledger status/);
});

test('organize no-ops (null) and never creates folders for a non-active GM', async () => {
  const setup = makeFolders();
  const organizer = organizerFor(setup, { isActiveGM: () => false });
  const doc = makeDoc();
  assert.equal(await organizer.organize(doc, 'pending'), null);
  assert.equal(setup.folders.length, 0, 'no folders created');
  assert.deepEqual(doc.updated, []);
});

test('organize no-ops (null) when FolderClass.create is unavailable, and warns', async () => {
  const setup = makeFolders();
  const warns = [];
  const organizer = createLedgerFolderOrganizer({
    folders: setup.folders,
    FolderClass: null,
    isActiveGM: () => true,
    logger: { warn: (msg) => warns.push(msg) },
  });
  assert.equal(await organizer.organize(makeDoc(), 'pending'), null);
  assert.ok(warns.some((m) => String(m).includes('FolderClass.create unavailable')));
});

test('organize swallows a folder-create error (returns null, warns) and leaves the doc unfiled', async () => {
  const setup = makeFolders();
  const warns = [];
  const organizer = createLedgerFolderOrganizer({
    folders: setup.folders,
    FolderClass: {
      create: async () => {
        throw new Error('boom');
      },
    },
    isActiveGM: () => true,
    logger: { warn: (msg) => warns.push(msg) },
  });
  const doc = makeDoc();
  assert.equal(await organizer.organize(doc, 'pending'), null);
  assert.equal(journalFolderId(doc), null, 'doc not moved');
  assert.deepEqual(doc.updated, []);
  assert.ok(warns.some((m) => String(m).includes('ledger folder create failed')));
});

test('organize re-checks the active GM after an awaited create (handover is a no-op)', async () => {
  const setup = makeFolders();
  let active = true;
  const organizer = createLedgerFolderOrganizer({
    folders: setup.folders,
    FolderClass: setup.FolderClass,
    isActiveGM: () => active,
  });
  const root = await setup.FolderClass.create({
    name: 'Market Ledgers',
    type: FOLDER_TYPE,
    folder: null,
    flags: { [SCOPE]: { ledgerRole: LEDGER_FOLDER_ROLES.root } },
  });
  const child = await setup.FolderClass.create({
    name: 'Pending',
    type: FOLDER_TYPE,
    folder: root.id,
    flags: { [SCOPE]: { ledgerRole: LEDGER_FOLDER_ROLES.pending } },
  });
  const doc = makeDoc();
  // The handover happens after the first awaited create, so `organize` returns
  // null without moving the doc even though the folders already exist.
  active = false;
  assert.equal(await organizer.organize(doc, 'pending'), null);
  assert.equal(journalFolderId(doc), null, 'doc not moved after the handover');
});

test('concurrent organizes never create a duplicate root hierarchy', async () => {
  const setup = makeFolders();
  const organizer = organizerFor(setup);
  const [a, b, c, d] = await Promise.all([
    organizer.organize(makeDoc(), 'pending'),
    organizer.organize(makeDoc(), 'committed'),
    organizer.organize(makeDoc(), 'failed'),
    organizer.organize(makeDoc(), 'needsRecovery'),
  ]);
  assert.ok(a && b && c && d);
  const roots = setup.folders.filter(
    (f) => f.type === FOLDER_TYPE && f.flags?.[SCOPE]?.ledgerRole === LEDGER_FOLDER_ROLES.root
  );
  assert.equal(roots.length, 1, 'only one root is ever created');
  assert.equal(roots[0].name, 'Market Ledgers');
});

test('a folder-create error never fails the whole organize (returns null, no doc move)', async () => {
  const setup = makeFolders();
  const warns = [];
  // Root creation succeeds, child creation throws.
  let calls = 0;
  const organizer = createLedgerFolderOrganizer({
    folders: setup.folders,
    FolderClass: {
      create: async (data) => {
        calls += 1;
        if (calls > 1) throw new Error('child boom');
        const folder = {
          id: 'folder-root',
          name: data.name,
          type: data.type,
          folder: data.folder ?? null,
          flags: data.flags,
        };
        setup.folders.push(folder);
        return folder;
      },
    },
    isActiveGM: () => true,
    logger: { warn: (msg) => warns.push(msg) },
  });
  const doc = makeDoc();
  assert.equal(await organizer.organize(doc, 'pending'), null);
  assert.equal(journalFolderId(doc), null);
  assert.ok(warns.some((m) => String(m).includes('ledger folder create failed')));
});

test('a delayed pending organize racing a concurrent committed update lands in Success, never Pending', async () => {
  const setup = makeFolders();
  let childStartedResolve;
  const childStarted = new Promise((r) => {
    childStartedResolve = r;
  });
  let releaseChild;
  const childGate = new Promise((r) => {
    releaseChild = r;
  });
  const organizer = createLedgerFolderOrganizer({
    folders: setup.folders,
    FolderClass: {
      create: async (data) => {
        if (data.flags?.market?.ledgerRole === LEDGER_FOLDER_ROLES.root) {
          const folder = {
            id: 'folder-root',
            name: data.name,
            type: data.type,
            folder: null,
            flags: data.flags,
          };
          setup.folders.push(folder);
          return folder;
        }
        childStartedResolve();
        await childGate;
        const id = `folder-${setup.folders.length + 1}`;
        const folder = {
          id,
          name: data.name,
          type: data.type,
          folder: data.folder ?? null,
          flags: data.flags,
        };
        setup.folders.push(folder);
        return folder;
      },
    },
    isActiveGM: () => true,
    logger: { warn: () => {} },
  });
  const doc = makeDoc();
  doc.flags = {
    market: { schemaVersion: 1, kind: 'ledger', record: { id: 'l1', status: 'pending' } },
  };

  const pending = organizer.organize(doc, 'pending');
  // The pending organize has read 'pending' and is now blocked on the child create.
  await childStarted;

  // The status is committed WHILE the pending organize is blocked on folder
  // creation, and a committed organize is issued concurrently for the same journal.
  doc.flags.market.record.status = 'committed';
  const committed = organizer.organize(doc, 'committed');
  releaseChild();

  await pending;
  await committed;

  const root = findByRole(setup.folders, LEDGER_FOLDER_ROLES.root);
  assert.ok(root, 'root folder created');
  const success = findByRoleAndParent(setup.folders, LEDGER_FOLDER_ROLES.success, root.id);
  assert.ok(success, 'success child folder created');
  assert.equal(
    journalFolderId(doc),
    success.id,
    'final folder is Success, never Pending, even though a pending organize raced the commit'
  );
});

test('a GM handover during a deferred Folder.create does not move the journal', async () => {
  const setup = makeFolders();
  let active = true;
  let childStartedResolve;
  const childStarted = new Promise((r) => {
    childStartedResolve = r;
  });
  let releaseChild;
  const childGate = new Promise((r) => {
    releaseChild = r;
  });
  const organizer = createLedgerFolderOrganizer({
    folders: setup.folders,
    FolderClass: {
      create: async (data) => {
        if (data.flags?.market?.ledgerRole === LEDGER_FOLDER_ROLES.root) {
          const folder = {
            id: 'folder-root',
            name: data.name,
            type: data.type,
            folder: null,
            flags: data.flags,
          };
          setup.folders.push(folder);
          return folder;
        }
        childStartedResolve();
        await childGate;
        const folder = {
          id: 'folder-pending',
          name: data.name,
          type: data.type,
          folder: data.folder ?? null,
          flags: data.flags,
        };
        setup.folders.push(folder);
        return folder;
      },
    },
    isActiveGM: () => active,
    logger: { warn: () => {} },
  });
  const doc = makeDoc();
  const pending = organizer.organize(doc, 'pending');
  // The child folder create is now deferred/in-flight.
  await childStarted;

  // The GM becomes inactive while the Folder.create is deferred.
  active = false;
  releaseChild();
  await pending;

  assert.equal(journalFolderId(doc), null, 'journal not moved after the handover during a deferred create');
  assert.deepEqual(doc.updated, [], 'no doc.update issued');
});
