// System adapters for reading/writing wallets and item prices, and for
// delivering purchased items. Each adapter is intentionally independent of
// Foundry globals at import time so it can be unit-tested in Node.
//
// Supported systems:
//   - 'dnd5e'      : full support, cp/sp/ep/gp/pp converted to integer copper.
//   - 'dc20rpg'    : full support, cp/sp/gp/pp converted to integer copper (cp).
//   - 'twodsix'    : full support (Traveller), `system.financeValues.cash` credits.
//   - 'generic'    : fallback; requires GM-configured path settings.
//   - 'daggerheart': explicitly UNSUPPORTED until the GM configures the generic
//     adapter paths. It has no native item price, so no price path is guessed.
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

// Exact decimal-to-copper for the dynamic currency path. The price value is
// parsed as an exact BigInt rational (never binary float rounding), multiplied
// by the denomination factor, and any fractional-copper residue is rejected
// with no tolerance. The result is validated as a safe integer.
function priceValueToCopperExact(value, factor, label = 'price') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`[market] '${label}' must be a finite number, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`[market] '${label}' must be >= 0, got ${value}`);
  }
  const r = decimalToRational(value);
  const scaledNum = r.num * BigInt(factor);
  const quotient = scaledNum / r.den;
  const remainder = scaledNum % r.den;
  if (remainder !== 0n) {
    throw new Error(
      `[market] '${label}' (${value}) is not representable in copper (sub-copper)`
    );
  }
  if (quotient > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`[market] '${label}' copper value overflowed a safe integer`);
  }
  return Number(quotient);
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

// --- dynamic dnd5e currency config ------------------------------------------
//
// dnd5e 6.x exposes `CONFIG.DND5E.currencies`: an object keyed by denomination
// whose `conversion` field is UNITS PER GP - how many units of that denomination
// make up ONE gold piece (official release-6.0.5: cp.conversion === 100,
// sp.conversion === 10, ep.conversion === 2, gp.conversion === 1,
// pp.conversion === 0.1). The marketplace keeps integer copper as its minor-unit
// ledger, so the per-denomination copper factor is `conversion.cp /
// conversion[d]` (the reciprocal direction from the prior GP-per-unit reading,
// which misread the live config as a list of reciprocals and broke the balance
// read on the official table). All factor math uses exact decimal-string BigInt
// rationals -- never binary float rounding -- so a config whose ratios do not
// resolve to whole copper pieces fails closed before any wallet write.

function bigintGcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

// Largest accepted decimal scale: the number of digits after the point, once any
// scientific-notation exponent is applied. Financial currency conversions never
// need more than a handful of decimal places, so an absurd scale (e.g. 1e-300)
// is rejected rather than building an unbounded BigInt power of ten.
const MAX_DECIMAL_SCALE = 100;

// Parse a positive finite decimal (plain or scientific notation, e.g. '1e-7' or
// '1.23e+4') into an exact reduced BigInt rational. The exponent is bounded so an
// unsafe scale fails closed. Sign handling and the bare `0` case are supported,
// but callers validate finiteness/positivity beforehand.
function decimalToRational(value) {
  const s = String(value).trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  const sign = match ? match[1] : '';
  const intPart = match ? match[2] : '';
  const fracPart = match ? match[3] || '' : '';
  if (!match || (intPart === '' && fracPart === '')) {
    throw new Error(`[market] currency conversion must be a finite decimal, got '${s}'`);
  }
  const expStr = match[4];
  const exp = expStr === undefined ? 0 : Number(expStr);
  const mantissa = BigInt(intPart + fracPart);
  const scale = fracPart.length - exp;
  if (Math.abs(scale) > MAX_DECIMAL_SCALE) {
    throw new Error(
      `[market] currency conversion scale too large (exponent ${exp}), got '${s}'`
    );
  }
  let num;
  let den;
  if (scale > 0) {
    num = mantissa;
    den = 10n ** BigInt(scale);
  } else if (scale < 0) {
    num = mantissa * (10n ** BigInt(-scale));
    den = 1n;
  } else {
    num = mantissa;
    den = 1n;
  }
  if (sign === '-') num = -num;
  if (num === 0n) {
    return { num: 0n, den: 1n };
  }
  const g = bigintGcd(num, den);
  return { num: num / g, den: den / g };
}

