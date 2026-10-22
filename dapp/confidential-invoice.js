
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const lc = (h) => String(h).toLowerCase();
const sameHex = (a, b, bytes = 32) => typeof a === 'string' && typeof b === 'string'
  && new RegExp('^0x[0-9a-fA-F]{' + bytes * 2 + '}$').test(a) && lc(a) === lc(b);
const integer = (v) => {
  if (!['string', 'number', 'bigint'].includes(typeof v) || (typeof v === 'number' && !Number.isSafeInteger(v))) throw new Error('invalid invoice integer');
  return BigInt(v);
};

// Check the same public payment, pre-signed wrap witness and active deployment at every boundary that
// accepts an invoice. A valid opening alone does not bind the underlying amount actually escrowed.
export function verifyConfidentialInvoice(invoice, { pool, assetByTicker, chainBinding } = {}) {
  try {
    if (!invoice || invoice.v !== 1 || !invoice.witness || typeof invoice.ticker !== 'string'
      || !Object.hasOwn(assetByTicker, invoice.ticker)) return false;
    const meta = assetByTicker[invoice.ticker], w = invoice.witness;
    if (!sameHex(invoice.assetId, meta.assetId) || !sameHex(invoice.underlying, meta.underlying, 20)
      || !sameHex(invoice.chainBinding, chainBinding)) return false;
    const amount = integer(invoice.amount), value = integer(invoice.value), scale = integer(meta.unitScale);
    if (amount <= 0n || scale <= 0n || amount % scale !== 0n || value <= 0n || value > (1n << 64n) - 1n
      || typeof w.value !== 'string' || !/^\+?\d+$/.test(w.value)
      || amount !== value * scale || integer(w.value) !== value) return false;
    if (!sameHex(w.chainBinding, invoice.chainBinding) || !sameHex(w.asset, invoice.assetId)
      || !['cx', 'cy', 'owner'].every((k) => sameHex(w[k], invoice[k]))) return false;
    // The wrap harness parses a decimal string, and the guest reads R/Z as exactly 33/32 bytes.
    // The JS curve verifier also accepts other encodings which cannot be settled by that guest.
    if (typeof w.sigR !== 'string' || !/^0x0[23][0-9a-fA-F]{64}$/.test(w.sigR)
      || typeof w.sigZ !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(w.sigZ)) return false;
    if (!sameHex(invoice.commit, pool.depositCommit(invoice.cx, invoice.cy, invoice.owner))) return false;
    if (!sameHex(invoice.leaf, pool.leaf(invoice.assetId, invoice.cx, invoice.cy, invoice.owner))) return false;
    if (!sameHex(invoice.depositId, pool.depositId(invoice.assetId, value, invoice.cx, invoice.cy, invoice.owner))) return false;
    const ctx = pool.intentContext(
      'tacit-wrap-intent-v1', invoice.chainBinding, invoice.assetId, invoice.depositId,
      [[invoice.cx, invoice.cy, invoice.owner]], [value]
    );
    return pool.verifyOpeningSigma(invoice.cx, invoice.cy, value, w.sigR, w.sigZ, ctx);
  } catch {
    return false;
  }
}

export function makeConfidentialInvoice({ ux }) {
  if (!ux || !ux.pool || !ux.buildWrap) throw new Error('makeConfidentialInvoice: a confidential-pool-ux instance is required');
  const pool = ux.pool;

  function createInvoice({ recipientPriv, ticker = 'cETH', amountWei, index = 0 }) {
    const meta = ux.assetByTicker[ticker];
    if (!meta) throw new Error(`unknown asset ${ticker}`);
    const w = ux.buildWrap({ walletPriv: recipientPriv, amountWei, ticker, index });
    const invoice = {
      v: 1,
      chainBinding: w.wrapOp.chainBinding,
      assetId: w.wrapOp.asset,
      underlying: meta.underlying,
      ticker,
      amount: w.amount,
      value: w.wrapOp.value,
      cx: w.wrapOp.cx,
      cy: w.wrapOp.cy,
      owner: w.wrapOp.owner,
      commit: w.commit,
      depositId: w.depositId,
      leaf: w.leaf,
      memo: w.memo,
      witness: w.wrapOp,
    };
    return { invoice, claim: { index } };
  }

  function verifyInvoice(invoice) {
    return verifyConfidentialInvoice(invoice, { pool, assetByTicker: ux.assetByTicker, chainBinding: ux.chainBindingHex() });
  }

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

  function settleInputs(invoice) {
    if (!verifyInvoice(invoice)) throw new Error('invoice failed verification (malformed / not claimable)');
    return {
      depositsConsumed: [invoice.depositId],
      leaves: [invoice.leaf],
      memos: [invoice.memo],
      witness: invoice.witness,
    };
  }

  function isPaid(invoice, wrapEvents) {
    return (wrapEvents || []).some((e) => lc(e.depositId) === lc(invoice.depositId));
  }

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
