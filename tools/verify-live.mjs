#!/usr/bin/env node
// Checks the live mainnet deployment against what this repo claims about it: that the deployed runtime is the
// artifact compiled here, that the immutable verifying keys are the ones the committed guest ELFs are pinned to,
// that the rest of the immutable wiring matches the deployment manifest, and that the live state is internally
// consistent. Read-only over public RPC — it never broadcasts, never signs, and needs no key or API token.
//
// Usage: node tools/verify-live.mjs      exit 0 = every check passed, 1 = at least one failed
//
// `note` rows are deliberate: parameter combinations a reader should judge for themselves. They never fail the run.
// What this does NOT prove is in docs/VERIFY-LIVE.md; read that before quoting a green run at anyone.
import { readFileSync, existsSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';

// A network or RPC problem is an operator condition, not a verification result — report it as one line rather
// than a stack trace, and never as a passing run.
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (e) => { console.error(`verify-live: ${e && e.message ? e.message : e}`); process.exit(1); });
}

const ROOT = new URL('..', import.meta.url).pathname;
const RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://cloudflare-eth.com',
  'https://1rpc.io/eth',
];

// ---------------------------------------------------------------- reporting

const rows = [];
let failures = 0;
const at = (s) => rows.push({ section: s });
const row = (status, name, value) => {
  if (status === 'FAIL') failures++;
  rows.push({ status, name, value: String(value) });
};
const ok = (n, v) => row('ok', n, v);
const fail = (n, v) => row('FAIL', n, v);
const note = (n, v) => row('note', n, v);
const eq = (n, got, want, fmt = (x) => x) =>
  (String(got).toLowerCase() === String(want).toLowerCase()
    ? ok(n, fmt(got))
    : fail(n, `${fmt(got)} — expected ${fmt(want)}`));

// --------------------------------------------------------------- rpc client

let rpcUrl = null;
let rpcCalls = 0;

async function rpcOn(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcCalls, method, params }),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'rpc error');
  return body.result;
}

// Endpoints differ in what they serve (drpc refuses wide ranges, some rate-limit), so a failed call re-tries the
// whole list rather than giving up on the endpoint that happened to be chosen first.
async function rpc(method, params) {
  const order = rpcUrl ? [rpcUrl, ...RPCS.filter((u) => u !== rpcUrl)] : RPCS;
  let last;
  for (const url of order) {
    try {
      const out = await rpcOn(url, method, params);
      rpcUrl = url;
      return out;
    } catch (e) { last = e; }
  }
  throw new Error(`${method} failed on every RPC: ${last && last.message}`);
}

// --------------------------------------------------------------- abi basics

const utf8 = (s) => new TextEncoder().encode(s);
const hex = (b) => Buffer.from(b).toString('hex');
const keccak = (...parts) => '0x' + hex(keccak_256(Buffer.concat(parts.map((p) => Buffer.from(p)))));
const selector = (sig) => '0x' + hex(keccak_256(utf8(sig))).slice(0, 8);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const b32Word = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const asAddr = (r) => '0x' + r.slice(-40);
const asUint = (r) => BigInt(r === '0x' ? '0x0' : r.slice(0, 66));
const slice32 = (r, i) => '0x' + r.slice(2 + i * 64, 66 + i * 64);

// Every read is pinned to one block, so the printed table is a single coherent snapshot rather than a set of
// values drawn from whatever heights the RPCs happened to be at. Set once, below, from the head block.
let BLOCK = 'latest';
const call = (to, data) => rpc('eth_call', [{ to, data }, BLOCK]);
const callSig = (to, sig, args = '') => call(to, selector(sig) + args);

