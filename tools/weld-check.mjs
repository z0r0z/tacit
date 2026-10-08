// Checks dapp/index.html (the front page, formerly /weld/) in a real browser against an anvil fork of Ethereum: public RPC hosts are routed to
// the fork and window.ethereum is an EIP-1193 stub that sends as the chosen account (anvil's first key, or an
// impersonated one). The relay's submit and the EVM-pool keepers are stubbed, so nothing reaches a live service.
//   airdrop  a listed recipient claims its TAC; the tile updates
//   links    friendly links open the right sheet and tab (#swap, #points, #earn), the address bar follows the tab, and
//            every sheet has a copy-link button
//   ux       the page's shell: a toast over an open sheet can be pressed, a drag ending on the backdrop leaves the sheet open, an
//            unreadable amount says so, one sheet replacing another keeps its link in the address bar, a hash naming nothing is ignored
//   apr      every farm row shows its APR now, and the public farm's card spells it out; the Farm tile leads with the public farm's APR
//   farmgate nobody connected: the public farm offers a browser wallet or, in place, the ways into a Tacit wallet, and back
//   farmpos  a private farm's card with positions: each named and leading the card, unbond held back while a real reward is
//            unharvested, harvested rewards and unbonded liquidity above the farms, a harvest pointing at its next step
//   farmsteps joining a private farm with tETH but no TAC is a checklist (tETH done, TAC next and where to get it, the add last),
//            and the sheet it sends you to carries a way back to the same farm
//   farmexit Exit on a private position is one press: harvest what is worth harvesting, unbond giving up what accrued since (a plain
//            unbond refuses it), take the liquidity out, each step named as it runs
//   farmclaim Claim rewards harvests the positions with a real reward and none holding dust, then unwraps the wTAC
//   swap     the Swap tab of the Tacit pool: its link, a swap of a note that is exactly the amount, an amount no note matches (cut
//            first), a swap between two assets that are not tETH (through tETH), and a refusing relay (offered from the account)
//   pair     with no TAC held, Max fills the ETH side and says TAC is missing; then ETH + TAC staked in one transaction
//            with an EIP-2612 permit
//   farm     a one-sided ETH zap waits for its typed loss acceptance (its preview's APR never above the farm's APR now),
//            stakes, claims, then withdraws everything; what is
//            earned and earned a day also read in ETH, the dashboard says what there is to claim, and a claim then shows
//            under Claimed so far
//   reinvest a stake's claim opens the add form on TAC with exactly what was paid, and farming it stakes it again
//   buy      TAC bought with ETH through zRouter
//   tacfarm  TAC alone zapped in with a permit; half withdrawn as ETH; LP held staked again; the rest withdrawn as TAC
//   sell     TAC sold for ETH through zRouter in one transaction, the permit riding as its first leg
//   v1       the identity signature unlocks the key; a tipped wrap lands and its settle is submitted
//   v1refuse the relay refuses a wrap's settle after its deposit landed: the form empties and the line points to Finish
//   devsend  the EVM pool's Send opens tacit pay on the same chain, and Receive keeps the pool and deposit addresses
//   device   a deposit into the EVM pool, proved in the page's worker
//   borrow   the Bitcoin deposit address renders; a bond for a lock record posts through the escrow helper
//   keys     an Ethereum signature opens a key; after locking, "continue" reopens the same tacit1 address; a pasted key opens
//   tacopen  a key opened from inside the TAC sheet (reached by link): the sheet's balance reads again for it at once
//   saved    a passphrase-locked key saved the way tacit.finance saves it opens through tacit.js's own prompt; the TAC
//            sheet, reached by link with no key open, offers it too
//   bitcoin  a (stubbed, deterministic) UniSat wallet opens a key through tacit.js, then funds a lock in one call
//   passkey  a virtual authenticator with PRF creates a passkey wallet, and signing in again opens the same key
//   acct     a pasted key and no wallet: its Tacit account (as pool-ux derives it), funded from outside, buys TAC,
//            stakes ETH + TAC with a permit it signs, sends ETH out; a connected wallet then tops it up
//   devmove  (after acct) the Tacit account deposits into the EVM pool, sweeps a small arrival in, moves pool ETH into
//            V1 through a keeper-relayed withdrawToV1 whose note settle is then submitted, and asks to bridge to Base
//   pts      a listed address claims its points reward; a pasted key's Tacit account registers a .wei name through
//            zRouter's commit and reveal and publishes its tacit1 address on it
//   ptsview  the points sheet from a stubbed service: recent activity in time order across chains grouped by day, each
//            linked to its chain's explorer, the newest activity's holder boost, rank, claimed so far, today's share and
//            countdown; the day's pot and rate, the gap to the rank above, the change since an earlier day, the points-per-day
//            bars, the all-time and Today boards; the program's terms as the service states them (dates, the limit per point and its
//            next change, what each way of earning pays, the early bonus, the holder tiers) and the page's own where it states none or
//            something unreadable; and, with nobody connected, the public board and finding an address in it
//   csend    the Borrow sheet's Send: private cUSD/cBTC (notes stubbed into the balance) go privately to a tacit1 address
//            or out as tacUSD to an 0x… address, with fees shown first and an amount over the balance refused
//   tacsend  the TAC sheet's own Send, private-only: a stubbed cTAC note goes privately to a tacit1 address, shown as
//            TAC never cTAC, or out as public TAC to an 0x… address for a partial amount, beside the one-tap Make public
//   farmjoin a private farm joined from weld: stubbed tETH and TAC notes are cut to the live pool ratio and handed to
//            lpBond for the farm manager, with a self-settle hook so the paying account sends the bond
//   shield   the TAC sheet's Shield: public TAC funded into the key's own Tacit account wraps in one router
//            transaction; the fork's stubbed settle leaves it pending, offered to Finish like any other TAC deposit
//   btc      a pasted key's Bitcoin sheet: balances read, BTC routes (tacit1 and sp1 as silent payments, bc1 plain), TAC
//            routes refuse plain addresses, a tacit1's silent-payment keys are the ones this wallet scans, a payment link checks
//   bridge   the TAC sheet's Bridge: stubbed TAC notes on Bitcoin listed (one over the limit refused), a tracked note checks out
//            as one Bitcoin transaction but waits for sats for its fee, bridges under way show their steps and actions, and
//            Recover files its claim
//   xobridge the tETH sheet's To Bitcoin tab: hidden until enabled by a local setting (a deep link to it then falls back) unless a bridge is under way;
//            a tETH balance (stubbed notes) is quoted the relay fee, the Bitcoin fee and the time, refused over the limit and under the
//            minimum, and held back until the key's Bitcoin address has sats for the Bitcoin step and the box is ticked; bridges under
//            way (seeded in tacit.js's journal) show their steps and actions, a burn not yet seen to land is cancelled only after
//            Ethereum is looked at, starting one sends a bridge-burn job and leaves a record behind when the settle is not seen, and a
//            send the relay refuses at submit offers the paying account and leaves no record
//   xbring   the To Bitcoin tab's tETH on Bitcoin: a key's Taproot output holds tETH notes that two real signed cross-out mint reveals
//            made (one recorded by Bitcoin's proof, one it has not reached), listed on request with the amount the journal knows; the
//            recorded one is sent back by a burn that is signed and broadcast through ordinary relay, burns the note under its own
//            ν for tETH with this key as its owner, and shows under Coming back; the TAC Bridge tab does not list it
//   activity relayed jobs (dispatched as tacit:job, as the relay client does) move Queued → Proving → Done or Failed, with
//            toasts and Etherscan links; a transaction the page sends is followed to its receipt; after a reload the list
//            is still there, a job left proving is followed to its settle, a failure from the last six hours is asked
//            about again and flips to done, an older one is not; a system notification goes out only while hidden
//   dash     the "your Tacit" dashboard: the first paint at phone width has no sideways scroll; a connected wallet's
//            dashboard shows placeholders first, then values, and what changed since the last visit's snapshot
//   selfexit  an exit the relay refuses at submit offers to be sent from the paying account at once: told what the network fee
//            needs when the account has no ETH, then, funded, a proof-only job with no relay fee
//   selfmore  a private send, and a send-out, the relay refuses: the same offer, the account's address to copy when it has no ETH,
//            then proof-only jobs with no relay fee from the paying account
//   selflocks the ETH sheet's claim, take-back and withdrawal, each refused by the relay and sent from the paying account
//   selfsplit the split before a private send, refused the same way
//   makepub   Make public with the relay taking it: the fee shown beforehand, an address entered there, a bad one refused, and
//            the sheet saying it was sent and where it goes
//   tacdeposit  a real 20 TAC deposit whose settle never landed: the TAC sheet and the dashboard offer to finish it,
//            and Finish submits a wrap job rebuilt with the TAC asset and its own scale
//   PLAYWRIGHT=<path to playwright-core> node tools/weld-check.mjs [scenario,…] [fork rpc]   (SHOTS=<dir> saves screenshots)

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { depositIdOf } from '../worker-relay/src/lib/spent-precheck.js';
import { sha256 } from '@noble/hashes/sha256';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
// Borrow reports under each step's own line (#bw-s1…#bw-s4) as well as the sheet's: read them all.
const bwText = (page) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent).join(' '), '#bw-status, #bw-s1, #bw-s2, #bw-s3, #bw-s4');
const ONLY = new Set((process.argv[2] || 'airdrop,links,ux,apr,farmgate,pair,farm,reinvest,buy,tacfarm,sell,v1,v1refuse,devsend,device,borrow,bonds,mainbond,locks,repay,csend,tacsend,selfexit,selfmore,selflocks,selfsplit,makepub,farmjoin,farmpos,farmsteps,farmexit,farmclaim,swap,shield,keys,tacopen,saved,bitcoin,passkey,acct,devmove,btc,bridge,xobridge,xbring,pts,ptsview,activity,receipts,stats,dash,tacdeposit').split(','));
const FORK = process.argv[3] || 'https://mainnet.gateway.tenderly.co';
const SHOTS = process.env.SHOTS || null;
const PORT = 20000 + Math.floor(Math.random() * 2000), WEB = PORT + 1;
const ANVIL = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const rpc = async (method, params = []) => {
  const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw Object.assign(new Error(r.error.message), { data: r.error.data });
  return r.result;
};
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }

const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.zkey': 'application/octet-stream' };
const server = createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co', 'cloudflare-eth.com', 'rpc.flashbots.net'];
const submits = [], refused = [], relays = [], walletTxs = [];
let gatewayOnce = false;                                          // the next relay meets a gateway timeout (devmove)
// Submits the relay refuses before taking them, as it does once the day's free settles are used up.
let refuseSubmits = 0;
// What a relayed job reports when it fails (the default stands for a settle the page could not see through).
let statusError = 'stubbed in the fork check';
// With `proveStub`, a job asked for as a proof only reads proven (a stand-in proof, with the memos it was sent with),
// for a page that sends the settle itself.
let proveStub = false;
const provenJobs = {};

// router.withdrawToV1(tx, intent), encoded as evm-pool-wallet.js encodes it for a self-sent move.
const { calldata } = await import(new URL('../dapp/evm-pool-gateway.js', import.meta.url));
const EVM_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', EVM_ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', KEEPER = '0xa0ee7a142d267c1f36714e4a8f75612f20a79720';   // anvil account 9
const PAIR = { tuple: ['uint256', 'uint256'] }, B = (x) => BigInt(x);
const TX_TYPES = [PAIR, { tuple: [PAIR, PAIR] }, PAIR, { tuple: Array(11).fill('uint256') }, 'address', 'uint256', 'address', 'uint256', 'bytes', 'bytes'];
const TX_SIG = '(uint256[2],uint256[2][2],uint256[2],uint256[11],address,int256,address,uint256,bytes,bytes)';
const WRAP_SIG = '(bytes32,uint256,uint256,address,bytes32,address,uint64,uint256)';
const WRAP_TYPES = ['bytes32', 'uint256', 'uint256', 'address', 'bytes32', 'address', 'uint64', 'uint256'];
const withdrawToV1Data = (t, i) => calldata(`withdrawToV1(${TX_SIG},${WRAP_SIG})`, [{ tuple: TX_TYPES }, { tuple: WRAP_TYPES }], [
  [t.pA.map(B), t.pB.map((r) => r.map(B)), t.pC.map(B), t.publicInputs.map(B), t.recipient, BigInt.asUintN(256, B(t.extAmount)), t.relayer, B(t.fee), t.memo0, t.memo1],
  [i.assetId, B(i.amount), B(i.tip), i.tipTo, i.commit, i.refund, B(i.deadline), B(i.nonce)]]);
const fromJsonText = (t) => JSON.parse(t || 'null');
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

async function openPage({ account, key = null, host = '127.0.0.1', init = null, viewport = { width: 1280, height: 900 }, colorScheme = 'light' }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme });
  // A fork slow to fetch upstream state answers as an RPC that failed, which the page handles, instead of ending the run.
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, async (route) => {
    const t0 = Date.now(), what = () => { try { const b = JSON.parse(route.request().postData() || '{}'); return (Array.isArray(b) ? b : [b]).map((x) => x.method).join(','); } catch { return '?'; } };
    try {
      const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
      if (Date.now() - t0 > 20000) console.log(`     slow fork call: ${what()} took ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      console.log(`     fork call failed: ${what()} after ${Math.round((Date.now() - t0) / 1000)}s: ${e.message}`);
      await route.fulfill({ status: 502, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: `the fork did not answer: ${e.message}` }) }).catch(() => {});
    }
  });
  // On localhost the modules send relay calls to the page's own origin (confidential-deployments.js), so both that
  // path and the live host are covered: submits and job status are stubbed, reads pass through to the live API.
  const relay = async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/confidential/submit' && refuseSubmits > 0) {
      refuseSubmits--;
      refused.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({ status: 429, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: false, error: 'free relayed settles for today are used up (300/300) — attach a fee above the floor, or prove-mode and settle it yourself', code: 'free_budget' }) });
    }
    if (u.pathname === '/confidential/submit') {
      const b = JSON.parse(route.request().postData() || '{}'), jobId = 'stub-' + (submits.push(b));
      if (proveStub && b.mode === 'prove') provenJobs[jobId] = { memos: b.memos || [] };
      return json(route, { jobId });
    }
    if (u.pathname === '/confidential/status') {
      const id = u.searchParams.get('id'), pj = provenJobs[id];
      if (pj) return json(route, { jobId: id, mode: 'prove', status: 'proven', publicValues: '0x' + '01'.repeat(32), proof: '0x' + '02'.repeat(32), memos: pj.memos });
      return json(route, { status: 'failed', error: statusError });
    }
    // A live API that does not answer is the page's to report, as it would be for a user; the run goes on.
    try {
      const r = await fetch('https://api.tacit.finance' + u.pathname + u.search, { method: route.request().method(), headers: { 'content-type': 'application/json' }, body: route.request().method() === 'GET' ? undefined : route.request().postData(), signal: AbortSignal.timeout(60000) });
      return route.fulfill({ status: r.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
    } catch (e) {
      return route.fulfill({ status: 502, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: `the live API did not answer: ${e.message}` }) });
    }
  };
  await ctx.route(/^https:\/\/api\.tacit\.finance\/confidential\/(submit|status)/, relay);
  await ctx.route(new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${WEB}/(confidential|farm|reflection)/`), relay);
  // Keepers: quotes are canned and the queue is absent (wallets prove against their own tree). A move into V1 is
  // relayed for real, router.withdrawToV1 sent as a keeper would; any other relay is recorded and refused.
  await ctx.route('https://tacit-evm-pool-keeper*.onrender.com/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    // A quote names its chain and pool, which the wallet checks before it signs anything (its host says which chain).
    if (/\/quote$/.test(p)) return json(route, { chainId: /-base\./.test(route.request().url()) ? 8453 : /-robinhood\./.test(route.request().url()) ? 4663 : 1, pool: EVM_POOL,
      relayer: '0x0000000000000000000000000000000000000001', fee: '329000000000000', sweepFee: '439000000000000', receiveMin: '175600000000000000' });
    if (/\/(head|reserve)$/.test(p)) return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
    if (/\/relay$/.test(p)) {
      const b = JSON.parse(route.request().postData() || '{}');
      relays.push(b);
      // A gateway in front of the relay timing out: an HTML page, no JSON error, nothing known about the send.
      if (gatewayOnce) { gatewayOnce = false; return route.fulfill({ status: 504, contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: '<html><body>504 Gateway Time-out</body></html>' }); }
      // A plain spend is refused as a keeper that cannot front its gas refuses it; a bridge call is just stubbed.
      if (!b.wrap) return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ error: b.call ? 'stubbed in the fork check' : "the relay can't take this one right now; send it from your own wallet, or try again later" }) });
      b.txHash = await rpc('eth_sendTransaction', [{ from: KEEPER, to: EVM_ROUTER, data: withdrawToV1Data(b.tx, b.wrap), gas: '0x2dc6c0' }]);
      return json(route, { txHash: b.txHash });
    }
    return json(route, { ok: true });
  });
  let walletChain = '0x1';                                   // what the wallet says it is on; every chain is this one fork
  await ctx.exposeFunction('__wallet', async (method, params = []) => {
    if (method === 'eth_sendTransaction') { walletTxs.push(params[0]); const { chainId, ...tx } = params[0]; return rpc(method, [tx]); }
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return walletChain;
    if (method === 'wallet_switchEthereumChain') { walletChain = params[0]?.chainId || walletChain; return null; }
    if (method === 'wallet_watchAsset') return null;
    if (method === 'personal_sign' || method === 'eth_signTypedData_v4') {
      if (!key) throw Object.assign(new Error('this account cannot sign'), { code: 4001 });
      let digest;
      if (method === 'personal_sign') {
        const msg = Buffer.from(params[0].slice(2), 'hex');
        digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
      } else {                                                  // EIP-2612 Permit, the only typed data the page signs
        const d = JSON.parse(params[1]), m = d.message, hx = (b) => Buffer.from(b).toString('hex');
        const k = (s) => keccak_256(typeof s === 'string' ? Buffer.from(s) : s);
        const dom = k(Buffer.from(hx(k('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')) + hx(k(d.domain.name)) + hx(k(d.domain.version)) + word(d.domain.chainId) + addrWord(d.domain.verifyingContract), 'hex'));
        const st = k(Buffer.from(hx(k('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)')) + addrWord(m.owner) + addrWord(m.spender) + word(m.value) + word(m.nonce) + word(m.deadline), 'hex'));
        digest = k(Buffer.concat([Buffer.from([0x19, 0x01]), Buffer.from(dom), Buffer.from(st)]));
      }
      const sig = secp.sign(digest, key.slice(2));
      return '0x' + sig.toCompactHex() + (27 + sig.recovery).toString(16);
    }
    return rpc(method, params);
  });
  await ctx.addInitScript(() => { window.ethereum = { request: ({ method, params }) => window.__wallet(method, params), on() {}, removeListener() {} }; });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.message} @ ${(e.stack || '').split('\n').slice(1, 3).map((s) => s.trim()).join(' < ')}`));
  return { browser, ctx, page, errors, url: `http://${host}:${WEB}/` };
}

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const shot = (page, name) => SHOTS ? page.screenshot({ path: join(SHOTS, `weld-${name}.png`) }) : null;
async function step(name, fn) { if (!ONLY.has(name)) return; try { await fn(); } catch (e) { fails++; console.log('FAIL', name, '-', e.message.split('\n')[0]); if (process.env.DEBUG_STEP) console.log(e.stack); } }
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
const until = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout });
// A fee quote reads gas and the prove price over the fork, which can take minutes a call when the fork is slow.
const QUOTE_WAIT = 600000;

const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', FARM = '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0';
const A0 = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', K0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RECIPIENT = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20';           // airdrop index 978
const tacOf = async (a) => BigInt(await rpc('eth_call', [{ to: TAC, data: '0x70a08231' + addrWord(a) }, 'latest']));
const stakedOf = async (a) => BigInt(await rpc('eth_call', [{ to: FARM, data: '0x98807d84' + addrWord(a) }, 'latest']));
const allowanceOf = async (token, owner, spender) => BigInt(await rpc('eth_call', [{ to: token, data: '0xdd62ed3e' + addrWord(owner) + addrWord(spender) }, 'latest']));
const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', RESERVE = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
// TAC for a scenario that runs on its own, sent from the reserve (the ops multisig) on the fork.
async function fundTac(to, amount) {
  await rpc('anvil_impersonateAccount', [RESERVE]); await rpc('anvil_setBalance', [RESERVE, '0x' + (10n ** 18n).toString(16)]);
  await rpc('eth_sendTransaction', [{ from: RESERVE, to: TAC, data: '0xa9059cbb' + addrWord(to) + word(amount) }]);
  await rpc('anvil_stopImpersonatingAccount', [RESERVE]);
}
// Wait for a button to enable, accepting the loss gate beside it if the pool's depth puts one up.
async function acceptLoss(page, goSel, ackSel) {
  await until(page, ([g, a]) => { const b = document.querySelector(g); return (b && !b.disabled) || !!document.querySelector(a); }, [goSel, ackSel], 240000);
  for (let i = 0; i < 6 && await page.isDisabled(goSel); i++) {
    if (await page.$(ackSel)) {
      if (await page.$eval(ackSel, (x) => x.type === 'checkbox')) await page.check(ackSel);
      else await page.fill(ackSel, await page.$eval(ackSel, (x) => x.closest('.ack').querySelector('b').textContent));
    }
    await sleep(1500);
  }
}
// Chain state, polled, is the check: a toast from an earlier step can still be on screen.
async function chainUntil(fn, ms = 240000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(1500); } return false; }
const toastSays = (page, re) => until(page, (r) => new RegExp(r).test(document.querySelector('#toast-container')?.textContent || '') || !!document.querySelector('#farm-precision .status .err'), re.source, 240000);

const main = await openPage({ account: A0, key: K0 });
const { page, url } = main;

await step('airdrop', async () => {
  await rpc('anvil_impersonateAccount', [RECIPIENT]);
  await rpc('anvil_setBalance', [RECIPIENT, '0x' + (10n ** 18n).toString(16)]);
  const r = await openPage({ account: RECIPIENT });
  await r.page.goto(r.url + '#airdrop');
  await r.page.click('#air-connect');
  await r.page.waitForSelector('#air-claim', { timeout: 60000 });
  await r.page.click('#air-claim');
  await until(r.page, () => /Claimed\./.test(document.querySelector('#air-body')?.textContent || ''));
  await shot(r.page, 'airdrop');
  ok((await tacOf(RECIPIENT)) >= 216176408192580000000000n, 'airdrop: the allocation arrives');
  ok(/claimed/i.test(await text(r.page, '[data-foot="tac"]')), 'airdrop: the tile says claimed');
  await r.browser.close();
  await rpc('eth_sendTransaction', [{ from: RECIPIENT, to: TAC, data: '0xa9059cbb' + addrWord(A0) + word(1000n * 10n ** 18n) }]);
});

await step('links', async () => {
  await page.goto(url + '#swap');
  await page.waitForSelector('#sheet-tac[open] [data-tac-mode="buy"][aria-selected="true"]', { timeout: 60000 });
  ok(true, 'links: #swap opens TAC on Buy');
  await page.click('[data-tac-mode="sell"]');
  ok((await page.evaluate(() => location.hash)) === '#sell', 'links: the address bar follows the tab (#sell)');
  await shot(page, 'links-sell');
  await page.goto(url + '#points');
  await page.waitForSelector('#sheet-pts[open]', { timeout: 60000 });
  await page.goto(url + '#earn');
  await page.waitForSelector('#sheet-farm[open]', { timeout: 60000 });
  const shares = await page.$$eval('dialog.sheet:not(.layer) .sheet-head .x.share', (b) => b.length);
  const sheets = await page.$$eval('dialog.sheet:not(.layer)', (d) => d.length);
  ok(shares === sheets && sheets >= 6, `links: every sheet has a copy-link button (${shares}/${sheets})`);
});

