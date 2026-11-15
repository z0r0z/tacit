// The wallet side of a split deposit, with the wallet passed in, so a test can stand in for it: sign each note's
// typed data, find the first nonce no earlier deposit used, check each pool is the pool it should be, send the
// deposits (one atomic batch where the wallet offers it, one transaction at a time where it does not), and
// check each commitment landed.
//
// `provider` is an EIP-1193 provider. Nothing here touches the page.

import { keccak_256, bytesToHex } from './vendor/tacit-deps.min.js';
import {
  FIXED_POOLS, noteTypedData, canonicalRS, deriveSecrets, depositCall, commitmentBytes32, noteString, parseNoteString,
} from '/fixed-pool-notes.js?cb=ab06e6d2';
import { fixedPoolLeaves } from '/fixed-pool-sync.js?cb=cd4a3f3a';
import { PAYMASTERS, paymasterFor, bundlerClient, readGasFeeReference, prepareSponsoredWithdrawal, sendSponsoredOperation } from '/fixed-pool-paymaster.js?cb=40893745';

const enc = new TextEncoder();
const selector = (sig) => '0x' + bytesToHex(keccak_256(enc.encode(sig)).slice(0, 4));
const SEL = {
  commitments: selector('commitments(bytes32)'),
  isSpent: selector('isSpent(bytes32)'),
  denomination: selector('denomination()'),
  isKnownRoot: selector('isKnownRoot(bytes32)'),
};
const WITHDRAW = selector('withdraw(bytes,bytes32,bytes32,address,address,uint256,uint256)');
const hexOf = (n) => '0x' + BigInt(n).toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const word = (hex) => '0x' + String(hex).replace(/^0x/, '').padStart(64, '0');

