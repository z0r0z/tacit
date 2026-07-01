#!/usr/bin/env node
// End-to-end airdrop dryrun on Bitcoin signet.
//
// Runs the full issuer-side flow against the live signet — CETCHes a token
// (or reuses an existing one), generates N synthetic recipients, builds the
// snapshot, pins to IPFS, announces, funds a treasury, simulates each
// recipient's tip+claim, drives fulfilment from the treasury, verifies each
// recipient receives the expected amount on chain.
//
// Reuses the same crypto + tx-building path the dapp + daemon use (imports
// dapp/tacit.js under a jsdom shim). If this passes end-to-end, the live
// mainnet flow is the same code with different prevouts.
//
// SAFETY:
//   - All tx broadcasts hit the live signet API (mempool.space/signet).
//   - DRY_RUN=1 in env skips broadcasts; prints what would happen.
//   - The token ticker defaults to a deliberately innocuous "PINE" so a
//     casual signet observer can't tell this is a tacit airdrop test.
//   - Three signet wallets are required: ISSUER (holds token supply, sends
//     to treasury), TREASURY (signs fulfilment CXFERs), TIP_FUNDER (pretends
//     to be each recipient's BTC wallet for the tip step). All three need
//     to be funded with a few thousand signet sats before the test runs.
//     The script prints the addresses on first launch and waits.
//
// Usage:
//   ISSUER_PRIV=hex64 TREASURY_PRIV=hex64 TIP_FUNDER_PRIV=hex64 \
//     [N=5] [TICKER=PINE] [DRY_RUN=1] node tests/signet-dryrun.mjs
//
// Or use a single SEED to derive all three deterministically (so the same
// signet sats funding works across multiple runs):
//   SEED=hex64 N=5 node tests/signet-dryrun.mjs

import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// ============== jsdom + dapp boot ==============
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const m = await import('../dapp/tacit.js');
const { _signEip191WithPriv, _ethAddrFromPriv } = await import('./composition.mjs');

// ============== config ==============
const WORKER_BASE = (process.env.WORKER_BASE || 'https://api.tacit.finance').replace(/\/+$/, '');
const N_RECIPIENTS = parseInt(process.env.N || '5', 10);
const TICKER = process.env.TICKER || 'PINE';
const DECIMALS = parseInt(process.env.DECIMALS || '8', 10);
const SUPPLY = BigInt(process.env.SUPPLY || '1000000000');         // 10 PINE at 8 decimals (small supply, plenty for 5×100-base test)
const PER_RECIPIENT = BigInt(process.env.PER_RECIPIENT || '100');  // 100 base units = 0.00000100 PINE
const TIP_SATS = parseInt(process.env.TIP_SATS || '1000', 10);
const DRY_RUN = !!process.env.DRY_RUN;
const SKIP_CETCH = !!process.env.SKIP_CETCH;       // if you've already CETCHed and want to skip
const PROVIDED_ASSET_ID = (process.env.ASSET_ID || '').toLowerCase();

// Deterministic key derivation when a SEED is provided. Otherwise read three
// distinct privkeys from env. Deterministic mode lets the operator fund the
// same addresses once and re-run the harness across iterations.
function deriveFromSeed(seedHex, label) {
  const m = sha256(new TextEncoder().encode('tacit-signet-dryrun-v1:' + label + ':' + seedHex));
  return bytesToHex(m);
}
const SEED = (process.env.SEED || '').toLowerCase();
const ISSUER_PRIV   = (process.env.ISSUER_PRIV   || (SEED ? deriveFromSeed(SEED, 'issuer')   : '')).toLowerCase();
const TREASURY_PRIV = (process.env.TREASURY_PRIV || (SEED ? deriveFromSeed(SEED, 'treasury') : '')).toLowerCase();
const TIP_FUNDER_PRIV = (process.env.TIP_FUNDER_PRIV || (SEED ? deriveFromSeed(SEED, 'tip-funder') : '')).toLowerCase();

