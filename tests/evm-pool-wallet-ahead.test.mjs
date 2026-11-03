// A deposit proved before it is asked for (wallet.prepareDeposit): the deposit of that amount sends it while the pool's head is the one it was proved
// against, once; any other deposit proves its own. The pool here is a fake one with a real tree, and its pre-flight refuses a proof built on another
// head, as the contract does (StaleRoot).
//   node tests/evm-pool-wallet-ahead.test.mjs
import assert from 'node:assert/strict';
import { makeEvmPoolWallet, evmPoolKeys } from '../dapp/evm-pool-wallet.js';
import { makeEvmPoolZk, publicSignals } from '../dapp/evm-pool-zk.js';
import { selector } from '../dapp/evm-pool-gateway.js';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';
import { keccak_256 } from '@noble/hashes/sha3';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const STALE_ROOT = '0x' + Buffer.from(selector('StaleRoot()')).toString('hex');
const topic = (sig) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex');
const T_TRANSACT = topic('Transact(bytes32,bytes32,bytes32,bytes32,uint256,bytes32,address,int256,address,uint256,bytes,bytes)');
const w64 = (x) => BigInt.asUintN(256, BigInt(x)).toString(16).padStart(64, '0');
const bytes = (h) => Buffer.from(String(h).replace(/^0x/, ''), 'hex');
const PROOF = { pi_a: ['1', '2', '1'], pi_b: [['3', '4'], ['5', '6'], ['1', '0']], pi_c: ['7', '8', '1'] };
const A = 5n * 10n ** 16n, B = 7n * 10n ** 16n;

// A pool whose tree is real: each transaction is one block, its leaves go into the tree and its Transact into the logs.
function fakePool() {
  const tree = zk.incTree(), sizeOf = new Map([[tree.root, 0]]), logs = [];
  let block = 0;
  return {
    get tip() { return block; }, get root() { return tree.root; }, get size() { return tree.size; },
    transact({ out, memo = [null, null] }) {
      block++;
      const firstIndex = tree.size, [o0, o1] = out, tx = '0x' + w64(block);
      tree.append(out.map(BigInt)); sizeOf.set(tree.root, tree.size);
      const m = memo.map((x) => Buffer.from(x ?? []).toString('hex')), pad = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64);
      const body0 = w64(m[0].length / 2) + pad(m[0]);
      logs.push({ address: POOL, blockNumber: '0x' + block.toString(16), transactionHash: tx, logIndex: '0x0', topics: [T_TRANSACT, '0x' + w64(0), '0x' + w64(0)],
        data: '0x' + [o0, o1, firstIndex, 0, 0, 0, 0, 0, 320, 320 + body0.length / 2].map(w64).join('') + body0 + w64(m[1].length / 2) + pad(m[1]) });
      return tx;
    },
    node: async (m, p) => {
      if (m === 'eth_blockNumber') return '0x' + block.toString(16);
      if (m === 'eth_getLogs') {
        const f = p[0], at = [f.address].flat().map((a) => a.toLowerCase()), t0 = [f.topics?.[0] ?? []].flat().map((t) => t.toLowerCase());
        return logs.filter((l) => at.includes(l.address.toLowerCase()) && (!t0.length || t0.includes(l.topics[0])) && Number(l.blockNumber) >= Number(f.fromBlock) && Number(l.blockNumber) <= Number(f.toBlock));
      }
      if (m === 'eth_call') return '0x' + w64(sizeOf.get(BigInt('0x' + p[0].data.slice(-64))) ?? 0);
      if (m === 'eth_getTransactionReceipt') { const l = logs.filter((x) => x.transactionHash === p[0]); return l.length ? { status: '0x1', logs: l } : null; }
      return '0x0';
    },
  };
}

// A wallet on that pool. `ctl.gate`: a promise the prover waits for; `ctl.failFirst`: the first proof throws; `ctl.refuseOnce`: the first send is refused in the
// wallet; `ctl.onCall`: run once when the
// deposit's call is built, before the wallet checks it. The signer lands the call in the pool; the check before it refuses a proof that is not
// on the pool's head.
function setup(ctl = {}) {
  const pool = fakePool(), proves = [], sent = [], steps = [];
  let stash = null;
  const rpc = async (m, p) => {
    if (m === 'eth_blockNumber') { ctl.reads = (ctl.reads || 0) + 1; if (ctl.failRead) throw new Error('fetch failed'); }
    if (m === 'eth_call' && p[0]?.from) {
      if (stash && (stash.publicInputs[1] !== String(pool.root) || stash.publicInputs[3] !== String(pool.size))) throw Object.assign(new Error('execution reverted'), { data: STALE_ROOT });
      return '0x';
    }
    return pool.node(m, p);
  };
  const prove = async (input) => {
    if (ctl.gate) await ctl.gate;
    if (ctl.failFirst) { ctl.failFirst = false; throw new Error('Proving stopped on this device'); }
    const r = { proof: PROOF, publicSignals: publicSignals(input) };
    proves.push(r);
    return r;
  };
  const signer = { address: '0x' + '11'.repeat(20), send: async () => { if (ctl.refuseOnce) { ctl.refuseOnce = false; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); } return pool.transact({ out: [BigInt(stash.publicInputs[9]), BigInt(stash.publicInputs[10])], memo: [bytes(stash.memo0), bytes(stash.memo1)] }); } };
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(9));
  const W = makeEvmPoolWallet({ zk, keys, keeper: null, store: null, feed: false, prove, chain: { chainId: 1, pool: POOL, router: ROUTER, rpc, deployBlock: 1, confirmations: 0, logChunk: 50000 } });
  W.connect(signer);
  const selfCall = (tx) => { const f = ctl.onCall; ctl.onCall = null; f?.(pool); ctl.readsAtSend = ctl.reads; stash = tx; sent.push(tx); return { to: POOL, data: '0x00000000' }; };
  const deposit = (amount, extra = {}) => W.deposit({ amount, selfCall, onStep: (s) => steps.push(s), ...extra });
  return { W, pool, proves, sent, steps, deposit };
}
const insert = (pool, a = 11n, b = 12n) => pool.transact({ out: [a, b], memo: [Buffer.from('aa'), Buffer.from('bb')] });

