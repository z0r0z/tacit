#!/usr/bin/env node
// Speeds up a transfer of the reverse key's own that is stuck unconfirmed at a rate the blocks have moved past (the move that puts silently sent TAC on the plain address
// is one: a wallet transfer cannot be re-run while its notes are "settling"). It does not touch the TAC: it makes a second transaction that spends the transfer's
// sats-change output (its output 1, never the output that holds the notes) and one confirmed plain-sat coin of the reverse address, and pays a fee large enough that the two
// together are worth a miner's while (a child pays for its parent). It refuses unless the wallet itself sees the notes at output 0 and nothing at output 1.
//
//   FB_LP_KEY=$(security find-generic-password -s tacit-fastbridge-lp -w) node tools/fastbridge-lp-reverse-bump.mjs --txid <the stuck transfer> [--rate 2]
//       says what it would do and sends nothing
//   … --txid <id> [--rate 2] --send --confirm <the token the line above printed>      sends it
//
// Costs about a thousand sats of fee, taken from the coin. Node 22; from the repository root.

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
export const CHILD_VB = 180;          // two P2WPKH inputs, one P2WPKH output: 177.5 vB, rounded up
export const MAX_RATE = 10, MIN_RATE = 1, MAX_FEE = 5000;

// The fee of the child so that parent + child together pay `rate` sat/vB, and never less than the child's own 1 sat/vB.
export const childFee = ({ parentFee, parentVsize, rate, childVb = CHILD_VB }) => Math.max(Math.ceil(rate * (parentVsize + childVb)) - parentFee, childVb);

const holdOf = (holdings, asset) => { const e = holdings instanceof Map ? holdings.get(asset) : null; return (e && e.utxos) || []; };

// What would be sent, read from the chain and from what the wallet finds for this key. Throws, in words, when anything is not as it must be.
export async function planBump({ tacit, parentTxid, address, fetchJson, rate = 2, asset = TAC }) {
  if (!/^[0-9a-f]{64}$/.test(String(parentTxid))) throw new Error('--txid must be the 64-hex id of the stuck transaction');
  if (!(rate >= MIN_RATE && rate <= MAX_RATE)) throw new Error(`--rate must be between ${MIN_RATE} and ${MAX_RATE} sat/vB`);
  const parent = await fetchJson(`/tx/${parentTxid}`).catch(() => null);
  if (!parent || !Array.isArray(parent.vout) || !Number.isFinite(parent.fee) || !Number.isFinite(parent.weight)) throw new Error('that transaction could not be read from the explorer');
  if (parent.status && parent.status.confirmed) throw new Error('that transaction has already confirmed: there is nothing to speed up');
  const out = parent.vout[1];
  if (!out || out.scriptpubkey_address !== address) throw new Error('output 1 of that transaction does not pay the reverse address: this tool only spends the sats change a transfer of the reverse key leaves there');
  if (!(out.value >= tacit.DUST)) throw new Error('output 1 of that transaction is below the dust size: nothing to spend');
  const os = await fetchJson(`/tx/${parentTxid}/outspend/1`).catch(() => null);
  if (!os || os.spent !== false) throw new Error('output 1 of that transaction is already spent, or its state could not be read');
  const holdings = await tacit.scanHoldings(true);
  const mine = holdOf(holdings, asset).filter((x) => x.utxo && x.utxo.txid === parentTxid);
  if (!mine.some((x) => x.utxo.vout === 0 && BigInt(x.amount) > 0n)) throw new Error('the wallet does not see TAC at output 0 of that transaction: it is not the move this tool is for, so nothing was planned');
  if (mine.some((x) => x.utxo.vout !== 0)) throw new Error('the wallet sees TAC at an output of that transaction other than output 0: nothing was planned');
  const parentVsize = Math.ceil(parent.weight / 4);
  const fee = childFee({ parentFee: parent.fee, parentVsize, rate });
  if (fee > MAX_FEE) throw new Error(`the fee for that rate would be ${fee} sats, above the ${MAX_FEE} this tool allows`);
  let coins = [];
  try { coins = tacit.selectSatsUtxosSafe(await tacit.getUtxos(address), holdings).filter((u) => u.value > tacit.DUST && u.status && u.status.confirmed && u.txid !== parentTxid); } catch { /* said below */ }
  const need = fee - out.value + tacit.DUST;
  const coin = coins.filter((u) => u.value >= need).sort((a, b) => a.value - b.value)[0];
  if (!coin) throw new Error(`no confirmed plain-sat coin at the reverse address is large enough: it needs ${Math.max(need, tacit.DUST + 1)} sats or more for the fee`);
  const change = coin.value + out.value - fee;
  return { parentTxid, parentFee: parent.fee, parentVsize, rate, fee, childVb: CHILD_VB, spend: { txid: parentTxid, vout: 1, value: out.value, spk: out.scriptpubkey }, coin: { txid: coin.txid, vout: coin.vout, value: coin.value }, change, packageRate: (parent.fee + fee) / (parentVsize + CHILD_VB) };
}

