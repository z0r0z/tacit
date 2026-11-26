#!/usr/bin/env node
// An operator signs an ad for their node and posts it to the board.
//   OPERATOR_KEY=<32-byte hex> node tools/nodes-ad.mjs --eth https://eth.example.org [--eth-roles eth-reads,eth-logs] \
//        --btc https://btc.example.org/api [--btc-roles btc-esplora] [--pay-to 0x…] [--name "my node"] [--days 30] \
//        [--post https://api.tacit.finance/nodes/ad]
// Without --post the signed ad is printed. The ad is good for --days (at most 30); post it again to change or extend it.
import process from 'node:process';
import { secp, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { signAd, checkAd } from '../dapp/nodes-list.js';

const a = process.argv.slice(2), arg = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : null; };
const key = (process.env.OPERATOR_KEY || '').replace(/^0x/, '');
if (!/^[0-9a-f]{64}$/i.test(key)) { console.error('OPERATOR_KEY (32-byte hex; node tools/nodes-keygen.mjs makes one) is not set'); process.exit(1); }
const endpoints = [];
if (arg('eth')) endpoints.push({ kind: 'eth', url: arg('eth'), roles: (arg('eth-roles') || 'eth-reads').split(',') });
if (arg('btc')) endpoints.push({ kind: 'btc', url: arg('btc'), roles: (arg('btc-roles') || 'btc-esplora').split(',') });
if (!endpoints.length) { console.error('give --eth <url> and/or --btc <url>'); process.exit(1); }
const now = Math.floor(Date.now() / 1000);
const ad = signAd({ operator: bytesToHex(secp.getPublicKey(hexToBytes(key), true)), ...(arg('pay-to') ? { payTo: arg('pay-to') } : {}), ...(arg('name') ? { name: arg('name') } : {}), endpoints, at: now, until: now + Math.min(30, Number(arg('days')) || 30) * 86400 }, key);
checkAd(ad, now);
if (!arg('post')) { console.log(JSON.stringify(ad, null, 2)); process.exit(0); }
const r = await fetch(arg('post'), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(ad) });
console.log(r.status, await r.text());
process.exit(r.ok ? 0 : 1);
