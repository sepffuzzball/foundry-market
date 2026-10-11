// GM-only ledger summary feature tests.
//
// The ledger summary is a best-effort, GM-only text page rendered per ledger
// journal. This suite covers the pure renderer (escaping, quote-known heuristic,
// statuses, payload fallback, no raw payload/outcome dumps), the
// normalization/detail bounds, and the store integration (fire-and-forget sync
// that never fails the ledger write, per-journal serialization so a committed
// update wins, the backfill sweep, unrelated-page preservation, and the
// GM-only journal ownership).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderLedgerSummary,
  resolveLedgerIds,
  findLedgerSummaryPage,
  SUMMARY_PAGE_NAME,
  syncLedgerSummaryPage,
} from '../src/storage/ledger-summary.js';
import { normalizeLedgerRecord, LEDGER_DETAIL_MAX } from '../src/services/model.js';
import { createStore, defaultDocAccess } from '../src/storage/store.js';
import { publicPurchaseResult } from '../src/core/requests.js';

// --------------------------------------------------------------------------
// Pure renderer
// --------------------------------------------------------------------------

test('renderLedgerSummary: balance-read-failed with no quote info shows reason, detail and Not quoted', () => {
  const record = normalizeLedgerRecord({
    key: 'u1:r1',
    userId: 'u1',
    status: 'failed',
    error: 'balance-read-failed',
    detail: 'balance store threw',
    payload: { shopId: 's1', entryId: 'e1', actorId: 'A.1', quantity: 2 },
    quantity: 1,
    createdAt: Date.UTC(2026, 0, 1),
    updatedAt: Date.UTC(2026, 0, 1, 0, 0, 1),
  });
  const html = renderLedgerSummary(record, {
    shopName: 'General Store',
    actorName: 'Helga',
    itemName: 'Potion',
  });
  assert.ok(html.includes('<strong>Status:</strong> failed'));
  assert.ok(html.includes('General Store (shop s1)'));
  assert.ok(html.includes('Potion (entry e1) for Helga (actor A.1)'));
  assert.ok(html.includes('<strong>Quantity:</strong> 2'));
  assert.ok(html.includes('<strong>Quote:</strong> Not quoted'));
  assert.ok(html.includes('<strong>Reason:</strong> balance-read-failed'));
  assert.ok(html.includes('<strong>Detail:</strong> balance store threw'));
  assert.ok(html.includes('<strong>Created:</strong> 2026-01-01T00:00:00.000Z'));
  assert.ok(html.includes('<strong>Updated:</strong> 2026-01-01T00:00:01.000Z'));
  // Never dump the raw payload/outcome objects.
  assert.ok(!html.includes('"payload"'));
  assert.ok(!html.includes('"outcome"'));
});

test('renderLedgerSummary: balance-read-failed after a quote shows the quoted total', () => {
  const record = normalizeLedgerRecord({
    key: 'u1:r1',
    userId: 'u1',
    status: 'failed',
    error: 'balance-read-failed',
    detail: 'balance store threw',
    quoteKnown: true,
    quantity: 2,
    unitPrice: 5,
    totalPrice: 10,
    payload: { shopId: 's1', entryId: 'e1', actorId: 'A.1', quantity: 2 },
  });
  const html = renderLedgerSummary(record, {
    shopName: 'General Store',
    actorName: 'Helga',
    itemName: 'Potion',
  });
  assert.ok(html.includes('<strong>Reason:</strong> balance-read-failed'));
  assert.ok(html.includes('<strong>Quote:</strong> Unit 5 cp, Total 10 cp'));
  assert.ok(!html.includes('Not quoted'), 'a known quote never renders Not quoted');
});

