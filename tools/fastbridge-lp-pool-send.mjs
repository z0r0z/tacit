#!/usr/bin/env node
// Sends a little private TAC from the provider's own pool account to another Tacit identity: the way to put a few TAC in a test wallet (the reverse side's canary swap is
// run from one). The pool takes no plain transfer to another key, so it is a stealth lock the pool's own client builds from one note of the provider's (the note is cut to the exact
// amount first), to the public key of the identity named on the command line: that identity then finds the lock by scanning and claims it.
// Capped at 5 TAC; says what it would do and sends nothing unless it is given the token of that exact plan.
//
//   FB_LP_KEY=$(security find-generic-password -s tacit-fastbridge-lp -w) node tools/fastbridge-lp-pool-send.mjs --tac 1.6 --to <66-hex Tacit identity public key>
//   … --tac 1.6 --to <pub> --send --confirm <the token the line above printed>
//
// Node 22; from the repository root.

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MAX_TAC_UNITS = 5n * 10n ** 8n;
const ONE = 10n ** 8n;
export const tacText = (v) => { const n = BigInt(v), f = (n % ONE).toString().padStart(8, '0').replace(/0+$/, ''); return `${(n / ONE).toString()}${f ? '.' + f : ''}`; };
export const parseTac = (s) => {
  const m = /^(\d{1,3})(?:\.(\d{1,8}))?$/.exec(String(s || '').trim());
  if (!m) throw new Error('--tac must be an amount of TAC such as 1.6');
  const v = BigInt(m[1]) * ONE + BigInt((m[2] || '').padEnd(8, '0'));
  if (v <= 0n) throw new Error('--tac must be more than 0');
  if (v > MAX_TAC_UNITS) throw new Error(`--tac is capped at ${tacText(MAX_TAC_UNITS)} TAC in this tool`);
  return v;
};
export const parsePub = (s) => { const h = String(s || '').trim().toLowerCase().replace(/^0x/, ''); if (!/^0[23][0-9a-f]{64}$/.test(h)) throw new Error('--to must be a Tacit identity public key: 66 hex characters starting 02 or 03'); return h; };

// What would be sent: the smallest note of the provider's that covers the amount and the relay fee.
export async function planSend({ ux, key, amount, toPub }) {
  const bal = await ux.balance(key, { cbtc: false, bridge: false });
  const tac = Object.values((bal && bal.byAsset) || {}).find((a) => a.ticker === 'TAC');
  if (!tac) throw new Error('the provider holds no private TAC');
  const fee = BigInt(await ux.quoteOpFee('TAC', 'transfer'));
  const note = (tac.notes || []).filter((n) => BigInt(n.value) >= amount + fee).sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : 1))[0];
  if (!note) { const have = (tac.notes || []).map((n) => BigInt(n.value)).sort((x, y) => (x < y ? 1 : -1)); throw new Error(`no single note of the provider's covers ${tacText(amount)} TAC and the ${tacText(fee)} TAC fee: it holds ${have.length} private TAC note${have.length === 1 ? '' : 's'}${have.length ? ', the largest ' + tacText(have[0]) + ' TAC' : ''}`); }
  return { amount, fee, toPub, asset: tac.asset, note, noteValue: BigInt(note.value) };
}
export const sendToken = (plan) => createHash('sha256').update(JSON.stringify({ a: plan.amount.toString(), f: plan.fee.toString(), t: plan.toPub, n: [String(plan.note.value), String(plan.note.leaf ?? plan.note.index ?? plan.note.id ?? '')] })).digest('hex').slice(0, 10);
export const describePlan = (plan, from) => [
  `from the provider's pool account ${from}: one note of ${tacText(plan.noteValue)} TAC`,
  `would lock ${tacText(plan.amount)} TAC privately for the identity ${plan.toPub.slice(0, 12)}…${plan.toPub.slice(-6)} (it claims it by scanning), after cutting the note to that amount (split fee ${tacText(plan.fee)} TAC); the rest (${tacText(plan.noteValue - plan.amount - plan.fee)} TAC) stays with the provider`].join('\n');

export async function executeSend({ ux, key, plan, token, log = () => {} }) {
  if (token !== sendToken(plan)) throw new Error('the confirm token is not the one for this plan: run it without --send and use the token it prints');
  const t0 = Date.now();
  const r = await ux.stealthSend({ walletPriv: key, recipientPubHex: plan.toPub, notes: [plan.note], amount: plan.amount, waitOpts: { timeoutMs: 25 * 60e3, intervalMs: 3000, onUpdate: (st) => log(`job ${st.status} ${st.stage || ''} +${Math.round((Date.now() - t0) / 1000)} s`) } });
  return r && (r.txHash || r.hash || null);
}

async function main() {
  const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const keyHex = String(process.env.FB_LP_KEY || '').trim().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.log('no key in the environment (FB_LP_KEY, 64 hex characters)'); process.exit(1); }
  delete process.env.FB_LP_KEY;
  const amount = parseTac(arg('--tac')), toPub = parsePub(arg('--to'));
  const hardStop = setTimeout(() => { console.log('STOPPED: time limit'); process.exit(3); }, 40 * 60e3); hardStop.unref?.();
  const { secp, sha256, keccak_256, hmac } = await import(REPO + '/dapp/vendor/tacit-deps.min.js');
  secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
  const { makeConfidentialPoolUx } = await import(REPO + '/dapp/confidential-pool-ux.js');
  const { setActiveNetwork } = await import(REPO + '/dapp/confidential-deployments.js');
  setActiveNetwork('mainnet');
  const key = Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16)));
  const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'mainnet' });
  const from = ux.account(key).address;
  const plan = await planSend({ ux, key, amount, toPub });
  console.log(describePlan(plan, from));
  const token = sendToken(plan);
  if (!process.argv.includes('--send')) { console.log(`\nnothing was sent. To send it: run the same command with  --send --confirm ${token}`); process.exit(0); }
  const sent = await executeSend({ ux, key, plan, token, log: (m) => console.log('  ' + m) });
  console.log(`\nsent: ${sent || '(settled)'}`);
  process.exit(0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.log(String((e && e.message) || e).slice(0, 300)); process.exit(1); });
