// Unit tests for the M6 GM-authored per-Item valuation (sell/barter) in
// `src/advanced/valuation.js` plus the `shop.commerce.valuations` schema in
// `src/services/model.js`.
//
// These are pure Node tests (no Foundry globals). They cover the pure
// `fingerprintItem` (deterministic key-sorted canonical JSON, full source
// fields, plain-JSON rejection, id-mismatch rejection, 64KB bound), the pure
// `getApprovedValuation` (match / wrong-actor / wrong-id / mutated-player-price
// invalidation), the GM-only `approve` service (GM gate, re-read, one-whole-item
// rule, replace-or-append, cap, persisted normalization, single shop patch), and
// the fact that `valuations` never leaks into the public catalog.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fingerprintItem,
  getApprovedValuation,
  findApprovedValuation,
  createValuationService,
} from '../src/advanced/valuation.js';
import { normalizeShop, makeId, MAX_COMMERCE_VALUATIONS } from '../src/services/model.js';
import { publicShop } from '../src/core/requests.js';

// ---------------------------------------------------------------- helpers

function makeItem(overrides = {}) {
  const {
    id = 'item1',
    name = 'Potion',
    img = 'icons/potion.png',
    type = 'consumable',
    flags = {},
    system = {},
    price = 10,
    quantity = 1,
  } = overrides;
  const data = {
    _id: id,
    name,
    img,
    type,
    flags,
    system: { ...system, quantity, price },
  };
  const item = {
    id,
    name,
    documentName: 'Item',
    parent: null,
    _data: data,
    toObject() {
      return JSON.parse(JSON.stringify(this._data));
    },
  };
  return item;
}

function makeActor({ id = 'actor1', uuid = 'Actor.actor1', item = null } = {}) {
  const items = new Map();
  const actor = { id, uuid, name: 'Player', items };
  if (item) {
    item.parent = actor;
    items.set(item.id, item);
  }
  return actor;
}

function makeShop(overrides = {}) {
  return normalizeShop({ id: 'shop1', name: 'General Store', ...overrides });
}

function makeStore({ shop } = {}) {
  const shops = new Map();
  if (shop) shops.set(shop.id, shop);
  const state = {
    findShopCalls: 0,
    updateShopCalls: 0,
    nullUpdateShop: false,
    failUpdateShop: false,
  };
  const store = {
    state,
    _shops: shops,
    async findShop(id) {
      state.findShopCalls += 1;
      return shops.get(id) || null;
    },
    async updateShop(id, patch) {
      state.updateShopCalls += 1;
      if (state.failUpdateShop) {
        state.failUpdateShop = false;
        throw new Error('update failed');
      }
      if (state.nullUpdateShop) {
        state.nullUpdateShop = false;
        return null;
      }
      const current = shops.get(id);
      if (!current) return null;
      // Mirror the real store: normalize the patched shop so the persisted
      // record is validated, exactly as the schema demands.
      const next = normalizeShop({ ...current, ...patch });
      shops.set(id, next);
      return next;
    },
  };
  return store;
}

function makeValuationService({
  store,
  actor,
  isActiveGM = () => true,
  getActor,
} = {}) {
  return createValuationService({
    store,
    runShopExclusive: (shopId, fn) => fn(),
    isActiveGM,
    getActor:
      getActor ||
      (async (id) => (actor && actor.id === id ? actor : null)),
    makeId,
    logger: { error: () => {} },
  });
}

// ---------------------------------------------------- pure fingerprintItem

test('fingerprintItem is deterministic and independent of object key order', () => {
  const a = makeItem({ name: 'Potion', price: 10 });
  // Same data, but the toObject output lays the keys out in a different order.
  const b = {
    id: 'item1',
    documentName: 'Item',
    toObject() {
      return {
        system: { price: 10, quantity: 1 },
        flags: {},
        type: 'consumable',
        img: 'icons/potion.png',
        name: 'Potion',
        _id: 'item1',
      };
    },
  };
  const fa = fingerprintItem(a);
  const fb = fingerprintItem(b);
  assert.equal(fa, fb);
  assert.match(fa, /^[0-9a-f]{16,128}$/);
});