await check('a deposit with nothing proved ahead proves at the press, as before', async () => {
  const { W, proves, steps, deposit } = setup();
  await deposit(A);
  assert.equal(proves.length, 1);
  assert.ok(steps.includes('proving on this device'));
  assert.equal(W.summary().balance, A);
});

await check('a deposit proved ahead is sent as it is: one proof, no proving at the press, the note is the wallet\'s', async () => {
  const { W, proves, sent, steps, deposit } = setup();
  assert.equal(await W.prepareDeposit(A), true);
  assert.equal(proves.length, 1);
  await deposit(A);
  assert.equal(proves.length, 1, 'the press proved nothing');
  assert.deepEqual(sent[0].publicInputs, proves[0].publicSignals, 'the call carries the proof made ahead');
  assert.equal(sent[0].extAmount, String(A));
  assert.ok(!steps.includes('proving on this device'));
  assert.equal(W.summary().balance, A, 'the note opens under the wallet\'s keys');
});

await check('a press while the proof is being made waits for that proof and proves nothing more', async () => {
  let open; const gate = new Promise((r) => { open = r; });
  const { W, proves, sent, steps, deposit } = setup({ gate });
  const ahead = W.prepareDeposit(A);
  const press = deposit(A);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(steps.includes('proving on this device'), 'the card is told it is proving');
  assert.equal(sent.length, 0);
  open();
  await ahead; await press;
  assert.equal(proves.length, 1);
  assert.equal(sent.length, 1);
});

await check('the same amount asked twice is proved once', async () => {
  const { W, proves } = setup();
  await Promise.all([W.prepareDeposit(A), W.prepareDeposit(A)]);
  await W.prepareDeposit(A);
  assert.equal(proves.length, 1);
});

await check('a deposit of another amount proves its own; the first amount\'s proof is then on a head that has moved', async () => {
  const { W, proves, sent, deposit } = setup();
  await W.prepareDeposit(A);
  await deposit(B);
  assert.equal(proves.length, 2);
  assert.equal(sent[0].extAmount, String(B));
  await deposit(A);
  assert.equal(proves.length, 3, 'the deposit of B inserted into the pool, so the proof for A was proved again');
  assert.equal(sent[1].extAmount, String(A));
  assert.equal(W.summary().balance, A + B);
});

await check('only the latest amount asked for is kept', async () => {
  const { W, proves, deposit } = setup();
  await W.prepareDeposit(A);
  await W.prepareDeposit(B);
  await deposit(A);
  assert.equal(proves.length, 3, 'A was proved again: B replaced it');
});

await check('a proof taken by one deposit is not sent by the next of that amount', async () => {
  const { W, proves, sent, deposit } = setup();
  await W.prepareDeposit(A);
  await deposit(A);
  await deposit(A);
  assert.equal(proves.length, 2);
  assert.notDeepEqual(sent[0].publicInputs, sent[1].publicInputs);
  assert.equal(W.summary().balance, 2n * A);
});

await check('another transaction inserted after the proof: the press finds the head moved and proves on the new one', async () => {
  const { W, pool, proves, sent, steps, deposit } = setup();
  await W.prepareDeposit(A);
  const oldRoot = String(pool.root);
  insert(pool);
  await deposit(A);
  assert.equal(proves.length, 2);
  assert.equal(sent.length, 1, 'only the proof on the new head went to the wallet');
  assert.notEqual(sent[0].publicInputs[1], oldRoot);
  assert.equal(sent[0].publicInputs[3], '2', 'it starts after the two leaves the other transaction inserted');
  assert.ok(!steps.includes('someone else got in first, proving again'), 'found stale before the wallet, not by a refusal');
  assert.equal(W.summary().balance, A);
});

