// Unit tests for the M4 shop automation schema and the pure time/presence/stock
// helpers in `src/automation/policy.js`.
//
// These tests are pure: no Foundry globals, no storage, no commerce, no UI.
// They cover the normalized `automation` / per-entry `restock`/`stockVisibility`
// shapes, business-hour inclusivity (including overnight), travel anchor and
// rotation, schedule due-cycle (forward and backward), restock catch-up, public
// stock privacy labels, and event visibility.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeShop,
  normalizeInventoryEntry,
  normalizeAutomation,
  MAX_AUTOMATION_EVENTS,
  AUTOMATION_EVENT_TITLE_MAX,
  AUTOMATION_EVENT_DESCRIPTION_MAX,
  TRAVEL_LOCATION_MIN,
  TRAVEL_LOCATION_MAX,
  STOCK_VISIBILITIES,
  LOW_STOCK_THRESHOLD,
} from '../src/services/model.js';
import {
  withinHours,
  isShopTrading,
  cycleAt,
  dueCycle,
  stockView,
  activeMarketEvents,
  planAutomation,
  timeParts,
  timeAt,
  SECONDS_PER_DAY,
} from '../src/automation/policy.js';

const BASE = timeAt(0, 0); // Monday 00:00

function makeEntry(overrides = {}) {
  return normalizeInventoryEntry({
    id: 'entry1',
    itemUuid: 'Compendium.books.Item.potion',
    snapshot: 'a small red potion',
    name: 'Potion',
    quantity: 10,
    stockMode: 'finite',
    price: 100,
    ...overrides,
  });
}

function makeShop({ open = true, locationId = 'home', hours, travel, events, inventory } = {}) {
  return normalizeShop({
    id: 'shop1',
    name: 'General Store',
    locationId,
    open,
    inventory: inventory ?? [],
    automation: { hours: hours ?? {}, travel: travel ?? {}, events: events ?? [] },
  });
}

// ----------------------------------------------------- automation defaults

