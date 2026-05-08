// Sats-send pipeline integration — end-to-end safety simulation.
//
// `sats-send.test.mjs` covers the safety primitives in isolation. This file
// exercises the FULL pipeline assembly: address decode → holdings classification
// → input selection → fee estimation → tx assembly. We synthesize realistic
// holdings and UTXO fixtures (the kind a real tacit wallet would have after
// etching an asset and being topped up) and verify the resulting tx contains
// EXACTLY the safe inputs and EXCLUDES the asset UTXO every time.
//
// This is the closest substitute we have for "etch a test asset on signet,
// run sats-send, verify the asset survives" — which requires browser + chain
// access we don't have here.
//
// Run: `node sats-send-integration.test.mjs`
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
const { decodeP2wpkhAddress, selectSatsUtxosSafe, estSatsSendVb, buildSatsSendTx, p2trScript } = dapp;

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else             { console.log(`  FAIL  ${label}`); fail++; }
    })
    .catch(e => { console.log(`  THROW ${label}: ${e.message}\n${e.stack}`); fail++; });
}

// ============================================================================
// Realistic fixture: a wallet that has etched an asset and been topped up.
// Mirrors what the user described: 1 tacit asset commitment (546 sats) +
// 1 funding sats UTXO (~30k sats).
// ============================================================================
const ASSET_UTXO     = { txid: '11'.repeat(32), vout: 0, value: 546 };
const ASSET_CHANGE   = { txid: '22'.repeat(32), vout: 1, value: 546 };  // CXFER change UTXO
const SATS_FUNDING   = { txid: '33'.repeat(32), vout: 1, value: 30705 }; // top-up change
const SATS_FAUCET    = { txid: '44'.repeat(32), vout: 0, value: 20000 };

function holdingsWithAsset(assetIdHex, ...assetUtxos) {
  return new Map([[assetIdHex, {
    assetIdHex, ticker: 'TAC', decimals: 8,
    balance: 100000000n,
    utxos: assetUtxos,
    ghosts: [], inflated: [],
    unknownAsset: false,
  }]]);
}

const TAC_AID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';

// ============================================================================
// Pipeline simulation — mirrors buildAndBroadcastSatsSend's logic without
// actually broadcasting. Calls the same primitives in the same order.
// ============================================================================
function simulatePipeline({ recipientAddr, amountSats, allUtxos, holdings, feeRate = 2, hrp = 'bc' }) {
  // (1) Address validation.
  const decoded = decodeP2wpkhAddress(recipientAddr);
  if (!decoded) throw new Error('recipient invalid');
  if (decoded.hrp !== hrp) throw new Error(`hrp mismatch (${decoded.hrp} vs ${hrp})`);

  // (2) Amount validation.
  if (!Number.isInteger(amountSats) || amountSats <= 0) throw new Error('amount invalid');

  // (3) Holdings ground truth.
  if (!holdings || !(holdings instanceof Map)) throw new Error('no holdings');

  // (4) Sats UTXO selection.
  const sats = selectSatsUtxosSafe(allUtxos, holdings).sort((a, b) => b.value - a.value);
  if (sats.length === 0) throw new Error('no sats utxos');

  // (5) Greedy picking + fee estimation.
  let picked = [], total = 0, fee = 0, change = 0, hasChange = false;
  const DUST = 546;
  const feeFor = (vb, rate) => Math.max(500, Math.ceil(vb * rate));
  for (let i = 0; i < sats.length; i++) {
    picked.push(sats[i]); total += sats[i].value;
    const fwc = feeFor(estSatsSendVb(picked.length, true), feeRate);
    if (total >= amountSats + fwc + DUST) { fee = fwc; change = total - amountSats - fee; hasChange = true; break; }
    const fnc = feeFor(estSatsSendVb(picked.length, false), feeRate);
    if (total >= amountSats + fnc) { fee = fnc; change = 0; hasChange = false; break; }
  }
  if (fee === 0) throw new Error('insufficient sats');

  // (6) Tx assembly.
  const recipientScript = (() => {
    // For the test we just need the right script SHAPE, not a real tx hash dest.
    const out = new Uint8Array(22);
    out[0] = 0x00; out[1] = 0x14;
    out.set(decoded.program, 2);
    return out;
  })();
  const changeScript = (() => {
    // Simulate user's own P2WPKH change script — bytes don't matter for the test.
    const out = new Uint8Array(22);
    out[0] = 0x00; out[1] = 0x14;
    return out;
  })();
  const tx = buildSatsSendTx({
    inputs: picked,
    recipientScript,
    recipientValue: amountSats,
    changeScript,
    changeValue: change,
  });
  return { tx, picked, fee, change, hasChange };
}

