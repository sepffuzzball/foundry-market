// Unit tests for the M5 validated commerce configuration and the pure advanced
// commerce policies/quotes in `src/advanced/policy.js`.
//
// These tests are pure: no Foundry globals, no storage, no commerce, no UI.
// They cover the normalized `shop.commerce` / per-entry `access` defaults and
// fail-closed validation (caps, lengths, rate bounds, funds, actor-UUID rules),
// the integer rounding of sell/buyback/deposit quotes, the overflow behavior,
// and the backroom/private access restrictions (public requires visible, deny-all
// on an empty/-100 backroom, uuid OR reputation match).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeShop,
  normalizeInventoryEntry,
  normalizeCommerce,
  normalizeEntryAccess,
  MAX_COMMERCE_SERVICES,
  MAX_COMMERCE_SPECIALS,
  MAX_ACCESS_UUIDS,
  SERVICE_NAME_MAX,
  SERVICE_DESCRIPTION_MAX,
  SPECIAL_TITLE_MAX,
  SPECIAL_DESCRIPTION_MAX,
  COMMERCE_RATE_MIN,
  COMMERCE_RATE_MAX,
  COMMERCE_RATE_DEFAULT_BUY,
  COMMERCE_RATE_DEFAULT_BUYBACK,
  PREORDER_DEPOSIT_BPS_DEFAULT,
  PREORDER_MAX_PER_ACTOR_DEFAULT,
  ACCESS_MODES,
} from '../src/services/model.js';
import {
  canAccessEntry,
  visibleEntriesFor,
  quoteSell,
  quoteBuyback,
  quoteDeposit,
  quoteSpecial,
} from '../src/advanced/policy.js';

function makeShop(overrides = {}) {
  return normalizeShop({ id: 'shop1', name: 'General Store', ...overrides });
}

function makeEntry(overrides = {}) {
  return normalizeInventoryEntry({
    id: 'entry1',
    itemUuid: 'Compendium.books.Item.potion',
    name: 'Potion',
    price: 100,
    quantity: 5,
    ...overrides,
  });
}

const OK_UUID = 'Actor.alice';

// ---------------------------------------------------- commerce defaults

test('a shop with no commerce config normalizes to the documented defaults', () => {
  const shop = makeShop();
  assert.deepEqual(shop.commerce, {
    funds: null,
    buyRateBps: 5000,
    buybackRateBps: 12000,
    services: [],
    specials: [],
    preorders: { enabled: false, depositBps: 2500, maxPerActor: 3 },
    theft: { enabled: false },
    valuations: [],
  });
});

test('the commerce default constants match the documented values', () => {
  assert.equal(COMMERCE_RATE_DEFAULT_BUY, 5000);
  assert.equal(COMMERCE_RATE_DEFAULT_BUYBACK, 12000);
  assert.equal(PREORDER_DEPOSIT_BPS_DEFAULT, 2500);
  assert.equal(PREORDER_MAX_PER_ACTOR_DEFAULT, 3);
  assert.equal(COMMERCE_RATE_MIN, 0);
  assert.equal(COMMERCE_RATE_MAX, 20000);
  assert.equal(MAX_COMMERCE_SERVICES, 20);
  assert.equal(MAX_COMMERCE_SPECIALS, 20);
  assert.equal(MAX_ACCESS_UUIDS, 20);
  assert.equal(SERVICE_NAME_MAX, 100);
  assert.equal(SERVICE_DESCRIPTION_MAX, 400);
  assert.equal(SPECIAL_TITLE_MAX, 100);
  assert.equal(SPECIAL_DESCRIPTION_MAX, 400);
  assert.deepEqual(ACCESS_MODES, ['public', 'backroom']);
});

test('an inventory entry with no access config normalizes to public defaults', () => {
  const entry = makeEntry();
  assert.deepEqual(entry.access, { mode: 'public', actorUuids: [], minReputation: -100 });
});

test('a configured entry backroom access is preserved exactly', () => {
  const entry = makeEntry({
    access: { mode: 'backroom', actorUuids: ['Actor.alice'], minReputation: 25 },
  });
  assert.equal(entry.access.mode, 'backroom');
  assert.deepEqual(entry.access.actorUuids, ['Actor.alice']);
  assert.equal(entry.access.minReputation, 25);
});

test('an unknown access mode falls back to public', () => {
  const entry = makeEntry({ access: { mode: 'vip' } });
  assert.equal(entry.access.mode, 'public');
});

// ---------------------------------------------------- service/special defaults

test('a service normalizes to the documented default shape', () => {
  const shop = makeShop({
    commerce: { services: [{ id: 'svc1', name: 'Repair' }] },
  });
  const [service] = shop.commerce.services;
  assert.equal(service.id, 'svc1');
  assert.equal(service.name, 'Repair');
  assert.equal(service.description, '');
  assert.equal(service.price, 0);
  assert.equal(service.visible, true);
  assert.equal(service.enabled, true);
  assert.equal(service.manualFulfillment, true);
});