test('old shops with no automation normalize to harmless defaults', () => {
  const shop = makeShop();
  assert.equal(shop.automation.hours.enabled, false);
  assert.deepEqual(shop.automation.hours.days, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(shop.automation.hours.openMinute, 0);
  assert.equal(shop.automation.hours.closeMinute, 0);
  assert.equal(shop.automation.travel.enabled, false);
  assert.deepEqual(shop.automation.travel.locationIds, []);
  assert.equal(shop.automation.travel.anchorTime, 0);
  assert.equal(shop.automation.travel.intervalSeconds, 86400);
  assert.equal(shop.automation.travel.lastCycle, -1);
  assert.deepEqual(shop.automation.events, []);
  assert.equal(shop.automation.diagnostics.lastRunAt, null);
  assert.equal(shop.automation.diagnostics.lastStatus, 'never');
  assert.equal(shop.automation.diagnostics.lastError, '');
  assert.equal(shop.automation.diagnostics.lastRestocked, 0);
  assert.equal(shop.automation.diagnostics.lastLocationId, '');
});

test('inventory entries default restock/stock-visibility without affecting stock', () => {
  const entry = makeEntry();
  assert.equal(entry.stockVisibility, 'exact');
  assert.equal(entry.restock.enabled, false);
  assert.equal(entry.restock.target, 10);
  assert.equal(entry.restock.intervalSeconds, 86400);
  assert.equal(entry.restock.anchorTime, 0);
  assert.equal(entry.restock.lastCycle, -1);
});

test('day-0 is Monday in the time grid', () => {
  assert.equal(timeParts(timeAt(0, 0)).dayOfWeek, 0);
  assert.equal(timeParts(timeAt(3, 0)).dayOfWeek, 3);
  assert.equal(timeParts(timeAt(6, 0)).dayOfWeek, 6);
  assert.equal(timeParts(timeAt(1, 600)).minuteOfDay, 600);
  assert.equal(timeAt(0, 0), 0, 'worldTime 0 is Monday 00:00');
});

test('negative world times map onto the same weekday/minute grid', () => {
  assert.deepEqual(timeParts(0), { dayOfWeek: 0, minuteOfDay: 0 });
  assert.deepEqual(timeParts(-1), { dayOfWeek: 6, minuteOfDay: 1439 });
  assert.deepEqual(timeParts(-SECONDS_PER_DAY), { dayOfWeek: 6, minuteOfDay: 0 });
  assert.deepEqual(timeParts(-7 * SECONDS_PER_DAY), { dayOfWeek: 0, minuteOfDay: 0 });
});

// ---------------------------------------------------- business hours

test('withinHours is inclusive at open and exclusive at close', () => {
  const shop = makeShop({
    hours: { enabled: true, days: [0], openMinute: 600, closeMinute: 660 },
  });
  assert.equal(withinHours(shop, timeAt(0, 600)), true, 'open minute is inclusive');
  assert.equal(withinHours(shop, timeAt(0, 659)), true, 'inside the window');
  assert.equal(withinHours(shop, timeAt(0, 660)), false, 'close minute is exclusive');
  assert.equal(withinHours(shop, timeAt(0, 599)), false, 'before opening');
  assert.equal(withinHours(shop, timeAt(1, 650)), false, 'wrong day even inside the window');
});

test('withinHours handles an overnight window (opening day controls until morning)', () => {
  const shop = makeShop({
    hours: { enabled: true, days: [0], openMinute: 1200, closeMinute: 360 },
  });
  assert.equal(withinHours(shop, timeAt(0, 1200)), true, 'opens at 20:00 on day 0');
  assert.equal(withinHours(shop, timeAt(0, 1439)), true, 'late on opening day');
  assert.equal(withinHours(shop, timeAt(0, 1199)), false, 'before the opening');
  assert.equal(withinHours(shop, timeAt(0, 1)), false, 'early on opening day, no prior overnight (Sunday off)');
  assert.equal(withinHours(shop, timeAt(1, 1)), true, 'continues into next morning');
  assert.equal(withinHours(shop, timeAt(1, 359)), true, 'still within next-morning close');
  assert.equal(withinHours(shop, timeAt(1, 360)), false, 'close minute exclusive next morning');
  assert.equal(withinHours(shop, timeAt(2, 1)), false, 'day 2 does not inherit the day-1 overnight');
});

test('withinHours treats equal open/close as a full open day', () => {
  const shop = makeShop({
    hours: { enabled: true, days: [0, 1], openMinute: 300, closeMinute: 300 },
  });
  assert.equal(withinHours(shop, timeAt(0, 0)), true);
  assert.equal(withinHours(shop, timeAt(1, 1439)), true);
  assert.equal(withinHours(shop, timeAt(2, 0)), false, 'day 2 is not listed');
});

test('withinHours is always true when hours are disabled or absent', () => {
  const shop = makeShop();
  assert.equal(withinHours(shop, timeAt(2, 0)), true);
  assert.equal(withinHours(shop, timeAt(5, 720)), true);
});

// ------------------------------------------------ isShopTrading reasons + travel

test('isShopTrading reports manually-closed before any other check', () => {
  const shop = makeShop({
    open: false,
    hours: { enabled: true, days: [0], openMinute: 600, closeMinute: 660 },
  });
  const state = isShopTrading(shop, timeAt(0, 700));
  assert.deepEqual(state, { open: false, reason: 'manually-closed', locationId: 'home' });
});

test('isShopTrading reports outside-hours when outside the window', () => {
  const shop = makeShop({
    open: true,
    hours: { enabled: true, days: [0], openMinute: 600, closeMinute: 660 },
  });
  const state = isShopTrading(shop, timeAt(0, 100));
  assert.deepEqual(state, { open: false, reason: 'outside-hours', locationId: 'home' });
});

test('travel: before anchor the shop is not-arrived', () => {
  const shop = makeShop({
    travel: {
      enabled: true,
      locationIds: ['loc-a', 'loc-b'],
      anchorTime: BASE,
      intervalSeconds: 3600,
      lastCycle: -1,
    },
  });
  const state = isShopTrading(shop, BASE - 60);
  assert.deepEqual(state, { open: false, reason: 'not-arrived', locationId: 'home' });
});

test('travel: once arrived the shop trades and the location rotates by cycle', () => {
  const shop = makeShop({
    travel: {
      enabled: true,
      locationIds: ['loc-a', 'loc-b'],
      anchorTime: BASE,
      intervalSeconds: 3600,
      lastCycle: -1,
    },
  });
  assert.deepEqual(isShopTrading(shop, BASE), {
    open: true,
    reason: 'open',
    locationId: 'loc-a',
  });
  assert.deepEqual(isShopTrading(shop, BASE + 3600), {
    open: true,
    reason: 'open',
    locationId: 'loc-b',
  });
  assert.deepEqual(isShopTrading(shop, BASE + 7200), {
    open: true,
    reason: 'open',
    locationId: 'loc-a',
  });
});

test('travel arrival ignores lastCycle (presence is not a due-cycle concept)', () => {
  const shop = makeShop({
    travel: {
      enabled: true,
      locationIds: ['loc-a', 'loc-b'],
      anchorTime: BASE,
      intervalSeconds: 3600,
      lastCycle: 99,
    },
  });
  const state = isShopTrading(shop, BASE + 3600);
  assert.equal(state.open, true);
  assert.equal(state.reason, 'open');
  assert.equal(state.locationId, 'loc-b');
});

test('travel: manually-closed still reports the rotated travel location', () => {
  const shop = makeShop({
    open: false,
    travel: {
      enabled: true,
      locationIds: ['loc-a', 'loc-b'],
      anchorTime: BASE,
      intervalSeconds: 3600,
      lastCycle: -1,
    },
  });
  const state = isShopTrading(shop, BASE + 3600);
  assert.deepEqual(state, { open: false, reason: 'manually-closed', locationId: 'loc-b' });
});

test('travel: outside-hours still reports the rotated travel location', () => {
  const shop = makeShop({
    hours: { enabled: true, days: [0], openMinute: 600, closeMinute: 660 },
    travel: {
      enabled: true,
      locationIds: ['loc-a', 'loc-b'],
      anchorTime: BASE,
      intervalSeconds: 3600,
      lastCycle: -1,
    },
  });
  const state = isShopTrading(shop, BASE + 3600);
  assert.deepEqual(state, { open: false, reason: 'outside-hours', locationId: 'loc-b' });
});

test('travel: before anchor, manually-closed takes precedence over not-arrived', () => {
  const shop = makeShop({
    open: false,
    travel: {
      enabled: true,
      locationIds: ['loc-a', 'loc-b'],
      anchorTime: BASE,
      intervalSeconds: 3600,
      lastCycle: -1,
    },
  });
  const state = isShopTrading(shop, BASE - 60);
  assert.deepEqual(state, { open: false, reason: 'manually-closed', locationId: 'home' });
});

test('travel: before anchor, outside-hours takes precedence over not-arrived', () => {
  const shop = makeShop({
    hours: { enabled: true, days: [0], openMinute: 600, closeMinute: 660 },
    travel: {
      enabled: true,
      locationIds: ['loc-a', 'loc-b'],
      anchorTime: BASE,
      intervalSeconds: 3600,
      lastCycle: -1,
    },
  });
  const state = isShopTrading(shop, BASE - 60);
  assert.deepEqual(state, { open: false, reason: 'outside-hours', locationId: 'home' });
});

// ------------------------------------------------------- schedule cycles

test('cycleAt returns 0 before the anchor and the integer cycle after', () => {
  const config = { anchorTime: BASE, intervalSeconds: 3600 };
  assert.equal(cycleAt(config, BASE - 1), 0);
  assert.equal(cycleAt(config, BASE), 0);
  assert.equal(cycleAt(config, BASE + 3 * 3600), 3);
});

test('dueCycle returns null before the anchor', () => {
  const config = { anchorTime: BASE, intervalSeconds: 3600, lastCycle: -1 };
  assert.equal(dueCycle(config, BASE - 1), null);
});

test('dueCycle returns null once the cycle has already been applied (backward)', () => {
  const config = { anchorTime: BASE, intervalSeconds: 3600, lastCycle: 5 };
  assert.equal(dueCycle(config, BASE + 3 * 3600), null, 'cycle 3 <= lastCycle 5');
  assert.equal(dueCycle(config, BASE + 6 * 3600), 6, 'a strictly later cycle is due');
});

test('dueCycle returns the next cycle when none has been applied', () => {
  const config = { anchorTime: BASE, intervalSeconds: 3600, lastCycle: -1 };
  assert.equal(dueCycle(config, BASE + 4 * 3600), 4);
});

// ------------------------------------------------------------ max limits

test('events beyond MAX_AUTOMATION_EVENTS are dropped', () => {
  const events = Array.from({ length: MAX_AUTOMATION_EVENTS + 3 }, (_, i) => ({
    id: `e${i}`,
    title: `Event ${i}`,
    startAt: i,
    endAt: i + 1,
  }));
  const shop = makeShop({ events });
  assert.equal(shop.automation.events.length, MAX_AUTOMATION_EVENTS);
});

test('event normalization caps title/description and requires endAt > startAt', () => {
  const e = normalizeAutomation({
    events: [
      {
        title: 'x'.repeat(AUTOMATION_EVENT_TITLE_MAX + 50),
        description: 'y'.repeat(AUTOMATION_EVENT_DESCRIPTION_MAX + 50),
        startAt: 5,
        endAt: 6,
      },
    ],
  });
  assert.equal(e.events[0].title.length, AUTOMATION_EVENT_TITLE_MAX);
  assert.equal(e.events[0].description.length, AUTOMATION_EVENT_DESCRIPTION_MAX);
  assert.equal(e.events[0].visible, true);
  assert.ok(e.events[0].id);

  assert.throws(
    () => normalizeAutomation({ events: [{ title: 'bad', startAt: 6, endAt: 6 }] }),
    /endAt must be > startAt/
  );
});

test('automation event ids are validated and generated when absent', () => {
  // An absent id is generated as a scalar string.
  const generated = normalizeAutomation({ events: [{ title: 'Sale', startAt: 0, endAt: 1 }] });
  assert.ok(generated.events[0].id, 'an id is generated when absent');
  assert.equal(typeof generated.events[0].id, 'string');

  // A valid string id is preserved.
  const withId = normalizeAutomation({ events: [{ id: 'ev-1', title: 'Sale', startAt: 0, endAt: 1 }] });
  assert.equal(withId.events[0].id, 'ev-1');

  // An object id is rejected (must be a string).
  assert.throws(
    () => normalizeAutomation({ events: [{ id: {}, title: 'Sale', startAt: 0, endAt: 1 }] }),
    /must be a string/
  );

  // An oversized id (> 120 chars) is rejected.
  assert.throws(
    () => normalizeAutomation({ events: [{ id: 'x'.repeat(121), title: 'Sale', startAt: 0, endAt: 1 }] }),
    /must be at most 120 chars/
  );

  // A control-character id is rejected.
  assert.throws(
    () => normalizeAutomation({ events: [{ id: 'bad\nid', title: 'Sale', startAt: 0, endAt: 1 }] }),
    /must not contain control characters/
  );
});

test('hours days are bounded, validated and de-duplicated', () => {
  assert.throws(() => makeShop({ hours: { days: [7] } }), /days\[\]/);
  assert.throws(() => makeShop({ hours: { days: [-1] } }), /days\[\]/);
  assert.throws(() => makeShop({ hours: { days: [0, 1.5] } }), /days\[\]/);
  const shop = makeShop({ hours: { days: [0, 0, 1, 1, 2] } });
  assert.deepEqual(shop.automation.hours.days, [0, 1, 2]);
});

test('hours minutes are bounded', () => {
  assert.throws(() => makeShop({ hours: { openMinute: 1440 } }), /openMinute/);
  assert.throws(() => makeShop({ hours: { closeMinute: -1 } }), /closeMinute/);
});

test('travel location ids are required, unique and non-empty when enabled', () => {
  assert.throws(
    () =>
      makeShop({
        travel: { enabled: true, locationIds: ['only-one'] },
      }),
    new RegExp(`must contain ${TRAVEL_LOCATION_MIN}..${TRAVEL_LOCATION_MAX}`)
  );
  const two = makeShop({
    travel: { enabled: true, locationIds: ['loc-a', 'loc-a', 'loc-b'] },
  });
  assert.deepEqual(two.automation.travel.locationIds, ['loc-a', 'loc-b']);
  // disabled travel may carry fewer than two ids
  const one = makeShop({ travel: { enabled: false, locationIds: ['only-one'] } });
  assert.deepEqual(one.automation.travel.locationIds, ['only-one']);
});

test('travel location ids are capped at TRAVEL_LOCATION_MAX and bounded in length', () => {
  const many = Array.from({ length: TRAVEL_LOCATION_MAX + 2 }, (_, i) => `loc-${i}`);
  const shop = makeShop({ travel: { enabled: true, locationIds: many } });
  assert.equal(shop.automation.travel.locationIds.length, TRAVEL_LOCATION_MAX);
  assert.throws(
    () => makeShop({ travel: { enabled: true, locationIds: ['a'.repeat(121), 'b'] } }),
    /must be at most/
  );
});

test('travel interval is bounded and lastCycle cannot be below -1', () => {
  assert.throws(() => makeShop({ travel: { intervalSeconds: 3599 } }), /intervalSeconds/);
  assert.throws(() => makeShop({ travel: { intervalSeconds: 31536001 } }), /intervalSeconds/);
  assert.throws(() => makeShop({ travel: { lastCycle: -2 } }), /lastCycle/);
  assert.equal(makeShop({ travel: { intervalSeconds: 3600, lastCycle: -1 } }).automation.travel.intervalSeconds, 3600);
});

test('stockVisibility defaults and rejects unknown enum values by falling back', () => {
  assert.equal(STOCK_VISIBILITIES.includes('exact'), true);
  const exact = makeEntry();
  assert.equal(exact.stockVisibility, 'exact');
  const low = makeEntry({ stockVisibility: 'low' });
  assert.equal(low.stockVisibility, 'low');
  const fallback = makeEntry({ stockVisibility: 'bogus' });
  assert.equal(fallback.stockVisibility, 'exact');
});

// ------------------------------------------------------ restock schedule

test('restock is only enabled for finite stock', () => {
  assert.equal(makeEntry({ stockMode: 'unlimited', restock: { enabled: true } }).restock.enabled, false);
  assert.equal(makeEntry({ stockMode: 'non-restocking', restock: { enabled: true } }).restock.enabled, false);
  assert.equal(makeEntry({ stockMode: 'finite', restock: { enabled: true } }).restock.enabled, true);
});

test('restock target defaults to the quantity floor of 1 and rejects invalid targets', () => {
  assert.equal(makeEntry({ quantity: 0 }).restock.target, 1);
  assert.equal(makeEntry({ quantity: 7 }).restock.target, 7);
  assert.throws(() => makeEntry({ restock: { target: 0 } }), /target/);
  assert.throws(() => makeEntry({ restock: { target: -3 } }), /target/);
  assert.throws(
    () => makeEntry({ restock: { target: Number.MAX_SAFE_INTEGER + 1 } }),
    /target/
  );
});

test('restock schedule fields are validated', () => {
  assert.throws(() => makeEntry({ restock: { intervalSeconds: 3599 } }), /intervalSeconds/);
  assert.throws(() => makeEntry({ restock: { intervalSeconds: 31536001 } }), /intervalSeconds/);
  assert.throws(() => makeEntry({ restock: { lastCycle: -2 } }), /lastCycle/);
  // the anchor may be signed (past) without error
  assert.equal(makeEntry({ restock: { anchorTime: -100 } }).restock.anchorTime, -100);
});

test('planAutomation catches up a due finite restock by one set-to-target', () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const plan = planAutomation(shop, BASE + 3 * 3600);
  assert.deepEqual(plan.restocks, [{ entryId: 'entry1', cycle: 3, target: 20 }]);
});

