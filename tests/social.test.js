// Unit tests for the M3 social data layer and pure reputation/pricing engine.
//
// These tests are pure: no Foundry globals, no storage, no commerce. They cover
// the 10 personality presets, the reputation tiers/clamp/weight blend, the
// social-influenced quote (rounding, free base, overflow, refusal), and the
// shop NPC/social normalization and legacy migration.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PERSONALITY_IDS,
  PERSONALITIES,
  isValidPersonality,
  getPersonality,
  effectivePersonality,
} from '../src/social/personalities.js';
import {
  REPUTATION_BANDS,
  REPUTATION_MIN,
  REPUTATION_MAX,
  clampReputation,
  reputationBand,
  effectiveReputation,
} from '../src/social/reputation.js';
import {
  quoteSocial,
  BPS_MIN,
  BPS_MAX,
  COMBINED_BPS_MIN,
  COMBINED_BPS_MAX,
  ZERO_BPS,
} from '../src/social/pricing.js';
import {
  normalizeShop,
  normalizeNpc,
  normalizeShopSocial,
  MAX_SHOP_NPCS,
} from '../src/services/model.js';

// ------------------------------------------------------- personalities

test('all ten personality presets exist with distinct mechanics', () => {
  assert.equal(PERSONALITY_IDS.length, 10);
  const seenMarkup = new Set();
  for (const id of PERSONALITY_IDS) {
    const p = getPersonality(id);
    assert.equal(p.id, id);
    assert.ok(PERSONALITIES[id], 'preset is registered under its id');
    assert.ok(typeof p.label === 'string' && p.label.length > 0, 'label');
    assert.ok(typeof p.description === 'string' && p.description.length > 0, 'description');
    assert.ok(Array.isArray(p.greetings) && p.greetings.length >= 2, 'greetings >= 2');
    assert.ok(Number.isSafeInteger(p.markupBps), 'markupBps integer');
    assert.ok(Number.isSafeInteger(p.haggleDifficulty), 'haggleDifficulty integer');
    assert.ok(Number.isSafeInteger(p.deceptionPenalty), 'deceptionPenalty integer');
    assert.ok(Number.isSafeInteger(p.repeatBonus), 'repeatBonus integer');
    assert.ok(p.markupBps >= BPS_MIN && p.markupBps <= BPS_MAX, 'markupBps in range');
    seenMarkup.add(p.markupBps);
  }
  assert.equal(seenMarkup.size, 10, 'every preset carries a distinct markupBps');
});

test('getPersonality falls back to honest and validates ids', () => {
  assert.equal(getPersonality('nope').id, 'honest');
  assert.equal(getPersonality(undefined).id, 'honest');
  assert.equal(getPersonality(null).id, 'honest');
  assert.equal(isValidPersonality('honest'), true);
  assert.equal(isValidPersonality('greedy'), true);
  assert.equal(isValidPersonality('nope'), false);
  assert.equal(isValidPersonality('__proto__'), false);
  assert.equal(isValidPersonality(undefined), false);
});

test('effectivePersonality returns the primary exactly for weight 0 or no secondary', () => {
  const p = getPersonality('honest');
  for (const noSecondary of [undefined, null, '']) {
    const e = effectivePersonality('honest', noSecondary, 50);
    assert.equal(e.markupBps, p.markupBps);
    assert.equal(e.haggleDifficulty, p.haggleDifficulty);
    assert.equal(e.deceptionPenalty, p.deceptionPenalty);
    assert.equal(e.repeatBonus, p.repeatBonus);
    assert.equal(e.id, p.id);
  }
  const zero = effectivePersonality('honest', 'greedy', 0);
  assert.equal(zero.markupBps, p.markupBps);
});

test('effectivePersonality blends mechanics by secondary weight', () => {
  const blended = effectivePersonality('honest', 'greedy', 50);
  // honest: markup 0, haggle 3, deception 0, repeat 10
  // greedy: markup 1500, haggle 1, deception 400, repeat 5
  assert.equal(blended.markupBps, 750);
  assert.equal(blended.haggleDifficulty, 2);
  assert.equal(blended.deceptionPenalty, 200);
  assert.equal(blended.repeatBonus, 8);
  assert.equal(blended.id, 'honest', 'identity comes from the primary');
});

test('effectivePersonality uses the secondary exactly for weight 100', () => {
  const e = effectivePersonality('honest', 'greedy', 100);
  assert.equal(e.markupBps, 1500);
  assert.equal(e.haggleDifficulty, 1);
  assert.equal(e.deceptionPenalty, 400);
  assert.equal(e.repeatBonus, 5);
});