test('renderLedgerSummary: a 0 cp quoted failure still shows the quote, not Not quoted', () => {
  const record = normalizeLedgerRecord({
    key: 'u1:r1',
    userId: 'u1',
    status: 'failed',
    error: 'balance-read-failed',
    detail: 'balance store threw',
    quoteKnown: true,
    quantity: 1,
    unitPrice: 0,
    totalPrice: 0,
    payload: { shopId: 's1', entryId: 'e1', actorId: 'A.1', quantity: 1 },
  });
  const html = renderLedgerSummary(record, {
    shopName: 'General Store',
    actorName: 'Helga',
    itemName: 'Potion',
  });
  assert.ok(html.includes('<strong>Reason:</strong> balance-read-failed'));
  assert.ok(html.includes('<strong>Quote:</strong> Unit 0 cp, Total 0 cp'));
  assert.ok(!html.includes('Not quoted'), 'a 0 cp quote is a known quote, never Not quoted');
});

test('renderLedgerSummary: a pre-quote failure renders Not quoted', () => {
  const record = normalizeLedgerRecord({
    key: 'u1:r1',
    userId: 'u1',
    status: 'failed',
    error: 'shop-not-found',
    detail: 'no such shop',
    quantity: 1,
    payload: { shopId: 's1', entryId: 'e1', actorId: 'A.1', quantity: 1 },
  });
  const html = renderLedgerSummary(record, { shopName: 'General Store' });
  assert.ok(html.includes('<strong>Reason:</strong> shop-not-found'));
  assert.ok(html.includes('<strong>Quote:</strong> Not quoted'));
});

test('renderLedgerSummary: the legacy quote heuristic still applies without quoteKnown', () => {
  // A legacy record that predates the quoteKnown flag, carrying a nonzero total,
  // must still render the quote via the prior heuristic.
  const record = normalizeLedgerRecord({
    key: 'u1:r1',
    status: 'failed',
    error: 'insufficient-funds',
    quantity: 1,
    unitPrice: 7,
    totalPrice: 7,
    payload: { shopId: 's1', entryId: 'e1', actorId: 'A.1', quantity: 1 },
  });
  const html = renderLedgerSummary(record, { shopName: 'General Store' });
  assert.equal(record.quoteKnown, false, 'no explicit flag on the legacy record');
  assert.ok(html.includes('<strong>Quote:</strong> Unit 7 cp, Total 7 cp'));
  assert.ok(!html.includes('Not quoted'), 'legacy heuristic still recognizes the quote');
});

test('renderLedgerSummary: named shop shows name plus id, unnamed shop shows the id once', () => {
  const base = {
    key: 'u1:r1',
    status: 'failed',
    error: 'shop-closed',
    quoteKnown: true,
    quantity: 1,
    unitPrice: 1,
    totalPrice: 1,
    payload: { shopId: 's1', entryId: 'e1', actorId: 'A.1', quantity: 1 },
  };
  // Named shop: `Name (shop id)`.
  const named = renderLedgerSummary(normalizeLedgerRecord(base), { shopName: 'General Store' });
  assert.ok(named.includes('<strong>Shop:</strong> General Store (shop s1)'));
  assert.ok(!named.includes('(shop s1) (shop s1)'), 'shop id never duplicated for a named shop');
  // Unnamed shop: the id is shown exactly once.
  const unnamed = renderLedgerSummary(normalizeLedgerRecord(base));
  assert.ok(unnamed.includes('<strong>Shop:</strong> (shop s1)'));
  assert.equal(unnamed.match(/\(shop s1\)/g).length, 1, 'shop id appears exactly once');
});

