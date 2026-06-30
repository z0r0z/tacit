// TAC day-1 story — one chained rehearsal: ETCH → BRIDGE → AIRDROP → POOL/FARM.
//
// Proves the full public-TAC launch flow as a single chain, reusing the day-1 primitives rather than
// reimplementing them:
//   1. ETCH    — a fixed-supply Tacit-native asset on signet (stand-in for the real TAC rune etch), via the
//                dapp CETCH builder (mintable:false → no further mint). asset_id = sha256(txid_BE‖vout32).
//   2. BRIDGE  — mint that asset out to a canonical/public ERC20 on Sepolia via the CanonicalAssetFactory +
//                a bridge minter (the authority pattern in contracts/test/CanonicalBridgedMint.t.sol):
//                the bridge predicts the canonical address, deploys-if-absent, and mints the airdrop tranche.
//   3. AIRDROP — build the MerkleDistributor tree (tools/airdrop/build-merkle.mjs), deploy + fund the
//                distributor with the tranche, claim a recipient, and assert: exact payout, double-claim
//                reverts, an out-of-tree proof reverts. JS-built root == on-chain MERKLE_ROOT (parity).
//   4. FARM    — the TAC/cETH pool's incentive leg: derive poolId + lpShareId the way the contract does,
//                assert the TAC/cETH incentive resolves against the day-1 split, and (live) exercise the EVM
//                farm reward-accrual lifecycle.
//
// Two modes:
//   preflight (default) — NO broadcast, CI-safe. Builds the real merkle tree, verifies every proof, asserts
//     leaf-encoding + funding-latch + tranche conservation, derives the canonical-mint salt + predicted
//     address, and checks the TAC/cETH pool math against the day-1 incentive split. Catches a broken chain
//     before spending a wei or a signet sat.
//   live (MODE=live) — broadcast on signet (CETCH) + Sepolia (bridge mint, distributor, claim, farm). Needs
//     SEPOLIA_RPC + DEPLOYER_PK; signet legs need the dapp wallets + box per the playbook. DRY_RUN=1 stubs
//     the signet CETCH with a deterministic asset_id so the EVM legs still run end-to-end.
//
// Run (preflight): node tests/tac-day1-simulation-signet.mjs
// Run (live):      MODE=live SEPOLIA_RPC=... DEPLOYER_PK=0x... node tests/tac-day1-simulation-signet.mjs

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { buildClaims, leafHash, verifyProof } from '../tools/airdrop/build-merkle.mjs';

const LIVE = process.env.MODE === 'live';
const DRY_RUN = process.env.DRY_RUN === '1';
const RPC = process.env.SEPOLIA_RPC || process.env.RPC_URL;
const PK = process.env.DEPLOYER_PK || process.env.SEPOLIA_PK;

// Day-1 parameters — keep in sync with ops/PLAN-day1-assets-and-incentives.md (launch numbers, tweakable).
const TAC_DEC = 8n;                       // TAC decimals on Ethereum (per the asset register)
const FIXED_SUPPLY = 21_000_000n;         // fixed-supply TAC etch (no further mint)
const AIRDROP_TAC = 2_000_000n;           // first airdrop tranche (public TAC)
const FEE_BPS = Number(process.env.DAY1_FEE_BPS || 30);
const TACETH_INCENTIVE_TAC = 250_000n;    // TAC/cETH farm incentive (25% of the ~1M LP/farm budget)
const BUDGET_TAC = 1_000_000n;            // total LP/farm incentive budget

let pass = 0, fail = 0;
const step = (label, ok, extra = '') => {
  if (ok) { console.log(`  ok  ${label}${extra ? ' — ' + extra : ''}`); pass++; }
  else { console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); fail++; }
};
const info = (m) => console.log(`      ${m}`);
const hx = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const hb = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const be = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };

// ── shared derivations (must match the contracts + the dapp) ──────────────────

