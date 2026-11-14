// Any ERC-20 as its own private form in the pool (dapp/confidential-pool-ux.js externalAsset, addAsset, registerTokenCall), checked on an anvil fork of
// mainnet with the real deployment and the same calls the front page makes:
//   - a token the pool does not hold yet (LINK, 18 decimals) resolves with the scale registerWrappedAuto will give it, and nothing is added
//   - registering it is one call from the key's account; after it the token resolves as registered and every lookup finds it (by ticker and by id)
//   - registering it again is refused (AlreadyRegistered), so a page that raced another never sends a failing transaction
//   - an amount finer than the scale is refused before anything is built
//   - the key's account deposits 1.5 LINK through the router by Permit2: the pool escrows exactly that, and its Wrap event carries LINK's own asset id
//   - a token already registered (SPX, 8 decimals, scale 1) deposits the same way
//   - the page's one-confirmation shield (index.html xtWrapDeposit), the calls it hands a batching wallet, run here in the order it sends them:
//     a token the pool does not hold yet (LINK) is registered, approved to Permit2 in full and deposited with a Permit2 signature made BEFORE any
//     of the three exist; a second deposit then needs only its signature and one call (the approval was once)
//   - a token with an EIP-2612 permit (wstETH): a signature and the deposit, no approval of any kind
// Run: anvil --fork-url <mainnet rpc> --port 8547 --chain-id 1 & node tests/pool-token-own-form-fork.mjs [anvil url]
import assert from 'node:assert/strict';
import { secp, sha256, keccak_256, hmac } from '../dapp/vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { setActiveNetwork, nativeEvmAssetId } from '../dapp/confidential-deployments.js';

const ANVIL = process.argv[2] || 'http://127.0.0.1:8547';
const LINK = '0x514910771af9ca656af840dff83e8264ecf986ca', SPX = '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c';
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
const WRAP_TOPIC = '0x' + hx(keccak_256(new TextEncoder().encode('Wrap(bytes32,bytes32,uint256)')));
// a balance for the account: each candidate slot of the token's balances mapping is written and read back through balanceOf
async function give(token, to, amount) {
  for (let i = 0; i < 20; i++) {
    const at = '0x' + hx(keccak_256(Buffer.from(w32(to) + i.toString(16).padStart(64, '0'), 'hex'))), was = await call('eth_getStorageAt', [token, at, 'latest']);
    await call('anvil_setStorageAt', [token, at, '0x' + amount.toString(16).padStart(64, '0')]);
    if ((await balOf(token, to)) === amount) return;
    await call('anvil_setStorageAt', [token, at, was]);
  }
  throw new Error(`no balance slot found for ${token}`);
}
async function receipt(h) {
  for (let i = 0; i < 120; i++) { const r = await call('eth_getTransactionReceipt', [h]); if (r) return r; await new Promise((ok) => setTimeout(ok, 500)); }
  throw new Error(`no receipt for ${h}`);
}
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
await call('anvil_setBalance', [acct.address, '0x' + (10n ** 18n).toString(16)]);

