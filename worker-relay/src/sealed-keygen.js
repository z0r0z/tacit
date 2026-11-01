// Makes a gateway key for the private route. The secret goes in the keeper's EVM_POOL_KEEPER_GATEWAY_KEY (or the _<chainId> form for one
// chain) and nowhere else; the public key is what the pages pin and what GET /evm-pool/keeper/info shows once the route is on.
//   node src/sealed-keygen.js

import { bytesToHex } from '../../dapp/vendor/tacit-deps.min.js';
import { newGatewayKey, gatewayKeys } from '../../dapp/sealed-request.js';

const secret = newGatewayKey();
const keys = gatewayKeys(secret);
console.log(`secret      ${secret}   (the keeper's EVM_POOL_KEEPER_GATEWAY_KEY; keep it out of git and logs)`);
console.log(`public key  ${bytesToHex(keys.pub)}`);
console.log(`key id      ${bytesToHex(keys.kid)}`);
