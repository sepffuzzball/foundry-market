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
  normalizePriceBreakdown,
  makeId,
  assertStockMode,
} from '../src/services/model.js';
import {
  getAdapter,
  GenericAdapter,
  Dnd5eAdapter,
  DaggerheartAdapter,
  DC20Adapter,
  TwodsixAdapter,
  DC20_DENOMINATIONS,
  DC20_DENOMINATION_FACTOR,
  dc20DenominationToCopper,
  readPath,
  readIntegerPath,
  setPath,
  buildPatch,
  cleanItemData,
  denominationsToCopper,
  copperToDenominations,
  denominationToCopper,
  priceValueToCopper,
  dndCurrencyFactors,
  formatCopperAsGP,
} from '../src/adapters/index.js';
import {
  createCommerce,
  createLockMap,
  payloadHash,
  resolveIdempotency,
} from '../src/services/commerce.js';
import {
  buildCatalog,
  publicShop,
  publicPurchaseResult,
  publicSellResult,
  publicCartResult,
  publicServiceResult,
  publicPreorderResult,
  publicTheftResult,
  publicAdvancedOrder,
  requestMessageData,
  handleMarketChatMessage,
  buildResponseContent,
  PUBLIC_ENTRY_FIELDS,
  PUBLIC_SHOP_FIELDS,
} from '../src/core/requests.js';
import { fingerprintItem } from '../src/advanced/valuation.js';
import { createStore, store as defaultStore } from '../src/storage/store.js';
import { createLedgerFolderOrganizer, LEDGER_FOLDER_ROLES } from '../src/storage/ledger-folders.js';
import {
  makeItem as sellMakeItem,
  createMockActor as sellCreateMockActor,
  makeAdapter as sellMakeAdapter,
  makeShop as sellMakeShop,
  createFakeStore as sellCreateStore,
  makeService as sellMakeService,
} from './advanced-selling.test.js';

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

function makeShop({ open = true, stockMode = 'finite', price = 100, quantity = 10, visible = true, commerce } = {}) {
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
  return normalizeShop({ id: 'shop1', name: 'General Store', locationId: 'loc1', open, inventory: [entry], commerce });
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

// ------------------------------------------------------- dc20rpg + twodsix

test('DC20 denomination conversion in integer copper (cp/sp/gp/pp)', () => {
  assert.deepEqual(DC20_DENOMINATIONS, ['cp', 'sp', 'gp', 'pp'], 'no ep in DC20');
  assert.equal(dc20DenominationToCopper('cp'), 1);
  assert.equal(dc20DenominationToCopper('sp'), 10);
  assert.equal(dc20DenominationToCopper('gp'), 100);
  assert.equal(dc20DenominationToCopper('pp'), 1000);
  assert.equal(DC20_DENOMINATION_FACTOR['ep'], undefined);
  assert.throws(() => dc20DenominationToCopper('ep'), /unknown currency/);
  assert.throws(() => dc20DenominationToCopper('btc'), /unknown currency/);
});

test('DC20Adapter getBalance/debit/credit convert cp/sp/gp/pp to integer cp', async () => {
  const adapter = new DC20Adapter();
  const actor = createMockActor({ currency: { gp: 5, sp: 2 } });
  assert.equal(await adapter.getBalance(actor), 520);

  const debit = await adapter.debit(actor, 200);
  assert.equal(debit.newBalance, 320);
  assert.equal(actor.system.currency.gp, 3);
  assert.equal(actor.system.currency.sp, 2);
  assert.equal(actor.system.currency.cp, 0);

  const credit = await adapter.credit(actor, 50);
  assert.equal(credit.newBalance, 370);
  assert.equal(actor.system.currency.gp, 3);
  assert.equal(actor.system.currency.sp, 7);
  assert.equal(actor.system.currency.cp, 0);
});

test('DC20Adapter debit rejects when funds are insufficient', async () => {
  const adapter = new DC20Adapter();
  const actor = createMockActor({ currency: { sp: 1 } });
  await assert.rejects(() => adapter.debit(actor, 20), /insufficient funds/);
});

test('DC20Adapter rejects a nonzero unknown wallet denomination', async () => {
  const adapter = new DC20Adapter();
  // ep is not a DC20 denomination and carries a nonzero balance -> reject.
  const actor = createMockActor({ currency: { gp: 1, ep: 1 } });
  await assert.rejects(() => adapter.getBalance(actor), /unknown currency/);
  // A zero balance on an unknown denomination is ignored.
  const zero = createMockActor({ currency: { gp: 1, ep: 0 } });
  assert.equal(await adapter.getBalance(zero), 100);
});

test('DC20Adapter wallet rejects negative, fractional and overflow values', async () => {
  const adapter = new DC20Adapter();
  await assert.rejects(() => adapter.getBalance(createMockActor({ currency: { cp: -1 } })), />= 0/);
  await assert.rejects(() => adapter.getBalance(createMockActor({ currency: { sp: 1.5 } })), /safe integer/);
  // Overflow.credit rejects a balance that would exceed a safe integer.
  const overflow = createMockActor({ currency: { gp: 1 } });
  await assert.rejects(() => adapter.credit(overflow, Number.MAX_SAFE_INTEGER), /overflowed/);
});

test('DC20Adapter getItemPrice reads system.price.value/currency (default gp)', async () => {
  const adapter = new DC20Adapter();
  const gp = await adapter.getItemPrice({ system: { price: { value: 2, currency: 'gp' } } });
  assert.deepEqual(gp, { amount: 2, denomination: 'gp', minorUnits: 200 });
  // currency defaults to "gp" when absent.
  const dflt = await adapter.getItemPrice({ system: { price: { value: 3 } } });
  assert.deepEqual(dflt, { amount: 3, denomination: 'gp', minorUnits: 300 });
  // A non-gp denomination scales to cp minor units exactly.
  const sp = await adapter.getItemPrice({ system: { price: { value: 5, currency: 'sp' } } });
  assert.deepEqual(sp, { amount: 5, denomination: 'sp', minorUnits: 50 });
});

test('DC20Adapter getItemPrice rejects unknown denomination, fractional and overflow', async () => {
  const adapter = new DC20Adapter();
  await assert.rejects(
    () => adapter.getItemPrice({ system: { price: { value: 1, currency: 'ep' } } }),
    /unknown currency denomination/
  );
  await assert.rejects(
    () => adapter.getItemPrice({ system: { price: { value: -1 } } }),
    />= 0/
  );
  await assert.rejects(
    () => adapter.getItemPrice({ system: { price: { value: 1.5 } } }),
    /safe integer/
  );
  await assert.rejects(
    () => adapter.getItemPrice({ system: { price: { value: Number.MAX_SAFE_INTEGER, currency: 'pp' } } }),
    /overflow/
  );
});

test('DC20Adapter deliverItem creates an embedded Item with system.quantity', async () => {
  const adapter = new DC20Adapter();
  const source = makeSourceItem();
  const actor = createMockActor({});
  const delivered = await adapter.deliverItem(actor, source, { quantity: 3 });
  assert.ok(delivered.id);
  assert.equal(actor.items.length, 1);
  assert.equal('_id' in actor.items[0], false);
  assert.equal(actor.items[0].system.quantity, 3);
  // source never mutated and still carries _id.
  assert.equal(source.toObject()._id, 'srcItem');
  const removed = await adapter.removeItem(actor, delivered.id);
  assert.equal(removed, true);
  assert.deepEqual(actor.removedIds, [delivered.id]);
});

test('TwodsixAdapter supports numeric system.financeValues.cash only', async () => {
  const adapter = new TwodsixAdapter();
  const actor = createMockActor({ system: { financeValues: { cash: 100 } } });
  assert.equal(await adapter.getBalance(actor), 100);

  const debit = await adapter.debit(actor, 30);
  assert.equal(debit.newBalance, 70);
  assert.equal(actor.system.financeValues.cash, 70);
  assert.equal('patchLog' in actor && actor.patchLog.length, 1, 'one update wrote cash');
  assert.equal(actor.patchLog[0]['system.financeValues.cash'], 70);

  const credit = await adapter.credit(actor, 5);
  assert.equal(credit.newBalance, 75);
  assert.equal(actor.system.financeValues.cash, 75);
});

test('TwodsixAdapter fails closed for an unsupported/non-numeric cash actor', async () => {
  const adapter = new TwodsixAdapter();
  await assert.rejects(() => adapter.getBalance(createMockActor({})), /finite number/);
  await assert.rejects(
    () => adapter.getBalance(createMockActor({ system: { financeValues: { cash: '0' } } })),
    /finite number/
  );
  await assert.rejects(
    () => adapter.getBalance(createMockActor({ system: { financeValues: { cash: 1.5 } } })),
    /safe integer/
  );
  await assert.rejects(
    () => adapter.getBalance(createMockActor({ system: { financeValues: { cash: -1 } } })),
    />= 0/
  );
  // A cash overflow on credit is rejected before any update.
  const overflow = createMockActor({ system: { financeValues: { cash: 1 } } });
  await assert.rejects(() => adapter.credit(overflow, Number.MAX_SAFE_INTEGER), /overflowed/);
  assert.equal(overflow.system.financeValues.cash, 1, 'no patch applied on overflow');
});

test('TwodsixAdapter getItemPrice maps system.price 1:1 to credits', async () => {
  const adapter = new TwodsixAdapter();
  const price = await adapter.getItemPrice({ system: { price: 50 } });
  assert.deepEqual(price, { amount: 50, denomination: 'credits', minorUnits: 50 });
  await assert.rejects(() => adapter.getItemPrice({ system: { price: -1 } }), />= 0/);
  await assert.rejects(() => adapter.getItemPrice({ system: { price: 1.5 } }), /safe integer/);
});

test('TwodsixAdapter deliverItem creates an embedded Item with system.quantity', async () => {
  const adapter = new TwodsixAdapter();
  const source = makeSourceItem();
  const actor = createMockActor({ system: { financeValues: { cash: 100 } } });
  const delivered = await adapter.deliverItem(actor, source, { quantity: 2 });
  assert.ok(delivered.id);
  assert.equal(actor.items.length, 1);
  assert.equal('_id' in actor.items[0], false);
  assert.equal(actor.items[0].system.quantity, 2);
  assert.equal(source.toObject()._id, 'srcItem');
  const removed = await adapter.removeItem(actor, delivered.id);
  assert.equal(removed, true);
  assert.deepEqual(actor.removedIds, [delivered.id]);
});

test('generic adapter requires configured paths', async () => {
  const bare = new GenericAdapter();
  assert.equal(bare.supported, false);
  const configured = new GenericAdapter({ walletPath: 'flags.w', itemPricePath: 'system.p' });
  assert.equal(configured.supported, true);
  await assert.rejects(bare.getBalance(createMockActor()), /not configured/);
});

test('getAdapter routes first-class dc20rpg/twodsix and unsupported daggerheart', () => {
  assert.ok(getAdapter('some-unknown-system') instanceof GenericAdapter);
  const dh = getAdapter('daggerheart');
  assert.ok(dh instanceof DaggerheartAdapter);
  assert.equal(dh.supported, false, 'daggerheart reports unsupported without config');
  assert.ok(getAdapter('dc20rpg') instanceof DC20Adapter);
  assert.equal(getAdapter('dc20rpg').supported, true, 'dc20rpg is first-class supported');
  assert.ok(getAdapter('twodsix') instanceof TwodsixAdapter);
  assert.equal(getAdapter('twodsix').supported, true, 'twodsix is first-class supported');
  // The legacy 'dc20' system-id alias resolves to the same first-class adapter.
  assert.ok(getAdapter('dc20') instanceof DC20Adapter);
  assert.equal(getAdapter('dc20').supported, true);
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
    priceBreakdown: null,
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

// ------------------------------------------------ M5 sell request wiring

function makeSellMessage(request) {
  return {
    flags: { market: { type: 'request', request: { type: 'sell', ...request } } },
  };
}

function makeSellCtx({ selling, activeGM = 'gm1', currentUser = 'gm1' } = {}) {
  const responses = [];
  return {
    activeGMId: () => activeGM,
    currentUserId: () => currentUser,
    gmIds: () => ['gm1'],
    respond: async (data) => responses.push(data.flags.market.response),
    selling,
    responses,
  };
}

test('publicSellResult never echoes private selling internals', () => {
  const safe = publicSellResult({
    status: 'conflict',
    conflict: true,
    error: 'conflicting duplicate payload',
    expected: 'abc',
    existing: { id: 'o1', details: {} },
    orderId: 'o1',
    details: { payout: 50, fundsBefore: 100, compensation: ['credit-refunded'] },
    compensation: ['credit-refunded'],
    outcome: { payout: 50 },
    record: { id: 'o1', kind: 'sell' },
    payout: 50,
    buybackEntryId: 'b1',
    itemName: 'Potion',
  });
  assert.equal(safe.status, 'conflict');
  assert.equal(safe.error, 'conflicting duplicate payload');
  assert.equal(safe.orderId, 'o1');
  assert.equal(safe.payout, 50);
  assert.equal(safe.buybackEntryId, 'b1');
  assert.equal(safe.itemName, 'Potion');
  assert.ok(!('conflict' in safe));
  assert.ok(!('expected' in safe));
  assert.ok(!('existing' in safe));
  assert.ok(!('details' in safe));
  assert.ok(!('compensation' in safe));
  assert.ok(!('outcome' in safe));
  assert.ok(!('record' in safe));
  assert.ok(!('order' in safe));
});

test('publicSellResult maps unknown and raw error text to a bounded server-error', () => {
  // A raw exception message (adapter/store detail) must not be echoed.
  const raw = publicSellResult({
    status: 'error',
    error: new Error('shop update exploded after apply'),
  });
  assert.equal(raw.error, 'server-error');

  // A malicious/detail-bearing string must not be echoed verbatim.
  const malicious = publicSellResult({
    status: 'error',
    error: "[market] itemPrice did not carry a numeric minorUnits value <script>alert(1)</script>",
  });
  assert.equal(malicious.error, 'server-error');

  // An unknown internal detail string collapses to the generic code.
  const unknown = publicSellResult({ status: 'error', error: 'some internal detail' });
  assert.equal(unknown.error, 'server-error');

  // A known bounded code is preserved verbatim.
  const known = publicSellResult({ status: 'error', error: 'conflicting duplicate payload' });
  assert.equal(known.error, 'conflicting duplicate payload');

  // A known code with an appended internal detail keeps only the bounded code.
  const prefixed = publicSellResult({
    status: 'error',
    error: 'order-read-failed: unexpected token',
  });
  assert.equal(prefixed.error, 'order-read-failed');
});

test('a sell request dispatches to the selling service with the hook userId as requester', async () => {
  const calls = [];
  const selling = {
    sell: async (payload, requesterId) => {
      calls.push({ payload, requesterId });
      return { status: 'committed', orderId: 'o1', payout: 50, buybackEntryId: 'b1', itemName: 'Potion' };
    },
  };
  const ctx = makeSellCtx({ selling });
  const data = await handleMarketChatMessage(
    makeSellMessage({
      shopId: 'shop1',
      actorId: 'actor1',
      itemId: 'item1',
      requestId: 'req-1',
      userId: 'forged-user',
    }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'sell');
  assert.equal(data.result.status, 'committed');
  assert.equal(data.result.orderId, 'o1');
  assert.equal(data.result.payout, 50);
  assert.equal(data.result.buybackEntryId, 'b1');
  assert.equal(data.result.itemName, 'Potion');
  assert.equal(data.requestId, 'req-1');
  assert.equal(data.shopId, 'shop1');
  assert.equal(data.actorId, 'actor1');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].requesterId,
    'user1',
    'the hook userId is the requester, never the payload userId'
  );
  assert.deepEqual(calls[0].payload, {
    shopId: 'shop1',
    actorId: 'actor1',
    itemId: 'item1',
    requestId: 'req-1',
  });
  assert.ok(!('userId' in calls[0].payload), 'no payload userId leaks into the service call');
});

test('a sell request without the required fields is rejected on the GM side', async () => {
  let called = false;
  const selling = {
    sell: async () => {
      called = true;
      return { status: 'committed' };
    },
  };
  const cases = [
    [{ actorId: 'actor1', itemId: 'item1', requestId: 'req' }, 'missing-shop-id'],
    [{ shopId: 'shop1', itemId: 'item1', requestId: 'req' }, 'missing-actor-id'],
    [{ shopId: 'shop1', actorId: 'actor1', requestId: 'req' }, 'missing-item-id'],
    [{ shopId: 'shop1', actorId: 'actor1', itemId: 'item1' }, 'missing-request-id'],
  ];
  for (const [fields, expected] of cases) {
    called = false;
    const ctx = makeSellCtx({ selling });
    const data = await handleMarketChatMessage(makeSellMessage(fields), 'user1', ctx);
    assert.equal(data.result.status, 'error');
    assert.equal(data.result.error, expected);
    assert.equal(called, false, `selling.sell must not run without ${expected}`);
  }
});

test('a sell request commits through the real selling service and exposes only public fields', async () => {
  const shop = sellMakeShop({ funds: 100 });
  const adapter = sellMakeAdapter({ minorUnits: 100 });
  const actor = sellCreateMockActor({ item: sellMakeItem({ name: 'Potion' }) });
  const store = sellCreateStore({ shop });
  const service = sellMakeService({ store, actor, adapter });
  const ctx = makeSellCtx({ selling: service });
  const data = await handleMarketChatMessage(
    makeSellMessage({
      shopId: 'shop1',
      actorId: 'actor1',
      itemId: 'item1',
      requestId: 'req-1',
      userId: 'forged',
    }),
    'gm1',
    ctx
  );
  assert.equal(data.type, 'sell');
  assert.equal(data.result.status, 'committed');
  assert.ok(Number.isSafeInteger(data.result.payout) && data.result.payout > 0);
  assert.equal(data.result.itemName, 'Potion');
  assert.ok(typeof data.result.orderId === 'string');
  assert.ok(typeof data.result.buybackEntryId === 'string');
  assert.equal(data.requestId, 'req-1');
  assert.equal(data.shopId, 'shop1');
  assert.equal(data.actorId, 'actor1');
  assert.ok(!('details' in data.result));
  assert.ok(!('compensation' in data.result));
  // The actor was credited and the shop gained a single buyback listing.
  assert.equal(actor.wallet, data.result.payout);
  assert.equal(store._shops.get('shop1').inventory.length, 1);
});

test('a sell request replays/conflicts through the request path without leaking internals', async () => {
  const selling = {
    sell: async () => ({
      status: 'conflict',
      conflict: true,
      error: 'conflicting duplicate payload',
      orderId: 'o1',
      expected: 'hash',
      existing: { id: 'o1' },
    }),
  };
  const ctx = makeSellCtx({ selling });
  const data = await handleMarketChatMessage(
    makeSellMessage({ shopId: 'shop1', actorId: 'actor1', itemId: 'item1', requestId: 'req-1' }),
    'gm1',
    ctx
  );
  assert.equal(data.type, 'sell');
  assert.equal(data.result.status, 'conflict');
  assert.equal(data.result.error, 'conflicting duplicate payload');
  assert.equal(data.result.orderId, 'o1');
  assert.ok(!('expected' in data.result));
  assert.ok(!('existing' in data.result));
  assert.ok(!('conflict' in data.result));
});

// ---- M5: advanced order request dispatch (cart/service/preorder/theft) ---------

function makeAdvancedMessage(type, request = {}) {
  return {
    flags: { market: { type: 'request', request: { type, ...request } } },
  };
}

function makeAdvancedCtx({ cart, services, preorders, theft, activeGM = 'gm1', currentUser = 'gm1' } = {}) {
  const responses = [];
  return {
    activeGMId: () => activeGM,
    currentUserId: () => currentUser,
    gmIds: () => ['gm1'],
    respond: async (data) => responses.push(data.flags.market.response),
    cart,
    services,
    preorders,
    theft,
    responses,
  };
}

test('a cart request dispatches to the cart service with the hook userId as requester', async () => {
  const calls = [];
  const cart = {
    checkout: async (payload, requesterId) => {
      calls.push({ payload, requesterId });
      return {
        status: 'committed',
        orderId: 'o1',
        total: 700,
        quantity: 3,
        items: [
          { entryId: 'entry1', quantity: 2 },
          { entryId: 'entry2', quantity: 1 },
        ],
      };
    },
  };
  const ctx = makeAdvancedCtx({ cart });
  const data = await handleMarketChatMessage(
    makeAdvancedMessage('cart', {
      shopId: 'shop1',
      actorId: 'actor1',
      lines: [
        { entryId: 'entry1', quantity: 2 },
        { entryId: 'entry2', quantity: 1 },
      ],
      barterItemId: 'item-9',
      requestId: 'req-1',
      userId: 'forged-user',
    }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'cart');
  assert.equal(data.result.status, 'committed');
  assert.equal(data.result.orderId, 'o1');
  assert.equal(data.result.total, 700);
  assert.equal(data.result.quantity, 3);
  assert.equal(data.requestId, 'req-1');
  assert.equal(data.shopId, 'shop1');
  assert.equal(data.actorId, 'actor1');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].requesterId,
    'user1',
    'the hook userId is the requester, never the payload userId'
  );
  assert.deepEqual(calls[0].payload, {
    shopId: 'shop1',
    actorId: 'actor1',
    lines: [
      { entryId: 'entry1', quantity: 2 },
      { entryId: 'entry2', quantity: 1 },
    ],
    requestId: 'req-1',
    barterItemId: 'item-9',
  });
  assert.ok(!('userId' in calls[0].payload), 'no payload userId leaks into the service call');
});

test('a cart request without the required fields is rejected on the GM side', async () => {
  let called = false;
  const cart = {
    checkout: async () => {
      called = true;
      return { status: 'committed' };
    },
  };
  const cases = [
    [{ actorId: 'actor1', lines: [], requestId: 'req' }, 'missing-shop-id'],
    [{ shopId: 'shop1', lines: [], requestId: 'req' }, 'missing-actor-id'],
    [{ shopId: 'shop1', actorId: 'actor1', lines: 'not-an-array', requestId: 'req' }, 'missing-lines'],
    [{ shopId: 'shop1', actorId: 'actor1', lines: [] }, 'missing-request-id'],
  ];
  for (const [fields, expected] of cases) {
    called = false;
    const ctx = makeAdvancedCtx({ cart });
    const data = await handleMarketChatMessage(makeAdvancedMessage('cart', fields), 'user1', ctx);
    assert.equal(data.result.status, 'error');
    assert.equal(data.result.error, expected);
    assert.equal(called, false, `cart.checkout must not run without ${expected}`);
  }
});

test('a service request dispatches to the booking service with the hook userId as requester', async () => {
  const calls = [];
  const services = {
    book: async (payload, requesterId) => {
      calls.push({ payload, requesterId });
      return { status: 'booked', orderId: 'o1', serviceId: 'svc1', serviceName: 'Repair', price: 150 };
    },
  };
  const ctx = makeAdvancedCtx({ services });
  const data = await handleMarketChatMessage(
    makeAdvancedMessage('service', {
      shopId: 'shop1',
      serviceId: 'svc1',
      actorId: 'actor1',
      requestId: 'req-1',
      userId: 'forged-user',
    }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'service');
  assert.equal(data.result.status, 'booked');
  assert.equal(data.result.orderId, 'o1');
  assert.equal(data.result.serviceId, 'svc1');
  assert.equal(data.result.serviceName, 'Repair');
  assert.equal(data.result.price, 150);
  assert.equal(data.requestId, 'req-1');
  assert.equal(data.shopId, 'shop1');
  assert.equal(data.actorId, 'actor1');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].requesterId,
    'user1',
    'the hook userId is the requester, never the payload userId'
  );
  assert.deepEqual(calls[0].payload, {
    shopId: 'shop1',
    serviceId: 'svc1',
    actorId: 'actor1',
    requestId: 'req-1',
  });
  assert.ok(!('userId' in calls[0].payload), 'no payload userId leaks into the service call');
});

