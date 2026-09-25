// Signet dry run of the Secret Sats faucet (worker-relay/src/sats-faucet.js) with real transactions.
//
//   node tests/sats-faucet-signet.mjs [faucet|fund|take|shield|buyshield|relist|all]   (default: all, resumable)
//
// faucet     etch the cBTC stand-in (first run), split lots, list FAUCET_TARGET_LISTINGS sales
// fund       send BUYER_FUND_SATS from the funding wallet to a fresh throwaway buyer key
// take       buyer takes one sale: pays the price, receives a cBTC note (one transaction)
// shield     buyer shields that note into its pool address (T_BTC_SHIELD carrier)
// buyshield  buyer takes a second sale straight into the pool (one carrier: shield in vin[0], lot in vin[1])
// relist     one more faucet pass: detects the takes and lists replacements
//
// The funding wallet (~/.tacit-validation/signet.json) is the faucet key. State, including the buyer's
// throwaway key, is kept in ~/.tacit-validation/sats-faucet-state.json (mode 0600).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadTacitHeadless, setWalletKey, makeFaucet, openStateFile, configFromEnv } from '../worker-relay/src/sats-faucet.js';

const WALLET_FILE = path.join(os.homedir(), '.tacit-validation', 'signet.json');
const STATE_FILE = process.env.STATE_FILE || path.join(os.homedir(), '.tacit-validation', 'sats-faucet-state.json');
const BUYER_FUND_SATS = Number(process.env.BUYER_FUND_SATS || 12_000);

const W = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
if (W.network !== 'signet' || !/^tb1q/.test(W.address)) throw new Error('funding wallet must be a signet P2WPKH');

const loaded = await loadTacitHeadless('signet');
const { tacit, deps } = loaded;
const { bytesToHex, hexToBytes } = deps;
const secret = await import('../dapp/sats/secret.js');

const cfg = configFromEnv({ ...process.env, FAUCET_STATE: STATE_FILE });
const store = openStateFile(STATE_FILE);
const asFaucet = () => setWalletKey(loaded, W.priv_hex);
if (asFaucet() !== String(W.pub_hex).toLowerCase()) throw new Error('funding wallet pub_hex does not match its key');
const faucet = makeFaucet({ ...loaded, cfg, store, logger: (m) => console.log(`  ${m}`) });
const S = faucet.state;
const demo = S.demo || (S.demo = {});
const persist = () => { S.updatedAt = Math.floor(Date.now() / 1000); store.save(S); };
if (!demo.buyerPriv) { demo.buyerPriv = bytesToHex(crypto.getRandomValues(new Uint8Array(32))); persist(); }
const asBuyer = () => setWalletKey(loaded, demo.buyerPriv);
const buyerAddr = () => { asBuyer(); const a = tacit.wallet.address(); asFaucet(); return a; };

const log = (m) => console.log(`  ${m}`);
const link = (txid) => `https://mempool.space/signet/tx/${txid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitVisible(txid) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${tacit.NET.api}/tx/${txid}/status`).catch(() => null);
    if (r?.ok) return;
    await sleep(3000);
  }
  throw new Error(`${txid} not visible`);
}

async function stageFaucet() {
  console.log('\n--- faucet ---');
  asFaucet();
  for (let i = 0; i < 4; i++) {
    if (!(await faucet.tick())) throw new Error(faucet.status().last_error);
    if (faucet.status().open_sales.length >= cfg.target) break;
  }
  const st = faucet.status();
  log(`asset ${st.asset_id}`);
  if (S.etch) log(`etch   ${link(S.etch.revealTxid)}`);
  for (const s of S.splits || []) log(`split  ${link(s.revealTxid)} (${s.k} lots)`);
  for (const s of st.open_sales) log(`sale   ${s.sale_id}  ${s.txid}:${s.vout}`);
  if (st.open_sales.length < cfg.target) throw new Error(`only ${st.open_sales.length} sales listed`);
}

async function stageFund() {
  console.log('\n--- fund ---');
  if (demo.fund) { log(`buyer funded ${link(demo.fund)}`); return; }
  asFaucet();
  const to = tacit.p2wpkhScript(hexToBytes(setWalletKey(loaded, demo.buyerPriv)));
  asFaucet();
  const own = tacit.p2wpkhScript(tacit.wallet.pub);
  const feeRate = await tacit.getFeeRate();
  const sats = tacit.selectSatsUtxosSafe(await tacit.getUtxos(W.address), await tacit.scanHoldings(true)).sort((a, b) => b.value - a.value);
  const picked = []; let total = 0, fee = 0;
  for (const u of sats) {
    picked.push(u); total += u.value;
    fee = tacit.feeFor(11 + 68 * picked.length + 31 * 2, feeRate);
    if (total >= BUYER_FUND_SATS + fee + tacit.DUST) break;
  }
  if (total < BUYER_FUND_SATS + fee + tacit.DUST) throw new Error('funding wallet short of sats');
  const tx = {
    version: 2, locktime: 0,
    inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: [{ value: BUYER_FUND_SATS, script: to }, { value: total - BUYER_FUND_SATS - fee, script: own }],
  };
  picked.forEach((u, i) => { tx.inputs[i].witness = tacit.signP2wpkhInput(tx, i, u.value); });
  await tacit.broadcast(bytesToHex(tacit.serializeTx(tx)));
  demo.fund = tacit.txid(tx); persist();
  log(`buyer ${buyerAddr()} funded ${BUYER_FUND_SATS} sats: ${link(demo.fund)}`);
  await waitVisible(demo.fund);
}