// ETH as text <-> wei. Eighteen decimals at most; anything else is not an amount.
export function parseEther(text) {
  const m = /^(\d*)(?:\.(\d{0,18}))?$/.exec(String(text).trim().replace(/,/g, ''));
  if (!m || (m[1] === '' && (m[2] === undefined || m[2] === ''))) return null;
  return BigInt(m[1] || '0') * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0') || '0');
}
export function formatEther(wei) {
  const w = BigInt(wei);
  const whole = w / 10n ** 18n, frac = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

// What a proved withdrawal must say before anything signs it: the pool's own `withdraw` with this root, this
// nullifier hash and this recipient, and no relayer, fee or refund. The proof came out of code the page did not
// write; this reads the call itself.
export function checkWithdrawCall(out, { pool, recipient, root, nullifierHash, relayer = '0x' + '0'.repeat(40), fee = 0n }) {
  const fail = (why) => { throw new Error(`The proved withdrawal is not the one asked for (${why}).`); };
  if (String(out.target).toLowerCase() !== pool.address.toLowerCase()) fail('pool');
  const data = String(out.input);
  if (data.slice(0, 10) !== WITHDRAW) fail('call');
  const body = data.slice(10);
  const w = (i) => body.slice(i * 64, i * 64 + 64);
  const addr = (i) => '0x' + w(i).slice(24);
  if (BigInt('0x' + w(0)) !== 224n) fail('layout');
  if (('0x' + w(1)).toLowerCase() !== String(root).toLowerCase()) fail('root');
  if (('0x' + w(2)).toLowerCase() !== commitmentBytes32(nullifierHash)) fail('note');
  if (addr(3).toLowerCase() !== recipient.toLowerCase()) fail('recipient');
  if (addr(4).toLowerCase() !== relayer.toLowerCase()) fail('relayer');
  if (BigInt('0x' + w(5)) !== BigInt(fee) || BigInt('0x' + w(6)) !== 0n) fail('fee');
  if (BigInt('0x' + w(7)) !== 256n) fail('proof size');
  if (body.length !== 8 * 64 + 256 * 2) fail('length');
  if (out.proof !== undefined && String(out.proof).toLowerCase() !== '0x' + body.slice(8 * 64).toLowerCase()) fail('proof');
  if (String(out.root).toLowerCase() !== String(root).toLowerCase()) fail('root');
  if (String(out.nullifierHash).toLowerCase() !== commitmentBytes32(nullifierHash)) fail('nullifier hash');
}

export function makeFlow({ provider, account, chainId, store = null, poll = 1500, timeout = 10 * 60 * 1000, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
  const pools = FIXED_POOLS[chainId] || [];
  const sigs = new Map();
  let determinismChecked = false;

  const call = async (to, data) => {
    const r = await provider.request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
    return r && r !== '0x' ? BigInt(r) : 0n;
  };
  const seen = async (pool, commitment) => (await call(pool.address, SEL.commitments + commitmentBytes32(commitment).slice(2))) !== 0n;
  const spent = async (pool, nullifierHash) => (await call(pool.address, SEL.isSpent + commitmentBytes32(nullifierHash).slice(2))) !== 0n;

  const rawSign = async (nonce) => provider.request({
    method: 'eth_signTypedData_v4',
    params: [account, JSON.stringify(noteTypedData(nonce, chainId))],
  });
  // One signature per nonce, kept for the session. The first one is asked for twice: a wallet whose signature
  // changes from one request to the next would make a note that cannot be found again.
  async function signNonce(nonce) {
    if (sigs.has(nonce)) return sigs.get(nonce);
    const sig = await rawSign(nonce);
    canonicalRS(sig); // refuses a signature that is not 65 bytes
    if (!determinismChecked) {
      const again = await rawSign(nonce);
      if (bytesToHex(canonicalRS(again)) !== bytesToHex(canonicalRS(sig))) {
        throw new Error('This wallet signs the same request differently each time, so a note made with it could not be found again.');
      }
      determinismChecked = true;
    }
    sigs.set(nonce, sig);
    return sig;
  }

  // The deposits an earlier visit made under `nonce`, in any pool of this chain.
  async function probe(nonce) {
    const sig = await signNonce(nonce);
    const hits = [];
    for (const pool of pools) {
      const secrets = deriveSecrets({ signature: sig, pool: pool.address });
      if (await seen(pool, secrets.commitment)) hits.push({ nonce, pool, secrets });
    }
    return hits;
  }

  const hintKey = `fixed-next:${chainId}:${String(account).toLowerCase()}`;
  const hint = () => { try { return Math.max(0, Number(store?.get(hintKey)) || 0); } catch { return 0; } };
  const remember = (n) => { try { store?.set(hintKey, String(n)); } catch { /* a convenience only */ } };

  // Nonces from `from` on, until `gap` in a row have no deposit. `next` is the one after the last deposit found.
  async function scan({ from = 0, gap = 2, onProbe = null } = {}) {
    const found = [];
    let next = from, empty = 0;
    for (let n = from; empty < gap; n++) {
      onProbe?.(n);
      const hits = await probe(n);
      if (hits.length) { found.push(...hits); next = n + 1; empty = 0; } else empty++;
    }
    for (const f of found) f.spent = await spent(f.pool, f.secrets.nullifierHash);
    return { found, next };
  }

  // A pool is the pool it is listed as only if it has code and takes the amount it is listed for.
  async function checkPool(pool) {
    const code = await provider.request({ method: 'eth_getCode', params: [pool.address, 'latest'] });
    if (!code || code === '0x') throw new Error(`No pool at ${pool.address} on this network.`);
    const d = await call(pool.address, SEL.denomination);
    if (d !== pool.denomination) throw new Error(`${pool.address} takes ${formatEther(d)} ETH, not ${formatEther(pool.denomination)} ETH.`);
  }

  async function atomicSupported() {
    try {
      const caps = await provider.request({ method: 'wallet_getCapabilities', params: [account] });
      const s = caps?.[hexOf(chainId)]?.atomic?.status;
      return s === 'supported' || s === 'ready';
    } catch { return false; }
  }

  async function until(fn, what) {
    const end = Date.now() + timeout;
    for (;;) {
      const r = await fn();
      if (r) return r;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
      await sleep(poll);
    }
  }

  const txOf = (c) => ({ from: account, to: c.to, value: hexOf(c.value), data: c.data });

  async function sendBatch(calls) {
    const res = await provider.request({
      method: 'wallet_sendCalls',
      params: [{ version: '2.0.0', from: account, chainId: hexOf(chainId), atomicRequired: true, calls: calls.map((c) => ({ to: c.to, value: hexOf(c.value), data: c.data })) }],
    });
    const id = typeof res === 'string' ? res : res?.id;
    const st = await until(async () => {
      const s = await provider.request({ method: 'wallet_getCallsStatus', params: [id] });
      return s && Number(s.status) >= 200 ? s : null;
    }, 'the batch');
    if (Number(st.status) !== 200) throw new Error('The batch did not go through.');
    return { id };
  }

  async function sendOne(c) {
    const hash = await provider.request({ method: 'eth_sendTransaction', params: [txOf(c)] });
    const rc = await until(() => provider.request({ method: 'eth_getTransactionReceipt', params: [hash] }), 'the deposit');
    if (rc.status !== '0x1' && Number(rc.status) !== 1) throw new Error(`The deposit ${hash} failed.`);
    return { hash };
  }

  // Signs for every note first (each signature is a prompt), then sends. `plan` is planSplit's result.
  async function deposit(plan, { onStep = () => {} } = {}) {
    const wanted = plan.notes.flatMap((n) => Array.from({ length: n.count }, () => ({ denomination: n.denomination, address: n.address })));
    if (!wanted.length) return { notes: [], sent: 'none' };
    for (const p of new Map(wanted.map((w) => [w.address, w])).values()) await checkPool(p);
    onStep({ step: 'find' });
    const { next } = await scan({ from: hint() });
    const notes = [];
    for (let i = 0; i < wanted.length; i++) {
      const nonce = next + i;
      onStep({ step: 'sign', i, of: wanted.length });
      const sig = await signNonce(nonce);
      const secrets = deriveSecrets({ signature: sig, pool: wanted[i].address });
      notes.push({ nonce, pool: wanted[i], secrets, call: depositCall(wanted[i], secrets.commitment) });
    }
    const calls = notes.map((n) => n.call);
    onStep({ step: 'send', count: calls.length });
    let sent = 'sequential';
    const done = [];
    try {
      if (calls.length > 1 && (await atomicSupported())) { await sendBatch(calls); sent = 'batch'; notes.forEach((n) => done.push(n)); }
      else for (const n of notes) { await sendOne(n.call); done.push(n); onStep({ step: 'sent', i: done.length, of: notes.length }); }
    } catch (e) {
      e.done = done; e.notes = notes;
      throw e;
    }
    remember(next + notes.length);
    // each commitment must be in its pool now (a node a block behind needs a moment to say so)
    for (const n of notes) {
      const pool = pools.find((p) => p.address === n.pool.address);
      let landed = false;
      for (let t = 0; t < 8 && !landed; t++) { if (t) await sleep(poll); landed = await seen(pool, n.secrets.commitment); }
      if (!landed) throw Object.assign(new Error('A deposit was sent but its commitment is not in the pool yet. Find will show it in a minute.'), { done, notes });
    }
    return { notes: notes.map((n) => ({ ...n, text: noteString({ denomination: n.pool.denomination, chainId, preimage: n.secrets.preimage }) })), sent };
  }

  const knownRoot = async (pool, root) => (await call(pool.address, SEL.isKnownRoot + word(root).slice(2))) !== 0n;

  // The steps both withdrawals share: the note is for this network and a pool, the recipient is an address, the
  // pool is what it says, the note is unspent and among the pool's deposits, and the tree built from them lands on
  // a root the pool knows. Everything here is checked before any proof is made.
  async function readyToWithdraw({ noteText, recipient, prover, onStep, leaves, beforeRead = () => {} }) {
    const note = parseNoteString(noteText);
    if (note.chainId !== chainId) throw new Error(`This note is for network ${note.chainId}; the wallet is on ${chainId}.`);
    const pool = pools.find((p) => formatEther(p.denomination) === note.amount);
    if (!pool) throw new Error('No pool takes this note on this network.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) || /^0x0{40}$/i.test(recipient)) throw new Error('Enter the address that should receive it.');
    beforeRead(pool);
    await checkPool(pool);
    if (await spent(pool, note.nullifierHash)) throw new Error('This note is already spent.');
    onStep({ step: 'read' });
    const { bytes, count } = await leaves({
      chainId, pool,
      getLogs: (f) => provider.request({ method: 'eth_getLogs', params: [f] }),
      blockNumber: async () => Number(await provider.request({ method: 'eth_blockNumber' })),
      onProgress: (p) => onStep({ step: 'read', ...p }),
    });
    const mine = commitmentBytes32(note.commitment).slice(2);
    let found = false;
    for (let i = 0; i < count && !found; i++) found = bytesToHex(bytes.subarray(i * 32, i * 32 + 32)) === mine;
    if (!found) throw new Error('This note\'s deposit is not among the pool\'s deposits. Check the note, or try again in a minute if it was just made.');
    onStep({ step: 'tree', count });
    const { root } = await prover.load(bytes);
    if (!(await knownRoot(pool, root))) throw new Error('The deposits read do not add up to a root the pool knows. Try again in a minute.');
    return { note, pool, root, preimageHex: bytesToHex(note.preimage) };
  }

  const settled = async (pool, note) => {
    for (let t = 0; t < 8; t++) { if (t) await sleep(poll); if (await spent(pool, note.nullifierHash)) return true; }
    return false;
  };

  // Reads the pool's deposits, builds its tree, proves the note's withdrawal to `recipient`, and (unless
  // `send` is false) sends it from the connected account. `prover` has `load(bytes)` and `prove(args)`.
  async function withdraw({ noteText, recipient, prover, send = true, onStep = () => {}, leaves = fixedPoolLeaves }) {
    const { note, pool, root, preimageHex } = await readyToWithdraw({ noteText, recipient, prover, onStep, leaves });
    onStep({ step: 'prove' });
    const out = await prover.prove({ chainId, pool: pool.address, preimageHex, recipient });
    checkWithdrawCall(out, { pool, recipient, root, nullifierHash: note.nullifierHash });
    if (!send) return { call: out, sent: false };
    onStep({ step: 'send' });
    const { hash } = await sendOne({ to: out.target, value: 0n, data: out.input });
    return { call: out, hash, sent: true, spent: await settled(pool, note) };
  }

  // The same withdrawal with its gas paid from the note by the pool paymaster, as one 4337 operation from a
  // throwaway account. The wallet signs and sends nothing, so none is needed beyond a node to read from: the
  // recipient is paid directly (it can be a Tacit receive address) and needs no ETH.
  // `confirm({ fee, receive, denomination })` is asked once the proof is made and the fee is fixed, before anything is
  // sent; a false answer ends it with nothing sent.
  async function withdrawSponsored({ noteText, recipient, prover, send = true, onStep = () => {}, leaves = fixedPoolLeaves, bundler = null, confirm = null, maxFeePercent }) {
    const cfg = PAYMASTERS[chainId];
    if (!cfg) throw new Error('Paying the gas from the note is not available on this network.');
    const { note, pool, root, preimageHex } = await readyToWithdraw({
      noteText, recipient, prover, onStep, leaves,
      beforeRead: (p) => paymasterFor(chainId, p.address), // a pool the paymaster does not take stops here
    });
    const client = bundler || bundlerClient(cfg.bundler, fetchImpl);
    const reference = await readGasFeeReference(provider);
    const prepared = await prepareSponsoredWithdrawal({
      chainId, pool: pool.address, denomination: pool.denomination, recipient, bundler: client, reference, onStep, maxFeePercent,
      prove: async (fee) => {
        const out = await prover.prove({ chainId, pool: pool.address, preimageHex, recipient, relayer: cfg.paymaster, fee: String(fee) });
        checkWithdrawCall(out, { pool, recipient, root, nullifierHash: note.nullifierHash, relayer: cfg.paymaster, fee });
        return out;
      },
    });
    const receive = pool.denomination - prepared.fee;
    onStep({ step: 'quote', fee: prepared.fee, receive });
    if (!send) return { op: prepared.op, fee: prepared.fee, receive, sent: false, gasEstimation: prepared.gasEstimation };
    if (confirm && !(await confirm({ fee: prepared.fee, receive, denomination: pool.denomination }))) {
      throw Object.assign(new Error('Cancelled. Nothing was sent.'), { cancelled: true });
    }
    const done = await sendSponsoredOperation({ op: prepared.op, chainId, bundler: client, onStep, poll });
    return { op: prepared.op, fee: prepared.fee, receive, sent: true, hash: done.txHash, userOpHash: done.hash, spent: await settled(pool, note), gasEstimation: prepared.gasEstimation };
  }

  return { pools, signNonce, probe, scan, deposit, checkPool, atomicSupported, seen, spent, withdraw, withdrawSponsored, knownRoot };
}

// What a found or fresh note shows: its size, its place, and the line that spends it elsewhere.
export const describeNote = (n, chainId) => ({
  nonce: n.nonce,
  denomination: formatEther(n.pool.denomination),
  pool: n.pool.address,
  spent: !!n.spent,
  text: noteString({ denomination: n.pool.denomination, chainId, preimage: n.secrets.preimage }),
});
