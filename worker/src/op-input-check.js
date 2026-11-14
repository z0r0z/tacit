// Whether a submitted op can be read as its prover reads it. The reader (dapp/sp1-stdin.js, the relay's board input) follows the per-op
// binary's own reads field for field, defaults and accepted forms included, so an op it cannot read (a field missing, a value not in the
// form the binary takes) is one the binary would stop on as well: such a job could never be proved, and is refused at the door rather
// than after it has taken a turn in the relay's queue and a share of the day's proving budgets. Ops a page builds read cleanly.
// An op type the reader does not know is left to the relay.
import { stdinFor, SELF_PROVE_TYPES } from '../../dapp/sp1-stdin.js';
import { readWrapStdin, readDepositHead, wrapOpens } from './proof-pool.js';

const ZERO_HASH = '0x' + '00'.repeat(32);
// OP_WRAPTRANSFER's type byte and the intent tag its deposit's signature is made under (contracts/sp1/confidential/src/main.rs).
const OP_WRAPTRANSFER = 27;
const WRAPTRANSFER_TAG = 'tacit-wraptransfer-intent-v1';

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
    const stdin = stdinFor(type, { ...op, memoHashes: (Array.isArray(memos) ? memos : []).map(() => ZERO_HASH) });
    // A wrap's program also stops on a signature that does not open its commitment (proof-pool.js wrapOpens, as the program checks it).
    if (type === 'wrap' && !wrapOpens(readWrapStdin(stdinFor('wrap', { ...op, memoHashes: [ZERO_HASH] })))) return 'the wrap op\'s signature does not open its commitment';
    // So does a wrap-transfer's, for the deposit it spends, under its own tag. The deposit is read from the input just built, which is what
    // the program reads; an input this cannot read the deposit from is left to the program rather than refused on a guess.
    if (type === 'wraptransfer') {
      let deposit = null;
      try { deposit = readDepositHead(stdin, OP_WRAPTRANSFER); } catch { /* not read here */ }
      if (deposit && !wrapOpens(deposit, WRAPTRANSFER_TAG)) return 'the wraptransfer op\'s deposit signature does not open its commitment';
    }
    return null;
  } catch (e) {
    return `the ${type} op cannot be read: ${String(e?.message || e).replace(/^sp1-stdin \S+: /, '').slice(0, 160)}`;
  }
}
