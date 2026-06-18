// Build a cETH wrap deposit for the current confidential pilot pool (from confidential-pool-ux.js
// config). Outputs the wrap calldata args, the OP_WRAP witness (for the box prover), the recovery memo,
// and the depositId. The wallet scalar doubles as the note owner + scan key (single-key e2e).
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const _cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
secp.etc.hmacSha256Sync = (k, ...m) => hmac(nobleSha256, k, _cat(m));

const walletPriv = (process.env.WALLET_PRIV || '').replace(/\s+/g, '');
if (!/^0x?[0-9a-fA-F]{64}$/.test(walletPriv.startsWith('0x') ? walletPriv : '0x' + walletPriv)) {
  console.error('set WALLET_PRIV to a 32-byte hex key'); process.exit(1);
}
const amountWei = process.env.AMOUNT_WEI || '1000000000000000'; // 0.001 ETH

const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: fetch });
const w = ux.buildWrap({ walletPriv, amountWei, ticker: 'cETH' });

writeFileSync('/tmp/wrapop.json', JSON.stringify(w.wrapOp));
writeFileSync('/tmp/wrap-memo.hex', w.memo);
console.log('POOL=' + ux.cfg.pool);
console.log('ASSET=' + w.wrapArgs.assetId);
console.log('AMOUNT=' + w.amount);
// wrap takes only the commit digest keccak(Cx‖Cy‖owner); the raw coords stay in the OP_WRAP witness
// (/tmp/wrapop.json), never on-chain. So the deposit note's nullifier is not publicly computable.
console.log('COMMIT=' + w.wrapArgs.commit);
console.log('DEPOSITID=' + w.depositId);
console.log('LEAF=' + w.leaf);
console.log('VALUE=' + w.note.value);
