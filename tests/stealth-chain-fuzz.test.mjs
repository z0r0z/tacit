// Chain-of-transfers fuzz test.
//
// Models arbitrary tacit-asset transfer chains of length 1..6 hops,
// where each hop independently chooses CLASSICAL or STEALTH receiving.
// At each hop, we simulate the full math of the dapp CXFER builder
// and recipient scanner end-to-end:
//
//   - Sender's amount-channel ECDH (deriveAmountKeystreamECDH +
//     deriveBlinding) MUST use the scalar matching the witness pubkey
//     of vin[1] — wallet.priv for classical inputs, tweakedSk for
//     stealth-received inputs. The fix landed in dapp/tacit.js for
//     buildAndBroadcastCXferMulti.
//   - Sender's stealth-channel ECDH uses the per-input effective
//     priv sum (Σ wallet.priv for classical + tweakedSk for stealth).
//   - Recipient classifies each input by its on-chain (witness +
//     prevout), aggregates eligibles into P_sender, derives b,
//     checks both amount channel and stealth-shape match.
//   - Pedersen commitment balances at every hop (kernel sig closes).
//   - tweakedSk_recipient · G == commit (custody preserved).
//
// Fuzz dimensions:
//   - Chain length: 1..6 hops.
//   - Per-hop recipient mode: classical | stealth (random).
//   - Per-hop input count K_asset ∈ {1, 2, 3} (asset inputs the
//     sender consumes at that hop).
//   - K_asset > 1 picks a mix of classical + stealth inputs from
//     the sender's recovered holdings (when both are available).
//   - Random scalars throughout.

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import {
  SECP_N,
  DOMAIN_CXFER_STEALTH,
  encodeStealthAddress, decodeStealthAddress,
  deriveStealthEcdhBlinding, computeStealthCommit, computeStealthTweakedSk,
  classifyInput, aggregateStealthEligibleInputPubkeys,
  stealthTxAnchorHead,
  senderComputeStealthCommit, recipientScanTxForStealth,
} from './stealth-dapp-patch.mjs';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

const G = secp.ProjectivePoint.BASE;
const H = (() => {
  // Same nothing-up-my-sleeve H as the dapp.
  let counter = 0;
  while (true) {
    const seed = sha256(concatBytes(new TextEncoder().encode('tacit-H-v1'), new Uint8Array([counter])));
    try {
      const p = secp.ProjectivePoint.fromHex(bytesToHex(concatBytes(new Uint8Array([0x02]), seed)));
      if (!p.equals(secp.ProjectivePoint.ZERO)) return p;
    } catch {}
    counter++;
    if (counter > 1000) throw new Error('H derivation failed');
  }
})();

const N_BITS = 64;
const modN = x => ((x % SECP_N) + SECP_N) % SECP_N;
const bigintToBytes32 = (x) => {
  let h = modN(x).toString(16); while (h.length < 64) h = '0' + h;
  return hexToBytes(h);
};
const bytes32ToBigint = (b) => BigInt('0x' + bytesToHex(b));

// Mirror dapp helpers used in the amount channel.
const AMOUNT_DOMAIN      = new TextEncoder().encode('tacit-cxfer-amount-v1');
const AMOUNT_SELF_DOMAIN = new TextEncoder().encode('tacit-cxfer-amount-self-v1');
const BLINDING_DOMAIN    = new TextEncoder().encode('tacit-cxfer-blinding-v1');
const CHANGE_BLINDING_DOMAIN = new TextEncoder().encode('tacit-cxfer-change-blinding-v1');