// ============================================================================
// Tests — danger scenarios
// ============================================================================
console.log('Pipeline integration — dangerous scenarios:');

await test('sats-send NEVER includes asset UTXO in tx inputs (canonical case)', () => {
  const result = simulatePipeline({
    recipientAddr: 'bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v',
    amountSats: 10000,
    allUtxos: [ASSET_UTXO, SATS_FUNDING],
    holdings: holdingsWithAsset(TAC_AID, ASSET_UTXO),
  });
  const inputKeys = result.tx.inputs.map(i => `${i.txid}:${i.vout}`);
  return !inputKeys.includes(`${ASSET_UTXO.txid}:${ASSET_UTXO.vout}`)
      && inputKeys.includes(`${SATS_FUNDING.txid}:${SATS_FUNDING.vout}`);
});

await test('sats-send excludes ALL asset UTXOs (etch + CXFER change both stay safe)', () => {
  const result = simulatePipeline({
    recipientAddr: 'bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v',
    amountSats: 10000,
    allUtxos: [ASSET_UTXO, ASSET_CHANGE, SATS_FUNDING],
    holdings: holdingsWithAsset(TAC_AID, ASSET_UTXO, ASSET_CHANGE),
  });
  const inputKeys = result.tx.inputs.map(i => `${i.txid}:${i.vout}`);
  return !inputKeys.includes(`${ASSET_UTXO.txid}:${ASSET_UTXO.vout}`)
      && !inputKeys.includes(`${ASSET_CHANGE.txid}:${ASSET_CHANGE.vout}`)
      && inputKeys.length === 1
      && inputKeys[0] === `${SATS_FUNDING.txid}:${SATS_FUNDING.vout}`;
});

await test('sats-send picks larger UTXO first (greedy descending value)', () => {
  const result = simulatePipeline({
    recipientAddr: 'bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v',
    amountSats: 5000,
    allUtxos: [SATS_FAUCET, SATS_FUNDING], // funding is larger; should be picked first
    holdings: new Map(),
  });
  // We requested 5000; either UTXO alone covers it. Greedy picks the larger one.
  return result.tx.inputs.length === 1
      && result.tx.inputs[0].txid === SATS_FUNDING.txid;
});

await test('sats-send refuses entirely if all UTXOs are asset UTXOs', () => {
  // This is the "user is stranded with only asset UTXOs" case. We refuse to
  // proceed rather than invent a sats-send out of nothing.
  let threw = false;
  try {
    simulatePipeline({
      recipientAddr: 'bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v',
      amountSats: 5000,
      allUtxos: [ASSET_UTXO, ASSET_CHANGE],
      holdings: holdingsWithAsset(TAC_AID, ASSET_UTXO, ASSET_CHANGE),
    });
  } catch (e) {
    threw = e.message.includes('no sats');
  }
  return threw;
});

await test('sats-send refuses if asset UTXO is at NON-DUST value AND in holdings (Gate 1 catches)', () => {
  // Simulate a scenario where a hypothetical asset UTXO has value > DUST
  // (e.g., a future protocol variant). Gate 2 (dust threshold) wouldn't catch
  // it — Gate 1 (scanHoldings) must.
  const weirdAsset = { txid: 'aa'.repeat(32), vout: 0, value: 5000 };
  const result = simulatePipeline({
    recipientAddr: 'bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v',
    amountSats: 3000,
    allUtxos: [weirdAsset, SATS_FUNDING],
    holdings: holdingsWithAsset(TAC_AID, weirdAsset),
  });
  const inputKeys = result.tx.inputs.map(i => `${i.txid}:${i.vout}`);
  return !inputKeys.includes(`${weirdAsset.txid}:${weirdAsset.vout}`)
      && inputKeys.includes(`${SATS_FUNDING.txid}:${SATS_FUNDING.vout}`);
});

