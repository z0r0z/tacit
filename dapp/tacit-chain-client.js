// The tacit chain as the app uses it: one wallet from the Tacit key (HMAC-SHA256(key, "tacit-chain-seed-v1"), a seed of its own, so
// nothing on the chain links to the user's other addresses), its notes found from the chain's memos (scanned once, then only what
// is new), and the moves: shield TAC from Ethereum (approved deposit, or an inbox the confidential pool's unwrap pays), pay a chain
// address, withdraw to an Ethereum address, hop into the confidential pool. Every spend is proven here (the pool's Halo2 prover),
// then handed to the chain's leader.
//
//   const c = makeChainClient({ cfg: tacitChain(), rpcCall, priv, system: () => halo2System, storage: localStorage });
//   await c.ready();  c.balance();  await c.scan();
//   const s = await c.shield(units)    → { deposit (for TacitBlocks.deposit), inbox(back) → address, submit({ back? }) }
//   await c.pay(fullAddress, units)    → receipt;   await c.withdraw('0x…', units);   await c.hop(commit, units)
//
// Amounts are in chain units (1e-8 TAC, 1e10 of the token's smallest units). A spend takes at most two notes: more is refused with a
// message to move fewer at once (two notes of yours merge into one by paying yourself).
import { sha256, keccak_256, hmac, concatBytes } from './vendor/tacit-deps.min.js';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from './vendor/tacit-poseidon.min.js';
import { makeChainWallet, hopOp } from './tacit-chain-wallet.js';

export const UNIT = 10n ** 10n;
const te = new TextEncoder();
const POSEIDON = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 };
const poseidon = (xs) => POSEIDON[xs.length](xs);
const hx = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const sel = (sig) => hx(keccak_256(te.encode(sig)).slice(0, 4)).slice(2);

/// The chain seed of a Tacit private key: one-way and domain-separated, like the Ethereum account and the Bitcoin pool seed.
export const chainSeed = (priv) => hmac(sha256, priv, te.encode('tacit-chain-seed-v1'));

