// Task rewards: a fixed amount of TAC credited to the account that did a listed job's step, outside the daily pot.
//
// A step is credited as a ledger adjustment (lib/points-adjustments.js), so it adds to what the address is owed and touches
// nothing else: no day's split, rate ceiling, weight or multiplier reads the ledger. The amount is what the step's gas costs
// at a slow-mode price, in TAC at the deepest venue's price, plus a tip; both inputs are read from the chain at the step's own
// block (the gas price) or from the quotes the service sampled around it (the TAC price), and the result is fixed when the
// step is credited.
//
// Everything here is pure and BigInt, so the service, its tests and the page can state the same figures.
import { keccak256, toBytes, encodeAbiParameters, pad } from 'viem';

export const WAD = 10n ** 18n;
export const CREATEX = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
const topic = (sig) => keccak256(toBytes(sig));
export const CONTRACT_CREATION = topic('ContractCreation(address,bytes32)');
export const ASSET_REGISTERED = topic('AssetRegistered(bytes32,address,uint256,string,string,uint8)');
// The catch-up registry's own event for a point it kept: Posted(size, blockNumber, by), with the size indexed.
export const POSTED = topic('Posted(uint256,uint256,address)');

// The salt CreateX uses for a salt that starts with 20 zero bytes and the flag 0x01 (the chain-bound form the package uses).
export const guardedSalt = (chainId, salt) => keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [BigInt(chainId), salt]));

// The salt CreateX uses for a salt that starts with 20 zero bytes and the flag 0x00 (the form that names the same address on every
// chain: no deployer and no chain id is mixed in, so the init code alone fixes what lands there).
export const unboundSalt = (salt) => keccak256(salt);

const lower = (s) => String(s).toLowerCase();

// The chain a step is on (its own, else its job's) and the salt CreateX guards its deployment under there.
export const stepChain = (job, step) => step.chainId ?? job.chainId;
export const saltOf = (chainId, step) => (step.bound === false ? unboundSalt(step.salt) : guardedSalt(chainId, step.salt));

// ── the price of gas at a block ──

// A slow-mode price for a block: its base fee plus the `pct`th percentile of the tips its transactions paid, kept between
// `floor` and `cap`. A block with no tipping transaction pays the floor. Read from the block alone, so it is the same
// figure whenever it is asked for.
export function slowGasPrice(block, { pct = 10, floor = 10_000_000n, cap = 2_000_000_000n } = {}) {
  const base = BigInt(block.baseFeePerGas ?? 0n);
  const tips = [];
  for (const tx of block.transactions ?? []) {
    if (typeof tx === 'string') continue;
    const paid = BigInt(tx.gasPrice ?? tx.maxFeePerGas ?? 0n);
    if (paid > base) tips.push(paid - base);
  }
  tips.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let tip = tips.length ? tips[Math.min(tips.length - 1, Math.floor((tips.length * pct) / 100))] : floor;
  if (tip < floor) tip = floor;
  if (tip > cap) tip = cap;
  return base + tip;
}

// ── the price of TAC ──

const median = (xs) => {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2n;
};

// TAC (wei) one ETH buys at time `t`, from sampled quotes [{ t, tacPerEth }]: the lower of the sample nearest `t` (within
// `maxAgeSecs`, either side) and the median of the `windowSecs` before it. The lower figure is the dearer TAC and pays out
// less, so neither a momentary dump of TAC nor a gap in the samples raises a reward. null when no sample is near enough.
export function tacPerEthAt(quotes, t, { maxAgeSecs = 7200, windowSecs = 21600 } = {}) {
  let near = null;
  for (const q of quotes) {
    if (Math.abs(q.t - t) > maxAgeSecs) continue;
    if (!near || Math.abs(q.t - t) < Math.abs(near.t - t) || (Math.abs(q.t - t) === Math.abs(near.t - t) && q.t < near.t)) near = q;
  }
  if (!near) return null;
  const recent = quotes.filter((q) => q.t <= near.t && q.t > near.t - windowSecs).map((q) => BigInt(q.tacPerEth));
  const mid = recent.length ? median(recent) : BigInt(near.tacPerEth);
  const now = BigInt(near.tacPerEth);
  return now < mid ? now : mid;
}