test('renderLedgerSummary escapes hostile labels and detail and never leaks raw JSON', () => {
  const record = normalizeLedgerRecord({
    key: 'u1:r2',
    status: 'failed',
    error: '<b>& "x"</b>',
    detail: '<script>alert("hi")</script>',
    quantity: 1,
    payload: { shopId: 's<&>', entryId: 'e"&', actorId: 'A<&>', quantity: 1 },
    outcome: { raw: 'object' },
  });
  const html = renderLedgerSummary(record, {
    shopName: '<Shop & Co>',
    actorName: 'A<&>',
    itemName: 'I<&>',
  });
  assert.ok(html.includes('&lt;Shop &amp; Co&gt;'));
  assert.ok(html.includes('s&lt;&amp;&gt;'));
  assert.ok(html.includes('I&lt;&amp;&gt;'));
  // Reason/detail escaped.
  assert.ok(html.includes('&lt;b&gt;&amp; &quot;x&quot;&lt;/b&gt;'));
  assert.ok(html.includes('&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;'));
  assert.ok(!html.includes('<b>'), 'raw reason tags escaped');
  assert.ok(!html.includes('<script>'), 'raw detail tags escaped');
  assert.ok(!html.includes('{'), 'no raw JSON object dump');
  assert.ok(!html.includes('"raw"'), 'no strippable raw key dump');
});

test('renderLedgerSummary: pending/committed show a quote, failures do not leak a quote', () => {
  for (const status of ['pending', 'committed']) {
    const r = normalizeLedgerRecord({ key: 'k', status, unitPrice: 10, totalPrice: 20 });
    const html = renderLedgerSummary(r);
    assert.ok(html.includes(`<strong>Status:</strong> ${status}`));
    assert.ok(html.includes('Unit 10 cp, Total 20 cp'));
  }
  const failed = normalizeLedgerRecord({ key: 'k', status: 'failed', error: 'x' });
  assert.ok(renderLedgerSummary(failed).includes('<strong>Status:</strong> failed'));
  assert.ok(renderLedgerSummary(failed).includes('<strong>Reason:</strong> x'));
  const needs = normalizeLedgerRecord({ key: 'k', status: 'needsRecovery', error: 'x' });
  assert.ok(renderLedgerSummary(needs).includes('<strong>Status:</strong> needsRecovery'));
});

test('renderLedgerSummary: a legacy record without detail/compensation renders safely', () => {
  const legacy = {
    status: 'failed',
    error: 'shop-not-found',
    quantity: 1,
    payload: { shopId: 's1', entryId: 'e1', actorId: 'A.1', quantity: 1 },
  };
  const html = renderLedgerSummary(legacy);
  assert.ok(html.includes('<strong>Reason:</strong> shop-not-found'));
  assert.ok(!html.includes('<strong>Detail:</strong>'), 'no detail line when detail absent');
  assert.ok(html.includes('<strong>Compensation:</strong> none'));
});

test('renderLedgerSummary lists compensation entries and falls back to stable ids', () => {
  const record = normalizeLedgerRecord({
    key: 'k',
    status: 'failed',
    error: 'x',
    compensation: ['currency-refunded', 'item-removed'],
    quantity: 1,
  });
  const html = renderLedgerSummary(record);
  assert.ok(html.includes('<li>currency-refunded</li>'));
  assert.ok(html.includes('<li>item-removed</li>'));
  // No names provided -> fall back to stable ids.
  assert.ok(html.includes('<strong>Status:</strong> failed'));
});

test('renderLedgerSummary clips huge fallback ids before escaping', () => {
  const huge = (s) => s.repeat(200); // well past ID_MAX (120)
  const record = {
    status: 'failed',
    error: 'x',
    quantity: 1,
    payload: {
      shopId: huge('s'),
      entryId: huge('e'),
      actorId: huge('a'),
      quantity: 1,
    },
  };
  const html = renderLedgerSummary(record);
  // The fallback ids must be clipped: a 200-char id becomes 120 chars + '...'.
  assert.ok(html.includes('(shop ' + huge('s').slice(0, 120) + '...)'));
  assert.ok(html.includes('(entry ' + huge('e').slice(0, 120) + '...)'));
  assert.ok(html.includes('(actor ' + huge('a').slice(0, 120) + '...)'));
  // No raw unclipped id is ever dumped into the page.
  assert.ok(!html.includes(huge('s')), 'raw shop id never dumped');
  assert.ok(!html.includes(huge('e')), 'raw entry id never dumped');
  assert.ok(!html.includes(huge('a')), 'raw actor id never dumped');
});

