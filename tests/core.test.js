// Unit tests for the pure market core. No Foundry globals are required; all
// document access and actor behavior are mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  quote,
  quoteBreakdown,
  parseMinorUnits,
  add,
  subtract,
  formatMinorUnits,
} from '../src/services/pricing.js';
import {
  SCHEMA_VERSION,
  normalizeShop,
  normalizeInventoryEntry,
  normalizeLedgerRecord,
  makeId,
  assertStockMode,
} from '../src/services/model.js';
import {
  getAdapter,
  GenericAdapter,
  Dnd5eAdapter,
  DaggerheartAdapter,
  readPath,
  readIntegerPath,
  setPath,
  buildPatch,
  cleanItemData,
  denominationsToCopper,
  copperToDenominations,
  denominationToCopper,
  priceValueToCopper,
} from '../src/adapters/index.js';
import {
  createCommerce,
  createLockMap,
  payloadHash,
  resolveIdempotency,
} from '../src/services/commerce.js';
import {
  buildCatalog,
  publicPurchaseResult,
  handleMarketChatMessage,
  PUBLIC_ENTRY_FIELDS,
  PUBLIC_SHOP_FIELDS,
} from '../src/core/requests.js';
import { createStore, store as defaultStore } from '../src/storage/store.js';

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setInPlace(obj, path, value) {
  const segments = String(path).split('.').map((s) => s.trim()).filter(Boolean);
  let cur = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (cur[seg] == null) cur[seg] = /^\d+$/.test(segments[i + 1]) ? [] : {};
    cur = cur[seg];
  }
  cur[segments[segments.length - 1]] = value;
}

function createMockActor(opts = {}) {
  const { currency = {}, ownership = {}, system = {}, flags = {}, failUpdateCount = 0 } = opts;
  const items = [];
  const patchLog = [];
  const removedIds = [];
  let updateCount = 0;
  const actor = {
    id: 'actor1',
    ownership,
    system: { ...system, currency },
    flags,
    get items() { return items; },
    get patchLog() { return patchLog; },
    get removedIds() { return removedIds; },
    async update(patch) {
      updateCount += 1;
      if (failUpdateCount && updateCount >= failUpdateCount) {
        throw new Error('simulated update failure');
      }
      for (const [path, value] of Object.entries(patch)) setInPlace(actor, path, value);
      patchLog.push(patch);
      return actor;
    },
    async createEmbeddedDocuments(name, data) {
      const docs = data.map((d) => ({ id: makeId(), ...d }));
      items.push(...docs);
      return docs;
    },
    async deleteEmbeddedDocuments(name, ids) {
      removedIds.push(...ids);
      return true;
    },
  };
  return actor;
}

