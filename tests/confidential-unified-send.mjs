// Pins the new unified-send layer (dapp-only orchestration over existing builders):
//   1. Tacit unified address codec round-trips both-lanes and BTC-only payloads,
//      rejects wrong HRP / truncated / bad-point payloads.
//   2. makeUnifiedSend routing: a unified address resolves to the right leg per
//      chosen asset; single-format addresses are lane-checked; the EVM lane is
//      gated; the bare-pubkey ambiguity surfaces (via a stub parseRecipient).
// Run: node tests/confidential-unified-send.mjs
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import assert from 'node:assert';
import { makeTacitAddress } from '../dapp/tacit-address.js';
import { makeUnifiedSend } from '../dapp/confidential-unified-send.js';

const { encodeTacitAddress, decodeTacitAddress } = makeTacitAddress({ secp });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const priv = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const pub = (h) => secp.getPublicKey(priv(h), true);
const spendPub = pub('11'.repeat(32));
const scanPub  = pub('22'.repeat(32));
const evmPub   = pub('33'.repeat(32));
const hex = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');

// ── 1. codec round-trip ──
{
  const addr = encodeTacitAddress({ network: 'mainnet', btcSpendPub: spendPub, btcScanPub: scanPub, evmOwnerPub: evmPub });
  assert.ok(addr.startsWith('tacit1'), 'mainnet HRP is tacit1');
  const dec = decodeTacitAddress(addr);
  assert.strictEqual(dec.network, 'mainnet');
  assert.strictEqual(hex(dec.lanes.btc.spendPub), hex(spendPub));
  assert.strictEqual(hex(dec.lanes.btc.scanPub), hex(scanPub));
  assert.strictEqual(hex(dec.lanes.evm.ownerPub), hex(evmPub));
  ok('both-lanes address round-trips (spend, scan, evm owner)');

  const sig = encodeTacitAddress({ network: 'signet', btcSpendPub: spendPub, btcScanPub: scanPub, evmOwnerPub: evmPub });
  assert.ok(sig.startsWith('tactt1'), 'signet HRP is tactt1');
  ok('signet HRP is tactt1');

  const btcOnly = encodeTacitAddress({ network: 'mainnet', btcSpendPub: spendPub, btcScanPub: scanPub });
  const decBtc = decodeTacitAddress(btcOnly);
  assert.ok(!decBtc.lanes.evm, 'btc-only address omits evm lane');
  ok('btc-only address round-trips without an evm lane');
}

// ── 1b. codec rejections ──
{
  assert.throws(() => decodeTacitAddress('tacit1qqqqqqqqqqqqqqqq'), /payload|checksum|length/i);
  ok('rejects truncated payload');
  const addr = encodeTacitAddress({ network: 'mainnet', btcSpendPub: spendPub, btcScanPub: scanPub });
  assert.throws(() => decodeTacitAddress(addr.slice(0, -1) + (addr.slice(-1) === 'q' ? 'p' : 'q')), /checksum/i);
  ok('rejects corrupted checksum');
  assert.throws(() => encodeTacitAddress({ network: 'mars', btcSpendPub: spendPub, btcScanPub: scanPub }), /unknown network/);
  ok('rejects unknown network');
}

// ── 2. dispatch routing (stub parseRecipient + builders) ──
{
  const calls = [];
  const tacitParsed = { kind: 'tacit', network: 'signet',
    lanes: { btc: { spendPub, scanPub }, evm: { ownerPub: evmPub } }, raw: 'tactt1...' };

  const mk = (overrides = {}) => makeUnifiedSend({
    parseRecipient: () => overrides.parsed || tacitParsed,
    currentNetworkName: () => 'signet',
    isCrosslaneConfigured: () => overrides.evmLive ?? true,
    buildAndBroadcastCXferMulti: async (a) => { calls.push(['cxfer', a]); return { txid: 'btc-tx' }; },
    sendSats: async (a) => { calls.push(['sats', a]); return { txid: 'sats-tx' }; },
    getPoolUx: () => overrides.ux || null,
  });

  // unified addr + BTC asset → CXFER pubkey leg
  calls.length = 0;
  let r = await mk().dispatchSend({ wallet: { priv: priv('aa'.repeat(32)) },
    recipientRaw: 'tactt1...', asset: { kind: 'btc', assetId: '0xabc' }, amount: 100n });
  assert.ok(r.ok && r.path === 'cxfer-pubkey', 'unified+btc → cxfer-pubkey');
  assert.strictEqual(calls[0][0], 'cxfer');
  assert.strictEqual(calls[0][1].recipients[0].pubHex, hex(spendPub));
  ok('unified address + BTC asset routes to CXFER pubkey');

  // unified addr + sats → silent payment leg
  calls.length = 0;
  r = await mk().dispatchSend({ wallet: {}, recipientRaw: 'tactt1...', asset: { kind: 'sats' }, amount: 5000n });
  assert.ok(r.ok && r.path === 'sats-sp', 'unified+sats → silent payment');
  assert.strictEqual(calls[0][0], 'sats');
  ok('unified address + sats routes to silent payment');

  // unified addr + pool asset, EVM gated OFF → blocked
  r = await mk({ evmLive: false }).dispatchSend({ wallet: {}, recipientRaw: 'tactt1...',
    asset: { kind: 'pool', assetId: '0xeth' }, amount: 1n });
  assert.ok(!r.ok && r.blocked, 'EVM lane blocked when not configured');
  ok('EVM lane blocked when crosslane not configured');

  // unified addr + pool asset, EVM live → reaches pool ux transfer
  const uxCalls = [];
  const fakeUx = {
    tickerOf: () => 'cETH',
    balance: async () => ({ notes: [{ asset: '0xeth', value: '100' }] }),
    transfer: async (a) => { uxCalls.push(a); return { txHash: '0xhash' }; },
  };
  r = await mk({ evmLive: true, ux: fakeUx }).dispatchSend({ wallet: { priv: priv('bb'.repeat(32)) },
    recipientRaw: 'tactt1...', asset: { kind: 'pool', assetId: '0xeth', ticker: 'cETH' }, amount: 100n });
  assert.ok(r.ok && r.path === 'evm-transfer', 'EVM transfer dispatched');
  assert.strictEqual(uxCalls[0].recipientPubHex, '0x' + hex(evmPub), 'recipient is the evm owner pubkey');
  ok('unified address + pool asset routes to pool transfer with evm owner key');

  // single stealth address + EVM asset → lane mismatch rejected
  r = await mk({ parsed: { kind: 'stealth', chain: 'btc', path: 'cxfer-stealth', recipientPub: spendPub, raw: 'tcsts1..' } })
    .dispatchSend({ wallet: {}, recipientRaw: 'tcsts1..', asset: { kind: 'pool', assetId: '0xeth' }, amount: 1n });
  assert.ok(!r.ok, 'stealth recipient rejected for EVM asset');
  ok('single-format lane mismatch is rejected');

  // ambiguous bare pubkey surfaces for the chooser
  r = await mk({ parsed: { kind: 'ambiguous', candidates: [{ chain: 'btc' }, { chain: 'evm' }], raw: '02..' } })
    .dispatchSend({ wallet: {}, recipientRaw: '02..', asset: { kind: 'btc', assetId: '0xabc' }, amount: 1n });
  assert.ok(!r.ok && r.ambiguous, 'ambiguous parse surfaces');
  ok('ambiguous bare pubkey surfaces a chooser instead of auto-sending');
}

