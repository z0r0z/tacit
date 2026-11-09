// Input guard: does this text look like a wallet recovery phrase or a raw private key? Deterministic, never left to the model.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIP39 = new Set(readFileSync(path.join(HERE, 'bip39-english.txt'), 'utf8').split(/\s+/).filter(Boolean));
const KEY_RE = /\b(?:0x)?[0-9a-fA-F]{64}\b/;
// 12 consecutive words of which at least 11 are BIP-39 words (one typo allowed). Plain sentences have many non-list words (the, does, from, ...).
export function looksLikeSeed(text) {
  const w = (String(text).toLowerCase().match(/[a-z]+/g) || []);
  for (let i = 0; i + 12 <= w.length; i++) { let n = 0; for (let j = i; j < i + 12; j++) if (BIP39.has(w[j])) n++; if (n >= 11) return true; }
  return false;
}
export const looksLikeSecret = (text) => looksLikeSeed(text) || KEY_RE.test(text);
