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
import { PAYMASTERS, paymasterFor, bundlerSet, readGasFeeReference, readFallbackGasPrice, prepareSponsoredWithdrawal, sendSponsoredOperation } from '/fixed-pool-paymaster.js?cb=b8ddfbc9';

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

// ETH as text <-> wei. Eighteen decimals at most; anything else is not an amount. Commas are read as the Pay page reads them (its parseUnits), so
// the form and the notes agree on what was typed: "1,5" is 1.5, "1,000.5" and "1,000,000" have thousands separators, and "1,000" or "1,500", which
// could be either, is not an amount (a looser reading turned "1,5" into 15 ETH).
export function parseEther(text) {
  let t = String(text ?? '').trim();
  if (t.includes(',')) {
    if (/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d*)?$/.test(t) && (t.includes('.') || t.indexOf(',') !== t.lastIndexOf(','))) t = t.replace(/,/g, '');
    else if (/^\d*,\d*$/.test(t) && !/^[1-9]\d{0,2},\d{3}$/.test(t)) t = t.replace(',', '.');
    else return null;
  }
  const m = /^(\d*)(?:\.(\d{0,18}))?$/.exec(t);
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

// The signatures a wallet has given for one account on one network, and whether it was seen to sign the same request the same way. A caller that makes
// several flows for the same wallet passes them one session, so a note number is signed for once and the wallet is checked once, not before every action.
export const newSession = () => ({ sigs: new Map(), checked: false });

