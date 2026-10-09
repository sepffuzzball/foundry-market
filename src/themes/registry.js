// Theme registry for the market (M2 data layer).
//
// This module is intentionally pure data: no Foundry globals, no CSS generation,
// no bundled assets. It exposes the fixed set of shop themes keyed by their
// canonical id, plus a safe `registerTheme` so an external module can add its
// own theme, and a normalize helper so the schema can safely fall back to the
// general-store theme for legacy/blank/unrecognized values.
//
// Theme metadata is display-only: label, blurb, an icon glyph (single text
// character), a CSS class id and a default background sound (empty for the
// built-in themes because they ship no bundled audio). No stylesheet is produced
// from this file; the UI is responsible for mapping a theme id to any real
// styles. The registration surface never writes to the store: `registerTheme`
// only updates this in-memory registry.

import { normalizeAppearance, sanitizeMediaPath } from '../services/model.js';

export const THEME_IDS = [
  'blacksmith',
  'leatherworker',
  'apothecary',
  'dark-druid',
  'necromancer',
  'pastry',
  'general-store',
  'holy-temple',
];

// The id of a built-in theme. Kept as a private snapshot so `resetThemes` can
// restore the registry to exactly the documented defaults after a test or an
// external module registers additional themes.
const BUILT_IN_THEME_IDS = THEME_IDS.slice();

// A theme id must be a lowercase slug (letters/digits, each run separated by a
// single hyphen) so it can be used safely as a CSS class token.
const THEME_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Theme metadata length caps. Kept small because `label`/`blurb` are displayed
// verbatim in a shell UI, and `icon` is a single glyph.
const THEME_LABEL_MAX = 60;
const THEME_BLURB_MAX = 240;
const THEME_ICON_MAX = 4;

// Ids that collide with Object.prototype / prototype-chain names. Registering
// one of these would shadow an inherited property and make `getTheme` (which
// uses `hasOwnProperty`) disagree with a plain property read, so they are
// rejected outright.
const RESERVED_THEME_IDS = ['__proto__', 'constructor', 'prototype'];

export const THEMES = {
  blacksmith: {
    id: 'blacksmith',
    label: 'Blacksmith',
    blurb: 'A forge-dark shop of arms, armor and hard-worn tools.',
    icon: '\u2692', // U+2692 hammer and pick
    cssClass: 'market-theme-blacksmith',
    defaultSound: '',
  },
  leatherworker: {
    id: 'leatherworker',
    label: 'Leatherworker',
    blurb: 'Sewn hides, boots and straps from a careful hand.',
    icon: '\u2702', // U+2702 black scissors
    cssClass: 'market-theme-leatherworker',
    defaultSound: '',
  },
  apothecary: {
    id: 'apothecary',
    label: 'Apothecary',
    blurb: 'Herbs, tinctures and curious remedies behind the counter.',
    icon: '\u2697', // U+2697 alembic
    cssClass: 'market-theme-apothecary',
    defaultSound: '',
  },
  'dark-druid': {
    id: 'dark-druid',
    label: 'Dark Druid',
    blurb: 'A moon-lit stand of thorns, roots and old whispers.',
    icon: '\u263E', // U+263E last quarter moon
    cssClass: 'market-theme-dark-druid',
    defaultSound: '',
  },
  necromancer: {
    id: 'necromancer',
    label: 'Necromancer',
    blurb: 'Bone, grave-dust and the things that refuse to stay buried.',
    icon: '\u2620', // U+2620 skull and crossbones
    cssClass: 'market-theme-necromancer',
    defaultSound: '',
  },
  pastry: {
    id: 'pastry',
    label: 'Pastry',
    blurb: 'Warm loaves, sweet tarts and the smell of fresh dough.',
    icon: '\u2615', // U+2615 hot beverage
    cssClass: 'market-theme-pastry',
    defaultSound: '',
  },
  'general-store': {
    id: 'general-store',
    label: 'General Store',
    blurb: 'A common market selling a little of everything.',
    icon: '\u25A3', // U+25A3 white square containing black small square
    cssClass: 'market-theme-general-store',
    defaultSound: '',
  },
  'holy-temple': {
    id: 'holy-temple',
    label: 'Holy Temple',
    blurb: 'A sanctified hall of candles, relics and quiet blessings.',
    icon: '\u271D', // U+271D latin cross
    cssClass: 'market-theme-holy-temple',
    defaultSound: '',
  },
};