export function makeChainClient({ cfg, rpcCall, priv, system, storage = globalThis.localStorage, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  if (!cfg) throw new Error('tacit chain: not deployed');
  const call = async (sig, args = '') => strip(await rpcCall('eth_call', [{ to: cfg.blocks, data: '0x' + sel(sig) + args }, 'latest']));
  const api = async (method, path, body) => {
    const r = await fetchImpl(cfg.leader + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...j };
  };
  const leader = {
    path: (i) => api('GET', `/path/${i}`),
    notes: (from, limit) => api('GET', `/notes?from=${from}&limit=${limit}`),
    spent: async (nf) => (await api('GET', `/spent/${nf}`)).spent,
    address: async (h) => (await api('GET', `/address/${h}`)).address,
    publish: async (a) => (await api('POST', '/address', { address: a })).hash,
  };
  let w = null, me = null, prover = null;
  const st = { next: 0, notes: [] };   // notes: { index, value, s (hex), leaf, nullifier }
  const key = () => `tacit-chain-notes-v1:${cfg.blocks.toLowerCase()}:${hx(w.chainAddressHash(w.address(me))).slice(2, 18)}`;
  const save = () => { try { storage?.setItem(key(), JSON.stringify({ next: st.next, notes: st.notes.map((n) => ({ ...n, value: String(n.value), leaf: String(n.leaf) })) })); } catch {} };
  const load = () => {
    try {
      const j = JSON.parse(storage?.getItem(key()) || 'null');
      if (j) { st.next = j.next; st.notes = j.notes.map((n) => ({ ...n, value: BigInt(n.value), leaf: BigInt(n.leaf) })); }
    } catch {}
  };
  const proverP = () => (prover ||= Promise.resolve(system()).then((s) => ({ prove: (input, o) => s.prove(input, o) })));

  async function ready() {
    if (w) return;
    const [chain, asset] = await Promise.all([call('CHAIN()'), call('TAC_ASSET()')]);
    w = makeChainWallet({ poseidon, prover: { prove: async (i, o) => (await proverP()).prove(i, o) }, chain: '0x' + chain, asset: BigInt('0x' + asset) });
    me = w.keys(chainSeed(priv));
    load();
  }

  /// New notes since the last scan, then which of this wallet's are spent.
  async function scan() {
    await ready();
    const r = await w.scan(me, leader, { from: st.next, known: st.notes.map((n) => ({ ...n, s: hexBytes(n.s) })) });
    st.next = r.next;
    st.notes = r.notes.map((n) => ({ index: n.index, value: n.value, s: hx(n.s), leaf: n.leaf, nullifier: n.nullifier }));
    save();
    return balance();
  }
  const balance = () => st.notes.reduce((t, n) => t + BigInt(n.value), 0n);
  const hexBytes = (h) => Uint8Array.from(strip(h).match(/../g) || [], (x) => parseInt(x, 16));
  const owned = () => st.notes.map((n) => ({ ...n, s: hexBytes(n.s) }));

  /// Up to two notes covering `need`: the fewest, largest first.
  function inputs(need) {
    const ns = owned().sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1));
    if (ns[0] && BigInt(ns[0].value) >= need) return [ns.filter((n) => BigInt(n.value) >= need).pop()];
    if (ns.length >= 2 && BigInt(ns[0].value) + BigInt(ns[1].value) >= need) return ns.slice(0, 2);
    throw new Error(balance() >= need ? 'that amount spans more than two of your chain notes: move part of it first' : 'more than you hold on the tacit chain');
  }

  /// Hands a spend to the leader and waits for it to land; drops the notes it spends from the wallet's list.
  async function submit(spent, extra = {}, { onStatus, timeoutMs = 30 * 60e3 } = {}) {
    const r = await api('POST', '/spend', { ...spent.submission, ...extra });
    if (!r.ok) throw new Error(r.error || `the leader refused the spend (${r.status})`);
    onStatus?.({ id: r.id, status: 'queued' });
    const t0 = Date.now();
    for (;;) {
      const rc = await api('GET', `/receipt/${r.id}`);
      if (rc.status === 'landed') break;
      if (Date.now() - t0 > timeoutMs) throw new Error('not landed yet: it stays with the leader, and lands when a block takes it');
      await new Promise((ok) => setTimeout(ok, 4000));
    }
    const gone = new Set(spent.nullifiers.map(strip));
    st.notes = st.notes.filter((n) => !gone.has(strip(n.nullifier)));
    save();
    onStatus?.({ id: r.id, status: 'landed' });
    return { id: r.id };
  }

  async function spend(opts) {
    await ready();
    return w.spend(me, { ...opts, leader });
  }

  return {
    ready, scan, balance,
    address: async () => { await ready(); return w.address(me); },
    /// The 32-byte hash a Tacit address's chain lane carries.
    lane: async () => { await ready(); return w.chainAddressHash(w.address(me)); },
    publish: async () => { await ready(); return w.publish(me, leader); },
    resolve: async (hash) => { await ready(); return w.resolve(hash, leader); },
    /// A shield of `units`: prove it, then pay its deposit (`deposit` after approving TAC, or TAC to `inbox(back)`), then `submit`.
    async shield(units, { onProgress } = {}) {
      const s = await spend({ dep: { v: BigInt(units) }, onProgress });
      const d = s.deposit;
      return {
        deposit: d,
        depositCalldata: '0x' + sel('deposit(uint256,bytes32,bytes32,bytes32)') + word(d.value) + strip(d.cx) + strip(d.cy) + strip(d.body),
        inbox: async (back) => '0x' + (await call('inbox(uint256,bytes32,bytes32,bytes32,bytes32)', word(d.value) + strip(d.cx) + strip(d.cy) + strip(d.body) + strip(back))).slice(24),
        submit: (o = {}) => submit(s, o.back ? { back: o.back } : {}, o),
      };
    },
    async pay(to, units, o = {}) {
      return submit(await spend({ inputs: inputs(BigInt(units)), outputs: [{ to, value: BigInt(units) }], onProgress: o.onProgress }), {}, o);
    },
    async withdraw(to, units, o = {}) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('an Ethereum address');
      return submit(await spend({ inputs: inputs(BigInt(units)), exit: { v: BigInt(units), to }, onProgress: o.onProgress }), {}, o);
    },
    /// Into the confidential pool as its deposit for `commit` (a fresh one, which the pool's wrap then takes in).
    async hop(commit, units, o = {}) {
      return submit(await spend({ inputs: inputs(BigInt(units)), exit: { v: BigInt(units), op: hopOp(commit) }, onProgress: o.onProgress }), {}, o);
    },
    /// What `withdraw` credits an address and has not sent yet, in the token's smallest units; anyone may send it (TacitBlocks.withdraw).
    owed: async (addr) => BigInt('0x' + (await call('owed(address)', strip(addr).padStart(64, '0')))),
    withdrawCalldata: (addr) => '0x' + sel('withdraw(address)') + strip(addr).padStart(64, '0'),
  };
}
