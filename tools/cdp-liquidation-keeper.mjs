#!/usr/bin/env node
// CDP liquidation keeper — permissionlessly seizes undercollateralized cUSD positions.
//
// HOW IT WORKS (enabled by the owner-published / nonce-0 CDP change):
//   1. Enumerate positions: scan CdpPositionInserted logs for the settle txs that opened positions, decode
//      each settle's PublicValues.cdpMints (controller, owner, debtValue, rateSnapshot, legs[]) — owner is
//      public + nonce is 0, so the keeper can reconstruct each position leaf. Drop positions whose
//      positionNullifier appears in any cdpCloses/cdpLiquidations (already retired).
//   2. Price + health: read Chainlink BTC/USD (latestRoundData, staleness-gated like the engine) and the
//      engine's liqRatioBps; a position is seizable when collateral_usd · 10000 < debt · liqRatioBps.
//   3. Liquidate: supply the keeper's own cUSD notes (≥ debt), build OP_CDP_LIQUIDATE, settle gasless via the
//      relay; the basket is seized to the keeper (public withdrawals → tacBTC). onCdpLiquidate reverts if
//      healthy, so a stale read is fail-safe (the proof just won't settle).
//
// VERIFICATION: the action path (buildCdpLiquidateOp → liquidateCdp) is guest-verified — a decode/price bug
// is fail-safe (op rejected, no wrong fund movement). The exec-cdpliquidate prover binary IS deployed on the
// relay (worker-relay/prover/bin/), so the proof path is live; `cdpliquidate` is likewise in the worker's
// submit allowlist and the relay's PEROP map.
//
// STATUS: this is a SCRIPT, not a deployed service — worker-relay/render.yaml runs no keeper. Liquidations
// only happen while somebody runs this. It also needs cUSD INVENTORY: onCdpLiquidate burns notes summing to
// the FULL accrued debt (no partial liquidation, no auction), so a keeper holding no cUSD cannot act at all
// and must source it first.
//
// NETWORK defaults to signet — pass NETWORK=mainnet explicitly to run against the live deployment.
//
// ALERTS: each tick also says which open loans have come within NEAR_FALL percent of the liquidation line (a line starting ALERT, and, with
// ALERT_WEBHOOK set, a POST of {"text": "..."} there), once for each approach (a loan that backs off is told again if it returns; ALERT_STATE=<file>
// keeps what was told across restarts). Loans are named by the first eight digits of their position leaf, which the vault page shows beside each
// loan. ALERT_ONLY=1 does only this: no key, no cUSD, no liquidation, nothing but reads.
//
// Usage: KEEPER_PRIV=0x.. [NETWORK=signet|mainnet] [BTC_USD_FEED=0x..] [MIN_HEALTH_BPS=12500] [ONCE=1]
//        [ALERT_WEBHOOK=https://...] [ALERT_STATE=<file>]
//        node tools/cdp-liquidation-keeper.mjs
//        ALERT_ONLY=1 NETWORK=mainnet BTC_USD_FEED=0x.. [ALERT_WEBHOOK=..] node tools/cdp-liquidation-keeper.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { secp, sha256, keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { boardPlan } from './cdp-near-board.mjs';
import { strip, wordAt, wBig, decodeSettlePositions } from './cdp-positions.mjs';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { makeConfidentialCdp } from '../dapp/confidential-cdp.js';
import { makeConfidentialDefiActions } from '../dapp/confidential-defi-actions.js';
import { getConfidentialDeployment, setActiveNetwork } from '../dapp/confidential-deployments.js';

const NETWORK = process.env.NETWORK || 'signet';
setActiveNetwork(NETWORK);
const ALERT_ONLY = process.env.ALERT_ONLY === '1', ALERT_WEBHOOK = process.env.ALERT_WEBHOOK, ALERT_STATE = process.env.ALERT_STATE;
// alert-only never signs or spends: the identity the shared code asks for is a fixed throwaway
const KEEPER_PRIV = process.env.KEEPER_PRIV || (ALERT_ONLY ? '0x' + '11'.repeat(32) : '');
if (!KEEPER_PRIV) { console.error('set KEEPER_PRIV (or ALERT_ONLY=1)'); process.exit(2); }
const ONCE = process.env.ONCE === '1';
const POLL_MS = Number(process.env.POLL_MS || 60000);


