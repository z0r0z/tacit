// Sats-send safety primitives.
//
// Two functions are safety-critical: address parsing (must reject anything that
// isn't a strict P2WPKH bech32 v0 address; mixed-case and wrong-length programs
// would let a user send Bitcoin to an unintended destination), and
// asset-UTXO classification (must NEVER green-light an asset UTXO for plain
// spending; doing so would burn a tacit holding with no recovery).
//
// These tests pin both behaviors against synthetic fixtures. `scanHoldings` is
// not mocked here — instead we feed `selectSatsUtxosSafe` a hand-built holdings
// Map shaped like the real one, so the test exercises the filter logic in
// isolation from chain I/O.
//
// Run: `node sats-send.test.mjs`
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

const dapp = await import('../dapp/tacit.js');
const { decodeP2wpkhAddress, selectSatsUtxosSafe, estSatsSendVb, buildSatsSendTx } = dapp;

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else             { console.log(`  FAIL  ${label}`); fail++; }
    })
    .catch(e => { console.log(`  THROW ${label}: ${e.message}`); fail++; });
}

// ============================================================================
// decodeP2wpkhAddress — STRICT bech32 v0 / 20-byte program decoder
// ============================================================================
console.log('decodeP2wpkhAddress (strict P2WPKH bech32 v0):');

await test('accepts canonical mainnet P2WPKH (bc1q...)', () => {
  const r = decodeP2wpkhAddress('bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v');
  return r !== null && r.hrp === 'bc' && r.version === 0 && r.program.length === 20;
});

await test('accepts canonical signet/testnet P2WPKH (tb1q...)', () => {
  const r = decodeP2wpkhAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
  return r !== null && r.hrp === 'tb' && r.version === 0 && r.program.length === 20;
});

await test('rejects bc1p... (P2TR / bech32m v1) — out of scope, reject not silent-accept', () => {
  // bech32m and v1 are intentionally not supported in this revision; if the
  // decoder ever silently accepts a v1 program as if it were v0, sats sent
  // there would land at an unintended recipient.
  const r = decodeP2wpkhAddress('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297');
  return r === null;
});

await test('rejects mixed-case input (BIP-173 disallows it)', () => {
  // Real-world wallets never send mixed-case; if we accepted them silently we'd
  // be lenient where the spec says we shouldn't.
  return decodeP2wpkhAddress('bc1QxgqFp2yqqEvxr7z6tzzhv7y62yz4jal3luu92v') === null;
});

await test('rejects empty / very short input', () => {
  return decodeP2wpkhAddress('') === null && decodeP2wpkhAddress('bc1q') === null;
});

await test('rejects garbage / non-bech32 strings', () => {
  return decodeP2wpkhAddress('not an address') === null
      && decodeP2wpkhAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') === null;
});

await test('rejects bech32 v0 with 32-byte program (P2WSH, not P2WPKH)', () => {
  // P2WSH is bech32 v0 but with a 32-byte script hash. Sats sent to a P2WSH
  // would be unspendable without the script. We narrow the decoder to P2WPKH.
  const r = decodeP2wpkhAddress('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3');
  return r === null;
});

await test('rejects truncated checksum', () => {
  return decodeP2wpkhAddress('bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92') === null;
});

await test('rejects null / non-string inputs without throwing', () => {
  // The dapp validation layer should never trip on these; defensive coding
  // matters when user input flows in from a paste.
  return decodeP2wpkhAddress(null) === null
      && decodeP2wpkhAddress(undefined) === null
      && decodeP2wpkhAddress(12345) === null
      && decodeP2wpkhAddress({}) === null;
});

// ============================================================================
// selectSatsUtxosSafe — ASSET-UTXO EXCLUSION
// ============================================================================
console.log('\nselectSatsUtxosSafe (asset-UTXO exclusion):');

// Helper: synthesize a holdings Map shaped like scanHoldings output.
function fakeHoldings(spec) {
  const m = new Map();
  for (const [aid, h] of Object.entries(spec)) m.set(aid, { utxos: [], ghosts: [], inflated: [], ...h });
  return m;
}
const ASSET_UTXOS_FIXTURE = [
  { txid: 'a'.repeat(64), vout: 0, value: 546 },     // tacit asset commitment (DUST)
  { txid: 'b'.repeat(64), vout: 1, value: 546 },     // another asset
];
const SATS_UTXOS_FIXTURE = [
  { txid: 'c'.repeat(64), vout: 0, value: 30000 },   // funding
  { txid: 'd'.repeat(64), vout: 1, value: 5000 },    // small but spendable
];
const GHOST_UTXO_FIXTURE = { txid: 'e'.repeat(64), vout: 2, value: 546 };
const INFLATED_UTXO_FIXTURE = { txid: 'f'.repeat(64), vout: 3, value: 546 };

await test('throws if holdings argument is null/undefined (hard-abort, no fallback)', () => {
  let threw = false;
  try { selectSatsUtxosSafe([], null); } catch { threw = true; }
  let threw2 = false;
  try { selectSatsUtxosSafe([], undefined); } catch { threw2 = true; }
  return threw && threw2;
});

await test('throws if holdings is not a Map (defends against shape regressions)', () => {
  let threw = false;
  try { selectSatsUtxosSafe([], { fakeAid: { utxos: [] } }); } catch { threw = true; }
  return threw;
});