// Render an exact terminating decimal string from a BigInt fraction. The
// fraction must reduce to a denominator of the form 2^a * 5^b (the only
// denominators that terminate in base 10); anything else is rejected rather than
// truncated, so a non-terminating GP value (e.g. 1/3 gp) fails closed instead of
// silently dropping digits.
function rationalToDecimalString(num, den) {
  if (den === 0n) {
    throw new Error('[market] currency conversion produced a zero denominator');
  }
  if (num === 0n) {
    return '0';
  }
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const intPart = abs / den;
  let rem = abs % den;
  if (rem === 0n) {
    return (negative ? '-' : '') + intPart.toString();
  }
  // A terminating decimal requires the reduced denominator to be 2^a * 5^b.
  // Strip every factor of 2 and 5; if a factor other than 2 or 5 remains the
  // fraction would repeat forever and must be rejected.
  let d = den;
  while (d % 2n === 0n) d /= 2n;
  while (d % 5n === 0n) d /= 5n;
  if (d !== 1n) {
    throw new Error('[market] currency conversion produced a non-terminating decimal');
  }
  let frac = '';
  while (rem !== 0n) {
    rem *= 10n;
    frac += (rem / den).toString();
    rem %= den;
  }
  frac = frac.replace(/0+$/, '');
  if (frac === '') {
    return (negative ? '-' : '') + intPart.toString();
  }
  return (negative ? '-' : '') + intPart.toString() + '.' + frac;
}

// Validate a denomination config item and return its `conversion` value.
function readCurrencyConversion(item, denom) {
  if (item == null || typeof item !== 'object') {
    throw new Error(`[market] currency '${denom}' config must be an object`);
  }
  const conv = item.conversion;
  const s = conv == null ? '' : String(conv).trim();
  if (
    !/^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s) ||
    !Number.isFinite(Number(conv)) ||
    Number(conv) <= 0
  ) {
    throw new Error(
      `[market] currency '${denom}' conversion must be a positive finite decimal, got ${conv}`
    );
  }
  return conv;
}

// Normalize a currency config into per-denomination copper factors. `factors[d]`
// is how many copper pieces equal one unit of denomination d
// (`conversion.cp / conversion[d]`, exact BigInt rational) - a config whose
// `conversion` values are UNITS PER GP so one gold piece equals `conversion.cp`
// copper and `conversion[d]` units of d. Throws on a malformed conversion, an
// inexact (fractional-copper) ratio, a factor that is not a positive safe
// integer, or a gp factor below 1.
function normalizeCurrencyConfig(config) {
  if (config == null || typeof config !== 'object') {
    throw new Error('[market] currency config must be an object');
  }
  if (config.cp == null || config.gp == null) {
    throw new Error("[market] currency config requires 'cp' and 'gp'");
  }
  const cpConv = readCurrencyConversion(config.cp, 'cp');
  const cpRational = decimalToRational(cpConv);
  const factors = {};
  for (const [denom, item] of Object.entries(config)) {
    const conv = readCurrencyConversion(item, denom);
    const dRational = decimalToRational(conv);
    // factor[d] = conversion.cp / conversion[d]  (exact BigInt rational)
    const num = cpRational.num * dRational.den;
    const den = cpRational.den * dRational.num;
    const g = bigintGcd(num, den);
    const reducedNum = num / g;
    const reducedDen = den / g;
    if (reducedDen !== 1n) {
      throw new Error(
        `[market] currency '${denom}' factor (${cpConv} / ${conv}) is not a whole number of copper`
      );
    }
    if (reducedNum <= 0n || reducedNum > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `[market] currency '${denom}' factor must be a positive safe integer, got ${reducedNum}`
      );
    }
    factors[denom] = Number(reducedNum);
  }
  if (factors.gp < 1) {
    throw new Error(`[market] currency 'gp' factor must be >= 1, got ${factors.gp}`);
  }
  return { factors, cpConv };
}