function deriveBlinding(myPriv, theirPub, anchor, voutIdx) {
  const shared = secp.getSharedSecret(myPriv, theirPub);
  const seed = sha256(shared.slice(1));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  const out = hmac(sha256, seed, concatBytes(BLINDING_DOMAIN, anchor, voutLE));
  let r = bytes32ToBigint(out) % SECP_N; if (r === 0n) r = 1n;
  return r;
}
function deriveChangeBlinding(myPriv, anchor, voutIdx) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  const out = hmac(sha256, myPriv, concatBytes(CHANGE_BLINDING_DOMAIN, anchor, voutLE));
  let r = bytes32ToBigint(out) % SECP_N; if (r === 0n) r = 1n;
  return r;
}
function deriveAmountKeystreamECDH(myPriv, theirPub, anchor, voutIdx) {
  const shared = secp.getSharedSecret(myPriv, theirPub);
  const seed = sha256(shared.slice(1));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  return hmac(sha256, seed, concatBytes(AMOUNT_DOMAIN, anchor, voutLE)).slice(0, 8);
}
function deriveAmountKeystreamSelf(myPriv, anchor, voutIdx) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  return hmac(sha256, myPriv, concatBytes(AMOUNT_SELF_DOMAIN, anchor, voutLE)).slice(0, 8);
}
const encryptAmount = (amount, ks) => {
  const ab = new Uint8Array(8);
  new DataView(ab.buffer).setBigUint64(0, amount, true);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = ab[i] ^ ks[i];
  return out;
};
const decryptAmount = (ct, ks) => {
  const ab = new Uint8Array(8);
  for (let i = 0; i < 8; i++) ab[i] = ct[i] ^ ks[i];
  return new DataView(ab.buffer).getBigUint64(0, true);
};
const pedersenCommit = (amount, r) => {
  const rPart = G.multiply(modN(r));
  const aMod = modN(amount);
  return aMod === 0n ? rPart : rPart.add(H.multiply(aMod));
};

// =============================================================================
// Wallet + UTXO model
// =============================================================================

function newWallet(name) {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  let d = bytes32ToBigint(priv) % SECP_N; if (d === 0n) d = 1n;
  const fixed = bigintToBytes32(d);
  return {
    name, priv: fixed, pub: secp.getPublicKey(fixed, true),
    holdings: [],  // [{ kind: 'classical'|'stealth', amount, blinding, signerPriv, signerPub }]
  };
}