test('a special normalizes to the documented default shape', () => {
  const shop = makeShop({
    commerce: { specials: [{ id: 'sp1', title: 'Two for one' }] },
  });
  const [special] = shop.commerce.specials;
  assert.equal(special.id, 'sp1');
  assert.equal(special.title, 'Two for one');
  assert.equal(special.description, '');
  assert.equal(special.entryId, '');
  assert.equal(special.price, 0);
  assert.equal(special.visible, true);
  assert.deepEqual(special.actorUuids, []);
});

test('services and specials accept an explicit fallback id and generate one when absent', () => {
  const shop = makeShop({
    commerce: { services: [{ name: 'S' }], specials: [{ title: 'T' }] },
  });
  const { services, specials } = shop.commerce;
  assert.ok(typeof services[0].id === 'string' && services[0].id.length > 0);
  assert.ok(typeof specials[0].id === 'string' && specials[0].id.length > 0);
  const again = normalizeShop(shop);
  assert.equal(again.commerce.services[0].id, services[0].id);
  assert.equal(again.commerce.specials[0].id, specials[0].id);
});

// ---------------------------------------------------- fail-closed validation

test('a negative or fractional funds value fails closed', () => {
  assert.throws(() => makeShop({ commerce: { funds: -1 } }), />= 0/);
  assert.throws(() => makeShop({ commerce: { funds: 1.5 } }), /safe integer/);
  assert.equal(makeShop({ commerce: { funds: 0 } }).commerce.funds, 0);
  assert.equal(makeShop({ commerce: { funds: null } }).commerce.funds, null);
});

test('rates are bounded 0..20000 and buyback must be >= buy', () => {
  assert.throws(() => makeShop({ commerce: { buyRateBps: 20001 } }), /20000/);
  assert.throws(() => makeShop({ commerce: { buybackRateBps: -1 } }), /20000/);
  assert.throws(
    () => makeShop({ commerce: { buyRateBps: 20000 } }),
    /buybackRateBps/
  );
  assert.throws(
    () => makeShop({ commerce: { buyRateBps: 12000, buybackRateBps: 11999 } }),
    /buybackRateBps/
  );
  assert.equal(makeShop({ commerce: { buyRateBps: 20000, buybackRateBps: 20000 } }).commerce.buybackRateBps, 20000);
});

test('more than 20 services or specials is rejected, not sliced', () => {
  assert.throws(
    () =>
      makeShop({
        commerce: {
          services: Array.from({ length: MAX_COMMERCE_SERVICES + 1 }, (_, i) => ({
            name: `s${i}`,
          })),
        },
      }),
    /at most 20/
  );
  assert.throws(
    () =>
      makeShop({
        commerce: {
          specials: Array.from({ length: MAX_COMMERCE_SPECIALS + 1 }, (_, i) => ({
            title: `t${i}`,
          })),
        },
      }),
    /at most 20/
  );
});

test('exactly 20 services and specials are accepted', () => {
  const shop = makeShop({
    commerce: {
      services: Array.from({ length: MAX_COMMERCE_SERVICES }, (_, i) => ({ name: `s${i}` })),
      specials: Array.from({ length: MAX_COMMERCE_SPECIALS }, (_, i) => ({ title: `t${i}` })),
    },
  });
  assert.equal(shop.commerce.services.length, MAX_COMMERCE_SERVICES);
  assert.equal(shop.commerce.specials.length, MAX_COMMERCE_SPECIALS);
});

test('more than 20 allowlisted actor uuids is rejected on entry access and specials', () => {
  const many = Array.from({ length: MAX_ACCESS_UUIDS + 1 }, (_, i) => `Actor.${i}`);
  assert.throws(
    () => makeEntry({ access: { actorUuids: many } }),
    /at most 20/
  );
  assert.throws(
    () => makeShop({ commerce: { specials: [{ title: 'T', actorUuids: many }] } }),
    /at most 20/
  );
});

test('allowlisted actor uuids must match /^Actor\\.[A-Za-z0-9]+$/', () => {
  assert.throws(
    () => makeEntry({ access: { actorUuids: ['Item.abc'] } }),
    /Actor/
  );
  assert.throws(
    () => makeShop({ commerce: { specials: [{ title: 'T', actorUuids: ['Actor.'] }] } }),
    /Actor/
  );
  assert.equal(makeEntry({ access: { actorUuids: ['Actor.abc', 'Actor.9x'] } }).access.actorUuids.length, 2);
});

