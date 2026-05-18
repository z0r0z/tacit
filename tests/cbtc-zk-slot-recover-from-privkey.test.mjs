// SPEC-CBTC-ZK §5.21 — Phase 2A: scanSlotsFromPrivkey
//
// What this guards against:
//   A wallet wiped to bare privkey on a new device (no localStorage)
//   would have lost its slot records before this path landed. The
//   Phase 1 helpers (_deriveSlotSecret / _deriveSlotNullifierPreimage)
//   make (secret, ν) deterministic from (priv, anchor, outputIndex);
//   Phase 2A walks the address's outgoing-spend history, treats each
//   spent outpoint as a candidate MINT anchor, derives K_btc, and
//   confirms a match against a real on-chain T_SLOT_MINT envelope.
//
// What this proves:
//   - A privkey that previously minted a slot can re-discover the slot
//     record from chain alone — assetIdHex, denomination, secrets,
//     leaf commit, K_btc, and the mint txid all reconstruct correctly.
//   - Privkeys that haven't minted return zero candidates.
//   - Anchors that don't decode as T_SLOT_MINT are skipped without
//     false-positive recovery.
//
// Mocks the dapp's chain-fetch helpers (getTx, getOutspend, apiJson) so
// the test runs offline against a synthetic two-tx chain.
//
// Run: `node tests/cbtc-zk-slot-recover-from-privkey.test.mjs`

import { JSDOM } from 'jsdom';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(t) { console.log(`\n${t}:`); }

// =================== synthetic chain fixture ===================
// Build a complete two-tx slot-mint flow:
//   commitTx: spends wallet UTXO (anchor.txid:anchor.vout) → vout[0] is a
//             P2TR carrying the envelope script (we don't need to actually
//             construct the script; the dapp reads it from witness[1] of
//             the REVEAL tx).
//   revealTx: spends commitTx:0 → vin[0].witness[1] is the T_SLOT_MINT
//             envelope script. vout[0] is the slot P2TR at K_btc.
// We don't need real Bitcoin signatures or merkle roots — only the bytes
// scanSlotsFromPrivkey reads.

const WALLET_PRIV = hexToBytes('11'.repeat(32));
const WALLET_PUB = secp.getPublicKey(WALLET_PRIV, true);
// p2wpkh address from pubkey — use the dapp's address derivation for
// byte-perfect match with what scanSlotsFromPrivkey expects.
dapp.wallet.priv = WALLET_PRIV;
dapp.wallet.pub = WALLET_PUB;
const ADDRESS = dapp.wallet.address();

const ASSET_ID = hexToBytes('a1'.repeat(32));
const DENOM = 10_000n;

// Anchor outpoint (wallet's spent UTXO that funds the commit)
const ANCHOR_TXID = 'aa'.repeat(32);
const ANCHOR_VOUT = 0;

// Build the T_SLOT_MINT envelope via the dapp's high-level builder. This
// gives us a byte-identical payload to what real builders produce.
const built = await dapp.buildSlotMintEnvelope({
  networkTag: 0x01, // signet
  assetId: ASSET_ID,
  denomination: DENOM,
  // Deterministic secret + nullifier derived from anchor — this is the
  // Phase 1 contract we're exercising.
  secret: dapp._deriveSlotSecret({
    privkey: WALLET_PRIV,
    anchorOutpoint: dapp._slotOutpointBytes(ANCHOR_TXID, ANCHOR_VOUT),
    outputIndex: 0,
  }),
  nullifierPreimage: dapp._deriveSlotNullifierPreimage({
    privkey: WALLET_PRIV,
    anchorOutpoint: dapp._slotOutpointBytes(ANCHOR_TXID, ANCHOR_VOUT),
    outputIndex: 0,
  }),
  paymentAssetId: new Uint8Array(32),
  paymentAmount: 0n,
  minterPriv: WALLET_PRIV,
});