test('renderLedgerSummary caps an oversized compensation list and counts the remainder', () => {
  const comp = Array.from({ length: 20 }, (_, i) => `comp-${i}`);
  const record = {
    status: 'failed',
    error: 'x',
    quantity: 1,
    compensation: comp,
  };
  const html = renderLedgerSummary(record);
  // The first COMP_MAX (12) entries are rendered.
  for (let i = 0; i < 12; i++) {
    assert.ok(html.includes(`<li>comp-${i}</li>`), `entry ${i} shown`);
  }
  // The remainder is collapsed into a single count, never rendered as a list item.
  assert.ok(!html.includes('<li>comp-12</li>'), '13th entry not rendered as an item');
  assert.ok(html.includes('...and 8 more'), 'remainder counted');
});

test('renderLedgerSummary stays bounded with huge/legacy malformed strings', () => {
  const huge = (s, n) => s.repeat(n);
  const record = {
    status: 'failed',
    error: huge('e', 5000),
    detail: huge('d', 5000),
    quantity: 1,
    compensation: Array.from({ length: 50 }, () => huge('c', 100)),
    payload: {
      shopId: huge('s', 500),
      entryId: huge('e', 500),
      actorId: huge('a', 500),
      quantity: 1,
    },
  };
  const html = renderLedgerSummary(record, {
    shopName: huge('n', 500),
    actorName: huge('x', 500),
    itemName: huge('i', 500),
  });
  // Every dynamic string is clipped, so the page cannot grow without bound.
  assert.ok(html.length < 5000, `html length ${html.length} should stay bounded`);
  assert.ok(html.includes('...and 38 more'), '50-entry compensation collapsed to 12 + 38');
});

test('resolveLedgerIds prefers top-level ids and falls back to payload, preferring payload quantity', () => {
  // Top-level ids win when present.
  const a = resolveLedgerIds({ shopId: 's1', entryId: 'e1', actorId: 'A.1', quantity: 2 });
  assert.deepEqual(a, { shopId: 's1', entryId: 'e1', actorId: 'A.1', quantity: 2 });
  // Payload ids used when top-level absent; payload quantity preferred (a failed
  // pre-quote record carries the real requested quantity only on the payload).
  const b = resolveLedgerIds({ quantity: 1, payload: { shopId: 's9', entryId: 'e9', actorId: 'A.9', quantity: 5 } });
  assert.deepEqual(b, { shopId: 's9', entryId: 'e9', actorId: 'A.9', quantity: 5 });
  // No payload -> defaults.
  const c = resolveLedgerIds({});
  assert.deepEqual(c, { shopId: '', entryId: '', actorId: '', quantity: 1 });
});

// --------------------------------------------------------------------------
// Model detail field
// --------------------------------------------------------------------------

test('normalizeLedgerRecord defaults detail to empty and bounds it', () => {
  const r = normalizeLedgerRecord({ key: 'k' });
  assert.equal(r.detail, '');
  const long = normalizeLedgerRecord({ key: 'k', detail: 'x'.repeat(600) });
  assert.equal(long.detail.length, LEDGER_DETAIL_MAX);
  assert.ok(long.detail.endsWith('x'.repeat(LEDGER_DETAIL_MAX)));
});

// --------------------------------------------------------------------------
// Public projection never leaks detail
// --------------------------------------------------------------------------

test('publicPurchaseResult never leaks the diagnostic detail', () => {
  const pub = publicPurchaseResult({
    status: 'failed',
    ledgerId: 'L1',
    error: 'balance-read-failed',
    detail: 'internal store threw',
  });
  assert.equal(pub.status, 'failed');
  assert.equal(pub.error, 'balance-read-failed');
  assert.ok(!('detail' in pub), 'detail is stripped from the public result');
});

// --------------------------------------------------------------------------
// Store integration (fake adapter with syncLedgerSummary)
// --------------------------------------------------------------------------

