// Binding Bitcoin notes to the Ethereum pool: one Tacit transfer (T_CXFER_BOUND) from the wallet's notes to its own
// Taproot address, in the sizes the holder wants. Once reflection has folded that transaction, each bound note can be
// spent straight into the pool (the fast lane, confidential-pool-ux.js fastlaneExit) under the Taproot key, with no
// bridge burn. A Bitcoin spend of a bound note stays pending until reflection passes its block (SPEC §5.2).
//
// The bound outputs sit at P2TR(the wallet's x-only key), untweaked, the address bridged notes already land at, so the
// note's authority key is the wallet key itself. Their blindings and amounts use the wallet's own change channel
// (deriveChangeBlinding / deriveAmountKeystreamSelf over the first input), so the key alone finds and opens them again.
//
// Pure: no network, no storage. A caller sends the pair with makeAdaptorBtcTx's broadcastPair.

import { concatBytes, hexToBytes, bytesToHex } from './vendor/tacit-deps.min.js';
import { makeAdaptorBtcTx } from './adaptor-btc-tx.js';

export const T_CXFER_BOUND = 0x39;
export const MAX_BOUND_OUTPUTS = 8;

const asBig = (x) => (typeof x === 'bigint' ? x : BigInt(x));
const u32le = (n) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
const bytes32 = (h, what) => {
  const b = h instanceof Uint8Array ? h : hexToBytes(String(h).replace(/^0x/, ''));
  if (b.length !== 32) throw new Error(`btc-bind: ${what} must be 32 bytes`);
  return b;
};

// The bound payload is the Bulletproofs+ transfer payload with the opcode swapped and the pool's chain binding after it.
export function boundKit(kit, target) {
  const t = bytes32(target, 'the chain binding');
  return {
    ...kit,
    encodePayload: (args) => {
      const p = kit.encodePayload(args);
      return concatBytes(Uint8Array.of(T_CXFER_BOUND), t, p.subarray(1));
    },
  };
}

export function makeBtcBind({ prims, kit, target }) {
  const { wallet } = prims;
  const tx = makeAdaptorBtcTx({ prims, kit: boundKit(kit, target) });
  const own = prims.p2wpkhScript(wallet.pub);
  const fastScript = prims.p2trScript(wallet.xonly());
  const anchorOf = (n) => concatBytes(Uint8Array.from(hexToBytes(n.txid)).reverse(), u32le(n.vout));

  // A note at the wallet's P2WPKH address signs by its key; one at the Taproot address (a bound note split again) by key path.
  const inputOf = (n) => {
    const taproot = !!n.taproot;
    return {
      txid: n.txid, vout: n.vout, value: n.value, amount: n.amount, blinding: n.blinding,
      spk: taproot ? fastScript : own,
      witnessSizes: taproot ? [64] : [72, 33],
      sign: taproot
        ? (t, idx, prevouts) => prims.signTaprootKeypathInput(t, idx, prevouts, wallet.priv)
        : (t, idx, prevouts) => prims.signP2wpkhInput(t, idx, prevouts[idx].value),
    };
  };

  // BIND: the notes' whole value into bound notes of `sizes` (default one note), each at the Taproot address.
  function bindTransfer({ asset, notes, sizes = null, satsUtxos, feeRate }) {
    if (!notes || !notes.length) throw new Error('btc-bind: nothing to bind');
    const total = notes.reduce((s, n) => s + asBig(n.amount), 0n);
    const parts = (sizes && sizes.length ? sizes : [total]).map(asBig);
    if (parts.length > MAX_BOUND_OUTPUTS) throw new Error(`btc-bind: at most ${MAX_BOUND_OUTPUTS} bound notes in one transaction`);
    if (parts.some((v) => v <= 0n)) throw new Error('btc-bind: every bound note must hold something');
    if (parts.reduce((s, v) => s + v, 0n) !== total) throw new Error('btc-bind: the sizes must add up to the notes being bound');
    const inputs = notes.map(inputOf);
    const anchor = anchorOf(inputs[0]);
    const outputs = parts.map((amount, i) => ({
      amount, script: fastScript,
      blinding: kit.deriveChangeBlinding(wallet.priv, anchor, i),
      keystream: kit.deriveAmountKeystreamSelf(wallet.priv, anchor, i),
    }));
    const pair = tx.transfer({ asset, inputs, outputs, satsUtxos, feeRate });
    return { ...pair, bound: outputs.map((o, vout) => ({ vout, amount: o.amount, blinding: o.blinding })) };
  }

  // UNBIND: one bound note back to ordinary TAC at the wallet's trading address, a plain transfer (Bulletproofs+) signed by key path.
  // The wallet opens it by its own change channel; like any spend of a bound note it is pending until the reflection passes it.
  const plain = makeAdaptorBtcTx({ prims, kit });
  function unbindTransfer({ asset, note, satsUtxos, feeRate }) {
    const input = inputOf({ ...note, taproot: true });
    const anchor = anchorOf(input);
    const out = {
      amount: asBig(note.amount), script: own,
      blinding: kit.deriveChangeBlinding(wallet.priv, anchor, 0),
      keystream: kit.deriveAmountKeystreamSelf(wallet.priv, anchor, 0),
    };
    return plain.transfer({ asset, inputs: [input], outputs: [out], satsUtxos, feeRate });
  }

  return { bindTransfer, unbindTransfer, fastScript, broadcastPair: tx.broadcastPair };
}

