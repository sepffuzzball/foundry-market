// System adapters for reading/writing wallets and item prices, and for
// delivering purchased items. Each adapter is intentionally independent of
// Foundry globals at import time so it can be unit-tested in Node.
//
// Supported systems:
//   - 'dnd5e'   : full support, cp/sp/ep/gp/pp converted to integer copper.
//   - 'generic' : fallback; requires GM-configured path settings.
//   - 'daggerheart' | 'dc20' | 'twodsix' : explicitly UNSUPPORTED until the GM
//     configures the generic adapter paths. No paths are guessed.
//
// Inventory prices are stored as integer "minor units" - the smallest currency
// unit of the active system (copper for dnd5e). The adapter is responsible for
// bridging the marketplace's minor-unit integer to the system's representation.

import { makeId, assertString } from '../services/model.js';

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

export function assertSafeSegment(segment) {
  if (RESERVED.has(segment)) {
    throw new Error(`[market] path uses reserved segment '${segment}'`);
  }
  if (segment === '') {
    throw new Error('[market] path contains an empty segment');
  }
  return segment;
}

export function splitPath(path) {
  if (typeof path !== 'string' || path.trim() === '') return [];
  return path
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Safely read `path` from `obj`. Returns undefined when a segment is missing. */
export function readPath(obj, path) {
  if (path == null || path === '') return obj;
  let current = obj;
  for (const segment of splitPath(path)) {
    assertSafeSegment(segment);
    if (current == null || typeof current !== 'object') return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Coerce a value to a non-negative safe integer. Rejects nonnumeric, negative
 * and unsafe (non-integer / beyond MAX_SAFE_INTEGER) values.
 */
export function toNonNegativeInteger(value, label = 'value') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`[market] '${label}' must be a finite number, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`[market] '${label}' must be >= 0, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`[market] '${label}' must be a safe integer, got ${value}`);
  }
  return value;
}

export function readIntegerPath(obj, path, label) {
  return toNonNegativeInteger(readPath(obj, path), `path '${path}' (${label})`);
}

/**
 * Convert a denomination amount (possibly a finite, non-negative fractional
 * number like `0.1` gp) to integer copper when it is exactly representable.
 * A value that cannot be expressed as a whole number of copper (e.g. `0.005`
 * gp = 0.5 cp) is rejected. The result is validated to be a safe integer, so
 * overflow is detected rather than silently wrapping.
 */