test('a service request without the required fields is rejected on the GM side', async () => {
  let called = false;
  const services = {
    book: async () => {
      called = true;
      return { status: 'booked' };
    },
  };
  const cases = [
    [{ serviceId: 'svc1', actorId: 'actor1', requestId: 'req' }, 'missing-shop-id'],
    [{ shopId: 'shop1', actorId: 'actor1', requestId: 'req' }, 'missing-service-id'],
    [{ shopId: 'shop1', serviceId: 'svc1', requestId: 'req' }, 'missing-actor-id'],
    [{ shopId: 'shop1', serviceId: 'svc1', actorId: 'actor1' }, 'missing-request-id'],
  ];
  for (const [fields, expected] of cases) {
    called = false;
    const ctx = makeAdvancedCtx({ services });
    const data = await handleMarketChatMessage(makeAdvancedMessage('service', fields), 'user1', ctx);
    assert.equal(data.result.status, 'error');
    assert.equal(data.result.error, expected);
    assert.equal(called, false, `services.book must not run without ${expected}`);
  }
});

test('a preorder request dispatches to the preorder service with the hook userId as requester', async () => {
  const calls = [];
  const preorders = {
    place: async (payload, requesterId) => {
      calls.push({ payload, requesterId });
      return { status: 'booked', orderId: 'o1', entryId: 'entry1', quantity: 2, total: 200, deposit: 100, remaining: 100 };
    },
  };
  const ctx = makeAdvancedCtx({ preorders });
  const data = await handleMarketChatMessage(
    makeAdvancedMessage('preorder', {
      shopId: 'shop1',
      entryId: 'entry1',
      actorId: 'actor1',
      quantity: 2,
      requestId: 'req-1',
      userId: 'forged-user',
    }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'preorder');
  assert.equal(data.result.status, 'booked');
  assert.equal(data.result.orderId, 'o1');
  assert.equal(data.result.entryId, 'entry1');
  assert.equal(data.result.quantity, 2);
  assert.equal(data.result.total, 200);
  assert.equal(data.requestId, 'req-1');
  assert.equal(data.shopId, 'shop1');
  assert.equal(data.actorId, 'actor1');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].requesterId,
    'user1',
    'the hook userId is the requester, never the payload userId'
  );
  assert.deepEqual(calls[0].payload, {
    shopId: 'shop1',
    entryId: 'entry1',
    actorId: 'actor1',
    quantity: 2,
    requestId: 'req-1',
  });
  assert.ok(!('userId' in calls[0].payload), 'no payload userId leaks into the service call');
});

test('a preorder request without the required fields is rejected on the GM side', async () => {
  let called = false;
  const preorders = {
    place: async () => {
      called = true;
      return { status: 'booked' };
    },
  };
  const cases = [
    [{ entryId: 'entry1', actorId: 'actor1', requestId: 'req' }, 'missing-shop-id'],
    [{ shopId: 'shop1', actorId: 'actor1', requestId: 'req' }, 'missing-entry-id'],
    [{ shopId: 'shop1', entryId: 'entry1', requestId: 'req' }, 'missing-actor-id'],
    [{ shopId: 'shop1', entryId: 'entry1', actorId: 'actor1' }, 'missing-request-id'],
  ];
  for (const [fields, expected] of cases) {
    called = false;
    const ctx = makeAdvancedCtx({ preorders });
    const data = await handleMarketChatMessage(makeAdvancedMessage('preorder', fields), 'user1', ctx);
    assert.equal(data.result.status, 'error');
    assert.equal(data.result.error, expected);
    assert.equal(called, false, `preorders.place must not run without ${expected}`);
  }
});

test('a theft request dispatches to the theft service with the hook userId as requester', async () => {
  const calls = [];
  const theft = {
    attempt: async (payload, requesterId) => {
      calls.push({ payload, requesterId });
      return { status: 'committed', orderId: 'o1', entryId: 'entry1', success: true };
    },
  };
  const ctx = makeAdvancedCtx({ theft });
  const data = await handleMarketChatMessage(
    makeAdvancedMessage('theft', {
      shopId: 'shop1',
      entryId: 'entry1',
      actorId: 'actor1',
      requestId: 'req-1',
      userId: 'forged-user',
    }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'theft');
  assert.equal(data.result.status, 'committed');
  assert.equal(data.result.orderId, 'o1');
  assert.equal(data.result.entryId, 'entry1');
  assert.equal(data.result.success, true);
  assert.equal(data.requestId, 'req-1');
  assert.equal(data.shopId, 'shop1');
  assert.equal(data.actorId, 'actor1');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].requesterId,
    'user1',
    'the hook userId is the requester, never the payload userId'
  );
  assert.deepEqual(calls[0].payload, {
    shopId: 'shop1',
    entryId: 'entry1',
    actorId: 'actor1',
    requestId: 'req-1',
  });
  assert.ok(!('userId' in calls[0].payload), 'no payload userId leaks into the service call');
});

test('a theft request without the required fields is rejected on the GM side', async () => {
  let called = false;
  const theft = {
    attempt: async () => {
      called = true;
      return { status: 'committed' };
    },
  };
  const cases = [
    [{ entryId: 'entry1', actorId: 'actor1', requestId: 'req' }, 'missing-shop-id'],
    [{ shopId: 'shop1', actorId: 'actor1', requestId: 'req' }, 'missing-entry-id'],
    [{ shopId: 'shop1', entryId: 'entry1', requestId: 'req' }, 'missing-actor-id'],
    [{ shopId: 'shop1', entryId: 'entry1', actorId: 'actor1' }, 'missing-request-id'],
  ];
  for (const [fields, expected] of cases) {
    called = false;
    const ctx = makeAdvancedCtx({ theft });
    const data = await handleMarketChatMessage(makeAdvancedMessage('theft', fields), 'user1', ctx);
    assert.equal(data.result.status, 'error');
    assert.equal(data.result.error, expected);
    assert.equal(called, false, `theft.attempt must not run without ${expected}`);
  }
});

test('theft request ignores a client-supplied success and only attempts the claim', async () => {
  let resolveCalled = false;
  const attemptCalls = [];
  const theft = {
    attempt: async (payload) => {
      attemptCalls.push(payload);
      return { status: 'committed', orderId: 'o1' };
    },
    resolve: async () => {
      resolveCalled = true;
      return { status: 'booked' };
    },
  };
  const ctx = makeAdvancedCtx({ theft });
  const data = await handleMarketChatMessage(
    makeAdvancedMessage('theft', {
      shopId: 'shop1',
      entryId: 'entry1',
      actorId: 'actor1',
      requestId: 'req-1',
      success: true,
    }),
    'gm1',
    ctx
  );
  assert.equal(data.type, 'theft');
  assert.equal(data.result.status, 'committed');
  assert.equal(data.result.orderId, 'o1');
  assert.equal(attemptCalls.length, 1);
  assert.ok(!('success' in attemptCalls[0]), 'a client success never reaches attempt');
  assert.equal(resolveCalled, false, 'a player theft request never resolves; only the GM does');
});

test('requestMessageData copies only the allowlisted advanced fields, never a server/GM snapshot', () => {
  const data = requestMessageData({
    type: 'service',
    requestId: 'req-1',
    shopId: 'shop1',
    actorId: 'actor1',
    serviceId: 'svc1',
    success: true,
    price: 999,
    gmUserId: 'gm-x',
    lines: [{ entryId: 'e1', quantity: 1 }],
    barterItemId: 'item-9',
  });
  const request = data.flags.market.request;
  assert.equal(request.type, 'service');
  assert.equal(request.serviceId, 'svc1');
  assert.deepEqual(request.lines, [{ entryId: 'e1', quantity: 1 }]);
  assert.equal(request.barterItemId, 'item-9');
  assert.ok(!('success' in request), 'a client success/price/gmUserId never rides the request');
  assert.ok(!('price' in request));
  assert.ok(!('gmUserId' in request));
});

// ---- M5: advanced public sanitizers strip private response internals ------------

test('publicCartResult strips private cart internals and never echoes carrybacks', () => {
  const safe = publicCartResult({
    status: 'committed',
    conflict: true,
    expected: 'hash',
    existing: { id: 'o1' },
    record: { id: 'o1', kind: 'cart', details: {} },
    outcome: { total: 700 },
    details: { fundsBefore: 1000, barter: [], delivered: [] },
    barter: { itemId: 'x' },
    delivered: [],
    orderId: 'o1',
    total: 700,
    quantity: 3,
    barterCredit: 50,
    cashPaid: 650,
    items: [
      { entryId: 'e1', name: 'Potion', quantity: 2, itemUuid: 'Compendium.Item.p', snapshot: {}, createdId: 'e1' },
      { entryId: 'e2', name: 'Sword', quantity: 1, specialId: 's1', specialPrice: 400 },
    ],
  });
  assert.equal(safe.status, 'committed');
  assert.equal(safe.orderId, 'o1');
  assert.equal(safe.total, 700);
  assert.equal(safe.quantity, 3);
  assert.equal(safe.barterCredit, 50);
  assert.equal(safe.cashPaid, 650);
  assert.deepEqual(safe.items, [
    { entryId: 'e1', name: 'Potion', quantity: 2 },
    { entryId: 'e2', name: 'Sword', quantity: 1, specialId: 's1', specialPrice: 400 },
  ]);
  assert.ok(!('conflict' in safe));
  assert.ok(!('expected' in safe));
  assert.ok(!('existing' in safe));
  assert.ok(!('record' in safe));
  assert.ok(!('outcome' in safe));
  assert.ok(!('details' in safe));
  assert.ok(!('barter' in safe));
  assert.ok(!('delivered' in safe));
});

test('publicServiceResult strips private service internals and never echoes carrybacks', () => {
  const safe = publicServiceResult({
    status: 'fulfilled',
    conflict: true,
    expected: 'hash',
    existing: { id: 'o1' },
    record: { id: 'o1', kind: 'service' },
    outcome: { serviceId: 'svc1' },
    details: { unitPrice: 150, serviceName: 'Repair', priceInfo: {}, fundsBefore: 1000 },
    compensation: ['credit-refunded'],
    orderId: 'o1',
    serviceId: 'svc1',
    serviceName: 'Repair',
    price: 150,
  });
  assert.equal(safe.status, 'fulfilled');
  assert.equal(safe.orderId, 'o1');
  assert.equal(safe.serviceId, 'svc1');
  assert.equal(safe.serviceName, 'Repair');
  assert.equal(safe.price, 150);
  assert.ok(!('conflict' in safe));
  assert.ok(!('expected' in safe));
  assert.ok(!('existing' in safe));
  assert.ok(!('record' in safe));
  assert.ok(!('outcome' in safe));
  assert.ok(!('details' in safe));
  assert.ok(!('compensation' in safe));
});

test('publicPreorderResult strips private preorder internals and never echoes carrybacks', () => {
  const safe = publicPreorderResult({
    status: 'booked',
    conflict: true,
    expected: 'hash',
    existing: { id: 'o1' },
    record: { id: 'o1', kind: 'preorder' },
    outcome: { total: 200 },
    details: { unitPrice: 100, itemUuid: 'Compendium.Item.p', fundsBefore: 1000, compensation: [] },
    orderId: 'o1',
    entryId: 'entry1',
    quantity: 2,
    total: 200,
    deposit: 100,
    remaining: 100,
  });
  assert.equal(safe.status, 'booked');
  assert.equal(safe.orderId, 'o1');
  assert.equal(safe.entryId, 'entry1');
  assert.equal(safe.quantity, 2);
  assert.equal(safe.total, 200);
  assert.equal(safe.deposit, 100);
  assert.equal(safe.remaining, 100);
  assert.ok(!('conflict' in safe));
  assert.ok(!('expected' in safe));
  assert.ok(!('existing' in safe));
  assert.ok(!('record' in safe));
  assert.ok(!('outcome' in safe));
  assert.ok(!('details' in safe));
});

test('publicTheftResult strips private theft internals and never echoes carrybacks', () => {
  const safe = publicTheftResult({
    status: 'committed',
    success: true,
    conflict: true,
    expected: 'hash',
    existing: { id: 'o1' },
    record: { id: 'o1', kind: 'theft' },
    outcome: { success: true },
    details: { compensation: [] },
    orderId: 'o1',
    entryId: 'entry1',
  });
  assert.equal(safe.status, 'committed');
  assert.equal(safe.orderId, 'o1');
  assert.equal(safe.entryId, 'entry1');
  assert.equal(safe.success, true);
  assert.ok(!('conflict' in safe));
  assert.ok(!('expected' in safe));
  assert.ok(!('existing' in safe));
  assert.ok(!('record' in safe));
  assert.ok(!('outcome' in safe));
  assert.ok(!('details' in safe));
});

test('advanced cart/preorder detail is bounded and only emitted for the two documented errors', () => {
  const cartShort = publicCartResult({ status: 'error', error: 'insufficient-funds', detail: 'need 250 more' });
  assert.equal(cartShort.detail, 'need 250 more');
  const cartLong = publicCartResult({
    status: 'error',
    error: 'insufficient-funds',
    detail: 'x'.repeat(300),
  });
  assert.equal(cartLong.detail.length, 200);
  const cartOther = publicCartResult({ status: 'error', error: 'order-read-failed', detail: 'boom' });
  assert.ok(!('detail' in cartOther), 'detail only appears for the two documented errors');
  const preorderRefused = publicPreorderResult({ status: 'error', error: 'service-refused', detail: 'Hated' });
  assert.equal(preorderRefused.detail, 'Hated');
  const svc = publicServiceResult({ status: 'error', error: 'service-refused', detail: 'x' });
  assert.ok(!('detail' in svc), 'service never emits a detail');
  const theft = publicTheftResult({ status: 'error', error: 'insufficient-funds', detail: 'x' });
  assert.ok(!('detail' in theft), 'theft never emits a detail');
});

