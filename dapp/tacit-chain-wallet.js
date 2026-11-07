// The tacit chain's wallet: what turns a seed into private TAC on the chain. It builds a spend (the body its owners sign, the notes it makes
// with their hybrid post-quantum memos, the Halo2 proof from the pool's wasm prover), hands it to a leader, and finds the notes that are its
// own among the chain's published memos. Byte for byte the block program's (docs/TACIT-BLOCKS.md; vectors in tests/vectors/).
//
//   const w = makeChainWallet({ poseidon, prover, chain, asset });  // prover: makeHalo2System(...), chain: the contract's CHAIN, asset: TAC's field
//   const me = w.keys(seed);                                        // spending keys (BabyJubJub) and memo keys (secp256k1 + ML-KEM-768)
//   w.address(me)                                                   // what a payer needs
//   const { submission, deposit, created } = await w.spend(me, { dep: { v }, outputs: [...] })  // a shield; deposit() it on L1, POST submission to /spend
//   const { notes } = await w.scan(me, leader)                      // the notes the chain's memos show to be mine, unspent
//
// A spend is padded to two output notes (a zero-valued one to oneself when it makes one), so every spend adds the same number of leaves.

import { sha256, concatBytes } from './vendor/tacit-deps.min.js';
import { makeBtcPoolZk, assetField, bodyHash as zkBodyHash, ZK_N_IN, ZK_N_OUT, L_BJJ } from './btc-pool-zk.js';
import { memoKeys, sealMemo, openMemo, memoHash, MEMO_LEN } from './tacit-chain-memo.js';
import { lockOp } from './tacit-chain-lock.js';

export { assetField };
const te = new TextEncoder();
const OP_HOP = 1;
const OP_MIGRATE = 3;
const OP_POOL = 4;