test('fingerprintItem includes the full source fields (id/name/type/system/flags)', () => {
  const f1 = fingerprintItem(makeItem({ name: 'Potion', price: 10 }));
  const f2 = fingerprintItem(makeItem({ name: 'Potion', price: 10, type: 'weapon' }));
  const f3 = fingerprintItem(makeItem({ name: 'Potion', price: 10, flags: { magic: true } }));
  assert.notEqual(f1, f2);
  assert.notEqual(f1, f3);
});

test('fingerprintItem rejects a function inside the item data', () => {
  const item = {
    id: 'item1',
    documentName: 'Item',
    toObject() {
      return { _id: 'item1', name: 'P', system: {}, transform: (x) => x };
    },
  };
  assert.throws(() => fingerprintItem(item), /function/);
});

test('fingerprintItem rejects a non-plain (custom prototype) object', () => {
  const proto = Object.create({ extra: 1 });
  proto.x = 5;
  const item = {
    id: 'item1',
    documentName: 'Item',
    toObject() {
      return { _id: 'item1', name: 'P', system: proto };
    },
  };
  assert.throws(() => fingerprintItem(item), /custom prototype/);
});

test('fingerprintItem rejects an item id mismatch', () => {
  const item = {
    id: 'item1',
    documentName: 'Item',
    toObject() {
      return { _id: 'item2', name: 'P', system: {} };
    },
  };
  assert.throws(() => fingerprintItem(item), /id mismatch/);
});

test('fingerprintItem rejects serialized JSON over 64KB', () => {
  const big = makeItem({ name: 'P', system: { payload: 'x'.repeat(70 * 1024) } });
  assert.throws(() => fingerprintItem(big), /exceeds/);
});

// ---------------------------------------------------- pure getApprovedValuation

function valuationShop(entry) {
  return makeShop({ commerce: { valuations: [entry] } });
}

test('getApprovedValuation returns the amount for a matching, still-valid approval', () => {
  const item = makeItem({ name: 'Potion', price: 10 });
  const actor = makeActor({ item });
  const fp = fingerprintItem(item);
  const shop = valuationShop({
    id: 'v1',
    actorUuid: 'Actor.actor1',
    itemId: 'item1',
    amount: 42,
    fingerprint: fp,
  });
  assert.equal(getApprovedValuation(actor.items.get('item1'), shop), 42);
});

test('getApprovedValuation returns null for the wrong actor', () => {
  const item = makeItem({ name: 'Potion', price: 10 });
  const actor = makeActor({ item });
  const fp = fingerprintItem(item);
  const shop = valuationShop({
    id: 'v1',
    actorUuid: 'Actor.actor1',
    itemId: 'item1',
    amount: 42,
    fingerprint: fp,
  });
  const other = makeActor({ id: 'actor9', uuid: 'Actor.actor9', item: makeItem({ id: 'item1' }) });
  assert.equal(getApprovedValuation(other.items.get('item1'), shop), null);
});

test('getApprovedValuation returns null for the wrong item id', () => {
  const item = makeItem({ name: 'Potion', price: 10 });
  const actor = makeActor({ item });
  const fp = fingerprintItem(item);
  const shop = valuationShop({
    id: 'v1',
    actorUuid: 'Actor.actor1',
    itemId: 'item1',
    amount: 42,
    fingerprint: fp,
  });
  const otherItem = makeItem({ id: 'item2', name: 'Potion', price: 10 });
  otherItem.parent = actor;
  assert.equal(getApprovedValuation(otherItem, shop), null);
});

test('a forged/mutated player price invalidates a stored approval', () => {
  const item = makeItem({ name: 'Potion', price: 10 });
  const actor = makeActor({ item });
  const fp = fingerprintItem(item);
  const shop = valuationShop({
    id: 'v1',
    actorUuid: 'Actor.actor1',
    itemId: 'item1',
    amount: 42,
    fingerprint: fp,
  });
  assert.equal(getApprovedValuation(actor.items.get('item1'), shop), 42);
  // The player inflates the system price; the approval no longer matches.
  item._data.system.price = 5000;
  assert.equal(getApprovedValuation(actor.items.get('item1'), shop), null);
});

test('getApprovedValuation returns null when there are no valuations', () => {
  const item = makeItem({});
  const actor = makeActor({ item });
  assert.equal(getApprovedValuation(actor.items.get('item1'), makeShop()), null);
});

// ------------------------------------------------- whole-entry read side

