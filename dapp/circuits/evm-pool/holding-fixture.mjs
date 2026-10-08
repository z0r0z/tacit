// Writes worker-relay/tests/fixtures/holding/fixture.json: a small pool history (five Transact events), the snapshot it gives, and two
// real Groth16 proofs of one note held in it, made against a DEVELOPMENT key (a single-party setup, never for deployment), for the
// points service's tests of claim verification. From dapp/circuits/evm-pool, after building the circuit as holding.test.mjs says:
//   node holding-fixture.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildPoseidon, newMemEmptyTrie } from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import { makeBtcPoolZk, mulB8, L_BJJ, P_FR } from '../../btc-pool-zk.js';
import { makeEvmPoolZk } from '../../evm-pool-zk.js';
import { claimHashOf } from '../../../worker-relay/src/lib/holding-epoch.js';
import { smtRoot } from '../../../worker-relay/src/lib/evm-pool-snapshot.js';

const WASM = 'build/holding_js/holding.wasm', ZKEY = 'build/holding_dev.zkey', SMT_LEVELS = 40;
const TAG_RET = 0x686f6c645f726574n, TAG_SIG = 0x686f6c645f736967n, ETH = 10n ** 18n;
const OUT = new URL('../../../worker-relay/tests/fixtures/holding/fixture.json', import.meta.url);

const P = await buildPoseidon();
const poseidon = (xs) => P.F.toObject(P(xs.map(BigInt)));
const base = makeBtcPoolZk({ poseidon }), evm = makeEvmPoolZk({ poseidon });
const { H, npkOf, nullifier, sign } = base;
const { leafOf, tree } = evm;
const rnd = (m) => { let x = 0n; while (x === 0n) x = BigInt('0x' + crypto.randomBytes(32).toString('hex')) % m; return x; };
const hex32 = (x) => '0x' + BigInt(x).toString(16).padStart(64, '0');
const str = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

const asset = 0n, chainId = 1, epoch = 20800;
const claimAddresses = ['0x' + 'ab'.repeat(20), '0x' + 'cd'.repeat(20)];
const makeNote = (v) => { const sk = rnd(L_BJJ), nk = rnd(L_BJJ), rho = rnd(P_FR), Ak = mulB8(sk); return { sk, nk, rho, v, Ak, npk: npkOf(Ak, mulB8(nk)) }; };
const notes = Array.from({ length: 8 }, (_, i) => makeNote(i === 3 ? (3n * ETH) / 2n : (BigInt(i + 1) * ETH) / 10n));
const MINE = 3, SPENT = [0, 1, 5];
const leafFor = (n) => leafOf(asset, n.v, n.npk, n.rho);
const T = tree(notes.map(leafFor));
const nfOf = (i) => nullifier(notes[i].nk, leafFor(notes[i]), i);

// The pool's events: four deposits' worth of insertions (the last also spending notes 0 and 1) and a withdrawal spending note 5.
const ref = evm.incTree();
const ev = (block, logIndex, outs, nfs) => {
  const firstIndex = BigInt(ref.size);
  if (outs[0] !== 0n || outs[1] !== 0n) ref.append(outs);
  return { block, logIndex, firstIndex: firstIndex.toString(), outLeaf0: hex32(outs[0]), outLeaf1: hex32(outs[1]), nf0: hex32(nfs[0]), nf1: hex32(nfs[1]), newRoot: hex32(ref.root) };
};
const L = notes.map(leafFor);
const events = [
  ev(100, 0, [L[0], L[1]], [0n, 0n]), ev(100, 1, [L[2], L[3]], [0n, 0n]), ev(101, 0, [L[4], L[5]], [0n, 0n]),
  ev(102, 0, [L[6], L[7]], [nfOf(0), nfOf(1)]), ev(103, 0, [0n, 0n], [nfOf(5), 0n]),
];
if (ref.root !== T.root) throw new Error('the events do not give the tree the proof is made against');

const trie = await newMemEmptyTrie();
for (const i of SPENT) await trie.insert(nfOf(i), 1n);
const F = (x) => trie.F.toObject(x);
const nfRoot = F(trie.root);
if (nfRoot !== smtRoot(SPENT.map(nfOf), H)) throw new Error('the service\'s spent-set root is not circomlib\'s');

async function exclusion(nf) {
  const r = await trie.find(nf);
  const sib = r.siblings.map(F);
  while (sib.length < SMT_LEVELS) sib.push(0n);
  return { smtSiblings: sib, smtOldKey: r.found ? nf : r.isOld0 ? 0n : F(r.notFoundKey), smtOldValue: r.found ? F(r.foundValue) : r.isOld0 ? 0n : F(r.notFoundValue), smtIsOld0: r.isOld0 ? 1n : 0n };
}

async function claimFor(claimAddress, bucketMin) {
  const note = notes[MINE], leaf = leafFor(note), nf = nfOf(MINE);
  const claimHash = claimHashOf({ chainId, epoch, claimAddress });
  const retNf = H([TAG_RET, note.nk, leaf, BigInt(epoch)]);
  const msg = H([TAG_SIG, asset, BigInt(epoch), T.root, nfRoot, bucketMin, claimHash, retNf]);
  const sig = sign(note.sk, msg);
  const input = {
    root: T.root, nfRoot, asset, epoch: BigInt(epoch), bucketMin, claimHash, retNf,
    v: note.v, rho: note.rho, nk: note.nk, ak: note.Ak, index: MINE, path: T.path(MINE), sigR8: sig.R8, sigS: sig.S, ...(await exclusion(nf)),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(str(input), WASM, ZKEY);
  return { claimAddress, proof, publicSignals };
}

const vkey = JSON.parse(fs.readFileSync('build/vk.json', 'utf8'));
const claims = [await claimFor(claimAddresses[0], ETH), await claimFor(claimAddresses[1], ETH)];
for (const c of claims) if (!(await snarkjs.groth16.verify(vkey, c.publicSignals, c.proof))) throw new Error('a fixture proof does not verify');

fs.mkdirSync(new URL('.', OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  note: 'DEVELOPMENT proofs: made against a single-party test key, for the points service\'s tests only. Regenerate with dapp/circuits/evm-pool/holding-fixture.mjs.',
  chainId, epoch, poolAsset: asset.toString(), bucketWei: ETH.toString(), emptyRoot: hex32(evm.incTree().root),
  events, snapshot: { block: 103, root: hex32(T.root), nfRoot: hex32(nfRoot), size: 8, nullifiers: 3 }, claims, vkey,
}, null, 1));
console.log('fixture written:', events.length, 'events,', claims.length, 'proofs; retNf of both:', claims.map((c) => c.publicSignals[6].slice(0, 12) + '…').join(' '));
process.exit(0);