// A fake docAccess wired to the REAL `syncLedgerSummaryPage`/`renderLedgerSummary`
// so store integration exercises the same page semantics (create/update only the
// module-owned page, never others). Documents expose a duck-typed `pages` array
// plus `createEmbeddedDocuments`/`updateEmbeddedDocuments` mirrors of the Foundry
// embedded-document surface.
function createLedgerSummaryFakeDocAccess({ isActiveGM = () => true, listLedgerJournals = null } = {}) {
  const docs = new Map();
  let seq = 0;
  let pageSeq = 0;
  function makePage(data) {
    const page = {
      id: `page-${++pageSeq}`,
      name: data.name,
      type: data.type,
      text: data.text,
      flags: data.flags,
      update(patch) {
        for (const [key, value] of Object.entries(patch)) {
          if (key === 'text.content') this.text = { ...this.text, content: value };
          else this[key] = value;
        }
        return Promise.resolve(this);
      },
    };
    return page;
  }
  function makeDoc({ name, flags } = {}) {
    const id = `journal-${++seq}`;
    const doc = {
      id,
      name,
      flags,
      pages: [],
      createEmbeddedDocuments(type, data) {
        for (const d of data) doc.pages.push(makePage(d));
        return Promise.resolve([]);
      },
      updateEmbeddedDocuments() {
        return Promise.resolve([]);
      },
    };
    docs.set(id, doc);
    return doc;
  }
  const fake = {
    docs,
    makeDoc,
    async listJournalEntries() { return Array.from(docs.values()); },
    async listLedgerJournals() {
      return listLedgerJournals === null
        ? Array.from(docs.values())
        : listLedgerJournals(docs);
    },
    async getJournalEntry(id) { return docs.get(id) || null; },
    async createJournalEntry({ name, flags }) { return makeDoc({ name, flags }); },
    async updateJournalEntry(doc, patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'flags') doc.flags = { ...doc.flags, ...value };
        else doc[key] = value;
      }
      return doc;
    },
    async syncLedgerSummary(doc, record, names = {}) {
      const html = renderLedgerSummary(record, names);
      return syncLedgerSummaryPage(doc, html, { isActiveGM });
    },
  };
  return fake;
}

function ledgerDocByRecordId(da, recordId) {
  return Array.from(da.docs.values()).find(
    (d) => d.flags?.market?.record?.id === recordId
  ) || null;
}

test('createLedger does not await the summary sync and never fails if it throws', async () => {
  const da = createLedgerSummaryFakeDocAccess();
  da.syncLedgerSummary = async () => { throw new Error('boom'); };
  const store = createStore(da);
  const result = await store.createLedger({ key: 'u1:r1', status: 'failed', error: 'x', quantity: 1 });
  assert.equal(result.created, true);
  assert.equal(result.record.status, 'failed');
  // The fire-and-forget task is swallowed and logged; it must not reject the
  // create. Flush so no unhandled tail lingers.
  await store.flushLedgerSummaries();
});

test('updateLedger does not fail if the summary sync throws', async () => {
  const da = createLedgerSummaryFakeDocAccess();
  const store = createStore(da);
  const created = await store.createLedger({ key: 'u1:r1', status: 'pending', quantity: 1 });
  da.syncLedgerSummary = async () => { throw new Error('boom'); };
  const updated = await store.updateLedger(created.record.id, { status: 'committed' });
  assert.equal(updated.status, 'committed');
  await store.flushLedgerSummaries();
});