// ── the reward ──

// TAC (wei) for a step of `gas` units: the gas at `gasPriceWei`, in TAC at `tacPerEth`, times (1 + tipBps/10000), at least
// the step's share (by gas) of the job's floor and at most its share of the job's cap, rounded down to 0.01 TAC.
// A step may name its own least and most (`minWei`, `maxWei`): a step on a chain where gas costs next to nothing still takes the
// effort of a person to send, and pays that least; one that names none takes its share of the job's floor and cap.
export function stepReward({ gas, jobGas, gasPriceWei, tacPerEth, tipBps = 10_000n, floorWei, capWei, minWei = null, maxWei = null }) {
  const g = BigInt(gas), jg = BigInt(jobGas);
  if (g <= 0n || jg < g) throw new Error('a step is part of its job, with gas of its own');
  const cost = (g * BigInt(gasPriceWei) * BigInt(tacPerEth)) / WAD;
  let wei = (cost * (10_000n + BigInt(tipBps))) / 10_000n;
  const lo = minWei != null ? BigInt(minWei) : (BigInt(floorWei) * g) / jg, hi = maxWei != null ? BigInt(maxWei) : (BigInt(capWei) * g) / jg;
  if (wei < lo) wei = lo;
  if (wei > hi) wei = hi;
  return wei - (wei % (WAD / 100n));
}

// ── what a transaction completed ──

// The steps of `job` that a successful transaction completes, each with what shows it: { step, proof }. `tx` and `receipt` are
// viem's. A deployment through CreateX is shown by CreateX's own log for the planned address (the address commits to the init
// code, so nothing else can be there); a registration by the pool's own event for the planned asset; a pair, which emits no
// event, by a top-level call to the pool with exactly the planned call data (it reverts when the pair exists, so a call that
// succeeded made it).
export function stepsCompleted(job, tx, receipt, chainId = job.chainId) {
  if (receipt.status !== 'success') return [];
  const out = [];
  const logs = receipt.logs ?? [];
  for (const step of job.steps) {
    if (stepChain(job, step) !== chainId) continue;
    if (step.kind === 'createx') {
      const want = pad(step.expected, { size: 32 }).toLowerCase();
      const salt = saltOf(chainId, step);
      const hit = logs.find((l) => lower(l.address) === lower(CREATEX) && l.topics?.[0] === CONTRACT_CREATION
        && lower(l.topics[1]) === want && lower(l.topics[2] ?? '') === lower(salt));
      if (hit) out.push({ step, proof: { log: hit.logIndex } });
    } else if (step.kind === 'register') {
      const hit = logs.find((l) => lower(l.address) === lower(step.to) && l.topics?.[0] === ASSET_REGISTERED && lower(l.topics[1]) === lower(step.asset));
      if (hit) out.push({ step, proof: { log: hit.logIndex } });
    } else if (step.kind === 'pair') {
      if (tx.to && lower(tx.to) === lower(step.to) && keccak256(tx.input) === step.dataHash) out.push({ step, proof: { call: true } });
    } else if (step.kind === 'post') {
      // The registry keeps a point only when the pool held its root, and says so in this event: one for a count of at least
      // `minSize` (a point near the pool's head, not a trivial early one) is the step.
      const hit = logs.find((l) => lower(l.address) === lower(step.to) && l.topics?.[0] === POSTED && l.topics[1] && BigInt(l.topics[1]) >= BigInt(step.minSize));
      if (hit) out.push({ step, proof: { log: hit.logIndex } });
    } else if (step.kind === 'review') {
      // What is done off this chain is read by hand: the sender names the Bitcoin transaction in a transaction to itself, and the
      // step lists the hash of that transaction once the work has been read on both chains.
      if (tx.to && lower(tx.to) === lower(tx.from) && /^0x[0-9a-fA-F]{64}$/.test(tx.input ?? '') && step.approved.some((h) => lower(h) === lower(tx.hash))) out.push({ step, proof: { reviewed: true } });
    }
  }
  return out;
}