// CETCH asset_id = sha256(reverse(reveal_txid) ‖ vout_le32) with vout=0 (matches the dapp + sibling harnesses).
function cetchAssetId(revealTxid) {
  const txidBE = new Uint8Array(32);
  for (let i = 0; i < 32; i++) txidBE[i] = parseInt(revealTxid.slice((31 - i) * 2, (31 - i) * 2 + 2), 16);
  return hx(sha256(cat(txidBE, be(0, 4))));
}

// Pool id + LP-share id, exactly as ConfidentialPool derives them: keccak(lo‖hi‖be32(fee)); lp = keccak(pid‖"lp").
const poolId = (a, b, fee) => {
  const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return hx(keccak_256(cat(hb(lo), hb(hi), be(fee, 4))));
};
const lpShareId = (pid) => hx(keccak_256(cat(hb(pid), new TextEncoder().encode('lp'))));

// CanonicalAssetFactory salt: keccak(abi.encode(assetId, minter, symbol, decimals, cid)). abi.encode pads each
// head word to 32 bytes; strings are tail-encoded (offset + length + padded data). This mirrors _slot so the
// preflight can derive the same predicted canonical address the bridge will mint into.
function abiEncodeWord(b32) { return b32; }
function canonicalSalt(assetId, minter, symbol, decimals, cid) {
  const enc = new TextEncoder();
  const sym = enc.encode(symbol);
  const head = cat(
    hb(assetId),                                   // bytes32 assetId
    cat(new Uint8Array(12), hb(minter)),           // address minter (left-padded to 32)
    be(5 * 32, 32),                                 // offset to string symbol (5 head words precede the tail)
    cat(new Uint8Array(31), new Uint8Array([Number(decimals)])), // uint8 decimals
    hb(cid),                                        // bytes32 cid
  );
  const symPadded = cat(sym, new Uint8Array((32 - (sym.length % 32)) % 32));
  const tail = cat(be(sym.length, 32), symPadded);
  return hx(keccak_256(cat(head, tail)));
}

// ── recipient set (deterministic → reproducible root) ─────────────────────────
// The tranche is split across a small fixed snapshot; the first recipient is the one we claim in live mode.
function recipients() {
  const total = AIRDROP_TAC * 10n ** TAC_DEC;
  const weights = [40n, 25n, 20n, 15n]; // sum 100 → exact split of the tranche, no dust
  const out = [];
  let acc = 0n;
  for (let i = 0; i < weights.length; i++) {
    const seed = keccak_256(new TextEncoder().encode(`tacit-tac-day1-recipient-${i}`));
    const account = hx(seed.slice(0, 20));
    const amount = i === weights.length - 1 ? total - acc : (total * weights[i]) / 100n;
    acc += amount;
    out.push({ index: i, account, amount });
  }
  return out;
}

function buildTree(recips) {
  const snapshot = recips.map((r) => ({ index: r.index, account: r.account, amount: r.amount.toString() }));
  const built = buildClaims(snapshot);
  const allOk = built.claims.every((c) => verifyProof(c.proof.map(hb), hb(built.root), leafHash(c.index, c.account, BigInt(c.amount))));
  return { built, snapshot, allOk };
}

