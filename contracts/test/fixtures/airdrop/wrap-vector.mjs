// Builds the deposit a wallet would pass to claimAndShield, with the dapp's own buildWrap, and writes it as a fixture.
//   node contracts/test/fixtures/airdrop/wrap-vector.mjs
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../../../../node_modules/@noble/hashes/sha3.js';
import * as secp from '../../../../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../../../../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../../../../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../../../../dapp/confidential-pool-ux.js';

const cat = (arrs) => { const o = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0)); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'mainnet', fetchImpl: async () => { throw new Error('offline'); } });

const walletPriv = '0x' + '7a'.repeat(32);
const amountWei = 1234n * 10n ** 18n;
const w = ux.buildWrap({ walletPriv, amountWei, ticker: 'TAC', index: 0 });
const out = { ticker: 'TAC', assetId: w.wrapArgs.assetId, amountWei: amountWei.toString(), commit: w.commit, depositId: w.depositId, index: 0 };
writeFileSync(new URL('./wrap-vector.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(out);