await test('sats-send refuses if scanHoldings missed an asset UTXO at DUST (Gate 2 backstop)', () => {
  // Simulate the failure mode where Gate 1 has a bug — holdings is empty
  // even though a 546-sat asset UTXO exists at the user's address. Gate 2's
  // value > DUST check is the last line of defense. The 546 UTXO must be
  // excluded by Gate 2 even though Gate 1 didn't flag it.
  const result = simulatePipeline({
    recipientAddr: 'bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v',
    amountSats: 5000,
    allUtxos: [ASSET_UTXO, SATS_FUNDING],
    holdings: new Map(), // ← Gate 1 fails: empty holdings, asset UTXO not flagged
  });
  const inputKeys = result.tx.inputs.map(i => `${i.txid}:${i.vout}`);
  return !inputKeys.includes(`${ASSET_UTXO.txid}:${ASSET_UTXO.vout}`); // Gate 2 saved us
});

await test('sats-send refuses if holdings is null (Gate 3 hard-abort)', () => {
  let threw = false;
  try {
    simulatePipeline({
      recipientAddr: 'bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v',
      amountSats: 5000,
      allUtxos: [ASSET_UTXO, SATS_FUNDING],
      holdings: null, // ← scanHoldings failed (chain unreachable)
    });
  } catch (e) {
    threw = true;
  }
  return threw;
});

await test('sats-send tx output[0] value EXACTLY matches requested amount', () => {
  const result = simulatePipeline({
    recipientAddr: 'bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v',
    amountSats: 7777,
    allUtxos: [SATS_FUNDING],
    holdings: new Map(),
  });
  return result.tx.outputs[0].value === 7777;
});

await test('sats-send change output goes back to user (when present)', () => {
  // Use a recipient script we recognize to verify outputs[0] != outputs[1]
  // and that outputs[1] is *the change script*, not the recipient script.
  const result = simulatePipeline({
    recipientAddr: 'bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v',
    amountSats: 5000,
    allUtxos: [SATS_FUNDING],
    holdings: new Map(),
  });
  if (!result.hasChange) return false; // need change for this test
  // outputs[0] = recipient (bc1qxgqfp2y…), outputs[1] = change (different script)
  return result.tx.outputs.length === 2
      && result.tx.outputs[0].value === 5000
      && result.tx.outputs[1].value === result.change
      && result.tx.outputs[1].value > 0;
});

// ============================================================================
// Tests — value-conservation invariants
// ============================================================================
console.log('\nPipeline integration — value conservation:');

await test('sum(inputs) == sum(outputs) + fee (no leak, no creation)', () => {
  const result = simulatePipeline({
    recipientAddr: 'bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v',
    amountSats: 5000,
    allUtxos: [SATS_FUNDING],
    holdings: new Map(),
  });
  const totalIn = result.picked.reduce((a, u) => a + u.value, 0);
  const totalOut = result.tx.outputs.reduce((a, o) => a + o.value, 0);
  return totalIn === totalOut + result.fee;
});

await test('multi-input case: sums conserve', () => {
  // Force multi-input by requesting more than any single UTXO can cover.
  const big1 = { txid: 'b1'.repeat(32), vout: 0, value: 25000 };
  const big2 = { txid: 'b2'.repeat(32), vout: 0, value: 25000 };
  const result = simulatePipeline({
    recipientAddr: 'bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v',
    amountSats: 40000,
    allUtxos: [big1, big2],
    holdings: new Map(),
  });
  const totalIn = result.picked.reduce((a, u) => a + u.value, 0);
  const totalOut = result.tx.outputs.reduce((a, o) => a + o.value, 0);
  return result.picked.length === 2 && totalIn === totalOut + result.fee;
});

// ============================================================================
// Tests — network HRP isolation
// ============================================================================
console.log('\nPipeline integration — network HRP isolation:');

await test('mainnet address rejected on signet pipeline', () => {
  let threw = false;
  try {
    simulatePipeline({
      recipientAddr: 'bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v', // mainnet
      amountSats: 5000,
      allUtxos: [SATS_FUNDING],
      holdings: new Map(),
      hrp: 'tb', // simulate on signet
    });
  } catch (e) {
    threw = e.message.includes('hrp mismatch');
  }
  return threw;
});

await test('signet address rejected on mainnet pipeline', () => {
  let threw = false;
  try {
    simulatePipeline({
      recipientAddr: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', // signet
      amountSats: 5000,
      allUtxos: [SATS_FUNDING],
      holdings: new Map(),
      hrp: 'bc',
    });
  } catch (e) {
    threw = e.message.includes('hrp mismatch');
  }
  return threw;
});

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