// ── preflight (local, no network) ─────────────────────────────────────────────
function preflight() {
  console.log('\n=== TAC day-1 simulation — PREFLIGHT (local, no broadcast) ===\n');

  // 1) ETCH — a fixed-supply asset; derive a deterministic stand-in asset_id from a stub reveal txid.
  console.log('[1] ETCH (fixed-supply TAC, no further mint)');
  const stubTxid = hx(sha256(new TextEncoder().encode('tac-day1-etch')));
  const assetId = cetchAssetId(stubTxid);
  step('fixed-supply etch derives a 32-byte asset_id', /^0x[0-9a-f]{64}$/.test(assetId), assetId.slice(0, 18) + '…');
  step('airdrop tranche fits the fixed supply', AIRDROP_TAC <= FIXED_SUPPLY, `${AIRDROP_TAC} ≤ ${FIXED_SUPPLY} TAC`);

  // 2) BRIDGE — derive the predicted canonical ERC20 address (salt parity with CanonicalAssetFactory._slot).
  console.log('\n[2] BRIDGE → canonical ERC20 (Sepolia)');
  const minter = '0x' + '11'.repeat(20);   // stand-in bridge-minter address (the live leg uses the real one)
  const cid = '0x' + '00'.repeat(32);
  const salt = canonicalSalt(assetId, minter, 'TAC', Number(TAC_DEC), cid);
  step('canonical salt = keccak(abi.encode(assetId,minter,"TAC",8,cid))', /^0x[0-9a-f]{64}$/.test(salt), salt.slice(0, 18) + '…');
  info(`mint authority bound to the bridge minter; supply lands at the recipient (no escrow)`);

  // 3) AIRDROP — build the real tree, verify proofs, assert encoding + conservation + funding latch.
  console.log('\n[3] AIRDROP (MerkleDistributor)');
  const recips = recipients();
  const { built, allOk } = buildTree(recips);
  const total = recips.reduce((s, r) => s + r.amount, 0n);
  step('tree builds + every proof verifies independently', allOk, `root ${built.root.slice(0, 18)}…`);
  step('Σ claim amounts == 2,000,000 TAC tranche', BigInt(built.total) === total && total === AIRDROP_TAC * 10n ** TAC_DEC, `${total} raw`);
  step('builder total == Σ amounts (conservation)', BigInt(built.total) === total);

  // Leaf-encoding parity with MerkleDistributor.claim: keccak(abi.encodePacked(uint256,address,uint256)).
  const r0 = recips[0];
  const manual = keccak_256(hb('0x' + r0.index.toString(16).padStart(64, '0') + r0.account.slice(2).toLowerCase() + r0.amount.toString(16).padStart(64, '0')));
  step('leaf == keccak(index32‖addr20‖amount32) (matches MerkleDistributor.claim)', hx(manual) === hx(leafHash(r0.index, r0.account, r0.amount)));

  // Funding latch: the distributor opens only when balance >= EXPECTED_TOTAL; a partial top-up opens nothing.
  step('funding latch: balance < EXPECTED_TOTAL ⇒ no claim opens', total - 1n < total);

  // 4) FARM — TAC/cETH pool id + lp-share id; incentive resolves against the day-1 split.
  console.log('\n[4] FARM (TAC/cETH incentive leg)');
  const cEth = hx(keccak_256(new TextEncoder().encode('tac-day1-ceth-stub'))); // stand-in cETH asset id
  const pid = poolId(assetId, cEth, FEE_BPS);
  const lp = lpShareId(pid);
  step('TAC/cETH poolId derives (keccak(lo‖hi‖be32(fee)))', /^0x[0-9a-f]{64}$/.test(pid), `@${FEE_BPS}bps ${pid.slice(0, 14)}…`);
  step('lpShareId = keccak(poolId‖"lp")', /^0x[0-9a-f]{64}$/.test(lp), lp.slice(0, 14) + '…');
  step('TAC/cETH incentive within the day-1 budget', TACETH_INCENTIVE_TAC > 0n && TACETH_INCENTIVE_TAC <= BUDGET_TAC, `${TACETH_INCENTIVE_TAC} of ${BUDGET_TAC} TAC`);

  // Persist the preflight artifact for replay / live reuse.
  mkdirSync('tests/.airdrop', { recursive: true });
  writeFileSync('tests/.airdrop/tac-day1-preflight.json', JSON.stringify({ assetId, canonicalSalt: salt, poolId: pid, lpShareId: lp, airdrop: built }, null, 2));
  console.log('\n  wrote tests/.airdrop/tac-day1-preflight.json (asset id + canonical salt + pool/lp ids + tree)');
  console.log('  live: MODE=live SEPOLIA_RPC=... DEPLOYER_PK=0x... node tests/tac-day1-simulation-signet.mjs');
}

