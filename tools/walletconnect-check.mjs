// Checks WalletConnect (v2) end to end over its real relay, on every page that connects a wallet. A wallet in Node, holding a test key, pairs with the
// link a page shows and answers what the page asks it.
//   · the front page, /pay, /pay/eth and /tac: the wallet approves the session and answers personal_sign, and the page opens the Tacit wallet that signature
//     derives, saying "Approve in your wallet" while each request waits. After a reload the kept session opens the same wallet with no new pairing;
//     Disconnect ends the session in the wallet app, and the next sign-in pairs afresh.
//   · /tac, the keeper page and Secret Sats: a wallet app opens the key (/tac, /sats; /sats and the classic app share tacit.js's Ethereum wallet, whose
//     disconnect ends the session) or pays for a keeper action (the keeper page, which names the wallet app and leaves it on Disconnect).
//   · /trade/tac/, /teth/ and /cbtc/: the header shows the wallet app's account as connected (on Ethereum, not "another network"), a reload
//     brings it back with no new pairing, and Disconnect ends the session in the wallet app.
//   · the trade pages' wallet layer (trade/wallet.js over the real adapter): the network reads as 0x1, the page never asks the wallet to switch to it,
//     a transaction and TAC's permit reach the wallet app as the page built them, and Disconnect ends the session.
// Nothing is sent on any chain.
//   node tools/walletconnect-check.mjs        (build/'s dependencies installed: cd build && npm ci; PLAYWRIGHT names a playwright-core)

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';

const req = createRequire(new URL('../build/package.json', import.meta.url));
const WebSocket = req('ws');
globalThis.WebSocket ??= WebSocket;
const { SignClient } = await import(req.resolve('@walletconnect/sign-client'));
const secp = await import(req.resolve('@noble/secp256k1'));
const { keccak_256 } = await import(req.resolve('@noble/hashes/sha3'));
const { hmac } = await import(req.resolve('@noble/hashes/hmac'));
const { sha256 } = await import(req.resolve('@noble/hashes/sha256'));
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');

