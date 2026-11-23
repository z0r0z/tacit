#!/usr/bin/env node
// Sends a few thousand sats of the reverse key's own fee coin to a Bitcoin address named on the command line: the way to give a test wallet the sats a TAC transfer of its own needs
// (a wallet that was paid only note-sized outputs cannot pay the fee of sending them on). A plain bech32 (P2WPKH) address only, at most 5,000 sats, from a confirmed plain coin that no
// TAC note sits on; it says what it would do and sends nothing unless it is given the token of that exact plan.
//
//   FB_LP_KEY=$(security find-generic-password -s tacit-fastbridge-lp -w) node tools/fastbridge-lp-reverse-sats.mjs --to bc1q… --sats 3000
//   … --to bc1q… --sats 3000 --send --confirm <the token the line above printed>
//
// Node 22; from the repository root.

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MIN_SATS = 1000, MAX_SATS = 5000, MIN_RATE = 2;      // a rate that keeps a few thousand sats from sitting unconfirmed when blocks floor above 1 sat/vB
export const parseSats = (s) => {
  if (!/^\d{3,5}$/.test(String(s ?? '').trim())) throw new Error(`--sats must be a whole number of sats from ${MIN_SATS} to ${MAX_SATS}`);
  const n = Number(s);
  if (n < MIN_SATS || n > MAX_SATS) throw new Error(`--sats must be from ${MIN_SATS} to ${MAX_SATS}`);
  return n;
};

// What would be sent: from the smallest confirmed plain coin that covers the amount and the fee, to a mainnet P2WPKH address that is not the key's own.
export async function planSats({ tacit, address, to, sats }) {
  const dest = tacit.decodeP2wpkhAddress(String(to || '').trim().toLowerCase());
  if (!dest || dest.hrp !== 'bc') throw new Error('--to must be a mainnet bech32 address starting bc1q');
  if (String(to).trim().toLowerCase() === address) throw new Error('--to is the key\'s own address: nothing to send');
  const holdings = await tacit.scanHoldings(true);
  const all = await tacit.getUtxos(address);
  const rate = Math.max(MIN_RATE, Number(await tacit.getFeeRate('standard')) || MIN_RATE);
  const fee = Math.ceil(tacit.estSatsSendVb(1, true) * rate);
  const need = sats + fee + tacit.DUST;
  const coin = tacit.selectSatsUtxosSafe(all, holdings).filter((u) => u.value > tacit.DUST && u.status && u.status.confirmed && u.value >= need).sort((a, b) => a.value - b.value)[0];
  if (!coin) throw new Error(`no confirmed plain coin at the reverse address covers ${sats} sats, a fee of about ${fee} and a change that is not dust`);
  return { to: String(to).trim().toLowerCase(), toProgram: Array.from(dest.program), sats, fee, rate, coin: { txid: coin.txid, vout: coin.vout, value: coin.value }, change: coin.value - sats - fee };
}

export const satsToken = (plan) => createHash('sha256').update(JSON.stringify({ t: plan.to, s: plan.sats, c: [plan.coin.txid, plan.coin.vout, plan.coin.value], f: plan.fee })).digest('hex').slice(0, 10);

export const describePlan = (plan, from) => [
  `from the reverse address ${from}: the coin ${plan.coin.txid.slice(0, 8)}…:${plan.coin.vout} (${plan.coin.value} sats)`,
  `would send ${plan.sats} sats to ${plan.to}, with a fee of about ${plan.fee} sats (${plan.rate} sat/vB), and about ${plan.change} sats back to the reverse address as change (it is the fee coin of the reverse locks and is unavailable to them until this confirms)`].join('\n');

// One input, the coin of the plan; an output to the address and one back to the key; the whole of the fee the plan names. Built here, not by the wallet module's own send, so that what goes out is what was shown.
export async function executeSats({ tacit, plan, token, bytesToHex }) {
  if (token !== satsToken(plan)) throw new Error('the confirm token is not the one for this plan: run it without --send and use the token it prints');
  if (plan.change < tacit.DUST || plan.coin.value !== plan.sats + plan.fee + plan.change) throw new Error('the plan does not add up: nothing was sent');
  const toScript = Uint8Array.from([0x00, 0x14, ...plan.toProgram]);
  const tx = { version: 2, locktime: 0, inputs: [{ txid: plan.coin.txid, vout: plan.coin.vout, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: plan.sats, script: toScript }, { value: plan.change, script: tacit.p2wpkhScript(tacit.wallet.pub) }] };
  tx.inputs[0].witness = tacit.signP2wpkhInputWithKey(tx, 0, plan.coin.value, tacit.wallet.priv, tacit.wallet.pub);
  await tacit.broadcastWithRetry(bytesToHex(tacit.serializeTx(tx)));
  return tacit.txid(tx);
}

async function main() {
  const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const keyHex = String(process.env.FB_LP_KEY || '').trim().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.log('no key in the environment (FB_LP_KEY, 64 hex characters)'); process.exit(1); }
  delete process.env.FB_LP_KEY;
  const sats = parseSats(arg('--sats')), to = arg('--to');
  const hardStop = setTimeout(() => { console.log('STOPPED: time limit'); process.exit(3); }, 10 * 60e3); hardStop.unref?.();
  globalThis.__TACIT_WORKER_BASE__ = process.env.TACIT_WORKER_BASE || 'https://api.tacit.finance'; globalThis.__TACIT_CHAIN_VIA_WORKER__ = true;
  const { loadTacit } = await import(REPO + '/worker-relay/src/lib/btc-pool-transparent.js');
  const { secp, sha256, hmac, bytesToHex } = await import(REPO + '/dapp/vendor/tacit-deps.min.js');
  secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
  const { setActiveNetwork } = await import(REPO + '/dapp/confidential-deployments.js');
  const { makeBtcWallet } = await import(REPO + '/dapp/bitcoin-taproot-wallet.js');
  const { reverseKeyOf } = await import(REPO + '/fastbridge-lp/lib/reverse.mjs');
  setActiveNetwork('mainnet');
  const rkey = reverseKeyOf(Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16))));
  const { prims } = makeBtcWallet({ priv: rkey, hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
  const tacit = await loadTacit('mainnet', { livePool: true });
  delete globalThis.location;
  tacit.wallet.priv = rkey; tacit.wallet.pub = prims.wallet.pub;
  const address = prims.wallet.address();
  const plan = await planSats({ tacit, address, to, sats });
  console.log(describePlan(plan, address));
  const token = satsToken(plan);
  if (!process.argv.includes('--send')) { console.log(`\nnothing was sent. To send it: run the same command with  --send --confirm ${token}`); process.exit(0); }
  const sent = await executeSats({ tacit, plan, token: arg('--confirm'), bytesToHex });
  console.log(`\nsent: ${sent || '(broadcast)'}`);
  process.exit(0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.log(String((e && e.message) || e).slice(0, 300)); process.exit(1); });
