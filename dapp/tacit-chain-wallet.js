
import { sha256, concatBytes } from './vendor/tacit-deps.min.js';
import { makeBtcPoolZk, assetField, bodyHash as zkBodyHash, ZK_N_IN, ZK_N_OUT, L_BJJ } from './btc-pool-zk.js';
import { memoKeys, sealMemo, openMemo, memoHash, MEMO_LEN } from './tacit-chain-memo.js';
import { lockOp } from './tacit-chain-lock.js';

export { assetField };
const te = new TextEncoder();
const OP_HOP = 1;
const OP_MIGRATE = 3;
const OP_POOL = 4;

export const EXIT_FEE_BPS = 10n;
export const MIN_POOL_FEE = 200_000n;
export const lockFee = (value) => { const f = ceilDiv(BigInt(value) * EXIT_FEE_BPS, 10_000n); return f > 0n ? f : 1n; };
export const lockAllowed = (value, rate) => { const [p, s] = rateOf(rate); return BigInt(value) > lockFee(value) && lockFee(value) * p >= MIN_POOL_FEE * s; };
export const VIRTUAL = 100_000_000n;
const rateOf = ({ pool, shares }) => [BigInt(pool) + VIRTUAL, BigInt(shares) + VIRTUAL];
const ceilDiv = (a, b) => (a + b - 1n) / b;
export const worthOf = (shares, rate) => { const [p, s] = rateOf(rate); return BigInt(shares) * p / s; };
export function shieldMargin(rate) {
  const [p] = rateOf(rate);
  const m = ceilDiv(5n * MIN_POOL_FEE * 10_000n, p);
  return m < 2n ? 2n : m > 200n ? 200n : m;
}
export function sharesFor(amount, rate, marginBps = null) {
  if (marginBps == null) marginBps = shieldMargin(rate);
  const [p, s] = rateOf(rate);
  return BigInt(amount) * s * (10_000n - BigInt(marginBps)) / (p * 10_000n);
}
export function pays(amount, shares, rate) {
  const [p, s] = rateOf(rate);
  const worth = BigInt(shares) * p;
  let fee = worth / 10_000n * EXIT_FEE_BPS + ceilDiv(worth % 10_000n * EXIT_FEE_BPS, 10_000n);
  if (fee < MIN_POOL_FEE * s) fee = MIN_POOL_FEE * s;
  return worth >= fee && BigInt(amount) * s <= worth - fee;
}
export function sharesToPay(amount, rate) {
  const [p, s] = rateOf(rate);
  let n = ceilDiv(BigInt(amount) * s * 10_000n, p * (10_000n - EXIT_FEE_BPS));
  const floor = ceilDiv((BigInt(amount) + MIN_POOL_FEE) * s, p);
  if (n < floor) n = floor;
  while (!pays(amount, n, rate)) n += 1n;
  return n;
}
export function poolShare(rate) {
  const [p, s] = rateOf(rate);
  return ceilDiv(MIN_POOL_FEE * s, p);
}
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

export function bodyBytes(chain, outs, memoHashes, exitTo, amounts, salt) {
  return concatBytes(BODY_DOMAIN, bytes(chain, 32, 'chain'), ...outs.map((o) => be(o, 32)), ...memoHashes, bytes(exitTo, 20, 'exit address'), amountsBytes(amounts), bytes(salt, 32, 'salt'));
}

const amountsBytes = ([dep, exit]) => concatBytes(be(dep ?? 0n, 8), be(exit ?? 0n, 8));

export function opBodyBytes(chain, outs, memoHashes, opBytes, amounts, salt) {
  return concatBytes(OP_BODY_DOMAIN, bytes(chain, 32, 'chain'), ...outs.map((o) => be(o, 32)), ...memoHashes, opBytes, amountsBytes(amounts), bytes(salt, 32, 'salt'));
}

const opening = (o) => (o ? concatBytes(Uint8Array.of(1), be(o.v, 8), be(o.r, 32), be(o.amount ?? 0n, 8)) : Uint8Array.of(0));

export function spendData({ memoHashes, exitTo, salt, dep, exit, opBytes }) {
  return concatBytes(...memoHashes, bytes(exitTo, 20, 'exit address'), salt, opening(dep), opening(exit), ...(opBytes ? [Uint8Array.of(1), opBytes] : []));
}

export const hopOp = (commit) => concatBytes(Uint8Array.of(OP_HOP), bytes(commit, 32, 'commit'));