// What a job's file says, checked: every step has the fields its kind needs and its own gas. Returns the job, or throws.
export function checkJob(job) {
  const hex = (v, n) => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(v);
  if (!/^[a-z0-9-]{1,40}$/.test(job.id ?? '') || !Number.isInteger(job.chainId)) throw new Error('job needs an id and a chain');
  const wei = (v) => typeof v === 'string' && /^[0-9]{1,30}$/.test(v);
  if (!Array.isArray(job.steps) || !job.steps.length) throw new Error(`${job.id}: no steps`);
  const seen = new Set();
  for (const s of job.steps) {
    if (!/^[a-z0-9-]{1,40}$/.test(s.id ?? '') || seen.has(s.id)) throw new Error(`${job.id}: step id ${s.id}`);
    seen.add(s.id);
    if (!Number.isInteger(s.gas) || s.gas <= 0) throw new Error(`${job.id}/${s.id}: gas`);
    if (s.chainId != null && !(Number.isInteger(s.chainId) && s.chainId > 0)) throw new Error(`${job.id}/${s.id}: chainId`);
    if ((s.minWei != null && !wei(s.minWei)) || (s.maxWei != null && !wei(s.maxWei)) || (s.minWei != null && s.maxWei != null && BigInt(s.minWei) > BigInt(s.maxWei))) throw new Error(`${job.id}/${s.id}: minWei and maxWei`);
    if (!hex(s.to, 40)) throw new Error(`${job.id}/${s.id}: to`);
    if (s.kind === 'createx') { if (!hex(s.expected, 40) || !hex(s.salt, 64) || !hex(s.initCodeHash, 64) || (s.bound != null && typeof s.bound !== 'boolean')) throw new Error(`${job.id}/${s.id}: createx fields`); }
    else if (s.kind === 'post') { if (!Number.isInteger(s.minSize) || s.minSize < 2) throw new Error(`${job.id}/${s.id}: minSize`); }
    else if (s.kind === 'register') { if (!hex(s.asset, 64)) throw new Error(`${job.id}/${s.id}: asset`); }
    else if (s.kind === 'pair') { if (!hex(s.dataHash, 64)) throw new Error(`${job.id}/${s.id}: dataHash`); }
    else if (s.kind === 'review') { if (!Array.isArray(s.approved) || !s.approved.every((h) => hex(h, 64)) || s.minWei == null || s.minWei !== s.maxWei) throw new Error(`${job.id}/${s.id}: review fields`); }
    else throw new Error(`${job.id}/${s.id}: kind ${s.kind}`);
  }
  return job;
}

export const jobGas = (job) => job.steps.reduce((n, s) => n + s.gas, 0);
export const claimId = (job, step) => `task:${job.id}:${step.id}`;

// ── when a credit may be applied ──

// Whether a credit of `wei` can be applied now without the distributor's funding or the tasks budget standing in the way:
// the tasks budget has room, the program (and its on-chain root deadline) has not ended, and after the credit the funding
// still covers `reserveDays` whole days of the regular pot. `status(extraWei)` is the funding status with the ledger raised
// by that much (lib/points-funding.js), null when it cannot be read. Returns null to apply, else the reason it waits.
export function holdReason({ wei, creditedWei, budgetWei, nowSec, endSec, status, reserveDays }) {
  if (!endSec || nowSec > endSec) return 'ended';
  if (creditedWei + wei > budgetWei) return 'budget';
  const s = status(wei);
  if (!s) return 'funding unread';
  if (s.shortfallWei > 0n || s.daysCovered < reserveDays) return 'funding';
  return null;
}