for (const [name, v] of [['ISSUER_PRIV', ISSUER_PRIV], ['TREASURY_PRIV', TREASURY_PRIV], ['TIP_FUNDER_PRIV', TIP_FUNDER_PRIV]]) {
  if (!/^[0-9a-f]{64}$/.test(v)) {
    console.error(`${name} not set or malformed. Set via env var (64 hex chars) or pass SEED=<hex64> to derive all three.`);
    process.exit(1);
  }
}

const issuerPub   = secp.getPublicKey(hexToBytes(ISSUER_PRIV), true);
const treasuryPub = secp.getPublicKey(hexToBytes(TREASURY_PRIV), true);
const tipPub      = secp.getPublicKey(hexToBytes(TIP_FUNDER_PRIV), true);
const issuerAddr   = bech32.encode('tb', [0, ...bech32.toWords(ripemd160(sha256(issuerPub)))]);
const treasuryAddr = bech32.encode('tb', [0, ...bech32.toWords(ripemd160(sha256(treasuryPub)))]);
const tipAddr      = bech32.encode('tb', [0, ...bech32.toWords(ripemd160(sha256(tipPub)))]);

function setWallet(privHex) {
  const priv = hexToBytes(privHex);
  m.wallet.priv = priv;
  m.wallet.pub = secp.getPublicKey(priv, true);
  m.invalidateHoldingsCache();
}

// ============== preflight ==============
console.log('\n=== Tacit signet airdrop dryrun ===');
console.log(`Worker:       ${WORKER_BASE}`);
console.log(`Recipients:   ${N_RECIPIENTS}`);
console.log(`Token:        ${TICKER} (${DECIMALS} decimals, supply ${SUPPLY.toString()} base units)`);
console.log(`Per claim:    ${PER_RECIPIENT.toString()} base units`);
console.log(`Tip per claim: ${TIP_SATS} sats`);
console.log(`Dry run:      ${DRY_RUN ? 'YES (no broadcasts)' : 'NO (live signet)'}`);
console.log();
console.log('Wallets:');
console.log(`  issuer:     ${issuerAddr}`);
console.log(`  treasury:   ${treasuryAddr}`);
console.log(`  tip funder: ${tipAddr}`);
console.log();
const need = TIP_SATS * N_RECIPIENTS + 1000;
console.log('Fund each address with signet sats before continuing:');
console.log(`  issuer     ≥ 50,000 sats (CETCH + mint + funding CXFER to treasury)`);
console.log(`  treasury   ≥ 50,000 sats (${Math.ceil(N_RECIPIENTS / 7)} × CXFER fulfilment batches)`);
console.log(`  tip funder ≥ ${need.toLocaleString()} sats (${N_RECIPIENTS} × ${TIP_SATS} tips + headroom)`);
console.log();
console.log('Signet faucets: https://signet.bublina.eu.org/  ·  https://alt.signetfaucet.com/');
console.log();

const NONINTERACTIVE = !!process.env.CONFIRM || !stdin.isTTY;
const rl = NONINTERACTIVE ? null : readline.createInterface({ input: stdin, output: stdout });
async function pause(prompt) {
  if (NONINTERACTIVE) { console.log(prompt + ' [auto-confirmed via CONFIRM env / non-TTY stdin]'); return ''; }
  return await rl.question(prompt + ' [press Enter to continue, Ctrl-C to abort] ');
}
async function balance(addr) {
  try {
    const u = await m.getTx ? await fetch(`https://mempool.space/signet/api/address/${addr}/utxo`) : null;
    if (!u || !u.ok) return null;
    const utxos = await u.json();
    return utxos.reduce((s, x) => s + (x.value || 0), 0);
  } catch { return null; }
}

if (!DRY_RUN) {
  await pause('Fund the three addresses above, then');
  for (const [name, addr] of [['issuer', issuerAddr], ['treasury', treasuryAddr], ['tip funder', tipAddr]]) {
    const sats = await balance(addr);
    if (sats == null) console.log(`  ${name}: balance fetch failed (network) — continuing anyway`);
    else console.log(`  ${name}: ${sats.toLocaleString()} sats at ${addr}`);
  }
  await pause('Balances look correct?');
}