await test('excludes asset UTXOs that appear in holdings.utxos', () => {
  const holdings = fakeHoldings({ asset1: { utxos: ASSET_UTXOS_FIXTURE } });
  const all = [...ASSET_UTXOS_FIXTURE, ...SATS_UTXOS_FIXTURE];
  const sats = selectSatsUtxosSafe(all, holdings);
  // Should contain ONLY the SATS_UTXOS_FIXTURE entries.
  return sats.length === SATS_UTXOS_FIXTURE.length
      && sats.every(s => SATS_UTXOS_FIXTURE.some(x => x.txid === s.txid && x.vout === s.vout));
});

await test('excludes ghost UTXOs (validation incomplete — treat as asset)', () => {
  const holdings = fakeHoldings({ asset1: { ghosts: [GHOST_UTXO_FIXTURE] } });
  const all = [GHOST_UTXO_FIXTURE, ...SATS_UTXOS_FIXTURE];
  const sats = selectSatsUtxosSafe(all, holdings);
  return sats.length === SATS_UTXOS_FIXTURE.length
      && !sats.some(s => s.txid === GHOST_UTXO_FIXTURE.txid && s.vout === GHOST_UTXO_FIXTURE.vout);
});

await test('excludes inflated UTXOs too', () => {
  const holdings = fakeHoldings({ asset1: { inflated: [INFLATED_UTXO_FIXTURE] } });
  const all = [INFLATED_UTXO_FIXTURE, ...SATS_UTXOS_FIXTURE];
  const sats = selectSatsUtxosSafe(all, holdings);
  return sats.length === SATS_UTXOS_FIXTURE.length;
});

await test('excludes all UTXOs at value <= DUST regardless of holdings entry (gate 2 backstop)', () => {
  // Even if holdings is empty, a 546-sat UTXO should be rejected by the dust
  // backstop. Defends against a bug in scanHoldings missing an asset UTXO.
  const holdings = fakeHoldings({});
  const all = [
    { txid: '1'.repeat(64), vout: 0, value: 546 },     // exactly DUST → reject
    { txid: '2'.repeat(64), vout: 0, value: 545 },     // below DUST → reject (would fail relay anyway)
    { txid: '3'.repeat(64), vout: 0, value: 547 },     // just above DUST → accept
    { txid: '4'.repeat(64), vout: 0, value: 30000 },   // normal → accept
  ];
  const sats = selectSatsUtxosSafe(all, holdings);
  return sats.length === 2
      && sats.every(s => s.value > 546);
});

await test('returns plain-sats UTXOs when no holdings exist (empty Map)', () => {
  const holdings = fakeHoldings({});
  const sats = selectSatsUtxosSafe(SATS_UTXOS_FIXTURE, holdings);
  return sats.length === SATS_UTXOS_FIXTURE.length;
});

await test('handles multi-asset holdings (union of all asset/ghost/inflated)', () => {
  const holdings = fakeHoldings({
    asset1: { utxos: [ASSET_UTXOS_FIXTURE[0]] },
    asset2: { utxos: [ASSET_UTXOS_FIXTURE[1]], ghosts: [GHOST_UTXO_FIXTURE] },
  });
  const all = [...ASSET_UTXOS_FIXTURE, GHOST_UTXO_FIXTURE, ...SATS_UTXOS_FIXTURE];
  const sats = selectSatsUtxosSafe(all, holdings);
  return sats.length === SATS_UTXOS_FIXTURE.length;
});

await test('handles malformed holdings entries (missing utxos/ghosts/inflated keys)', () => {
  const holdings = new Map();
  holdings.set('aid1', {}); // no utxos / no ghosts / no inflated
  // Should not throw; should treat as "no asset UTXOs in this entry."
  const sats = selectSatsUtxosSafe(SATS_UTXOS_FIXTURE, holdings);
  return sats.length === SATS_UTXOS_FIXTURE.length;
});

await test('input list and result are unrelated arrays (no in-place mutation)', () => {
  const all = [...SATS_UTXOS_FIXTURE];
  const before = JSON.stringify(all);
  selectSatsUtxosSafe(all, fakeHoldings({}));
  return JSON.stringify(all) === before;
});

// ============================================================================
// estSatsSendVb / buildSatsSendTx — TX BUILDER
// ============================================================================
console.log('\ntx builder helpers:');

await test('estSatsSendVb scales with input count and change presence', () => {
  const oneInOneOut    = estSatsSendVb(1, false);
  const oneInTwoOut    = estSatsSendVb(1, true);
  const fiveInTwoOut   = estSatsSendVb(5, true);
  // Two outputs costs more than one (extra 31 vbytes for the change output).
  // Five inputs cost more than one (4 × 68 extra vbytes).
  return oneInTwoOut > oneInOneOut
      && fiveInTwoOut > oneInTwoOut
      && (oneInTwoOut - oneInOneOut) === 31
      && (fiveInTwoOut - oneInTwoOut) === 4 * 68;
});

await test('buildSatsSendTx omits change output when changeValue is 0', () => {
  const tx = buildSatsSendTx({
    inputs: [{ txid: 'a'.repeat(64), vout: 0 }],
    recipientScript: new Uint8Array(22),
    recipientValue: 5000,
    changeScript: new Uint8Array(22),
    changeValue: 0,
  });
  return tx.outputs.length === 1 && tx.outputs[0].value === 5000;
});

await test('buildSatsSendTx includes change output when changeValue > 0', () => {
  const tx = buildSatsSendTx({
    inputs: [{ txid: 'a'.repeat(64), vout: 0 }],
    recipientScript: new Uint8Array(22),
    recipientValue: 5000,
    changeScript: new Uint8Array(22),
    changeValue: 1234,
  });
  return tx.outputs.length === 2 && tx.outputs[0].value === 5000 && tx.outputs[1].value === 1234;
});

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