function createMockStore() {
  const shops = new Map();
  const ledgers = new Map();
  const store = {
    _shops: shops,
    _ledgers: ledgers,
    async findShop(id) { return shops.get(id) || null; },
    async updateShop(id, patch) {
      const current = shops.get(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      shops.set(id, next);
      return next;
    },
    async findLedgerByKey(key) { return ledgers.get(key) || null; },
    async createLedger(rec) {
      const normalized = { ...rec, id: rec.id || makeId() };
      const existing = ledgers.get(normalized.key);
      if (existing) return { record: existing, created: false };
      ledgers.set(normalized.key, normalized);
      return { record: normalized, created: true };
    },
    async updateLedger(id, patch) {
      for (const [key, value] of ledgers) {
        if (value.id === id) {
          const next = { ...value, ...patch, updatedAt: patch.updatedAt ?? value.updatedAt };
          ledgers.set(key, next);
          return next;
        }
      }
      return null;
    },
  };
  return store;
}

function makeSourceItem() {
  return {
    toObject: () => ({
      _id: 'srcItem',
      name: 'Potion',
      type: 'consumable',
      img: 'icons/potion.png',
      system: { price: { value: 1, denomination: 'gp' }, quantity: 1 },
      effects: [],
      flags: { 'another-module': { x: 1 } },
      folder: 'folder1',
      sort: 5,
      ownership: { user2: 2 },
      _stats: { coreVersion: '14', systemId: 'dnd5e' },
    }),
  };
}

function makeShop({ open = true, stockMode = 'finite', price = 100, quantity = 10, visible = true } = {}) {
  const entry = normalizeInventoryEntry({
    id: 'entry1',
    itemUuid: 'Compendium.books.Item.potion',
    snapshot: 'A small red potion',
    name: 'Potion',
    img: 'icons/potion.png',
    quantity,
    stockMode,
    price,
    visible,
  });
  return normalizeShop({ id: 'shop1', name: 'General Store', locationId: 'loc1', open, inventory: [entry] });
}

function makeCommerceCtx({ store, actor, itemSource, adapter, getActor, isGM = () => true, actorOwnedBy = () => true, systemId = () => 'dnd5e', getAdapter = () => adapter, fromUuid = () => itemSource, now = () => 1000, logger = console }) {
  return {
    store,
    getActor: getActor || ((id) => (actor && actor.id === id ? actor : null)),
    fromUuid,
    getAdapter,
    systemId,
    isGM,
    actorOwnedBy,
    logger,
    now,
    makeId,
  };
}

function getLedgerForUser(store, userIdFragment) {
  for (const rec of store._ledgers.values()) {
    if (rec.key.startsWith(userIdFragment)) return rec;
  }
  return null;
}

// ------------------------------------------------------------------ pricing

test('quote returns an integer total', () => {
  const total = quote({ price: 100 }, 3);
  assert.equal(total, 300);
  assert.ok(Number.isInteger(total));
});

test('quote does not accept floats', () => {
  assert.throws(() => quote({ price: 1.5 }, 2), /safe integer/);
});

test('quote does not accept zero or negative quantity', () => {
  assert.throws(() => quote({ price: 10 }, 0), /quantity/);
  assert.throws(() => quote({ price: 10 }, -2), /quantity/);
});

test('quote rejects a negative price', () => {
  assert.throws(() => quote({ price: -5 }, 2), /non-negative/);
});

test('quoteBreakdown yields integer members', () => {
  const b = quoteBreakdown({ price: 250 }, 4);
  assert.equal(b.unitPrice, 250);
  assert.equal(b.quantity, 4);
  assert.equal(b.total, 1000);
  assert.ok([b.unitPrice, b.quantity, b.total].every(Number.isSafeInteger));
});

test('parseMinorUnits accepts digit strings and rejects floats/negatives', () => {
  assert.equal(parseMinorUnits('1,250'), 1250);
  assert.equal(parseMinorUnits(75), 75);
  assert.throws(() => parseMinorUnits('3.5'), /integer string/);
  assert.throws(() => parseMinorUnits('-1'), /integer string/);
  assert.throws(() => parseMinorUnits('abc'), /integer string/);
});

test('add and subtract are integer-safe and reject negatives', () => {
  assert.equal(add(4, 6), 10);
  assert.equal(subtract(10, 3), 7);
  assert.throws(() => subtract(1, 2), /negative/);
});

test('formatMinorUnits keeps the integer value intact', () => {
  assert.equal(formatMinorUnits(1250, { currency: 'cp' }), '1,250 cp');
});

// ----------------------------------------------------------- adapter basics

test('dnd5e denomination conversion in integer copper', () => {
  assert.equal(denominationToCopper('cp'), 1);
  assert.equal(denominationToCopper('sp'), 10);
  assert.equal(denominationToCopper('ep'), 50);
  assert.equal(denominationToCopper('gp'), 100);
  assert.equal(denominationToCopper('pp'), 1000);
  assert.equal(denominationsToCopper({ cp: 5, sp: 2, gp: 1 }), 125);
  assert.deepEqual(copperToDenominations(125), { cp: 5, ep: 0, gp: 1, pp: 0, sp: 2 });
  assert.throws(() => denominationToCopper('btc'), /unknown currency/);
});

test('Dnd5eAdapter getBalance/debit/credit', async () => {
  const adapter = new Dnd5eAdapter();
  const actor = createMockActor({ currency: { gp: 5 } });
  assert.equal(await adapter.getBalance(actor), 500);

  const debit = await adapter.debit(actor, 200);
  assert.equal(debit.newBalance, 300);
  assert.equal(actor.system.currency.gp, 3);

  const credit = await adapter.credit(actor, 50);
  assert.equal(credit.newBalance, 350);
  assert.equal(actor.system.currency.gp, 3);
  assert.equal(actor.system.currency.ep, 1);
});

test('Dnd5eAdapter debit rejects when funds are insufficient', async () => {
  const adapter = new Dnd5eAdapter();
  const actor = createMockActor({ currency: { sp: 1 } });
  await assert.rejects(() => adapter.debit(actor, 20), /insufficient funds/);
});

test('Dnd5eAdapter getItemPrice converts to copper integer', async () => {
  const adapter = new Dnd5eAdapter();
  const item = { system: { price: { value: 2, denomination: 'gp' } } };
  const price = await adapter.getItemPrice(item);
  assert.deepEqual(price, { amount: 2, denomination: 'gp', minorUnits: 200 });
});

test('generic adapter requires configured paths', async () => {
  const bare = new GenericAdapter();
  assert.equal(bare.supported, false);
  const configured = new GenericAdapter({ walletPath: 'flags.w', itemPricePath: 'system.p' });
  assert.equal(configured.supported, true);
  await assert.rejects(bare.getBalance(createMockActor()), /not configured/);
});

test('getAdapter falls back to generic and reports unsupported subclasses', () => {
  assert.ok(getAdapter('some-unknown-system') instanceof GenericAdapter);
  const dh = getAdapter('daggerheart');
  assert.ok(dh instanceof DaggerheartAdapter);
  assert.equal(dh.supported, false, 'daggerheart reports unsupported without config');
  assert.equal(getAdapter('twodsix').supported, false);
  assert.equal(getAdapter('dc20').supported, false);
  const dhConfig = getAdapter('daggerheart', {
    config: { walletPath: 'flags.w', itemPricePath: 'system.p' },
  });
  assert.equal(dhConfig.supported, true, 'only support when paths are configured');
});

// ------------------------------------------------------------- path security

test('path utils reject reserved segments', () => {
  assert.throws(() => readPath({}, 'a.__proto__.b'), /reserved segment/);
  assert.throws(() => readPath({}, 'x.constructor'), /reserved segment/);
  assert.throws(() => setPath({}, 'system.__proto__.q', 1), /reserved segment/);
  assert.throws(() => buildPatch('', 1), /empty path/);
});

test('path utils reject nonnumeric and unsafe integer values', () => {
  assert.throws(() => readIntegerPath({ a: 'seven' }, 'a'), /finite number/);
  assert.throws(() => readIntegerPath({ a: 1.5 }, 'a'), /safe integer/);
  assert.throws(() => readIntegerPath({ a: Number.NaN }, 'a'), /finite number/);
  assert.throws(() => readIntegerPath({ a: -4 }, 'a'), />= 0/);
});

test('generic adapter getBalance rejects non-integer wallet values', async () => {
  const adapter = new GenericAdapter({ walletPath: 'flags.w', itemPricePath: 'system.p' });
  await assert.rejects(() => adapter.getBalance({ flags: { w: 3.5 } }), /safe integer/);
  await assert.rejects(() => adapter.getBalance({ flags: { w: -1 } }), />= 0/);
  assert.equal(await adapter.getBalance({ flags: { w: 7 } }), 7);
});

test('generic adapter debit/credit read and write the integer wallet', async () => {
  const adapter = new GenericAdapter({ walletPath: 'flags.w', itemPricePath: 'system.p' });
  const actor = createMockActor({ flags: { w: 100 } });
  assert.equal(await adapter.getBalance(actor), 100);
  const debit = await adapter.debit(actor, 40);
  assert.equal(debit.newBalance, 60);
  assert.equal(actor.flags.w, 60);
  const credit = await adapter.credit(actor, 10);
  assert.equal(credit.newBalance, 70);
  assert.equal(actor.flags.w, 70);
});

// -------------------------------------------------------------- item delivery

test('cleanItemData strips _id/ownership/folder/sort and preserves system', () => {
  const source = makeSourceItem().toObject();
  const before = JSON.stringify(source);
  const clean = cleanItemData(source);
  assert.equal('_id' in clean, false);
  assert.equal('ownership' in clean, false);
  assert.equal('folder' in clean, false);
  assert.equal('sort' in clean, false);
  assert.ok(clean.system && clean.system.price);
  assert.equal(clean.name, 'Potion');
  // source unchanged
  assert.equal(JSON.stringify(source), before);
});

test('dnd5e deliverItem creates an embedded Item without leaking source fields', async () => {
  const adapter = new Dnd5eAdapter();
  const actor = createMockActor({});
  const delivered = await adapter.deliverItem(actor, makeSourceItem(), { quantity: 2 });
  assert.ok(delivered.id);
  assert.equal(actor.items.length, 1);
  const item = actor.items[0];
  assert.equal('_id' in item, false);
  assert.equal('ownership' in item, false);
  assert.equal(item.system.quantity, 2);
});

test('generic path delivery appends to the configured array without mutation', async () => {
  const adapter = new GenericAdapter({
    walletPath: 'flags.w',
    itemPricePath: 'system.p',
    deliveryMode: 'path',
    deliveryPath: 'flags.marketItems',
  });
  const actor = createMockActor({ flags: { w: 50 } });
  const delivered = await adapter.deliverItem(actor, makeSourceItem(), { quantity: 1 });
  assert.equal(actor.flags.marketItems[0].id, delivered.id);
  assert.equal('_id' in actor.flags.marketItems[0], false);
});

test('generic embedded delivery strips and never mutates the item source', async () => {
  const adapter = new GenericAdapter({
    walletPath: 'flags.w',
    itemPricePath: 'system.p',
  });
  const source = makeSourceItem();
  const actor = createMockActor({ flags: { w: 50 } });
  await adapter.deliverItem(actor, source, { quantity: 2 });
  assert.equal(actor.items.length, 1);
  assert.equal('_id' in actor.items[0], false);
  // source still carries _id
  assert.ok(source.toObject()._id === 'srcItem');
});

// --------------------------------------------------------------------- idempotency

test('payloadHash is stable and distinguishes intents', () => {
  const a = { shopId: 's', entryId: 'e', actorId: 'a', quantity: 1 };
  const b = { ...a };
  assert.equal(payloadHash(a), payloadHash(b));
  assert.notEqual(payloadHash(a), payloadHash({ ...a, quantity: 2 }));
  assert.notEqual(payloadHash(a), payloadHash({ ...a, entryId: 'other' }));
});

test('resolveIdempotency create/replay/conflict', () => {
  const payload = { shopId: 's', entryId: 'e', actorId: 'a', quantity: 1 };
  const hash = payloadHash(payload);

  assert.deepEqual(resolveIdempotency(null, payload), { decision: 'create' });

  const record = { id: 'r1', key: 'u1:req1', payloadHash: hash, status: 'committed' };
  const replay = resolveIdempotency(record, payload);
  assert.equal(replay.decision, 'replay');
  assert.equal(replay.record.id, 'r1');

  const conflict = resolveIdempotency(record, { ...payload, quantity: 9 });
  assert.equal(conflict.decision, 'conflict');
  assert.equal(conflict.expected, hash);
});

test('createLockMap serializes operations per key', async () => {
  const lock = createLockMap();
  const order = [];
  await Promise.all([
    lock.run('k', async () => { order.push('a1'); await sleep(15); order.push('a2'); }),
    lock.run('k', async () => { order.push('b1'); order.push('b2'); }),
  ]);
  assert.deepEqual(order, ['a1', 'a2', 'b1', 'b2']);
});

// ------------------------------------------------------------------- commerce

test('purchase commits with dnd5e: debits, delivers, decrements stock', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );

  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'committed');

  const shop = store._shops.get('shop1');
  assert.equal(shop.inventory[0].quantity, 8, 'stock decremented');
  assert.equal(actor.items.length, 1, 'item delivered');
  assert.equal(actor.system.currency.gp, 3, 'wallet debited by 200 copper');

  const ledger = getLedgerForUser(store, 'user1:');
  assert.ok(ledger, 'a ledger record exists');
  assert.equal(ledger.status, 'committed');
  assert.equal(ledger.totalPrice, 200);
});