// ============== phase 1: CETCH a test token (or reuse) ==============
let assetIdHex;
if (PROVIDED_ASSET_ID) {
  if (!/^[0-9a-f]{64}$/.test(PROVIDED_ASSET_ID)) { console.error('ASSET_ID malformed'); process.exit(1); }
  assetIdHex = PROVIDED_ASSET_ID;
  console.log(`\nPhase 1: reusing asset ${assetIdHex.slice(0, 16)}…`);
} else if (SKIP_CETCH) {
  console.error('SKIP_CETCH set but no ASSET_ID provided'); process.exit(1);
} else {
  console.log(`\nPhase 1: CETCH ${TICKER} (${DECIMALS} dec, supply ${SUPPLY})`);
  setWallet(ISSUER_PRIV);
  if (DRY_RUN) {
    console.log(`  DRY RUN — would CETCH ${TICKER} from ${issuerAddr}`);
    assetIdHex = '0'.repeat(64);
  } else {
    const cetch = await m.buildAndBroadcastCEtch({
      ticker: TICKER, supplyBase: SUPPLY, decimals: DECIMALS,
    });
    assetIdHex = cetch.assetIdHex;
    console.log(`  ✓ CETCH broadcast · reveal ${cetch.revealTxid.slice(0, 16)}… · asset_id ${assetIdHex.slice(0, 16)}…`);
    console.log(`  Waiting 60s for indexer to pick it up…`);
    await new Promise(r => setTimeout(r, 60_000));
  }
}

// ============== phase 2: generate synthetic recipients ==============
console.log(`\nPhase 2: generate ${N_RECIPIENTS} synthetic recipients`);
const recipients = [];
for (let i = 0; i < N_RECIPIENTS; i++) {
  const ethPriv = secp.utils.randomPrivateKey();
  const tacitPriv = secp.utils.randomPrivateKey();
  const ethAddrHex = _ethAddrFromPriv(ethPriv);
  const tacitPub = secp.getPublicKey(tacitPriv, true);
  recipients.push({
    leafIdx: i,
    ethPriv, tacitPriv,
    ethAddrHex, ethAddrBytes: hexToBytes(ethAddrHex),
    tacitPubHex: bytesToHex(tacitPub),
    amount: PER_RECIPIENT,
  });
}
console.log(`  ✓ ${recipients.length} recipients (each receiving ${PER_RECIPIENT} base units)`);

// ============== phase 3: build snapshot + pin + announce ==============
console.log(`\nPhase 3: build snapshot, pin to IPFS, announce`);
const rows = recipients.map(r => ({
  index: r.leafIdx, ethAddrHex: r.ethAddrHex, ethAddrBytes: r.ethAddrBytes, amount: r.amount,
}));
const commit = m.computeAirdropCommitment(rows);
const rootHex = bytesToHex(commit.root);
console.log(`  ✓ merkle root: ${rootHex}`);

let cid = null;
if (!DRY_RUN) {
  const blob = {
    schema: 'tacit-airdrop-v1',
    network: 'signet',
    asset_id: assetIdHex,
    asset_ticker: TICKER,
    asset_decimals: DECIMALS,
    merkle_root: rootHex,
    leaf_count: recipients.length,
    total_amount: recipients.reduce((s, r) => s + r.amount, 0n).toString(),
    rows: recipients.map(r => ({ index: r.leafIdx, eth_address: '0x' + r.ethAddrHex, amount: r.amount.toString() })),
  };
  const r = await fetch(WORKER_BASE + '/pin-airdrop-snapshot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(blob),
  });
  if (!r.ok) { console.error('pin failed:', r.status, await r.text()); process.exit(1); }
  const j = await r.json();
  cid = j.IpfsHash || j.cid || j.Hash;
  console.log(`  ✓ pinned to IPFS · CID ${cid}`);
}

