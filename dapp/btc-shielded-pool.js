// Bitcoin-native shielded pool — Phase 3 wallet wiring (NEW, EXPERIMENTAL module, not wired into any
// default UI flow).
//
// Implements the wallet side of DESIGN-btc-shielded-pool.md: T_BTC_SHIELD (0x6C) / T_BTC_SPEND (0x6D)
// envelope construction, the §2 one-time stealth spend-key derivation (mirroring dapp/confidential-
// stealth.js's oneTimeAddress/recoverOneTimeKey, pointed at Bitcoin witness data instead of an EVM lock),
// recipient-side note scanning (mirroring dapp/confidential-lock-scan.js / confidential-memo.js's
// decrypt-then-reauthenticate pattern), and a witness-assembly + prover call structured like
// dapp/confidential-swapbatch.js's proveSwapBatch — but there is no fourth SP1 guest ELF built or pinned
// yet (Phase 2 of the design doc's §12 has not run), so `proveBtcPoolSpend` below is a stub that throws
// rather than fabricating a fake proof. Nothing in this module is imported by dapp/tacit.js or any other
// live entry point; it is addressable only by an explicit `import` of this file.
//
// Mirrors worker/src/btc-shielded-pool.js's constants/formulas exactly (both, in turn, mirror
// contracts/sp1/confidential/cxfer-core/src/btc_pool.rs) — kept as two separate files rather than one
// shared import because the dapp and worker bundles are built/deployed independently, the same reason
// every other opcode's parse logic already exists once in dapp/*.js and once in worker/src/index.js.
//
// Crypto deps injected for Node + browser, same convention as dapp/confidential-pool.js /
// dapp/confidential-stealth.js: { secp, keccak256, sha256 }.

export const T_BTC_SHIELD = 0x6c;
export const T_BTC_SPEND = 0x6d;
export const BTC_POOL_OUT_PAY = 0x00;
export const BTC_POOL_OUT_EXIT = 0x01;
export const BTC_POOL_MAX_IN = 2;
export const BTC_POOL_MAX_OUT = 2;
export const CT_NOTE_LEN = 56; // v(8) ‖ r(32) ‖ tag(16)