test('purchase fails on insufficient funds without charging or delivering', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 60, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 1 } }); // 100 cp
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );

  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' }, // total 120 > 100
    'gm1'
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'insufficient-funds');
  assert.equal(actor.items.length, 0, 'no item delivered');
  assert.equal(actor.system.currency.gp, 1, 'no charge');
  const ledger = getLedgerForUser(store, 'user1:');
  assert.equal(ledger.status, 'failed');
});

test('purchase is idempotent: replay returns the committed outcome', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );

  const payload = {
    shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2,
    requestId: 'fixed-request', userId: 'user1',
  };
  const first = await commerce.purchase(payload, 'gm1');
  assert.equal(first.status, 'committed');
  const balanceAfterFirst = actor.system.currency.gp;

  const second = await commerce.purchase(payload, 'gm1');
  assert.equal(second.status, 'replay');
  assert.equal(actor.system.currency.gp, balanceAfterFirst, 'no second charge');
});

test('purchase rejects a conflicting duplicate payload for the same key', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );

  const base = {
    shopId: 'shop1', actorId: 'actor1', requestId: 'same-req', userId: 'user1',
  };
  const first = await commerce.purchase({ ...base, entryId: 'entry1', quantity: 2 }, 'gm1');
  assert.equal(first.status, 'committed');
  const second = await commerce.purchase({ ...base, entryId: 'entry1', quantity: 9 }, 'gm1');
  assert.equal(second.status, 'conflict');
  assert.equal(second.error, 'conflicting duplicate payload');
});

