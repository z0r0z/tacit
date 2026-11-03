// Staged deposits: a deposit of the key's own, waiting in the pool, made from a private note ahead of the press.
//
// A private swap is two needs in one proof: the note's key (who may spend it) and the pool's reserves (the price), and a proof that pins the
// reserves goes stale when anyone trades. Staging splits them. The note leaves the pool by a relayed unwrap to an exit escrow whose one call wraps
// exactly that ETH back into the pool as the key's own deposit at a wrap index (through the forwarder the page's deposit-first wrap uses), and the
// relay runs the call once the settle lands. That step pins nothing that moves. The deposit then waits: it never expires, nothing refunds it, and
// only an opening proof from the key spends it. At the press a wrap-swap (OP 33) spends it against the live reserves; its program input holds no
// secret of the key's, so any prover may make it, and it can be proved while the amount is still on screen. A fresh wallet finds a staged deposit
// from the key alone (balance's diag.wrap.pending), as it finds any deposit of its own that is still waiting.
//
// The escrow's leftover and a recipe that never ran go to a rescue address made from the Tacit key (never the wallet's account, which the
// activation would then name on chain), so they are found again from the key too.
import { secp, keccak_256 } from './vendor/tacit-deps.min.js';

export const WRAP_TIP_FORWARDER = '0x000000D218B03db5837943b0b05DeA2965AE956e';
const ZERO = '0x0000000000000000000000000000000000000000', E10 = 10n ** 10n;
// What the relay's activation of the recipe may cost in gas, priced into the unwrap's fee (155k measured on a mainnet fork, deploying the escrow).
const ACT_GAS = 200000n;
// A recipe runs only before its deadline; past it the escrow's ETH can only go to the rescue address. The relay runs it within a minute of the
// settle, so this is the window for anyone else (the key itself) to run it if the relay did not.
const STAGE_TTL = 30 * 86400;
const lc = (s) => String(s || '').toLowerCase();
const hexOf = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const nonce = () => BigInt(hexOf(crypto.getRandomValues(new Uint8Array(16)))).toString();

// The rescue key and its account, from the Tacit wallet key alone.
export function rescueKey(walletPriv) {
  const tag = new TextEncoder().encode('tacit-stage-rescue-v1');
  const k = typeof walletPriv === 'string' ? Uint8Array.from(walletPriv.replace(/^0x/, '').match(/../g), (h) => parseInt(h, 16)) : walletPriv;
  const m = new Uint8Array(tag.length + k.length); m.set(tag); m.set(k, tag.length);
  const priv = keccak_256(m);
  const pub = secp.getPublicKey(priv, false);
  return { priv: hexOf(priv), address: hexOf(keccak_256(pub.slice(1)).slice(12)) };
}

// The recipe: the escrow sends exactly `wei` to the forwarder, which wraps it as the deposit for `commit` (no tip).
export function stageRecipe({ asset, commit, wei, rescue, deadline, nonce: n = nonce() }) {
  const data = '0x' + 'fc24c435' + word(commit) + word(wei) + word(0);
  return {
    exitedAsset: lc(asset), feeAsset: ZERO, finalRecipient: lc(rescue), deadline: String(deadline), nonce: String(n),
    calls: [{ target: lc(WRAP_TIP_FORWARDER), value: String(wei), token: ZERO, amount: '0', push: false, data }], sweepTokens: [], minOuts: [],
  };
}