// ── shares (common/src/lib.rs): notes count shares of the chain's pool; a share is worth pool / shares units (1e-8 TAC), one
// while there are none. These mirror the program's checks exactly, so a spend built with them is one it takes.
export const EXIT_FEE_BPS = 10n;
export const MIN_POOL_FEE = 200_000n;
/// The shares a lock's claim or refund note is worth less than the lock of `value` shares (the holders' part: EXIT_FEE_BPS of it,
/// rounded up, at least one): seal its memos with the lock's value less this (common/src/lib.rs `lock_fee`).
export const lockFee = (value) => { const f = ceilDiv(BigInt(value) * EXIT_FEE_BPS, 10_000n); return f > 0n ? f : 1n; };
/// Whether a lock of `value` shares may be made at `rate`: its fee must be worth at least MIN_POOL_FEE (so a lock is about 2 TAC or more).
export const lockAllowed = (value, rate) => { const [p, s] = rateOf(rate); return BigInt(value) > lockFee(value) && lockFee(value) * p >= MIN_POOL_FEE * s; };
/// The units of pool and shares the rate counts that no note holds (common/src/lib.rs VIRTUAL).
export const VIRTUAL = 100_000_000n;
const rateOf = ({ pool, shares }) => [BigInt(pool) + VIRTUAL, BigInt(shares) + VIRTUAL];
const ceilDiv = (a, b) => (a + b - 1n) / b;
/// What `shares` are worth now, in units (rounded down).
export const worthOf = (shares, rate) => { const [p, s] = rateOf(rate); return BigInt(shares) * p / s; };
/// The margin a shield leaves for the rate to rise before it lands, in basis points: room for about five payments' pool shares in a
/// small pool (each raises the rate by MIN_POOL_FEE / (pool + VIRTUAL)), 2 bps once the pool is large.
export function shieldMargin(rate) {
  const [p] = rateOf(rate);
  const m = ceilDiv(5n * MIN_POOL_FEE * 10_000n, p);
  return m < 2n ? 2n : m > 200n ? 200n : m;
}
/// The most shares `amount` units buy at `rate` (the program's `covers`), less `marginBps` for the rate to rise before the shield lands
/// (by default `shieldMargin`).
export function sharesFor(amount, rate, marginBps = null) {
  if (marginBps == null) marginBps = shieldMargin(rate);
  const [p, s] = rateOf(rate);
  return BigInt(amount) * s * (10_000n - BigInt(marginBps)) / (p * 10_000n);
}
/// Whether `shares` may pay out `amount` units (the program's `pays`: their worth less the exit fee, EXIT_FEE_BPS rounded up and at
/// least MIN_POOL_FEE).
export function pays(amount, shares, rate) {
  const [p, s] = rateOf(rate);
  const worth = BigInt(shares) * p;
  let fee = worth / 10_000n * EXIT_FEE_BPS + ceilDiv(worth % 10_000n * EXIT_FEE_BPS, 10_000n);
  if (fee < MIN_POOL_FEE * s) fee = MIN_POOL_FEE * s;
  return worth >= fee && BigInt(amount) * s <= worth - fee;
}
/// The fewest shares that pay out `amount` units at `rate`, the exit fee included.
export function sharesToPay(amount, rate) {
  const [p, s] = rateOf(rate);
  let n = ceilDiv(BigInt(amount) * s * 10_000n, p * (10_000n - EXIT_FEE_BPS));
  // a small exit pays the minimum fee: start from what the amount plus that is worth
  const floor = ceilDiv((BigInt(amount) + MIN_POOL_FEE) * s, p);
  if (n < floor) n = floor;
  while (!pays(amount, n, rate)) n += 1n;
  return n;
}
/// The fewest shares worth MIN_POOL_FEE: a payment's pool share.
export function poolShare(rate) {
  const [p, s] = rateOf(rate);
  return ceilDiv(MIN_POOL_FEE * s, p);
}
/// A pool share's operation bytes: the exit's shares to the chain's holders.
export const poolOp = () => Uint8Array.of(OP_POOL);
const hx = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (h, n, what) => {
  const b = h instanceof Uint8Array ? h : Uint8Array.from(String(h).replace(/^0x/, '').match(/../g) || [], (x) => parseInt(x, 16));
  if (n != null && b.length !== n) throw new Error(`tacit-chain-wallet: ${what} is not ${n} bytes`);
  return b;
};
const be = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const fromBe = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const randomBytes = (n) => { const o = new Uint8Array(n); globalThis.crypto.getRandomValues(o); return o; };
const randomBlinding = () => { for (;;) { const r = fromBe(randomBytes(32)) % L_BJJ; if (r > 0n && r < (1n << 250n)) return r; } };
const ZERO32 = new Uint8Array(32);

const BODY_DOMAIN = te.encode('tacit-block-body-v1');
const OP_BODY_DOMAIN = te.encode('tacit-block-op-body-v1');

/// A payment's body: what the program recomputes and every input's owner signed (common/src/lib.rs `body_bytes`).
export function bodyBytes(chain, outs, memoHashes, exitTo, amounts, salt) {
  return concatBytes(BODY_DOMAIN, bytes(chain, 32, 'chain'), ...outs.map((o) => be(o, 32)), ...memoHashes, bytes(exitTo, 20, 'exit address'), amountsBytes(amounts), bytes(salt, 32, 'salt'));
}

/// The TAC the owners sign to cross the edge (common/src/lib.rs `amounts_bytes`): the deposit's amount, then the exit's, u64 each.
const amountsBytes = ([dep, exit]) => concatBytes(be(dep ?? 0n, 8), be(exit ?? 0n, 8));

/// A spend that puts its exit's value in an operation: `opBytes` is the operation's serialization (`op_body_bytes`).
export function opBodyBytes(chain, outs, memoHashes, opBytes, amounts, salt) {
  return concatBytes(OP_BODY_DOMAIN, bytes(chain, 32, 'chain'), ...outs.map((o) => be(o, 32)), ...memoHashes, opBytes, amountsBytes(amounts), bytes(salt, 32, 'salt'));
}