test('purchase compensates a failed delivery by refunding currency', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  // Make delivery throw after the debit.
  actor.createEmbeddedDocuments = async () => {
    throw new Error('delivery exploded');
  };
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );

  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'failed');
  assert.ok(result.compensation.includes('currency-refunded'));
  assert.equal(actor.system.currency.gp, 5, 'currency refunded');
  const ledger = getLedgerForUser(store, 'user1:');
  assert.equal(ledger.status, 'failed');
});

test('purchase marks needsRecovery when compensation itself fails', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 30, quantity: 10 }));
  // First update (debit) succeeds; second update (refund) throws.
  const actor = createMockActor({ flags: { w: 100 }, failUpdateCount: 2 });
  const adapter = new GenericAdapter({ walletPath: 'flags.w', itemPricePath: 'system.p' });
  // delivery uses embedded creation and throws.
  actor.createEmbeddedDocuments = async () => { throw new Error('delivery exploded'); };
  const commerce = createCommerce(
    makeCommerceCtx({
      store, actor, itemSource: makeSourceItem(), adapter,
      systemId: () => 'generic',
    })
  );

  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' }, // total 60
    'gm1'
  );
  assert.equal(result.status, 'needsRecovery');
  assert.ok(result.compensation.includes('currency-refund-failed'));
  const ledger = getLedgerForUser(store, 'user1:');
  assert.equal(ledger.status, 'needsRecovery');
  assert.ok(ledger.compensation.includes('currency-refund-failed'));
});

test('purchase rejects when the executing user is not a GM', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce(
    makeCommerceCtx({
      store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter(),
      isGM: () => false,
    })
  );
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' },
    'player'
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'not-a-gm');
});

test('purchase reports adapter unsupported without charging', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce(
    makeCommerceCtx({
      store, actor, itemSource: makeSourceItem(),
      adapter: new DaggerheartAdapter(), // no config => unsupported
      systemId: () => 'daggerheart',
    })
  );
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'adapter-unsupported');
  assert.equal(actor.system.currency.gp, 5, 'no charge');
});