test('effectivePersonality rejects an out-of-range or fractional secondaryWeight', () => {
  assert.throws(() => effectivePersonality('honest', 'greedy', 101), /between 0 and 100/);
  assert.throws(() => effectivePersonality('honest', 'greedy', -1), /between 0 and 100/);
  assert.throws(() => effectivePersonality('honest', 'greedy', 0.5), /safe integer/);
});

// ------------------------------------------------------- reputation tiers/clamp

test('clampReputation clamps into the documented range', () => {
  assert.equal(clampReputation(150), 100);
  assert.equal(clampReputation(-200), -100);
  assert.equal(clampReputation(25), 25);
  assert.equal(clampReputation(0), 0);
  assert.equal(clampReputation(NaN), 0);
  assert.equal(clampReputation(undefined), 0);
});

test('reputation band table is ordered with the documented thresholds', () => {
  assert.equal(REPUTATION_BANDS.length, 11);
  assert.deepEqual(
    REPUTATION_BANDS.map((b) => b.threshold),
    [-100, -75, -50, -25, -10, 0, 10, 25, 50, 75, 100]
  );
  assert.deepEqual(
    REPUTATION_BANDS.map((b) => b.title),
    ['Hated', 'Despised', 'Hostile', 'Distrusted', 'Disliked', 'Neutral',
     'Friendly', 'Trusted', 'Liked', 'Admired', 'Loved']
  );
  assert.equal(REPUTATION_BANDS[0].refused, true, 'only Hated refuses');
  assert.ok(REPUTATION_BANDS.slice(1).every((b) => b.refused === false));
  assert.ok(REPUTATION_BANDS.every((b) => Number.isSafeInteger(b.bps)));
});

test('reputation band bps match the documented default table', () => {
  assert.deepEqual(
    REPUTATION_BANDS.map((b) => b.bps),
    [4000, 3500, 2500, 1500, 1000, 0, -500, -750, -1000, -1250, -1500]
  );
});

test('reputationBand maps a score to the highest matching band', () => {
  assert.equal(reputationBand(100).title, 'Loved');
  assert.equal(reputationBand(75).title, 'Admired');
  assert.equal(reputationBand(50).title, 'Liked');
  assert.equal(reputationBand(25).title, 'Trusted');
  assert.equal(reputationBand(10).title, 'Friendly');
  assert.equal(reputationBand(9).title, 'Neutral');
  assert.equal(reputationBand(0).title, 'Neutral');
  assert.equal(reputationBand(-5).title, 'Disliked');
  assert.equal(reputationBand(-10).title, 'Disliked');
  assert.equal(reputationBand(-50).title, 'Hostile');
  assert.equal(reputationBand(-100).title, 'Hated');
  assert.equal(reputationBand(-200).title, 'Hated');
});

// ------------------------------------------------------- reputation weights

test('effectiveReputation uses 100% individual when there is no party', () => {
  assert.equal(effectiveReputation(20, 999, { partyId: '', individualWeight: 70, partyWeight: 30 }), 20);
  assert.equal(effectiveReputation(20, undefined, { partyId: '' }), 20);
});

test('effectiveReputation weights the individual and party scores', () => {
  const opts = { partyId: 'party1', individualWeight: 70, partyWeight: 30 };
  assert.equal(effectiveReputation(20, 80, opts), 38);
  assert.equal(
    effectiveReputation(20, 80, { partyId: 'party1', individualWeight: 0, partyWeight: 100 }),
    80
  );
  assert.equal(
    effectiveReputation(20, 80, { partyId: 'party1', individualWeight: 100, partyWeight: 0 }),
    20
  );
});

test('effectiveReputation treats a missing score as 0 and clamps inputs', () => {
  const opts = { partyId: 'party1', individualWeight: 70, partyWeight: 30 };
  assert.equal(effectiveReputation(undefined, 50, opts), 15);
  assert.equal(effectiveReputation(40, undefined, opts), 28);
  // High/low scores are clamped before blending.
  assert.equal(effectiveReputation(150, -50, opts), 55); // (100*70 + -50*30)/100
  assert.equal(effectiveReputation(20, 0, { partyId: '' }), 20);
});

test('effectiveReputation rejects a negative weight', () => {
  assert.throws(
    () => effectiveReputation(1, 2, { partyId: 'p', individualWeight: -1, partyWeight: 30 }),
    />= 0/
  );
});

