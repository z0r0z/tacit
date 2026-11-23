#!/usr/bin/env node
// Moves TAC that was sent to the reverse side's tacit1 address onto the reverse address itself. A tacit1 address is paid privately: the TAC sits at a one-time address of
// the reverse key, which the lock does not sign for and the reverse side does not count. This spends those notes (found again from the key and the transaction that paid
// them, with the wallet's own private-payment discovery) in one transfer to the reverse key's plain address, where the reverse side sells from. The same steps
// worker-relay/src/bridge-recover.js takes to send on TAC it was paid privately. The destination is the reverse key itself, derived from FB_LP_KEY, never typed in.
//
//   FB_LP_KEY=$(security find-generic-password -s tacit-fastbridge-lp -w) node tools/fastbridge-lp-reverse-normalize.mjs --txid <id of the transaction that paid it>
//       says what it would move and sends nothing
//   … --txid <id> --send --confirm <the token the line above printed>      moves it
//
// It needs a confirmed plain-sat coin at the reverse address for the transfer's fee (the same coin that pays the locks' fees). Node 22; from the repository root.

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const ONE = 10n ** 8n;
export const tacText = (v) => { const n = BigInt(v), f = (n % ONE).toString().padStart(8, '0').replace(/0+$/, ''); return `${(n / ONE).toString()}${f ? '.' + f : ''}`; };

// What would be moved, from the notes the wallet finds for this key in one transaction. Throws, in words, when there is nothing it can move.
export async function planMove({ tacit, txid, destPubHex, asset = TAC }) {
  if (!/^[0-9a-f]{64}$/.test(String(txid))) throw new Error('--txid must be the 64-hex id of the transaction your wallet paid the TAC in');
  try { await tacit.discoverStealthFromTxid(txid, { merge: true }); } catch (e) { throw new Error(`that transaction could not be read as a private payment to this key: ${String((e && e.message) || e).slice(0, 160)}`); }
  try { if (typeof tacit.invalidateHoldingsCache === 'function') tacit.invalidateHoldingsCache(); } catch { /* the scan below is forced anyway */ }
  const holdings = await tacit.scanHoldings(true);
  const entry = holdings instanceof Map ? holdings.get(asset) : null;
  const here = ((entry && entry.utxos) || []).filter((x) => x.utxo && x.utxo.txid === txid);
  if (!here.length) throw new Error('no TAC from that transaction was found for this key: is it the transaction that paid the reverse tacit1 address, and has it confirmed?');
  const stealth = here.filter((x) => x.stealthTweakedSk);
  if (!stealth.length) throw new Error('the TAC from that transaction is already a plain note at the reverse address: there is nothing to move');
  const ready = stealth.filter((x) => x.utxo.status && x.utxo.status.confirmed);
  if (!ready.length) throw new Error('the TAC from that transaction has not confirmed yet: run this again once it has');
  const inputs = ready.map((x) => ({ txid: x.utxo.txid, vout: x.utxo.vout, value: x.utxo.value, amount: BigInt(x.amount).toString() }));
  const total = ready.reduce((s, x) => s + BigInt(x.amount), 0n);
  if (total <= 0n) throw new Error('those notes hold no TAC');
  let coins = [];
  try { coins = tacit.selectSatsUtxosSafe(await tacit.getUtxos(tacit.wallet.address()), holdings).filter((u) => u.value > tacit.DUST && u.status && u.status.confirmed); } catch { /* said below */ }
  return { txid, asset, destPubHex, inputs, total: total.toString(), pending: stealth.length - ready.length, fee: { coins: coins.length, sats: coins.reduce((s, u) => s + u.value, 0) }, entries: ready };
}

// What the confirm token covers: the notes spent, what they hold, and where it goes. A plan that differs in any of them has another token.
export const moveToken = (plan) => createHash('sha256').update(JSON.stringify({ a: plan.asset, d: plan.destPubHex, i: plan.inputs.map((n) => [n.txid, n.vout, n.amount]), t: plan.total })).digest('hex').slice(0, 10);

export async function executeMove({ tacit, plan, token, bytesToHex }) {
  if (token !== moveToken(plan)) throw new Error('the confirm token is not the one for this plan: run it without --send and use the token it prints');
  if (bytesToHex(tacit.wallet.pub) !== plan.destPubHex) throw new Error('the open wallet is not the reverse key: nothing was sent');
  if (!plan.fee.coins) throw new Error('no confirmed plain-sat coin at the reverse address to pay the fee: wait for the sats to confirm, then run it again');
  const r = await tacit.buildAndBroadcastCXferMulti({ assetIdHex: plan.asset, recipients: [{ pubHex: plan.destPubHex, amount: BigInt(plan.total) }], forceUtxos: plan.entries });
  return r.revealTxid || r.txid || null;
}

export function describePlan(plan, address) {
  const L = [`found ${plan.inputs.length} private note${plan.inputs.length === 1 ? '' : 's'} from ${plan.txid.slice(0, 12)}…, confirmed: ${plan.inputs.map((n) => `${tacText(n.amount)} TAC (${n.txid.slice(0, 8)}…:${n.vout})`).join(', ')}`,
    `would move ${tacText(plan.total)} TAC in one transfer to ${address} (the reverse address, as a plain note)`,
    `fee coins at the reverse address: ${plan.fee.coins} confirmed plain coin${plan.fee.coins === 1 ? '' : 's'}, ${plan.fee.sats} sats${plan.fee.coins ? '' : '  <- NONE: wait for the sats to confirm first'}`];
  if (plan.pending) L.push(`(${plan.pending} more note${plan.pending === 1 ? '' : 's'} from that transaction not confirmed yet, left alone)`);
  return L.join('\n');
}

async function main() {
  const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const keyHex = String(process.env.FB_LP_KEY || '').trim().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.log('no key in the environment (FB_LP_KEY, 64 hex characters)'); process.exit(1); }
  delete process.env.FB_LP_KEY;
  const hardStop = setTimeout(() => { console.log('STOPPED: time limit'); process.exit(3); }, 15 * 60e3); hardStop.unref?.();
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
  const destPubHex = bytesToHex(prims.wallet.pub), address = prims.wallet.address();
  const txid = String(arg('--txid') || '').trim().toLowerCase();
  const plan = await planMove({ tacit, txid, destPubHex });
  console.log(describePlan(plan, address));
  const token = moveToken(plan);
  if (!process.argv.includes('--send')) { console.log(`\nnothing was sent. To move it: run the same command with  --send --confirm ${token}`); process.exit(0); }
  const sent = await executeMove({ tacit, plan, token: arg('--confirm'), bytesToHex });
  console.log(`\nsent: ${sent}\nIt counts for the reverse side once it has confirmed: run tools/fastbridge-lp-reverse-status.mjs to see it.`);
  process.exit(0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.log(String((e && e.message) || e).slice(0, 300)); process.exit(1); });