export const migrateOp = (to, note) => {
  const t = bytes(to, 20, 'successor');
  if (t.every((x) => x === 0)) throw new Error('tacit-chain-wallet: a successor address');
  return concatBytes(Uint8Array.of(OP_MIGRATE), t, bytes(note, 32, 'note'));
};
export const migrationItem = (to, note, value) => sha256(concatBytes(te.encode('tacit-block-migrate-v1'), bytes(to, 20, 'successor'), bytes(note, 32, 'note'), be(value, 8)));

export function makeChainWallet({ poseidon, prover, chain, asset, network = 'mainnet' }) {
  const Z = makeBtcPoolZk({ poseidon });
  const assetF = BigInt(asset);
  const chainB = bytes(chain, 32, 'chain');

  const treeLeaves = [];
  let built = null;
  const leavesKept = () => treeLeaves.map((x) => x.toString(16).padStart(64, '0')).join('');
  const leavesKeep = (str) => {
    if (typeof str !== 'string' || str.length % 64 !== 0 || !/^[0-9a-f]*$/.test(str)) return false;
    treeLeaves.length = 0; built = null;
    for (let i = 0; i < str.length; i += 64) treeLeaves.push(BigInt('0x' + str.slice(i, i + 64)));
    return true;
  };
  const nfList = [], nfSet = new Set();
  let nfRoute = true;
  const nullifiersKept = () => nfList.map((h) => h.slice(2)).join('');
  const nullifiersKeep = (str) => {
    if (typeof str !== 'string' || str.length % 64 !== 0 || !/^[0-9a-f]*$/.test(str)) return false;
    nfList.length = 0; nfSet.clear();
    for (let i = 0; i < str.length; i += 64) { const h = '0x' + str.slice(i, i + 64); nfList.push(h); nfSet.add(h); }
    return true;
  };
  async function syncNullifiers(leader) {
    if (typeof leader.nullifiers !== 'function' || !nfRoute) return null;
    for (let guard = 0; guard < 1000; guard++) {
      const r = await leader.nullifiers(nfList.length, 1000);
      if (!r || r.ok === false) { if (r && r.status === 404) nfRoute = false; return null; }
      const total = Number(r.total), list = Array.isArray(r.nullifiers) ? r.nullifiers : null;
      if (!Number.isInteger(total) || total < 0 || !list) return null;
      if (total < nfList.length) { nfList.length = 0; nfSet.clear(); continue; }
      for (const h of list) {
        const x = String(h).toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(x)) return null;
        nfList.push(x); nfSet.add(x);
      }
      if (nfList.length >= total || !list.length) return nfSet;
    }
    return null;
  }
  async function noteTree(leader) {
    if (typeof leader.state !== 'function' || typeof leader.notes !== 'function') return null;
    const st = await leader.state();
    const total = Number(st?.leaves), want = BigInt(st?.noteRoot ?? -1);
    if (!Number.isInteger(total) || total < 0) throw new Error('tacit-chain-wallet: the leader did not say how many notes the chain holds');
    const grow = async () => {
      while (treeLeaves.length < total) {
        const page = await leader.notes(treeLeaves.length, 500);
        if (!page?.leaves?.length) break;
        for (const l of page.leaves) treeLeaves.push(BigInt(l));
      }
      if (treeLeaves.length > total) treeLeaves.length = total;
      built = null;
    };
    const tree = () => (built && built.n === treeLeaves.length ? built.tree : (built = { n: treeLeaves.length, tree: Z.tree(treeLeaves) }).tree);
    if (treeLeaves.length > total) { treeLeaves.length = 0; built = null; }
    await grow();
    let t = treeLeaves.length === total ? tree() : null;
    if (!t || t.root !== want) {
      treeLeaves.length = 0; built = null;
      await grow();
      t = treeLeaves.length === total ? tree() : null;
      if (!t || t.root !== want) throw new Error('tacit-chain-wallet: the notes the leader serves do not make the root it reports');
    }
    return t;
  }

  function keys(seed) {
    const zk = Z.walletKeys(seed, network);
    return { seed, zk, memo: memoKeys(seed) };
  }

  function address(k) {
    return { A: k.zk.A, N: k.zk.N, scanPub: k.memo.address.scanPub, kemPub: k.memo.address.kemPub };
  }

  const ADDRESS_LEN = 128 + 33 + 1184;
  const addressBytes = (a) => concatBytes(be(a.A[0], 32), be(a.A[1], 32), be(a.N[0], 32), be(a.N[1], 32), a.scanPub, a.kemPub);
  const chainAddressHash = (a) => sha256(concatBytes(te.encode('tacit-chain-address-v1'), addressBytes(a)));
  async function resolve(hash, leader) {
    const h = bytes(hash, 32, 'chain address hash');
    const full = await leader.address(hx(h));
    if (!full) throw new Error('tacit-chain-wallet: no leader knows this chain address yet');
    const a = decodeAddress('tc1' + String(full).replace(/^0x/, ''));
    if (hx(chainAddressHash(a)) !== hx(h)) throw new Error('tacit-chain-wallet: the directory answered with another address');
    return a;
  }
  const publish = (k, leader) => leader.publish(hx(addressBytes(address(k))));
  function encodeAddress(a) {
    return 'tc1' + hx(addressBytes(a)).slice(2);
  }
  function decodeAddress(s) {
    if (!String(s).startsWith('tc1')) throw new Error('tacit-chain-wallet: not a tacit chain address');
    const b = bytes('0x' + s.slice(3), ADDRESS_LEN, 'address');
    return { A: [fromBe(b.subarray(0, 32)), fromBe(b.subarray(32, 64))], N: [fromBe(b.subarray(64, 96)), fromBe(b.subarray(96, 128))], scanPub: b.slice(128, 161), kemPub: b.slice(161) };
  }

  function makeNote(to, value) {
    const { memo, s } = sealMemo({ scanPub: to.scanPub, kemPub: to.kemPub }, value);
    const { npk, rho } = Z.outputKeys(to.A, to.N, s);
    return { v: BigInt(value), npk, rho, memo, s, leaf: Z.leafOf(assetF, value, npk, rho) };
  }

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

    let root = 0n;
    const witnessIn = [];
    const tree = inputs.length ? await noteTree(leader) : null;
    for (const n of inputs) {
      let path;
      if (tree) {
        if (treeLeaves[n.index] !== BigInt(n.leaf)) throw new Error('tacit-chain-wallet: a note is not where the chain\'s tree holds it');
        root = tree.root; path = tree.path(n.index);
      } else {
        const got = await leader.path(n.index);
        root = BigInt(got.root); path = got.path;
      }
      const own = Z.ownedKeys(k.zk, n.s);
      if (Z.leafOf(assetF, n.value, own.npk, own.rho) !== BigInt(n.leaf)) throw new Error('tacit-chain-wallet: a note is not this wallet\'s');
      witnessIn.push({ v: BigInt(n.value), rho: own.rho, nk: own.nk, Ak: own.Ak, index: BigInt(n.index), path: path.map(BigInt), sig: Z.sign(own.sk, bh) });
    }
    while (witnessIn.length < ZK_N_IN) witnessIn.push(null);

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
    const deposit = depO ? { shares: depO.v, amount: depO.amount, cx: hx(be(signals[10], 32)), cy: hx(be(signals[11], 32)), body: hx(be(signals[1], 32)) } : null;
    return { submission, deposit, created, publics: signals, nullifiers: signals.slice(3, 5).filter((x) => x !== 0n).map((x) => hx(be(x, 32))) };
  }

  async function scan(k, leader, { from = 0, known = [], keep = true } = {}) {
    const mine = [...known];
    const record = keep && typeof leader.state === 'function';
    let next = from;
    for (;;) {
      const page = await leader.notes(next, 200);
      if (record && treeLeaves.length === next) { for (const leaf of page.leaves) treeLeaves.push(BigInt(leaf)); built = null; }
      page.leaves.forEach((leaf, i) => {
        const opened = openMemo(bytes(page.memos[i], MEMO_LEN, 'memo'), k.memo.secret);
        if (!opened) return;
        const own = Z.ownedKeys(k.zk, opened.s);
        const mineLeaf = Z.leafOf(assetF, opened.value, own.npk, own.rho);
        if (mineLeaf !== BigInt(leaf) || opened.value === 0n) return;
        if (!mine.some((n) => n.index === next + i)) mine.push({ index: next + i, value: opened.value, s: opened.s, leaf: mineLeaf });
      });
      if (page.next >= page.total || page.leaves.length === 0) { next = page.total; break; }
      next = page.next;
    }
    const notes = [];
    const spent = [];
    const spentSet = record ? await syncNullifiers(leader).catch(() => null) : null;
    for (const n of mine) {
      const own = Z.ownedKeys(k.zk, n.s);
      const nf = Z.nullifier(own.nk, n.leaf, n.index), nfHex = hx(be(nf, 32));
      const isSpent = spentSet ? spentSet.has(nfHex.toLowerCase()) : await leader.spent(nfHex);
      (isSpent ? spent : notes).push({ ...n, nullifier: nfHex });
    }
    return { notes, spent, next };
  }

  return { keys, address, encodeAddress, decodeAddress, chainAddressHash, resolve, publish, spend, scan, makeNote, leavesKept, leavesKeep, nullifiersKept, nullifiersKeep, syncNullifiers, Z };
}

export { sha256, lockOp };
