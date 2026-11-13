// Whether a submitted op can be read as its prover reads it. The reader (dapp/sp1-stdin.js, the relay's board input) follows the per-op
// binary's own reads field for field, defaults and accepted forms included, so an op it cannot read (a field missing, a value not in the
// form the binary takes) is one the binary would stop on as well: such a job could never be proved, and is refused at the door rather
// than after it has taken a turn in the relay's queue and a share of the day's proving budgets. Ops a page builds read cleanly.
// An op type the reader does not know is left to the relay.
import { stdinFor, SELF_PROVE_TYPES } from '../../dapp/sp1-stdin.js';

const ZERO_HASH = '0x' + '00'.repeat(32);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// The batch program (exec-batchtransfer.rs) takes one to 256 transfers under the batch's chain binding and spend root.
const MAX_BATCH = 256;

// → null when the op can go on, or why it cannot be read.
export function opInputGap({ type, op, memos = [] } = {}) {
  if (type === 'batchtransfer' && isObj(op)) {
    const ops = op.ops;
    if (!Array.isArray(ops) || !ops.length) return 'the batchtransfer op has no transfers';
    if (ops.length > MAX_BATCH) return `the batchtransfer op has more than ${MAX_BATCH} transfers`;
    for (const [i, t] of ops.entries()) {
      if (!isObj(t)) return `the batchtransfer op's transfer ${i} is not an object`;
      // the batch program reads each input's secret as `nk`, where a lone transfer reads it as `secret`
      const inputs = Array.isArray(t.inputs) ? t.inputs.map((x) => (isObj(x) ? { ...x, secret: x.nk } : x)) : t.inputs;
      const gap = opInputGap({ type: 'transfer', op: { ...t, chainBinding: op.chainBinding, spendRoot: op.spendRoot, inputs } });
      if (gap) return gap.replace(/^the transfer op/, `the batchtransfer op's transfer ${i}`).replace(/\bsecret\b/, 'nk');
    }
    return null;
  }
  if (!SELF_PROVE_TYPES.includes(type) || !isObj(op)) return null;
  try {
    stdinFor(type, { ...op, memoHashes: (Array.isArray(memos) ? memos : []).map(() => ZERO_HASH) });
    return null;
  } catch (e) {
    return `the ${type} op cannot be read: ${String(e?.message || e).replace(/^sp1-stdin \S+: /, '').slice(0, 160)}`;
  }
}