// ------------------------------------------------------- shop social + NPC

test('normalizeShopSocial defaults to the documented neutral split', () => {
  const s = normalizeShopSocial();
  assert.equal(s.primaryPersonality, 'honest');
  assert.equal(s.secondaryPersonality, '');
  assert.equal(s.secondaryWeight, 0);
  assert.equal(s.individualWeight, 70);
  assert.equal(s.partyWeight, 30);
  assert.equal(s.partyId, '');
  assert.equal(s.shopMarkupBps, 0);
  assert.deepEqual(s.autoPurchase, { enabled: false, minimumSpend: 100, cooldownSeconds: 86400, delta: 1 });
});

test('normalizeShop enforces the strict weight percent sum', () => {
  assert.equal(normalizeShop({ name: 'S', social: { individualWeight: 50 } }).social.partyWeight, 50);
  assert.equal(normalizeShop({ name: 'S', social: { partyWeight: 40 } }).social.individualWeight, 60);
  assert.throws(
    () => normalizeShop({ name: 'S', social: { individualWeight: 50, partyWeight: 40 } }),
    /must equal 100/
  );
  assert.throws(
    () => normalizeShop({ name: 'S', social: { individualWeight: 101 } }),
    /between 0 and 100/
  );
});

test('a legacy shop owner migrates to the primary NPC', () => {
  const shop = normalizeShop({ name: 'S', locationId: 'L', owner: 'Bob' });
  assert.equal(shop.owner, 'Bob');
  assert.equal(shop.npcs.length, 1);
  assert.equal(shop.npcs[0].name, 'Bob');
  assert.equal(shop.npcs[0].personality, 'honest');
  assert.equal(shop.npcs[0].visible, true);
  assert.equal(shop.npcs[0].id, `owner-${shop.id}`);
});

test('re-normalizing a legacy shop yields the same primary NPC id', () => {
  const shop = normalizeShop({ name: 'S', locationId: 'L', owner: 'Bob' });
  const again = normalizeShop(shop);
  assert.equal(again.npcs[0].id, shop.npcs[0].id);
  assert.equal(again.npcs[0].id, `owner-${shop.id}`);
});

test('the primary NPC id is stable when the owner name changes', () => {
  const shop = normalizeShop({ name: 'S', locationId: 'L', owner: 'Bob' });
  const next = normalizeShop({ ...shop, owner: 'Alice' });
  assert.equal(next.npcs[0].id, shop.npcs[0].id);
  assert.equal(next.npcs[0].name, 'Alice');
  assert.equal(next.owner, 'Alice');
});

test('a shop with no owner has no NPCs', () => {
  const shop = normalizeShop({ name: 'S', locationId: 'L' });
  assert.equal(shop.npcs.length, 0);
  assert.equal(shop.owner, '');
});

test('a manager owner edit is preserved and applied to the primary NPC', () => {
  const legacy = normalizeShop({ name: 'S', locationId: 'L', owner: 'Bob' });
  const next = normalizeShop({ ...legacy, owner: 'Alice' });
  assert.equal(next.owner, 'Alice');
  assert.equal(next.npcs.length, 1);
  assert.equal(next.npcs[0].name, 'Alice');
});

test('owner string synchronizes from the first NPC on explicit NPC edits', () => {
  const shop = normalizeShop({
    name: 'S',
    locationId: 'L',
    npcs: [{ name: 'Aragorn', personality: 'proud' }],
  });
  assert.equal(shop.owner, 'Aragorn');
  assert.equal(shop.npcs[0].name, 'Aragorn');
  assert.equal(shop.npcs[0].personality, 'proud');
});

test('a shop carries at most three NPCs', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ name: `NPC${i}` }));
  const shop = normalizeShop({ name: 'S', locationId: 'L', npcs: many });
  assert.equal(shop.npcs.length, MAX_SHOP_NPCS);
  assert.equal(shop.npcs.length, 3);
  assert.equal(shop.npcs[0].name, 'NPC0');
  assert.equal(shop.npcs[2].name, 'NPC2');
});

test('normalizeNpc validates fields and defaults unknown personality to honest', () => {
  const npc = normalizeNpc({ name: 'A', personality: 'nope' });
  assert.equal(npc.personality, 'honest');
  assert.equal(npc.role, '');
  assert.equal(npc.actorUuid, '');
  assert.equal(npc.portrait, '');
  assert.equal(npc.greeting, '');
  assert.equal(npc.visible, true);
  assert.throws(() => normalizeNpc({}), /npcs\[\]\.name/);
  assert.throws(
    () => normalizeNpc({ name: 'A', portrait: 'https://cdn.example.com/a.png' }),
    /local media path/
  );
});

