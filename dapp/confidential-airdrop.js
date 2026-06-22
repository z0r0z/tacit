// Confidential airdrop: one sender → many recipients, non-interactive, over the stealth lock-set
// (ops/DESIGN-confidential-stealth-receive.md). Each recipient needs only a published static spend
// pubkey; the sender derives a one-time address per recipient and locks value under it, with a memo
// that lets the recipient discover + reconstruct the lock by scanning alone. Built entirely on the
// already-proven stealth primitives (dapp/confidential-stealth.js) — no guest or contract change.
//
// Two pieces are new here vs. the per-note memo (dapp/confidential-memo.js): (1) ephemeralPub is
// PUBLISHED in the clear so any candidate recipient can run the ECDH scan, and (2) the lock params
// (asset, amount, Cx, Cy, deadline, locker) — none of which are on-chain in the clear, only the leaf
// hash is — are sealed under the same shared point e·B = b·E. The stealth lock leaf is the
// authenticator: a wrong key / tampered memo recomputes to a leaf that won't match the on-chain one.
//
// Prerequisites the caller satisfies (NOT this module): a lock consumes one funding note that opens to
// EXACTLY that recipient's amount (no change in a lock), so the funding is pre-split with
// transfer.buildTransfer; and a lock can't consume a split output minted in the same proof
// (membership is against the pre-state spend_root), so the split and the locks are separate settles.
//
// Inject: { stealth, secp, sha256, keccak256, curveOrder }; add { pool, transfer } to use the funding
// split + driver. Wire form (bytes memo): ephemeralPub(33) ‖ ciphertext(144), ciphertext =
// xor(asset(32)‖amount_be8‖Cx(32)‖Cy(32)‖deadline_be8‖locker(32)).

const PLAIN_LEN = 144;       // asset(32) ‖ amount(8) ‖ Cx(32) ‖ Cy(32) ‖ deadline(8) ‖ locker(32)
const MAX_DENOM_PER_OP = 7;  // a transfer aggregates ≤8 outputs (BP+ {1,2,4,8}); reserve one slot for change
const POW2 = [1, 2, 4, 8];