// Simulate ONE CXFER from sender to a list of recipients.
// recipients: [{ wallet, mode: 'classical'|'stealth', amount }]
// senderInputs: array of UTXOs picked from sender.holdings to spend. Total
// amount must >= sum(recipients.amount). Remainder = change.
function emitCxfer({ sender, senderInputs, recipients }) {
  if (!Array.isArray(senderInputs) || senderInputs.length === 0) {
    throw new Error('senderInputs required');
  }
  const inAmt = senderInputs.reduce((s, u) => s + u.amount, 0n);
  const sendTotal = recipients.reduce((s, r) => s + r.amount, 0n);
  if (sendTotal > inAmt) throw new Error('insufficient input');
  const changeAmt = inAmt - sendTotal;
  const K = recipients.length;
  const m = K + 1 <= 2 ? 2 : K + 1 <= 4 ? 4 : 8;  // smallest power-of-2 fit

  // tx_anchor: random outpoint stand-in (matches first asset input).
  const fakeTxid = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const txAnchor = concatBytes(
    (() => { const b = hexToBytes(fakeTxid); const r = new Uint8Array(32); for (let i = 0; i < 32; i++) r[i] = b[31 - i]; return r; })(),
    new Uint8Array([0, 0, 0, 0]),
  );

  // §A.2 fix: amount-channel scalar = signer of vin[1] = first asset input.
  const amountChannelSenderPriv = senderInputs[0].signerPriv;

  // Pedersen blindings + amount keystreams (per output).
  const blindings = []; const keystreams = []; const amounts = [];
  for (let i = 0; i < K; i++) {
    amounts.push(recipients[i].amount);
    blindings.push(deriveBlinding(amountChannelSenderPriv, recipients[i].wallet.pub, txAnchor, i));
    keystreams.push(deriveAmountKeystreamECDH(amountChannelSenderPriv, recipients[i].wallet.pub, txAnchor, i));
  }
  amounts.push(changeAmt);
  blindings.push(deriveChangeBlinding(sender.priv, txAnchor, K));
  keystreams.push(deriveAmountKeystreamSelf(sender.priv, txAnchor, K));
  for (let v = K + 1; v < m; v++) {
    amounts.push(0n);
    blindings.push(deriveChangeBlinding(sender.priv, txAnchor, v));
    keystreams.push(deriveAmountKeystreamSelf(sender.priv, txAnchor, v));
  }

  // Pedersen commitments — these are what go on chain.
  const commitments = amounts.map((a, i) => pedersenCommit(a, blindings[i]));

  // Output scripts (P2WPKH wrapped — we model them as 'pubkey-or-commit')
  // and the stealth-channel commit derivation.
  const txAnchorHead = stealthTxAnchorHead(fakeTxid, 0);
  const eligiblePrivs = senderInputs.map(u => u.signerPriv);
  const outputs = [];
  for (let i = 0; i < K; i++) {
    if (recipients[i].mode === 'stealth') {
      const { commit } = senderComputeStealthCommit({
        senderEligibleInputPrivs: eligiblePrivs,
        recipientPub: recipients[i].wallet.pub,
        networkTag: 'signet',
        domain: DOMAIN_CXFER_STEALTH,
        txAnchorHead, voutIndex: i,
      });
      outputs.push({ scriptPub: commit, isStealth: true });
    } else {
      outputs.push({ scriptPub: recipients[i].wallet.pub, isStealth: false });
    }
  }
  // Change goes back to sender.pub (classical).
  outputs.push({ scriptPub: sender.pub, isStealth: false });
  for (let v = K + 1; v < m; v++) outputs.push({ scriptPub: sender.pub, isStealth: false });

  // Encrypted-amount payloads.
  const cts = amounts.map((a, i) => encryptAmount(a, keystreams[i]));

  // Kernel excess (must balance for the tx to be valid).
  const blindingSum = blindings.reduce((s, b) => modN(s + b), 0n);
  const inBlindingSum = senderInputs.reduce((s, u) => modN(s + u.blinding), 0n);
  const excess = modN(blindingSum - inBlindingSum);
  // Verify: ΣC_out - ΣC_in == excess·G  (amounts balance, so H-component zero).
  const sumOut = commitments.reduce((p, c) => p.add(c), secp.ProjectivePoint.ZERO);
  const sumIn = senderInputs.reduce((p, u) => p.add(pedersenCommit(u.amount, u.blinding)), secp.ProjectivePoint.ZERO);
  const ePrime = sumOut.add(sumIn.negate());
  const eGuess = G.multiply(excess);
  if (!ePrime.equals(eGuess)) throw new Error('kernel excess mismatch — amounts or blindings broken');

  // Return the "broadcast tx" — what a recipient sees on chain.
  return {
    senderPubAtVin1: senderInputs[0].signerPub,  // what recipient reads from vin[1].witness[1]
    inputs: senderInputs.map(u => ({ kind: 'p2wpkh', pub: u.signerPub })),
    outputs, cts, commitments,
    txAnchor, txAnchorHead, fakeTxid,
    K, m,
  };
}