test('purchase serializes per shop through the queue', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor1 = createMockActor({ currency: { gp: 5 } });
  const actor2 = createMockActor({ currency: { gp: 5 } });
  const order = [];
  const commerce = createCommerce(
    makeCommerceCtx({
      store, actor: actor1, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter(),
      getActor: (id) => (id === 'actor1' ? actor1 : actor2),
      now: () => Date.now(),
    })
  );

  // Two purchases for the same shop must not interleave in a way that loses
  // a decrement. Run them near-simultaneously.
  const p1 = commerce.purchase({ shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, userId: 'u1' }, 'gm1');
  const p2 = commerce.purchase({ shopId: 'shop1', entryId: 'entry1', actorId: 'actor2', quantity: 1, userId: 'u2' }, 'gm1');
  const [r1, r2] = await Promise.all([p1, p2]);
  order.push(r1.status, r2.status);
  assert.deepEqual(order, ['committed', 'committed']);
  const shop = store._shops.get('shop1');
  assert.equal(shop.inventory[0].quantity, 8, 'both decrements applied serially');
});

test('concurrent same-key purchases across GM clients never double-charge', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  // Two separate commerce instances with SEPARATE lock maps simulate two GM
  // clients: the per-shop lock does not serialize across clients, so this is
  // the exact race the ledger idempotency must resolve.
  const commerceA = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );
  const commerceB = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );
  const payload = {
    shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1,
    requestId: 'dup', userId: 'u1',
  };
  const [r1, r2] = await Promise.all([
    commerceA.purchase(payload, 'gm1'),
    commerceB.purchase(payload, 'gm1'),
  ]);
  const statuses = [r1.status, r2.status];
  assert.ok(statuses.includes('committed'), 'exactly one purchase commits');
  assert.ok(
    statuses.includes('pending') || statuses.includes('replay'),
    'the losing purchase never charges (surfaces as pending or replay)'
  );
  assert.equal(actor.system.currency.gp, 4, 'debit applied exactly once');
  const shop = store._shops.get('shop1');
  assert.equal(shop.inventory[0].quantity, 9, 'stock decremented exactly once');
  const ledgers = Array.from(store._ledgers.values()).filter((r) => r.key === 'u1:dup');
  assert.equal(ledgers.length, 1, 'a single ledger record persists for the key');
  assert.equal(ledgers[0].status, 'committed');
});

test('same requestId across different shops races as a conflict and never double-charges', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  store._shops.set('shop2', makeShop({ price: 50, quantity: 10 }));
  const actor1 = createMockActor({ currency: { gp: 5 } });
  const actor2 = createMockActor({ currency: { gp: 5 } });
  const getActor = (id) => (id === 'actor1' ? actor1 : actor2);
  const commerceA = createCommerce(
    makeCommerceCtx({ store, actor: actor1, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter(), getActor })
  );
  const commerceB = createCommerce(
    makeCommerceCtx({ store, actor: actor2, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter(), getActor })
  );
  const base = { requestId: 'shared', userId: 'u1' };
  const firstBefore = JSON.stringify(actor1.system.currency);
  const secondBefore = JSON.stringify(actor2.system.currency);
  const [r1, r2] = await Promise.all([
    commerceA.purchase(
      { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, ...base }, 'gm1'
    ),
    commerceB.purchase(
      { shopId: 'shop2', entryId: 'entry1', actorId: 'actor2', quantity: 1, ...base }, 'gm1'
    ),
  ]);
  const statuses = [r1.status, r2.status];
  assert.ok(statuses.includes('committed'), 'one purchase commits');
  assert.ok(statuses.includes('conflict'), 'the duplicate key across a different shop is a conflict');
  // Exactly one actor is debited; the conflicting shop is never charged.
  const charged =
    (JSON.stringify(actor1.system.currency) !== firstBefore ? 1 : 0) +
    (JSON.stringify(actor2.system.currency) !== secondBefore ? 1 : 0);
  assert.equal(charged, 1, 'exactly one actor charged');
  const ledgers = Array.from(store._ledgers.values()).filter((r) => r.key === 'u1:shared');
  assert.equal(ledgers.length, 1, 'a single ledger record for the shared key');
  assert.equal(ledgers[0].status, 'committed');
});

// -------------------------------------------- request response + safety

function makeMessageCtx({ commerce }) {
  const responses = [];
  return {
    activeGMId: () => 'gm1',
    currentUserId: () => 'gm1',
    gmIds: () => ['gm1'],
    respond: async (data) => {
      responses.push(data.flags.market.response);
    },
    commerce,
    responses,
  };
}

function makePurchaseMessage(request) {
  return {
    flags: { market: { type: 'request', request: { type: 'purchase', ...request } } },
  };
}