// ── 3b. wrap-and-send (router-aware batching) ──
{
  const tacitParsed = { kind: 'tacit', network: 'signet',
    lanes: { btc: { spendPub, scanPub }, evm: { ownerPub: evmPub } } };
  const baseUx = (routerOn, log) => ({
    tickerOf: () => 'cETH',
    routerConfigured: () => routerOn,
    balance: async () => ({ notes: log.settled ? [{ asset: '0xeth', value: '100' }] : [] }),
    routerWrap: async (a) => { log.calls.push(['routerWrap', a.amountWei]); log.settled = true; return {}; },
    wrap: async (a) => { log.calls.push(['wrap', a.amountWei]); log.settled = true; return {}; },
    transfer: async (a) => { log.calls.push(['transfer', a.amount]); return { txHash: '0xh' }; },
  });
  const mk = (ux) => makeUnifiedSend({
    parseRecipient: () => tacitParsed,
    currentNetworkName: () => 'signet',
    isCrosslaneConfigured: () => true,
    buildAndBroadcastCXferMulti: async () => ({}),
    sendSats: async () => ({}),
    getPoolUx: () => ux,
  });

  // router configured → wrap-and-send prefers the single-tx routerWrap, then transfers
  let log = { calls: [], settled: false };
  let r = await mk(baseUx(true, log)).dispatchSend({ wallet: { priv: priv('cc'.repeat(32)) },
    recipientRaw: 'tactt1', asset: { kind: 'pool', assetId: '0xeth', ticker: 'cETH' },
    amount: 100n, opts: { allowWrap: true, wrapPollTries: 1, wrapPollDelayMs: 0 } });
  assert.ok(r.ok, 'wrap-and-send completes');
  assert.deepStrictEqual(log.calls.map((c) => c[0]), ['routerWrap', 'transfer'], 'router wrap then transfer');
  ok('wrap-and-send uses router single-tx wrap when configured');

  // router NOT configured → falls back to two-step pool wrap
  log = { calls: [], settled: false };
  r = await mk(baseUx(false, log)).dispatchSend({ wallet: { priv: priv('dd'.repeat(32)) },
    recipientRaw: 'tactt1', asset: { kind: 'pool', assetId: '0xeth', ticker: 'cETH' },
    amount: 100n, opts: { allowWrap: true, wrapPollTries: 1, wrapPollDelayMs: 0 } });
  assert.ok(r.ok, 'two-step wrap-and-send completes');
  assert.deepStrictEqual(log.calls.map((c) => c[0]), ['wrap', 'transfer'], 'pool wrap then transfer');
  ok('falls back to two-step pool wrap when router not configured');

  // wrap disallowed → refuses instead of silently wrapping
  log = { calls: [], settled: false };
  r = await mk(baseUx(true, log)).dispatchSend({ wallet: {}, recipientRaw: 'tactt1',
    asset: { kind: 'pool', assetId: '0xeth', ticker: 'cETH' }, amount: 100n, opts: {} });
  assert.ok(!r.ok && /insufficient/.test(r.reason), 'refuses without allowWrap');
  assert.strictEqual(log.calls.length, 0, 'no wrap when not allowed');
  ok('refuses to wrap-and-send unless explicitly allowed');
}

console.log(`\n${n}/${n} unified-send checks passed`);