test('advanced public results carry a stable originalStatus and keep shop-write-missing', () => {
  // A replay response must expose the recorded original status so the storefront
  // can distinguish a success replay from a failed/needsRecovery one.
  const cart = publicCartResult({ status: 'replay', orderId: 'o1', originalStatus: 'committed' });
  assert.equal(cart.originalStatus, 'committed');
  const svc = publicServiceResult({ status: 'replay', orderId: 'o1', originalStatus: 'booked' });
  assert.equal(svc.originalStatus, 'booked');
  const pre = publicPreorderResult({ status: 'replay', orderId: 'o1', originalStatus: 'cancelled' });
  assert.equal(pre.originalStatus, 'cancelled');
  const theft = publicTheftResult({ status: 'replay', orderId: 'o1', originalStatus: 'failed' });
  assert.equal(theft.originalStatus, 'failed');
  const sell = publicSellResult({ status: 'replay', orderId: 'o1', originalStatus: 'committed' });
  assert.equal(sell.originalStatus, 'committed');

  // An unknown / non-string originalStatus is dropped, never leaked.
  const unknown = publicCartResult({ status: 'replay', originalStatus: 'bogus' });
  assert.ok(!('originalStatus' in unknown));
  const nonString = publicCartResult({ status: 'replay', originalStatus: 42 });
  assert.ok(!('originalStatus' in nonString));

  // The null shop-write compensation code is a kept, stable error - it must not
  // collapse to server-error.
  const missing = publicCartResult({ status: 'failed', error: 'shop-write-missing' });
  assert.equal(missing.error, 'shop-write-missing');
  const sellMissing = publicSellResult({ status: 'failed', error: 'shop-write-missing' });
  assert.equal(sellMissing.error, 'shop-write-missing');
});

test('publicAdvancedOrder projects only the bounded scalar summary and strips private fields', () => {
  const o = publicAdvancedOrder({
    id: 'o1',
    key: 'cart:req-1',
    kind: 'cart',
    status: 'committed',
    phase: 'committed',
    shopId: 'shop1',
    actorId: 'actor1',
    entryId: null,
    relatedOrderId: null,
    quantity: 2,
    total: 200,
    deposit: null,
    remaining: null,
    userId: 'player1',
    createdAt: 100,
    updatedAt: 200,
    error: null,
    details: { unitPrice: 100, fundsBefore: 500, compensation: [] },
    outcome: { total: 200 },
    payload: { lines: [{ entryId: 'e1', quantity: 2 }] },
    intentHash: 'abc123',
    extra: 'ignored',
  });
  assert.deepEqual(o, {
    id: 'o1',
    key: 'cart:req-1',
    kind: 'cart',
    status: 'committed',
    phase: 'committed',
    shopId: 'shop1',
    actorId: 'actor1',
    entryId: null,
    relatedOrderId: null,
    quantity: 2,
    total: 200,
    deposit: null,
    remaining: null,
    userId: 'player1',
    createdAt: 100,
    updatedAt: 200,
    error: null,
  });
  assert.ok(!('details' in o));
  assert.ok(!('outcome' in o));
  assert.ok(!('payload' in o));
  assert.ok(!('intentHash' in o));
  assert.ok(!('extra' in o));
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

// ---------------------------------------------- merchant funds on direct Buy

test('purchase earns finite merchant funds on a regular sale', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10, commerce: { funds: 500 } }));
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
  assert.equal(shop.commerce.funds, 700, 'finite merchant funds gained the total');
  assert.equal(actor.system.currency.gp, 3, 'wallet debited by 200 copper');
});

test('purchase earns finite merchant funds on an unlimited-stock sale', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, stockMode: 'unlimited', commerce: { funds: 500 } }));
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
  assert.equal(shop.inventory[0].quantity, 10, 'unlimited stock unchanged');
  assert.equal(shop.commerce.funds, 700, 'finite merchant funds gained the total');
});

test('purchase refuses a merchant-funds overflow before any debit', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10, commerce: { funds: Number.MAX_SAFE_INTEGER } }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );

  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'merchant-funds-overflow');
  assert.equal(actor.system.currency.gp, 5, 'no charge before the overflow refusal');
  assert.equal(actor.items.length, 0, 'no item delivered');
  const shop = store._shops.get('shop1');
  assert.equal(shop.inventory[0].quantity, 10, 'stock unchanged');
  assert.equal(shop.commerce.funds, Number.MAX_SAFE_INTEGER, 'funds unchanged');
  const ledger = getLedgerForUser(store, 'user1:');
  assert.equal(ledger.status, 'failed');
  assert.equal(ledger.error, 'merchant-funds-overflow');
});

test('purchase compensates when the shop write applies but then throws', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10, commerce: { funds: 500 } }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const originalUpdateShop = store.updateShop;
  let updateShopCalls = 0;
  store.updateShop = async (id, patch) => {
    updateShopCalls += 1;
    if (updateShopCalls === 1) {
      // Apply the patch, then throw: the write landed but the call failed.
      const current = store._shops.get(id);
      if (current) store._shops.set(id, { ...current, ...patch });
      throw new Error('shop write exploded after apply');
    }
    return originalUpdateShop(id, patch);
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
  assert.ok(result.compensation.includes('item-removed'));
  assert.ok(result.compensation.includes('shop-restored'));
  const shop = store._shops.get('shop1');
  assert.equal(shop.inventory[0].quantity, 10, 'stock restored to the original count');
  assert.equal(shop.commerce.funds, 500, 'merchant funds restored to the original amount');
  assert.equal(actor.system.currency.gp, 5, 'currency refunded');
});

test('purchase escalates a mixed shop write to needsRecovery', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10, commerce: { funds: 500 } }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const originalUpdateShop = store.updateShop;
  let updateShopCalls = 0;
  store.updateShop = async (id, patch) => {
    updateShopCalls += 1;
    if (updateShopCalls === 1) {
      // Apply only the stock change (drop the commerce patch), then throw: the
      // write halves apart - one dimension applied, the other did not.
      const current = store._shops.get(id);
      if (current) store._shops.set(id, { ...current, inventory: patch.inventory });
      throw new Error('write exploded with a half-applied patch');
    }
    return originalUpdateShop(id, patch);
  };
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );

  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'needsRecovery');
  assert.ok(result.compensation.includes('shop-state-mixed'));
  const shop = store._shops.get('shop1');
  assert.equal(shop.inventory[0].quantity, 8, 'stock left as the half-applied write left it');
  assert.equal(shop.commerce.funds, 500, 'funds left untouched by the half-applied write');
  const ledger = getLedgerForUser(store, 'user1:');
  assert.equal(ledger.status, 'needsRecovery');
});

test('purchase refunds a failure and leaves finite funds unchanged', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10, commerce: { funds: 500 } }));
  const actor = createMockActor({ currency: { gp: 5 } });
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
  const shop = store._shops.get('shop1');
  assert.equal(shop.inventory[0].quantity, 10, 'stock never touched');
  assert.equal(shop.commerce.funds, 500, 'merchant funds never touched');
});

test('purchase with legacy null funds leaves commerce.funds unchanged', async () => {
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
  assert.equal(shop.commerce.funds, null, 'legacy null funds stay null');
  assert.equal(shop.inventory[0].quantity, 8, 'stock decremented as before');
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

// ------------------------------------------------------ M6 dynamic currency config
//
// Official dnd5e `CONFIG.DND5E.currencies[d].conversion` is UNITS PER GP - how
// many units of denomination d are worth ONE gold piece - not GP per unit. Every
// config below uses that meaning, so the copper factor for a denomination is
// `conversion.cp / conversion[d]` (e.g. the official cp=100, gp=1 gives
// factor[gp] = 100 copper per gold).

// The canonical units-per-gp config (1 gp = 100 cp, 10 sp, 2 ep; 10 gp = 1 pp)
// must reproduce the legacy copper factors exactly and format GP exactly.
test('M6: canonical currency config reproduces legacy copper factors', () => {
  const config = {
    cp: { conversion: 100 },
    sp: { conversion: 10 },
    ep: { conversion: 2 },
    gp: { conversion: 1 },
    pp: { conversion: 0.1 },
  };
  assert.deepEqual(dndCurrencyFactors(config), { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 });
  assert.equal(formatCopperAsGP(125, config), '1.25');
  assert.equal(formatCopperAsGP(1250, config), '12.5');
});

test('M6: scientific-notation conversion strings parse exactly', () => {
  // cp 1e2 == 100 cp per gp, gp 1: factor[gp] is exactly 100.
  assert.deepEqual(
    dndCurrencyFactors({ cp: { conversion: '1e2' }, gp: { conversion: 1 } }),
    { cp: 1, gp: 100 }
  );
  // pp 1e-1 == 0.1 pp per gp (10 gp = 1 pp): factor[pp] is exactly 1000.
  assert.deepEqual(
    dndCurrencyFactors({ cp: { conversion: 100 }, gp: { conversion: 1 }, pp: { conversion: '1e-1' } }),
    { cp: 1, gp: 100, pp: 1000 }
  );
  // The exact rational is used for GP formatting too: 125 cp / 100 cp-per-gp = 1.25 gp.
  assert.equal(
    formatCopperAsGP(125, { cp: { conversion: '1e2' }, gp: { conversion: 1 } }),
    '1.25'
  );
});

test('M6: an unsafe decimal conversion scale is rejected', () => {
  // 1e200 is a finite, positive decimal whose scientific scale (200) exceeds the
  // supported bound, so it fails closed instead of building a huge power of ten.
  assert.throws(
    () => dndCurrencyFactors({ cp: { conversion: '1e200' }, gp: { conversion: 1 } }),
    /scale|exponent/i
  );
  // A huge negative scale (1e-200) is likewise rejected.
  assert.throws(
    () => dndCurrencyFactors({ cp: { conversion: '1e-200' }, gp: { conversion: 1 } }),
    /scale|exponent/i
  );
});

test('M6: Dnd5eAdapter honors CONFIG.DND5E.currencies when present', async () => {
  const saved = globalThis.CONFIG;
  globalThis.CONFIG = {
    DND5E: {
      currencies: {
        pp: { conversion: 0.1 },
        gp: { conversion: 1 },
        ep: { conversion: 2 },
        sp: { conversion: 10 },
        cp: { conversion: 100 },
      },
    },
  };
  try {
    const adapter = new Dnd5eAdapter();
    const actor = createMockActor({ currency: { gp: 5 } });
    assert.equal(await adapter.getBalance(actor), 500);
    assert.deepEqual(dndCurrencyFactors({
      cp: { conversion: 100 },
      gp: { conversion: 1 },
    }), { cp: 1, gp: 100 });
  } finally {
    if (saved === undefined) delete globalThis.CONFIG;
    else globalThis.CONFIG = saved;
  }
});

test('M6: custom dynamic currency config converts through derived factors', async () => {
  // A GM-configured non-default rate: 1 gp = 50 cp and 1 sp = 10 cp. The factors
  // are derived as conversion.cp / conversion[d], never hardcoded.
  const config = { cp: { conversion: 50 }, sp: { conversion: 5 }, gp: { conversion: 1 } };
  assert.deepEqual(dndCurrencyFactors(config), { cp: 1, sp: 10, gp: 50 });
  assert.equal(formatCopperAsGP(105, config), '2.1');
  assert.equal(formatCopperAsGP(125, config), '2.5');

  const adapter = new Dnd5eAdapter({ currencyConfig: config });
  const actor = createMockActor({ currency: { gp: 2, cp: 5 } });
  assert.equal(await adapter.getBalance(actor), 105);

  const debit = await adapter.debit(actor, 50);
  assert.equal(debit.newBalance, 55);
  assert.equal(actor.system.currency.gp, 1, 'decomposed to 1 gp');
  assert.equal(actor.system.currency.cp, 5, 'decomposed to 5 cp');

  const price = await adapter.getItemPrice({ system: { price: { value: 1, denomination: 'gp' } } });
  assert.equal(price.minorUnits, 50, 'item gp converts to 50 cp');
});

test('M6: getAdapter forwards a currencyConfig to the dnd5e adapter', async () => {
  const adapter = getAdapter('dnd5e', { currencyConfig: { cp: { conversion: 50 }, gp: { conversion: 1 } } });
  assert.ok(adapter instanceof Dnd5eAdapter);
  const actor = createMockActor({ currency: { gp: 2, cp: 5 } });
  assert.equal(await adapter.getBalance(actor), 105);
});

test('M6: malformed conversion, inexact ratio and overflow fail closed before an update', async () => {
  // malformed (zero) conversion
  const zero = new Dnd5eAdapter({ currencyConfig: { cp: { conversion: 0 }, gp: { conversion: 1 } } });
  const a = createMockActor({ currency: { gp: 1 } });
  await assert.rejects(() => zero.debit(a, 1), /conversion/);
  assert.equal(a.system.currency.gp, 1, 'wallet unchanged after a failed config');
  assert.equal(a.patchLog.length, 0, 'no patch applied');

  // inexact ratio (1 gp / 0.03 cp is not a whole number of copper)
  const inexact = new Dnd5eAdapter({ currencyConfig: { cp: { conversion: 0.03 }, gp: { conversion: 1 } } });
  const b = createMockActor({ currency: { gp: 1 } });
  await assert.rejects(() => inexact.debit(b, 1), /factor|whole number/);
  assert.equal(b.patchLog.length, 0, 'no patch applied');

  // factor overflow (1e25 copper per gp overflows a safe integer)
  const overflow = new Dnd5eAdapter({
    currencyConfig: { cp: { conversion: '10000000000000000000000000' }, gp: { conversion: 1 } },
  });
  const c = createMockActor({ currency: { gp: 1 } });
  await assert.rejects(() => overflow.debit(c, 1), /safe integer|factor/);
  assert.equal(c.patchLog.length, 0, 'no patch applied');
});

test('M6: an unknown currency denomination with nonzero balance is rejected', async () => {
  const adapter = new Dnd5eAdapter({ currencyConfig: { cp: { conversion: 50 }, gp: { conversion: 1 } } });
  // ep is not configured and carries a nonzero balance -> reject.
  const actor = createMockActor({ currency: { gp: 1, ep: 1 } });
  await assert.rejects(() => adapter.getBalance(actor), /unknown currency/);
  // A zero balance on an unknown denomination is ignored.
  const zero = createMockActor({ currency: { gp: 1, ep: 0 } });
  assert.equal(await adapter.getBalance(zero), 50);
});

test('M6: item price rejects fractional minor units and overflow under a dynamic factor', async () => {
  const adapter = new Dnd5eAdapter({ currencyConfig: { cp: { conversion: 50 }, gp: { conversion: 1 } } });
  // 0.03 gp * 50 cp/gp = 1.5 cp -> not representable.
  await assert.rejects(
    () => adapter.getItemPrice({ system: { price: { value: 0.03, denomination: 'gp' } } }),
    /sub-copper|representable/i
  );
  // An overflowing product is rejected rather than wrapping.
  const defaultAdapter = new Dnd5eAdapter();
  await assert.rejects(
    () => defaultAdapter.getItemPrice({ system: { price: { value: Number.MAX_SAFE_INTEGER, denomination: 'gp' } } }),
    /overflow/i
  );
});

test('M6: item price rejects fractional copper exactly with no tolerance', async () => {
  const adapter = new Dnd5eAdapter();
  // 1000000.005 gp * 100 cp/gp = 100000000.5 cp -> fractional copper, rejected
  // exactly (no tolerance that could round a large float to a whole integer).
  await assert.rejects(
    () => adapter.getItemPrice({ system: { price: { value: 1000000.005, denomination: 'gp' } } }),
    /sub-copper|representable/i
  );
  // A large exact integer value still converts to an exact safe integer.
  const ok = await adapter.getItemPrice({ system: { price: { value: 1000000, denomination: 'gp' } } });
  assert.equal(ok.minorUnits, 100000000, '1000000 gp is exactly 100000000 cp');
});

test('M6: purchase succeeds and debits once under the live official CONFIG', async () => {
  const saved = globalThis.CONFIG;
  globalThis.CONFIG = {
    DND5E: {
      currencies: {
        pp: { conversion: 0.1 },
        gp: { conversion: 1 },
        ep: { conversion: 2 },
        sp: { conversion: 10 },
        cp: { conversion: 100 },
      },
    },
  };
  try {
    const store = createMockStore();
    store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
    const actor = createMockActor({ currency: { gp: 1 } });
    const adapter = new Dnd5eAdapter();
    const originalDebit = adapter.debit.bind(adapter);
    let debitCount = 0;
    adapter.debit = async (a, amount) => {
      debitCount += 1;
      return originalDebit(a, amount);
    };
    const commerce = createCommerce(
      makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter })
    );
    const result = await commerce.purchase(
      { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, requestId: 'req1', userId: 'user1' },
      'gm1'
    );
    assert.equal(result.status, 'committed');
    assert.equal(debitCount, 1, 'debits exactly once');
    assert.equal(actor.system.currency.gp, 0, '1 gp spent on a 100-cp item');
    const ledger = getLedgerForUser(store, 'user1:');
    assert.ok(ledger, 'a ledger record exists');
    assert.equal(ledger.status, 'committed');
    assert.equal(ledger.totalPrice, 100);
  } finally {
    if (saved === undefined) delete globalThis.CONFIG;
    else globalThis.CONFIG = saved;
  }
});

test('M6: a raw purchase exception is sanitized but the ledger keeps the diagnostic', async () => {
  // The real-world bug scenario: the adapter throws a raw `[market] ...` detail
  // while reading the balance. Commerce records a failed ledger carrying the
  // bounded `balance-read-failed` code and returns the raw detail on the result;
  // the public projection (and the chat content) expose only the bounded code,
  // never the raw adapter message.
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 1 } });
  const failing = new Dnd5eAdapter();
  failing.getBalance = async () => {
    throw new Error("[market] currency 'gp' factor (100 / 1) is not a whole number of copper");
  };
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: failing })
  );

  // The raw commerce result keeps the bounded code AND the raw diagnostic detail.
  const raw = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, requestId: 'req1', userId: 'user1' },
    'gm1'
  );
  assert.equal(raw.status, 'failed');
  assert.equal(raw.error, 'balance-read-failed');
  assert.ok(raw.detail.includes('whole number of copper'), 'raw detail retained for GM diagnosis');

  // The GM-only ledger retains the diagnostic error code.
  const ledger = getLedgerForUser(store, 'user1:');
  assert.ok(ledger, 'a ledger record exists');
  assert.equal(ledger.error, 'balance-read-failed');
  assert.equal(actor.system.currency.gp, 1, 'no charge on a failed read');

  // The player-facing projection and chat never leak the raw adapter message.
  const safe = publicPurchaseResult(raw);
  assert.equal(safe.error, 'balance-read-failed');
  assert.equal(safe.status, 'failed');
  assert.ok(!('detail' in safe), 'raw detail stripped from the public projection');
  assert.equal(buildResponseContent({ type: 'purchase', result: safe }), 'Purchase failed (balance-read-failed).');
});

