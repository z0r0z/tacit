// Confidential partial-fill bid (OP_BID) witness assembler for the EVM confidential pool.
//
// Buyer-offline limit order (Bitcoin T_PREAUTH_BID_VAR parity): the buyer pre-funds V_fund =
// maxFill·price of assetB and posts a bid to buy up to maxFill of assetA at `price` (assetB per unit)
// on the `increment` grid, then walks away. A seller picks any grid `chosenF ∈ [minFill, maxFill]`,
// delivers chosenF of assetA, receives chosenF·price of assetB; the buyer gets chosenF of assetA +
// the (maxFill−chosenF)·price refund. The buyer's received-note blindings are deriveNote(bidSecret,
// asset, f) — only the buyer can reproduce them, so the seller can't steal the fill — and the buyer
// recovers the notes by recomputing them after scanning the fill (the K presig is the off-chain bid;
// the witness carries only the chosen fill's openings). Mirror of main.rs OP_BID.
//
// keccak injected for Node+browser parity; `pool` supplies commitXY/leaf/nullifier/merkle +
// openingSigma/intentContext/deriveNote, all of which the guest agrees on.

const U64_MAX = (1n << 64n) - 1n;
const ZERO32 = '0x' + '00'.repeat(32);
const BID_BUYER_TAG = 'tacit-bid-buyer-v1';
const BID_SELLER_TAG = 'tacit-bid-seller-v1';

