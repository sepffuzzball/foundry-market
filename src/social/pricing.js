// Pure social-influenced pricing for the market core (M3 data layer).
//
// This module is intentionally free of Foundry globals so it can be imported by
// Node for tests. It layers shop, personality, reputation and haggle basis-point
// adjustments onto an entry's base price, ONCE (no compounding), and always
// rounds UP at the unit minor-unit so a player is never under-charged.
//
// The price order is: base item price (entry.price) -> additive
// shop/personality/reputation/haggle bps -> integer unit rounding -> quantity.
// All integer math is done with BigInt intermediates so the result is lossless
// for any input within the safe-integer envelope, and the final total is checked
// against Number.MAX_SAFE_INTEGER (overflow throws rather than wrapping).
//
// A base price of 0 (a free item) stays 0 regardless of adjustments. A positive
// base is never rounded below 1 minor unit. A Hated-reputation shop is flagged
// `refused` (the pure engine reports the refusal; wiring it into the purchase
// path is a later milestone).

import { assertPositiveInteger } from '../services/model.js';
import { assertMinorUnits } from '../services/pricing.js';
import { effectivePersonality } from './personalities.js';
import { effectiveReputation, reputationBand } from './reputation.js';

// Valid range for any single basis-point adjustment (shop, personality,
// reputation, haggle). Applied additively; each component is independently
// bounded to this range.
export const BPS_MIN = -9000;
export const BPS_MAX = 50000;

// Combined adjustment envelope. quoteSocial sums all four components
// additively, so the combined `adjustmentBps` may span the full sum of the
// per-component bounds (4 * -9000 = -36000 up to 4 * 50000 = 200000), and must
// be validated against these combined bounds rather than the per-component ones.
// `adjustmentBps` always retains the actual raw sum for a transparent breakdown.
export const COMBINED_BPS_MIN = -36000;
export const COMBINED_BPS_MAX = 200000;

// A combined discount at or below this many bps is a 100%+ discount: the price
// factor (BPS_SCALE + adjustmentBps) is zero or negative. quoteSocial clamps the
// factor to zero BEFORE the min-1 minor-unit clamp, so a positive base is never
// priced at zero and never goes negative, while a free base stays 0.
export const ZERO_BPS = -10000;

const BPS_SCALE = 10000;

function assertBps(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`[market] '${label}' must be a safe integer, got ${value}`);
  }
  if (value < BPS_MIN || value > BPS_MAX) {
    throw new Error(
      `[market] '${label}' must be between ${BPS_MIN} and ${BPS_MAX}, got ${value}`
    );
  }
  return value;
}

/**
 * Quote the social-influenced price of buying `quantity` units of `entry`.
 *
 * `shop` supplies the social settings (`shop.social`), whose personality and
 * reputation inputs drive the personality/reputation adjustments. `scores`
 * supplies `{ individual, party }` reputation scores for the buying actor (a
 * missing record counts as 0); `haggleBps` is an optional caller-supplied haggle
 * adjustment (default 0).
 *
 * Returns a full integer breakdown:
 *   { unitBase, quantity, baseTotal, shopBps, personalityBps, reputationBps,
 *     haggleBps, adjustmentBps, unitPrice, total, band, refused }
 *
 * Throws when quantity is not a positive integer, the base price is not a
 * non-negative safe integer, any single bps is outside [-9000, 50000], the
 * combined adjustment is outside [-36000, 200000], or the final total overflows a
 * safe integer.
 */
export function quoteSocial(entry, quantity, { shop, scores, haggleBps = 0 } = {}) {
  const qty = assertPositiveInteger(quantity, 'quantity');
  const base = assertMinorUnits(entry?.price ?? 0, 'entry.price');

  const social = shop?.social || {};
  // Personality: blend primary (+ optional secondary) and take its markup.
  const eff = effectivePersonality(
    social.primaryPersonality || 'honest',
    social.secondaryPersonality || '',
    social.secondaryWeight ?? 0
  );
  const personalityBps = assertBps(eff.markupBps, 'personalityBps');
  const shopBps = assertBps(social.shopMarkupBps ?? 0, 'shop.social.shopMarkupBps');
  const haggle = assertBps(haggleBps ?? 0, 'haggleBps');

  // Reputation: combine individual + party, then map the effective score to a
  // band. The lowest band (Hated) refuses a sale.
  const repScore = effectiveReputation(scores?.individual, scores?.party, {
    individualWeight: social.individualWeight,
    partyWeight: social.partyWeight,
    partyId: social.partyId,
  });
  const band = reputationBand(repScore);
  const reputationBps = assertBps(band.bps, 'reputationBps');
  const refused = band.refused;

  // Additive once. The sum is checked for safe-integer overflow so an extreme
  // combination of adjustments never silently wraps.
  const adjustmentBps = personalityBps + shopBps + reputationBps + haggle;
  if (!Number.isSafeInteger(adjustmentBps)) {
    throw new Error('[market] quoteSocial adjustmentBps overflowed a safe integer');
  }
  // Each component is already bounded, but the additive sum is validated against
  // the combined envelope so a valid combination of extremes (e.g. four -9000
  // components) never fails the quote.
  if (adjustmentBps < COMBINED_BPS_MIN || adjustmentBps > COMBINED_BPS_MAX) {
    throw new Error(
      `[market] quoteSocial adjustmentBps must be between ${COMBINED_BPS_MIN} and ${COMBINED_BPS_MAX}, got ${adjustmentBps}`
    );
  }

  const baseTotal = base * qty;
  if (!Number.isSafeInteger(baseTotal)) {
    throw new Error('[market] quoteSocial baseTotal overflowed a safe integer');
  }

  // Round UP at the unit minor-unit using BigInt. For a combined discount of 100%
  // or more (`adjustmentBps <= ZERO_BPS`) the price factor is zero or negative, so
  // clamp it to a zero factor FIRST: a positive base then floors at 1 minor unit
  // via the min-1 clamp below (never a zero or negative price), while a free base
  // stays 0. BigInt is used throughout so an extreme discount is lossless.
  const factor = adjustmentBps <= ZERO_BPS ? 0n : BigInt(BPS_SCALE + adjustmentBps);
  const numerator = BigInt(base) * factor;
  const denominator = BigInt(BPS_SCALE);
  let unitPriceBig = (numerator + denominator - 1n) / denominator; // ceil
  if (base === 0) unitPriceBig = 0n; // a free base stays 0
  else if (unitPriceBig < 1n) unitPriceBig = 1n; // positive base: min 1 minor unit
  const unitPrice = Number(unitPriceBig);

  const total = unitPrice * qty;
  if (!Number.isSafeInteger(total)) {
    throw new Error('[market] quoted total overflowed a safe integer');
  }

  return {
    unitBase: base,
    quantity: qty,
    baseTotal,
    shopBps,
    personalityBps,
    reputationBps,
    haggleBps: haggle,
    adjustmentBps,
    unitPrice,
    total,
    band: { title: band.title, threshold: band.threshold },
    refused,
  };
}