test('service/special name and title are required and capped to the documented maxima', () => {
  assert.throws(() => makeShop({ commerce: { services: [{ name: '' }] } }), /name/);
  assert.throws(() => makeShop({ commerce: { specials: [{ title: '' }] } }), /title/);
  const long = 'x'.repeat(SERVICE_NAME_MAX + 5);
  const shop = makeShop({
    commerce: { services: [{ name: long }], specials: [{ title: long }] },
  });
  assert.equal(shop.commerce.services[0].name.length, SERVICE_NAME_MAX);
  assert.equal(shop.commerce.specials[0].title.length, SPECIAL_TITLE_MAX);
});

test('service/special descriptions are capped to the documented maxima', () => {
  const long = 'y'.repeat(SERVICE_DESCRIPTION_MAX + 5);
  const shop = makeShop({
    commerce: {
      services: [{ name: 'S', description: long }],
      specials: [{ title: 'T', description: long }],
    },
  });
  assert.equal(shop.commerce.services[0].description.length, SERVICE_DESCRIPTION_MAX);
  assert.equal(shop.commerce.specials[0].description.length, SPECIAL_DESCRIPTION_MAX);
});

test('a negative service/special price fails closed', () => {
  assert.throws(
    () => makeShop({ commerce: { services: [{ name: 'S', price: -1 }] } }),
    />= 0/
  );
  assert.throws(
    () => makeShop({ commerce: { specials: [{ title: 'T', price: -1 }] } }),
    />= 0/
  );
});

test('entry access minReputation is bounded to the reputation range', () => {
  assert.throws(() => makeEntry({ access: { minReputation: 101 } }), /between/);
  assert.throws(() => makeEntry({ access: { minReputation: -101 } }), /between/);
  assert.equal(makeEntry({ access: { minReputation: 50 } }).access.minReputation, 50);
});

test('preorder fields are bounded: depositBps in rate range and maxPerActor >= 1', () => {
  assert.throws(
    () => makeShop({ commerce: { preorders: { depositBps: 20001 } } }),
    /20000/
  );
  assert.throws(
    () => makeShop({ commerce: { preorders: { maxPerActor: 0 } } }),
    />= 1/
  );
  assert.deepEqual(makeShop({ commerce: { preorders: { enabled: true, maxPerActor: 5 } } }).commerce.preorders, {
    enabled: true,
    depositBps: 2500,
    maxPerActor: 5,
  });
});

// ---------------------------------------------------- rounding / quotes

test('quoteSell floors the buy price in integer minor units', () => {
  assert.equal(quoteSell(100, { commerce: { buyRateBps: 3333 } }), 33);
  assert.equal(quoteSell(100, { commerce: { buyRateBps: 5000 } }), 50);
  assert.equal(quoteSell(100, { commerce: { buyRateBps: 20000 } }), 200);
  assert.equal(quoteSell(0, { commerce: { buyRateBps: 5000 } }), 0);
});

test('quoteSell uses the default buy rate when no shop config is present', () => {
  assert.equal(quoteSell(100, {}), 50);
  assert.equal(quoteSell(100, undefined), 50);
});

test('quoteBuyback ceils the buyback price in integer minor units', () => {
  assert.equal(quoteBuyback(100, { commerce: { buybackRateBps: 3333 } }), 34);
  assert.equal(quoteBuyback(100, { commerce: { buybackRateBps: 12000 } }), 120);
  assert.equal(quoteBuyback(100, {}), 120);
  assert.equal(quoteBuyback(0, { commerce: { buybackRateBps: 12000 } }), 0);
});

test('quoteDeposit ceils, caps at total, and floors a positive deposit at 1', () => {
  assert.deepEqual(quoteDeposit(100, { commerce: { preorders: { depositBps: 2500 } } }), {
    deposit: 25,
    remaining: 75,
  });
  assert.deepEqual(quoteDeposit(100, {}), { deposit: 25, remaining: 75 });
  // A preorders block without an explicit depositBps uses the default rate.
  assert.deepEqual(
    quoteDeposit(100, { commerce: { preorders: {} } }),
    { deposit: 25, remaining: 75 }
  );
  // A 200% deposit rate caps back at the total.
  assert.deepEqual(quoteDeposit(100, { commerce: { preorders: { depositBps: 20000 } } }), {
    deposit: 100,
    remaining: 0,
  });
  // A 0% deposit on a positive order still requires at least 1 minor unit.
  assert.deepEqual(quoteDeposit(1, { commerce: { preorders: { depositBps: 0 } } }), {
    deposit: 1,
    remaining: 0,
  });
  // A zero total stays zero.
  assert.deepEqual(quoteDeposit(0, { commerce: { preorders: { depositBps: 2500 } } }), {
    deposit: 0,
    remaining: 0,
  });
});