const opening = (o) => (o ? concatBytes(Uint8Array.of(1), be(o.v, 8), be(o.r, 32), be(o.amount ?? 0n, 8)) : Uint8Array.of(0));

/// The rest of a spend beside its proof (common/src/lib.rs `SpendData::to_bytes`): memo hashes, exit address, salt, the deposit's and the
/// exit's openings, and an operation after a 1.
export function spendData({ memoHashes, exitTo, salt, dep, exit, opBytes }) {
  return concatBytes(...memoHashes, bytes(exitTo, 20, 'exit address'), salt, opening(dep), opening(exit), ...(opBytes ? [Uint8Array.of(1), opBytes] : []));
}

/// A hop's operation bytes: the exit's value into the confidential pool as a deposit for `commit` (its keccak(Cx ‖ Cy ‖ owner)).
export const hopOp = (commit) => concatBytes(Uint8Array.of(OP_HOP), bytes(commit, 32, 'commit'));

/// A migration's operation bytes: the exit's value to the successor chain `to` (its landing contract), for the note `note` names there.
/// The block publishes only each successor's total, so the amount stays hidden and the note keeps this chain's anonymity set.
export const migrateOp = (to, note) => {
  const t = bytes(to, 20, 'successor');
  if (t.every((x) => x === 0)) throw new Error('tacit-chain-wallet: a successor address');
  return concatBytes(Uint8Array.of(OP_MIGRATE), t, bytes(note, 32, 'note'));
};
/// The item a migration publishes (the block program's `migration_item`), which a successor checks the note and value it is shown against.
export const migrationItem = (to, note, value) => sha256(concatBytes(te.encode('tacit-block-migrate-v1'), bytes(to, 20, 'successor'), bytes(note, 32, 'note'), be(value, 8)));

