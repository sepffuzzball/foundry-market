// Pure reputation tiers and blending for the market core (M3 data layer).
//
// This module is intentionally free of Foundry globals so it can be imported by
// Node for tests. It defines the fixed reputation band table (an ordered set of
// thresholds), a clamp helper, a band lookup, and a weighted blend of an
// individual and a party reputation into one effective score.
//
// Reputation is system-agnostic: scores are plain integers in [-100, 100]. Each
// band carries a display title, its threshold, a basis-point price modifier
// (reputationBps, additive into a quote) and a `refused` flag (the lowest band
// refuses a sale outright).

export const REPUTATION_MIN = -100;
export const REPUTATION_MAX = 100;

// Ordered ascending by threshold. `Hated` is the only refusing band. The
// basis-point price modifiers are the documented defaults: worse reputation
// surcharges more, better reputation discounts more, and the bands are strictly
// monotonic (Hated, the worst, carries the largest surcharge).
export const REPUTATION_BANDS = [
  { title: 'Hated', threshold: -100, bps: 4000, refused: true },
  { title: 'Despised', threshold: -75, bps: 3500, refused: false },
  { title: 'Hostile', threshold: -50, bps: 2500, refused: false },
  { title: 'Distrusted', threshold: -25, bps: 1500, refused: false },
  { title: 'Disliked', threshold: -10, bps: 1000, refused: false },
  { title: 'Neutral', threshold: 0, bps: 0, refused: false },
  { title: 'Friendly', threshold: 10, bps: -500, refused: false },
  { title: 'Trusted', threshold: 25, bps: -750, refused: false },
  { title: 'Liked', threshold: 50, bps: -1000, refused: false },
  { title: 'Admired', threshold: 75, bps: -1250, refused: false },
  { title: 'Loved', threshold: 100, bps: -1500, refused: false },
];

function assertWeight(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`[market] '${label}' must be a safe integer, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`[market] '${label}' must be >= 0, got ${value}`);
  }
  return value;
}

/**
 * Clamp a reputation score into [REPUTATION_MIN, REPUTATION_MAX] as an integer.
 * A missing or non-finite score collapses to 0 (neutral).
 */
export function clampReputation(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0;
  const v = Math.round(score);
  return v < REPUTATION_MIN ? REPUTATION_MIN : v > REPUTATION_MAX ? REPUTATION_MAX : v;
}

/**
 * Return the reputation band for `score`. The score is clamped into range first
 * (a value below -100 or above 100 maps to the end band), then the band with the
 * highest threshold not exceeding the score is returned. Never throws; returns
 * one of the REPUTATION_BANDS entries (with title, threshold, bps, refused).
 */
export function reputationBand(score) {
  const clamped = clampReputation(score);
  let band = REPUTATION_BANDS[0];
  for (const b of REPUTATION_BANDS) {
    if (b.threshold <= clamped) band = b;
    else break;
  }
  return band;
}

/**
 * Blend an individual and a party reputation score into a single effective
 * integer score using the supplied weights.
 *
 *   - `individual` / `party` are reputation scores (integers, clamped to
 *     [-100, 100]). A missing record (undefined/null/non-finite) counts as 0.
 *   - When `partyId` is empty there is no party, so the result is 100% the
 *     individual score.
 *   - Otherwise the two scores are combined as
 *     `round((individual * individualWeight + party * partyWeight) /
 *     (individualWeight + partyWeight))`.
 *
 * Weights must be non-negative safe integers; a zero total weight falls back to
 * 0. Never produces a float.
 */
export function effectiveReputation(individual, party, opts = {}) {
  const { individualWeight = 70, partyWeight = 30, partyId = '' } = opts;
  const ind = clampReputation(individual ?? 0);
  if (!partyId) return ind;
  const par = clampReputation(party ?? 0);
  const indW = assertWeight(individualWeight, 'individualWeight');
  const parW = assertWeight(partyWeight, 'partyWeight');
  const total = indW + parW;
  if (total <= 0) return 0;
  const num = ind * indW + par * parW;
  return Math.round(num / total);
}