test('findApprovedValuation returns the full validated entry for a matching approval', () => {
  const item = makeItem({ name: 'Potion', price: 10 });
  const actor = makeActor({ item });
  const fp = fingerprintItem(item);
  const shop = valuationShop({
    id: 'v1',
    actorUuid: 'Actor.actor1',
    itemId: 'item1',
    amount: 42,
    fingerprint: fp,
  });
  const entry = findApprovedValuation(actor.items.get('item1'), shop);
  assert.equal(entry.id, 'v1');
  assert.equal(entry.amount, 42);
  assert.equal(entry.fingerprint, fp);
});

test('findApprovedValuation returns null when no match / mutated / wrong actor', () => {
  const item = makeItem({ name: 'Potion', price: 10 });
  const actor = makeActor({ item });
  const fp = fingerprintItem(item);
  // No matching approval (different item id).
  const wrongItem = makeItem({ id: 'item9' });
  wrongItem.parent = actor;
  assert.equal(
    findApprovedValuation(wrongItem, valuationShop({
      id: 'v1', actorUuid: 'Actor.actor1', itemId: 'item1', amount: 42, fingerprint: fp,
    })),
    null
  );
  // Mutated price invalidates.
  item._data.system.price = 9999;
  assert.equal(
    findApprovedValuation(actor.items.get('item1'), valuationShop({
      id: 'v1', actorUuid: 'Actor.actor1', itemId: 'item1', amount: 42, fingerprint: fp,
    })),
    null
  );
});

test('createValuationService exposes a getApprovedValuation that returns the full entry', async () => {
  const item = makeItem({ name: 'Potion', price: 10 });
  const actor = makeActor({ item });
  const fp = fingerprintItem(item);
  const shop = makeShop({
    commerce: {
      valuations: [
        { id: 'v1', actorUuid: 'Actor.actor1', itemId: 'item1', amount: 42, fingerprint: fp },
      ],
    },
  });
  const store = makeStore({ shop });
  const service = makeValuationService({ store, actor });
  const entry = service.getApprovedValuation(actor.items.get('item1'), shop);
  assert.equal(entry.id, 'v1');
  assert.equal(entry.amount, 42);
  assert.equal(entry.fingerprint, fp);
});

test('createValuationService getApprovedValuation returns null when no matching approval', async () => {
  const item = makeItem({ name: 'Potion', price: 10 });
  const actor = makeActor({ item });
  const store = makeStore({ shop: makeShop() });
  const service = makeValuationService({ store, actor });
  assert.equal(service.getApprovedValuation(actor.items.get('item1'), makeShop()), null);
});

// ---------------------------------------------------- approve service

test('approve persists a normalized valuation and returns approved', async () => {
  const item = makeItem({ name: 'Potion', price: 10 });
  const actor = makeActor({ item });
  const shop = makeShop();
  const store = makeStore({ shop });
  const service = makeValuationService({ store, actor });

  const res = await service.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'item1', amount: 42 },
    'gm1'
  );

  assert.equal(res.status, 'approved');
  assert.ok(res.valuationId);
  assert.equal(res.itemName, 'Potion');
  assert.equal(res.amount, 42);

  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.valuations.length, 1);
  const v = stored.commerce.valuations[0];
  assert.equal(v.id, res.valuationId);
  assert.equal(v.actorUuid, 'Actor.actor1');
  assert.equal(v.itemId, 'item1');
  assert.equal(v.amount, 42);
  assert.equal(v.fingerprint, fingerprintItem(item));
  assert.match(v.fingerprint, /^[0-9a-f]{16,128}$/);
  assert.equal(store.state.updateShopCalls, 1);
});

test('approve round-trips with getApprovedValuation until the player mutates the price', async () => {
  const item = makeItem({ name: 'Potion', price: 10 });
  const actor = makeActor({ item });
  const store = makeStore({ shop: makeShop() });
  const service = makeValuationService({ store, actor });

  const res = await service.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'item1', amount: 77 },
    'gm1'
  );
  assert.equal(res.status, 'approved');

  const stored = store._shops.get('shop1');
  assert.equal(getApprovedValuation(actor.items.get('item1'), stored), 77);

  item._data.system.price = 9999;
  assert.equal(getApprovedValuation(actor.items.get('item1'), stored), null);
});