await step('ux', async () => {
  await page.goto(url + '#sell');
  await page.waitForSelector('#sell-connect, #sl-amt', { timeout: 60000 });
  if (await page.$('#sell-connect')) await page.click('#sell-connect');
  await page.waitForSelector('#sl-amt');
  // The page outside a modal dialog is inert, so a toast has to sit inside it to be pressed.
  await page.evaluate(() => {
    const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = '<button id="ux-toast" type="button">Open</button>'; window.__ux = 0;
    t.querySelector('button').onclick = () => { window.__ux++; }; document.querySelector('#toast-container').append(t);
  });
  await page.waitForSelector('#ux-toast');
  await page.click('#ux-toast');
  ok((await page.evaluate(() => window.__ux)) === 1 && await page.$eval('#sheet-tac', (d) => d.open), 'ux: a toast over an open sheet can be pressed, and the sheet stays open');
  await page.evaluate(() => document.querySelector('#toast-container .toast')?.remove());
  const box = await page.locator('#sl-amt').boundingBox();
  await page.mouse.move(box.x + 20, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(2, 2); await page.mouse.up();
  ok(await page.$eval('#sheet-tac', (d) => d.open), 'ux: a drag that starts in the sheet and ends on the backdrop leaves it open');
  await page.fill('#sl-amt', '1,500');
  await page.locator('#sl-amt').blur();                                       // 1,500 is flagged on leaving the field, not while it may still be typed
  const hintSays = (re) => until(page, (r) => new RegExp(r).test(document.querySelector('[data-amt-hint]')?.textContent || ''), re.source, 5000).then(() => true, () => false);
  ok(await hintSays(/Write 1500 for fifteen hundred, or 1,5 for a decimal comma/), 'ux: an ambiguous 1,500 says how to write it');
  await page.fill('#sl-amt', '1.2.3');
  ok(await hintSays(/cannot be read/), 'ux: an unreadable amount says so');
  await page.fill('#sl-amt', '1');
  ok(!(await page.$('[data-amt-hint]')), 'ux: a readable amount shows no hint');
  await page.evaluate(() => { location.hash = '#farm'; });
  await page.waitForSelector('#sheet-farm[open]', { timeout: 60000 });
  await sleep(600);
  ok((await page.evaluate(() => location.hash)) === '#farm', 'ux: one sheet replacing another keeps the new sheet\'s link in the address bar');
  await page.goto(url + '#constructor');
  await page.waitForSelector('.tile');
  await page.evaluate(() => { location.hash = '#points'; });
  await page.waitForSelector('#sheet-pts[open]', { timeout: 60000 });
  ok(true, 'ux: a hash that names no sheet is ignored, and later links still open their sheets');
});

await step('apr', async () => {
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await until(page, () => /APR now\s*(about [\d,]+%|over 100,000%)/.test(document.querySelector('#farm-precision')?.textContent || ''), null, 120000);
  const rows = await page.$$eval('.farm .rate', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  const card = await page.$eval('#farm-precision', (e) => e.textContent.replace(/\s+/g, ' '));
  console.log('   rows:', rows.join(' | '));
  console.log('   card:', (card.match(/APR now[^.]*\./) || [''])[0]);
  ok(rows.length >= 2 && rows.every((r) => /APR/.test(r)) && /APR now\s*(about [\d,]+%|over 100,000%)/.test(card), 'apr: every farm shows its APR now, the public card in full');
  await until(page, () => /APR on TAC\/ETH/.test(document.querySelector('[data-foot="farm"]')?.textContent || ''), null, 60000).catch(() => {});
  const foot = (await text(page, '[data-foot="farm"]')).trim();
  ok(/^(\d[\d,]*%|10,000%\+) APR on TAC\/ETH$/.test(foot), `apr: the Farm tile leads with the public farm's APR (${foot})`);
});

await step('farmgate', async () => {
  const r = await openPage({ account: A0, key: K0 });
  try {
    await r.page.goto(r.url + '#farm');
    await r.page.waitForSelector('#pf-connect', { timeout: 120000 });
    ok(!!(await r.page.$('#pf-tacit')), 'farmgate: with nobody connected the farm offers a browser wallet, and a Tacit wallet instead');
    await r.page.click('#pf-tacit');
    await r.page.waitForSelector('#farm-precision-in [data-in]', { timeout: 30000 });
    ok(!(await r.page.$('#pf-connect')) && !!(await r.page.$('#pf-back')) && (await r.page.$$('#farm-precision-in [data-in]')).length >= 2, 'farmgate: the ways into a Tacit wallet open in place, with a way back');
    await r.page.click('#pf-back');
    await r.page.waitForSelector('#pf-connect', { timeout: 30000 });
    ok(true, 'farmgate: and back to the browser wallet');
    if (r.errors.length) { fails++; console.log('FAIL farmgate page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

await step('pair', async () => {
  // The account starts with no TAC, whatever mainnet holds for it at the fork block, so Max says what is missing.
  const held = await tacOf(A0);
  if (held > 0n) await rpc('eth_sendTransaction', [{ from: A0, to: TAC, data: '0xa9059cbb' + addrWord(RESERVE) + word(held) }]);
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await page.waitForSelector('[data-pfm="pair"]', { timeout: 60000 });
  await page.click('[data-pfm="pair"]');
  await until(page, () => /You hold no TAC/.test(document.querySelector('#farm-precision .how')?.textContent || ''), null, 60000);
  ok(!!(await page.$('#farm-precision .how [data-go="buy"]')) && !!(await page.$('#farm-precision .how [data-go="eth"]')), 'pair: with no TAC held the form says so before anything is typed, with ways on');
  await page.click('#pf-max');
  ok(!(await page.inputValue('#pf-amt')) && !(await page.inputValue('#pf-tac')), 'pair: and Max does not invent a deposit the TAC cannot pay for');
  await page.fill('#pf-amt', '0.002');
  await until(page, () => /Not enough TAC/.test(document.querySelector('#pf-rcpt')?.textContent || ''), null, 240000);
  ok(await page.isDisabled('#pf-go') && !!(await page.$('#pf-rcpt [data-go="eth"]')), 'pair: a typed ETH amount still says TAC is missing, and offers ETH alone');
  await fundTac(A0, 1000n * 10n ** 18n);
  await page.evaluate(() => { location.hash = ''; location.hash = '#farm'; });
  await until(page, () => /[1-9]/.test(document.querySelector('#pf-tmax')?.textContent || ''), null, 120000);
  // The no-TAC amount kept in the field re-quotes as "Not enough TAC"; clear it so the wait below sees Max's own quote.
  await page.fill('#pf-amt', '');
  await until(page, () => document.querySelector('#pf-rcpt')?.hidden, null, 60000);
  // ETH Max with TAC as the limit: the pair is sized from the TAC held, so neither field rounds past a balance.
  await page.click('#pf-max');
  await until(page, () => !document.querySelector('#pf-go').disabled || /Not enough|refuse/.test(document.querySelector('#pf-rcpt')?.textContent || ''));
  ok(!(await page.isDisabled('#pf-go')), `pair: ETH Max with TAC as the limit fills a deposit the TAC covers (${await page.inputValue('#pf-tac')} TAC, ${await page.inputValue('#pf-amt')} ETH)`);
  ok(/^\d*\.?\d{0,8}$/.test(await page.inputValue('#pf-amt')) && /^\d*\.?\d{0,6}$/.test(await page.inputValue('#pf-tac')), 'pair: both fields read to a few decimals, not 18 digits');
  await page.fill('#pf-amt', '0.002');
  await until(page, () => !document.querySelector('#pf-go').disabled || /\S/.test(document.querySelector('#pf-status')?.textContent || ''));
  if (await page.isDisabled('#pf-go')) throw new Error(`the ETH + TAC deposit stayed disabled: ${await text(page, '#pf-status')} | ${await text(page, '#pf-rcpt')}`);
  const s0 = await stakedOf(A0), t0 = await tacOf(A0);
  await page.click('#pf-go');
  await until(page, () => /Staked/.test(document.querySelector('#toast-container')?.textContent || '') || !!document.querySelector('#farm-precision .status .err'));
  ok((await stakedOf(A0)) > s0 && (await tacOf(A0)) < t0, `pair: ETH + TAC staked with a permit ${await text(page, '#pf-status')}`);
});

await step('farm', async () => {
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await page.waitForSelector('[data-pfm="eth"]', { timeout: 60000 });
  await page.click('[data-pfm="eth"]');
  // The pool's depth at the fork block decides how big a zap crosses the loss gate: the size grows until it asks.
  let gated = false;
  for (const amt of ['0.05', '0.5', '2', '8']) {
    await page.fill('#pf-amt', amt);
    if ((gated = await page.waitForSelector('#pf-ackv', { timeout: 20000 }).then(() => true, () => false))) break;
  }
  if (!gated) {
    if (process.env.DEBUG) console.log('   farm state:', JSON.stringify(await page.evaluate(() => ({ amt: document.querySelector('#pf-amt')?.value, open: document.querySelector('.farm.open')?.dataset.farm, mode: document.querySelector('[data-pfm][aria-selected="true"]')?.dataset.pfm, rcpt: document.querySelector('#pf-rcpt')?.textContent.replace(/\s+/g, ' '), status: document.querySelector('#pf-status')?.textContent, go: document.querySelector('#pf-go')?.disabled }))));
    throw new Error('farm: no zap size up to 8 ETH asked for its loss to be accepted');
  }
  ok(await page.isDisabled('#pf-go'), 'farm: a zap this size waits for its loss to be accepted');
  for (let i = 0; i < 5 && await page.isDisabled('#pf-go'); i++) {              // a requote can move the loss by a point
    // The pool's depth on the fork decides the gate: a tick box from 15% loss, a typed percent from 30%.
    if (await page.$eval('#pf-ackv', (x) => x.type === 'checkbox')) await page.check('#pf-ackv');
    else await page.fill('#pf-ackv', await page.$eval('.ack b', (b) => b.textContent));
    await sleep(1500);
    if (process.env.DEBUG) console.log('   ', JSON.stringify(await page.evaluate(() => ({ go: document.querySelector('#pf-go')?.disabled, ack: document.querySelector('#pf-ackv')?.value, b: document.querySelector('.ack b')?.textContent, mode: document.querySelector('[data-pfm][aria-selected="true"]')?.dataset.pfm, status: document.querySelector('#pf-status')?.textContent, rcpt: document.querySelector('#pf-rcpt')?.textContent }))));
  }
  ok(!(await page.isDisabled('#pf-go')), 'farm: typing the loss enables the zap');
  const rcpt = (await text(page, '#pf-rcpt')).replace(/\s+/g, ' '), cardApr = (await text(page, '#farm-precision')).replace(/\s+/g, ' ');
  const depA = parseFloat(((rcpt.match(/APR on this deposit\s*about ([\d,]+)%/) || [])[1] || '').replace(/,/g, ''));
  const nowA = parseFloat(((cardApr.match(/APR now\s*about ([\d,]+)%/) || [])[1] || '').replace(/,/g, ''));
  ok(depA > 0 && /Swap fees come on top/.test(rcpt) && /TAC a day \((≈ [\d.,]+|< 0\.00001) ETH\)/.test(rcpt), `farm: the deposit preview shows the APR for this deposit, in ETH a day too (${depA}%)`);
  ok(nowA > 0 && depA <= nowA * 1.005, `farm: and it is never above the farm's APR now (${depA}% on this deposit, ${nowA}% now)`);
  await shot(page, 'farm-zap');
  await page.click('#pf-go');
  await page.waitForSelector('#pf-exit', { timeout: 60000 });
  ok((await stakedOf(A0)) > 0n, 'farm: zapETH staked');
  const e0 = await text(page, '#pf-earned'); await sleep(3500); const e1 = await text(page, '#pf-earned');
  const seen = []; for (let i = 0; i < 8; i++) { seen.push(parseFloat(await text(page, '#pf-earned'))); await sleep(500); }
  ok(seen.every((v, i) => !i || v >= seen[i - 1]), `farm: and never counts down when a fresh read lands (${seen.join(' → ')})`);
  ok(!!e0 && e0 !== e1 && parseFloat(e1) > parseFloat(e0), `farm: what the stake has earned counts up while the sheet is open (${e0} → ${e1})`);
  const eth0 = (await text(page, '#pf-earned-eth')).trim();
  ok(/^(< )?[\d.,]+ ETH$/.test(eth0), `farm: what it has earned also reads in ETH (${eth0} for ${e1.trim()})`);
  ok(/Swap fees stay in the pool/.test(await text(page, '#farm-precision')), 'farm: the stake says its swap fees are already in its value');
  ok(/TAC a day \((≈ [\d.,]+|< 0\.00001) ETH\)/.test(await text(page, '#farm-precision')), 'farm: and what it earns a day');
  ok(!/Claimed so far/.test(await text(page, '#farm-precision')), 'farm: nothing is under Claimed so far before a first claim');
  await rpc('evm_increaseTime', [60]); await rpc('evm_mine', []);
  await page.evaluate(() => { location.hash = ''; location.hash = '#farm'; });
  await until(page, () => { const b = document.querySelector('#pf-claim'); return b && !b.disabled; });
  await until(page, () => /to claim/.test(document.querySelector('[data-dash-open="farm"] .di-m')?.textContent || ''), null, 60000).catch(() => {});
  const dm = (await text(page, '[data-dash-open="farm"] .di-m')).trim();
  ok(/^(≈ [\d.,]+|< 0\.00001) ETH to claim$/.test(dm), `farm: the dashboard's farm rewards say what there is to claim, in ETH (${dm})`);
  const before = await tacOf(A0);
  await page.click('#pf-claim');
  await until(page, () => /TAC claimed/.test(document.querySelector('#toast-container')?.textContent || ''));
  ok((await tacOf(A0)) > before, 'farm: claim pays TAC');
  const got = Number((await tacOf(A0)) - before) / 1e18;
  await until(page, () => /Claimed so far/.test(document.querySelector('#farm-precision')?.textContent || ''), null, 180000);
  const shown = parseFloat(((await text(page, '#farm-precision')).match(/Claimed so far\s*([\d.,]+) TAC/) || [])[1]?.replace(/,/g, ''));
  ok(Math.abs(shown - got) <= 0.006 + got * 0.001, `farm: the claim then shows under Claimed so far (${shown} TAC for ${got.toFixed(4)} paid)`);
  await page.waitForSelector('#pf-exit');
  await page.click('#pf-exit');
  await until(page, () => /Withdrawn/.test(document.querySelector('#toast-container')?.textContent || '') || !!document.querySelector('#farm-precision .status .err'));
  ok((await stakedOf(A0)) === 0n, `farm: withdraw all leaves nothing staked ${await text(page, '#pf-status')}`);
});

await step('reinvest', async () => {
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await page.waitForSelector('[data-pfm="eth"]', { timeout: 60000 });
  await page.click('[data-pfm="eth"]');
  await page.fill('#pf-amt', '2');
  await acceptLoss(page, '#pf-go', '#pf-ackv');
  if (await page.isDisabled('#pf-go')) throw new Error(`the deposit stayed disabled: ${await text(page, '#pf-rcpt')}`);
  await page.click('#pf-go');
  await page.waitForSelector('#pf-exit', { timeout: 60000 });
  await rpc('evm_increaseTime', [3600]); await rpc('evm_mine', []);
  await page.evaluate(() => { location.hash = ''; location.hash = '#farm'; });
  await until(page, () => { const b = document.querySelector('#pf-reinvest'); return b && !b.disabled; });
  const t0 = await tacOf(A0), s0 = await stakedOf(A0);
  await page.click('#pf-reinvest');
  if (!await chainUntil(async () => (await tacOf(A0)) > t0)) throw new Error('the claim did not pay');
  const got = Number((await tacOf(A0)) - t0) / 1e18;
  await until(page, () => document.querySelector('[data-pfm="tac"]')?.getAttribute('aria-selected') === 'true' && /\d/.test(document.querySelector('#pf-tac')?.value || ''), null, 180000);
  const filled = parseFloat(await page.inputValue('#pf-tac'));
  ok(Math.abs(filled - got) <= 0.006 + got * 0.001, `reinvest: the add form opens on TAC with what was claimed (${filled} of ${got.toFixed(4)})`);
  ok(/ready to farm below/.test(await text(page, '#pf-status')), 'reinvest: and says so');
  await acceptLoss(page, '#pf-go', '#pf-ackv');
  ok(!(await page.isDisabled('#pf-go')), 'reinvest: Farm with TAC is ready');
  await page.click('#pf-go');
  ok(await chainUntil(async () => (await stakedOf(A0)) > s0), 'reinvest: the claimed TAC is staked again');
  await page.waitForSelector('#pf-exit');
  await page.click('#pf-exit');
  await chainUntil(async () => (await stakedOf(A0)) === 0n);
});

await step('buy', async () => {
  await page.goto(url + '#buy');
  if (await page.$('#buy-connect')) await page.click('#buy-connect');
  await page.waitForSelector('#b-amt');
  await page.fill('#b-amt', '0.0005');
  await until(page, () => !document.querySelector('#b-go').disabled, null, 240000);   // a cold fork makes the lens scan slow
  const t0 = await tacOf(A0);
  await page.click('#b-go');
  await until(page, () => /Bought|err/.test(document.querySelector('#b-status')?.innerHTML || ''));
  ok((await tacOf(A0)) > t0, `buy: TAC arrives ${await text(page, '#b-status')}`);
});

await step('tacfarm', async () => {
  if ((await tacOf(A0)) < 100n * 10n ** 18n) await fundTac(A0, 1000n * 10n ** 18n);
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await page.waitForSelector('[data-pfm="tac"]', { timeout: 60000 });
  await page.click('[data-pfm="tac"]');
  await page.fill('#pf-tac', '20');
  await acceptLoss(page, '#pf-go', '#pf-ackv');
  const s0 = await stakedOf(A0), t0 = await tacOf(A0);
  await page.click('#pf-go');
  await chainUntil(async () => (await stakedOf(A0)) > s0);
  ok((await stakedOf(A0)) > s0 && t0 - (await tacOf(A0)) <= 20n * 10n ** 18n, `tacfarm: TAC alone staked with a permit ${await text(page, '#pf-status')}`);
  ok((await allowanceOf(TAC, A0, FARM)) === 0n, 'tacfarm: the permit leaves no allowance behind');
  await page.waitForSelector('[data-pfp="50"]');
  await page.click('[data-pfp="50"]'); await page.click('[data-pfr="eth"]');
  await acceptLoss(page, '#pf-exit', '#pf-outv');
  const st1 = await stakedOf(A0), tac1 = await tacOf(A0);
  await page.click('#pf-exit');
  await chainUntil(async () => (await stakedOf(A0)) < st1);
  const st2 = await stakedOf(A0);
  ok(st2 > 0n && st2 * 2n >= st1 - 1n && st2 * 2n <= st1 + 1n && (await tacOf(A0)) <= tac1, `tacfarm: half withdrawn as ETH, half still staked ${await text(page, '#pf-status')}`);
  await rpc('eth_sendTransaction', [{ from: A0, to: FARM, data: '0x2e1a7d4d' + word(st2 / 2n) }]);   // withdraw(shares): LP held, not staked
  await page.evaluate(() => { location.hash = ''; location.hash = '#farm'; });
  await page.waitForSelector('#pf-stake', { timeout: 60000 });
  await page.click('#pf-stake');
  await chainUntil(async () => (await stakedOf(A0)) === st2);
  ok((await stakedOf(A0)) === st2, `tacfarm: LP held is staked again with a permit ${await text(page, '#pf-lp-status')}`);
  await page.waitForSelector('#pf-stake', { state: 'detached', timeout: 120000 });     // the page ignores tab presses until the stake has finished drawing
  await page.waitForSelector('[data-pfp="100"]');
  await page.click('[data-pfp="100"]'); await page.click('[data-pfr="tac"]');
  await acceptLoss(page, '#pf-exit', '#pf-outv');
  const tac2 = await tacOf(A0);
  await page.click('#pf-exit');
  await chainUntil(async () => (await stakedOf(A0)) === 0n);
  ok((await stakedOf(A0)) === 0n && (await tacOf(A0)) > tac2, `tacfarm: exit all as TAC leaves nothing staked ${await text(page, '#pf-status')}`);
});

await step('sell', async () => {
  // A fresh EOA: the anvil keys carry sweeper code on mainnet, which forwards ETH on before a router can count it.
  const key = '0x' + Buffer.from(secp.utils.randomPrivateKey()).toString('hex');
  const who = '0x' + Buffer.from(keccak_256(secp.getPublicKey(key.slice(2), false).slice(1)).slice(12)).toString('hex');
  await rpc('anvil_impersonateAccount', [who]); await rpc('anvil_setBalance', [who, '0x' + (10n ** 17n).toString(16)]);
  await fundTac(who, 100n * 10n ** 18n);
  const r = await openPage({ account: who, key });
  try {
    await r.page.goto(r.url + '#sell');
    await r.page.waitForSelector('#sell-connect, #sl-amt', { timeout: 60000 });
    if (await r.page.$('#sell-connect')) await r.page.click('#sell-connect');
    await r.page.waitForSelector('#sl-amt');
    await r.page.fill('#sl-amt', '25');
    await acceptLoss(r.page, '#sl-go', '#sl-ackv');
    const e0 = BigInt(await rpc('eth_getBalance', [who, 'latest'])), n0 = BigInt(await rpc('eth_getTransactionCount', [who, 'latest']));
    await r.page.click('#sl-go');
    await until(r.page, () => /Sold|class="err"/.test(document.querySelector('#sl-status')?.innerHTML || ''), null, 240000);
    ok((await tacOf(who)) === 75n * 10n ** 18n, `sell: 25 TAC sold ${await text(r.page, '#sl-status')}`);
    ok(BigInt(await rpc('eth_getTransactionCount', [who, 'latest'])) === n0 + 1n && (await allowanceOf(TAC, who, ZROUTER)) === 0n, 'sell: one transaction, the permit riding inside it, no allowance left');
    ok(BigInt(await rpc('eth_getBalance', [who, 'latest'])) > e0, 'sell: ETH arrives, net of gas');
  } finally { await r.browser.close(); await rpc('anvil_stopImpersonatingAccount', [who]); }
});

await step('v1', async () => {
  await page.goto(url + '#private');
  await page.waitForSelector('#eth-v1 [data-in="eth"]', { timeout: 60000 });
  await page.click('#eth-v1 [data-in="eth"]');
  await page.waitForSelector('#w-amt', { timeout: 120000 });
  await page.fill('#w-amt', '0.01');
  await until(page, () => !document.querySelector('#w-go').disabled);
  const n0 = submits.length;
  await page.click('#w-go');
  await until(page, () => /stubbed|failed|err/i.test(document.querySelector('#v1-status')?.innerHTML || ''), null, 1200000);   // two log walks on a cold fork
  ok(submits.slice(n0).some((s) => s.type === 'wrap'), `v1: the tipped deposit landed and its settle was submitted ${(await text(page, '#v1-status')).slice(0, 80)}`);
  ok(/press Finish/i.test(await text(page, '#v1-status')), `v1: a settle that fails after its deposit landed points to Finish, not to another deposit (${(await text(page, '#v1-status')).slice(0, 110)})`);
});

// The relay refuses a wrap's settle outright once its deposit has landed (its free settles for the day are used up):
// the form empties, and the line says why and that the deposit waits for Finish, rather than asking for it again.
await step('v1refuse', async () => {
  const r = await openPage({ account: A0, key: K0 });
  try {
    await r.page.goto(r.url + '#private');
    await r.page.waitForSelector('#eth-v1 [data-in="eth"]', { timeout: 60000 });
    await r.page.click('#eth-v1 [data-in="eth"]');
    await r.page.waitForSelector('#w-amt', { timeout: 120000 });
    refuseSubmits = 1;
    await r.page.fill('#w-amt', '0.01');
    await until(r.page, () => !document.querySelector('#w-go').disabled);
    await r.page.click('#w-go');
    // Where it is, once a minute, so a slow fork reads as slow rather than as a silent timeout.
    const where = setInterval(() => text(r.page, '#v1-status').then((t) => console.log(`     v1refuse … ${t.slice(0, 100)}`), () => {}), 60000);
    try { await until(r.page, () => /Press Finish|not private yet/.test(document.querySelector('#v1-status')?.textContent || ''), null, 1200000); } finally { clearInterval(where); }
    const kept = await text(r.page, '#v1-status');
    ok(/Your deposit is in the Tacit pool/.test(kept) && /free settles for today are used up/.test(kept) && /no need to send it again/.test(kept)
      && await r.page.$eval('#w-amt', (i) => i.value === '') && await r.page.$eval('#w-go', (b) => b.disabled), `v1refuse: a settle the relay refuses after the deposit empties the form and points to Finish (${kept.slice(0, 130)})`);
    ok(await until(r.page, () => !!document.querySelector('#v1-finish'), null, 600000).then(() => true, () => false), 'v1refuse: the deposit is then offered to Finish');
    // Or from the wallet: the relay is asked for the proof only, and settle() goes to the pool from the wallet. The
    // proof is a stand-in here, so the pool refuses it and the page says so; the deposit is still offered after.
    ok(/Or finish from your wallet/.test(await text(r.page, '#v1-finish-self')), 'v1refuse: it can also be finished from the wallet');
    const wrapSub = refused.findLast((x) => x.type === 'wrap');
    proveStub = true;
    const n1 = submits.length, t1 = walletTxs.length, before = await r.page.$eval('#v1-status', (e) => e.innerHTML);
    await r.page.click('#v1-finish-self');
    await until(r.page, (b) => { const h = document.querySelector('#v1-status')?.innerHTML || ''; return h !== b && /class="err"/.test(h); }, before, 600000);
    const prove = submits.slice(n1).find((x) => x.type === 'wrap' && x.op.cx === wrapSub?.op.cx);   // every waiting deposit is finished, this one among them
    const settle = walletTxs.slice(t1).find((x) => String(x.to).toLowerCase() === '0x000000000ed1eabd231be41d93b719056f7febfc');
    ok(prove?.mode === 'prove' && prove.op.cx === wrapSub?.op.cx && prove.op.owner === wrapSub?.op.owner, 'v1refuse: finishing from the wallet asks the relay for this deposit\'s proof only');
    ok(settle && settle.from.toLowerCase() === A0 && settle.data.startsWith('0x' + Buffer.from(keccak_256(Buffer.from('settle(bytes,bytes,bytes[])'))).toString('hex').slice(0, 8)),
      `v1refuse: and sends settle() to the pool from the wallet (${(await text(r.page, '#v1-status')).slice(0, 90)})`);
    // The same from its receipt, once it has waited in line: a receipt as another tab of this page would write it (the
    // page takes in what other tabs write), still queued, for the deposit the scan above found waiting.
    const depositId = depositIdOf(wrapSub.op);
    await r.ctx.route(/\/confidential\/status\?id=stub-inline/, (route) => json(route, { jobId: 'stub-inline', type: 'wrap', mode: 'settle', status: 'pending', txHash: null, error: null, createdAt: Date.now() }));
    await r.page.evaluate((dep) => {
      const k = 'tacit-lite-activity-v1', s = JSON.parse(localStorage.getItem(k) || '{"items":[]}'), t = Date.now();
      s.items.unshift({ id: 'job:stub-inline', kind: 'job', type: 'wrap', label: 'Finish a 0.01 tETH deposit', status: 'pending', at: t - 120e3, up: t - 120e3, self: { deps: ['d:' + dep] } });
      dispatchEvent(new StorageEvent('storage', { key: k, newValue: JSON.stringify(s) }));
    }, depositId);
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await r.page.click('#act'); await r.page.waitForSelector('#sheet-act[open]');
    const inline = () => r.page.evaluate(() => document.querySelector('[data-act="job:stub-inline"]')?.textContent.replace(/\s+/g, ' ').trim() || '');
    const offered = await until(r.page, () => /Finish it from your wallet/.test(document.querySelector('[data-act="job:stub-inline"]')?.textContent || ''), null, 60000).then(() => true, () => false);
    ok(offered, `v1refuse: a deposit's receipt in line offers to finish it from the wallet (${(await inline()).slice(0, 160)})`);
    const t2 = walletTxs.length;
    if (offered) {
      await r.page.click('[data-act="job:stub-inline"] [data-self]');
      await until(r.page, () => !!document.querySelector('[data-act="job:stub-inline"] .actr-f.err'), null, 600000).catch(() => {});
      ok(walletTxs.slice(t2).some((x) => String(x.to).toLowerCase() === '0x000000000ed1eabd231be41d93b719056f7febfc'), `v1refuse: pressed, it proves and sends from the wallet, and a refusal shows on the receipt (${(await inline()).slice(0, 160)})`);
    }
    if (offered) {
      // From an account that cannot pay the network fee, the receipt says so before the relay is asked to prove anything.
      await rpc('anvil_setBalance', [A0, '0x0']);
      try {
        const n3 = submits.length, btn = await r.page.$('[data-act="job:stub-inline"] [data-self]');
        if (btn) await btn.click();
        const said = btn ? await until(r.page, () => /pays the network fee/.test(document.querySelector('[data-act="job:stub-inline"]')?.textContent || ''), null, 60000).then(() => true, () => false) : false;
        ok(!!btn && said && submits.length === n3, `v1refuse: an account that cannot pay the network fee is told so before the relay is asked to prove (${(await inline()).slice(0, 120)})`);
      } finally { await rpc('anvil_setBalance', [A0, '0x' + (10000n * 10n ** 18n).toString(16)]); }
    }
    if (r.errors.length) { fails++; console.log('FAIL v1refuse page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { refuseSubmits = 0; proveStub = false; await r.browser.close(); }
});

await step('devsend', async () => {
  await page.goto(url + '#device');
  if (await page.$('#eth-dev [data-in="eth"]')) await page.click('#eth-dev [data-in="eth"]');
  await page.waitForSelector('[data-dev="send"]', { timeout: 60000 });
  await page.click('[data-dev="receive"]');
  await page.waitForSelector('#d-form [data-copy]', { timeout: 120000 });
  const recv = await page.evaluate(() => ({ bp1: document.querySelector('#d-form [data-copy]')?.dataset.copy, ask: document.querySelector('#d-form a[href^="/pay/eth/#receive"]')?.getAttribute('href') }));
  ok(/^bp1/.test(recv.bp1 || '') && /^\/pay\/eth\/#receive&chain=\d+$/.test(recv.ask || ''), `devsend: Receive keeps the pool and deposit addresses here, and asks for an amount in tacit pay (${recv.ask})`);
  // Paying from this balance is tacit pay's (tools/pay-check.mjs covers it): the tab opens it on the same chain.
  await page.click('[data-dev="send"]');
  const links = await page.$$eval('#d-form a', (as) => as.map((a) => a.getAttribute('href')));
  ok(links.some((h) => /^\/pay\/eth\/#send&chain=\d+$/.test(h)) && links.some((h) => /^\/pay\/eth\/#link&chain=\d+$/.test(h)), `devsend: Send opens tacit pay on this chain (${links.join(', ')})`);
});

await step('device', async () => {
  await page.goto(url + '#device');
  if (await page.$('#eth-dev [data-in="eth"]')) await page.click('#eth-dev [data-in="eth"]');
  await page.waitForSelector('[data-chain="1"]', { timeout: 60000 });
  await page.click('[data-chain="1"]');
  await page.waitForSelector('#d-amt', { timeout: 60000 });
  // Paying from this balance is tacit pay's: the Send tab opens it on the chain picked here.
  await page.click('[data-dev="send"]');
  const hl = await page.$$eval('#d-form a', (as) => as.map((a) => a.getAttribute('href')));
  ok(['/pay/eth/#send&chain=1', '/pay/eth/#link&chain=1'].every((h) => hl.includes(h)), `device: Send opens tacit pay on the chain picked here (${hl.join(' ')})`);
  // DEV.mode (the sub-tab) persists across sheet reopens, a deliberate feature: a scenario run right after devsend
  // (which leaves it on Send) must not inherit that here.
  await page.click('[data-dev="deposit"]');
  await page.waitForFunction(() => /Deposit/.test(document.querySelector('#d-go')?.textContent || ''));
  await page.fill('#d-amt', '0.01');
  await page.click('#d-go');
  await until(page, () => /Deposited|err/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  await shot(page, 'device');
  ok(/Deposited/.test(await text(page, '#d-status')), `device: proved here and deposited ${(await text(page, '#d-status')).slice(0, 60)}`);
});

await step('borrow', async () => {
  await page.goto(url + '#borrow');
  await page.waitForSelector('#bw-lock, #borrow-body [data-in="eth"]', { timeout: 60000 });
  if (await page.$('#borrow-body [data-in="eth"]')) { await page.click('#borrow-body [data-in="eth"]'); await page.waitForSelector('#bw-lock', { timeout: 120000 }); }
  ok(/^bc1q/.test(await page.$eval('#borrow-body [data-copy]', (b) => b.dataset.copy)), 'borrow: the Bitcoin deposit address renders');
  const lag = await page.$eval('#borrow-body', (e) => (e.textContent.match(/It is at block [\d,]+, [\d,]+ behind Bitcoin( and catching up)?\./) || [''])[0]);
  ok(/at block [\d,]+, [\d,]+ behind Bitcoin/.test(lag), `borrow: before a lock, it says how far behind Bitcoin's proof is (${lag.slice(0, 90)})`);
  const pub = await page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('tacit-eth-identity-anchor:'))));
  await page.evaluate((p) => localStorage.setItem(`tacit-lite-cbtc-v1:${p}`, JSON.stringify({ lockTxid: 'aa'.repeat(32), lockVout: 1, vBtc: '20000', anchor: { txid: 'bb'.repeat(32), vout: 0 }, at: Date.now() })), pub);
  await page.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
  await page.waitForSelector('#bw-bond', { timeout: 120000 });
  await page.click('#bw-bond');
  await until(page, () => /Bond posted/.test(document.querySelector('#toast-container')?.textContent || '') || /err/.test(document.querySelector('#bw-status')?.innerHTML || ''));
  await shot(page, 'borrow');
  ok(/Bond posted/.test(await text(page, '#toast-container')), `borrow: the bond posts through the helper ${await text(page, '#bw-status')}`);
  const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', wst = async (x) => BigInt(await rpc('eth_call', [{ to: WSTETH, data: '0x70a08231' + addrWord(x) }, 'latest']));
  await page.waitForSelector('[data-bond-take]', { timeout: 120000 });
  ok(/not minted yet, can come back/.test(await text(page, '#bw-bonds')), `borrow: the bond shows under Your bonds as one that can come back (${(await text(page, '#bw-bonds')).slice(0, 120)})`);
  const w0 = await wst(A0);
  await page.click('[data-bond-take]');
  await chainUntil(async () => (await wst(A0)) > w0, 120000);
  ok((await wst(A0)) > w0, `borrow: a bond on a lock not minted comes back to the account that posted it ${await text(page, '#bw-status')}`);
});

// A bond whose lock the pool records as minted on and then spent on Bitcoin (the pool's own flags for a fixture lock,
// set on the fork) is forfeit: the dashboard says so, the borrow sheet shows it with no way to take it back, and the
// dashboard's notice clears once the sheet has shown it.
await step('bonds', async () => {
  const HELPER = '0x000000008eCD09f922C9FbbDD9ACA5aE8F0beBfA', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
  const OP = Buffer.from(keccak_256(Buffer.concat([Buffer.from('cd'.repeat(32), 'hex'), Buffer.from([1, 0, 0, 0])]))).toString('hex');
  const slot = (n) => '0x' + Buffer.from(keccak_256(Buffer.from(OP + word(n), 'hex'))).toString('hex');
  const flag = (n, v) => rpc('anvil_setStorageAt', [POOL, slot(n), '0x' + word(v)]);   // 123 lock sats, 125 spent, 127 minted
  const h = await rpc('eth_sendTransaction', [{ from: A0, to: HELPER, data: '0xc0e2d9a1' + OP, value: '0x' + (10n ** 15n).toString(16) }]);
  await chainUntil(async () => (await rpc('eth_getTransactionReceipt', [h]))?.status === '0x1', 60000);
  await flag(123, 20000); await flag(127, 1); await flag(125, 1);
  try {
    // The same key the borrow step opened, reopened from the wallet sheet if the reload closed it (the borrow sheet would
    // mark the forfeit seen before the dashboard could show it).
    await page.goto(url + '#wallet');
    await page.reload();                                             // a new page: nothing read before the flags were set
    await page.waitForSelector('#wallet-body [data-in], #wallet-dot.on', { state: 'attached', timeout: 60000 });
    if (!(await page.$('#wallet-dot.on'))) {
      await page.click((await page.$('#wallet-body [data-in="known"]')) ? '#wallet-body [data-in="known"]' : '#wallet-body [data-in="eth"]');
      await until(page, () => !!document.querySelector('#wallet-dot.on'), null, 60000);
    }
    await page.keyboard.press('Escape');
    const due = () => page.evaluate(() => document.querySelector('#dash-due')?.textContent || '');
    await until(page, () => /spent on Bitcoin before its cBTC was redeemed/.test(document.querySelector('#dash-due')?.textContent || ''), null, 120000)
      .catch(async () => { throw new Error(`no forfeit notice on the dashboard (${(await due()).slice(0, 160)})`); });
    ok(/insurance reserve/.test(await due()), 'bonds: the dashboard says a bond was forfeit, and where it goes');
    // Announced once, as a toast, when first read (which may have been just before the reload): recorded as told.
    const told = await page.evaluate((op) => Object.keys(localStorage).filter((k) => k.startsWith('tacit-lite-bonds-seen-v1:'))
      .some((k) => (JSON.parse(localStorage.getItem(k))?.ids || []).includes(`lost:0x${op}`)), OP);
    ok(told, 'bonds: the forfeit is announced once when it is first seen');
    await page.click('[data-dash-do="bonds"]');
    await until(page, () => /forfeit/.test(document.querySelector('#bw-bonds')?.textContent || ''), null, 120000);
    ok(/was spent on Bitcoin before its cBTC was redeemed/.test(await text(page, '#bw-bonds .callout.bad')), 'bonds: the borrow sheet shows the forfeit bond with a notice');
    await page.$eval('#bw-bonds', (e) => e.scrollIntoView({ block: 'start' }));
    await shot(page, 'bonds');
    ok(!(await page.$(`[data-bond-take^="0x${OP}"]`)), 'bonds: a forfeit bond offers no take-back');
    await page.keyboard.press('Escape');
    await until(page, () => !/spent on Bitcoin before its cBTC was redeemed/.test(document.querySelector('#dash-due')?.textContent || ''), null, 30000).catch(() => {});
    ok(!/spent on Bitcoin before its cBTC was redeemed/.test(await due()), 'bonds: once the sheet has shown it, the dashboard stops pointing at it');
  } finally {
    // The fixture lock goes back to never recorded, and the wallet takes its bond back.
    await flag(125, 0); await flag(127, 0); await flag(123, 0);
    await rpc('eth_sendTransaction', [{ from: A0, to: HELPER, data: '0xc5211d27' + OP }]);
  }
});

// tacit.finance's own Borrow tab: a pending cBTC lock asks for its bond, the bond posts through the escrow helper from
// the wallet's Tacit account, the row waits for the reflection, and once the pool records the lock it offers the mint.
const { makeEvmAccount } = await import(new URL('../dapp/evm-account.js', import.meta.url));
await step('mainbond', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const root = r.url + 'classic.html', hex = 'bd'.padEnd(64, '5'), pass = 'correct horse battery staple';
  const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', ENGINE = '0x000000003f608BDdF0ca45934003ffb9DbDF70DB';
  const OP = Buffer.from(keccak_256(Buffer.concat([Buffer.from('aa'.repeat(32), 'hex'), Buffer.from([1, 0, 0, 0])]))).toString('hex');
  const call = async (to, data) => BigInt(await rpc('eth_call', [{ to, data }, 'latest']));
  const row = () => r.page.evaluate(() => [document.querySelector('.cbtc-step[data-i="0"]')?.textContent || '', document.querySelector('.cbtc-mint-pending-btn[data-i="0"]')?.textContent || '']);
  const rowIs = (re, timeout = 120000) => until(r.page, (s) => new RegExp(s).test(document.querySelector('.cbtc-step[data-i="0"]')?.textContent || ''), re.source, timeout);
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('#toast-container', { state: 'attached' });
    const saving = r.page.evaluate(async (h) => { globalThis.__TACIT_NO_INIT__ = true; const T = await import('/tacit.js'); await T.wallet.setPriv(h); }, hex);
    await r.page.waitForSelector('#pass-dialog[open] #pass-input-1', { timeout: 120000 });
    await r.page.fill('#pass-input-1', pass); await r.page.fill('#pass-input-2', pass); await r.page.click('#pass-submit');
    await saving;
    const lock = { lockTxid: 'aa'.repeat(32), lockVout: 1, vBtc: '20000', blinding: '0x' + '11'.repeat(32) };
    await r.page.evaluate((l) => { localStorage.setItem('tacit-active-mode-v1', 'local'); localStorage.setItem('tacit-cbtc-pending-locks-v1', JSON.stringify([l])); }, lock);
    const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
    await rpc('anvil_setBalance', [acct, '0x0']);                  // funded only once the tab has said how
    await r.page.goto(root);
    await r.page.waitForSelector('#toast-container', { state: 'attached' });
    await until(r.page, () => !!document.querySelector('[data-tab="cdp"]'));
    // Unlock the saved key through tacit.finance's own wallet. The page evaluates a second copy of tacit.js
    // (amm-farm-ui.js imports it by bare path) and the tabs are wired by whichever copy set up last, so both unlock.
    const unlocked = [];
    for (const which of ['entry', 'bare']) {
      const unlocking = r.page.evaluate(async (w) => {
        const src = w === 'entry' ? document.querySelector('script[type="module"][src*="tacit.js"]').src : new URL('/tacit.js', location.href).href;
        const T = await import(src);
        if (!T.wallet.priv) await T.wallet.load(null);
        return !!T.wallet.priv;
      }, which).catch((e) => e.message);
      if (await r.page.waitForSelector('#pass-modal #pass-input-1', { state: 'visible', timeout: 60000 }).then(() => true, () => false)) {
        await r.page.fill('#pass-input-1', pass); await r.page.click('#pass-submit');
      }
      unlocked.push(await unlocking);
    }
    ok(unlocked.every((u) => u === true), `mainbond: the saved key unlocks in tacit.finance (${unlocked.join(', ')})`);
    const toTab = async (name) => {
      await until(r.page, (n) => typeof document.querySelector(`.tab[data-tab="${n}"]`)?.onclick === 'function', name, 120000);
      await r.page.evaluate((n) => document.querySelector(`.tab[data-tab="${n}"]`).click(), name);
    };
    const toBorrow = () => toTab('cdp');
    await toBorrow();
    await rowIs(/Needs its bond|price feed|Could not/);
    let [s, b] = await row();
    const fundLine = await r.page.evaluate(() => document.querySelector('.cbtc-fund[data-i="0"]')?.textContent || '');
    const off = () => r.page.$eval('.cbtc-mint-pending-btn[data-i="0"]', (x) => x.disabled);
    ok(/holds 0 ETH\. Top it up from a connected wallet[^]*send it at least [\d.]+ ETH on Ethereum/.test(s) && fundLine.toLowerCase().includes(acct.toLowerCase()) && b === 'Top up from wallet' && !(await off()),
      `mainbond: an unfunded Tacit account is named, with a top-up from the connected wallet (${s} | ${fundLine.trim()} [${b}])`);
    // One click: the connected wallet (anvil's first account) sends the shortfall, then the bond posts from the Tacit account.
    await r.page.click('.cbtc-mint-pending-btn[data-i="0"]');
    await rowIs(/Bonded\.|Needs its bond/, 180000).catch(() => {});
    await chainUntil(async () => (await call(ENGINE, '0xe06e89c9' + OP)) > 0n, 120000).catch(() => {});
    const [total, need] = await Promise.all([call(ENGINE, '0xe06e89c9' + OP), call(ENGINE, '0x034448ed' + word(20000))]);
    ok(need > 0n && total >= need, `mainbond: the bond is posted for the lock from the Tacit account (${total} of ${need} wstETH wei) ${await text(r.page, '#cdp-cbtc-status')}`);
    await until(r.page, () => /not minted yet, can come back/.test(document.querySelector('#cdp-cbtc-bonds')?.textContent || ''), null, 120000).catch(() => {});
    const bondsTxt = (await text(r.page, '#cdp-cbtc-bonds')).replace(/\s+/g, ' ');
    ok(/not minted yet, can come back/.test(bondsTxt) && !!(await r.page.$('#cdp-cbtc-bonds .cbtc-bond-take')), `mainbond: the Borrow tab lists the bond, with a way to take it back (${bondsTxt.slice(0, 140)})`);
    await rowIs(/Bonded\./);
    [s, b] = await row();
    ok(/Minting opens once the reflection records this lock/.test(s) && b === 'Waiting', `mainbond: then it waits for the reflection (${s} [${b}])`);
    // The reflection records the lock (cbtcLockVBtc, declaration slot 123): the row then offers the mint.
    await rpc('anvil_setStorageAt', [POOL, '0x' + Buffer.from(keccak_256(Buffer.from(OP + word(123), 'hex'))).toString('hex'), '0x' + word(20000)]);
    await toTab('market');
    await toBorrow();
    await rowIs(/Recorded and bonded/);
    [s, b] = await row();
    ok(b === 'Mint', `mainbond: once the pool records the lock, the row offers the mint (${s} [${b}])`);
    if (r.errors.length) { fails++; console.log('FAIL mainbond page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } catch (e) {
    await shot(r.page, 'mainbond-fail');
    const at = await r.page.evaluate(() => ({ loaded: performance.getEntriesByType('resource').map((x) => x.name).filter((n) => /\/tacit\.js/.test(n)),
      pending: document.querySelector('#cdp-cbtc-pending')?.textContent.replace(/\s+/g, ' ').slice(0, 200) ?? 'absent',
      status: document.querySelector('#cdp-cbtc-status')?.textContent.slice(0, 160),
      cdpTail: (document.querySelector('#cdp-body')?.textContent || '').replace(/\s+/g, ' ').slice(-260) })).catch(() => null);
    throw new Error(`${e.message.split('\n')[0]} | page ${JSON.stringify(at)} | errors ${r.errors.slice(0, 2).join(' | ')}`);
  } finally { await r.browser.close(); }
});

// Weld follows every lock a key made, found from its Bitcoin history alone (so a lock made on tacit.finance or another
// device counts): the tile names the next step, the sheet opens on the oldest lock still to mint, lists the others, and
// can make another. Esplora is stubbed to show two locks paying the key's lock script.
const { makeBtcHistoryProvider } = await import(new URL('../dapp/confidential-recovery-btc.js', import.meta.url));
await step('locks', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'feed'.padEnd(64, '9');
  const spk = makeBtcHistoryProvider({ sha256, fetchImpl: async () => ({ ok: false }) }).walletScripts(hex).lock;
  const lockHex = Buffer.from(spk).toString('hex'), sh = Buffer.from(sha256(spk)).toString('hex');
  const lockTx = (id, commit, value, time) => ({ txid: id.repeat(32), vin: [{ txid: commit.repeat(32), vout: 0 }], status: { confirmed: true, block_time: time, block_height: 968900 },
    vout: [{ scriptpubkey: '0014' + '00'.repeat(20), value: 1000 }, { scriptpubkey: lockHex, value }] });
  const history = [lockTx('b2', 'c2', 30000, 1_790_600_000), lockTx('b1', 'c1', 20000, 1_790_500_000)];     // newest first, as esplora serves
  for (const base of ['https://mempool.space/api', 'https://blockstream.info/api', 'https://mempool.emzy.de/api']) {
    await r.ctx.route(`${base}/scripthash/${sh}/txs**`, (route) => json(route, route.request().url().includes('/chain/') ? [] : history));
    for (const c of ['c1', 'c2']) await r.ctx.route(`${base}/tx/${c.repeat(32)}`, (route) => json(route, { txid: c.repeat(32), vin: [{ txid: `a${c[1]}`.repeat(32), vout: 0 }] }));
  }
  const body = () => r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' '));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await until(r.page, () => /BTC locked · post its bond/.test(document.querySelector('[data-foot="borrow"]')?.textContent || ''), null, 120000).catch(() => {});
    const foot = await text(r.page, '[data-foot="borrow"]');
    ok(/0\.0002\d* BTC locked · post its bond/.test(foot), `locks: the Borrow tile names the next step (${foot})`);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
    await r.page.waitForSelector('#borrow-body [data-pick]', { timeout: 120000 });
    const b = await body();
    ok(/0\.0002\d* BTC in your own output/.test(b) && /Your locks/.test(b) && /post its bond · shown above/.test(b), `locks: the sheet opens on the oldest lock still to mint and lists the others (${b.slice(0, 120)})`);
    ok(!!(await r.page.$('#borrow-body details.lockmore #bw-lock')), 'locks: another lock can be made from the sheet');
    ok(!!(await r.page.$('#bw-bond, #bw-topup')), 'locks: the lock it follows offers its bond');
    await until(r.page, () => /Paid from your (Tacit account|wallet)[^]*?\d ETH/.test(document.querySelector('#borrow-body')?.textContent || ''), null, 60000).catch(() => {});
    const bt = await body(), short = !!(await r.page.$('#bw-topup'));
    ok(/Paid from your (Tacit account|wallet)/.test(bt) && (short ? /Top up your Tacit account from a connected wallet/.test(bt) && !(await r.page.$('#bw-bond')) : !(await r.page.$eval('#bw-bond', (x) => x.disabled))),
      `locks: the bond names the account that pays and what it holds, and offers a top-up when short (${(bt.match(/Paid from.{0,60}?ETH/) || [''])[0]}${short ? ' · Top up from wallet' : ''})`);
    await r.page.click('#borrow-body [data-pick]');
    await until(r.page, () => /0\.0003\d* BTC in your own output/.test((document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' ')), null, 60000).catch(() => {});
    ok(/0\.0003\d* BTC in your own output/.test(await body()), 'locks: Show opens the other lock');
    // An empty Tacit account: the connected wallet tops it up and the bond posts from the Tacit account, in one click.
    if (await r.page.waitForSelector('#bw-topup', { timeout: 60000 }).then(() => true, () => false)) {
      await r.page.click('#bw-topup');
      await until(r.page, () => /Bond posted/.test([...document.querySelectorAll('#bw-status, #bw-s1, #bw-s2, #bw-s3, #bw-s4')].map((e) => e.textContent).join(' ')) || /error|could not|reverted/i.test([...document.querySelectorAll('#bw-status, #bw-s1, #bw-s2, #bw-s3, #bw-s4')].map((e) => e.textContent).join(' ')), null, 180000).catch(() => {});
      ok(/Bond posted/.test(await bwText(r.page)), `locks: Top up from wallet funds the Tacit account and posts the bond (${(await bwText(r.page)).trim().slice(0, 120)})`);
    } else ok(false, 'locks: an empty Tacit account offers Top up from wallet');
    if (r.errors.length) { fails++; console.log('FAIL locks page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// A loan taken against a lock is repaid from weld itself: the step shows what repaying burns and offers Repay and close,
// which says so plainly when the loan is not on chain yet (here: a record of a loan the fork has never seen).
await step('repay', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'be11'.padEnd(64, '7'), pub = Buffer.from(secp.getPublicKey(hex, true)).toString('hex');
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate((p) => localStorage.setItem(`tacit-lite-cbtc-v1:${p}`, JSON.stringify({ lockTxid: 'ab'.repeat(32), lockVout: 1, vBtc: '20000',
      anchor: { txid: 'cd'.repeat(32), vout: 0 }, at: Date.now(), minted: true, borrowed: '800000000', borrowedAt: Date.now() })), pub);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
    await r.page.waitForSelector('#bw-repay', { timeout: 240000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | sheet: ${(await r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' ').slice(0, 260)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    const note = await r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' '));
    ok(/Repaying burns 8(\.00)? cUSD you hold privately and returns the cBTC/.test(note), `repay: the loan step says what repaying burns (${(note.match(/Repaying burns[^.]*\./) || [''])[0]})`);
    await r.page.click('#bw-repay');
    await until(r.page, () => /not visible on chain yet|not on chain yet/.test([...document.querySelectorAll('#bw-status, #bw-s1, #bw-s2, #bw-s3, #bw-s4')].map((e) => e.textContent).join(' ')), null, 60000).catch(() => {});
    ok(/not visible on chain yet|not on chain yet/.test(await bwText(r.page)), `repay: before the loan is on chain it says so (${await bwText(r.page)})`);
    if (r.errors.length) { fails++; console.log('FAIL repay page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The tacit1 address of a key, derived the way tacit.finance does (BIP-352 scan key, one root).
const { makeTacitAddress } = await import(new URL('../dapp/tacit-address.js', import.meta.url));
const { bip352TaggedHash } = await import(new URL('../dapp/bip352.js', import.meta.url));
function tacit1(hex) {
  const priv = Buffer.from(hex, 'hex');
  const scan = BigInt('0x' + Buffer.from(bip352TaggedHash('BIP0352/ScanKey', priv)).toString('hex')) % secp.CURVE.n;
  const pub = secp.getPublicKey(priv, true);
  return makeTacitAddress({ secp }).encodeTacitAddress({ network: 'mainnet', btcSpendPub: pub, btcScanPub: secp.getPublicKey(scan.toString(16).padStart(64, '0'), true), evmOwnerPub: pub });
}
// The address the page shows for a key: the unified one, with the pool lane (flags 0x85).
const { unifiedAddress } = await import(new URL('../dapp/tacit-unified.js', import.meta.url));
const shownAddress = (hex) => unifiedAddress(hex).address;
const walletText = (p) => p.evaluate(() => document.querySelector('#wallet-body')?.textContent.replace(/\s+/g, ' ') || '');
// Open the wallet sheet by changing the hash; a navigation to the same URL would reload and drop the key.
const toWallet = (p) => p.evaluate(() => { location.hash = ''; location.hash = '#wallet'; });
const shown = async (p) => { await toWallet(p); await p.waitForSelector('#wallet-body .who, #wallet-body [data-in]', { timeout: 60000 }); return walletText(p); };
const lock = async (p) => { await toWallet(p); await p.waitForSelector('#w-lock', { timeout: 60000 }); await p.click('#w-lock'); await p.waitForSelector('#wallet-body [data-in]'); };
const addrIn = (txt) => (txt.match(/tacit1[0-9a-z]{8}…[0-9a-z]{12}/) || [''])[0];

await step('csend', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'c5e4d'.padEnd(64, '3');
  // The page's pool module, with private cUSD and cBTC notes added to what the key's balance finds.
  const CUSD = '0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d', CBTC = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const note = (asset, value, i) => ({ asset, value: String(value), leafIndex: 900000 + i, cx: '0x' + String(i).repeat(64).slice(0, 64), cy: '0x01', owner: '0x02' });
      const add = [note('${CUSD}', 2500000000n, 1), note('${CUSD}', 300000000n, 2), note('${CBTC}', 50000n, 3)];
      ux.balance = async (priv) => {
        const b = await balance(priv);
        b.notes = [...b.notes, ...add];
        for (const n of add) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.value = BigInt(g.value) + BigInt(n.value); g.notes = [...g.notes, n]; }
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
    await r.page.waitForSelector('#bw-send:not([hidden]) #cs-to', { timeout: 240000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | sheet: ${(await r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' ').slice(-300)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    const chips = await r.page.$$eval('#bw-send [data-cs]', (b) => b.map((x) => x.textContent));
    ok(chips.join(',') === 'cBTC,cUSD', `csend: private cBTC and cUSD are both offered (${chips.join(', ')})`);
    await r.page.click('#bw-send [data-cs="cusd"]');
    await r.page.waitForSelector('#cs-max');
    ok(/Private 28(\.00)? cUSD/.test(await text(r.page, '#cs-max')), `csend: the cUSD balance is the notes' sum (${await text(r.page, '#cs-max')})`);
    await r.page.fill('#cs-to', tacit1('abc'.padEnd(64, '9')));
    await r.page.fill('#cs-amt', '15');                           // clears the claim's relay fee at today's gas, and fits with a split
    // The relay-fee quote prices proving through zQuoter, whose DEX reads a cold fork fetches slot by slot: well over a minute.
    await until(r.page, () => /They get about/.test(document.querySelector('#cs-rcpt')?.textContent || '') && !document.querySelector('#cs-go').disabled, null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | preview: ${(await text(r.page, '#cs-rcpt')).replace(/\s+/g, ' ')} | status: ${await text(r.page, '#bw-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(true, `csend: a tacit1 recipient is quoted privately (${(await text(r.page, '#cs-rcpt')).replace(/\s+/g, ' ').trim()})`);
    await r.page.fill('#cs-to', '0x000000000000000000000000000000000000dEaD');
    await until(r.page, () => /Arrives[^]*tacUSD/.test(document.querySelector('#cs-rcpt')?.textContent || '') && !document.querySelector('#cs-go').disabled, null, 60000);
    ok(/Relay fee/.test(await text(r.page, '#cs-rcpt')), `csend: an 0x recipient gets it as tacUSD, fee first (${(await text(r.page, '#cs-rcpt')).replace(/\s+/g, ' ').trim()})`);
    // Out to an account this key deposits from: it goes, and the page says it links the two.
    const own = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
    await r.page.fill('#cs-to', own);
    await until(r.page, () => /one of your own accounts/.test(document.querySelector('#cs-rcpt')?.textContent || ''), null, 60000).catch(() => {});
    ok(/one of your own accounts/.test(await text(r.page, '#cs-rcpt')) && !(await r.page.$eval('#cs-go', (b) => b.disabled)), 'csend: paying out to an own account says it links them, and still allows it');
    await r.page.fill('#cs-amt', '100');
    await until(r.page, () => /More than your private balance/.test(document.querySelector('#cs-rcpt')?.textContent || ''), null, 60000);
    ok(await r.page.$eval('#cs-go', (b) => b.disabled), 'csend: more than the private balance is refused');
    await r.page.click('#bw-send [data-cs="cbtc"]');
    await until(r.page, () => /Private 0\.0005 cBTC/.test(document.querySelector('#cs-max')?.textContent || ''), null, 30000);
    ok(true, `csend: switching to cBTC shows its balance (${await text(r.page, '#cs-max')})`);
    if (r.errors.length) { fails++; console.log('FAIL csend page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

await step('shield', async () => {
  const hex = '5411d'.padEnd(64, '3');
  const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await fundTac(acct, 40n * 10n ** 18n);
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 17n).toString(16)]);   // gas for the router wrap's own transaction
  const r = await openPage({ account: A0, key: K0 });
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#tac-shield #tsh-go', { timeout: 240000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | bal: ${(await r.page.evaluate(() => (document.querySelector('#tac-bal')?.textContent || '').replace(/\s+/g, ' ').slice(0, 300)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    await until(r.page, () => /account 40(\.00)?$/.test((document.querySelector('#tsh-max')?.textContent || '').trim()), null, 60000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | max: ${await text(r.page, '#tsh-max')} | acct: ${acct} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(true, `shield: the account's own public TAC is offered, no cTAC leakage (${await text(r.page, '#tsh-max')})`);
    await r.page.fill('#tsh-amt', '25');
    await until(r.page, () => !document.querySelector('#tsh-go').disabled, null, 30000);
    await r.page.click('#tsh-go');
    await until(r.page, () => /press Finish|err/i.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#tac-bal-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    const st = await text(r.page, '#tac-bal-status');
    // Direct (still in this sheet when it fails) or handed off to Activity first (this run, on a stubbed fork, always
    // does — the relay accepts the job before its stubbed status ever answers) word it differently; both say the
    // deposit is safe and point to Finish, never ask for it again.
    ok(/deposit is (in the Tacit pool|safe in the pool)/.test(st) && /press Finish/.test(st), `shield: a one-tx deposit from the account, settle left to Finish like every other wrap here (${st.slice(0, 140)})`);
    ok(await r.page.$eval('#tsh-amt', (i) => i.value === ''), 'shield: the amount field empties once the deposit lands');
    await until(r.page, () => !!document.querySelector('#tac-finish'), null, 60000).then(() => true, () => false)
      .then((v) => ok(v, 'shield: the deposit is then offered to Finish, same as any other pending TAC deposit'));
    if (r.errors.length) { fails++; console.log('FAIL shield page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// Joining a private farm from weld: stubbed private tETH and TAC notes, a relay split that leaves the exact note it was
// asked for, and lpBond itself recorded rather than proved (the fork has no prover). The form sizes both sides to the live
// pool ratio, Max leaves each side's split fee, the notes are cut to exactly those sizes, and the bond goes to the farm
// manager with a self-settle hook so the paying account sends it.
await step('farmjoin', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'f4a3e'.padEnd(64, '6');
  const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 18n).toString(16)]);
  const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', CTAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      let seq = 0;
      const note = (asset, value) => { seq++; return { asset, value: String(value), leafIndex: 910000 + seq, cx: '0x' + seq.toString(16).padStart(64, 'a'), cy: '0x01', owner: '0x02', root: '0x03', path: [] }; };
      let add = [note('${CETH}', 2000000n), note('${CTAC}', 50000000000n)];
      window.__splits = [];
      ux.balance = async (priv) => {
        const b = await balance(priv);
        b.notes = [...b.notes, ...add];
        for (const n of add) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.value = BigInt(g.value) + BigInt(n.value); g.notes = [...g.notes, n]; }
        return b;
      };
      ux.transfer = async ({ notes, amount, fee }) => {
        const sum = notes.reduce((a, n) => a + BigInt(n.value), 0n), gone = new Set(notes.map((n) => n.cx));
        add = add.filter((n) => !gone.has(n.cx)).concat([note(notes[0].asset, amount), note(notes[0].asset, sum - BigInt(amount) - BigInt(fee))]);
        window.__splits.push({ asset: notes[0].asset, amount: String(amount), fee: String(fee) });
        return { status: 'settled' };
      };
      ux.lpBond = async (a) => {
        window.__join = { controller: a.controller, a: a.aNote.value, b: a.bNote.value, aAsset: a.aNote.asset, bAsset: a.bNote.asset, feeBps: a.feeBps, selfSettle: typeof a.selfSettle, calldata: ux.settleCalldata({ publicValues: '0x01', proof: '0x02', memos: [] }).slice(0, 10) };
        return { txHash: null, dShares: 1n };
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#farm'; });
    await r.page.waitForSelector('[data-farm="pid0"] > button', { timeout: 120000 });
    await r.page.click('[data-farm="pid0"] > button');
    await r.page.waitForSelector('#sj-max-0', { timeout: 240000 }).catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${(await text(r.page, '#farm-pid0')).replace(/\s+/g, ' ').slice(0, 300)}`); });
    await r.page.click('#sj-max-0');
    // Cold, the fork fetches the relay-fee quote's DEX reads slot by slot (see csend): minutes where mainnet takes a second.
    await until(r.page, () => /Adds/.test(document.querySelector('#sj-rcpt-0')?.textContent || '') && !document.querySelector('#sj-go-0').disabled, null, 420000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${(await text(r.page, '#sj-rcpt-0')).replace(/\s+/g, ' ')}`); });
    await shot(r.page, 'farmjoin');
    const rc = (await text(r.page, '#sj-rcpt-0')).replace(/\s+/g, ' ');
    ok(/Share of the farm/.test(rc) && /Relay fee to split your notes/.test(rc) && /Gas, from your Tacit account/.test(rc), `farmjoin: Max quotes both sides, the split fees and the gas (${rc})`);
    if (/Earns about/.test(rc)) ok(/APR on this deposit\s*(about [\d,]+%|over 100,000%)/.test(rc) && /Swap fees come on top/.test(rc), 'farmjoin: and the APR for this deposit');
    await r.page.click('#sj-go-0');
    await until(r.page, () => !!window.__join || /err/.test(document.querySelector('#sf-status-0')?.innerHTML || ''), null, 120000);
    const j = await r.page.evaluate(() => window.__join), splits = await r.page.evaluate(() => window.__splits);
    if (!j) throw new Error(`no bond: ${await text(r.page, '#sf-status-0')}`);
    // The live pool, read the way pool-ux reads it: pools(bytes32) → reserves A and B.
    const poolId = '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00';
    const sel = Buffer.from(keccak_256('pools(bytes32)')).toString('hex').slice(0, 8);
    const w = (await rpc('eth_call', [{ to: '0x000000000Ed1eabD231Be41d93b719056F7febFC', data: '0x' + sel + poolId.slice(2) }, 'latest'])).slice(2);
    const rA = BigInt('0x' + w.slice(3 * 64, 4 * 64)), rB = BigInt('0x' + w.slice(4 * 64, 5 * 64)), a = BigInt(j.a), b = BigInt(j.b);
    ok(j.controller.toLowerCase() === '0x000031c47cb61fab1ce2790a69625fabb71ede24' && j.selfSettle === 'function' && j.calldata === '0x' + Buffer.from(keccak_256('settle(bytes,bytes,bytes[])')).toString('hex').slice(0, 8),
      `farmjoin: the bond goes to the farm manager, settled by the paying account (${j.controller}, ${j.selfSettle}, ${j.calldata})`);
    ok(j.aAsset === CETH && j.bAsset === CTAC && b * rA >= a * rB && (b - 1n) * rA < a * rB, `farmjoin: the TAC side is the tETH side at the live ratio, rounded up (${a} : ${b}, pool ${rA} : ${rB})`);
    ok(splits.length === 2 && splits.every((x) => BigInt(x.amount) + BigInt(x.fee) <= (x.asset === CETH ? 2000000n : 50000000000n)) && BigInt(splits[0].amount) === a && BigInt(splits[1].amount) === b,
      `farmjoin: each note is cut to exactly its side, its fee within the balance (${JSON.stringify(splits)})`);
    await until(r.page, () => /In the farm/.test(document.querySelector('#sf-status-0')?.textContent || ''), null, 60000).catch(() => {});
    ok(/In the farm/.test(await text(r.page, '#sf-status-0')), `farmjoin: the sheet says it is in (${await text(r.page, '#sf-status-0')})`);
    if (r.errors.length) { fails++; console.log('FAIL farmjoin page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
await step('tacsend', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ac5e4'.padEnd(64, '3');
  // The page's pool module, with a private cTAC note (the pool asset id TAC and cTAC share) added to the balance.
  const TACID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const note = { asset: '${TACID}', value: '3000000000', leafIndex: 900010, cx: '0x' + '7'.repeat(64), cy: '0x01', owner: '0x02' };
      ux.balance = async (priv) => {
        const b = await balance(priv);
        b.notes = [...b.notes, note];
        const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
        g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#tac-send:not([hidden]) #ts-to', { timeout: 240000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | sheet: ${(await r.page.evaluate(() => (document.querySelector('#tac-bal')?.textContent || '').replace(/\s+/g, ' ').slice(-300)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    ok(/Private 30(\.00)? TAC/.test(await text(r.page, '#ts-max')), `tacsend: the private balance is offered, no cTAC/tacTAC leakage (${await text(r.page, '#ts-max')})`);
    ok(!(await r.page.$('[data-ts]')), 'tacsend: one source only, no toggle (public TAC already sends from the wallet sheet)');
    await r.page.fill('#ts-to', tacit1('abd'.padEnd(64, '9')));
    await r.page.fill('#ts-amt', '15');
    await until(r.page, () => /They get about/.test(document.querySelector('#ts-rcpt')?.textContent || '') && !document.querySelector('#ts-go').disabled, null, QUOTE_WAIT)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | preview: ${(await text(r.page, '#ts-rcpt')).replace(/\s+/g, ' ')} | rc.hidden=${await r.page.$eval('#ts-rcpt', (e) => e.hidden)} to=${await r.page.$eval('#ts-to', (e) => e.value.slice(0, 20))} amt=${await r.page.$eval('#ts-amt', (e) => e.value)} go.disabled=${await r.page.$eval('#ts-go', (e) => e.disabled)} html=${(await r.page.$eval('#ts-rcpt', (e) => e.innerHTML)).slice(0, 200)} | status: ${await text(r.page, '#tac-bal-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(/TAC/.test(await text(r.page, '#ts-rcpt')) && !/cTAC/.test(await text(r.page, '#ts-rcpt')), `tacsend: a tacit1 recipient is quoted privately, shown as TAC (${(await text(r.page, '#ts-rcpt')).replace(/\s+/g, ' ').trim()})`);
    await r.page.fill('#ts-to', '0x000000000000000000000000000000000000dEaD');
    await until(r.page, () => /Arrives/.test(document.querySelector('#ts-rcpt')?.textContent || '') && !document.querySelector('#ts-go').disabled, null, QUOTE_WAIT);
    ok(/Relay fee/.test(await text(r.page, '#ts-rcpt')) && /Arrives[^]*TAC/.test(await text(r.page, '#ts-rcpt')), `tacsend: an 0x recipient gets a partial amount as public TAC, fee first (${(await text(r.page, '#ts-rcpt')).replace(/\s+/g, ' ').trim()})`);
    await r.page.fill('#ts-amt', '1000');
    await until(r.page, () => /More than your private balance/.test(document.querySelector('#ts-rcpt')?.textContent || ''), null, QUOTE_WAIT);
    ok(await r.page.$eval('#ts-go', (b) => b.disabled), 'tacsend: more than the private balance is refused');
    // The one-tap "Make public" (drains every worthwhile note) still sits alongside the new partial-amount form.
    ok(/Make public/.test(await text(r.page, '#tac-bal')), 'tacsend: the all-at-once "Make public" action is unchanged');
    if (r.errors.length) { fails++; console.log('FAIL tacsend page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

await step('selfexit', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ac5e5'.padEnd(64, '4');
  const want = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  const TACID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv) => {
        const b = await balance(priv);
        // A real note for this key (a wrap's own output, recovered), so the exit builds; it is not in the pool, so the
        // proof the relay is asked for is a stand-in below.
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        const w = ux.buildWrap({ walletPriv: hx, amountWei: (30n * 10n ** 18n).toString(), ticker: 'cTAC', index: 0 });
        const note = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], hx)[0];
        if (!note) throw new Error('stub note not recovered');
        b.notes = [...b.notes, note];
        const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
        g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await rpc('anvil_setBalance', [want, '0x0']);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#tac-pub', { timeout: 240000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | sheet: ${(await r.page.evaluate(() => (document.querySelector('#tac-bal')?.textContent || '').replace(/\s+/g, ' ').slice(0, 300)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    // The relay refuses the exit at submit: nothing is queued, so the offer is on the status line itself.
    refuseSubmits = 1;
    await sleep(3000);                                               // the sheet's reads repaint it once more
    await r.page.click('#tac-pub');
    const offered = await until(r.page, () => !!document.querySelector('#tac-bal-status [data-selfdo]'), null, 300000).then(() => true, () => false);
    ok(offered && /free settles for today/.test(await text(r.page, '#tac-bal-status')), `selfexit: a relay refusal at submit offers to send it from the Tacit account (${(await text(r.page, '#tac-bal-status')).replace(/\s+/g, ' ').slice(0, 140)})`);
    if (offered) {
      // An account with no ETH is told what it needs and where, not left with a failure.
      await r.page.click('#tac-bal-status [data-selfdo]');
      await until(r.page, () => /Send a little ETH/.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 120000);
      const need = await text(r.page, '#tac-bal-status');
      ok(/network fee, about [\d.]+ ETH/.test(need) && need.includes(want.slice(0, 8)) || /Tacit account/.test(need), `selfexit: an account without ETH is told the fee and to add some (${need.replace(/\s+/g, ' ').slice(0, 160)})`);
      // Funded, it asks the relay for the proof only (no fee in the op) and sends settle() itself.
      await rpc('anvil_setBalance', [want, '0x' + (10n ** 17n).toString(16)]);
      proveStub = true;
      const n1 = submits.length;
      await r.page.click('#tac-bal-status [data-selfdo]');
      await until(r.page, () => !/Send a little ETH/.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 60000).catch(() => {});
      await sleep(4000);
      const prove = submits.slice(n1).find((x) => x.type === 'unwrap' || x.type === 'sendunwrap');
      ok(prove?.mode === 'prove' && BigInt(prove.op.fee) === 0n, `selfexit: funded, the relay is asked for the proof only, with no relay fee (${prove ? `${prove.type} ${prove.mode} fee ${prove.op.fee}` : 'no submit'})`);
    }
    if (r.errors.length) { fails++; console.log('FAIL selfexit page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { refuseSubmits = 0; proveStub = false; await r.browser.close(); }
});

await step('selfmore', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ac5e6'.padEnd(64, '5');
  const want = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  const TACID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv) => {
        const b = await balance(priv);
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        const w = ux.buildWrap({ walletPriv: hx, amountWei: (30n * 10n ** 18n).toString(), ticker: 'cTAC', index: 0 });
        const note = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], hx)[0];
        if (!note) throw new Error('stub note not recovered');
        b.notes = [...b.notes, note];
        const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
        g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await rpc('anvil_setBalance', [want, '0x0']);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#ts-to', { timeout: 240000 });
    await sleep(3000);
    // A private send of the whole note, refused at submit: the offer, the way to fund the account (with its address to copy),
    // then, funded, a proof-only lock job from the paying account.
    await r.page.fill('#ts-to', tacit1('abd'.padEnd(64, '8')));
    await r.page.fill('#ts-amt', '30');
    await until(r.page, () => /They get about/.test(document.querySelector('#ts-rcpt')?.textContent || '') && !document.querySelector('#ts-go').disabled, null, QUOTE_WAIT);
    refuseSubmits = 1;
    await r.page.click('#ts-go');
    const offered = await until(r.page, () => !!document.querySelector('#tac-bal-status [data-selfdo]'), null, QUOTE_WAIT).then(() => true, () => false);
    ok(offered, `selfmore: a private send the relay refuses offers to be sent from the Tacit account (${(await text(r.page, '#tac-bal-status')).replace(/\s+/g, ' ').slice(0, 120)})`);
    if (offered) {
      await r.page.click('#tac-bal-status [data-selfdo]');
      await until(r.page, () => /Add a little ETH|Send a little ETH/.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 120000);
      const copyAddr = await r.page.$eval('#tac-bal-status [data-selfcopy]', (b) => b.dataset.selfcopy).catch(() => null);
      ok(copyAddr && copyAddr.toLowerCase() === want.toLowerCase(), `selfmore: an account without ETH shows its address with a copy button (${copyAddr ? copyAddr.slice(0, 10) : 'none'})`);
      await rpc('anvil_setBalance', [want, '0x' + (10n ** 17n).toString(16)]);
      proveStub = true;
      const n1 = submits.length;
      await r.page.click('#tac-bal-status [data-selfdo]');
      await until(r.page, () => !/Send a little ETH/.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 60000).catch(() => {});
      await sleep(4000);
      const lock = submits.slice(n1).find((x) => x.type === 'stealthlock');
      ok(lock?.mode === 'prove', `selfmore: funded, the lock is proved by the relay and settled by the account (${lock ? `${lock.type} ${lock.mode}` : 'no submit'})`);
    }
    // A partial send to an 0x address (a send-out), refused the same way: it goes out with no relay fee.
    proveStub = false; refuseSubmits = 1;
    await until(r.page, () => !!document.querySelector('#ts-to') && !document.querySelector('#ts-go')?.getAttribute('aria-busy'), null, 120000);
    await sleep(3000);
    await r.page.fill('#ts-to', '0x000000000000000000000000000000000000dEaD');
    await r.page.fill('#ts-amt', '15');
    await until(r.page, () => /Arrives/.test(document.querySelector('#ts-rcpt')?.textContent || '') && !document.querySelector('#ts-go').disabled, null, QUOTE_WAIT);
    await r.page.click('#ts-go');
    const offered2 = await until(r.page, () => !!document.querySelector('#tac-bal-status [data-selfdo]'), null, QUOTE_WAIT).then(() => true, () => false);
    ok(offered2, 'selfmore: a send-out the relay refuses offers the same');
    if (offered2) {
      proveStub = true;
      const n2 = submits.length;
      await r.page.click('#tac-bal-status [data-selfdo]');
      await sleep(8000);
      const out = submits.slice(n2).find((x) => x.type === 'sendunwrap' || x.type === 'unwrap');
      ok(out?.mode === 'prove' && BigInt(out.op.fee) === 0n, `selfmore: and goes out proof-only with no relay fee (${out ? `${out.type} ${out.mode} fee ${out.op.fee}` : 'no submit'})`);
    }
    if (r.errors.length) { fails++; console.log('FAIL selfmore page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { refuseSubmits = 0; proveStub = false; await r.browser.close(); }
});

// The ETH sheet's relayed actions that have no scenario of their own, each refused by the relay and then sent from the
// paying account: claiming a payment, taking back an expired send, and a withdrawal. The pool module is stubbed with a
// private tETH note and two locks, and with claim/refund calls that the relay refuses until they are handed a self-settle.
await step('selflocks', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ac5e7'.padEnd(64, '6');
  const want = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv) => {
        const b = await balance(priv);
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        const w = ux.buildWrap({ walletPriv: hx, amountWei: (5n * 10n ** 17n).toString(), ticker: 'cETH', index: 0 });
        const note = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], hx)[0];
        if (!note) throw new Error('stub note not recovered');
        b.notes = [...b.notes, note];
        const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
        g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        return b;
      };
      const asset = ux.assetByTicker.cETH.assetId;
      const lock = (leaf, deadline, extra) => ({ leaf, asset, amount: '50000000', deadline: String(deadline), spent: false, ...extra });
      ux.scanStealthLocks = async () => ({ mine: [lock('0x' + 'a1'.repeat(32), 4102444800)], lockSetRoot: '0x' + '01'.repeat(32) });
      ux.scanSentLocks = async () => ({ sent: [lock('0x' + 'b2'.repeat(32), 1, { refundPriv: '0x' + '07'.repeat(32) })], lockSetRoot: '0x' + '02'.repeat(32) });
      const calls = (window.__selfCalls = []);
      const refuse = () => new Error('relay 429: free relayed settles for today are used up (300/300) — attach a fee above the floor');
      for (const kind of ['claim', 'refund']) {
        ux[kind === 'claim' ? 'stealthClaim' : 'stealthRefund'] = async (a) => {
          calls.push({ kind, self: typeof a.selfSettle, fee: String(a.fee) });
          if (!a.selfSettle) throw refuse();
          return { txHash: '0x' + 'ee'.repeat(32) };
        };
      }
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await rpc('anvil_setBalance', [want, '0x0']);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#eth'; });
    await r.page.waitForSelector('#v1-claim', { timeout: 600000 });
    const offerIn = (sel) => until(r.page, (q) => !!document.querySelector(q + ' [data-selfdo]'), sel, QUOTE_WAIT).then(() => true, () => false);
    const selfCalls = () => r.page.evaluate(() => window.__selfCalls);
    // Claiming a payment.
    await sleep(2000);
    await r.page.click('#v1-claim');
    ok(await offerIn('#v1-status'), 'selflocks: a claim the relay refuses offers to be sent from the Tacit account');
    await r.page.click('#v1-status [data-selfdo]');
    await until(r.page, () => /Send a little ETH/.test(document.querySelector('#v1-status')?.textContent || ''), null, 120000);
    await rpc('anvil_setBalance', [want, '0x' + (10n ** 17n).toString(16)]);
    await r.page.click('#v1-status [data-selfdo]');
    await until(r.page, () => (window.__selfCalls || []).some((c) => c.kind === 'claim' && c.self === 'function'), null, 120000).catch(() => {});
    const claim = (await selfCalls()).find((c) => c.kind === 'claim' && c.self === 'function');
    ok(claim && claim.fee === '0', `selflocks: funded, the claim is settled by the account with no relay fee (${JSON.stringify(claim)})`);
    // Taking back an expired send.
    await until(r.page, () => !!document.querySelector('#v1-back') && !document.querySelector('#v1-back').disabled, null, 120000);
    await r.page.click('#v1-back');
    ok(await offerIn('#v1-status'), 'selflocks: taking back a send the relay refuses offers the same');
    await r.page.click('#v1-status [data-selfdo]');
    await until(r.page, () => (window.__selfCalls || []).some((c) => c.kind === 'refund' && c.self === 'function'), null, 120000).catch(() => {});
    const refund = (await selfCalls()).find((c) => c.kind === 'refund' && c.self === 'function');
    ok(refund && refund.fee === '0', `selflocks: and is settled by the account with no relay fee (${JSON.stringify(refund)})`);
    // A withdrawal. The sheet ignores a tab change while an action is still going, so the refund finishes first.
    await until(r.page, () => /Done\./.test(document.querySelector('#v1-status')?.textContent || ''), null, 180000);
    await sleep(2000);
    await r.page.click('[data-v1="out"]');
    await r.page.fill('#o-to', '0x000000000000000000000000000000000000dEaD');
    await r.page.fill('#o-amt', '0.1');
    await until(r.page, () => !document.querySelector('#o-rcpt')?.hidden && !document.querySelector('#o-go')?.disabled, null, QUOTE_WAIT);
    refuseSubmits = 1;
    await r.page.click('#o-go');
    ok(await offerIn('#v1-status'), 'selflocks: a withdrawal the relay refuses offers the same');
    proveStub = true;
    const n1 = submits.length;
    await r.page.click('#v1-status [data-selfdo]');
    await sleep(8000);
    const out = submits.slice(n1).find((x) => x.type === 'sendunwrap' || x.type === 'unwrap');
    ok(out?.mode === 'prove' && BigInt(out.op.fee) === 0n, `selflocks: and goes out proof-only with no relay fee (${out ? `${out.type} ${out.mode} fee ${out.op.fee}` : 'no submit'})`);
    if (r.errors.length) { fails++; console.log('FAIL selflocks page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { refuseSubmits = 0; proveStub = false; await r.browser.close(); }
});

// A private send that needs a note of its exact size makes one first with a relayed split. If the relay refuses that step,
// the split can be sent from the paying account, and the send is pressed again once the note exists.
await step('selfsplit', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ac5e8'.padEnd(64, '7');
  const want = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv) => {
        const b = await balance(priv);
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        const w = ux.buildWrap({ walletPriv: hx, amountWei: (30n * 10n ** 18n).toString(), ticker: 'cTAC', index: 0 });
        const note = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], hx)[0];
        if (!note) throw new Error('stub note not recovered');
        b.notes = [...b.notes, note];
        const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
        g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await rpc('anvil_setBalance', [want, '0x' + (10n ** 17n).toString(16)]);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#ts-to', { timeout: 240000 });
    await sleep(3000);
    await r.page.fill('#ts-to', tacit1('abd'.padEnd(64, '6')));
    await r.page.fill('#ts-amt', '15');
    await until(r.page, () => /They get about/.test(document.querySelector('#ts-rcpt')?.textContent || '') && !document.querySelector('#ts-go').disabled, null, QUOTE_WAIT);
    refuseSubmits = 1;
    await r.page.click('#ts-go');
    const offered = await until(r.page, () => !!document.querySelector('#tac-bal-status [data-selfdo]'), null, QUOTE_WAIT).then(() => true, () => false);
    ok(offered && /Splitting a note/.test(await text(r.page, '#tac-bal-status')) || offered, `selfsplit: a split the relay refuses offers to be sent from the Tacit account (${(await text(r.page, '#tac-bal-status')).replace(/\s+/g, ' ').slice(0, 120)})`);
    if (offered) {
      proveStub = true;
      const n1 = submits.length;
      await r.page.click('#tac-bal-status [data-selfdo]');
      await sleep(8000);
      const tr = submits.slice(n1).find((x) => x.type === 'transfer');
      ok(tr?.mode === 'prove', `selfsplit: the split is proved by the relay and settled by the account (${tr ? `${tr.type} ${tr.mode}` : 'no submit'})`);
    }
    if (r.errors.length) { fails++; console.log('FAIL selfsplit page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { refuseSubmits = 0; proveStub = false; await r.browser.close(); }
});

// Make public with the relay taking the job: the sheet says plainly that it was sent and where it goes, names the relay fee
// beforehand, and sends to an address entered there; a bad address is refused before anything is sent.
await step('makepub', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ac5e9'.padEnd(64, '8');
  const DEAD = '0x000000000000000000000000000000000000dEaD';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv) => {
        const b = await balance(priv);
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        const w = ux.buildWrap({ walletPriv: hx, amountWei: (30n * 10n ** 18n).toString(), ticker: 'cTAC', index: 0 });
        const note = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], hx)[0];
        if (!note) throw new Error('stub note not recovered');
        b.notes = [...b.notes, note];
        const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
        g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#tac-pub', { timeout: 240000 });
    ok(await until(r.page, () => /relay fee of about \d+ TAC comes out of it/.test(document.querySelector('#tac-bal')?.textContent || ''), null, QUOTE_WAIT).then(() => true, () => false),
      `makepub: the sheet names the relay fee before it is pressed (${(await text(r.page, '#tac-bal')).replace(/\s+/g, ' ').match(/A relay fee[^.]*\./)?.[0] || 'none'})`);
    // A bad address is refused here, with nothing sent.
    const n0 = submits.length;
    await r.page.fill('#tac-pub-to', 'not an address');
    await r.page.click('#tac-pub');
    await until(r.page, () => /address|0x/i.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 120000);
    ok(submits.length === n0, `makepub: a bad address is refused before anything is sent (${(await text(r.page, '#tac-bal-status')).replace(/\s+/g, ' ').slice(0, 100)})`);
    // The address entered gets it, and the sheet says the job is with the relay, and where it goes.
    await r.page.fill('#tac-pub-to', DEAD);
    await r.page.click('#tac-pub');
    await until(r.page, () => /Sent to the relay/.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, QUOTE_WAIT);
    const said = (await text(r.page, '#tac-bal-status')).replace(/\s+/g, ' ');
    const job = submits.slice(n0).find((x) => x.type === 'unwrap');
    ok(job && String(job.op.recipient).toLowerCase() === DEAD.toLowerCase(), `makepub: the exit pays the address entered (${job ? job.op.recipient : 'no submit'})`);
    ok(/✓ Sent to the relay/.test(said) && /0x0000/.test(said) && /proved in about a minute/.test(said), `makepub: the sheet says it was sent and where it goes (${said.slice(0, 150)})`);
    ok(!!(await r.page.$('#tac-bal-status button.btn[data-act-open]')), 'makepub: and offers a clear button to follow it');
    if (r.errors.length) { fails++; console.log('FAIL makepub page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

await step('keys', async () => {
  const r = await openPage({ account: A0, key: K0 });
  await r.page.goto(r.url + '#wallet');
  // Before anyone has signed in: the chip says what it opens, and the Ethereum option says what the signature is and how many the first time asks for.
  const first = await r.page.evaluate(() => ({ chip: document.querySelector('#wallet-label').textContent, eth: document.querySelector('#wallet-body [data-in="eth"]').textContent.replace(/\s+/g, ' '), lede: document.querySelector('#wallet-body .lede-s').textContent }));
  ok(first.chip === 'Sign in' && /A free message signature, two the first time/.test(first.eth) && /sends nothing and costs no gas/.test(first.lede), `keys: the first visit says it is a sign-in, and that the signature is free (${first.chip} | ${first.eth})`);
  await r.page.click('#wallet-body [data-in="eth"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  const txt = await shown(r.page);
  const addr = addrIn(txt);
  ok(/opened with Ethereum/.test(txt) && addr, `keys: an Ethereum signature opens ${addr}`);
  await lock(r.page);
  ok(/Continue as tacit1/.test(await walletText(r.page)), 'keys: once locked, the sheet offers to continue with the same wallet');
  await r.page.click('#wallet-body [data-in="known"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  ok((await shown(r.page)).includes(addr), 'keys: continuing reopens the same tacit1 address');
  await lock(r.page);
  const hex = 'c0ffee'.padEnd(64, '1');
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  const t1 = shownAddress(hex);
  ok((await shown(r.page)).includes(`${t1.slice(0, 14)}…${t1.slice(-12)}`), `keys: a pasted key opens its own unified tacit1 address ${t1.slice(0, 14)}…`);
  if (r.errors.length) { fails++; console.log('FAIL keys page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

await step('tacopen', async () => {
  const r = await openPage({ account: A0, key: K0 });
  await r.page.goto(r.url);
  await r.page.waitForSelector('#toast-container', { state: 'attached' });
  const hex = 'abcdef'.padEnd(64, '3'), pass = 'correct horse battery staple';
  const saving = r.page.evaluate(async (h) => { globalThis.__TACIT_NO_INIT__ = true; const T = await import('/tacit.js'); await T.wallet.setPriv(h); return !!localStorage.getItem('tacit-wallet-v1:mainnet'); }, hex);
  await r.page.waitForSelector('#pass-dialog[open] #pass-input-1', { timeout: 120000 });
  await r.page.fill('#pass-input-1', pass); await r.page.fill('#pass-input-2', pass); await r.page.click('#pass-submit');
  ok(await saving, 'tacopen: a key is saved the way tacit.finance saves it');
  await r.page.evaluate(() => { localStorage.setItem('tacit-active-mode-v1', 'local'); localStorage.removeItem('tacit-lite-id-v1'); });
  await r.page.goto(r.url + '#tac'); await r.page.reload();
  await r.page.waitForSelector('#tac-bal [data-in="known"]', { timeout: 60000 });
  await r.page.click('#tac-bal [data-in="known"]');
  await r.page.waitForSelector('#pass-dialog[open] #pass-input-1', { timeout: 120000 });
  await r.page.fill('#pass-input-1', pass); await r.page.click('#pass-submit');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
  // Opened from inside the open sheet: its balance reads again for the key at once, not at the next minute's refresh.
  const t0 = Date.now();
  const done = await until(r.page, () => { const t = document.querySelector('#tac-bal')?.textContent || ''; return /TAC/.test(t) && !/still reading/.test(t); }, null, 45000).then(() => true, () => false);
  ok(done, `tacopen: the TAC balance finishes reading after the key opens in the sheet (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!done) console.log('     tac-bal:', (await r.page.evaluate(() => [...document.querySelectorAll('#tac-bal .parts span')].map((e) => e.textContent.replace(/\s+/g, ' ').trim() + (e.querySelector('.sk') ? ' [skeleton]' : '')).join(' | '))));
  if (r.errors.length) { fails++; console.log('FAIL tacopen page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

await step('saved', async () => {
  const r = await openPage({ account: A0, key: K0 });
  await r.page.goto(r.url);
  await r.page.waitForSelector('#toast-container', { state: 'attached' });
  const hex = 'abcdef'.padEnd(64, '2'), pass = 'correct horse battery staple';
  // Save a key the way tacit.finance does, through its own module and prompt.
  const saving = r.page.evaluate(async (h) => { globalThis.__TACIT_NO_INIT__ = true; const T = await import('/tacit.js'); await T.wallet.setPriv(h); return !!localStorage.getItem('tacit-wallet-v1:mainnet'); }, hex);
  await r.page.waitForSelector('#pass-dialog[open] #pass-input-1', { timeout: 120000 });
  await r.page.fill('#pass-input-1', pass); await r.page.fill('#pass-input-2', pass); await r.page.click('#pass-submit');
  ok(await saving, 'saved: a passphrase-locked key is saved in this browser');
  await r.page.evaluate(() => { localStorage.setItem('tacit-active-mode-v1', 'local'); localStorage.removeItem('tacit-lite-id-v1'); });
  // A link straight to the TAC sheet, with no key open in the tab, offers the same wallet there.
  await r.page.goto(r.url + '#tac'); await r.page.reload();
  ok(!!(await r.page.waitForSelector('#tac-bal [data-in="known"]', { timeout: 60000 }).catch(() => null)), 'saved: the TAC sheet offers to open the saved key');
  await r.page.goto(r.url + '#wallet'); await r.page.reload();
  await r.page.waitForSelector('#wallet-body [data-in="known"]', { timeout: 60000 });
  ok(/saved in this browser/.test(await walletText(r.page)), 'saved: the sheet offers the saved key');
  await r.page.click('#wallet-body [data-in="known"]');
  await r.page.waitForSelector('#pass-dialog[open] #pass-input-1', { timeout: 120000 });
  await r.page.fill('#pass-input-1', pass); await r.page.click('#pass-submit');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
  const t1 = shownAddress(hex);
  ok((await shown(r.page)).includes(`${t1.slice(0, 14)}…${t1.slice(-12)}`), 'saved: the passphrase opens the same key tacit.finance saved');
  ok(await r.page.evaluate(() => localStorage.getItem('tacit-active-mode-v1') === 'local'), 'saved: tacit.finance\'s own wallet choice is left as it was');
  if (r.errors.length) { fails++; console.log('FAIL saved page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

await step('bitcoin', async () => {
  // A UniSat stand-in with a real key: deterministic ECDSA, so enrolment's two signatures agree.
  const bk = '11'.repeat(32);
  const r = await openPage({ account: A0, key: K0, init: { arg: { bk }, fn: ({ bk }) => {
    const sent = [];
    window.__sent = sent;
    window.unisat = {
      requestAccounts: async () => ['bc1qtestaddress0000000000000000000000000000'], getAccounts: async () => ['bc1qtestaddress0000000000000000000000000000'],
      getPublicKey: async () => '02' + bk.slice(0, 64 - 2).padEnd(64, '0'), getNetwork: async () => 'livenet', on() {}, removeListener() {},
      signMessage: async (msg, type) => { const d = new TextEncoder().encode(bk + '|' + type + '|' + msg); const h = await crypto.subtle.digest('SHA-256', d); return btoa(String.fromCharCode(...new Uint8Array(h), ...new Uint8Array(h), 1)); },
      sendBitcoin: async (to, sats) => { sent.push([to, sats]); return 'ab'.repeat(32); },
    };
  } } });
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="btc"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
  const txt = await shown(r.page);
  ok(/opened with Bitcoin bc1qte/.test(txt), `bitcoin: a Bitcoin wallet's signature opens a key (${addrIn(txt)})`);
  await lock(r.page);
  await r.page.click('#wallet-body [data-in="known"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
  ok((await shown(r.page)).includes(addrIn(txt) || '?'), 'bitcoin: signing in again opens the same key');
  await r.page.evaluate(() => { location.hash = '#borrow'; });
  await r.page.waitForSelector('#bw-amt', { timeout: 120000 });
  await r.page.fill('#bw-amt', '0.0002');
  await r.page.click('#bw-fund');
  await until(r.page, () => (window.__sent || []).length > 0 || /err/.test(document.querySelector('#bw-status')?.innerHTML || ''), null, 60000);
  const sent = await r.page.evaluate(() => window.__sent);
  const deposit = await r.page.$eval('#borrow-body [data-copy]', (b) => b.dataset.copy);
  ok(sent.length === 1 && sent[0][0] === deposit && sent[0][1] >= 21000, `bitcoin: one popup funds the deposit address with ${sent[0]?.[1]} sats, the lock and its fees`);
  if (r.errors.length) { fails++; console.log('FAIL bitcoin page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

await step('passkey', async () => {
  const r = await openPage({ account: A0, key: K0, host: 'localhost' });
  const cdp = await r.ctx.newCDPSession(r.page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="new"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 60000);
  const txt = await shown(r.page), addr = addrIn(txt);
  ok(/opened with passkey/.test(txt) && addr, `passkey: a new passkey wallet opens ${addr}`);
  ok(await r.page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('tacit-prf-v1') || '{}')).length === 1), 'passkey: tacit.finance\'s passkey list gains the wallet');
  await lock(r.page);
  await r.page.click('#wallet-body [data-in="passkey"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 60000);
  ok((await shown(r.page)).includes(addr), 'passkey: signing in with it opens the same key');
  if (r.errors.length) { fails++; console.log('FAIL passkey page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

const balOf = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
const go = (p, h) => p.evaluate((x) => { location.hash = ''; location.hash = x; }, h);
let ACCT = null;
await step('acct', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'feed'.padEnd(64, '3');
  const want = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  // tacit.finance's pool module, loaded on its own, derives the same account from the same key.
  const viaUx = await r.page.evaluate(async (h) => {
    const d = await import('/vendor/tacit-deps.min.js'), dep = await import('/confidential-deployments.js');
    dep.setActiveNetwork('mainnet');
    const { makeConfidentialPoolUx } = await import('/confidential-pool-ux.js');
    return makeConfidentialPoolUx({ secp: d.secp, keccak256: d.keccak_256, sha256: d.sha256, network: 'mainnet' }).account(d.hexToBytes(h)).address;
  }, hex);
  await toWallet(r.page);
  await r.page.waitForSelector('#ac-form [data-copy]', { timeout: 60000 });
  const shownAddr = await r.page.$eval('#ac-form [data-copy]', (b) => b.dataset.copy);
  ok(shownAddr === want && viaUx === want, `acct: the Tacit account is the key's own, as tacit.finance derives it (${want.slice(0, 10)}…, pool-ux ${viaUx.slice(0, 10)}…)`);
  ok(await r.page.$eval('[data-pay="tacit"]', (b) => b.classList.contains('main')), 'acct: with no wallet connected, the Tacit account pays');
  await rpc('anvil_setBalance', [want, '0x' + (10n ** 17n).toString(16)]);             // funded from outside, as an exchange would

  await go(r.page, '#buy');
  await r.page.waitForSelector('#b-amt', { timeout: 60000 });
  ok(/Tacit account/.test(await text(r.page, '#b-max')), 'acct: the pay line names the Tacit account');
  await r.page.fill('#b-amt', '0.001');
  await until(r.page, () => !document.querySelector('#b-go').disabled, null, 240000);
  await r.page.click('#b-go');
  await until(r.page, () => /Bought|err/.test(document.querySelector('#b-status')?.innerHTML || ''), null, 120000);
  ok((await tacOf(want)) > 0n, `acct: Buy signs from the Tacit account, no wallet asked ${await text(r.page, '#b-status')}`);

  await go(r.page, '#farm');
  await r.page.waitForSelector('[data-pfm="pair"]', { timeout: 60000 });
  await r.page.click('[data-pfm="pair"]');
  await r.page.fill('#pf-amt', '0.0002');
  await until(r.page, () => !document.querySelector('#pf-go').disabled || /\S/.test(document.querySelector('#pf-status')?.textContent || ''), null, 60000);
  if (await r.page.isDisabled('#pf-go')) throw new Error(`the ETH + TAC deposit stayed disabled: ${await text(r.page, '#pf-rcpt')}`);
  await r.page.click('#pf-go');
  await until(r.page, () => /Staked/.test(document.querySelector('#toast-container')?.textContent || '') || !!document.querySelector('#farm-precision .status .err'), null, 120000);
  ok((await stakedOf(want)) > 0n, `acct: ETH + TAC staked with a permit the Tacit account signed ${await text(r.page, '#pf-status')}`);

  const OUT = '0x1111111111111111111111111111111111111111', o0 = await balOf(OUT);
  await toWallet(r.page);
  await r.page.waitForSelector('[data-wal="out"]');
  await r.page.click('[data-wal="out"]');
  await r.page.fill('#ac-to', OUT); await r.page.fill('#ac-mv', '0.01');
  await r.page.click('#ac-go');
  await until(r.page, () => /Sent\.|err/.test(document.querySelector('#ac-status')?.innerHTML || ''), null, 120000);
  ok((await balOf(OUT)) - o0 === 10n ** 16n, `acct: Send out pays from the Tacit account ${await text(r.page, '#ac-status')}`);
  await r.page.click('[data-wala="tac"]');
  await r.page.waitForSelector('#ac-to');
  await r.page.fill('#ac-to', OUT);
  const tAcct = await tacOf(want), tOut0 = await tacOf(OUT);
  await r.page.click('#ac-max');
  await until(r.page, () => !!document.querySelector('#ac-mv')?.value);
  await r.page.click('#ac-go');
  await chainUntil(async () => (await tacOf(OUT)) - tOut0 === tAcct, 120000);
  ok(tAcct > 0n && (await tacOf(OUT)) - tOut0 === tAcct && (await tacOf(want)) === 0n, `acct: Send out moves all of the Tacit account's TAC too (${Number(tAcct / 10n ** 14n) / 1e4} TAC)`);
  await r.page.click('[data-wala="eth"]');

  await r.page.click('[data-pay="wallet"]');                                              // connects the stub wallet
  await until(r.page, () => document.querySelector('[data-pay="wallet"]')?.classList.contains('main'));
  await r.page.click('[data-pay="tacit"]');
  await until(r.page, () => document.querySelector('[data-pay="tacit"]')?.classList.contains('main'));
  ok(true, 'acct: with a wallet connected either account can be chosen to pay');
  await r.page.click('[data-wal="add"]');
  await r.page.waitForSelector('#ac-go');
  const a0 = await balOf(want);
  await r.page.fill('#ac-mv', '0.02');
  await r.page.click('#ac-go');
  await until(r.page, () => /Added\.|err/.test(document.querySelector('#ac-status')?.innerHTML || ''), null, 120000);
  ok((await balOf(want)) - a0 === 2n * 10n ** 16n, `acct: Add from wallet tops the Tacit account up ${await text(r.page, '#ac-status')}`);
  if (r.errors.length) { fails++; console.log('FAIL acct page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  ACCT = { r, want };
});

await step('devmove', async () => {
  if (!ACCT) throw new Error('needs the acct scenario first');
  const { r } = ACCT, st = () => text(r.page, '#d-status');
  await go(r.page, '#device');
  await r.page.waitForSelector('[data-chain="1"]', { timeout: 60000 });
  await r.page.click('[data-chain="1"]');
  await r.page.waitForSelector('#d-amt', { timeout: 60000 });
  await r.page.fill('#d-amt', '0.01');
  await r.page.click('#d-go');
  await until(r.page, () => /Deposited|err/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  ok(/Deposited/.test(await st()), `devmove: the Tacit account deposits, proved here ${(await st()).slice(0, 60)}`);

  await r.page.click('[data-dev="receive"]');
  await r.page.waitForSelector('#d-form [data-copy]', { timeout: 60000 });
  const box = (await r.page.$$eval('#d-form [data-copy]', (bs) => bs.map((b) => b.dataset.copy)))[1];
  await rpc('eth_sendTransaction', [{ from: A0, to: box, value: '0x' + (10n ** 15n).toString(16) }]);   // under the keeper's minimum
  await r.page.click('[data-dev="send"]'); await r.page.click('[data-dev="receive"]');
  await r.page.waitForSelector('#d-sweep', { timeout: 60000 });
  await r.page.click('#d-sweep');
  await until(r.page, () => /Swept in|err/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  ok(/Swept in/.test(await st()) && (await balOf(box)) === 0n, `devmove: a small arrival is swept in from this device ${(await st()).slice(0, 60)}`);

  await r.page.click('[data-dev="out"]');
  await r.page.click('[data-dest="v1"]');
  await r.page.fill('#d-amt', '0.002');
  const n0 = submits.length, k0 = relays.length;
  await r.page.click('#d-go');
  await until(r.page, () => /Moved|stubbed|failed|err/i.test(document.querySelector('#d-status')?.innerHTML || ''), null, 1200000);
  const rel = relays.slice(k0).find((b) => b.wrap);
  const landed = !!rel?.txHash && (await rpc('eth_getTransactionReceipt', [rel.txHash]))?.status === '0x1';
  ok(rel && BigInt(rel.wrap.amount) === 2n * 10n ** 15n && landed && submits.slice(n0).some((s) => s.type === 'wrap'),
    `devmove: pool ETH moves into V1 in one relayed withdrawToV1, then its note settle is submitted ${(await st()).slice(0, 60)}`);

  await r.page.click('[data-dest="8453"]');
  await r.page.fill('#d-amt', '0.001');
  const k1 = relays.length;
  await r.page.click('#d-go');
  await until(r.page, () => /On its way|stubbed|err/i.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  ok(relays.slice(k1).some((b) => b.call), `devmove: a move to Base asks the relayer for its bridge call ${(await st()).slice(0, 60)}`);

  // A withdrawal the keeper cannot take says so plainly and offers the paying account instead, which then sends it
  // itself, proved here, with no relay fee.
  const BEEF = '0x000000000000000000000000000000000000beef';
  await r.page.click('[data-dest="addr"]');
  await r.page.fill('#d-to', BEEF);
  await r.page.fill('#d-amt', '0.0005');
  // A gateway's timeout says nothing of whether the relay sent it: the page reads the chain and offers no second payment.
  gatewayOnce = true;
  await r.page.click('#d-go');
  await until(r.page, () => /class="err"/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  const unknown = await st();
  ok(/did not answer/.test(unknown) && !(await r.page.$('#d-status [data-retry="d-self"]')) && (await r.page.$eval('#d-amt', (i) => i.value)) === '',
    `devmove: a gateway timeout is read as no answer: the amount clears and no second payment is offered (${unknown.slice(0, 90)})`);
  await r.page.fill('#d-amt', '0.0005');
  await until(r.page, () => !document.querySelector('#d-go').disabled, null, 60000);
  const k2 = relays.length, b0 = await balOf(BEEF);
  await r.page.click('#d-go');
  await until(r.page, () => /data-retry="d-self"|class="err"/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  const said = await st();
  ok(relays.slice(k2).some((b) => !b.wrap && !b.call) && /can’t take this one/.test(said) && !/gas/i.test(said) && !!(await r.page.$('#d-status [data-retry="d-self"]')),
    `devmove: a withdrawal the keeper cannot take says so plainly and offers the Tacit account instead (${said.slice(0, 110)})`);
  await r.page.click('#d-status [data-retry="d-self"]');
  await r.page.waitForSelector('#d-relay', { timeout: 30000 });
  await until(r.page, () => !document.querySelector('#d-go').disabled, null, 30000);
  await r.page.click('#d-go');
  await until(r.page, () => /Withdrawn|class="err"/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  ok(/Withdrawn/.test(await st()) && (await balOf(BEEF)) - b0 === 5n * 10n ** 14n, `devmove: then the Tacit account sends it, proved here, with no relay fee (${(await st()).slice(0, 60)})`);
  if (r.errors.length) { fails++; console.log('FAIL devmove page errors: ' + r.errors.slice(0, 3).join(' | ')); }
});
await step('btc', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'b17c'.padEnd(64, '5');
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  await go(r.page, '#btc');
  await until(r.page, () => /^\d/.test(document.querySelector('#btc-body .bal .v')?.textContent || '') || /err/.test(document.querySelector('#btc-body')?.innerHTML || ''), null, 180000);
  ok(/^0(\.0+)?$/.test((await text(r.page, '#btc-body .bal .v')).trim()), `btc: an empty key reads 0 BTC through tacit.js (${(await text(r.page, '#btc-body .bal .v')).trim()})`);
  const route = async (to, want) => {
    await r.page.fill('#bt-to', to); await r.page.fill('#bt-amt', '0.0001');
    await until(r.page, () => !document.querySelector('#bt-rcpt').hidden, null, 60000);
    await sleep(400);
    return (await text(r.page, '#bt-rcpt')).replace(/\s+/g, ' ');
  };
  const t1 = tacit1(hex);
  ok(/Silent payment/.test(await route(t1, 'sp')), 'btc: BTC to a tacit1 address goes as a silent payment');
  ok(/Silent payment/.test(await route(shownAddress(hex), 'sp')), 'btc: BTC to a unified tacit1 address goes as a silent payment');
  ok(/Plain payment/.test(await route('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'addr')), 'btc: BTC to a bc1 address is a plain payment');
  ok(/Ethereum address/.test(await route(A0, 'err')), 'btc: an Ethereum address is refused with a reason');
  ok(/More than you hold/.test(await text(r.page, '#bt-rcpt')) || await r.page.isDisabled('#bt-go'), 'btc: an unfunded key cannot send');
  // BTC to a tacit1 is a silent payment to its Bitcoin lane: the wallet's version-0 silent-payment keys, which tacit.js
  // still scans (SP_KEY_VERSIONS) beside the version-1 address it shows.
  await r.page.click('[data-btcm="receive"]');
  await until(r.page, () => [...document.querySelectorAll('#btc-form [data-copy]')].some((b) => /^sp1/.test(b.dataset.copy)), null, 60000);
  const shown = await r.page.$$eval('#btc-form [data-copy]', (bs) => bs.map((b) => b.dataset.copy).find((v) => /^sp1/.test(v)));
  const [fromT1, v0, scanned] = await r.page.evaluate(async ([a, h]) => {
    const T = await import([...document.scripts].map((x) => x.textContent).join('').match(/\/tacit\.js\?cb=[0-9a-f]+/)[0]);   // the instance the page loaded
    const d = await import('/vendor/tacit-deps.min.js'), { makeTacitAddress } = await import('/tacit-address.js');
    const { lanes } = makeTacitAddress({ secp: d.secp }).decodeTacitAddress(a);
    const enc = (k) => T.encodeSilentPaymentAddress({ scanPub: k.scanPub, spendPub: k.spendPub, network: 'mainnet' });
    return [enc(lanes.btc), enc(T.deriveWalletSilentPaymentKeys(d.hexToBytes(h), 0)), T.SP_KEY_VERSIONS];
  }, [t1, hex]);
  ok(fromT1 === v0 && scanned.includes(0) && /^sp1/.test(shown || ''), `btc: BTC to a tacit1 lands on silent-payment keys this wallet scans (${fromT1.slice(0, 12)}…, versions ${scanned})`);
  await r.page.fill('#bt-chk', '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b');
  await r.page.click('#bt-chk-go');
  await until(r.page, () => /not addressed|not found|not indexed/.test(document.querySelector('#btc-status')?.textContent || ''), null, 120000);
  ok(true, `btc: a payment link is checked against this key (${(await text(r.page, '#btc-status')).trim().slice(0, 50)})`);
  if (r.errors.length) { fails++; console.log('FAIL btc page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});
// The TAC sheet's Bridge: TAC notes on Bitcoin (a stubbed holdings scan) are listed, one over the limit refused with its
// reason; a note the stubbed reflection tracks checks out as one Bitcoin transaction, held back while the key holds no
// sats for its fee; bridges already under way (seeded in the journal tacit.js keeps) show their steps and actions, a
// mint the relay refused offers the paying account, and Recover on one that did not complete files its claim.
await step('bridge', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'b41d'.padEnd(64, '9'), pubB = secp.getPublicKey(hex, true), pub = Buffer.from(pubB).toString('hex');
  const { ripemd160 } = await import('@noble/hashes/ripemd160');
  const spk = '0014' + Buffer.from(ripemd160(sha256(pubB))).toString('hex');
  const { makeConfidentialPool } = await import(new URL('../dapp/confidential-pool.js', import.meta.url));
  const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
  const rev = (h) => h.match(/../g).reverse().join('');
  const N1 = 'c1'.repeat(32), N2 = 'c2'.repeat(32), N3 = 'c3'.repeat(32), N4 = 'c4'.repeat(32), SK3 = '3b'.repeat(32), TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  const spk3 = '0014' + Buffer.from(ripemd160(sha256(secp.getPublicKey(SK3, true)))).toString('hex');
  const claims = [];
  const api = (re, fn) => r.page.route(re, (route) => fn(route, new URL(route.request().url())));
  // The note tree holds the leaf the burn names for a note of this amount (blinding as the stubbed scan gives it); N4 is live but absent from it.
  const leafOf = (amt) => { const c = pool.commitXY(amt, '0x' + (12345n + amt).toString(16).padStart(64, '0')); return pool.btcNoteLeaf('0x' + TAC, c.cx, c.cy, '0x' + '00'.repeat(32)); };
  let dumps = 0;
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/dump/, (route) => { dumps++; return json(route, { attestedHeight: 970000,
    snapshot: { height: 970000, liveTriples: [[pool.outpointKey('0x' + rev(N1), 0), '0x00', '0x00', '0x00', 0], [pool.outpointKey('0x' + rev(N3), 0), '0x00', '0x00', '0x00', 0], [pool.outpointKey('0x' + rev(N4), 0), '0x00', '0x00', '0x00', 0]], burnNodes: [], noteLeaves: [leafOf(25000000000n)], pendingDepositRecords: [] } }); });
  // Any other transaction Bitcoin has never seen (the stuck bridge's two): registered first, so the fixtures below win.
  await api(/^https:\/\/api\.tacit\.finance\/chain\/tx\/[0-9a-f]{64}/, (route) => route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"not-found"}' }));
  await api(/^https:\/\/api\.tacit\.finance\/chain\/tx\/(c1|c2|c3|c4){32}/, (route, u) => json(route, { txid: u.pathname.split('/').pop(),
    status: { confirmed: true, block_height: 960000 }, vout: [{ scriptpubkey: u.pathname.includes('c3c3') ? spk3 : spk, value: 546 }] }));
  await api(/^https:\/\/api\.tacit\.finance\/bridge\/recover/, (route) => {
    if (route.request().method() === 'POST') { claims.push(JSON.parse(route.request().postData() || '{}')); return json(route, { ok: true, status: 'queued' }); }
    return json(route, { status: 'queued' });
  });
  await r.page.goto(r.url + '#wallet');
  // The holdings scan is tacit.js's own, stubbed on the instance the page loads.
  await r.page.evaluate(async ([n1, n2, n3, n4, sk3, aid]) => {
    globalThis.__TACIT_NO_INIT__ = true; localStorage.setItem('tacit-network-v1', 'mainnet');
    const T = await import([...document.scripts].map((x) => x.textContent).join('').match(/\/tacit\.js\?cb=[0-9a-f]+/)[0]);
    const note = (txid, amount) => ({ utxo: { txid, vout: 0, value: 546, status: { confirmed: true } }, amount, blinding: 12345n + amount });
    const stealth = { ...note(n3, 3000000000n), stealthTweakedSk: sk3 };
    const utxos = [note(n1, 25000000000n), note(n2, 150000000000n), stealth, note(n4, 4000000000n)];
    T._testSetScanHoldingsOverride(() => new Map([[aid, { assetIdHex: aid, ticker: 'TAC', decimals: 8, balance: 182000000000n, utxos, ghosts: [], inflated: [], pending: [] }]]));
  }, [N1, N2, N3, N4, SK3, TAC]);
  // Three bridges under way: one waiting for the proof, one ready whose mint the relay refused, one that did not complete.
  const recOf = (id, stage, extra = {}) => ({ id: `${id}:0`, network: 'mainnet', walletPub: pub, path: 'reflected', stage, createdAt: Date.now(),
    source: { txid: id, vout: 0, sats: 546, assetId: '0x' + TAC, amount: { __big: '10000000000' }, blinding: { __big: '777' } },
    burn: { txid: id.replace(/^../, 'bb'), hex: '00', commitTxid: 'cc'.repeat(32), commitHex: '00', fundingUtxo: { txid: 'dd'.repeat(32), vout: 1 } },
    envelope: { destLeaf: '0x' + 'ee'.repeat(32) }, ...extra });
  const journal = [recOf('d1'.repeat(32), 'rburn-mined', { burnHeight: 970050, createdAt: Date.now() - 3e6 }),
    recOf('d2'.repeat(32), 'rfolded', { createdAt: Date.now() - 2e6, lastError: { message: 'free relayed settles for today are used up', at: Date.now() }, errorCount: 1 }),
    recOf('d3'.repeat(32), 'not-recorded', { createdAt: Date.now() - 1e6 }),
    recOf('d4'.repeat(32), 'rburn-signed', { createdAt: Date.now() - 5e5, lastError: { message: 'bad-txns-inputs-missingorspent', at: Date.now() }, errorCount: 3 })];
  await r.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`tacit-burndep-bridge-v1:mainnet:${pub}`, JSON.stringify(journal)]);
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  // The Bitcoin sheet's TAC line links here.
  await go(r.page, '#bitcoin');
  await until(r.page, () => !!document.querySelector('#btc-body a[data-link="bridge"]'), null, 120000);
  await r.page.click('#btc-body a[data-link="bridge"]');
  await until(r.page, () => location.hash === '#bridge' && !document.querySelector('#bridge-body').hidden && document.querySelector('[data-tac-mode="bridge"]').getAttribute('aria-selected') === 'true');
  ok(true, 'bridge: the Bitcoin sheet’s TAC line opens the TAC sheet’s Bridge tab, and the link reads #bridge');
  await until(r.page, () => document.querySelectorAll('#bridge-body .brn').length === 4, null, 120000);
  const notes = (await text(r.page, '#bridge-body .brns')).replace(/\s+/g, ' ').trim();
  ok(/^250(\.0+)? TAC.*40(\.0+)? TAC.*30(\.0+)? TAC.*1,500(\.0+)? TAC\s*Over 1,000 TAC/.test(notes) && !(await r.page.$(`#bridge-body input[value="${N2}:0"]`)) && (await r.page.inputValue('#bridge-body .brsp input')) === '1000' && !!(await r.page.$('#bridge-body [data-brsplit]')),
    `bridge: the notes are listed, the one over 1,000 TAC with its reason and a split control, not a dead choice (${notes})`);
  await r.page.check(`#bridge-body input[value="${N1}:0"]`);
  await until(r.page, () => /One Bitcoin transaction|err/.test(document.querySelector('#br-rcpt')?.innerHTML || ''), null, 120000);
  const rc = (await text(r.page, '#br-rcpt')).replace(/\s+/g, ' ');
  ok(/One Bitcoin transaction/.test(rc) && /250(\.0+)? private TAC on Ethereum/.test(rc) && /Relay fee\s*None/.test(rc), `bridge: a tracked note checks out as one Bitcoin transaction with no relay fee (${rc.slice(0, 160)})`);
  await until(r.page, () => /short of the fee/.test(document.querySelector('#br-rcpt')?.textContent || ''), null, 120000).catch(() => {});
  // The check reads the whole reflection state: redrawing the sheet (another tab and back) must not read it again.
  const before = dumps;
  await r.page.click('[data-tac-mode="airdrop"], [data-tac-mode="air"]'); await sleep(300); await r.page.click('[data-tac-mode="bridge"]');
  await until(r.page, () => /short of the fee/.test(document.querySelector('#br-rcpt')?.textContent || ''), null, 60000);
  ok(dumps === before, `bridge: redrawing the sheet does not run the check, or read the reflection state, again (${before} → ${dumps})`);
  await r.page.check('#br-ack').catch(() => {});
  ok(/short of the fee/.test(await text(r.page, '#br-rcpt')) && await r.page.isDisabled('#br-go'), 'bridge: a key with no sats for the fee cannot start it, and is told so');
  const rows = await r.page.$$eval('#bridge-body .brr', (xs) => xs.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.length === 4, `bridge: the four bridges under way are listed (${rows.length})`);
  ok(/Recorded/.test(rows[0] || '') && /proof is at block/.test(rows[0] || '') && !!(await r.page.$('#bridge-body .brr:nth-child(1) .stp li.now')),
    `bridge: one waiting for the proof shows its step and where the proof is (${(rows[0] || '').slice(0, 140)})`);
  ok(/Mint now/.test(rows[1] || '') && /Send it from/.test(rows[1] || '') && /free settles for today/.test(rows[1] || ''),
    `bridge: a mint the relay refused offers Mint now and sending it from the paying account (${(rows[1] || '').slice(0, 200)})`);
  ok(/didn’t complete/.test(rows[2] || '') && /Recover/.test(rows[2] || ''), 'bridge: one that did not complete offers Recover');
  ok(/Cancel this bridge/.test(rows[3] || '') && /has not taken this transaction/.test(rows[3] || ''), 'bridge: a signed transaction Bitcoin keeps rejecting offers to be cancelled');
  await r.page.click('#bridge-body [data-bract="cancel"]');
  await until(r.page, () => /Yes, cancel it/.test(document.querySelector('#bridge-body [data-bract="cancel"]')?.textContent || ''), null, 30000);
  await r.page.click('#bridge-body [data-bract="cancel"]');
  await until(r.page, () => document.querySelectorAll('#bridge-body .brr').length === 3, null, 60000);
  ok(true, 'bridge: cancelling it asks once more, checks Bitcoin has neither transaction, then drops the row');
  await r.page.click('#bridge-body [data-bract="recover"]');
  await until(r.page, () => /Recovering/.test(document.querySelector('#br-rstatus')?.textContent || '') || /err/.test(document.querySelector('#br-rstatus')?.innerHTML || ''), null, 60000);
  ok(claims.length === 1 && claims[0].burnTxid?.replace(/^0x/, '') === 'bb' + 'd3'.repeat(31) && /on its way back/.test(await text(r.page, '#bridge-body')),
    `bridge: Recover files one signed claim for that burn, and the row says the TAC is on its way back (${await text(r.page, '#br-rstatus')})`);
  if (process.env.SHOT) await r.page.screenshot({ path: process.env.SHOT + '-wide.png' });
  // Phone width: nothing scrolls sideways.
  // TAC received privately (a stealth note the proof tracks) cannot be burned as it is: the page offers to send it to this key's own address.
  await r.page.check(`#bridge-body input[value="${N3}:0"]`);
  await until(r.page, () => !!document.querySelector('#br-prep'), null, 120000);
  ok(/received privately/.test(await text(r.page, '#br-rcpt')) && await r.page.isDisabled('#br-go'), 'bridge: TAC received privately is offered a send to the key’s own address, and cannot start a bridge as it is');
  // A tracked note the tree holds in an older form is offered the same send, before anything is signed.
  await r.page.check(`#bridge-body input[value="${N4}:0"]`);
  await until(r.page, () => /older note form/.test(document.querySelector('#br-rcpt')?.textContent || '') && !!document.querySelector('#br-prep'), null, 120000);
  ok(await r.page.isDisabled('#br-go'), 'bridge: a tracked note in an older form is offered a send to the key’s own address, and cannot start a bridge as it is');
  await r.page.setViewportSize({ width: 360, height: 760 });
  await sleep(300);
  const wide = await r.page.evaluate(() => { const d = document.querySelector('#sheet-tac .sheet-in'); return [d.scrollWidth, d.clientWidth, document.documentElement.scrollWidth, innerWidth]; });
  if (process.env.SHOT) await r.page.screenshot({ path: process.env.SHOT + '-phone.png', fullPage: true });
  ok(wide[0] <= wide[1] + 1 && wide[2] <= wide[3] + 1, `bridge: no sideways scroll at phone width (${wide})`);
  if (r.errors.length) { fails++; console.log('FAIL bridge page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

// The tETH sheet's To Bitcoin tab (see the header). The pool module is stubbed to hold tETH notes; Bitcoin and the proof answer
// from canned responses; the relay is the harness's own, which takes a submit and then reports its job failed.
await step('xobridge', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'b7e7'.padEnd(64, '5'), pubB = secp.getPublicKey(hex, true), pub = Buffer.from(pubB).toString('hex');
  const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  const api = (re, fn) => r.page.route(re, (route) => fn(route, new URL(route.request().url())));
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const note = (value, i) => ({ asset: '${CETH}', value: BigInt(value), blinding: BigInt(1000 + i), leafIndex: 900000 + i, leaf: '0x' + String(i).repeat(64).slice(0, 64), nullifier: '0x' + String(i + 1).repeat(64).slice(0, 64),
        cx: '0x' + String(i).repeat(64).slice(0, 64), cy: '0x01', owner: '0x' + '02'.repeat(32), secret: '0x' + '03'.repeat(32), root: '0x' + '04'.repeat(32), path: Array.from({ length: 32 }, () => '0x' + '00'.repeat(32)) });
      const add = [note(400000, 1), note(200000, 2), note(1200000, 3), note(500000, 4), note(500000, 5)];
      ux.balance = async (priv) => {
        const b = await balance(priv);
        b.notes = [...b.notes, ...add];
        for (const n of add) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.value = BigInt(g.value) + BigInt(n.value); g.notes = [...g.notes, n]; }
        return b;
      };
      return ux;
    }` }));
  // Bitcoin and the proof, canned: the proof is up to date and the view of Ethereum is recent; the key's address has what `utxos` says.
  let utxos = [];
  const head = Number(BigInt(await rpc('eth_blockNumber')));
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/status/, (route) => json(route, { network: 'mainnet', attestedHeight: 970373, tipHeight: 970373, lagBlocks: 0 }));
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/eth-state\/covers/, (route, u) => json(route, { network: 'mainnet', block: Number(u.searchParams.get('block')), bestBlock: head - 300, confirmedBlock: head - 3000, covered: false }));
  await api(/^https:\/\/api\.tacit\.finance\/crossout\/minted/, (route, u) => json(route, { decided: u.searchParams.get('txid') === '9a'.repeat(32), minted: false, status: 'rejected' }));
  await api(/^https:\/\/(mempool\.space|blockstream\.info|api\.tacit\.finance\/chain)\/(api\/)?address\/[^/]+\/utxo/, (route) => json(route, utxos));
  await r.page.goto(r.url + '#wallet');
  await r.page.evaluate(async () => {
    globalThis.__TACIT_NO_INIT__ = true; localStorage.setItem('tacit-network-v1', 'mainnet');
    const T = await import([...document.scripts].map((x) => x.textContent).join('').match(/\/tacit\.js\?cb=[0-9a-f]+/)[0]);
    T._testSetScanHoldingsOverride(() => new Map());
  });
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));

  // Hidden until enabled: with nothing set and no bridge under way there is no tab, and a link to it opens the sheet as it is.
  await go(r.page, '#private/bitcoin');
  await until(r.page, () => !!document.querySelector('#eth-v1 [data-v1="wrap"][aria-selected="true"]'), null, 120000);
  ok(!(await r.page.$('#eth-v1 [data-v1="btc"]')), 'xobridge: with nothing set and no bridge under way the sheet has no To Bitcoin tab, and a link to it opens Make private');
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'true'));
  await go(r.page, '#private');
  await until(r.page, () => !!document.querySelector('#eth-v1 [data-v1="btc"]'), null, 120000);
  ok(true, 'xobridge: enabled, the tab is there');
  await r.page.evaluate(() => localStorage.removeItem('tacit-teth-btc'));

  // A bridge already under way shows the tab even when it is switched off, however the bridge got there.
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'false'));
  const big = (v) => ({ __big: String(v) }), ago = (ms) => Date.now() - ms;
  const src = (id, extra = {}) => ({ nullifier: id, value: big(400000), amount: big(390000), fee: big(10000), assetId: CETH, ticker: 'tETH', ...extra });
  const settle = (n, extra = {}) => ({ txHash: n.repeat(32), claimId: '0x' + n.repeat(32), cx: '0x' + 'c2'.repeat(32), cy: '0x' + 'c3'.repeat(32), destCommitment: '0x' + 'dd'.repeat(32), ethBlock: head - 400, claimIdVerified: true, ...extra });
  const rec = (n, stage, extra = {}) => ({ id: '0x' + n.repeat(32), network: 'mainnet', walletPub: pub, stage, createdAt: ago(9e6 - Number('0x' + n) * 1e3), destXonly: 'ab'.repeat(32), source: src('0x' + n.repeat(32)), ...extra });
  const mint = { commitHex: '00', commitTxid: '8a'.repeat(32), revealHex: '00', revealTxid: '9a'.repeat(32), feeRate: 3 };
  const journal = [
    rec('a1', 'settling', { createdAt: ago(5 * 3600e3), startBlock: head - 50, dests: [{ amount: big(390000), cx: '0x' + 'c2'.repeat(32), cy: '0x' + 'c3'.repeat(32), destCommitment: '0x' + 'dd'.repeat(32) }], source: src('0x' + 'a1'.repeat(32), { attempts: ['10000'] }) }),
    rec('a2', 'settled', { settle: settle('a2') }),
    rec('a3', 'covered', { settle: settle('a3'), lastError: { message: 'crossout-ux: Bitcoin fees are high right now (400 sat/vB), so the Bitcoin step is waiting for them to fall under 100', at: Date.now() }, errorCount: 1 }),
    rec('a4', 'mint-signed', { settle: settle('a4'), mint, lastError: { message: 'bad-txns-inputs-missingorspent', at: Date.now() }, errorCount: 3 }),
    rec('a5', 'mint-confirmed', { settle: settle('a5'), mint: { ...mint, revealTxid: '9b'.repeat(32) } }),
    rec('a6', 'mint-rejected', { settle: settle('a6'), mint, rejectedStatus: 'rejected' }),
    rec('a7', 'minted', { settle: settle('a7'), mint }),
    rec('a8', 'settled', { settle: settle('a8'), source: src('0x' + 'a8'.repeat(32), { assetId: TAC, ticker: 'TAC' }) }),
  ];
  await r.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`tacit-crossout-bridge-v1:mainnet:${pub}`, JSON.stringify(journal)]);
  await go(r.page, '#private/bitcoin');
  await until(r.page, () => document.querySelectorAll('#eth-v1 .brr').length === 6, null, 120000);
  ok(!!(await r.page.$('#eth-v1 [data-v1="btc"][aria-selected="true"]')) && (await r.page.evaluate(() => location.hash)) === '#private/bitcoin', 'xobridge: a bridge under way shows the tab, selected by the link, whose address reads #private/bitcoin');
  const rows = await r.page.$$eval('#eth-v1 .brr', (xs) => xs.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.length === 6 && !rows.some((x) => /TAC/.test(x)) && /Sent to Ethereum/.test(rows[0]) && /Waiting for Bitcoin’s proof/.test(rows[1]) && /fees are high/.test(rows[2]) && /Waiting for the tETH to be credited/.test(rows[4]) && /was not credited/.test(rows[5]),
    `xobridge: the six unfinished tETH bridges are listed in order, a finished one and a TAC one are not (${rows.length}: ${rows.map((x) => x.slice(0, 90)).join(' || ')})`);
  ok(/0\.0039 tETH/.test(rows[0]) && !!(await r.page.$('#eth-v1 .brr:nth-child(1) .stp li.now')), 'xobridge: a row names what arrives (the note less the relay fee) and marks its step');
  ok(/Cancel/.test(rows[0]) && /Look again/.test(rows[0]), `xobridge: a burn not yet seen to land, an hour or more on, offers to look again or cancel (${rows[0]})`);
  ok(/Send it anyway/.test(rows[2]), `xobridge: a Bitcoin step held back for high fees offers to be sent anyway (${rows[2]})`);
  ok(/Sign it again/.test(rows[3]) && /Try again/.test(rows[3]), `xobridge: a signed pair Bitcoin keeps rejecting offers to be signed again (${rows[3]})`);
  // Cancelling looks on Ethereum first (nothing there on the fork), then lets the intent go.
  await r.page.click('#eth-v1 [data-xoact="cancel"]');
  await until(r.page, () => document.querySelectorAll('#eth-v1 .brr').length === 5, null, 120000);
  ok(/Cancelled: no burn for it was found on Ethereum/.test(await text(r.page, '#xo-rstatus')) && !JSON.parse(await r.page.evaluate((k) => localStorage.getItem(k), `tacit-crossout-bridge-v1:mainnet:${pub}`)).some((x) => x.stage === 'settling'),
    'xobridge: cancelling it drops the row and the record once Ethereum shows no burn for it');

  // Without the setting the tab only follows the bridges under way; with it, a new one can be started.
  ok(!(await r.page.$('#xo-amt')), 'xobridge: without the setting, bridges under way are followed and no new one is offered');
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'true'));
  await go(r.page, '#private');
  await go(r.page, '#private/bitcoin');
  // The form. A tETH balance of five notes (0.004, 0.002, 0.012, 0.005, 0.005) is read; the key's Bitcoin address has nothing yet.
  await r.page.waitForSelector('#xo-amt');
  await r.page.fill('#xo-amt', '0.004');
  await until(r.page, () => /Bitcoin fee, when it is sent/.test(document.querySelector('#xo-rcpt')?.textContent || ''), null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | receipt: ${(await text(r.page, '#xo-rcpt')).replace(/\s+/g, ' ')} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
  const rc0 = (await text(r.page, '#xo-rcpt')).replace(/\s+/g, ' ');
  ok(/You get0\.00\d+ tETH on your Bitcoin address/.test(rc0) && /Relay fee0\.00\d+ tETH/.test(rc0) && /Arrivesusually a few hours, sometimes up to a day/.test(rc0), `xobridge: the receipt names what arrives, the relay fee and the time (${rc0.slice(0, 220)})`);
  ok(/needs a coin of \d[\d,]* sats|needs one coin of \d[\d,]* sats/.test(rc0) && await r.page.isDisabled('#xo-go') && await r.page.isHidden('#xo-ackrow'), 'xobridge: with no sats on the key’s Bitcoin address it cannot start, and says how many it needs');
  // Funded: the box appears, and ticking it enables the button. Each bridge still to sign its mint takes a coin of its own,
  // so there is one coin for each of those and one for this.
  utxos = Array.from({ length: 8 }, (_, i) => ({ txid: (i + 10).toString(16).padStart(2, '0').repeat(32), vout: 0, value: 20000, status: { confirmed: true, block_height: 970000 } }));
  await r.page.click('#xo-recheck');
  await until(r.page, () => !document.querySelector('#xo-ackrow')?.hidden, null, 240000).catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | receipt: ${(await text(r.page, '#xo-rcpt')).replace(/\s+/g, ' ')}`); });
  ok(await r.page.isDisabled('#xo-go'), 'xobridge: with sats free, the button still waits for the box to be ticked');
  await r.page.check('#xo-ack');
  ok(!(await r.page.isDisabled('#xo-go')), 'xobridge: ticked, it can start');
  // The limits.
  await r.page.fill('#xo-amt', '0.006');
  await until(r.page, () => /at most 0\.005 tETH/.test(document.querySelector('#xo-rcpt')?.textContent || ''), null, 120000);
  ok(await r.page.isDisabled('#xo-go') && await r.page.isHidden('#xo-ackrow'), 'xobridge: more than the limit is refused with the limit named, and the box goes away');
  await r.page.fill('#xo-amt', '0.0005');
  await until(r.page, () => /at least 0\.001 tETH/.test(document.querySelector('#xo-rcpt')?.textContent || ''), null, 120000);
  ok(await r.page.isDisabled('#xo-go'), 'xobridge: under the minimum is refused with the minimum named');

  // Start one: the page checks again, takes the note of exactly that size, and the relay is sent a bridge-burn job; the harness's
  // relay then reports the job failed, as a settle the page could not see through, and the intent record is what is left.
  const before = submits.length;
  await r.page.fill('#xo-amt', '0.004');
  await until(r.page, () => !document.querySelector('#xo-ackrow')?.hidden, null, 240000);
  await r.page.check('#xo-ack');
  await r.page.click('#xo-go');
  await until(r.page, () => document.querySelectorAll('#eth-v1 .brr').length === 6, null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const sent = submits.slice(before);
  ok(sent.length === 1 && /bridgeburn/i.test(JSON.stringify(sent[0]).slice(0, 400)), `xobridge: starting one sends the relay a bridge-burn job (${sent.length}: ${JSON.stringify(sent[0] || {}).slice(0, 160)})`);
  const after = await r.page.evaluate((k) => JSON.parse(localStorage.getItem(k)), `tacit-crossout-bridge-v1:mainnet:${pub}`);
  const mine = after.find((x) => x.id === '0x' + '2'.repeat(64));
  ok(!!mine && mine.stage === 'settling' && mine.startBlock >= head && mine.dests.length === 1 && mine.source.attempts.length === 1, 'xobridge: a settle the page could not see through leaves an intent record for that note, with where to look for it');
  const said = (await text(r.page, '#v1-status')).replace(/\s+/g, ' ').trim();
  ok(said.length > 0 && !/Burned on Ethereum/.test(said), `xobridge: the failure is reported on the sheet, not passed off as a burn (${said.slice(0, 160)})`);

  // A send the relay refuses at submit: nothing was queued, so the intent is let go and the paying account is offered.
  refuseSubmits = 1;
  await r.page.fill('#xo-amt', '0.005');           // another whole note, the largest the limit allows: the first is held by the action that is still following its job, and the fork's gas can price the relay fee above a smaller one
  await until(r.page, () => !document.querySelector('#xo-ackrow')?.hidden, null, 240000);
  await r.page.check('#xo-ack');
  await r.page.click('#xo-go');
  await until(r.page, () => !!document.querySelector('#v1-status [data-selfdo]'), null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const left = JSON.parse(await r.page.evaluate((k) => localStorage.getItem(k), `tacit-crossout-bridge-v1:mainnet:${pub}`));
  ok(!left.some((x) => x.id === '0x' + '5'.repeat(64)) && left.some((x) => x.id === '0x' + '2'.repeat(64)) && refused.length > 0, 'xobridge: a send the relay refuses at submit offers the paying account and leaves no record of that note behind (the first note’s intent stays)');
  // A relay that turns the fee down when it picks the job up: the page asks once more at a doubled fee brought back onto the
  // two-digit ladder, and when that is turned down too (or doubling would eat the note) offers the paying account.
  await r.page.fill('#xo-amt', '');
  await until(r.page, () => document.querySelector('#xo-rcpt')?.hidden, null, 30000);          // the last receipt is gone before the next is waited for
  await r.page.fill('#xo-amt', '0.005');
  await until(r.page, () => /Relay fee0\.\d+ tETH/.test(document.querySelector('#xo-rcpt')?.textContent || '') && !document.querySelector('#xo-ackrow')?.hidden, null, 240000);
  const fee1 = BigInt(Math.round(Number((await text(r.page, '#xo-rcpt')).match(/Relay fee(0\.\d+) tETH/)[1]) * 1e8));
  statusError = 'feeGate: bound fee is below the marginal cost at this gas';
  const b2 = submits.length;
  await r.page.check('#xo-ack');
  await r.page.click('#xo-go');
  await until(r.page, () => !!document.querySelector('#v1-status [data-selfdo]') || /feeGate|marginal cost|Sent to the relay/.test(document.querySelector('#v1-status')?.textContent || ''), null, 240000);
  await sleep(1500);
  const fees = submits.slice(b2).map((b) => BigInt(b.op?.fee ?? b.fee ?? -1));
  const ladder = (v) => v.toString().replace(/0+$/, '').length <= 2;
  const retried = fee1 * 4n < 500000n;
  ok(fees.length === (retried ? 2 : 1) && fees.every(ladder) && (!retried || (fees[1] > fees[0] && fees[1] >= fee1 * 2n)), `xobridge: a fee the relay turns down is asked again once at a doubled fee on the ladder (${retried ? 'doubling fits' : 'doubling would not fit the note'}; fees ${fees.join(' → ')})`);
  statusError = 'stubbed in the fork check';
  if (r.errors.length) { fails++; console.log('FAIL xobridge page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

// The To Bitcoin tab's tETH on Bitcoin (see the header). The key's Taproot output holds two notes made by real, signed cross-out mint
// reveals (built in the page with its own modules); the explorers, Bitcoin's proof and the worker answer from canned responses.
await step('xbring', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'c7e7'.padEnd(64, '6'), privB = Buffer.from(hex, 'hex'), pubB = secp.getPublicKey(privB, true), pub = Buffer.from(pubB).toString('hex'), XONLY = '0x' + pub.slice(2);
  const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
  const { makeConfidentialPool } = await import(new URL('../dapp/confidential-pool.js', import.meta.url));
  const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
  const rev = (h) => h.match(/../g).reverse().join('');
  const api = (re, fn) => r.page.route(re, (route) => fn(route, new URL(route.request().url())));
  await r.page.goto(r.url + '#wallet');
  // Two notes: A (0.004 tETH, in Bitcoin's proof), B (0.003 tETH, made in a block the proof has not reached).
  // A cross-out's destination blinding is HMAC(key, 'tacit-crossout-blinding-v1' || nullifier) mod n, as crossOut() derives it.
  const derive = (nullifier) => { const m = Buffer.concat([Buffer.from('tacit-crossout-blinding-v1'), Buffer.from(nullifier.slice(2), 'hex')]); let b = 0n; for (const x of hmac(sha256, privB, m)) b = (b << 8n) | BigInt(x); b %= secp.CURVE.n; return b === 0n ? 1n : b; };
  const mk = (amount, claim, nullifier) => { const nu = '0x' + nullifier.repeat(32), blinding = derive(nu), { cx, cy } = pool.commitXY(amount, blinding); return { amount, blinding, cx, cy, claimId: '0x' + claim.repeat(32), nullifier: nu }; };
  const NA = mk(400000n, 'c1', 'a1'), NB = mk(300000n, 'c2', 'a2');
  await r.page.evaluate(async () => {
    globalThis.__TACIT_NO_INIT__ = true; localStorage.setItem('tacit-network-v1', 'mainnet');
    const T = await import([...document.scripts].map((x) => x.textContent).join('').match(/\/tacit\.js\?cb=[0-9a-f]+/)[0]);
    T._testSetScanHoldingsOverride(() => new Map());
  });
  const built = await r.page.evaluate(async ([hexKey, xonly, asset, notes]) => {
    const { makeBtcWallet } = await import('/bitcoin-taproot-wallet.js');
    const { makeCrossoutMintReveal } = await import('/crossout-mint-reveal.js');
    const { secp } = await import('/vendor/tacit-deps.min.js');
    const priv = Uint8Array.from(hexKey.match(/../g).map((b) => parseInt(b, 16)));
    const w = makeBtcWallet({ priv, hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 3 });
    const mr = makeCrossoutMintReveal({ secp });
    return notes.map((n, i) => { const b = mr.buildCrossoutMintTxs({ prims: w.prims, assetId: asset, claimId: n.claimId, cx: n.cx, cy: n.cy, destXonly: xonly, fundingUtxo: { txid: String(i + 1).repeat(64), vout: 0, value: 50000 }, feeRate: 3 }); return { revealHex: b.revealHex, revealTxid: b.revealTxid }; });
  }, [hex, XONLY, CETH, [NA, NB].map((n) => ({ claimId: n.claimId, cx: n.cx, cy: n.cy }))]);
  NA.revealHex = built[0].revealHex; NA.txid = built[0].revealTxid; NB.revealHex = built[1].revealHex; NB.txid = built[1].revealTxid;
  const leafOf = (n) => pool.btcNoteLeaf(CETH, n.cx, n.cy, XONLY);
  const addrP2tr = await r.page.evaluate(async (x) => (await import('/crossout-notes.js')).p2trAddress(x.slice(2), 'bc'), XONLY);
  const posts = [];
  const explorer = (route, u) => {
    const p = u.pathname.replace(/^\/api/, '').replace(/^\/chain/, '');
    if (route.request().method() === 'POST' && p === '/tx') { posts.push(route.request().postData()); return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'ab'.repeat(32) }); }
    if (p === `/address/${addrP2tr}/utxo`) return json(route, [NA, NB].map((n) => ({ txid: n.txid, vout: 0, value: 330, status: { confirmed: true, block_height: n === NA ? 970000 : 970200 } })));
    if (/^\/address\/bc1q[0-9a-z]+\/utxo$/.test(p)) return json(route, [{ txid: 'f1'.repeat(32), vout: 0, value: 20000, status: { confirmed: true, block_height: 960000 } }]);
    for (const n of [NA, NB]) {
      if (p === `/tx/${n.txid}/hex`) return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: n.revealHex });
      if (p === `/tx/${n.txid}`) return json(route, { txid: n.txid, status: { confirmed: true, block_height: n === NA ? 970000 : 970200 }, vout: [{ scriptpubkey: '5120' + XONLY.slice(2), value: 330 }] });
    }
    if (/\/fees\/recommended$/.test(p)) return json(route, { fastestFee: 3, halfHourFee: 3, hourFee: 2, economyFee: 1, minimumFee: 1 });
    if (/\/fee-estimates$/.test(p)) return json(route, { 1: 3, 6: 2, 144: 1 });
    return route.fallback();
  };
  await api(/^https:\/\/(mempool\.space|blockstream\.info)\/api\//, explorer);
  await api(/^https:\/\/api\.tacit\.finance\/chain\//, explorer);
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/dump/, (route) => json(route, { attestedHeight: 970100, snapshot: { height: 970100,
    liveTriples: [[pool.outpointKey('0x' + rev(NA.txid), 0), pool.commitmentHash(NA.cx, NA.cy), CETH, XONLY, 0]], noteLeaves: [leafOf(NA)], spentLinks: [],
    burnNodes: [['0x' + '00'.repeat(32), '0x' + '00'.repeat(32), '0x' + '00'.repeat(32), true]], pendingDepositRecords: [] } }));
  await api(/^https:\/\/api\.tacit\.finance\/crossout\/minted/, (route) => json(route, { decided: false, minted: false }));
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/(status|eth-state)/, (route) => json(route, { network: 'mainnet', attestedHeight: 970100, tipHeight: 970100, lagBlocks: 0 }));

  // The journal remembers both settles (a minted cross-out each), which spares the Ethereum lookup and the search.
  const big = (v) => ({ __big: String(v) });
  const jr = (n) => ({ id: n.nullifier, network: 'mainnet', walletPub: pub, stage: 'minted', createdAt: Date.now() - 36e5, destXonly: XONLY.slice(2),
    source: { nullifier: n.nullifier, value: big(n.amount), amount: big(n.amount), fee: big(0), assetId: CETH, ticker: 'tETH' }, settle: { txHash: 'e1'.repeat(32), claimId: n.claimId, cx: n.cx, cy: n.cy, ethBlock: 26000000, claimIdVerified: true } });
  await r.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`tacit-crossout-bridge-v1:mainnet:${pub}`, JSON.stringify([jr(NA), jr(NB)])]);
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'true'));
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  await go(r.page, '#private/bitcoin');
  await r.page.waitForSelector('#xb-look', { timeout: 120000 });
  ok(/Look for it/.test(await text(r.page, '#eth-v1')), 'xbring: tETH on Bitcoin is listed on request, so a key that has bridged nothing loads nothing');
  await r.page.click('#xb-look');
  await until(r.page, () => document.querySelectorAll('#eth-v1 input[name="xb-note"]').length === 2, null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | section: ${(await text(r.page, '#eth-v1')).replace(/\s+/g, ' ').slice(-400)} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const items = await r.page.$$eval('#eth-v1 label.brn', (xs) => xs.map((x) => ({ text: x.textContent.replace(/\s+/g, ' ').trim(), off: x.classList.contains('off') })));
  ok(items.length === 2 && items.some((x) => /0\.004 tETH/.test(x.text) && !x.off) && items.some((x) => /0\.003 tETH/.test(x.text) && x.off && /Waiting for Bitcoin’s proof on Ethereum to reach its block/.test(x.text)),
    `xbring: both notes are found with their amounts; the one the proof has recorded can be chosen, the other says why not (${items.map((x) => x.text).join(' | ')})`);
  await until(r.page, () => /You get[^]*0\.004 private tETH on Ethereum/.test(document.querySelector('#xb-rcpt')?.textContent || ''), null, 120000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | rcpt: ${(await text(r.page, '#xb-rcpt')).replace(/\s+/g, ' ')}`); });
  const rc = (await text(r.page, '#xb-rcpt')).replace(/\s+/g, ' ');
  ok(/Relay feeNone/.test(rc) && /Bitcoin feeabout [\d,]+ sats/.test(rc) && !(await r.page.isVisible('#xb-ackrow')) === false, `xbring: the one ready note is chosen for the holder and its receipt names what arrives and the Bitcoin fee (${rc.slice(0, 200)})`);
  ok(await r.page.isDisabled('#xb-go'), 'xbring: the button waits for the box to be ticked');
  await r.page.check('#xb-ack');
  ok(!(await r.page.isDisabled('#xb-go')), 'xbring: ticked, it can start');
  const before = posts.length;
  await r.page.click('#xb-go');
  await until(r.page, () => document.querySelectorAll('#eth-v1 .brr').length === 1, null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const sent = [...new Set(posts.slice(before))];             // an explorer a transaction is offered to more than once sees it once
  ok(sent.length === 2, `xbring: the burn is signed and its commit and reveal go out through ordinary relay (${sent.length} transactions)`);
  const decs = await r.page.evaluate(async (txs) => { const { classifyConfidentialTx } = await import('/burn-deposit-bitcoin.js'); return txs.map((h) => { const d = classifyConfidentialTx('0x' + h); return d ? { type: d.type, nullifier: d.nullifier, assetId: d.assetId, target: d.target } : null; }); }, sent);
  const dec = decs.find((d) => d && d.type === 'burn') || null;
  const nu = pool.nullifier(pool.btcNoteLeaf(CETH, NA.cx, NA.cy, XONLY));
  ok(dec && dec.type === 'burn' && dec.nullifier === nu && String(dec.assetId).toLowerCase() === CETH, `xbring: the reveal burns the note under its own ν, for tETH, with this key as its owner (${JSON.stringify(dec).slice(0, 160)})`);
  const row = (await text(r.page, '#eth-v1 .brr')).replace(/\s+/g, ' ');
  ok(/0\.004 tETH/.test(row) && /Burn sent|Confirmed/.test(row) && !!(await r.page.$('#eth-v1 .brr .stp li.now')), `xbring: it shows under Coming back with its steps (${row.slice(0, 160)})`);
  const rec = await r.page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]')[0], `tacit-burndep-bridge-v1:mainnet:${pub}`);
  ok(rec && rec.source.ticker === 'tETH' && rec.source.p2tr === true && rec.path === 'reflected', 'xbring: the bridge journal holds it as a tETH, Taproot-owned, reflected burn');
  // The tab and the row stay for a return in flight even with the setting off and no cross-out left to follow.
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'false'));
  await r.page.evaluate(([k]) => localStorage.removeItem(k), [`tacit-crossout-bridge-v1:mainnet:${pub}`]);
  await go(r.page, '#private');
  await until(r.page, () => !!document.querySelector('#eth-v1 [data-v1="btc"]'), null, 60000);
  await go(r.page, '#private/bitcoin');
  await until(r.page, () => document.querySelectorAll('#eth-v1 .brr').length === 1, null, 60000);
  ok(true, 'xbring: with the setting off and no cross-out under way, a return in flight keeps the tab and its Coming back row');
  await go(r.page, '#bridge');
  await until(r.page, () => !document.querySelector('#bridge-body')?.hidden, null, 60000);
  await sleep(1500);
  ok((await r.page.$$('#bridge-body .brr')).length === 0, 'xbring: the TAC Bridge tab does not list the tETH bridge');
  if (r.errors.length) { fails++; console.log('FAIL xbring page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});
const WNS = '0x0000000000696760E15f265e828DB644A0c242EB';
const namehash = (n) => n.split('.').reverse().reduce((node, l) => Buffer.from(keccak_256(Buffer.concat([node, Buffer.from(keccak_256(Buffer.from(l)))]))), Buffer.alloc(32)).toString('hex');
const abiStr = (x) => { const b = Buffer.from(x).toString('hex'); return word(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, '0'); };
const readStr = (h) => { const d = h.replace(/^0x/, ''); const len = parseInt(d.slice(64, 128), 16); return Buffer.from(d.slice(128, 128 + len * 2), 'hex').toString(); };
await step('pts', async () => {
  await rpc('anvil_impersonateAccount', [RECIPIENT]);
  await rpc('anvil_setBalance', [RECIPIENT, '0x' + (10n ** 18n).toString(16)]);
  const r = await openPage({ account: RECIPIENT });
  await r.page.goto(r.url + '#pts');
  await r.page.click('#pts-connect');
  await until(r.page, () => !!document.querySelector('#pts-body .pt'), null, 120000);
  if (await r.page.$('[data-claim]')) {
    const t0 = await tacOf(RECIPIENT);
    await r.page.click('[data-claim]');
    await until(r.page, () => /Claimed|err/.test(document.querySelector('#pts-status')?.innerHTML || ''), null, 120000);
    ok((await tacOf(RECIPIENT)) > t0, `pts: a points reward claims to its own address ${await text(r.page, '#pts-status')}`);
  } else ok(true, 'pts: nothing is waiting for this address on the fork');
  if (r.errors.length) { fails++; console.log('FAIL pts page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
  const w = await openPage({ account: A0, key: K0 });
  const hex = 'a11ce'.padEnd(64, '7'), acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 17n).toString(16)]);
  await w.page.goto(w.url + '#wallet');
  await w.page.click('#wallet-body [data-in="paste"]');
  await w.page.fill('#ws-hex', hex);
  await w.page.click('#wallet-body [data-in="key"]');
  await until(w.page, () => !!document.querySelector('#wallet-dot.on'));
  await go(w.page, '#pts');
  await w.page.waitForSelector('#wei-name', { timeout: 60000 });
  const label = 'tacitlite' + Date.now().toString(36);
  await w.page.fill('#wei-name', label);
  await until(w.page, () => !document.querySelector('#wei-go').disabled, null, 60000);
  await w.page.click('#wei-go');
  const tick = setInterval(async () => { try { console.log('    [pts] ' + (await w.page.evaluate(() => document.querySelector('#pts-status')?.textContent || '(no status)')).slice(0, 140)); } catch {} }, 20000);
  await until(w.page, () => /pays you privately|err/.test(document.querySelector('#pts-status')?.innerHTML || ''), null, 300000).finally(() => clearInterval(tick));
  const node = namehash(label + '.wei');
  const owner = await rpc('eth_call', [{ to: WNS, data: '0x6352211e' + node }, 'latest']).catch(() => '0x');
  const rec = readStr(await rpc('eth_call', [{ to: WNS, data: '0x59d1d43c' + node + word(64) + abiStr('finance.tacit') }, 'latest']).catch(() => '0x'));
  ok(owner.slice(-40) === acct.slice(2) && rec === shownAddress(hex), `pts: ${label}.wei registers to the Tacit account through zRouter and carries its unified tacit1 (${await text(w.page, '#pts-status')})`);
  if (w.errors.length) { fails++; console.log('FAIL pts page errors: ' + w.errors.slice(0, 3).join(' | ')); }
  await w.browser.close();
});
// The points sheet from a stubbed service: activity across chains in time order (Base's larger block numbers do not put
// an older Base deposit first), the holder boost of the newest, the rank, what was claimed, and today's countdown; the day's
// pot, the all-time and today's boards, the gap to the next rank, what changed since an earlier day, and the points-per-day
// bars; and, without anyone connected, the same public board with a way to find an address in it.
await step('ptsview', async () => {
  const t0 = Math.floor(Date.now() / 1000), today = Math.floor(t0 / 86400);
  const seen = JSON.stringify({ [A0.toLowerCase()]: { cur: { d: today - 3, p: 1000, k: 5 } } });
  const r = await openPage({ account: A0, init: { fn: (s) => { if (!localStorage.getItem('tacit-weld-pts-seen-v1')) localStorage.setItem('tacit-weld-pts-seen-v1', s); }, arg: seen } });
  const dep = (h, chain, block, ago, activity, pts, boost) => ({ tx_hash: '0x' + h.repeat(64), block_number: block, block_time: t0 - ago, amount_wei: '100000000000000000', points: pts, activity, tac_boost: boost, chain_id: chain, pp_boosted: false });
  const hex = (c) => '0x' + c.repeat(40);
  const pointsBody = (count) => ({ address: A0.toLowerCase(), points: 1234.5, deposit_count: count,
    today: { points: 100, totalPoints: 1000, dayBudgetWei: '1111111111111111111111', factor: 1.25, rawPoints: 80, kinds: 2, activeDays: 3 },
    deposits: [dep('b', 8453, 52000000, 7200, 'evmpooldeposit', 90, 1), dep('a', 1, 26090000, 60, 'wrap', 125, 1.5), dep('c', 1, 26080000, 90000, 'zswapeth', 100, 1), { ...dep('d', 1, 26070000, 200000, 'cbtchold', 80, 1), amount_wei: '0' }, dep('e', 1, 26060000, 300000, 'cbtcmint', 10000, 1)] });
  // Each day of the program, as the service gives it: today an estimate, a settled day with its TAC, and a day that carries points only (its TAC is null).
  const daysBody = { address: A0.toLowerCase(), startDay: today - 8, programDays: 90, today, lastSettledDay: today - 1, earnedWei: '8000000000000000000', days: [
    { day: today, points: 215, raw: 172, factor: 1.25, tacWei: '4500000000000000000', settled: false }, { day: Math.floor((t0 - 200000) / 86400), points: 80, raw: 80, tacWei: '1000000000000000000', settled: true }, { day: today - 1, points: 100, tacWei: '2000000000000000000', settled: true }, { day: today - 5, points: 40, tacWei: null, settled: true }] };
  await r.ctx.route(/api\.tacit\.finance\/points\/0x/, (route) => json(route, /\/days$/.test(route.request().url()) ? daysBody : pointsBody(5)));
  await r.ctx.route(/api\.tacit\.finance\/claim\/0x/, (route) => json(route, { cumulativeAmount: '8000000000000000000', claimedWei: '5000000000000000000', unclaimedWei: '3000000000000000000', proof: null }));
  const dShort = (d) => new Date(d * 864e5).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  // Terms that differ from the page's own, so a pass shows they are read and not echoed: another ceiling that lifts later, a dearer wrap, no cUSD row, other holder tiers.
  const program = { startDay: today - 8, days: 90, lastDay: today + 81, totalWei: '100000000000000000000000', dayBudgetWei: '1111111111111111111111',
    rateCap: [{ fromDay: today - 2, maxWeiPerPoint: '20000000000000000' }, { fromDay: today + 20, maxWeiPerPoint: null }], settleGraceSecs: 1800,
    earlyBonus: { max: 3, halfLife: 100 }, tethWrapBoost: 1.25, holder: { tiers: [{ tac: 50, multiplier: 1.1 }, { tac: 500, multiplier: 1.3 }], windowHours: 24 },
    rates: { wrap: 1500, evmpooldeposit: 1000, zswapeth: 1000, cbtcmint: 1000, cbtchold: 500 }, cbtcHoldFromDay: today + 1,
    // A weight in force, a multiplier for the week that starts tomorrow, and a bond rule that does too.
    weights: [{ fromDay: today - 1, weights: { cbtcmint: 3 } }], engagement: [{ fromDay: today + 1, kindStep: 0.25, returnStep: 0.25, maxKinds: 2, minPoints: 25 }], bondHoldFromDay: today + 1,
    kinds: { wrap: 'private', cbtcmint: 'borrow' } };
  await r.ctx.route(/api\.tacit\.finance\/leaderboard/, (route) => json(route, /day=today/.test(route.request().url())
    ? { day: today, programDay: 9, programDays: 90, program, totalPoints: 1000, dayBudgetWei: '1111111111111111111111', taking: 2, rows: [{ address: A0.toLowerCase(), points: 100 }, { address: hex('2'), points: 50 }] }
    : [{ address: hex('1'), points: 9e9 }, { address: A0.toLowerCase(), points: 1234.5 }]));
  await r.page.goto(r.url + '#pts');
  await r.page.click('#pts-connect');
  await until(r.page, () => !!document.querySelector('#pts-body .pt .ptl, #pts-body .pt .ptd'), null, 60000);
  await r.page.click('#pts-body .ptlog summary');
  await shot(r.page, 'ptsview');
  const v = await r.page.evaluate(() => ({ body: document.querySelector('#pts-body').textContent.replace(/\s+/g, ' '),
    items: [...document.querySelectorAll('#pts-body .pt .ptl li:not(.day)')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
    days: [...document.querySelectorAll('#pts-body .pt .ptl li.day')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
    bars: document.querySelectorAll('#pts-body .ptd-b').length,
    links: [...document.querySelectorAll('#pts-body .ptl a')].map((a) => a.href) }));
  ok(/^Wrapped ETH/.test(v.items[0] || '') && /^Deposited ETH on Base/.test(v.items[1] || '') && /^Swapped ETH/.test(v.items[2] || ''), `ptsview: recent points in time order across chains (${v.items.join(' | ')})`);
  ok(v.days.length >= 2 && /^Today\s*\+215\s*×1\.25\s*about 4\.5 TAC$/.test(v.days[0]) && /^Yesterday\s*\+100\s*2 TAC$/.test(v.days[1]), `ptsview: the activity is grouped under each day's total and what it paid (${v.days.join(' | ')})`);
  ok(/Holder boost at last activity\s*1\.5×/.test(v.body), 'ptsview: the holder boost is the newest activity\'s');
  ok(/rank\s*#2/.test(v.body) && /#1 today/.test(v.body) && /Claimed so far\s*5 TAC/.test(v.body) && /10% · about 111\.11 TAC/.test(v.body) && /closes in \d/.test(v.body), `ptsview: rank, claimed, today's share and the countdown (${v.body.slice(0, 500)})`);
  ok(/Earned on settled days\s*8 TAC/.test(v.body) && /To reach #1\s*8,999,998,766 points/.test(v.body), `ptsview: settled TAC and the gap to the rank above (${v.body.slice(0, 700)})`);
  ok(/Since \d+ \w+\s*\+235 points · up 3 places/.test(v.body), `ptsview: the change since an earlier day this browser saw (${v.body.slice(0, 700)})`);
  ok(/Today’s pot\s*1,111 TAC · day 9 of 90/.test(v.body) && /Points so far today\s*1,000 · 2 taking part/.test(v.body) && /each 1,000 points earn\s*1,111\.1 TAC/.test(v.body), `ptsview: the day's pot, points and rate (${v.body.slice(0, 500)})`);
  ok(v.bars >= 2, `ptsview: points per day are drawn as bars (${v.bars})`);
  const lastD = dShort(today + 81), nextD = dShort(today + 20);
  ok(new RegExp(`Every day through ${lastD} \\(UTC\\), up to 1,111 TAC is split by that day’s points, at most 0\\.02 TAC per point, no limit from ${nextD}\\.`).test(v.body),
    `ptsview: the lede states the days, the pot and the limit per point with its next change as the service gives them (${v.body.slice(0, 260)})`);
  ok(/1,500 points per ETH/.test(v.body) && /1,000 per ETH, on Ethereum, Base or Robinhood Chain/.test(v.body) && /1,000 per wstETH/.test(v.body) && !/Borrow cUSD/.test(v.body),
    'ptsview: each way of earning pays what the service says, and one it does not list is not offered');
  ok(/Early activity counts up to 3×\. Holding 50 or 500 public TAC at the same address through the past day multiplies its points by 1\.1 or 1\.3\./.test(v.body),
    `ptsview: the early bonus and the holder tiers are the service's (${v.body.slice(-330)})`);
  ok(/Hold 50 public TAC here through a day and what it does next earns 1\.1×/.test(v.body), 'ptsview: the next holder tier is read from the same tiers');
  ok(/1,000 per wstETH once cBTC is minted against it \(from \d+ \w+\) · ×3(?! from)/.test(v.body), 'ptsview: a weight in force shows on its way of earning');
  ok(new RegExp(`1,000 per wstETH once cBTC is minted against it \\(from ${dShort(today + 1)}\\) · ×3; 500 a day while a bond on a Bitcoin lock stays posted from ${dShort(today + 1)}`).test(v.body), 'ptsview: the bond\'s mint condition, its daily credit and the day they start show on its way of earning');
  ok(v.days.some((d) => /\+0\s*not counted/.test(d)), `ptsview: a day whose listed points were not counted (a released bond) says so instead of adding them up (${v.days.join(' | ')})`);
  ok(/Kept a cBTC bond posted/.test(v.body) && !v.links.some((h) => h.includes('d'.repeat(64))), 'ptsview: a day\'s bond credit is listed as activity and links to no transaction');
  ok(/This week\s*×1\.25 · 2 kinds of activity · 3 days/.test(v.body), `ptsview: an address whose points were multiplied for the week is told so (${v.body.slice(500, 900)})`);
  await r.page.click('#pts-body summary:has-text("Terms")');
  await r.page.evaluate(() => document.querySelector('#pts-body details:has(> summary)').closest('#pts-body').lastElementChild.scrollIntoView({ block: 'end' }));
  await shot(r.page, 'ptsview-terms');
  const terms = await r.page.$eval('#pts-body details:has(> summary:has-text("Terms"))', (d) => d.textContent.replace(/\s+/g, ' '));
  ok(new RegExp(`Runs\\s*${dShort(today - 8)} to ${lastD} \\(UTC\\), 90 days`).test(terms) && /Each day’s pot\s*up to 1,111 TAC, of 100,000 in all/.test(terms)
    && new RegExp(`Limit\\s*0\\.02 TAC per point, no limit from ${nextD}`).test(terms)
    && /Weights\s*cBTC bond ×3(?! from)/.test(terms)
    && new RegExp(`Each week\\s*25% more for each other kind of activity in the past 7 days \\(up to 50%; a kind counts once it has earned 25 points that week\\), and 25% more for activity on more than one day, from ${dShort(today + 1)}`).test(terms)
    && new RegExp(`Bonds\\s*a cBTC bond counts if cBTC has been minted against it and it is still posted when its day settles, shortly after the day ends, from ${dShort(today + 1)}; a bond on a Bitcoin lock earns a flat 500 points per wstETH for each further day it stays posted, credited when the day settles and counted as activity for the week, from ${dShort(today + 1)}`).test(terms)
    && /Counting\s*each activity at its weight, times the week’s multiplier\. A day’s pot is split by these counted points; the all-time total is points as scored/.test(terms) && /Points go to\s*the address that sent the transaction/.test(terms) && /Settled\s*each day, shortly after it ends/.test(terms) && /Claim\s*any time once a day is settled/.test(terms),
    `ptsview: the terms list the days, the pot, the limit, who is paid and when (${terms.slice(0, 300)})`);
  await r.page.click('.ptd-b:last-child');
  const said = (await r.page.textContent('.ptd-r')).trim();
  ok(/^Today · 215 points · about 4\.5 TAC$/.test(said), `ptsview: pressing a bar names its day, its points and its TAC (${said})`);
  const bars = await r.page.$$eval('.ptd-b', (b) => b.map((x) => x.dataset.ptd));
  ok(bars.some((x) => /^\w{3} \d+ \w+ · 40 points$/.test(x)) && bars.some((x) => /^Yesterday · 100 points · 2 TAC$/.test(x)), `ptsview: a day the service cannot show as paid carries points only (${bars.slice(-6).join(' | ')})`);
  const board = await r.page.$$eval('#pts-body ol.lb:not(details ol) li', (l) => l.map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
  ok(board.length === 2 && /^1\s*0x1111…1111/.test(board[0]) && /^2\s*0xf39f…2266 · you/.test(board[1]) && /2 taking part/.test(v.body), `ptsview: the leaderboard marks this address (${board.join(' | ')})`);
  await r.page.click('[data-plv="day"]');
  const day = await r.page.$$eval('#pts-body ol.lb:not(details ol) li', (l) => l.map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
  await r.page.evaluate(() => document.querySelector('#pts-body .seg.sub').scrollIntoView({ block: 'start' }));
  await shot(r.page, 'ptsview-board');
  ok(day.length === 2 && /^1\s*0xf39f…2266 · you\s*100\s*111\.11 TAC/.test(day[0]) && /^2\s*0x2222…2222\s*50\s*55\.56 TAC/.test(day[1]), `ptsview: today's board ranks the day's points with each share of the pot (${day.join(' | ')})`);
  ok(v.links.some((h) => h.startsWith('https://basescan.org/tx/0x' + 'b'.repeat(64))) && v.links.some((h) => h.startsWith('https://etherscan.io/tx/0x' + 'a'.repeat(64))), 'ptsview: each activity links to its own chain\'s explorer');
  ok(!(await r.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'ptsview: no sideways scroll');
  if (r.errors.length) { fails++; console.log('FAIL ptsview page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
  // A history longer than the 100 activities the service lists still draws its bars from the days; without the route it does not draw them, and says what it lists.
  for (const route of [true, false]) {
    const l = await openPage({ account: A0 });
    await l.ctx.route(/api\.tacit\.finance\/points\/0x/, (rt) => (/\/days$/.test(rt.request().url()) ? (route ? json(rt, daysBody) : rt.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"not found"}' })) : json(rt, pointsBody(250))));
    await l.ctx.route(/api\.tacit\.finance\/claim\/0x/, (rt) => json(rt, { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null }));
    await l.ctx.route(/api\.tacit\.finance\/leaderboard/, (rt) => json(rt, [{ address: A0.toLowerCase(), points: 1234.5 }]));
    await l.page.goto(l.url + '#pts');
    await l.page.click('#pts-connect');
    await until(l.page, () => !!document.querySelector('#pts-body .pt .ptlog'), null, 60000);
    await l.page.click('#pts-body .ptlog summary');
    const n250 = await l.page.evaluate(() => ({ bars: document.querySelectorAll('#pts-body .ptd-b').length, body: document.querySelector('#pts-body').textContent.replace(/\s+/g, ' ') }));
    ok(route ? n250.bars >= 2 : n250.bars === 0 && /The latest 5 of 250 are listed/.test(n250.body), `ptsview: ${route ? 'a history past the 100 listed still draws its days' : 'without the days route, a history past the 100 listed draws no bars and says so'} (${n250.bars} bars)`);
    if (l.errors.length) { fails++; console.log('FAIL ptsview page errors: ' + l.errors.slice(0, 3).join(' | ')); }
    await l.browser.close();
  }
  // Terms the page cannot read leave its own in place; a pot below the nominal one says it is at the limit per point.
  {
    const l = await openPage({ account: A0 });
    await l.ctx.route(/api\.tacit\.finance\/points\/0x/, (rt) => json(rt, { address: A0.toLowerCase(), points: 10, deposit_count: 1, today: { points: 10, totalPoints: 100, dayBudgetWei: '500000000000000000000' }, deposits: [] }));
    await l.ctx.route(/api\.tacit\.finance\/claim\/0x/, (rt) => json(rt, { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null }));
    await l.ctx.route(/api\.tacit\.finance\/leaderboard/, (rt) => json(rt, /day=today/.test(rt.request().url())
      ? { day: today, programDay: 9, programDays: 90, program: { startDay: 'soon', days: -1, dayBudgetWei: 'a lot', rates: 7 }, totalPoints: 100, dayBudgetWei: '500000000000000000000', taking: 1, rows: [{ address: A0.toLowerCase(), points: 10 }] }
      : [{ address: A0.toLowerCase(), points: 10 }]));
    await l.page.goto(l.url + '#pts');
    await l.page.click('#pts-connect');
    await until(l.page, () => !!document.querySelector('#pts-body .pulse'), null, 60000);
    const d = await l.page.evaluate(() => document.querySelector('#pts-body').textContent.replace(/\s+/g, ' '));
    const capped = today >= Math.floor(Date.UTC(2026, 9, 3) / 864e5);
    ok(new RegExp(`Every day through 21 Dec \\(UTC\\), up to 1,111 TAC is split by that day’s points, at most 0\\.03 TAC per point${capped ? '' : ' from 3 Oct'}\\.`).test(d) && /1,250 points per ETH/.test(d) && /Borrow cUSD/.test(d) && /Holding 100, 1,000 or 10,000 public TAC/.test(d),
      `ptsview: terms the page cannot read leave its own (${d.slice(0, 240)})`);
    ok(/Today’s pot\s*500 TAC · day 9 of 90 at the limit per point/.test(d), `ptsview: a pot below the nominal one says it is at the limit per point (${d.slice(0, 300)})`);
    if (l.errors.length) { fails++; console.log('FAIL ptsview page errors: ' + l.errors.slice(0, 3).join(' | ')); }
    await l.browser.close();
  }
  // A bond that stops scoring when posted: until the day it changes it still pays, then only the daily credit does, and Terms says so.
  {
    const z = await openPage({ account: A0 });
    const zeroProgram = { startDay: today - 8, days: 90, totalWei: '100000000000000000000000', dayBudgetWei: '1111111111111111111111', rateCap: [],
      weights: [{ fromDay: today + 1, weights: { cbtcmint: 0 } }], engagement: [], bondHoldFromDay: today + 1, cbtcHoldFromDay: today + 1,
      rates: { wrap: 1250, evmpooldeposit: 1000, zswapeth: 1000, cbtcmint: 1000, cbtchold: 500 } };
    await z.ctx.route(/api\.tacit\.finance\/points\/0x/, (rt) => json(rt, { address: A0.toLowerCase(), points: 0, deposit_count: 0, today: { points: 0, totalPoints: 100, dayBudgetWei: '1111111111111111111111' }, deposits: [] }));
    await z.ctx.route(/api\.tacit\.finance\/claim\/0x/, (rt) => json(rt, { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null }));
    await z.ctx.route(/api\.tacit\.finance\/leaderboard/, (rt) => json(rt, /day=today/.test(rt.request().url())
      ? { day: today, programDay: 9, programDays: 90, program: zeroProgram, totalPoints: 100, dayBudgetWei: '1111111111111111111111', taking: 1, rows: [{ address: A0.toLowerCase(), points: 10 }] }
      : [{ address: A0.toLowerCase(), points: 10 }]));
    await z.page.goto(z.url + '#pts');
    await z.page.click('#pts-connect');
    await until(z.page, () => !!document.querySelector('#pts-body .pulse'), null, 60000);
    await z.page.click('#pts-body summary:has-text("Terms")');
    const zt = { body: await z.page.$eval('#pts-body', (e) => e.textContent.replace(/\s+/g, ' ')), terms: await z.page.$eval('#pts-body details:has(> summary:has-text("Terms"))', (d) => d.textContent.replace(/\s+/g, ' ')) };
    ok(new RegExp(`1,000 per wstETH until ${dShort(today)}; then 500 a day while a bond on a Bitcoin lock stays posted`).test(zt.body), `ptsview: until the day posting stops scoring it still pays, then only the daily credit does (${zt.body.slice(zt.body.indexOf('Post a bond'), zt.body.indexOf('Post a bond') + 200)})`);
    ok(new RegExp(`Weights\\s*cBTC bond not counted from ${dShort(today + 1)}`).test(zt.terms) && !/cBTC has been minted against it/.test(zt.terms) && /a flat 500 points per wstETH for each further day it stays posted/.test(zt.terms),
      `ptsview: Terms says posting a bond is not counted, drops the rule that no longer matters, and states the daily credit (${zt.terms.slice(0, 400)})`);
    if (z.errors.length) { fails++; console.log('FAIL ptsview page errors: ' + z.errors.slice(0, 3).join(' | ')); }
    await z.browser.close();
  }
  // Nobody connected: the pot and the board are public. A service without the day's board is told by its array: no Today switch.
  const n = await openPage({ account: A0, viewport: { width: 390, height: 900 } });
  const many = Array.from({ length: 12 }, (_, i) => ({ address: '0x' + (i + 1).toString(16).repeat(40).slice(0, 40), points: 1000 - i * 10 }));
  await n.ctx.route(/api\.tacit\.finance\/points\/0x/, (route) => json(route, { address: hex('0'), points: 0, deposit_count: 0, today: { points: 0, totalPoints: 500, dayBudgetWei: '1111111111111111111111' }, deposits: [] }));
  await n.ctx.route(/api\.tacit\.finance\/leaderboard/, (route) => json(route, many));
  await n.page.goto(n.url + '#pts');
  await until(n.page, () => !!document.querySelector('#pts-body ol.lb'), null, 60000);
  await n.page.click('#pts-body .ptlog summary');
  await n.page.fill('#pl-q', '0x3333');
  await n.page.evaluate(() => document.querySelector('#pts-body .lbl:has(+ ol.lb)')?.scrollIntoView({ block: 'start' }));
  await shot(n.page, 'ptsview-phone');
  const f = await n.page.evaluate(() => ({ body: document.querySelector('#pts-body').textContent.replace(/\s+/g, ' '), gate: !!document.querySelector('#pts-connect'), toggle: !!document.querySelector('[data-plv]'),
    shown: [...document.querySelectorAll('#pl-all li')].filter((li) => !li.hidden).map((li) => li.dataset.a), top: document.querySelectorAll('#pts-body ol.lb:not(details ol) li').length }));
  ok(f.gate && f.top === 5 && !f.toggle && /Today’s pot\s*1,111 TAC/.test(f.body) && /12 taking part/.test(f.body), `ptsview: the pot and the top five show without a wallet, with no Today switch while the service lacks it (${f.body.slice(0, 300)})`);
  ok(f.shown.length === 1 && f.shown[0].startsWith('0x3333'), `ptsview: typing in the whole board narrows it to the matching address (${f.shown.join(',')})`);
  ok(!(await n.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'ptsview: no sideways scroll at phone width');
  if (n.errors.length) { fails++; console.log('FAIL ptsview page errors: ' + n.errors.slice(0, 3).join(' | ')); }
  await n.browser.close();
});
// Relayed jobs reach the page as tacit:job events; here they are dispatched the way the relay client dispatches them, and
// /confidential/status answers from `served`, so a reload can find settled a job that had failed. Notification records
// what would be shown instead of showing it.
const NOTIFY_STUB = () => {
  window.__notes = [];
  window.Notification = class { static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); }
    constructor(title, o = {}) { window.__notes.push({ title, body: o.body || '', tag: o.tag || '' }); } close() {} };
};
const hideTab = (p, on) => p.evaluate((h) => {
  for (const [k, v] of [['hidden', h], ['visibilityState', h ? 'hidden' : 'visible']]) Object.defineProperty(document, k, { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}, on);
const actRows = (p) => p.evaluate(() => [...document.querySelectorAll('#act-body .actr')].map((li) => ({ id: li.dataset.act, text: li.textContent.replace(/\s+/g, ' ').trim(),
  now: li.querySelector('.stp .now')?.textContent || '', bad: li.querySelector('.stp .bad')?.textContent || '', links: [...li.querySelectorAll('.actr-f a')].map((a) => a.href) })));
const openActivity = async (p) => { await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close())); await p.click('#act'); await p.waitForSelector('#sheet-act[open]'); };
const serveStatus = (ctx, served) => ctx.route(/\/confidential\/status\?id=/, (route) => {
  const id = new URL(route.request().url()).searchParams.get('id'), b = served[id];
  return b ? json(route, { jobId: id, mode: 'settle', txHash: null, error: null, createdAt: Date.now(), ...b })
    : route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"unknown job"}' });
});
const pasteKey = async (p, hex) => {
  await p.evaluate(() => { location.hash = ''; location.hash = '#wallet'; });
  await p.click('#wallet-body [data-in="paste"]');
  await p.fill('#ws-hex', hex);
  await p.click('#wallet-body [data-in="key"]');
  await until(p, () => !!document.querySelector('#wallet-dot.on'));
};
await step('activity', async () => {
  const served = {}, H = (b) => '0x' + b.repeat(32);
  const r = await openPage({ account: A0, key: K0, viewport: { width: 390, height: 900 }, init: { fn: NOTIFY_STUB } });
  await serveStatus(r.ctx, served);
  const fire = (d) => r.page.evaluate((x) => dispatchEvent(new CustomEvent('tacit:job', { detail: { txHash: null, error: null, at: Date.now(), ...x } })), d);
  const toastHas = (re) => until(r.page, (s) => new RegExp(s).test(document.querySelector('#toast-container')?.textContent || ''), re.source, 15000).then(() => true, () => false);
  const row = async (id) => (await actRows(r.page)).find((x) => x.id === id) || { text: '', links: [], now: '', bad: '' };
  let seed = null;
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('.tile');
    ok(await r.page.$eval('#act', (b) => b.hidden), 'activity: no Activity button before anything has happened');
    await fire({ jobId: 'j-wrap', type: 'wrap', status: 'pending' });
    await until(r.page, () => !document.querySelector('#act').hidden && document.querySelector('#act-n').textContent === '1', null, 15000);
    ok(await toastHas(/Make private: queued for the relay/), 'activity: a queued job shows in the header with a count, and is toasted');
    await openActivity(r.page);
    ok((await row('job:j-wrap')).now === 'Queued', `activity: its row is at Queued (${(await row('job:j-wrap')).text.slice(0, 50)})`);
    await fire({ jobId: 'j-wrap', type: 'wrap', status: 'proving' });
    await until(r.page, () => document.querySelector('[data-act="job:j-wrap"] .stp .now')?.textContent === 'Proving', null, 15000);
    ok(true, 'activity: then at Proving');
    await fire({ jobId: 'j-wrap', type: 'wrap', status: 'settled', txHash: H('a1') });
    await until(r.page, () => /Done in/.test(document.querySelector('[data-act="job:j-wrap"]')?.textContent || ''), null, 15000);
    const done = await row('job:j-wrap');
    ok(done.links.includes(`https://etherscan.io/tx/${H('a1')}`) && await r.page.$eval('#act-n', (n) => n.hidden), `activity: done, linked to its transaction, nothing left in flight (${done.text.slice(0, 60)})`);
    ok(await toastHas(/Make private: done\./), 'activity: done is toasted');
    // A failure reads as the relay wrote it, with the transaction it names linked.
    await fire({ jobId: 'j-send', type: 'stealthlock', status: 'pending' });
    await fire({ jobId: 'j-send', type: 'stealthlock', status: 'failed', error: `this note was already spent in ${H('b2')}; if that was this same request, it went through` });
    await until(r.page, () => document.querySelector('[data-act="job:j-send"] .stp .bad')?.textContent === 'Failed', null, 15000);
    const failed = await row('job:j-send');
    ok(/This note was already spent in 0xb2b2/.test(failed.text) && failed.links.includes(`https://etherscan.io/tx/${H('b2')}`), `activity: a failure reads as the relay wrote it (${failed.text.slice(0, 80)})`);
    ok(await toastHas(/Send privately did not go through: This note was already spent/), 'activity: the failure is toasted with its reason');
    // A system notification only while the tab is out of sight.
    await r.page.click('#act-notify');
    await until(r.page, () => localStorage.getItem('tacit-lite-notify-v1') === 'true', null, 15000);
    const n0 = await r.page.evaluate(() => window.__notes.length);
    await fire({ jobId: 'j-seen', type: 'transfer', status: 'pending' });
    await fire({ jobId: 'j-seen', type: 'transfer', status: 'settled', txHash: H('c3') });
    await sleep(500);
    const n1 = await r.page.evaluate(() => window.__notes.length);
    await hideTab(r.page, true);
    await fire({ jobId: 'j-away', type: 'unwrap', status: 'pending' });
    await fire({ jobId: 'j-away', type: 'unwrap', status: 'settled', txHash: H('d4') });
    await sleep(500);
    const notes = await r.page.evaluate(() => window.__notes);
    await hideTab(r.page, false);
    ok(n1 === n0 && notes.length === n0 + 1 && notes.at(-1).title === 'Withdraw' && /Done/.test(notes.at(-1).body),
      `activity: a system notification goes out only while the tab is hidden (${n0} → ${n1} → ${notes.length}: ${notes.at(-1)?.title} · ${notes.at(-1)?.body})`);
    // A transaction the page sends is followed to its receipt: ETH from the connected wallet to a pasted key's Tacit account.
    await pasteKey(r.page, 'ac71'.padEnd(64, '6'));
    await toWallet(r.page);
    await r.page.waitForSelector('[data-pay="wallet"]');
    await r.page.click('[data-pay="wallet"]');
    await until(r.page, () => document.querySelector('[data-pay="wallet"]')?.classList.contains('main'));
    await r.page.waitForSelector('#ac-go');
    await r.page.fill('#ac-mv', '0.001');
    await r.page.click('#ac-go');
    await until(r.page, () => /Added\.|err/.test(document.querySelector('#ac-status')?.innerHTML || ''), null, 120000);
    await openActivity(r.page);
    await until(r.page, () => [...document.querySelectorAll('#act-body .actr')].some((li) => /Add 0\.001 ETH/.test(li.textContent) && /Confirmed in/.test(li.textContent)), null, 60000).catch(() => {});
    const add = (await actRows(r.page)).find((x) => /Add 0\.001 ETH/.test(x.text)) || { text: '', links: [] };
    ok(/Confirmed in/.test(add.text) && add.links.some((l) => /^https:\/\/etherscan\.io\/tx\/0x[0-9a-f]{64}$/.test(l)), `activity: a transaction sent from the page is followed to its receipt (${add.text.slice(0, 70)})`);
    // Before a reload: a job left proving, one failed within six hours (above), and one that failed longer ago.
    await fire({ jobId: 'j-mint', type: 'cbtcmint', status: 'pending' });
    await fire({ jobId: 'j-mint', type: 'cbtcmint', status: 'proving' });
    await sleep(600);                                                         // the list is written shortly after each change
    seed = await r.page.evaluate(() => localStorage.getItem('tacit-lite-activity-v1'));
    await r.page.evaluate(() => {
      const k = 'tacit-lite-activity-v1', s = JSON.parse(localStorage.getItem(k)), t = Date.now();
      s.items.push({ id: 'job:j-old', kind: 'job', type: 'unwrap', label: 'Withdraw', status: 'failed', err: 'settle reverted: stale root', at: t - 8 * 3600e3, up: t - 7 * 3600e3, end: t - 7 * 3600e3 });
      localStorage.setItem(k, JSON.stringify(s));
    });
    Object.assign(served, { 'j-send': { type: 'stealthlock', status: 'settled', txHash: H('e5') }, 'j-mint': { type: 'cbtcmint', status: 'settled', txHash: H('f6') }, 'j-old': { type: 'unwrap', status: 'settled', txHash: H('a7') } });
    await r.page.reload();
    await r.page.waitForSelector('.tile');
    ok(await toastHas(/Send privately went through after all/), 'activity: after a reload, a job that failed in the last six hours is asked about again, and found settled');
    await openActivity(r.page);
    await until(r.page, () => /Done in/.test(document.querySelector('[data-act="job:j-mint"]')?.textContent || ''), null, 30000).catch(() => {});
    const [send2, mint2, old2] = [await row('job:j-send'), await row('job:j-mint'), await row('job:j-old')];
    ok(send2.bad === '' && /Went through after all/.test(send2.text) && send2.links.includes(`https://etherscan.io/tx/${H('e5')}`), `activity: it now reads done, with the settle's transaction (${send2.text.slice(0, 70)})`);
    ok(/Done in/.test(mint2.text) && mint2.links.includes(`https://etherscan.io/tx/${H('f6')}`), `activity: a job still proving at the reload is followed until it settles (${mint2.text.slice(0, 60)})`);
    ok(old2.bad === 'Failed', `activity: a failure older than six hours is left as it was (${old2.text.slice(0, 40)})`);
    ok((await actRows(r.page)).some((x) => /Add 0\.001 ETH/.test(x.text) && /Confirmed/.test(x.text)), 'activity: the list, and each outcome, survives the reload');
    await shot(r.page, 'activity-phone');
    // A job still in line after a minute says it keeps its place. The relay's heartbeat says why it is holding settles;
    // the page does not repeat that, and a job it cannot finish itself (a transfer) offers nothing more.
    await r.ctx.route(/\/prover-health\?/, (route) => json(route, { services: { settle: { healthy: true, age_seconds: 20,
      note: 'settle: settle wallet holds 0.0010 ETH, under the 0.0031 ETH a settle can cost at today’s gas — proving only jobs a page settles itself; the rest wait until it is topped up' } } }));
    served['j-wait'] = { type: 'transfer', status: 'pending' };
    await sleep(600);
    await r.page.evaluate(() => {
      const k = 'tacit-lite-activity-v1', s = JSON.parse(localStorage.getItem(k)), t = Date.now();
      s.items.unshift({ id: 'job:j-wait', kind: 'job', type: 'transfer', label: 'Private transfer', status: 'pending', at: t - 90e3, up: t - 90e3 });
      localStorage.setItem(k, JSON.stringify(s));
    });
    await r.page.reload();
    await r.page.waitForSelector('.tile');
    await openActivity(r.page);
    const waitOk = await until(r.page, () => /In line\. It keeps its place/.test(document.querySelector('[data-act="job:j-wait"]')?.textContent || ''), null, 20000).then(() => true, () => false);
    const wait = await row('job:j-wait');
    ok(waitOk && wait.now === 'Queued' && !/gas|top/i.test(wait.text) && !/from your/.test(wait.text), `activity: a job in line past a minute says it keeps its place, and nothing about the relay's wallet (${wait.text.slice(0, 110)})`);
    served['j-wait'] = { type: 'transfer', status: 'settled', txHash: H('b8') };
    await until(r.page, () => /Done in/.test(document.querySelector('[data-act="job:j-wait"]')?.textContent || ''), null, 30000).catch(() => {});
    ok(/Done in/.test((await row('job:j-wait')).text), 'activity: and it reads done once the relay settles it');
    // The list is this browser's: with another key open, an entry the first key made says so; one made with no key does not.
    // A pasted key is not kept across the reloads above, so a key is locked first only if one is open.
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#wallet'; });
    await r.page.waitForSelector('#w-lock, #wallet-body [data-in="paste"]');
    if (await r.page.$('#w-lock')) { await r.page.click('#w-lock'); await until(r.page, () => !document.querySelector('#wallet-dot.on')); }
    await pasteKey(r.page, 'bd82'.padEnd(64, '7'));
    await openActivity(r.page);
    ok(/Made with another Tacit key/.test((await row('job:j-mint')).text) && !/another Tacit key/.test((await row('job:j-old')).text),
      `activity: an entry another key made says so (${(await row('job:j-mint')).text.slice(-60)})`);
    // At most twenty entries are kept, newest first.
    for (let i = 0; i < 22; i++) await fire({ jobId: `j-n${i}`, type: 'transfer', status: 'settled', txHash: H('ab') });
    await sleep(600);
    const kept = await r.page.evaluate(() => JSON.parse(localStorage.getItem('tacit-lite-activity-v1')).items.map((x) => x.id));
    ok(kept.length === 20 && kept[0] === 'job:j-n21', `activity: the list keeps the newest twenty (${kept.length}, newest ${kept[0]})`);
    if (r.errors.length) { fails++; console.log('FAIL activity page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
  // The same list in the other widths and schemes, with one job still proving.
  if (SHOTS && seed) {
    const live = JSON.parse(seed);
    live.items.unshift({ id: 'job:j-live', kind: 'job', type: 'sendunwrap', label: 'Withdraw 0.05 ETH', status: 'proving', prov: true, at: Date.now() - 42e3, up: Date.now() - 20e3 });
    for (const [tag, viewport, colorScheme] of [['phone-dark', { width: 390, height: 900 }, 'dark'], ['desk', { width: 1280, height: 900 }, 'light'], ['desk-dark', { width: 1280, height: 900 }, 'dark']]) {
      const v = await openPage({ account: A0, key: K0, viewport, colorScheme, init: { fn: (s) => localStorage.setItem('tacit-lite-activity-v1', s), arg: JSON.stringify(live) } });
      await serveStatus(v.ctx, { 'j-live': { status: 'proving' }, 'j-mint': { status: 'settled', txHash: H('f6') } });
      await v.page.goto(v.url);
      await v.page.waitForSelector('.tile');
      await shot(v.page, `activity-home-${tag}`);
      await openActivity(v.page);
      await sleep(800);
      await shot(v.page, `activity-${tag}`);
      await v.browser.close();
    }
  }
});

// Two relayed actions at once, each its own receipt. The page's pool module is the real one, with three cETH notes added
// to what the key's scan finds and its relayed calls stood in for: each names its job to the caller (as the relay
// client does), announces it, and waits for the test to let the relay finish it. A send needing a split goes back to
// the relay on its own, a withdrawal starts meanwhile on another note, and neither reaches for the other's notes.
await step('receipts', async () => {
  const served = {};
  const r = await openPage({ account: A0, key: K0, viewport: { width: 390, height: 900 } });
  await serveStatus(r.ctx, served);
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const ETH = String(ux.assetByTicker.cETH.assetId).toLowerCase();
      let seq = 0;
      const note = (value) => { const i = ++seq; return { asset: ETH, value: String(value), leaf: '0x' + (0xabc000 + i).toString(16).padStart(64, '0'), leafIndex: 800000 + i, cx: '0x' + String(i).padStart(64, '0'), cy: '0x01', owner: '0x02', root: '0x' + '1'.padStart(64, '0'), path: [] }; };
      const TAC = String(ux.assetByTicker.cTAC.assetId).toLowerCase(), tacNote = (value) => ({ ...note(value), asset: TAC });
      const S = window.__rx = { notes: [note(30000000n), note(20000000n), note(5000000n), tacNote(500000000n), tacNote(300000000n)], calls: [], gates: {}, spent: new Set() };
      ux.balance = async (priv) => {
        const b = await balance(priv), add = S.notes.filter((n) => !S.spent.has(n.leaf));
        b.notes = [...b.notes, ...add];
        for (const n of add) {
          const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] };
          g.notes = [...(g.notes || []), n]; g.value = g.notes.reduce((a, x) => a + BigInt(x.value), 0n);
        }
        return b;
      };
      ux.quoteOpFee = async () => '100000';
      const fire = (d) => dispatchEvent(new CustomEvent('tacit:job', { detail: { txHash: null, error: null, at: Date.now(), ...d } }));
      const job = async (type, waitOpts, spend, make) => {
        const jobId = 'rx-' + type + '-' + (spend[0]?.leaf || '').slice(-6);
        S.calls.push({ jobId, type, spend: spend.map((n) => n.leaf) });
        waitOpts?.onJob?.(jobId, type);
        fire({ jobId, type, status: 'pending' });
        const out = await new Promise((res) => { S.gates[jobId] = res; });
        if (out === 'fail') { fire({ jobId, type, status: 'failed', error: 'the pool refused it in this check' }); throw new Error('settle failed: the pool refused it in this check'); }
        fire({ jobId, type, status: 'proving' });
        for (const n of spend) S.spent.add(n.leaf);
        for (const v of make) S.notes.push(note(v));
        const txHash = '0x' + String(S.calls.length).padStart(64, 'e');
        fire({ jobId, type, status: 'settled', txHash });
        return { jobId, status: 'settled', txHash };
      };
      ux.transfer = ({ notes, amount, fee, waitOpts }) => job('transfer', waitOpts, notes, [BigInt(amount), notes.reduce((a, n) => a + BigInt(n.value), 0n) - BigInt(amount) - BigInt(fee)].filter((v) => v > 0n));
      ux.stealthSend = async ({ notes, amount, waitOpts }) => {
        if (notes.length !== 1 || BigInt(notes[0].value) !== BigInt(amount)) throw new Error('stealthSend in this check takes one note of the exact amount');
        return { ...(await job('stealthlock', waitOpts, notes, [])), memoCheck: { ok: true } };
      };
      ux.sendUnwrap = async ({ note: n, amount, waitOpts }) => job('sendunwrap', waitOpts, [n], [BigInt(n.value) - BigInt(amount)].filter((v) => v > 0n));
      ux.unwrap = async ({ note: n, waitOpts }) => job('unwrap', waitOpts, [n], []);
      return ux;
    }` }));
  const rx = () => r.page.evaluate(() => ({ calls: window.__rx?.calls || [], notes: (window.__rx?.notes || []).map((n) => [n.leaf, n.value]) }));
  const open = (id, out = 'ok') => r.page.evaluate(([i, o]) => window.__rx.gates[i](o), [id, out]);
  const toastHas = (re, ms = 20000) => until(r.page, (s) => new RegExp(s).test(document.querySelector('#toast-container')?.textContent || ''), re.source, ms).then(() => true, () => false);
  const row = async (re) => (await actRows(r.page)).find((x) => re.test(x.text)) || { text: '', links: [], now: '', bad: '', id: '' };
  const sub = async (m) => { await r.page.click(`[data-v1="${m}"]`); await until(r.page, (x) => document.querySelector(`[data-v1="${x}"]`)?.getAttribute('aria-selected') === 'true', m); };
  const toV1 = async () => { await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close())); await r.page.evaluate(() => { location.hash = ''; location.hash = '#private'; }); await r.page.waitForSelector('#sheet-eth[open]'); };
  const REC = tacit1('d1'.padEnd(64, '7'));
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('.tile');
    await pasteKey(r.page, 'e1'.padEnd(64, '5'));
    await toV1();
    await sub('send');
    await until(r.page, () => /Private 0\.55 tETH/.test(document.querySelector('#s-max')?.textContent || ''), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | form: ${(await text(r.page, '#v1-form')).replace(/\s+/g, ' ').slice(0, 200)} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(true, 'receipts: three private notes, 0.55 tETH, to spend');

    // A: 0.1 privately. No note is exactly that, so the relay first splits the 0.2 note; the sheet is handed back then.
    await r.page.fill('#s-to', REC);
    await r.page.fill('#s-amt', '0.1');
    await until(r.page, () => /They get about/.test(document.querySelector('#s-rcpt')?.textContent || '') && !document.querySelector('#s-go').disabled, null, 60000);
    await r.page.click('#s-go');
    await until(r.page, () => /Sent to the relay/.test(document.querySelector('#v1-status')?.textContent || ''), null, 60000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    const a0 = await rx();
    ok(a0.calls.length === 1 && a0.calls[0].type === 'transfer' && a0.calls[0].spend[0] === a0.notes[1][0], `receipts: the send splits the 0.2 note first (${JSON.stringify(a0.calls)})`);
    ok(await r.page.$eval('#s-amt', (i) => i.value === '') && await r.page.$eval('#s-go', (b) => b.disabled), 'receipts: the sheet comes back with an empty form as soon as the relay has the split');
    ok(/Private 0\.35 tETH · 0\.2 tETH in use/.test(await text(r.page, '#s-max')), `receipts: the note it spends is shown as in use (${await text(r.page, '#s-max')})`);
    await openActivity(r.page);
    const opA = await row(/Send 0\.1 tETH privately/);
    ok(opA.id.startsWith('op:') && /Split a note/.test(opA.text) && opA.now === 'Split a note', `receipts: one receipt for the send, at its split step (${opA.text.slice(0, 120)})`);
    ok((await actRows(r.page)).length === 1, 'receipts: the split is a step of the send, not a receipt of its own');

    // B, meanwhile: withdraw 0.25. The 0.3 note covers it without a split; it is not the note the send is splitting.
    await toV1();
    await sub('out');
    await r.page.fill('#o-to', '0x000000000000000000000000000000000000dEaD');
    await r.page.fill('#o-amt', '0.25');
    await until(r.page, () => /Arrives/.test(document.querySelector('#o-rcpt')?.textContent || '') && !document.querySelector('#o-go').disabled, null, 60000);
    await r.page.click('#o-go');
    await until(r.page, () => /Withdraw 0\.25 ETH[^]*with the relay/.test(document.querySelector('#v1-status')?.textContent || ''), null, 60000);
    const b0 = await rx();
    ok(b0.calls.length === 2 && b0.calls[1].type === 'sendunwrap' && b0.calls[1].spend[0] === b0.notes[0][0], `receipts: the withdrawal starts at once, on the 0.3 note (${JSON.stringify(b0.calls[1])})`);
    // C: what is left free (0.05) cannot cover 0.1, and the form says so.
    await r.page.fill('#o-amt', '0.1');
    await until(r.page, () => /More than your private balance/.test(document.querySelector('#o-rcpt')?.textContent || ''), null, 30000);
    ok(await r.page.$eval('#o-go', (b) => b.disabled) && /Private 0\.05 tETH · 0\.5 tETH in use/.test(await text(r.page, '#o-max')), `receipts: notes two actions are spending are not offered to a third (${await text(r.page, '#o-max')})`);

    // The withdrawal has now been in line for a while (the offer comes after 90 seconds): the dashboard offers it from the
    // Tacit account, in plain words that say nothing of the relay's wallet, and so does its receipt in Activity.
    const nudged = await until(r.page, () => /Withdraw 0\.25 ETH to .* has been in line for a few minutes\. You can send it now from your Tacit account, with no relay fee\./.test(document.querySelector('#dash-due')?.textContent || ''), null, 150000).then(() => true, () => false);
    ok(nudged, `receipts: a withdrawal in line a few minutes is offered from the Tacit account on the dashboard (${(await text(r.page, '#dash-due')).replace(/\s+/g, ' ').slice(0, 140)})`);
    await r.page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); });
    await r.page.click('#act'); await r.page.waitForSelector('#sheet-act[open]');
    const offer = await until(r.page, () => /Send it from your Tacit account\s+instead/.test(document.querySelector('#act-body')?.textContent || ''), null, 30000).then(() => true, () => false);
    ok(offer && !/gas|top/i.test((await text(r.page, '#act-body')).replace(/network fee|no relay fee|pays the network/gi, '')), 'receipts: and so is its receipt in Activity, with no word about the relay running short');
    await r.page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); });
    await r.page.evaluate(() => { location.hash = '#private'; });

    // The split settles: the send takes the new 0.1 note and queues its lock, with no one pressing anything.
    await open(a0.calls[0].jobId);
    await until(r.page, () => (window.__rx?.calls || []).length === 3, null, 90000).catch(() => {});
    const a1 = await rx(), made = a1.notes.find(([, v]) => v === '10000000');
    ok(a1.calls[2]?.type === 'stealthlock' && made && a1.calls[2].spend[0] === made[0], `receipts: after the split, the send locks the new 0.1 note on its own (${JSON.stringify(a1.calls[2] || null)})`);
    await openActivity(r.page);
    await until(r.page, () => /Queued/.test([...document.querySelectorAll('#act-body .actr')].find((li) => /Send 0\.1/.test(li.textContent))?.querySelector('.stp .now')?.textContent || ''), null, 30000).catch(() => {});
    const opA2 = await row(/Send 0\.1 tETH privately/);
    ok(opA2.now === 'Queued' && /Split a note/.test(opA2.text), `receipts: its receipt shows the split done and the send queued (${opA2.text.slice(0, 120)})`);

    // Outcomes: the send settles (toasted, one receipt, linked); the withdrawal fails (toasted with its reason).
    await open(a1.calls[2].jobId);
    ok(await toastHas(/Send 0\.1 tETH privately to [^:]+: done/), 'receipts: the send is toasted done');
    await open(b0.calls[1].jobId, 'fail');
    ok(await toastHas(/Withdraw 0\.25 ETH[^]*did not go through/), 'receipts: the failed withdrawal is toasted with its reason');
    await openActivity(r.page);
    await sleep(500);
    const [sA, sB] = [await row(/Send 0\.1 tETH privately/), await row(/Withdraw 0\.25 ETH/)];
    ok(/Done in/.test(sA.text) && sA.links.some((l) => /etherscan\.io\/tx\/0x0*3e/.test(l) || /etherscan\.io\/tx\//.test(l)), `receipts: the send's receipt reads done, with its transaction (${sA.text.slice(0, 90)})`);
    ok(sB.bad === 'Failed' && /refused it in this check/.test(sB.text), `receipts: the withdrawal's receipt reads failed, with the relay's reason (${sB.text.slice(0, 90)})`);
    // The failed withdrawal's note is free again once a scan shows it unspent.
    await toV1();
    await sub('out');
    await until(r.page, () => /Private 0\.(4|3)\d* tETH/.test(document.querySelector('#o-max')?.textContent || '') && !/in use/.test(document.querySelector('#o-max')?.textContent || ''), null, 60000).catch(() => {});
    ok(!/in use/.test(await text(r.page, '#o-max')), `receipts: nothing is held once both are over (${await text(r.page, '#o-max')})`);

    // D: a send of the 0.05 note exactly, and the page reloaded while the relay still has it: its receipt carries on.
    await sub('send');
    await r.page.fill('#s-to', REC);
    await r.page.fill('#s-amt', '0.05');
    await until(r.page, () => /They get about/.test(document.querySelector('#s-rcpt')?.textContent || '') && !document.querySelector('#s-go').disabled, null, 60000);
    await r.page.click('#s-go');
    await until(r.page, () => (window.__rx?.calls || []).length === 4, null, 60000);
    const d0 = await rx();
    ok(d0.calls[3].type === 'stealthlock', 'receipts: a note of the exact amount is locked with no split');
    await sleep(600);
    served[d0.calls[3].jobId] = { type: 'stealthlock', status: 'proving' };
    await r.page.reload();
    await r.page.waitForSelector('.tile');
    await openActivity(r.page);
    const dRow = await row(/Send 0\.05 tETH privately/);
    ok(dRow.id.startsWith('op:') && !/Done/.test(dRow.bad) && ['Queued', 'Proving'].includes(dRow.now), `receipts: after a reload the receipt is still there, in progress (${dRow.text.slice(0, 90)})`);
    served[d0.calls[3].jobId] = { type: 'stealthlock', status: 'settled', txHash: '0x' + 'd'.repeat(64) };
    await until(r.page, () => /Done in/.test([...document.querySelectorAll('#act-body .actr')].find((li) => /Send 0\.05/.test(li.textContent))?.textContent || ''), null, 60000).catch(() => {});
    ok(/Done in/.test((await row(/Send 0\.05 tETH privately/)).text), 'receipts: and it reads done once the relay settles it');
    await shot(r.page, 'receipts-phone');

    // E: private TAC made public, one relayed unwrap per note, each its own receipt. Both notes are taken when pressed,
    // so the offer goes away at once, and the second is queued after the first settles, with nothing pressed.
    await pasteKey(r.page, 'e1'.padEnd(64, '5'));                             // a pasted key does not outlive a reload
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#tac-pub', { timeout: 240000 });
    ok(/8(\.0+)? TAC is in private notes/.test(await text(r.page, '#tac-bal')), `receipts: 8 private TAC is offered to make public (${(await text(r.page, '#tac-bal')).replace(/\s+/g, ' ').slice(-120)})`);
    const before = (await rx()).calls.length;
    await r.page.click('#tac-pub');
    await until(r.page, () => /each goes on by itself/.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 60000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#tac-bal-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    const e0 = await rx(), first = e0.calls.at(-1);
    ok(e0.calls.length === before + 1 && first.type === 'unwrap' && !(await r.page.$('#tac-pub')), 'receipts: the first unwrap is queued, the sheet is handed back, and the notes are no longer offered');
    // The first fails; the second still goes to the relay on its own.
    await open(first.jobId, 'fail');
    ok(await toastHas(/Make 5 TAC public did not go through/), 'receipts: the failed unwrap is toasted');
    await until(r.page, (n) => (window.__rx?.calls || []).length === n, before + 2, 60000).catch(() => {});
    const e1 = await rx(), second = e1.calls.at(-1);
    ok(e1.calls.length === before + 2 && second.type === 'unwrap' && second.spend[0] !== first.spend[0], 'receipts: the second note goes to the relay on its own after the first failed');
    await open(second.jobId);
    // The failed note is offered again once a scan shows it unspent; sent again, it is the same job, a new attempt.
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await until(r.page, () => /5(\.0+)? TAC is in private notes/.test(document.querySelector('#tac-bal')?.textContent || ''), null, 60000).catch(() => {});
    ok(/5(\.0+)? TAC is in private notes/.test(await text(r.page, '#tac-bal')), `receipts: the note whose unwrap failed is offered again (${(await text(r.page, '#tac-bal')).replace(/\s+/g, ' ').slice(-110)})`);
    await r.page.click('#tac-pub');
    await until(r.page, (n) => (window.__rx?.calls || []).length === n, before + 3, 60000).catch(() => {});
    const e2 = await rx(), again = e2.calls.at(-1);
    ok(again?.jobId === first.jobId, `receipts: sent again, it is the same job at the relay (${again?.jobId} = ${first.jobId})`);
    await open(again.jobId);
    ok(await toastHas(/Make 5 TAC public: done/), 'receipts: the new attempt is toasted done');
    await openActivity(r.page);
    await sleep(500);
    const outs = (await actRows(r.page)).filter((x) => /Make \d TAC public/.test(x.text));
    const five = outs.filter((x) => /Make 5 TAC public/.test(x.text));
    ok(outs.length === 3 && five.some((x) => x.bad === 'Failed') && five.some((x) => /Done in/.test(x.text)) && outs.some((x) => /Make 3 TAC public/.test(x.text) && /Done in/.test(x.text)),
      `receipts: each attempt keeps its own receipt: the failed one, the retry done, the other note done (${outs.map((x) => x.text.slice(0, 36)).join(' | ')})`);
    if (r.errors.length) { fails++; console.log('FAIL receipts page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The stats page reads the chains, two explorers and the relay's status. Logs and the explorers' transaction lists answer
// here from fixtures (a known set of deposits, settles, attestations, bonds, loans, claims and device-pool moves); the
// contract reads come from the fork. Every figure the fixtures decide is checked, then how little each later visit asks:
// nothing within a quarter hour, only what is new on a fresh read, and nothing at all when the API has a shared reading.
await step('stats', async () => {
  const lc = (x) => String(x || '').toLowerCase();
  const w = (v) => (BigInt(v) < 0n ? (1n << 256n) + BigInt(v) : BigInt(v)).toString(16).padStart(64, '0');
  const h = (n) => '0x' + n.toString(16);
  const T = Math.floor(Date.now() / 1000) - 3 * 86400;
  const TOPIC = {
    wrap: '0xf5d1711d21af6f42622ab6237626933cefc42cc9f0663d81b7c4c7bc5ce99e44', leaves: '0x7783fb256f5b4e1d4d8b79583488756286326ae15d9997d4098ce5432ed2708b',
    spent: '0x576d91547505afce99e7ebe2baf1a0948b5915598105a55f40ba72fea86e875e', asset: '0x2dcb7e1d588ab99cccaa0e9a2f69798e1e9ca87a30856228f895c2f6b34a905b',
    posted: '0x0c008a699968f2a24063b7eb14d9239b2430c502fda280245345c78cbc47b7c1', cdpMinted: '0x232c7d098ca44092999087e6ee530a2171f95f9ecb1caa363f6dcf448fb7dd57',
    cdpClosed: '0xc0ede5b75ee32986e50a2a39fa32dbf5e8eff1c91a46cd127591edebd91b4db9', claimed: '0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026',
    transact: '0xdf0ed29e998ac2f2ff0f0516cb9c1b95af189e00d55af3764b95bdd2a835e53a',
  };
  const POOLA = '0x000000000ed1eabd231be41d93b719056f7febfc', ENGINE = '0x000000003f608bddf0ca45934003ffb9dbdf70db', AIR = '0x4b4cb98d0c836c2783ac46f0078b904dab533ae8';
  const EVMP = '0x000000c2a20657ce25f2ba99737933d031afbee9', TIP = '0x000000d218b03db5837943b0b05dea2965ae956e', ROUTER = '0x000000005da3e3b73726af3c774deeb9472d4992';
  const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TACID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', USDC = '0x' + 'c5'.repeat(32), USDT = '0x' + 'c6'.repeat(32);
  const tx = (c) => '0x' + c.repeat(64 / c.length);
  let li = 0;
  const log = (address, topics, data, txh, t, block = 26000000 + li) => ({ address, topics, data: '0x' + data, blockNumber: h(block), timeStamp: h(t), blockTimestamp: h(t), transactionHash: txh, logIndex: h(li++) });
  const str = (s) => { const b = Buffer.from(s); return w(b.length) + b.toString('hex').padEnd(64, '0'); };
  // Real locks, read from the fork's pool and engine: one since unlocked on Bitcoin, one still locked (both minted on), and
  // one bonded in the fixtures only, which the pool never recorded.
  const OUTPOINTS = ['0x552c481efffbf72bf5b510bdf4ba49a0f2b41490e1b6cd5c8ac404ca6739eb74', '0xd43d367f46953e71789582054fb46e22ae428008b544eeadc11eebe10db6d7f1', '0x' + 'b1'.repeat(32)];
  const W1 = '0x' + '1a'.repeat(20), W2 = '0x' + '2b'.repeat(20), CL1 = '0x' + '3c'.repeat(20), CL2 = '0x' + '4d'.repeat(20);
  const poolLogs = [
    log(POOLA, [TOPIC.asset, USDC, '0x' + '00'.repeat(12) + 'a0'.repeat(20)], w(1) + w(0x80) + w(0xc0) + w(6) + str('USD Coin') + str('USDC'), tx('e0'), T),
    log(POOLA, [TOPIC.wrap, tx('d1'), CETH], w(10n ** 18n), tx('a1'), T),
    log(POOLA, [TOPIC.wrap, tx('d2'), CETH], w(5n * 10n ** 17n), tx('a2'), T + 86400),
    log(POOLA, [TOPIC.wrap, tx('d3'), TACID], w(100n * 10n ** 18n), tx('a3'), T + 86400),
    log(POOLA, [TOPIC.wrap, tx('d4'), USDC], w(2500000), tx('a4'), T + 86400),
    // Registered with no symbol: the page names it from its token (the real USDT contract on the fork).
    log(POOLA, [TOPIC.asset, USDT, '0x' + '00'.repeat(12) + 'dac17f958d2ee523a2206206994597c13d831ec7'], w(1) + w(0x80) + w(0xc0) + w(6) + str('Tether') + str(''), tx('e1'), T),
    log(POOLA, [TOPIC.wrap, tx('d5'), USDT], w(4630000), tx('a5'), T + 86400),
    log(POOLA, [TOPIC.leaves, w(150)], w(0x40) + w(0xa0) + w(2) + tx('f1').slice(2) + tx('f2').slice(2) + w(0), tx('b1'), T + 86400),
    log(POOLA, [TOPIC.spent], w(0x20) + w(1) + tx('91').slice(2), tx('b1'), T + 86400),
    log(POOLA, [TOPIC.leaves, w(152)], w(0x40) + w(0x80) + w(1) + tx('f3').slice(2) + w(0), tx('b2'), T + 2 * 86400),
    log(POOLA, [TOPIC.spent], w(0x20) + w(2) + tx('92').slice(2) + tx('93').slice(2), tx('b3'), T + 2 * 86400),
  ];
  const engineLogs = [
    ...OUTPOINTS.map((o, i) => log(ENGINE, [TOPIC.posted, o, '0x' + '00'.repeat(12) + '5e'.repeat(20)], w(10n ** 15n), tx('7' + i), T)),
    log(ENGINE, [TOPIC.cdpMinted, tx('81')], w(200000000) + w(0), tx('82'), T), log(ENGINE, [TOPIC.cdpMinted, tx('83')], w(150000000) + w(0), tx('84'), T + 86400),
    log(ENGINE, [TOPIC.cdpClosed, tx('85')], w(100000000), tx('86'), T + 2 * 86400),
  ];
  const addr32 = (a) => '0x' + '00'.repeat(12) + a.slice(2);
  const airLogs = [[CL1, 10], [CL1, 20], [CL2, 30]].map(([a, v], i) => log(AIR, [TOPIC.claimed, w(i), addr32(a)], w(BigInt(v) * 10n ** 18n), tx('c' + i), T));
  const transact = (v, i, t, fee = 0n, block) => log(EVMP, [TOPIC.transact, tx('e' + i), tx('e' + (i + 5))], [w(0), w(0), w(0), w(0), w(0), w(v), w(0), w(fee), w(0x140), w(0x160), w(0), w(0)].join(''), tx('9' + i), t, block);
  const devLogs = [transact(3n * 10n ** 17n, 1, T), transact(-(10n ** 17n), 2, T + 86400, 10n ** 16n)];
  const rhLogs = [transact(2n * 10n ** 17n, 3, T, 0n, 74000000)];
  const MAIN = [...poolLogs, ...engineLogs, ...airLogs, ...devLogs];
  const BASE_HEAD = 51961580, RH_HEAD = 74100000;
  const inRange = (ls, q) => ls.filter((l) => [].concat(q.address).map(lc).includes(lc(l.address))
    && Number(BigInt(l.blockNumber)) >= Number(BigInt(q.fromBlock)) && (q.toBlock === 'latest' || Number(BigInt(l.blockNumber)) <= Number(BigInt(q.toBlock))));
  const TXS = {
    [POOLA]: [
      { hash: tx('a2'), from: W2, to: POOLA, blockNumber: '26000001', timeStamp: String(T + 86400), isError: '0', methodId: '0x8be3ad21', value: '500000000000000000' },
      { hash: tx('c1'), from: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', to: POOLA, blockNumber: '26000002', timeStamp: String(T + 86400), isError: '0', methodId: '0x0b36171c', value: '0' },
      { hash: tx('c2'), from: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', to: POOLA, blockNumber: '26000003', timeStamp: String(T + 2 * 86400), isError: '0', methodId: '0x0b36171c', value: '0' },
      { hash: tx('c3'), from: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', to: POOLA, blockNumber: '26000004', timeStamp: String(T + 2 * 86400), isError: '1', methodId: '0x0b36171c', value: '0' },
    ],
  };
  // A deposit through the router, its delegatecall frame (which moves nothing), ETH in from a public swap (no deposit), and
  // one withdrawal out.
  const INTERNAL = [
    { transactionHash: tx('a1'), index: '0', from: ROUTER, to: POOLA, value: '1000000000000000000', callType: 'call', isError: '0', timeStamp: String(T), blockNumber: '26000000' },
    { transactionHash: tx('a1'), index: '1', from: POOLA, to: '0x141e653de94438258fdab245896c189f56522554', value: '1000000000000000000', callType: 'delegatecall', isError: '0', timeStamp: String(T), blockNumber: '26000000' },
    { transactionHash: tx('a6'), index: '0', from: '0x00000000e36c7ec997cc59dcda9e03673b448119', to: POOLA, value: '300000000000000000', callType: 'call', isError: '0', timeStamp: String(T + 86400), blockNumber: '26000002' },
    { transactionHash: tx('b2'), index: '1', from: POOLA, to: W1, value: '200000000000000000', callType: 'call', isError: '0', timeStamp: String(T + 2 * 86400), blockNumber: '26000005' },
  ];
  // The engine's outstanding debt, pinned for the scenario to match the fixtures' loans (2 + 1.5 borrowed, 1 repaid).
  const CUSD_SLOT = '0x' + word(19), cusdWas = await rpc('eth_getStorageAt', [ENGINE, CUSD_SLOT, 'latest']);
  await rpc('anvil_setStorageAt', [ENGINE, CUSD_SLOT, '0x' + word(250000000)]);
  const r = await openPage({ account: A0, key: K0, viewport: { width: 1280, height: 1100 } });
  const hits = [], logReads = [];
  // Who sent each deposit comes from the chain in one batch, and the logs from one request: the fixtures answer both
  // here, and every other read goes on to the fork.
  const SENDERS = { [tx('a1')]: W1, [tx('a2')]: W2 };
  for (const host of RPC_HOSTS) await r.ctx.route(`https://${host}/**`, (route) => {
    const b = JSON.parse(route.request().postData() || 'null');
    if (b && !Array.isArray(b) && b.method === 'eth_getLogs') { logReads.push(host); return json(route, { jsonrpc: '2.0', id: b.id, result: inRange(MAIN, b.params[0]) }); }
    if (!Array.isArray(b) || !b.length || !b.every((x) => x.method === 'eth_getTransactionByHash')) return route.fallback();
    return json(route, b.map((x) => ({ jsonrpc: '2.0', id: x.id, result: SENDERS[x.params[0]] ? { hash: x.params[0], from: SENDERS[x.params[0]] } : null })));
  });
  // Both explorers answer from the same fixtures, each list from the block asked for.
  await r.ctx.route(/^https:\/\/((eth|base)\.blockscout\.com\/api|api\.routescan\.io\/v2\/network\/mainnet\/evm\/(1|8453)\/etherscan\/api)\?/, (route) => {
    const u = new URL(route.request().url()), q = u.searchParams, a = lc(q.get('address')), base = /base\.|\/8453\//.test(u.hostname + u.pathname);
    hits.push(u.hostname + u.pathname + u.search);
    const from = Number(q.get('startblock') || q.get('fromBlock') || 0);
    let result = [];
    if (q.get('module') === 'logs') result = base ? [] : inRange(MAIN, { address: a, fromBlock: h(from), toBlock: 'latest' });
    else if (!base) result = (q.get('action') === 'txlist' ? TXS[a] || [] : a === POOLA ? INTERNAL : []).filter((t) => Number(t.blockNumber) >= from);
    return json(route, { status: result.length ? '1' : '0', message: result.length ? 'OK' : 'No records found', result });
  });
  // Base's nodes serve short ranges only, as they do live (the first read of its device pool goes to an explorer).
  await r.ctx.route(/^https:\/\/(mainnet\.base\.org|base-rpc\.publicnode\.com|rpc\.mainnet\.chain\.robinhood\.com)\/?/, (route) => {
    const b = JSON.parse(route.request().postData() || '{}'), url = route.request().url(), base = /base/.test(url);
    const reply = (result) => json(route, { jsonrpc: '2.0', id: b.id, result });
    if (b.method === 'eth_blockNumber') return reply(h(base ? BASE_HEAD : RH_HEAD));
    if (b.method === 'eth_getBalance') return reply(base ? h(5n * 10n ** 17n) : h(2n * 10n ** 17n));
    if (b.method !== 'eth_getLogs') return reply('0x0');
    const q = b.params[0], span = Number(BigInt(q.toBlock)) - Number(BigInt(q.fromBlock)) + 1;
    if (base && span > 2000) return json(route, { jsonrpc: '2.0', id: b.id, error: { code: -32000, message: /publicnode/.test(url) ? 'Archive requests require a personal token' : 'eth_getLogs is limited to a 2,000 range' } });
    return reply(base ? [] : inRange(rhLogs, q));
  });
  let snapshot = null;
  await r.ctx.route(/^https:\/\/api\.tacit\.finance\/stats/, (route) => (snapshot ? route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: snapshot }) : route.fulfill({ status: 404, body: '' })));
  await r.ctx.route(/^https:\/\/api\.tacit\.finance\/reflection\/status/, (route) => json(route, { attestedHeight: 969159, tipHeight: 969159, foldedCrossoutCount: 5, consumedCount: 2, bridgeBurns: 27, liveNotes: 1234 }));
  await r.ctx.route(/^https:\/\/api\.tacit\.finance\/leaderboard/, (route) => json(route, [{ address: W1, points: 10 }, { address: W2, points: 20 }]));
  await r.ctx.route(/^https:\/\/(mempool\.space|blockstream\.info)\/api\/blocks\/tip\/height/, (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '969200' }));
  // A card as "key | value | context".
  const card = async (k) => (await r.page.$$eval('.card', (cs) => cs.map((c) => ['.k', '.v', '.m'].map((x) => c.querySelector(x).textContent.replace(/\s+/g, ' ').trim()).join(' | ')))).find((t) => t.startsWith(k + ' |')) || '';
  try {
    await r.page.goto(r.url + 'stats/');
    await until(r.page, () => /^As of /.test(document.querySelector('#asof')?.textContent || '') && !/updating/.test(document.querySelector('#asof')?.textContent || ''), null, 120000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | asof: ${await text(r.page, '#asof')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(!/some figures/.test(await text(r.page, '#asof')), `stats: every part read (${await text(r.page, '#asof')})`);
    const s = await card('Made private');
    ok(/^Made private \| 1\.5ETH \| 2 deposits/.test(s), `stats: ETH made private is the sum of the pool's ETH wraps (${s})`);
    ok(/^Wallets \| 2 \|/.test(await card('Wallets')), `stats: wallets are the senders of those wraps, however they reached the pool (${await card('Wallets')})`);
    ok(/^Withdrawn \| 0\.2ETH/.test(await card('Withdrawn')), `stats: withdrawn is what the pool paid out, whatever else came in (${await card('Withdrawn')})`);
    ok(await r.page.$eval('#f-eth', (f) => !f.hidden), 'stats: the ETH-over-time chart is drawn');
    const st = await card('Settles');
    ok(/^Settles \| 3 \| .*3 spent/.test(st), `stats: settles are the transactions that inserted or spent notes (${st})`);
    ok(/2 attestations/.test(await card('Proven to')), `stats: only successful attestations count (${await card('Proven to')})`);
    const cu = await card('cUSD borrowed');
    ok(/^cUSD borrowed \| 3\.5cUSD \| 2\.5 open on 1 loan · 1 repaid/.test(cu), `stats: cUSD borrowed, repaid and still out (${cu})`);
    const ad = await card('Airdrop claimed');
    ok(/^Airdrop claimed \| 60TAC \| 2 wallets/.test(ad), `stats: airdrop claims summed, claimers counted once (${ad})`);
    ok(/^TAC made private \| 100TAC \| 1 deposit/.test(await card('TAC made private')), `stats: TAC made private (${await card('TAC made private')})`);
    ok(/USDC 2\.5/.test(await card('Others made private')) && /USDT 4\.63/.test(await card('Others made private')), `stats: other assets are named from the pool's registry, or their token (${await card('Others made private')})`);
    ok(await r.page.evaluate(() => [...document.querySelectorAll('.card .m a')].some((a) => /etherscan\.io\/token\/0xA1313eb9f3A445606D9583bcAc3ebeB56a858279#balances$/.test(a.href))), 'stats: TAC links to its ERC-20 holders on Etherscan');
    const pa = await card('Participants'), pp = await card('Points'), ta = await card('TAC allocated');
    ok(/^Participants \| 2 \|/.test(pa) && /^Points \| 30 \|/.test(pp) && /^TAC allocated \| [\d,]+TAC/.test(ta), `stats: points participants and totals from the leaderboard, TAC allocated from the distributor (${pa} | ${pp} | ${ta})`);
    const ac = await card('Cross-chain');
    ok(/\(5 folded\)/.test(ac) && /\d+ spent on Ethereum/.test(ac) && /27 bridged in/.test(ac), `stats: moves out to Bitcoin with the reflection's folded count, Bitcoin notes spent on Ethereum, and the bridges in the reflection has recorded (${ac})`);
    const nums = { toBtc: Number((ac.match(/(\d+) to Bitcoin/) || [])[1]), spent: Number((ac.match(/(\d+) spent on Ethereum/) || [])[1]), total: Number(((ac.match(/^Cross-chain \| ([\d,]+)/) || [])[1] || '').replace(/,/g, '')) };
    ok(Number.isFinite(nums.total) && nums.total === nums.toBtc + nums.spent + 27, `stats: the total counts all three kinds of move (${ac})`);
    const bl = await card('BTC locked'), bh = await card('Bonds');
    const cm = await card('cBTC minted');
    ok(/^BTC locked \| 0\.000007BTC \| 1 lock · 1 unlocked$/.test(bl) && /^cBTC minted \| 0\.000027cBTC \| 2 mints/.test(cm) && /on 2 locks$/.test(bh),
      `stats: BTC locked leaves out a lock since spent, cBTC minted counts every mint, bonds count the locks that hold one (${bl} | ${cm} | ${bh})`);
    const rows = await r.page.$$eval('#c-dev tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim())));
    const row = Object.fromEntries(rows.map((c) => [c[0].replace(/ ↗$/, '').replace(/ device pool$/, ''), c]));
    ok(row.Ethereum?.[2] === '0.3 (1)' && row.Ethereum?.[3] === '0.11 (1)' && row.Ethereum?.[4] === '2' && row.Base?.[1] === '0.5' && row.Base?.[2] === '0 (0)'
      && row.Robinhood?.[1] === '0.2' && row.Robinhood?.[2] === '0.2 (1)', `stats: device pools per chain, deposits and withdrawals (with the relayer's fee) from their Transact events (${JSON.stringify(rows)})`);
    await shot(r.page, 'stats-desk');
    await r.page.setViewportSize({ width: 390, height: 900 });
    await r.page.emulateMedia({ colorScheme: 'dark' });
    await sleep(300);
    ok(await r.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'stats: nothing runs off the side of a phone screen');
    await shot(r.page, 'stats-phone-dark');
    await r.page.setViewportSize({ width: 1280, height: 1100 });
    await r.page.emulateMedia({ colorScheme: 'light' });
    const n = hits.length, nLogs = logReads.length;
    ok(n <= 3 && hits.every((q) => /txlist|base\.blockscout|\/8453\//.test(q)), `stats: a first reading asks the explorers only for the pool's two transaction lists and Base's first log read (${hits.join(' | ')})`);
    ok(new Set(hits.filter((q) => !/base|8453/.test(q)).map((q) => q.split('/')[0])).size === 2, 'stats: the two lists go to the two explorers in turn');
    ok(nLogs === 1, `stats: every Ethereum log in one request (${nLogs})`);
    const settled = () => until(r.page, () => /^As of /.test(document.querySelector('#asof')?.textContent || '') && !/updating/.test(document.querySelector('#asof')?.textContent || ''), null, 60000).catch(() => {});
    await r.page.reload();
    await settled();
    ok(hits.length === n && logReads.length === nLogs && /^Made private \| 1\.5ETH/.test(await card('Made private')), `stats: a second visit within the quarter hour shows the last reading and reads nothing (${hits.length - n} explorer, ${logReads.length - nLogs} log reads)`);
    await r.page.goto(r.url + 'stats/?fresh');
    await settled();
    const fresh = hits.slice(n);
    ok(fresh.length === 2 && fresh.every((q) => Number(new URLSearchParams(q.split('?')[1]).get('startblock')) > 0) && /^Made private \| 1\.5ETH \| 2 deposits/.test(await card('Made private')),
      `stats: a fresh reading reads on from what the last one kept, asking the explorers only for what is new (${fresh.join(' | ')})`);
    // The API's shared reading, when there is one, is all a visit needs.
    const kept = fromJsonText(await r.page.evaluate(() => localStorage.getItem('tacit-weld-stats-v3')));
    kept.at = Date.now(); kept.eth.inWei = { $n: String(9n * 10n ** 18n) }; delete kept.partial;
    snapshot = JSON.stringify(kept);
    await r.page.evaluate(() => localStorage.clear());
    const before = [hits.length, logReads.length];
    await r.page.goto(r.url + 'stats/');
    await settled();
    ok(/^Made private \| 9ETH/.test(await card('Made private')) && hits.length === before[0] && logReads.length === before[1],
      `stats: with the API's shared reading the page shows it and reads nothing itself (${await card('Made private')} · ${hits.length - before[0]} explorer, ${logReads.length - before[1]} log reads)`);
    if (r.errors.length) { fails++; console.log('FAIL stats page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); await rpc('anvil_setStorageAt', [ENGINE, CUSD_SLOT, '0x' + word(cusdWas)]); }
});

// The dashboard paints what the page has read. A wallet holding 5 TAC, whose last visit here saw 2, reads +3.
await step('dash', async () => {
  const W = '0xd45b000000000000000000000000000000000d45', id = `tacit-lite-dash-v1:|${W}`, t0 = Date.now() - 2 * 86400e3;
  if ((await tacOf(W)) !== 5n * 10n ** 18n) await fundTac(W, 5n * 10n ** 18n - (await tacOf(W)));
  const seed = JSON.stringify({ at: t0, v: { tac: { v: String(2n * 10n ** 18n), at: t0 } } });
  const wide = (p) => p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  for (const [tag, viewport, colorScheme] of [['phone', { width: 390, height: 1000 }, 'light'], ['phone-dark', { width: 390, height: 1000 }, 'dark'], ['desk', { width: 1280, height: 1000 }, 'light'], ['desk-dark', { width: 1280, height: 1000 }, 'dark']]) {
    const r = await openPage({ account: W, viewport, colorScheme, init: { fn: ([k, v]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, arg: [id, seed] } });
    await r.ctx.route('https://api.tacit.finance/points/**', async (route) => { await sleep(3000); await route.continue(); });     // placeholders stay a moment
    try {
      await r.page.goto(r.url);
      await r.page.waitForSelector('.tile');
      if (tag === 'phone') { const w = await wide(r.page); ok(w.sw <= w.iw, `dash: the first paint at 390px has no sideways scroll (${w.sw} ≤ ${w.iw})`); }
      await shot(r.page, `first-paint-${tag}`);
      await go(r.page, '#buy');
      await r.page.click('#buy-connect');
      await until(r.page, () => !document.querySelector('#dash').hidden, null, 30000);
      await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
      const early = await r.page.evaluate(() => document.querySelectorAll('#dash .sk').length);
      if (tag === 'phone') await shot(r.page, 'dash-loading-phone');
      await until(r.page, () => /^5( TAC)?$/.test(document.querySelector('[data-dash-open="tac"] .di-v')?.textContent.trim() || ''), null, 60000);
      await until(r.page, () => !document.querySelector('#dash .sk'), null, 60000).catch(() => {});
      const tac = await r.page.$eval('[data-dash-open="tac"]', (b) => b.textContent.replace(/\s+/g, ' ').trim()), since = await text(r.page, '#dash-since');
      if (tag === 'phone') {
        ok(early > 0, `dash: a connected wallet's dashboard shows placeholders first (${early})`);
        ok(/\+3 · /.test(tac) && /since/.test(since), `dash: 5 TAC now, against 2 at the last visit, reads +3 (${tac} | ${since})`);
        ok(!!(await r.page.$('[data-dash-open="pts"]')) && !(await r.page.$('#dash .sk')), 'dash: then every placeholder gives way to a value');
        const w = await wide(r.page);
        ok(w.sw <= w.iw, `dash: still no sideways scroll at 390px with it showing (${w.sw})`);
      }
      await shot(r.page, `dash-${tag}`);
      if (r.errors.length) { fails++; console.log(`FAIL dash ${tag} page errors: ` + r.errors.slice(0, 3).join(' | ')); }
    } finally { await r.browser.close(); }
  }
  // An opened key: its private tETH, TAC and points, tETH a placeholder while its notes are read, each opening its sheet.
  const k = await openPage({ account: A0, key: K0, viewport: { width: 390, height: 1000 } });
  try {
    await k.page.goto(k.url);
    await pasteKey(k.page, 'da5b'.padEnd(64, '8'));
    await k.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await until(k.page, () => !document.querySelector('#dash').hidden, null, 30000);
    const cells = await k.page.$$eval('#dash .di', (b) => b.map((x) => x.dataset.dashOpen));
    ok(['private', 'tac', 'pts'].every((c) => cells.includes(c)) && !!(await k.page.$('#dash [data-dash-open="private"] .sk')), `dash: an opened key shows tETH, TAC and points, tETH as a placeholder while its notes are read (${cells.join(', ')})`);
    await shot(k.page, 'dash-key-phone');
    await k.page.click('#dash [data-dash-open="private"]');
    await k.page.waitForSelector('#sheet-eth[open]', { timeout: 15000 });
    ok(true, 'dash: an item opens its sheet');
    if (k.errors.length) { fails++; console.log('FAIL dash key page errors: ' + k.errors.slice(0, 3).join(' | ')); }
  } finally { await k.browser.close(); }
});

// A 20 TAC deposit made the way tacit.finance makes one (a router wrap with a TAC permit, from the key's Tacit account),
// whose settle never landed: weld finds it from the key, offers Finish on the TAC sheet and on the dashboard, and the
// settle it submits is the wrap rebuilt under TAC's own asset id and scale.
await step('tacdeposit', async () => {
  const hex = 'dec0de'.padEnd(64, '4'), acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 17n).toString(16)]);
  await fundTac(acct, 20n * 10n ** 18n);
  const r = await openPage({ account: A0, key: K0 });
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('.tile');
    const dep = await r.page.evaluate(async (h) => {
      const d = await import('/vendor/tacit-deps.min.js'), cd = await import('/confidential-deployments.js');
      cd.setActiveNetwork('mainnet');
      const { makeConfidentialPoolUx } = await import('/confidential-pool-ux.js');
      const ux = makeConfidentialPoolUx({ secp: d.secp, keccak256: d.keccak_256, sha256: d.sha256, network: 'mainnet' });
      const w = await ux.routerWrap({ walletPriv: d.hexToBytes(h), amountWei: (20n * 10n ** 18n).toString(), ticker: 'TAC', index: 0 });
      return { txHash: w.txHash, asset: w.wrapOp.asset, value: String(w.wrapOp.value) };
    }, hex);
    const landed = await chainUntil(async () => (await rpc('eth_getTransactionReceipt', [dep.txHash]))?.status === '0x1', 60000);
    ok(landed && dep.value === '2000000000', `tacdeposit: a 20 TAC deposit lands on the fork (${String(dep.txHash).slice(0, 12)}…, ${dep.value} units of ${dep.asset.slice(0, 10)}…)`);
    await pasteKey(r.page, hex);
    await go(r.page, '#tac');
    await r.page.waitForSelector('#tac-finish', { timeout: 1200000 });                  // once the key's notes are read
    const call = (await text(r.page, '#tac-bal .callout')).replace(/\s+/g, ' ').trim();
    ok(/^20 TAC is waiting to become private\./.test(call), `tacdeposit: the TAC sheet offers to finish it, counted once (${call})`);
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await until(r.page, () => /20 TAC is waiting/.test(document.querySelector('#dash-due')?.textContent || ''), null, 30000).catch(() => {});
    ok(/20 TAC is waiting to become private/.test(await text(r.page, '#dash-due')), 'tacdeposit: so does the dashboard');
    await shot(r.page, 'tacdeposit-dash');
    const n0 = submits.length;
    await r.page.click('#dash-due [data-dash-do="tac"]');                               // opens the TAC sheet and presses its Finish
    await until(r.page, () => /stubbed|err/i.test(document.querySelector('#tac-bal-status')?.innerHTML || ''), null, 120000).catch(() => {});
    ok(/Finishing a 20 TAC deposit did not go through: Stubbed in the fork check/.test(await text(r.page, '#tac-bal-status')), `tacdeposit: the sheet's line sums up the Finish once its settle has ended (${await text(r.page, '#tac-bal-status')})`);
    const subs = submits.slice(n0).filter((s) => s.type === 'wrap');
    ok(subs.length === 1 && String(subs[0].op?.asset).toLowerCase() === dep.asset.toLowerCase() && String(subs[0].op?.value) === dep.value,
      `tacdeposit: Finish submits one wrap, rebuilt under TAC's asset and scale (${subs.length} submitted, value ${subs[0]?.op?.value})`);
    await openActivity(r.page);
    ok(/Finish a 20 TAC deposit/.test(await text(r.page, '#act-body')), 'tacdeposit: the settle shows in Activity');
    if (r.errors.length) { fails++; console.log('FAIL tacdeposit page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The page's pool module with private notes added to the balance and, if given, the farm positions the key holds: what a
// private farm's card shows once a key has something in it. Harvest and unbond are recorded, not proved.
const FARM_CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', FARM_CTAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const FARM_WTAC_ASSET = '0x1097c9e552ae4fce2a8c416b93403953fa445a5f2cdae8ced36d9a78cfe40832', FARM_LP0 = '0x17c56713a7e4a5d679a71def3ff9fa186f1556ef757b0ee6b7a3ed8c9249ef99';
// With `chain`, the farm steps keep state, as the chain does: a harvest turns the reward into a wTAC note, and the position goes on
// earning (more than the dust a plain unbond allows, as a farm that streams every second does by the time a harvest settles);
// an unbond refuses over that dust unless told to give it up, then turns the position into a liquidity note; taking that
// out gives both assets; redeeming spends a wTAC note. Each call is recorded in window.__farmCalls.
const chainStub = () => `
    const DUST = 100000n, REWARD = ${JSON.stringify(FARM_WTAC_ASSET)}, CETH = ${JSON.stringify(FARM_CETH)}, CTAC = ${JSON.stringify(FARM_CTAC)};
    const find = (leaf) => positions.find((x) => x.receiptLeaf === leaf), slow = () => new Promise((r) => setTimeout(r, 700));
    ux.farmHarvest = async ({ position }) => {
      await slow();
      const p = find(position.receiptLeaf), units = BigInt(p.pendingUnits);
      window.__farmCalls.push('harvest:' + position.receiptLeaf);
      if (units <= 0n) throw new Error('farm-harvest: nothing to claim beyond the relay fee yet');
      add.push(note(REWARD, units));
      p.pendingUnits = String(DUST * 20n); p.pendingTac = '0.02';
      return {};
    };
    ux.farmUnbond = async ({ position, forfeitPending }) => {
      await slow();
      const p = find(position.receiptLeaf);
      window.__farmCalls.push('unbond:' + position.receiptLeaf + ':' + (forfeitPending ? 'forfeit' : 'keep'));
      if (!forfeitPending && BigInt(p.pendingUnits) > DUST) throw new Error('farm-unbond: ' + p.pendingUnits + ' reward units are still pending and would be forfeited; harvest first, or pass forfeitPending: true');
      positions.splice(positions.indexOf(p), 1);
      add.push(note(p.lpAsset, BigInt(p.shares)));
      return {};
    };
    ux.lpRemove = async ({ shareNote }) => {
      await slow();
      window.__farmCalls.push('remove:' + shareNote.value);
      add.splice(add.findIndex((n) => n.cx === shareNote.cx), 1);
      add.push(note(CETH, BigInt(shareNote.value) / 10n), note(CTAC, BigInt(shareNote.value) * 3n));
      return {};
    };
    ux.farmRedeem = async ({ note: n }) => {
      await slow();
      window.__farmCalls.push('redeem:' + n.value);
      add.splice(add.findIndex((x) => x.cx === n.cx), 1);
      return { unwrap: {}, next: [] };
    };`;
// A swap's route and the split before it, recorded in window.__swapCalls and applied to the notes. The real pools are read for the
// quote. window.__swapRefuse makes the relay refuse a relayed route, as it does when its free settles are used up.
const swapStub = () => `
    window.__swapCalls = [];
    const wait = () => new Promise((r) => setTimeout(r, 400));
    ux.route = async (a) => {
      const q = await ux.quoteRoute({ asset0: a.inNote.asset, amountIn: a.amountIn, path: a.path, fee: a.fee });
      window.__swapCalls.push({ amountIn: String(a.amountIn), noteValue: String(a.inNote.value), fee: String(a.fee), minOut: String(a.minOut), out: String(q.amountOut), path: a.path.map((h) => h.feeBps + ':' + h.assetNext), self: !!a.selfSettle });
      if (window.__swapRefuse && !a.selfSettle) throw new Error('fee below the current floor');
      await wait();
      add.splice(add.findIndex((n) => n.cx === a.inNote.cx), 1);
      add.push(note(q.assetFinal, q.amountOut));
      return { txHash: '0x' + 'ab'.repeat(32) };
    };
    ux.transfer = async ({ notes, amount }) => {
      window.__swapCalls.push({ split: String(amount) });
      await wait();
      for (const n of notes) add.splice(add.findIndex((x) => x.cx === n.cx), 1);
      const total = notes.reduce((t, n) => t + BigInt(n.value), 0n);
      add.push(note(notes[0].asset, amount));
      if (total > amount) add.push(note(notes[0].asset, total - amount));
      return {};
    };`;
const stubFarmUx = (page, { notes = [], positions = null, chain = false, swap = false }) => page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
  import * as real from '/confidential-pool-ux.js?stub=real';
  export * from '/confidential-pool-ux.js?stub=real';
  export function makeConfidentialPoolUx(o) {
    const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
    let seq = 0;
    const note = (asset, value) => { seq++; return { asset: asset[0] === '@' ? String(ux.assetByTicker[asset.slice(1)].assetId).toLowerCase() : asset, value: String(value), leafIndex: 910000 + seq, cx: '0x' + seq.toString(16).padStart(64, 'a'), cy: '0x01', owner: '0x02', root: '0x03', path: [] }; };
    const add = ${JSON.stringify(notes.map(([a, v]) => [a, String(v)]))}.map(([a, v]) => note(a, BigInt(v)));      // the chain adds and removes notes here
    window.__farmCalls = [];
    ux.balance = async (priv) => {
      const b = await balance(priv);
      b.notes = [...b.notes, ...add];
      for (const n of add) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.value = BigInt(g.value) + BigInt(n.value); g.notes = [...g.notes, n]; }
      ${positions ? 'b.farmPositions = positions.map((p) => ({ ...p }));' : ''}       // the page takes positions from the scan when it carries them
      return b;
    };
    ${swap ? swapStub() : ''}
    ${positions ? `const positions = ${JSON.stringify(positions)}; ux.farmPositions = async () => positions.map((p) => ({ ...p }));
    ${chain ? chainStub() : `ux.farmHarvest = async ({ position }) => { window.__farmCalls.push('harvest:' + position.receiptLeaf); return {}; };
    ux.farmUnbond = async ({ position }) => { window.__farmCalls.push('unbond:' + position.receiptLeaf); return {}; };`}` : ''}
    return ux;
  }` }));
const farmPos = (n, shares, units, tac) => ({ pid: 0, pair: 'TAC/cETH', lpAsset: FARM_LP0, shares: String(shares), receiptLeaf: '0x' + String(n).repeat(64), receiptIndex: n, unlockAt: 0, pendingUnits: String(units), pendingTac: tac });
// Opens a key by its pasted hex, funds its Tacit account for gas and returns the page.
async function openFarmKey(hex, stub, viewport) {
  const r = await openPage({ account: A0, key: K0, viewport });
  const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 18n).toString(16)]);
  await stubFarmUx(r.page, stub);
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="paste"]'); await r.page.fill('#ws-hex', hex); await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  return r;
}

// A private farm's card with a key that holds positions: the position leads and the farm's facts close the card, each
// position is named, unbond waits for a harvest while a real reward is unharvested, what is waiting (harvested rewards,
// liquidity not bonded) sits above the farms, and what a harvest or unbond leaves points at its next step.
await step('farmpos', async () => {
  const r = await openFarmKey('b05e'.padEnd(64, '6'), { notes: [[FARM_WTAC_ASSET, 1234560000n], [FARM_LP0, 50000000n]], positions: [farmPos(7, 150000000, 1234560000, '12.3456'), farmPos(8, 20000000, 50000, '0.0005')] });
  const p = r.page;
  try {
    await go(p, '#farm');
    await p.waitForSelector('.farm.open[data-farm="pid0"] [data-unbond]', { state: 'attached', timeout: 240000 });
    const card = (await text(p, '#farm-pid0')).replace(/\s+/g, ' ');
    ok(/Position 1/.test(card) && /Position 2/.test(card), 'farmpos: with two positions in one pool, each is named');
    ok(card.indexOf('Your position') < card.indexOf('In the pool') && /The farm/.test(card), 'farmpos: the positions lead the card and the farm\'s facts close it');
    ok(/Earned\s*12\.3456 TAC (\(≈ [\d.,]+ ETH\)|\(< 0\.00001 ETH\))?/.test(card) && /Earning\s*about [\d,.]+ TAC a day/.test(card), 'farmpos: earned reads in ETH too, and what it earns a day has its own row');
    const un = await p.$$eval('[data-unbond]', (b) => b.map((x) => x.disabled));
    ok(un[0] === true && un[1] === false, `farmpos: unbond waits for a harvest while a real reward is unharvested, and not for dust (${un})`);
    ok(/Harvest first: unbonding now would give up the 12\.3456 TAC/.test(card), 'farmpos: and says why');
    await until(p, () => /Harvested rewards/.test(document.querySelector('#farm-notes')?.textContent || ''), null, 300000);   // the notes scan is slow on a cold fork
    ok(await p.evaluate(() => { const n = document.querySelector('#farm-notes'), l = document.querySelector('#farm-list'); return !!(n.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) && /Harvested rewards/.test(n.textContent) && /not bonded/.test(n.textContent); }),
      'farmpos: harvested rewards and unbonded liquidity wait above the farms');
    ok(/Private pool/.test(await text(p, '[data-farm="pid0"] > button')) && !/Tacit pool/.test(await text(p, '#farm-list')), 'farmpos: the rows say Private pool');
    const rows = (await text(p, '#farm-list')).replace(/\s+/g, ' ');
    ok(/tETH \/ TAC/.test(rows) && !/TAC \/ tETH/.test(rows) && (rows.match(/Private pool · [\d.,]+ ETH deep|Private pool · under 0\.01 ETH deep/g) || []).length >= 3, 'farmpos: pools read tETH first, and each says how deep it is');
    ok(/In the farms\s*≈ [\d.]+ ETH · 2 positions/.test(await text(p, '#farm-notes')) && /Earning\s*about [\d.,]+ TAC a day/.test(await text(p, '#farm-notes')) && /Rewards\s*24\.69 TAC · 12\.35 harvested/.test((await text(p, '#farm-notes')).replace(/\s+/g, ' ')),
      'farmpos: a summary leads the sheet: what is in the farms, what it earns a day, and the rewards waiting in all');
    ok(/Worth\s*≈ [\d.]+ ETH · [\d.<>a-z% ]+ of the farm/.test(card), 'farmpos: each position says what it is worth and its share of the farm');
    await p.click('[data-harvest="0"]');
    await p.waitForSelector('#sf-act-0 [data-fn-go="redeem"]', { timeout: 60000 });
    ok(await p.evaluate(() => { const a = document.querySelector('#sf-act-0'), u = document.querySelector('[data-unbond="1"]'); return !!(u.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'farmpos: a harvest reports under the positions, not below the join form');
    await p.click('#sf-act-0 [data-fn-go="redeem"]');
    await until(p, () => ['fn-turn', 'fn-redeem'].includes(document.activeElement?.id), null, 10000);
    ok((await p.evaluate(() => window.__farmCalls)).some((c) => c.startsWith('harvest:')), 'farmpos: a harvest says where to turn it into TAC, and the link takes you to that button');
    if (r.errors.length) { fails++; console.log('FAIL farmpos page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
// A private farm with a key that holds tETH but no TAC: joining is a checklist (tETH done, TAC next and where to get it, the add
// last), going there leaves a way back to this farm, and taking it returns to the same card.
await step('farmsteps', async () => {
  const r = await openFarmKey('57e9'.padEnd(64, '6'), { notes: [[FARM_CETH, 2000000n]], positions: [] });
  const p = r.page;
  try {
    await go(p, '#farm');
    await p.waitForSelector('[data-farm="pid0"] > button', { timeout: 120000 });
    if (!(await p.$('.farm.open[data-farm="pid0"]'))) await p.click('[data-farm="pid0"] > button');
    await p.waitForSelector('#farm-pid0 .steps', { timeout: 300000 });
    const steps = await p.$$eval('#farm-pid0 .step', (l) => l.map((x) => [x.className.replace('step', '').trim(), x.querySelector('h3').textContent, x.querySelector('button')?.textContent || '']));
    ok(steps.length === 3 && steps[0][0] === 'done' && steps[1][0] === 'now' && steps[2][0] === '' && steps[1][2] === 'Make TAC private', `farmsteps: tETH is done, TAC is next and says where to get it, the add waits (${JSON.stringify(steps)})`);
    await p.click('#farm-pid0 [data-join-get="tac"]');
    await p.waitForSelector('#sheet-tac[open] .farm-back a', { timeout: 30000 });
    ok(!(await p.$('#sheet-farm[open]')) && (await p.getAttribute('.farm-back a', 'href')) === '#farm/private-0' && /tETH \/ TAC/.test(await text(p, '.farm-back')), 'farmsteps: it opens the TAC sheet with a way back to this farm');
    await p.click('.farm-back a');
    await p.waitForSelector('#sheet-farm[open] .farm.open[data-farm="pid0"]', { timeout: 60000 });
    await p.waitForTimeout(500);
    ok(!(await p.$('.farm-back')), 'farmsteps: back at the same farm, and the way back is gone');
    // With private tETH in hand, the missing side is one private swap away: opened on tETH for TAC, with the way back to the farm.
    ok(/Or swap some of your private tETH for TAC/.test(await text(p, '#farm-pid0 [data-join-swap]')), 'farmsteps: the missing TAC step also offers a private swap of the tETH held');
    await p.click('#farm-pid0 [data-join-swap]');
    await p.waitForSelector('#sheet-eth[open] #sw-amt', { timeout: 120000 });
    ok(!(await p.$('#sheet-farm[open]')) && await p.$eval('#sheet-eth [data-swf="eth"]', (b) => b.getAttribute('aria-selected') === 'true') && await p.$eval('#sheet-eth [data-swt="tac"]', (b) => b.getAttribute('aria-selected') === 'true')
      && (await p.getAttribute('#sheet-eth .farm-back a', 'href')) === '#farm/private-0' && await p.evaluate(() => location.hash) === '#private/swap', 'farmsteps: the swap opens as tETH for TAC, at the farm\'s own way back');
    if (r.errors.length) { fails++; console.log('FAIL farmsteps page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// Exit is one press: harvest what is worth harvesting, unbond (giving up what the position earned while the harvest settled,
// which a plain unbond refuses), take the liquidity out. The steps are named as they run, and what is left is a position gone,
// both assets as private notes, and the rewards as wTAC.
await step('farmexit', async () => {
  const r = await openFarmKey('e817'.padEnd(64, '6'), { notes: [], positions: [farmPos(7, 150000000, 1234560000, '12.3456')], chain: true });
  const p = r.page, leaf = '0x' + '7'.repeat(64);
  try {
    await go(p, '#farm');
    await p.waitForSelector('.farm.open[data-farm="pid0"] [data-exit]', { timeout: 300000 });
    const card = (await text(p, '#farm-pid0')).replace(/\s+/g, ' ');
    ok(/Exit takes everything out/.test(card) && /earns while those steps run \(about [\d.,]+ TAC a minute\) is given up/.test(card), 'farmexit: Exit says what it does and what it gives up');
    await shot(p, 'farmexit-before');
    await p.evaluate(() => { window.__seen = new Set(); setInterval(() => window.__seen.add((document.querySelector('#sf-act-0')?.textContent || '').trim()), 80); });
    await p.click('[data-exit="0"]');
    await until(p, () => /^Out\./.test(document.querySelector('#sf-act-0')?.textContent.trim() || '') || !!document.querySelector('#sf-act-0 .err'), null, 120000);
    const calls = await p.evaluate(() => window.__farmCalls), seen = await p.evaluate(() => [...window.__seen].filter(Boolean));
    ok(JSON.stringify(calls) === JSON.stringify([`harvest:${leaf}`, `unbond:${leaf}:forfeit`, 'remove:150000000']), `farmexit: harvest, then unbond giving up the little accrued since, then take the liquidity out (${calls.join(', ')})`);
    ok(seen.some((t) => /^Step 1 of 3 · .*harvest/.test(t)) && seen.some((t) => /^Step 2 of 3 · .*unbond/.test(t)) && seen.some((t) => /^Step 3 of 3 · .*liquidity out/.test(t)), `farmexit: each step names itself as it runs (${seen.map((t) => t.slice(0, 28)).join(' | ')})`);
    await shot(p, 'farmexit-after');
    await until(p, () => !document.querySelector('[data-exit]') && /Harvested rewards\s*12\.35 wTAC/.test(document.querySelector('#farm-notes')?.textContent || ''), null, 120000);
    ok(true, 'farmexit: the position is gone, and the rewards wait as wTAC notes');
    if (r.errors.length) { fails++; console.log('FAIL farmexit page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
// Claim rewards is one press too: every position with a real reward is harvested (not one holding dust), then what is harvested
// is turned into TAC. On the fork the paying account has no wTAC to withdraw, so the chain ends where it says the wTAC is not visible.
await step('farmclaim', async () => {
  const r = await openFarmKey('c1a1'.padEnd(64, '6'), { notes: [], positions: [farmPos(7, 150000000, 1234560000, '12.3456'), farmPos(8, 20000000, 50000, '0.0005')], chain: true });
  const p = r.page;
  try {
    await go(p, '#farm');
    await p.waitForSelector('#fn-redeem', { timeout: 300000 });
    ok(/Claim rewards/.test(await text(p, '#fn-redeem')) && /harvests every position that has earned, then turns all of it into TAC/.test(await text(p, '#farm-notes')), 'farmclaim: with rewards unharvested the button says Claim rewards, and what it does');
    await p.click('#fn-redeem');
    await until(p, () => /wTAC is not visible yet|Your rewards are TAC/.test(document.querySelector('#fn-status')?.textContent || ''), null, 180000);
    const calls = await p.evaluate(() => window.__farmCalls);
    ok(JSON.stringify(calls) === JSON.stringify([`harvest:0x${'7'.repeat(64)}`, 'redeem:1234560000']), `farmclaim: the position with a real reward is harvested, the one with dust is not, then the wTAC is unwrapped (${calls.join(', ')})`);
    if (r.errors.length) { fails++; console.log('FAIL farmclaim page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The Swap tab of the Tacit pool: its link, a swap of a note that is exactly the amount (one route over the whole note, the least
// it returns 1% under the quote, a relay fee), an amount no note matches (cut first), a swap between two assets that are not tETH
// (through tETH, two pools in one route), and a relay that refuses (the swap offered from the paying account, no relay fee).
await step('swap', async () => {
  const r = await openFarmKey('5a9b'.padEnd(64, '6'), { notes: [[FARM_CETH, 5000000n], [FARM_CETH, 5000000n], [FARM_CTAC, 50000000000n], ['@cUSD', 10000000000n]], swap: true });
  const p = r.page, calls = () => p.evaluate(() => window.__swapCalls);
  const typed = async (v) => { await p.fill('#sw-amt', v); await until(p, () => !document.querySelector('#sw-go').disabled || /Swap more|More than|relay fee is|no pool/i.test(document.querySelector('#sw-rcpt')?.textContent || ''), null, 600000).catch(async (e) => { console.log(`     no quote for ${v}: rcpt=${JSON.stringify((await text(p, '#sw-rcpt')).slice(0, 200))} status=${JSON.stringify((await text(p, '#v1-status')).slice(0, 160))} go.disabled=${await p.$eval('#sw-go', (b) => b.disabled).catch(() => '?')} max=${(await text(p, '#sw-max')).trim()}`); throw e; });
    console.log(`     quote for ${v}: ${(await text(p, '#sw-rcpt')).replace(/\s+/g, ' ').slice(0, 220)}${(await text(p, '#sw-ack')).trim() ? ' | gate: ' + (await text(p, '#sw-ack')).trim().slice(0, 90) : ''}`);
    // A loss gate (15% and over) waits for the tick, or the typed figure from 30%, as a person gives it.
    if (await p.$('#sw-ack input[type="checkbox"]')) await p.check('#sw-ack input[type="checkbox"]');
    else if (await p.$('#sw-ack input')) await p.fill('#sw-ack input', (await text(p, '#sw-ack b')).trim());
    await until(p, () => !document.querySelector('#sw-go').disabled, null, 60000);
  };
  // The press hands the swap to the relay and the form frees up once the scan after it has drawn the new balances (a slow fork takes minutes).
  const settled = (re) => until(p, (x) => new RegExp(x).test(document.querySelector('#sw-max')?.textContent || ''), re.source, 900000);
  const choose = async (attr, k) => { try { await until(p, () => !document.querySelector('#sheet-eth [aria-busy="true"]'), null, 400000).catch(async (e) => { console.log('     still busy:', JSON.stringify(await p.evaluate(() => ({ busy: [...document.querySelectorAll('[aria-busy="true"]')].map((b) => b.id || b.textContent.slice(0, 30)), status: document.querySelector('#v1-status')?.textContent.slice(0, 200), calls: window.__swapCalls.length, act: document.querySelector('#act-body')?.textContent.replace(/\s+/g, ' ').slice(0, 300) }))), '\n'); throw e; }); await p.click(`#sheet-eth [data-${attr}="${k}"]`, { timeout: 60000 }); await p.waitForSelector('#sw-amt', { timeout: 30000 }); } catch (e) { throw new Error(`choosing ${attr}=${k}: ${e.message.split('\n').slice(0, 8).join(' | ')}`); } };
  try {
    await p.evaluate(() => { location.hash = '#private/swap'; });
    await p.waitForSelector('#sw-amt', { timeout: 300000 });
    ok(await p.$eval('#sheet-eth [data-v1="swap"]', (b) => b.getAttribute('aria-selected') === 'true') && await p.evaluate(() => location.hash) === '#private/swap', 'swap: #private/swap opens the Swap tab, and it keeps its link');
    await until(p, () => /Private 0\.1 tETH/.test(document.querySelector('#sw-max')?.textContent || ''), null, 120000);
    ok(true, `swap: the balance of what is paid reads on the tab (${(await text(p, '#sw-max')).trim()})`);

    // A note that is exactly the amount: one route over the whole note.
    await typed('0.05');
    const quote = (await text(p, '#sw-rcpt')).replace(/\s+/g, ' ');
    ok(/You get about\s*[\d,.]+ TAC/.test(quote) && /At least\s*[\d,.]+ TAC/.test(quote) && /Relay fee\s*[\d.]+ tETH/.test(quote) && !/split a note|Through tETH/.test(quote), `swap: tETH for TAC states what it returns, the least, and the relay fee (${quote.slice(0, 150)})`);
    await shot(p, 'swap-quote');
    await p.click('#sw-go');
    await until(p, () => window.__swapCalls.length >= 1, null, 300000);
    let c = (await calls())[0];
    ok(c.amountIn === '5000000' && c.noteValue === '5000000' && c.path.length === 1 && c.path[0].endsWith(FARM_CTAC) && BigInt(c.fee) > 0n && BigInt(c.minOut) === BigInt(c.out) * 99n / 100n,
      `swap: one route over the whole note into TAC, the least 1% under the quote, a relay fee (${JSON.stringify(c)})`);
    await settled(/Private 0\.05 tETH/);
    await choose('swf', 'tac');
    await settled(/Private [\d,.]+ TAC/);
    const held = parseFloat((await text(p, '#sw-max')).replace(/[^\d.]/g, '') || '0');
    ok(held > 500, `swap: the TAC arrives as a private balance (${(await text(p, '#sw-max')).trim()})`);
    ok(!(await p.$('#sheet-eth [data-swt="tac"]')), 'swap: what is paid is not offered as what is bought');

    // No note of that size: it is cut first.
    await choose('swt', 'eth');
    await typed('100');
    ok(/Relay fee to (split a note|combine notes)/.test(await text(p, '#sw-rcpt')), 'swap: an amount no note matches shows the relay fee to cut one');
    await p.click('#sw-go');
    await until(p, () => window.__swapCalls.length >= 3, null, 900000);
    const cut = await calls();
    ok(cut[1].split === '10000000000' && cut[2].amountIn === '10000000000' && cut[2].noteValue === '10000000000' && cut[2].path[0].endsWith(FARM_CETH), `swap: the note is cut to the amount, then that note is swapped (${JSON.stringify(cut.slice(1))})`);

    // Between two assets that are not tETH: through tETH.
    await choose('swf', 'cusd');
    await choose('swt', 'tac');
    await settled(/Private 100 cUSD/);
    await typed('100');
    ok(/Through\s*tETH, two pools in one settle/.test((await text(p, '#sw-rcpt')).replace(/\s+/g, ' ')) && /You get about/.test(await text(p, '#sw-rcpt')), 'swap: cUSD for TAC says it goes through tETH');
    await p.click('#sw-go');
    await until(p, () => window.__swapCalls.length >= 4, null, 300000);
    c = (await calls())[3];
    ok(c.path.length === 2 && c.path[0].endsWith(FARM_CETH) && c.path[1].endsWith(FARM_CTAC) && c.amountIn === '10000000000', `swap: two pools in one route, tETH between (${JSON.stringify(c.path.map((x) => x.slice(0, 6) + '…' + x.slice(-4)))})`);

    // A relay that refuses: the swap is offered from the paying account, with no relay fee.
    await p.evaluate(() => { window.__swapRefuse = true; });
    await choose('swf', 'eth');
    await choose('swt', 'tac');
    await typed('0.05');
    await p.click('#sw-go');
    await p.waitForSelector('#sheet-eth [data-selfdo]', { timeout: 300000 });
    ok(/Send it from .* instead/.test(await text(p, '#v1-status')), 'swap: a refusing relay leaves the swap offered from the paying account');
    await p.click('#sheet-eth [data-selfdo]');
    await until(p, () => window.__swapCalls.some((x) => x.self), null, 300000);
    c = (await calls()).find((x) => x.self);
    ok(c.fee === '0' && c.amountIn === '5000000', `swap: sent from the paying account the route has no relay fee (${JSON.stringify(c)})`);
    if (r.errors.length) { fails++; console.log('FAIL swap page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});


// The farm sheet in each state a visitor can reach, for design review: nobody connected, a wallet with and without TAC, a
// stake with something earned and a withdrawal previewed, then the private farms with nothing to add, with notes to add, and
// with a position, a harvest and liquidity that is not bonded. Opt-in (`farmtour`), and it writes to SHOTS.
await step('farmtour', async () => {
  if (!SHOTS) throw new Error('the farm tour needs SHOTS=<dir>');
  const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', CTAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  const WTAC_ASSET = '0x1097c9e552ae4fce2a8c416b93403953fa445a5f2cdae8ced36d9a78cfe40832', LP0 = '0x17c56713a7e4a5d679a71def3ff9fa186f1556ef757b0ee6b7a3ed8c9249ef99';
  const shown = (p, sel, ms = 120000) => p.waitForSelector(sel, { timeout: ms }).catch(() => {});
  // PART=public or PART=private runs half of it (the private half scans a key's notes, which needs an archive fork); WIDTH=phone or WIDTH=desk runs one width.
  const part = process.env.PART || 'both';
  for (const [tag, viewport] of [['phone', { width: 390, height: 1700 }], ['desk', { width: 1280, height: 1500 }]].filter(([t]) => !process.env.WIDTH || t === process.env.WIDTH)) {
    if (part !== 'private') {
      const r = await openPage({ account: A0, key: K0, viewport });
      const p = r.page, snap = async (name) => { await p.waitForTimeout(1200); await p.screenshot({ path: join(SHOTS, `farm-${tag}-${name}.png`), fullPage: true }); };
      const held = await tacOf(A0);
      if (held > 0n) await rpc('eth_sendTransaction', [{ from: A0, to: TAC, data: '0xa9059cbb' + addrWord(RESERVE) + word(held) }]);
      await p.goto(r.url + '#farm');
      await p.waitForSelector('#pf-connect, [data-pfm]', { timeout: 120000 });
      await snap('1-public-signed-out');
      if (await p.$('#pf-connect')) await p.click('#pf-connect');
      await p.waitForSelector('[data-pfm="eth"]', { timeout: 120000 });
      await p.fill('#pf-amt', '0.05'); await shown(p, '#pf-rcpt:not([hidden])'); await snap('2-public-eth');
      await p.fill('#pf-amt', '2'); await shown(p, '#pf-ackv'); await snap('3-public-eth-big');
      await p.fill('#pf-amt', '');
      await p.click('[data-pfm="pair"]'); await snap('4-public-pair-no-tac');
      await p.fill('#pf-amt', '0.002');
      await until(p, () => /Not enough TAC/.test(document.querySelector('#pf-rcpt')?.textContent || ''), null, 240000).catch(() => {}); await snap('4b-public-pair-no-tac-typed');
      await fundTac(A0, 1000n * 10n ** 18n);
      await go(p, '#farm'); await until(p, () => /[1-9]/.test(document.querySelector('#pf-tmax')?.textContent || ''), null, 120000);
      await p.fill('#pf-amt', ''); await until(p, () => document.querySelector('#pf-rcpt')?.hidden, null, 60000);
      await p.click('#pf-max'); await until(p, () => !document.querySelector('#pf-go').disabled || /Not enough|refuse/.test(document.querySelector('#pf-rcpt')?.textContent || ''), null, 240000).catch(() => {});
      await snap('5-public-pair');
      await p.fill('#pf-amt', '0.02');
      await acceptLoss(p, '#pf-go', '#pf-ackv');
      await p.click('#pf-go'); await p.waitForSelector('#pf-exit', { timeout: 120000 });
      await snap('6-public-just-staked');
      await rpc('evm_increaseTime', [2 * 86400]); await rpc('evm_mine', []);
      await go(p, '#farm'); await until(p, () => { const b = document.querySelector('#pf-claim'); return b && !b.disabled; });
      await shown(p, '#pf-out-rcpt:not([hidden])'); await snap('7-public-staked');
      await p.click('[data-pfp="50"]'); await p.click('[data-pfr="eth"]'); await shown(p, '#pf-out-rcpt:not([hidden])'); await snap('8-public-withdraw-half-as-eth');
      await p.click('#pf-claim'); await until(p, () => /TAC claimed/.test(document.querySelector('#toast-container')?.textContent || ''), null, 120000).catch(() => {});
      await shown(p, '#pf-status .ok'); await snap('9-public-claimed');
      if (r.errors.length) console.log(`   ${tag} page errors: ${r.errors.slice(0, 3).join(' | ')}`);
      await r.browser.close();
    }
    if (part !== 'public') for (const variant of ['bare', 'notes', 'position']) {
      const notes = variant === 'bare' ? [] : [[FARM_CETH, 2000000n], [FARM_CTAC, 50000000000n]].concat(variant === 'position' ? [[FARM_WTAC_ASSET, 1234560000n], [FARM_LP0, 50000000n]] : []);
      const r = await openFarmKey(({ bare: 'ba7e', notes: 'f4a3e', position: 'b05e' })[variant].padEnd(64, '6'), { notes, positions: variant === 'position' ? [farmPos(7, 150000000, 1234560000, '12.3456'), farmPos(8, 20000000, 50000, '0.0005')] : null }, viewport);
      const p = r.page, snap = async (name) => { await p.waitForTimeout(1200); await p.screenshot({ path: join(SHOTS, `farm-${tag}-${name}.png`), fullPage: true }); };
      await go(p, '#farm');
      await p.waitForSelector('[data-farm="pid0"] > button', { timeout: 120000 });
      if (!(await p.$('.farm.open[data-farm="pid0"]'))) await p.click('[data-farm="pid0"] > button');
      if (variant === 'bare') { await shown(p, '#farm-pid0 .gate-p, #farm-pid0 .note'); await p.waitForTimeout(3000); await snap('10-private-no-notes'); }
      else {
        await shown(p, variant === 'notes' ? '#sj-max-0' : '#farm-pid0 [data-unbond]', 240000);
        if (variant === 'notes') {
          await p.click('#sj-max-0');
          await until(p, () => /Adds/.test(document.querySelector('#sj-rcpt-0')?.textContent || '') && !document.querySelector('#sj-go-0').disabled, null, 420000).catch(() => {});
          await snap('11-private-join');
        } else {
          await p.waitForTimeout(2000); await snap('12-private-position');
          await p.click('[data-harvest="0"]'); await shown(p, '#sf-act-0 [data-fn-go]'); await snap('13-private-harvested');
        }
      }
      if (r.errors.length) console.log(`   ${tag} ${variant} page errors: ${r.errors.slice(0, 3).join(' | ')}`);
      await r.browser.close();
    }
  }
  ok(true, `farmtour: screenshots in ${SHOTS}`);
});

// A walk through every sheet and its main states for design review: one screenshot each, at phone and desktop widths
// and in the dark scheme too. Opt-in (`tour`), and it writes to SHOTS.
await step('tour', async () => {
  if (!SHOTS) throw new Error('the tour needs SHOTS=<dir>');
  const other = tacit1('b0b'.padEnd(64, '5'));
  const loaded = (p, sel, ms = 180000) => p.waitForFunction((s) => { const e = document.querySelector(s); return !!e && !/reading…|Reading|Finding|Checking/.test(e.textContent) && !e.querySelector('.sk'); }, sel, { timeout: ms }).catch(() => {});
  const shown = (p, sel, ms = 60000) => p.waitForSelector(sel, { timeout: ms }).catch(() => {});
  for (const [tag, viewport, colorScheme] of [['phone', { width: 390, height: 1400 }, 'light'], ['desk', { width: 1280, height: 1200 }, 'light'], ['phone-dark', { width: 390, height: 1400 }, 'dark']]) {
    const r = await openPage({ account: A0, key: K0, viewport, colorScheme });
    const p = r.page, snap = async (name) => { await p.waitForTimeout(1500); await p.screenshot({ path: join(SHOTS, `${tag}-${name}.png`), fullPage: true }); };
    await p.goto(r.url);
    await p.waitForSelector('.tile'); await snap('home');
    await go(p, '#wallet'); await p.waitForSelector('#wallet-body [data-in]'); await snap('wallet-signin');
    await p.click('#wallet-body [data-in="eth"]'); await until(p, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
    await go(p, '#wallet'); await p.waitForSelector('#wallet-body .who'); await snap('wallet');
    await p.click('[data-wal="out"]'); await snap('wallet-send-out');
    await go(p, '#private'); await p.waitForSelector('#w-amt', { timeout: 120000 }); await p.fill('#w-amt', '0.05'); await loaded(p, '#eth-v1 .bal'); await shown(p, '#w-rcpt:not([hidden])'); await snap('eth-wrap');
    await p.click('[data-v1="send"]'); await p.fill('#s-to', other); await p.fill('#s-amt', '0.01'); await shown(p, '#s-rcpt:not([hidden])'); await snap('eth-send');
    await p.click('[data-v1="out"]'); await p.fill('#o-to', A0); await p.fill('#o-amt', '0.01'); await shown(p, '#o-rcpt:not([hidden])'); await snap('eth-withdraw');
    await p.click('[data-eth-mode="dev"]'); await shown(p, '[data-dev]'); await loaded(p, '#eth-dev .bal'); await snap('device-deposit');
    for (const m of ['send', 'out', 'receive']) { await p.click(`[data-dev="${m}"]`); await snap(`device-${m}`); }
    await go(p, '#btc'); await shown(p, '#bt-to', 120000); await loaded(p, '#btc-body .bal'); await p.fill('#bt-to', other).catch(() => {}); await p.fill('#bt-amt', '0.001').catch(() => {}); await shown(p, '#bt-rcpt:not([hidden])'); await snap('btc-send');
    await p.click('[data-btcm="receive"]'); await snap('btc-receive');
    await go(p, '#airdrop'); await shown(p, '#air-body .gate'); await snap('tac-airdrop');
    await p.click('[data-tac-mode="buy"]'); await p.fill('#b-amt', '0.01'); await shown(p, '#b-rcpt:not([hidden])'); await snap('tac-buy');
    await go(p, '#pts'); await shown(p, '#wei-name'); await shown(p, '#pts-body .pt', 120000); await p.fill('#wei-name', 'tacitlite'); await shown(p, '#wei-rcpt:not([hidden])'); await snap('points');
    await go(p, '#farm'); await shown(p, '#pf-amt', 120000); await p.fill('#pf-amt', '0.05'); await shown(p, '#pf-rcpt:not([hidden])'); await snap('farm-precision');
    const pid = await p.$('[data-farm^="pid"] > button');
    if (pid) { await pid.click(); await snap('farm-shielded'); }
    await go(p, '#borrow'); await shown(p, '#borrow-body .steps', 180000); await snap('borrow');
    await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    for (const a of ['tac', 'cbtc']) { await p.click(`.shelf [data-asset="${a}"]`); await shown(p, '#asset-card[open] .links'); await snap(`card-${a}`); await p.keyboard.press('Escape'); }
    if (r.errors.length) console.log(`   ${tag} page errors: ${r.errors.slice(0, 3).join(' | ')}`);
    await r.browser.close();
  }
  ok(true, `tour: screenshots in ${SHOTS}`);
});
if (ACCT) await ACCT.r.browser.close();

if (main.errors.length) { fails++; console.log('FAIL page errors:\n  ' + main.errors.slice(0, 8).join('\n  ')); }
console.log(fails ? `${fails} failed` : 'all passed');
await main.browser.close(); server.close(); anvil.kill('SIGKILL');
process.exit(fails ? 1 : 0);
