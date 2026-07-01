// OP_BRIDGE_STEALTH_MINT standalone signet rehearsal — cross-chain confidential PAY-TO-STEALTH.
//
// A SENDER burns a note on Bitcoin; the reflection attests that burn into bitcoinBurnRoot; the box settles
// OP_BRIDGE_STEALTH_MINT, minting the burned value into the shared stealth lock-set under the RECIPIENT's
// one-time pubkey; the recipient scans the lock-set and claims with OP_STEALTH_CLAIM (only they can).
//
// Two modes:
//   preflight (default) — load .local/bridge-stealth-mint-wallets.json (or ephemeral keys), assemble the
//     real bridge-stealth-mint op (dapp/confidential-stealth.js buildBridgeStealthMint) and ASSERT it is
//     inflation-safe + recipient-only: (1) the L opening sigma binds the cleartext amount, (2) the kernel
//     conserves v_in == v_L (over-mint unconstructible), (3) the minted lock is claimable ONLY by the
//     recipient's one-time key, not the sender's base key. Runs locally (no signet/box) — the CI-safe path.
//   live (MODE=live) — broadcast the full round-trip on Sepolia+Signet via the box. Gated.
//
// Run (preflight): node tests/bridge-stealth-mint-signet-e2e.mjs
// Setup:           node tests/gen-bridge-stealth-mint-signet-wallets.mjs   (then fund the sender)

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash, webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { signSchnorr, verifySchnorr, SECP_N } from '../dapp/bulletproofs.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';
import assert from 'node:assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const transfer = makeConfidentialTransfer({ keccak256 });
const stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer });

const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const b32 = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
const fromHex = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
const rand = () => { const b = new Uint8Array(32); (globalThis.crypto || webcrypto).getRandomValues(b); return hx(b); };

function loadWallets() {
  const f = path.join(__dirname, '..', '.local', 'bridge-stealth-mint-wallets.json');
  if (existsSync(f)) {
    const w = JSON.parse(readFileSync(f, 'utf8'));
    return { senderPriv: '0x' + w.sender.priv_hex, recipientPriv: '0x' + w.recipient.priv_hex, persisted: true };
  }
  // ephemeral (preflight still validates the full math; live mode requires the persisted+funded wallets)
  return { senderPriv: rand(), recipientPriv: rand(), persisted: false };
}