export function makeConfidentialStage({ ux: t, now = () => Math.floor(Date.now() / 1000) }) {
  const escrowOf = async (recipe) => {
    const r = String(await t.ethCall(t.cfg.router, t.router.escrowAddressForCalldata(recipe))).replace(/^0x/, '');
    const a = '0x' + r.slice(-40);
    if (r.length < 64 || /^0x0{40}$/.test(a)) throw new Error('The stage’s escrow could not be read, so nothing was sent.');
    return lc(a);
  };
  // The unwrap's fee floor: its settle, and the relay's activation of the recipe at today's gas price with a third more.
  async function stageFee(kind = 'unwrap') {
    const gp = BigInt(await t.rpc('eth_gasPrice', []).catch(() => '0xb2d05e00'));
    return BigInt(await t.quoteOpFee('cETH', kind)) + (ACT_GAS * gp * 4n / 3n + E10 - 1n) / E10;
  }
  // The amount a partial unwrap must take out of a note so that, after its fee, exactly `units` reach the escrow: the fee grows with the amount
  // (on the relay's coarse ladder), so it is found by stepping until the two agree. → { amount, fee } in the pool's units, or null.
  function sizeFor(units, floor) {
    let amount = units + floor;
    for (let i = 0; i < 8; i++) {
      const { fee, net } = t.quoteUnwrapFee(amount, 'cETH', { minFee: floor });
      if (net === units) return { amount, fee };
      amount += units - net;
    }
    return null;
  }

  // Stages a tETH note: its unwrap to the escrow is proved, settled, and the recipe run, and the key's deposit waits in the pool. With no
  // `amountWei` the whole note is staged (its value less the fee); with one, exactly that much is (a fixed size: 0.01, 0.1 ETH), the rest staying a
  // hidden change note of the key's, and the unwrap is a partial one. With the holder's own prover set (relay.useProver, the device prover takes
  // both) the unwrap is proved on this machine and posted with its recipe, so no one else sees the note's key; otherwise the relay proves it.
  // → { index, wei, depositId, settleTx, activateTx, own, change }
  async function stageNote({ note, walletPriv, amountWei = null, minFee = null, waitOpts = {}, onStep = () => {} }) {
    if (!note) throw new Error('stageNote: note required');
    const eth = lc(t.assetByTicker.cETH.assetId);
    if (lc(note.asset) !== eth) throw new Error('stageNote: only tETH notes are staged');
    const own = t.relay.ownProving();
    let floor = minFee != null ? BigInt(minFee) : await stageFee('unwrap');
    let units = t.quoteUnwrapFee(BigInt(note.value), 'cETH', { minFee: floor }).net, part = null;
    if (amountWei != null) {
      const want = BigInt(amountWei);
      if (want <= 0n || want % E10 !== 0n) throw new Error('stageNote: amountWei must be a positive multiple of 1e10');
      if (want / E10 !== units) {
        if (minFee == null) floor = await stageFee('sendunwrap');
        part = sizeFor(want / E10, floor);
        if (!part) throw new Error('The stage could not be sized to that amount; try another.');
        if (part.amount >= BigInt(note.value)) throw new Error('This note does not hold that much and the fee.');
        units = want / E10;
      }
    }
    if (units <= 0n) throw new Error('This note is too small to stage: the relay’s fee is more than it.');
    const wei = units * E10;
    const index = await t.nextWrapIndex({ walletPriv, ticker: 'cETH' });
    const w = t.buildWrap({ walletPriv, amountWei: wei, ticker: 'cETH', index });
    const recipe = stageRecipe({ asset: eth, commit: w.commit, wei, rescue: rescueKey(walletPriv).address, deadline: now() + STAGE_TTL });
    const escrow = await escrowOf(recipe);
    // the op: a plain unwrap of the whole note, or a partial one with its change note (and that note's memo)
    let spec, change = null;
    if (!part) {
      const built = t.buildUnwrap({ note, walletPriv, recipient: escrow, feeOpts: { minFee: floor }, ttlSecs: own ? 6 * 3600 : 3600 });
      const q = t.quoteUnwrapFee(BigInt(note.value), 'cETH', { minFee: floor });
      if (BigInt(built.op.fee) !== q.fee || lc(built.op.recipient) !== escrow) throw new Error('The stage did not come out as priced, so nothing was sent.');
      spec = { type: 'unwrap', op: built.op, memos: [] };
    } else {
      const x = await t.sendUnwrapExitOp({ note, walletPriv, recipient: escrow, amount: part.amount, feeOpts: { minFee: floor }, ttl: own ? 6 * 3600 : 3600 });
      if (x.exact || BigInt(x.out.payout) !== units || lc(x.op.recipient) !== escrow) throw new Error('The stage did not come out as priced, so nothing was sent.');
      spec = { type: 'sendunwrap', op: x.op, leaves: [x.changeLeaf], outputs: x.changeOut, ephRand: x.ephRand };
      change = { value: BigInt(x.out.change), leaf: x.changeLeaf };
    }
    let jobId = null;
    try {
      if (own) {
        onStep('prove');
        const p = await t.relay.prove(spec, waitOpts);
        if (!p || !p.publicValues || !p.proof) throw new Error(`this machine's prover returned no proof (${(p && p.status) || 'no status'})`);
        onStep('settle');
        const posted = await t.relay.postProof({ type: spec.type, publicValues: p.publicValues, proof: p.proof, memos: p.memos || spec.memos || [], exit: recipe });
        if (!posted || !posted.jobId) throw new Error((posted && posted.error) || 'the relay would not take the stage');
        jobId = posted.jobId;
      } else {
        onStep('settle');
        const sub = await t.relay.submitOp({ ...spec, exit: recipe }, { ...waitOpts, viaRelay: true });
        jobId = sub.jobId;
      }
      const st = await t.relay.waitForSettle(jobId, { ...waitOpts, viaRelay: true });
      onStep('activate', st.txHash);
      for (let i = 0; i < 60; i++) {
        const s = await t.relay.status(jobId).catch(() => null);
        if (s?.activation === 'done' && s.activateTx) return { index, wei, depositId: w.depositId, settleTx: st.txHash || null, activateTx: s.activateTx, own, change };
        if (s?.activation === 'failed') throw new Error(`The relay did not wrap the staged ETH (${s.activateError || 'no reason given'}).`);
        await (waitOpts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(5000);
      }
      throw new Error('The relay has not wrapped the staged ETH yet.');
    } catch (e) {
      // the recipe is on chain with the settle: anyone may still run it (activateExit) until its deadline
      if (jobId) e.stuck = { recipe, escrow, jobId, index, depositId: w.depositId };
      throw e;
    }
  }

  // The key's staged tETH deposits still waiting, from a balance read (or `scan`, one already made). → [{ index, wei, depositId }]
  async function staged({ walletPriv, scan = null }) {
    const b = scan || await t.balance(walletPriv, { bridge: false });
    const eth = lc(t.assetByTicker.cETH.assetId);
    const { staged: mine } = await splitPending(((b.diag && b.diag.wrap && b.diag.wrap.pending) || []).filter((d) => lc(d.asset) === eth));
    return mine.map((d) => ({ index: d.index, wei: BigInt(d.value) * E10, depositId: d.depositId }));
  }
  // The key's pending deposits split into those staged (made by an exit recipe the router ran: a transaction to the router calling activateExit)
  // and those still waiting to become notes (sent from a wallet and not yet settled), read from the transaction that made each, so a fresh wallet
  // tells them apart from the key and the chain alone. A page offers to finish only the second kind: finishing a staged one would make it a note
  // again. A deposit whose transaction cannot be read is counted as waiting, as before. → { staged, waiting }
  const ACTIVATE = String(t.router.activateExitCalldata(stageRecipe({ asset: '0x' + '00'.repeat(32), commit: '0x' + '00'.repeat(32), wei: 1n, rescue: '0x' + '11'.repeat(20), deadline: 1, nonce: 1 }))).slice(0, 10).toLowerCase();
  const madeBy = new Map();
  async function splitPending(pending = []) {
    const out = { staged: [], waiting: [] };
    await Promise.all(pending.map(async (d) => {
      let by = d.txHash ? madeBy.get(lc(d.txHash)) : null;
      if (by == null && d.txHash) {
        const tx = await t.rpc('eth_getTransactionByHash', [d.txHash]).catch(() => null);
        by = tx ? (lc(tx.to) === lc(t.cfg.router) && String(tx.input || '').slice(0, 10).toLowerCase() === ACTIVATE ? 'stage' : 'wallet') : null;
        if (by) madeBy.set(lc(d.txHash), by);
      }
      (by === 'stage' ? out.staged : out.waiting).push(d);
    }));
    const order = (a, b) => a.index - b.index;
    return { staged: out.staged.sort(order), waiting: out.waiting.sort(order) };
  }

  // The press's swap of a staged deposit, proved by whichever prover the relay picks (`ahead`: before the press, on the board). Its fee is carved from
  // the input, so the relay sends it at the press from the proof alone. → { built, proven }
  // `toTicker` or `toAsset` names what it buys; `minOut` is the least the holder takes (the quote they saw, less its slippage).
  async function proveSwap({ walletPriv, deposit, toTicker = null, toAsset = null, feeBps = 30, fee = null, minOut = 0n, ahead = false, waitOpts = {} }) {
    const f = fee != null ? BigInt(fee) : BigInt(await t.quoteOpFee('cETH', 'route'));
    const built = await t.buildWrapSwap({ walletPriv, toTicker, toAsset, amountWei: deposit.wei, feeBps, fee: f, minOut: BigInt(minOut), index: deposit.index });
    if (lc(built.depositId) !== lc(deposit.depositId)) throw new Error('That deposit is not the key’s at this index.');
    const proven = await t.relay.prove({ type: 'wrapswap', op: built.op, leaves: built.leaves, outputs: built.outputs, memos: built.memos, ephRand: built.ephRand, ...(ahead ? { ahead: true } : {}) }, waitOpts);
    if (!proven.publicValues || !proven.proof) throw new Error(`the prover returned no proof for this swap (${proven.status || 'no status'})`);
    if (!t.wrapProofFits(built, proven)) throw Object.assign(new Error('the proof returned is not for this swap, so it is not used'), { code: 'wrong_proof' });
    return { built, proven: { ...proven, memos: proven.memos || built.memos } };
  }
  // Whether a swap proved earlier still prices against the pool as it is now.
  async function stillFits(built) {
    const r = await t.poolReserves(built.pid);
    return !!r && BigInt(r.reserveA) === BigInt(built.reserveA) && BigInt(r.reserveB) === BigInt(built.reserveB);
  }
  // The press: the proof made ahead if the pool has not moved since, else one made now; the relay sends it. → { jobId, txHash, amountOut }
  async function pressSwap({ walletPriv, deposit, toTicker = null, toAsset = null, feeBps = 30, fee = null, minOut = 0n, ready = null, waitOpts = {} }) {
    const p = ready && (await stillFits(ready.built)) ? ready : await proveSwap({ walletPriv, deposit, toTicker, toAsset, feeBps, fee, minOut, waitOpts });
    const posted = await t.relay.postProof({ type: 'wrapswap', publicValues: p.proven.publicValues, proof: p.proven.proof, memos: p.proven.memos });
    if (!posted || !posted.jobId) throw new Error((posted && posted.error) || 'the relay would not take the swap');
    const st = await t.relay.waitForSettle(posted.jobId, { ...waitOpts, viaRelay: true });
    return { jobId: posted.jobId, txHash: st.txHash || null, amountOut: p.built.amountOut, ahead: p === ready };
  }

  return { stageFee, stageNote, staged, splitPending, proveSwap, stillFits, pressSwap, rescueKey, stageRecipe };
}