export function priceValueToCopper(value, factor, label = 'price') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`[market] '${label}' must be a finite number, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`[market] '${label}' must be >= 0, got ${value}`);
  }
  const copper = value * factor;
  const rounded = Math.round(copper);
  // Tolerate the tiny floating-point error produced by valid fractions
  // (e.g. 0.29 gp -> 28.999999999999996) while rejecting true sub-copper
  // values whose copper amount is genuinely fractional.
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(copper)) * 8;
  if (Math.abs(copper - rounded) > tolerance) {
    throw new Error(
      `[market] '${label}' (${value}) is not representable in copper (sub-copper)`
    );
  }
  if (!Number.isSafeInteger(rounded)) {
    throw new Error(`[market] '${label}' copper value overflowed a safe integer`);
  }
  return rounded;
}

/**
 * Build an update patch for a dot-path against a Foundry document. The key is
 * the literal dot path so Foundry's diffing resolves the nested value.
 */
export function buildPatch(path, value) {
  if (path == null || path === '') {
    throw new Error('[market] cannot build a patch for an empty path');
  }
  return { [path]: value };
}

/**
 * Return a deep-ish clone of `obj` with `value` set at `path`, cloning only the
 * segments traversed. Never mutates the source object. Prototype-pollution safe.
 */
export function setPath(obj, path, value) {
  const segments = splitPath(path);
  if (segments.length === 0) return value;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return value;
    const result = obj.slice();
    setIn(result, segments, value);
    return result;
  }
  const result = { ...obj };
  setIn(result, segments, value);
  return result;
}

function setIn(container, segments, value) {
  let target = container;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    assertSafeSegment(segment);
    const nextSegment = segments[i + 1];
    const nextIsIndex = /^\d+$/.test(nextSegment);
    const current = target[segment];
    const fallback = nextIsIndex ? [] : {};
    const next =
      current == null || typeof current !== 'object'
        ? fallback
        : Array.isArray(current)
        ? current.slice()
        : { ...current };
    target[segment] = next;
    target = next;
  }
  const last = segments[segments.length - 1];
  assertSafeSegment(last);
  target[last] = value;
}

function cfgString(config, resolver, key, settingKey) {
  if (config[key] != null && config[key] !== '') return String(config[key]);
  const resolved = resolver(settingKey);
  return resolved == null ? '' : String(resolved);
}

/** Remove fields that must not be carried onto a newly created item. */
export function cleanItemData(itemData) {
  const data = structuredClone(itemData);
  delete data._id;
  delete data.ownership;
  delete data.folder;
  delete data.sort;
  return data;
}

export class BaseAdapter {
  constructor(opts = {}) {
    this._opts = opts;
    this.systemId = opts.systemId || 'generic';
    this.unsupportedReason = '';
    this._supported = true;
  }

  get supported() {
    return this._supported;
  }
  getBalance() {
    throw new Error('[market] adapter subclass must implement getBalance');
  }
  debit() {
    throw new Error('[market] adapter subclass must implement debit');
  }
  credit() {
    throw new Error('[market] adapter subclass must implement credit');
  }
  getItemPrice() {
    throw new Error('[market] adapter subclass must implement getItemPrice');
  }
  deliverItem() {
    throw new Error('[market] adapter subclass must implement deliverItem');
  }
  removeItem() {
    throw new Error('[market] adapter subclass must implement removeItem');
  }
}

export class GenericAdapter extends BaseAdapter {
  constructor(config = {}, resolver = () => null) {
    super({ systemId: 'generic' });
    this.cfg = config;
    this.resolve = resolver;
    this.walletPath = cfgString(config, resolver, 'walletPath', 'genericWallet');
    this.itemPricePath = cfgString(config, resolver, 'itemPricePath', 'genericPrice');
    this.itemPriceDenominationPath = cfgString(
      config,
      resolver,
      'itemPriceDenominationPath',
      'genericPriceDenomination'
    );
    this.deliveryMode =
      cfgString(config, resolver, 'deliveryMode', 'genericDeliveryMode') || 'embedded';
    this.deliveryPath = cfgString(config, resolver, 'deliveryPath', 'genericDeliveryPath');
    this.quantityPath = cfgString(config, resolver, 'quantityPath', 'genericQuantityPath');
  }

  get supported() {
    return !!(this.walletPath && this.itemPricePath);
  }

  _unsupported() {
    return new Error(
      `[market] generic adapter paths are not configured (walletPath=${this.walletPath || '<empty>'}, itemPricePath=${this.itemPricePath || '<empty>'})`
    );
  }

  getBalance(actor) {
    if (!this.supported) return Promise.resolve().then(() => Promise.reject(this._unsupported()));
    let value;
    try {
      value = readIntegerPath(actor, this.walletPath, 'wallet');
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve(value);
  }

  async debit(actor, amount) {
    if (!this.supported) throw this._unsupported();
    const current = readIntegerPath(actor, this.walletPath, 'wallet');
    const next = current - toNonNegativeInteger(amount, 'amount');
    if (next < 0) {
      throw new Error(`[market] insufficient funds: need ${amount}, have ${current}`);
    }
    await actor.update(buildPatch(this.walletPath, next));
    return { amount, newBalance: next };
  }

  async credit(actor, amount) {
    if (!this.supported) throw this._unsupported();
    const current = readIntegerPath(actor, this.walletPath, 'wallet');
    const next = current + toNonNegativeInteger(amount, 'amount');
    await actor.update(buildPatch(this.walletPath, next));
    return { amount, newBalance: next };
  }

  getItemPrice(item) {
    if (!this.supported) return Promise.resolve().then(() => Promise.reject(this._unsupported()));
    let amount;
    try {
      amount = readIntegerPath(item, this.itemPricePath, 'item price');
    } catch (err) {
      return Promise.reject(err);
    }
    const denomination = this.itemPriceDenominationPath
      ? readPath(item, this.itemPriceDenominationPath)
      : null;
    return Promise.resolve({
      amount,
      denomination: denomination == null ? null : String(denomination),
      minorUnits: amount,
    });
  }

  async deliverItem(actor, item, { quantity = 1 } = {}) {
    if (!this.supported) throw this._unsupported();
    const source = item?.toObject ? item.toObject() : item;
    const data = cleanItemData(source);

    if (this.quantityPath) {
      const withQty = setPath(data, this.quantityPath, toNonNegativeInteger(quantity, 'quantity'));
      Object.assign(data, withQty);
    } else if (
      data.system &&
      data.system.quantity != null &&
      typeof data.system.quantity === 'number'
    ) {
      data.system.quantity = quantity;
    }

    if (this.deliveryMode === 'embedded') {
      const created = await actor.createEmbeddedDocuments('Item', [data]);
      const doc = Array.isArray(created) ? created[0] : created;
      return { item: doc, id: doc && doc.id };
    }

    if (this.deliveryMode === 'path') {
      if (!this.deliveryPath) {
        throw new Error('[market] generic delivery path not configured');
      }
      const existing = readPath(actor, this.deliveryPath);
      const list = Array.isArray(existing) ? existing.slice() : [];
      const keyId = data.id || makeId();
      const payload = { ...data, id: keyId };
      list.push(payload);
      await actor.update(buildPatch(this.deliveryPath, list));
      return { item: payload, id: keyId };
    }

    throw new Error(`[market] unknown generic delivery mode '${this.deliveryMode}'`);
  }

  async removeItem(actor, itemId) {
    if (!this.supported) throw this._unsupported();
    if (this.deliveryMode === 'embedded') {
      await actor.deleteEmbeddedDocuments('Item', [itemId]);
      return true;
    }
    if (this.deliveryMode === 'path') {
      const existing = readPath(actor, this.deliveryPath) || [];
      const list = (Array.isArray(existing) ? existing : []).filter(
        (x) => x && x.id !== itemId
      );
      await actor.update(buildPatch(this.deliveryPath, list));
      return true;
    }
    return false;
  }
}

// --- dnd5e currency + item price support -------------------------------------

export const DENOMINATIONS = ['cp', 'sp', 'ep', 'gp', 'pp'];
export const DENOMINATION_FACTOR = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };

export function denominationToCopper(denomination) {
  if (!(denomination in DENOMINATION_FACTOR)) {
    throw new Error(`[market] unknown currency denomination '${denomination}'`);
  }
  return DENOMINATION_FACTOR[denomination];
}

export function denominationsToCopper(currency = {}) {
  let copper = 0;
  for (const d of DENOMINATIONS) {
    const amount = currency[d] == null ? 0 : currency[d];
    const n = toNonNegativeInteger(amount, `currency.${d}`);
    const product = n * DENOMINATION_FACTOR[d];
    if (!Number.isSafeInteger(product)) {
      throw new Error(`[market] 'currency.${d}' conversion overflowed a safe integer`);
    }
    const sum = copper + product;
    if (!Number.isSafeInteger(sum)) {
      throw new Error('[market] currency conversion overflowed a safe integer');
    }
    copper = sum;
  }
  return copper;
}

export function copperToDenominations(copper) {
  let remaining = toNonNegativeInteger(copper, 'copper');
  const out = {};
  for (const d of ['pp', 'gp', 'ep', 'sp']) {
    const factor = DENOMINATION_FACTOR[d];
    out[d] = Math.floor(remaining / factor);
    remaining %= factor;
  }
  out.cp = remaining;
  return out;
}

export class Dnd5eAdapter extends BaseAdapter {
  constructor(opts = {}) {
    super({ systemId: 'dnd5e' });
  }

  getBalance(actor) {
    return Promise.resolve(denominationsToCopper(actor?.system?.currency || {}));
  }

  async debit(actor, amount) {
    const copper = denominationsToCopper(actor?.system?.currency || {});
    const remaining = copper - toNonNegativeInteger(amount, 'amount');
    if (remaining < 0) {
      throw new Error(`[market] insufficient funds: need ${amount} copper, have ${copper}`);
    }
    const currency = copperToDenominations(remaining);
    await actor.update({ 'system.currency': currency });
    return { amount, newBalance: remaining, currency };
  }

  async credit(actor, amount) {
    const copper = denominationsToCopper(actor?.system?.currency || {});
    const toAdd = toNonNegativeInteger(amount, 'amount');
    const result = copper + toAdd;
    if (!Number.isSafeInteger(result)) {
      throw new Error('[market] currency credit overflowed a safe integer');
    }
    const currency = copperToDenominations(result);
    await actor.update({ 'system.currency': currency });
    return { amount, newBalance: result, currency };
  }

  async getItemPrice(item) {
    const price = item?.system?.price || {};
    const value = price.value ?? 0;
    const denomination = assertString(price.denomination ?? 'gp', 'item.system.price.denomination');
    const factor = denominationToCopper(denomination);
    const minorUnits = priceValueToCopper(value, factor, 'item.system.price.value');
    return { amount: minorUnits / factor, denomination, minorUnits };
  }

  async deliverItem(actor, item, { quantity = 1 } = {}) {
    const source = item?.toObject ? item.toObject() : item;
    const data = cleanItemData(source);
    if (
      data.system &&
      data.system.quantity != null &&
      typeof data.system.quantity === 'number'
    ) {
      data.system.quantity = quantity;
    }
    const created = await actor.createEmbeddedDocuments('Item', [data]);
    const doc = Array.isArray(created) ? created[0] : created;
    return { item: doc, id: doc && doc.id };
  }

  async removeItem(actor, itemId) {
    await actor.deleteEmbeddedDocuments('Item', [itemId]);
    return true;
  }
}

// --- Explicitly-unsupported subclasses ----------------------------------------
//
// These systems are not (yet) modeled with system-specific paths. They behave
// like the generic adapter but ONLY report support when the GM has configured
// the generic paths; otherwise `supported === false` and the marketplace says
// "adapter unsupported" rather than guessing.

export class DaggerheartAdapter extends GenericAdapter {
  constructor(config = {}, resolver = () => null) {
    super(config, resolver);
    this.systemId = 'daggerheart';
  }
}

export class DC20Adapter extends GenericAdapter {
  constructor(config = {}, resolver = () => null) {
    super(config, resolver);
    this.systemId = 'dc20';
  }
}

export class TwodsixAdapter extends GenericAdapter {
  constructor(config = {}, resolver = () => null) {
    super(config, resolver);
    this.systemId = 'twodsix';
  }
}

/**
 * Resolve the adapter for a system id. Unknown/falsy systems fall back to the
 * generic adapter. `opts.config` is a direct config object; `opts.resolver` is
 * `(settingKey) => value` used to read configured path settings at runtime.
 */
export function getAdapter(systemId, opts = {}) {
  const { config = {}, resolver = () => null } = opts;
  switch (String(systemId || 'generic')) {
    case 'dnd5e':
      return new Dnd5eAdapter(opts);
    case 'daggerheart':
      return new DaggerheartAdapter(config, resolver);
    case 'dc20':
      return new DC20Adapter(config, resolver);
    case 'twodsix':
      return new TwodsixAdapter(config, resolver);
    default:
      return new GenericAdapter(config, resolver);
  }
}

export default getAdapter;
