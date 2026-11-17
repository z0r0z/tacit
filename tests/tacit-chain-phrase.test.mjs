// A PQ ID's backup phrase (dapp/tacit-chain-phrase.js): the root as 24 BIP39 words, checked against the BIP39 reference vectors for 256-bit
// entropy, read back from any case and spacing and from four-letter prefixes, and refused with a plain reason when a word or the count is wrong.
//   node tests/tacit-chain-phrase.test.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { rootToPhrase, phraseToRoot } from '../dapp/tacit-chain-phrase.js';
import { WORDS } from '../dapp/vendor/bip39-english.js';

const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
let n = 0;
const ok = (c, s) => { assert.ok(c, s); n++; console.log('  ok   ' + s); };

ok(createHash('sha256').update(WORDS.join('\n') + '\n').digest('hex') === '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda', 'the wordlist is BIP39\'s English list, byte for byte');

// the BIP39 reference vectors (trezor/python-mnemonic vectors.json), 32-byte entropy
const VECTORS = [
  ['00'.repeat(32), `${'abandon '.repeat(23)}art`],
  ['7f'.repeat(32), 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title'],
  ['80'.repeat(32), 'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless'],
  ['ff'.repeat(32), `${'zoo '.repeat(23)}vote`],
];
for (const [e, words] of VECTORS) {
  ok(rootToPhrase(hex(e)) === words, `${e.slice(0, 4)}… writes as the reference phrase`);
  ok(Buffer.from(phraseToRoot(words)).toString('hex') === e, `and the phrase reads back as ${e.slice(0, 4)}…`);
}
let round = true;
for (let i = 0; i < 500; i++) { const r = Uint8Array.from(randomBytes(32)); if (Buffer.compare(Buffer.from(phraseToRoot(rootToPhrase(r))), Buffer.from(r))) round = false; }
ok(round, '500 random roots read back as written');

const p = rootToPhrase(hex('7f'.repeat(32)));
ok(Buffer.from(phraseToRoot(`  ${p.toUpperCase().replace(/ /g, ',\n  ')} `)).toString('hex') === '7f'.repeat(32), 'any case, commas and line breaks');
ok(Buffer.from(phraseToRoot(p.split(' ').map((w) => w.slice(0, 4)).join(' '))).toString('hex') === '7f'.repeat(32), 'four-letter prefixes are enough');
assert.throws(() => phraseToRoot(p.split(' ').slice(0, 23).join(' ')), /24 words; this has 23/); ok(true, 'a missing word is named as a count');
assert.throws(() => phraseToRoot(p.replace('legal', 'legxl')), /Word 1 .*legxl/); ok(true, 'a word not on the list is named by its place');
assert.throws(() => phraseToRoot(p.replace(/title$/, 'wrong')), /check does not match/); ok(true, 'a wrong word on the list fails the check');
assert.throws(() => rootToPhrase(new Uint8Array(31)), /32 bytes/); ok(true, 'only a 32-byte root is written');
console.log(`${n} ok`);