/**
 * Normalize and validate the metadata an external module passes to
 * `registerTheme`. Throws a readable `[market]` error on the first problem so a
 * bad registration is caught at module load instead of silently producing a
 * broken theme.
 */
function normalizeThemeMetadata(metadata) {
  const id = metadata?.id;
  // Reject prototype-chain collisions first so they always report as a duplicate
  // (an `__proto__`/`constructor`/`prototype` id is never a valid new theme).
  if (RESERVED_THEME_IDS.includes(id) || Object.prototype.hasOwnProperty.call(THEMES, id)) {
    throw new Error(`[market] theme '${id}' is already registered`);
  }
  if (typeof id !== 'string' || !THEME_ID_RE.test(id)) {
    throw new Error(
      `[market] theme 'id' must be a lowercase slug (letters/digits separated by ` +
        `single hyphens), got ${JSON.stringify(id)}`
    );
  }

  const label = metadata.label;
  if (typeof label !== 'string' || label.trim() === '') {
    throw new Error(`[market] theme '${id}' label must be a non-empty string`);
  }
  if (label.length > THEME_LABEL_MAX) {
    throw new Error(`[market] theme '${id}' label must be at most ${THEME_LABEL_MAX} chars`);
  }

  const blurb = metadata.blurb;
  if (typeof blurb !== 'string' || blurb.trim() === '') {
    throw new Error(`[market] theme '${id}' blurb must be a non-empty string`);
  }
  if (blurb.length > THEME_BLURB_MAX) {
    throw new Error(`[market] theme '${id}' blurb must be at most ${THEME_BLURB_MAX} chars`);
  }

  const icon = metadata.icon;
  if (typeof icon !== 'string' || icon.trim() === '') {
    throw new Error(`[market] theme '${id}' icon must be a non-empty text character`);
  }
  if (icon.length > THEME_ICON_MAX) {
    throw new Error(`[market] theme '${id}' icon must be at most ${THEME_ICON_MAX} chars`);
  }

  return {
    id,
    label,
    blurb,
    icon,
    cssClass: `market-theme-${id}`,
    // `defaultSound` is optional; when supplied it must be a local media path
    // (sanitized via the shared media-path sanitizer, which collapses an unsafe
    // value to ''). A shop still plays whatever `appearance.music` the GM sets.
    defaultSound:
      metadata.defaultSound == null ? '' : sanitizeMediaPath(String(metadata.defaultSound)),
  };
}

/**
 * Register an additional shop theme from an external module. Purely in-memory:
 * it appends to `THEMES` and `THEME_IDS` (never mutating the built-in entries)
 * and returns the registered metadata. `getTheme`/`normalizeTheme` immediately
 * recognize it, and the manager/storefront will render `theme-<id>` (and the
 * manager preview `.preview-panel.theme-<id>`) for a shop set to that theme, so
 * the supplying module must provide matching CSS for those selectors. No store
 * data is written.
 *
 * @param {object} metadata `{ id, label, blurb, icon, defaultSound? }`
 * @returns {object} the registered theme metadata (including the generated cssClass)
 */
export function registerTheme(metadata) {
  const theme = normalizeThemeMetadata(metadata);
  THEMES[theme.id] = theme;
  THEME_IDS.push(theme.id);
  return theme;
}

/**
 * Restore the registry to exactly the built-in 8-theme set, dropping any theme
 * an external module (or a test) registered. This mutates the exported
 * `THEMES`/`THEME_IDS` back to their documented defaults.
 */
export function resetThemes() {
  for (const key of Object.keys(THEMES)) {
    if (!BUILT_IN_THEME_IDS.includes(key)) delete THEMES[key];
  }
  THEME_IDS.length = 0;
  THEME_IDS.push(...BUILT_IN_THEME_IDS);
}

/**
 * Return the theme metadata object for a known id, or `null` when the id is not
 * a registered theme.
 */
export function getTheme(id) {
  return Object.prototype.hasOwnProperty.call(THEMES, id) ? THEMES[id] : null;
}

/**
 * Normalize an arbitrary theme value to a known theme id. Legacy blank or
 * unrecognized values always fall back to the `general-store` theme so a shop
 * record never carries an unknown theme.
 */
export function normalizeTheme(id) {
  return getTheme(id) ? id : 'general-store';
}

// The registry is the single data-layer entry point. Re-export the appearance
// and media-path helpers so callers can import the whole M2 surface from here
// without reaching into the schema module.
export { normalizeAppearance, sanitizeMediaPath };