test('purchase response only exposes safe fields, never the raw ledger record', async () => {
  const commerce = {
    purchase: async () => ({
      status: 'replay',
      record: { id: 'r1', key: 'user1:req', totalPrice: 200, quantity: 2, payloadHash: 'x' },
    }),
  };
  const ctx = makeMessageCtx({ commerce });
  const data = await handleMarketChatMessage(
    makePurchaseMessage({ shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, requestId: 'req' }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'purchase');
  const result = data.result;
  assert.deepEqual(result, {
    status: 'replay',
    ledgerId: 'r1',
    error: undefined,
    total: 200,
    quantity: 2,
    compensation: undefined,
  });
  assert.ok(!('record' in result), 'no raw record leaked');
  assert.ok(!('existing' in result), 'no raw conflict record leaked');
  assert.ok(!('expected' in result), 'no expected hash leaked');
});

test('purchase request without a stable requestId is rejected on the GM side', async () => {
  let called = false;
  const commerce = {
    purchase: async () => {
      called = true;
      return { status: 'committed' };
    },
  };
  const ctx = makeMessageCtx({ commerce });
  const data = await handleMarketChatMessage(
    makePurchaseMessage({ shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2 }),
    'user1',
    ctx
  );
  assert.equal(called, false, 'commerce.purchase must not run without a requestId');
  assert.equal(data.result.status, 'error');
  assert.equal(data.result.error, 'missing-request-id');
});

test('publicPurchaseResult never echoes conflict internals', () => {
  const safe = publicPurchaseResult({
    status: 'conflict',
    conflict: true,
    error: 'conflicting duplicate payload',
    expected: 'abc',
    existing: { id: 'r1', payloadHash: 'def' },
  });
  assert.equal(safe.status, 'conflict');
  assert.equal(safe.error, 'conflicting duplicate payload');
  assert.equal(safe.ledgerId, 'r1');
  assert.ok(!('expected' in safe));
  assert.ok(!('existing' in safe));
  assert.ok(!('conflict' in safe));
});

// ----------------------------------------------------------- commerce edge cases

test('a pending ledger replay surfaces pending instead of silently implying success', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );
  const payload = {
    shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2,
    requestId: 'pending-request', userId: 'user1',
  };
  const reqPayload = {
    shopId: payload.shopId, entryId: payload.entryId, actorId: payload.actorId, quantity: 2,
  };
  store._ledgers.set('user1:pending-request', {
    id: 'pend1',
    key: 'user1:pending-request',
    status: 'pending',
    payloadHash: payloadHash(reqPayload),
    quantity: 2,
    unitPrice: 100,
    totalPrice: 200,
    payload: reqPayload,
  });
  const result = await commerce.purchase(payload, 'gm1');
  assert.equal(result.status, 'pending');
  assert.equal(result.ledgerId, 'pend1');
  assert.equal(actor.system.currency.gp, 5, 'no charge on a pending replay');
});

test('purchase reports a total overflow as a failed ledger outcome', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: Number.MAX_SAFE_INTEGER, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 1 } });
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'total-overflow');
});

test('purchase falls back to a valid snapshot when the itemUuid is deleted', async () => {
  const store = createMockStore();
  const shop = makeShop({ price: 50, quantity: 10 });
  shop.inventory[0].itemUuid = 'Compendium.deleted.Item.gone';
  shop.inventory[0].snapshot = JSON.stringify({
    name: 'Potion', type: 'consumable', system: { quantity: 1 },
  });
  store._shops.set('shop1', shop);
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce(
    makeCommerceCtx({
      store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter(),
      fromUuid: async () => null,
    })
  );
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'committed');
  assert.equal(actor.items.length, 1, 'item delivered from snapshot');
  assert.equal(actor.items[0].name, 'Potion');
});

test('purchase refuses an entry with neither a resolvable itemUuid nor a valid snapshot', async () => {
  const store = createMockStore();
  const shop = makeShop({ price: 50, quantity: 10 });
  shop.inventory[0].itemUuid = '';
  shop.inventory[0].snapshot = 'A small red potion'; // not valid JSON item data
  store._shops.set('shop1', shop);
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'failed');
  assert.ok(/item source not found/.test(result.error));
  assert.equal(actor.system.currency.gp, 5, 'currency refunded after source lookup failure');
  assert.equal(actor.items.length, 0);
});

test('purchase restores stock when a later ledger commit write fails', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const originalUpdateLedger = store.updateLedger;
  store.updateLedger = async (id, patch) => {
    if (patch.status === 'committed') throw new Error('commit write failed');
    return originalUpdateLedger(id, patch);
  };
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'failed');
  assert.ok(result.compensation.includes('stock-restored'));
  assert.ok(result.compensation.includes('currency-refunded'));
  assert.ok(result.compensation.includes('item-removed'));
  const shop = store._shops.get('shop1');
  assert.equal(shop.inventory[0].quantity, 10, 'stock restored to original count');
  assert.equal(actor.system.currency.gp, 5, 'currency refunded');
});