test('invalid social and autoPurchase params throw', () => {
  assert.throws(
    () => normalizeShop({ name: 'S', social: { shopMarkupBps: 60000 } }),
    /between -9000 and 50000/
  );
  assert.throws(
    () => normalizeShop({ name: 'S', social: { autoPurchase: { delta: 0 } } }),
    />= 1/
  );
  assert.throws(
    () => normalizeShop({ name: 'S', social: { autoPurchase: { minimumSpend: -1 } } }),
    />= 0/
  );
});

// ------------------------------------------------------- social pricing

test('quoteSocial layers bps additively once', () => {
  const shop = normalizeShop({
    name: 'S',
    locationId: 'L',
    owner: 'Bob',
    social: { primaryPersonality: 'greedy', shopMarkupBps: 1000 },
  });
  const q = quoteSocial({ price: 100 }, 2, { shop, scores: { individual: 0 }, haggleBps: 100 });
  assert.equal(q.shopBps, 1000);
  assert.equal(q.personalityBps, 1500);
  assert.equal(q.reputationBps, 0);
  assert.equal(q.haggleBps, 100);
  assert.equal(q.adjustmentBps, 2600);
  assert.equal(q.unitBase, 100);
  assert.equal(q.quantity, 2);
  assert.equal(q.baseTotal, 200);
  assert.equal(q.unitPrice, 126);
  assert.equal(q.total, 252);
  assert.equal(q.refused, false);
  assert.deepEqual(q.band, { title: 'Neutral', threshold: 0 });
});

test('quoteSocial rounds the unit price up at the minor unit', () => {
  const shop = normalizeShop({ name: 'S', locationId: 'L', social: { shopMarkupBps: 333 } });
  const q = quoteSocial({ price: 100 }, 1, { shop, scores: { individual: 0 } });
  assert.equal(q.adjustmentBps, 333);
  assert.equal(q.unitPrice, 104);
});

test('quoteSocial keeps a free base at 0 through adjustments', () => {
  const shop = normalizeShop({ name: 'S', locationId: 'L', social: { shopMarkupBps: 5000 } });
  const q = quoteSocial({ price: 0 }, 3, { shop, scores: { individual: 0 } });
  assert.equal(q.unitBase, 0);
  assert.equal(q.unitPrice, 0);
  assert.equal(q.total, 0);
  assert.equal(q.baseTotal, 0);
});

test('quoteSocial never rounds a positive base below 1 minor unit', () => {
  const shop = normalizeShop({ name: 'S', locationId: 'L', social: { shopMarkupBps: -9000 } });
  const q = quoteSocial({ price: 2 }, 1, { shop, scores: { individual: 0 } });
  assert.equal(q.adjustmentBps, -9000);
  assert.equal(q.unitPrice, 1);
  assert.equal(q.refused, false);
});

test('quoteSocial rejects a total that overflows a safe integer', () => {
  const shop = normalizeShop({ name: 'S', locationId: 'L' });
  const big = Number.MAX_SAFE_INTEGER;
  assert.throws(() => quoteSocial({ price: big }, 10, { shop, scores: { individual: 0 } }), /overflowed a safe integer/);
});

test('quoteSocial flags a Hated reputation as refused', () => {
  const shop = normalizeShop({ name: 'S', locationId: 'L' });
  const q = quoteSocial({ price: 100 }, 1, { shop, scores: { individual: -100, party: 0 } });
  assert.equal(q.refused, true);
  assert.deepEqual(q.band, { title: 'Hated', threshold: -100 });
  assert.equal(q.reputationBps, 4000);
});

test('quoteSocial applies a reputation discount and never goes negative', () => {
  const shop = normalizeShop({ name: 'S', locationId: 'L' });
  const q = quoteSocial({ price: 100 }, 4, { shop, scores: { individual: 100 } });
  assert.equal(q.reputationBps, -1500);
  assert.equal(q.adjustmentBps, -1500);
  assert.equal(q.unitPrice, 85);
  assert.equal(q.total, 340);
  assert.ok(q.total >= 0);
});

test('quoteSocial tolerates a shop without social data', () => {
  const q = quoteSocial({ price: 50 }, 2, { shop: {}, scores: { individual: 0 } });
  assert.equal(q.personalityBps, 0);
  assert.equal(q.unitPrice, 50);
  assert.equal(q.total, 100);
});