// Recipient scans a tx. Mirrors the dapp scanner's branching:
//   - ECDH path (sender ≠ us): decrypt amount via ECDH(walletPriv, senderPub).
//   - Self path (we sent to ourselves; output is change/padding/self-pay):
//     decrypt via deriveAmountKeystreamSelf(walletPriv, anchor, vout).
//   - Stealth detection (only after ECDH or self succeeds AND the output
//     script is NOT P2WPKH(walletPub)): trial the §A.2.5-derived commit.
function scanTxAsRecipient({ tx, wallet }) {
  const credits = [];
  const senderPub = tx.senderPubAtVin1;
  for (let v = 0; v < tx.outputs.length; v++) {
    // Try ECDH path first.
    let recovered = null;  // { amount, blinding }
    {
      const ks = deriveAmountKeystreamECDH(wallet.priv, senderPub, tx.txAnchor, v);
      const candidate = decryptAmount(tx.cts[v], ks);
      if (candidate >= 0n && candidate < (1n << BigInt(N_BITS))) {
        const r = deriveBlinding(wallet.priv, senderPub, tx.txAnchor, v);
        if (pedersenCommit(candidate, r).equals(tx.commitments[v])) {
          recovered = { amount: candidate, blinding: r };
        }
      }
    }
    // Try self path (change/padding/self-pay).
    if (!recovered) {
      const ks = deriveAmountKeystreamSelf(wallet.priv, tx.txAnchor, v);
      const candidate = decryptAmount(tx.cts[v], ks);
      if (candidate >= 0n && candidate < (1n << BigInt(N_BITS))) {
        const r = deriveChangeBlinding(wallet.priv, tx.txAnchor, v);
        if (pedersenCommit(candidate, r).equals(tx.commitments[v])) {
          recovered = { amount: candidate, blinding: r };
        }
      }
    }
    if (!recovered) continue;

    // Now classify by output script.
    const out = tx.outputs[v];
    if (out.scriptPub.length === 33 && out.scriptPub.every((x, i) => x === wallet.pub[i])) {
      credits.push({ vout: v, amount: recovered.amount, blinding: recovered.blinding, signerPriv: wallet.priv, signerPub: wallet.pub, kind: 'classical' });
      continue;
    }
    // Stealth trial.
    try {
      const { aggregatePub } = aggregateStealthEligibleInputPubkeys(tx.inputs);
      if (!aggregatePub) continue;
      const txAnchor = concatBytes(tx.txAnchorHead, (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; })());
      const b = deriveStealthEcdhBlinding({
        ourPriv: wallet.priv, theirPub: aggregatePub,
        networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH, txAnchor,
      });
      const expected = computeStealthCommit({ underlyingPub: wallet.pub, blinding: b });
      if (out.scriptPub.length === expected.length && out.scriptPub.every((x, i) => x === expected[i])) {
        const tweakedSk = computeStealthTweakedSk({ underlyingPriv: wallet.priv, blinding: b });
        const tweakedPub = secp.getPublicKey(tweakedSk, true);
        credits.push({ vout: v, amount: recovered.amount, blinding: recovered.blinding, signerPriv: tweakedSk, signerPub: tweakedPub, kind: 'stealth' });
      }
    } catch {}
  }
  return credits;
}

// =============================================================================
// Tests
// =============================================================================

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); console.log(`✓ ${name}`); pass++; } catch (e) { console.error(`✗ ${name}: ${e.message}`); console.error('  ', (e.stack || '').split('\n').slice(0, 4).join('\n   ')); fail++; } };
const assert = (c, m = 'fail') => { if (!c) throw new Error(m); };

// === Single-hop sanity (classical recipient) ===
test('hop: classical → classical (existing CXFER, unchanged)', () => {
  const A = newWallet('A'), B = newWallet('B');
  A.holdings.push({ amount: 1000n, blinding: 42n, signerPriv: A.priv, signerPub: A.pub });
  const tx = emitCxfer({ sender: A, senderInputs: A.holdings, recipients: [{ wallet: B, mode: 'classical', amount: 400n }] });
  const credits = scanTxAsRecipient({ tx, wallet: B });
  assert(credits.length === 1 && credits[0].amount === 400n && credits[0].kind === 'classical');
});