test('purchase marks needsRecovery when restoring the stock itself fails', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const originalUpdateLedger = store.updateLedger;
  store.updateLedger = async (id, patch) => {
    if (patch.status === 'committed') throw new Error('commit write failed');
    return originalUpdateLedger(id, patch);
  };
  let updateShopCalls = 0;
  store.updateShop = async (id, patch) => {
    updateShopCalls += 1;
    if (updateShopCalls === 2) throw new Error('stock restore failed');
    const current = store._shops.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    store._shops.set(id, next);
    return next;
  };
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'needsRecovery');
  assert.ok(result.compensation.includes('stock-restore-failed'));
  const ledger = getLedgerForUser(store, 'user1:');
  assert.equal(ledger.status, 'needsRecovery');
  assert.ok(ledger.compensation.includes('stock-restore-failed'));
});

// ------------------------------------------------------------- fractional prices

test('dnd5e item price converts finite fractional values exactly to copper', async () => {
  const adapter = new Dnd5eAdapter();
  const tenth = await adapter.getItemPrice({ system: { price: { value: 0.1, denomination: 'gp' } } });
  assert.equal(tenth.minorUnits, 10, '0.1 gp is exactly 10 cp');
  const quarter = await adapter.getItemPrice({ system: { price: { value: 0.25, denomination: 'gp' } } });
  assert.equal(quarter.minorUnits, 25, '0.25 gp is exactly 25 cp');
  // Float noise for a representable fraction must still resolve to a whole cp.
  const odd = await adapter.getItemPrice({ system: { price: { value: 0.29, denomination: 'gp' } } });
  assert.equal(odd.minorUnits, 29, '0.29 gp is exactly 29 cp');
  await assert.rejects(
    () => adapter.getItemPrice({ system: { price: { value: 0.005, denomination: 'gp' } } }),
    /sub-copper|representable/i
  );
  await assert.rejects(
    () => adapter.getItemPrice({ system: { price: { value: 0.125, denomination: 'gp' } } }),
    /sub-copper|representable/i
  );
});

test('priceValueToCopper rejects sub-copper, non-finite and negative values', () => {
  assert.equal(priceValueToCopper(0.1, 100), 10);
  assert.equal(priceValueToCopper(1, 100), 100);
  assert.throws(() => priceValueToCopper(0.005, 100), /sub-copper|representable/);
  assert.throws(() => priceValueToCopper(0.125, 100), /sub-copper|representable/);
  assert.throws(() => priceValueToCopper(Number.POSITIVE_INFINITY, 100), /finite number/);
  assert.throws(() => priceValueToCopper(-0.5, 100), />= 0/);
});

test('denominationsToCopper detects conversion overflow', () => {
  assert.throws(() => denominationsToCopper({ pp: Number.MAX_SAFE_INTEGER }), /overflowed/);
});

test('dnd5e credit detects an overflowed balance', async () => {
  const adapter = new Dnd5eAdapter();
  const actor = createMockActor({ currency: { gp: 1 } });
  await assert.rejects(() => adapter.credit(actor, Number.MAX_SAFE_INTEGER), /overflowed/);
});

// --------------------------------------------------------------- store default

test('default store creates GM-only journal entries with ownership default 0', async () => {
  const created = [];
  const journalDocs = [];
  globalThis.game = {
    journal: {
      // Foundry V14 `JournalEntry.create` is the document class static; the
      // default store's doc access must use it (not the collection `.create`).
      documentClass: {
        create: async (data) => {
          const doc = { id: makeId(), ...data };
          journalDocs.push(doc);
          created.push(data);
          return doc;
        },
      },
      filter: () => journalDocs,
      get: (id) => journalDocs.find((d) => d.id === id) || null,
    },
  };
  try {
    const loc = await defaultStore.createLocation({ name: 'Town' });
    assert.ok(loc.id);
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].ownership, { default: 0 }, 'journals are GM-only');
  } finally {
    delete globalThis.game;
  }
});

// ------------------------------------------------------------ catalog/allowlist

test('catalog only exposes allowlisted public fields', () => {
  const shop = makeShop({ price: 100, quantity: 5 });
  // sneak in a system-ish field that must not leak
  shop.inventory[0].itemUuid = 'Compen.Book.Item.x';
  shop.inventory[0].system = { price: { value: 1, denomination: 'gp' } };
  const catalog = buildCatalog(shop);

  assert.ok(Object.keys(catalog.shop).every((k) => PUBLIC_SHOP_FIELDS.includes(k)));
  assert.equal(catalog.shop.id, 'shop1');
  assert.equal(catalog.shop.open, true);
  // only visible entries, allowlisted fields
  assert.equal(catalog.inventory.length, 1);
  const entry = catalog.inventory[0];
  assert.ok(Object.keys(entry).every((k) => PUBLIC_ENTRY_FIELDS.includes(k)));
  assert.ok(!('itemUuid' in entry), 'itemUuid not leaked');
  assert.ok(!('system' in entry), 'item system data not leaked');
  assert.ok(!('snapshot' in entry), 'snapshot (possible secret item/system data) not leaked');
});

test('catalog hides invisible entries', () => {
  const shop = makeShop({ quantity: 5 });
  shop.inventory.push(normalizeInventoryEntry({ id: 'entry2', itemUuid: 'u2', name: 'Hidden', price: 5, visible: false }));
  const catalog = buildCatalog(shop);
  assert.equal(catalog.inventory.length, 1);
});

