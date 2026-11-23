#!/usr/bin/env node
// Funds the reverse side of the house fast bridge provider with a little TAC on Bitcoin: one transfer from one named TAC note of the provider's main address to the reverse
// key (the dedicated address the reverse side sells from), paying its miner fee from one named plain coin. Nothing else at the main address can be touched: the wallet is
// handed a view of the address that holds ONLY the outpoints named here (the full list is refused by every explorer, and holds the Bitcoin-book maker's notes and coins).
// The destination is the reverse key itself, derived from FB_LP_KEY, never typed in.
//
//   tools/lp-run.sh fund --tac 3 --note <txid:vout> [--note …] --coin <txid:vout> [--mode silent|plain]       says what it would send, sends nothing
//   tools/lp-run.sh fund … --send --confirm <the token the line above printed>                                sends it
//
//   --note   TAC notes that may be spent (note-sized outputs of the main address): the smallest that covers the amount is used, the rest is returned as change
//   --coin   the plain coin that pays the fee: 3,000 to 20,000 sats (the leftover take-fee coins: not the 2,046 of a swap under way, not the maker's larger coins)
//   --mode   silent (default): to the reverse tcs1 address, a silent send (it then needs `lp-run.sh normalize --txid <id>`); plain: to the reverse key, ready as it arrives
//
// Node 22; from the repository root.

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const ONE = 10n ** 8n, MAX_TAC = 25n * ONE, DUST = 546;
export const COIN_MIN = 3000, COIN_MAX = 20000;
export const tacText = (v) => { const n = BigInt(v), f = (n % ONE).toString().padStart(8, '0').replace(/0+$/, ''); return `${(n / ONE).toString()}${f ? '.' + f : ''}`; };
export const parseTac = (t) => {
  const m = /^(\d{1,3})(?:\.(\d{1,8}))?$/.exec(String(t ?? ''));
  if (!m) throw new Error('--tac must be a decimal amount of TAC, such as 3 or 2.5');
  const n = BigInt(m[1]) * ONE + BigInt((m[2] || '').padEnd(8, '0'));
  if (n <= 0n) throw new Error('--tac must be more than 0');
  if (n > MAX_TAC) throw new Error(`--tac is held to ${tacText(MAX_TAC)} TAC: this is for a small funding, not a move of stock`);
  return n;
};
export const parseOutpoint = (s, what) => {
  const m = /^([0-9a-f]{64}):(\d{1,5})$/.exec(String(s ?? '').trim().toLowerCase());
  if (!m) throw new Error(`${what} must be <64-hex txid>:<output number>`);
  return { txid: m[1], vout: Number(m[2]) };
};

// The named outputs as the explorer's utxo list shows them, after checking each is the main address's, unspent, and the right kind: a note-sized output for a note, a
// plain coin in the fee-coin range for the coin. `getJson(path)` reads the explorer.
export async function exposeOutpoints({ getJson, address, notes, coin }) {
  const one = async (o, kind) => {
    const tx = await getJson(`/tx/${o.txid}`);
    const out = tx && tx.vout && tx.vout[o.vout];
    if (!out) throw new Error(`${kind} ${o.txid.slice(0, 12)}…:${o.vout} is not an output of that transaction`);
    if (out.scriptpubkey_address !== address) throw new Error(`${kind} ${o.txid.slice(0, 12)}…:${o.vout} is not at the main address`);
    const spent = await getJson(`/tx/${o.txid}/outspend/${o.vout}`);
    if (!spent || spent.spent !== false) throw new Error(`${kind} ${o.txid.slice(0, 12)}…:${o.vout} is ${spent && spent.spent ? 'already spent' : 'not known to be unspent'}`);
    if (!tx.status || !tx.status.confirmed) throw new Error(`${kind} ${o.txid.slice(0, 12)}…:${o.vout} has not confirmed yet`);
    return { txid: o.txid, vout: o.vout, value: out.value, status: { confirmed: true, block_height: tx.status.block_height, block_hash: tx.status.block_hash, block_time: tx.status.block_time } };
  };
  if (!notes.length) throw new Error('name at least one TAC note with --note');
  const noteUtxos = [];
  for (const n of notes) { const u = await one(n, 'note'); if (u.value > DUST) throw new Error(`note ${u.txid.slice(0, 12)}…:${u.vout} is ${u.value} sats: a TAC note is note-sized (${DUST})`); noteUtxos.push(u); }
  const c = await one(coin, 'coin');
  if (c.value < COIN_MIN || c.value > COIN_MAX) throw new Error(`the coin is ${c.value} sats: the fee coin must be ${COIN_MIN} to ${COIN_MAX} (a leftover take-fee coin, not one of a swap under way and not one of the maker's)`);
  if (notes.some((n) => n.txid === coin.txid && n.vout === coin.vout)) throw new Error('the coin is also named as a note');
  return { utxos: [...noteUtxos, c], coin: c };
}