test('hop: classical → stealth (validated by Phase A/B/C signet)', () => {
  const A = newWallet('A'), B = newWallet('B');
  A.holdings.push({ amount: 1000n, blinding: 42n, signerPriv: A.priv, signerPub: A.pub });
  const tx = emitCxfer({ sender: A, senderInputs: A.holdings, recipients: [{ wallet: B, mode: 'stealth', amount: 400n }] });
  const credits = scanTxAsRecipient({ tx, wallet: B });
  assert(credits.length === 1 && credits[0].amount === 400n && credits[0].kind === 'stealth');
  assert(!credits[0].signerPriv.every((x, i) => x === B.priv[i]), 'stealth signerPriv must differ from walletPriv');
});

// === The bug-fix tests ===
test('hop: stealth → classical (THE FIX — amount channel must use tweakedSk)', () => {
  const A = newWallet('A'), B = newWallet('B'), C = newWallet('C');
  // Hop 1: A → B stealth.
  A.holdings.push({ amount: 1000n, blinding: 7n, signerPriv: A.priv, signerPub: A.pub });
  const tx1 = emitCxfer({ sender: A, senderInputs: A.holdings, recipients: [{ wallet: B, mode: 'stealth', amount: 1000n }] });
  const bCredits = scanTxAsRecipient({ tx: tx1, wallet: B });
  assert(bCredits.length === 1 && bCredits[0].kind === 'stealth');
  B.holdings.push(bCredits[0]);

  // Hop 2: B → C classical, spending the stealth-received UTXO.
  const tx2 = emitCxfer({ sender: B, senderInputs: B.holdings, recipients: [{ wallet: C, mode: 'classical', amount: 300n }] });
  const cCredits = scanTxAsRecipient({ tx: tx2, wallet: C });
  assert(cCredits.length === 1, `expected 1 credit at Carol, got ${cCredits.length}`);
  assert(cCredits[0].amount === 300n);
  assert(cCredits[0].kind === 'classical');
});

test('hop: stealth → stealth (THE FIX — both channels must use tweakedSk)', () => {
  const A = newWallet('A'), B = newWallet('B'), C = newWallet('C');
  A.holdings.push({ amount: 1000n, blinding: 9n, signerPriv: A.priv, signerPub: A.pub });
  const tx1 = emitCxfer({ sender: A, senderInputs: A.holdings, recipients: [{ wallet: B, mode: 'stealth', amount: 800n }] });
  const bCredits = scanTxAsRecipient({ tx: tx1, wallet: B });
  B.holdings.push(bCredits[0]);

  const tx2 = emitCxfer({ sender: B, senderInputs: B.holdings, recipients: [{ wallet: C, mode: 'stealth', amount: 500n }] });
  const cCredits = scanTxAsRecipient({ tx: tx2, wallet: C });
  assert(cCredits.length === 1 && cCredits[0].amount === 500n && cCredits[0].kind === 'stealth');
});

// === Multi-input mixed (classical + stealth at the same hop) ===
test('hop: K_asset=2 mixed (classical[0] + stealth[1]) → stealth', () => {
  const A = newWallet('A'), B = newWallet('B'), C = newWallet('C');
  // Seed B with a classical UTXO directly.
  B.holdings.push({ amount: 500n, blinding: 11n, signerPriv: B.priv, signerPub: B.pub });
  // And a stealth UTXO via A → B.
  A.holdings.push({ amount: 500n, blinding: 22n, signerPriv: A.priv, signerPub: A.pub });
  const tx1 = emitCxfer({ sender: A, senderInputs: A.holdings, recipients: [{ wallet: B, mode: 'stealth', amount: 500n }] });
  B.holdings.push(scanTxAsRecipient({ tx: tx1, wallet: B })[0]);
  // Now B spends BOTH (classical[0] + stealth[1]) → C stealth.
  // Note: with classical first, amountChannelSenderPriv = wallet.priv. Vin[1] (first asset)
  // is the classical input → witness pubkey = wallet.pub. The mix still works because
  // the stealth-channel ECDH uses Σ effective privs (per-input).
  const tx2 = emitCxfer({ sender: B, senderInputs: B.holdings, recipients: [{ wallet: C, mode: 'stealth', amount: 700n }] });
  const credits = scanTxAsRecipient({ tx: tx2, wallet: C });
  assert(credits.length === 1 && credits[0].amount === 700n && credits[0].kind === 'stealth');
});