test('summary sync creates the module-owned page after a create and update', async () => {
  const da = createLedgerSummaryFakeDocAccess();
  const store = createStore(da);
  const created = await store.createLedger({
    key: 'u1:r1',
    status: 'pending',
    unitPrice: 5,
    totalPrice: 5,
    quantity: 1,
  });
  const doc = ledgerDocByRecordId(da, created.record.id);
  assert.ok(doc);
  await store.flushLedgerSummaries();
  let page = findLedgerSummaryPage(doc.pages);
  assert.ok(page, 'summary page created');
  assert.equal(page.name, SUMMARY_PAGE_NAME);
  assert.equal(page.type, 'text');
  assert.equal(page.text.format, 1);
  assert.ok(page.text.content.includes('<strong>Status:</strong> pending'));

  await store.updateLedger(created.record.id, { status: 'committed' });
  await store.flushLedgerSummaries();
  page = findLedgerSummaryPage(doc.pages);
  assert.ok(page, 'summary page still exists');
  assert.equal(page.name, SUMMARY_PAGE_NAME);
  assert.ok(page.text.content.includes('<strong>Status:</strong> committed'));
  assert.equal(doc.pages.length, 1, 'one module-owned page, no duplicates');
});

test('summary sync preserves unrelated pages and only updates the module-owned page', async () => {
  const da = createLedgerSummaryFakeDocAccess();
  const store = createStore(da);
  const created = await store.createLedger({ key: 'u1:r1', status: 'pending', quantity: 1 });
  const doc = ledgerDocByRecordId(da, created.record.id);
  // Simulate a GM page a player/GM added before the market owned a page.
  doc.pages.unshift({
    id: 'gm-page',
    name: 'My Notes',
    type: 'text',
    text: { format: 1, content: 'hello' },
    update() { return Promise.resolve(this); },
  });
  await store.flushLedgerSummaries();
  assert.equal(doc.pages.length, 2, 'gm page kept + summary page added');
  const gm = doc.pages.find((p) => p.id === 'gm-page');
  assert.equal(gm.text.content, 'hello');
  const page = findLedgerSummaryPage(doc.pages);
  assert.equal(page.name, SUMMARY_PAGE_NAME);
});

test('summary sync per-journal: a committed update wins over a stale pending render', async () => {
  const da = createLedgerSummaryFakeDocAccess();
  const store = createStore(da);
  // Make every summary slow so the pending render is still in-flight when the
  // committed update lands, forcing the per-journal queue to serialize.
  const origSync = da.syncLedgerSummary;
  da.syncLedgerSummary = async (doc, record, names) => {
    await new Promise((r) => setTimeout(r, 5));
    return origSync(doc, record, names);
  };
  const created = await store.createLedger({
    key: 'u1:r1',
    status: 'pending',
    unitPrice: 5,
    totalPrice: 5,
    quantity: 1,
  });
  const doc = ledgerDocByRecordId(da, created.record.id);
  await store.updateLedger(created.record.id, { status: 'committed' });
  await store.flushLedgerSummaries();
  const page = findLedgerSummaryPage(doc.pages);
  assert.ok(page);
  assert.ok(
    page.text.content.includes('<strong>Status:</strong> committed'),
    'final summary shows committed, never a stale pending render'
  );
});

test('backfill sweep renders a summary for an existing (non-created) ledger journal', async () => {
  const da = createLedgerSummaryFakeDocAccess();
  const store = createStore(da);
  // A legacy/existing journal that was never routed through createLedger, so it
  // has no summary page yet. Note: the status is valid so the folder sweep also
  // runs; the summary attempt is independent of the folder counters.
  const doc = da.makeDoc({
    name: 'Ledger: legacy',
    flags: {
      market: {
        schemaVersion: 1,
        kind: 'ledger',
        record: {
          id: 'legacy-1',
          key: 'u1:r0',
          status: 'failed',
          error: 'shop-closed',
          payload: { shopId: 's1', entryId: 'e1', actorId: 'A.1', quantity: 3 },
        },
      },
    },
  });
  const summary = await store.organizeLedgerJournals({ isActiveGM: () => true });
  // The sweep schedules the summary backfill independently (never awaits it), so
  // resolve the queued best-effort summary before asserting the page exists.
  await store.flushLedgerSummaries();
  const page = findLedgerSummaryPage(doc.pages);
  assert.ok(page, 'summary page created by the sweep backfill');
  assert.ok(page.text.content.includes('<strong>Status:</strong> failed'));
  assert.ok(page.text.content.includes('<strong>Quantity:</strong> 3'));
  assert.equal(summary.status, 'ok');
});

