import { dictionary } from '../vendor/cmu-pronouncing-dictionary.js';
import {
  CLIP_COLORS,
  DEFAULT_MASTER,
  EFFECT_PARAMS,
  SNAP_BEAT,
} from './constants.js';
import { makeId } from './id.js';

const BASE_LOOKUP = new Map();
const REVERSE_LOOKUP = new Map();
const REVERSE_LOOKUP_STRESSLESS = new Map();
const VOWEL_PHONEMES = new Set([
  'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY',
  'IH', 'IY', 'OW', 'OY', 'UH', 'UW', 'A', 'E', 'I', 'O', 'U',
]);
const PUNCTUATION_GAPS = new Map([
  [',', 0.5],
  [';', 0.75],
  [':', 0.75],
  ['.', 1],
  ['!', 1],
  ['?', 1],
]);

function normalizeProtocolForLookup(protocol) {
  return protocol.trim().replace(/\s+/gu, ' ');
}

function normalizeProtocolStressless(protocol) {
  return normalizeProtocolForLookup(protocol).replace(/[!']/gu, '');
}

function scoreReverseCandidate(word) {
  let score = word.length;
  if (!/^[a-z]+$/u.test(word)) score += 5;
  if (word.includes('\'')) score += 3;
  if (word.endsWith("'s")) score += 2;
  return score;
}

function maybeSetReverseLookup(map, key, word) {
  const existing = map.get(key);
  if (!existing || scoreReverseCandidate(word) < scoreReverseCandidate(existing)) {
    map.set(key, word);
  }
}

for (const [word, pronunciation] of Object.entries(dictionary)) {
  const base = word.replace(/\(\d+\)$/u, '');
  if (!BASE_LOOKUP.has(base)) {
    BASE_LOOKUP.set(base, pronunciation);
  }
  const protocol = pronunciationToProtocol(pronunciation);
  maybeSetReverseLookup(REVERSE_LOOKUP, normalizeProtocolForLookup(protocol), base);
  maybeSetReverseLookup(REVERSE_LOOKUP_STRESSLESS, normalizeProtocolStressless(protocol), base);
}

const GREEDY_DIGRAPHS = [
  ['tion', ['SH', 'AH', 'N']],
  ['sion', ['ZH', 'AH', 'N']],
  ['tch', ['CH']],
  ['igh', ['AY']],
  ['air', ['EH', 'R']],
  ['ear', ['IY', 'R']],
  ['ure', ['Y', 'UH', 'R']],
  ['ph', ['F']],
  ['ch', ['CH']],
  ['sh', ['SH']],
  ['th', ['TH']],
  ['ng', ['NG']],
  ['qu', ['K', 'W']],
  ['ck', ['K']],
  ['wh', ['W']],
  ['ee', ['IY']],
  ['ea', ['IY']],
  ['oo', ['UW']],
  ['oa', ['OW']],
  ['ow', ['AW']],
  ['ou', ['AW']],
  ['oi', ['OY']],
  ['oy', ['OY']],
  ['au', ['AO']],
  ['aw', ['AO']],
  ['ai', ['EY']],
  ['ay', ['EY']],
  ['er', ['ER']],
  ['ir', ['ER']],
  ['ur', ['ER']],
  ['ar', ['AA', 'R']],
  ['or', ['AO', 'R']],
];

const LETTER_MAP = {
  a: ['AE'],
  b: ['B'],
  c: ['K'],
  d: ['D'],
  e: ['EH'],
  f: ['F'],
  g: ['G'],
  h: ['HH'],
  i: ['IH'],
  j: ['JH'],
  k: ['K'],
  l: ['L'],
  m: ['M'],
  n: ['N'],
  o: ['AA'],
  p: ['P'],
  q: ['K'],
  r: ['R'],
  s: ['S'],
  t: ['T'],
  u: ['AH'],
  v: ['V'],
  w: ['W'],
  x: ['K', 'S'],
  y: ['Y'],
  z: ['Z'],
};

function snapBeat(value) {
  return Math.round(value / SNAP_BEAT) * SNAP_BEAT;
}

function countSyllables(phonemeString) {
  return phonemeString
    .split(/\s+/u)
    .filter((part) => VOWEL_PHONEMES.has(part.replace(/[!()+-].*$/u, '')))
    .length;
}

function pickColor(index) {
  return CLIP_COLORS[index % CLIP_COLORS.length];
}

function cleanWord(word) {
  return word
    .trim()
    .toLowerCase()
    .replace(/^[^a-z']+|[^a-z']+$/gu, '');
}

function pronunciationToProtocol(pronunciation) {
  return pronunciation
    .split(/\s+/u)
    .map((part) => {
      const match = part.match(/^([A-Z]+)([012])?$/u);
      if (!match) return part;
      const [, phoneme, stress] = match;
      return stress && stress !== '0' ? `${phoneme}!` : phoneme;
    })
    .join(' ');
}

function lookupPronunciation(word) {
  const normalized = cleanWord(word);
  if (!normalized) return '';
  return BASE_LOOKUP.get(normalized) ?? BASE_LOOKUP.get(normalized.replace(/'s$/u, ''));
}

function fallbackPronunciation(word) {
  const normalized = cleanWord(word);
  if (!normalized) return 'HH AH';
  const parts = [];
  let index = 0;
  while (index < normalized.length) {
    if (normalized[index] === '\'' && index < normalized.length - 1) {
      index += 1;
      continue;
    }
    const remaining = normalized.slice(index);
    let matched = false;
    for (const [chunk, phonemes] of GREEDY_DIGRAPHS) {
      if (remaining.startsWith(chunk)) {
        parts.push(...phonemes);
        index += chunk.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    const char = normalized[index];
    const next = normalized[index + 1] ?? '';
    if (char === 'c' && /[eiy]/u.test(next)) {
      parts.push('S');
    } else if (char === 'g' && /[eiy]/u.test(next)) {
      parts.push('JH');
    } else if (char === 'e' && index === normalized.length - 1 && parts.length > 0) {
      // Silent trailing e.
    } else {
      parts.push(...(LETTER_MAP[char] ?? ['AH']));
    }
    index += 1;
  }

  const firstVowelIndex = parts.findIndex((part) => VOWEL_PHONEMES.has(part));
  if (firstVowelIndex >= 0) {
    parts[firstVowelIndex] = `${parts[firstVowelIndex]}!`;
  }
  return parts.join(' ');
}

export function wordToProtocol(word) {
  const pronunciation = lookupPronunciation(word);
  return pronunciation ? pronunciationToProtocol(pronunciation) : fallbackPronunciation(word);
}

function prettifyFallbackLabel(protocol) {
  const parts = protocol
    .replaceAll('(', ' ')
    .replaceAll(')', ' ')
    .split(/\s+/u)
    .filter(Boolean)
    .map((part) => part.replace(/[!']/gu, '').replace(/[+-]\d+(?:\.\d+)?$/u, ''))
    .filter(Boolean);

  if (!parts.length) return 'imported word';
  return parts
    .slice(0, 3)
    .map((part) => part[0] + part.slice(1).toLowerCase())
    .join('-');
}

export function protocolToWordLabel(protocol) {
  const normalized = normalizeProtocolForLookup(protocol);
  const exact = REVERSE_LOOKUP.get(normalized);
  const stressless = REVERSE_LOOKUP_STRESSLESS.get(normalizeProtocolStressless(normalized));
  if (exact && stressless) {
    return scoreReverseCandidate(stressless) <= scoreReverseCandidate(exact) ? stressless : exact;
  }
  return exact ?? stressless ?? prettifyFallbackLabel(normalized);
}

export function sentenceToClips(sentence, master = DEFAULT_MASTER) {
  const tokens = sentence.match(/[A-Za-z']+|[.,!?;:]/gu) ?? [];
  const clips = [];
  let cursorBeat = 0;

  for (const token of tokens) {
    if (PUNCTUATION_GAPS.has(token)) {
      cursorBeat += PUNCTUATION_GAPS.get(token);
      continue;
    }
    const phonemes = wordToProtocol(token);
    const syllables = Math.max(1, countSyllables(phonemes));
    const rate = master.rate;
    const beatMs = 60000 / master.tempo;
    const clipMs = Math.max(rate * (phonemes.split(/\s+/u).length || 1), syllables * 120);
    const lengthBeats = snapBeat(Math.max(0.75, clipMs / beatMs));
    clips.push({
      id: makeId(),
      text: token,
      phonemes,
      startBeat: snapBeat(cursorBeat),
      lengthBeats,
      rateMs: rate,
      pitchOffset: 0,
      color: pickColor(clips.length),
      bank: master.bank,
      effects: {},
      automation: {},
    });
    cursorBeat += lengthBeats;
  }

  return clips;
}