export function makeBtcShieldedPool({ secp, keccak256, sha256 }) {
  const Pt = secp.ProjectivePoint;
  const G = Pt.BASE;
  const N = secp.CURVE.n;
  const enc = new TextEncoder();

  const NOTE_DOMAIN = enc.encode('tacit-btc-pool-note-v1');
  const NF_DOMAIN = enc.encode('tacit-btc-pool-nf-v1');
  const ECDH_DOMAIN = enc.encode('tacit-btc-pool-ecdh-v1'); // pool-own domain, disjoint from confidential-stealth.js's EVM 'tacit-stealth-ecdh-v1'
  const AEAD_KEY_DOMAIN = enc.encode('tacit-btc-pool-aead-key-v1');
  const AEAD_TAG_DOMAIN = enc.encode('tacit-btc-pool-aead-tag-v1');

  // ── byte helpers (matching dapp/confidential-pool.js / dapp/confidential-stealth.js conventions) ──
  const hexToBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const hx = (b) => '0x' + bytesToHex(b);
  const concat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
  const b32 = (h) => { const s = String(h).replace(/^0x/, '').padStart(64, '0'); if (s.length !== 64) throw new Error('expected a 32-byte value'); return hexToBytes(s); };
  const be = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
  const le4 = (v) => { const x = Number(v) >>> 0; return Uint8Array.of(x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >>> 24) & 0xff); };
  // On-wire fields are little-endian (design §3, matching lock_vout/exit_vout/h_anchor's own LE
  // convention) — distinct from canonical_body's internal big-endian integers (design §4), the same LE-
  // wire/BE-hash split T_CXFER's own kernel message already uses.
  const le8 = (v) => { let x = BigInt(v); const o = new Uint8Array(8); for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
  const bToBig = (b) => { let x = 0n; for (const y of b) x = (x << 8n) | BigInt(y); return x; };
  const modN = (x) => ((x % N) + N) % N;
  const k = (...parts) => keccak256(concat(parts));
  const compress = (P) => P.toRawBytes(true);
  const xOnly = (P) => P.toRawBytes(true).slice(1);
  const evenY = (P) => P.toRawBytes(true)[0] === 0x02;
  // `pkEph` is always published/consumed as a full 33-byte compressed point in this module (see
  // deriveBtcPoolSpendKey below), so reconstructing it from a bare 32-byte value would only ever
  // happen on malformed input — length-sniffing here is a format-detection convenience, not a
  // silent-guess-the-parity risk, because the 32-byte case never legitimately occurs for pkEph.
  const ptFrom = (hexCompressedOrXonly) => {
    const s = String(hexCompressedOrXonly).replace(/^0x/, '');
    return s.length === 64 ? Pt.fromHex('02' + s) : Pt.fromHex(s);
  };
  // `recipientSpendPub` (pk_recv, the recipient's long-lived receiving address) is NEVER subject to
  // the even-y retry that `spend_key` gets — a real address can have either parity — so silently
  // forcing even-y on a 32-byte input would misderive the shared secret for roughly half of all
  // real addresses if one is ever handed in x-only form. Require the unambiguous 33-byte compressed
  // encoding always; reject anything else rather than guess.
  const ptFromRecipientAddr = (hexCompressed) => {
    const s = String(hexCompressed).replace(/^0x/, '');
    if (s.length !== 66) throw new Error('btc-shielded-pool: recipientSpendPub must be a 33-byte compressed point (got ' + s.length / 2 + ' bytes) — x-only input is ambiguous and unsafe to guess-parity for an address');
    return Pt.fromHex(s);
  };

  // ── leaf / nullifier (design §2, byte-exact mirror of cxfer-core btc_pool.rs / worker/src/btc-shielded-pool.js) ──
  const btcPoolNoteLeaf = (asset, cx, cy, spendKey) => hx(k(b32(asset), b32(cx), b32(cy), b32(spendKey), NOTE_DOMAIN));
  const btcPoolNfSecret = (skNote) => hx(k(NF_DOMAIN, b32(skNote)));
  const btcPoolNullifier = (leaf, nfSecret) => hx(k(b32(leaf), b32(nfSecret), enc.encode('spent')));

  // ── §2 one-time stealth spend key, mirroring confidential-stealth.js's oneTimeAddress/recoverOneTimeKey,
  // but pointed at this pool's own leaf/nullifier domain and — unlike the EVM stealth send's bare x-only
  // drop — required to land on the CANONICAL EVEN-Y representative before it is ever published, per
  // security doc A5's "canonical witness requirement" / G2. A stealth address whose point happens to have
  // odd y is simply not a usable spend_key here (the relation rejects any sk_note that isn't already
  // even-y — see cxfer-core btc_pool.rs's `c[0] != 0x02` check), so the sender retries with a fresh
  // ephemeral until the derived point is even-y, rather than trying to "fix" the point after the fact
  // (there is no fix: negating the scalar changes `shared`, which the recipient would independently
  // recompute anyway, so the fix has to happen before anything is published, not after).
  const MAX_STEALTH_RETRIES = 64;
  function deriveBtcPoolSpendKey({ recipientSpendPub, ephemeralPriv }) {
    const B = ptFromRecipientAddr(recipientSpendPub);
    for (let attempt = 0; attempt < MAX_STEALTH_RETRIES; attempt++) {
      const e = modN(BigInt(ephemeralPriv) + BigInt(attempt));
      if (e === 0n) continue;
      const shared = B.multiply(e);
      const s = modN(bToBig(k(ECDH_DOMAIN, compress(shared))));
      const O = B.add(G.multiply(s));
      if (evenY(O)) {
        return { pkEph: hx(compress(G.multiply(e))), spendKey: hx(xOnly(O)), ephemeralPrivUsed: hx(be(e, 32)) };
      }
    }
    throw new Error('btc-shielded-pool: could not derive an even-y spend_key within the retry budget (astronomically unlikely — check inputs)');
  }

  // RECIPIENT: recover sk_note (the discrete log of the published spend_key) from a note's published
  // pk_eph. Because the sender already retried until the point was even-y (above), this always recovers
  // the canonical scalar directly — no separate negation step needed on the recipient side.
  function recoverBtcPoolSpendSecret({ recipientSpendPriv, pkEph }) {
    const b = modN(BigInt(recipientSpendPriv));
    const E = ptFrom(pkEph);
    const shared = E.multiply(b);
    const s = modN(bToBig(k(ECDH_DOMAIN, compress(shared))));
    const skNote = modN(b + s);
    return { skNote: hx(be(skNote, 32)), spendKey: hx(xOnly(G.multiply(skNote))) };
  }

  // ── ct_note AEAD (design §3: `ct_note = AEAD(key derived from the §2 shared secret, plaintext = v(8) ‖
  // r(32), 16-byte tag)`, 56 bytes exact). No general-purpose AEAD library is imported anywhere in this
  // dapp bundle (dapp/confidential-memo.js's own note-memo sealing uses a bare keystream XOR with no
  // separate tag, authenticating instead by re-deriving the leaf); a genuine 16-byte tag is part of this
  // op's own wire format, so this module adds a small encrypt-then-MAC construction rather than reusing
  // that file's untagged scheme. Keystream: keccak-counter-mode (same technique confidential-memo.js's
  // `keystream` uses, swapped to keccak for domain separation from that file's sha256-based one). Tag:
  // keccak(tagDomain ‖ key ‖ ciphertext)[0:16] — encrypt-then-MAC, not a standardized AEAD construction by
  // name; flagged here so a reviewer checks it on its own terms rather than assuming it is, say, AES-GCM.
  function _aeadKey(sharedPt) { return k(AEAD_KEY_DOMAIN, compress(sharedPt)); }
  function _keystream(key, len) {
    const out = new Uint8Array(len);
    let off = 0, c = 0;
    while (off < len) { const blk = k(key, Uint8Array.of(c & 0xff, (c >> 8) & 0xff)); out.set(blk.subarray(0, Math.min(32, len - off)), off); off += 32; c++; }
    return out;
  }
  function _aeadSeal(key, plaintext40) {
    const ks = _keystream(key, plaintext40.length);
    const ct = new Uint8Array(plaintext40.length);
    for (let i = 0; i < ct.length; i++) ct[i] = plaintext40[i] ^ ks[i];
    const tag = k(AEAD_TAG_DOMAIN, key, ct).slice(0, 16);
    return concat([ct, tag]);
  }
  function _aeadOpen(key, sealed56) {
    if (sealed56.length !== CT_NOTE_LEN) return null;
    const ct = sealed56.subarray(0, 40);
    const tag = sealed56.subarray(40, 56);
    const expectTag = k(AEAD_TAG_DOMAIN, key, ct).slice(0, 16);
    // Constant-time: this is a local wallet scan today, but this function has no way to guarantee it
    // never ends up processing many users' ciphertexts inside a hosted relay/scanning service later,
    // at which point a timing side-channel here would matter — cheap to close now, not worth revisiting.
    let diff = 0;
    for (let i = 0; i < 16; i++) diff |= tag[i] ^ expectTag[i];
    if (diff !== 0) return null;
    const ks = _keystream(key, ct.length);
    const pt = new Uint8Array(ct.length);
    for (let i = 0; i < pt.length; i++) pt[i] = ct[i] ^ ks[i];
    return pt;
  }
  function sealCtNote({ sharedPt, value, blinding }) {
    const key = _aeadKey(sharedPt);
    const plain = concat([be(value, 8), b32(blinding)]);
    return hx(_aeadSeal(key, plain));
  }
  function openCtNote({ sharedPt, ctNoteHex }) {
    const key = _aeadKey(sharedPt);
    const pt = _aeadOpen(key, hexToBytes(ctNoteHex));
    if (!pt) return null;
    return { value: bToBig(pt.subarray(0, 8)), blinding: hx(pt.subarray(8, 40)) };
  }

  // ── Pedersen commitment (v·H + r·G), same convention as confidential-pool.js/confidential-memo.js ──
  function pedersenCommitXY(H, value, blindingHex) {
    const a = H.multiply(BigInt(value)).add(G.multiply(modN(BigInt(blindingHex)))).toAffine();
    return { cx: '0x' + a.x.toString(16).padStart(64, '0'), cy: '0x' + a.y.toString(16).padStart(64, '0') };
  }

  // ── canonical_body / h_body (design §4 — byte-exact mirror of worker/src/btc-shielded-pool.js /
  // cxfer-core btc_pool.rs's `btc_pool_h_body`) — the wallet needs this to know what the guest witness
  // must commit to once the real prover exists; see `proveBtcPoolSpend` below. ──
  function btcPoolCanonicalBody({ asset, nullifiers, outKind, outputs, exitVout, destSpkHash, hAnchor }) {
    const parts = [Uint8Array.of(T_BTC_SPEND), b32(asset), Uint8Array.of(nullifiers.length)];
    for (const nf of nullifiers) parts.push(b32(nf));
    parts.push(Uint8Array.of(outKind));
    if (outKind === BTC_POOL_OUT_PAY) {
      parts.push(Uint8Array.of(outputs.length));
      for (const o of outputs) parts.push(b32(o.cx), b32(o.cy), b32(o.pkEph), b32(o.spendKey), hexToBytes(o.ctNote));
    } else {
      parts.push(be(exitVout || 0, 4), b32(destSpkHash || '0x' + '00'.repeat(32)));
    }
    parts.push(be(hAnchor, 4));
    return concat(parts);
  }
  function btcPoolHBody(fields) { return hx(keccak256(btcPoolCanonicalBody(fields))); }

  // ── T_BTC_SHIELD envelope builder (design §3) ──
  // 0x6C ‖ asset(32) ‖ lock_vout(4 LE) ‖ Cx(32) ‖ Cy(32) ‖ pk_eph(32) ‖ spend_key(32) ‖ opening_proof(64)
  // = 229 bytes exact. `buildOpeningProof` is injected rather than baked in here — see
  // worker/src/btc-shielded-pool.js's `verifyBtcShieldOpeningProof` comment on why the exact NIZK
  // construction is a genuine open item pending reconciliation with T_BTC_WRAP (which does not exist yet
  // either). This builder only assembles the envelope around whatever 64-byte proof it is given.
  function buildBtcShieldEnvelope({ asset, lockVout, cx, cy, pkEph, spendKey, openingProof }) {
    if ((Number(lockVout) >>> 0) === 0) throw new Error('btc-shielded-pool: lock_vout must be != 0 (mirrors the cBTC lock convention — a vout-0 lock is never recognized)');
    const op = hexToBytes(openingProof);
    if (op.length !== 64) throw new Error(`btc-shielded-pool: opening_proof must be 64 bytes, got ${op.length}`);
    const env = concat([Uint8Array.of(T_BTC_SHIELD), b32(asset), le4(lockVout), b32(cx), b32(cy), b32(pkEph), b32(spendKey), op]);
    if (env.length !== 229) throw new Error(`btc-shielded-pool: shield envelope must be 229 bytes, got ${env.length}`);
    return hx(env);
  }

  // Self-directed shield (design §2: "T_BTC_SHIELD uses the same construction, self-directed... no
  // special-cased path"). Depositor is their own recipient: derive a stealth spend_key against their own
  // published receiving key, exactly like a pay to someone else, then assemble the lock's Pedersen
  // commitment and the envelope around it.
  function buildBtcShield({ H, asset, lockVout, ephemeralPriv, ownSpendPub, value, blinding, buildOpeningProof }) {
    const { pkEph, spendKey } = deriveBtcPoolSpendKey({ recipientSpendPub: ownSpendPub, ephemeralPriv });
    const { cx, cy } = pedersenCommitXY(H, value, blinding);
    const openingProof = buildOpeningProof({ cx, cy, value, blinding });
    const env = buildBtcShieldEnvelope({ asset, lockVout, cx, cy, pkEph, spendKey, openingProof });
    return { envelope: env, leaf: btcPoolNoteLeaf(asset, cx, cy, spendKey), cx, cy, pkEph, spendKey };
  }

  // ── T_BTC_SPEND envelope builder (design §3) — pay or exit, never mixed ──
  function buildBtcSpendEnvelope({ asset, nullifiers, outKind, outputs, exitVout, exitValue, destSpkHash, hAnchor, proof }) {
    if (!nullifiers.length || nullifiers.length > BTC_POOL_MAX_IN) throw new Error('btc-shielded-pool: n_in out of range (1..2)');
    if (new Set(nullifiers.map((x) => String(x).toLowerCase())).size !== nullifiers.length) throw new Error('btc-shielded-pool: nullifiers must be pairwise distinct within one envelope');
    const parts = [Uint8Array.of(T_BTC_SPEND), b32(asset), Uint8Array.of(nullifiers.length)];
    for (const nf of nullifiers) parts.push(b32(nf));
    parts.push(Uint8Array.of(outKind));
    if (outKind === BTC_POOL_OUT_PAY) {
      if (!outputs || !outputs.length || outputs.length > BTC_POOL_MAX_OUT) throw new Error('btc-shielded-pool: n_out out of range (1..2)');
      parts.push(Uint8Array.of(outputs.length));
      for (const o of outputs) {
        const ct = hexToBytes(o.ctNote);
        if (ct.length !== CT_NOTE_LEN) throw new Error(`btc-shielded-pool: ct_note must be ${CT_NOTE_LEN} bytes`);
        parts.push(b32(o.cx), b32(o.cy), b32(o.pkEph), b32(o.spendKey), ct);
      }
    } else if (outKind === BTC_POOL_OUT_EXIT) {
      parts.push(le4(exitVout), le8(exitValue), b32(destSpkHash));
    } else {
      throw new Error('btc-shielded-pool: out_kind must be 0x00 (pay) or 0x01 (exit)');
    }
    parts.push(le4(hAnchor));
    parts.push(hexToBytes(proof)); // width not yet fixed (design "Still open" — pinned once the guest is compiled, Phase 2)
    return hx(concat(parts));
  }

  // Build a pay: derives each output's stealth spend_key/pk_eph, seals ct_note, computes nullifiers for
  // the spent inputs (requires their sk_note, i.e. the caller already recovered them via
  // `recoverBtcPoolSpendSecret` for each spent note), and hands the whole thing to `proveBtcPoolSpend`
  // (below) to get `proof`, then assembles the wire envelope. Structured the same shape as
  // dapp/confidential-swapbatch.js's build→prove→assemble pipeline.
  async function buildBtcSpendPay({ H, asset, inputs, outputs, hAnchor, prove }) {
    const nullifiers = inputs.map((i) => btcPoolNullifier(i.leaf, btcPoolNfSecret(i.skNote)));
    const builtOutputs = outputs.map((o) => {
      // `deriveBtcPoolSpendKey` may bump the ephemeral secret internally to land on an even-y spend_key
      // (its own comment explains why); `ephemeralPrivUsed` is the ACTUAL scalar behind the published
      // `pkEph`, and the AEAD key below must be derived from that same scalar, not the caller's original
      // seed — using the seed here would seal ct_note under a shared secret the recipient can never
      // reproduce (they only ever see the published pk_eph = G·ephemeralPrivUsed).
      const { pkEph, spendKey, ephemeralPrivUsed } = deriveBtcPoolSpendKey({ recipientSpendPub: o.recipientSpendPub, ephemeralPriv: o.ephemeralPriv });
      const { cx, cy } = pedersenCommitXY(H, o.value, o.blinding);
      const shared = ptFromRecipientAddr(o.recipientSpendPub).multiply(modN(BigInt(ephemeralPrivUsed)));
      const ctNote = sealCtNote({ sharedPt: shared, value: o.value, blinding: o.blinding });
      return { cx, cy, pkEph, spendKey, ctNote, value: o.value, blinding: o.blinding };
    });
    const witness = {
      asset, root: inputs[0] && inputs[0].root, hAnchor, outKind: BTC_POOL_OUT_PAY,
      inputs: inputs.map((i) => ({ cx: i.cx, cy: i.cy, spendKey: i.spendKey, value: i.value, blinding: i.blinding, leafIndex: i.leafIndex, path: i.path, skNote: i.skNote })),
      outputs: builtOutputs.map((o) => ({ cx: o.cx, cy: o.cy, pkEph: o.pkEph, spendKey: o.spendKey, ctNote: o.ctNote, value: o.value, blinding: o.blinding })),
    };
    const hBody = btcPoolHBody({ asset, nullifiers, outKind: BTC_POOL_OUT_PAY, outputs: builtOutputs, hAnchor });
    const { proof } = await prove(witness, { hBody });
    const envelope = buildBtcSpendEnvelope({
      asset, nullifiers, outKind: BTC_POOL_OUT_PAY,
      outputs: builtOutputs.map((o) => ({ cx: o.cx, cy: o.cy, pkEph: o.pkEph, spendKey: o.spendKey, ctNote: o.ctNote })),
      hAnchor, proof,
    });
    return { envelope, nullifiers, outputs: builtOutputs };
  }

  // Build an exit: same input side as a pay, no outputs, redeems straight to a real Bitcoin output.
  async function buildBtcSpendExit({ asset, inputs, exitVout, exitValue, destSpkHash, hAnchor, prove }) {
    const nullifiers = inputs.map((i) => btcPoolNullifier(i.leaf, btcPoolNfSecret(i.skNote)));
    const witness = {
      asset, root: inputs[0] && inputs[0].root, hAnchor, outKind: BTC_POOL_OUT_EXIT,
      inputs: inputs.map((i) => ({ cx: i.cx, cy: i.cy, spendKey: i.spendKey, value: i.value, blinding: i.blinding, leafIndex: i.leafIndex, path: i.path, skNote: i.skNote })),
      outputs: [], exitVout, exitValue, destSpkHash,
    };
    const hBody = btcPoolHBody({ asset, nullifiers, outKind: BTC_POOL_OUT_EXIT, outputs: [], exitVout, destSpkHash, hAnchor });
    const { proof } = await prove(witness, { hBody });
    const envelope = buildBtcSpendEnvelope({ asset, nullifiers, outKind: BTC_POOL_OUT_EXIT, exitVout, exitValue, destSpkHash, hAnchor, proof });
    return { envelope, nullifiers };
  }

  // ── prover call-out (STUB — no fourth SP1 guest built/pinned yet, design §4/§12 step 2) ──
  //
  // Structured exactly like dapp/confidential-swapbatch.js's `proveSwapBatch` (assemble witness → call
  // out to a prover → get back proof bytes matching the wire width), so wiring in the real thing later is
  // a body-swap, not a redesign. UNLIKE swap-batch's snarkjs-in-process Groth16 prover, this relation is an
  // SP1 program (design §4: "a fourth SP1 guest, not a new ceremony") — the existing settle/reflection
  // guests' proofs are produced out-of-process by a relay service (worker-relay/src/reflection-folder.js
  // per the codebase's own convention), not by an in-browser WASM call, so the real implementation of this
  // function will almost certainly be an HTTP call to that same class of relay service once it exists, not
  // an in-process library call like swapBatch's. Left unimplemented rather than guessed at.
  //
  // TODO(btc-pool-guest): once Phase 2 (the SP1 guest) and its prover-service endpoint exist, replace this
  // stub with the real call. Do not have this function fabricate or return a proof under any circumstance
  // before then — a caller that doesn't check for the thrown error would otherwise submit an envelope with
  // garbage `proof` bytes that the indexer's `verifyBtcPoolSpendProof` stub already always rejects anyway
  // (worker/src/btc-shielded-pool.js), but failing loudly here is strictly better than failing silently
  // two layers away.
  async function proveBtcPoolSpend(_witness, _publicContext) {
    throw new Error(
      'btc-shielded-pool: proveBtcPoolSpend is not implemented — the btc-pool SP1 guest (design §4/§12 '
      + 'step 2) has not been built or pinned yet. This is a deliberate stub; see the comment above '
      + 'proveBtcPoolSpend in dapp/btc-shielded-pool.js for what needs to be wired in.'
    );
  }

  // ── recipient-side note detection/scanning (design §6) ──
  //
  // "Unmodified reuse of the pool's existing pattern: scan accepted envelopes, attempt ECDH decryption of
  // each ct_note with the viewing key, verify the recovered plaintext re-derives the published leaf" —
  // mirrors dapp/confidential-memo.js's openMemo (decrypt, then reauthenticate against the on-chain leaf,
  // reject everything else silently) and dapp/confidential-lock-scan.js's event-driven, dependency-
  // injected shape (a caller-supplied stream of already-accepted envelopes, not raw RPC).
  //
  // `envelopes`: an array of already-accepted (per worker/src/btc-shielded-pool.js's acceptance-order
  // state machine) T_BTC_SHIELD/T_BTC_SPEND-pay envelopes, each `{ asset, cx, cy, pkEph, spendKey, ctNote,
  // leaf, leafIndex, path }` — i.e. already parsed and, for a spend-pay, per-output. `recipientSpendPriv`:
  // the viewing/spend private key to scan against.
  function scanBtcPoolNotes({ envelopes, recipientSpendPriv }) {
    const found = [];
    for (const e of envelopes) {
      if (!e || !e.pkEph) continue;
      try {
        const { skNote, spendKey } = recoverBtcPoolSpendSecret({ recipientSpendPriv, pkEph: e.pkEph });
        if (String(spendKey).toLowerCase() !== String(e.spendKey).toLowerCase()) continue; // not addressed to me
        const b = modN(BigInt(recipientSpendPriv));
        const E = ptFrom(e.pkEph);
        const shared = E.multiply(b);
        const opening = e.ctNote ? openCtNote({ sharedPt: shared, ctNoteHex: e.ctNote }) : null;
        if (!opening) continue; // addressed to me by key, but ct_note didn't open/authenticate — treat as not mine
        const rederivedLeaf = btcPoolNoteLeaf(e.asset, e.cx, e.cy, e.spendKey);
        if (e.leaf && String(rederivedLeaf).toLowerCase() !== String(e.leaf).toLowerCase()) continue; // tampered/mismatched
        found.push({
          asset: e.asset, cx: e.cx, cy: e.cy, spendKey: e.spendKey, skNote, value: opening.value, blinding: opening.blinding,
          leaf: rederivedLeaf, leafIndex: e.leafIndex, path: e.path,
        });
      } catch { /* one bad envelope must never abort the rest of the scan */ continue; }
    }
    return found;
  }

  return {
    btcPoolNoteLeaf, btcPoolNfSecret, btcPoolNullifier, btcPoolCanonicalBody, btcPoolHBody,
    deriveBtcPoolSpendKey, recoverBtcPoolSpendSecret,
    sealCtNote, openCtNote,
    buildBtcShieldEnvelope, buildBtcShield, buildBtcSpendEnvelope, buildBtcSpendPay, buildBtcSpendExit,
    proveBtcPoolSpend, scanBtcPoolNotes,
  };
}