test('approve is refused for a non-active GM before any store read', async () => {
  const actor = makeActor({ item: makeItem() });
  const store = makeStore({ shop: makeShop() });
  const service = makeValuationService({ store, actor, isActiveGM: () => false });

  const res = await service.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'item1', amount: 42 },
    'gm1'
  );

  assert.equal(res.status, 'error');
  assert.equal(res.error, 'not-active-gm');
  assert.equal(store.state.findShopCalls, 0);
});

test('approve validates payload before any store read', async () => {
  const store = makeStore({ shop: makeShop() });
  const service = makeValuationService({ store, actor: makeActor() });

  const noAmount = await service.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'item1' },
    'gm1'
  );
  assert.equal(noAmount.status, 'error');
  assert.match(noAmount.error, /amount/);

  const zero = await service.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'item1', amount: 0 },
    'gm1'
  );
  assert.equal(zero.status, 'error');
  assert.match(zero.error, /amount/);
  assert.equal(store.state.findShopCalls, 0);
});

test('approve replaces an existing valuation for the same actor+item (no duplicate)', async () => {
  const item = makeItem({ name: 'Potion', price: 10 });
  const actor = makeActor({ item });
  const shop = makeShop({
    commerce: {
      valuations: [
        {
          actorUuid: 'Actor.actor1',
          itemId: 'item1',
          amount: 5,
          fingerprint: 'c'.repeat(16),
        },
      ],
    },
  });
  const store = makeStore({ shop });
  const service = makeValuationService({ store, actor });

  const res = await service.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'item1', amount: 42 },
    'gm1'
  );
  assert.equal(res.status, 'approved');

  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.valuations.length, 1);
  assert.equal(stored.commerce.valuations[0].amount, 42);
  assert.equal(stored.commerce.valuations[0].fingerprint, fingerprintItem(item));
});

test('approve drops the oldest valuation when the cap is full', async () => {
  const valuations = [];
  for (let i = 0; i < MAX_COMMERCE_VALUATIONS; i++) {
    valuations.push({
      actorUuid: 'Actor.actor1',
      itemId: `it${i}`,
      amount: i + 1,
      fingerprint: 'a'.repeat(16),
    });
  }
  const item = makeItem({ id: 'item100' });
  const actor = makeActor({ item });
  const shop = makeShop({ commerce: { valuations } });
  assert.equal(shop.commerce.valuations.length, MAX_COMMERCE_VALUATIONS);
  const store = makeStore({ shop });
  const service = makeValuationService({ store, actor });

  const res = await service.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'item100', amount: 1000 },
    'gm1'
  );
  assert.equal(res.status, 'approved');

  const stored = store._shops.get('shop1');
  assert.equal(stored.commerce.valuations.length, MAX_COMMERCE_VALUATIONS);
  // The oldest (it0) was dropped; the new valuation is appended at the end.
  assert.equal(stored.commerce.valuations[0].itemId, 'it1');
  assert.equal(stored.commerce.valuations[MAX_COMMERCE_VALUATIONS - 1].itemId, 'item100');
  assert.equal(stored.commerce.valuations[MAX_COMMERCE_VALUATIONS - 1].amount, 1000);
});

test('approve rejects a stacked item / missing item / parent mismatch / fingerprint failure', async () => {
  // stacked (quantity 2)
  const stacked = makeItem({ id: 'item1', quantity: 2 });
  const a1 = makeActor({ item: stacked });
  let store = makeStore({ shop: makeShop() });
  let service = makeValuationService({ store, actor: a1 });
  let res = await service.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'item1', amount: 42 },
    'gm1'
  );
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'stacked-item');

  // missing item
  const a2 = makeActor({ item: makeItem({ id: 'item1' }) });
  store = makeStore({ shop: makeShop() });
  service = makeValuationService({ store, actor: a2 });
  res = await service.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'missing', amount: 42 },
    'gm1'
  );
  assert.equal(res.error, 'item-not-found');

  // parent mismatch (embedded on a different actor)
  const other = makeActor({ id: 'actor9', uuid: 'Actor.actor9' });
  const mismatched = makeItem({ id: 'item1' });
  mismatched.parent = other;
  const a3 = { id: 'actor1', uuid: 'Actor.actor1', items: new Map([['item1', mismatched]]) };
  store = makeStore({ shop: makeShop() });
  service = makeValuationService({ store, actor: a3 });
  res = await service.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'item1', amount: 42 },
    'gm1'
  );
  assert.equal(res.error, 'item-parent-mismatch');

  // fingerprint failure (item data id disagrees with the document id)
  const badItem = {
    id: 'item1',
    documentName: 'Item',
    toObject() {
      return { _id: 'item2', name: 'P', system: {} };
    },
  };
  const a4 = { id: 'actor1', uuid: 'Actor.actor1', items: new Map([['item1', badItem]]) };
  store = makeStore({ shop: makeShop() });
  service = makeValuationService({ store, actor: a4 });
  res = await service.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'item1', amount: 42 },
    'gm1'
  );
  assert.equal(res.error, 'fingerprint-failed');
});

