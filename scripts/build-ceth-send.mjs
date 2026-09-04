// Build a confidential OP_TRANSFER spending the cETH note this wallet just wrapped (leaf index 1 on
// the current mainnet pool generation), split into a recipient output + change, with an optional
// relay-fee tip. Mirrors build-ceth-wrap.mjs: the wallet scalar is the note owner/scan key, reused
// here to rebuild the exact note (deriveNote is deterministic in (priv, assetId, index)) and to
// reconstruct its Merkle membership witness from the pool's LeavesInserted history.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const _cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
secp.etc.hmacSha256Sync = (k, ...m) => hmac(nobleSha256, k, _cat(m));

const walletPriv = (process.env.WALLET_PRIV || '').replace(/\s+/g, '');
if (!/^0x?[0-9a-fA-F]{64}$/.test(walletPriv.startsWith('0x') ? walletPriv : '0x' + walletPriv)) {
  console.error('set WALLET_PRIV to a 32-byte hex key'); process.exit(1);
}
const network = process.env.NETWORK || 'signet';
const rpc = process.env.RPC_URL || 'https://ethereum-rpc.publicnode.com';
const feeUnits = BigInt(process.env.FEE_UNITS || '10000'); // 10000 = the cETH relay-fee floor (0.0001 ETH)

const pool = makeConfidentialPool({ keccak256: keccak_256, sha256, secp });
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: fetch, network });
const meta = ux.cfg.assets.find((a) => a.ticker === 'cETH');
if (!meta) { console.error('cETH not in this network config'); process.exit(1); }

async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

// Pull every LeavesInserted log since the pool's deploy block, in <=10k-block chunks (public RPC cap),
// and flatten into the ordered leaf array the tree needs. topics[1] (firstLeafIndex) is indexed; the
// leaves themselves are in `data` (offset word0 = leaves-array offset, per the eth_pool_loop gotcha).
async function fetchAllLeaves() {
  const TOPIC = '0x7783fb256f5b4e1d4d8b79583488756286326ae15d9997d4098ce5432ed2708b';
  const fromBlock = Number(process.env.DEPLOY_BLOCK || 25853421);
  const toBlock = Number(await rpcCall('eth_blockNumber', []));
  const CHUNK = 9999;
  const logs = [];
  for (let b = fromBlock; b <= toBlock; b += CHUNK + 1) {
    const end = Math.min(b + CHUNK, toBlock);
    const res = await rpcCall('eth_getLogs', [{ fromBlock: '0x' + b.toString(16), toBlock: '0x' + end.toString(16), address: ux.cfg.pool, topics: [TOPIC] }]);
    logs.push(...res);
  }
  logs.sort((a, b) => (parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16)) || (parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16)));
  const leaves = [];
  for (const log of logs) {
    const firstLeafIndex = parseInt(log.topics[1], 16);
    const data = log.data.slice(2);
    const word = (i) => data.slice(i * 64, i * 64 + 64);
    const leavesOffsetWords = parseInt(word(0), 16) / 32;
    const leavesLen = parseInt(word(leavesOffsetWords), 16);
    const arr = [];
    for (let i = 0; i < leavesLen; i++) arr.push('0x' + word(leavesOffsetWords + 1 + i));
    leaves[firstLeafIndex] = leaves[firstLeafIndex]; // no-op, just documenting intent
    for (let i = 0; i < arr.length; i++) leaves[firstLeafIndex + i] = arr[i];
  }
  return leaves;
}

const leaves = await fetchAllLeaves();
console.error(`fetched ${leaves.length} leaves from chain`);

const id = { priv: walletPriv.startsWith('0x') ? walletPriv : '0x' + walletPriv };
const { secret, blinding } = pool.deriveNote(id.priv, meta.assetId, 0);
const blindingHex = '0x' + BigInt(blinding).toString(16).padStart(64, '0');
const { cx, cy } = pool.commitXY(200000n, blindingHex);
const ownerFromPriv = (() => {
  // identity() is internal to confidential-pool-ux.js; rederive owner the same way buildWrap did by
  // reusing buildWrap's own output would require a second wrap — instead pull it via the note object
  // ux exposes on any builder that touches identity. Simplest: ask ux to build a zero-effect wrap probe
  // is wasteful; ux does not export identity() directly, so recompute via secp the same way pool-ux does
  // (owner = pubkey[1:33], i.e. the x-coordinate of P = priv*G).
  const P = secp.ProjectivePoint.BASE.multiply(BigInt(id.priv) % secp.CURVE.n);
  return '0x' + P.toRawBytes(true).slice(1, 33).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
})();
const pubHex = '0x' + secp.ProjectivePoint.BASE.multiply(BigInt(id.priv) % secp.CURVE.n).toRawBytes(true).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

const leafIndex = 1;
const expectedLeaf = pool.leaf(meta.assetId, cx, cy, ownerFromPriv);
if (String(leaves[leafIndex]).toLowerCase() !== String(expectedLeaf).toLowerCase()) {
  console.error(`leaf mismatch: on-chain leaf[${leafIndex}]=${leaves[leafIndex]} vs recomputed=${expectedLeaf}`);
  process.exit(1);
}
console.error('note reconstructed and matches on-chain leaf', expectedLeaf);

const { root, path } = (() => {
  const t = new pool.Tree();
  for (const l of leaves) t.insert(l);
  return t.rootAndPath(leafIndex);
})();

const note = { value: '200000', blinding: blindingHex, secret, asset: meta.assetId, owner: ownerFromPriv, cx, cy, leafIndex, root, path };

const amount = 200000n - feeUnits; // send (value - fee) to the recipient, 0 change, fee = relay tip
const built = ux.buildTransferOp({ walletPriv: id.priv, notes: [note], recipientPubHex: pubHex, amount, fee: feeUnits });

writeFileSync('/tmp/sendop.json', JSON.stringify(built.op));
writeFileSync('/tmp/send-leaves.json', JSON.stringify(built.leaves));
writeFileSync('/tmp/send-memos.json', JSON.stringify(built.memos));
console.log('SPEND_ROOT=' + root);
console.log('AMOUNT=' + amount);
console.log('FEE=' + feeUnits);
console.log('CHANGE=' + built.change);
console.log('RECIPIENT_PUB=' + pubHex + ' (self, split-send)');
console.log('OUT_LEAVES=' + JSON.stringify(built.leaves));