test('M6: an unknown/raw purchase error collapses to server-error in response and chat', async () => {
  const commerce = {
    purchase: async () => ({ status: 'error', error: new Error('[market] something exploded at runtime') }),
  };
  const ctx = makeMessageCtx({ commerce });
  const data = await handleMarketChatMessage(
    makePurchaseMessage({ shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, requestId: 'req' }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'purchase');
  assert.equal(data.result.error, 'server-error', 'raw error collapses to server-error');
  assert.equal(buildResponseContent(data), 'Purchase failed (server-error).');
  assert.ok(!data.result.error.includes('exploded'), 'no raw text leaks into the response');
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

test('catalog projects owner and sanitized appearance fields', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'The Apothecary',
    locationId: 'loc1',
    open: true,
    theme: 'apothecary',
    owner: 'Maven Elar',
    appearance: {
      backgroundImage: 'modules/apothecary/img/bg.png',
      ownerPortrait: 'icons/elar.png',
      accentColor: '#AB12CD',
      typography: 'display',
      density: 'compact',
      animation: 'subtle',
      music: 'modules/apothecary/sfx/amb.ogg',
      soundEffect: 'systems/dnd5e/sfx/bell.ogg',
      welcomeMessage: 'Welcome to the apothecary.',
    },
    inventory: [],
  });
  const catalog = buildCatalog(shop);
  assert.equal(catalog.shop.owner, 'Maven Elar');
  assert.equal(catalog.shop.theme, 'apothecary');
  assert.deepEqual(catalog.shop.appearance, {
    backgroundImage: 'modules/apothecary/img/bg.png',
    ownerPortrait: 'icons/elar.png',
    accentColor: '#AB12CD',
    typography: 'display',
    density: 'compact',
    animation: 'subtle',
    music: 'modules/apothecary/sfx/amb.ogg',
    soundEffect: 'systems/dnd5e/sfx/bell.ogg',
    welcomeMessage: 'Welcome to the apothecary.',
  });
  // Only allowlisted public fields project; no raw store/pricing internals.
  assert.ok(Object.keys(catalog.shop).every((k) => PUBLIC_SHOP_FIELDS.includes(k)));
});

test('catalog projects public entry metadata only for visible entries and keeps hidden/snapshot privacy', () => {
  const entry = normalizeInventoryEntry({
    id: 'e1',
    itemUuid: 'Compendium.a.Item.x',
    snapshot: JSON.stringify({ name: 'Potion', system: { price: { value: 1 } } }),
    name: 'Potion',
    price: 25,
    quantity: 4,
    publicDescription: 'A red potion.',
    category: 'Consumable',
    rarity: 'Common',
  });
  const hidden = normalizeInventoryEntry({
    id: 'e2',
    itemUuid: 'Compendium.a.Item.y',
    snapshot: JSON.stringify({ name: 'Ring', system: {} }),
    name: 'Ring',
    price: 50,
    quantity: 1,
    visible: false,
    publicDescription: 'A hidden ring.',
    category: 'Wondrous',
    rarity: 'Rare',
  });
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    inventory: [entry, hidden],
  });
  const catalog = buildCatalog(shop);
  assert.equal(catalog.inventory.length, 1, 'only the visible entry projects');
  const publicEntry = catalog.inventory[0];
  assert.equal(publicEntry.publicDescription, 'A red potion.');
  assert.equal(publicEntry.category, 'Consumable');
  assert.equal(publicEntry.rarity, 'Common');
  assert.ok(!('itemUuid' in publicEntry), 'itemUuid hidden');
  assert.ok(!('snapshot' in publicEntry), 'snapshot (possible item/system secret) hidden');
});

test('buildCatalog never supplies unvalidated raw input to the projection', () => {
  const raw = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    owner: 42,
    theme: '',
    appearance: {
      backgroundImage: 'https://cdn.example.com/bg.png',
      ownerPortrait: 'icons/a (1).png',
      accentColor: 'red',
      typography: 'fancy',
      density: 'wide',
      animation: 'none',
      music: 'worlds/x/y.ogg?q=1',
      soundEffect: 'modules/x/../../y.ogg',
      welcomeMessage: 'Hi',
    },
    inventory: [],
  };
  assert.doesNotThrow(() => buildCatalog(raw));
  const catalog = buildCatalog(raw);
  assert.equal(catalog.shop.theme, 'general-store', 'blank theme fails closed to general-store');
  assert.equal(catalog.shop.owner, '42', 'owner coerced to a plain string');
  const appearance = catalog.shop.appearance;
  assert.equal(appearance.backgroundImage, '');
  assert.equal(appearance.ownerPortrait, '');
  assert.equal(appearance.accentColor, '');
  assert.equal(appearance.typography, 'classic');
  assert.equal(appearance.density, 'comfortable');
  assert.equal(appearance.animation, 'full');
  assert.equal(appearance.music, '');
  assert.equal(appearance.soundEffect, '');
  assert.equal(appearance.welcomeMessage, 'Hi');
  // Every appearance field is a plain string; no unsafe value leaked.
  assert.ok(Object.values(appearance).every((v) => typeof v === 'string'));
});

test('a hidden primary NPC never leaks its name in shop.owner or merchants', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'The Quiet Shop',
    locationId: 'loc1',
    owner: 'Borin the Smith',
    npcs: [
      { name: 'Borin the Smith', visible: false },
      { name: 'Mira the Clerk', role: 'Clerk', visible: true },
    ],
    inventory: [],
  });
  const catalog = buildCatalog(shop);
  assert.equal(catalog.shop.owner, '', 'hidden primary owner is blanked');
  assert.ok(
    !catalog.merchants.some((m) => m.name === 'Borin the Smith'),
    'hidden primary not in merchants'
  );
  assert.equal(catalog.merchants.length, 1, 'only visible merchants project');
  assert.equal(catalog.merchants[0].name, 'Mira the Clerk');
});

test('a hidden primary NPC never leaks its name or portrait through the public shop', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'The Quiet Shop',
    locationId: 'loc1',
    owner: 'Borin the Smith',
    appearance: {
      backgroundImage: 'modules/apothecary/img/bg.png',
      ownerPortrait: 'icons/borin.png',
      welcomeMessage: 'Welcome to the quiet shop.',
    },
    npcs: [
      { name: 'Borin the Smith', portrait: 'icons/borin.png', visible: false },
      { name: 'Mira the Clerk', role: 'Clerk', portrait: 'icons/mira.png', visible: true },
    ],
    inventory: [],
  });
  // The catalog projection is the same as publicShop's output (publicShop is
  // embedded in the catalog via buildCatalog), so assert both direct and catalog
  // projections blank the hidden primary's name AND portrait.
  const direct = publicShop(shop);
  assert.equal(direct.owner, '', 'direct projection blanks the hidden primary owner');
  assert.equal(direct.appearance.ownerPortrait, '', 'direct projection blanks the hidden primary portrait');

  const catalog = buildCatalog(shop);
  assert.equal(catalog.shop.owner, '', 'catalog blanks the hidden primary owner');
  assert.equal(catalog.shop.appearance.ownerPortrait, '', 'catalog blanks the hidden primary portrait');
  // Other appearance fields and visible-NPC behavior remain intact.
  assert.equal(catalog.shop.appearance.backgroundImage, 'modules/apothecary/img/bg.png', 'background preserved');
  assert.equal(catalog.shop.appearance.welcomeMessage, 'Welcome to the quiet shop.', 'welcomeMessage preserved');
  assert.ok(
    !catalog.merchants.some((m) => m.name === 'Borin the Smith'),
    'hidden primary not in merchants'
  );
  assert.equal(catalog.merchants.length, 1, 'only visible merchants project');
  assert.equal(catalog.merchants[0].name, 'Mira the Clerk');
  assert.equal(catalog.merchants[0].portrait, 'icons/mira.png', 'visible merchant portrait preserved');
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

// A fake docAccess wired to a real ledger-folder organizer. `folders` is a live
// list the organizer scans (it exposes the low-level folder records for
// assertions) and `FolderClass` creates + records folders in that same list.
// `opts.isActiveGM` controls both the organizer's own gate and the sweep gate the
// store reads through `store.organizeLedgerJournals({ isActiveGM })`.
function createFakeDocAccessWithOrganizer({
  isActiveGM = () => true,
  ListLedgerJournals = null,
} = {}) {
  const docs = new Map();
  const folders = [];
  let seq = 0;
  let folderSeq = 0;
  const FolderClass = {
    create: async (data) => {
      const id = `folder-${++folderSeq}`;
      const folder = {
        id,
        name: data.name,
        type: data.type,
        folder: data.folder ?? null,
        flags: data.flags,
      };
      folders.push(folder);
      return folder;
    },
  };
  const organizer = createLedgerFolderOrganizer({
    folders,
    FolderClass,
    isActiveGM,
    logger: { warn: () => {} },
  });
  function makeDoc({ name, flags, folder = null } = {}) {
    const id = `journal-${++seq}`;
    const doc = {
      id,
      name,
      flags,
      _source: { folder },
      failUpdate: false,
      update(patch) {
        if (this.failUpdate) throw new Error('[market] fake doc.update failed');
        if (patch && patch.folder !== undefined) this._source.folder = patch.folder;
        if (patch && patch.flags) this.flags = { ...this.flags, ...patch.flags };
        return this;
      },
    };
    docs.set(id, doc);
    return doc;
  }
  const listJournalEntries = () => Promise.resolve(Array.from(docs.values()));
  const listLedgerJournals =
    ListLedgerJournals === null
      ? () => Promise.resolve(Array.from(docs.values()))
      : () => Promise.resolve(ListLedgerJournals(docs));
  return {
    docs,
    folders,
    FolderClass,
    makeDoc,
    async listJournalEntries() {
      return listJournalEntries();
    },
    async listLedgerJournals() {
      return listLedgerJournals();
    },
    async getJournalEntry(id) {
      return docs.get(id) || null;
    },
    async createJournalEntry({ name, flags }) {
      return makeDoc({ name, flags });
    },
    async updateJournalEntry(doc, patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'flags') doc.flags = { ...doc.flags, ...value };
        else doc[key] = value;
      }
      return doc;
    },
    async organizeLedgerJournal(doc, status) {
      return organizer.organize(doc, status);
    },
    // Test-only: resolve once every queued folder placement (including the
    // store's fire-and-forget organizes) has settled, so a test can await the
    // best-effort arrange deterministically.
    async flushOrganizer() {
      return organizer.flush();
    },
  };
}

