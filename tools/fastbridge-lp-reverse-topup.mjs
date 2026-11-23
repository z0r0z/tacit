#!/usr/bin/env node
// Moves one plain coin of the provider's main address to its reverse address: the way to give the reverse side the sats its locks cost (a reverse swap spends about 3,650 sats of Bitcoin fees
// and the user's claim budget). The main address is read by the coin you name, never listed (explorers refuse an address with this many outputs), and the destination is the reverse
// key's own address, derived from FB_LP_KEY, never typed. The coin must be confirmed, unspent, a plain P2WPKH output of the main address, and between 10,000 and 200,000 sats (so it cannot be a note,
// and the large treasury coins are out of range). It says what it would do and sends nothing unless it is given the token of that exact plan.
//
//   FB_LP_KEY=$(security find-generic-password -s tacit-fastbridge-lp -w) node tools/fastbridge-lp-reverse-topup.mjs --coin <txid:vout>
//   … --coin <txid:vout> --send --confirm <the token the line above printed>
//
// Node 22; from the repository root.

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MIN_COIN = 10_000, MAX_COIN = 200_000, MIN_RATE = 2, SEND_VB = 110;     // 1 P2WPKH input, 1 P2WPKH output
export const parseOutpoint = (s) => {
  const m = /^([0-9a-f]{64}):(\d{1,4})$/i.exec(String(s || '').trim());
  if (!m) throw new Error('--coin must be <64-hex txid>:<output number>');
  return { txid: m[1].toLowerCase(), vout: Number(m[2]) };
};

// What would be sent: the whole of the named coin, less the fee, to the reverse address.
export async function planTopup({ coin, mainAddress, reverseAddress, fetchJson, rate = MIN_RATE }) {
  const tx = await fetchJson(`/tx/${coin.txid}`).catch(() => null);
  const o = tx && Array.isArray(tx.vout) ? tx.vout[coin.vout] : null;
  if (!o) throw new Error('that coin could not be read from the explorer');
  if (o.scriptpubkey_address !== mainAddress || o.scriptpubkey_type !== 'v0_p2wpkh') throw new Error('that output is not a plain output of the provider\'s main address');
  if (!(tx.status && tx.status.confirmed)) throw new Error('that coin is not confirmed yet');
  if (!(o.value >= MIN_COIN && o.value <= MAX_COIN)) throw new Error(`that coin is ${o.value} sats: this tool moves coins of ${MIN_COIN} to ${MAX_COIN} sats only`);
  const os = await fetchJson(`/tx/${coin.txid}/outspend/${coin.vout}`).catch(() => null);
  if (!os || os.spent !== false) throw new Error('that coin is already spent, or its state could not be read');
  const fee = Math.ceil(SEND_VB * Math.max(MIN_RATE, rate));
  return { coin: { ...coin, value: o.value, spk: o.scriptpubkey }, to: reverseAddress, fee, rate: Math.max(MIN_RATE, rate), out: o.value - fee };
}

export const topupToken = (plan) => createHash('sha256').update(JSON.stringify({ c: [plan.coin.txid, plan.coin.vout, plan.coin.value], t: plan.to, f: plan.fee })).digest('hex').slice(0, 10);

export const describePlan = (plan, from) => [
  `from the provider's main address ${from}: the coin ${plan.coin.txid.slice(0, 8)}…:${plan.coin.vout} (${plan.coin.value} sats)`,
  `would move it whole to the reverse address ${plan.to}: ${plan.out} sats arrive, the fee is ${plan.fee} sats (${plan.rate} sat/vB)`].join('\n');

export async function executeTopup({ tacit, plan, token, mainPriv, mainPub, reversePub, bytesToHex }) {
  if (token !== topupToken(plan)) throw new Error('the confirm token is not the one for this plan: run it without --send and use the token it prints');
  if (bytesToHex(tacit.p2wpkhScript(mainPub)) !== plan.coin.spk) throw new Error('the key is not the one that owns that output: nothing was sent');
  if (plan.out < tacit.DUST || plan.coin.value !== plan.out + plan.fee) throw new Error('the plan does not add up: nothing was sent');
  const tx = { version: 2, locktime: 0, inputs: [{ txid: plan.coin.txid, vout: plan.coin.vout, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: plan.out, script: tacit.p2wpkhScript(reversePub) }] };
  tx.inputs[0].witness = tacit.signP2wpkhInputWithKey(tx, 0, plan.coin.value, mainPriv, mainPub);
  await tacit.broadcastWithRetry(bytesToHex(tacit.serializeTx(tx)));
  return tacit.txid(tx);
}

async function main() {
  const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const keyHex = String(process.env.FB_LP_KEY || '').trim().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.log('no key in the environment (FB_LP_KEY, 64 hex characters)'); process.exit(1); }
  delete process.env.FB_LP_KEY;
  const coin = parseOutpoint(arg('--coin'));
  const hardStop = setTimeout(() => { console.log('STOPPED: time limit'); process.exit(3); }, 10 * 60e3); hardStop.unref?.();
  globalThis.__TACIT_WORKER_BASE__ = process.env.TACIT_WORKER_BASE || 'https://api.tacit.finance'; globalThis.__TACIT_CHAIN_VIA_WORKER__ = true;
  const { loadTacit } = await import(REPO + '/worker-relay/src/lib/btc-pool-transparent.js');
  const { secp, sha256, hmac, bytesToHex } = await import(REPO + '/dapp/vendor/tacit-deps.min.js');
  secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
  const { setActiveNetwork } = await import(REPO + '/dapp/confidential-deployments.js');
  const { makeBtcWallet } = await import(REPO + '/dapp/bitcoin-taproot-wallet.js');
  const { reverseKeyOf } = await import(REPO + '/fastbridge-lp/lib/reverse.mjs');
  setActiveNetwork('mainnet');
  const key = Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16)));
  const wallet = (priv) => makeBtcWallet({ priv, hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 }).prims.wallet;
  const mainW = wallet(key), revW = wallet(reverseKeyOf(key));
  const tacit = await loadTacit('mainnet', { livePool: true });
  delete globalThis.location;
  const fetchJson = async (path) => {
    for (const round of [0, 1, 2]) {
      for (const base of ['https://mempool.emzy.de/api', 'https://mempool.space/api', 'https://blockstream.info/api']) {
        try { const r = await fetch(base + path, { signal: AbortSignal.timeout(25e3) }); if (r.ok) return await r.json(); } catch { /* next explorer */ }
      }
      await new Promise((r) => setTimeout(r, 6000 * (round + 1)));
    }
    throw new Error('no explorer answered ' + path);
  };
  const rate = Math.max(MIN_RATE, Number(await tacit.getFeeRate('standard')) || MIN_RATE);
  const plan = await planTopup({ coin, mainAddress: mainW.address(), reverseAddress: revW.address(), fetchJson, rate });
  console.log(describePlan(plan, mainW.address()));
  const token = topupToken(plan);
  if (!process.argv.includes('--send')) { console.log(`\nnothing was sent. To send it: run the same command with  --send --confirm ${token}`); process.exit(0); }
  const sent = await executeTopup({ tacit, plan, token: arg('--confirm'), mainPriv: key, mainPub: mainW.pub, reversePub: revW.pub, bytesToHex });
  console.log(`\nsent: ${sent}`);
  process.exit(0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.log(String((e && e.message) || e).slice(0, 300)); process.exit(1); });