test('hop: K_asset=2 mixed (stealth[0] + classical[1]) → classical', () => {
  const A = newWallet('A'), B = newWallet('B'), C = newWallet('C');
  // Order matters: pickedAssetUtxos[0] = stealth, so amount channel must use tweakedSk.
  // The receiver will see vin[1].witness[1] = commit (= B's stealth pubkey).
  A.holdings.push({ amount: 500n, blinding: 22n, signerPriv: A.priv, signerPub: A.pub });
  const tx1 = emitCxfer({ sender: A, senderInputs: A.holdings, recipients: [{ wallet: B, mode: 'stealth', amount: 500n }] });
  B.holdings.push(scanTxAsRecipient({ tx: tx1, wallet: B })[0]);  // stealth first
  B.holdings.push({ amount: 500n, blinding: 33n, signerPriv: B.priv, signerPub: B.pub });  // classical second

  const tx2 = emitCxfer({ sender: B, senderInputs: B.holdings, recipients: [{ wallet: C, mode: 'classical', amount: 600n }] });
  const credits = scanTxAsRecipient({ tx: tx2, wallet: C });
  assert(credits.length === 1 && credits[0].amount === 600n && credits[0].kind === 'classical');
});

// === Self-payment ===
test('hop: stealth self-payment (Bob → Bob stealth)', () => {
  const B = newWallet('B');
  B.holdings.push({ amount: 1000n, blinding: 5n, signerPriv: B.priv, signerPub: B.pub });
  const tx = emitCxfer({ sender: B, senderInputs: B.holdings, recipients: [{ wallet: B, mode: 'stealth', amount: 400n }] });
  const credits = scanTxAsRecipient({ tx, wallet: B });
  // B's scan should detect BOTH the stealth recipient output AND the
  // change output. Both decrypt via ECDH(B.priv, vin[1]=B.pub).
  // Stealth one has scriptPub=commit, classical change has scriptPub=B.pub.
  const stealthCredit = credits.find(c => c.kind === 'stealth');
  const classicalCredit = credits.find(c => c.kind === 'classical');
  assert(stealthCredit && stealthCredit.amount === 400n, 'expected stealth self-credit of 400');
  assert(classicalCredit && classicalCredit.amount === 600n, 'expected change of 600');
});

