// Pure NPC personality presets for the market core (M3 data layer).
//
// This module is intentionally free of Foundry globals so it can be imported by
// Node for tests. It defines the fixed set of personality presets, plus a
// getter with a safe fallback and a weighted blender for a shop's primary and
// secondary NPC personalities.
//
// Each preset carries only integer mechanical numbers (basis-point markup,
// haggle difficulty, deception penalty, repeat bonus) and display metadata
// (label, description, greetings). The mechanical numbers are deliberately
// distinct across the ten presets so that no two personalities behave
// identically.

// The ten canonical personality ids. A shop's primary personality must be one
// of these, and the secondary (if any) must be too.
export const PERSONALITY_IDS = [
  'honest',
  'greedy',
  'generous',
  'helpful',
  'suspicious',
  'scornful',
  'proud',
  'desperate',
  'shrewd',
  'eccentric',
];

export const PERSONALITIES = {
  honest: {
    id: 'honest',
    label: 'Honest',
    description: 'Deals fairly and tells the truth.',
    markupBps: 0,
    haggleDifficulty: 3,
    deceptionPenalty: 0,
    repeatBonus: 10,
    greetings: [
      'Welcome! What can I get for you?',
      'Everything here is priced fairly, I promise.',
    ],
  },
  greedy: {
    id: 'greedy',
    label: 'Greedy',
    description: 'Always looking to turn a profit.',
    markupBps: 1500,
    haggleDifficulty: 1,
    deceptionPenalty: 400,
    repeatBonus: 5,
    greetings: [
      'Money talks!',
      'Its a steal, really!',
      'Best price in town - trust me.',
    ],
  },
  generous: {
    id: 'generous',
    label: 'Generous',
    description: 'Happy to give a fair deal.',
    markupBps: -1000,
    haggleDifficulty: 4,
    deceptionPenalty: 0,
    repeatBonus: 20,
    greetings: [
      'Take your time, friend.',
      'I always look after my customers.',
    ],
  },
  helpful: {
    id: 'helpful',
    label: 'Helpful',
    description: 'Takes time to help you find the right thing.',
    markupBps: -500,
    haggleDifficulty: 5,
    deceptionPenalty: 0,
    repeatBonus: 15,
    greetings: [
      'How can I help you today?',
      'Let me know what you need and we will find it.',
    ],
  },
  suspicious: {
    id: 'suspicious',
    label: 'Suspicious',
    description: 'Wary of every customer who walks in.',
    markupBps: 800,
    haggleDifficulty: 2,
    deceptionPenalty: 300,
    repeatBonus: 8,
    greetings: [
      'What do you want?',
      'Hmm, a buyer. Fine, look around.',
    ],
  },
  scornful: {
    id: 'scornful',
    label: 'Scornful',
    description: 'Looks down on everyone, even customers.',
    markupBps: 1200,
    haggleDifficulty: 3,
    deceptionPenalty: 200,
    repeatBonus: 3,
    greetings: [
      'Oh, its you.',
      "You again? Fine, but do not touch anything.",
    ],
  },
  proud: {
    id: 'proud',
    label: 'Proud',
    description: 'Boasts about the fine quality of every ware.',
    markupBps: 1000,
    haggleDifficulty: 1,
    deceptionPenalty: 100,
    repeatBonus: 6,
    greetings: [
      'Only the finest here.',
      'You are looking at quality, mark my words.',
    ],
  },
  desperate: {
    id: 'desperate',
    label: 'Desperate',
    description: 'Needs to make a sale, any sale.',
    markupBps: -800,
    haggleDifficulty: 5,
    deceptionPenalty: 50,
    repeatBonus: 25,
    greetings: [
      'Please, buy something!',
      'Any offer at all?',
      'Please, I need this gone.',
    ],
  },
  shrewd: {
    id: 'shrewd',
    label: 'Shrewd',
    description: 'A sharp negotiator who always gets his way.',
    markupBps: 600,
    haggleDifficulty: 1,
    deceptionPenalty: 500,
    repeatBonus: 12,
    greetings: [
      'Lets make a deal.',
      'I can do better than that.',
    ],
  },
  eccentric: {
    id: 'eccentric',
    label: 'Eccentric',
    description: 'Astounding tastes and odd offers.',
    markupBps: 300,
    haggleDifficulty: 2,
    deceptionPenalty: 150,
    repeatBonus: 20,
    greetings: [
      'Oh wonderful, a customer!',
      'Fascinating, isnt it?',
      'Welcome to my curiosity shoppe!',
    ],
  },
};

// A personality id is valid only when it is an own key of the preset map.
// Prototype-chain names and unknown strings both fail closed to false.
export function isValidPersonality(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PERSONALITIES, id);
}

/**
 * Return the preset for `id`, falling back to the `honest` preset for any
 * unknown or missing id. Never throws.
 */
export function getPersonality(id) {
  return PERSONALITIES[id] || PERSONALITIES.honest;
}

function assertWeight(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`[market] '${label}' must be a safe integer, got ${value}`);
  }
  if (value < 0 || value > 100) {
    throw new Error(`[market] '${label}' must be between 0 and 100, got ${value}`);
  }
  return value;
}

/**
 * Blend a primary and (optional) secondary personality into a single effective
 * one using `secondaryWeight` as the percentage weight given to the secondary.
 *
 * With a missing/empty secondary, a zero weight, or a secondary identical to the
 * primary, the result is exactly the primary preset (no rounding happens). With
 * a real secondary the four integer mechanical numbers are blended as
 * `round((primary * (100 - w) + secondary * w) / 100)` and rounded to the
 * nearest integer. Identity metadata (id/label/description) always comes from
 * the primary.
 *
 * `secondaryWeight` must be an integer in [0, 100]; anything else throws.
 */
export function effectivePersonality(primary, secondary, secondaryWeight = 0) {
  const sw = assertWeight(secondaryWeight, 'secondaryWeight');
  const p = getPersonality(primary);
  if (!secondary || sw === 0) {
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      markupBps: p.markupBps,
      haggleDifficulty: p.haggleDifficulty,
      deceptionPenalty: p.deceptionPenalty,
      repeatBonus: p.repeatBonus,
    };
  }
  const s = getPersonality(secondary);
  if (s.id === p.id) {
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      markupBps: p.markupBps,
      haggleDifficulty: p.haggleDifficulty,
      deceptionPenalty: p.deceptionPenalty,
      repeatBonus: p.repeatBonus,
    };
  }
  const blend = (a, b) => Math.round((a * (100 - sw) + b * sw) / 100);
  return {
    id: p.id,
    label: p.label,
    description: p.description,
    markupBps: blend(p.markupBps, s.markupBps),
    haggleDifficulty: blend(p.haggleDifficulty, s.haggleDifficulty),
    deceptionPenalty: blend(p.deceptionPenalty, s.deceptionPenalty),
    repeatBonus: blend(p.repeatBonus, s.repeatBonus),
  };
}
