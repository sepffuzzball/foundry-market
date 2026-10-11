// GM-only human-readable ledger summary renderer.
//
// Every purchase ledger record is stored in its own GM-only JournalEntry (see
// `store.js`). In addition to the machine-readable `flags.market.record`,
// the active GM may want to read a plain-text summary of each attempt without
// probing the raw JSON. This module renders that summary as a small HTML text
// page (a `JournalEntryPage` of type 'text') that the active GM can read in the
// Journal sidebar.
//
// The renderer is intentionally PURE: it takes a normalized ledger record (and
// optional best-effort shop/actor/item names) and returns an HTML string. It
// never touches `game`, never reads the store, and never throws on a stranger
// record - it always produces escaped, bounded HTML. The only data flow from a
// ledger record is the fields listed below; the raw `payload`/`outcome` objects
// are never dumped wholesale.
//
// This module is free of Foundry globals so it can be imported under Node for
// tests. The page persistence (finding/creating/updating the module-owned page)
// is handled by `syncLedgerSummaryPage` and the live store adapter.

// Name under which the module owns its summary page on a ledger journal. Only
// this exact module-owned page (identified by `flags.market.ledgerSummary`, never
// by name alone) is ever created or updated; any other page a GM adds to the
// journal is left untouched.
export const SUMMARY_PAGE_NAME = 'Purchase summary';

// Identifies a page as module-owned: it carries the market `ledgerSummary` flag.
// This is the ONLY signal used to claim a page, so a player or GM page that
// happens to be named "Purchase summary" but carries no flag is never treated as
// ours, and our page is never replaced by such a page.
export function isLedgerSummaryPage(page) {
  return !!(page && page.flags && page.flags.market && page.flags.market.ledgerSummary === true);
}

// First module-owned summary page on a journal, or null.
export function findLedgerSummaryPage(pages = []) {
  for (const page of pages) {
    if (isLedgerSummaryPage(page)) return page;
  }
  return null;
}

// Text-length caps. Dynamic strings are clipped before escaping so a hostile or
// enormous label/detail can never produce an unbounded journal page (nor break a
// test's exact-match assertion). `record.detail` is already bounded to
// `LEDGER_DETAIL_MAX` by the model, but every other string we render is clipped
// here defensively.
const NAME_MAX = 120;
const DETAIL_MAX = 500;
const CODE_MAX = 200;
// Fallback identifiers (shop/entry/actor ids) that stand in for a missing display
// name are clipped to the same cap as names, so a malformed or enormous legacy id
// can never create an unbounded journal page.
const ID_MAX = 120;
// The compensation list is rendered capped at the first N entries plus a count of
// the remainder, so a hostile/long list cannot create an unbounded page.
const COMP_MAX = 12;