test('quote functions reject a total that overflows a safe integer', () => {
  const big = Number.MAX_SAFE_INTEGER;
  assert.throws(() => quoteSell(big, { commerce: { buyRateBps: 20000 } }), /overflowed/);
  assert.throws(() => quoteBuyback(big, { commerce: { buybackRateBps: 20000 } }), /overflowed/);
  assert.throws(
    () => quoteDeposit(big, { commerce: { preorders: { depositBps: 20000 } } }),
    /overflowed/
  );
});

test('quote functions reject a negative or fractional money input', () => {
  assert.throws(() => quoteSell(-1, {}), /non-negative/);
  assert.throws(() => quoteBuyback(1.5, {}), /safe integer/);
  assert.throws(() => quoteDeposit(-1, {}), /non-negative/);
});

// ---------------------------------------------------- special quotes

test('quoteSpecial returns the configured price only for the matching entry and eligible actor', () => {
  const entry = { id: 'entry1', price: 100 };
  const special = { id: 's1', entryId: 'entry1', price: 75, actorUuids: ['Actor.alice'] };
  assert.equal(quoteSpecial(entry, special, 'Actor.alice'), 75);
  assert.equal(quoteSpecial(entry, special, 'Actor.bob'), null);
  assert.equal(quoteSpecial({ id: 'entry2', price: 100 }, special, 'Actor.alice'), null);
  assert.equal(quoteSpecial(null, special, 'Actor.alice'), null);
});

test('quoteSpecial with an empty actorUuids allowlist applies to any actor', () => {
  const entry = { id: 'entry1', price: 100 };
  const special = { id: 's2', entryId: 'entry1', price: 80, actorUuids: [] };
  assert.equal(quoteSpecial(entry, special, 'Actor.bob'), 80);
  assert.equal(quoteSpecial(entry, special, ''), 80);
});

// ---------------------------------------------------- private / backroom access

test('a public entry requires entry.visible to be accessible', () => {
  assert.equal(canAccessEntry({ visible: true }, {}), true);
  assert.equal(canAccessEntry({ visible: false }, {}), false);
  assert.equal(
    canAccessEntry({ visible: true, access: { mode: 'public', actorUuids: [], minReputation: -100 } }, {}),
    true
  );
  assert.equal(
    canAccessEntry({ visible: false, access: { mode: 'public', actorUuids: [], minReputation: -100 } }, {}),
    false
  );
});

test('a backroom entry grants access by matching uuid OR the reputation threshold', () => {
  const entry = makeEntry({ access: { mode: 'backroom', actorUuids: ['Actor.alice'], minReputation: -100 } });
  assert.equal(canAccessEntry(entry, { actorUuid: 'Actor.alice' }), true);
  assert.equal(canAccessEntry(entry, { actorUuid: 'Actor.bob' }), false);
  const rep = makeEntry({ access: { mode: 'backroom', actorUuids: [], minReputation: 0 } });
  assert.equal(canAccessEntry(rep, { score: 5 }), true);
  assert.equal(canAccessEntry(rep, { score: -1 }), false);
});

test('an empty/-100 backroom denies everyone (never accidentally public)', () => {
  const entry = makeEntry({ access: { mode: 'backroom', actorUuids: [], minReputation: -100 } });
  assert.equal(canAccessEntry(entry, { actorUuid: 'Actor.any' }), false);
  assert.equal(canAccessEntry(entry, { score: 100 }), false);
  assert.equal(canAccessEntry(entry, {}), false);
});

test('a backroom uuid match still grants access even with a high reputation bar', () => {
  const entry = makeEntry({ access: { mode: 'backroom', actorUuids: ['Actor.alice'], minReputation: 100 } });
  assert.equal(canAccessEntry(entry, { actorUuid: 'Actor.alice', score: 0 }), true);
  assert.equal(canAccessEntry(entry, { actorUuid: 'Actor.bob', score: 0 }), false);
});

test('visibleEntriesFor returns only visible entries the actor can access', () => {
  const shop = {
    inventory: [
      { id: 'a', visible: true, access: { mode: 'public', actorUuids: [], minReputation: -100 } },
      { id: 'b', visible: false, access: { mode: 'public', actorUuids: [], minReputation: -100 } },
      { id: 'c', visible: true, access: { mode: 'backroom', actorUuids: [], minReputation: 25 } },
    ],
  };
  assert.deepEqual(
    visibleEntriesFor(shop, 'Actor.any', 50).map((e) => e.id),
    ['a', 'c']
  );
  assert.deepEqual(
    visibleEntriesFor(shop, 'Actor.any', 0).map((e) => e.id),
    ['a']
  );
  assert.deepEqual(visibleEntriesFor({ inventory: 'nope' }, 'Actor.any', 0), []);
});