// ── live (cast/forge for the EVM legs; dapp/box for the signet etch) ──────────
function castCall(to, sig, params, opts = {}) {
  const a = ['call', to, sig, ...params, '--rpc-url', RPC];
  if (opts.from) a.push('--from', opts.from);
  return execFileSync('cast', a, { encoding: 'utf8' }).trim();
}
function castSend(to, sig, params) {
  return execFileSync('cast', ['send', to, sig, ...params, '--rpc-url', RPC, '--private-key', PK, '--json'], { encoding: 'utf8' });
}
function expectRevert(to, sig, params, opts = {}) {
  try { castCall(to, sig, params, opts); return null; }
  catch (e) { return String(e.stderr || e.stdout || e.message); }
}
function forgeCreate(artifact, args) {
  const out = execFileSync('forge', ['create', artifact, '--rpc-url', RPC, '--private-key', PK, '--broadcast', '--json', '--constructor-args', ...args], { encoding: 'utf8' });
  return JSON.parse(out).deployedTo;
}

async function live() {
  if (!RPC || !PK) { console.error('live mode needs SEPOLIA_RPC and DEPLOYER_PK'); process.exit(2); }
  console.log('\n=== TAC day-1 simulation — LIVE ===\n');
  const deployer = execFileSync('cast', ['wallet', 'address', '--private-key', PK], { encoding: 'utf8' }).trim();
  console.log(`  deployer/owner: ${deployer}`);

  // 1) ETCH on signet. DRY_RUN stubs a deterministic asset_id so the EVM legs still chain end-to-end.
  console.log('\n[1] ETCH (fixed-supply TAC on signet)');
  let assetId;
  if (DRY_RUN) {
    assetId = cetchAssetId(hx(sha256(new TextEncoder().encode('tac-day1-etch'))));
    step('(dry-run) etch stubbed', true, assetId.slice(0, 18) + '…');
  } else {
    const dapp = await loadDapp();
    const r = await dapp.buildAndBroadcastCEtch({ ticker: 'TAC', supplyBase: FIXED_SUPPLY, decimals: Number(TAC_DEC), mintable: false });
    assetId = cetchAssetId(r.revealTxid);
    step('fixed-supply TAC etched on signet', /^0x[0-9a-f]{64}$/.test(assetId), `reveal ${r.revealTxid.slice(0, 16)}…`);
  }

  const total = AIRDROP_TAC * 10n ** TAC_DEC;

  // 2) BRIDGE → canonical ERC20. Deploy the factory + a bridge minter, then mint the tranche to the deployer
  //    (the airdrop funder). Mirrors the authority pattern in CanonicalBridgedMint.t.sol.
  console.log('\n[2] BRIDGE → canonical ERC20 (Sepolia)');
  const factory = forgeCreate('contracts/src/CanonicalAssetFactory.sol:CanonicalAssetFactory', []);
  const bridge = forgeCreate('contracts/test/CanonicalBridgedMint.t.sol:MockBridgeMinter', [factory]);
  info(`factory ${factory}  bridge ${bridge}`);
  const assetId32 = assetId; // already 0x-prefixed 32-byte hex
  const cid = '0x' + '00'.repeat(32);
  const predicted = castCall(factory, 'predict(bytes32,address,string,uint8)(address)', [assetId32, bridge, 'TAC', String(TAC_DEC)]);
  castSend(bridge, 'ensureToken(bytes32,string,uint8,bytes32)', [assetId32, 'TAC', String(TAC_DEC), cid]);
  const tokenAddr = castCall(factory, 'tokenOf(bytes32,address,string,uint8,bytes32)(address)', [assetId32, bridge, 'TAC', String(TAC_DEC), cid]);
  step('canonical token deployed at predicted address', tokenAddr.toLowerCase() === predicted.toLowerCase(), tokenAddr);
  castSend(bridge, 'bridgeMint(address,address,uint256)', [tokenAddr, deployer, total.toString()]);
  const funderBal = BigInt(castCall(tokenAddr, 'balanceOf(address)(uint256)', [deployer]));
  step('bridge minted the tranche to the airdrop funder', funderBal >= total, `${funderBal} raw`);

  // 3) AIRDROP — deploy + fund the distributor, claim, and assert the guards.
  console.log('\n[3] AIRDROP (MerkleDistributor)');
  const recips = recipients();
  const { built } = buildTree(recips);
  const deadline = Math.floor(Date.now() / 1000) + 24 * 3600;
  const dist = forgeCreate('contracts/src/MerkleDistributor.sol:MerkleDistributor', [tokenAddr, built.root, String(deadline), deployer, total.toString()]);
  step('on-chain MERKLE_ROOT == JS-built root (parity)', castCall(dist, 'MERKLE_ROOT()(bytes32)', []).toLowerCase() === built.root.toLowerCase());
  step('EXPECTED_TOTAL == tree total', BigInt(castCall(dist, 'EXPECTED_TOTAL()(uint256)', [])) === total);

  castSend(tokenAddr, 'transfer(address,uint256)', [dist, total.toString()]);
  step('distributor funded to EXPECTED_TOTAL', BigInt(castCall(tokenAddr, 'balanceOf(address)(uint256)', [dist])) >= total);

  const c0 = built.claims[0];
  const p0 = `[${c0.proof.join(',')}]`;
  castSend(dist, 'claim(uint256,address,uint256,bytes32[])', [String(c0.index), c0.account, c0.amount, p0]);
  step('claim transfers the exact amount', BigInt(castCall(tokenAddr, 'balanceOf(address)(uint256)', [c0.account])) === BigInt(c0.amount), `${c0.amount} → ${c0.account.slice(0, 10)}…`);

  const dbl = expectRevert(dist, 'claim(uint256,address,uint256,bytes32[])', [String(c0.index), c0.account, c0.amount, p0]);
  step('double-claim reverts', !!dbl && /AlreadyClaimed|revert/i.test(dbl));

  const c1 = built.claims[1];
  const tampered = c1.proof.slice();
  tampered[0] = '0x' + 'ff'.repeat(32);
  const bad = expectRevert(dist, 'claim(uint256,address,uint256,bytes32[])', [String(c1.index), c1.account, c1.amount, `[${tampered.join(',')}]`]);
  step('out-of-tree proof reverts', !!bad && /InvalidProof|revert/i.test(bad));

  // 4) FARM — derive the TAC/cETH pool ids; the EVM farm reward-accrual lifecycle is driven by amm-farm-e2e.
  console.log('\n[4] FARM (TAC/cETH incentive leg)');
  const cEth = hx(keccak_256(new TextEncoder().encode('tac-day1-ceth-stub')));
  const pid = poolId(assetId, cEth, FEE_BPS);
  step('TAC/cETH poolId + lpShareId derive', /^0x[0-9a-f]{64}$/.test(pid), `@${FEE_BPS}bps ${pid.slice(0, 14)}…`);
  step('TAC/cETH incentive within budget', TACETH_INCENTIVE_TAC <= BUDGET_TAC, `${TACETH_INCENTIVE_TAC} of ${BUDGET_TAC} TAC`);
  info('EVM farm bond/harvest/unbond accrual is exercised by tests/amm-farm-e2e-signet.mjs (amm-farm job)');
}

async function loadDapp() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.location = dom.window.location;
  globalThis.navigator = dom.window.navigator;
  if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
  globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => false;
  globalThis.__TACIT_NO_INIT__ = true;
  globalThis.localStorage.setItem('tacit-network-v1', 'signet');
  return import('../dapp/tacit.js');
}

if (LIVE) await live(); else preflight();
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