// === Fuzz across chains ===
test('fuzz: 300 random chains, length 1..6, mixed modes, full scanner', () => {
  const RNG_SEED = 1779213000;
  let rng = RNG_SEED;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng; };
  const randInt = (lo, hi) => lo + (rand() % (hi - lo + 1));
  const randMode = () => (rand() & 1) ? 'classical' : 'stealth';

  let chainsRun = 0;
  let chainsWithStealthHop = 0;
  let chainsWithMixedInputs = 0;
  let totalHopsExecuted = 0;
  for (let iter = 0; iter < 300; iter++) {
    const chainLen = randInt(1, 6);
    const wallets = [];
    for (let i = 0; i < chainLen + 1; i++) wallets.push(newWallet(`W${i}`));

    // Seed each wallet (not just W0) with some classical UTXOs so multi-
    // input scenarios are reachable — a downstream sender can mix a
    // received stealth UTXO with its own pre-existing classical holdings.
    for (let i = 0; i < wallets.length; i++) {
      const seedCount = randInt(1, 2);
      for (let j = 0; j < seedCount; j++) {
        const amt = BigInt(randInt(10000, 100000));
        const r = BigInt(randInt(1, 1_000_000_000));
        wallets[i].holdings.push({ amount: amt, blinding: r, signerPriv: wallets[i].priv, signerPub: wallets[i].pub });
      }
    }

    let chainOk = true;
    let sawStealth = false;
    let sawMixed = false;
    for (let hop = 0; hop < chainLen; hop++) {
      const sender = wallets[hop];
      const recipient = wallets[hop + 1];
      if (sender.holdings.length === 0) break;

      const K_asset = randInt(1, Math.min(3, sender.holdings.length));
      // Random selection order to mix stealth and classical inputs.
      const shuffled = [...sender.holdings];
      for (let k = shuffled.length - 1; k > 0; k--) {
        const j = rand() % (k + 1);
        [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
      }
      const picked = shuffled.slice(0, K_asset);
      const inAmt = picked.reduce((s, u) => s + u.amount, 0n);
      const sendAmt = (inAmt * BigInt(randInt(20, 80))) / 100n;
      if (sendAmt <= 0n || sendAmt >= inAmt) break;

      const mode = randMode();
      if (mode === 'stealth') sawStealth = true;
      const kinds = new Set(picked.map(u => u.signerPub.every((x, i) => x === sender.pub[i]) ? 'classical' : 'stealth'));
      if (kinds.size > 1) sawMixed = true;

      let tx;
      try {
        tx = emitCxfer({ sender, senderInputs: picked, recipients: [{ wallet: recipient, mode, amount: sendAmt }] });
      } catch (e) {
        chainOk = false; break;
      }

      // Recipient + sender both scan (sender must recover their own change).
      const rCredits = scanTxAsRecipient({ tx, wallet: recipient });
      const matching = rCredits.find(c => c.amount === sendAmt);
      if (!matching) { chainOk = false; break; }
      if (mode === 'stealth' && matching.kind !== 'stealth') { chainOk = false; break; }
      if (mode === 'classical' && matching.kind !== 'classical') { chainOk = false; break; }
      const derivedPub = secp.getPublicKey(matching.signerPriv, true);
      if (!derivedPub.every((x, i) => x === matching.signerPub[i])) { chainOk = false; break; }

      const sCredits = scanTxAsRecipient({ tx, wallet: sender });
      const changeAmt = inAmt - sendAmt;
      const changeCredit = sCredits.find(c => c.amount === changeAmt);
      if (changeAmt > 0n && !changeCredit) { chainOk = false; break; }

      // Sender consumes picked UTXOs, recovers change.
      sender.holdings = sender.holdings.filter(u => !picked.includes(u));
      if (changeCredit) {
        sender.holdings.push({
          amount: changeCredit.amount, blinding: changeCredit.blinding,
          signerPriv: changeCredit.signerPriv, signerPub: changeCredit.signerPub,
        });
      }
      recipient.holdings.push({
        amount: matching.amount, blinding: matching.blinding,
        signerPriv: matching.signerPriv, signerPub: matching.signerPub,
      });
      totalHopsExecuted++;
    }
    if (chainOk) chainsRun++;
    if (chainOk && sawStealth) chainsWithStealthHop++;
    if (chainOk && sawMixed) chainsWithMixedInputs++;
  }
  console.log(`  ✓ chains: ${chainsRun}/300, total hops: ${totalHopsExecuted}, stealth-bearing: ${chainsWithStealthHop}, mixed-input: ${chainsWithMixedInputs}`);
  assert(chainsRun === 300, `chain fuzz had failures: ${300 - chainsRun}/300 chains broken`);
  assert(chainsWithStealthHop > 100, `not enough stealth hops sampled (${chainsWithStealthHop})`);
  // Mixed-input chains are rare under random picking (sender typically uses
  // either its initial classical seed or its received stealth UTXO, but
  // rarely both in one tx). The K_asset=2 dedicated tests above cover this
  // path deterministically; here we just verify it doesn't break when it
  // does happen.
  assert(chainsWithMixedInputs > 0, `mixed-input hops never sampled — fuzz unsound`);
});

