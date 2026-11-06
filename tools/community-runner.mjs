#!/usr/bin/env node
// Tacit's community ops runner: one key keeps Bitcoin's state moving onto Ethereum and sends the open board's settles for the fees
// their proofs pay. Every call it makes is permissionless on chain, the same ones Tacit's own services and the community ops page
// (tacit.finance/prove/, its Relay and Bitcoin tabs) make, built by the same modules:
//   headers  BitcoinLightRelay.advanceTip, when the next proof is waiting on the relay (dapp/header-relay-advance.js)
//   attest   a proof Tacit's prover has published and not landed, to attestBitcoinStateProven; first advanceReflectionAncestry()
//            while the proofs are more than 2,016 blocks behind the relay (dapp/community-ops.js)
//   settles  the open board's settles whose fee (tETH, or TAC at 80% of the TAC/tETH pool's price) covers their gas with a margin, read
//            from Tacit's API and from public Nostr relays (dapp/nostr-board.js), so it goes on when the API does not; each pass also copies
//            the API's waiting proofs to the relays (dapp/community-ops.js)
//   all      the three, each on its own cadence (the default)
//   mirror   (opt-in, not in `all`, needs no key) only copy the API's waiting proofs to the Nostr relays, so the board stays public
//   prove    (opt-in, not in `all`) take the proof market's orders: prove each holder's wrap on this machine with tacit-prover and be paid in TAC
//            from their permit when the pool accepts it. Run `node tools/community-runner.mjs prove` beside tacit-prover (127.0.0.1:47815).
//   board    (opt-in, not in `all`, needs no key) race Tacit's own prover for the prover board's public jobs: ops whose program input holds
//            no one's secret (a wrap, a staged deposit's swap or payment). Each is proved with tacit-prover beside it; the first proof the
//            relay checks and takes is the one used, and its maker's address is credited on the board (MINER=0x…, default the key's
//            address). A job whose deadline is nearer than this machine's last proof took is passed over: a press is for a fast machine.
// Each transaction is simulated against the latest block before it is signed, and work someone else has done meanwhile is passed
// over. Signed transactions go to SEND_RPC_URL (Flashbots Protect by default, which does not include one that would revert), one at a
// time, each waited for before the next.
//
//   RUNNER_KEY=0x… node tools/community-runner.mjs [headers|attest|settles|all]
//   node tools/community-runner.mjs mirror                       keep the board public on Nostr, no key
//   DRY_RUN=1 ONCE=1 node tools/community-runner.mjs            what it would send, then exit; with no key it simulates from a throwaway one
//
// Env:
//   RUNNER_KEY          the account that signs, pays the gas and is paid the board's fees (a key holding only ETH for gas)
//   RPC_URL             reads and simulation (default https://ethereum-rpc.publicnode.com)
//   SEND_RPC_URL        where signed transactions go (default https://rpc.flashbots.net/fast?hint=hash)
//   API_BASE            Tacit's API: published proofs, the board, landings (default https://api.tacit.finance)
//   ESPLORA_URL         Bitcoin headers (default https://blockstream.info/api)
//   DRY_RUN=1           print what would be sent, send nothing          ONCE=1    one pass of each mode, then exit
//   HEADERS_SECS=300  ATTEST_SECS=60  SETTLES_SECS=15                   each mode's cadence
//   HEADERS_MIN_BEHIND=3   headers go out once the relay is this many blocks behind Bitcoin's tip less 2 and the next proof waits on it
//   HEADERS_NEED=<height>  carry the relay to this Bitcoin height (a lock's or deposit's block + 24) whatever the pacing
//   ATTEST_AFTER_SECS=120  how long a published proof is left to Tacit's own prover before this key sends it
//   MARGIN_BPS=2000        a settle is sent when its fee pays its gas with this much to spare (2000 = 20%)
//   NOSTR=1                read and copy the board on Nostr (0: the API's board alone). Needs a WebSocket: Node 22, or Node 20 with
//                          --experimental-websocket          NOSTR_RELAYS=wss://…,wss://…   the relays (default dapp/nostr-board.js's)
//   MAX_GAS_GWEI=5         headers, attests and ancestry calls wait while the base fee is above this (0 = no ceiling); settles are
//                          priced by their fee instead
//   PRIORITY_GWEI=0.1      the tip each transaction offers
// docs/COMMUNITY-OPS.md says what each mode costs and earns.

