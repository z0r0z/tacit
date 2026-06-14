#!/usr/bin/env node
// Cross-chain confidential orderbook (ops/PLAN-confidential-adaptor-swap.md). Locks: posting +
// best-price matching across the two lanes; partial fills at exact price multiples; the lifecycle
// (cancel maker-only, expiry); resolver-gated asset recognition; and — end-to-end — that a FILL yields
// a drivable adaptor swap whose completed legs are accepted by the REAL kernel verifier (verifySchnorr).
//
// Run: node tests/cross-chain-orderbook.mjs

import { createHash } from 'node:crypto';
import assert from 'node:assert';
import { verifySchnorr, modN } from '../dapp/bulletproofs.js';
import { makeCrossChainAssets } from '../dapp/cross-chain-asset-resolver.js';
import { makeAdaptorSwap } from '../dapp/adaptor-swap.js';
import { completedSig } from '../dapp/adaptor-signature.js';
import { makeCrossChainOrderbook } from '../dapp/cross-chain-orderbook.js';

const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const sha256 = (b) => createHash('sha256').update(Buffer.from(b)).digest();
const sc = (tag) => modN(BigInt('0x' + Buffer.from(sha(tag)).toString('hex'))) || 1n;
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const TAC = '0x' + 'aa'.repeat(32), tETH = '0x' + 'bb'.repeat(32);

// resolver knows both assets on both lanes (so cross-chain offers validate)
const X = makeCrossChainAssets({ sha256 });
X.ingestBitcoin({ assetIdHex: TAC, ticker: 'TAC', decimals: 8 });
X.ingestEvm({ assetIdHex: TAC, ticker: 'TAC', decimals: 8, canonicalErc20: '0x' + 'ee'.repeat(20) }, 1);
X.ingestBitcoin({ assetIdHex: tETH, ticker: 'tETH', decimals: 8 });
X.ingestEvm({ assetIdHex: tETH, ticker: 'tETH', decimals: 8, canonicalErc20: '0x' + 'ff'.repeat(20) }, 1);

// ── 1. post + best-price matching across lanes ──
{
  const ob = makeCrossChainOrderbook({ resolver: X });
  // maker A: give 100 TAC (bitcoin) want 10 tETH (ethereum)  → 10 TAC per tETH
  const a = ob.post({ maker: 'A', giveAsset: TAC, giveAmount: 100n, giveLane: 'bitcoin', wantAsset: tETH, wantAmount: 10n, wantLane: 'ethereum' });
  // maker B: give 90 TAC want 10 tETH  → 9 TAC per tETH (better for a TAC seller; worse for a TAC buyer)
  const b = ob.post({ maker: 'B', giveAsset: TAC, giveAmount: 90n, giveLane: 'bitcoin', wantAsset: tETH, wantAmount: 10n, wantLane: 'ethereum' });
  assert.strictEqual(ob.book().length, 2, 'two live offers');
  // a taker GIVES tETH to GET TAC → matches both; best = most TAC per tETH = maker A (100/10 > 90/10)
  const q = ob.quote({ giveAsset: tETH, wantAsset: TAC });
  assert.strictEqual(q.length, 2, 'both offers match the opposite pair');
  assert.strictEqual(q[0].offer.id, a, 'best price first = the offer giving more TAC per tETH');
  ok('post + best-price matching across lanes (taker gives tETH, receives TAC; best offer ranks first)');
}

