#!/usr/bin/env node
// Puts TAC that the fast bridge provider's Ethereum address holds into the Ethereum pool as private notes of the same key: the TAC it
// lends. It is the funding step of fastbridge-lp/README.md ("Fund it"), and the way to top the provider up later. With --eth it puts
// plain ETH of the address into the pool instead: the ETH a Bitcoin-for-ETH provider (pair mode) lends.
//
//   FB_LP_KEY=<64 hex> node tools/fastbridge-lp-shield.mjs <TAC> [--index N] [--send]
//   FB_LP_KEY=<64 hex> node tools/fastbridge-lp-shield.mjs <ETH> --eth [--index N] [--send]
//
//   <TAC>       the amount, up to 8 places (the pool's notes have 8); with --eth, ETH, and some more ETH stays at the address for gas
//   --index N   the wrap index of this key's deposit. The first deposit of a key is 0, the next 1, and so on; without it the pool's
//               history is read to find the next free one, which takes minutes. A used index is refused before anything is sent.
//   --send      send it. Without it, only checks: the balances, the permit, the deposit built and run as a call (nothing is sent)
//   FORK=<url>  Ethereum reads and sends go to a fork (anvil) instead of mainnet, and the relay is not asked, so the settle is skipped
//   EXPECT_ADDRESS=<0x…>  refuse to run unless the key's address is this one (a wrong key moves nothing)
//
// The key is read from the environment and is never printed. Node 22; run from the repository root.

import { makeFileStorage } from '../fastbridge-lp/lib/storage.mjs';
import { GAS_KEPT, parseAmount, checkDeposit, sendDeposit, waitMined, settleDeposit } from '../fastbridge-lp/lib/shield-core.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const ETH = args.includes('--eth');
const UNIT = ETH ? 'ETH' : 'TAC';
const TICKER = ETH ? 'cETH' : 'TAC';
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const amountText = args.find((a) => /^\d+(\.\d{1,8})?$/.test(a));
const die = (m) => { console.error(m); process.exit(1); };

const keyHex = String(process.env.FB_LP_KEY || '').trim().replace(/^0x/, '');
if (!/^[0-9a-f]{64}$/i.test(keyHex)) die('FB_LP_KEY must be 64 hex characters (set it in the environment)');
if (!amountText) die('usage: FB_LP_KEY=<64 hex> node tools/fastbridge-lp-shield.mjs <amount, up to 8 places> [--eth] [--index N] [--send]');
const indexArg = flag('--index');
if (indexArg != null && !/^\d+$/.test(indexArg)) die('--index must be a whole number');
const FORK = process.env.FORK || null;
const { notes8, amountWei } = parseAmount(amountText);                          // the pool's units (8 places) and the token's (18)
if (notes8 <= 0n) die('the amount must be more than zero');

// the pool module is a browser module: it keeps hints in a localStorage, here a file in the temp directory
globalThis.localStorage = makeFileStorage(join(tmpdir(), 'tacit-lp-shield-cache.json'));
// a fork: every Ethereum JSON-RPC request goes to it, anything else (the relay) is left alone
const realFetch = globalThis.fetch.bind(globalThis);
if (FORK) {
  globalThis.fetch = (u, o) => {
    let rpc = false;
    try { rpc = !!o && String(o.method || '').toUpperCase() === 'POST' && typeof o.body === 'string' && JSON.parse(o.body).jsonrpc === '2.0'; } catch { rpc = false; }
    return rpc ? realFetch(FORK, o) : realFetch(u, o);
  };
}

const { secp, sha256, keccak_256, hmac } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
setActiveNetwork('mainnet');
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => globalThis.fetch(u, o), network: 'mainnet' });

const key = Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16)));
const acct = ux.account(key);
if (process.env.EXPECT_ADDRESS && process.env.EXPECT_ADDRESS.toLowerCase() !== acct.address.toLowerCase()) die(`this key's address is ${acct.address}, not ${process.env.EXPECT_ADDRESS}: nothing was done`);
const meta = ux.assetByTicker[TICKER];
if (!meta || !(ETH ? meta.assetId : meta.underlying)) die(`this build of the pool module has no ${UNIT} to wrap (assetByTicker.${TICKER})`);
const hexq = (v) => '0x' + BigInt(v).toString(16);
const word = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const ethOf = async (a) => BigInt(await ux.rpc('eth_getBalance', [a, 'latest']));
const tacOf = async (a) => (ETH ? ethOf(a) : BigInt(await ux.rpc('eth_call', [{ to: meta.underlying, data: '0x70a08231' + word(a) }, 'latest'])));
const show = (wei) => `${(Number(wei / 10n ** 10n) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 })} ${UNIT}`;

console.log(JSON.stringify({ address: acct.address, token: ETH ? 'ETH' : meta.underlying, amount: amountText + ' ' + UNIT, fork: FORK || null, send: SEND }));
const [eth, tac] = [await ethOf(acct.address), await tacOf(acct.address)];
console.log(`holds ${ETH ? '' : show(tac) + ' and '}${(Number(eth) / 1e18).toFixed(6)} ETH`);
if (tac < amountWei + (ETH ? GAS_KEPT : 0n)) die(`the address holds ${show(tac)}, short of the ${amountText} ${UNIT} asked${ETH ? ` and ${show(GAS_KEPT)} for gas` : ''}: nothing was done`);

const index = indexArg != null ? BigInt(indexArg) : undefined;
const { built } = await checkDeposit({ ux, key, address: acct.address, amountWei, ticker: TICKER, index }).catch((e) => die(String((e && e.message) || e)));
console.log(JSON.stringify({ permit: built.permitType, router: built.to, index: String(built.index ?? index ?? ''), needsPermit2Approval: !!built.needsPermit2Approval, calldataBytes: built.calldata ? (built.calldata.length - 2) / 2 : 0 }));
if (!built.needsPermit2Approval) console.log('the deposit runs as a call: it would not revert');
if (!SEND) { console.log('checked only; add --send to send it'); process.exit(0); }

const sent = await sendDeposit({ ux, key, amountWei, ticker: TICKER, index });
console.log('deposit sent:', sent.txHash);
const receipt = await waitMined(ux, sent.txHash);
if (!receipt || receipt.status !== '0x1') die(`the deposit did not succeed (${receipt ? 'reverted' : 'no receipt in 6 minutes'}): ${sent.txHash}`);
console.log(`deposit mined in block ${Number(receipt.blockNumber)}; the address now holds ${show(await tacOf(acct.address))}${ETH ? ' (the rest of it is for gas)' : ''}`);
if (FORK) { console.log('fork: the relay is not asked, so the notes are not settled here'); process.exit(0); }

const settled = await settleDeposit({ ux, key, address: acct.address, sent, say: console.log }).catch((e) => die(`the deposit is on the chain (${sent.txHash}, index ${String(sent.index ?? index ?? '')}) but its settle did not go through: ${String((e && e.message) || e).slice(0, 300)}`));
console.log('settle:', settled.status, settled.txHash || settled.jobId || '');
const bal = await ux.balance(key);
const idTail = ETH ? String(meta.assetId).toLowerCase().replace(/^0x/, '').slice(-64) : 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const tacNotes = Object.entries(bal.byAsset || {}).find(([k]) => k.toLowerCase().endsWith(idTail));
console.log(`private ${UNIT} in the pool for this key:`, tacNotes ? `${tacNotes[1].notes.length} note(s), ${show(tacNotes[1].notes.reduce((s, n) => s + BigInt(n.value), 0n) * 10n ** 10n)}` : 'none found yet');
process.exit(0);
