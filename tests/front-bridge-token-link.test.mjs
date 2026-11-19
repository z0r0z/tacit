// The front page opens a token's bridge from a link (dapp/index.html: the #card= grammar and hxPreset), which the bridge page's "Another token" button goes to.
//
// 2026-11-19: the bridge page can now start a crossing of any ERC-20, and its button links to #card=bridge:xw0x… (from the wallet to Bitcoin) or #card=bridge:xb0x… (back from Bitcoin).
// The front page knew those keys once it had met the token (HX_BR has xw, xp and xb), but its link grammar took only the built-in letter keys, and the "met by its address" check knew
// xw and xp, not xb. A mixed-case address in a link is lower-cased, as the Shield link's is.
//
// Run: node tests/front-bridge-token-link.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp/index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = (label, fn) => { try { fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; } };

const line = page.split('\n').find((l) => l.includes('const card = h.match(/^card='));
ok(line, 'the card link grammar is not where it was');
const re = new Function(`return ${/h\.match\((\/\^card=.*\/)\);?\s*$/.exec(line)[1]};`)();
const JPYC = '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29';

test('a link to a token\'s bridge to Bitcoin (xw) or back from it (xb) is taken, whatever the case of the address', () => {
  for (const k of ['xw', 'xb']) for (const a of [JPYC, JPYC.toUpperCase().replace('0X', '0x')]) {
    const m = re.exec(`card=bridge:${k}${a}`);
    ok(m && m[1] === `bridge:${k}${a}`, `${k}${a} not taken: ${m && m[1]}`);
  }
  const m = re.exec(`card=bridge:xw${JPYC}&amt=1.5`);
  ok(m && m[1] === `bridge:xw${JPYC}` && m[3] === '1.5', 'an amount is still read after it');
});

test('what was taken before still is, and what is not a token address is not', () => {
  for (const ok_ of ['card=bridge', 'card=bridge:btc', 'card=bridge:kb', 'card=bridge:tb', 'card=bridge:cbtc', 'card=bridge:ut', `card=shield:${JPYC}`, 'card=swap', 'card=earn:ether:spx']) ok(re.test(ok_), `${ok_} stopped matching`);
  // (a bare `bridge:xw` is a letter key of the old grammar, which hxPreset ignores as it is no key of HX_BR: it is not a token's address and never opened a bridge)
  for (const bad of ['card=bridge:xw0x1234',`card=bridge:xz${JPYC}`, `card=bridge:xp${JPYC}`, `card=bridge:xw${JPYC}00`, `card=bridge:xw${JPYC.slice(0, -1)}g`, `card=bridge:x${JPYC}`]) {
    const m = re.exec(bad);
    ok(!m || !m[1].startsWith('bridge:x') || m[0] !== bad, `${bad} was taken as a token's bridge (${m && m[1]})`);
  }
});

test('the link is lower-cased on the way to the card, as the Shield link\'s address is', () => {
  ok(/card\[1\]\.startsWith\('bridge:x'\) \? card\[1\]\.toLowerCase\(\)/.test(page), 'a mixed-case address would not find its token\'s keys (they are lower case)');
});

test('a token named by its bridge key is met by its address: xw and xp as before, xb through the same address', () => {
  const src = page.split('\n').find((l) => l.includes('const met = /^x[wpb]0x[0-9a-f]{40}$/'));
  ok(src, 'the met check does not know xb');
  const xtAddr = (k) => { const m = /^(?:xw|xp|x:)?(0x[0-9a-f]{40})$/.exec(String(k || '').toLowerCase()); return m ? m[1] : null; };   // the page's own (index.html xtAddr)
  const real = page.split('\n').find((l) => l.startsWith('const xtAddr = '));
  ok(real && /\(\?:xw\|xp\|x:\)\?/.test(real), 'xtAddr changed: this test\'s copy is stale');
  const met = new Function('xtAddr', 'a', `${src.trim().replace(/^const met = /, 'return ')}`);
  for (const k of ['xw', 'xp', 'xb']) ok(met(xtAddr, `${k}${JPYC}`) === JPYC, `${k} not met by its address`);
  for (const bad of ['xz' + JPYC, 'bridge', 'btc', JPYC.replace('0x', 'xw0x') + '0', undefined]) ok(met(xtAddr, bad) === null, `${bad} was taken for a token`);
});

test('a token\'s bridge links (Activity, notices, bring-back) open its card, which openLink hands to the hash route', () => {
  ok(/const xoLink = \(a\) => \(a\?\.runtime \? `card=bridge:xw\$\{a\.key\.slice\(1\)\}`/.test(page), 'xoLink');
  ok(/const brBack = \(k\) => \(XA\[k\]\?\.runtime \? `card=bridge:xb\$\{k\.slice\(1\)\}`/.test(page), 'brBack');
  ok(/openLink\(xaOf\(rec\)\?\.runtime \? xoLink\(xaOf\(rec\)\)/.test(page), 'the minted notice');
  ok(/if \(head\.startsWith\('card='\)\) \{ location\.hash = h; return; \}/.test(page), 'openLink does not pass a card link on');
  ok(/dec: r\.tdec, addr: r\.addr \}\)/.test(page), 'the front page\'s own route has no address');
});

test('a token held at Taproot is listed under Bitcoin in Send (xtTaprootHeld) and read when Send opens (xtCrossedRead)', () => {
  ok(/\|\| xtTaprootHeld\(r\)\)\)\.map\(\(r\) => \[`xb\$\{r\.addr\}`/.test(page), 'xtSends does not ask xtTaprootHeld');
  ok(/if \(S\.key && HX\.tab === 'send'\) xtCrossedRead\(\);/.test(page), 'hxWarmBals does not start the read');
  ok(/'tk btc'/.test(page) && /\.coin \.tk\.btc, \.pk-r \.tk\.btc \{ border-radius: 50%; outline: 1\.5px solid var\(--orange\)/.test(page), 'the Bitcoin ring');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
