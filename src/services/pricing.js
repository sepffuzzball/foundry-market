// Pure integer pricing math for the market core.
//
// All prices are expressed in integer "minor units" (the smallest currency
// unit of the active system). No floats are ever produced by these helpers,
// so tests can assert exact integer equality.

import { assertPositiveInteger } from './model.js';

export function assertMinorUnits(price, label = 'price') {
  if (!Number.isSafeInteger(price)) {
    throw new Error(
      `[market] '${label}' must be a safe integer in minor units, got ${price}`
    );
  }
  if (price < 0) {
    throw new Error(`[market] '${label}' must be non-negative, got ${price}`);
  }
  return price;
}

/**
 * Quote the total cost of buying `quantity` units of an entry whose unit price
 * is `entry.price`. Returns only integers; throws on invalid inputs.
 */
export function quote(entry, quantity) {
  const qty = assertPositiveInteger(quantity, 'quantity');
  const unitPrice = assertMinorUnits(entry?.price, 'entry.price');
  const total = unitPrice * qty;
  if (!Number.isSafeInteger(total)) {
    throw new Error('[market] quoted total overflowed a safe integer');
  }
  return total;
}

/**
 * Return the full quote breakdown. Every member is an integer.
 */
export function quoteBreakdown(entry, quantity) {
  const qty = assertPositiveInteger(quantity, 'quantity');
  const unitPrice = assertMinorUnits(entry?.price, 'entry.price');
  const total = unitPrice * qty;
  if (!Number.isSafeInteger(total)) {
    throw new Error('[market] quoted total overflowed a safe integer');
  }
  return { unitPrice, quantity: qty, total };
}

/**
 * Add two integer minor-unit amounts safely.
 */
export function add(a, b) {
  const x = assertMinorUnits(a, 'a');
  const y = assertMinorUnits(b, 'b');
  const sum = x + y;
  if (!Number.isSafeInteger(sum)) {
    throw new Error('[market] addition overflowed a safe integer');
  }
  return sum;
}

/**
 * Subtract `b` from `a` (both minor units). Throws if the result is negative.
 */
export function subtract(a, b) {
  const x = assertMinorUnits(a, 'a');
  const y = assertMinorUnits(b, 'b');
  const diff = x - y;
  if (diff < 0) {
    throw new Error(`[market] subtraction would go negative: ${x} - ${y}`);
  }
  return diff;
}

/**
 * Format an integer minor-unit amount with thousands separators and an
 * optional currency label. Purely cosmetic; never alters the integer value.
 */
export function formatMinorUnits(mu, { currency = 'cp', fractionDigits = 0 } = {}) {
  const value = assertMinorUnits(mu);
  const fixed = fractionDigits > 0 ? (value / 10 ** fractionDigits).toFixed(fractionDigits) : String(value);
  const [int, frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac} ${currency}` : `${grouped} ${currency}`;
}

/**
 * Parse a string or number into a non-negative integer minor-unit value.
 * Rejects floats, negatives, and non-numeric values.
 */
export function parseMinorUnits(value, label = 'price') {
  if (typeof value === 'number') return assertMinorUnits(value, label);
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/,/g, '');
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`[market] '${label}' must be an integer string, got '${value}'`);
    }
    const n = Number(trimmed);
    return assertMinorUnits(n, label);
  }
  throw new Error(`[market] '${label}' must be a number or integer string, got ${typeof value}`);
}