// Return the per-denomination copper conversion factors for a currency config.
export function dndCurrencyFactors(config) {
  return normalizeCurrencyConfig(config).factors;
}

// Format `copper` (integer copper pieces) as an exact decimal GP string. GP is
// `copper / factors.gp` - `factors.gp` is the validated cp-per-gp factor derived
// from the currency config (`conversion.cp / conversion.gp`, exact BigInt
// rational), i.e. the number of copper pieces equal to one gold piece. Using the
// validated factor (rather than `conversion.cp` alone) keeps GP exact even when a
// custom CONFIG sets `gp.conversion` to something other than 1; no floating point
// is involved. A ratio that cannot be rendered exactly as a terminating decimal
// (never a clean 2^a*5^b denominator) fails closed rather than truncating.
export function formatCopperAsGP(copper, config) {
  const n = toNonNegativeInteger(copper, 'copper');
  const { factors } = normalizeCurrencyConfig(config);
  const valueNum = BigInt(n);
  const valueDen = BigInt(factors.gp);
  return rationalToDecimalString(valueNum, valueDen);
}

// Format an integer copper amount for the player-facing dnd5e storefront. If the
// amount is strictly greater than one gold piece (the configured `factors.gp`
// threshold, i.e. how many copper make one gp), it is rendered as an exact decimal
// GP string with a unit; otherwise it is rendered as a copper count. The threshold
// is strict: 100 cp stays '100 cp' and 101 cp is '1.01 gp'. Invalid copper or a
// malformed config throws rather than rendering a wrong unit. When `config` is
// omitted the validated live CONFIG.DND5E.currencies / canonical defaults are used.
export function formatDnd5eDisplayPrice(copper, config) {
  const n = toNonNegativeInteger(copper, 'copper');
  const resolved = config == null ? foundryCurrencyConfig() : config;
  const { factors } = normalizeCurrencyConfig(resolved);
  if (n > factors.gp) {
    return `${formatCopperAsGP(n, resolved)} gp`;
  }
  return `${n} cp`;
}

// Canonical dnd5e UNITS-PER-GP defaults (1 gp = 100 cp, 1 gp = 10 sp, 1 gp = 2
// ep, 10 gp = 1 pp) matching the official release-6.0.5 table.
function defaultCurrencyConfig() {
  return {
    pp: { conversion: 0.1 },
    gp: { conversion: 1 },
    ep: { conversion: 2 },
    sp: { conversion: 10 },
    cp: { conversion: 100 },
  };
}

// Read the live dnd5e system config. `CONFIG.DND5E.currencies` carries each
// denomination's UNITS PER GP (cp.conversion === 100, gp.conversion === 1,
// pp.conversion === 0.1), so the value is passed through with no reciprocal -
// the opposite direction is handled by the factor math in normalizeCurrencyConfig.
// Falls back to the canonical defaults when no CONFIG is present (e.g. Node
// tests).
function foundryCurrencyConfig() {
  const currencies = globalThis.CONFIG?.DND5E?.currencies;
  if (!currencies || typeof currencies !== 'object') return defaultCurrencyConfig();
  const out = {};
  for (const key of Object.keys(currencies)) {
    const item = currencies[key];
    if (!item || typeof item !== 'object') continue;
    const u = item.conversion;
    if (typeof u !== 'number' || !Number.isFinite(u) || u <= 0) continue;
    out[key] = { conversion: u };
  }
  return out;
}

// Resolve the currency config for an adapter: an explicit getter/object wins,
// otherwise rely on CONFIG when available, otherwise the canonical defaults.
function resolveCurrencyConfig(opts) {
  const cc = opts?.currencyConfig;
  if (typeof cc === 'function') {
    const got = cc();
    if (got != null && typeof got === 'object') return got;
    return foundryCurrencyConfig();
  }
  if (cc != null && typeof cc === 'object') return cc;
  return foundryCurrencyConfig();
}