test('planAutomation does not loop over many elapsed cycles', () => {
  const entry = makeEntry({
    quantity: 5,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const plan = planAutomation(shop, BASE + 50 * 3600);
  assert.equal(plan.restocks.length, 1);
  assert.equal(plan.restocks[0].cycle, 50);
});

test('planAutomation includes a due restock at/above target so lastCycle can advance without stock loss', () => {
  const entry = makeEntry({
    quantity: 25,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const plan = planAutomation(shop, BASE + 3600);
  assert.deepEqual(plan.restocks, [{ entryId: 'entry1', cycle: 1, target: 20 }]);
});

test('planAutomation includes a due restock when quantity equals the target (same target -> due plan)', () => {
  const entry = makeEntry({
    quantity: 20,
    restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE, lastCycle: -1 },
  });
  const shop = makeShop({ inventory: [entry] });
  const plan = planAutomation(shop, BASE + 3 * 3600);
  assert.deepEqual(plan.restocks, [{ entryId: 'entry1', cycle: 3, target: 20 }]);
});

test('planAutomation omits non-restocking, disabled and before-anchor restocks', () => {
  const shop = makeShop({
    inventory: [
      makeEntry({
        id: 'finite-disabled',
        quantity: 5,
        restock: { enabled: false, target: 20, intervalSeconds: 3600, anchorTime: BASE },
      }),
      makeEntry({
        id: 'unlimited',
        stockMode: 'unlimited',
        quantity: 5,
        restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE },
      }),
      makeEntry({
        id: 'future-anchor',
        quantity: 5,
        restock: { enabled: true, target: 20, intervalSeconds: 3600, anchorTime: BASE + 7200 },
      }),
    ],
  });
  const plan = planAutomation(shop, BASE + 3600);
  assert.deepEqual(plan.restocks, []);
});

test('planAutomation travel is null before the anchor and due only after', () => {
  const shop = makeShop({
    travel: {
      enabled: true,
      locationIds: ['loc-a', 'loc-b'],
      anchorTime: BASE,
      intervalSeconds: 3600,
      lastCycle: -1,
    },
  });
  assert.equal(planAutomation(shop, BASE - 1).travel, null);
  assert.deepEqual(planAutomation(shop, BASE + 3600).travel, {
    cycle: 1,
    locationId: 'loc-b',
  });
  assert.equal(planAutomation(shop, BASE + 3600).travel.locationId, 'loc-b');
});

// ------------------------------------------------------ public stock privacy

test('stockView exact exposes the true count', () => {
  assert.deepEqual(stockView(makeEntry({ stockVisibility: 'exact', quantity: 10 })), {
    quantity: 10,
    stockLabel: 'In stock',
    available: true,
  });
  assert.deepEqual(stockView(makeEntry({ stockVisibility: 'exact', quantity: 0 })), {
    quantity: 0,
    stockLabel: 'Out of stock',
    available: false,
  });
});

test('stockView low hides the count and labels low/out/available', () => {
  const low = stockView(makeEntry({ stockVisibility: 'low', quantity: 2 }));
  assert.equal(low.quantity, null);
  assert.equal(low.stockLabel, 'Low stock');
  assert.equal(low.available, true);

  const out = stockView(makeEntry({ stockVisibility: 'low', quantity: 0 }));
  assert.equal(out.quantity, null);
  assert.equal(out.stockLabel, 'Out of stock');
  assert.equal(out.available, false);

  const ok = stockView(makeEntry({ stockVisibility: 'low', quantity: 5 }));
  assert.equal(ok.quantity, null);
  assert.equal(ok.stockLabel, 'Available');
  assert.equal(ok.available, true);
});

test('stockView low threshold <= LOW_STOCK_THRESHOLD', () => {
  assert.equal(LOW_STOCK_THRESHOLD, 3);
  assert.equal(stockView(makeEntry({ stockVisibility: 'low', quantity: LOW_STOCK_THRESHOLD })).stockLabel, 'Low stock');
  assert.equal(stockView(makeEntry({ stockVisibility: 'low', quantity: LOW_STOCK_THRESHOLD + 1 })).stockLabel, 'Available');
});

test('stockView hidden never leaks the true count', () => {
  assert.deepEqual(stockView(makeEntry({ stockVisibility: 'hidden', quantity: 8 })), {
    quantity: null,
    stockLabel: 'Available',
    available: true,
  });
  assert.deepEqual(stockView(makeEntry({ stockVisibility: 'hidden', quantity: 0 })), {
    quantity: null,
    stockLabel: 'Out of stock',
    available: false,
  });
});

test('stockView treats unlimited stock as always available', () => {
  assert.deepEqual(
    stockView(makeEntry({ stockMode: 'unlimited', stockVisibility: 'low', quantity: 0 })),
    { quantity: null, stockLabel: 'Available', available: true }
  );
  const exact = stockView(makeEntry({ stockMode: 'unlimited', stockVisibility: 'exact', quantity: 0 }));
  assert.equal(exact.available, true);
});

// ------------------------------------------------------- events visibility

test('activeMarketEvents returns only visible active events sorted by start', () => {
  const shop = makeShop({
    events: [
      { title: 'B', startAt: 20, endAt: 30, visible: true },
      { title: 'A', startAt: 10, endAt: 40, visible: true },
      { title: 'hidden', startAt: 5, endAt: 100, visible: false },
      { title: 'future', startAt: 60, endAt: 80, visible: true },
      { title: 'past', startAt: 1, endAt: 3, visible: true },
    ],
  });
  const active = activeMarketEvents(shop, 25);
  assert.deepEqual(
    active.map((e) => e.title),
    ['A', 'B']
  );
});

test('activeMarketEvents is empty outside any window and ignores visibility', () => {
  const shop = makeShop({
    events: [
      { title: 'one', startAt: 10, endAt: 20, visible: true },
      { title: 'hidden', startAt: 10, endAt: 20, visible: false },
    ],
  });
  assert.deepEqual(activeMarketEvents(shop, 15).map((e) => e.title), ['one']);
  assert.deepEqual(activeMarketEvents(shop, 25), []);
});

test('planAutomation includes activeEvents in its plan', () => {
  const shop = makeShop({
    events: [
      { title: 'Sale', startAt: BASE, endAt: BASE + 3600, visible: true },
      { title: 'Past', startAt: BASE - 7200, endAt: BASE - 3600, visible: true },
    ],
  });
  const plan = planAutomation(shop, BASE + 600);
  assert.deepEqual(plan.activeEvents.map((e) => e.title), ['Sale']);
});