export function makeConfidentialBid({ keccak256, pool }) {
  const { leaf, nullifier, commitXY, openingSigma, verifyOpeningSigma, deriveOpeningNonce, intentContext, deriveNote, deriveBidSecret } = pool;
  const { hx } = pool._internal;

  // Per-grid buyer opening-sigma nonces, derived DISTINCTLY from (bidSecret, chosenF). The offline
  // K-presig bid publisher signs the CONSTANT funding note once per grid point; reusing a sigma nonce
  // across two grid fills exposes the funding blinding r (two z = k + e·r under different challenges
  // give r = (z1−z2)/(e1−e2)), and under the bearer model that lets anyone spend the buyer's funding
  // note. The publisher MUST use these (or equivalently distinct-per-(note,chosenF) nonces) — never a
  // fixed nonce. Built on deriveNote's deterministic per-index blinding, so each grid point differs.
  const nonceDomain = (label) => hx(keccak256(new TextEncoder().encode(label)));
  const ND_FUND = nonceDomain('tacit-bid-fund-nonce-v1');
  const ND_RECVA = nonceDomain('tacit-bid-recva-nonce-v1');
  const ND_REFUND = nonceDomain('tacit-bid-refund-nonce-v1');
  // Resting (multi-fill) bid domains. The chained funding/refund + per-lot received-note blindings are
  // keyed by the cumulative-filled state C (monotonic → no two lots ever collide). The sigma nonces are
  // DUAL-ROLE: a funding note is signed once as ITS lot's funding and once as the PREVIOUS lot's refund
  // (two distinct contexts) — distinct domains here guarantee the two sigmas never share a nonce, which
  // would leak the note blinding r (z1−z2 over e1−e2) and, under the bearer model, let anyone spend it.
  const REST_FUND = nonceDomain('tacit-bid-rest-fund-note-v1');
  const REST_RECV = nonceDomain('tacit-bid-rest-recv-note-v1');
  const ND_REST_FUND_AS_FUND = nonceDomain('tacit-bid-rest-fund-as-funding-nonce-v1');
  const ND_REST_FUND_AS_REF = nonceDomain('tacit-bid-rest-fund-as-refund-nonce-v1');
  const ND_REST_RECV = nonceDomain('tacit-bid-rest-recv-nonce-v1');
  function deriveBidNonces(bidSecret, chosenF) {
    const f = Number(chosenF);
    return {
      fund: deriveNote(bidSecret, ND_FUND, f).blinding,
      recvA: deriveNote(bidSecret, ND_RECVA, f).blinding,
      refund: deriveNote(bidSecret, ND_REFUND, f).blinding,
    };
  }

  // Buyer posts the bid: pre-fund V_fund = maxFill·price of assetB (an existing note). bidSecret is a
  // dedicated 32-byte secret (NOT the wallet seed) driving the per-fill received-note blindings.
  function buildBid({ assetA, assetB, minFill, maxFill, price, increment, chainBinding, spendRoot,
                      buyerOwner, fundRSecp, fundLeafIndex, fundPath, bidSecret }) {
    minFill = BigInt(minFill); maxFill = BigInt(maxFill); price = BigInt(price); increment = BigInt(increment);
    if (!(minFill > 0n && price > 0n && increment > 0n)) throw new Error('bid: zero term');
    if (maxFill < minFill) throw new Error('bid: max < min');
    if ((maxFill - minFill) % increment !== 0n) throw new Error('bid: grid not increment-aligned');
    if (assetA === assetB) throw new Error('bid: same asset');
    const vFund = maxFill * price;
    if (vFund > U64_MAX) throw new Error('bid: V_fund over u64');
    const fundC = commitXY(vFund, fundRSecp);
    return {
      assetA, assetB, minFill, maxFill, price, increment, chainBinding, spendRoot, buyerOwner, vFund, bidSecret,
      fund: { cx: fundC.cx, cy: fundC.cy, leafIndex: fundLeafIndex, path: fundPath, _r: BigInt(fundRSecp) },
    };
  }

  // Seller fills the bid at `chosenF`: reconstruct the buyer's pre-signed openings (via bidSecret —
  // in production the seller uses the published openings, identical) + build the seller legs.
  function fillBid(bid, { chosenF, sellerOwner, sellerInAmount, sellerInRSecp, sellerInLeafIndex,
                          sellerInPath, sellerRecvRSecp, sellerChangeRSecp, nonces }) {
    chosenF = BigInt(chosenF); sellerInAmount = BigInt(sellerInAmount);
    const { assetA, assetB, minFill, maxFill, price, increment, vFund, bidSecret, buyerOwner } = bid;
    if (!(chosenF >= minFill && chosenF <= maxFill)) throw new Error('bid: fill out of range');
    if ((chosenF - minFill) % increment !== 0n) throw new Error('bid: fill off grid');
    if (sellerInAmount < chosenF) throw new Error('bid: seller input below fill');
    const pay = chosenF * price, refund = vFund - pay;

    const raR = deriveNote(bidSecret, assetA, Number(chosenF)).blinding;
    const raC = commitXY(chosenF, raR);
    const buyerRecvA = { cx: raC.cx, cy: raC.cy, amount: chosenF, _r: raR };
    let refundNote = null;
    if (chosenF < maxFill) {
      const rfR = deriveNote(bidSecret, assetB, Number(chosenF)).blinding;
      const rfC = commitXY(refund, rfR);
      refundNote = { cx: rfC.cx, cy: rfC.cy, amount: refund, _r: rfR };
    }

    const sInC = commitXY(sellerInAmount, sellerInRSecp);
    const payC = commitXY(pay, sellerRecvRSecp);
    const sellerIn = { cx: sInC.cx, cy: sInC.cy, amount: sellerInAmount, owner: sellerOwner,
                       leafIndex: sellerInLeafIndex, path: sellerInPath, _r: BigInt(sellerInRSecp) };
    const sellerRecvB = { cx: payC.cx, cy: payC.cy, amount: pay, _r: BigInt(sellerRecvRSecp) };
    let sellerChange = null;
    const changeAmt = sellerInAmount - chosenF;
    if (changeAmt > 0n) {
      if (sellerChangeRSecp == null) throw new Error('bid: sellerChangeRSecp required when input exceeds fill');
      const scC = commitXY(changeAmt, sellerChangeRSecp);
      sellerChange = { cx: scC.cx, cy: scC.cy, amount: changeAmt, _r: BigInt(sellerChangeRSecp) };
    } else if (sellerChangeRSecp != null) throw new Error('bid: sellerChangeRSecp given but input equals fill');

    // Buyer context: PRE-SIGNED OFFLINE — only buyer-knowable data (no seller notes).
    const bNotes = [[bid.fund.cx, bid.fund.cy, buyerOwner], [buyerRecvA.cx, buyerRecvA.cy, buyerOwner]];
    if (refundNote) bNotes.push([refundNote.cx, refundNote.cy, buyerOwner]);
    const buyerCtx = intentContext(BID_BUYER_TAG, bid.chainBinding, assetA, assetB, bNotes, [minFill, maxFill, price, increment, chosenF]);
    // The buyer's opening-sigma nonces MUST be distinct + non-zero (a reused nonce leaks the note
    // blinding — see deriveBidNonces); across grid points the publisher must likewise vary them.
    const buyerNonces = [nonces.fund, nonces.recvA].concat(refundNote ? [nonces.refund] : []).map((x) => BigInt(x));
    if (buyerNonces.some((x) => x === 0n) || new Set(buyerNonces.map(String)).size !== buyerNonces.length) {
      throw new Error('bid: buyer sigma nonces must be distinct + non-zero (reuse leaks the blinding)');
    }
    bid.fund.sig = openingSigma(vFund, bid.fund._r, buyerCtx, nonces.fund);
    buyerRecvA.sig = openingSigma(chosenF, buyerRecvA._r, buyerCtx, nonces.recvA);
    if (refundNote) refundNote.sig = openingSigma(refund, refundNote._r, buyerCtx, nonces.refund);

    // Seller context: online — binds the seller's notes + chosenF.
    const sNotes = [[sellerIn.cx, sellerIn.cy, sellerOwner], [sellerRecvB.cx, sellerRecvB.cy, sellerOwner]];
    if (sellerChange) sNotes.push([sellerChange.cx, sellerChange.cy, sellerOwner]);
    const sellerCtx = intentContext(BID_SELLER_TAG, bid.chainBinding, assetA, assetB, sNotes, [chosenF, price]);
    // The seller is online and signs once, so its nonces are DERIVED per (note blinding, sellerCtx) —
    // no caller-supplied seller nonce to reuse (a re-sign under a new fill auto-varies the nonce).
    sellerIn.sig = openingSigma(sellerInAmount, sellerIn._r, sellerCtx, deriveOpeningNonce(sellerIn._r, sellerCtx, 'bid-seller-in'));
    sellerRecvB.sig = openingSigma(pay, sellerRecvB._r, sellerCtx, deriveOpeningNonce(sellerRecvB._r, sellerCtx, 'bid-seller-recv'));
    if (sellerChange) sellerChange.sig = openingSigma(changeAmt, sellerChange._r, sellerCtx, deriveOpeningNonce(sellerChange._r, sellerCtx, 'bid-seller-change'));

    return { ...bid, chosenF, pay, refund, buyerRecvA, refundNote, sellerOwner, sellerIn, sellerRecvB, sellerChange };
  }

  // JS mirror of EVERY OP_BID guest assertion. Returns { nullifiers, leaves } or throws.
  function verifyBid(filled, { merkleRootFrom }) {
    const fail = (m) => { throw new Error('bid: ' + m); };
    const { assetA, assetB, chainBinding, spendRoot, buyerOwner, fund,
            buyerRecvA, refundNote, sellerOwner, sellerIn, sellerRecvB, sellerChange } = filled;
    const minFill = BigInt(filled.minFill), maxFill = BigInt(filled.maxFill), price = BigInt(filled.price), increment = BigInt(filled.increment);
    const chosenF = BigInt(filled.chosenF);
    if (!(minFill > 0n && price > 0n && increment > 0n)) fail('zero term');
    if (maxFill < minFill) fail('max < min');
    if ((maxFill - minFill) % increment !== 0n) fail('grid not increment-aligned');
    if (assetA === assetB) fail('same asset');
    if (spendRoot === ZERO32 || !spendRoot) fail('membership requires a non-zero spend root');
    if (!(chosenF >= minFill && chosenF <= maxFill)) fail('fill out of range');
    if ((chosenF - minFill) % increment !== 0n) fail('fill off grid');
    // DERIVE the amounts (as the guest does) — never trust stored fields.
    const vFund = maxFill * price;
    const pay = chosenF * price;
    const refund = vFund - pay;
    if (vFund > U64_MAX) fail('V_fund over u64');

    if (merkleRootFrom(leaf(assetB, fund.cx, fund.cy, buyerOwner), fund.leafIndex, fund.path) !== spendRoot) fail('funding membership');
    if (merkleRootFrom(leaf(assetA, sellerIn.cx, sellerIn.cy, sellerOwner), sellerIn.leafIndex, sellerIn.path) !== spendRoot) fail('seller membership');

    if (chosenF < maxFill) { if (!refundNote || refund <= 0n) fail('partial fill must refund'); }
    else if (refundNote || refund !== 0n) fail('full fill has no refund');
    const changeAmt = sellerChange ? sellerChange.amount : 0n;
    if (sellerChange) { if (!(sellerIn.amount > chosenF)) fail('seller change requires input > fill'); }
    else if (sellerIn.amount !== chosenF) fail('seller exact input required without change');

    const bNotes = [[fund.cx, fund.cy, buyerOwner], [buyerRecvA.cx, buyerRecvA.cy, buyerOwner]];
    if (refundNote) bNotes.push([refundNote.cx, refundNote.cy, buyerOwner]);
    const buyerCtx = intentContext(BID_BUYER_TAG, chainBinding, assetA, assetB, bNotes, [minFill, maxFill, price, increment, chosenF]);
    if (!verifyOpeningSigma(fund.cx, fund.cy, vFund, fund.sig.R, fund.sig.z, buyerCtx)) fail('funding opening');
    if (!verifyOpeningSigma(buyerRecvA.cx, buyerRecvA.cy, chosenF, buyerRecvA.sig.R, buyerRecvA.sig.z, buyerCtx)) fail('buyer-recv-a opening');
    if (refundNote && !verifyOpeningSigma(refundNote.cx, refundNote.cy, refund, refundNote.sig.R, refundNote.sig.z, buyerCtx)) fail('buyer-refund opening');

    const sNotes = [[sellerIn.cx, sellerIn.cy, sellerOwner], [sellerRecvB.cx, sellerRecvB.cy, sellerOwner]];
    if (sellerChange) sNotes.push([sellerChange.cx, sellerChange.cy, sellerOwner]);
    const sellerCtx = intentContext(BID_SELLER_TAG, chainBinding, assetA, assetB, sNotes, [chosenF, price]);
    if (!verifyOpeningSigma(sellerIn.cx, sellerIn.cy, sellerIn.amount, sellerIn.sig.R, sellerIn.sig.z, sellerCtx)) fail('seller-in opening');
    if (!verifyOpeningSigma(sellerRecvB.cx, sellerRecvB.cy, pay, sellerRecvB.sig.R, sellerRecvB.sig.z, sellerCtx)) fail('seller-recv opening');
    if (sellerChange && !verifyOpeningSigma(sellerChange.cx, sellerChange.cy, changeAmt, sellerChange.sig.R, sellerChange.sig.z, sellerCtx)) fail('seller-change opening');

    if (vFund !== pay + refund) fail('asset_b conservation');
    if (sellerIn.amount !== chosenF + changeAmt) fail('asset_a conservation');
    if (vFund > U64_MAX || pay > U64_MAX) fail('amount over u64');

    const nullifiers = [nullifier(fund.cx, fund.cy), nullifier(sellerIn.cx, sellerIn.cy)];
    const leaves = [
      leaf(assetA, buyerRecvA.cx, buyerRecvA.cy, buyerOwner), // buyer receives assetA (chosenF)
      leaf(assetB, sellerRecvB.cx, sellerRecvB.cy, sellerOwner), // seller receives assetB (pay)
    ];
    if (refundNote) leaves.push(leaf(assetB, refundNote.cx, refundNote.cy, buyerOwner)); // buyer refund
    if (sellerChange) leaves.push(leaf(assetA, sellerChange.cx, sellerChange.cy, sellerOwner)); // seller change
    return { nullifiers, leaves };
  }

  // Seed-only recovery of a buyer's filled-bid OUTPUT notes (received asset_a + the asset_b refund).
  // These are the ONE note family the universal memo scan (confidential-indexer.recover) cannot reach:
  // the seller settles the fill but never learns the buyer's deriveNote blindings, so it can seal no
  // memo for them. The buyer instead re-derives the per-fill blindings from `bidSecret` (itself
  // seed-bound via deriveBidSecret) and matches against the on-chain leaves — exactly the "recompute
  // after scanning the fill" the bid relies on. A seller fills at most one grid point per bid, so the
  // scan is O(grid) and terminates on the first match.
  //
  // `bid` carries { assetA, assetB, minFill, maxFill, price, increment, buyerOwner } and the funding
  // commitment { fund:{cx,cy} } (all recoverable from the buyer's on-chain bid post). `leafSet` is a
  // Map(leafHash → { leafIndex }) over the live note tree (from the indexer). Returns the recovered
  // buyer notes [{ asset, value, blinding, cx, cy, owner, leaf, leafIndex }] ready to spend; empty if
  // the bid is unfilled.
  function recoverBidOutputs({ seed, bid, leafSet }) {
    const { assetA, assetB, buyerOwner } = bid;
    const minFill = BigInt(bid.minFill), maxFill = BigInt(bid.maxFill);
    const price = BigInt(bid.price), increment = BigInt(bid.increment);
    const bidSecret = deriveBidSecret(seed, bid.fund.cx, bid.fund.cy);
    const get = (lf) => { const e = leafSet.get(String(lf).toLowerCase()); return e ? e.leafIndex : null; };
    const out = [];
    for (let f = minFill; f <= maxFill; f += increment) {
      // Buyer received asset_a (chosenF), blinding deriveNote(bidSecret, assetA, f).
      const raR = deriveNote(bidSecret, assetA, Number(f)).blinding;
      const raC = commitXY(f, raR);
      const raLeaf = leaf(assetA, raC.cx, raC.cy, buyerOwner);
      const raIdx = get(raLeaf);
      if (raIdx == null) continue; // this grid point wasn't the fill
      out.push({ asset: assetA, value: f, blinding: raR, cx: raC.cx, cy: raC.cy, owner: buyerOwner, leaf: raLeaf, leafIndex: raIdx });
      // On a partial fill the buyer also gets the asset_b refund (maxFill−f)·price.
      if (f < maxFill) {
        const refund = (maxFill - f) * price;
        const rfR = deriveNote(bidSecret, assetB, Number(f)).blinding;
        const rfC = commitXY(refund, rfR);
        const rfLeaf = leaf(assetB, rfC.cx, rfC.cy, buyerOwner);
        const rfIdx = get(rfLeaf);
        if (rfIdx != null) out.push({ asset: assetB, value: refund, blinding: rfR, cx: rfC.cx, cy: rfC.cy, owner: buyerOwner, leaf: rfLeaf, leafIndex: rfIdx });
      }
      break; // a bid is filled at exactly one grid point
    }
    return out;
  }

  // ───────────────── Resting (multi-fill) bid ─────────────────
  // Turns the single-shot OP_BID into a RESTING order that many sellers fill over time, with NO guest
  // change. A resting order is a chain of standard OP_BID states: a fill of one `increment` lot spends
  // the current funding note and emits the next (its refund) — each is a standard OP_BID with maxFill =
  // remaining (= maxFill_total − cumulative), chosenF = increment, so the guest verifies it unchanged.
  // The buyer pre-signs every state ONCE (offline); sellers fill the head lot-by-lot across sequential
  // settles (a refund must land in the tree before the next lot can prove membership against it).
  //
  // Notes are keyed by the cumulative-filled state C (monotonic), so two equal-size lots never collide.
  // A lot at state C is verified by `verifyBid` exactly (maxFill = remaining, chosenF = increment) — the
  // resting layer only RESTRUCTURES the single-shot witness into a pre-signed grid + a deferred seller leg.

  // Buyer posts a resting bid: pre-fund V_fund = maxFill·price of assetB (an existing note, blinding
  // fundRSecp), then pre-sign every lot state C ∈ {0, inc, …, maxFill−inc}. Returns the published grid;
  // the funding membership (leafIndex/path) + spendRoot are supplied per-lot at fill time (the opening
  // sigmas are membership-independent). `min_fill = increment` for a resting order (each lot is one inc).
  function buildRestingBid({ assetA, assetB, maxFill, price, increment, chainBinding, buyerOwner, fundRSecp, bidSecret }) {
    maxFill = BigInt(maxFill); price = BigInt(price); increment = BigInt(increment);
    if (!(price > 0n && increment > 0n)) throw new Error('bid: zero term');
    if (maxFill <= 0n || maxFill % increment !== 0n) throw new Error('bid: maxFill must be a positive multiple of increment');
    if (assetA === assetB) throw new Error('bid: same asset');
    const vFund = maxFill * price;
    if (vFund > U64_MAX) throw new Error('bid: V_fund over u64');
    const minFill = increment;

    // Funding note at cumulative C (value (maxFill−C)·price). C=0 is the buyer's existing note; C>0 is
    // deriveNote(REST_FUND, C) — the SAME note the lot at C−increment emits as its refund.
    const fundingR = (C) => (C === 0n ? BigInt(fundRSecp) : deriveNote(bidSecret, REST_FUND, Number(C)).blinding);
    const states = [];
    for (let C = 0n; C < maxFill; C += increment) {
      const remaining = maxFill - C;
      const vFundC = remaining * price;
      const fR = fundingR(C);
      const fC = commitXY(vFundC, fR);
      const rR = deriveNote(bidSecret, REST_RECV, Number(C)).blinding;
      const rC = commitXY(increment, rR);
      const nextRemaining = remaining - increment;
      let refund = null;
      if (nextRemaining > 0n) {
        const fR2 = fundingR(C + increment);
        const c2 = commitXY(nextRemaining * price, fR2);
        refund = { cx: c2.cx, cy: c2.cy, amount: nextRemaining * price, _r: fR2 };
      }
      // Per-state buyer context: a standard OP_BID with maxFill' = remaining, chosenF = increment.
      const bNotes = [[fC.cx, fC.cy, buyerOwner], [rC.cx, rC.cy, buyerOwner]];
      if (refund) bNotes.push([refund.cx, refund.cy, buyerOwner]);
      const ctx = intentContext(BID_BUYER_TAG, chainBinding, assetA, assetB, bNotes, [minFill, remaining, price, increment, increment]);
      const fundNonce = deriveNote(bidSecret, ND_REST_FUND_AS_FUND, Number(C)).blinding;
      const recvNonce = deriveNote(bidSecret, ND_REST_RECV, Number(C)).blinding;
      const fund = { cx: fC.cx, cy: fC.cy, amount: vFundC, _r: fR, sig: openingSigma(vFundC, fR, ctx, fundNonce) };
      const recv = { cx: rC.cx, cy: rC.cy, amount: increment, _r: rR, sig: openingSigma(increment, rR, ctx, recvNonce) };
      if (refund) {
        // funding[C+inc] signed HERE as this lot's refund — a DISTINCT domain from its as-funding nonce
        // at state C+inc, so the note's two sigmas never share a nonce.
        const refNonce = deriveNote(bidSecret, ND_REST_FUND_AS_REF, Number(C + increment)).blinding;
        refund.sig = openingSigma(refund.amount, refund._r, ctx, refNonce);
      }
      states.push({ C, remaining, fund, recv, refund });
    }
    return { assetA, assetB, minFill, maxFill, price, increment, chainBinding, buyerOwner, vFund, bidSecret, states };
  }

  // Seller fills the head lot (state C) of a resting bid: supply the current funding membership +
  // spendRoot + seller legs. Returns a `filled` object that `verifyBid` checks exactly as a single-shot
  // fill (maxFill = remaining, chosenF = increment). The buyer's funding/received/refund openings are
  // already pre-signed in `restingBid.states[C]`.
  function fillRestingLot(restingBid, C, { spendRoot, fundLeafIndex, fundPath, sellerOwner, sellerInAmount,
                          sellerInRSecp, sellerInLeafIndex, sellerInPath, sellerRecvRSecp, sellerChangeRSecp }) {
    C = BigInt(C);
    const state = restingBid.states.find((s) => s.C === C);
    if (!state) throw new Error('bid: no such resting state');
    const { assetA, assetB, price, increment, chainBinding, buyerOwner, minFill, bidSecret } = restingBid;
    const remaining = state.remaining;
    const chosenF = increment;
    sellerInAmount = BigInt(sellerInAmount);
    if (sellerInAmount < chosenF) throw new Error('bid: seller input below lot');
    const pay = chosenF * price;

    const sInC = commitXY(sellerInAmount, sellerInRSecp);
    const payC = commitXY(pay, sellerRecvRSecp);
    const sellerIn = { cx: sInC.cx, cy: sInC.cy, amount: sellerInAmount, owner: sellerOwner,
                       leafIndex: sellerInLeafIndex, path: sellerInPath, _r: BigInt(sellerInRSecp) };
    const sellerRecvB = { cx: payC.cx, cy: payC.cy, amount: pay, _r: BigInt(sellerRecvRSecp) };
    let sellerChange = null;
    const changeAmt = sellerInAmount - chosenF;
    if (changeAmt > 0n) {
      if (sellerChangeRSecp == null) throw new Error('bid: sellerChangeRSecp required when input exceeds lot');
      const scC = commitXY(changeAmt, sellerChangeRSecp);
      sellerChange = { cx: scC.cx, cy: scC.cy, amount: changeAmt, _r: BigInt(sellerChangeRSecp) };
    } else if (sellerChangeRSecp != null) throw new Error('bid: sellerChangeRSecp given but input equals lot');

    const sNotes = [[sellerIn.cx, sellerIn.cy, sellerOwner], [sellerRecvB.cx, sellerRecvB.cy, sellerOwner]];
    if (sellerChange) sNotes.push([sellerChange.cx, sellerChange.cy, sellerOwner]);
    const sellerCtx = intentContext(BID_SELLER_TAG, chainBinding, assetA, assetB, sNotes, [chosenF, price]);
    sellerIn.sig = openingSigma(sellerInAmount, sellerIn._r, sellerCtx, deriveOpeningNonce(sellerIn._r, sellerCtx, 'bid-seller-in'));
    sellerRecvB.sig = openingSigma(pay, sellerRecvB._r, sellerCtx, deriveOpeningNonce(sellerRecvB._r, sellerCtx, 'bid-seller-recv'));
    if (sellerChange) sellerChange.sig = openingSigma(changeAmt, sellerChange._r, sellerCtx, deriveOpeningNonce(sellerChange._r, sellerCtx, 'bid-seller-change'));

    const fund = { ...state.fund, leafIndex: fundLeafIndex, path: fundPath };
    return {
      assetA, assetB, minFill, maxFill: remaining, price, increment, chainBinding, spendRoot, buyerOwner,
      vFund: remaining * price, bidSecret, fund, chosenF, pay, refund: state.refund ? state.refund.amount : 0n,
      buyerRecvA: state.recv, refundNote: state.refund,
      sellerOwner, sellerIn, sellerRecvB, sellerChange,
    };
  }

  // Cancellation / head recovery: the buyer reclaims the resting order by spending the current funding
  // note (it knows the blinding). Returns the live funding note { cx, cy, amount, _r } at cumulative C
  // for a plain transfer/withdraw; the in-flight lot at C then double-spends the same nullifier and reverts.
  function restingFundingNote(restingBid, C) {
    const state = restingBid.states.find((s) => s.C === BigInt(C));
    if (!state) throw new Error('bid: no such resting state');
    return { cx: state.fund.cx, cy: state.fund.cy, amount: state.fund.amount, _r: state.fund._r };
  }

  return { buildBid, fillBid, verifyBid, recoverBidOutputs, deriveBidNonces,
           buildRestingBid, fillRestingLot, restingFundingNote, BID_BUYER_TAG, BID_SELLER_TAG };
}
