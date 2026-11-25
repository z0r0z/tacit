// A pledge belongs to one desk key. Its roots are Bitcoin outpoints chosen by the operator.
const idOf = ({ txid, vout }) => `${txid}:${vout}`;

export function makePledge(config) {
  if (config === undefined) return null;
  if (!config || !Array.isArray(config.outpoints)) throw new Error('pledge.outpoints must be an array of txid:vout strings');
  const roots = new Set();
  for (const id of config.outpoints) {
    if (typeof id !== 'string' || !/^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$/.test(id) || Number(id.slice(65)) > 0xffffffff || roots.has(id)) {
      throw new Error('pledge.outpoints contains an invalid or repeated outpoint');
    }
    roots.add(id);
  }
  const { minDiscountBps, maxDiscountBps, maxMinerFeeSats } = config;
  if (!Number.isInteger(minDiscountBps) || !Number.isInteger(maxDiscountBps) ||
      minDiscountBps < 0 || minDiscountBps > maxDiscountBps || maxDiscountBps >= 10_000) {
    throw new Error('pledge needs whole discount bounds from 0 through 9999 bps, minimum first');
  }
  if (!Number.isSafeInteger(maxMinerFeeSats) || maxMinerFeeSats <= 0) throw new Error('pledge.maxMinerFeeSats must be a positive whole number');

  function permits(value, out) {
    const input = BigInt(value), payout = BigInt(out), discount = (input - payout) * 10_000n;
    return payout > 0n && discount >= input * BigInt(minDiscountBps) && discount <= input * BigInt(maxDiscountBps);
  }

  function inventory(notes, records) {
    const allowed = new Map([...roots].map((id) => [id, [id]])), used = new Set();
    for (const r of records) {
      if (!r.lockPair) continue;
      for (const n of r.noteInputs || []) used.add(idOf(n));
      // lockTransfer always puts its own TAC change at vout 1. Only change from a
      // funded pledge inherits its roots. An operator can also explicitly pledge it anew.
      const change = r.lockPair.txid + ':1';
      if (!allowed.has(change) && r.pledgeRoots?.length && r.pledgeRoots.every((id) => roots.has(id))) allowed.set(change, r.pledgeRoots);
    }
    const available = [];
    for (const note of notes) {
      const id = idOf(note);
      if (!allowed.has(id) || used.has(id) || BigInt(note.amount) <= 0n) continue;
      available.push({ ...note, pledgeRoots: allowed.get(id) });
      used.add(id);
    }
    return available;
  }
  return { empty: roots.size === 0, terms: { minDiscountBps, maxDiscountBps, maxMinerFeeSats }, permits, inventory };
}

// Check the signed pair before its bytes can be journaled or broadcast. A commit's first
// output funds the reveal, so it cancels when counting the miner fee across both transactions.
export function makePledgedFunding(btc, txOutputEnvelope) {
  return async (method, args, cap, records) => {
    const used = new Set();
    for (const r of records) for (const leg of [r.lockPair, r.refund, r.take]) {
      for (const id of leg?.feeInputs || []) used.add(id);
    }
    const parents = new Map(), coins = [], values = new Map();
    const ownScript = Buffer.from(btc.prims.p2wpkhScript(btc.wallet.pub)).toString('hex');
    for (const coin of await btc.satsUtxos()) {
      const id = idOf(coin);
      if (used.has(id) || values.has(id)) continue;
      // A larger-than-dust output can still carry TAC. Use only coins from plain
      // Bitcoin transactions at this key, checked afresh before every funded leg.
      if (!parents.has(coin.txid)) parents.set(coin.txid, await btc.fetchTx(coin.txid));
      const tx = parents.get(coin.txid), output = tx?.vout[coin.vout];
      if (!tx?.status?.confirmed || !tx.vin?.length || output?.scriptpubkey !== ownScript || output.value !== coin.value ||
          txOutputEnvelope(tx) || await btc.outspend(coin.txid, coin.vout)) continue;
      coins.push(coin);
      values.set(id, coin.value);
    }
    const pair = btc.tx[method]({ ...args, satsUtxos: coins, feeRate: await btc.feeRate() });
    const feeInputs = pair.commitTx.inputs.map(idOf);
    const sum = (outputs) => outputs.reduce((total, o) => total + o.value, 0);
    const fee = feeInputs.reduce((total, id) => total + values.get(id), 0) + sum(args.notes || [args.lockOut])
      - sum(pair.commitTx.outputs.slice(1)) - sum(pair.revealTx.outputs);
    if (!Number.isSafeInteger(fee) || fee < 0 || fee > cap) throw new Error(`desk miner fee ${fee} exceeds the pledge limit of ${cap} sats or is unreadable`);
    return { ...pair, feeInputs };
  };
}