// Read an actor's currency object into integer copper, using the config factors.
// Unknown denominations carrying a nonzero balance are rejected (fail closed);
// unknown/zero denominations are ignored.
function currencyToCopper(currency, factors) {
  let copper = 0;
  const configured = new Set(Object.keys(factors));
  for (const [denom, raw] of Object.entries(currency || {})) {
    if (!configured.has(denom)) {
      const amount = raw == null ? 0 : Number(raw);
      if (amount !== 0) {
        throw new Error(`[market] unknown currency denomination '${denom}'`);
      }
      continue;
    }
    const n = toNonNegativeInteger(raw, `currency.${denom}`);
    const product = n * factors[denom];
    if (!Number.isSafeInteger(product)) {
      throw new Error(`[market] currency '${denom}' conversion overflowed a safe integer`);
    }
    copper += product;
    if (!Number.isSafeInteger(copper)) {
      throw new Error('[market] currency conversion overflowed a safe integer');
    }
  }
  return copper;
}

// Decompose a copper balance into the canonical largest-factor denomination
// breakdown (greedy, largest factor first) using only the configured factors.
function copperToCurrency(copper, factors) {
  const order = Object.keys(factors).sort((a, b) => factors[b] - factors[a]);
  let remaining = copper;
  const out = {};
  for (const denom of order) {
    const factor = factors[denom];
    out[denom] = Math.floor(remaining / factor);
    remaining %= factor;
  }
  return out;
}

export class Dnd5eAdapter extends BaseAdapter {
  constructor(opts = {}) {
    super({ systemId: 'dnd5e' });
    this._opts = opts;
  }

  // Resolve and validate the currency config snapshot for one operation.
  _configSnapshot() {
    const config = resolveCurrencyConfig(this._opts);
    return normalizeCurrencyConfig(config);
  }

  getBalance(actor) {
    return Promise.resolve().then(() => {
      const { factors } = this._configSnapshot();
      return currencyToCopper(actor?.system?.currency || {}, factors);
    });
  }

  async debit(actor, amount) {
    const { factors } = this._configSnapshot();
    const copper = currencyToCopper(actor?.system?.currency || {}, factors);
    const remaining = copper - toNonNegativeInteger(amount, 'amount');
    if (remaining < 0) {
      throw new Error(`[market] insufficient funds: need ${amount} copper, have ${copper}`);
    }
    const currency = copperToCurrency(remaining, factors);
    await actor.update({ 'system.currency': currency });
    return { amount, newBalance: remaining, currency };
  }

  async credit(actor, amount) {
    const { factors } = this._configSnapshot();
    const copper = currencyToCopper(actor?.system?.currency || {}, factors);
    const toAdd = toNonNegativeInteger(amount, 'amount');
    const result = copper + toAdd;
    if (!Number.isSafeInteger(result)) {
      throw new Error('[market] currency credit overflowed a safe integer');
    }
    const currency = copperToCurrency(result, factors);
    await actor.update({ 'system.currency': currency });
    return { amount, newBalance: result, currency };
  }

