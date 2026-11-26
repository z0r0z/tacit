#!/usr/bin/env node
// Makes the prober's signing key, or an operator's: prints the private key (keep it secret: PROBER_KEY on the prober service) and the public key
// (pin it in dapp/nodes-list.js PROBER_PUBS). An operator's ad is made with `node tools/nodes-ad.mjs`.
import crypto from 'node:crypto';
import { secp, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
const priv = crypto.randomBytes(32);
console.log(JSON.stringify({ private: bytesToHex(priv), public: bytesToHex(secp.getPublicKey(priv, true)) }, null, 2));