// What the confirm token covers: what is spent, the fee and the change. A plan that differs in any of them has another token.
export const bumpToken = (plan) => createHash('sha256').update(JSON.stringify({ p: plan.parentTxid, s: [plan.spend.txid, plan.spend.vout, plan.spend.value], c: [plan.coin.txid, plan.coin.vout, plan.coin.value], f: plan.fee, o: plan.change })).digest('hex').slice(0, 10);

export function describePlan(plan, address) {
  return [`stuck: ${plan.parentTxid.slice(0, 12)}…  paying ${plan.parentFee} sats for ${plan.parentVsize} vB (${(plan.parentFee / plan.parentVsize).toFixed(2)} sat/vB); it holds the TAC note at output 0, which is not touched`,
    `would spend its output 1 (${plan.spend.value} sats, the sats change) and the coin ${plan.coin.txid.slice(0, 8)}…:${plan.coin.vout} (${plan.coin.value} sats), both the reverse address's`,
    `to ${address} (back to itself): ${plan.change} sats, so the fee is ${plan.fee} sats for about ${plan.childVb} vB`,
    `together the two pay ${plan.packageRate.toFixed(2)} sat/vB (asked for ${plan.rate})`].join('\n');
}

export async function executeBump({ tacit, plan, token, bytesToHex }) {
  if (token !== bumpToken(plan)) throw new Error('the confirm token is not the one for this plan: run it without --send and use the token it prints');
  const script = tacit.p2wpkhScript(tacit.wallet.pub);
  if (bytesToHex(script) !== plan.spend.spk) throw new Error('the open wallet is not the key that owns that output: nothing was sent');
  const tx = { version: 2, locktime: 0, inputs: [{ txid: plan.spend.txid, vout: plan.spend.vout, sequence: 0xfffffffd, witness: [] }, { txid: plan.coin.txid, vout: plan.coin.vout, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: plan.change, script }] };
  const values = [plan.spend.value, plan.coin.value];
  if (plan.change < tacit.DUST || plan.spend.value + plan.coin.value - plan.change !== plan.fee) throw new Error('the plan does not add up: nothing was sent');
  tx.inputs.forEach((_, i) => { tx.inputs[i].witness = tacit.signP2wpkhInputWithKey(tx, i, values[i], tacit.wallet.priv, tacit.wallet.pub); });
  await tacit.broadcastWithRetry(bytesToHex(tacit.serializeTx(tx)));
  return tacit.txid(tx);
}

async function main() {
  const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const keyHex = String(process.env.FB_LP_KEY || '').trim().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.log('no key in the environment (FB_LP_KEY, 64 hex characters)'); process.exit(1); }
  delete process.env.FB_LP_KEY;
  const hardStop = setTimeout(() => { console.log('STOPPED: time limit'); process.exit(3); }, 10 * 60e3); hardStop.unref?.();
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
  const fetchJson = async (path) => {
    for (const base of ['https://mempool.space/api', 'https://blockstream.info/api']) {
      try { const r = await fetch(base + path, { signal: AbortSignal.timeout(20e3) }); if (r.ok) return await r.json(); } catch { /* next */ }
    }
    throw new Error('no explorer answered ' + path);
  };
  const parentTxid = String(arg('--txid') || '').trim().toLowerCase();
  const rate = arg('--rate') == null ? 2 : Number(arg('--rate'));
  const plan = await planBump({ tacit, parentTxid, address, fetchJson, rate });
  console.log(describePlan(plan, address));
  const token = bumpToken(plan);
  if (!process.argv.includes('--send')) { console.log(`\nnothing was sent. To send it: run the same command with  --send --confirm ${token}`); process.exit(0); }
  const sent = await executeBump({ tacit, plan, token: arg('--confirm'), bytesToHex });
  console.log(`\nsent: ${sent}\nWhen the stuck transfer confirms, run tools/lp-run.sh status to see the TAC at the reverse address.`);
  process.exit(0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.log(String((e && e.message) || e).slice(0, 300)); process.exit(1); });