function clip(value, max) {
  const s = String(value == null ? '' : value);
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

// Escape a value for safe interpolation into HTML. Order matters: `&` first so a
// previously-escaped entity is not double-escaped later.
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resolve the identifiers used for a ledger summary, preferring the canonical
 * top-level fields and falling back to the raw `payload` object (the commerce
 * request payload `{ shopId, entryId, actorId, quantity }`) only when the
 * top-level field is absent. Top-level fields win because they are the always-
 * normalized, schema-checked values; payload is an unvalidated snapshot that a
 * legacy record may carry instead.
 *
 * @param {object} record A (typically normalized) ledger record.
 * @returns {{shopId: string, entryId: string, actorId: string, quantity: number}}
 */
export function resolveLedgerIds(record = {}) {
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  const shopId = record.shopId || payload.shopId || '';
  const entryId = record.entryId || payload.entryId || '';
  const actorId = record.actorId || payload.actorId || '';
  // Quantity is special: a failed pre-quote record stores its real requested
  // quantity only on the payload (top-level quantity defaults to 1 in that path),
  // so prefer the payload snapshot and fall back to the top-level field.
  const payloadQ = Number(payload.quantity);
  let quantity;
  if (Number.isSafeInteger(payloadQ) && payloadQ >= 1) quantity = payloadQ;
  else {
    const topQ = Number(record.quantity);
    quantity = Number.isSafeInteger(topQ) && topQ >= 1 ? topQ : 1;
  }
  return { shopId, entryId, actorId, quantity };
}

// A quote is considered "known" when the purchase was actually quoted. That is
// the case for a status that implies a completed- or in-progress quote
// (`pending`/`committed`), when the record carries an explicit `quoteKnown` flag
// (set for every post-quote failure, including a 0 cp quote such as a free or
// fully-discounted item), OR when a nonzero unit/total is present, OR when a
// structured `priceBreakdown` exists. A pre-quote failure (e.g. shop-not-found,
// actor-not-found) carries none of those, so it renders 'Not quoted'.
function isQuoteKnown(record = {}) {
  if (record.quoteKnown === true) return true;
  const status = record.status;
  if (status === 'pending' || status === 'committed') return true;
  if (record.unitPrice > 0 || record.totalPrice > 0) return true;
  if (record.priceBreakdown != null) return true;
  return false;
}

function isoDate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function indent(label, value) {
  return `<p><strong>${label}:</strong> ${value}</p>`;
}

/**
 * Render a GM-only human-readable summary of a purchase ledger record as an HTML
 * string for a text `JournalEntryPage`. Pure: never touches `game`, never reads
 * the store, never throws. All dynamic data is clipped and HTML-escaped, the raw
 * `payload`/`outcome` objects are never dumped (only the fields above are shown),
 * and unknown identifiers fall back to stable ids rather than blank text.
 *
 * @param {object} record A normalized (or legacy) ledger record.
 * @param {{shopName?: string, actorName?: string, itemName?: string}} [opts]
 *        Best-effort, already-resolved display names. When absent the renderer
 *        falls back to stable ids so the summary is still useful.
 * @returns {string} Escaped HTML.
 */
export function renderLedgerSummary(record = {}, opts = {}) {
  const { shopName, actorName, itemName } = opts;
  const ids = resolveLedgerIds(record);
  const status = clip(record.status, CODE_MAX);

  // Every dynamic component is clipped before escaping so a hostile or enormous
  // label/id/detail can never create an unbounded journal page and never break an
  // exact-match assertion. Fallback ids that stand in for a missing display name
  // use the same cap as names (ID_MAX).
  const shopIdPart = clip(ids.shopId, ID_MAX);
  const entryIdPart = clip(ids.entryId, ID_MAX);
  const actorIdPart = clip(ids.actorId, ID_MAX);

  // Compose the "attempted buy" line without duplicating an id: a named item
  // shows its entry id separately, an unnamed one already encodes it.
  const purchaseParts = [];
  if (itemName) {
    purchaseParts.push(escapeHtml(clip(itemName, NAME_MAX)));
    if (entryIdPart) purchaseParts.push(`(entry ${escapeHtml(entryIdPart)})`);
  } else {
    purchaseParts.push(
      entryIdPart ? `(entry ${escapeHtml(entryIdPart)})` : 'Unknown item'
    );
  }
  const actorPart = actorIdPart ? `(actor ${escapeHtml(actorIdPart)})` : '';
  if (actorName) {
    const namePart = escapeHtml(clip(actorName, NAME_MAX));
    purchaseParts.push(`for ${actorPart ? `${namePart} ${actorPart}` : namePart}`);
  } else {
    purchaseParts.push(actorPart ? `for ${actorPart}` : 'for Unknown actor');
  }
  const purchase = purchaseParts.join(' ');

  const out = [];
  out.push(indent('Status', escapeHtml(status)));

  const shopLine = shopName
    ? shopIdPart
      ? `${escapeHtml(clip(shopName, NAME_MAX))} (shop ${escapeHtml(shopIdPart)})`
      : escapeHtml(clip(shopName, NAME_MAX))
    : shopIdPart
      ? `(shop ${escapeHtml(shopIdPart)})`
      : 'Not specified';
  out.push(indent('Shop', shopLine));
  out.push(indent('Purchase', purchase));
  out.push(indent('Quantity', String(ids.quantity)));

  if (isQuoteKnown(record)) {
    const unit = Number(record.unitPrice) || 0;
    const total = Number(record.totalPrice) || 0;
    out.push(indent('Quote', `Unit ${escapeHtml(String(unit))} cp, Total ${escapeHtml(String(total))} cp`));
  } else {
    out.push(indent('Quote', 'Not quoted'));
  }

  // Reason/detail only make sense on a failed / needs-recovery attempt, but any
  // stray error string is still shown so nothing is silently hidden.
  if (record.error || record.status === 'failed' || record.status === 'needsRecovery') {
    out.push(indent('Reason', escapeHtml(clip(record.error || '(none)', CODE_MAX))));
    if (record.detail) {
      out.push(indent('Detail', escapeHtml(clip(record.detail, DETAIL_MAX))));
    }
  }

  const comp = Array.isArray(record.compensation) ? record.compensation : [];
  if (comp.length > 0) {
    // Render at most the first COMP_MAX entries, then a count of the remainder, so
    // a long/hostile compensation list cannot create an unbounded journal page.
    const shown = comp.slice(0, COMP_MAX);
    const items = shown
      .map((c) => `<li>${escapeHtml(clip(c, CODE_MAX))}</li>`)
      .join('');
    const hidden = comp.length - shown.length;
    const more = hidden > 0 ? `<li>...and ${hidden} more</li>` : '';
    out.push(`<p><strong>Compensation:</strong></p><ul>${items}${more}</ul>`);
  } else if (record.status === 'failed' || record.status === 'needsRecovery') {
    out.push(indent('Compensation', 'none'));
  }

  const created = isoDate(record.createdAt);
  const updated = isoDate(record.updatedAt);
  out.push(indent('Created', created || 'unknown'));
  out.push(indent('Updated', updated || 'unknown'));

  return `<div>${out.join('')}</div>`;
}

/**
 * Persist `html` as the module-owned `Purchase summary` text page on `doc`'s
 * journal. This is a best-effort, GM-only side effect: it creates the page when
 * absent and updates ONLY the module-owned page (identified by the market
 * `ledgerSummary` flag, never by name) when the content changed. It never
 * replaces or otherwise touches any other page on the journal, and a failure
 * here must never fail the ledger write (the caller catches).
 *
 * The active-GM predicate is re-checked before the read and after each await, so
 * a GM handover never leaves us trusting or writing a page we no longer own.
 *
 * @param {object} doc A journal entry document (duck-typed: `.pages`).
 * @param {string} html Escaped HTML to write.
 * @param {{isActiveGM?: () => boolean}} [opts]
 * @returns {Promise<{changed: boolean, created: boolean, skipped: boolean}>}
 */
export function syncLedgerSummaryPage(doc, html, { isActiveGM = () => true } = {}) {
  if (!isActiveGM()) return Promise.resolve({ changed: false, created: false, skipped: true });
  const pages = doc && doc.pages ? Array.from(doc.pages) : [];
  const existing = findLedgerSummaryPage(pages);

  if (existing) {
    if (!isActiveGM()) return Promise.resolve({ changed: false, created: false, skipped: true });
    const current = existing.text && existing.text.content;
    if (current === html) {
      return Promise.resolve({ changed: false, created: false, skipped: false });
    }
    if (typeof existing.update === 'function') {
      return Promise.resolve(existing.update({ 'text.content': html })).then(
        () => ({ changed: true, created: false, skipped: false })
      );
    }
    if (typeof doc.updateEmbeddedDocuments === 'function' && existing.id) {
      return Promise.resolve(
        doc.updateEmbeddedDocuments('JournalEntryPage', [{ _id: existing.id, 'text.content': html }])
      ).then(() => ({ changed: true, created: false, skipped: false }));
    }
    return Promise.resolve({ changed: false, created: false, skipped: false });
  }

  if (!isActiveGM()) return Promise.resolve({ changed: false, created: false, skipped: true });
  const pageData = {
    name: SUMMARY_PAGE_NAME,
    type: 'text',
    text: { format: 1, content: html },
    flags: { market: { ledgerSummary: true } },
  };
  if (typeof doc.createEmbeddedDocuments === 'function') {
    return Promise.resolve(doc.createEmbeddedDocuments('JournalEntryPage', [pageData])).then(
      () => ({ changed: true, created: true, skipped: false })
    );
  }
  if (doc && doc.pages && typeof doc.pages.push === 'function') {
    const page = { id: `page-${doc.pages.length + 1}`, ...pageData };
    page.update = (patch) => {
      Object.assign(page, patch);
      return Promise.resolve(page);
    };
    doc.pages.push(page);
    return Promise.resolve({ changed: true, created: true, skipped: false });
  }
  return Promise.resolve({ changed: false, created: false, skipped: false });
}