function folderByRole(folders, role) {
  return folders.find(
    (f) => f.type === 'JournalEntry' && f.flags?.market?.ledgerRole === role
  ) || null;
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

test('store updateShop derives owner from the new primary NPC when npcs are patched without an owner', async () => {
  const store = createStore(createFakeDocAccess());
  const shop = await store.createShop({
    name: 'S',
    locationId: 'loc1',
    owner: 'Old Owner',
    npcs: [
      { name: 'Old Owner', personality: 'honest' },
      { name: 'Tavi', personality: 'honest' },
    ],
  });
  assert.equal(shop.owner, 'Old Owner');
  assert.equal(shop.npcs[0].name, 'Old Owner');
  // Patch the primary NPC's name (and roster) WITHOUT an explicit owner. The
  // derived owner must come from the new primary, never the stale persisted
  // owner string (which used to be re-applied onto npcs[0].name).
  const updated = await store.updateShop(shop.id, {
    npcs: [
      { name: 'Renamed', personality: 'generous' },
      { name: 'Tavi', personality: 'honest' },
    ],
  });
  assert.equal(updated.npcs[0].name, 'Renamed', 'primary NPC name preserved through the patch');
  assert.equal(updated.owner, 'Renamed', 'owner derived from the new primary NPC name');
});

test('store updateShop lets an explicit owner win over the derived primary NPC name', async () => {
  const store = createStore(createFakeDocAccess());
  const shop = await store.createShop({
    name: 'S',
    locationId: 'loc1',
    owner: 'Old',
    npcs: [{ name: 'Old', personality: 'honest' }],
  });
  const updated = await store.updateShop(shop.id, {
    npcs: [{ name: 'Newly', personality: 'honest' }],
    owner: 'Explicit Owner',
  });
  assert.equal(updated.owner, 'Explicit Owner', 'an explicit owner wins');
  assert.equal(updated.npcs[0].name, 'Explicit Owner', 'the explicit owner is applied to the primary NPC');
});

test('store updateShop rejects a non-array npcs patch', async () => {
  const store = createStore(createFakeDocAccess());
  const shop = await store.createShop({ name: 'S', locationId: 'loc1' });
  await assert.rejects(
    () => store.updateShop(shop.id, { npcs: 'not-an-array' }),
    /shop\.npcs must be an array/
  );
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

test('store files a new ledger journal into the Pending folder and moves it on commit', async () => {
  const da = createFakeDocAccessWithOrganizer();
  const store = createStore(da);
  const result = await store.createLedger({
    key: 'u1:r1',
    status: 'pending',
    payloadHash: 'abc',
    quantity: 1,
    unitPrice: 5,
    totalPrice: 5,
  });
  assert.equal(result.created, true);
  const rec = result.record;

  const doc = Array.from(da.docs.values()).find(
    (d) => d.flags?.market?.kind === 'ledger' && d.flags?.market?.record?.id === rec.id
  );
  // The store launches the folder arrange best-effort (never awaited), so the test
  // harness must flush the organizer before asserting the folder placement.
  await da.flushOrganizer();
  const root = folderByRole(da.folders, LEDGER_FOLDER_ROLES.root);
  const pending = folderByRole(da.folders, LEDGER_FOLDER_ROLES.pending);
  assert.ok(root, 'root folder created');
  assert.ok(pending, 'pending child folder created');
  assert.equal(doc._source.folder, pending.id, 'journal filed into Pending');

  const updated = await store.updateLedger(rec.id, { status: 'committed' });
  assert.equal(updated.status, 'committed');
  await da.flushOrganizer();
  const success = folderByRole(da.folders, LEDGER_FOLDER_ROLES.success);
  assert.ok(success, 'success child folder created');
  assert.equal(doc._source.folder, success.id, 'journal moved into Success on commit');
});

test('a ledger folder-create error never fails the ledger record or status', async () => {
  const da = createFakeDocAccessWithOrganizer();
  // Root creation succeeds, child creation throws -> the journal stays unfiled.
  da.FolderClass.create = async (data) => {
    if (data.flags?.market?.ledgerRole !== LEDGER_FOLDER_ROLES.root) {
      throw new Error('folder boom');
    }
    const folder = {
      id: 'folder-root',
      name: data.name,
      type: data.type,
      folder: data.folder ?? null,
      flags: data.flags,
    };
    da.folders.push(folder);
    return folder;
  };
  const store = createStore(da);
  const result = await store.createLedger({
    key: 'u1:r2',
    status: 'pending',
    payloadHash: 'abc',
    quantity: 1,
    unitPrice: 5,
    totalPrice: 5,
  });
  assert.equal(result.created, true, 'record persisted despite folder failure');
  assert.equal(result.record.status, 'pending');
  // Let the best-effort arrange settle (it swallows the child create error).
  await da.flushOrganizer();
  const doc = Array.from(da.docs.values()).find(
    (d) => d.flags?.market?.kind === 'ledger' && d.flags?.market?.record?.id === result.record.id
  );
  assert.equal(doc._source.folder, null, 'journal left unfiled');
});

test('a journal move failure during update keeps the committed status persisted', async () => {
  const da = createFakeDocAccessWithOrganizer();
  const store = createStore(da);
  const result = await store.createLedger({
    key: 'u1:r3',
    status: 'pending',
    payloadHash: 'abc',
    quantity: 1,
    unitPrice: 5,
    totalPrice: 5,
  });
  const doc = Array.from(da.docs.values()).find(
    (d) => d.flags?.market?.kind === 'ledger' && d.flags?.market?.record?.id === result.record.id
  );
  // The store launches the arrange best-effort (never awaited); flush it so the
  // initial Pending placement has settled before asserting.
  await da.flushOrganizer();
  const pendingFolder = folderByRole(da.folders, LEDGER_FOLDER_ROLES.pending);
  assert.equal(doc._source.folder, pendingFolder.id, 'initially placed in Pending');

  // The flags write still succeeds, but the organizer's doc.update throws.
  doc.failUpdate = true;
  const updated = await store.updateLedger(result.record.id, { status: 'committed' });
  assert.equal(updated.status, 'committed', 'status update is committed');
  // The organizer cannot move the journal now: it stays in Pending.
  await da.flushOrganizer();
  assert.equal(doc._source.folder, pendingFolder.id, 'move failed, stays in Pending');
  assert.equal(doc.flags?.market?.record?.status, 'committed', 'flags record is committed');
});

test('store ledger-folder sweep moves pending, skips invalid/already-filed, and leaves non-ledger untouched', async () => {
  const da = createFakeDocAccessWithOrganizer();
  const store = createStore(da);
  // Pre-seed root + success folders so an already-filed ledger is not moved.
  const root = await da.FolderClass.create({
    name: 'Market Ledgers',
    type: 'JournalEntry',
    folder: null,
    flags: { market: { ledgerRole: LEDGER_FOLDER_ROLES.root } },
  });
  const success = await da.FolderClass.create({
    name: 'Success',
    type: 'JournalEntry',
    folder: root.id,
    flags: { market: { ledgerRole: LEDGER_FOLDER_ROLES.success } },
  });
  const mk = (kind, status, folder = null) =>
    da.makeDoc({
      name: kind,
      flags: { market: { schemaVersion: 1, kind, record: { id: makeId(), status } } },
      folder,
    });
  const committed = mk('ledger', 'committed', success.id); // already filed -> skipped
  const pending = mk('ledger', 'pending'); // moved
  const invalid = mk('ledger', 'bogus'); // invalid status -> skipped
  const shop = mk('shop', null); // non-ledger -> skipped
  const failed = mk('ledger', 'failed', null); // moved

  const summary = await store.organizeLedgerJournals({ isActiveGM: () => true });
  assert.equal(summary.status, 'ok');
  assert.equal(summary.moved, 2, 'pending + failed moved');
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 3, 'already-filed + invalid + non-ledger skipped');

  const pendingFolder = folderByRole(da.folders, LEDGER_FOLDER_ROLES.pending);
  const failureFolder = folderByRole(da.folders, LEDGER_FOLDER_ROLES.failure);
  assert.equal(pending._source.folder, pendingFolder.id);
  assert.equal(failed._source.folder, failureFolder.id);
  assert.equal(committed._source.folder, success.id, 'already-filed ledger untouched');
  assert.equal(shop._source.folder, null, 'non-ledger journal untouched');
});

test('store ledger-folder sweep is an idle no-op for a non-active GM', async () => {
  // The organizer's own active-GM gate is also false, so even the create path
  // no-ops and no folders are ever created.
  const da = createFakeDocAccessWithOrganizer({ isActiveGM: () => false });
  const store = createStore(da);
  await store.createLedger({
    key: 'u1:r4',
    status: 'pending',
    payloadHash: 'abc',
    quantity: 1,
    unitPrice: 5,
    totalPrice: 5,
  });
  assert.equal(da.folders.length, 0, 'create no-ops for a non-active GM');
  const summary = await store.organizeLedgerJournals({ isActiveGM: () => false });
  assert.deepEqual(summary, { status: 'idle', moved: 0, failed: 0, skipped: 0 });
  assert.equal(da.folders.length, 0, 'no folders created while not the active GM');
});

test('store ledger-folder sweep counts a folder-move throw as failed, not a false success', async () => {
  const da = createFakeDocAccessWithOrganizer();
  const store = createStore(da);
  const doc = da.makeDoc({
    name: 'L',
    flags: { market: { schemaVersion: 1, kind: 'ledger', record: { id: makeId(), status: 'pending' } } },
    folder: null,
  });
  doc.failUpdate = true; // the organizer's doc.update throws
  const summary = await store.organizeLedgerJournals({ isActiveGM: () => true });
  assert.equal(summary.status, 'ok');
  assert.equal(summary.moved, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 0);
});

test('store ledger-folder sweep recovers a legacy (schema-v0) ledger journal', async () => {
  const da = createFakeDocAccessWithOrganizer();
  const store = createStore(da);
  // A legacy schema-v0 ledger journal: kind === 'ledger', no schemaVersion.
  const legacy = da.makeDoc({
    name: 'Legacy ledger',
    flags: { market: { kind: 'ledger', record: { id: makeId(), status: 'failed' } } },
    folder: null,
  });
  const summary = await store.organizeLedgerJournals({ isActiveGM: () => true });
  assert.equal(summary.status, 'ok');
  assert.equal(summary.moved, 1, 'legacy journal filed');
  assert.equal(summary.skipped, 0);
  const failureFolder = folderByRole(da.folders, LEDGER_FOLDER_ROLES.failure);
  assert.equal(legacy._source.folder, failureFolder.id);
});

test('createLedger and updateLedger resolve without awaiting a pending folder organizer', async () => {
  const da = createFakeDocAccessWithOrganizer();
  // The organizer's placement never settles; the store must NOT await it.
  da.organizeLedgerJournal = () => new Promise(() => {});
  const store = createStore(da);

  const created = await store.createLedger({
    key: 'u:defer',
    status: 'pending',
    payloadHash: 'abc',
    quantity: 1,
    unitPrice: 5,
    totalPrice: 5,
  });
  assert.equal(created.created, true);
  assert.equal(created.record.status, 'pending', 'status is correct despite the pending organizer');

  const updated = await store.updateLedger(created.record.id, { status: 'committed' });
  assert.equal(updated.status, 'committed', 'update resolves and persists the committed status');

  const doc = Array.from(da.docs.values()).find(
    (d) => d.flags?.market?.kind === 'ledger' && d.flags?.market?.record?.id === created.record.id
  );
  assert.ok(doc, 'ledger journal persisted (still owned by the store)');
  assert.equal(doc.flags?.market?.record?.status, 'committed', 'flags reflect the committed status');
});

test('default store createLedger stays GM-owned while the folder arrange is pending', async () => {
  const created = [];
  const oldGE = globalThis.game;
  const oldJE = globalThis.JournalEntry;
  globalThis.JournalEntry = {
    create: async (data) => {
      created.push(data);
      return {
        id: 'j1',
        name: data.name,
        flags: data.flags,
        ownership: data.ownership,
        _source: { folder: null },
        update() {
          return this;
        },
      };
    },
  };
  // The folder document-class create never settles, so the organizer cannot
  // complete. `createLedger` must still return immediately, untouched.
  const pendingFolder = {
    create: () => new Promise(() => {}),
  };
  globalThis.game = {
    journal: { documentClass: globalThis.JournalEntry, filter: () => [] },
    folders: { documentClass: pendingFolder, filter: () => [] },
    user: { isGM: true, id: 'gm1' },
    users: { activeGM: { id: 'gm1' } },
  };
  try {
    const res = await defaultStore.createLedger({
      key: 'u:rgm',
      status: 'pending',
      payloadHash: 'abc',
      quantity: 1,
      unitPrice: 1,
      totalPrice: 1,
    });
    assert.ok(res.record.id);
    assert.equal(res.record.status, 'pending', 'status correct while the folder op is pending');
    assert.equal(created[0].ownership?.default, 0, 'ledger journal stays GM-only');
  } finally {
    globalThis.game = oldGE;
    globalThis.JournalEntry = oldJE;
  }
});

test('default store ledger journal is created GM-only (ownership default 0)', async () => {
  const created = [];
  const oldGE = globalThis.game;
  const oldJE = globalThis.JournalEntry;
  globalThis.JournalEntry = {
    create: async (data) => {
      created.push(data);
      return {
        id: 'j1',
        name: data.name,
        flags: data.flags,
        ownership: data.ownership,
        _source: { folder: null },
        update() {
          return this;
        },
      };
    },
  };
  globalThis.game = {
    journal: { documentClass: globalThis.JournalEntry, filter: () => [] },
    folders: { documentClass: globalThis.JournalEntry, filter: () => [] },
    user: { isGM: true, id: 'gm1' },
    users: { activeGM: { id: 'gm1' } },
  };
  try {
    const res = await defaultStore.createLedger({
      key: 'u:r',
      status: 'pending',
      payloadHash: 'abc',
      quantity: 1,
      unitPrice: 1,
      totalPrice: 1,
    });
    assert.ok(res.record.id);
    assert.equal(created[0].ownership?.default, 0, 'ledger journal is GM-only');
  } finally {
    globalThis.game = oldGE;
    globalThis.JournalEntry = oldJE;
  }
});

test('default store fire-and-forget ledger folder task after game teardown fails closed without a TypeError', async () => {
  // The real-world race: a ledger journal is persisted while the Foundry `game`
  // global is live, and the store's best-effort folder arrange (launched
  // fire-and-forget, never awaited) settles only AFTER the runtime tears the
  // `game` global down - between ledger persistence and the scheduled background
  // task. By that point the organizer consults only its active-GM predicate, so
  // it must fail closed (return false) on an absent `game`, never throw a
  // TypeError, and leave the persisted journal record intact.
  const createdData = [];
  const createdDocs = [];
  const oldGE = globalThis.game;
  const oldJE = globalThis.JournalEntry;
  const oldFolder = globalThis.Folder;
  // A deferred create-gate we release only AFTER tearing `game` down. This keeps
  // the journal-creation microtask chain (which reads `game.journal`) running
  // while `game` is live, while forcing the fire-and-forget organize to settle
  // after the teardown - the exact interleaving that used to throw.
  let resolveCreate;
  const createGate = new Promise((resolve) => {
    resolveCreate = resolve;
  });
  globalThis.JournalEntry = {
    create: async (data) => {
      createdData.push(data);
      const doc = {
        // Unique id so the organizer's per-journal queue is never shared with a
        // stale entry left by another default-store test.
        id: 'teardown-j1',
        name: data.name,
        flags: data.flags,
        ownership: data.ownership,
        _source: { folder: null },
        update() {
          return this;
        },
      };
      createdDocs.push(doc);
      return createGate.then(() => doc);
    },
  };
  globalThis.Folder = {
    create: async (data) => ({
      id: 'folder-teardown',
      name: data.name,
      type: data.type,
      folder: data.folder ?? null,
      flags: data.flags,
    }),
  };
  globalThis.game = {
    journal: { documentClass: globalThis.JournalEntry, filter: () => [] },
    folders: { documentClass: globalThis.Folder, filter: () => [] },
    user: { isGM: true, id: 'gm1' },
    users: { activeGM: { id: 'gm1' } },
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const resPromise = defaultStore.createLedger({
      key: 'u:teardown',
      status: 'pending',
      payloadHash: 'abc',
      quantity: 1,
      unitPrice: 1,
      totalPrice: 1,
    });
    // Let the microtask chain reach `createJournalEntry` (it reads `game.journal`
    // and then blocks on the deferred gate). The journal is now persisted while
    // `game` is still live, but the fire-and-forget organize has not run yet.
    await sleep(0);
    // Tear the `game` global down while the organize is still unscheduled.
    globalThis.game = oldGE;
    // Release the journal create: insertRecord resumes and schedules the
    // fire-and-forget organize, which now settles AFTER the teardown.
    resolveCreate();
    const res = await resPromise;
    // Give the best-effort organize a chance to settle after the teardown.
    await sleep(0);
    assert.equal(res.created, true, 'ledger record persisted');
    assert.equal(res.record.status, 'pending', 'journal record remains intact after teardown');
    assert.equal(createdData.length, 1, 'a single GM-only journal was persisted');
    assert.equal(createdData[0].ownership?.default, 0, 'journal stays GM-only');
    assert.equal(
      createdDocs[0]._source.folder,
      null,
      'journal left unfiled when the organizer fails closed'
    );
    const thrown = warnings.filter((w) =>
      /TypeError|ReferenceError|is not a function|Cannot read/i.test(String(w.join(' ')))
    );
    assert.equal(
      thrown.length,
      0,
      `no TypeError/throw warned after game teardown (got: ${warnings.map((w) => w.join(' ')).join(' | ')})`
    );
  } finally {
    console.warn = originalWarn;
    globalThis.game = oldGE;
    globalThis.JournalEntry = oldJE;
    globalThis.Folder = oldFolder;
  }
});

// ---------------------------------------------------------------- M3 social catalog

function makeCatalogMessage(request) {
  return {
    flags: { market: { type: 'request', request: { type: 'catalog', ...request } } },
  };
}

function makeSocialCatalogCtx({
  store,
  getActor,
  actorOwnedBy = () => true,
  getSocial,
  commerce = {},
}) {
  const responses = [];
  return {
    activeGMId: () => 'gm1',
    currentUserId: () => 'gm1',
    gmIds: () => ['gm1'],
    respond: async (data) => responses.push(data.flags.market.response),
    commerce,
    store,
    getActor,
    actorOwnedBy,
    getSocial,
    responses,
  };
}

test('catalog with an owned actor personalizes price, breakdown and relationship only', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    social: { primaryPersonality: 'greedy', shopMarkupBps: 500 },
    inventory: [
      normalizeInventoryEntry({
        id: 'e1',
        itemUuid: 'Compendium.a.Item.x',
        name: 'Potion',
        price: 100,
        quantity: 5,
        visible: true,
      }),
    ],
  });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({
    store,
    getActor: async (id) => (id === 'a1' ? { uuid: 'Actor.a1' } : null),
    getSocial: async () => ({
      score: 50,
      band: { title: 'Liked' },
      individual: 50,
      party: 0,
      partyId: 'party1',
    }),
  });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat1' }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'catalog');
  assert.equal(data.actorId, 'a1', 'correlation echoes the actorId');
  assert.ok(data.relationship, 'a sanitized relationship is present');
  assert.equal(data.relationship.score, 50);
  assert.equal(data.relationship.title, 'Liked');
  assert.equal(data.relationship.individual, 50);
  assert.equal(data.relationship.party, 0);
  assert.equal('partyId' in data.relationship, false, 'partyId is always omitted');
  assert.equal(data.inventory.length, 1);
  const entry = data.inventory[0];
  assert.ok('basePrice' in entry && 'priceBreakdown' in entry && 'canBuy' in entry);
  assert.equal(entry.basePrice, 100);
  assert.equal(entry.canBuy, true);
  assert.ok(entry.price != null, 'personalized unit price present');
  assert.ok(entry.priceBreakdown.band.title, 'breakdown carries the band title');
  assert.equal(entry.priceBreakdown.quantity, 1);
  // No raw reputation record or private social config leaks into the entry.
  assert.ok(!('itemUuid' in entry), 'itemUuid still omitted');
  assert.ok(!('snapshot' in entry), 'snapshot still omitted');
  assert.ok(!('social' in entry), 'private shop social config omitted');
  assert.deepEqual(data.merchants, []);
});

test('personalized catalog exposes only still-valid GM-approved items for the owned actor', async () => {
  const i1 = {
    id: 'i1',
    name: 'Sword',
    system: { quantity: 1 },
    toObject() {
      return { _id: 'i1', name: 'Sword', type: 'weapon', system: { quantity: 1 }, flags: {} };
    },
  };
  const i2 = {
    id: 'i2',
    name: 'Ring',
    system: {},
    toObject() {
      return { _id: 'i2', name: 'Ring', type: 'gear', system: {}, flags: {} };
    },
  };
  const fingerprint = fingerprintItem(i1);
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    inventory: [],
    commerce: {
      valuations: [
        { id: 'v1', actorUuid: 'Actor.a1', itemId: 'i1', amount: 100, fingerprint },
      ],
    },
  });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({
    store,
    getActor: async () => ({ uuid: 'Actor.a1', items: [i1, i2] }),
    getSocial: async () => ({ score: 0, individual: 0, party: 0 }),
  });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat-approve-1' }),
    'user1',
    ctx
  );
  assert.deepEqual(
    data.shop.approvedItems,
    [{ itemId: 'i1', amount: 100 }],
    'only the matching, fingerprint-valid item is approved'
  );
  // The raw private valuation fields never leak (no `valuations`, no `actorUuid`,
  // no `fingerprint`, no `id` on the projected allowlist entries).
  assert.ok(!('valuations' in data.shop), 'raw commerce.valuations never leaks');
  assert.equal(Object.keys(data.shop.approvedItems[0]).join(','), 'itemId,amount');
});

test('a catalog approval is dropped for a different actor or a mutated item', async () => {
  const i1 = {
    id: 'i1',
    name: 'Sword',
    system: { quantity: 1 },
    toObject() {
      return { _id: 'i1', name: 'Sword', type: 'weapon', system: { quantity: 1 }, flags: {} };
    },
  };
  // A mutated version of the SAME item (a player changed the system price) whose
  // fingerprint no longer matches the approval recorded at approve time.
  const mutated = {
    id: 'i1',
    name: 'Sword',
    system: { quantity: 1 },
    toObject() {
      return {
        _id: 'i1',
        name: 'Sword',
        type: 'weapon',
        system: { quantity: 1, price: 9999 },
        flags: {},
      };
    },
  };
  const fingerprint = fingerprintItem(i1);
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    inventory: [],
    commerce: {
      valuations: [
        { id: 'v1', actorUuid: 'Actor.a1', itemId: 'i1', amount: 100, fingerprint },
        // A valuation for a DIFFERENT actor; the requester owns another actor.
        { id: 'v2', actorUuid: 'Actor.a2', itemId: 'i2', amount: 50, fingerprint },
      ],
    },
  });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({
    store,
    getActor: async () => ({ uuid: 'Actor.a1', items: [mutated] }),
    getSocial: async () => ({ score: 0, individual: 0, party: 0 }),
  });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat-approve-2' }),
    'user1',
    ctx
  );
  assert.deepEqual(
    data.shop.approvedItems,
    [],
    'a mutated item and an other-actor valuation are both dropped'
  );
});

test('a base (non-personalized) catalog carries an empty approvedItems allowlist', async () => {
  const i1 = {
    id: 'i1',
    name: 'Sword',
    toObject() {
      return { _id: 'i1', name: 'Sword', type: 'weapon', flags: {} };
    },
  };
  const fingerprint = fingerprintItem(i1);
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    inventory: [],
    commerce: {
      valuations: [
        { id: 'v1', actorUuid: 'Actor.a1', itemId: 'i1', amount: 100, fingerprint },
      ],
    },
  });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({ store });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', requestId: 'cat-approve-base' }),
    'user1',
    ctx
  );
  assert.deepEqual(data.shop.approvedItems, [], 'base catalog exposes no approvals');
});

test('catalog with an unowned actor returns a correlated actor-not-owned error', async () => {
  const shop = normalizeShop({ id: 'shop1', name: 'S', locationId: 'loc1', inventory: [] });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({
    store,
    getActor: async () => ({ uuid: 'Actor.a1' }),
    actorOwnedBy: () => false,
    getSocial: async () => ({ score: 0 }),
  });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat2' }),
    'user2',
    ctx
  );
  assert.equal(data.type, 'error');
  assert.equal(data.error, 'actor-not-owned');
  assert.equal(data.actorId, 'a1');
  assert.equal(data.requestId, 'cat2');
});

test('personalized catalog omits hidden entries and never leaks a raw rep record', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    inventory: [
      normalizeInventoryEntry({
        id: 'e1',
        itemUuid: 'Compendium.a.Item.x',
        name: 'Visible',
        price: 100,
        quantity: 5,
        visible: true,
      }),
      normalizeInventoryEntry({
        id: 'e2',
        itemUuid: 'Compendium.a.Item.y',
        name: 'Hidden',
        price: 50,
        quantity: 1,
        visible: false,
      }),
    ],
  });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({
    store,
    getActor: async () => ({ uuid: 'Actor.a1' }),
    getSocial: async () => ({
      score: 0,
      band: { title: 'Neutral' },
      individual: 0,
      party: 0,
      partyId: '',
    }),
  });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat3' }),
    'user1',
    ctx
  );
  assert.equal(data.inventory.length, 1, 'hidden entry omitted from the personalized catalog');
  assert.equal(data.inventory[0].name, 'Visible');
});

test('a legacy shop still projects a base catalog and the legacy owner as a merchant', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'Legacy',
    locationId: 'loc1',
    owner: 'Bob',
    open: true,
    inventory: [
      normalizeInventoryEntry({
        id: 'e1',
        itemUuid: 'Compendium.a.Item.x',
        name: 'A',
        price: 10,
        quantity: 3,
        visible: true,
      }),
    ],
  });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({ store, getActor: async () => null });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', requestId: 'cat4' }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'catalog');
  const entry = data.inventory[0];
  // No actor => base catalog: the base price is authoritative, no per-actor fields.
  assert.equal(entry.price, 10);
  assert.ok(!('priceBreakdown' in entry));
  assert.ok(!('basePrice' in entry));
  assert.ok(!('canBuy' in entry));
  assert.ok(!('relationship' in data), 'no relationship without an actor');
  // The legacy owner migrates to the primary NPC which is projected publicly.
  assert.equal(data.merchants.length, 1);
  assert.equal(data.merchants[0].name, 'Bob');
  assert.equal(typeof data.merchants[0].personality.label, 'string');
  assert.ok(!('actorUuid' in data.merchants[0]), 'actorUuid never leaked');
  assert.ok(!('social' in data.merchants[0]));
});

