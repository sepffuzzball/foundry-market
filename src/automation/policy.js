// M4 shop automation policies.
//
// This module is intentionally free of any Foundry globals so it can be imported
// by Node for tests. Every function here is deterministic and pure: it reads a
// normalized shop record and a world-time in seconds, derives a decision, and
// never mutates the shop. The runtime/UI wiring that consumes these decisions
// lives elsewhere (commerce, the request handler, the automation runner and the
// manager editor); this slice only provides the schema-agnostic helpers.
//
// Time model: `worldTime` is the module's world-time in seconds, expressed on the
// game world's own relative clock where 0 is Monday 00:00 - not the Unix epoch.
// Day 0 is Monday and the weekday index is floor(worldTime / 86400) modulo 7. A
// day is 86400 seconds; an hour-day minute index runs 0..1439 and business-hour
// windows are [openMinute, closeMinute).

import {
  STOCK_VISIBILITIES,
  LOW_STOCK_THRESHOLD,
} from '../services/model.js';

export const SECONDS_PER_DAY = 86400;
export const DAY_EPOCH_OFFSET = 0; // worldTime 0 is Monday 00:00 (no epoch shift)

function safeDays(days) {
  return Array.isArray(days) ? days : [];
}

function inDayRange(days, dayOfWeek) {
  return safeDays(days).includes(dayOfWeek);
}

/**
 * Split a world time into a { dayOfWeek, minuteOfDay } pair. `dayOfWeek` is 0
 * (Monday) .. 6 (Sunday); `minuteOfDay` is 0..1439. Negative world times (before
 * day 0) are supported and map onto the same weekday/minute grid.
 */
