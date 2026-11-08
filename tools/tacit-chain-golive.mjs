#!/usr/bin/env node
// Turns the tacit chain on in the app once its contracts are deployed: where it is (TACIT_CHAIN in dapp/tacit-chain-config.js, and every page's
// own copy of it, TACIT_CHAIN_PAGE), and its leader's origin in the connect-src of every page that talks to the leader. Then the build (which
// rewrites the tokens and the front page's inline-script hash) and the check that the copies agree.
//
//   node tools/tacit-chain-golive.mjs --blocks 0x… --leader https://…            write, build, check
//   node tools/tacit-chain-golive.mjs --blocks 0x… --leader https://… --dry-run  say what would change, change nothing
//   --root <dir>  the checkout to change (default: this one), e.g. a copy to try it on
//
// The leader must be https. A leader set before is taken out of connect-src when another replaces it.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const DRY = argv.includes('--dry-run');
const ROOT = arg('--root') || join(dirname(fileURLToPath(import.meta.url)), '..');
const DAPP = join(ROOT, 'dapp');
const CONFIG = join(DAPP, 'tacit-chain-config.js');
// the pages that talk to the leader: the front page (the tile's chain moves, and TAC's page, /tac/, which the build makes from it)
const LEADER_PAGES = ['index.html'];

const die = (m) => { console.error(`tacit-chain-golive: ${m}`); process.exit(1); };
const blocks = arg('--blocks'), leaderIn = arg('--leader');
if (!blocks || !/^0x[0-9a-fA-F]{40}$/.test(blocks) || /^0x0{40}$/.test(blocks)) die('--blocks must be the TacitBlocks address (0x and 40 hex digits)');
let url;
try { url = new URL(leaderIn || ''); } catch { die('--leader must be a URL, https://…'); }
if (url.protocol !== 'https:') die(`the leader must be https (got ${url.protocol.replace(/:$/, '')})`);
if (url.username || url.password || url.search || url.hash) die('the leader is a plain https URL: no credentials, query or fragment');
const leader = (url.origin + url.pathname).replace(/\/+$/, '');
const origin = url.origin;

const read = (f) => readFileSync(f, 'utf8');
const lit = (v) => `{ blocks: '${v.blocks}', leader: '${v.leader}' }`;
const want = { blocks, leader };
const changes = [];
const put = (file, before, after, what) => { if (before !== after) changes.push({ file, after, what }); };

// the config, and the leader it named before
const cfgText = read(CONFIG), cfgRe = /export const TACIT_CHAIN = \{[^}]*\};/;
if (!cfgRe.test(cfgText)) die(`${relative(ROOT, CONFIG)} has no TACIT_CHAIN`);
const oldLeader = (/leader:\s*'([^']*)'/.exec(cfgText.match(cfgRe)[0]) || [])[1] || null;
const oldOrigin = oldLeader ? (() => { try { return new URL(oldLeader).origin; } catch { return null; } })() : null;
put(CONFIG, cfgText, cfgText.replace(cfgRe, `export const TACIT_CHAIN = ${lit(want)};`), `TACIT_CHAIN = ${lit(want)}`);

// every page's own copy, wherever one is kept
const html = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = join(d, n), s = statSync(p);
    if (s.isDirectory()) walk(p); else if (n.endsWith('.html')) html.push(p);
  }
})(DAPP);
const pageRe = /var TACIT_CHAIN_PAGE = \{[^}]*\};/;
const texts = new Map(html.map((f) => [f, read(f)]));
for (const [f, t] of texts) if (pageRe.test(t)) texts.set(f, t.replace(pageRe, `var TACIT_CHAIN_PAGE = ${lit(want)};`));
if (![...texts.values()].some((t) => t.includes(`var TACIT_CHAIN_PAGE = ${lit(want)};`))) die('no page keeps a TACIT_CHAIN_PAGE copy (the front page should)');

// the leader's origin in connect-src (an older leader's taken out)
for (const rel of LEADER_PAGES) {
  const f = join(DAPP, rel);
  if (!texts.has(f)) die(`${rel} is missing`);
  const t = texts.get(f), m = /(<meta http-equiv="Content-Security-Policy" content="[^"]*?connect-src )([^;"]+)/.exec(t);
  if (!m) die(`${rel} has no connect-src in its Content-Security-Policy`);
  let list = m[2].trim().split(/\s+/);
  if (oldOrigin && oldOrigin !== origin) list = list.filter((x) => x !== oldOrigin);
  if (!list.includes(origin)) list.push(origin);
  texts.set(f, t.slice(0, m.index) + m[1] + list.join(' ') + t.slice(m.index + m[0].length));
}
for (const f of html) {
  const before = read(f), after = texts.get(f);
  const csp = LEADER_PAGES.some((r) => join(DAPP, r) === f) ? `connect-src + ${origin}${oldOrigin && oldOrigin !== origin ? `, - ${oldOrigin}` : ''}` : null;
  put(f, before, after, [pageRe.test(before) ? 'TACIT_CHAIN_PAGE' : null, csp].filter(Boolean).join(', '));
}

console.log(`tacit chain: blocks ${blocks}, leader ${leader}${oldLeader && oldLeader !== leader ? ` (was ${oldLeader})` : ''}`);
if (!changes.length) console.log('nothing to change: already live with these');
for (const c of changes) console.log(`${DRY ? 'would change' : 'changed'} ${relative(ROOT, c.file)}: ${c.what}`);
if (DRY) { console.log('dry run: nothing written, no build run'); process.exit(0); }
for (const c of changes) writeFileSync(c.file, c.after);

// the build rewrites the tokens and the front page's inline-script hash; then the copies must agree and the leader be allowed
const run = (file, args = []) => execFileSync(process.execPath, [file, ...args], { cwd: ROOT, stdio: 'inherit' });
run(join(ROOT, 'build/build.mjs'));
run(join(ROOT, 'build/build.mjs'), ['--verify-only']);
run(join(ROOT, 'tests/tacit-chain-page.test.mjs'));
console.log('tacit chain is on: review the diff, then commit and push the dapp (it deploys on push)');