test('a personalized catalog quote failure fails closed as a correlated server-error', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    inventory: [normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'A', price: 10, quantity: 1 })],
  });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({
    store,
    getActor: async () => ({ uuid: 'Actor.a1' }),
    getSocial: async () => ({ individual: 0, party: 0 }),
    // Inject a bad quoteSocial by supplying a shop whose social markup pushes
    // the total over a safe integer, so quoteSocial throws.
  });
  shop.social.shopMarkupBps = 50000;
  shop.inventory[0].price = Number.MAX_SAFE_INTEGER;
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat5' }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'error');
  assert.equal(data.error, 'server-error');
  assert.equal(data.requestId, 'cat5');
  assert.equal(data.actorId, 'a1');
});

// ------------------------------------------------------------- ledger priceBreakdown

test('normalizeLedgerRecord preserves a validated priceBreakdown and rejects a raw one', () => {
  const ok = normalizeLedgerRecord({
    key: 'u1:r1',
    status: 'pending',
    quantity: 2,
    unitPrice: 85,
    totalPrice: 170,
    priceBreakdown: {
      quantity: 2,
      unitBase: 100,
      baseTotal: 200,
      shopBps: 0,
      personalityBps: 0,
      reputationBps: -1500,
      haggleBps: 0,
      adjustmentBps: -1500,
      unitPrice: 85,
      total: 170,
      band: { title: 'Loved', threshold: 100 },
      refused: false,
    },
  });
  assert.deepEqual(ok.priceBreakdown, {
    quantity: 2,
    unitBase: 100,
    baseTotal: 200,
    shopBps: 0,
    personalityBps: 0,
    reputationBps: -1500,
    haggleBps: 0,
    adjustmentBps: -1500,
    unitPrice: 85,
    total: 170,
    band: { title: 'Loved', threshold: 100 },
    refused: false,
  });

  // A raw arbitrary breakdown is rejected (throws) instead of being persisted.
  assert.throws(
    () =>
      normalizeLedgerRecord({
        key: 'u1:r2',
        status: 'pending',
        quantity: 1,
        unitPrice: 5,
        totalPrice: 5,
        priceBreakdown: { unitPrice: 'fifty', quantity: 1, total: 5 },
      }),
    /safe integer/
  );
  assert.throws(
    () =>
      normalizeLedgerRecord({
        key: 'u1:r3',
        status: 'pending',
        quantity: 1,
        unitPrice: 5,
        totalPrice: 5,
        priceBreakdown: { quantity: 1, unitPrice: 5, total: 5, band: { title: '' } },
      }),
    /must not be empty/
  );

  // A missing/legacy breakdown normalizes to null.
  const legacy = normalizeLedgerRecord({ key: 'u1:r4', status: 'pending', quantity: 1, unitPrice: 5, totalPrice: 5 });
  assert.equal(legacy.priceBreakdown, null);
});

test('normalizePriceBreakdown rejects a float, a negative total and a non-boolean refused', () => {
  assert.throws(() => normalizePriceBreakdown({ quantity: 1, unitPrice: 1.5, total: 1 }), /safe integer/);
  assert.throws(() => normalizePriceBreakdown({ quantity: 1, unitPrice: 5, total: -1 }), />= 0/);
  assert.throws(() => normalizePriceBreakdown({ quantity: 1, unitPrice: 5, total: 5, refused: 'yes' }), /boolean/);
  assert.equal(normalizePriceBreakdown(null), null);
  assert.equal(normalizePriceBreakdown(undefined), null);
});

test('normalizePriceBreakdown validates the combined adjustment across the full sum range', () => {
  // The combined adjustment is the additive sum of up to four [-9000, 50000]
  // components, so it spans [-36000, 200000], not the per-component [-9000, 50000].
  const low = normalizePriceBreakdown({ quantity: 1, unitBase: 100, baseTotal: 100, unitPrice: 1, total: 1, adjustmentBps: -36000 });
  assert.equal(low.adjustmentBps, -36000);
  const high = normalizePriceBreakdown({ quantity: 1, unitBase: 100, baseTotal: 100, unitPrice: 615, total: 615, adjustmentBps: 200000 });
  assert.equal(high.adjustmentBps, 200000);
  // A combined adjustment outside the envelope is rejected; the individual
  // component fields still use the per-component bound (unchanged).
  assert.throws(
    () => normalizePriceBreakdown({ quantity: 1, unitPrice: 1, total: 1, adjustmentBps: -36001 }),
    /between -36000 and 200000/
  );
  assert.throws(
    () => normalizePriceBreakdown({ quantity: 1, unitPrice: 1, total: 1, adjustmentBps: 200001 }),
    /between -36000 and 200000/
  );
  const components = normalizePriceBreakdown({
    quantity: 1,
    unitBase: 100,
    baseTotal: 100,
    shopBps: 50000,
    personalityBps: 1500,
    reputationBps: 4000,
    haggleBps: 50000,
    adjustmentBps: 105500,
    unitPrice: 1155,
    total: 1155,
  });
  assert.equal(components.adjustmentBps, 105500, 'the raw combined sum is retained');
  assert.equal(components.shopBps, 50000, 'a max per-component shop bps is accepted');
});

// ------------------------------------------------------------- M3 social purchase

test('a good reputation discounts the charged total and persists an exact priceBreakdown', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce({
    ...makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() }),
    // Loved reputation (-1500bps) on a neutral shop: unit price 100 -> 85.
    getSocial: async () => ({ individual: 100, party: 0 }),
  });

  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'committed');
  assert.equal(result.unitPrice, 85, 'charged unit price comes from quoteSocial');
  assert.equal(result.total, 170, 'charged total comes from quoteSocial');
  assert.ok(result.priceBreakdown, 'priceBreakdown returned on the result');
  assert.equal(result.priceBreakdown.unitPrice, 85);
  assert.equal(result.priceBreakdown.total, 170);
  assert.equal(result.priceBreakdown.band.title, 'Loved');
  assert.equal(result.priceBreakdown.reputationBps, -1500);
  assert.equal(result.priceBreakdown.refused, false);

  const ledger = getLedgerForUser(store, 'user1:');
  assert.equal(ledger.status, 'committed');
  assert.equal(ledger.unitPrice, 85);
  assert.equal(ledger.totalPrice, 170);
  assert.deepEqual(ledger.priceBreakdown, result.priceBreakdown, 'ledger persists the validated breakdown');
  assert.deepEqual(ledger.outcome.priceBreakdown, result.priceBreakdown, 'outcome also persists the breakdown');
  assert.equal(actor.items.length, 1);
});

test('a Hated reputation refuses with service-refused before any debit', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce({
    ...makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() }),
    getSocial: async () => ({ individual: -100, party: 0 }),
  });

  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'service-refused');
  assert.equal(actor.system.currency.gp, 5, 'no debit on a refusal');
  assert.equal(actor.items.length, 0, 'no delivery on a refusal');

  const ledger = getLedgerForUser(store, 'user1:');
  assert.equal(ledger.status, 'failed');
  assert.equal(ledger.error, 'service-refused');
  assert.ok(ledger.priceBreakdown, 'the refusal persists the Hated breakdown');
  assert.equal(ledger.priceBreakdown.band.title, 'Hated');
  assert.equal(ledger.priceBreakdown.refused, true);
});

test('purchase never trusts a stale catalog price: it re-quotes from live reputation', async () => {
  // The storefront may have shown the base price (200 for 2 @ 100). The purchase
  // must charge the server-quoted discounted total instead, proving it re-reads
  // the shop + reputation rather than trusting any client-side price.
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce({
    ...makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() }),
    getSocial: async () => ({ individual: 100, party: 0 }),
  });

  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.total, 170, 'server-quoted total (85/unit) beats the stale base total of 200');
  assert.equal(result.totalPrice ?? result.total, 170);
});

test('a legacy commerce (no getSocial) keeps the original integer quote and a null breakdown', async () => {
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
  assert.equal(result.total, 200, 'original integer quote path retained');
  assert.equal(result.priceBreakdown, null, 'no social breakdown on the legacy path');
  const ledger = getLedgerForUser(store, 'user1:');
  assert.equal(ledger.totalPrice, 200);
  assert.equal(ledger.priceBreakdown, null);
});

// -------------------------------------------------------- M4 trading/presence

test('a shop outside its declared hours rejects the sale before any charge', async () => {
  const store = createMockStore();
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    automation: {
      hours: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], openMinute: 540, closeMinute: 1020 },
    },
    inventory: [
      normalizeInventoryEntry({
        id: 'entry1',
        itemUuid: 'u1',
        name: 'Potion',
        price: 100,
        quantity: 10,
      }),
    ],
  });
  store._shops.set('shop1', shop);
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce({
    ...makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() }),
    getWorldTime: () => 64800, // Mon 18:00, past the 17:00 close
  });
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'shop-closed');
  assert.equal(actor.system.currency.gp, 5, 'no debit before close');
  assert.equal(actor.items.length, 0, 'no delivery before close');
  const ledger = getLedgerForUser(store, 'user1:');
  assert.equal(ledger.status, 'failed');
  assert.equal(ledger.error, 'shop-closed');
});

test('a manually open shop whose travelling merchant has not arrived rejects before charge', async () => {
  const store = createMockStore();
  const shop = normalizeShop({
    id: 'shop1',
    name: 'Traveller',
    locationId: 'base',
    open: true,
    automation: {
      travel: {
        enabled: true,
        locationIds: ['a', 'b'],
        anchorTime: 1000,
        intervalSeconds: 3600,
        lastCycle: -1,
      },
    },
    inventory: [
      normalizeInventoryEntry({
        id: 'entry1',
        itemUuid: 'u1',
        name: 'Potion',
        price: 100,
        quantity: 10,
      }),
    ],
  });
  store._shops.set('shop1', shop);
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce({
    ...makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() }),
    getWorldTime: () => 500, // before the travel anchor => not arrived
  });
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'shop-closed');
  assert.equal(actor.system.currency.gp, 5, 'no debit before arrival');
  assert.equal(actor.items.length, 0, 'no delivery before arrival');
});

test('a shop trading normally at world time still commits (getWorldTime path is not over-restrictive)', async () => {
  const store = createMockStore();
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    automation: {
      hours: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], openMinute: 540, closeMinute: 1020 },
    },
    inventory: [
      normalizeInventoryEntry({
        id: 'entry1',
        itemUuid: 'u1',
        name: 'Potion',
        price: 100,
        quantity: 10,
      }),
    ],
  });
  store._shops.set('shop1', shop);
  const actor = createMockActor({ currency: { gp: 5 } });
  const commerce = createCommerce({
    ...makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() }),
    getWorldTime: () => 36000, // Mon 10:00, inside the 09:00-17:00 window
  });
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'committed');
  assert.equal(result.total, 100);
});

test('an invalid getWorldTime fails the purchase closed before any debit', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  const badTimes = [
    Number.NaN,
    undefined,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  for (const bad of badTimes) {
    const commerce = createCommerce({
      ...makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() }),
      getWorldTime: () => bad,
    });
    const result = await commerce.purchase(
      { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 1, userId: 'user1' },
      'gm1'
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'invalid-world-time');
    assert.equal(actor.system.currency.gp, 5, 'no debit for an invalid world time');
    assert.equal(actor.items.length, 0, 'no delivery for an invalid world time');
    const shop = store._shops.get('shop1');
    assert.equal(shop.inventory[0].quantity, 10, 'stock unchanged for an invalid world time');
  }
});

// ---------------------------------------------- M4 public catalog + stockView

test('base catalog projects a non-exact entry without leaking the true count', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Low', price: 10, quantity: 3, stockVisibility: 'low' }),
      normalizeInventoryEntry({ id: 'e2', itemUuid: 'u2', name: 'Hidden', price: 20, quantity: 0, stockVisibility: 'hidden' }),
      normalizeInventoryEntry({ id: 'e3', itemUuid: 'u3', name: 'Exact', price: 30, quantity: 5, stockVisibility: 'exact' }),
    ],
  });
  const catalog = buildCatalog(shop, { worldTime: 3600 });
  const byId = Object.fromEntries(catalog.inventory.map((e) => [e.id, e]));
  const low = byId.e1;
  assert.equal(low.quantity, null, 'low entry hides the exact count');
  assert.equal(low.stockLabel, 'Low stock');
  assert.equal(low.available, true);
  assert.ok(!('stockVisibility' in low), 'stockVisibility not leaked');
  assert.ok(!('restock' in low), 'restock not leaked');
  const hidden = byId.e2;
  assert.equal(hidden.quantity, null, 'hidden entry hides the count at zero stock');
  assert.equal(hidden.stockLabel, 'Out of stock');
  assert.equal(hidden.available, false);
  const exact = byId.e3;
  assert.equal(exact.quantity, 5, 'exact entry keeps the true count');
  assert.equal(exact.available, true);
});

test('personalized catalog projects non-exact stock without leaking the count and refuses zero stock', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Low', price: 10, quantity: 3, stockVisibility: 'low', visible: true }),
      normalizeInventoryEntry({ id: 'e2', itemUuid: 'u2', name: 'Hidden', price: 20, quantity: 0, stockVisibility: 'hidden', visible: true }),
      normalizeInventoryEntry({ id: 'e3', itemUuid: 'u3', name: 'Exact', price: 30, quantity: 5, stockVisibility: 'exact', visible: true }),
    ],
  });
  const store = { findShop: async () => shop };
  const ctx = {
    ...makeSocialCatalogCtx({
      store,
      getActor: async () => ({ uuid: 'Actor.a1' }),
      getSocial: async () => ({ score: 0, band: { title: 'Neutral' }, individual: 0, party: 0, partyId: '' }),
    }),
    worldTime: () => 3600,
  };
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat-m4' }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'catalog');
  const byId = Object.fromEntries(data.inventory.map((e) => [e.id, e]));
  const low = byId.e1;
  assert.equal(low.quantity, null, 'low entry hides the count');
  assert.equal(low.available, true);
  assert.equal(low.canBuy, true, 'in-stock low entry is buyable');
  const hidden = byId.e2;
  assert.equal(hidden.quantity, null, 'hidden entry hides the count at zero stock');
  assert.equal(hidden.available, false);
  assert.equal(hidden.canBuy, false, 'zero-stock entry is not buyable');
  const exact = byId.e3;
  assert.equal(exact.quantity, 5, 'exact entry keeps the true count');
  assert.ok(!('stockVisibility' in low), 'stockVisibility not leaked');
  assert.ok(!('restock' in low), 'restock not leaked');
});

test('catalog only exposes visible active market events, sanitized', () => {
  const worldTime = 5000;
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    automation: {
      events: [
        { id: 'ev1', title: 'Sale', description: '20% off', startAt: 4000, endAt: 6000, visible: true },
        { id: 'ev2', title: 'Hidden event', description: 'secret', startAt: 4500, endAt: 5500, visible: false },
        { id: 'ev3', title: 'Future', description: 'later', startAt: 8000, endAt: 9000, visible: true },
      ],
    },
    inventory: [],
  });
  const catalog = buildCatalog(shop, { worldTime });
  assert.deepEqual(catalog.shop.marketEvents, [
    { id: 'ev1', title: 'Sale', description: '20% off' },
  ]);
});

test('catalog without a world time keeps legacy open/location and an empty marketEvents', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    automation: {
      hours: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], openMinute: 540, closeMinute: 1020 },
      events: [{ id: 'ev1', title: 'Sale', description: 'x', startAt: 0, endAt: 1000, visible: true }],
    },
    inventory: [],
  });
  const catalog = buildCatalog(shop);
  assert.equal(catalog.shop.open, true, 'legacy open preserved without a time');
  assert.equal(catalog.shop.locationId, 'loc1', 'legacy location preserved without a time');
  assert.deepEqual(catalog.shop.marketEvents, [], 'no time => no market events');
  assert.ok(!('closedReason' in catalog.shop), 'no closedReason without a time');
});

test('catalog with a present-but-invalid ctx.worldTime fails closed as a correlated server-error', async () => {
  const shop = normalizeShop({ id: 'shop1', name: 'S', locationId: 'loc1', open: true, inventory: [] });
  const store = { findShop: async () => shop };
  const badTimes = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    undefined,
  ];
  for (const bad of badTimes) {
    const ctx = makeSocialCatalogCtx({ store });
    ctx.worldTime = () => bad;
    const data = await handleMarketChatMessage(
      makeCatalogMessage({ shopId: 'shop1', requestId: 'cat-bad-time' }),
      'user1',
      ctx
    );
    assert.equal(data.type, 'error');
    assert.equal(data.error, 'server-error');
    assert.equal(data.requestId, 'cat-bad-time', 'correlation echoes the request id');
    assert.equal(data.shopId, 'shop1', 'correlation echoes the shop id');
    assert.ok(!('inventory' in data), 'no catalog is projected on an invalid time');
    assert.ok(!('shop' in data), 'no shop projection is sent on an invalid time');
  }
});

test('public market events project only a validated scalar string id', () => {
  // An unnormalized fixture whose event ids include an object and a control char
  // must project a safe scalar id, never `[object Object]`.
  const raw = {
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    automation: {
      events: [
        { id: { nested: 'bad' }, title: 'A', description: 'x', startAt: 0, endAt: 100, visible: true },
        { id: 'bad\nid', title: 'C', description: 'z', startAt: 0, endAt: 100, visible: true },
        { id: 'ev-good', title: 'B', description: 'y', startAt: 0, endAt: 100, visible: true },
      ],
    },
    inventory: [],
  };
  const catalog = buildCatalog(raw, { worldTime: 50 });
  assert.deepEqual(catalog.shop.marketEvents, [
    { id: '', title: 'A', description: 'x' },
    { id: '', title: 'C', description: 'z' },
    { id: 'ev-good', title: 'B', description: 'y' },
  ]);
});

// ---------------------------------------------- M4 public catalog location name

test('catalog resolves a travel-active shop locationName from the projected locationId', () => {
  const worldTime = 5000;
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'base',
    open: true,
    inventory: [],
    automation: {
      travel: { enabled: true, locationIds: ['a', 'b'], anchorTime: 0, intervalSeconds: 3600, lastCycle: 0 },
    },
  });
  const locations = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta' },
  ];
  const catalog = buildCatalog(shop, { worldTime, locations });
  assert.equal(catalog.shop.locationId, 'b', 'travel rotation is projected');
  assert.equal(catalog.shop.locationName, 'Beta', 'safe name resolved for the projected location');
  // Only the single resolved string is exposed, never the location list or the
  // private travel config.
  assert.ok(!('locations' in catalog.shop), 'the location list is never exposed');
  assert.ok(!('travel' in catalog.shop), 'travel config is never exposed');
});