async function main() {
  const cfg = getConfidentialDeployment(NETWORK);
  if (!cfg || !cfg.pool) { console.error(`no pool deployed on ${NETWORK}`); process.exit(1); }
  if (!cfg.collateralEngine) { console.error('no CollateralEngine configured — CDP not live'); process.exit(1); }
  const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: NETWORK });
  const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool });
  const defi = makeConfidentialDefiActions({
    pool: ux.pool, cdp, farm: null, relay: ux.relay,
    id: ux.identity(KEEPER_PRIV), chainBindingHex: ux.chainBindingHex, secp,
  });
  const keeperAddr = ux.account(KEEPER_PRIV).address;
  const debtAsset = cdp.debtAssetId(cfg.collateralEngine);
  const feedAddr = process.env.BTC_USD_FEED; // Chainlink BTC/USD (8-dec); required for off-chain pricing
  const _sel = (sig) => '0x' + [...keccak_256(new TextEncoder().encode(sig))].slice(0, 4).map((x) => x.toString(16).padStart(2, '0')).join('');

  // engine.liqRatioBps() (public getter).
  async function liqRatioBps() {
    const r = await ux.ethCall(cfg.collateralEngine, _sel('liqRatioBps()'));
    return BigInt(r || '0x30d4'); // default 12500
  }
  // Chainlink BTC/USD price (8-dec), staleness-gated like the engine.
  async function btcUsd8() {
    if (!feedAddr) throw new Error('set BTC_USD_FEED to price collateral');
    const r = await ux.ethCall(feedAddr, _sel('latestRoundData()'));
    const h = strip(r);
    const answer = wBig(wordAt(h, 1));        // int256 answer
    const updatedAt = wBig(wordAt(h, 3));
    const now = BigInt(Math.floor(Date.now() / 1000));
    const maxStale = BigInt(process.env.MAX_STALENESS || (NETWORK === 'mainnet' ? 3900 : 86400));
    if (answer <= 0n) throw new Error('feed: non-positive');
    if (now - updatedAt > maxStale) throw new Error('feed: stale');
    return answer;
  }

  // engine.currentDebt(principal, snapshot): what a position owes now (its principal while no fee has accrued). A failed read says the principal.
  const word = (v) => (typeof v === 'bigint' ? v.toString(16) : strip(v)).padStart(64, '0');
  async function owedNow(p) {
    try { return BigInt(await ux.ethCall(cfg.collateralEngine, _sel('currentDebt(uint256,uint256)') + word(p.debtValue) + word(p.rateSnapshot))); } catch { return p.debtValue; }
  }
  // eth_getLogs over the whole life of the pool is refused on public nodes (a 50,000-block limit) or comes back empty: the range is asked in chunks, what was
  // found is kept between ticks, and a chunk that fails ends the tick (it must never read as "no positions").
  const LOG_CHUNK = Number(process.env.LOG_CHUNK || 40000);
  const scan = { next: Number(cfg.deployBlock || 0), txs: new Set(), done: new Map(), spent: new Set() };
  async function newPositionTxs(topic0) {
    const head = parseInt(await ux.rpc('eth_blockNumber', []), 16);
    for (let a = scan.next; a <= head; a += LOG_CHUNK) {
      const b = Math.min(a + LOG_CHUNK - 1, head);
      const r = await ux.rpc('eth_getLogs', [{ address: cfg.pool, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16), topics: [topic0] }]);
      if (!Array.isArray(r)) throw new Error(`eth_getLogs ${a}-${b} gave no answer`);
      for (const l of r) scan.txs.add(l.transactionHash);
      scan.next = b + 1;
    }
  }
  // the pool's cdpPositionSpent mapping (storage slot 163, as the dapp reads it): true once a position is closed or liquidated
  const bytes32 = (h) => Uint8Array.from(Buffer.from(strip(h).padStart(64, '0'), 'hex'));
  async function positionSpent(nullifier) {
    const key = '0x' + Buffer.from(keccak_256(Uint8Array.from([...bytes32(nullifier), ...bytes32('0xa3')]))).toString('hex');
    return BigInt((await ux.rpc('eth_getStorageAt', [cfg.pool, key, 'latest'])) || '0x0') !== 0n;
  }
  let seen = [];
  try { if (ALERT_STATE) seen = JSON.parse(readFileSync(ALERT_STATE, 'utf8')); } catch { /* first run, or a file that is not there yet */ }
  async function say(text) {
    console.error('ALERT ' + text);
    if (ALERT_WEBHOOK) {
      try { await fetch(ALERT_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) }); }
      catch (e) { console.error('  alert webhook failed:', e && e.message || e); }
    }
  }
  async function board(open, price, liqBps) {
    const rows = [];
    for (const p of open) rows.push({ leaf: p.positionLeaf, debt: await owedNow(p), sats: p.legs.reduce((s, l) => s + l.value, 0n) });
    const { lines, keep } = boardPlan(rows, { price, liqBps, seen });
    for (const text of lines) await say(text);
    seen = keep;
    try { if (ALERT_STATE) writeFileSync(ALERT_STATE, JSON.stringify(keep)); } catch (e) { console.error('  alert state not saved:', e && e.message || e); }
  }

  async function tick() {
    // 1. enumerate from CdpPositionInserted settle txs.
    const topic0 = '0x' + [...keccak_256(new TextEncoder().encode('CdpPositionInserted(bytes32)'))].map((x) => x.toString(16).padStart(2, '0')).join('');
    await newPositionTxs(topic0);
    const mints = [], retired = new Set();
    for (const tx of scan.txs) {
      let dec = scan.done.get(tx);
      if (!dec) {
        const t = await ux.rpc('eth_getTransactionByHash', [tx]);
        if (!t || !t.input) continue;
        // settle(bytes publicValues, bytes proof, bytes[] memos): strip selector, read arg0 (bytes) offset+len.
        const data = strip(t.input).slice(8);
        const pvOff = Number(wBig(wordAt(data, 0))) / 32;
        const pvLen = Number(wBig(wordAt(data, pvOff)));
        const pvHex = data.slice((pvOff + 1) * 64, (pvOff + 1) * 64 + pvLen * 2);
        dec = decodeSettlePositions(pvHex, cdp);
        scan.done.set(tx, dec);
      }
      mints.push(...dec.mints);
      for (const n of dec.retired) retired.add(n);
    }
    // a position is open until the pool says its nullifier is spent (a close or a liquidation is a settle that inserts no position, so the settles read
    // above do not all show it)
    const open = [];
    for (const m of mints) {
      const nf = cdp.positionNullifier(m.positionLeaf);
      if (retired.has(nf) || scan.spent.has(nf) || await positionSpent(nf)) { scan.spent.add(nf); continue; }
      open.push(m);
    }
    // what the engine owes against what was found: the loans' principal adds up to its outstanding cUSD, or a position is not being seen
    const principal = open.reduce((s, m) => s + m.debtValue, 0n);
    let engineOut = null;
    try { engineOut = BigInt(await ux.ethCall(cfg.collateralEngine, _sel('outstandingCusd()'))); } catch { /* the line below says it could not be read */ }
    console.error(`[keeper] ${new Date().toISOString()} ${open.length} open positions, principal ${principal} cUSD base units; engine outstanding ${engineOut ?? 'unread'}${engineOut != null && engineOut !== principal ? ' — DIFFERENT: a position is not being seen, or one is not what it was read as' : ''}`);
    if (!open.length) return;

    const price = await btcUsd8();   // BTC/USD, 8-dec
    const liqBps = await liqRatioBps();
    await board(open, price, liqBps);
    if (ALERT_ONLY) { console.error(`[keeper] ${new Date().toISOString()} ${open.length} open positions looked at`); return; }
    const posTree = await ux.cdpPositionTree();
    const { notes } = await ux.balance(KEEPER_PRIV);
    const cusd = (notes || []).filter((x) => x.asset.toLowerCase() === debtAsset.toLowerCase());

    for (const p of open) {
      // collateral USD (8-dec): Σ cBTC legs (8-dec sats→BTC) × price. cBTC value is in 8-dec base units.
      const collatBtc = p.legs.reduce((s, l) => s + l.value, 0n); // 8-dec BTC units
      const collatUsd = (collatBtc * price) / (10n ** 8n);        // 8-dec USD
      const debtUsd = p.debtValue;                                // cUSD is 8-dec, 1:1 USD
      const healthy = collatUsd * 10000n >= debtUsd * liqBps;
      if (healthy) continue;
      console.error(`[keeper] SEIZABLE position ${p.positionLeaf.slice(0, 14)} debt=${debtUsd} collatUsd=${collatUsd}`);
      // gather keeper cUSD ≥ debt
      const debtNotes = []; let sum = 0n;
      // `nk: n.secret` — each burned debt note's own secret nullifier key. input_leaf_authed's native
      // branch requires it to nullify the note; without it the guest's assert fails silently
      // (EXECUTE_OK, pv_bytes = 0) rather than the settle erroring out here.
      for (const n of cusd) { debtNotes.push({ cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner, nk: n.secret }); sum += BigInt(n.value); if (sum >= debtUsd) break; }
      if (sum < debtUsd) { console.error(`  skip: keeper holds ${sum} cUSD < ${debtUsd}`); continue; }
      const positionIndex = posTree.indexOf(p.positionLeaf);
      if (positionIndex < 0) { console.error('  skip: position not in tree yet'); continue; }
      // RELAYED (gasless) by default: carve a relay fee from the first seized leg so the box settles and the
      // keeper needs no ETH. SELF_SETTLE=1 (or a leg-0 too small for a fee) falls back to box-prove +
      // keeper-submitted settle. The fee is FEE_BPS of leg 0 (default 30 bps), floored below leg-0 value.
      const leg0 = p.legs[0] ? p.legs[0].value : 0n;
      const feeBps = BigInt(process.env.FEE_BPS || 30);
      let fee = process.env.SELF_SETTLE === '1' ? 0n : (leg0 * feeBps + 9999n) / 10000n;
      if (fee >= leg0) fee = 0n; // too small to carve a fee → self-settle
      try {
        const res = await defi.liquidateCdp({
          controller: p.controller, owner: p.owner, debtValue: debtUsd, rateSnapshot: p.rateSnapshot,
          basket: p.legs, positionIndex, positionPath: posTree.pathFor(positionIndex).path,
          spendRoot: (cusd[0] || {}).root, cdpPositionRoot: posTree.root, liquidator: keeperAddr, debtNotes, fee,
          waitOpts: { onUpdate: (st) => console.error(`  ${fee > 0n ? 'settle' : 'prove'} ${st.status}`) },
        });
        if (fee > 0n) {
          console.error(`  liquidated (relayed) → seized ${collatBtc - fee} cBTC to ${keeperAddr}, ${fee} fee to box`);
        } else {
          if (!res || !res.publicValues || !res.proof) { console.error('  skip: prove returned no proof'); continue; }
          const r = await ux.submitSettle({ settlerPriv: KEEPER_PRIV, publicValues: res.publicValues, proof: res.proof, memos: [] });
          console.error(`  liquidated (self-settle) → seized ${collatBtc} cBTC to ${keeperAddr} (${r.txHash})`);
        }
      } catch (e) { console.error('  liquidate failed:', e && e.message || e); }
    }
  }

  console.error(`[keeper] cdp-liquidation on ${NETWORK} pool=${cfg.pool} engine=${cfg.collateralEngine} keeper=${keeperAddr}`);
  do { try { await tick(); } catch (e) { console.error('[keeper] tick error:', e && e.message || e); } if (!ONCE) await new Promise((r) => setTimeout(r, POLL_MS)); } while (!ONCE);
}

main().catch((e) => { console.error(e); process.exit(1); });
