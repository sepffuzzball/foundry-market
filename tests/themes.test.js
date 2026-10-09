// Tests for the M2 theme registry and appearance/media validation. No Foundry
// globals required; the store is driven against an in-memory document access
// object exactly as the M1 core tests do.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  THEMES,
  THEME_IDS,
  getTheme,
  normalizeTheme,
  registerTheme,
  resetThemes,
} from '../src/themes/registry.js';
import {
  normalizeShop,
  normalizeAppearance,
  isValidMediaPath,
  sanitizeMediaPath,
  WELCOME_MESSAGE_MAX,
} from '../src/services/model.js';
import { createStore } from '../src/storage/store.js';

// ---------------------------------------------------------------- helpers

function createFakeDocAccess() {
  const docs = new Map();
  let seq = 0;
  return {
    docs,
    async listJournalEntries() {
      return Array.from(docs.values());
    },
    async getJournalEntry(id) {
      return docs.get(id) || null;
    },
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

// ------------------------------------------------------------ theme registry

test('theme registry exposes exactly the documented 8 themes', () => {
  assert.equal(THEME_IDS.length, 8);
  assert.deepEqual(
    [...THEME_IDS].sort(),
    [
      'apothecary',
      'blacksmith',
      'dark-druid',
      'general-store',
      'holy-temple',
      'leatherworker',
      'necromancer',
      'pastry',
    ].sort()
  );
  for (const id of THEME_IDS) {
    const t = getTheme(id);
    assert.ok(t, `theme '${id}' is registered`);
    assert.equal(t.id, id, 'theme object carries its own id');
    assert.equal(typeof t.label, 'string');
    assert.ok(t.label.length > 0, 'label is non-empty');
    assert.equal(typeof t.blurb, 'string');
    assert.ok(t.blurb.length > 0, 'blurb is non-empty');
    assert.equal(typeof t.icon, 'string');
    assert.ok(t.icon.length > 0, 'icon glyph is a non-empty text character');
    assert.equal(t.cssClass, `market-theme-${id}`);
    assert.equal(typeof t.defaultSound, 'string');
    assert.equal(t.defaultSound, '', 'no bundled background audio asset');
    assert.equal(ThemesHas(THEMES, id), true);
  }
});

function ThemesHas(themes, id) {
  return Object.prototype.hasOwnProperty.call(themes, id);
}

test('getTheme returns null for unknown ids and normalizeTheme falls back to general-store', () => {
  assert.equal(getTheme('no-such-theme'), null);
  assert.equal(getTheme(undefined), null);
  assert.equal(normalizeTheme(''), 'general-store');
  assert.equal(normalizeTheme(undefined), 'general-store');
  assert.equal(normalizeTheme(null), 'general-store');
  assert.equal(normalizeTheme('no-such-theme'), 'general-store');
  assert.equal(normalizeTheme('blacksmith'), 'blacksmith');
  assert.equal(normalizeTheme('holy-temple'), 'holy-temple');
  assert.equal(normalizeTheme('general-store'), 'general-store');
});

// -------------------------------------------------------- shop theme migration

test('normalizeShop maps a legacy blank or unknown theme to general-store', () => {
  const blank = normalizeShop({ name: 'S', theme: '' });
  assert.equal(blank.theme, 'general-store');
  const unknown = normalizeShop({ name: 'S', theme: 'pixie-market' });
  assert.equal(unknown.theme, 'general-store');
  const known = normalizeShop({ name: 'S', theme: 'necromancer' });
  assert.equal(known.theme, 'necromancer');
});

test('store roundtrip normalizes a legacy theme without bumping the schema', async () => {
  const store = createStore(createFakeDocAccess());
  const shop = await store.createShop({ name: 'S', theme: '' });
  assert.equal(shop.theme, 'general-store');
  const found = await store.findShop(shop.id);
  assert.equal(found.theme, 'general-store');
  assert.equal(typeof found.owner, 'string');
  assert.ok(Number.isSafeInteger(found.createdAt));
  // The appearance object is always present with documented defaults.
  assert.equal(found.appearance.typography, 'classic');
  assert.equal(found.appearance.density, 'comfortable');
  assert.equal(found.appearance.animation, 'full');
  // Updating shop metadata must not erase the theme normalization or appearance.
  const updated = await store.updateShop(shop.id, { open: false });
  assert.equal(updated.open, false);
  assert.equal(updated.theme, 'general-store');
  assert.equal(updated.appearance.accentColor, '');
});

// --------------------------------------------------------- appearance defaults

test('normalizeAppearance fills documented defaults', () => {
  const app = normalizeAppearance();
  assert.deepEqual(app, {
    backgroundImage: '',
    ownerPortrait: '',
    accentColor: '',
    typography: 'classic',
    density: 'comfortable',
    animation: 'full',
    music: '',
    soundEffect: '',
    welcomeMessage: '',
  });
});

test('normalizeAppearance preserves valid values and normalizes radio fields', () => {
  const app = normalizeAppearance({
    backgroundImage: 'modules/forge/img/forge-bg.png',
    ownerPortrait: 'icons/portrait.png',
    accentColor: '#A1B2C3',
    typography: 'display',
    density: 'compact',
    animation: 'subtle',
    music: 'modules/forge/sfx/ambient.ogg',
    soundEffect: 'systems/dnd/sfx/bell.ogg',
    welcomeMessage: 'Welcome!',
  });
  assert.equal(app.backgroundImage, 'modules/forge/img/forge-bg.png');
  assert.equal(app.ownerPortrait, 'icons/portrait.png');
  assert.equal(app.accentColor, '#A1B2C3');
  assert.equal(app.typography, 'display');
  assert.equal(app.density, 'compact');
  assert.equal(app.animation, 'subtle');
  assert.equal(app.music, 'modules/forge/sfx/ambient.ogg');
  assert.equal(app.soundEffect, 'systems/dnd/sfx/bell.ogg');
  assert.equal(app.welcomeMessage, 'Welcome!');
  // Unrecognized radio values fall back to the documented default.
  assert.equal(normalizeAppearance({ typography: 'fancy' }).typography, 'classic');
  assert.equal(normalizeAppearance({ density: 'wide' }).density, 'comfortable');
  assert.equal(normalizeAppearance({ animation: 'none' }).animation, 'full');
});

// ----------------------------------------------------------- media path rules

test('isValidMediaPath accepts local asset paths under the allowed roots', () => {
  assert.equal(isValidMediaPath(''), true, 'empty is always valid');
  assert.equal(isValidMediaPath('modules/forge/img/bg.png'), true);
  assert.equal(isValidMediaPath('./modules/forge/img/bg.png'), true);
  assert.equal(isValidMediaPath('worlds/mine/x/note.md'), true);
  assert.equal(isValidMediaPath('systems/dnd5e/icons/axe.svg'), true);
  assert.equal(isValidMediaPath('icons/potion.png'), true);
  assert.equal(isValidMediaPath('  modules/a/b.png  '), true, 'whitespace trimmed');
});

test('isValidMediaPath rejects http, absolute, bad chars, dot-dot and query', () => {
  assert.equal(isValidMediaPath('https://cdn.example.com/a.png'), false, 'remote url');
  assert.equal(isValidMediaPath('modules/x/../y.png'), false, 'dot-dot segment');
  assert.equal(isValidMediaPath('icons/a (1).png'), false, 'parentheses');
  assert.equal(isValidMediaPath("icons/a'b.png"), false, 'single quote');
  assert.equal(isValidMediaPath('icons/a"b.png'), false, 'double quote');
  assert.equal(isValidMediaPath('icons/a\\b.png'), false, 'backslash');
  assert.equal(isValidMediaPath('icons/100%.png'), false, 'percent');
  assert.equal(isValidMediaPath('icons/a:b.png'), false, 'colon');
  assert.equal(isValidMediaPath('worlds/x/y.png?q=1'), false, 'query string');
  assert.equal(isValidMediaPath('worlds/x/y.png#frag'), false, 'fragment');
  assert.equal(isValidMediaPath('X'.repeat(301)), false, 'over max length');
  assert.equal(isValidMediaPath('ui/logo.png'), false, 'outside the allowed roots');
});

test('normalizeAppearance throws on an invalid media path at GM save', () => {
  assert.throws(
    () => normalizeAppearance({ backgroundImage: 'https://cdn/x.png' }),
    /local media path/
  );
  assert.throws(() => normalizeAppearance({ ownerPortrait: 'icons/a (1).png' }), /local media path/);
  assert.throws(() => normalizeAppearance({ music: 'worlds/x/y.ogg?x=1' }), /local media path/);
  assert.throws(
    () => normalizeAppearance({ soundEffect: 'modules/x/../../y.ogg' }),
    /local media path/
  );
});

test('sanitizeMediaPath never throws and collapses unsafe values', () => {
  assert.equal(sanitizeMediaPath('modules/a/b.png'), 'modules/a/b.png');
  assert.equal(sanitizeMediaPath('./worlds/x/y.png'), './worlds/x/y.png');
  assert.equal(sanitizeMediaPath('https://cdn/x.png'), '');
  assert.equal(sanitizeMediaPath('icons/a (1).png'), '');
  assert.equal(sanitizeMediaPath(''), '');
  assert.equal(sanitizeMediaPath('   worlds/x/y.png   '), 'worlds/x/y.png');
});

// ------------------------------------------------------------- accent + strings

test('normalizeAppearance rejects a malformed accent color', () => {
  assert.throws(() => normalizeAppearance({ accentColor: 'red' }), /accentColor|hex/);
  assert.throws(() => normalizeAppearance({ accentColor: '#FFF' }), /accentColor|hex/);
  assert.throws(() => normalizeAppearance({ accentColor: '#GGHHII' }), /accentColor|hex/);
  assert.equal(normalizeAppearance({ accentColor: '#aBcDeF' }).accentColor, '#aBcDeF');
  assert.equal(normalizeAppearance({ accentColor: '' }).accentColor, '');
});

test('normalizeAppearance caps welcomeMessage to the documented maximum', () => {
  const app = normalizeAppearance({ welcomeMessage: 'x'.repeat(WELCOME_MESSAGE_MAX + 100) });
  assert.equal(app.welcomeMessage.length, WELCOME_MESSAGE_MAX);
});

// ------------------------------------------------------- registerTheme surface

test('registerTheme adds a validated theme and getTheme/normalizeTheme recognize it', () => {
  resetThemes();
  const meta = registerTheme({
    id: 'candy-shop',
    label: 'Candy Shop',
    blurb: 'A sweet shop of confections and spun sugar.',
    icon: '\u2764',
  });
  assert.equal(meta.id, 'candy-shop');
  assert.equal(meta.cssClass, 'market-theme-candy-shop');
  assert.equal(meta.defaultSound, '');
  assert.ok(THEMES['candy-shop'], 'theme recorded in THEMES');
  assert.ok(THEME_IDS.includes('candy-shop'), 'theme id added to THEME_IDS');
  // Built-in entries are untouched by a custom registration.
  assert.equal(THEMES.blacksmith.defaultSound, '');
  assert.equal(THEMES['general-store'].cssClass, 'market-theme-general-store');
  // The registry accessors see the custom theme immediately.
  assert.equal(getTheme('candy-shop').label, 'Candy Shop');
  assert.equal(normalizeTheme('candy-shop'), 'candy-shop');
  assert.equal(normalizeTheme('no-such-theme'), 'general-store', 'unknown still falls back');
  resetThemes();
});

test('registerTheme rejects an id that is not a lowercase slug', () => {
  resetThemes();
  const bad = ['CandyShop', 'candy shop', '', 'candy--shop', '-candy', 'candy-', 123, null];
  for (const id of bad) {
    assert.throws(
      () => registerTheme({ id, label: 'L', blurb: 'B', icon: 'i' }),
      /slug/,
      `id ${JSON.stringify(id)} must be rejected`
    );
  }
  resetThemes();
});

test('registerTheme rejects duplicates including prototype names', () => {
  resetThemes();
  assert.throws(
    () => registerTheme({ id: 'blacksmith', label: 'X', blurb: 'Y', icon: 'z' }),
    /already registered/,
    'a built-in id is a duplicate'
  );
  registerTheme({ id: 'candy-shop', label: 'C', blurb: 'D', icon: 'e' });
  assert.throws(
    () => registerTheme({ id: 'candy-shop', label: 'C2', blurb: 'D2', icon: 'f' }),
    /already registered/,
    'a custom id is a duplicate'
  );
  for (const reserved of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(
      () => registerTheme({ id: reserved, label: 'L', blurb: 'B', icon: 'i' }),
      /already registered/,
      `prototype name '${reserved}' is rejected`
    );
  }
  resetThemes();
});

test('registerTheme validates label/blurb/icon type and length', () => {
  resetThemes();
  assert.throws(() => registerTheme({ id: 'x-shop', label: '', blurb: 'B', icon: 'i' }), /label/);
  assert.throws(() => registerTheme({ id: 'x-shop', label: 5, blurb: 'B', icon: 'i' }), /label/);
  assert.throws(() => registerTheme({ id: 'x-shop', label: 'L', blurb: '', icon: 'i' }), /blurb/);
  assert.throws(() => registerTheme({ id: 'x-shop', label: 'L', blurb: 7, icon: 'i' }), /blurb/);
  assert.throws(() => registerTheme({ id: 'x-shop', label: 'L', blurb: 'B', icon: '' }), /icon/);
  assert.throws(() => registerTheme({ id: 'x-shop', label: 'L', blurb: 'B', icon: 9 }), /icon/);
  // Over-length values are rejected.
  assert.throws(
    () => registerTheme({ id: 'x-shop', label: 'N'.repeat(61), blurb: 'B', icon: 'i' }),
    /label/
  );
  assert.throws(
    () => registerTheme({ id: 'x-shop', label: 'L', blurb: 'B'.repeat(241), icon: 'i' }),
    /blurb/
  );
  assert.throws(
    () => registerTheme({ id: 'x-shop', label: 'L', blurb: 'B', icon: 'iiiii' }),
    /icon/
  );
  const meta = registerTheme({ id: 'b-shop', label: 'B', blurb: 'B', icon: 'i' });
  assert.equal(meta.id, 'b-shop');
  resetThemes();
});

test('registerTheme sanitizes an optional defaultSound to a local path', () => {
  resetThemes();
  const a = registerTheme({
    id: 'a-shop',
    label: 'A',
    blurb: 'B',
    icon: 'i',
    defaultSound: 'modules/x/ambient.ogg',
  });
  assert.equal(a.defaultSound, 'modules/x/ambient.ogg');
  const b = registerTheme({
    id: 'b-shop',
    label: 'B',
    blurb: 'B',
    icon: 'i',
    defaultSound: 'https://cdn.example.com/x.ogg',
  });
  assert.equal(b.defaultSound, '', 'an invalid remote defaultSound collapses to empty');
  const c = registerTheme({ id: 'c-shop', label: 'C', blurb: 'B', icon: 'i' });
  assert.equal(c.defaultSound, '', 'defaults to empty when omitted');
  resetThemes();
});

test('resetThemes restores the exact built-in 8 and drops custom registrations', () => {
  resetThemes();
  registerTheme({ id: 'temp-shop', label: 'T', blurb: 'B', icon: 'i' });
  assert.ok(THEME_IDS.includes('temp-shop'));
  resetThemes();
  assert.equal(THEME_IDS.length, 8);
  assert.ok(!('temp-shop' in THEMES), 'custom theme dropped');
  assert.deepEqual(
    [...THEME_IDS].sort(),
    [
      'apothecary',
      'blacksmith',
      'dark-druid',
      'general-store',
      'holy-temple',
      'leatherworker',
      'necromancer',
      'pastry',
    ].sort()
  );
});