test('catalog bounds locationName to 100 characters', () => {
  const worldTime = 5000;
  const long = 'x'.repeat(250);
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'base',
    open: true,
    inventory: [],
    automation: {
      travel: { enabled: true, locationIds: ['a', 'b'], anchorTime: 0, intervalSeconds: 3600, lastCycle: 0 },
    },
  });
  // At worldTime 5000 with a 3600 interval the projected cycle is 1, which rotates
  // to 'b'. Bound its name to 100 chars.
  const catalog = buildCatalog(shop, { worldTime, locations: [{ id: 'b', name: long }] });
  assert.equal(catalog.shop.locationId, 'b');
  assert.equal(catalog.shop.locationName.length, 100);
  assert.equal(catalog.shop.locationName, long.slice(0, 100));
});

test('catalog uses an empty locationName when the projected location is not in the list', () => {
  const worldTime = 5000;
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'base',
    open: true,
    inventory: [],
    automation: {
      travel: { enabled: true, locationIds: ['a', 'b'], anchorTime: 0, intervalSeconds: 3600, lastCycle: 0 },
    },
  });
  // 'b' is projected but absent from the location list.
  const catalog = buildCatalog(shop, { worldTime, locations: [{ id: 'a', name: 'Alpha' }] });
  assert.equal(catalog.shop.locationId, 'b');
  assert.equal(catalog.shop.locationName, '', 'no stale base name when the rotate target is unknown');
});

test('a failed listLocations read fails the catalog closed as a correlated server-error', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'base',
    open: true,
    inventory: [],
    automation: {
      travel: { enabled: true, locationIds: ['a', 'b'], anchorTime: 0, intervalSeconds: 3600, lastCycle: 0 },
    },
  });
  const store = {
    findShop: async () => shop,
    async listLocations() {
      throw new Error('locations read failed');
    },
  };
  const ctx = makeSocialCatalogCtx({ store });
  ctx.worldTime = () => 5000;
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', requestId: 'cat-loc-err' }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'error');
  assert.equal(data.error, 'server-error');
  assert.equal(data.shopId, 'shop1', 'correlation echoes the shop id');
  assert.ok(!('shop' in data), 'no catalog is projected on a failed location read');
});

test('catalog sets an empty locationName in a legacy context without listLocations (base and personalized)', async () => {
  const shop = normalizeShop({ id: 'shop1', name: 'S', locationId: 'loc1', open: true, inventory: [] });
  const store = { findShop: async () => shop };

  // Base path (no actor).
  const baseCtx = makeSocialCatalogCtx({ store });
  baseCtx.worldTime = () => 5000;
  const baseData = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', requestId: 'base-no-loc' }),
    'user1',
    baseCtx
  );
  assert.equal(baseData.type, 'catalog');
  assert.equal(baseData.shop.locationName, '');

  // Personalized path (with an owned actor).
  const persCtx = makeSocialCatalogCtx({
    store,
    getActor: async (id) => (id === 'a1' ? { uuid: 'Actor.a1' } : null),
    getSocial: async () => ({ score: 0, band: { title: 'Neutral' }, individual: 0, party: 0, partyId: '' }),
  });
  persCtx.worldTime = () => 5000;
  const persData = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'pers-no-loc' }),
    'user1',
    persCtx
  );
  assert.equal(persData.type, 'catalog');
  assert.equal(persData.shop.locationName, '');
});

test('allowlist includes locationName and both catalog variants stay allowlisted', async () => {
  assert.ok(PUBLIC_SHOP_FIELDS.includes('locationName'));

  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'base',
    open: true,
    inventory: [],
    automation: {
      travel: { enabled: true, locationIds: ['a', 'b'], anchorTime: 0, intervalSeconds: 3600, lastCycle: 0 },
    },
  });
  const store = {
    findShop: async () => shop,
    async listLocations() {
      return [{ id: 'b', name: 'Alpha' }];
    },
  };

  // Base variant.
  const baseCtx = makeSocialCatalogCtx({ store });
  baseCtx.worldTime = () => 5000;
  const baseData = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', requestId: 'allow-base' }),
    'user1',
    baseCtx
  );
  assert.equal(baseData.type, 'catalog');
  assert.equal(baseData.shop.locationId, 'b');
  assert.equal(baseData.shop.locationName, 'Alpha');
  assert.ok(Object.keys(baseData.shop).every((k) => PUBLIC_SHOP_FIELDS.includes(k)));

  // Personalized variant.
  const persCtx = makeSocialCatalogCtx({
    store,
    getActor: async (id) => (id === 'a1' ? { uuid: 'Actor.a1' } : null),
    getSocial: async () => ({ score: 0, band: { title: 'Neutral' }, individual: 0, party: 0, partyId: '' }),
  });
  persCtx.worldTime = () => 5000;
  const persData = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'allow-pers' }),
    'user1',
    persCtx
  );
  assert.equal(persData.type, 'catalog');
  assert.equal(persData.shop.locationName, 'Alpha');
  assert.ok(Object.keys(persData.shop).every((k) => PUBLIC_SHOP_FIELDS.includes(k)));
});

// ------------------------------------------------------------ M5 catalog specials

test('base catalog projects a sanitized specials list and cross-references exactly one eligible public offer', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Potion', price: 100, quantity: 5, visible: true }),
    ],
    commerce: {
      specials: [
        {
          id: 'sp1',
          title: 'Potion Sale',
          description: 'Half price',
          entryId: 'e1',
          price: 60,
          visible: true,
          actorUuids: [],
        },
      ],
    },
  });
  const catalog = buildCatalog(shop);
  assert.ok(Object.keys(catalog.shop).every((k) => PUBLIC_SHOP_FIELDS.includes(k)));
  assert.deepEqual(catalog.shop.specials, [
    { id: 'sp1', title: 'Potion Sale', description: 'Half price', entryId: 'e1', price: 60 },
  ]);
  assert.equal(catalog.inventory[0].specialId, 'sp1');
  assert.equal(catalog.inventory[0].specialPrice, 60);
  // Never leaks the raw `visible`/`actorUuids`/commerce config into the entry.
  assert.ok(!('actorUuids' in catalog.inventory[0]));
});

test('base catalog hides an actor-specific offer and omits its cross-reference even when the item is public', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Potion', price: 100, quantity: 5, visible: true }),
    ],
    commerce: {
      specials: [
        { id: 'sp1', title: 'VIP', description: 'Only Alice', entryId: 'e1', price: 60, visible: true, actorUuids: ['Actor.alice'] },
      ],
    },
  });
  const catalog = buildCatalog(shop);
  assert.deepEqual(catalog.shop.specials, []);
  assert.ok(!('specialId' in catalog.inventory[0]), 'no cross-reference for a hidden actor-specific offer');
  assert.ok(!('specialPrice' in catalog.inventory[0]));
});

test('base catalog omits a special whose reference entry is a backroom', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Backroom', price: 20, quantity: 1, visible: true, access: { mode: 'backroom', actorUuids: [], minReputation: 0 } }),
      normalizeInventoryEntry({ id: 'e2', itemUuid: 'u2', name: 'Public', price: 10, quantity: 1, visible: true }),
    ],
    commerce: {
      specials: [
        { id: 'sp1', title: 'Backroom', description: '', entryId: 'e1', price: 15, visible: true, actorUuids: [] },
        { id: 'sp2', title: 'Public', description: '', entryId: 'e2', price: 5, visible: true, actorUuids: [] },
      ],
    },
  });
  const catalog = buildCatalog(shop);
  assert.deepEqual(catalog.inventory.map((e) => e.name), ['Public']);
  assert.deepEqual(catalog.shop.specials.map((s) => s.id), ['sp2']);
  assert.equal(catalog.inventory[0].specialId, 'sp2');
});

test('personalized catalog exposes an actor-allowlisted offer only to the eligible actor at a social-quoted price', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Potion', price: 100, quantity: 5, visible: true }),
    ],
    commerce: {
      specials: [
        { id: 'sp1', title: 'VIP', description: 'Only Alice', entryId: 'e1', price: 60, visible: true, actorUuids: ['Actor.alice'] },
      ],
    },
  });
  const store = { findShop: async () => shop };

  // Base: the actor-specific offer is hidden (actorUuid null).
  const baseCatalog = buildCatalog(shop);
  assert.deepEqual(baseCatalog.shop.specials, []);
  assert.ok(!('specialId' in baseCatalog.inventory[0]));

  // Personalized for Alice (in the allowlist): the offer appears and the entry
  // is cross-referenced with a social quote of the special price.
  const aliceCtx = makeSocialCatalogCtx({
    store,
    getActor: async (id) => (id === 'a1' ? { uuid: 'Actor.alice' } : null),
    getSocial: async () => ({ score: 0, band: { title: 'Neutral' }, individual: 0, party: 0, partyId: '' }),
  });
  const alice = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'alice-spec' }),
    'user1',
    aliceCtx
  );
  assert.equal(alice.type, 'catalog');
  assert.deepEqual(alice.shop.specials, [
    { id: 'sp1', title: 'VIP', description: 'Only Alice', entryId: 'e1', price: 60 },
  ]);
  assert.equal(alice.inventory[0].specialId, 'sp1');
  assert.equal(alice.inventory[0].specialPrice, 60);
  assert.ok(Object.keys(alice.shop).every((k) => PUBLIC_SHOP_FIELDS.includes(k)));

  // Personalized for Bob (NOT in the allowlist): hidden, no cross-reference.
  const bobCtx = makeSocialCatalogCtx({
    store,
    getActor: async (id) => (id === 'a2' ? { uuid: 'Actor.bob' } : null),
    getSocial: async () => ({ score: 0, band: { title: 'Neutral' }, individual: 0, party: 0, partyId: '' }),
  });
  const bob = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a2', requestId: 'bob-spec' }),
    'user1',
    bobCtx
  );
  assert.equal(bob.type, 'catalog');
  assert.deepEqual(bob.shop.specials, []);
  assert.ok(!('specialId' in bob.inventory[0]));
});

test('personalized catalog social-quotes the cross-referenced special price', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    social: { shopMarkupBps: 1000 },
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Potion', price: 100, quantity: 5, visible: true }),
    ],
    commerce: {
      specials: [
        { id: 'sp1', title: 'Sale', description: '', entryId: 'e1', price: 60, visible: true, actorUuids: [] },
      ],
    },
  });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({
    store,
    getActor: async (id) => (id === 'a1' ? { uuid: 'Actor.a1' } : null),
    getSocial: async () => ({ score: 0, band: { title: 'Neutral' }, individual: 0, party: 0, partyId: '' }),
  });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'social-spec' }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'catalog');
  // 60 marked up 10% => 66 per unit. The offer price is quoted socially, not
  // emitted verbatim, for BOTH the cross-referenced entry price and the public
  // specials list - they must agree.
  assert.equal(data.inventory[0].specialPrice, 66);
  assert.equal(data.shop.specials[0].price, 66);
});

test('personalized special price agrees with the configured price for a neutral owned actor', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    // No markup / personality / reputation adjustments: the social quote must
    // resolve to the special's own configured price for an owned neutral actor.
    social: {},
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Potion', price: 100, quantity: 5, visible: true }),
    ],
    commerce: {
      specials: [
        { id: 'sp1', title: 'Sale', description: '', entryId: 'e1', price: 60, visible: true, actorUuids: [] },
      ],
    },
  });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({
    store,
    getActor: async (id) => (id === 'a1' ? { uuid: 'Actor.a1' } : null),
    getSocial: async () => ({ score: 0, band: { title: 'Neutral' }, individual: 0, party: 0, partyId: '' }),
  });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'agree-spec' }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'catalog');
  // For an owned actor with no price adjustment the personalized special price
  // must AGREE with the configured special price (still produced by quoteSocial,
  // never the raw number bypassing the social engine).
  assert.equal(data.inventory[0].specialPrice, 60);
  assert.equal(data.shop.specials[0].price, 60);
});

test('personalized catalog social-quotes EVERY eligible special price in the list, even with multiple offers', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    social: { shopMarkupBps: 1000 },
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Potion', price: 100, quantity: 5, visible: true }),
    ],
    commerce: {
      specials: [
        { id: 'sp1', title: 'A', description: '', entryId: 'e1', price: 60, visible: true, actorUuids: [] },
        { id: 'sp2', title: 'B', description: '', entryId: 'e1', price: 70, visible: true, actorUuids: [] },
      ],
    },
  });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({
    store,
    getActor: async (id) => (id === 'a1' ? { uuid: 'Actor.a1' } : null),
    getSocial: async () => ({ score: 0, band: { title: 'Neutral' }, individual: 0, party: 0, partyId: '' }),
  });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'multi-spec' }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'catalog');
  // Both offers are exposed at their SOCIAL-QUOTED prices (60 -> 66, 70 -> 77),
  // never the raw configured price, and each agrees with how the storefront would
  // read them.
  assert.deepEqual(data.shop.specials.map((s) => s.price), [66, 77]);
  // An ambiguous multi-offer entry is never cross-referenced.
  assert.ok(!('specialId' in data.inventory[0]));
});

test('a hidden (visible:false) special is omitted from the public list and not cross-referenced', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Potion', price: 100, quantity: 5, visible: true }),
    ],
    commerce: {
      specials: [
        { id: 'sp1', title: 'Sale', description: '', entryId: 'e1', price: 60, visible: false, actorUuids: [] },
      ],
    },
  });
  const catalog = buildCatalog(shop);
  assert.deepEqual(catalog.shop.specials, []);
  assert.ok(!('specialId' in catalog.inventory[0]));
});

test('a special whose reference entry is not in the inventory (forged) is omitted', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Potion', price: 100, quantity: 5, visible: true }),
    ],
    commerce: {
      specials: [
        { id: 'sp1', title: 'Ghost', description: '', entryId: 'missing', price: 60, visible: true, actorUuids: [] },
      ],
    },
  });
  const catalog = buildCatalog(shop);
  assert.deepEqual(catalog.shop.specials, []);
  assert.ok(!('specialId' in catalog.inventory[0]));
});

test('two eligible offers on one entry keep the separate list and do NOT cross-reference', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Potion', price: 100, quantity: 5, visible: true }),
    ],
    commerce: {
      specials: [
        { id: 'sp1', title: 'A', description: '', entryId: 'e1', price: 60, visible: true, actorUuids: [] },
        { id: 'sp2', title: 'B', description: '', entryId: 'e1', price: 70, visible: true, actorUuids: [] },
      ],
    },
  });
  const catalog = buildCatalog(shop);
  assert.deepEqual(catalog.shop.specials.map((s) => s.id), ['sp1', 'sp2']);
  assert.ok(!('specialId' in catalog.inventory[0]), 'an ambiguous entry is not cross-referenced');
});

// ------------------------------------------------------------ M5 backroom access

test('base catalog omits backroom entries regardless of visible', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Public', price: 10, quantity: 1, visible: true }),
      normalizeInventoryEntry({ id: 'e2', itemUuid: 'u2', name: 'Backroom', price: 20, quantity: 1, visible: true, access: { mode: 'backroom', actorUuids: ['Actor.a1'], minReputation: -100 } }),
      normalizeInventoryEntry({ id: 'e3', itemUuid: 'u3', name: 'HiddenBackroom', price: 30, quantity: 1, visible: false, access: { mode: 'backroom', actorUuids: [], minReputation: 0 } }),
    ],
  });
  const catalog = buildCatalog(shop);
  assert.deepEqual(catalog.inventory.map((e) => e.name), ['Public']);
  for (const entry of catalog.inventory) {
    assert.ok(!('access' in entry), 'access gate never leaks into the base catalog');
  }
});

test('personalized catalog filters backroom entries by access (allowlist + reputation)', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    social: { primaryPersonality: 'honest', shopMarkupBps: 0 },
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Public', price: 10, quantity: 1, visible: true }),
      normalizeInventoryEntry({ id: 'e2', itemUuid: 'u2', name: 'Allow', price: 20, quantity: 1, visible: true, access: { mode: 'backroom', actorUuids: ['Actor.a1'], minReputation: -100 } }),
      normalizeInventoryEntry({ id: 'e3', itemUuid: 'u3', name: 'Rep', price: 30, quantity: 1, visible: true, access: { mode: 'backroom', actorUuids: [], minReputation: 25 } }),
      normalizeInventoryEntry({ id: 'e4', itemUuid: 'u4', name: 'Deny', price: 40, quantity: 1, visible: true, access: { mode: 'backroom', actorUuids: [], minReputation: 50 } }),
    ],
  });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({
    store,
    getActor: async (id) => (id === 'a1' ? { uuid: 'Actor.a1' } : null),
    getSocial: async () => ({ score: 30, band: { title: 'Friendly' }, individual: 30, party: 0, partyId: '' }),
  });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat-m5-1' }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'catalog');
  assert.deepEqual(data.inventory.map((e) => e.name).sort(), ['Allow', 'Public', 'Rep']);
  assert.ok(!data.inventory.some((e) => e.name === 'Deny'), 'reputation-denied backroom is omitted');
  for (const entry of data.inventory) {
    assert.ok(!('access' in entry), 'access gate never leaks into the personalized catalog');
  }
});

test('an unowned actor cannot probe a backroom-only catalog (actor-not-owned, no leak)', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Secret', price: 10, quantity: 1, visible: true, access: { mode: 'backroom', actorUuids: ['Actor.a1'], minReputation: -100 } }),
    ],
  });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({
    store,
    getActor: async () => ({ uuid: 'Actor.a1' }),
    actorOwnedBy: () => false,
    getSocial: async () => ({ score: 100, band: { title: 'Loved' }, individual: 100, party: 0, partyId: '' }),
  });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat-m5-unowned' }),
    'user2',
    ctx
  );
  assert.equal(data.type, 'error');
  assert.equal(data.error, 'actor-not-owned');
  assert.ok(!('inventory' in data), 'no catalog inventory leaked for an unowned actor');
});

// ------------------------------------------------------ M5 availability flags

test('public shop projects commerce services/flags without leaking the raw commerce object', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [],
    commerce: {
      funds: 500,
      buyRateBps: 4000,
      buybackRateBps: 9000,
      services: [
        { id: 'sv1', name: 'Repair', description: 'Fix gear', price: 50, enabled: true, visible: true, manualFulfillment: true },
        { id: 'sv2', name: 'Disabled', description: 'Off', price: 10, enabled: false, visible: true },
        { id: 'sv3', name: 'Hidden', description: 'Not shown', price: 5, enabled: true, visible: false },
      ],
      preorders: { enabled: true, depositBps: 1000, maxPerActor: 2 },
      theft: { enabled: true },
    },
  });
  const catalog = buildCatalog(shop);
  const s = catalog.shop;
  assert.equal(s.preordersEnabled, true);
  assert.equal(s.theftEnabled, true);
  assert.deepEqual(s.services, [{ id: 'sv1', name: 'Repair', description: 'Fix gear', price: 50 }]);
  // The allowlisted projection never carries the private `commerce` config.
  assert.ok(!('commerce' in s), 'raw commerce object never leaks');
  assert.ok(!('funds' in s));
  assert.ok(!('buyRateBps' in s));
  assert.ok(!('buybackRateBps' in s));
  assert.ok(!('depositBps' in s));
  assert.ok(!('maxPerActor' in s));
  assert.ok(!('manualFulfillment' in s.services[0]), 'manualFulfillment flag not leaked');
  assert.ok(!('enabled' in s.services[0]), 'service enabled flag not leaked');
  assert.ok(!('visible' in s.services[0]), 'service visible flag not leaked');
});