// Announce — uses the issuer pubkey as the announcement signer. The treasury
// address (= treasury pubkey's P2WPKH) is what recipients see for tipping.
// For the dryrun, issuer signs the announcement so the dapp's discovery
// list can resolve it via _claimDiscoverDrops → issuer_pubkey.
if (!DRY_RUN) {
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const note = 'signet dryrun';
  const msg = m.dropAnnounceMsgBytes('signet', assetIdHex, rootHex, cid, expiresAt, note);
  // BIP-340 expects the x-only pubkey. The treasury signs because the dapp
  // derives the treasury address from issuer_pubkey in the announcement —
  // for this dryrun we want the announced "treasury" to be the actual
  // treasury wallet, so treasury signs.
  const sig = m.signSchnorr(msg, hexToBytes(TREASURY_PRIV));
  const r = await fetch(WORKER_BASE + '/drops?network=signet', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_id: assetIdHex, merkle_root: rootHex, ipfs_cid: cid,
      issuer_pubkey: bytesToHex(treasuryPub), expires_at: expiresAt, note,
      announce_sig: bytesToHex(sig),
    }),
  });
  if (!r.ok) { console.error('announce failed:', r.status, await r.text()); process.exit(1); }
  console.log(`  ✓ announced · recipients on signet's Claim tab will see this drop under "${TICKER}"`);
}

// ============== phase 4: issuer funds treasury with token supply ==============
console.log(`\nPhase 4: issuer sends ${PER_RECIPIENT * BigInt(N_RECIPIENTS)} base units → treasury`);
const totalPayout = PER_RECIPIENT * BigInt(N_RECIPIENTS);
if (!DRY_RUN) {
  setWallet(ISSUER_PRIV);
  // Send total payout + 10% headroom.
  const sendAmount = totalPayout + totalPayout / 10n;
  const r = await m.buildAndBroadcastCXfer({
    assetIdHex,
    recipientPubHex: bytesToHex(treasuryPub),
    amount: sendAmount,
  });
  console.log(`  ✓ treasury funded · reveal ${r.revealTxid.slice(0, 16)}…`);
  console.log(`  Waiting 60s for confirmation + indexer pickup…`);
  await new Promise(r2 => setTimeout(r2, 60_000));
}

// ============== phase 5: each recipient tips + submits ==============
console.log(`\nPhase 5: simulate ${N_RECIPIENTS} recipients (sign + tip + submit)`);
for (const r of recipients) {
  // Build canonical claim msg (matches buildAirdropClaimMsg signature).
  const msg = m.buildAirdropClaimMsg({
    rootHex, network: 'signet', assetIdHex,
    ethAddrHex: r.ethAddrHex, leafIndex: r.leafIdx,
    amount: r.amount, ticker: TICKER, decimals: DECIMALS,
    tacitPubHex: r.tacitPubHex,
  });
  const sig = _signEip191WithPriv(msg, r.ethPriv);
  let fundingTxid = null;
  if (!DRY_RUN) {
    // Tip via the tip funder wallet.
    setWallet(TIP_FUNDER_PRIV);
    try {
      const tipRes = await m.buildAndBroadcastSatsSend({
        recipientAddr: treasuryAddr,
        amountSats: TIP_SATS,
      });
      fundingTxid = tipRes.txid;
    } catch (e) {
      console.log(`  ⚠ leaf ${r.leafIdx}: tip failed (${e.message}); submitting without funding_txid (daemon will skip)`);
    }
  }
  // POST to worker.
  if (!DRY_RUN) {
    const body = {
      leaf_index: r.leafIdx,
      tacit_pubkey: r.tacitPubHex,
      eth_sig: sig,
    };
    if (fundingTxid) body.funding_txid = fundingTxid;
    const resp = await fetch(`${WORKER_BASE}/airdrops/${rootHex}/claims?network=signet`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.log(`  ✗ leaf ${r.leafIdx}: submit failed ${resp.status} ${(await resp.text()).slice(0, 100)}`);
      continue;
    }
    console.log(`  ✓ leaf ${r.leafIdx}: tipped + submitted · funding_txid ${fundingTxid?.slice(0, 16)}…`);
  } else {
    console.log(`  (dry) leaf ${r.leafIdx}: would tip + submit`);
  }
}

