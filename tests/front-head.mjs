#!/usr/bin/env node
// What the front page's head asks of the host, read from dapp/index.html alone (no browser, no chain). The host sends the document first and everything the
// head names after it, so the first paint and the tile (the Swap card, which TAC is traded in) are only as early as the head lets them be:
//   1. nothing in the head holds the first paint: no stylesheet without a media query that keeps it back, no script that is not deferred, async or a module;
//   2. every module the page's own script imports statically is named in the head as a modulepreload (the script cannot start until they have all arrived, and
//      one the head leaves out is asked for only when the whole document has been read), and so is the swap card with the modules it imports, which the
//      script loads as soon as it has run;
//   3. the card's stylesheet, held back in the head, is let in by the script before it draws the tile;
//   4. the tile is a quiet skeleton from the first paint, in the height the card settles at, which the script's first draw replaces.
//
//   node tests/front-head.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DAPP = join(new URL('../', import.meta.url).pathname, 'dapp');
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const page = readFileSync(join(DAPP, 'index.html'), 'utf8');
const head = /<head>([\s\S]*?)<\/head>/.exec(page)[1], mod = /<script type="module">([\s\S]*?)<\/script>/.exec(page)[1];
const STATIC_IMPORT = /(?:^|[\n;}])\s*(?:import|export)\s*(?:[^'"();]*?\sfrom\s*)?(['"])([^'"]+)\1/g;

// 1. nothing holds the first paint
const sheets = [...head.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map((m) => m[0]);
ok(sheets.length > 0 && sheets.every((l) => /\bmedia="print"/.test(l)), `a stylesheet in the head is kept back with media="print" (${sheets.length} of them)`);
const scripts = [...head.matchAll(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/g)].map((m) => m[0]);
ok(scripts.length > 0 && scripts.every((t) => /\b(defer|async)\b|type="module"/.test(t)), `every script the head loads is deferred, async or a module (${scripts.length})`);
ok(/<script defer src="\/front-route\.js/.test(head), 'the routing script is deferred: it runs after the document and before the page\'s module, in that order');

// 2. the head names what the script imports, and the card
const named = new Set([...head.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1].split('?')[0]));
const statics = [...new Set([...mod.matchAll(STATIC_IMPORT)].map((m) => m[2]).filter((u) => u.startsWith('/')).map((u) => u.split('?')[0]))];
const missing = statics.filter((u) => !named.has(u) && !new RegExp(`<script[^>]*src="${u.replace(/\./g, '\\.')}`).test(head));
ok(statics.length > 20 && missing.length === 0, `the head names every module the page's script imports statically (${statics.length}; not named: ${missing.join(', ') || 'none'})`);
const card = readFileSync(join(DAPP, 'swap/card.js'), 'utf8');
const cardImports = [...new Set([...card.matchAll(STATIC_IMPORT)].map((m) => m[2]).filter((u) => u.startsWith('/')).map((u) => u.split('?')[0]))];
const cardMissing = ['/swap/card.js', ...cardImports].filter((u) => !named.has(u));
ok(named.has('/swap/card.js') && cardMissing.length === 0, `and the swap card with the modules it imports (${cardImports.length + 1}; not named: ${cardMissing.join(', ') || 'none'})`);
ok(/import\('\/swap\/card\.js/.test(mod), 'which the page\'s script loads as its first tab (a card file that moved would leave a stale head)');

// 3. the card's stylesheet comes in before the tile is drawn
const first = mod.search(/\bfunction paintHx\b|\bpaintHx\(\)/);
const flip = mod.search(/\[href\^="\/swap\/card\.css"\]'\)\?\.setAttribute\('media', 'all'\)/);
ok(flip > 0 && flip < first, 'the script lets the card\'s stylesheet in before its first draw of the tile');

// 4. the skeleton
ok(/<div id="hx-body"><div class="hx-sk" aria-hidden="true">/.test(page), 'the tile is a skeleton from the first paint, hidden from a screen reader');
const held = [...page.matchAll(/(?:@media \(max-width: (\d+)px\) \{ )?\.hx:has\(#hx-body:empty\), \.hx:has\(#hx-body > \.hx-sk\) \{ min-height: (\d+)px; \}/g)].map((m) => `${m[1] || 'any'}:${m[2]}`);
ok(held.join(' ') === 'any:537 640:529 380:544 330:560', `and holds the height the card settles at, at each width (${held.join(' ')}; tests/front-tile-height.mjs measures it in a browser)`);
ok(/<i class="f"><\/i><i class="f"><\/i><i class="p"><\/i><i class="g"><\/i>/.test(page), 'and has a place for each block of the card: two fields, the block under them, the button');

// 5. what the script does before it draws the tile leaves out what it can: the airdrop's closing day is written by hand, since the first toLocaleDateString of a locale
//    takes tens of milliseconds there (84 on a throttled phone, the most of any one thing the script does before the tile)
{
  const src = /const DAY_MONTHS = \[[^\]]*\];\nconst dayFmt = [^\n]*/.exec(mod)?.[0];
  ok(!!src && !/toLocaleDateString|Intl\./.test(src), 'the page writes a day by hand: dayFmt takes no Intl');
  if (src && Intl.DateTimeFormat.supportedLocalesOf('en-GB').length) {
    const dayFmt = new Function(`${src}; return dayFmt;`)();
    let bad = 0, count = 0;
    for (let sec = 1.5e9; sec < 2.2e9; sec += 86400 * 7 + 3600 * 5 + 17) { count++; if (dayFmt(sec) !== new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })) bad++; }
    ok(bad === 0 && dayFmt(NaN) === 'Invalid Date', `and writes a day as en-GB does, in this zone (${count} days, ${bad} written differently)`);
  }
}

console.log(`\n${fails ? `${fails} FAILED, ${n} ok` : `${n} front-head checks passed`}`);
process.exit(fails ? 1 : 0);
