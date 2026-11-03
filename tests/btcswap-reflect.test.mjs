// The Bitcoin-to-Bitcoin swap's desk leg as the reflection sees it, built by the real builders under the real TAC asset id: the
// desk's tracked note locked into the joint lock (dapp/btcswap.js jointLock, adaptor-btc-tx lockTransfer), and the holder's claim of
// it by key path, signed by both with MuSig2, the desk's half adapted to T (dapp/musig2.js). The reflection's fold (the JS mirror
// of the guest) leaves the holder's claimed note live, so it bridges in one burn; the desk reads t back from that same signature.
// DUMP=<file> keeps the blocks for the pinned guest (tests/gen-reflection-dump-synth.mjs <file> swap).
//   node tests/btcswap-reflect.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as rootSecp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { loadTacit } from '../worker-relay/src/lib/btc-pool-transparent.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit } from '../dapp/adaptor-btc-tx.js';
import { G, SECP_N, pedersenCommit, bigintToBytes32 } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes, sha256 } from '../dapp/vendor/tacit-deps.min.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import * as S from '../dapp/btcswap.js';
import * as M from '../dapp/musig2.js';

const tacit = await loadTacit('mainnet');
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const scalar = (tag) => (BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode(tag)))) % (SECP_N - 1n)) + 1n;
const rev = (h) => h.match(/../g).reverse().join('');
const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name)), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 2 });
const dW = wallet('desk'), hW = wallet('holder');
const kit = tacitKit(tacit);
const dTx = makeAdaptorBtcTx({ prims: dW.prims, kit }), hTx = makeAdaptorBtcTx({ prims: hW.prims, kit });
const coin = (tag) => [{ txid: bytesToHex(sha256(new TextEncoder().encode(tag))), vout: 0, value: 100_000 }];

// The desk's tracked note, at its P2WPKH address.
const DESK_NOTE = { txid: 'd7'.repeat(32), vout: 0, value: 546, amount: 100_000_000_000n, blinding: scalar('desk-note') };
const OUT = 99_000_000_000n;
const swapId = hexToBytes('ab'.repeat(36));
const mine = S.deskSwapSecrets({ seed: sha256(new TextEncoder().encode('desk-seed')), swapId });
const t = scalar('holder-t'), T = G.multiply(t);

function legs() {
  const lock = S.jointLock({ prims: dW.prims, holderPub: hW.prims.wallet.pub, deskPub: mine.pub, deskXonly: dW.prims.wallet.pub.slice(1), csvBlocks: 144 });
  const lockPair = dTx.lockTransfer({ asset: hexToBytes(TAC), notes: [DESK_NOTE], lock, lockAmount: OUT, rLock: mine.rLock, satsUtxos: coin('desk-coin'), feeRate: 2 });
  const claim = hTx.jointClaimTransfer({ asset: hexToBytes(TAC), lockOut: { txid: lockPair.revealTxid, vout: 0, value: lockPair.revealTx.outputs[0].value }, lock, amount: OUT, rLock: mine.rLock, satsUtxos: coin('holder-coin'), feeRate: 2 });
  // the two rounds, as the holder and the desk run them
  const hN = M.nonceGen({ sk: hW.prims.wallet.priv, pk: hW.prims.wallet.pub, aggXonly: lock.keys.xonly, msg: claim.sighash });
  const dN = M.nonceGen({ sk: bigintToBytes32(mine.d), pk: mine.pub, aggXonly: lock.keys.xonly, msg: claim.sighash });
  const sess = M.session({ keys: lock.keys, pubnonces: [hN.pubnonce, dN.pubnonce], msg: claim.sighash, T });
  const hS = M.partialSign({ secnonce: hN.secnonce, sk: hW.prims.wallet.priv, sess });
  const dS = M.partialSign({ secnonce: dN.secnonce, sk: mine.d, sess });
  const sPre = M.partialAgg({ psigs: [hS, dS], sess });
  const sig = M.adapt({ sPre, t, sess });
  const signed = hTx.withKeyPathSig({ revealJson: claim.revealJson, sighash: claim.sighash, sig, outputXonly: lock.outputXonly });
  return {
    lock, sess, sPre, sig,
    lockTx: { txid: lockPair.revealTxid, hex: lockPair.revealHex, vins: lockPair.revealTx.inputs.map((i) => ({ txid: i.txid, vout: i.vout })) },
    claimTx: { txid: claim.revealTxid, hex: signed.revealHex, vins: signed.revealTx.inputs.map((i) => ({ txid: i.txid, vout: i.vout })) },
  };
}

async function reflect(txs) {
  const ix = makeScanReflectionIndexer({ secp: rootSecp, keccak256: keccak_256, sha256: nobleSha256 });
  const cp = ix.pool, norm = (x) => cp._internal.hx(cp._internal.b32(x));
  const P = pedersenCommit(DESK_NOTE.amount, DESK_NOTE.blinding).toAffine();
  const cx = '0x' + P.x.toString(16).padStart(64, '0'), cy = '0x' + P.y.toString(16).padStart(64, '0');
  const key = cp.outpointKey('0x' + rev(DESK_NOTE.txid), DESK_NOTE.vout);
  ix.state()._acc.live.insert(key, cp.commitmentHash(cx, cy), '0x' + TAC);
  ix.coords().set(norm(key), { cx, cy });
  const input = await ix.assembleBlocks([{ txs: txs.map((x) => ({ txidDisplay: x.txid, rawHex: x.hex, decode: classifyConfidentialTx('0x' + x.hex), vins: x.vins.map((i) => ({ prevTxidDisplay: i.txid, vout: i.vout })) })) }], { headers: [], anchorHeight: 100 });
  if (process.env.DEBUG_FOLD) console.log(JSON.stringify(input.nonConserving), JSON.stringify(input.blocks[0].txs.map((x) => x.outputs.length)));
  return (txid, vout) => ix.state()._acc.live.triples().some((x) => String(x[0]).toLowerCase() === String(cp.outpointKey('0x' + rev(txid), vout)).toLowerCase());
}

const l = legs();
const live = await reflect([l.lockTx, l.claimTx]);
assert.ok(!live(l.lockTx.txid, 0), 'the desk\'s lock is spent by the claim');
assert.ok(live(l.lockTx.txid, 1), 'the desk\'s change is tracked');
assert.ok(live(l.claimTx.txid, 0), 'the holder\'s claimed note is tracked: it bridges in one burn');
assert.ok(!live(DESK_NOTE.txid, 0), 'the desk\'s note is spent');
// the claim's witness is one 64-byte signature, and the desk reads t from it with the pre-signature it kept
assert.equal(M.extract({ sig: l.sig, sPre: l.sPre, sess: l.sess }), t);
assert.equal(S.extractT({ witness: [bytesToHex(l.sig)], sessions: [{ msg: bytesToHex(l.sess.msg), pubnonces: l.sess.pubnonces.map(bytesToHex), sPre: l.sPre.toString(16).padStart(64, '0') }], keys: l.lock.keys, T }), t);
console.log('ok - the desk\'s lock and the holder\'s MuSig2 key-path claim fold live; t comes back from the claim');

if (process.env.DUMP) {
  writeFileSync(process.env.DUMP, JSON.stringify({ tac: TAC, swap: { txs: [l.lockTx, l.claimTx], live: [{ txid: DESK_NOTE.txid, vout: 0, k: '0x' + DESK_NOTE.blinding.toString(16), amount: String(DESK_NOTE.amount) }] } }));
  console.log('kept the blocks in', process.env.DUMP);
}

process.exit(0);
