// tacit.finance/etch, on Ethereum: an asset made through the canonical asset factory (the pool's own, contracts/src/CanonicalAssetFactory.sol), with a fixed
// supply minted at once to one address and a metadata stamp (the IPFS content hash of its name, logo, description and link, which the token reports as its
// contractURI). The supply is made by a FixedSupplyMinter: a contract that etches the token, mints the whole supply in its constructor and then has no call
// left in it, so nothing can mint again. It is deployed through CreateX, in one call, which makes it one transaction of the page's own and a call a wallet's
// batch can carry; the one further step (registering the token with the pool) is a second call, sent in the same batch when the wallet batches calls
// atomically (EIP-5792), else after the first is mined.
//
// What this makes is an Ethereum token. The pool takes it as an escrow asset (registerWrappedAuto), and the pool never links an escrow asset to a Bitcoin id
// (ReflectionLib.register: CrossChainEscrow), so it does not cross the bridge to Bitcoin; an asset that crosses is etched on Bitcoin.
import { FIXED_SUPPLY_MINTER_INIT } from '/etch/minter.js?cb=4a0d243a';

// contracts/deployments/1.json
export const FACTORY = '0x0000000042c2D57499Df64BAF81bfA2C6E100535', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', CREATEX = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
const SEL = {
  deployCreate2: '0x26307668', registerWrappedAuto: '0x0339e3f3', predict: '0xb3852d4c', deriveAssetId: '0x5a27003f',
  balanceOf: '0x70a08231', totalSupply: '0x18160ddd', decimals: '0x313ce567', symbol: '0x95d89b41', contractURI: '0xe8a3d485', MINTER: '0xfe6d8124', ASSET_ID: '0x9ceb21ae',
};
const ZERO32 = '0x' + '00'.repeat(32);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => strip(a).padStart(64, '0');
const b32 = (h) => strip(h).padStart(64, '0');
// bytes / string tail: its length, then its bytes padded to a whole word
const tail = (hex) => word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
const utf8hex = (s) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

// The metadata's content hash: a CID the pin returns (a raw-codec CIDv1 of the JSON's sha-256: base32, "b" + 0x01 0x55 0x12 0x20 + the 32-byte digest), as the
// 32 bytes the factory takes. Anything else is refused, so a hash that does not name the JSON is never stamped.
export function cidDigest(cid) {
  const s = String(cid || '').toLowerCase();
  if (!/^b[a-z2-7]+$/.test(s)) throw new Error('the pin returned a content id this page cannot read');
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, acc = 0;
  const bytes = [];
  for (const c of s.slice(1)) { acc = (acc << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); acc &= (1 << bits) - 1; } }
  if (bytes.length !== 36 || bytes[0] !== 0x01 || bytes[1] !== 0x55 || bytes[2] !== 0x12 || bytes[3] !== 0x20) throw new Error('the pin returned a content id that is not the hash of the metadata');
  return '0x' + bytes.slice(4).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// CreateX takes the first twenty bytes of a salt as who it is guarded for and the twenty-first as whether a redeploy elsewhere is: random bytes and a zero make it
// guarded for no one, so the same call from anyone makes the same contract (which mints to the address in its arguments, so a copy of the call is harmless).
const randomSalt = () => { const b = crypto.getRandomValues(new Uint8Array(32)); b[20] = 0; return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); };
// FixedSupplyMinter's constructor arguments, after its creation code.
export function minterInit({ etcher, salt, symbol, decimals, cid = ZERO32, supply, recipient }) {
  const args = addr(FACTORY) + addr(etcher) + b32(salt) + word(8 * 32) + word(decimals) + b32(cid) + word(supply) + addr(recipient) + tail(utf8hex(symbol));
  return FIXED_SUPPLY_MINTER_INIT + args;
}
const deployCall = (salt, initCode) => SEL.deployCreate2 + b32(salt) + word(64) + tail(strip(initCode));
const registerCall = (token) => SEL.registerWrappedAuto + addr(token) + word(0);