function checksum(addr) {
  const lower = addr.replace(/^0x/, '').toLowerCase();
  const h = hex(keccak_256(utf8(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

// --------------------------------------------------------- local repo inputs

function readJson(rel) { return JSON.parse(readFileSync(ROOT + rel, 'utf8')); }

const POOL_ARTIFACT = 'contracts/out/ConfidentialPool.sol/ConfidentialPool.json';
const LIB_ARTIFACT = 'contracts/out/ReflectionLib.sol/ReflectionLib.json';

if (!existsSync(ROOT + POOL_ARTIFACT) || !existsSync(ROOT + LIB_ARTIFACT)) {
  console.error('contracts/out is missing the ConfidentialPool / ReflectionLib artifacts.');
  console.error('The bytecode and immutable-offset checks read them, so there is nothing to compare against.');
  console.error('Build them first:   cd contracts && forge build');
  process.exit(1);
}

const manifest = readJson('contracts/deployments/1.json');
const bytecodePin = readJson('contracts/pool-bytecode-pin.json');
const vkeyPin = readJson('contracts/sp1/confidential/elf-vkey-pin.json');
const poolArtifact = readJson(POOL_ARTIFACT);
const libArtifact = readJson(LIB_ARTIFACT);

const POOL = manifest.pool;
const ENGINE = manifest.engine;
const RELAY = manifest.headerRelay;

// Byte offsets of the 12 ReflectionLib link references, from the bytecode pin's `link_references` — the same
// string verify-pool-size.sh asserts, so the two tools cannot drift apart on where the library address sits.
const LINK_OFFSETS = bytecodePin.link_references.split(':').pop().split(',').map(Number);
const LINK_WIDTH = 20;

// Solidity names immutables by AST node id, which the artifact does not carry. The ids are assigned in source
// order, so sorting them recovers the declaration order of ConfidentialPool.sol's 12 immutables. The mapping is
// self-checking: COLLATERAL_ENGINE is the one `public immutable` of the set, so its getter proves the alignment.
const IMMUTABLE_ORDER = [
  'SP1_VERIFIER', 'PROGRAM_VKEY', 'CHAIN_BINDING', 'BITCOIN_RELAY_VKEY',
  'HEADER_RELAY', 'PREDECESSOR', 'LINEAGE_STEWARD', 'REFLECTION_CONFIRMATIONS',
  'CANONICAL_FACTORY', 'TETH_BITCOIN_LINK', 'COLLATERAL_ENGINE', 'PUBLIC_AMM',
];

const immutableRefs = poolArtifact.deployedBytecode.immutableReferences;
const immutableIds = Object.keys(immutableRefs).map(Number).sort((a, b) => a - b);
if (immutableIds.length !== IMMUTABLE_ORDER.length) {
  console.error(`the compiled pool has ${immutableIds.length} immutables, this tool knows ${IMMUTABLE_ORDER.length}.`);
  console.error('ConfidentialPool.sol gained or lost one; update IMMUTABLE_ORDER to match its declaration order.');
  process.exit(1);
}
const immutableSlots = new Map(immutableIds.map((id, i) => [IMMUTABLE_ORDER[i], immutableRefs[String(id)]]));

// Zero every slot whose contents are chosen at deploy time — the library address at each link offset and, when
// asked, every immutable — so two runtimes that differ only in deploy parameters compare equal.
function normalise(runtimeHex, { zeroImmutables }) {
  const b = Buffer.from(runtimeHex.replace(/^0x/, '').replace(/__\$[0-9a-f]+\$__/g, '0'.repeat(LINK_WIDTH * 2)), 'hex');
  for (const o of LINK_OFFSETS) b.fill(0, o, o + LINK_WIDTH);
  if (zeroImmutables) for (const refs of Object.values(immutableRefs)) for (const r of refs) b.fill(0, r.start, r.start + r.length);
  return b;
}

function readImmutable(runtimeHex, name) {
  const refs = immutableSlots.get(name);
  const body = runtimeHex.replace(/^0x/, '');
  const seen = new Set(refs.map((r) => body.slice(r.start * 2, (r.start + r.length) * 2)));
  if (seen.size !== 1) throw new Error(`${name} holds ${seen.size} different values across its ${refs.length} slots`);
  return '0x' + [...seen][0];
}

// ---------------------------------------------------------------- run

const head = await rpc('eth_getBlockByNumber', ['latest', false]);
const blockNumber = Number(BigInt(head.number));
const chainId = Number(BigInt(await rpc('eth_chainId', [])));
BLOCK = head.number;
const poolRuntime = await rpc('eth_getCode', [POOL, BLOCK]);

at('deployed code');

if (chainId !== manifest.chainId) fail('chain', `connected to chain ${chainId}, manifest is chain ${manifest.chainId}`);
else ok('chain', `${chainId} at block ${blockNumber}`);

if (poolRuntime === '0x') {
  console.error(`no code at ${POOL} on chain ${chainId} — nothing to verify.`);
  process.exit(1);
}

const poolBytes = (poolRuntime.length - 2) / 2;
if (poolBytes !== bytecodePin.runtime_size) fail('pool.runtime-size', `${poolBytes} bytes, pin says ${bytecodePin.runtime_size}`);
else ok('pool.runtime-size', `${poolBytes} bytes (pin ${bytecodePin.runtime_size}, EIP-170 limit ${bytecodePin.eip170_limit})`);

const localLinkNormalised = normalise(poolArtifact.deployedBytecode.object, { zeroImmutables: false });
eq('pool.artifact-keccak', keccak(localLinkNormalised), bytecodePin.runtime_keccak);

// The live runtime must name one library at all 12 link sites; a mismatch would mean part of the pool
// delegatecalls somewhere else.
const linked = new Set(LINK_OFFSETS.map((o) => poolRuntime.slice(2).slice(o * 2, (o + LINK_WIDTH) * 2)));
let libAddr = null;
if (linked.size !== 1) fail('pool.link-sites', `${LINK_OFFSETS.length} sites reference ${linked.size} different addresses`);
else {
  libAddr = checksum('0x' + [...linked][0]);
  ok('pool.link-sites', `${LINK_OFFSETS.length} sites, all ReflectionLib ${libAddr}`);
}

const liveNormalised = normalise(poolRuntime, { zeroImmutables: true });
const localNormalised = normalise(poolArtifact.deployedBytecode.object, { zeroImmutables: true });
if (liveNormalised.equals(localNormalised)) {
  ok('pool.runtime-match', `identical to the local build over ${localNormalised.length} bytes (library address and ${immutableIds.length} immutables normalised)`);
} else {
  let i = 0;
  while (i < localNormalised.length && localNormalised[i] === liveNormalised[i]) i++;
  fail('pool.runtime-match', `differs from the local build, first at byte ${i}`);
}

if (libAddr) {
  const libRuntime = await rpc('eth_getCode', [libAddr, BLOCK]);
  const libRefs = libArtifact.deployedBytecode.immutableReferences;
  const zeroLibSelf = (h) => {
    const b = Buffer.from(h.replace(/^0x/, ''), 'hex');
    for (const refs of Object.values(libRefs)) for (const r of refs) b.fill(0, r.start, r.start + r.length);
    return b;
  };
  const liveLib = zeroLibSelf(libRuntime);
  const localLib = zeroLibSelf(libArtifact.deployedBytecode.object);
  if (liveLib.equals(localLib)) ok('reflectionlib.runtime-match', `identical to the local build over ${localLib.length} bytes (self-address normalised)`);
  else fail('reflectionlib.runtime-match', 'differs from the local build');
  // A library compiled for one address and deployed at another would delegatecall-guard itself into reverting.
  const self = Object.values(libRefs)[0][0];
  const baked = '0x' + libRuntime.replace(/^0x/, '').slice(self.start * 2, (self.start + self.length) * 2).slice(-40);
  eq('reflectionlib.self-address', baked, libAddr.toLowerCase(), () => `${checksum(baked)} (baked) vs ${libAddr} (deployed at)`);
}

at('verifying keys');

const programVkey = readImmutable(poolRuntime, 'PROGRAM_VKEY');
const relayVkey = readImmutable(poolRuntime, 'BITCOIN_RELAY_VKEY');
eq('PROGRAM_VKEY', programVkey, vkeyPin.program_vkey);
eq('BITCOIN_RELAY_VKEY', relayVkey, vkeyPin.bitcoin_relay_vkey);
// The vkey above is only as meaningful as the ELF it was derived from, and the ELF in this checkout is what a
// reader would rebuild (docs/REPRODUCIBLE-BUILDS.md). Confirm the committed bytes are the pinned bytes; the
// derivation itself is not reproducible here, see docs/VERIFY-LIVE.md.
for (const [name, path, wantSha, wantBytes] of [
  ['elf.settle', 'contracts/sp1/confidential/elf/cxfer-guest', vkeyPin.elf_sha256, vkeyPin.elf_bytes],
  ['elf.reflection', 'contracts/sp1/confidential/elf/reflection-prover', vkeyPin.reflection_elf_sha256, vkeyPin.reflection_elf_bytes],
  ['elf.eth-reflection', 'contracts/sp1/eth-reflection/elf/eth_reflection', vkeyPin.eth_reflection_elf_sha256, vkeyPin.eth_reflection_elf_bytes],
]) {
  const bytes = readFileSync(ROOT + path);
  const got = hex(sha256(bytes));
  if (got === wantSha && bytes.length === wantBytes) ok(name, `sha256 ${got.slice(0, 16)}… (${bytes.length} bytes) matches elf-vkey-pin.json`);
  else fail(name, `sha256 ${got.slice(0, 16)}… (${bytes.length} bytes), pin says ${wantSha.slice(0, 16)}… (${wantBytes} bytes)`);
}
eq('manifest.programVkey', manifest.programVkey, vkeyPin.program_vkey);
eq('manifest.bitcoinRelayVkey', manifest.bitcoinRelayVkey, vkeyPin.bitcoin_relay_vkey);

at('immutable wiring');

const immAddr = (n) => asAddr(readImmutable(poolRuntime, n));
eq('SP1_VERIFIER', immAddr('SP1_VERIFIER'), manifest.sp1Verifier, checksum);
eq('HEADER_RELAY', immAddr('HEADER_RELAY'), manifest.headerRelay, checksum);
eq('COLLATERAL_ENGINE', immAddr('COLLATERAL_ENGINE'), manifest.engine, checksum);
eq('PUBLIC_AMM', immAddr('PUBLIC_AMM'), manifest.publicAmm, checksum);
eq('CANONICAL_FACTORY', immAddr('CANONICAL_FACTORY'), manifest.factory, checksum);
eq('TETH_BITCOIN_LINK', readImmutable(poolRuntime, 'TETH_BITCOIN_LINK'), manifest.tethBitcoinId);
eq('LINEAGE_STEWARD', immAddr('LINEAGE_STEWARD'), manifest.engineAdmin, checksum);
eq('REFLECTION_CONFIRMATIONS', asUint(readImmutable(poolRuntime, 'REFLECTION_CONFIRMATIONS')), BigInt(manifest.reflectionConfirmations), (v) => `${v} Bitcoin blocks`);

const predecessor = immAddr('PREDECESSOR');
ok('PREDECESSOR', BigInt(predecessor) === 0n ? 'none — lineage runs through handoff, not a constructor link' : checksum(predecessor));

// The pool derives its own binding at construction, so re-deriving it from (chainId, address) is what proves the
// deployed code is bound to this chain and this address and cannot replay a sibling deployment's proofs.
eq('CHAIN_BINDING', readImmutable(poolRuntime, 'CHAIN_BINDING'),
  keccak(Buffer.from(word(chainId), 'hex'), Buffer.from(POOL.replace(/^0x/, ''), 'hex')),
  (v) => `${v} = keccak(chainid ${chainId} ‖ pool)`);

// The public getter is the one immutable with an ABI entry; agreement proves the id→name mapping above.
eq('COLLATERAL_ENGINE()', asAddr(await callSig(POOL, 'COLLATERAL_ENGINE()')), manifest.engine, checksum);
eq('engine.POOL()', asAddr(await callSig(ENGINE, 'POOL()')), POOL, checksum);

for (const [name, addr] of [['sp1Verifier', manifest.sp1Verifier], ['headerRelay', manifest.headerRelay],
  ['engine', manifest.engine], ['publicAmm', manifest.publicAmm], ['factory', manifest.factory]]) {
  const size = ((await rpc('eth_getCode', [addr, BLOCK])).length - 2) / 2;
  if (size > 0) ok(`code.${name}`, `${size} bytes at ${checksum(addr)}`);
  else fail(`code.${name}`, `no code at ${checksum(addr)}`);
}

at('live state');

const relayTip = asUint(await callSig(RELAY, 'tipHeight()'));
const attestedTipHash = await callSig(POOL, 'attestedReflectionTip()');
const attestedHeight = asUint(await callSig(RELAY, 'blockHeight(bytes32)', b32Word(attestedTipHash)));
const confirmations = BigInt(manifest.reflectionConfirmations);

ok('relay.tipHeight', `${relayTip}`);
if (attestedHeight === 0n) {
  fail('reflection.attestedTip', `${attestedTipHash} is not a block the relay knows`);
} else {
  ok('reflection.attestedTip', `${attestedHeight} (${attestedTipHash.slice(0, 18)}…)`);
  const lag = relayTip - attestedHeight;
  if (lag < confirmations) fail('reflection.confirmations', `attested state is only ${lag} blocks behind the relay tip, below the pool's ${confirmations}`);
  else ok('reflection.confirmations', `${lag} blocks behind the relay tip, at or beyond the required ${confirmations}`);
}
ok('reflection.digest', await callSig(POOL, 'attestedReflectionDigest()'));
// attestedCrossOutCount() returns the pool's RECORDED cross-out count, not how many have folded on the
// Bitcoin side — the two diverge whenever a cross-out has settled on Ethereum and its Bitcoin-side mint has
// not been broadcast yet, which is a normal and open-ended state. Labelling it "folds" is the exact confusion
// that has already cost a day of investigation once; name it for what it reads.
ok('reflection.counters', `cross-outs recorded ${asUint(await callSig(POOL, 'attestedCrossOutCount()'))} · Bitcoin-side consumptions ${asUint(await callSig(POOL, 'attestedBitcoinConsumedCount()'))}`);

ok('pool.root', await callSig(POOL, 'currentRoot()'));
const leaves = asUint(await callSig(POOL, 'nextLeafIndex()'));
ok('pool.leaves', `${leaves} note commitments appended`);
const backingSats = asUint(await callSig(POOL, 'cbtcBackingSats()'));
ok('pool.cbtcBackingSats', `${backingSats} sat (${(Number(backingSats) / 1e8).toFixed(8)} BTC of reflected locks)`);

const successor = asAddr(await callSig(POOL, 'successor()'));
ok('pool.successor', BigInt(successor) === 0n ? 'none — this generation is current' : checksum(successor));

// Oracle reads are quoted per whole BTC. They revert on a stale or out-of-bound feed, so a number coming back at
// all is the freshness check; the printed values are for judging the numbers themselves.
const ONE_BTC = word(100000000n);
const btcUsd = asUint(await callSig(ENGINE, 'btcToUsd(uint256)', ONE_BTC));
const wstPerBtc = asUint(await callSig(ENGINE, 'wstEthForBtc(uint256)', ONE_BTC));
const required = asUint(await callSig(ENGINE, 'requiredEscrow(uint256)', ONE_BTC));
const escrowRatioBps = asUint(await callSig(ENGINE, 'escrowRatioBps()'));

ok('oracle.btcToUsd', `${(Number(btcUsd) / 1e8).toFixed(2)} cUSD per BTC`);
ok('oracle.wstEthForBtc', `${(Number(wstPerBtc) / 1e18).toFixed(6)} wstETH per BTC`);
if (required === (wstPerBtc * escrowRatioBps) / 10000n) {
  ok('oracle.requiredEscrow', `${(Number(required) / 1e18).toFixed(6)} wstETH per BTC = ${Number(escrowRatioBps) / 10000}× the mark`);
} else {
  fail('oracle.requiredEscrow', `${required} wei is not escrowRatioBps (${escrowRatioBps}) applied to the ${wstPerBtc} wei mark`);
}

at('solvency');

const balanceOf = async (token, who) => asUint(await callSig(token, 'balanceOf(address)', addrWord(who)));
const totalSupply = async (token) => asUint(await callSig(token, 'totalSupply()'));

ok('pool.balance.ETH', `${(Number(BigInt(await rpc('eth_getBalance', [POOL, BLOCK]))) / 1e18).toFixed(9)} ETH`);
const HOLDINGS = [
  ['USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6],
  ['USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6],
  ['wstETH', '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', 18],
];
for (const [sym, token, dec] of HOLDINGS) {
  ok(`pool.balance.${sym}`, `${(Number(await balanceOf(token, POOL)) / 10 ** dec).toFixed(Math.min(dec, 8))} ${sym}`);
}
const escrowHeld = await balanceOf(HOLDINGS[2][1], ENGINE);
ok('engine.escrow.wstETH', `${(Number(escrowHeld) / 1e18).toFixed(9)} wstETH posted against cBTC positions`);

// A coverage RATIO is deliberately not derived from these two reads, because the obvious one is wrong.
//
// `cbtcBackingSats` counts every lock reflection has recorded, including locks that never cleared the escrow
// gate and so never minted any cBTC. Escrow is posted per position at mint time, and a lock that minted
// nothing requires none — so dividing the escrow held by what `requiredEscrow(cbtcBackingSats)` returns
// understates coverage by exactly the share of tracked sats that never minted. On this deployment that is
// half of them, which turns a book at roughly 1.06x of requirement into an alarming-looking 53%.
//
// Computing it honestly needs the per-lock split — `cbtcLockVBtc` and `cbtcMinted` for each outpoint — and
// the pool emits no event carrying them, so an outside reader would have to walk every attest's calldata.
// That is out of scope for a fifty-call snapshot. Print both figures as facts and say what they are; a
// reader who wants the ratio can get the outpoints from the attest history.
if (backingSats > 0n) {
  const wouldRequire = asUint(await callSig(ENGINE, 'requiredEscrow(uint256)', word(backingSats)));
  ok('engine.escrow.reference', `${(Number(wouldRequire) / 1e18).toFixed(9)} wstETH is what today's mark would require if ALL ${backingSats} tracked sat had minted — not a coverage denominator, since unminted locks require no escrow`);
}

// A canonical token only exists because the pool burned an in-system note to mint it, so its ERC-20 supply can
// never exceed what the pool tracks as backing that asset. Both are 18-decimal ERC-20s over an 8-decimal
// in-system unit, hence the 1e10 unit scale.
const outstandingCusd = asUint(await callSig(ENGINE, 'outstandingCusd()'));
const SCALE = 10000000000n;
const backed = [
  ['tacBTC', manifest.cbtcToken, backingSats, 'reflected BTC locks (cbtcBackingSats)'],
  ['tacUSD', manifest.cusdToken, outstandingCusd, 'CDP debt outstanding (outstandingCusd)'],
];
for (const [sym, token, cap, source] of backed) {
  const supply = await totalSupply(token);
  const units = supply / SCALE;
  const shown = `${(Number(supply) / 1e18).toFixed(8)} ${sym} minted against ${(Number(cap) / 1e8).toFixed(8)} of ${source}`;
  if (units <= cap) ok(`backing.${sym}`, shown); else fail(`backing.${sym}`, shown);
}

at('risk parameters');

const params = {};
for (const name of ['cdpRatioBps', 'liqRatioBps', 'escrowRatioBps', 'maxStaleness', 'maxDeviationBps',
  'stabilityFeePerSecond', 'escrowMaintenanceBps', 'insuranceReserve', 'outstandingCusd', 'escrowGraceWindow']) {
  params[name] = asUint(await callSig(ENGINE, `${name}()`));
}
ok('cdpRatioBps', `${params.cdpRatioBps} — a CDP must open at ${Number(params.cdpRatioBps) / 100}% collateral`);
ok('liqRatioBps', `${params.liqRatioBps} — liquidatable below ${Number(params.liqRatioBps) / 100}%`);
ok('escrowRatioBps', `${params.escrowRatioBps} — a cBTC locker posts ${Number(params.escrowRatioBps) / 100}% of the mark in wstETH`);
ok('maxStaleness', `${params.maxStaleness} s — an oracle answer older than this reverts every priced call`);
ok('stabilityFeePerSecond', `${params.stabilityFeePerSecond}${params.stabilityFeePerSecond === 0n ? ' — cUSD debt does not accrue interest' : ''}`);
ok('insuranceReserve', `${params.insuranceReserve} (8-dec cUSD)`);
ok('outstandingCusd', `${params.outstandingCusd} (8-dec cUSD) = ${(Number(params.outstandingCusd) / 1e8).toFixed(8)} cUSD of debt`);
ok('escrowGraceWindow', `${params.escrowGraceWindow} s`);

const btcUsdTwap = asAddr(await callSig(ENGINE, 'btcUsdTwap()'));
const wstTwap = asAddr(await callSig(ENGINE, 'wstEthBtcTwap()'));
ok('oracle.feeds', `BTC/USD ${checksum(asAddr(await callSig(ENGINE, 'btcUsdFeed()')))}, wstETH/BTC ${checksum(asAddr(await callSig(ENGINE, 'wstEthBtcFeed()')))}`);

// Flags. Each is a live configuration that is legitimate but worth a reader's attention, so it is reported and
// never failed — the script has no standing to decide the protocol's risk appetite.
if (params.insuranceReserve === 0n && params.outstandingCusd > 0n) {
  note('flag.insurance', `reserve is empty against ${(Number(params.outstandingCusd) / 1e8).toFixed(8)} cUSD outstanding — a shortfall on liquidation has nothing to draw on`);
}
if (params.escrowMaintenanceBps === 0n) {
  note('flag.margin-call', 'escrowMaintenanceBps is 0 — the escrow margin call is dormant, so a cBTC locker is only ever enforced at the full escrow ratio');
}
if (BigInt(btcUsdTwap) === 0n || BigInt(wstTwap) === 0n) {
  const which = [BigInt(btcUsdTwap) === 0n && 'BTC/USD', BigInt(wstTwap) === 0n && 'wstETH/BTC'].filter(Boolean);
  note('flag.oracle-source', `${which.join(' and ')} ${which.length > 1 ? 'have' : 'has'} no TWAP cross-check configured — a single feed sets the price, bounded only by maxStaleness`);
}
if (params.maxDeviationBps === 0n) {
  note('flag.deviation-bound', 'maxDeviationBps is 0 — the feed-vs-TWAP deviation bound is disabled');
}
if (params.liqRatioBps >= params.cdpRatioBps) {
  note('flag.cdp-headroom', `liqRatioBps ${params.liqRatioBps} leaves no headroom under cdpRatioBps ${params.cdpRatioBps}`);
}

// ---------------------------------------------------------------- output

const width = rows.reduce((w, r) => (r.name ? Math.max(w, r.name.length) : w), 0);
console.log('');
console.log(`tacit — live verification of ${checksum(POOL)}`);
console.log(`chain ${chainId} · block ${blockNumber} · ${rpcUrl} · ${rpcCalls} read-only calls`);
for (const r of rows) {
  if (r.section) { console.log(''); console.log(r.section); continue; }
  console.log(`  ${r.status.padEnd(5)} ${r.name.padEnd(width)}  ${r.value}`);
}
const counts = rows.reduce((c, r) => (r.status ? { ...c, [r.status]: (c[r.status] || 0) + 1 } : c), {});
console.log('');
console.log(`${counts.ok || 0} passed, ${counts.FAIL || 0} failed, ${counts.note || 0} flagged for attention`);
console.log('What this does not prove: docs/VERIFY-LIVE.md');
process.exit(failures ? 1 : 0);