import { pathToFileURL } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as secp from '@noble/secp256k1';
import { makeEvmTx } from '../dapp/evm-tx.js';
import { makeHeaderRelayAdvance } from '../dapp/header-relay-advance.js';
import { makeMarketSolver } from '../worker-relay/src/lib/market-solver.js';
import { encodeClaim, encodeFulfill } from '../dapp/proof-market.js';
import {
  POOL, SEL_ANCESTRY, SETTLE_GAS, readProof, attestRefusal, encodeAttest, needsAncestry, ancestryCalls, ethText, feeWeiOf, readPrices, feeCovers,
  boardSummary, pickSettle, readBoard, reportLanded, settleCalldata,
} from '../dapp/community-ops.js';
import { makeNostrBoard, mergeBoards, NOSTR_RELAYS } from '../dapp/nostr-board.js';

secp.etc.hmacSha256Sync = (key, ...m) => hmac(sha256, key, secp.etc.concatBytes(...m));

export const MODES = ['headers', 'attest', 'settles'];
const GWEI = 1_000_000_000n;
const hexToBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const gweiToWei = (g) => BigInt(Math.round(Number(g) * 1e9));
const gweiText = (wei) => (Number(wei) / 1e9).toFixed(3);

// ── configuration ──
export function readConfig(env = process.env, argv = process.argv.slice(2)) {
  const v = (k, d) => (env[k] != null && String(env[k]).trim() !== '' ? String(env[k]).trim() : d);
  const num = (k, d) => { const n = Number(v(k, d)); if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a number of 0 or more`); return n; };
  const mode = String(argv.find((a) => !a.startsWith('-')) || v('MODE', 'all')).toLowerCase();
  if (mode !== 'all' && mode !== 'prove' && mode !== 'board' && mode !== 'mirror' && !MODES.includes(mode)) throw new Error(`unknown mode "${mode}": headers, attest, settles, prove, board, mirror or all`);
  const need = v('HEADERS_NEED', null);
  if (need != null && !/^\d{1,8}$/.test(need)) throw new Error('HEADERS_NEED must be a Bitcoin block height');
  const dryRun = v('DRY_RUN', '0') === '1', key = v('RUNNER_KEY', null);
  const miner = v('MINER', null);
  if (miner != null && !/^0x[0-9a-fA-F]{40}$/.test(miner)) throw new Error('MINER must be the 0x address the board credits');
  if (mode === 'board' && !key && !miner) throw new Error('set MINER=0x<the address the board credits>');
  if (!key && !dryRun && mode !== 'board' && mode !== 'mirror') throw new Error('set RUNNER_KEY=0x<a key holding a little ETH for gas>, or DRY_RUN=1 to see what would be sent');
  return {
    modes: mode === 'all' ? MODES.slice() : [mode], dryRun, once: v('ONCE', '0') === '1', key, miner,
    rpcUrl: v('RPC_URL', 'https://ethereum-rpc.publicnode.com'), sendRpcUrl: v('SEND_RPC_URL', 'https://rpc.flashbots.net/fast?hint=hash'),
    api: v('API_BASE', 'https://api.tacit.finance').replace(/\/+$/, ''), esplora: v('ESPLORA_URL', 'https://blockstream.info/api').replace(/\/+$/, ''),
    secs: { headers: num('HEADERS_SECS', 300), attest: num('ATTEST_SECS', 60), settles: num('SETTLES_SECS', 15), prove: num('PROVE_SECS', 10), board: num('BOARD_SECS', 5), mirror: num('MIRROR_SECS', 60) },
    nostr: v('NOSTR', '1') !== '0', nostrRelays: v('NOSTR_RELAYS', NOSTR_RELAYS.join(',')).split(',').map((x) => x.trim()).filter((x) => /^wss:\/\//.test(x)),
    marketAddr: v('MARKET_ADDR', '0x0000000033Dd45B1686Ba37e5F6e4ABDdaC17609'), deviceProver: v('DEVICE_PROVER', 'http://127.0.0.1:47815').replace(/\/+$/, ''), minTacWei: BigInt(v('MIN_TAC_WEI', '0')),
    headersMinBehind: num('HEADERS_MIN_BEHIND', 3), headersNeed: need == null ? null : Number(need),
    attestAfterMs: num('ATTEST_AFTER_SECS', 120) * 1000, marginBps: BigInt(Math.round(num('MARGIN_BPS', 2000))),
    maxGasWei: gweiToWei(num('MAX_GAS_GWEI', 5)), priorityWei: gweiToWei(num('PRIORITY_GWEI', 0.1)),
  };
}

// ── what each mode does with what it reads ──
// Headers: sent when the next proof waits on the relay and the relay has fallen HEADERS_MIN_BEHIND blocks behind (Tacit's own relay
// keeps it within a block or two), or whenever HEADERS_NEED names a height past the relay.
export function headersVerdict(st, pl, { minBehind = 3, need = null } = {}) {
  if (pl.action !== 'advance') {
    if (need != null && need <= st.relayTip) return { go: false, why: `the relay already has block ${need}` };
    return { go: false, why: `the relay is at ${st.relayTip} (Bitcoin ${st.btcTip}): nothing to advance` };
  }
  if (need != null) return { go: true, why: `${pl.pending} header(s), ${pl.from} to ${pl.to}, toward block ${need}` };
  if (pl.useless) return { go: false, why: `the relay confirms Bitcoin to ${st.relayTip - st.confirmations}, past the proven block ${st.attested}: the next proof is not waiting on it` };
  const behind = st.btcTip - 2 - st.relayTip;
  if (behind < minBehind) return { go: false, why: `the relay is ${behind} block(s) behind, under HEADERS_MIN_BEHIND=${minBehind}: left to Tacit's relay` };
  return { go: true, why: `${pl.pending} header(s), ${pl.from} to ${pl.to}: the next proof is waiting on them` };
}
// Attests: a published proof that still builds on the pool's digest, once Tacit's prover has had ATTEST_AFTER_SECS to land it.
export function attestVerdict({ rec, offer }, { nowMs = Date.now(), afterMs = 120_000 } = {}) {
  if (offer === 'none') return { go: false, why: 'no published proof is waiting' };
  if (offer === 'malformed') return { go: false, why: 'the published proof is not in the form the pool takes' };
  if (offer === 'spent') return { go: false, why: `the latest proof (Bitcoin to ${rec.attestedTo}) is on chain, or the pool has moved past it` };
  const age = Number.isFinite(rec.at) ? nowMs - rec.at : Infinity;
  if (age < afterMs) return { go: false, why: `the proof for Bitcoin to ${rec.attestedTo} was published ${Math.round(age / 1000)} s ago: left to Tacit's prover for ${Math.round(afterMs / 1000)} s` };
  return { go: true, why: `the proof for Bitcoin to ${rec.attestedTo}${Number.isFinite(age) ? `, published ${Math.round(age / 60000)} min ago,` : ''} is not on chain` };
}
// The unpaid work waits for a base fee at or under the ceiling (0 = none).
export const gasAllows = (baseWei, maxWei) => !maxWei || BigInt(baseWei) <= BigInt(maxWei);

// ── the key ──
export function makeSigner(keyHex) {
  const priv = String(keyHex).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(priv)) throw new Error('RUNNER_KEY must be 32 bytes of hex');
  const evmTx = makeEvmTx({ secp, keccak256: keccak_256 });
  const address = '0x' + bytesToHex(keccak_256(secp.getPublicKey(hexToBytes(priv), false).slice(1)).slice(-20));
  // signEip1559 takes the key as hex; the transaction's hash is the keccak of its signed bytes.
  const sign = (tx) => { const { raw } = evmTx.signEip1559(tx, priv); return { raw, hash: '0x' + bytesToHex(keccak_256(hexToBytes(raw))) }; };
  return { address, sign };
}
export const throwawayKey = () => '0x' + bytesToHex(secp.utils.randomPrivateKey());