// The calls that etch it, and the addresses they will make, read from the chain as the wallet's account would make them: the simulated call returns the
// minter's address, and the factory's own `predict` names the token's. `read(method, params)` is a JSON-RPC read; `gas` is what the first call is estimated at.
export async function plan({ account, symbol, decimals, supply, cid = ZERO32, register = false, salt = randomSalt() }, read) {
  const initCode = minterInit({ etcher: account, salt, symbol, decimals, cid, supply, recipient: account });
  const create = { to: CREATEX, data: deployCall(salt, initCode), label: 'Create the token' };
  const ret = await read('eth_call', [{ from: account, to: CREATEX, data: create.data }, 'latest']);
  const minter = '0x' + strip(ret).slice(24, 64);
  if (!/^0x[0-9a-f]{40}$/.test(minter) || /^0x0+$/.test(minter)) throw new Error('the token could not be created: the simulated deployment answered nothing');
  const assetId = await read('eth_call', [{ to: FACTORY, data: SEL.deriveAssetId + addr(account) + b32(salt) + word(5 * 32) + word(decimals) + b32(cid) + tail(utf8hex(symbol)) }, 'latest']);
  const token = '0x' + strip(await read('eth_call', [{ to: FACTORY, data: SEL.predict + strip(assetId) + addr(minter) + word(5 * 32) + word(decimals) + b32(cid) + tail(utf8hex(symbol)) }, 'latest'])).slice(24, 64);
  const gas = BigInt(await read('eth_estimateGas', [{ from: account, to: CREATEX, data: create.data }]));
  const calls = [create];
  if (register) calls.push({ to: POOL, data: registerCall(token), label: 'Register it with the pool', gas: 120000n });
  return { salt, symbol, decimals, supply, cid, account, minter, token, assetId: '0x' + strip(assetId), calls, gas: gas + (register ? 120000n : 0n) };
}