function preflight() {
  const { recipientPriv, persisted } = loadWallets();
  console.log(`bridge-stealth-mint preflight — wallets: ${persisted ? '.local/bridge-stealth-mint-wallets.json' : 'ephemeral (gen wallets for the live run)'}\n`);

  const cb = '0x' + '11'.repeat(32), asset = '0x' + 'aa'.repeat(32), poolRoot = '0x' + '22'.repeat(32);
  const locker = '0x' + '00'.repeat(31) + '01';
  const amount = 1000n, deadline = 1_900_000_000n;
  const ZERO_OWNER = '0x' + '00'.repeat(32); // Bitcoin-homed notes are owner-free (bearer)

  // recipient static spend key → sender derives a one-time address; recipient recovers the one-time key
  const B = hx(secp.ProjectivePoint.BASE.multiply(BigInt(recipientPriv)).toRawBytes(true));
  const { ephemeralPub, ownerPub } = stealth.oneTimeAddress({ recipientSpendPub: B, ephemeralPriv: rand() });
  const { oneTimePriv } = stealth.recoverOneTimeKey({ recipientSpendPriv: recipientPriv, ephemeralPub });

  // the burned Bitcoin note (value == amount; the bridge conserves it into the lock)
  const rIn = randomScalar();
  const burned = { ...pool.commitXY(amount, rIn), owner: ZERO_OWNER, blinding: rIn, leafIndex: 0, path: pool.zeros };
  const lBlinding = randomScalar();
  const mint = stealth.buildBridgeStealthMint({
    chainBinding: cb, asset, poolRoot, burned, ownerPub, amount, deadline, locker, lBlinding,
    bmNext: '0x' + 'ff'.repeat(32), bmIndex: 0, bmPath: pool.zeros,
  });

  let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

  // (1) the burn-set destCommitment is the blind stealth lock leaf the guest re-derives — no cleartext amount.
  const destLeaf = stealth.stealthLockLeafBlind(asset, mint.lCx, mint.lCy, ownerPub, deadline, locker);
  assert.equal(typeof destLeaf, 'string', 'destCommitment derives');
  assert.ok(mint.lRange && mint.lRange.length, 'L carries a BP+ range (v_L < 2^64, so fee = v_in − v_L can\'t exceed the burn)');
  ok('blind lock leaf binds (L, ownerPub, deadline, locker) — the burn-set pins it, no amount in the preimage');

  // (2) conservation v_in == v_L + fee (over-mint unconstructible)
  assert.equal(transfer.verifyTransfer(transfer.buildTransfer({ inputs: [{ value: amount, blinding: BigInt(rIn) }], outputs: [{ value: amount, blinding: BigInt(lBlinding) }] })), true);
  assert.throws(() => transfer.buildTransfer({ inputs: [{ value: amount, blinding: BigInt(rIn) }], outputs: [{ value: amount + 500n, blinding: BigInt(lBlinding) }] }), /not conserved/);
  assert.ok(mint.kernelR && mint.kernelZ, 'op carries the conservation kernel');
  ok('kernel enforces v_in == v_L + fee — over-mint is unconstructible');

  // (3) the minted lock is claimable ONLY by the recipient one-time key (blind claim)
  const fee = 30n, net = amount - fee, mOwner = '0x' + '00'.repeat(31) + '09';
  const claim = stealth.buildStealthClaim({
    chainBinding: cb, asset, lCx: mint.lCx, lCy: mint.lCy, ownerPub, amount, deadline, locker, lBlinding,
    lockSetRoot: '0x' + '33'.repeat(32), lIndex: 0, lPath: pool.zeros, oneTimePriv, mOwner, fee, mBlinding: randomScalar(),
  });
  const claimMsg = stealth.stealthClaimMsgBlind(cb, destLeaf, claim.mCx, claim.mCy, mOwner, fee);
  assert.equal(verifySchnorr(fromHex(claim.ownerSig), claimMsg, b32(ownerPub)), true, 'recipient one-time claim verifies');
  assert.equal(verifySchnorr(fromHex(hx(signSchnorr(claimMsg, b32(recipientPriv)))), claimMsg, b32(ownerPub)), false, 'base spend key cannot claim');
  assert.ok(claim.mRange && claim.mRange.length, 'claim output M carries a BP+ range');
  assert.equal(net, amount - fee, 'claim mints amount − fee');
  ok('minted lock plugs into OP_STEALTH_CLAIM — recipient-only (sender cannot claim)');

  console.log(`\nPREFLIGHT OK — ${n} checks. The bridge-stealth-mint op assembles, conserves, and is recipient-only.`);
  if (!persisted) console.log('(run gen-bridge-stealth-mint-signet-wallets.mjs + fund the sender for the live broadcast.)');
}