export function makeFlow({ provider, account, chainId, store = null, poll = 1500, timeout = 10 * 60 * 1000, fetchImpl = globalThis.fetch?.bind(globalThis), session = newSession() }) {
  const pools = FIXED_POOLS[chainId] || [];
  const sigs = session.sigs;

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
    if (!session.checked) {
      const again = await rawSign(nonce);
      if (bytesToHex(canonicalRS(again)) !== bytesToHex(canonicalRS(sig))) {
        throw new Error('This wallet signs the same request differently each time, so a note made with it could not be found again.');
      }
      session.checked = true;
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
      onProbe?.(n, !sigs.has(n));
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
      // a failed read (a node busy for a moment) is not an answer: the transaction may well be mined, so ask again until the time is up
      let r = null;
      try { r = await fn(); } catch { /* ask again */ }
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

  // The wait for a deposit's receipt follows a speed-up or cancel in the wallet (activity.js waitMined, loaded when first wanted: a speed-up sends another transaction at the
  // same nonce and the first hash never confirms); where that cannot load, it is the plain wait it was.
  async function mined(hash) {
    const A = await import('./activity.js').catch(() => null), read = (method, params) => provider.request({ method, params });
    if (A?.waitMined) return A.waitMined({ read, hash, timeoutMs: timeout, every: poll });
    return { rc: await until(() => read('eth_getTransactionReceipt', [hash]), 'the deposit') };
  }
  async function sendOne(c) {
    const A = await import('./activity.js').catch(() => null), tx = txOf(c), ask = () => provider.request({ method: 'eth_sendTransaction', params: [tx] });
    const hash = A?.sendGuess ? await A.sendGuess({ read: (method, params) => provider.request({ method, params }), request: ask, from: tx.from, to: tx.to, value: tx.value ? BigInt(tx.value) : 0n, data: tx.data || '0x' }) : await ask();   // (with the guess a wallet on a private mempool needs)
    const w = await mined(hash);
    if (w.replaced) throw new Error(`The deposit ${hash} was replaced in your wallet, by a cancel or another transaction, before it was mined. Nothing was deposited.`);
    if (!w.rc) throw new Error('Timed out waiting for the deposit.');
    if (w.rc.status !== '0x1' && Number(w.rc.status) !== 1) throw new Error(`The deposit ${hash} failed.`);
    return { hash: w.rc.transactionHash || hash };
  }

  // The notes of `plan` (planSplit's result), made but not sent: the next free numbers are found, and each is signed for (a prompt
  // each), which gives its secrets, its commitment and the call that deposits it. Whoever sends the call, the note is the wallet's.
  async function prepareNotes(plan, { onStep = () => {} } = {}) {
    const wanted = plan.notes.flatMap((n) => Array.from({ length: n.count }, () => ({ denomination: n.denomination, address: n.address })));
    if (!wanted.length) return [];
    for (const p of new Map(wanted.map((w) => [w.address, w])).values()) await checkPool(p);
    onStep({ step: 'find' });
    const { next } = await scan({ from: hint(), onProbe: (n, signs) => onStep({ step: 'probe', n, signs }) });
    const notes = [];
    for (let i = 0; i < wanted.length; i++) {
      const nonce = next + i;
      onStep({ step: 'sign', i, of: wanted.length, signs: !sigs.has(nonce) });
      const sig = await signNonce(nonce);
      const secrets = deriveSecrets({ signature: sig, pool: wanted[i].address });
      notes.push({ nonce, pool: wanted[i], secrets, call: depositCall(wanted[i], secrets.commitment) });
    }
    return notes;
  }

  // Whether each note's commitment is in its pool (a node a block behind needs a moment to say so). → the notes that are
  // there; `remember` moves the next-number hint past them.
  async function landedNotes(notes, { wait = true } = {}) {
    const ok = [];
    for (const n of notes) {
      const pool = pools.find((p) => p.address === n.pool.address);
      let landed = false;
      for (let t = 0; t < (wait ? 8 : 1) && !landed; t++) {
        if (t) await sleep(poll);
        try { landed = await seen(pool, n.secrets.commitment); } catch { /* a read that failed says nothing: not landed yet */ }
      }
      if (landed) ok.push(n);
    }
    if (ok.length) remember(Math.max(...ok.map((n) => n.nonce)) + 1);
    return ok;
  }

  // Signs for every note first (each signature is a prompt), then sends. `plan` is planSplit's result.
  async function deposit(plan, { onStep = () => {} } = {}) {
    const notes = await prepareNotes(plan, { onStep });
    if (!notes.length) return { notes: [], sent: 'none' };
    const next = notes[0].nonce;
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
    if ((await landedNotes(notes)).length !== notes.length) throw Object.assign(new Error('A deposit was sent but its commitment is not in the pool yet. Find will show it in a minute.'), { done, notes });
    return { notes: notes.map((n) => ({ ...n, text: noteString({ denomination: n.pool.denomination, chainId, preimage: n.secrets.preimage }) })), sent };
  }

  // The same split with ONE sender for all of it (TacitSplitDeposit: every note and the Tacit deposit in one transaction, so all of it lands or none).
  // The notes are prepared and signed for as ever; `send(notes)` makes the transaction and returns its hash. A send that throws after the transaction
  // was in fact sent (a wallet that lost its wait) is not a failure if every note is in its pool; if none is, nothing landed (all or nothing), the
  // notes were never kept, and their numbers are free for the next try.
  async function depositWith(plan, send, { onStep = () => {} } = {}) {
    const notes = await prepareNotes(plan, { onStep });
    if (!notes.length) return { notes: [], sent: 'none' };
    onStep({ step: 'send', count: notes.length });
    let hash = null;
    try { hash = await send(notes); } catch (e) {
      if ((await landedNotes(notes, { wait: false })).length !== notes.length) { e.done = []; e.notes = notes; throw e; }
    }
    if ((await landedNotes(notes)).length !== notes.length) throw Object.assign(new Error('A deposit was sent but its commitment is not in the pool yet. Find will show it in a minute.'), { done: notes, notes });
    return { notes: notes.map((n) => ({ ...n, text: noteString({ denomination: n.pool.denomination, chainId, preimage: n.secrets.preimage }) })), sent: 'one transaction', hash };
  }

  const knownRoot = async (pool, root) => (await call(pool.address, SEL.isKnownRoot + word(root).slice(2))) !== 0n;

  // The steps both withdrawals share: the note is for this network and a pool, the recipient is an address, the
  // pool is what it says, the note is unspent and among the pool's deposits, and the tree built from them lands on
  // a root the pool knows. Everything here is checked before any proof is made.
  async function readyToWithdraw({ noteText, recipient, prover, onStep, leaves, beforeRead = () => {}, cache = null }) {
    const note = parseNoteString(noteText);
    if (note.chainId !== chainId) throw new Error(`This note is for network ${note.chainId}; the wallet is on ${chainId}.`);
    const pool = pools.find((p) => formatEther(p.denomination) === note.amount);
    if (!pool) throw new Error('No pool takes this note on this network.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) || /^0x0{40}$/i.test(recipient)) throw new Error('Enter the address that should receive it.');
    beforeRead(pool);
    await checkPool(pool);
    if (await spent(pool, note.nullifierHash)) throw new Error('This note is already spent.');
    const mine = commitmentBytes32(note.commitment).slice(2);
    const has = (bytes, count) => { for (let i = 0; i < count; i++) if (bytesToHex(bytes.subarray(i * 32, i * 32 + 32)) === mine) return true; return false; };
    // A run of withdrawals that shares `cache` ({ pools: Map, loaded }, with one prover) reads each pool's deposits and builds its tree once: the
    // pool is read again only if it no longer knows that root or the note is not among the deposits read (a busy pool moved on, a note was made
    // since). The proved call is still checked against this root before anything is sent, so a tree left in the prover by mistake cannot spend.
    let src = cache?.pools.get(pool.address) ?? null, reused = false;
    if (src && has(src.bytes, src.count) && (await knownRoot(pool, src.root))) reused = true; else src = null;
    if (!src) {
      onStep({ step: 'read' });
      const r = await leaves({
        chainId, pool,
        getLogs: (f) => provider.request({ method: 'eth_getLogs', params: [f] }),
        blockNumber: async () => Number(await provider.request({ method: 'eth_blockNumber' })),
        onProgress: (p) => onStep({ step: 'read', ...p }),
      });
      if (!has(r.bytes, r.count)) throw new Error('This note\'s deposit is not among the pool\'s deposits. Check the note, or try again in a minute if it was just made.');
      src = { bytes: r.bytes, count: r.count };
    }
    let root;
    if (reused) {
      if (cache.loaded !== pool.address) {
        cache.loaded = null;
        const again = await prover.load(src.bytes.slice());   // another pool's tree is in the prover: give it this one back (it takes the buffer it is given)
        if (again.root !== src.root) throw new Error('The deposits read before do not give the same root now. Try again.');
        cache.loaded = pool.address;
      }
      root = src.root;
    } else {
      onStep({ step: 'tree', count: src.count });
      const keep = cache ? src.bytes.slice() : null;           // the prover takes the buffer it is given
      if (cache) cache.loaded = null;
      ({ root } = await prover.load(src.bytes));
      if (!(await knownRoot(pool, root))) throw new Error('The deposits read do not add up to a root the pool knows. Try again in a minute.');
      if (cache) { cache.pools.set(pool.address, { bytes: keep, count: src.count, root }); cache.loaded = pool.address; }
    }
    return { note, pool, root, preimageHex: bytesToHex(note.preimage) };
  }

  const settled = async (pool, note) => {
    for (let t = 0; t < 8; t++) {
      if (t) await sleep(poll);
      // the withdrawal has been sent: a read that fails here must not make it look as if it had not, so it counts as "not shown yet"
      try { if (await spent(pool, note.nullifierHash)) return true; } catch { /* not shown yet */ }
    }
    return false;
  };

  // Reads the pool's deposits, builds its tree, proves the note's withdrawal to `recipient`, and (unless
  // `send` is false) sends it from the connected account. `prover` has `load(bytes)` and `prove(args)`.
  // `confirm({ fee, receive, denomination })`, when given, is asked once the proof is made, before anything is sent (fee is 0: the wallet
  // pays the gas, and the recipient gets the whole note); a false answer ends it with nothing sent.
  async function withdraw({ noteText, recipient, prover, send = true, onStep = () => {}, leaves = fixedPoolLeaves, confirm = null, cache = null }) {
    const { note, pool, root, preimageHex } = await readyToWithdraw({ noteText, recipient, prover, onStep, leaves, cache });
    onStep({ step: 'prove' });
    const out = await prover.prove({ chainId, pool: pool.address, preimageHex, recipient });
    checkWithdrawCall(out, { pool, recipient, root, nullifierHash: note.nullifierHash });
    if (!send) return { call: out, sent: false };
    if (confirm && !(await confirm({ fee: 0n, receive: pool.denomination, denomination: pool.denomination }))) {
      throw Object.assign(new Error('Cancelled. Nothing was sent.'), { cancelled: true });
    }
    onStep({ step: 'send' });
    const { hash } = await sendOne({ to: out.target, value: 0n, data: out.input });
    return { call: out, hash, sent: true, receive: pool.denomination, spent: await settled(pool, note) };
  }

  // The same withdrawal with its gas paid from the note by the pool paymaster, as one 4337 operation from a
  // throwaway account. The wallet signs and sends nothing, so none is needed beyond a node to read from: the
  // recipient is paid directly (it can be a Tacit receive address) and needs no ETH.
  // `confirm({ fee, receive, denomination })` is asked once the proof is made and the fee is fixed, before anything is
  // sent; a false answer ends it with nothing sent.
  async function withdrawSponsored({ noteText, recipient, prover, send = true, onStep = () => {}, leaves = fixedPoolLeaves, bundler = null, confirm = null, maxFeePercent, cache = null }) {
    const cfg = PAYMASTERS[chainId];
    if (!cfg) throw new Error('Paying the gas from the note is not available on this network.');
    const { note, pool, root, preimageHex } = await readyToWithdraw({
      noteText, recipient, prover, onStep, leaves, cache,
      beforeRead: (p) => paymasterFor(chainId, p.address), // a pool the paymaster does not take stops here
    });
    const client = bundler || bundlerSet(cfg.bundlers, fetchImpl);
    const reference = await readGasFeeReference(provider);
    const prepared = await prepareSponsoredWithdrawal({
      chainId, pool: pool.address, denomination: pool.denomination, recipient, bundler: client, reference, nodePrice: () => readFallbackGasPrice(provider), onStep, maxFeePercent,
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

  // The note text for a deposit this wallet made: the secrets come from signing its nonce again, so only (nonce, pool) is kept.
  async function noteText({ nonce, pool }) {
    const p = pools.find((q) => q.address.toLowerCase() === String(pool).toLowerCase());
    if (!p) throw new Error('No pool takes this note on this network.');
    const secrets = deriveSecrets({ signature: await signNonce(nonce), pool: p.address });
    return noteString({ denomination: p.denomination, chainId, preimage: secrets.preimage });
  }

  return { pools, signNonce, probe, scan, deposit, depositWith, sendOne, prepareNotes, landedNotes, checkPool, atomicSupported, seen, spent, withdraw, withdrawSponsored, knownRoot, noteText };
}

// What a found or fresh note shows: its size, its place, and the line that spends it elsewhere.
export const describeNote = (n, chainId) => ({
  nonce: n.nonce,
  denomination: formatEther(n.pool.denomination),
  pool: n.pool.address,
  spent: !!n.spent,
  text: noteString({ denomination: n.pool.denomination, chainId, preimage: n.secrets.preimage }),
});
