// Live-signet proof of the recycler's CPFP path: spend the ordinary main-key sats reserve output of an unconfirmed reveal,
// pay a package-aware child back to the same key, broadcast it through the public explorers, and wait for the chain to confirm.
// Use the reveal txid, never the commit txid: a commit-output child does not force the reveal into a block.
// Secrets stay in ~/.tacit-validation; the parent txid/vout can be given explicitly or found from the parent transaction.
//   FB_CPFP_PARENT=<reveal-txid> node tests/fastbridge-signet-cpfp.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { bytesToHex, hexToBytes, secp } from '../dapp/vendor/tacit-deps.min.js';
import { findCpfpAnchor, buildCpfpBump, cpfpFee } from '../fastbridge-lp/lib/stuck-recycle.mjs';

const DIR = join(process.env.HOME || '.', '.tacit-validation');
mkdirSync(DIR, { recursive: true });
const KEY_FILE = process.env.FB_RECYCLE_KEY_FILE || join(DIR, 'signet-recycle.json');
const STATE = process.env.FB_CPFP_STATE || join(DIR, 'fastbridge-signet-cpfp-state.json');
const BASES = ['https://mempool.space/signet/api', 'https://blockstream.info/signet/api'];
const POLL_MS = 30_000;
const now = () => new Date().toISOString();
const log = (msg, x = {}) => console.log(JSON.stringify({ ts: now(), msg, ...x }));
let S = {}; try { S = JSON.parse(readFileSync(STATE, 'utf8')); } catch {}
const keep = () => writeFileSync(STATE, JSON.stringify(S, null, 1));

async function esplora(path, init) {
  let last;
  for (const b of BASES) {
    try {
      const r = await fetch(b + path, init ? { method: 'POST', headers: { 'content-type': 'text/plain' }, body: init } : undefined);
      if (r.ok) return init ? r.text() : r.json();
      last = new Error(`${b}: HTTP ${r.status}`);
    } catch (e) { last = e; }
  }
  throw last || new Error('no signet explorer answered');
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function status(txid) { try { return (await esplora(`/tx/${txid}`)).status || {}; } catch { return {}; } }

const { loadTacit } = await import('../worker-relay/src/lib/btc-pool-transparent.js');
const tacit = await loadTacit('signet');
const key = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
const priv = hexToBytes(key.priv_hex || key.privHex || key.priv);
assert.equal(priv.length, 32);
tacit.wallet.priv = priv;
const pub = secp.getPublicKey(priv, true);
tacit.wallet.pub = pub;
const mainSpk = bytesToHex(tacit.p2wpkhScript(pub));

const parentTxid = S.parentTxid || process.env.FB_CPFP_PARENT;
assert.match(String(parentTxid || ''), /^[0-9a-f]{64}$/, 'FB_CPFP_PARENT or a state file is needed');
if (!S.parentTxid) { S.parentTxid = parentTxid; keep(); }

if (!S.child) {
  const parent = await esplora(`/tx/${parentTxid}`);
  let anchor;
  if (process.env.FB_CPFP_VOUT != null) {
    const vout = Number(process.env.FB_CPFP_VOUT), out = (parent.vout || [])[vout];
    assert.ok(out && String(out.scriptpubkey || '').toLowerCase() === mainSpk, 'the explicit output is not a main-key sats output');
    anchor = { txid: parentTxid, vout, value: Number(out.value) };
  } else anchor = findCpfpAnchor(parent, mainSpk);
  assert.ok(anchor, 'the parent has no spendable main-key sats output over dust');
  const feeRate = Math.max(2, Number(process.env.FB_CPFP_RATE || 5));
  const vsizeOf = (tx) => Number.isFinite(Number(tx.vsize)) ? Number(tx.vsize) : Math.ceil(Number(tx.weight || 0) / 4);
  const members = new Map();
  const addPackageTx = async (tx) => {
    if (!tx || members.has(tx.txid)) return;
    members.set(tx.txid, tx);
    for (const input of tx.vin || []) {
      const prev = await esplora(`/tx/${input.txid}`).catch(() => null);
      if (prev && !(prev.status && prev.status.confirmed)) await addPackageTx(prev);
    }
  };
  await addPackageTx(parent);
  const packageParent = {
    vsize: [...members.values()].reduce((n, tx) => n + vsizeOf(tx), 0),
    fee: [...members.values()].reduce((n, tx) => n + Number(tx.fee || 0), 0),
  };
  const child = buildCpfpBump({
    anchor, rate: feeRate, parent: packageParent, mainSpkHex: mainSpk,
    sign: (tx, i, value) => tacit.signP2wpkhInputWithKey(tx, i, value, priv, pub),
  });
  const hex = bytesToHex(tacit.serializeTx(child.tx)), txid = tacit.txid(child.tx);
  S.child = { txid, hex, parentTxid, anchor, rate: feeRate, fee: child.fee, out: child.out, parentWeight: parent.weight, parentFee: parent.fee, packageVsize: packageParent.vsize, packageFee: packageParent.fee, packageTxs: [...members.keys()] };
  keep();
  await esplora('/tx', hex);
  log('sent cpfp child', { txid, parentTxid, anchor: `${anchor.txid}:${anchor.vout}`, rate: feeRate, fee: child.fee });
} else if (!S.accepted) {
  try { await esplora('/tx', S.child.hex); } catch { /* already seen is fine */ }
  S.accepted = true; keep();
  log('resent cpfp child', { txid: S.child.txid });
}

for (;;) {
  const ps = await status(parentTxid), cs = await status(S.child.txid);
  if (ps.confirmed && cs.confirmed) break;
  log('waiting for a block', { parentTxid, childTxid: S.child.txid, parent: ps, child: cs });
  await wait(POLL_MS);
}
S.verified = { parentTxid, childTxid: S.child.txid, fee: S.child.fee, out: S.child.out, mempool: `https://mempool.space/signet/tx/${S.child.txid}` };
keep();
log('verified', S.verified);
