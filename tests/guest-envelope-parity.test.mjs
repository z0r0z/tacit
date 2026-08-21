// Guest <-> JS envelope layout parity.
//
// The guest is the consensus authority for envelope bytes: cxfer-core's parse_* functions decide what
// a confirmed transaction means. The JS layers (dapp encoders, worker decoders) have to agree with it
// exactly, and nothing in the repo asserted that. Two envelopes had already drifted apart unnoticed —
// each layer self-consistent, the pair impossible to satisfy — and the tests kept passing because they
// only ever compared JS against JS.
//
// This gate reads the guest source and pins the length rule of every fixed-size envelope. It fails if
// the guest changes a length without the JS side being revisited, and it fails on the divergences that
// exist today rather than recording them as acceptable.
//
// Run: node tests/guest-envelope-parity.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const RS = readFileSync(join(here, '../contracts/sp1/confidential/cxfer-core/src/bitcoin.rs'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? ' :: ' + d : '')); } };
const group = (t) => console.log('\n' + t + ':');

// Pull the body of a `pub fn <name>` out of the guest source.
function guestFn(name) {
  const i = RS.indexOf(`pub fn ${name}`);
  if (i < 0) return null;
  const j = RS.indexOf('\npub fn ', i + 1);
  return RS.slice(i, j < 0 ? RS.length : j);
}
// The exact-length rule a parser enforces: `if env.len() != N`.
function exactLen(name) {
  const body = guestFn(name);
  if (!body) return null;
  const m = body.match(/env\.len\(\)\s*!=\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

// Fixed-size envelopes and the length the guest requires. LAUNCH marks an envelope the launch dapp
// builds or reads; those are the ones a divergence would break at launch rather than at AMM enablement.
const FIXED = [
  { fn: 'parse_crossout_mint_envelope',      bytes: 161, op: '0x65', launch: true,  what: 'cross-out mint' },
  { fn: 'parse_cbtc_lock_envelope',          bytes: 197, op: '0x66', launch: true,  what: 'cBTC lock' },
  { fn: 'parse_cbtc_redeem_envelope',        bytes: 109, op: '0x67', launch: true,  what: 'cBTC redeem' },
  { fn: 'parse_btc_call_envelope',           bytes: 201, op: '0x68', launch: false, what: 'BTC call' },
  { fn: 'parse_lp_harvest_envelope',         bytes: 346, op: '0x35', launch: false, what: 'LP harvest' },
  { fn: 'parse_lp_unbond_fields',            bytes: 217, op: '0x36', launch: false, what: 'LP unbond' },
  { fn: 'parse_farm_refund_envelope',        bytes: 174, op: '0x37', launch: false, what: 'farm refund' },
  { fn: 'parse_protocol_fee_claim_envelope', bytes: 207, op: '0x31', launch: false, what: 'protocol-fee claim' },
];

group('Guest fixed-length envelope rules are unchanged');
for (const e of FIXED) {
  const got = exactLen(e.fn);
  ok(`${e.op} ${e.what}: guest requires ${e.bytes} bytes`, got === e.bytes,
     got === null ? `${e.fn}: no exact-length rule found (parser reshaped?)` : `guest now says ${got}`);
}

// ── JS side ──────────────────────────────────────────────────────────────────────────────────────
// Where the JS states a length for the same envelope, it must be the guest's number.
group('JS-declared lengths match the guest');
const cbtcEnv = readFileSync(join(here, '../dapp/cbtc-envelope.js'), 'utf8');
for (const [what, bytes] of [['cBTC lock', 197], ['cBTC redeem', 109]]) {
  ok(`${what}: dapp asserts ${bytes}`, new RegExp(`env\\.length\\s*!==\\s*${bytes}\\b`).test(cbtcEnv));
}

// ── Known divergences ────────────────────────────────────────────────────────────────────────────
// Built, not asserted from a comment: these construct a real envelope and measure it.
group('T_LP_ADD (0x2D) — dapp encoder vs guest');
{
  const { encodeLpAdd } = await import('../dapp/amm-envelope.js');
  const { XCURVE_PROOF_LEN } = await import('./amm-sigma-xcurve.mjs');
  const f = (n, b) => new Uint8Array(n).fill(b);
  // The guest's variant-0 length is computed, not a literal, so derive it the same way the guest does:
  // HEADER(452) + share_r(32) + expiry(4) + refund_a(32) + refund_b(32) = 552, and the tail must END there.
  const GUEST_V0 = 1 + 1 + 32 + 32 + 8 + 8 + 8 + 33 + 32 + XCURVE_PROOF_LEN + 64 + 64 + 32 + 4 + 32 + 32;
  const body = guestFn('parse_lp_add_envelope') || '';
  ok('guest still ends variant-0 at the refund tail (no proof tail)',
     /const V0_LEN: usize = TAIL \+ 4 \+ 32 \+ 32/.test(body) && /env\.len\(\) != V0_LEN/.test(body));
  ok('guest still rejects trailing bytes on variant 1', /if p != env\.len\(\)/.test(body));
  const built = encodeLpAdd({
    variant: 0, assetA: f(32, 1), assetB: f(32, 2), deltaA: 10n, deltaB: 20n, shareAmount: 14n,
    shareCSecp: f(33, 2), shareCBJJ: f(32, 3), shareXcurveSigma: f(XCURVE_PROOF_LEN, 4),
    kernelSigA: f(64, 5), kernelSigB: f(64, 6), shareR: f(32, 7),
    expiryHeight: 900000, refundABlinding: f(32, 8), refundBBlinding: f(32, 9),
    proof: new Uint8Array(0),
  });
  ok(`dapp variant-0 envelope is ${GUEST_V0} bytes (guest's exact length)`, built.length === GUEST_V0,
     `dapp emits ${built.length} — it appends u16 proof_len + proof, which the guest's length rule forbids; ` +
     `even an empty proof overshoots by the 2-byte prefix. The worker requires that same tail, so no envelope satisfies both.`);
}

group('T_PROTOCOL_FEE_CLAIM (0x31) — dapp encoder vs guest');
{
  const { encodeProtocolFeeClaim } = await import('../dapp/amm-envelope.js');
  const f = (n, b) => new Uint8Array(n).fill(b);
  const built = encodeProtocolFeeClaim({
    poolId: f(32, 1), claimerXOnly: f(32, 2), claimAmount: 5n,
    claimCSecp: f(33, 3), claimBlinding: f(32, 4), claimSig: f(64, 5),
  });
  ok('dapp claim envelope is 207 bytes (guest\'s exact length)', built.length === 207,
     `dapp emits ${built.length}. The guest reads a 33-byte COMPRESSED claimer pubkey and a 4-byte fee_bps ` +
     `(the LP tier, part of the pool_id preimage); the dapp writes a 32-byte x-only claimer and no fee_bps at all.`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
