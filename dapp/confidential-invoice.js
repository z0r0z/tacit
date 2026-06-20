// Invoice-based confidential payments for the EVM ConfidentialPool.
//
// EVM pool notes are BEARER: spend is authorized by an opening sigma over the note's blinding `r` (the
// settle guest's verify_opening_sigma; `secret` is vestigial, `owner` is leaf-binding only). So whoever
// knows `r` can spend — and a sender who builds a note necessarily knows `r`. A secure "send to someone"
// therefore can't have the SENDER pick the blinding; the RECIPIENT must.
//
// The invoice flow inverts it: the recipient derives the note (blinding from their seed, recoverable), and
// publishes an INVOICE — the commitment, the deposit/leaf ids, a memo sealed to themselves, and a
// PRE-SIGNED consume (the opening sigma, a zero-knowledge proof of `r`). The invoice carries NO raw
// blinding/secret. The payer wraps public funds (USDC, …) to the invoice's commit via
// ConfidentialWrapRouter and, using the pre-signed witness, can finalize the recipient's note in ONE tx
// (wrapAndSettle) WITHOUT ever learning `r`. Result: the payer can pay (and even settle) but can never
// spend the note; only the recipient (who re-derives `r` from their seed) can. Sender + amount are public
// (public source funds); the recipient is hidden (the commit binds the owner, not msg.sender).
//
// Dep: a makeConfidentialPoolUx() instance — reuses its note derivation (buildWrap), pool primitives, and
// recipient-agnostic memo scan (indexer.recover), so an invoice note recommits/rehashes to exactly the
// on-chain leaf and is discovered by the recipient's normal scan.

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export function makeConfidentialInvoice({ ux }) {
  if (!ux || !ux.pool || !ux.buildWrap) throw new Error('makeConfidentialInvoice: a confidential-pool-ux instance is required');
  const pool = ux.pool;
  const lc = (h) => String(h).toLowerCase();

  // RECIPIENT — build a shareable invoice for `amountWei` of `ticker`, into note `index`. The recipient
  // keeps only `claim.index` (the blinding is seed-derived from it, so the note is recoverable from the
  // seed alone). Everything in `invoice` is safe to hand the payer: no blinding, no secret.
  function createInvoice({ recipientPriv, ticker = 'cETH', amountWei, index = 0 }) {
    const meta = ux.assetByTicker[ticker];
    if (!meta) throw new Error(`unknown asset ${ticker}`);
    // buildWrap is the canonical note+witness derivation; we expose only its safe (blinding-free) subset.
    const w = ux.buildWrap({ walletPriv: recipientPriv, amountWei, ticker, index });
    const invoice = {
      v: 1,
      chainBinding: w.wrapOp.chainBinding,
      assetId: w.wrapOp.asset,
      underlying: meta.underlying, // the ERC20 the payer permits + the router pulls (0x0 ⇒ native ETH, see payArgs)
      ticker,
      amount: w.amount, // underlying amount the payer wraps
      value: w.wrapOp.value, // in-system note value (amount / unitScale)
      cx: w.wrapOp.cx,
      cy: w.wrapOp.cy,
      owner: w.wrapOp.owner,
      commit: w.commit, // = keccak(Cx‖Cy‖owner); the router/wrap target
      depositId: w.depositId, // the recipient watches Wrap(depositId,…) to confirm payment
      leaf: w.leaf, // the recipient's note leaf once consumed
      memo: w.memo, // ECDH-sealed to the recipient — the discovery channel (emitted at settle)
      witness: w.wrapOp, // PRE-SIGNED consume (opening sigma, ZK of r) — lets the payer prove+settle in one tx
    };
    return { invoice, claim: { index } };
  }

  // PAYER — verify an invoice is well-formed + CLAIMABLE before paying, so a malformed invoice can't lock
  // funds in an unconsumable deposit. Checks the commit/leaf/depositId all bind (cx,cy,owner,value) and
  // that the pre-signed sigma actually opens the commitment to `value` under the consume context (a
  // malformed commit can't be sigma-proven; the context is bound to depositId so the sigma can't be lifted
  // to another note). Returns true iff safe to pay.
  function verifyInvoice(invoice) {
    try {
      if (!invoice || invoice.v !== 1 || !invoice.witness) return false;
      const value = BigInt(invoice.value);
      if (lc(pool.depositCommit(invoice.cx, invoice.cy, invoice.owner)) !== lc(invoice.commit)) return false;
      if (lc(pool.leaf(invoice.assetId, invoice.cx, invoice.cy, invoice.owner)) !== lc(invoice.leaf)) return false;
      if (lc(pool.depositId(invoice.assetId, value, invoice.cx, invoice.cy, invoice.owner)) !== lc(invoice.depositId)) return false;
      // The consume sigma is over the SAME context the OP_WRAP guest checks: intentContext('tacit-wrap-
      // intent-v1', chainBinding, assetId, depositId, [(cx,cy,owner)], [value]). Verifying it assures the
      // payer the deposit is consumable into a real note worth `value` — i.e., the recipient holds r.
      const ctx = pool.intentContext(
        'tacit-wrap-intent-v1', invoice.chainBinding, invoice.assetId, invoice.depositId,
        [[invoice.cx, invoice.cy, invoice.owner]], [value]
      );
      return pool.verifyOpeningSigma(invoice.cx, invoice.cy, value, invoice.witness.sigR, invoice.witness.sigZ, ctx);
    } catch {
      return false;
    }
  }

  // PAYER — the wrap target to pay the invoice. For an ERC20 (USDC, …) feed (token, amount, commit) to
  // ConfidentialWrapRouter.wrapWithPermit/Permit2 (gasless approve) or wrapAndSettle* (one-tx finalize via
  // `settleInputs`). For native ETH (`native: true`) there is no ERC20 to permit — pay with a direct
  // payable pool.wrap{value: amount}(assetId, amount, commit); the commit/leaf/witness are identical.
  function payArgs(invoice) {
    if (!verifyInvoice(invoice)) throw new Error('invoice failed verification (malformed / not claimable)');
    return {
      token: invoice.underlying,
      amount: invoice.amount,
      commit: invoice.commit,
      assetId: invoice.assetId,
      native: lc(invoice.underlying) === ZERO_ADDR,
    };
  }

  // PAYER (or anyone) — the settle inputs that consume the invoice's deposit into the recipient's note,
  // built from the PRE-SIGNED witness so NO blinding is needed. Pair `witness` with a proof and submit via
  // ConfidentialWrapRouter.wrapAndSettleWithPermit/Permit2 (one tx, with the matching wrap), or pool.settle
  // after a separate wrap. The minted note's owner is the recipient; only they can spend it.
  function settleInputs(invoice) {
    if (!verifyInvoice(invoice)) throw new Error('invoice failed verification (malformed / not claimable)');
    return {
      depositsConsumed: [invoice.depositId],
      leaves: [invoice.leaf],
      memos: [invoice.memo],
      witness: invoice.witness,
    };
  }

  // RECIPIENT — was the invoice paid? Match its depositId against observed Wrap(depositId,assetId,amount)
  // events (the deposit is pending and ready to consume once this is true).
  function isPaid(invoice, wrapEvents) {
    return (wrapEvents || []).some((e) => lc(e.depositId) === lc(invoice.depositId));
  }

  // RECIPIENT — re-derive the spendable note from the seed alone (after the deposit settles). Reuses the
  // canonical buildWrap derivation at `claim.index`, attaching the on-chain membership (root, leafIndex,
  // path) the recipient reads from the tree, to produce a `note` ready for ux.buildUnwrap / a transfer. The
  // payer cannot run this — it needs the recipient's seed (the blinding).
  function recoverNote({ recipientPriv, invoice, index, root, leafIndex, path }) {
    const w = ux.buildWrap({ walletPriv: recipientPriv, amountWei: invoice.amount, ticker: invoice.ticker, index });
    if (lc(w.depositId) !== lc(invoice.depositId)) throw new Error('recoverNote: wrong seed/index for this invoice');
    return {
      asset: invoice.assetId,
      value: w.note.value,
      cx: w.note.cx,
      cy: w.note.cy,
      owner: w.note.owner,
      blinding: w.note.blinding,
      secret: w.note.secret,
      root,
      leafIndex,
      path,
    };
  }

  return { createInvoice, verifyInvoice, payArgs, settleInputs, isPaid, recoverNote };
}