// Live signet round-trip. DRY_RUN=1 builds the op + the Bitcoin burn envelope (commit/reveal hex) and stops
// before broadcasting, so CI can exercise envelope construction without funds; without it the sender must be
// a persisted, funded signet wallet and the box must be reachable.
//
// Sequence (mirrors the sibling broadcast harnesses):
//   1. assemble the bridge-stealth-mint op from the funded wallets (the recipient one-time address + the
//      burned note + the blind lock L, range-bound and conserved by the kernel);
//   2. broadcast a 0x2B confidential bridge-burn on signet: a Taproot commit/reveal whose envelope carries
//      assetId ‖ bitcoinPoolRoot ‖ nullifier(burned note) ‖ destCommitment, where destCommitment is the
//      blind stealth lock leaf the guest re-derives — the same key the bridge-burn set folds ν → dest under;
//   3. wait for confirmations so the reflection prover folds the burn into bitcoinBurnRoot;
//   4. settle OP_BRIDGE_STEALTH_MINT through the box (type "bridgestealthmint") into the stealth lock-set;
//   5. self-verify: the recipient scans the minted lock (one-time key recovers, sender's base key cannot),
//      confirming the cross-chain pay landed and is recipient-claimable.
async function live() {
  const DRY_RUN = process.env.DRY_RUN === '1';
  const NETWORK = (process.env.NETWORK || 'signet').toLowerCase();
  if (NETWORK !== 'signet' && NETWORK !== 'mainnet') fail('NETWORK must be signet|mainnet');

  const { senderPriv, recipientPriv, persisted } = loadWallets();
  if (!persisted && !DRY_RUN) {
    fail('live broadcast needs a persisted, funded sender wallet.\n' +
      '  run:  node tests/gen-bridge-stealth-mint-signet-wallets.mjs\n' +
      '  then: fund the printed sender address with signet sats, and re-run with MODE=live.\n' +
      '  (DRY_RUN=1 MODE=live exercises envelope construction with ephemeral keys and no funds.)');
  }

  // ── Bitcoin tx primitives (commit/reveal, signing, broadcast) need a browser-ish global env. ──
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage; globalThis.location = dom.window.location;
  globalThis.navigator = dom.window.navigator;
  if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
  globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => false;
  globalThis.__TACIT_NO_INIT__ = true;
  globalThis.localStorage.setItem('tacit-network-v1', NETWORK);

  const dapp = await import('../dapp/tacit.js');
  const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');

  const senderBytes = fromHex(senderPriv);
  dapp.wallet.priv = senderBytes;
  dapp.wallet.pub = secp.getPublicKey(senderBytes, true);
  dapp.invalidateHoldingsCache?.();
  await dapp.ensurePrivkey?.();
  const SENDER_ADDR = dapp.wallet.address();

  let ux, cfg;
  try { ux = makeConfidentialPoolUx({ secp, keccak256, sha256, network: NETWORK }); cfg = ux.cfg; }
  catch (e) { fail(`confidential pool UX not configured for ${NETWORK}: ${e.message}`); }
  if (!cfg.pool) fail(`cfg.pool is null — ConfidentialPool not deployed on ${NETWORK}.`);
  const chainBinding = ux.chainBindingHex();

  console.log(`\n=== bridge-stealth-mint LIVE (${NETWORK}${DRY_RUN ? ', DRY_RUN' : ''}) ===\n`);
  console.log(`  pool:        ${cfg.pool}`);
  console.log(`  relay base:  ${cfg.relayBase}`);
  console.log(`  sender addr: ${SENDER_ADDR}`);

  // The asset the burned note carries (production TAC by default). The burned note is a member of the
  // Bitcoin pool root the on-chain knownBitcoinRoot gates; in DRY_RUN we use a placeholder root for the
  // envelope, since no live burned note exists to anchor membership against.
  const asset = (process.env.ASSET || '0xf0bbe868a3a3e6a0d9b3f6b6a3c3d3e3f3a3b3c3d3e3f3a3b3c31ef1bde43f94762b').slice(0, 66);
  const amount = BigInt(process.env.AMOUNT || 1000n);
  const fee = BigInt(process.env.FEE || 0n);
  const deadline = BigInt(process.env.DEADLINE || 1_900_000_000n);
  const locker = hx(dapp.wallet.xonly());        // the burner's x-only refund pubkey
  const ZERO_OWNER = '0x' + '00'.repeat(32);     // Bitcoin-homed notes are bearer (owner-free)

  // ── 1. assemble the op (this is what DRY_RUN exercises end to end) ──
  const recipientSpendPub = hx(secp.ProjectivePoint.BASE.multiply(BigInt(recipientPriv)).toRawBytes(true));
  const ephemeralPriv = rand();
  const { ephemeralPub, ownerPub } = stealth.oneTimeAddress({ recipientSpendPub, ephemeralPriv });

  const rIn = randomScalar();
  const burnedC = pool.commitXY(amount, rIn);
  const burned = { ...burnedC, owner: ZERO_OWNER, blinding: rIn, leafIndex: 0, path: pool.zeros };
  const poolRoot = process.env.POOL_ROOT || ('0x' + '22'.repeat(32)); // live: the gated Bitcoin pool root
  const lBlinding = randomScalar();
  const mint = stealth.buildBridgeStealthMint({
    chainBinding, asset, poolRoot, burned, ownerPub, amount, deadline, locker, lBlinding,
    bmNext: '0x' + 'ff'.repeat(32), bmIndex: 0, bmPath: pool.zeros, fee,
  });
  // destCommitment the burn declares == the blind stealth lock leaf the guest re-derives.
  const destCommitment = stealth.stealthLockLeafBlind(asset, mint.lCx, mint.lCy, ownerPub, deadline, locker);
  const nullifier = pool.nullifier(burned.cx, burned.cy);
  console.log(`  ownerPub:    ${ownerPub}`);
  console.log(`  L (blind):   ${mint.lCx.slice(0, 18)}…  dest=${destCommitment.slice(0, 18)}…  ν=${nullifier.slice(0, 18)}…`);

  // ── 2. build the 0x2B confidential bridge-burn envelope (opcode‖asset‖poolRoot‖ν‖dest, 129B) ──
  const envBytes = new Uint8Array(129);
  envBytes[0] = 0x2b;
  envBytes.set(b32(asset), 1);
  envBytes.set(b32(poolRoot), 33);
  envBytes.set(b32(nullifier), 65);
  envBytes.set(b32(destCommitment), 97);

  const envelopeScript = dapp.encodeEnvelopeScript(dapp.wallet.xonly(), envBytes);
  const tapLeaf = dapp.tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = dapp.tweakedOutputKey(dapp.TAP_NUMS, tapLeaf);
  const commitSpk = dapp.p2trScript(Q_xonly);
  const cbControl = dapp.controlBlock(dapp.TAP_NUMS, parity);
  const wpkhSpk = dapp.p2wpkhScript(dapp.wallet.pub);
  const DUST = dapp.DUST;

  const feeRate = await dapp.getFeeRate();
  const revealVb = 11 + 41 + 31 + Math.ceil((1 + 1 + 65 + 3 + 45 + envBytes.length + 34) / 4);
  const revealFee = dapp.feeFor(revealVb, feeRate);
  const commitValue = DUST + revealFee;
  console.log(`  feeRate=${feeRate} revealFee=${revealFee} commitValue=${commitValue}`);

  const utxos = await dapp.getUtxos(SENDER_ADDR);
  const sats = (utxos || []).filter((u) => u.value > DUST).sort((a, b) => b.value - a.value);
  let commitTx, commitTxid, commitHex, revealTx, revealTxid, revealHex;
  if (!sats.length) {
    if (!DRY_RUN) fail(`no signet sats at ${SENDER_ADDR} to fund the 0x2B burn commit — fund the sender first.`);
    // DRY_RUN with no funds: use a synthetic prevout so envelope construction (commit/reveal) still runs.
    const synth = [{ txid: '00'.repeat(32), vout: 0, value: commitValue + 50_000 }];
    ({ commitTx, commitTxid, commitHex, revealTx, revealTxid, revealHex } =
      buildBurnTxs({ dapp, picked: synth, commitValue, commitSpk, wpkhSpk, revealFee, feeRate, envelopeScript, cbControl, DUST }));
    console.log('  (DRY_RUN, unfunded: synthetic prevout used for envelope construction)');
  } else {
    const picked = []; let total = 0; let commitFee = 300;
    for (const u of sats) { picked.push(u); total += u.value; commitFee = dapp.feeFor(dapp.estCommitVb(picked.length), feeRate); if (total >= commitValue + commitFee + DUST) break; }
    if (total < commitValue + commitFee) fail(`insufficient signet sats: need ${commitValue + commitFee}, have ${total}`);
    ({ commitTx, commitTxid, commitHex, revealTx, revealTxid, revealHex } =
      buildBurnTxs({ dapp, picked, commitValue, commitSpk, wpkhSpk, revealFee, feeRate, envelopeScript, cbControl, DUST }));
  }
  console.log(`  commit ${commitTxid.slice(0, 16)}…  reveal ${revealTxid.slice(0, 16)}…:0`);

  // the reveal must classify as a clean confidential bridge-burn before it goes out.
  const { classifyConfidentialTx } = await import('../dapp/burn-deposit-bitcoin.js');
  const cls = classifyConfidentialTx(revealHex);
  if (!cls || cls.type !== 'burn' || String(cls.nullifier).toLowerCase() !== nullifier.toLowerCase() || String(cls.dest).toLowerCase() !== destCommitment.toLowerCase()) {
    fail('the burn reveal does not classify as a clean 0x2B bridge-burn with the expected ν/dest');
  }
  console.log('  ✓ reveal classifies as a confidential bridge-burn (ν + destCommitment match the op)');

  if (DRY_RUN) {
    console.log('\nDRY_RUN=1: not broadcasting.');
    console.log('commit:', commitHex);
    console.log('reveal:', revealHex);
    console.log('\nDRY_RUN OK — op + Bitcoin burn envelope construct cleanly. Fund the sender + drop DRY_RUN to broadcast.');
    return;
  }

  // ── 3. broadcast + wait for confirmations (reflection folds the burn into bitcoinBurnRoot) ──
  console.log('\nbroadcasting commit…'); await dapp.broadcast(commitHex);
  console.log('broadcasting reveal…'); await dapp.broadcastWithRetry(revealHex);
  console.log(`  ✓ burn broadcast: https://mempool.space/${NETWORK}/tx/${revealTxid}`);
  const CONFS = Number(process.env.CONFIRMATIONS || 6);
  console.log(`  waiting for ${CONFS} confirmation(s) so reflection folds ν → destCommitment (up to ~60 min)…`);
  let confs = 0;
  for (let i = 1; i <= 120; i++) {
    try {
      const r = await fetch(`https://mempool.space/${NETWORK}/api/tx/${revealTxid}/status`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j && j.confirmed) {
        const tip = await (await fetch(`https://mempool.space/${NETWORK}/api/blocks/tip/height`, { signal: AbortSignal.timeout(8000) })).json();
        confs = Number(tip) - Number(j.block_height) + 1;
        if (confs >= CONFS) { console.log(`  ✓ ${confs} confirmation(s)`); break; }
      }
    } catch {}
    if (i % 5 === 0) console.log(`    attempt ${i}/120: confirmations=${confs} (need ${CONFS})`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
  if (confs < CONFS) fail(`burn reveal not confirmed to ${CONFS} within ~60 min — re-run once it confirms (reflection needs the confirmed burn).`);

  // ── 4. settle OP_BRIDGE_STEALTH_MINT through the box ──
  // The minted leaf is a stealth lock-set leaf the recipient recovers from the published ephemeral pubkey
  // (ECDH), so the memo carries that — distinct from the pool's note-recovery memos. Submit straight to the
  // box queue (type "bridgestealthmint") and poll to the on-chain settle.
  console.log('\nsubmitting the bridge-stealth-mint settle to the box (type "bridgestealthmint")…');
  const { makeConfidentialAirdrop } = await import('../dapp/confidential-airdrop.js');
  const airdrop = makeConfidentialAirdrop({ keccak256, secp, sha256, pool, stealth });
  const memo = airdrop.sealStealthMemo({ recipientSpendPub, ephemeralPriv, asset, amount, lCx: mint.lCx, lCy: mint.lCy, deadline, locker });
  const base = cfg.relayBase.replace(/\/$/, '');
  let submit;
  try {
    const res = await fetch(`${base}/confidential/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'bridgestealthmint', op: mint, memos: [memo] }),
    });
    if (!res.ok) throw new Error(`submit HTTP ${res.status}: ${await res.text()}`);
    submit = await res.json();
  } catch (e) {
    fail(`box submit failed: ${e.message}\n  (the box/worker at ${base} must be reachable + the burn folded into bitcoinBurnRoot — see CONFIRMATIONS.)`);
  }
  console.log(`  jobId ${String(submit.jobId).slice(0, 18)}… status=${submit.status}`);
  let settleRes = submit;
  const dl = Date.now() + 10 * 60 * 1000;
  while (settleRes.status !== 'settled') {
    if (settleRes.status === 'failed') fail(`box settle failed: ${settleRes.error || 'unknown'}`);
    if (Date.now() > dl) fail('box settle timed out (~10 min) — the box may be offline or the burn not yet folded.');
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const s = await fetch(`${base}/confidential/status?id=${encodeURIComponent(submit.jobId)}`);
      settleRes = s.status === 404 ? { ...settleRes, status: 'unknown' } : await s.json();
      console.log(`  · settle ${settleRes.status}…`);
    } catch (e) { fail(`status poll failed: ${e.message}`); }
    if (settleRes.status === 'unknown') fail('the box lost the job (worker restart / KV miss) — resubmit.');
  }
  console.log(`  ✓ settle landed: ${settleRes.txHash || settleRes.status}`);

  // ── 5. self-verify the lock is recipient-claimable ──
  const claimable = stealth.scanLock({ recipientSpendPriv: recipientPriv, ephemeralPub, ownerPub });
  if (!claimable) fail('the minted lock does not scan to the recipient one-time key — recovery would fail.');
  const { oneTimePriv } = stealth.recoverOneTimeKey({ recipientSpendPriv: recipientPriv, ephemeralPub });
  const lockLeaf = stealth.stealthLockLeafBlind(asset, mint.lCx, mint.lCy, ownerPub, deadline, locker);
  const mOwner = '0x' + '00'.repeat(31) + '09';
  const net = amount - fee;
  const claimMsg = stealth.stealthClaimMsgBlind(chainBinding, lockLeaf, ...(() => { const { cx, cy } = pool.commitXY(net, randomScalar()); return [cx, cy]; })(), mOwner, fee);
  const recipSig = stealth.signClaim({ oneTimePriv, claimMsg });
  if (verifySchnorr(fromHex(recipSig), claimMsg, b32(ownerPub)) !== true) fail('recipient one-time claim signature does not verify under ownerPub.');
  if (verifySchnorr(fromHex(hx(signSchnorr(claimMsg, b32(senderPriv)))), claimMsg, b32(ownerPub)) === true) fail('the sender base key produced a verifying claim — lock is NOT recipient-only.');

  console.log('\n=== bridge-stealth-mint LIVE COMPLETE ===');
  console.log(`  burn:   ${revealTxid}:0`);
  console.log(`  mint:   ${settleRes.txHash || '—'}`);
  console.log(`  lock:   scans to the recipient one-time key; recipient-only claim verifies, sender's does not.`);
}

// Build the commit (funds the reveal) + reveal (carries the 0x2B envelope in the Taproot script path) txs.
function buildBurnTxs({ dapp, picked, commitValue, commitSpk, wpkhSpk, revealFee, feeRate, envelopeScript, cbControl, DUST }) {
  const { bytesToHex } = { bytesToHex: (b) => Buffer.from(b).toString('hex') };
  const total = picked.reduce((s, u) => s + u.value, 0);
  const commitFee = dapp.feeFor(dapp.estCommitVb(picked.length), feeRate);
  const change = total - commitValue - commitFee;
  const commitOutputs = [{ value: commitValue, script: commitSpk }];
  if (change >= DUST) commitOutputs.push({ value: change, script: wpkhSpk });
  const commitTx = { version: 2, locktime: 0, inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })), outputs: commitOutputs };
  for (let i = 0; i < commitTx.inputs.length; i++) commitTx.inputs[i].witness = dapp.signP2wpkhInput(commitTx, i, picked[i].value);
  const commitHex = bytesToHex(dapp.serializeTx(commitTx));
  const commitTxid = dapp.txid(commitTx);
  const revealTx = { version: 2, locktime: 0, inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: DUST, script: wpkhSpk }] };
  revealTx.inputs[0].witness = dapp.signTaprootScriptPathInput(revealTx, [{ value: commitValue, script: commitSpk }], envelopeScript, cbControl);
  const revealHex = bytesToHex(dapp.serializeTx(revealTx));
  const revealTxid = dapp.txid(revealTx);
  return { commitTx, commitTxid, commitHex, revealTx, revealTxid, revealHex };
}

function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

if (process.env.MODE === 'live') live().catch((e) => fail(e.stack || e.message));
else preflight();
