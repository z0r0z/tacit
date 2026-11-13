// The settle relay keeps its own copy of the proof pool's reading of a wrap (worker-relay/src/lib/wrap-expect.js), because its image holds only its own directory. The
// copy must stay the pool's code exactly, and read every input and every proof the same way.
//   node tests/wrap-expect-parity.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as pool from '../worker/src/proof-pool.js';
import * as relay from '../worker-relay/src/lib/wrap-expect.js';

let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };
const poolSrc = readFileSync(new URL('../worker/src/proof-pool.js', import.meta.url), 'utf8');
const relaySrc = readFileSync(new URL('../worker-relay/src/lib/wrap-expect.js', import.meta.url), 'utf8');
// from the comment block above readWrapStdin to the end of proofFits
const slice = (src, endMarker) => {
  const lines = src.slice(0, src.indexOf('export function readWrapStdin')).split('\n');
  let j = lines.length - 2; while (j >= 0 && lines[j].startsWith('//')) j--;
  const start = lines.slice(0, j + 1).reduce((a, l) => a + l.length + 1, 0);
  const end = endMarker ? src.indexOf(endMarker) : src.length;
  return src.slice(start, end).trimEnd();
};
ok(slice(poolSrc, '// abi.encode for the SP1 verifier') === slice(relaySrc, null), 'the relay\'s copy is the pool\'s readWrapStdin, wrapExpect and proofFits, character for character');
ok(!/^import .*from '\.\.?\//m.test(relaySrc.replace(/from '@noble/g, '')) || !/from '\.\.\//.test(relaySrc), 'and it imports nothing from outside the relay\'s own directory');

const BIN = new Uint8Array(readFileSync(new URL('./fixtures/sp1-stdin/wrap.bin', import.meta.url)));
const same = (f, ...a) => { const run = (m) => { try { return JSON.stringify(m[f](...a), (_k, v) => (v instanceof Uint8Array ? [...v] : v)); } catch (e) { return `throws: ${e.message}`; } }; return run(pool) === run(relay); };
ok(same('readWrapStdin', BIN), 'a real wrap input reads the same');
ok(same('readWrapStdin', BIN.subarray(0, 100)) && same('readWrapStdin', new Uint8Array(0)) && same('readWrapStdin', new Uint8Array([1, 2, 3])), 'a short or empty input fails the same way');
const flipped = (i) => { const b = new Uint8Array(BIN); b[i] ^= 0xff; return b; };
ok([8, 20, 100, 200, 300, BIN.length - 9].every((i) => same('readWrapStdin', flipped(i))), 'an input with a byte changed reads, or fails, the same');
const e = pool.wrapExpect(pool.readWrapStdin(BIN));
ok(JSON.stringify(e) === JSON.stringify(relay.wrapExpect(relay.readWrapStdin(BIN))), 'the expected deposit, leaf, chain binding and memo root are the same');
const word = (x) => BigInt(x).toString(16).padStart(64, '0');
const LISTS = new Set([3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 17, 18, 19, 22, 23, 24, 25, 26, 28, 29, 30]);
const pv = (o = {}) => {
  const x = { leaves: [e.leaf], deposits: [e.depositId], chainBinding: e.chainBinding, memoRoot: e.memoRoot, fields: {}, ...o };
  const head = [], tail = [];
  for (let f = 0; f < 31; f++) {
    if (!LISTS.has(f)) { head.push(word(x.fields[f] ?? (f === 0 ? 1 : f === 1 ? x.chainBinding : f === 27 ? x.memoRoot : 0))); continue; }
    const items = f === 4 ? x.leaves : f === 5 ? x.deposits : [];
    head.push(word(32 * (31 + tail.length))); tail.push(word(items.length), ...items.map(word));
  }
  return '0x' + word(32) + head.join('') + tail.join('');
};
const O = '0x' + 'cd'.repeat(32);
const variants = [pv(), pv({ leaves: [O] }), pv({ deposits: [O] }), pv({ deposits: [e.depositId, O] }), pv({ chainBinding: O }), pv({ memoRoot: O }), pv({ fields: { 2: O } }), pv({ fields: { 11: O } }), '0x1234', 'nope', ''];
ok(pool.wrapPublicValues(e) === relay.wrapPublicValues(e) && pool.wrapPublicValues(e) === pv(), 'the full public values of a wrap are written the same');
ok(variants.every((v) => pool.proofFits(v, e) === relay.proofFits(v, e)), 'every proof, fitting or not, is judged the same');
ok(pool.proofFits(pv(), e) === true && pool.proofFits(pv({ chainBinding: O }), e) === false, 'and the fit is what it should be: the job\'s own passes, another chain\'s does not');
console.log(`all ${n} ok`);