// ------------------------------------------------------------------- schema

test('normalizeLedgerRecord enforces status and key', () => {
  assert.throws(() => normalizeLedgerRecord({ key: '' }), /must not be empty/);
  const rec = normalizeLedgerRecord({ key: 'u1:r1', status: 'committed', quantity: 2, unitPrice: 5, totalPrice: 10 });
  assert.equal(rec.status, 'committed');
  assert.equal(rec.quantity, 2);
  assert.throws(() => normalizeLedgerRecord({ key: 'u1:r1', status: 'bogus' }), /status/);
});

test('stock modes are validated', () => {
  assert.equal(assertStockMode('unlimited'), 'unlimited');
  assert.throws(() => assertStockMode('sometimes'), /stockMode/);
});

test('normalizeShop defaults and ids are stable', () => {
  const shop = normalizeShop({ name: 'S', locationId: 'L' });
  assert.equal(shop.open, true);
  assert.equal(shop.inventory.length, 0);
  assert.ok(Number.isSafeInteger(shop.createdAt));
  const again = normalizeShop({ ...shop });
  assert.equal(again.id, shop.id, 'id reused when provided');
});

// ------------------------------------------------------------------ store

function createFakeDocAccess() {
  const docs = new Map();
  let seq = 0;
  return {
    docs,
    async listJournalEntries() { return Array.from(docs.values()); },
    async getJournalEntry(id) { return docs.get(id) || null; },
    async createJournalEntry({ name, flags }) {
      const id = `journal-${++seq}`;
      const doc = { id, name, flags };
      docs.set(id, doc);
      return doc;
    },
    async updateJournalEntry(doc, patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'flags') doc.flags = { ...doc.flags, ...value };
        else doc[key] = value;
      }
      return doc;
    },
  };
}

test('store creates and updates locations without erasing fields', async () => {
  const store = createStore(createFakeDocAccess());
  const loc = await store.createLocation({ name: 'Town', description: 'A town' });
  assert.ok(loc.id);
  assert.equal(loc.name, 'Town');

  const listBefore = await store.listLocations();
  assert.equal(listBefore.length, 1);

  const updated = await store.updateLocation(loc.id, { description: 'Updated town' });
  assert.equal(updated.name, 'Town', 'name preserved');
  assert.equal(updated.description, 'Updated town');

  const listAfter = await store.listLocations();
  assert.equal(listAfter.length, 1);
  assert.equal(listAfter[0].description, 'Updated town');
});

test('store shops, inventory and findShop round-trip', async () => {
  const store = createStore(createFakeDocAccess());
  const shop = await store.createShop({ name: 'General Store', locationId: 'loc1', open: true });
  assert.equal(shop.inventory.length, 0);

  const entry = await store.addInventoryEntry(shop.id, {
    itemUuid: 'Compendium.a.Item.x',
    name: 'Potion',
    price: 25,
    quantity: 4,
  });
  assert.ok(entry.id);
  assert.equal(entry.price, 25);

  const found = await store.findShop(shop.id);
  assert.equal(found.inventory.length, 1);
  assert.equal(found.inventory[0].quantity, 4);

  const updated = await store.updateShop(shop.id, { open: false });
  assert.equal(updated.open, false);
  assert.equal(updated.inventory.length, 1, 'inventory preserved on update');

  const list = await store.listShops({ locationId: 'loc1' });
  assert.equal(list.length, 1);

  const otherLoc = await store.listShops({ locationId: 'loc2' });
  assert.equal(otherLoc.length, 0);
});

test('store ledger create/find/update idempotency key', async () => {
  const store = createStore(createFakeDocAccess());
  const result = await store.createLedger({
    key: 'user1:req1',
    status: 'pending',
    payloadHash: 'abc123',
    quantity: 2,
    unitPrice: 5,
    totalPrice: 10,
  });
  assert.equal(result.created, true, 'first create persists and reports created');
  const rec = result.record;
  assert.equal(rec.key, 'user1:req1');
  assert.equal(rec.status, 'pending');

  const found = await store.findLedgerByKey('user1:req1');
  assert.equal(found.id, rec.id);

  // Re-creating with the same key must not duplicate; it reports created:false
  // and hands back the existing record (so a caller never charges twice).
  const again = await store.createLedger({
    key: 'user1:req1',
    status: 'pending',
    payloadHash: 'abc123',
    quantity: 2,
    unitPrice: 5,
    totalPrice: 10,
  });
  assert.equal(again.created, false);
  assert.equal(again.record.id, rec.id, 'existing record reused');
  assert.equal((await store.findLedgerByKey('user1:req1')).id, rec.id, 'key still resolves to the same record');

  const updated = await store.updateLedger(rec.id, { status: 'committed' });
  assert.equal(updated.status, 'committed');

  const missing = await store.findLedgerByKey('user1:nope');
  assert.equal(missing, null);
});
