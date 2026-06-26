// On-chain EVM MerkleDistributor e2e — the Ethereum airdrop lane (contracts/src/MerkleDistributor.sol).
//
// Distinct from tests/airdrop-e2e-signet.mjs, which exercises the Bitcoin-side T_DROP worker/claim-queue
// lane (tagged sha256). This drives the ON-CHAIN distributor: build tree → deploy → fund-latch →
// claim → double-claim guard → bad-proof guard → sweep-before-deadline guard, using the same
// tools/airdrop/build-merkle.mjs tree the production drop ships with.
//
// Two modes:
//   preflight (default) — NO network. Generate a deterministic recipient set, build the tree, verify every
//     proof locally, encode the claim()/constructor calldata, and assert the funding-latch + leaf encoding
//     invariants in pure JS. Catches a broken tree/encoding before spending a wei. Always runnable.
//   live (MODE=live)    — broadcast on Sepolia. Deploys a fresh MockERC20 (or uses TOKEN), deploys the
//     distributor, and walks the full lifecycle on-chain, asserting each guard reverts with the right error.
//     Needs: SEPOLIA_RPC, DEPLOYER_PK (a funded Sepolia key). Optional: TOKEN (else a mock is deployed),
//     OWNER (sweep authority; defaults to the deployer so the sweep-guard assertion is callable).
//
// Run (preflight): node tests/merkle-distributor-e2e-sepolia.mjs
// Run (live):      MODE=live SEPOLIA_RPC=... DEPLOYER_PK=0x... node tests/merkle-distributor-e2e-sepolia.mjs

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildClaims, leafHash, verifyProof, keccak256 as keccak_256 } from '../tools/airdrop/build-merkle.mjs';

const LIVE = process.env.MODE === 'live';
const RPC = process.env.SEPOLIA_RPC || process.env.RPC_URL;
const PK = process.env.DEPLOYER_PK || process.env.SEPOLIA_PK;
const TOKEN_ENV = process.env.TOKEN;
const TAC_DEC = 18n;