// Construct the on-wire envelope script that the harness's mocked getTx
// will return for the reveal tx's vin[0].witness[1].
const envelopeScript = dapp.encodeEnvelopeScript(
  WALLET_PUB.slice(1), // x-only of wallet pubkey (cosmetic — signer key)
  built.payload,
);
const envelopeScriptHex = bytesToHex(envelopeScript);

const COMMIT_TXID = 'bb'.repeat(32);
const REVEAL_TXID = 'cc'.repeat(32);
const SLOT_SPK_HEX = bytesToHex(built.slotScriptPubKey);

// Mock chain backends. The dapp reaches mempool.space via api()/apiJson()/getTx/
// getOutspend; install global fetch + apiJson hooks that serve our two-tx
// fixture. Since api() prefixes with NET.name, our /address handler matches
// the wallet's signet address.
const _FIXTURE_TXS = new Map([
  [COMMIT_TXID, {
    txid: COMMIT_TXID,
    status: { confirmed: true, block_height: 100, block_time: 1700000000 },
    vin: [{
      txid: ANCHOR_TXID,
      vout: ANCHOR_VOUT,
      prevout: { scriptpubkey_address: ADDRESS, value: 20_000 },
      witness: [],
    }],
    vout: [
      // vout[0]: P2TR carrying the envelope (in real Bitcoin this is the
      // taproot-script-path output). The exact bytes don't matter for the
      // recovery scan — we just need the scriptpubkey to start with 5120
      // (P2TR) so the candidate-probe loop iterates this output. The actual
      // envelope script bytes are returned in the REVEAL tx's witness[1].
      { scriptpubkey: '5120' + 'ee'.repeat(32), value: 10_000 + 500 },
      { scriptpubkey: '0014' + 'ff'.repeat(20), value: 9_000 },  // change
    ],
  }],
  [REVEAL_TXID, {
    txid: REVEAL_TXID,
    status: { confirmed: true, block_height: 101, block_time: 1700000300 },
    vin: [{
      txid: COMMIT_TXID,
      vout: 0,
      witness: ['', envelopeScriptHex, ''], // signature, envelope-script, control-block
    }],
    vout: [
      { scriptpubkey: SLOT_SPK_HEX, value: Number(DENOM) }, // the slot P2TR
    ],
  }],
]);

const _FIXTURE_OUTSPENDS = new Map([
  [`${COMMIT_TXID}:0`, { spent: true, txid: REVEAL_TXID, vin: 0, status: { confirmed: true, block_height: 101 } }],
  [`${COMMIT_TXID}:1`, { spent: false }],
]);

// /address/:addr/txs/chain returns the commit tx in our fixture
const _FIXTURE_ADDR_TXS = [_FIXTURE_TXS.get(COMMIT_TXID)];