test('publicServices bounds oversized raw input and clamps an invalid price', () => {
  const shop = makeShop({ price: 100, quantity: 5 });
  // Bypass normalization to prove the projection is defensive on raw input.
  shop.commerce.services = [
    { id: 'sv1', name: 'A'.repeat(150), description: 'D'.repeat(500), price: -5, enabled: true, visible: true },
    { id: 'sv2', name: 'Fine', description: 'OK', price: 7, enabled: true, visible: true },
  ];
  const catalog = buildCatalog(shop);
  const [s1, s2] = catalog.shop.services;
  assert.equal(s1.name, 'A'.repeat(100), 'service name bounded to SERVICE_NAME_MAX');
  assert.equal(s1.description, 'D'.repeat(400), 'service description bounded to SERVICE_DESCRIPTION_MAX');
  assert.equal(s1.price, 0, 'a non-finite/negative price collapses to 0');
  assert.equal(s2.price, 7, 'a finite non-negative price is preserved');
  assert.equal(catalog.shop.services.length, 2);
});

test('base catalog reflects preordersEnabled/theftEnabled and never leaks the config', () => {
  const shop = makeShop({ price: 100, quantity: 5 });
  shop.commerce.preorders.enabled = true;
  shop.commerce.theft.enabled = true;
  const catalog = buildCatalog(shop);
  assert.equal(catalog.shop.preordersEnabled, true);
  assert.equal(catalog.shop.theftEnabled, true);
  assert.ok(!('commerce' in catalog.shop));
  // Default shop has both flags false.
  const plain = buildCatalog(makeShop({ price: 100, quantity: 5 }));
  assert.equal(plain.shop.preordersEnabled, false);
  assert.equal(plain.shop.theftEnabled, false);
});

test('base catalog marks a finite out-of-stock entry preorderable, never an in-stock/unlimited one', () => {
  const oos = makeShop({ price: 100, quantity: 0 });
  oos.commerce.preorders.enabled = true;
  oos.commerce.theft.enabled = true;
  const catalog = buildCatalog(oos);
  const entry = catalog.inventory[0];
  assert.equal(entry.canPreorder, true, 'a finite out-of-stock entry is preorderable');
  assert.equal(entry.canAttemptTheft, false, 'an out-of-stock entry is not stealable');

  const inStock = makeShop({ price: 100, quantity: 5 });
  inStock.commerce.preorders.enabled = true;
  inStock.commerce.theft.enabled = true;
  const catalog2 = buildCatalog(inStock);
  assert.equal(catalog2.inventory[0].canPreorder, false, 'an in-stock entry is not preorderable');
  assert.equal(catalog2.inventory[0].canAttemptTheft, true, 'an in-stock public entry is stealable');

  const unlimited = makeShop({ stockMode: 'unlimited', price: 100, quantity: 0 });
  unlimited.commerce.preorders.enabled = true;
  unlimited.commerce.theft.enabled = true;
  const catalog3 = buildCatalog(unlimited);
  assert.equal(catalog3.inventory[0].canPreorder, false, 'an unlimited entry is never preorderable');
  assert.equal(catalog3.inventory[0].canAttemptTheft, true, 'an unlimited in-stock entry is stealable');
});

test('base catalog disables preorder/theft when the shop is closed', () => {
  const shop = makeShop({ open: false, price: 100, quantity: 0 });
  shop.commerce.preorders.enabled = true;
  shop.commerce.theft.enabled = true;
  const catalog = buildCatalog(shop);
  assert.equal(catalog.shop.open, false);
  assert.equal(catalog.inventory[0].canPreorder, false, 'a closed shop never offers preorder');
  assert.equal(catalog.inventory[0].canAttemptTheft, false, 'a closed shop never offers theft');
});

test('a non-restocking out-of-stock entry is preorderable but not buyable', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Rare', price: 100, quantity: 0, stockMode: 'non-restocking', visible: true }),
    ],
    commerce: { preorders: { enabled: true } },
  });
  const catalog = buildCatalog(shop);
  assert.equal(catalog.inventory[0].stockMode, 'non-restocking');
  assert.equal(catalog.inventory[0].canPreorder, true, 'a non-restocking out-of-stock entry is preorderable');
  assert.ok(!('canBuy' in catalog.inventory[0]), 'the base entry never carries the personalized canBuy');
});

test('personalized canPreorder is refused for a Hated quote and true for an eligible actor', async () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    social: { primaryPersonality: 'honest', shopMarkupBps: 0 },
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Potion', price: 100, quantity: 0, visible: true }),
    ],
    commerce: { preorders: { enabled: true } },
  });
  const store = { findShop: async () => shop };

  const hatedCtx = makeSocialCatalogCtx({
    store,
    getActor: async (id) => (id === 'a1' ? { uuid: 'Actor.a1' } : null),
    getSocial: async () => ({ score: -100, band: { title: 'Hated' }, individual: -100, party: 0, partyId: '' }),
  });
  const hated = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat-preorder-hated' }),
    'user1',
    hatedCtx
  );
  assert.equal(hated.type, 'catalog');
  assert.equal(hated.inventory[0].canPreorder, false, 'a Hated (refused) quote is not preorderable');
  assert.equal(hated.inventory[0].canBuy, false, 'a refused quote is also not buyable');

  const likedCtx = makeSocialCatalogCtx({
    store,
    getActor: async (id) => (id === 'a1' ? { uuid: 'Actor.a1' } : null),
    getSocial: async () => ({ score: 50, band: { title: 'Liked' }, individual: 50, party: 0, partyId: '' }),
  });
  const liked = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat-preorder-liked' }),
    'user1',
    likedCtx
  );
  assert.equal(liked.inventory[0].canPreorder, true, 'an eligible actor may preorder an out-of-stock entry');
  assert.equal(liked.inventory[0].canBuy, false, 'an out-of-stock entry is still not buyable');
});

test('canAttemptTheft requires public access, in-stock availability and a trading shop', async () => {
  // A backroom entry the actor CAN access: theft is withheld (not public access),
  // while preorder may be offered (eligible).
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    social: { primaryPersonality: 'honest', shopMarkupBps: 0 },
    inventory: [
      normalizeInventoryEntry({ id: 'public', itemUuid: 'u1', name: 'Public', price: 10, quantity: 2, visible: true }),
      normalizeInventoryEntry({ id: 'back', itemUuid: 'u2', name: 'Backroom', price: 20, quantity: 2, visible: true, access: { mode: 'backroom', actorUuids: ['Actor.a1'], minReputation: -100 } }),
    ],
    commerce: { preorders: { enabled: true }, theft: { enabled: true } },
  });
  const store = { findShop: async () => shop };
  const ctx = makeSocialCatalogCtx({
    store,
    getActor: async (id) => (id === 'a1' ? { uuid: 'Actor.a1' } : null),
    getSocial: async () => ({ score: 0, band: { title: 'Neutral' }, individual: 0, party: 0, partyId: '' }),
  });
  const data = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat-theft-1' }),
    'user1',
    ctx
  );
  assert.equal(data.type, 'catalog');
  const byName = Object.fromEntries(data.inventory.map((e) => [e.name, e]));
  assert.equal(byName.Public.canAttemptTheft, true, 'a public in-stock entry is stealable');
  assert.equal(byName.Public.canPreorder, false, 'an in-stock public entry is not preorderable');
  assert.equal(byName.Backroom.canAttemptTheft, false, 'a backroom entry (even eligible) is never stealable');
  assert.equal(byName.Backroom.canPreorder, false, 'an in-stock backroom entry is not preorderable');

  // Out of stock public entry: theft false, preorder true.
  const oosShop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    social: { primaryPersonality: 'honest', shopMarkupBps: 0 },
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Potion', price: 100, quantity: 0, visible: true }),
    ],
    commerce: { preorders: { enabled: true }, theft: { enabled: true } },
  });
  const oosStore = { findShop: async () => oosShop };
  const oosCtx = makeSocialCatalogCtx({
    store: oosStore,
    getActor: async (id) => (id === 'a1' ? { uuid: 'Actor.a1' } : null),
    getSocial: async () => ({ score: 0, band: { title: 'Neutral' }, individual: 0, party: 0, partyId: '' }),
  });
  const oos = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat-theft-2' }),
    'user1',
    oosCtx
  );
  assert.equal(oos.inventory[0].canAttemptTheft, false, 'an out-of-stock entry is not stealable');
  assert.equal(oos.inventory[0].canPreorder, true, 'an out-of-stock entry is preorderable');

  // A closed shop with an in-stock public entry: neither flag is set.
  const closedShop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: false,
    social: { primaryPersonality: 'honest', shopMarkupBps: 0 },
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Potion', price: 100, quantity: 5, visible: true }),
    ],
    commerce: { preorders: { enabled: true }, theft: { enabled: true } },
  });
  const closedStore = { findShop: async () => closedShop };
  const closedCtx = makeSocialCatalogCtx({
    store: closedStore,
    getActor: async (id) => (id === 'a1' ? { uuid: 'Actor.a1' } : null),
    getSocial: async () => ({ score: 0, band: { title: 'Neutral' }, individual: 0, party: 0, partyId: '' }),
  });
  const closed = await handleMarketChatMessage(
    makeCatalogMessage({ shopId: 'shop1', actorId: 'a1', requestId: 'cat-theft-3' }),
    'user1',
    closedCtx
  );
  assert.equal(closed.shop.open, false);
  assert.equal(closed.inventory[0].canAttemptTheft, false, 'a closed shop withholds theft');
  assert.equal(closed.inventory[0].canPreorder, false, 'a closed shop withholds preorder');
});

test('base catalog hides a backroom entry (and via it preorder/theft), never leaking access', () => {
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'public', itemUuid: 'u1', name: 'Public', price: 10, quantity: 0, visible: true }),
      normalizeInventoryEntry({ id: 'back', itemUuid: 'u2', name: 'Backroom', price: 20, quantity: 0, visible: true, access: { mode: 'backroom', actorUuids: [], minReputation: -100 } }),
    ],
    commerce: { preorders: { enabled: true }, theft: { enabled: true } },
  });
  const catalog = buildCatalog(shop);
  assert.deepEqual(catalog.inventory.map((e) => e.name), ['Public']);
  for (const entry of catalog.inventory) {
    assert.ok(!('access' in entry), 'access gate never leaks into the base catalog');
    assert.ok('canPreorder' in entry && 'canAttemptTheft' in entry, 'base entries carry the availability flags');
  }
  assert.equal(catalog.inventory[0].canPreorder, true, 'the public out-of-stock entry is preorderable');
});

test('catalog only exposes allowlisted public fields across all M5 flag projections', () => {
  const shop = makeShop({ price: 100, quantity: 0 });
  shop.commerce.preorders.enabled = true;
  shop.commerce.theft.enabled = true;
  shop.commerce.services = [{ id: 'sv1', name: 'Repair', description: 'Fix', price: 5, enabled: true, visible: true }];
  const catalog = buildCatalog(shop);
  assert.ok(Object.keys(catalog.shop).every((k) => PUBLIC_SHOP_FIELDS.includes(k)));
  assert.ok(Object.keys(catalog.inventory[0]).every((k) => PUBLIC_ENTRY_FIELDS.includes(k)));
});

// -------------------------------------------------------- M5 backroom purchase

test('purchase rejects an inaccessible backroom as entry-restricted before debit', async () => {
  const store = createMockStore();
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Backroom', price: 100, quantity: 10, visible: true, access: { mode: 'backroom', actorUuids: ['Actor.alice'], minReputation: -100 } }),
    ],
  });
  store._shops.set('shop1', shop);
  const actor = createMockActor({ currency: { gp: 5 } });
  actor.uuid = 'Actor.bob';
  const commerce = createCommerce({
    ...makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() }),
    getSocial: async () => ({ score: 0, individual: 0, party: 0 }),
  });
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'e1', actorId: 'actor1', quantity: 1, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'entry-restricted');
  assert.equal(actor.system.currency.gp, 5, 'no debit for an inaccessible backroom');
  assert.equal(actor.items.length, 0, 'no delivery for an inaccessible backroom');
  const ledger = getLedgerForUser(store, 'user1:');
  assert.equal(ledger.status, 'failed');
  assert.equal(ledger.error, 'entry-restricted');
});

test('purchase commits for a backroom entry when the actor uuid is allowlisted', async () => {
  const store = createMockStore();
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Backroom', price: 100, quantity: 10, visible: true, access: { mode: 'backroom', actorUuids: ['Actor.alice'], minReputation: 25 } }),
    ],
  });
  store._shops.set('shop1', shop);
  const actor = createMockActor({ currency: { gp: 5 } });
  actor.uuid = 'Actor.alice';
  const commerce = createCommerce({
    ...makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() }),
    getSocial: async () => ({ score: 0, individual: 0, party: 0 }),
  });
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'e1', actorId: 'actor1', quantity: 1, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'committed');
  assert.equal(result.total, 100);
  assert.equal(actor.system.currency.gp, 4, 'debit applied');
  assert.equal(actor.items.length, 1, 'item delivered');
});

test('purchase commits for a backroom entry when the actor meets the reputation threshold', async () => {
  const store = createMockStore();
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Backroom', price: 100, quantity: 10, visible: true, access: { mode: 'backroom', actorUuids: [], minReputation: 25 } }),
    ],
  });
  store._shops.set('shop1', shop);
  const actor = createMockActor({ currency: { gp: 5 } });
  actor.uuid = 'Actor.bob';
  const commerce = createCommerce({
    ...makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() }),
    getSocial: async () => ({ score: 30, individual: 30, party: 0 }),
  });
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'e1', actorId: 'actor1', quantity: 1, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'committed');
  assert.equal(actor.system.currency.gp, 4, 'debit applied');
  assert.equal(actor.items.length, 1, 'item delivered');
});

test('legacy commerce fails closed for a backroom when getSocial is absent and the uuid is not allowlisted', async () => {
  const store = createMockStore();
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Backroom', price: 100, quantity: 10, visible: true, access: { mode: 'backroom', actorUuids: ['Actor.alice'], minReputation: 25 } }),
    ],
  });
  store._shops.set('shop1', shop);
  const actor = createMockActor({ currency: { gp: 5 } });
  actor.uuid = 'Actor.bob';
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'e1', actorId: 'actor1', quantity: 1, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'entry-restricted');
  assert.equal(actor.system.currency.gp, 5, 'no debit on a legacy backroom denial');
});

test('legacy commerce allows a backroom when the uuid is allowlisted even without getSocial', async () => {
  const store = createMockStore();
  const shop = normalizeShop({
    id: 'shop1',
    name: 'S',
    locationId: 'loc1',
    open: true,
    inventory: [
      normalizeInventoryEntry({ id: 'e1', itemUuid: 'u1', name: 'Backroom', price: 100, quantity: 10, visible: true, access: { mode: 'backroom', actorUuids: ['Actor.alice'], minReputation: 25 } }),
    ],
  });
  store._shops.set('shop1', shop);
  const actor = createMockActor({ currency: { gp: 5 } });
  actor.uuid = 'Actor.alice';
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );
  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'e1', actorId: 'actor1', quantity: 1, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'committed');
  assert.equal(actor.system.currency.gp, 4, 'debit applied');
  assert.equal(actor.items.length, 1, 'item delivered');
});

// ----------------------------------------------- terminal commit re-read (M1)

test('a committed ledger write that applies then throws is reported committed and never compensated', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  // The terminal `committed` ledger write APPLIES the state then throws: the
  // purchase may STILL have committed, so it must re-read rather than assume
  // failed (which used to refund currency, remove the item and restore stock).
  const originalUpdateLedger = store.updateLedger;
  store.updateLedger = async (id, patch) => {
    if (patch.status === 'committed') {
      const res = await originalUpdateLedger(id, patch);
      throw new Error('commit write exploded after apply');
    }
    return originalUpdateLedger(id, patch);
  };
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );

  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'committed');

  // No compensation: the stock decrement, the debit and the delivery all stay.
  const shop = store._shops.get('shop1');
  assert.equal(shop.inventory[0].quantity, 8, 'stock not restored');
  assert.equal(actor.system.currency.gp, 3, 'currency not refunded');
  assert.equal(actor.items.length, 1, 'delivered item not removed');
  const ledger = getLedgerForUser(store, 'user1:');
  assert.equal(ledger.status, 'committed', 'ledger recorded as committed');
});

test('a committed ledger write whose re-read is unavailable is needsRecovery without refunding', async () => {
  const store = createMockStore();
  store._shops.set('shop1', makeShop({ price: 100, quantity: 10 }));
  const actor = createMockActor({ currency: { gp: 5 } });
  // The terminal `committed` write throws (does not apply).
  const originalUpdateLedger = store.updateLedger;
  store.updateLedger = async (id, patch) => {
    if (patch.status === 'committed') throw new Error('commit write failed');
    return originalUpdateLedger(id, patch);
  };
  // The post-commit re-read is unavailable (lost read): the pending record cannot
  // be confirmed, so it must escalate WITHOUT refunding/removing/restoring.
  const originalFindLedger = store.findLedgerByKey.bind(store);
  let reads = 0;
  store.findLedgerByKey = async (key) => {
    reads += 1;
    if (reads >= 2) throw new Error('ledger read failed');
    return originalFindLedger(key);
  };
  const commerce = createCommerce(
    makeCommerceCtx({ store, actor, itemSource: makeSourceItem(), adapter: new Dnd5eAdapter() })
  );

  const result = await commerce.purchase(
    { shopId: 'shop1', entryId: 'entry1', actorId: 'actor1', quantity: 2, userId: 'user1' },
    'gm1'
  );
  assert.equal(result.status, 'needsRecovery');
  assert.equal(result.error, 'commit write failed');
  assert.deepEqual(result.compensation, []);

  // No compensation: the stock decrement, the debit and the delivery all stay.
  const shop = store._shops.get('shop1');
  assert.equal(shop.inventory[0].quantity, 8, 'stock not restored');
  assert.equal(actor.system.currency.gp, 3, 'currency not refunded');
  assert.equal(actor.items.length, 1, 'delivered item not removed');
  const ledger = getLedgerForUser(store, 'user1:');
  assert.equal(ledger.status, 'pending', 'ledger left pending for a replay');
});
