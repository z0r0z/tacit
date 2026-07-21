// Bitcoin / Taproot primitives extracted verbatim from tacit.js into a
// self-contained factory. Byte-faithful: implementations are copied exactly
// from the monolith; the only changes are parameterization of the network HRP
// and injection of the network I/O functions (getUtxos / broadcast / feeRate).
import { secp, sha256, ripemd160, hexToBytes, bytesToHex, concatBytes, bech32 } from './vendor/tacit-deps.min.js';

export function makeBtcWallet({ priv, hrp = 'bc', fetchUtxos, broadcastTx, fetchFeeRate }) {
  if (!(priv instanceof Uint8Array) || priv.length !== 32) {
    throw new Error('priv must be Uint8Array(32)');
  }

  // ---- curve constants ----
  const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const G = secp.ProjectivePoint.BASE;
  const ZERO = secp.ProjectivePoint.ZERO;

  const DUST = 546; // Bitcoin Core's P2PKH dust threshold — safe universal floor.

  // ============== HASH HELPERS ==============
  const hash256 = b => sha256(sha256(b));
  const hash160 = b => ripemd160(sha256(b));
  const reverseBytes = b => { const r = new Uint8Array(b); r.reverse(); return r; };

  // ============== BYTE WRITER ==============
  class W {
    constructor() { this.parts = []; }
    push(b) { this.parts.push(b); return this; }
    u8(n)   { this.parts.push(new Uint8Array([n & 0xff])); return this; }
    u32(n)  { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return this.push(b); }
    u64(n)  { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return this.push(b); }
    varint(n) {
      if (n < 0xfd)        return this.u8(n);
      if (n < 0x10000)     { this.u8(0xfd); const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return this.push(b); }
      if (n < 0x100000000) { this.u8(0xfe); const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return this.push(b); }
      this.u8(0xff); return this.u64(n);
    }
    out() { return concatBytes(...this.parts); }
  }

  const p2wpkhScript = pubkey => concatBytes(new Uint8Array([0x00, 0x14]), hash160(pubkey));
  const p2wpkhAddress = pubkey => bech32.encode(hrp, [0, ...bech32.toWords(hash160(pubkey))]);

  // ============== BIP143 SIGHASH ==============
  function sighashV0(tx, idx, scriptCode, value) {
    const w = new W();
    w.u32(tx.version);
    const wp = new W();
    for (const i of tx.inputs) { wp.push(reverseBytes(hexToBytes(i.txid))); wp.u32(i.vout); }
    w.push(hash256(wp.out()));
    const ws = new W();
    for (const i of tx.inputs) ws.u32(i.sequence);
    w.push(hash256(ws.out()));
    const inp = tx.inputs[idx];
    w.push(reverseBytes(hexToBytes(inp.txid)));
    w.u32(inp.vout);
    w.varint(scriptCode.length).push(scriptCode);
    w.u64(value);
    w.u32(inp.sequence);
    const wo = new W();
    for (const o of tx.outputs) { wo.u64(o.value); wo.varint(o.script.length).push(o.script); }
    w.push(hash256(wo.out()));
    w.u32(tx.locktime);
    w.u32(0x01); // SIGHASH_ALL
    return hash256(w.out());
  }

  function serializeTx(tx, withWitness = true) {
    const hasWit = withWitness && tx.inputs.some(i => i.witness && i.witness.length);
    const w = new W();
    w.u32(tx.version);
    if (hasWit) w.push(new Uint8Array([0x00, 0x01]));
    w.varint(tx.inputs.length);
    for (const i of tx.inputs) {
      w.push(reverseBytes(hexToBytes(i.txid)));
      w.u32(i.vout);
      const ss = i.scriptSig || new Uint8Array(0);
      w.varint(ss.length).push(ss);
      w.u32(i.sequence);
    }
    w.varint(tx.outputs.length);
    for (const o of tx.outputs) { w.u64(o.value); w.varint(o.script.length).push(o.script); }
    if (hasWit) {
      for (const i of tx.inputs) {
        const wit = i.witness || [];
        w.varint(wit.length);
        for (const item of wit) w.varint(item.length).push(item);
      }
    }
    w.u32(tx.locktime);
    return w.out();
  }
  const txid = tx => bytesToHex(reverseBytes(hash256(serializeTx(tx, false))));

  function derEncodeFromCompact(rs) {
    const trim = (x) => {
      let i = 0;
      while (i < x.length - 1 && x[i] === 0) i++;
      let t = x.slice(i);
      if (t[0] & 0x80) t = concatBytes(new Uint8Array([0]), t);
      return t;
    };
    const r = trim(rs.slice(0, 32));
    const s = trim(rs.slice(32, 64));
    return concatBytes(
      new Uint8Array([0x30, 4 + r.length + s.length]),
      new Uint8Array([0x02, r.length]), r,
      new Uint8Array([0x02, s.length]), s
    );
  }
  function sign(hash, priv) {
    const sig = secp.sign(hash, priv, { lowS: true });
    return concatBytes(derEncodeFromCompact(sig.toCompactRawBytes()), new Uint8Array([0x01]));
  }

  // ============== SCALAR / BYTE HELPERS ==============
  const modN = x => ((x % SECP_N) + SECP_N) % SECP_N;
  function bigintToBytes32(n) { const m = modN(n); return hexToBytes(m.toString(16).padStart(64, '0')); }
  const bytes32ToBigint = b => BigInt('0x' + bytesToHex(b));

  // ============== BIP-340 SCHNORR ==============
  function _taggedHash(tag, ...msgs) {
    const tagHash = sha256(new TextEncoder().encode(tag));
    return sha256(concatBytes(tagHash, tagHash, ...msgs));
  }
  function _xor32(a, b) { const r = new Uint8Array(32); for (let i = 0; i < 32; i++) r[i] = a[i] ^ b[i]; return r; }
  function signSchnorr(msgHash, priv32) {
    const dPrime = bytes32ToBigint(priv32);
    if (dPrime <= 0n || dPrime >= SECP_N) throw new Error('schnorr: invalid private key');
    const P = G.multiply(dPrime);
    const Pbytes = P.toRawBytes(true);
    const Px = Pbytes.slice(1);
    const d = (Pbytes[0] === 0x02) ? dPrime : (SECP_N - dPrime);
    const aux = crypto.getRandomValues(new Uint8Array(32));
    const t = _xor32(bigintToBytes32(d), _taggedHash('BIP0340/aux', aux));
    const rand = _taggedHash('BIP0340/nonce', t, Px, msgHash);
    let kPrime = bytes32ToBigint(rand) % SECP_N;
    if (kPrime === 0n) throw new Error('schnorr: nonce was zero');
    const R = G.multiply(kPrime);
    const Rbytes = R.toRawBytes(true);
    const Rx = Rbytes.slice(1);
    const k = (Rbytes[0] === 0x02) ? kPrime : (SECP_N - kPrime);
    const e = bytes32ToBigint(_taggedHash('BIP0340/challenge', Rx, Px, msgHash)) % SECP_N;
    const s = (k + e * d) % SECP_N;
    return concatBytes(Rx, bigintToBytes32(s));
  }

  // ============== TAPROOT (BIP-341) ==============
  const TAP_NUMS = hexToBytes('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');

  function _compactSize(n) {
    if (n < 0xfd) return new Uint8Array([n]);
    if (n <= 0xffff) {
      const b = new Uint8Array(3); b[0] = 0xfd;
      new DataView(b.buffer).setUint16(1, n, true); return b;
    }
    if (n <= 0xffffffff) {
      const b = new Uint8Array(5); b[0] = 0xfe;
      new DataView(b.buffer).setUint32(1, n, true); return b;
    }
    throw new Error('compactSize too big');
  }
  function tapLeafHash(script, leafVersion = 0xc0) {
    return _taggedHash('TapLeaf', new Uint8Array([leafVersion]), _compactSize(script.length), script);
  }
  function tweakedOutputKey(internalXonly, merkleRoot) {
    const P = secp.ProjectivePoint.fromHex('02' + bytesToHex(internalXonly));
    const t = _taggedHash('TapTweak', internalXonly, merkleRoot);
    const tBig = bytes32ToBigint(t);
    if (tBig >= SECP_N) throw new Error('tap tweak ≥ N');
    const Q = P.add(G.multiply(tBig));
    const Qbytes = Q.toRawBytes(true);
    return { Q_xonly: Qbytes.slice(1), parity: Qbytes[0] === 0x03 ? 1 : 0 };
  }
  function p2trScript(Q_xonly) {
    return concatBytes(new Uint8Array([0x51, 0x20]), Q_xonly);
  }
  function controlBlock(internalXonly, parity, leafVersion = 0xc0) {
    return concatBytes(new Uint8Array([leafVersion | (parity & 1)]), internalXonly);
  }
  function tapSighash(tx, inputIdx, prevouts, leafHash, hashType = 0x00) {
    if (prevouts.length !== tx.inputs.length) throw new Error('prevouts length mismatch');
    const u8 = v => new Uint8Array([v & 0xff]);
    const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
    const u64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
    const parts = [];
    parts.push(u8(0x00)); // epoch
    parts.push(u8(hashType));
    parts.push(u32(tx.version));
    parts.push(u32(tx.locktime));
    if ((hashType & 0x80) !== 0x80) {
      const buf = [];
      for (const inp of tx.inputs) {
        buf.push(reverseBytes(hexToBytes(inp.txid)));
        buf.push(u32(inp.vout));
      }
      parts.push(sha256(concatBytes(...buf)));
      const amts = []; for (const po of prevouts) amts.push(u64(po.value));
      parts.push(sha256(concatBytes(...amts)));
      const spks = [];
      for (const po of prevouts) { spks.push(_compactSize(po.script.length)); spks.push(po.script); }
      parts.push(sha256(concatBytes(...spks)));
      const seqs = []; for (const inp of tx.inputs) seqs.push(u32(inp.sequence ?? 0xffffffff));
      parts.push(sha256(concatBytes(...seqs)));
    }
    const baseHt = hashType & 0x03;
    // BIP-341 sha_outputs is included for ALL/DEFAULT (0x00, 0x01) but NOT for
    // NONE (0x02) or SINGLE (0x03). SINGLE has its own sha_single_output appended
    // later (after the spend_type / outpoint section). DEFAULT (hashType=0x00)
    // is treated as ALL per BIP-341.
    if (baseHt === 0x00 || baseHt === 0x01) {
      const outs = [];
      for (const out of tx.outputs) {
        outs.push(u64(out.value));
        outs.push(_compactSize(out.script.length));
        outs.push(out.script);
      }
      parts.push(sha256(concatBytes(...outs)));
    }
    const ext_flag = 1; // tapscript path
    parts.push(u8((ext_flag << 1) | 0));
    if ((hashType & 0x80) === 0x80) {
      const inp = tx.inputs[inputIdx]; const po = prevouts[inputIdx];
      parts.push(reverseBytes(hexToBytes(inp.txid)));
      parts.push(u32(inp.vout));
      parts.push(u64(po.value));
      parts.push(_compactSize(po.script.length));
      parts.push(po.script);
      parts.push(u32(inp.sequence ?? 0xffffffff));
    } else {
      parts.push(u32(inputIdx));
    }
    // BIP-341 sha_single_output: only when hash_type & 3 == SINGLE (0x03). Goes
    // after the input section (outpoint or input_index) and before the
    // tapscript-specific tapleaf_hash. We don't support annex, so no annex_hash.
    if (baseHt === 0x03) {
      if (inputIdx >= tx.outputs.length) throw new Error('SIGHASH_SINGLE: no output at input index');
      const out = tx.outputs[inputIdx];
      parts.push(sha256(concatBytes(u64(out.value), _compactSize(out.script.length), out.script)));
    }
    parts.push(leafHash);
    parts.push(u8(0x00)); // key_version
    parts.push(u32(0xffffffff)); // codesep_pos
    return _taggedHash('TapSighash', concatBytes(...parts));
  }

  // BIP-341 KEY-PATH sighash — used by the slot-spend reveal txs in T_SLOT_BURN /
  // T_SLOT_ROTATE. Differs from tapSighash (script-path) in ext_flag=0 and the
  // omission of leaf_hash / key_version / codesep_pos at the end. The signer
  // signs with the secret scalar r_leaf as the Schnorr private key.
  function tapSighashKeyPath(tx, inputIdx, prevouts, hashType = 0x00) {
    if (prevouts.length !== tx.inputs.length) throw new Error('prevouts length mismatch');
    const u8 = v => new Uint8Array([v & 0xff]);
    const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
    const u64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
    const parts = [];
    parts.push(u8(0x00)); // epoch
    parts.push(u8(hashType));
    parts.push(u32(tx.version));
    parts.push(u32(tx.locktime));
    if ((hashType & 0x80) !== 0x80) {
      const buf = [];
      for (const inp of tx.inputs) {
        buf.push(reverseBytes(hexToBytes(inp.txid)));
        buf.push(u32(inp.vout));
      }
      parts.push(sha256(concatBytes(...buf)));
      const amts = []; for (const po of prevouts) amts.push(u64(po.value));
      parts.push(sha256(concatBytes(...amts)));
      const spks = [];
      for (const po of prevouts) { spks.push(_compactSize(po.script.length)); spks.push(po.script); }
      parts.push(sha256(concatBytes(...spks)));
      const seqs = []; for (const inp of tx.inputs) seqs.push(u32(inp.sequence ?? 0xffffffff));
      parts.push(sha256(concatBytes(...seqs)));
    }
    const baseHt = hashType & 0x03;
    if (baseHt === 0x00 || baseHt === 0x01) {
      const outs = [];
      for (const out of tx.outputs) {
        outs.push(u64(out.value));
        outs.push(_compactSize(out.script.length));
        outs.push(out.script);
      }
      parts.push(sha256(concatBytes(...outs)));
    }
    const ext_flag = 0; // KEY PATH (vs 1 for tapscript path)
    parts.push(u8((ext_flag << 1) | 0));
    if ((hashType & 0x80) === 0x80) {
      const inp = tx.inputs[inputIdx]; const po = prevouts[inputIdx];
      parts.push(reverseBytes(hexToBytes(inp.txid)));
      parts.push(u32(inp.vout));
      parts.push(u64(po.value));
      parts.push(_compactSize(po.script.length));
      parts.push(po.script);
      parts.push(u32(inp.sequence ?? 0xffffffff));
    } else {
      parts.push(u32(inputIdx));
    }
    if (baseHt === 0x03) {
      if (inputIdx >= tx.outputs.length) throw new Error('SIGHASH_SINGLE: no output at input index');
      const out = tx.outputs[inputIdx];
      parts.push(sha256(concatBytes(u64(out.value), _compactSize(out.script.length), out.script)));
    }
    // KEY PATH ends here — no leaf_hash, no key_version, no codesep_pos.
    return _taggedHash('TapSighash', concatBytes(...parts));
  }

  // ============== ENVELOPE ==============
  const ENVELOPE_MAGIC = new TextEncoder().encode('TACIT');
  const ENVELOPE_VERSION = 0x01;
  const MAX_SCRIPT_PUSH = 520;
  const OP_FALSE = 0x00, OP_PUSHDATA1 = 0x4c, OP_PUSHDATA2 = 0x4d;
  const OP_IF = 0x63, OP_ENDIF = 0x68, OP_CHECKSIG = 0xac;

  function _encodePush(data) {
    if (data.length === 0) return new Uint8Array([OP_FALSE]);
    if (data.length <= 75) return concatBytes(new Uint8Array([data.length]), data);
    if (data.length <= 255) return concatBytes(new Uint8Array([OP_PUSHDATA1, data.length]), data);
    if (data.length <= 65535) {
      const lenLE = new Uint8Array(2); new DataView(lenLE.buffer).setUint16(0, data.length, true);
      return concatBytes(new Uint8Array([OP_PUSHDATA2]), lenLE, data);
    }
    throw new Error('push data too large');
  }
  function encodeEnvelopeScript(signingPubXonly, payload) {
    if (signingPubXonly.length !== 32) throw new Error('signing pubkey must be 32 bytes (x-only)');
    const chunks = [ENVELOPE_MAGIC, new Uint8Array([ENVELOPE_VERSION])];
    for (let i = 0; i < payload.length; i += MAX_SCRIPT_PUSH) {
      chunks.push(payload.slice(i, Math.min(i + MAX_SCRIPT_PUSH, payload.length)));
    }
    const pieces = [
      _encodePush(signingPubXonly),
      new Uint8Array([OP_CHECKSIG]),
      new Uint8Array([OP_FALSE, OP_IF]),
    ];
    for (const c of chunks) pieces.push(_encodePush(c));
    pieces.push(new Uint8Array([OP_ENDIF]));
    return concatBytes(...pieces);
  }

  // ============== SILENT PAYMENTS (BIP-352) ==============
  function deriveSilentPaymentScanPriv(spendPriv) {
    const h = _taggedHash('BIP0352/ScanKey', spendPriv);
    const s = bytes32ToBigint(h) % SECP_N;
    if (s === 0n) throw new Error('scan key derived as zero');
    return bigintToBytes32(s);
  }

  function deriveSilentPaymentKeys(spendPriv) {
    const scanPriv = deriveSilentPaymentScanPriv(spendPriv);
    const scanPub  = secp.getPublicKey(scanPriv, true);
    const spendPub = secp.getPublicKey(spendPriv, true);
    return { scanPriv, scanPub, spendPub };
  }

  // ============== WALLET ==============
  const pub = secp.getPublicKey(priv, true);
  const wallet = {
    priv,
    pub,
    pubHex: () => bytesToHex(pub),
    xonly: () => pub.slice(1),
    address: () => p2wpkhAddress(pub),
  };

  // ============== FEE EST ==============
  const inputVbytes = 68;        // P2WPKH input: 41 non-witness + 107 witness → 68 vbytes
  const p2trKeypathInputVbytes = 58; // P2TR keypath: 41 non-witness + 66 witness → 57.5 → 58 vbytes (ceil)
  const p2wpkhOutVbytes = 31;
  const p2trOutVbytes = 43;
  function estCommitVb(numInputs) { return 11 + numInputs * inputVbytes + p2trOutVbytes + p2wpkhOutVbytes; }
  const feeFor = (vb, rate) => Math.max(500, Math.ceil(vb * rate));

  // ============== SIGNERS ==============
  // Build a P2WPKH BIP-143 sighash and signed witness for input idx of tx
  function signP2wpkhInput(tx, idx, prevValue) {
    const scriptCode = concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), hash160(wallet.pub), new Uint8Array([0x88, 0xac]));
    const sh = sighashV0(tx, idx, scriptCode, prevValue);
    const sig = sign(sh, wallet.priv); // ECDSA DER + SIGHASH_ALL
    return [sig, wallet.pub];
  }

  function signTaprootKeypathInput(tx, inputIdx, prevouts, privKey) {
    const sh = tapSighashKeyPath(tx, inputIdx, prevouts, 0x00);
    const sig = signSchnorr(sh, privKey);
    return [sig];
  }

  function signCommitInputs(commitTx, picked, wpkhSpk) {
    const prevouts = picked.map(u => ({
      value: u.value,
      script: (u.scriptpubkey && u.scriptpubkey.startsWith('5120'))
        ? hexToBytes(u.scriptpubkey)
        : wpkhSpk,
    }));
    for (let i = 0; i < commitTx.inputs.length; i++) {
      if (picked[i].scriptpubkey && picked[i].scriptpubkey.startsWith('5120')) {
        commitTx.inputs[i].witness = signTaprootKeypathInput(commitTx, i, prevouts);
      } else {
        commitTx.inputs[i].witness = signP2wpkhInput(commitTx, i, picked[i].value);
      }
    }
  }

  // Build a Taproot script-path BIP-341 sighash and signed witness for input 0 of tx
  function signTaprootScriptPathInput(tx, prevouts, envelopeScript, controlBlockBytes) {
    const leaf = tapLeafHash(envelopeScript);
    const sh = tapSighash(tx, 0, prevouts, leaf, 0x00);
    const sig = signSchnorr(sh, wallet.priv);
    return [sig, envelopeScript, controlBlockBytes];
  }

  // ============== NETWORK (injected) ==============
  const getUtxos = (address) => fetchUtxos(address);
  const broadcast = (hex) => broadcastTx(hex);
  const getFeeRate = (tier) => fetchFeeRate(tier);

  async function broadcastWithRetry(hex, attempts = 4, baseDelayMs = 1000) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, baseDelayMs * i));
      try { return await broadcast(hex); }
      catch (e) {
        lastErr = e;
        const msg = (e && e.message) || '';
        if (/already in block|already known/i.test(msg)) return null;
        if (/too-long-mempool-chain/i.test(msg)) {
          throw new Error(
            'Bitcoin mempool ancestor-chain limit hit (25 unconfirmed parents). ' +
            'Your sats UTXOs depend on a long chain of unconfirmed self-sends. ' +
            'Wait for one of your unconfirmed txs to confirm (signet: ~5–15 min), ' +
            'then retry. Or top up from a fresh source (e.g. signet faucet) — ' +
            'fresh sats have no shared ancestry and bypass the limit.'
          );
        }
        if (/rate limited|429/i.test(msg)) {
          await new Promise(r => setTimeout(r, Math.min(8000, (i + 1) * 3000)));
          continue;
        }
        if (!/missing inputs|mempool-conflict|bad-txns-inputs-missingorspent/i.test(msg)) {
          throw e;
        }
      }
    }
    throw lastErr || new Error('broadcast failed');
  }

  const prims = {
    wallet,
    encodeEnvelopeScript,
    tapLeafHash,
    tweakedOutputKey,
    TAP_NUMS,
    p2trScript,
    controlBlock,
    p2wpkhScript,
    feeFor,
    getFeeRate,
    getUtxos,
    signCommitInputs,
    signTaprootScriptPathInput,
    serializeTx,
    txid,
    broadcast,
    broadcastWithRetry,
    estCommitVb,
    DUST,
    bytesToHex,
    hexToBytes,
  };

  return { wallet, prims, deriveSilentPaymentKeys };
}