export function makeChainWallet({ poseidon, prover, chain, asset, network = 'mainnet' }) {
  const Z = makeBtcPoolZk({ poseidon });
  const assetF = BigInt(asset);
  const chainB = bytes(chain, 32, 'chain');

  /// Spending keys (the pool's BabyJubJub keys) and memo keys (secp256k1 scan key, ML-KEM-768), both from the 32-byte seed.
  function keys(seed) {
    const zk = Z.walletKeys(seed, network);
    return { seed, zk, memo: memoKeys(seed) };
  }

  /// What a payer needs: the spending and nullifier public keys, the scan key and the ML-KEM key.
  function address(k) {
    return { A: k.zk.A, N: k.zk.N, scanPub: k.memo.address.scanPub, kemPub: k.memo.address.kemPub };
  }

  const ADDRESS_LEN = 128 + 33 + 1184;
  const addressBytes = (a) => concatBytes(be(a.A[0], 32), be(a.A[1], 32), be(a.N[0], 32), be(a.N[1], 32), a.scanPub, a.kemPub);
  /// What a Tacit address's chain lane carries: SHA-256("tacit-chain-address-v1" ‖ the full address).
  const chainAddressHash = (a) => sha256(concatBytes(te.encode('tacit-chain-address-v1'), addressBytes(a)));
  /// The full address for a chain lane's hash, from a leader's directory, checked against the hash (a directory can only withhold it).
  async function resolve(hash, leader) {
    const h = bytes(hash, 32, 'chain address hash');
    const full = await leader.address(hx(h));
    if (!full) throw new Error('tacit-chain-wallet: no leader knows this chain address yet');
    const a = decodeAddress('tc1' + String(full).replace(/^0x/, ''));
    if (hx(chainAddressHash(a)) !== hx(h)) throw new Error('tacit-chain-wallet: the directory answered with another address');
    return a;
  }
  /// Publishes this wallet's full address to a leader's directory, so a Tacit address with its chain lane can be paid.
  const publish = (k, leader) => leader.publish(hx(addressBytes(address(k))));
  function encodeAddress(a) {
    return 'tc1' + hx(addressBytes(a)).slice(2);
  }
  function decodeAddress(s) {
    if (!String(s).startsWith('tc1')) throw new Error('tacit-chain-wallet: not a tacit chain address');
    const b = bytes('0x' + s.slice(3), ADDRESS_LEN, 'address');
    return { A: [fromBe(b.subarray(0, 32)), fromBe(b.subarray(32, 64))], N: [fromBe(b.subarray(64, 96)), fromBe(b.subarray(96, 128))], scanPub: b.slice(128, 161), kemPub: b.slice(161) };
  }

  /// A note for `to` (an address) of `value`: its memo, and the keys the shared secret gives it.
  function makeNote(to, value) {
    const { memo, s } = sealMemo({ scanPub: to.scanPub, kemPub: to.kemPub }, value);
    const { npk, rho } = Z.outputKeys(to.A, to.N, s);
    return { v: BigInt(value), npk, rho, memo, s, leaf: Z.leafOf(assetF, value, npk, rho) };
  }

  /// Builds a spend.
  ///   inputs   owned notes from `scan` ({ index, value, s, leaf }), at most two
  ///   outputs  [{ to: address, value }]: at most three (two once padded); the rest of the inputs goes to oneself as change
  ///   dep      { v } to take in a deposit (made with `deposit()` on L1 first), the shield's amount
  ///   exit     { v, to: 20-byte address } to pay out on L1, or { v, op } to put the value in an operation (`hopOp`, `lockOp`)
  ///   leader   { path(index) → { root, path } } for the inputs' membership
  /// → { submission (what POST /spend takes), deposit (what TacitBlocks.deposit takes, for a shield), created (the notes it makes) }
  async function spend(k, { inputs = [], outputs = [], dep = null, exit = null, leader, pad = 2, opMemo = null, onProgress } = {}) {
    if (inputs.length > ZK_N_IN) throw new Error('tacit-chain-wallet: at most two inputs');
    const me = address(k);
    const total = inputs.reduce((t, n) => t + BigInt(n.value), 0n) + BigInt(dep?.v ?? 0);
    const spent = outputs.reduce((t, o) => t + BigInt(o.value), 0n) + BigInt(exit?.v ?? 0);
    if (spent > total) throw new Error('tacit-chain-wallet: more out than in');
    const outs = outputs.map((o) => ({ ...makeNote(o.to, o.value), self: false }));
    if (total > spent) outs.push({ ...makeNote(me, total - spent), self: true });
    while (outs.length < pad) outs.push({ ...makeNote(me, 0n), self: true });
    if (outs.length > ZK_N_OUT) throw new Error('tacit-chain-wallet: at most three output notes');

    const slots = [...outs, ...Array(ZK_N_OUT - outs.length).fill(null)];
    const memoHashes = slots.map((o) => (o ? memoHash(o.memo) : ZERO32));
    const outLeaves = slots.map((o) => (o ? o.leaf : 0n));
    const salt = randomBytes(32);

    const isOp = exit && exit.op;
    const exitTo = isOp || !exit ? new Uint8Array(20) : bytes(exit.to, 20, 'exit address');
    const amounts = [BigInt(dep?.amount ?? 0n), BigInt(exit?.amount ?? 0n)];
    const body = isOp ? opBodyBytes(chainB, outLeaves, memoHashes, exit.op, amounts, salt) : bodyBytes(chainB, outLeaves, memoHashes, exitTo, amounts, salt);
    const bh = zkBodyHash(body);

    // the inputs: membership in the chain's current note tree, and a signature of each note's owner over the body
    let root = 0n;
    const witnessIn = [];
    for (const n of inputs) {
      const { root: r, path } = await leader.path(n.index);
      root = BigInt(r);
      const own = Z.ownedKeys(k.zk, n.s);
      if (Z.leafOf(assetF, n.value, own.npk, own.rho) !== BigInt(n.leaf)) throw new Error('tacit-chain-wallet: a note is not this wallet\'s');
      witnessIn.push({ v: BigInt(n.value), rho: own.rho, nk: own.nk, Ak: own.Ak, index: BigInt(n.index), path: path.map(BigInt), sig: Z.sign(own.sk, bh) });
    }
    while (witnessIn.length < ZK_N_IN) witnessIn.push(null);

    // shares in the commitments; the TAC crossing the edge (a deposit's amount, an exit's, hop's or migration's payout) beside them
    const depO = dep ? { v: BigInt(dep.v), r: randomBlinding(), amount: BigInt(dep.amount) } : null;
    const exitO = exit ? { v: BigInt(exit.v), r: randomBlinding(), amount: BigInt(exit.amount ?? 0n) } : null;
    const w = Z.buildWitness({ root, bodyHash: bh, assetF, inputs: witnessIn, outputs: slots.map((o) => (o ? { v: o.v, npk: o.npk, rho: o.rho } : null)), exit: exitO && { v: exitO.v, r: exitO.r }, dep: depO && { v: depO.v, r: depO.r } });
    const proved = await prover.prove(w.input, { onProgress });
    const signals = proved.publicSignals.map(BigInt);
    const publics = concatBytes(...signals.map((x) => be(x, 32)));
    const data = spendData({ memoHashes, exitTo, salt, dep: depO, exit: exitO, opBytes: isOp ? exit.op : null });
    const memos = slots.filter(Boolean).map((o) => hx(o.memo));
    const submission = { publics: hx(publics), proof: hx(proved.wire), data: hx(data), memos, opMemos: opMemo ? [hx(opMemo)] : [] };
    const created = outs.map((o, j) => ({ slot: j, value: o.v, self: o.self, s: o.s, leaf: o.leaf }));
    // a shield: what TacitBlocks.deposit takes (the commitment is the deposit's public inputs, the body hash is the spend's)
    const deposit = depO ? { shares: depO.v, amount: depO.amount, cx: hx(be(signals[10], 32)), cy: hx(be(signals[11], 32)), body: hx(be(signals[1], 32)) } : null;
    return { submission, deposit, created, publics: signals, nullifiers: signals.slice(3, 5).filter((x) => x !== 0n).map((x) => hx(be(x, 32))) };
  }

  /// Finds this wallet's notes among the chain's published memos, from `from` on: each memo that opens with this wallet's keys and whose
  /// note leaf is the one published at that index. → { notes (unspent), spent, next }
  async function scan(k, leader, { from = 0, known = [] } = {}) {
    const mine = [...known];
    let next = from;
    for (;;) {
      const page = await leader.notes(next, 200);
      page.leaves.forEach((leaf, i) => {
        const opened = openMemo(bytes(page.memos[i], MEMO_LEN, 'memo'), k.memo.secret);
        if (!opened) return;
        const own = Z.ownedKeys(k.zk, opened.s);
        const mineLeaf = Z.leafOf(assetF, opened.value, own.npk, own.rho);
        if (mineLeaf !== BigInt(leaf) || opened.value === 0n) return;
        mine.push({ index: next + i, value: opened.value, s: opened.s, leaf: mineLeaf });
      });
      if (page.next >= page.total || page.leaves.length === 0) { next = page.total; break; }
      next = page.next;
    }
    const notes = [];
    const spent = [];
    for (const n of mine) {
      const own = Z.ownedKeys(k.zk, n.s);
      const nf = Z.nullifier(own.nk, n.leaf, n.index);
      (await leader.spent(hx(be(nf, 32))) ? spent : notes).push({ ...n, nullifier: hx(be(nf, 32)) });
    }
    return { notes, spent, next };
  }

  return { keys, address, encodeAddress, decodeAddress, chainAddressHash, resolve, publish, spend, scan, makeNote, Z };
}

export { sha256, lockOp };
