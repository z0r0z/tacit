// A PQ ID's backup phrase: its 32-byte root written as 24 BIP39 words (the root, then the first byte of its SHA-256 as a check, in 11-bit words).
// The phrase is the root itself, so it opens the PQ ID's TAC on any device with no passkey, and nothing needs to be stored anywhere to make it.
import { sha256 } from './vendor/tacit-deps.min.js';
import { WORDS } from './vendor/bip39-english.js';

const INDEX = new Map(WORDS.map((w, i) => [w, i]));

// root (32 bytes) → 24 words, space-separated
export function rootToPhrase(root) {
  if (!(root instanceof Uint8Array) || root.length !== 32) throw new Error('tacit chain: a root is 32 bytes');
  const bits = [...root, sha256(root)[0]].map((b) => b.toString(2).padStart(8, '0')).join('');
  return Array.from({ length: 24 }, (_, i) => WORDS[parseInt(bits.slice(11 * i, 11 * i + 11), 2)]).join(' ');
}

// 24 words (any case and spacing; a word's first four letters are enough) → the root, or a plain error saying what is wrong
export function phraseToRoot(text) {
  const words = String(text || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.length !== 24) throw new Error(`A backup phrase is 24 words; this has ${words.length}.`);
  const idx = words.map((w, i) => {
    const at = INDEX.get(w) ?? (w.length >= 4 ? WORDS.findIndex((x) => x.startsWith(w.slice(0, 4))) : -1);
    if (at < 0) throw new Error(`Word ${i + 1} (“${w}”) is not a backup phrase word.`);
    return at;
  });
  const bits = idx.map((n) => n.toString(2).padStart(11, '0')).join('');
  const root = Uint8Array.from({ length: 32 }, (_, i) => parseInt(bits.slice(8 * i, 8 * i + 8), 2));
  if (parseInt(bits.slice(256), 2) !== sha256(root)[0]) throw new Error('That phrase has a word wrong: its check does not match.');
  return root;
}
