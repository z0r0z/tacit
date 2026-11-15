// A token etched on Ethereum (dapp/etch/eth.js: the canonical factory through a FixedSupplyMinter, made by CreateX) goes into the DeFi pool as its own
// private form, checked on an anvil fork of mainnet with the real factory, CreateX and pool and the same calls the pages make:
//   for each decimals the etch page offers (0, 6, 8, 18):
//   - the page's own plan etches it from the key's account, and the chain shows what was asked for (verify)
//   - the pool has not been told of it: externalAsset gives the scale registerWrappedAuto will derive, under the id every page computes (nativeEvmAssetId)
//   - the card's own read of an unknown address (route.js readToken) names it and finds its EIP-2612 permit
//   - the front page's one-confirmation shield: registration, the approval to Permit2 and the deposit, with the signature made BEFORE any of them exist
//   - the pool escrows exactly the deposit and its Wrap event carries the token's own id; a second shield is one signature and one call
//   - the token's own permit takes a third deposit with no approval of any kind
//   - a token etched WITH its registration in the same batch (the etch page's "register with the pool" box) is registered at once, and shields by permit
// Run: anvil --fork-url <mainnet rpc> --port 8547 --chain-id 1 & node tests/etch-shield-fork.mjs [anvil url]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secp, sha256, keccak_256, hmac } from '../dapp/vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { setActiveNetwork, nativeEvmAssetId } from '../dapp/confidential-deployments.js';
import { readToken } from '../dapp/swap/route.js';

const ANVIL = process.argv[2] || 'http://127.0.0.1:8547';
const ETCH = new URL('../dapp/etch/', import.meta.url);
// eth.js names its two imports by site path; the test names them by file
const E = await import('data:text/javascript;base64,' + Buffer.from(readFileSync(new URL('eth.js', ETCH), 'utf8')
  .replace(/'\/etch\/minter\.js[^']*'/, `'${new URL('minter.js', ETCH).href}'`)
  .replace(/'\.\.\/trade\/batch\.js'/, `'${new URL('../trade/batch.js', ETCH).href}'`)).toString('base64'));

const call = async (method, params) => {
  const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const fetchImpl = (url, opts) => (/^https?:\/\/[^/]*(rpc|node|gateway|eth|llama|ankr|drpc|merkle|infura|alchemy|cloudflare)/i.test(String(url)) ? fetch(ANVIL, opts) : fetch(url, opts));
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
setActiveNetwork('mainnet');
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl, network: 'mainnet' });
const priv = '0x' + Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const acct = ux.account(priv), POOL = ux.cfg.pool;
const w32 = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0'), hx = (b) => Buffer.from(b).toString('hex');
const balOf = async (t, a) => BigInt(await call('eth_call', [{ to: t, data: '0x70a08231' + w32(a) }, 'latest']));
const allowance = async (t, o, sp) => BigInt(await call('eth_call', [{ to: t, data: '0xdd62ed3e' + w32(o) + w32(sp) }, 'latest']));
const WRAP_TOPIC = '0x' + hx(keccak_256(new TextEncoder().encode('Wrap(bytes32,bytes32,uint256)')));
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3', MAX256 = 2n ** 256n - 1n;
async function receipt(h) {
  for (let i = 0; i < 120; i++) { const r = await call('eth_getTransactionReceipt', [h]); if (r) return r; await new Promise((ok) => setTimeout(ok, 500)); }
  throw new Error(`no receipt for ${h}`);
}
const send = async (to, data, gasLimit = 2_000_000n) => { const r = await receipt((await ux.sendPreparedTx({ walletPriv: priv, to, calldata: data, gasLimit })).txHash); assert.equal(r.status, '0x1', `${to} reverted`); return r; };
const p2nonce = async (token) => BigInt('0x' + String(await call('eth_call', [{ to: PERMIT2, data: '0x927da105' + w32(acct.address) + w32(token) + w32(ux.cfg.router) }, 'latest'])).slice(2).slice(128, 192));
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
await call('anvil_setBalance', [acct.address, '0x' + (10n * 10n ** 18n).toString(16)]);