  async getItemPrice(item) {
    const { factors } = this._configSnapshot();
    const price = item?.system?.price || {};
    const value = price.value ?? 0;
    const denomination = assertString(price.denomination ?? 'gp', 'item.system.price.denomination');
    const factor = factors[denomination];
    if (factor == null) {
      throw new Error(`[market] unknown currency denomination '${denomination}'`);
    }
    const minorUnits = priceValueToCopperExact(value, factor, 'item.system.price.value');
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

// --- dc20rpg (DC20 RPG) currency + item price support --------------------------
//
// Source-backed against dc20rpg 0.10.7.0
// (module/dataModel/actorData.mjs + module/dataModel/itemData.mjs). The actor
// wallet is `system.currency.{cp,sp,gp,pp}`, each a non-negative safe integer,
// and the marketplace ledger uses the smallest unit, copper (`cp`): 1 cp, 1 sp
// = 10 cp, 1 gp = 100 cp, 1 pp = 1000 cp. There is no `ep` in DC20. Items price
// via `system.price.{value,currency}` (currency defaults to "gp") and carry a
// stack quantity at `system.quantity`.

export const DC20_DENOMINATIONS = ['cp', 'sp', 'gp', 'pp'];
export const DC20_DENOMINATION_FACTOR = { cp: 1, sp: 10, gp: 100, pp: 1000 };

export function dc20DenominationToCopper(denomination) {
  if (!(denomination in DC20_DENOMINATION_FACTOR)) {
    throw new Error(`[market] unknown currency denomination '${denomination}'`);
  }
  return DC20_DENOMINATION_FACTOR[denomination];
}

// Convert a DC20 actor currency object into integer copper (cp) minor units.
// Unknown denominations carrying a nonzero balance are rejected (fail closed);
// unknown zero balances are ignored.
function dc20CurrencyToCopper(currency = {}) {
  let copper = 0;
  const configured = new Set(DC20_DENOMINATIONS);
  for (const [denom, raw] of Object.entries(currency || {})) {
    if (!configured.has(denom)) {
      const amount = raw == null ? 0 : Number(raw);
      if (amount !== 0) {
        throw new Error(`[market] unknown currency denomination '${denom}'`);
      }
      continue;
    }
    const n = toNonNegativeInteger(raw, `currency.${denom}`);
    const product = n * DC20_DENOMINATION_FACTOR[denom];
    if (!Number.isSafeInteger(product)) {
      throw new Error(`[market] currency '${denom}' conversion overflowed a safe integer`);
    }
    copper += product;
    if (!Number.isSafeInteger(copper)) {
      throw new Error('[market] currency conversion overflowed a safe integer');
    }
  }
  return copper;
}

// Decompose integer copper into the canonical largest-factor denomination
// breakdown (greedy, largest factor first) across the DC20 denominations.
function dc20CopperToCurrency(copper) {
  let remaining = toNonNegativeInteger(copper, 'copper');
  const out = {};
  for (const d of ['pp', 'gp', 'sp', 'cp']) {
    const factor = DC20_DENOMINATION_FACTOR[d];
    out[d] = Math.floor(remaining / factor);
    remaining %= factor;
  }
  return out;
}

export class DC20Adapter extends GenericAdapter {
  constructor(config = {}, resolver = () => null) {
    super(
      { ...config, quantityPath: 'system.quantity', deliveryMode: 'embedded' },
      resolver
    );
    this.systemId = 'dc20rpg';
  }

  get supported() {
    return true;
  }

  getBalance(actor) {
    return Promise.resolve().then(() =>
      dc20CurrencyToCopper(actor?.system?.currency || {})
    );
  }

  async debit(actor, amount) {
    const copper = dc20CurrencyToCopper(actor?.system?.currency || {});
    const remaining = copper - toNonNegativeInteger(amount, 'amount');
    if (remaining < 0) {
      throw new Error(`[market] insufficient funds: need ${amount} cp, have ${copper}`);
    }
    const currency = dc20CopperToCurrency(remaining);
    await actor.update({ 'system.currency': currency });
    return { amount, newBalance: remaining, currency };
  }

  async credit(actor, amount) {
    const copper = dc20CurrencyToCopper(actor?.system?.currency || {});
    const toAdd = toNonNegativeInteger(amount, 'amount');
    const result = copper + toAdd;
    if (!Number.isSafeInteger(result)) {
      throw new Error('[market] currency credit overflowed a safe integer');
    }
    const currency = dc20CopperToCurrency(result);
    await actor.update({ 'system.currency': currency });
    return { amount, newBalance: result, currency };
  }

  async getItemPrice(item) {
    const price = item?.system?.price || {};
    const value = toNonNegativeInteger(price.value ?? 0, 'item.system.price.value');
    const denomination = assertString(
      price.currency ?? 'gp',
      'item.system.price.currency'
    );
    const factor = DC20_DENOMINATION_FACTOR[denomination];
    if (factor == null) {
      throw new Error(`[market] unknown currency denomination '${denomination}'`);
    }
    const minorUnits = value * factor;
    if (!Number.isSafeInteger(minorUnits)) {
      throw new Error('[market] item price overflowed a safe integer');
    }
    return { amount: minorUnits / factor, denomination, minorUnits };
  }

  // deliverItem/removeItem inherit GenericAdapter's embedded delivery, which
  // sets `system.quantity` via quantityPath and never mutates the source.
}

// --- Twodsix (Traveller) credits + item price support --------------------------
//
// Source-backed against Twodsix 7.7.0
// (src/module/data/actors/travellerData.js + src/module/data/items/gearData.js).
// The actor's numeric cash balance lives at `system.financeValues.cash` (a
// NumberField); `system.finances.cash` is only the DISPLAY string ("0", "10k",
// ...) and is never read here. An actor whose numeric cash is missing,
// non-numeric, negative, fractional or beyond a safe integer fails closed - no
// fallback to the display string. Credits are the only currency unit (no
// conversion), so an item price is its `system.price` non-negative safe integer
// and maps 1:1 to minor units. Items carry a stack quantity at `system.quantity`.

const TWODSIX_CASH_PATH = 'system.financeValues.cash';

export class TwodsixAdapter extends GenericAdapter {
  constructor(config = {}, resolver = () => null) {
    super(
      { ...config, quantityPath: 'system.quantity', deliveryMode: 'embedded' },
      resolver
    );
    this.systemId = 'twodsix';
  }

  get supported() {
    return true;
  }

  _readCash(actor) {
    const cash = actor?.system?.financeValues?.cash;
    return toNonNegativeInteger(cash, `path '${TWODSIX_CASH_PATH}' (cash)`);
  }

  getBalance(actor) {
    return Promise.resolve().then(() => this._readCash(actor));
  }

  async debit(actor, amount) {
    const current = this._readCash(actor);
    const next = current - toNonNegativeInteger(amount, 'amount');
    if (next < 0) {
      throw new Error(`[market] insufficient funds: need ${amount} credits, have ${current}`);
    }
    await actor.update(buildPatch(TWODSIX_CASH_PATH, next));
    return { amount, newBalance: next };
  }

  async credit(actor, amount) {
    const current = this._readCash(actor);
    const toAdd = toNonNegativeInteger(amount, 'amount');
    const next = current + toAdd;
    if (!Number.isSafeInteger(next)) {
      throw new Error('[market] credit overflowed a safe integer');
    }
    await actor.update(buildPatch(TWODSIX_CASH_PATH, next));
    return { amount, newBalance: next };
  }

  async getItemPrice(item) {
    const value = toNonNegativeInteger(
      item?.system?.price ?? 0,
      'item.system.price'
    );
    return { amount: value, denomination: 'credits', minorUnits: value };
  }

  // deliverItem/removeItem inherit GenericAdapter's embedded delivery, which
  // sets `system.quantity` via quantityPath and never mutates the source.
}

// --- Explicitly-unsupported subclass ------------------------------------------
//
// Daggerheart has no native item price, so no system-specific price path is
// invented. It behaves like the generic adapter but ONLY reports support when
// the GM has configured the generic paths; otherwise `supported === false` and
// the marketplace says "adapter unsupported" rather than guessing.

export class DaggerheartAdapter extends GenericAdapter {
  constructor(config = {}, resolver = () => null) {
    super(config, resolver);
    this.systemId = 'daggerheart';
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
    case 'dc20rpg':
    case 'dc20': // legacy system-id alias for dc20rpg
      return new DC20Adapter(config, resolver);
    case 'twodsix':
      return new TwodsixAdapter(config, resolver);
    default:
      return new GenericAdapter(config, resolver);
  }
}

export default getAdapter;