test('approve surfaces shop-not-found / actor-not-found / shop-write errors', async () => {
  const store = makeStore({});
  const service = makeValuationService({ store, actor: makeActor() });
  let res = await service.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'item1', amount: 42 },
    'gm1'
  );
  assert.equal(res.error, 'shop-not-found');

  const item = makeItem({});
  const actor = makeActor({ item });
  const store2 = makeStore({ shop: makeShop() });
  const service2 = makeValuationService({
    store: store2,
    actor,
    getActor: (async (id) => (id === 'actor1' ? null : null)),
  });
  res = await service2.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'item1', amount: 42 },
    'gm1'
  );
  assert.equal(res.error, 'actor-not-found');

  const store3 = makeStore({ shop: makeShop() });
  store3.state.nullUpdateShop = true;
  const service3 = makeValuationService({ store: store3, actor });
  res = await service3.approve(
    { shopId: 'shop1', actorId: 'actor1', itemId: 'item1', amount: 42 },
    'gm1'
  );
  assert.equal(res.error, 'shop-write-missing');
});

// ---------------------------------------------------- schema normalization

test('normalizeShop normalizes valuations and dedupes by (actorUuid, itemId) keeping the newest', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    commerce: {
      valuations: [
        { actorUuid: 'Actor.a', itemId: 'i1', amount: 1, fingerprint: 'a'.repeat(16) },
        { actorUuid: 'Actor.a', itemId: 'i1', amount: 2, fingerprint: 'b'.repeat(16) },
      ],
    },
  });
  assert.equal(shop.commerce.valuations.length, 1);
  assert.equal(shop.commerce.valuations[0].amount, 2);
});

test('normalizeShop defaults valuations to [] and fails closed on a bad fingerprint/amount', () => {
  const shop = normalizeShop({ id: 'shop1', name: 'S' });
  assert.deepEqual(shop.commerce.valuations, []);

  assert.throws(
    () =>
      normalizeShop({
        id: 'shop1',
        name: 'S',
        commerce: {
          valuations: [
            { actorUuid: 'Actor.a', itemId: 'i1', amount: 1, fingerprint: 'XYZ' },
          ],
        },
      }),
    /fingerprint/
  );
  assert.throws(
    () =>
      normalizeShop({
        id: 'shop1',
        name: 'S',
        commerce: {
          valuations: [
            { actorUuid: 'Actor.a', itemId: 'i1', amount: 0, fingerprint: 'a'.repeat(16) },
          ],
        },
      }),
    /amount/
  );
  assert.throws(
    () =>
      normalizeShop({
        id: 'shop1',
        name: 'S',
        commerce: {
          valuations: [
            { actorUuid: 'not-a-uuid', itemId: 'i1', amount: 1, fingerprint: 'a'.repeat(16) },
          ],
        },
      }),
    /Actor/
  );
});

// ---------------------------------------------------- public catalog

test('publicShop never leaks valuations into the player catalog', () => {
  const item = makeItem({ name: 'Potion', price: 10 });
  const actor = makeActor({ item });
  const shop = makeShop({
    commerce: {
      valuations: [
        {
          actorUuid: 'Actor.actor1',
          itemId: 'item1',
          amount: 42,
          fingerprint: fingerprintItem(item),
        },
      ],
    },
  });
  const pub = publicShop(shop);
  assert.ok(!('valuations' in pub));
  assert.equal(pub.services.length, 0);
  assert.deepEqual(pub.specials, []);
});