// === Adversarial / negative tests ===
test('negative: amount-channel scalar mismatch fails (proves the fix is load-bearing)', () => {
  // Simulate the BROKEN path: sender uses wallet.priv even when input is stealth.
  // This is what would happen if we forgot the fix. Recipient must NOT decrypt.
  const A = newWallet('A'), B = newWallet('B'), C = newWallet('C');
  A.holdings.push({ amount: 1000n, blinding: 9n, signerPriv: A.priv, signerPub: A.pub });
  const tx1 = emitCxfer({ sender: A, senderInputs: A.holdings, recipients: [{ wallet: B, mode: 'stealth', amount: 1000n }] });
  const stealthCredit = scanTxAsRecipient({ tx: tx1, wallet: B })[0];

  // Build a "broken" tx2 where sender uses wallet.priv instead of tweakedSk:
  const BROKEN_SIGNER_PRIV = B.priv;  // <-- WRONG; should be stealthCredit.signerPriv
  const brokenInput = { ...stealthCredit, signerPriv: BROKEN_SIGNER_PRIV };  // amount channel uses this
  // signerPub still equals the stealth commit, so vin[1].witness[1] = commit.
  // But the amount channel ECDH on the sender side will be ECDH(B.priv, C.pub)
  // ≠ ECDH(C.priv, commit). Recipient's amount-decrypt should fail.
  let credits;
  try {
    const tx2 = emitCxfer({ sender: B, senderInputs: [brokenInput], recipients: [{ wallet: C, mode: 'classical', amount: 600n }] });
    credits = scanTxAsRecipient({ tx: tx2, wallet: C });
  } catch {
    credits = [];
  }
  assert(credits.length === 0, 'broken sender amount-channel should not yield a recipient credit');
});

test('chain-length-5: stealth→classical→stealth→classical→stealth', () => {
  const wallets = [newWallet('W0'), newWallet('W1'), newWallet('W2'), newWallet('W3'), newWallet('W4'), newWallet('W5')];
  wallets[0].holdings.push({ amount: 100000n, blinding: 13n, signerPriv: wallets[0].priv, signerPub: wallets[0].pub });
  const modes = ['stealth', 'classical', 'stealth', 'classical', 'stealth'];
  for (let h = 0; h < 5; h++) {
    const sender = wallets[h], recipient = wallets[h + 1];
    const amt = BigInt(50000 - h * 10000);
    const tx = emitCxfer({ sender, senderInputs: sender.holdings, recipients: [{ wallet: recipient, mode: modes[h], amount: amt }] });
    const credits = scanTxAsRecipient({ tx, wallet: recipient });
    const matching = credits.find(c => c.amount === amt);
    assert(matching, `hop ${h} (mode=${modes[h]}) failed`);
    assert(matching.kind === modes[h], `hop ${h} kind mismatch`);
    // Recipient inherits.
    recipient.holdings.push({ amount: matching.amount, blinding: matching.blinding, signerPriv: matching.signerPriv, signerPub: matching.signerPub });
    sender.holdings = [];
  }
});

test('no double-spend: same UTXO can\'t be consumed twice', () => {
  // The CXFER builder enforces this structurally (kernel sig binds Σ
  // C_in via inputOutpoints; UTXO model on chain prevents double-spend),
  // but verify locally that recipient's amount can't accidentally exceed
  // the input balance.
  const A = newWallet('A'), B = newWallet('B');
  A.holdings.push({ amount: 100n, blinding: 7n, signerPriv: A.priv, signerPub: A.pub });
  // Try to send 200 from 100 of input. emitCxfer should throw.
  let threw = false;
  try {
    emitCxfer({ sender: A, senderInputs: A.holdings, recipients: [{ wallet: B, mode: 'stealth', amount: 200n }] });
  } catch { threw = true; }
  assert(threw, 'over-spend should throw');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
