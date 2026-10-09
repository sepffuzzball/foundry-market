// Market record schemas, normalization and validation.
//
// This module is intentionally free of any Foundry globals so it can be
// imported by Node for tests. Only plain data helpers live here.

export const SCHEMA_VERSION = 1;
export const LOCATION_KIND = 'location';
export const SHOP_KIND = 'shop';
export const LEDGER_KIND = 'ledger';

export const STOCK_MODES = ['finite', 'unlimited', 'non-restocking'];
export const LEDGER_STATUSES = ['pending', 'committed', 'failed', 'needsRecovery'];
export const OWNER_LEVEL = 3;

const ID_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a compact, Foundry-style base62 id. Uses the Web Crypto API which
 * is available both in the browser and in modern Node (>= 20).
 */
export function makeId(length = 16) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ID_CHARS[byte % ID_CHARS.length];
  return out;
}

export function assertString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw new Error(`[market] '${label}' must be a string, got ${typeof value}`);
  }
  if (!allowEmpty && value.trim() === '') {
    throw new Error(`[market] '${label}' must not be empty`);
  }
  return value;
}

export function assertInteger(value, label, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`[market] '${label}' must be a safe integer, got ${value}`);
  }
  if (value < min) {
    throw new Error(`[market] '${label}' must be >= ${min}, got ${value}`);
  }
  return value;
}

export function assertPositiveInteger(value, label) {
  return assertInteger(value, label, { min: 1 });
}

export function assertBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new Error(`[market] '${label}' must be a boolean, got ${typeof value}`);
  }
  return value;
}

export function assertStockMode(value) {
  if (!STOCK_MODES.includes(value)) {
    throw new Error(
      `[market] 'stockMode' must be one of ${STOCK_MODES.join(', ')}, got ${value}`
    );
  }
  return value;
}

export function assertLedgerStatus(value) {
  if (!LEDGER_STATUSES.includes(value)) {
    throw new Error(
      `[market] ledger status must be one of ${LEDGER_STATUSES.join(', ')}, got ${value}`
    );
  }
  return value;
}

/**
 * A snapshot is valid item data only when it parses to a non-null object with a
 * non-empty `name`. Anything else (empty, a plain summary string, an array, a
 * JSON scalar) is not usable as a delivery source. This mirrors the commerce
 * fallback so the schema always agrees with what the purchase path can deliver.
 * Returns the parsed object, or null when the snapshot is not usable.
 */
export function parseItemData(snapshot) {
  if (!snapshot) return null;
  let parsed;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.name !== 'string' || parsed.name.trim() === '') return null;
  return parsed;
}

/**
 * Normalize an inventory entry. All integer/money fields are validated to be
 * non-negative safe integers so prices and quantities never drift to floats.
 *
 * `itemUuid` may be absent (empty) only when the entry also carries a valid
 * item snapshot as a delivery fallback - matching the commerce purchase path,
 * which can resolve the source from a snapshot when no live UUID exists.
 */
export function normalizeInventoryEntry(raw = {}) {
  const name = assertString(raw.name, 'entry.name');
  const price = assertInteger(raw.price ?? 0, 'entry.price');
  const quantity = assertInteger(raw.quantity ?? 0, 'entry.quantity');
  const stockMode = assertStockMode(raw.stockMode || 'finite');
  const itemUuid = String(raw.itemUuid ?? '').trim();
  const snapshot = assertString(raw.snapshot ?? '', 'entry.snapshot', {
    allowEmpty: true,
  });
  const snapshotData = parseItemData(snapshot);
  if (itemUuid === '' && !snapshotData) {
    throw new Error(`[market] 'entry.itemUuid' must not be empty without valid snapshot item data`);
  }

  return {
    id: raw.id || makeId(),
    itemUuid,
    snapshot,
    name,
    img: assertString(raw.img ?? '', 'entry.img', { allowEmpty: true }),
    quantity,
    stockMode,
    price,
    visible: raw.visible === false ? false : true,
  };
}

export function normalizeShop(raw = {}) {
  const name = assertString(raw.name, 'shop.name');
  const open = raw.open === false ? false : true;
  const createdAt = Number(raw.createdAt ?? Date.now());
  if (!Number.isSafeInteger(createdAt)) {
    throw new Error('[market] shop.createdAt must be a safe integer');
  }

  const inventory = (Array.isArray(raw.inventory) ? raw.inventory : []).map(
    normalizeInventoryEntry
  );

  return {
    id: raw.id || makeId(),
    name,
    locationId: assertString(raw.locationId ?? '', 'shop.locationId', {
      allowEmpty: true,
    }),
    description: assertString(raw.description ?? '', 'shop.description', {
      allowEmpty: true,
    }),
    theme: assertString(raw.theme ?? '', 'shop.theme', { allowEmpty: true }),
    owner: assertString(raw.owner ?? '', 'shop.owner', { allowEmpty: true }),
    open,
    inventory,
    createdAt,
  };
}

export function normalizeLocation(raw = {}) {
  const name = assertString(raw.name, 'location.name');
  const createdAt = Number(raw.createdAt ?? Date.now());
  if (!Number.isSafeInteger(createdAt)) {
    throw new Error('[market] location.createdAt must be a safe integer');
  }
  return {
    id: raw.id || makeId(),
    name,
    description: assertString(raw.description ?? '', 'location.description', {
      allowEmpty: true,
    }),
    theme: assertString(raw.theme ?? '', 'location.theme', {
      allowEmpty: true,
    }),
    createdAt,
  };
}

export function normalizeLedgerRecord(raw = {}) {
  const key = assertString(raw.key, 'ledger.key');
  const status = assertLedgerStatus(raw.status || 'pending');
  const payloadHash = assertString(raw.payloadHash ?? '', 'ledger.payloadHash', {
    allowEmpty: true,
  });
  const quantity = assertInteger(raw.quantity ?? 1, 'ledger.quantity', { min: 1 });
  const unitPrice = assertInteger(raw.unitPrice ?? 0, 'ledger.unitPrice');
  const totalPrice = assertInteger(raw.totalPrice ?? 0, 'ledger.totalPrice');
  const createdAt = Number(raw.createdAt ?? Date.now());
  const updatedAt = Number(raw.updatedAt ?? createdAt);

  return {
    id: raw.id || makeId(),
    key,
    status,
    payloadHash,
    userId: assertString(raw.userId ?? '', 'ledger.userId', {
      allowEmpty: true,
    }),
    shopId: assertString(raw.shopId ?? '', 'ledger.shopId', {
      allowEmpty: true,
    }),
    entryId: assertString(raw.entryId ?? '', 'ledger.entryId', {
      allowEmpty: true,
    }),
    actorId: assertString(raw.actorId ?? '', 'ledger.actorId', {
      allowEmpty: true,
    }),
    quantity,
    unitPrice,
    totalPrice,
    payload: raw.payload ?? {},
    outcome: raw.outcome ?? {},
    error: assertString(raw.error ?? '', 'ledger.error', { allowEmpty: true }),
    compensation: (Array.isArray(raw.compensation) ? raw.compensation : []).slice(),
    createdAt,
    updatedAt,
  };
}