// Sends the calls: together in one atomic batch when the wallet takes one (EIP-5792), else one after another, each waited for. `step(n, of, label)` says which
// is being asked for. Resolves to the transaction hashes. A wallet that declines is the visitor's no, and nothing after it is sent.
export async function send(plan, wallet, { step = () => {}, read, pollMs = 3000 } = {}) {
  const W = wallet.state, from = W.account, n = plan.calls.length;
  await wallet.ensureMainnet();
  const batch = n > 1 && (await batchable(W, from));
  if (batch) {
    step(1, 1, 'Confirm both in your wallet');
    const sent = await W.prov.request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', from, chainId: '0x1', atomicRequired: true, calls: plan.calls.map((c) => ({ to: c.to, data: c.data, value: '0x0' })) }] });
    const id = typeof sent === 'string' ? sent : sent?.id;
    if (!id) throw new Error('the wallet did not say what it sent');
    for (let i = 0; i < 200; i++) {
      const s = await W.prov.request({ method: 'wallet_getCallsStatus', params: [id] });
      const code = Number(s?.status);
      if (code >= 200 && code < 300 && s.atomic !== false) {
        const bad = (s.receipts || []).find((r) => r.status === '0x0');
        if (bad) throw new Error('the batch was mined but a call in it failed');
        return (s.receipts || []).map((r) => r.transactionHash);
      }
      if (code >= 400) throw new Error('the batch was not mined');
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error('Sent, not confirmed yet. Check your wallet’s activity before sending anything again.');
  }
  const hashes = [];
  for (let i = 0; i < n; i++) {
    try {
      step(i + 1, n, plan.calls[i].label);
      const hash = await wallet.sendTx({ to: plan.calls[i].to, data: plan.calls[i].data, from });
      const r = await wallet.receipt(hash, { read, every: pollMs });
      if (r.status === '0x0') throw new Error(`${plan.calls[i].label} did not go through (${hash.slice(0, 10)}…)${i ? '' : ': nothing was made'}`);
      hashes.push(hash);
    } catch (e) {
      if (i > 0) e.partial = hashes.slice();        // what is already made is not undone by a later call that is not
      throw e;
    }
  }
  return hashes;
}
async function batchable(W, from) {
  try {
    const caps = await W.prov.request({ method: 'wallet_getCapabilities', params: [from, ['0x1']] });
    const a = caps?.['0x1']?.atomic?.status;
    return a === 'supported' || a === 'ready';
  } catch { return false; }
}

// What the chain says of the token now, against what was asked for: the symbol, the decimals, the whole supply in one account, no further minter than the
// one that was deployed, and the metadata stamp.
export async function verify(p, read) {
  const call = (to, data) => read('eth_call', [{ to, data }, 'latest']);
  const [sym, dec, tot, bal, mtr, uri] = await Promise.all([
    call(p.token, SEL.symbol), call(p.token, SEL.decimals), call(p.token, SEL.totalSupply), call(p.token, SEL.balanceOf + addr(p.account)), call(p.token, SEL.MINTER), call(p.token, SEL.contractURI),
  ]);
  const text = (h) => { const x = strip(h); const len = parseInt(x.slice(64, 128) || '0', 16); return decodeURIComponent(x.slice(128, 128 + len * 2).replace(/(..)/g, '%$1')); };
  const want = strip(p.cid) === '00'.repeat(32) ? '' : `ipfs://f01551220${strip(p.cid)}`;
  const checks = {
    symbol: text(sym) === p.symbol, decimals: BigInt(dec) === BigInt(p.decimals), supply: BigInt(tot) === p.supply, holder: BigInt(bal) === p.supply,
    minter: '0x' + strip(mtr).slice(24) === p.minter.toLowerCase(), metadata: text(uri) === want,
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}

// Offers the token to the wallet's token list (EIP-747); a wallet without it, or a no, is not an error.
export const addToWallet = (wallet, p, image) => wallet.watchAsset({ address: p.token, symbol: p.symbol.slice(0, 11), decimals: p.decimals, ...(image ? { image } : {}) });

// ── finding them again ──
// The factory's own record: every token it has made is a Deployed event. Those the pool mints itself (the bridged assets, TAC among them) are not etches
// made here, and are left out. The free node that answers a read over the factory's whole life is Tenderly's; the others refuse a range this wide, so it
// is asked first (the read moves on to the next when it fails).
export const DEPLOY_BLOCK = 25998736;
const DEPLOYED = '0x93c5d8685811454892b561b9f2a796b6f00badaadfbd6d47fd79e69219292913';
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
// The metadata hash as the CID string the pin returned: "b" + base32 of 0x01 0x55 0x12 0x20 + the digest.
export function cidString(digest) {
  const bytes = [0x01, 0x55, 0x12, 0x20, ...strip(digest).match(/../g).map((h) => parseInt(h, 16))];
  let bits = 0, acc = 0, out = '';
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += B32[(acc >> bits) & 31]; acc &= (1 << bits) - 1; } }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return `b${out}`;
}
export async function listEtches(read, hosts) {
  const logs = await read('eth_getLogs', [{ address: FACTORY, topics: [DEPLOYED], fromBlock: '0x' + DEPLOY_BLOCK.toString(16), toBlock: 'latest' }], hosts);
  const out = [];
  for (const l of logs) {
    const minter = '0x' + strip(l.topics[3]).slice(24), token = '0x' + strip(l.topics[2]).slice(24);
    if (minter === POOL.toLowerCase()) continue;
    const d = strip(l.data), len = parseInt(d.slice(3 * 64, 4 * 64), 16), cid = '0x' + d.slice(2 * 64, 3 * 64);
    // anyone can deploy a symbol that is not UTF-8: it reads with replacement marks rather than failing the whole list
    const symbol = new TextDecoder().decode(Uint8Array.from(d.slice(4 * 64, 4 * 64 + len * 2).match(/../g) || [], (b) => parseInt(b, 16)));
    out.push({ id: token, chain: 'eth', ticker: symbol, decimals: parseInt(d.slice(64, 128), 16), cid: /^0x0+$/.test(cid) ? null : cidString(cid), height: parseInt(l.blockNumber, 16), etchTxid: l.transactionHash, minter, name: '', logo: null, verified: false, mintable: false, holders: 0, later: false, same: 0, supply: null, at: 0 });
  }
  await Promise.all([
    ...out.map(async (a) => { try { a.supply = BigInt(await read('eth_call', [{ to: a.id, data: SEL.totalSupply }, 'latest'])); } catch { /* a supply that cannot be read is not shown */ } }),
    ...[...new Set(out.map((a) => a.height))].map(async (h) => { try { const ts = Number((await read('eth_getBlockByNumber', ['0x' + h.toString(16), false]))?.timestamp); for (const a of out) if (a.height === h) a.at = ts || 0; } catch { /* the date is a convenience */ } }),
  ]);
  const by = new Map();
  for (const a of out.sort((x, y) => x.height - y.height)) { const k = a.ticker.toLowerCase(); (by.get(k) || by.set(k, []).get(k)).push(a); }
  for (const g of by.values()) g.forEach((a, i) => { a.same = g.length - 1; a.later = i > 0; });
  return out.sort((x, y) => y.height - x.height);
}
// What `account` holds of each token.
export async function balances(read, account, tokens) {
  const out = {};
  await Promise.all(tokens.map(async (t) => { try { out[t] = BigInt(await read('eth_call', [{ to: t, data: SEL.balanceOf + addr(account) }, 'latest'])); } catch { /* unread */ } }));
  return out;
}