// A fetch that answers the main address's utxo list with exactly `utxos` and passes everything else through
export function viewFetch(realFetch, address, utxos) {
  const re = new RegExp(`/address/${address}/utxo(\\?.*)?$`);
  return async (input, init) => {
    const url = String((input && input.url) || input);
    if (re.test(url)) return new Response(JSON.stringify(utxos), { status: 200, headers: { 'content-type': 'application/json' } });
    return realFetch(input, init);
  };
}

// Which note, from the notes the wallet found among those exposed: the smallest that covers the amount
export async function planFund({ tacit, amount, exposed, destination, mode, houseAddress, scanTries = 8, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  let holdings = null, last = null;
  for (let i = 0; i < scanTries && !holdings; i++) {
    try { if (typeof tacit.invalidateHoldingsCache === 'function') tacit.invalidateHoldingsCache(); holdings = await tacit.scanHoldings(true); }
    catch (e) { last = e; log(`the scan has not finished (${String((e && e.message) || e).slice(0, 90)}): asking again`); await sleep(20000); }
  }
  if (!holdings) throw new Error(`the notes could not be read: ${String((last && last.message) || last).slice(0, 160)}`);
  const entry = holdings instanceof Map ? holdings.get(TAC) : null;
  const noteKeys = new Set(exposed.utxos.filter((u) => u.value <= DUST).map((u) => `${u.txid}:${u.vout}`));
  const found = ((entry && entry.utxos) || []).filter((x) => x.utxo && noteKeys.has(`${x.utxo.txid}:${x.utxo.vout}`) && !x.stealthTweakedSk && BigInt(x.amount) > 0n);
  if (!found.length) throw new Error('none of the named outputs is a TAC note the wallet can open and counts as valid (are they the take outputs that hold TAC, not their zero padding?)');
  const covering = found.filter((x) => BigInt(x.amount) >= amount).sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0));
  if (!covering.length) throw new Error(`none of the named notes holds ${tacText(amount)} TAC (the largest holds ${tacText(found.reduce((m, x) => (BigInt(x.amount) > m ? BigInt(x.amount) : m), 0n))})`);
  const pick = covering[0];
  return { amount: amount.toString(), mode, destination, houseAddress, note: { txid: pick.utxo.txid, vout: pick.utxo.vout, amount: BigInt(pick.amount).toString() }, change: (BigInt(pick.amount) - amount).toString(), coin: { txid: exposed.coin.txid, vout: exposed.coin.vout, value: exposed.coin.value }, entry: pick };
}

// What the confirm token covers: the note spent, what is sent, to where, how, and the coin that pays the fee
export const fundToken = (plan) => createHash('sha256').update(JSON.stringify({ n: [plan.note.txid, plan.note.vout, plan.note.amount], a: plan.amount, d: plan.destination, m: plan.mode, c: [plan.coin.txid, plan.coin.vout], h: plan.houseAddress })).digest('hex').slice(0, 10);

export async function executeFund({ tacit, plan, token, ownPubHex, expectPubHex }) {
  if (token !== fundToken(plan)) throw new Error('the confirm token is not the one for this plan: run it without --send and use the token it prints');
  if (ownPubHex !== expectPubHex) throw new Error('the open wallet is not the provider key: nothing was sent');
  const recipients = [plan.mode === 'plain' ? { pubHex: plan.destination, amount: BigInt(plan.amount) } : { stealthAddress: plan.destination, amount: BigInt(plan.amount) }];
  const r = await tacit.buildAndBroadcastCXferMulti({ assetIdHex: TAC, recipients, forceUtxos: [plan.entry] });
  return r.revealTxid || r.txid || null;
}