// The page's own plan, sent from the key's account: the create call alone, or with the registration as one more call (the page batches them; the calls are the same).
async function etch({ symbol, decimals, supply, register }) {
  const plan = await E.plan({ account: acct.address, symbol, decimals, supply, register }, call);
  for (const c of plan.calls) await send(c.to, c.data);
  const v = await E.verify(plan, call);
  assert.ok(v.ok, `the chain shows what was asked for: ${JSON.stringify(v.checks)}`);
  return plan;
}
const SYMS = { 0: 'ZERO', 6: 'SIX', 8: 'EIGHT', 18: 'EIGHTEEN' };
for (const decimals of [0, 6, 8, 18]) {
  const symbol = SYMS[decimals], one = 10n ** BigInt(decimals), supply = 1_000_000n * one;
  const tdec = Math.min(decimals, 8), scale = 10n ** BigInt(decimals - tdec);
  const amount = (decimals === 0 ? 1000n : 3n * one / 2n) / scale * scale;           // 1.5 tokens (1000 of a 0-decimal one), aligned to the scale
  let plan, id, row;
  await test(`${decimals} decimals: etched by the page's plan, and the pool has not been told of it`, async () => {
    plan = await etch({ symbol, decimals, supply, register: false });
    id = nativeEvmAssetId(1, plan.token);
    const r = await ux.externalAsset(plan.token);
    row = r.row;
    assert.equal(r.registered, false);
    assert.equal(row.assetId, id);
    assert.equal(row.symbol, symbol);
    assert.deepEqual([row.decimals, row.tacitDecimals, row.unitScale], [decimals, tdec, String(scale)]);
  });
  await test(`${decimals} decimals: the card reads the address it is pasted: its symbol, its decimals and its permit`, async () => {
    const t = await readToken({ ethCall: (to, data) => call('eth_call', [{ to, data }, 'latest']), keccak256: keccak_256, address: plan.token });
    assert.equal(t.sym, symbol);
    assert.equal(t.dec, decimals);
    assert.equal(t.permit, '1', 'the token names its own permit domain');
  });
  await test(`${decimals} decimals: one confirmation registers it, approves Permit2 and deposits; the pool escrows exactly it under its own id`, async () => {
    ux.addAsset(row);
    const w = ux.buildWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: row.ticker, index: 0 });
    const token = plan.token, expiration = Math.floor(Date.now() / 1000) + 1800, nonce = await p2nonce(token);
    const sg = ux.router.signPermit2Single({ token, amount, expiration, nonce, sigDeadline: expiration, priv: acct.priv, spender: ux.cfg.router });
    const calls = [ux.registerTokenCall(token), { to: token, data: '0x095ea7b3' + w32(PERMIT2) + MAX256.toString(16).padStart(64, '0') },
      { to: ux.cfg.router, data: ux.router.wrapWithPermit2Calldata({ token, amount, commit: w.commit, permitSingle: sg.permitSingle, signature: sg.signature }) }];
    const a0 = await balOf(token, acct.address), p0 = await balOf(token, POOL);
    let last;
    for (const c of calls) last = await send(c.to, c.data);
    assert.equal(a0 - (await balOf(token, acct.address)), amount);
    assert.equal((await balOf(token, POOL)) - p0, amount);
    const a = await ux.readAsset(id);
    assert.equal(a.registered, true);
    assert.equal(a.unitScale, scale);
    assert.equal(a.poolMinted, false, 'an escrow asset: the pool holds the token');
    const ev = last.logs.find((l) => l.address.toLowerCase() === POOL.toLowerCase() && l.topics[0] === WRAP_TOPIC);
    assert.ok(ev, 'the pool emitted Wrap');
    assert.equal(ev.topics[2], id);
    assert.equal(BigInt(ev.data), amount);
  });
  await test(`${decimals} decimals: the second shield is a signature and one call; the third goes by the token's own permit with no approval`, async () => {
    const token = plan.token, expiration = Math.floor(Date.now() / 1000) + 1800;
    const w2 = ux.buildWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: row.ticker, index: 1 }), n2 = await p2nonce(token);
    const sg = ux.router.signPermit2Single({ token, amount, expiration, nonce: n2, sigDeadline: expiration, priv: acct.priv, spender: ux.cfg.router });
    const p1 = await balOf(token, POOL);
    await send(ux.cfg.router, ux.router.wrapWithPermit2Calldata({ token, amount, commit: w2.commit, permitSingle: sg.permitSingle, signature: sg.signature }));
    assert.equal((await balOf(token, POOL)) - p1, amount);
    // the permit path, as the card's permitOf names the token's domain ('Tacit Token', version 1)
    row.permitName = 'Tacit Token'; row.permitVersion = '1'; row.permitType = 'eip2612';
    const al0 = await allowance(token, acct.address, PERMIT2), p2 = await balOf(token, POOL), a2 = await balOf(token, acct.address);
    const w = await ux.routerWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: row.ticker, index: 2 });
    assert.equal((await receipt(w.txHash)).status, '0x1');
    assert.equal((await balOf(token, POOL)) - p2, amount);
    assert.equal(a2 - (await balOf(token, acct.address)), amount);
    assert.equal(await allowance(token, acct.address, PERMIT2), al0, 'Permit2 untouched');
    assert.equal(await allowance(token, acct.address, ux.cfg.router), 0n, 'the permit was spent');
  });
}
await test('etched with its registration in the same batch: registered at once, and a shield is one call by the token\'s permit', async () => {
  const decimals = 18, plan = await etch({ symbol: 'BATCHED', decimals, supply: 1_000_000n * 10n ** 18n, register: true });
  assert.equal(plan.calls.length, 2);
  const { row, registered } = await ux.externalAsset(plan.token);
  assert.equal(registered, true, 'the second call of the batch registered it');
  assert.equal(row.assetId, nativeEvmAssetId(1, plan.token));
  assert.equal(row.symbol, 'BATCHED');
  const amount = 25n * 10n ** 17n;
  row.permitName = 'Tacit Token'; row.permitVersion = '1'; row.permitType = 'eip2612';
  const p0 = await balOf(plan.token, POOL);
  const w = await ux.routerWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: row.ticker, index: 0 });
  assert.equal((await receipt(w.txHash)).status, '0x1');
  assert.equal((await balOf(plan.token, POOL)) - p0, amount);
  // registering it again from anywhere is refused: the page that reads 'registered' never sends a registration
  await assert.rejects(call('eth_call', [{ from: acct.address, to: POOL, data: ux.registerTokenCall(plan.token).data }, 'latest']));
});
console.log(`\n${n} passed`);