export function timeParts(worldTime) {
  const days = Math.floor(worldTime / SECONDS_PER_DAY);
  const dayOfWeek = ((days % 7) + 7) % 7;
  const minuteOfDay = Math.floor(
    (((worldTime % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY) / 60
  );
  return { dayOfWeek, minuteOfDay };
}

/**
 * The earliest non-negative world time that lands on the given `dayOfWeek` and
 * `minuteOfDay`. This is a test/convenience helper for building deterministic
 * schedules; it never affects the shop record.
 */
export function timeAt(dayOfWeek, minuteOfDay) {
  const dayOffset = ((dayOfWeek % 7) + 7) % 7;
  return dayOffset * SECONDS_PER_DAY + minuteOfDay * 60;
}

/**
 * Whether the shop is inside its declared business hours at `worldTime`. A shop
 * with hours disabled (or an absent `automation.hours` block) is always open.
 *
 * Window semantics:
 * - openMinute === closeMinute  -> full-day open on every listed day.
 * - openMinute < closeMinute    -> [openMinute, closeMinute) on the listed day.
 * - openMinute > closeMinute    -> overnight: the opening day controls from
 *   openMinute until the next morning's closeMinute (inclusive of that next
 *   morning's minutes below closeMinute, exclusive of closeMinute).
 */
export function withinHours(shop, worldTime) {
  const hours = shop.automation && shop.automation.hours;
  if (!hours || !hours.enabled) return true;
  const { dayOfWeek, minuteOfDay } = timeParts(worldTime);
  const open = hours.openMinute;
  const close = hours.closeMinute;
  if (open === close) {
    return inDayRange(hours.days, dayOfWeek);
  }
  if (open < close) {
    return inDayRange(hours.days, dayOfWeek) && minuteOfDay >= open && minuteOfDay < close;
  }
  // Overnight: either today's listed day opens at `open` (stays open till
  // midnight), or the previous day was an opening day whose window continues
  // into today until `close`.
  return (
    (inDayRange(hours.days, dayOfWeek) && minuteOfDay >= open) ||
    (inDayRange(hours.days, (dayOfWeek + 6) % 7) && minuteOfDay < close)
  );
}

/**
 * The current cycle index for a travel/restock schedule. Before the anchor the
 * cycle is 0 (the schedule has not started). After the anchor it is
 * floor((now - anchor) / interval), clamped to the non-negative safe-integer
 * range so extreme times never overflow.
 */
export function cycleAt(config, worldTime) {
  if (worldTime < config.anchorTime) return 0;
  const raw = Math.floor((worldTime - config.anchorTime) / config.intervalSeconds);
  return Math.max(0, Math.min(raw, Number.MAX_SAFE_INTEGER));
}

/**
 * The cycle that is due for a schedule at `worldTime`, or null. A cycle is due
 * only after the anchor and only when it is strictly greater than the last
 * applied cycle; before the anchor or when the current cycle has already been
 * applied (cycle <= lastCycle) it returns null.
 */
export function dueCycle(config, worldTime) {
  if (worldTime < config.anchorTime) return null;
  const cycle = cycleAt(config, worldTime);
  if (cycle <= config.lastCycle) return null;
  return cycle;
}

/**
 * The travel presence and derived location for a shop at `worldTime`. Returns
 * null when travel is disabled or absent, `{ arrived: false, cycle: null,
 * locationId: null }` before the anchor (the merchant has not yet arrived), or
 * `{ arrived: true, cycle, locationId }` once arrived. The location id rotates
 * through the configured list by cycle, so the merchant is never pinned to a
 * single spot once a schedule is running.
 */
function travelState(shop, worldTime) {
  const travel = shop.automation && shop.automation.travel;
  if (!travel || travel.enabled !== true) return null;
  if (worldTime < travel.anchorTime) {
    return { arrived: false, cycle: null, locationId: null };
  }
  const cycle = cycleAt(travel, worldTime);
  const locationId = travel.locationIds[cycle % travel.locationIds.length];
  return { arrived: true, cycle, locationId };
}

/**
 * Whether the shop is trading with players at `worldTime`, combining the manual
 * `open` toggle, declared hours, and travel presence:
 * - `manually-closed` when the shop is toggled closed;
 * - `outside-hours` when hours are enabled and the time is outside them;
 * - `not-arrived` when travel is enabled and the anchor has not been reached,
 *   which can only be the outcome when the shop is open and inside its hours;
 * - `open` otherwise.
 * `locationId` is the travel location rotated by the current cycle once the
 * merchant has arrived, and is used for every outcome (including
 * `manually-closed` and `outside-hours`) so a travel-enabled shop never falsely
 * reports its base place to the public. Before the anchor, or when travel is
 * disabled, it is the shop's own `locationId`. Never mutates the shop.
 */
export function isShopTrading(shop, worldTime) {
  const baseLocationId = shop.locationId || '';
  const travel = shop.automation && shop.automation.travel;
  const travelEnabled = travel && travel.enabled === true;
  const state = travelEnabled ? travelState(shop, worldTime) : null;
  const arrived = !!(state && state.arrived);
  const locationId = arrived ? state.locationId : baseLocationId;

  if (shop.open === false) {
    return { open: false, reason: 'manually-closed', locationId };
  }
  if (!withinHours(shop, worldTime)) {
    return { open: false, reason: 'outside-hours', locationId };
  }
  if (travelEnabled && !arrived) {
    return { open: false, reason: 'not-arrived', locationId: baseLocationId };
  }
  return { open: true, reason: 'open', locationId };
}

/**
 * The public stock projection for an inventory entry, respecting its
 * `stockVisibility`. `exact` exposes the true count; `low` and `hidden` hide the
 * count (quantity: null) and expose only a label, so the public catalog never
 * leaks a real count outside exact mode. An `unlimited` entry is always
 * available regardless of the recorded quantity. Never mutates the entry.
 */
export function stockView(entry) {
  const vis = STOCK_VISIBILITIES.includes(entry.stockVisibility)
    ? entry.stockVisibility
    : 'exact';
  const qty = entry.quantity;
  if (entry.stockMode === 'unlimited') {
    return { quantity: vis === 'exact' ? qty : null, stockLabel: 'Available', available: true };
  }
  if (vis === 'exact') {
    const available = qty > 0;
    return {
      quantity: qty,
      stockLabel: available ? 'In stock' : 'Out of stock',
      available,
    };
  }
  if (vis === 'low') {
    if (qty <= 0) return { quantity: null, stockLabel: 'Out of stock', available: false };
    if (qty <= LOW_STOCK_THRESHOLD) return { quantity: null, stockLabel: 'Low stock', available: true };
    return { quantity: null, stockLabel: 'Available', available: true };
  }
  // hidden
  if (qty <= 0) return { quantity: null, stockLabel: 'Out of stock', available: false };
  return { quantity: null, stockLabel: 'Available', available: true };
}

/**
 * The events a player can currently see at `worldTime`: only `visible` events
 * whose window [startAt, endAt) contains the time, sorted by `startAt`
 * ascending. Event text is plain (the UI escapes it through Handlebars); this
 * helper never mutates the shop.
 */
export function activeMarketEvents(shop, worldTime) {
  const events = shop.automation && Array.isArray(shop.automation.events)
    ? shop.automation.events
    : [];
  return events
    .filter((e) => e.visible !== false && worldTime >= e.startAt && worldTime < e.endAt)
    .slice()
    .sort((a, b) => a.startAt - b.startAt);
}

/**
 * The pure automation plan for a shop at `worldTime`, with no side effects:
 *
 * - `restocks`: one entry per due, finite, restock-enabled inventory entry,
 *   regardless of whether its quantity is below or already at/above target. Each
 *   entry carries the due cycle and its target so the runtime can advance
 *   `lastCycle` (applying a set-to-target when below, or merely advancing
 *   without reducing stock when already at/above). A due entry is included
 *   exactly once - never looped over many elapsed cycles, never faked - so
 *   stock is never lowered by the plan.
 * - `travel`: `{ cycle, locationId }` when the travel schedule is due for a new
 *   cycle, else null.
 * - `activeEvents`: the visible active events (see `activeMarketEvents`).
 */
export function planAutomation(shop, worldTime) {
  const restocks = [];
  for (const entry of shop.inventory || []) {
    if (entry.stockMode !== 'finite') continue;
    const restock = entry.restock;
    if (!restock || restock.enabled !== true) continue;
    const cycle = dueCycle(restock, worldTime);
    if (cycle == null) continue;
    restocks.push({ entryId: entry.id, cycle, target: restock.target });
  }

  const travel = shop.automation && shop.automation.travel;
  let travelPlan = null;
  if (travel && travel.enabled === true) {
    const cycle = dueCycle(travel, worldTime);
    if (cycle != null) {
      travelPlan = {
        cycle,
        locationId: travel.locationIds[cycle % travel.locationIds.length],
      };
    }
  }

  return {
    restocks,
    travel: travelPlan,
    activeEvents: activeMarketEvents(shop, worldTime),
  };
}