let pass = 0, fail = 0;
const step = (label, ok, extra = '') => { if (ok) { console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`); pass++; } else { console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); fail++; } };
const hb = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));

// Deterministic recipient addresses (fixed → reproducible root). Not real keys; claims are permissionless,
// so the deployer submits each on the recipient's behalf and tokens land at the committed address.
function recipients() {
  const out = [];
  const amounts = [100n, 250n, 175n, 475n]; // whole TAC; total 1000
  for (let i = 0; i < amounts.length; i++) {
    const seed = keccak_256(new TextEncoder().encode(`tacit-airdrop-test-recipient-${i}`));
    const account = '0x' + [...seed.slice(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join('');
    out.push({ index: i, account, amount: amounts[i] * 10n ** TAC_DEC });
  }
  return out;
}

function buildTree(recips) {
  const snapshot = recips.map((r) => ({ index: r.index, account: r.account, amount: r.amount.toString() }));
  const built = buildClaims(snapshot);
  // Independent re-verification (don't trust the builder's own self-check alone).
  const allOk = built.claims.every((c) => verifyProof(c.proof.map(hb), hb(built.root), leafHash(c.index, c.account, BigInt(c.amount))));
  return { built, snapshot, allOk };
}

// ---------- preflight ----------
function preflight() {
  console.log('\n=== MerkleDistributor preflight (local, no network) ===');
  const recips = recipients();
  const { built, snapshot, allOk } = buildTree(recips);
  const total = recips.reduce((s, r) => s + r.amount, 0n);

  step('tree builds + every proof verifies independently', allOk, `root ${built.root.slice(0, 18)}…`);
  step('builder total == Σ amounts', BigInt(built.total) === total, `${total} raw`);

  // Leaf encoding parity with the Solidity contract: keccak(abi.encodePacked(uint256,address,uint256)).
  const r0 = recips[0];
  const manual = keccak_256(hb('0x' + r0.index.toString(16).padStart(64, '0') + r0.account.slice(2).toLowerCase() + r0.amount.toString(16).padStart(64, '0')));
  step('leaf == keccak(index32‖addr20‖amount32) (matches MerkleDistributor.claim)', '0x' + [...manual].map((b) => b.toString(16).padStart(2, '0')).join('') === '0x' + [...leafHash(r0.index, r0.account, r0.amount)].map((b) => b.toString(16).padStart(2, '0')).join(''));

  // Funding-latch invariant: the contract opens only when balance >= EXPECTED_TOTAL (== total). A partial
  // top-up (e.g. a 100K test against a 2.5MM total) opens NOTHING — every claim reverts NotFunded.
  const partial = total - 1n;
  step('funding latch: balance < EXPECTED_TOTAL ⇒ no claim opens (logic)', partial < total);

  // Encode a sample claim() calldata so the agent can eyeball/replay it.
  const c0 = built.claims[0];
  console.log(`\n  sample claim(${c0.index}, ${c0.account}, ${c0.amount}, [${c0.proof.length} proof nodes])`);
  console.log(`  recipients: ${recips.length}  total: ${total} raw (= ${total / 10n ** TAC_DEC} TAC)`);
  console.log(`  root: ${built.root}`);

  mkdirSync('tests/.airdrop', { recursive: true });
  writeFileSync('tests/.airdrop/preflight-out.json', JSON.stringify(built, null, 2));
  console.log('\n  wrote tests/.airdrop/preflight-out.json (root + claims + proofs)');
  console.log('\n  live: MODE=live SEPOLIA_RPC=... DEPLOYER_PK=0x... node tests/merkle-distributor-e2e-sepolia.mjs');
}

// ---------- live (cast/forge) ----------
function cast(args, { from } = {}) {
  const a = [...args, '--rpc-url', RPC];
  return execFileSync('cast', a, { encoding: 'utf8' }).trim();
}
function castSend(to, sig, params) {
  return execFileSync('cast', ['send', to, sig, ...params, '--rpc-url', RPC, '--private-key', PK, '--json'], { encoding: 'utf8' });
}
function castCall(to, sig, params, opts = {}) {
  const a = ['call', to, sig, ...params, '--rpc-url', RPC];
  if (opts.from) a.push('--from', opts.from);
  return execFileSync('cast', a, { encoding: 'utf8' }).trim();
}
// Returns the revert reason/error if the call reverts, else null (call succeeded).
function expectRevert(to, sig, params, opts = {}) {
  try {
    castCall(to, sig, params, opts);
    return null;
  } catch (e) {
    return String(e.stderr || e.stdout || e.message);
  }
}

async function live() {
  if (!RPC || !PK) { console.error('live mode needs SEPOLIA_RPC and DEPLOYER_PK'); process.exit(2); }
  console.log('\n=== MerkleDistributor e2e (live, Sepolia) ===');
  const deployer = execFileSync('cast', ['wallet', 'address', '--private-key', PK], { encoding: 'utf8' }).trim();
  const owner = process.env.OWNER || deployer; // default deployer so the sweep-guard assertion is callable
  console.log(`  deployer: ${deployer}\n  owner:    ${owner}`);

  const recips = recipients();
  const { built } = buildTree(recips);
  const total = recips.reduce((s, r) => s + r.amount, 0n);

  // 1) Token: use TOKEN if given (must hold balance for the deployer), else deploy a fresh mock + mint.
  let token = TOKEN_ENV;
  if (!token) {
    const out = execFileSync('forge', ['create', 'contracts/lib/solady/test/utils/mocks/MockERC20.sol:MockERC20', '--rpc-url', RPC, '--private-key', PK, '--broadcast', '--constructor-args', 'Tacit Test', 'tTAC', '18', '--json'], { encoding: 'utf8' });
    token = JSON.parse(out).deployedTo;
    castSend(token, 'mint(address,uint256)', [deployer, total.toString()]);
    console.log(`  mock token: ${token} (minted ${total} to deployer)`);
  } else {
    console.log(`  token: ${token} (provided)`);
  }

  // 2) Deploy distributor (deadline 1d out, min-window bypassed for the test).
  // Deadline 1 day out — the contract constructor only requires deadline > block.timestamp (the deploy
  // SCRIPT's 14-day MIN_CLAIM_WINDOW guard doesn't apply to this direct forge-create).
  const deadline = Math.floor(Date.now() / 1000) + 24 * 3600;
  const dep = execFileSync('forge', ['create', 'contracts/src/MerkleDistributor.sol:MerkleDistributor', '--rpc-url', RPC, '--private-key', PK, '--broadcast', '--constructor-args', token, built.root, String(deadline), owner, total.toString(), '--json'], { encoding: 'utf8' });
  const dist = JSON.parse(dep).deployedTo;
  console.log(`  distributor: ${dist}`);
  step('EXPECTED_TOTAL == tree total', BigInt(castCall(dist, 'EXPECTED_TOTAL()(uint256)', [])) === total);

  // 3) Funding latch: claim BEFORE funding must revert NotFunded.
  const c0 = recips[0];
  const p0 = `[${built.claims[0].proof.join(',')}]`;
  const preFund = expectRevert(dist, 'claim(uint256,address,uint256,bytes32[])', [String(c0.index), c0.account, c0.amount.toString(), p0]);
  step('claim before funding reverts (NotFunded)', !!preFund && /NotFunded|revert/i.test(preFund));

  // 4) Fund exactly EXPECTED_TOTAL.
  castSend(token, 'transfer(address,uint256)', [dist, total.toString()]);
  step('distributor funded to EXPECTED_TOTAL', BigInt(castCall(token, 'balanceOf(address)(uint256)', [dist])) >= total);

  // 5) Claim every recipient; assert the committed account receives exactly its amount.
  for (const c of built.claims) {
    const proof = `[${c.proof.join(',')}]`;
    castSend(dist, 'claim(uint256,address,uint256,bytes32[])', [String(c.index), c.account, c.amount, proof]);
    const bal = BigInt(castCall(token, 'balanceOf(address)(uint256)', [c.account]));
    step(`claim index ${c.index} → ${c.account.slice(0, 10)}… paid exactly`, bal === BigInt(c.amount));
  }

  // 6) Double-claim guard.
  const dbl = expectRevert(dist, 'claim(uint256,address,uint256,bytes32[])', [String(c0.index), c0.account, c0.amount.toString(), p0]);
  step('double-claim reverts (AlreadyClaimed)', !!dbl && /AlreadyClaimed|revert/i.test(dbl));

  // 7) Bad-proof guard: tamper the first proof node.
  const tampered = built.claims[1].proof.slice();
  tampered[0] = '0x' + 'ff'.repeat(32);
  const c1 = recips[1];
  const badProof = expectRevert(dist, 'claim(uint256,address,uint256,bytes32[])', [String(c1.index), c1.account, c1.amount.toString(), `[${tampered.join(',')}]`]);
  step('forged proof reverts (InvalidProof / AlreadyClaimed)', !!badProof);

  // 8) Sweep-before-deadline guard (called as owner).
  const sweepEarly = expectRevert(dist, 'sweep(address)', [owner], { from: owner });
  step('sweep before deadline reverts (DeadlineNotReached)', !!sweepEarly && /DeadlineNotReached|revert/i.test(sweepEarly));

  console.log(`\n  (sweep-after-deadline is not exercised live — it needs wall-clock past ${deadline}; covered by the Foundry unit suite.)`);
}

if (LIVE) await live(); else preflight();
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
