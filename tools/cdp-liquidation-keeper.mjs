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
// is fail-safe (op rejected, no wrong fund movement). Run against a deployed pool+engine. The box needs an
// exec-cdpliquidate.rs harness/serializer (rides the re-prove) for the proof to be produced.
//
// Usage: KEEPER_PRIV=0x.. [NETWORK=signet] [BTC_USD_FEED=0x..] [MIN_HEALTH_BPS=12500] [ONCE=1]
//        node tools/cdp-liquidation-keeper.mjs

import { secp, sha256, keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { makeConfidentialCdp } from '../dapp/confidential-cdp.js';
import { makeConfidentialDefiActions } from '../dapp/confidential-defi-actions.js';
import { getConfidentialDeployment, setActiveNetwork } from '../dapp/confidential-deployments.js';

const NETWORK = process.env.NETWORK || 'signet';
setActiveNetwork(NETWORK);
const KEEPER_PRIV = process.env.KEEPER_PRIV;
if (!KEEPER_PRIV) { console.error('set KEEPER_PRIV'); process.exit(2); }
const ONCE = process.env.ONCE === '1';
const POLL_MS = Number(process.env.POLL_MS || 60000);

// ── ABI word helpers (read-only PublicValues decode) ──
const strip = (h) => String(h).replace(/^0x/, '');
const wordAt = (hex, i) => hex.slice(i * 64, i * 64 + 64);
const wBig = (w) => BigInt('0x' + w);
const wHex = (w) => '0x' + w;
const wAddr = (w) => '0x' + w.slice(24);

// Decode the cdpMints[] + retired position-nullifiers from one settle's publicValues bytes (hex, no 0x).
// PublicValues field order (see ConfidentialPool.sol): cdpMints is field 22, cdpCloses 23, cdpLiquidations 24.
function decodeSettlePositions(pvHex, cdp) {
  const out = { mints: [], retired: new Set() };
  const arrAt = (fieldIdx) => wBig(wordAt(pvHex, fieldIdx)) * 2n; // byte offset → word offset (÷32 = ×2 nibblewords/... )
  // helper: offset (bytes) from a word value → starting WORD index into pvHex
  const wordIdx = (byteOff) => Number(byteOff) / 32;
  const readNullifiers = (fieldIdx, nfIndexInStruct, structIsDynamic) => {
    const off = Number(wBig(wordAt(pvHex, fieldIdx))) / 32;
    const len = Number(wBig(wordAt(pvHex, off)));
    for (let e = 0; e < len; e++) {
      // dynamic struct array → element offsets relative to (off+1)
      const elemOff = off + 1 + Number(wBig(wordAt(pvHex, off + 1 + e))) / 32;
      out.retired.add(wHex(wordAt(pvHex, elemOff + nfIndexInStruct)));
    }
  };
  try {
    // cdpMints (field 22): dynamic array of dynamic struct.
    const off = Number(wBig(wordAt(pvHex, 22))) / 32;
    const len = Number(wBig(wordAt(pvHex, off)));
    for (let e = 0; e < len; e++) {
      const base = off + 1 + Number(wBig(wordAt(pvHex, off + 1 + e))) / 32; // element start word
      const controller = wAddr(wordAt(pvHex, base + 0));
      const debtValue = wBig(wordAt(pvHex, base + 2));
      const positionLeaf = wHex(wordAt(pvHex, base + 3));
      const rateSnapshot = wHex(wordAt(pvHex, base + 4));
      const legsOff = base + Number(wBig(wordAt(pvHex, base + 5))) / 32; // legs offset relative to element start
      const owner = wHex(wordAt(pvHex, base + 6));
      const nLegs = Number(wBig(wordAt(pvHex, legsOff)));
      const legs = [];
      for (let l = 0; l < nLegs; l++) {
        const a = legsOff + 1 + l * 2;
        legs.push({ asset: wHex(wordAt(pvHex, a)), value: wBig(wordAt(pvHex, a + 1)) });
      }
      if (BigInt(positionLeaf) > 1n) out.mints.push({ controller, owner, debtValue, rateSnapshot, positionLeaf, legs });
    }
    // cdpCloses (23) + cdpLiquidations (24): positionNullifier is struct field index 4.
    readNullifiers(23, 4);
    readNullifiers(24, 4);
  } catch (e) { /* tolerate a partial/odd settle; the position just isn't surfaced this round */ }
  void arrAt; void wordIdx;
  return out;
}

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

  async function tick() {
    // 1. enumerate from CdpPositionInserted settle txs.
    const fb = '0x' + Number(cfg.deployBlock || 0).toString(16);
    const topic0 = '0x' + [...keccak_256(new TextEncoder().encode('CdpPositionInserted(bytes32)'))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const logs = await ux.rpc('eth_getLogs', [{ address: cfg.pool, fromBlock: fb, toBlock: 'latest', topics: [topic0] }]);
    const txs = [...new Set((logs || []).map((l) => l.transactionHash))];
    const mints = [], retired = new Set();
    for (const tx of txs) {
      const t = await ux.rpc('eth_getTransactionByHash', [tx]);
      if (!t || !t.input) continue;
      // settle(bytes publicValues, bytes proof, bytes[] memos): strip selector, read arg0 (bytes) offset+len.
      const data = strip(t.input).slice(8);
      const pvOff = Number(wBig(wordAt(data, 0))) / 32;
      const pvLen = Number(wBig(wordAt(data, pvOff)));
      const pvHex = data.slice((pvOff + 1) * 64, (pvOff + 1) * 64 + pvLen * 2);
      const dec = decodeSettlePositions(pvHex, cdp);
      mints.push(...dec.mints);
      for (const n of dec.retired) retired.add(n);
    }
    const open = mints.filter((m) => !retired.has(cdp.positionNullifier(m.positionLeaf)));
    if (!open.length) { console.error(`[keeper] ${new Date().toISOString()} no open positions`); return; }

    const price = await btcUsd8();   // BTC/USD, 8-dec
    const liqBps = await liqRatioBps();
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
      for (const n of cusd) { debtNotes.push({ cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner }); sum += BigInt(n.value); if (sum >= debtUsd) break; }
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