const DAPP = new URL('../dapp/', import.meta.url).pathname;
const PROJECT = /WC_PROJECT_ID = '([0-9a-f]{32})'/.exec(readFileSync(join(DAPP, 'walletconnect.js'), 'utf8'))?.[1];
if (!PROJECT) throw new Error('no WC_PROJECT_ID in dapp/walletconnect.js');
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((r, res) => {
  const p = decodeURIComponent(new URL(r.url, 'http://x').pathname);
  let f = normalize(join(DAPP, p));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const KEY = Buffer.from('7'.repeat(63) + '1', 'hex');
const ADDR = '0x' + Buffer.from(keccak_256(secp.getPublicKey(KEY, false).slice(1)).slice(12)).toString('hex');
const sign = (digest) => { const s = secp.sign(digest, KEY); return '0x' + s.toCompactHex() + (27 + s.recovery).toString(16); };
const personalSign = (msgHex) => { const m = Buffer.from(msgHex.replace(/^0x/, ''), 'hex'); return sign(keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`), m]))); };
const TX_HASH = '0x' + 'cd'.repeat(32);

const wallet = await SignClient.init({ projectId: PROJECT, metadata: { name: 'walletconnect-check', description: 'test wallet', url: 'https://example.com', icons: [] } });
const asked = [], waiting = [], ended = [], seen = [];
let page = null;
wallet.on('session_delete', ({ topic }) => ended.push(topic));
wallet.on('session_proposal', async ({ id, params }) => {
  const want = [...(params.requiredNamespaces?.eip155?.chains || []), ...(params.optionalNamespaces?.eip155?.chains || [])];
  const methods = [...new Set([...(params.requiredNamespaces?.eip155?.methods || []), ...(params.optionalNamespaces?.eip155?.methods || [])])];
  const chains = want.filter((c) => c === 'eip155:1' || c === 'eip155:8453');
  asked.push(`proposal:${params.proposer.metadata.name}`);
  await wallet.approve({ id, namespaces: { eip155: { chains, accounts: chains.map((c) => `${c}:${ADDR}`), methods, events: ['accountsChanged', 'chainChanged'] } } });
});
wallet.on('session_request', async ({ topic, id, params }) => {
  const { method, params: p } = params.request;
  asked.push(method); seen.push({ method, params: p, chainId: params.chainId });
  waiting.push(await page?.evaluate(() => document.querySelector('#sheet-wc[open] #wc-h, .bsheet.top h2')?.textContent || '').catch(() => ''));
  const answer = method === 'personal_sign' ? { result: personalSign(p[0]) }
    : method === 'eth_sendTransaction' ? { result: TX_HASH }
    : method === 'eth_signTypedData_v4' ? { result: sign(keccak_256(Buffer.from(p[1]))) }
    : method === 'wallet_switchEthereumChain' ? { result: null }
    : { error: { code: 4200, message: 'not in this check' } };
  await wallet.respond({ topic, response: { id, jsonrpc: '2.0', ...answer } });
});

const browser = await chromium.launch();
const errors = [];
async function newPage() {
  const p = await (await browser.newContext()).newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) errors.push(m.text().slice(0, 160)); });
  return p;
}
// The page's own "Copy link" button hands over the pairing link; the wallet app pairs with it.
async function pairFrom(pg, sheet) {
  await pg.waitForSelector(`${sheet} .wc-qr svg`, { timeout: 30000 });
  await pg.evaluate(() => { navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await pg.click(`${sheet} [data-copy]`);
  const uri = await pg.evaluate(() => window.__copied);
  await wallet.core.pairing.pair({ uri });
  return uri;
}
const waitEnded = async (n) => { for (let i = 0; i < 40 && ended.length < n; i++) await new Promise((r) => setTimeout(r, 250)); return ended.length >= n; };
const tacitLabel = (pg) => pg.waitForFunction(() => /^tacit1/.test(document.querySelector('#wallet-label')?.textContent || ''), null, { timeout: 120000 }).catch(() => {});
const label = (pg, sel = '#wallet-label') => pg.evaluate((s) => document.querySelector(s)?.textContent || '', sel);

try {
  // ── the front page, /pay and /pay/eth: a wallet app opens the Tacit key ──
  for (const [name, path, copy, chip, sheet] of [['front page', '/#wallet', '#sheet-wc', '#wallet', '#sheet-wallet'], ['/pay', '/pay/', '#sheet-wc', '#wallet', '#sheet-wallet'], ['/pay/eth', '/pay/eth/', '#sheet-wc', '#wallet', '#sheet-wallet'], ['/tac', '/tac/', '#sheet-wc', '#wallet-chip', '#connect-sheet']]) {
    page = await newPage();
    const URL_ = `${ORIGIN}${path}`;
    asked.length = 0; waiting.length = 0;
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    if (name !== 'front page') await page.click(chip);
    await page.click(`${sheet} [data-in="eth"]`);
    const uri = await pairFrom(page, copy);
    ok(/^wc:[0-9a-f]{64}@2\?/.test(uri || ''), `${name}: the page shows a QR and copies its wc: link`);
    await tacitLabel(page);
    const first = await label(page);
    ok(/^tacit1/.test(first) && !(await page.$('#sheet-wc[open]')), `${name}: the wallet opens (${first.slice(0, 24)}…), the pairing sheet goes`);
    ok(asked.join(' ') === `proposal:${name === 'front page' || name === '/tac' ? 'tacit' : 'tacit pay'} personal_sign personal_sign`, `${name}: the wallet app was asked: ${asked.join(' → ')}`);
    ok(waiting.length === 2 && waiting.every((t) => t === 'Approve in your wallet'), `${name}: while each request waits, the page says so (${waiting.join(' | ')})`);

    asked.length = 0;
    await page.goto('about:blank');
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    if (name !== 'front page') await page.click(chip);
    if (name !== '/tac') await page.click(`${sheet} [data-in="known"]`);   // /tac's chip opens the one wallet this browser has opened, with no second press
    await tacitLabel(page);
    ok((await label(page)) === first && !(await page.$('#sheet-wc[open]')) && asked.join(' ') === 'personal_sign', `${name}: after a reload the kept session opens the same wallet, no pairing (asked: ${asked.join(' → ')})`);

    const before = ended.length;
    await page.click(chip);
    await page.waitForSelector(name === 'front page' ? '#sheet-wallet[open] [data-wc-off]' : `${sheet}[open] #w-wc-off`, { timeout: 15000 });
    await page.click(name === 'front page' ? '#sheet-wallet [data-wc-off]' : `${sheet} #w-wc-off`);
    await page.waitForFunction(() => !/^tacit1/.test(document.querySelector('#wallet-label')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    ok(await waitEnded(before + 1) && !/^tacit1/.test(await label(page)), `${name}: Disconnect ends the session in the wallet app and the key opened with it locks (${await label(page)})`);
    await page.click(`${sheet} [data-in="eth"]`).catch(async () => { await page.click(chip); await page.click(`${sheet} [data-in="eth"]`); });
    await page.waitForSelector('#sheet-wc[open] .wc-qr svg', { timeout: 30000 }).catch(() => {});
    ok(!!(await page.$('#sheet-wc[open] .wc-qr svg')), `${name}: after Disconnect, WalletConnect pairs afresh: another wallet app or account can sign in`);
    await page.context().close();
  }

  // ── the keeper page: a wallet app pays for a keeper action, and Disconnect leaves it ──
  page = await newPage();
  asked.length = 0;
  await page.goto(`${ORIGIN}/prove/#tab=bitcoin`, { waitUntil: 'domcontentloaded' });
  await page.click('#wallet');
  await pairFrom(page, '#sheet-wc');
  await page.waitForFunction(() => /^0x/.test(document.querySelector('#wallet-label')?.textContent || ''), null, { timeout: 60000 }).catch(() => {});
  ok((await label(page)) === `${ADDR.slice(0, 6)}…${ADDR.slice(-4)}` && !(await page.$('#sheet-wc[open]')), `the keeper page: the wallet app connects and the sheet goes (${await label(page)})`);
  await page.click('#wallet');
  await page.waitForSelector('#sheet-wc[open] [data-off]');
  ok(/WalletConnect · walletconnect-check/.test(await label(page, '#wc-body')), 'the keeper page: the chip names the wallet app');
  { const before = ended.length; await page.click('#sheet-wc [data-off]'); const gone = await waitEnded(before + 1); await page.waitForFunction(() => !/^0x/.test(document.querySelector('#wallet-label')?.textContent || ''), null, { timeout: 30000 }).catch(() => {}); ok(gone && !/^0x/.test(await label(page)), `the keeper page: Disconnect ends the session in the wallet app and the page asks to connect again (ended ${ended.length - before}, chip ${await label(page)})`); }
  await page.context().close();

  // ── Secret Sats (tacit.js's Ethereum wallet, as the classic app uses it): a wallet app opens the key ──
  page = await newPage();
  asked.length = 0;
  await page.goto(`${ORIGIN}/sats/`, { waitUntil: 'domcontentloaded' });
  await page.click('#btn-eth');
  await page.waitForSelector('dialog.wcx[open] .wc-qr svg', { timeout: 60000 });
  await page.evaluate(() => { navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await page.click('dialog.wcx[open] [data-copy]');
  await wallet.core.pairing.pair({ uri: await page.evaluate(() => window.__copied) });
  await page.waitForFunction(() => !/^(Sign in|Open wallet)$/.test(document.querySelector('#chip-label')?.textContent || 'Sign in'), null, { timeout: 120000 }).catch(() => {});
  ok(asked.join(' ') === 'proposal:tacit personal_sign personal_sign' && !(await page.$('dialog.wcx[open]')), `Secret Sats: the wallet app opens the key with two signatures (${asked.join(' → ')})`);
  { const before = ended.length, url = readFileSync(join(DAPP, 'sats/app.js'), 'utf8').match(/const TACIT_URL = '([^']+)'/)[1];
    await page.evaluate(async (u) => { (await import(u)).ethWallet.disconnect(); }, url);
    ok(await waitEnded(before + 1), 'Secret Sats: ending the Ethereum wallet ends the session in the wallet app'); }
  await page.context().close();

  // ── the trade pages: a wallet app connects, and the header says so ──
  for (const path of ['/trade/tac/', '/teth/', '/cbtc/']) {
    page = await newPage();
    asked.length = 0;
    await page.goto(`${ORIGIN}${path}`, { waitUntil: 'domcontentloaded' });
    await page.click('#wallet-chip');
    await pairFrom(page, '.bsheet.top');
    await page.waitForFunction(() => document.querySelector('#wallet-dot')?.classList.contains('on'), null, { timeout: 60000 }).catch(() => {});
    const chip = await page.evaluate(() => ({ label: document.querySelector('#wallet-label').textContent, on: document.querySelector('#wallet-dot').classList.contains('on'), warn: document.querySelector('#wallet-dot').classList.contains('warn') }));
    ok(chip.on && !chip.warn && chip.label === `${ADDR.slice(0, 6)}…${ADDR.slice(-4)}`, `${path}: the header shows the wallet app's account as connected on Ethereum (${chip.label})`);
    await page.click('#wallet-chip');
    await page.waitForSelector('.bsheet.top [data-leave]');
    const sheet = (await label(page, '.bsheet.top')).replace(/\s+/g, ' ');
    ok(/WalletConnect · walletconnect-check/.test(sheet) && !/Switch/.test(sheet), `${path}: the account sheet names the wallet app (${sheet.slice(0, 70)})`);
    await page.keyboard.press('Escape');
    asked.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#wallet-dot')?.classList.contains('on'), null, { timeout: 60000 }).catch(() => {});
    ok((await label(page)) === chip.label && !asked.some((a) => a.startsWith('proposal')), `${path}: after a reload the kept session brings the wallet back with no new pairing`);
    const before = ended.length;
    await page.click('#wallet-chip');
    await page.click('.bsheet.top [data-leave]');
    await page.waitForFunction(() => document.querySelector('#wallet-label')?.textContent === 'Connect', null, { timeout: 30000 }).catch(() => {});
    ok(await waitEnded(before + 1) && (await label(page)) === 'Connect', `${path}: Disconnect ends the session in the wallet app`);
    await page.context().close();
  }

  // ── the trade pages' wallet layer over the real adapter ──
  page = await newPage();
  await page.route(`${ORIGIN}/__blank`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>wallet</title>' }));
  await page.goto(`${ORIGIN}/__blank`);
  await page.exposeFunction('__pair', async (uri) => { await wallet.core.pairing.pair({ uri }); });
  asked.length = 0; seen.length = 0;
  const endedBefore = ended.length, TAC = '0x' + '11'.repeat(20);
  const out = await page.evaluate(async ({ project, tac }) => {
    const { announceWalletConnect } = await import('/walletconnect.js');
    const { makeWallet } = await import('/trade/wallet.js');
    const WC = announceWalletConnect({ projectId: project, chains: [1], rpcMap: { 1: 'https://ethereum-rpc.publicnode.com' }, metadata: { name: 'wallet layer', description: 'check', url: location.origin, icons: [] }, onPair: ({ uri }) => { window.__pair(uri); return () => {}; }, onAsk: () => () => {} });
    const wallet = makeWallet({ rpc: async () => null, leave: (p) => (p?.isWalletConnect ? WC.disconnect() : null) });
    const o = { names: wallet.available().map((w) => w.info.name) };
    await wallet.connect(wallet.available().find((w) => w.provider.isWalletConnect));
    o.account = wallet.state.account; o.chain = wallet.state.chain;
    await wallet.ensureMainnet(); o.chainAfter = wallet.state.chain;
    o.tx = await wallet.sendTx({ to: tac, data: '0xdeadbeef', value: 10n ** 15n });
    o.sig = await wallet.signPermit({ token: tac, name: 'Tacit Token', spender: tac, value: 5n, deadline: 99999999999n, nonce: 3n });
    await wallet.disconnect();
    o.after = wallet.state.account;
    return o;
  }, { project: PROJECT, tac: TAC });
  ok(out.names.join() === 'WalletConnect' && out.account === ADDR && out.chain === '0x1' && out.chainAfter === '0x1', `wallet layer: connects (${out.account?.slice(0, 8)}…) and reads Ethereum as ${out.chain}`);
  ok(!seen.some((s) => s.method === 'wallet_switchEthereumChain'), 'wallet layer: ensureMainnet does not ask the wallet app to switch to the network it is on');
  const tx = seen.find((s) => s.method === 'eth_sendTransaction');
  ok(out.tx === TX_HASH && tx?.chainId === 'eip155:1' && tx.params[0].to === TAC && tx.params[0].data === '0xdeadbeef' && tx.params[0].value === '0x38d7ea4c68000' && tx.params[0].from.toLowerCase() === ADDR, `wallet layer: a transaction reaches the wallet app as built, on eip155:1 (${tx?.params[0].value})`);
  const typed = seen.find((s) => s.method === 'eth_signTypedData_v4'), td = typed && JSON.parse(typed.params[1]);
  ok(td?.primaryType === 'Permit' && td.domain.chainId === 1 && td.domain.verifyingContract === TAC && td.message.owner.toLowerCase() === ADDR && [27, 28].includes(out.sig.v) && /^0x[0-9a-f]{64}$/.test(out.sig.r) && /^0x[0-9a-f]{64}$/.test(out.sig.s), `wallet layer: TAC's permit is signed as typed data on chain 1, split into v ${out.sig.v}, r, s`);
  ok(out.after === null && (await waitEnded(endedBefore + 1)), 'wallet layer: Disconnect ends the session in the wallet app and leaves no account');
  ok(!errors.length, `no page errors ${errors.join(' | ')}`);
} catch (e) { fails++; console.log('FAIL', (e.stack || e.message).split('\n').slice(0, 3).join(' / ')); }
await browser.close();
server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