export function describeFund(plan) {
  return [`spend the note ${plan.note.txid.slice(0, 12)}…:${plan.note.vout} (${tacText(plan.note.amount)} TAC) at the main address`,
    `send ${tacText(plan.amount)} TAC ${plan.mode === 'plain' ? 'to the reverse key (a plain note at the reverse address)' : 'silently, to the reverse tcs1 address (it lands at a one-time address of the reverse key)'}`,
    `return ${tacText(plan.change)} TAC to the main address as change`,
    `pay the miner fee from the coin ${plan.coin.txid.slice(0, 12)}…:${plan.coin.vout} (${plan.coin.value} sats; its change comes back to the main address)`].join('\n');
}

async function main() {
  const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const all = (n) => process.argv.reduce((a, x, i) => (x === n && process.argv[i + 1] ? [...a, process.argv[i + 1]] : a), []);
  const arg = (n) => all(n)[0] ?? null;
  const keyHex = String(process.env.FB_LP_KEY || '').trim().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.log('no key in the environment (FB_LP_KEY, 64 hex characters)'); process.exit(1); }
  delete process.env.FB_LP_KEY;
  const hardStop = setTimeout(() => { console.log('STOPPED: time limit'); process.exit(3); }, 25 * 60e3); hardStop.unref?.();
  const amount = parseTac(arg('--tac'));
  const mode = arg('--mode') || 'silent';
  if (mode !== 'silent' && mode !== 'plain') throw new Error('--mode is silent or plain');
  const notes = all('--note').map((s) => parseOutpoint(s, '--note')), coin = parseOutpoint(arg('--coin'), '--coin');
  const { loadTacit } = await import(REPO + '/worker-relay/src/lib/btc-pool-transparent.js');
  const { secp, sha256, hmac, bytesToHex } = await import(REPO + '/dapp/vendor/tacit-deps.min.js');
  secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
  const { setActiveNetwork } = await import(REPO + '/dapp/confidential-deployments.js');
  const { makeBtcWallet } = await import(REPO + '/dapp/bitcoin-taproot-wallet.js');
  const { reverseKeyOf } = await import(REPO + '/fastbridge-lp/lib/reverse.mjs');
  setActiveNetwork('mainnet');
  const key = Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16)));
  const wallet = (priv) => makeBtcWallet({ priv, hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 }).prims;
  const house = wallet(key), rev = wallet(reverseKeyOf(key));
  const houseAddress = house.wallet.address();
  if (houseAddress === rev.wallet.address()) throw new Error('the reverse address is the main address: refusing');
  const realFetch = globalThis.fetch;
  const BASES = ['https://mempool.space/api', 'https://blockstream.info/api'];
  const getJson = async (p) => { for (const b of BASES) { try { const r = await realFetch(b + p, { signal: AbortSignal.timeout(30000) }); if (r.ok) return await r.json(); } catch { /* the next explorer */ } } return null; };
  const exposed = await exposeOutpoints({ getJson, address: houseAddress, notes, coin });
  console.log(`main address ${houseAddress}: exposing ${exposed.utxos.length - 1} note-sized output${exposed.utxos.length - 1 === 1 ? '' : 's'} and one ${exposed.coin.value}-sat coin to the wallet, nothing else`);
  const tacit = await loadTacit('mainnet', { livePool: true });
  delete globalThis.location;
  tacit.wallet.priv = key; tacit.wallet.pub = house.wallet.pub;
  globalThis.fetch = viewFetch(globalThis.fetch, houseAddress, exposed.utxos);
  const destination = mode === 'plain' ? bytesToHex(rev.wallet.pub) : tacit.encodeStealthAddress({ network: 'mainnet', recipientPub: rev.wallet.pub });
  const plan = await planFund({ tacit, amount, exposed, destination, mode, houseAddress, log: (m) => console.log('  ..', m) });
  console.log(describeFund(plan));
  const token = fundToken(plan);
  if (!process.argv.includes('--send')) { console.log(`\nnothing was sent. To send it: the same command with  --send --confirm ${token}`); process.exit(0); }
  const sent = await executeFund({ tacit, plan, token: arg('--confirm'), ownPubHex: bytesToHex(tacit.wallet.pub), expectPubHex: bytesToHex(house.wallet.pub) });
  console.log(`\nsent: ${sent}\n${mode === 'silent' ? 'Once it has confirmed, run: tools/lp-run.sh normalize --txid ' + sent : 'It counts for the reverse side once it has confirmed: tools/lp-run.sh status shows it.'}`);
  process.exit(0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.log(String((e && e.message) || e).slice(0, 400)); process.exit(1); });