// ── 2. partial fill at an exact price multiple; remaining decremented; fill yields a drivable swap ──
{
  const ob = makeCrossChainOrderbook({ resolver: X });
  const id = ob.post({ maker: 'M', giveAsset: TAC, giveAmount: 100n, giveLane: 'bitcoin', wantAsset: tETH, wantAmount: 10n, wantLane: 'ethereum' });
  // taker takes 50 TAC (half) → pays 50·10/100 = 5 tETH
  const f = ob.fill(id, { taker: 'T', takeGive: 50n, t: sc('taker-t'), nearDeadline: 100, farDeadline: 200 });
  assert.strictEqual(f.legs.initiator.amount, 5n, 'taker (initiator) pays 5 tETH');
  assert.strictEqual(f.legs.responder.amount, 50n, 'maker (responder) pays 50 TAC');
  assert.strictEqual(ob.get(id).remaining, 50n, 'offer remaining decremented to 50 TAC');

  // drive the returned swap end-to-end → both legs accepted by the real kernel verifier
  const sw = makeAdaptorSwap();
  const mI = sha('taker pays 5 tETH'), mR = sha('maker pays 50 TAC');
  sw.lock(f.swap, 'initiator', { dPriv: sc('taker-key'), msg32: mI, nonce: sc('nI') });
  const lr = sw.lock(f.swap, 'responder', { dPriv: sc('maker-key'), msg32: mR, nonce: sc('nR') });
  const li = f.swap.legs.initiator;
  assert.ok(sw.ready(f.swap), 'both legs lock + verify');
  const { s: claimS, sig: sigR } = sw.claim(f.swap);
  assert.strictEqual(verifySchnorr(sigR, mR, lr.Px), true, 'claim leg verifies (real kernel verifier)');
  const { sig: sigI } = sw.counterclaim(f.swap, claimS);
  assert.strictEqual(verifySchnorr(sigI, mI, li.Px), true, 'counterclaim leg verifies (real kernel verifier)');
  ok('a partial fill yields a drivable adaptor swap; both completed legs pass verifySchnorr');
}

// ── 3. fill rejections: out-of-range take + non-exact price multiple ──
{
  const ob = makeCrossChainOrderbook({ resolver: X });
  const id = ob.post({ maker: 'M', giveAsset: TAC, giveAmount: 100n, giveLane: 'bitcoin', wantAsset: tETH, wantAmount: 10n, wantLane: 'ethereum' });
  assert.throws(() => ob.fill(id, { taker: 'T', takeGive: 200n, t: sc('t'), nearDeadline: 1, farDeadline: 2 }), /out of range/, 'over-fill rejected');
  assert.throws(() => ob.fill(id, { taker: 'T', takeGive: 7n, t: sc('t'), nearDeadline: 1, farDeadline: 2 }), /exact price multiple/, 'non-exact-multiple fill rejected (7·10/100 not integer)');
  ok('fill rejects an over-fill and a non-exact-price-multiple take (no rounding value leak)');
}

// ── 4. lifecycle: cancel (maker-only) + expiry sweep ──
{
  const ob = makeCrossChainOrderbook({ resolver: X });
  const id = ob.post({ maker: 'M', giveAsset: TAC, giveAmount: 100n, giveLane: 'bitcoin', wantAsset: tETH, wantAmount: 10n, wantLane: 'ethereum', expiry: 500 });
  assert.throws(() => ob.cancel(id, 'NOT-M'), /only the maker/, 'non-maker cannot cancel');
  assert.strictEqual(ob.cancel(id, 'M'), true, 'maker cancels');
  assert.strictEqual(ob.book().length, 0, 'cancelled offer leaves the book');
  const id2 = ob.post({ maker: 'M', giveAsset: TAC, giveAmount: 100n, giveLane: 'bitcoin', wantAsset: tETH, wantAmount: 10n, wantLane: 'ethereum', expiry: 500 });
  assert.strictEqual(ob.book(600).length, 0, 'expired offer not live at now=600');
  assert.strictEqual(ob.expireSweep(600), 1, 'expiry sweep marks it');
  ok('lifecycle: maker-only cancel + expiry sweep');
}

// ── 5. resolver gating: an offer on a lane the asset is not on is rejected ──
{
  const ob = makeCrossChainOrderbook({ resolver: X });
  const UNKNOWN = '0x' + 'cd'.repeat(32);
  assert.throws(() => ob.post({ maker: 'M', giveAsset: UNKNOWN, giveAmount: 1n, giveLane: 'bitcoin', wantAsset: tETH, wantAmount: 1n, wantLane: 'ethereum' }), /not recognized/, 'unknown asset rejected');
  assert.throws(() => ob.post({ maker: 'M', giveAsset: TAC, giveAmount: 1n, giveLane: 'bitcoin', wantAsset: tETH, wantAmount: 1n, wantLane: 'bitcoin' }), /distinct lanes/, 'same-lane (not cross-chain) rejected');
  ok('resolver-gated: an unrecognized asset and a same-lane offer are rejected');
}

console.log(`\n${n}/5 cross-chain orderbook checks passed`);
