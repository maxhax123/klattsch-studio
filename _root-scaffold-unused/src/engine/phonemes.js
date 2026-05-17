// Backward-compatible re-export of the default English bank for legacy
// importers. New code should pass `opts.bank` to the compiler.

import { banks } from './banks/index.js';

const englishBank = banks.get(banks.defaultName);

export const phonemes = Object.freeze(englishBank.phonemes);

export const PHONEME_KEYS = Object.keys(phonemes).filter(
  (k) => !k.startsWith('_'),
);