const linkId = nativeEvmAssetId(1, LINK);
await test('a token the pool does not hold resolves with the scale registration will give it, and is not added', async () => {
  const before = ux.assets.length, { row, registered } = await ux.externalAsset(LINK);
  assert.equal(registered, false);
  assert.equal(row.assetId, linkId);
  assert.equal(row.symbol, 'LINK');
  assert.deepEqual([row.decimals, row.tacitDecimals, row.unitScale], [18, 8, String(10n ** 10n)]);
  assert.equal(ux.assets.length, before);
  assert.equal(ux.assetByTicker[row.ticker], undefined);
});
await test('registering it is one call from the key\'s account; after it every lookup finds it', async () => {
  const c = ux.registerTokenCall(LINK);
  assert.equal(c.to, POOL);
  assert.ok(c.data.startsWith('0x0339e3f3'), 'registerWrappedAuto(address,bytes32)');
  const r = await receipt((await ux.sendPreparedTx({ walletPriv: priv, to: c.to, calldata: c.data, gasLimit: 200000n })).txHash);
  assert.equal(r.status, '0x1');
  const { row, registered } = await ux.externalAsset(LINK);
  assert.equal(registered, true);
  assert.equal(ux.assetByTicker[row.ticker], row);
  assert.ok(ux.assets.includes(row) && ux.cfg.assets.includes(row));
  assert.equal(ux.tickerOf(linkId), row.ticker);
  assert.equal(ux.poolTickerOf(linkId), row.ticker);
  assert.equal((await ux.readAsset(linkId)).unitScale, 10n ** 10n);
});
await test('registering it again is refused, so a page that raced another sends nothing that fails', async () => {
  const c = ux.registerTokenCall(LINK);
  await assert.rejects(call('eth_call', [{ from: acct.address, to: c.to, data: c.data }, 'latest']));
});
await test('an amount finer than the scale is refused before anything is built', async () => {
  const ticker = (await ux.externalAsset(LINK)).row.ticker;
  assert.throws(() => ux.buildWrap({ walletPriv: priv, amountWei: (15n * 10n ** 17n + 1n).toString(), ticker, index: 0 }));
});
for (const [name, token, amount, scale] of [['LINK', LINK, 15n * 10n ** 17n, 10n ** 10n], ['SPX', SPX, 250n * 10n ** 8n, 1n]]) {
  await test(`the key's account deposits ${name} through the router by Permit2; the pool escrows exactly it under ${name}'s own id`, async () => {
    const { row, registered } = await ux.externalAsset(token);
    assert.equal(registered, true);
    assert.equal(BigInt(row.unitScale), scale);
    await give(token, acct.address, amount * 2n);
    const a0 = await balOf(token, acct.address), p0 = await balOf(token, POOL);
    const w = await ux.routerWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: row.ticker, index: 0 });
    const r = await receipt(w.txHash);
    assert.equal(r.status, '0x1');
    assert.equal(a0 - (await balOf(token, acct.address)), amount);
    assert.equal((await balOf(token, POOL)) - p0, amount);
    const ev = r.logs.find((l) => l.address.toLowerCase() === POOL.toLowerCase() && l.topics[0] === WRAP_TOPIC);
    assert.ok(ev, 'the pool emitted Wrap');
    assert.equal(ev.topics[2], row.assetId);
    assert.equal(BigInt(ev.data), amount);
    assert.equal(ev.topics[1], w.depositId);
  });
}
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3', MAX256 = 2n ** 256n - 1n;
const allowance = async (t, o, sp) => BigInt(await call('eth_call', [{ to: t, data: '0xdd62ed3e' + w32(o) + w32(sp) }, 'latest']));
const send = async (to, data, value = 0n) => { const r = await receipt((await ux.sendPreparedTx({ walletPriv: priv, to, value, calldata: data, gasLimit: 1500000n })).txHash); assert.equal(r.status, '0x1', `${to} reverted`); return r; };
const p2nonce = async (token) => BigInt('0x' + String(await call('eth_call', [{ to: PERMIT2, data: '0x927da105' + w32(acct.address) + w32(token) + w32(ux.cfg.router) }, 'latest'])).slice(2).slice(128, 192));
const LINK2 = '0x514910771af9ca656af840dff83e8264ecf986ca', WSTETH = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0';
await test('one confirmation: a new token\'s registration, its approval to Permit2 and the deposit, with a signature made before any of them', async () => {
  const token = '0x6982508145454ce325ddbe47a25d4ec3d2311933'; // PEPE: 18 decimals, not in the pool at this block
  const pre = await ux.externalAsset(token);
  assert.equal(pre.registered, false);
  const amount = 3n * 10n ** 18n;
  await give(token, acct.address, amount * 2n);
  assert.equal(await allowance(token, acct.address, PERMIT2), 0n);
  const w = ux.buildWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: (ux.addAsset(pre.row), pre.row.ticker), index: 0 });
  const expiration = Math.floor(Date.now() / 1000) + 1800, nonce = await p2nonce(token);
  const sg = ux.router.signPermit2Single({ token, amount, expiration, nonce, sigDeadline: expiration, priv: acct.priv, spender: ux.cfg.router });
  const calls = [ux.registerTokenCall(token), { to: token, data: '0x095ea7b3' + w32(PERMIT2) + MAX256.toString(16).padStart(64, '0') },
    { to: ux.cfg.router, data: ux.router.wrapWithPermit2Calldata({ token, amount, commit: w.commit, permitSingle: sg.permitSingle, signature: sg.signature }) }];
  const a0 = await balOf(token, acct.address), p0 = await balOf(token, POOL);
  for (const c of calls) await send(c.to, c.data);
  assert.equal(a0 - (await balOf(token, acct.address)), amount);
  assert.equal((await balOf(token, POOL)) - p0, amount);
  assert.equal((await ux.readAsset(nativeEvmAssetId(1, token))).registered, true, 'registered by the first call');
  assert.ok((await allowance(token, acct.address, PERMIT2)) > 10n ** 60n, 'Permit2 holds the approval in full');
  // the second deposit: a signature (the next nonce) and one call
  const w2 = ux.buildWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: pre.row.ticker, index: 1 }), n2 = await p2nonce(token);
  assert.equal(n2, nonce + 1n, 'Permit2 counted the first signature');
  const sg2 = ux.router.signPermit2Single({ token, amount, expiration, nonce: n2, sigDeadline: expiration, priv: acct.priv, spender: ux.cfg.router });
  const p1 = await balOf(token, POOL);
  await send(ux.cfg.router, ux.router.wrapWithPermit2Calldata({ token, amount, commit: w2.commit, permitSingle: sg2.permitSingle, signature: sg2.signature }));
  assert.equal((await balOf(token, POOL)) - p1, amount, 'the second deposit needed no approval');
});
await test('a signature made for one amount does not move another: the deposit is refused, nothing is taken', async () => {
  const { row } = await ux.externalAsset(SPX);
  await give(SPX, acct.address, 10n ** 12n);
  const amount = 10n ** 9n, w = ux.buildWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: row.ticker, index: 9 });
  const exp = Math.floor(Date.now() / 1000) + 1800, nonce = await p2nonce(SPX);
  const sg = ux.router.signPermit2Single({ token: SPX, amount: amount / 2n, expiration: exp, nonce, sigDeadline: exp, priv: acct.priv, spender: ux.cfg.router });
  const data = ux.router.wrapWithPermit2Calldata({ token: SPX, amount, commit: w.commit, permitSingle: sg.permitSingle, signature: sg.signature });
  await assert.rejects(call('eth_call', [{ from: acct.address, to: ux.cfg.router, data }, 'latest']));
});
await test('wstETH takes its own EIP-2612 permit: a signature and the deposit, no approval of any kind', async () => {
  const { row, registered } = await ux.externalAsset(WSTETH);
  assert.equal(registered, true);
  row.permitName = 'Wrapped liquid staked Ether 2.0'; row.permitVersion = '1'; row.permitType = 'eip2612';
  const amount = 5n * 10n ** 17n;
  await give(WSTETH, acct.address, amount * 2n);
  const a0 = await balOf(WSTETH, acct.address), p0 = await balOf(WSTETH, POOL), al0 = await allowance(WSTETH, acct.address, PERMIT2);
  const w = await ux.routerWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: row.ticker, index: 0 });
  assert.equal((await receipt(w.txHash)).status, '0x1');
  assert.equal(a0 - (await balOf(WSTETH, acct.address)), amount);
  assert.equal((await balOf(WSTETH, POOL)) - p0, amount);
  assert.equal(await allowance(WSTETH, acct.address, PERMIT2), al0, 'no approval to Permit2');
  assert.equal(await allowance(WSTETH, acct.address, ux.cfg.router), 0n, 'none to the router either: the permit was spent');
});
console.log(`\n${n} passed`);
