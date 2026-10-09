// Checks the TAC "Bridge to Ethereum" UI (Holdings tab, dapp/classic.html + dapp/tacit.js) in a real browser.
// Unlike tests/burndep-ux.test.mjs (which drives dapp/burndep-ux.js directly, headless, no DOM), this exercises
// the actual click path: the note picker's eligible/ineligible rendering, the review panel, the irreversibility
// gate, and the first real broadcast — catching DOM-wiring bugs (wrong selector, a handler that never fires,
// a CSP block) that a unit test structurally cannot see. The Bitcoin/worker/MARA network surface is stubbed
// (signet has no anvil-equivalent local fork), so this is a wiring check, not a cryptographic one — the 48
// checks in tests/burndep-ux.test.mjs already cover the state machine itself against the same stub shapes.
//
//   PLAYWRIGHT=<path to playwright-core> node tools/bridge-eth-check.mjs   (SHOTS=<dir> saves screenshots)

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import * as secp from '@noble/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
const WEB = 21000 + Math.floor(Math.random() * 2000);
const ROOT = `http://127.0.0.1:${WEB}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const hex = (b) => Buffer.from(b).toString('hex');
const stripHex = (h) => String(h).replace(/^0x/, '');
const revHex = (h) => stripHex(h).match(/../g).reverse().join('');
const wpkhSpkHex = (pub) => '0014' + hex(ripemd160(sha256(pub)));

let fails = 0;
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };

// ---- fixtures: a real key/pubkey/script, and synthetic (never-real) outpoints ----
const WALLET_PRIV = 'b71d9e'.padEnd(64, '4');
const WALLET_PUB = secp.getPublicKey(WALLET_PRIV, true);
const OWN_SPK = wpkhSpkHex(WALLET_PUB);
const TAC_ASSET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const NOTE_TXID = '5e'.repeat(31) + '01';           // eligible, under the 1,000 TAC cap
const OVERCAP_TXID = '5e'.repeat(31) + '02';        // never fetched: preflight's cap check returns before any lookup
const FUND_TXID = '61'.repeat(32);
const BURN_HOME_LEAF_TXID = 'bb'.repeat(32);        // the one-hop cxfer the trace stub returns

// ---- local server: dapp/ static files + the worker paths the flow needs (this IS __TACIT_WORKER_BASE__) ----
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css' };
const server = createServer((req, res) => {
  const u = new URL(req.url, ROOT);
  const json = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };

  if (u.pathname === `/chain/tx/${NOTE_TXID}`) {
    return json({ status: { confirmed: true, block_height: 900 }, vout: [{ scriptpubkey: OWN_SPK }, { scriptpubkey: OWN_SPK }] });
  }
  // The attested reflection state the app checks a note against before bridging it: past the note's block, tracking
  // nothing, so the note takes the burn-deposit path this check drives.
  if (u.pathname === '/reflection/dump') {
    return json({ attestedHeight: 1000, snapshot: { height: 1000, noteLeaves: [], liveTriples: [], spentLinks: [], burnNodes: [], pendingDepositRecords: [] } });
  }
  if (u.pathname === '/reflection/burndep/trace') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => json({
      ok: true, hops: 1,
      bundle: { etch: { tx: '0x00', blockHash: 'aa'.repeat(32) }, cxfers: [{ tx: '0x00', txid: '0x' + BURN_HOME_LEAF_TXID, inputs: [{ prevTxid: '0x' + NOTE_TXID, prevVout: 0 }], outputs: [], rangeProof: '0x', kernelSig: '0x' }] },
    }));
    return;
  }
  if (req.method === 'POST') { req.on('data', () => {}); req.on('end', () => json({ ok: true })); return; } // any other worker POST this flow might hit

  let f = normalize(join(DAPP, decodeURIComponent(u.pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  // Background/unrelated worker reads this check doesn't stub by name (market ticker, recent-etches registry,
  // health, points, …) get an empty-but-valid JSON body instead of a 404 — several of these code paths call
  // .json() unconditionally and throw on an empty 404 body, which would otherwise fail the page for reasons
  // that have nothing to do with the bridge flow this check exercises.
  if (!existsSync(f)) return json({});
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // getUtxos()/getFeeRate() (plain-sats funding + fee estimate) go straight to mempool.space/blockstream.info,
  // never through the worker — real esplora hosts, stubbed here since these outpoints don't exist on any chain.
  await ctx.route(/^https:\/\/(mempool\.space|blockstream\.info)\/signet\/api\/address\/.*\/utxo$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ txid: FUND_TXID, vout: 0, value: 30000, status: { confirmed: true } }]) }));
  await ctx.route(/^https:\/\/(mempool\.space|blockstream\.info)\/signet\/api\/v1\/fees\/recommended$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ fastestFee: 5, halfHourFee: 3, hourFee: 2, economyFee: 1, minimumFee: 1 }) }));
  await ctx.route(/^https:\/\/(mempool\.space|blockstream\.info)\/signet\/api\/fee-estimates$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ '1': 5, '2': 4, '3': 3, '6': 2 }) }));
  await ctx.route(/^https:\/\/(mempool\.space|blockstream\.info)\/signet\/api\/blocks\/tip\/height$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '1000' }));
  await ctx.route(/^https:\/\/(mempool\.space|blockstream\.info)\/signet\/api\/tx$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: 'cc'.repeat(32) }));
  await ctx.route(/^https:\/\/(mempool\.space|blockstream\.info)\/signet\/api\/address\/[^/]+$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ chain_stats: { tx_count: 1 }, mempool_stats: { tx_count: 0 } }) }));
  // Background BTC/USD price ticker — unrelated to the bridge flow, stubbed only to keep it from spamming
  // CORS console errors (these hosts aren't routed for a real response in this local, non-CSP dev server).
  await ctx.route(/^https:\/\/(api\.coingecko\.com|api\.coinbase\.com|mempool\.space\/api\/v1\/prices)/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bitcoin: { usd: 60000 }, data: { amount: '60000' }, USD: { last: 60000 } }) }));
  await ctx.route('https://slipstream.mara.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ market_rate: 2, effective_rate: 3, submit_fee_rate: 3, multiplier: 1, discounted_multiplier: 1, multiplier_discount_percent: 0, slipstream_rate: 3 }),
  }));

  // __TACIT_NO_INIT__ is deliberately NOT set: it skips the whole init() bootstrap (dapp/tacit.js ~78447),
  // including the .tab click wiring this check needs — not just the welcome modal. The welcome modal is
  // dismissed directly below instead, right after it would have appeared.
  await ctx.addInitScript((workerBase) => {
    globalThis.__TACIT_WORKER_BASE__ = workerBase;
    localStorage.setItem('tacit-network-v1', 'signet');
    localStorage.setItem('tacit-onboarded-v1', '1');
    localStorage.setItem('tacit-active-mode-v1', 'local');
    // isOnboarded() alone doesn't keep the welcome modal from reappearing later in this flow (some path shows
    // it again after the initial dismissal, independent of that flag) — force it hidden every time something
    // flips its display back on, for as long as the page lives, rather than chase each trigger individually.
    const keepHidden = () => { const m = document.getElementById('welcome-modal'); if (m && m.style.display !== 'none') m.style.display = 'none'; };
    new MutationObserver(keepHidden).observe(document, { attributes: true, attributeFilter: ['style'], subtree: true, childList: true });
    document.addEventListener('DOMContentLoaded', keepHidden);
  }, ROOT);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.message} @ ${(e.stack || '').split('\n').slice(1, 3).map((s) => s.trim()).join(' < ')}`));
  const NOISE = /kraken\.com|coingecko\.com|cloudflare-eth\.com|sepolia|coinbase\.com/;
  // A public RPC that refuses this local origin (CORS) says so on the console too: the same hosts are noise there.
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text()) && !NOISE.test(m.text())) errors.push('console: ' + m.text()); });
  // ERR_ABORTED on a redundant fallback source (getFeeRate races mempool.space + blockstream.info, keeps
  // whichever answers first) is the browser cancelling the loser, not a real failure — the flow only cares
  // that ONE of them answers, which the assertions below already depend on succeeding.
  page.on('requestfailed', (r) => { if (!NOISE.test(r.url()) && r.failure()?.errorText !== 'net::ERR_ABORTED') errors.push('reqfail: ' + r.url() + ' ' + (r.failure()?.errorText || '')); });
  page.on('response', (r) => { if (r.status() >= 400 && !NOISE.test(r.url())) errors.push('http' + r.status() + ': ' + r.url()); });
  const until = (fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout });
  const shot = (name) => SHOTS ? page.screenshot({ path: join(SHOTS, `bridge-${name}.png`) }) : null;

  await page.goto(ROOT + '/classic.html');
  await page.waitForSelector('#toast-container', { state: 'attached' });
  // A fresh, wallet-less visitor gets the welcome/onboarding modal from init() — dismiss it directly rather
  // than clicking through its own flow, since _passphraseModal refuses to stack on top of it (dapp/tacit.js
  // ~1030) and setPriv below needs to open cleanly.
  await page.evaluate(() => { const m = document.getElementById('welcome-modal'); if (m) m.style.display = 'none'; });

  // amm-farm-ui.js imports tacit.js by bare path, so the page ends up with a second, disconnected module
  // instance — tab click handlers get wired by whichever copy's own setupTabs() ran last (tools/weld-check.mjs's
  // `mainbond` scenario hit the exact same thing). Set up BOTH the entry-point instance and the bare-path one,
  // so this works regardless of which one the Holdings tab's click handler is actually bound to.
  const instanceSrc = (which) => which === 'entry'
    ? `document.querySelector('script[type="module"][src*="tacit.js"]').src`
    : `new URL('/tacit.js', location.href).href`;
  const pass = 'correct horse battery staple';
  let pubHexFromPage = null;
  for (const which of ['entry', 'bare']) {
    const unlocking = page.evaluate(async ([h, pubHex, srcExpr, first]) => {
      const src = new Function('return ' + srcExpr)();
      const T = await import(src);
      const bytes = (x) => Uint8Array.from(x.match(/../g), (b) => parseInt(b, 16));
      // The first copy saves the key through setPriv; the second finds it saved, and tacit.js rightly refuses to save over a
      // wallet it has not opened, so that copy takes the same key directly.
      if (!T.wallet.priv) { if (first) await T.wallet.setPriv(h); else { T.wallet.priv = bytes(h); T.wallet.pub = bytes(pubHex); } }
      return Array.from(T.wallet.pub, (x) => x.toString(16).padStart(2, '0')).join('');
    }, [WALLET_PRIV, hex(WALLET_PUB), instanceSrc(which), which === 'entry']);
    const modalShown = await page.waitForSelector('#pass-modal #pass-input-1', { state: 'visible', timeout: 15000 }).then(() => true, () => false);
    if (modalShown) { await page.fill('#pass-input-1', pass); await page.fill('#pass-input-2', pass); await page.click('#pass-submit'); }
    pubHexFromPage = await unlocking.catch((e) => e.message);
  }
  ok(pubHexFromPage === hex(WALLET_PUB), `unlock: the test key opens through tacit.js's own wallet.setPriv (${pubHexFromPage})`);

  // Skip the "back up your key" modal (ensureBurnerBackedUp checks BACKUP_ACK_PREFIX + hex(wallet.pub) —
  // seeding both with/without 0x since bytesToHex's exact convention isn't asserted here) and override
  // scanHoldings() outright (_testSetScanHoldingsOverride) rather than seed _holdingsCache: the real scan
  // path re-triggers itself in the background even after a fresh cache hit (the "re-scanning in background"
  // snapshot behavior — dapp/tacit.js ~59872), which raced and clobbered a plain cache injection here with a
  // real, unstubbed scan that hung. The override intercepts every call, so nothing real ever runs. Set on
  // both instances for the same reason the unlock above is.
  for (const which of ['entry', 'bare']) {
    await page.evaluate(([pubHex, tacAsset, noteTxid, overTxid, srcExpr]) => {
      for (const k of [pubHex, '0x' + pubHex]) localStorage.setItem('tacit-backup-ack-v1:' + k, '1');
      const mkUtxo = (txid, value) => ({ utxo: { txid, vout: 0, value, status: { confirmed: true } } });
      const holdings = new Map([[tacAsset, {
        assetIdHex: tacAsset, ticker: 'TAC', decimals: 8, balance: 90_000_000_000n + 200_000_000_000n,
        utxos: [
          { ...mkUtxo(noteTxid, 1000), amount: 90_000_000_000n, blinding: 0x1234n },   // 900 TAC — eligible
          { ...mkUtxo(overTxid, 1000), amount: 200_000_000_000n, blinding: 0x5678n },  // 2,000 TAC — over the 1,000 TAC cap
        ],
        ghosts: [], inflated: [], pending: [], unverified: [], unknownAsset: false,
      }]]);
      const src = new Function('return ' + srcExpr)();
      return import(src).then((T) => { T._testSetScanHoldingsOverride(() => holdings); });
    }, [hex(WALLET_PUB), TAC_ASSET, NOTE_TXID, OVERCAP_TXID, instanceSrc(which)]);
  }
  await page.click('.tab[data-tab="holdings"]');

  await page.waitForSelector(`[data-act="bridge-eth"]`, { state: 'attached', timeout: 100000 }).catch(async () => {
    await page.screenshot({ path: '/private/tmp/claude-501/-Users-z-tacit/415bc623-2f66-4072-ba19-ccf06826025b/scratchpad/bridge-check-fail.png', fullPage: true }).catch(() => {});
    const dump = await page.evaluate(async () => {
      const src = document.querySelector('script[type="module"][src*="tacit.js"]').src;
      const T = await import(src);
      return {
        status: document.getElementById('holdings-status')?.textContent,
        walletPriv: !!T.wallet.priv, walletPub: !!T.wallet.pub,
        netName: document.getElementById('net-select')?.value || document.querySelector('[data-net]')?.textContent,
        bridgeBtnCount: document.querySelectorAll('[data-act="bridge-eth"]').length,
        assetCardHtmlTail: document.querySelector('.asset-card')?.innerHTML.slice(-1500),
      };
    });
    throw new Error('bridge-eth button never rendered: ' + JSON.stringify(dump) + ' | page errors: ' + errors.join(' | '));
  });
  ok(true, 'holdings: the Bridge to Ethereum button renders for the TAC holding');
  // The button lives inside a collapsed <details class="actions-group"> disclosure (each holding groups its
  // actions this way) — open it before interacting, same as a real user clicking the "Bridge · move to
  // Ethereum" summary would.
  await page.evaluate(() => document.querySelector('[data-act="bridge-eth"]').closest('details').open = true);
  await shot('holdings');

  await page.click('[data-act="bridge-eth"]');
  await page.waitForSelector('input[name="bridge-note"]', { timeout: 10000 });
  const notes = await page.$$eval('input[name="bridge-note"]', (els) => els.map((e) => ({ disabled: e.disabled, label: e.closest('label')?.textContent.replace(/\s+/g, ' ').trim() })));
  ok(notes.length === 2 && notes.some((n) => !n.disabled && /900/.test(n.label)), `picker: the eligible 900 TAC note is selectable (${JSON.stringify(notes[0])})`);
  ok(notes.some((n) => n.disabled && /beta limit/.test(n.label)), `picker: the 2,000 TAC note is disabled with the over-cap reason (${JSON.stringify(notes[1])})`);
  await shot('picker');

  // "split off 1,000 now →" on the over-cap note: closes the picker and pre-fills Send Privately as a
  // self-send of exactly the beta cap, to your own pubkey.
  await page.click('[data-split-shortcut="1"]');
  // Not '.tab.active[data-tab="transfer"]': the primary "Send" nav tab and its "Bitcoin" subtab share that
  // exact data-tab value, so the selector matches two elements — wait on the actual field instead.
  await page.waitForSelector('#x-recipient-pub', { state: 'visible', timeout: 10000 });
  const splitFromPicker = await page.evaluate(() => ({
    asset: document.getElementById('x-asset')?.value,
    recipient: (document.getElementById('x-recipient-pub')?.value || '').replace(/^0x/i, '').toLowerCase(),
    amount: document.getElementById('x-amount')?.value,
  }));
  ok(splitFromPicker.amount === '1000' && splitFromPicker.recipient === hex(WALLET_PUB).toLowerCase() && splitFromPicker.asset === TAC_ASSET,
    `split shortcut: pre-fills Send Privately with the cap amount to your own pubkey (${JSON.stringify(splitFromPicker)})`);
  await shot('split-shortcut');

  // The general "Split into a smaller note" action on the asset card itself (any asset, any amount). Some
  // background refresh re-renders the Holdings list on a short cycle, which detaches an already-open inline
  // form out from under a multi-step fill — open, fill and submit inside one synchronous evaluate instead of
  // three separate awaited calls, so nothing async can interleave and tear the form down mid-interaction.
  await page.click('.tab[data-tab="wallet"]');
  await page.click('.tab[data-tab="holdings"]');
  await page.waitForSelector('[data-act="split"]', { timeout: 10000 });
  const splitFormResult = await page.evaluate(() => {
    // openInlineForm builds its DOM synchronously on click — no await between opening the form and the field
    // existing, so nothing async gets a chance to re-render Holdings out from under this single JS turn.
    document.querySelector('[data-act="split"]').click();
    const field = document.querySelector('.inline-form-host [data-field="amount"]');
    if (!field) return 'no amount field';
    field.value = '300';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('.inline-form-host button')].find((b) => /continue/i.test(b.textContent));
    if (!btn) return 'no continue button';
    btn.click();
    return 'ok';
  });
  if (splitFormResult !== 'ok') throw new Error('split form: ' + splitFormResult);
  await page.waitForSelector('#x-recipient-pub', { state: 'visible', timeout: 10000 });
  const splitGeneral = await page.evaluate(() => ({
    asset: document.getElementById('x-asset')?.value,
    recipient: (document.getElementById('x-recipient-pub')?.value || '').replace(/^0x/i, '').toLowerCase(),
    amount: document.getElementById('x-amount')?.value,
  }));
  ok(splitGeneral.amount === '300' && splitGeneral.recipient === hex(WALLET_PUB).toLowerCase() && splitGeneral.asset === TAC_ASSET,
    `split (general): the asset-card action pre-fills Send Privately with a chosen amount to your own pubkey (${JSON.stringify(splitGeneral)})`);

  // Back to Holdings and re-open the bridge form to continue the real flow below with the eligible note.
  // The Holdings subtab only renders while its parent "Wallet" section is the active primary tab. Something
  // re-renders #holdings-list at least once shortly after the tab activates (a trailing async holdings/tip
  // refresh, not a tight loop — a 3s idle sample earlier saw only one mutation) — wait for it to go quiet
  // before opening the details and clicking, rather than racing it like the earlier multi-step fill did.
  await page.click('.tab[data-tab="wallet"]');
  await page.click('.tab[data-tab="holdings"]');
  await page.evaluate(() => new Promise((resolve) => {
    const el = document.getElementById('holdings-list');
    let t = setTimeout(resolve, 600);
    new MutationObserver(() => { clearTimeout(t); t = setTimeout(resolve, 600); }).observe(el, { childList: true, subtree: true });
    setTimeout(resolve, 4000); // hard cap regardless
  }));
  const reopened = await page.evaluate(() => {
    const btn = document.querySelector('[data-act="bridge-eth"]');
    if (!btn) return 'no bridge-eth button';
    const d = btn.closest('details'); if (d) d.open = true;
    btn.click();
    return 'ok';
  });
  if (reopened !== 'ok') throw new Error('re-open bridge form: ' + reopened);
  await page.waitForSelector('input[name="bridge-note"]', { timeout: 10000 });

  await page.check('input[name="bridge-note"][value="0"]');
  await page.click('.inline-form-host button.primary, .inline-form-host [data-submit], .inline-form-host button[type="submit"]').catch(() => {});
  // openInlineForm's own submit button — find it generically since its exact class isn't yet confirmed.
  await page.evaluate(() => { const f = document.querySelector('.inline-form-host'); const btn = f && [...f.querySelectorAll('button')].find((b) => /continue/i.test(b.textContent)); if (btn) btn.click(); });
  await until(() => /Irreversible/.test(document.body.textContent), null, 30000).catch(async () => {
    const dump = await page.evaluate(() => document.querySelector('[data-bridge-body]')?.innerHTML.slice(0, 1000));
    throw new Error('review panel never rendered (preflight likely failed): ' + dump);
  });
  ok(true, 'review: preflight passes on real stubbed data and the irreversibility panel renders');
  await shot('review');

  await page.check('[data-field="confirm"]');
  await page.evaluate(() => { const f = document.querySelector('.inline-form-host'); const btn = f && [...f.querySelectorAll('button')].find((b) => /continue/i.test(b.textContent)); if (btn) btn.click(); });
  await until(() => /Bridge started/.test(document.querySelector('#toast-container')?.textContent || ''), null, 30000).catch(async () => {
    const dump = await page.evaluate(() => document.querySelector('[data-bridge-body]')?.innerHTML.slice(0, 1000) + ' | toast: ' + document.querySelector('#toast-container')?.textContent);
    throw new Error('start() never completed: ' + dump);
  });
  ok(true, 'start: the migrate is built, signed, and broadcast; the UI reports it started');
  await shot('started');

  await sleep(500);
  const bridgeSection = await page.evaluate(() => document.querySelector('.burndep-bridge-holdings')?.textContent.replace(/\s+/g, ' ').slice(0, 200));
  ok(!!bridgeSection && /900/.test(bridgeSection), `persistent section: the new bridge shows in "Bridges to Ethereum" (${bridgeSection})`);

  // A second, injected record at burn-submitted: MARA Slipstream never puts this on public relay, so
  // mempool.space won't have heard of it until it's mined — the row must not link there and claim otherwise.
  await page.evaluate(([walletPubHex, network]) => {
    const key = `tacit-burndep-bridge-v1:${network}:${walletPubHex.toLowerCase()}`;
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    existing.push({
      id: 'fa'.repeat(31) + 'fb:0', network, walletPub: walletPubHex, stage: 'burn-submitted',
      source: { assetId: 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', amount: '50000000000' },
      migrate: { revealTxid: 'aa'.repeat(32) },
      burn: { txid: 'bb'.repeat(32) },
    });
    localStorage.setItem(key, JSON.stringify(existing));
  }, [hex(WALLET_PUB), 'signet']);
  await page.click('.tab[data-tab="wallet"]');
  await page.click('.tab[data-tab="holdings"]');
  await sleep(500);
  const secondRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-burndep-row]')];
    const row = rows.find((r) => r.textContent.includes('500 TAC'));
    return row ? row.innerHTML : null;
  });
  ok(!!secondRow && /not on public explorers yet/.test(secondRow) && new RegExp(`tx/${'aa'.repeat(32)}`).test(secondRow) && !secondRow.includes('bb'.repeat(32)),
    `pre-mined burn: the row links the confirmed move, not the unmined burn, and says why (${secondRow ? 'found' : 'row missing'})`);
  await shot('pre-mined-burn');

  // A mint the relay refused: the row offers to finish it from the holder's own Tacit account. Rows that failed for
  // another reason, or are at another stage, do not.
  await page.evaluate(([walletPubHex, network]) => {
    const key = `tacit-burndep-bridge-v1:${network}:${walletPubHex.toLowerCase()}`;
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    const base = { network, walletPub: walletPubHex, source: { assetId: 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', amount: '70000000000' }, burn: { txid: 'cc'.repeat(32) }, migrate: { revealTxid: 'aa'.repeat(32) } };
    existing.push({ ...base, id: 'f1'.repeat(31) + 'f2:0', stage: 'folded', lastError: { message: 'relay 400: submitJob: relay fee below the current floor — re-quote higher or self-settle', at: Date.now() }, errorCount: 1 });
    existing.push({ ...base, id: 'f3'.repeat(31) + 'f4:0', source: { ...base.source, amount: '30000000000' }, stage: 'folded', lastError: { message: 'cannot read properties of undefined', at: Date.now() }, errorCount: 1 });
    existing.push({ ...base, id: 'f5'.repeat(31) + 'f6:0', source: { ...base.source, amount: '20000000000' }, stage: 'registered', lastError: { message: 'relay is busy', at: Date.now() }, errorCount: 1 });
    localStorage.setItem(key, JSON.stringify(existing));
  }, [hex(WALLET_PUB), 'signet']);
  await page.click('.tab[data-tab="wallet"]');
  await page.click('.tab[data-tab="holdings"]');
  await sleep(500);
  const rowsBy = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-burndep-row]')].map((r) => [(r.textContent.match(/(\d+) TAC/) || [])[1], { self: !!r.querySelector('[data-burndep-act="selfmint"]'), text: r.textContent }])));
  ok(rowsBy['700'] && rowsBy['700'].self && /Finish it myself/.test(rowsBy['700'].text) && /can’t take this mint right now/.test(rowsBy['700'].text), 'a mint the relay refused offers "Finish it myself", with what it costs');
  ok(rowsBy['300'] && !rowsBy['300'].self, 'a mint that failed for another reason does not');
  ok(rowsBy['200'] && !rowsBy['200'].self, 'and neither does a bridge still waiting for the reflection');
  await shot('self-mint-offer');
  await page.evaluate(() => { document.querySelector('#toast-container').innerHTML = ''; document.querySelector('[data-burndep-act="selfmint"]').click(); });
  await until(() => /Bridge action failed/.test(document.querySelector('#toast-container')?.textContent || ''), null, 20000).catch(() => {});
  const selfToast = await page.evaluate(() => document.querySelector('#toast-container')?.textContent || '');
  ok(/Bridge action failed/.test(selfToast), `pressing it runs the mint through the holder's own account (the stub world has no real burn, so it stops with: ${selfToast.slice(0, 90)})`);

  // A bridge ready to mint is attempted by the page itself while the key is open: nothing is pressed here. One whose last
  // attempts failed a moment ago is left alone for the holder.
  await page.evaluate(([walletPubHex, network]) => {
    const key = `tacit-burndep-bridge-v1:${network}:${walletPubHex.toLowerCase()}`;
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    const base = { network, walletPub: walletPubHex, source: { assetId: 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', amount: '40000000000' }, burn: { txid: 'dd'.repeat(32) }, migrate: { revealTxid: 'aa'.repeat(32) } };
    existing.push({ ...base, id: 'f7'.repeat(31) + 'f8:0', stage: 'folded' });
    existing.push({ ...base, id: 'f9'.repeat(31) + 'fa:0', source: { ...base.source, amount: '10000000000' }, stage: 'folded', lastError: { message: 'relay is busy', at: Date.now() }, errorCount: 4 });
    localStorage.setItem(key, JSON.stringify(existing));
  }, [hex(WALLET_PUB), 'signet']);
  await page.click('.tab[data-tab="wallet"]');
  await page.click('.tab[data-tab="holdings"]');
  await until(([k, id]) => { const r = (JSON.parse(localStorage.getItem(k) || '[]')).find((x) => x.id === id); return !!(r && r.lastError); }, [`tacit-burndep-bridge-v1:signet:${hex(WALLET_PUB).toLowerCase()}`, 'f7'.repeat(31) + 'f8:0'], 20000).catch(() => {});
  const auto = await page.evaluate(([k]) => { const L = JSON.parse(localStorage.getItem(k) || '[]'); const g = (id) => L.find((x) => x.id === id); return { ready: g('f7'.repeat(31) + 'f8:0'), spent: g('f9'.repeat(31) + 'fa:0') }; }, [`tacit-burndep-bridge-v1:signet:${hex(WALLET_PUB).toLowerCase()}`]);
  ok(auto.ready && !!auto.ready.lastError, 'a bridge ready to mint is attempted by the page on its own, with no press (the stub world has no real burn, so the attempt records why it stopped)');
  ok(auto.spent && auto.spent.errorCount === 4 && /busy/.test(auto.spent.lastError.message), 'one that failed four times, the last a moment ago, is left for the holder');

  if (errors.length) { fails++; console.log('FAIL page errors:\n  ' + errors.slice(0, 8).join('\n  ')); }
  console.log(fails ? `${fails} failed` : 'all passed');
  await browser.close();
  server.close();
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e.stack || e.message); server.close(); process.exit(1); });