export function makeConfidentialAirdrop({ stealth, secp, sha256, keccak256, curveOrder, pool, transfer }) {
  const Pt = secp.ProjectivePoint, G = Pt.BASE, N = BigInt(curveOrder);
  const enc = new TextEncoder();
  const EPH_DOMAIN = enc.encode('tacit-airdrop-eph-v1');     // deterministic ephemeral per (recipient, index)
  const BLIND_DOMAIN = enc.encode('tacit-airdrop-blind-v1'); // deterministic lock blinding per index

  const hx = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const hb = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  const cat = (a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const b32 = (h) => { const b = hb(h); if (b.length > 32) throw new Error('over 32 bytes'); const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; };
  const be = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
  const bBig = (b) => { let x = 0n; for (const y of b) x = (x << 8n) | BigInt(y); return x; };
  const modN = (x) => ((x % N) + N) % N;
  const pt = (h) => { const s = String(h).replace(/^0x/, ''); return s.length === 64 ? Pt.fromHex('02' + s) : Pt.fromHex(s); };
  const kBig = (...parts) => modN(bBig(keccak256(cat(parts))));

  // sha256-counter keystream over the ECDH shared point (mirrors dapp/confidential-memo.js).
  const ksXor = (data, ss) => {
    const o = new Uint8Array(data.length);
    let off = 0, c = 0;
    while (off < data.length) { const blk = sha256(cat([ss, Uint8Array.of(c++ & 0xff)])); for (let i = 0; i < 32 && off < data.length; i++, off++) o[off] = data[off] ^ blk[i]; }
    return o;
  };

  // Deterministic ephemeral + lock blinding from the locker's seed, so the sender can re-derive the
  // whole airdrop (recovery / re-publish) without storing N scalars. `salt` separates repeated
  // airdrops to the same list (else same recipient+index collides on the lock leaf).
  const ephPriv = (lockerScanPriv, recipientSpendPub, i, salt) =>
    kBig(EPH_DOMAIN, b32(salt), b32(lockerScanPriv), hb(recipientSpendPub), be(i, 4)) || 1n;
  const lockBlinding = (lockerScanPriv, i, salt) =>
    '0x' + (kBig(BLIND_DOMAIN, b32(salt), b32(lockerScanPriv), be(i, 4)) || 1n).toString(16).padStart(64, '0');

  // SEAL: ephemeralPub in the clear; lock params XORed under sha256(compress(e·B)).
  const sealStealthMemo = ({ recipientSpendPub, ephemeralPriv, asset, amount, lCx, lCy, deadline, locker }) => {
    const ss = sha256(pt(recipientSpendPub).multiply(BigInt(ephemeralPriv)).toRawBytes(true));
    const plain = cat([b32(asset), be(amount, 8), b32(lCx), b32(lCy), be(deadline, 8), b32(locker)]);
    return hx(cat([G.multiply(BigInt(ephemeralPriv)).toRawBytes(true), ksXor(plain, ss)]));
  };

  // OPEN: derive the shared point as b·E, decrypt, recompute the one-time owner + lock leaf, accept iff
  // it rehashes to the on-chain leaf (the leaf hash authenticates — not mine / tampered ⇒ null).
  const openStealthMemo = ({ recipientSpendPriv, leaf, memoHex }) => {
    const b = hb(memoHex);
    if (b.length !== 33 + PLAIN_LEN) return null;
    const ephemeralPub = hx(b.subarray(0, 33));
    let p;
    try { p = ksXor(b.subarray(33), sha256(pt(ephemeralPub).multiply(modN(BigInt(recipientSpendPriv))).toRawBytes(true))); }
    catch { return null; }
    const asset = hx(p.subarray(0, 32)), amount = bBig(p.subarray(32, 40)),
      lCx = hx(p.subarray(40, 72)), lCy = hx(p.subarray(72, 104)),
      deadline = bBig(p.subarray(104, 112)), locker = hx(p.subarray(112, 144));
    let ownerPub;
    try { ownerPub = stealth.recoverOneTimeKey({ recipientSpendPriv, ephemeralPub }).ownerPub; }
    catch { return null; }
    const lockLeaf = stealth.stealthLockLeaf(asset, lCx, lCy, ownerPub, amount, deadline, locker);
    if (lockLeaf.toLowerCase() !== String(leaf).toLowerCase()) return null;
    return { ephemeralPub, asset, amount, lCx, lCy, deadline, locker, ownerPub };
  };

  // SENDER. recipients: [{ recipientSpendPub, amount }]; fundingNotes[i] must open to recipients[i].amount
  // ({ cx, cy, blinding, leafIndex, path } from a prior split). Returns the lock ops + lock leaves +
  // memos for ONE batch settle (the guest takes up to MAX_OPS = 256 ops per proof).
  function buildAirdrop({ chainBinding, asset, locker, lockerScanPriv, deadline, spendRoot, recipients, fundingNotes, salt = '0x' + '00'.repeat(32) }) {
    if (recipients.length !== fundingNotes.length) throw new Error('airdrop: one funding note per recipient');
    const ops = [], leaves = [], memos = [];
    recipients.forEach((r, i) => {
      const amount = BigInt(r.amount);
      const ePriv = ephPriv(lockerScanPriv, r.recipientSpendPub, i, salt);
      const { ownerPub } = stealth.oneTimeAddress({ recipientSpendPub: r.recipientSpendPub, ephemeralPriv: ePriv });
      const lBlinding = lockBlinding(lockerScanPriv, i, salt);
      const op = stealth.buildStealthLock({ chainBinding, asset, locker, ownerPub, amount, deadline, spendRoot, nNote: fundingNotes[i], lBlinding });
      ops.push(op);
      leaves.push(stealth.stealthLockLeaf(asset, op.lCx, op.lCy, ownerPub, amount, deadline, locker));
      memos.push(sealStealthMemo({ recipientSpendPub: r.recipientSpendPub, ephemeralPriv: ePriv, asset, amount, lCx: op.lCx, lCy: op.lCy, deadline, locker }));
    });
    return { ops, leaves, memos };
  }

  // RECIPIENT scan loop. events: [{ leaf, memo }] from the lock-set's LeavesInserted emit. Returns the
  // locks addressed to me with the recovered one-time key — paths come from the live lock-set tree at
  // claim time, then each feeds stealth.buildStealthClaim({ ...item, lockSetRoot, lIndex, lPath, mOwner, mBlinding, fee }).
  function scanAirdrop({ recipientSpendPriv, events }) {
    const mine = [];
    for (const ev of events) {
      const m = openStealthMemo({ recipientSpendPriv, leaf: ev.leaf, memoHex: ev.memo });
      if (!m) continue;
      const { oneTimePriv } = stealth.recoverOneTimeKey({ recipientSpendPriv, ephemeralPub: m.ephemeralPub });
      mine.push({ ...m, oneTimePriv, leaf: ev.leaf });
    }
    return mine;
  }

  // ── funding split (pre-step) ──────────────────────────────────────────────────────────────────
  // A lock consumes one funding note that opens to EXACTLY the recipient's amount and is owned by
  // `locker` (the guest keys the input leaf on `locker`, main.rs OP_STEALTH_LOCK). So before the locks,
  // the locker splits its own note(s) into per-recipient denominations with transfer.buildTransfer.
  // The split and the locks are SEPARATE settles: a lock proves membership against the pre-state
  // spend_root, so it can't consume a denomination minted in the same proof.

  const FUND_DOMAIN = enc.encode('tacit-airdrop-fund-v1');
  const outBlinding = (lockerScanPriv, role, i, salt) =>
    (kBig(FUND_DOMAIN, b32(salt), b32(lockerScanPriv), Uint8Array.of(role), be(i, 4)) || 1n);

  // Bin-pack `amounts` onto `sources` (each [{ value }]): one transfer op per source, ≤7 denominations +
  // a change slot, padded to a {1,2,4,8} output count. `fee` (a public relay leg) is charged on the first
  // op. Throws if the sources can't cover the amounts + fee, or an amount exceeds every source's room.
  function planFunding({ sources, amounts, fee = 0n }) {
    const f = BigInt(fee);
    const totalSrc = sources.reduce((s, x) => s + BigInt(x.value), 0n);
    const totalAmt = amounts.reduce((s, a) => s + BigInt(a), 0n);
    if (totalAmt + f > totalSrc) throw new Error('airdrop funding: sources under-funded');
    const room = sources.map((s) => BigInt(s.value));
    const denom = sources.map(() => []); // {amount, amountIndex}
    const sorted = amounts.map((a, i) => ({ v: BigInt(a), i })).sort((a, b) => (b.v > a.v ? 1 : b.v < a.v ? -1 : 0));
    for (const a of sorted) {
      const si = room.findIndex((r, k) => denom[k].length < MAX_DENOM_PER_OP && r >= a.v);
      if (si < 0) throw new Error('airdrop funding: cannot pack an amount — need more or larger sources');
      denom[si].push({ amount: a.v, amountIndex: a.i }); room[si] -= a.v;
    }
    const plan = [];
    for (let si = 0; si < sources.length; si++) {
      if (!denom[si].length) continue;
      const opFee = plan.length === 0 ? f : 0n;
      const change = room[si] - opFee;
      if (change < 0n) throw new Error('airdrop funding: first source cannot cover the fee');
      const real = denom[si].length + 1; // + change (kept even when 0, so conservation is explicit)
      const m = POW2.find((x) => x >= real);
      plan.push({ sourceIndex: si, denom: denom[si], change, fee: opFee, m, pad: m - real });
    }
    if (f > 0n && !plan.length) throw new Error('airdrop funding: fee with no outputs');
    return plan;
  }

  // Realize the plan: one transfer proof per op + the denomination notes (in `amounts` order) that become
  // buildAirdrop's fundingNotes once settled. Every output note is owned by `locker` and recoverable
  // (blinding derived from the locker seed). Output note = { value, blinding, owner, cx, cy, role }.
  function buildFunding({ sources, amounts, locker, lockerScanPriv, fee = 0n, salt = '0x' + '00'.repeat(32) }) {
    if (!pool || !transfer) throw new Error('airdrop funding needs { pool, transfer } injected');
    const plan = planFunding({ sources, amounts, fee });
    const denomNotes = new Array(amounts.length);
    let padCounter = 0;
    const ops = plan.map((p) => {
      const src = sources[p.sourceIndex];
      const outs = []; // { value, blinding, owner, cx, cy, role, amountIndex? }
      for (const d of p.denom) {
        const r = outBlinding(lockerScanPriv, 0, d.amountIndex, salt);
        const { cx, cy } = pool.commitXY(d.amount, r);
        const note = { value: d.amount, blinding: r, owner: locker, cx, cy, role: 'denom', amountIndex: d.amountIndex };
        denomNotes[d.amountIndex] = note; outs.push(note);
      }
      const cr = outBlinding(lockerScanPriv, 1, p.sourceIndex, salt);
      const { cx: ccx, cy: ccy } = pool.commitXY(p.change, cr);
      outs.push({ value: p.change, blinding: cr, owner: locker, cx: ccx, cy: ccy, role: 'change' });
      for (let j = 0; j < p.pad; j++) {
        const pr = outBlinding(lockerScanPriv, 2, padCounter++, salt);
        const { cx, cy } = pool.commitXY(0n, pr);
        outs.push({ value: 0n, blinding: pr, owner: locker, cx, cy, role: 'pad' });
      }
      const t = transfer.buildTransfer({
        inputs: [{ value: BigInt(src.value), blinding: BigInt(src.blinding) }],
        outputs: outs.map((o) => ({ value: o.value, blinding: o.blinding })), fee: p.fee,
      });
      return { sourceIndex: p.sourceIndex, ...t,
        source: { cx: src.cx, cy: src.cy, owner: locker, leafIndex: src.leafIndex, path: src.path, blinding: src.blinding },
        outNotes: outs };
    });
    return { ops, denomNotes };
  }

  // Stitch post-settle membership (one { leafIndex, path } per denomination note, in `amounts` order)
  // into the fundingNotes buildStealthLock consumes.
  function fundingNotesFor({ denomNotes, membership }) {
    return denomNotes.map((d, i) => ({ cx: d.cx, cy: d.cy, blinding: d.blinding, leafIndex: membership[i].leafIndex, path: membership[i].path }));
  }

  // Two-settle driver. Sequences split → index → lock against injected live-infra callbacks:
  //   settleSplit(fundingOps)  → settle the transfer batch (resolve once its leaves are on-chain),
  //   indexDenoms(denomNotes)  → [{ leafIndex, path }] for each denom leaf from the new spend tree,
  //   settleLocks({ ops, leaves, memos }) → settle the stealth-lock batch.
  // The barrier between them is real: the locks need the denominations' membership in the settled root.
  async function runAirdrop({ chainBinding, asset, locker, lockerScanPriv, deadline, spendRoot, recipients, sources, fee = 0n, salt = '0x' + '00'.repeat(32), settleSplit, indexDenoms, settleLocks }) {
    const funding = buildFunding({ sources, amounts: recipients.map((r) => r.amount), locker, lockerScanPriv, fee, salt });
    await settleSplit(funding.ops);
    const membership = await indexDenoms(funding.denomNotes);
    const fundingNotes = fundingNotesFor({ denomNotes: funding.denomNotes, membership });
    const drop = buildAirdrop({ chainBinding, asset, locker, lockerScanPriv, deadline, spendRoot, recipients, fundingNotes, salt });
    await settleLocks(drop);
    return { funding, drop };
  }

  // Pack buildAirdrop's lock ops into ONE multi-op proof for the box (harness exec-stealthlockbatch.rs):
  // a shared header (all locks share chainBinding + the pre-state spendRoot — one proof, one root) + the N
  // per-lock field sets the guest reads. Submit as { type: 'stealthlockbatch', op: <this>, memos: <the N
  // buildAirdrop memos> }: a pure lock emits no note leaf (pv.leaves.length == 0), so the N stealth memos
  // ride the settle calldata as the lock-memo tail (the pool's relaxed memo check accepts memos.length == N
  // here). The relaying worker / any indexer reads them from that calldata to feed scanAirdrop; the
  // sender-published bundle is the trustless fallback.
  function packStealthLockBatch(ops) {
    if (!ops.length) throw new Error('airdrop batch: no ops');
    const { chainBinding, spendRoot } = ops[0];
    for (const o of ops) {
      if (o.chainBinding !== chainBinding || o.spendRoot !== spendRoot) {
        throw new Error('airdrop batch: every lock must share chainBinding + spendRoot (one proof, one header)');
      }
    }
    const pick = (o) => ({ asset: o.asset, locker: o.locker, ownerPub: o.ownerPub, amount: o.amount, deadline: o.deadline,
      nCx: o.nCx, nCy: o.nCy, nIndex: o.nIndex, nPath: o.nPath, nSigR: o.nSigR, nSigZ: o.nSigZ,
      lCx: o.lCx, lCy: o.lCy, lSigR: o.lSigR, lSigZ: o.lSigZ });
    return { chainBinding, spendRoot, ops: ops.map(pick) };
  }

  return { buildAirdrop, scanAirdrop, sealStealthMemo, openStealthMemo, ephPriv, lockBlinding,
    planFunding, buildFunding, fundingNotesFor, runAirdrop, packStealthLockBatch };
}