async function stageTake() {
  console.log('\n--- take ---');
  if (demo.take) { log(`take ${link(demo.take.revealTxid)}`); return; }
  asBuyer();
  const r = await secret.claim(tacit, { status: faucet.status(), onProgress: (s) => log(s) });
  demo.take = { commitTxid: r.commitTxid, revealTxid: r.revealTxid, saleId: r.sale.sale_id, lot: `${r.sale.asset_outpoint.txid}:${r.sale.asset_outpoint.vout}`, note: r.note };
  persist();
  asFaucet();
  log(`sale ${r.sale.sale_id}: paid ${r.sale.min_price_sats} sats, received ${r.note.amount} units`);
  log(`commit ${link(r.commitTxid)}`);
  log(`reveal ${link(r.revealTxid)}`);
  const tx = await (await fetch(`${tacit.NET.api}/tx/${r.revealTxid}`)).json();
  if (tx.vout[1].value !== r.sale.min_price_sats || tx.vout[1].scriptpubkey !== r.sale.seller_payout_script) throw new Error('seller payout missing from the take');
  if (tx.vin[1].txid !== r.sale.asset_outpoint.txid || tx.vin[1].vout !== r.sale.asset_outpoint.vout) throw new Error('take does not spend the lot');
  log('one transaction: lot in vin[1], seller payout at vout[1], note at vout[0]');
}

async function stageShield() {
  console.log('\n--- shield ---');
  if (demo.shield) { log(`shield ${link(demo.shield.revealTxid)}`); return; }
  asBuyer();
  await waitVisible(demo.take.revealTxid);
  const pw = secret.poolWalletFor(tacit.wallet.priv, 'signet');
  const r = await secret.shieldNote(tacit, { note: demo.take.note, poolWallet: pw });
  const got = secret.pool.scan(pw, [r.poolNote]);
  if (got.length !== 1 || String(got[0].value) !== demo.take.note.amount) throw new Error('buyer does not receive the shield note');
  demo.shield = { commitTxid: r.commitTxid, revealTxid: r.revealTxid, poolAddress: pw.addressString, leaf: r.poolNote.leaf };
  persist();
  asFaucet();
  log(`pool address ${pw.addressString}`);
  log(`commit ${link(r.commitTxid)}`);
  log(`reveal ${link(r.revealTxid)}  leaf ${r.poolNote.leaf}`);
}

async function stageBuyShield() {
  console.log('\n--- buyshield ---');
  if (demo.buyshield) { log(`buy-and-shield ${link(demo.buyshield.revealTxid)}`); return; }
  asBuyer();
  const pw = secret.poolWalletFor(tacit.wallet.priv, 'signet');
  const r = await secret.buyAndShield(tacit, { status: faucet.status(), poolWallet: pw });
  const got = secret.pool.scan(pw, [r.poolNote]);
  if (got.length !== 1 || String(got[0].value) !== r.sale.asset_opening.amount) throw new Error('buyer does not receive the bought note');
  demo.buyshield = { commitTxid: r.commitTxid, revealTxid: r.revealTxid, saleId: r.sale.sale_id, leaf: r.poolNote.leaf };
  persist();
  asFaucet();
  log(`sale ${r.sale.sale_id}: paid ${r.sale.min_price_sats} sats, shielded ${r.sale.asset_opening.amount} units`);
  log(`commit ${link(r.commitTxid)}`);
  log(`reveal ${link(r.revealTxid)}  leaf ${r.poolNote.leaf}`);
}

async function stageRelist() {
  console.log('\n--- relist ---');
  asFaucet();
  if (!(await faucet.tick())) throw new Error(faucet.status().last_error);
  const st = faucet.status();
  log(`${st.open_sales.length} open, ${st.buffered_lots} buffered, ${st.taken_total} taken, reserve ${st.reserve}`);
  for (const t of st.recent_takes) log(`taken ${t.lot} in ${t.txid}`);
}

const STAGES = { faucet: stageFaucet, fund: stageFund, take: stageTake, shield: stageShield, buyshield: stageBuyShield, relist: stageRelist };
const want = process.argv[2] || 'all';
console.log(`=== sats faucet signet (${want}) ===`);
console.log(`  faucet ${W.address}`);
console.log(`  state  ${STATE_FILE}`);
if (want === 'all') { for (const s of Object.keys(STAGES)) await STAGES[s](); }
else { if (!STAGES[want]) throw new Error(`unknown stage ${want}`); await STAGES[want](); }
process.exit(0);