// The pool's storage a fast-lane spend is checked against: knownBitcoinRoot (a map, slot 78) and knownBitcoinSpentRoot
// (slot 79), from `forge inspect ConfidentialPool storageLayout`. `getStorageAt(pool, slot)` returns a 32-byte hex word.
export const SLOT_KNOWN_BITCOIN_ROOT = 78n, SLOT_KNOWN_BITCOIN_SPENT_ROOT = 79n;
export function makePoolRoots({ pool, getStorageAt, keccak256 }) {
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const isZero = (h) => /^(0x)?0*$/.test(String(h));
  return {
    isKnownRoot: async (root) => !isZero(await getStorageAt(pool, '0x' + bytesToHex(keccak256(hexToBytes(String(root).replace(/^0x/, '').padStart(64, '0') + word(SLOT_KNOWN_BITCOIN_ROOT)))))),
    spentRoot: async () => '0x' + String(await getStorageAt(pool, '0x' + word(SLOT_KNOWN_BITCOIN_SPENT_ROOT))).replace(/^0x/, '').padStart(64, '0'),
  };
}

// Whether a bound note can move by the fast lane now, and if so its input to buildFastlaneExitOp. `witnessFor({ leaves,
// nullifiers })` is POST /reflection/note-witness; the roots it answers with must be the pool's own, or a spend made
// on them would revert. `why` says what it waits for: 'reflecting' (the bind is not folded yet), 'spent' (gone on
// Bitcoin or already moved) or 'syncing' (the relay's state and the pool's differ for now).
export async function fastLaneNote({ pool, roots, witnessFor, note, authKey, chainBinding }) {
  const blinding = '0x' + asBig(note.blinding).toString(16).padStart(64, '0');
  const { cx, cy } = pool.commitXY(asBig(note.amount), blinding);
  const leaf = pool.btcNoteLeafBound(note.asset, cx, cy, authKey, chainBinding);
  const nu = pool.nullifier(leaf);
  const w = await witnessFor({ leaves: [leaf], nullifiers: [nu] });
  const at = w && w.witnesses && w.witnesses[leaf];
  if (!at) return { ready: false, why: 'reflecting', nullifier: nu };
  const low = w.unspent && w.unspent[nu];
  if (!low) return { ready: false, why: 'syncing', nullifier: nu };
  if (low.spent) return { ready: false, why: 'spent', nullifier: nu };
  const [known, spentRoot] = await Promise.all([roots.isKnownRoot(w.root), roots.spentRoot()]);
  if (!known || String(spentRoot).toLowerCase() !== String(w.spentRoot).toLowerCase()) return { ready: false, why: 'syncing', nullifier: nu };
  return {
    ready: true, nullifier: nu, spendRoot: w.root, bitcoinSpentRoot: w.spentRoot,
    input: { asset: note.asset, value: String(note.amount), blinding, cx, cy, authKey, leafIndex: at.leafIndex, path: at.path, low },
  };
}

// A bound note of this key, opened from the key and the chain alone: `tx` is the esplora transaction, `tacit` the
// dapp's tacit.js namespace. Null when the output is not a T_CXFER_BOUND note this key can open.
export function openBoundNote({ tacit, priv, pub, tx, vout }) {
  const env = tacit.txOutputEnvelope(tx);
  if (!env || env.opcode !== T_CXFER_BOUND || !tx.vin || tx.vin.length < 2) return null;
  const p = env.payload;
  const target = p.subarray(1, 33), asset = p.subarray(33, 65);
  const n = p[129];
  if (![1, 2, 4, 8].includes(n) || vout >= n) return null;
  const at = 130 + vout * 41;
  const commitment = p.subarray(at, at + 33), ct = p.subarray(at + 33, at + 41);
  const first = tx.vin[1];
  const anchorBytes = concatBytes(Uint8Array.from(hexToBytes(first.txid)).reverse(), u32le(first.vout));
  const opened = tacit.openTransferOutput({ priv, pub, senderPubHex: null, anchorBytes, vout, ct, commitment });
  if (!opened || opened.amount === 0n) return null;
  return { asset: bytesToHex(asset), target: bytesToHex(target), amount: opened.amount, blinding: opened.blinding, commitment: bytesToHex(commitment) };
}