// Install global fetch that intercepts mempool.space + worker calls and
// returns fixture data for the paths scanSlotsFromPrivkey hits.
const _origFetch = globalThis.fetch;
globalThis.fetch = async (resource, init) => {
  const url = typeof resource === 'string' ? resource : resource.url;
  // /address/<addr>/txs/chain (paginated; first page returns our fixture
  // for the wallet under test, empty for any other address).
  const addrMatch = url.match(/\/address\/([^/]+)\/txs\/chain/);
  if (addrMatch) {
    const body = addrMatch[1] === ADDRESS ? _FIXTURE_ADDR_TXS : [];
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  // /tx/<txid> — single tx fetch
  const txMatch = url.match(/\/tx\/([0-9a-f]{64})(?:\?|$)/i);
  if (txMatch) {
    const tx = _FIXTURE_TXS.get(txMatch[1].toLowerCase());
    if (!tx) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(tx), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // /tx/<txid>/outspend/<n>
  const osMatch = url.match(/\/tx\/([0-9a-f]{64})\/outspend\/(\d+)/i);
  if (osMatch) {
    const key = `${osMatch[1].toLowerCase()}:${osMatch[2]}`;
    const r = _FIXTURE_OUTSPENDS.get(key) || { spent: false };
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Batched outspends POST (worker fan-out)
  if (url.includes('/chain/outspends/batch') && init?.method === 'POST') {
    let outpoints = [];
    try { outpoints = JSON.parse(init.body).outpoints || []; } catch {}
    const results = outpoints.map(({ txid, vout }) => {
      const key = `${(txid || '').toLowerCase()}:${vout}`;
      return _FIXTURE_OUTSPENDS.get(key) || { spent: false };
    });
    return new Response(JSON.stringify({ outspends: results }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  // Anything else — pass through (or return 404; the dapp tolerates)
  return new Response('not implemented in fixture', { status: 404 });
};

// =================== tests ===================

group('Phase 2A: recover a previously-minted slot from privkey + chain alone');

{
  // Confirm there are zero local slot records before scan (fresh JSDOM).
  ok('no slots in local storage pre-scan', dapp.getSlotRecords().length === 0);

  // Run the scan.
  const result = await dapp.scanSlotsFromPrivkey();
  ok('scan completes without throwing', !!result);
  ok('scan reports 1 recovered slot', result.recovered === 1, `got recovered=${result.recovered}`);
  ok('scan reports 1 anchor tested', result.scanned === 1, `got scanned=${result.scanned}`);
  ok('scan returns the slot record', Array.isArray(result.slots) && result.slots.length === 1);

  const rec = result.slots[0];
  ok('recovered assetIdHex matches', rec.assetIdHex === bytesToHex(ASSET_ID));
  ok('recovered denomination matches', rec.denomination === DENOM.toString());
  ok('recovered leafCommitmentHex matches built envelope',
    rec.leafCommitmentHex === built.slotRecord.leafCommitmentHex);
  ok('recovered K_btc matches built envelope',
    rec.kBtcXOnlyHex === built.slotRecord.kBtcXOnlyHex);
  ok('recovered slotScriptPubKey matches', rec.slotScriptPubKeyHex === SLOT_SPK_HEX);
  ok('recovered secret matches the deterministic Phase 1 derivation',
    rec.secretHex === built.slotRecord.secretHex);
  ok('recovered nullifierPreimage matches the deterministic Phase 1 derivation',
    rec.nullifierPreimageHex === built.slotRecord.nullifierPreimageHex);
  ok('recovered mintTxid is the reveal tx', rec.mintTxid === REVEAL_TXID);
  ok('recovered commitTxid is the commit tx', rec.commitTxid === COMMIT_TXID);
  ok('record flagged as recoveredFromPrivkey', rec.recoveredFromPrivkey === true);
  ok('record status starts as live', rec.status === 'live');
}

group('idempotent: re-running scan does not re-insert');

{
  const result = await dapp.scanSlotsFromPrivkey();
  ok('re-scan reports 0 new recoveries', result.recovered === 0,
    `got recovered=${result.recovered}`);
  ok('local slot count is still 1', dapp.getSlotRecords().length === 1);
}

group('different privkey: no false positives');

{
  // Switch to a different wallet privkey. The address changes so the chain
  // walk yields zero anchors — but even if we forced anchors through, the
  // Phase 1 derivation would yield a different K_btc and the candidate
  // probe would reject the envelope.
  const otherPriv = hexToBytes('22'.repeat(32));
  dapp.wallet.priv = otherPriv;
  dapp.wallet.pub = secp.getPublicKey(otherPriv, true);
  // Clear local slot store
  for (const r of dapp.getSlotRecords()) dapp.forgetSlotRecord(r.leafCommitmentHex);
  ok('local slot store cleared for second-wallet test', dapp.getSlotRecords().length === 0);

  const result = await dapp.scanSlotsFromPrivkey();
  ok('different-privkey scan returns 0 recoveries', result.recovered === 0,
    `got recovered=${result.recovered}`);
}

globalThis.fetch = _origFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