await check('the head moves after that check, before the wallet: the pre-flight refuses and the deposit proves again', async () => {
  const ctl = {};
  const { W, pool, proves, sent, steps, deposit } = setup(ctl);
  await W.prepareDeposit(A);
  ctl.onCall = (p) => insert(p, 21n, 22n);
  await deposit(A);
  assert.equal(proves.length, 2, 'the proof made ahead, and one on the new head');
  assert.equal(sent.length, 2);
  assert.ok(steps.includes('someone else got in first, proving again'));
  assert.equal(sent[1].publicInputs[3], '2');
  assert.equal(pool.size, 4);
  assert.equal(W.summary().balance, A);
});

await check('a proof that failed leaves the deposit to prove for itself', async () => {
  const { W, proves, deposit } = setup({ failFirst: true });
  await assert.rejects(W.prepareDeposit(A), /Proving stopped/);
  await deposit(A);
  assert.equal(proves.length, 1);
  assert.equal(W.summary().balance, A);
});

await check('a proof that fails while the press waits for it leaves the press to prove its own', async () => {
  let open; const gate = new Promise((r) => { open = r; });
  const { W, proves, deposit } = setup({ gate, failFirst: true });
  const ahead = W.prepareDeposit(A);
  const press = deposit(A);
  await new Promise((r) => setTimeout(r, 50));
  open();
  await assert.rejects(ahead, /Proving stopped/);
  await press;
  assert.equal(proves.length, 1);
  assert.equal(W.summary().balance, A);
});

await check('a press that waits for the proof reads the pool after the wait: a head that moved meanwhile is found before the wallet', async () => {
  let open; const gate = new Promise((r) => { open = r; });
  const { W, pool, proves, sent, steps, deposit } = setup({ gate });
  const ahead = W.prepareDeposit(A);
  const press = deposit(A);
  await new Promise((r) => setTimeout(r, 50));
  insert(pool);
  open();
  await ahead; await press;
  assert.equal(proves.length, 2, 'the proof made on the old head, and one on the new');
  assert.equal(sent.length, 1, 'only the proof on the new head went to the wallet');
  assert.equal(sent[0].publicInputs[3], '2');
  assert.ok(!steps.includes('someone else got in first, proving again'));
  assert.equal(W.summary().balance, A);
});

await check('a deposit the wallet refuses keeps its proof for the next try', async () => {
  const { W, proves, sent, deposit } = setup({ refuseOnce: true });
  await W.prepareDeposit(A);
  await assert.rejects(deposit(A), /rejected/i);
  assert.equal(proves.length, 1);
  await deposit(A);
  assert.equal(proves.length, 1, 'the second try sent the proof made ahead');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].publicInputs, sent[1].publicInputs);
  assert.equal(W.summary().balance, A);
});

await check('and one the wallet refused after the head moved proves again, on the new head', async () => {
  const { W, pool, proves, sent, deposit } = setup({ refuseOnce: true });
  await W.prepareDeposit(A);
  await assert.rejects(deposit(A), /rejected/i);
  insert(pool);
  await deposit(A);
  assert.equal(proves.length, 2);
  assert.equal(sent[1].publicInputs[3], '2');
  assert.equal(W.summary().balance, A);
});

await check('an amount that is not positive is refused', async () => {
  const { W } = setup();
  await assert.rejects(W.prepareDeposit(0n), /enter an amount/);
});


await check('a read that fails at the press does not cost the proof made ahead', async () => {
  const ctl = {}, { W, proves, deposit } = setup(ctl);
  await W.prepareDeposit(A);
  ctl.failRead = true;
  await assert.rejects(deposit(A), /fetch failed/);
  ctl.failRead = false;
  await deposit(A);
  assert.equal(proves.length, 1, 'the proof made ahead stood for the next press');
  assert.equal(W.summary().balance, A);
});

await check('a read the caller made just before the press, after the proof was done, stands for the press; one begun before the proof does not', async () => {
  const early = {}, a = setup(early), t0 = Date.now() - 1;
  await a.W.prepareDeposit(A);
  await new Promise((r) => setTimeout(r, 5));
  const readAt = Date.now(); await a.W.sync();
  const reads = early.reads;
  await a.deposit(A, { readAt });
  assert.equal(early.readsAtSend, reads, 'no read of the pool between the caller\'s and the wallet');
  const stale = {}, b = setup(stale);
  await b.W.prepareDeposit(A);
  const reads2 = stale.reads;
  await b.deposit(A, { readAt: t0 });
  assert.equal(stale.readsAtSend, reads2 + 1, 'a read begun before the proof was done is not trusted: the pool is read again');
  // and a head that moved after the caller\'s read is found by the check before the wallet, which proves again
  const ctl = {}, c = setup(ctl);
  await c.W.prepareDeposit(A);
  await new Promise((r) => setTimeout(r, 5));
  const at = Date.now(); await c.W.sync();
  insert(c.pool);
  await c.deposit(A, { readAt: at });
  assert.equal(c.proves.length, 2, 'proved again on the new head');
  assert.equal(c.W.summary().balance, A);
});

console.log(`${n} passed`);