class DryRun extends Error {}

export function makeRunner(cfg, { log = (...a) => console.log(`[runner ${new Date().toISOString()}]`, ...a), fetchImpl = (...a) => globalThis.fetch(...a), WS = globalThis.WebSocket } = {}) {
  const signer = makeSigner(cfg.key || throwawayKey());
  const from = signer.address;
  async function rpcAt(url, method, params) {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    let j = null;
    try { j = await res.json(); } catch { /* the status below */ }
    if (j?.error) throw new Error(`${method}: ${j.error.message}${typeof j.error.data === 'string' ? ` ${j.error.data}` : ''}`);
    if (!res.ok || !j) throw new Error(`${method}: HTTP ${res.status}`);
    return j.result;
  }
  const rpc = (method, params) => rpcAt(cfg.rpcUrl, method, params);
  const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
  const advance = makeHeaderRelayAdvance({ rpcUrl: cfg.rpcUrl, esploraUrl: cfg.esplora, statusUrl: `${cfg.api}/reflection/status?network=mainnet`, fetchImpl });
  const latestBlock = () => rpc('eth_getBlockByNumber', ['latest', false]);
  const baseFee = async () => BigInt((await latestBlock()).baseFeePerGas);
  // The call run from this key against the latest block: a revert throws, and nothing is signed.
  async function simulate(to, data, value = 0n) {
    const v = value ? { value: '0x' + value.toString(16) } : {};
    await rpc('eth_call', [{ from, to, data, ...v }, 'latest']);
    return BigInt(await rpc('eth_estimateGas', [{ from, to, data, ...v }]));
  }
  // The unpaid modes' gas ceiling, said once per mode while it holds them back.
  async function gasOk(mode) {
    if (!cfg.maxGasWei) return true;
    const base = await baseFee();
    if (gasAllows(base, cfg.maxGasWei)) return true;
    say(mode, `base fee ${gweiText(base)} gwei is above MAX_GAS_GWEI=${gweiText(cfg.maxGasWei)}: waiting`);
    return false;
  }

  // One transaction at a time from this key: the nonce is read once the previous one has its receipt (or its wait ran out).
  const receipts = new Map();
  let queue = Promise.resolve();
  function sendTx({ to, data, gas, label, value = 0n }) {
    if (cfg.dryRun) {
      log(`DRY_RUN would send ${label} to ${to}: ${(data.length - 2) / 2} bytes of data, gas limit ${gas}`);
      return Promise.reject(new DryRun());
    }
    const run = async () => {
      const [nonce, base] = await Promise.all([rpc('eth_getTransactionCount', [from, 'latest']), baseFee()]);
      const tx = { chainId: 1n, nonce: BigInt(nonce), maxPriorityFeePerGas: cfg.priorityWei, maxFeePerGas: base * 2n + cfg.priorityWei, gasLimit: gas, to, value, data };
      const { raw, hash } = signer.sign(tx);
      const got = await rpcAt(cfg.sendRpcUrl, 'eth_sendRawTransaction', [raw]);
      if (got && String(got).toLowerCase() !== hash) log(`${label}: the send endpoint answered ${got} for ${hash}`);
      log(`${label}: sent ${hash} (nonce ${BigInt(nonce)}, gas limit ${gas})`);
      const receipt = await waitReceipt(hash);
      receipts.set(hash, receipt);
      return hash;
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }
  async function waitReceipt(hash, ms = 180_000) {
    for (const t0 = Date.now(); Date.now() - t0 < ms;) {
      const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 4000));
    }
    return null;
  }
  const ok = (r) => r?.status === '0x1' || r?.status === 1;

  // Each mode's state line is said when it changes, so a quiet loop stays quiet.
  const said = new Map();
  function say(mode, msg) { if (cfg.once || said.get(mode) !== msg) { said.set(mode, msg); log(`${mode}: ${msg}`); } }

  async function headers() {
    const st = await advance.status();
    const pl = advance.plan({ ...st, need: cfg.headersNeed });
    const v = headersVerdict(st, pl, { minBehind: cfg.headersMinBehind, need: cfg.headersNeed });
    say('headers', v.why);
    if (!v.go || !(await gasOk('headers'))) return false;
    try {
      const r = await advance.runAdvance({
        need: cfg.headersNeed, fromAddress: from,
        send: ({ to, data, gas }) => sendTx({ to, data, gas, label: 'advanceTip' }),
        waitReceipt: async (h) => (receipts.has(h) ? receipts.get(h) : waitReceipt(h)),
        onBatches: (bs) => log(`headers: ${bs.length} batch(es): ${bs.map((b) => `${b.from} to ${b.to}`).join(', ')}`),
        onProgress: (p) => { if (p.skipped) log(`headers: ${p.from} to ${p.to} already on chain, passed over`); },
      });
      if (r.sent.length) log(`headers: the relay has block ${r.sent[r.sent.length - 1].to} (${r.sent.length} transaction(s))`);
      return r.sent.length > 0;
    } catch (e) {
      if (e instanceof DryRun) return false;
      throw e;
    }
  }

  async function attest() {
    const st = await advance.status();
    if (needsAncestry(st.reflectionLag)) {
      say('attest', `the proofs are ${st.reflectionLag} blocks behind the relay: ${ancestryCalls(st.reflectionLag)} advanceReflectionAncestry() call(s) set the checkpoint first`);
      if (!(await gasOk('attest'))) return false;
      let gas;
      try { gas = await simulate(POOL, SEL_ANCESTRY); } catch (e) { say('attest', `the pool would not take advanceReflectionAncestry() now (${String(e.message).slice(0, 140)})`); return false; }
      return sent('attest', 'advanceReflectionAncestry()', await settled(sendTx({ to: POOL, data: SEL_ANCESTRY, gas: (gas * 125n) / 100n, label: 'advanceReflectionAncestry()' })));
    }
    const read = await readProof({ api: cfg.api, call, fetchImpl });
    const v = attestVerdict(read, { afterMs: cfg.attestAfterMs });
    say('attest', v.why);
    if (!v.go || !(await gasOk('attest'))) return false;
    const data = encodeAttest(read.rec.publicValues, read.rec.proof);
    let gas;
    try { gas = await simulate(POOL, data); } catch (e) { say('attest', `the pool would not take it: ${attestRefusal(e.message) || String(e.message).slice(0, 140)}`); return false; }
    return sent('attest', `attestBitcoinStateProven (Bitcoin to ${read.rec.attestedTo})`, await settled(sendTx({ to: POOL, data, gas: (gas * 125n) / 100n, label: 'attestBitcoinStateProven' })));
  }

  // The board on Nostr (nostr-board.js), read at most once a minute; TAC's worth to a sender (community-ops.js readPrices), likewise.
  const nb = cfg.nostr && typeof WS === 'function' ? makeNostrBoard({ pool: POOL, relays: cfg.nostrRelays, WS }) : null;
  if (cfg.nostr && !nb && (cfg.modes.includes('settles') || cfg.modes.includes('mirror'))) log('Nostr board off: this Node has no WebSocket (use Node 22, or run with --experimental-websocket); the API\'s board alone');
  let nostrAt = 0, nostrJobs = null, pricesAt = 0, prices = null;
  async function nostrRead() {
    if (nb && Date.now() - nostrAt > 60_000) { nostrAt = Date.now(); nostrJobs = await nb.read().catch(() => nostrJobs); }
    return nostrJobs;
  }
  async function priced() {
    if (Date.now() - pricesAt > 60_000) { pricesAt = Date.now(); prices = await readPrices({ call }).catch(() => prices); }
    return prices;
  }
  // The API's board and Nostr's as one; either may be missing, not both.
  async function boards() {
    const [a, n] = await Promise.allSettled([readBoard({ api: cfg.api, fetchImpl }), nostrRead()]);
    const api = a.status === 'fulfilled' ? a.value.jobs : null, nostr = n.status === 'fulfilled' ? n.value : null;
    if (!api && !nostr) throw new Error(`neither the API's board nor the Nostr relays answered (${a.reason?.message || 'no relay'})`);
    return { api, nostr, jobs: mergeBoards(api, nostr) };
  }
  // The API's open jobs that no relay carries yet, posted from here: up to four a pass, each once an hour.
  const mirrored = new Map();
  async function mirrorJobs(api, nostr) {
    if (!nb || !api || !nostr) return 0;
    const on = new Set(nostr.map((j) => j.publicValues.toLowerCase())), now = Date.now();
    for (const [k, at] of mirrored) if (now - at > 3600_000) mirrored.delete(k);
    let n = 0;
    for (const j of api.filter((x) => x.status === 'open' && x.publicValues && x.proof && Array.isArray(x.memos) && !on.has(x.publicValues.toLowerCase()) && !mirrored.has(x.publicValues.toLowerCase())).slice(0, 4)) {
      mirrored.set(j.publicValues.toLowerCase(), now);
      if (cfg.dryRun) { log(`DRY_RUN would post job ${String(j.jobId).slice(0, 10)} (${j.type}) to ${nb.relays.length} Nostr relays`); n++; continue; }
      const r = await nb.post(j).catch(() => null);
      if (r?.relays.length) { n++; log(`mirror: job ${String(j.jobId).slice(0, 10)} (${j.type}) posted to ${r.relays.length} of ${nb.relays.length} Nostr relays`); }
    }
    return n;
  }
  async function mirror() {
    const { api, nostr } = await boards();
    if (!nb) { say('mirror', 'Nostr board off: nothing to copy to'); return false; }
    const n = await mirrorJobs(api, nostr);
    if (!n) say('mirror', api ? `the API's ${api.length} job(s) are on Nostr already, or none is open` : 'the API\'s board did not answer');
    return false;                                                   // (each pass waits its cadence: the relays are read at most once a minute)
  }

  const tried = new Map();                                          // jobId -> when the pool last refused it here: passed over for 10 minutes
  async function settles() {
    const b = await boards(), jobs = b.jobs, px = await priced();
    mirrorJobs(b.api, b.nostr).catch(() => {});
    if (!jobs.length) { say('settles', 'nothing waiting on the board'); return false; }
    // Deadlines are the chain's: a job is judged by the latest block's time, as the pool judges it.
    const blk = await latestBlock(), nowMs = Number(BigInt(blk.timestamp)) * 1000, unit = BigInt(blk.baseFeePerGas) + cfg.priorityWei, now = Date.now();
    const s = boardSummary(jobs, { nowMs, prices: px });
    if (!s.waiting) { say('settles', `${jobs.length} on the board, none open to send`); return false; }
    const skip = new Set([...tried].filter(([, at]) => now - at < 10 * 60_000).map(([id]) => id));
    const job = pickSettle(jobs, { costWei: SETTLE_GAS * unit, marginBps: cfg.marginBps, nowMs, skip, prices: px });
    if (!job) { say('settles', `${s.waiting} waiting (${ethText(s.feeWei)} ETH in fees): none pays its gas at ${gweiText(unit)} gwei with MARGIN_BPS=${cfg.marginBps} to spare`); return false; }
    const data = settleCalldata(job), fee = feeWeiOf(job.publicValues, px);
    let gas;
    try { gas = await simulate(POOL, data); } catch (e) { tried.set(job.jobId, now); say('settles', `job ${job.jobId.slice(0, 10)}: the pool would not take it now (${String(e.message).slice(0, 120)})`); return true; }
    if (!feeCovers(fee, gas * unit, cfg.marginBps)) { tried.set(job.jobId, now); say('settles', `job ${job.jobId.slice(0, 10)}: at its own estimate of ${gas} gas its fee of ${ethText(fee)} ETH no longer pays with the margin`); return true; }
    say('settles', `job ${job.jobId.slice(0, 10)} (${job.type}): pays ${ethText(fee)} ETH, about ${ethText(gas * unit)} ETH of gas`);
    const r = await settled(sendTx({ to: POOL, data, gas: (gas * 12n) / 10n, label: `settle ${job.jobId.slice(0, 10)}` }));
    if (!r || !ok(r.receipt)) { tried.set(job.jobId, now); return sent('settles', `settle ${job.jobId.slice(0, 10)}`, r); }
    // (a job read from Nostr alone has no API record: the chain is its record)
    const rep = job.via === 'nostr' ? { ok: true, nostr: true } : await reportLanded({ api: cfg.api, fetchImpl, jobId: job.jobId, txHash: r.hash }).catch((e) => ({ ok: false, status: e.message }));
    log(`settles: job ${job.jobId.slice(0, 10)} landed in block ${BigInt(r.receipt.blockNumber)}, ${ethText(fee)} ETH of fees to ${from}; ${rep.nostr ? 'read from Nostr' : `reported ${rep.ok ? 'and recorded' : `(the API answered ${rep.status})`}`}`);
    return true;
  }

  // Prove: the proof market's open orders (worker/src/proof-market-queue.js, contracts/src/ProofMarket.sol). One order a pass: it is claimed (which
  // excludes other provers for the claim window) while its input is proved on this machine, then fulfilled, and the market pays this key in TAC from
  // the holder's permit in the same transaction the pool takes the proof. The proof is in the fulfil's calldata, so SEND_RPC_URL should be private.
  const DONE = '0x388a3cf5', CLAIMS = '0xeff0f592', BOND = '0xc7cf7484';
  const jget = async (url, init) => { const r = await fetchImpl(url, init); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || `${url} answered ${r.status}`); return b; };
  const proveSolver = makeMarketSolver({
    me: from, minPrice: cfg.minTacWei, retryMs: 120_000, log: (m) => log(`prove: ${m}`),
    listOrders: async () => (await jget(`${cfg.api}/market/orders?limit=20`)).orders || [],
    depositStatus: async (id) => BigInt(await call(POOL, '0x7da9874f' + id.slice(2))),
    done: async (id) => BigInt(await call(cfg.marketAddr, DONE + id.slice(2))) === 1n,
    claimOf: async (id) => { const r = String(await call(cfg.marketAddr, CLAIMS + id.slice(2))).slice(2); const solver = '0x' + r.slice(24, 64); return /^0x0+$/.test(solver) ? null : { solver, until: Number(BigInt('0x' + r.slice(64, 128))) }; },
    claim: async (o) => {
      const bond = BigInt(await call(cfg.marketAddr, BOND)), data = encodeClaim(o), gas = await simulate(cfg.marketAddr, data, bond);
      const r = await settled(sendTx({ to: cfg.marketAddr, data, gas: (gas * 12n) / 10n, value: bond, label: `claim ${o.intent.opId.slice(0, 10)}` }));
      if (!r) return null;                                   // a dry run
      if (!ok(r.receipt)) throw new Error('the claim did not land');
      return r.hash;
    },
    prove: async (o) => {
      const { id } = await jget(`${cfg.deviceProver}/prove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'wrap', stdin: o.stdin }) });
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await jget(`${cfg.deviceProver}/job?id=${encodeURIComponent(id)}`);
        if (s.status === 'done') return { publicValues: s.publicValues, proof: s.proof };
        if (s.status === 'failed') throw new Error(s.error || 'tacit-prover could not make the proof');
      }
    },
    fulfil: async (o, p) => {
      const data = encodeFulfill(o, p.proof), gas = await simulate(cfg.marketAddr, data);
      const r = await settled(sendTx({ to: cfg.marketAddr, data, gas: (gas * 12n) / 10n, label: `fulfil ${o.intent.opId.slice(0, 10)}` }));
      if (!r) return null;
      if (!ok(r.receipt)) throw new Error('the fulfil did not land');
      return r.hash;
    },
    clear: (id) => jget(`${cfg.api}/market/done`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: id }) }),
  });
  async function prove() { return proveSolver.pass(); }

  // The board's public jobs, raced against Tacit's own prover: claim one, prove it beside this runner, hand the proof back. The board keeps
  // it as a candidate; the relay checks it and takes the first that passes.
  const miner = (cfg.miner || from).toLowerCase();
  let lastProveMs = null;
  const boardPost = (path, body) => jget(`${cfg.api}/prover/community/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ miner, ...body }) });
  async function board() {
    const { job } = await boardPost('claim', {});
    if (!job) return false;
    const left = job.deadline * 1000 - Date.now();
    if (lastProveMs != null && lastProveMs > left) {
      log(`board: ${job.label || 'a job'} is due in ${Math.round(left / 1000)} s and this machine's last proof took ${Math.round(lastProveMs / 1000)} s: left to a faster one`);
      await boardPost('result', { jobId: job.jobId, error: 'too slow for its deadline' }).catch(() => {});
      return false;
    }
    const t0 = Date.now();
    try {
      const stdinHex = '0x' + Buffer.from(job.stdin, 'base64').toString('hex');
      const { id } = await jget(`${cfg.deviceProver}/prove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stdin: stdinHex }) });
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await jget(`${cfg.deviceProver}/job?id=${encodeURIComponent(id)}`);
        if (s.status === 'done') {
          lastProveMs = Date.now() - t0;
          const r = await boardPost('result', { jobId: job.jobId, publicValues: s.publicValues, proof: s.proof });
          log(`board: ${job.label || job.jobId.slice(0, 10)} proved in ${Math.round(lastProveMs / 1000)} s: ${r.status || r.error}`);
          return true;
        }
        if (s.status === 'failed') throw new Error(s.error || 'tacit-prover could not make the proof');
        if (Date.now() > job.deadline * 1000) throw new Error('its deadline passed while it was proved');
      }
    } catch (e) {
      log(`board: ${job.label || job.jobId.slice(0, 10)}: ${e.message}`);
      await boardPost('result', { jobId: job.jobId, error: String(e.message).slice(0, 200) }).catch(() => {});
      return false;
    }
  }

  // A send's outcome: null for a dry run, else { hash, receipt } (receipt null when it was not included in time).
  async function settled(p) {
    try { const hash = await p; return { hash, receipt: receipts.get(hash) ?? null }; }
    catch (e) { if (e instanceof DryRun) return null; throw e; }
  }
  function sent(mode, label, r) {
    if (!r) return false;
    if (!r.receipt) log(`${mode}: ${label} ${r.hash} not included within 3 minutes; it may still land`);
    else if (!ok(r.receipt)) log(`${mode}: ${label} ${r.hash} reverted`);
    else log(`${mode}: ${label} landed in block ${BigInt(r.receipt.blockNumber)} (${r.hash})`);
    return !!r.receipt;
  }

  async function start() {
    const [chain, bal, code] = await Promise.all([rpc('eth_chainId', []), rpc('eth_getBalance', [from, 'latest']), rpc('eth_getCode', [from, 'latest'])]);
    if (Number(chain) !== 1) throw new Error(`RPC_URL is on chain ${Number(chain)}, not Ethereum mainnet`);
    log(`${cfg.dryRun ? 'DRY_RUN: nothing is sent. ' : ''}${cfg.key ? 'key' : 'throwaway key'} ${from}, ${ethText(BigInt(bal))} ETH; modes ${cfg.modes.join(', ')}; sends to ${new URL(cfg.sendRpcUrl).host}`);
    if (!cfg.dryRun && BigInt(bal) === 0n && cfg.modes.some((m) => m !== 'mirror' && m !== 'board')) log('this key holds no ETH: every send would fail until it has some for gas');
    // The board pays its fees in ETH to the sending account; an account with code (an EIP-7702 delegation) runs that code on them.
    if (code && code !== '0x') log(`${from} has code (${code.slice(0, 10)}…): the board's ETH fees go to that code. Use a fresh key`);
  }

  return { from, start, passes: { headers, attest, settles, prove, board, mirror } };
}

async function main() {
  let cfg;
  try { cfg = readConfig(); } catch (e) { console.error(e.message); process.exit(2); }
  const runner = makeRunner(cfg);
  await runner.start();
  let failed = 0;
  // Each mode its own loop: a pass that did something goes again at once, one that did not waits its cadence.
  await Promise.all(cfg.modes.map(async (mode) => {
    for (;;) {
      let worked = false;
      try { worked = await runner.passes[mode](); } catch (e) { failed++; console.log(`[runner ${new Date().toISOString()}] ${mode}: pass failed: ${e.message}`); }
      if (cfg.once) return;
      if (!worked) await new Promise((r) => setTimeout(r, cfg.secs[mode] * 1000));
    }
  }));
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