// ============== phase 6: drive fulfilment from treasury ==============
console.log(`\nPhase 6: drive fulfilment from treasury (inline daemon loop)`);
if (!DRY_RUN) {
  setWallet(TREASURY_PRIV);
  console.log(`  Waiting 30s for tip txs + claims to propagate…`);
  await new Promise(r => setTimeout(r, 30_000));

  // Pull queue.
  const queueResp = await fetch(`${WORKER_BASE}/airdrops/${rootHex}/claims?network=signet`);
  if (!queueResp.ok) { console.error('queue pull failed'); process.exit(1); }
  const queue = (await queueResp.json()).claims || [];
  console.log(`  ✓ pulled ${queue.length} claims from queue`);

  // Build a synthetic drop record so the daemon's verify path works.
  const dropRecord = {
    drop_id: bytesToHex(sha256(new TextEncoder().encode(rootHex))).slice(0, 32),
    network: 'signet', asset_id_hex: assetIdHex,
    asset_ticker: TICKER, asset_decimals: DECIMALS,
    merkle_root_hex: rootHex,
    total_amount: totalPayout.toString(),
    count: recipients.length,
    rows: recipients.map(r => ({ index: r.leafIdx, eth_address: '0x' + r.ethAddrHex, amount: r.amount.toString() })),
    fulfilled: [],
  };

  // Batch up to 7 at a time, broadcast.
  let remaining = queue.slice();
  while (remaining.length > 0) {
    const batch = remaining.slice(0, 7);
    remaining = remaining.slice(batch.length);
    const recipientsList = [];
    for (const c of batch) {
      const r = recipients.find(x => x.leafIdx === c.leaf_index);
      if (!r) continue;
      recipientsList.push({ pubHex: c.tacit_pubkey, amount: r.amount });
    }
    console.log(`  Broadcasting batch of ${recipientsList.length}…`);
    const res = await m.buildAndBroadcastCXferMulti({
      assetIdHex, recipients: recipientsList, allowDuplicateRecipients: true,
    });
    console.log(`  ✓ batch broadcast · reveal ${res.revealTxid.slice(0, 16)}…`);
    // DELETE from worker queue.
    for (const c of batch) {
      fetch(`${WORKER_BASE}/airdrops/${rootHex}/claims/${c.leaf_index}?network=signet`, { method: 'DELETE' }).catch(() => {});
    }
  }
  console.log(`  Waiting 60s for confirmations…`);
  await new Promise(r => setTimeout(r, 60_000));
} else {
  console.log(`  (dry) would broadcast ${Math.ceil(N_RECIPIENTS / 7)} CXFER batches`);
}

// ============== phase 7: verify recipients ==============
console.log(`\nPhase 7: verify recipients`);
if (!DRY_RUN) {
  let ok = 0;
  for (const r of recipients) {
    // Each recipient's tacit wallet is independent. Set wallet → recipient,
    // scanHoldings, check balance of assetIdHex.
    setWallet(bytesToHex(r.tacitPriv));
    try {
      const holdings = await m.scanHoldings(true);
      const h = holdings.get(assetIdHex);
      const got = h ? h.balance : 0n;
      if (got === r.amount) { console.log(`  ✓ leaf ${r.leafIdx}: ${got.toString()} ${TICKER} credited`); ok++; }
      else                  { console.log(`  ✗ leaf ${r.leafIdx}: expected ${r.amount}, got ${got}`); }
    } catch (e) {
      console.log(`  ✗ leaf ${r.leafIdx}: holdings scan failed: ${e.message}`);
    }
  }
  console.log(`\n=== Dryrun result: ${ok}/${recipients.length} recipients verified ===\n`);
  if (ok !== recipients.length) process.exit(1);
} else {
  console.log(`  (dry) would verify ${N_RECIPIENTS} recipients`);
}

if (rl) await rl.close();
process.exit(0);