test('backfill sweep skips a malformed record without poisoning the sweep', async () => {
  const da = createLedgerSummaryFakeDocAccess();
  const store = createStore(da);
  // A malformed kind is not a ledger; the sweep should not attempt a summary.
  const shopDoc = da.makeDoc({
    name: 'Shop',
    flags: { market: { schemaVersion: 1, kind: 'shop', record: { id: 's1', name: 'S' } } },
  });
  const summary = await store.organizeLedgerJournals({ isActiveGM: () => true });
  assert.equal(summary.status, 'ok');
  assert.equal(summary.skipped, 1);
  assert.equal(findLedgerSummaryPage(shopDoc.pages), null);
});

test('the ledger-folder sweep completes despite a never-settling summary sync', async () => {
  // A `syncLedgerSummary` that never resolves must not block the sweep. The sweep
  // schedules the summary fire-and-forget and continues, so it still files every
  // ledger journal (folder work) and proceeds to the next doc.
  const ledgerDocs = [];
  let seq = 0;
  function makeLedgerDoc(status, id) {
    const doc = {
      id: `j-${++seq}`,
      name: `Ledger: ${id}`,
      flags: {
        market: {
          schemaVersion: 1,
          kind: 'ledger',
          record: { id, status },
        },
      },
      _source: { folder: null },
      update(patch) {
        if (patch && patch.folder !== undefined) this._source.folder = patch.folder;
        if (patch && patch.flags) this.flags = { ...this.flags, ...patch.flags };
        return this;
      },
    };
    ledgerDocs.push(doc);
    return doc;
  }
  const docA = makeLedgerDoc('pending', 'rec-a');
  const docB = makeLedgerDoc('failed', 'rec-b');
  const docAccess = {
    async listLedgerJournals() { return ledgerDocs.slice(); },
    async listJournalEntries() { return ledgerDocs.slice(); },
    // Never settles, never rejects.
    syncLedgerSummary() { return new Promise(() => {}); },
    async organizeLedgerJournal(doc) {
      const status = doc.flags.market.record.status;
      const folder = `folder-${status}`;
      doc._source.folder = folder;
      return folder;
    },
  };
  const store = createStore(docAccess);
  const summary = await store.organizeLedgerJournals({ isActiveGM: () => true });
  // The sweep must complete (not hang on the never-settling sync) and must have
  // processed BOTH journals - folder work happened and we moved on to the next doc.
  assert.equal(summary.status, 'ok');
  assert.equal(summary.moved, 2, 'both ledger journals filed despite the never-settling sync');
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(docA._source.folder, 'folder-pending');
  assert.equal(docB._source.folder, 'folder-failed');
});

test('summary sync is an idle no-op for a non-active GM', async () => {
  const da = createLedgerSummaryFakeDocAccess({ isActiveGM: () => false });
  const store = createStore(da);
  const created = await store.createLedger({ key: 'u1:r1', status: 'pending', quantity: 1 });
  await store.flushLedgerSummaries();
  const doc = ledgerDocByRecordId(da, created.record.id);
  assert.equal(doc.pages.length, 0, 'no page created while not the active GM');
});

// The full defaultDocAccess create path is GM-only. Simulate the live game
// boundary to confirm a ledger journal is created with `ownership.default: 0`.
test('defaultDocAccess creates ledger journals GM-only (ownership default 0)', async () => {
  const created = [];
  const JournalEntry = { create: async (data) => { created.push(data); return data; } };
  globalThis.game = { journal: { documentClass: JournalEntry } };
  try {
    const da = defaultDocAccess();
    const doc = await da.createJournalEntry({ name: 'Ledger: x', flags: { market: {} } });
    assert.ok(doc);
    assert.equal(created[0].ownership.default, 0, 'players get no read permission');
  } finally {
    delete globalThis.game;
  }
});