test('quoteSocial rejects invalid quantity, price and bps', () => {
  assert.throws(() => quoteSocial({ price: 10 }, 0, { shop: {}, scores: {} }), /quantity/);
  assert.throws(() => quoteSocial({ price: -1 }, 1, { shop: {}, scores: {} }), /non-negative/);
  assert.throws(() => quoteSocial({ price: 1.5 }, 1, { shop: {}, scores: {} }), /safe integer/);
  assert.throws(() => quoteSocial({ price: 10 }, 1, { shop: {}, scores: {}, haggleBps: 60000 }), /between -9000 and 50000/);
  assert.throws(() => quoteSocial({ price: 10 }, 1, { shop: {}, scores: {}, haggleBps: -9001 }), /between -9000 and 50000/);
});

test('quoteSocial accepts a combination that exceeds a per-component bps bound', () => {
  // shopMarkupBps at its max + greedy personality: 50000 + 1500 = 51500, which is
  // above the per-component BPS_MAX (50000) but within the combined envelope.
  const shop = normalizeShop({
    name: 'S',
    locationId: 'L',
    social: { primaryPersonality: 'greedy', shopMarkupBps: 50000 },
  });
  const q = quoteSocial({ price: 100 }, 1, { shop, scores: { individual: 0 } });
  assert.equal(q.shopBps, 50000);
  assert.equal(q.personalityBps, 1500);
  assert.equal(q.reputationBps, 0);
  assert.equal(q.adjustmentBps, 51500);
  assert.equal(q.unitPrice, 615);
  assert.equal(q.total, 615);
  assert.equal(q.refused, false);
});

test('quoteSocial accepts the full combined adjustment range without throwing', () => {
  // A Hated reputation (+4000) plus shop/haggle at their max: the raw sum is
  // 50000 + 1500 + 4000 + 50000 = 105500, far above the per-component bound, yet
  // the quote must not fail (it only refuses at the purchase path, not here).
  const shop = normalizeShop({
    name: 'S',
    locationId: 'L',
    social: { primaryPersonality: 'greedy', shopMarkupBps: 50000 },
  });
  const q = quoteSocial({ price: 100 }, 1, {
    shop,
    scores: { individual: -100, party: 0 },
    haggleBps: 50000,
  });
  assert.equal(q.adjustmentBps, 105500);
  assert.equal(q.refused, true, 'Hated still reports a refusal');
  assert.ok(q.unitPrice > 0);
  assert.ok(q.total >= 0);
});

test('quoteSocial floors an extreme combined discount at 1 minor unit (no negative price)', () => {
  // generous -1000, shop -9000, Loved -1500, haggle -9000 => -20500 (>= 100%).
  const shop = normalizeShop({
    name: 'S',
    locationId: 'L',
    social: { primaryPersonality: 'generous', shopMarkupBps: -9000 },
  });
  const q = quoteSocial({ price: 100 }, 2, { shop, scores: { individual: 100 }, haggleBps: -9000 });
  assert.equal(q.adjustmentBps, -20500);
  assert.equal(q.unitPrice, 1);
  assert.equal(q.total, 2);
  assert.equal(q.refused, false);
  assert.ok(q.total >= 0);
});

test('quoteSocial keeps a free base at 0 under an extreme combined discount', () => {
  const shop = normalizeShop({
    name: 'S',
    locationId: 'L',
    social: { primaryPersonality: 'generous', shopMarkupBps: -9000 },
  });
  const q = quoteSocial({ price: 0 }, 3, { shop, scores: { individual: 100 }, haggleBps: -9000 });
  assert.equal(q.adjustmentBps, -20500);
  assert.equal(q.unitPrice, 0);
  assert.equal(q.total, 0);
  assert.ok(q.total >= 0);
});

test('bps constants are the documented boundary', () => {
  assert.equal(BPS_MIN, -9000);
  assert.equal(BPS_MAX, 50000);
  assert.equal(COMBINED_BPS_MIN, 4 * BPS_MIN, 'combined min is the sum of four per-component minima');
  assert.equal(COMBINED_BPS_MAX, 4 * BPS_MAX, 'combined max is the sum of four per-component maxima');
  assert.equal(ZERO_BPS, -10000, 'a 100% discount is the zero-price threshold');
  assert.equal(REPUTATION_MIN, -100);
  assert.equal(REPUTATION_MAX, 100);
});
