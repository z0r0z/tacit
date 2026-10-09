#!/usr/bin/env node
// dapp/crossout-notes.js: the notes a key holds at its own Taproot output because a cross-out minted them, found from the key and
// public data. Real cryptography throughout (the commitment, the mint reveal's signing and envelope, the HMAC blinding); the
// Bitcoin explorer, the worker and the Ethereum node are stubbed by a small in-memory world.
//
// Run: node tests/crossout-notes.test.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialEvmLog } from '../dapp/confidential-evm-log.js';

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };

await import('../scratchpad/domshim2.mjs');
const { secp } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(nobleSha256, k, secp.etc.concatBytes(...m));
const { makeBtcWallet } = await import('../dapp/bitcoin-taproot-wallet.js');
const { makeCrossoutMintReveal } = await import('../dapp/crossout-mint-reveal.js');
const { makeCrossoutNotes, p2trAddress, solveAmount } = await import('../dapp/crossout-notes.js');
const { pedersenCommit } = await import('../dapp/bulletproofs-plus.js');

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const evmLog = makeConfidentialEvmLog({ keccak256: keccak_256 });
const stripHex = (h) => String(h).replace(/^0x/, '');
const withHex = (h) => '0x' + stripHex(h);
const hexToBytes = (h) => { const s = stripHex(h); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ---- the address of an x-only key: BIP-350's segwit v1 vector ----
ok(p2trAddress('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'bc') === 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'the P2TR address of a 32-byte key matches the BIP-350 vector');
ok(/^tb1p/.test(p2trAddress('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'tb')), 'and takes another prefix');
assert.throws(() => p2trAddress('00'.repeat(31)), /32 bytes/);
ok(true, 'a key that is not 32 bytes is refused');

// ---- the amount from a commitment ----
{
  const H = pedersenCommit(1n, 0n);
  const at = (a) => pedersenCommit(BigInt(a), 0n);
  void H;
  const cases = [1n, 2n, 8192n, 8193n, 16384n, 400_000n, 500_000n, 123_457n, 67_108_863n];
  for (const a of cases) ok(solveAmount(at(a), 26) === a, `${a} units is recovered from its commitment`);
  ok(solveAmount(at(70_000_000n), 26) === null, 'an amount past the search range is reported as not found, not guessed');
  ok(solveAmount(secp.ProjectivePoint.BASE.multiply(5n), 26) === null, 'a point that is no multiple of H in range is not found');
}

// ---- discovery over a real, signed mint reveal ----
const WALLET_PRIV = new Uint8Array(32).fill(0x31);
const PUB = secp.getPublicKey(WALLET_PRIV, true), XONLY = bytesToHex(PUB.slice(1));
const TETH = withHex('3c'.repeat(32)), TAC = withHex('f0'.repeat(32));
const POOL_ADDR = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const wallet = makeBtcWallet({ priv: WALLET_PRIV, hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 3 });
const P = wallet.prims;
const mintReveal = makeCrossoutMintReveal({ secp });

function destBlindingOf(nullifier) {
  const domain = new TextEncoder().encode('tacit-crossout-blinding-v1'), nb = hexToBytes(nullifier);
  const msg = new Uint8Array(domain.length + nb.length); msg.set(domain); msg.set(nb, domain.length);
  let b = 0n; for (const x of hmac(nobleSha256, WALLET_PRIV, msg)) b = (b << 8n) | BigInt(x);
  b %= secp.CURVE.n; return b === 0n ? 1n : b;
}
const topicCrossOut = evmLog.TOPIC0.CrossOutRecorded;
function crossOutLog({ claimId, destCommitment, nullifier, assetId, block }) {
  const data = new Uint8Array(128); data[31] = 1; data.set(hexToBytes(destCommitment), 32); data.set(hexToBytes(nullifier), 64); data.set(hexToBytes(assetId), 96);
  return { address: POOL_ADDR, topics: [topicCrossOut, claimId], data: '0x' + bytesToHex(data), blockNumber: '0x' + block.toString(16), transactionHash: '0x' + 'ee'.repeat(32) };
}

// One cross-out of `amount` of `assetId`: its settle event and its mint reveal (signed with the real builder).
function makeBridge({ assetId, amount, nullifier, seed }) {
  const r = destBlindingOf(nullifier);
  const { cx, cy } = pool.commitXY(amount, r);
  const destCommitment = pool.btcNoteLeaf(assetId, cx, cy, withHex(XONLY));
  const claimId = withHex(bytesToHex(keccak_256(Buffer.from(destCommitment + nullifier + assetId + seed, 'utf8'))));
  const built = mintReveal.buildCrossoutMintTxs({ prims: P, assetId, claimId, cx, cy, destXonly: XONLY, fundingUtxo: { txid: seed.repeat(32).slice(0, 64), vout: 0, value: 50_000 }, feeRate: 3 });
  return { assetId, amount, nullifier, r, cx, cy, destCommitment, claimId, revealHex: built.revealHex, revealTxid: built.revealTxid, log: crossOutLog({ claimId, destCommitment, nullifier, assetId, block: 26_000_000 }) };
}
const B1 = makeBridge({ assetId: TETH, amount: 400_000n, nullifier: withHex('a1'.repeat(32)), seed: '61' });
const B2 = makeBridge({ assetId: TETH, amount: 123_457n, nullifier: withHex('a2'.repeat(32)), seed: '62' });
const B3 = makeBridge({ assetId: TAC, amount: 7_000n, nullifier: withHex('a3'.repeat(32)), seed: '63' });

function makeWorld(bridges) {
  const credited = new Map();
  const reads = { logs: 0, utxo: 0, minted: 0 };
  const addr = p2trAddress(XONLY, 'bc');
  const utxos = bridges.map((b) => ({ txid: b.revealTxid, vout: 0, value: 330, status: { confirmed: true } }));
  utxos.push({ txid: 'bb'.repeat(32), vout: 1, value: 330, status: { confirmed: true } });                  // not a mint's vout 0
  utxos.push({ txid: 'cc'.repeat(32), vout: 0, value: 90_000, status: { confirmed: true } });               // plain sats, too large for a note
  const byTxid = new Map(bridges.map((b) => [b.revealTxid, b]));
  const chainJson = async (path) => {
    if (path === `/address/${addr}/utxo`) { reads.utxo++; return utxos; }
    const m = path.match(/^\/tx\/([0-9a-f]{64})$/);
    if (m && byTxid.has(m[1])) return { status: { confirmed: true }, vout: [{ scriptpubkey: '5120' + XONLY, value: 330 }] };
    throw new Error('world: unknown ' + path);
  };
  const chainHex = async (path) => { const m = path.match(/^\/tx\/([0-9a-f]{64})\/hex$/); if (m && byTxid.has(m[1])) return byTxid.get(m[1]).revealHex; throw new Error('world: no hex ' + path); };
  const workerJson = async (path) => { reads.minted++; const q = new URL('http://x' + path).searchParams; const id = q.get('txid'); return credited.has(id) ? { decided: true, minted: true } : { decided: false, minted: false }; };
  const logs = bridges.map((b) => b.log);
  const rpc = async (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + (26_100_000).toString(16);
    if (method === 'eth_getLogs') {
      reads.logs++;
      const f = params[0], from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
      if (to - from > 50000) throw new Error('range too wide');
      return logs.filter((l) => { const b = Number(BigInt(l.blockNumber)); return b >= from && b <= to && l.topics[1].toLowerCase() === (f.topics[1] || l.topics[1]).toLowerCase(); });
    }
    throw new Error('world: rpc ' + method);
  };
  return { chainJson, chainHex, workerJson, rpc, credited, reads, logs };
}
const makeNotes = (world, extra = {}) => makeCrossoutNotes({ secp, hmac: (h, k, m) => hmac(nobleSha256, k, m), sha256: nobleSha256, pool, evmLog, rpc: world.rpc, poolAddress: POOL_ADDR, deployBlock: 25_400_000,
  chainJson: world.chainJson, chainHex: world.chainHex, workerJson: world.workerJson, hrp: 'bc', ...extra });

{
  const world = makeWorld([B1, B2, B3]);
  world.credited.set(B1.revealTxid, true);
  const notes = makeNotes(world);
  const found = await notes.discover({ walletPriv: WALLET_PRIV, assetIds: [TETH] });
  ok(found.length === 2 && found.every((x) => x.assetId === TETH.toLowerCase()), 'the key\'s tETH notes are found at its Taproot address; a note of an asset not asked for, a non-mint output and plain sats are not');
  const f1 = found.find((x) => x.txid === B1.revealTxid), f2 = found.find((x) => x.txid === B2.revealTxid);
  ok(f1.amount === 400_000n && f1.blinding === B1.r && f1.nullifier === B1.nullifier, 'a note\'s amount, blinding and nullifier are recovered from the key and the chain alone');
  ok(f2.amount === 123_457n, 'including an amount no scan would guess');
  const { cx, cy } = pool.commitXY(f2.amount, f2.blinding);
  ok(cx === B2.cx && cy === B2.cy, 'the recovered opening reproduces the commitment in the mint');
  ok(f1.credited === true && f2.credited === null, 'whether the worker has credited each is reported (undecided is unknown, not no)');
  ok(f1.sats === 330 && f1.vout === 0 && f1.confirmed === true && f1.claimId === B1.claimId, 'with the output it sits in');
  const both = await notes.discover({ walletPriv: WALLET_PRIV, assetIds: [TETH, TAC] });
  ok(both.length === 3 && both.find((x) => x.assetId === TAC.toLowerCase()).amount === 7_000n, 'asking for more assets finds theirs too');
}
{
  // The journal's knowledge spares the log lookup and the search.
  const world = makeWorld([B1]);
  const found = await makeNotes(world).discover({ walletPriv: WALLET_PRIV, assetIds: [TETH], known: { [B1.claimId.toLowerCase()]: { amount: B1.amount, nullifier: B1.nullifier } } });
  ok(found.length === 1 && found[0].amount === 400_000n && world.reads.logs === 0, 'what the journal knows is used without asking Ethereum');
  // A wrong remembered amount does not produce an opening that is not the commitment's.
  const bad = await makeNotes(makeWorld([B1])).discover({ walletPriv: WALLET_PRIV, assetIds: [TETH], known: { [B1.claimId.toLowerCase()]: { amount: B1.amount + 1n, nullifier: B1.nullifier } } });
  ok(bad.length === 1 && bad[0].amount === null, 'a remembered amount that does not reproduce the commitment yields no opening');
}
{
  // A settle that does not name this key\'s destination is not opened.
  const world = makeWorld([B1]);
  world.logs[0] = crossOutLog({ claimId: B1.claimId, destCommitment: withHex('99'.repeat(32)), nullifier: B1.nullifier, assetId: TETH, block: 26_000_000 });
  const found = await makeNotes(world).discover({ walletPriv: WALLET_PRIV, assetIds: [TETH] });
  ok(found.length === 1 && found[0].amount === null, 'an event whose destination is not this note leaves its amount unknown');
  // Another key finds nothing at an address that is not its own.
  const other = new Uint8Array(32).fill(0x32);
  const none = await makeNotes(makeWorld([B1])).discover({ walletPriv: other, assetIds: [TETH] }).catch((e) => e);
  ok(none instanceof Error || (Array.isArray(none) && none.length === 0), 'another key does not see this key\'s notes');
}
{
  // The log range is paged: an event many blocks back is still found.
  const world = makeWorld([B1]);
  world.logs[0] = crossOutLog({ claimId: B1.claimId, destCommitment: B1.destCommitment, nullifier: B1.nullifier, assetId: TETH, block: 25_450_000 });
  const found = await makeNotes(world).discover({ walletPriv: WALLET_PRIV, assetIds: [TETH] });
  ok(found.length === 1 && found[0].amount === 400_000n && world.reads.logs > 1, 'an event far back is found across pages');
}

{
  // One output, spent or not: opened from the transaction that made it.
  const world = makeWorld([B1, B2]);
  const notes = makeNotes(world);
  const o = await notes.openOutpoint({ walletPriv: WALLET_PRIV, txid: B2.revealTxid, vout: 0 });
  ok(o && o.assetId === TETH.toLowerCase() && o.amount === 123_457n && o.blinding === B2.r && o.owner === withHex(XONLY) && o.nullifier === B2.nullifier, 'an output this key\'s cross-out made is opened from its transaction: asset, amount, blinding, owner');
  ok((await notes.openOutpoint({ walletPriv: WALLET_PRIV, txid: B2.revealTxid, vout: 1 })) === null, 'only vout 0 is a cross-out\'s note');
  const other = new Uint8Array(32).fill(0x32);
  ok((await notes.openOutpoint({ walletPriv: other, txid: B2.revealTxid, vout: 0 })) === null, 'another key does not open it: the output is not at its Taproot address');
  const withKnown = await notes.openOutpoint({ walletPriv: WALLET_PRIV, txid: B1.revealTxid, vout: 0, known: { amount: B1.amount, nullifier: B1.nullifier } });
  ok(withKnown && withKnown.amount === 400_000n, 'what the journal knows is accepted here too');
}

{
  // An output the explorer would not answer for is counted, so a list missing it is not mistaken for a complete one.
  const world = makeWorld([B1, B2]);
  const real = world.chainHex;
  world.chainHex = async (path) => { if (path.includes(B2.revealTxid)) throw new Error('429'); return real(path); };
  const found = await makeNotes(world).discover({ walletPriv: WALLET_PRIV, assetIds: [TETH] });
  ok(found.length === 1 && found[0].txid === B1.revealTxid && found.unread === 1, 'an output that could not be read is counted as unread, not silently dropped');
  const all = await makeNotes(makeWorld([B1, B2])).discover({ walletPriv: WALLET_PRIV, assetIds: [TETH] });
  ok(all.unread === 0, 'and a complete read counts none');
  // The Ethereum side failing is kept on the note as its reason, apart from an amount that is simply out of range.
  const w2 = makeWorld([B2]); w2.rpc = async () => { throw new Error('node down'); };
  const f2 = await makeNotes(w2).discover({ walletPriv: WALLET_PRIV, assetIds: [TETH] });
  ok(f2.length === 1 && f2[0].amount === null && /node down/.test(f2[0].openErr || ''), 'a note whose Ethereum lookup failed says so');
  const t0 = Date.now(); for (let i = 0; i < 3; i++) solveAmount(pedersenCommit(BigInt(100_000 + i), 0n), 26);
  ok(Date.now() - t0 < 2500, 'repeated searches reuse the baby-step table (three took ' + (Date.now() - t0) + ' ms)');
}

{
  // Dust with a mint-shaped envelope can be sent to anyone's Taproot address: only a few unknown claims are looked up per call,
  // and an answer (found or not) is kept, so a refresh does not search Ethereum again for the same claim.
  const many = Array.from({ length: 11 }, (_, i) => makeBridge({ assetId: TETH, amount: 100_000n + BigInt(i), nullifier: withHex((0xb0 + i).toString(16).repeat(32)), seed: (0x70 + i).toString(16) }));
  const world = makeWorld(many);
  const notes = makeNotes(world);
  const first = await notes.discover({ walletPriv: WALLET_PRIV, assetIds: [TETH] });
  const opened = first.filter((x) => x.amount != null), skipped = first.filter((x) => x.amount == null);
  ok(first.length === 11 && opened.length === 8 && skipped.length === 3 && skipped.every((x) => /not opened/.test(x.openErr || '')), 'eight unknown claims are opened per call; the rest are listed unopened');
  const known = Object.fromEntries(many.slice(8).map((b) => [b.claimId.toLowerCase(), { amount: b.amount, nullifier: b.nullifier }]));
  const withKnown = await makeNotes(makeWorld(many)).discover({ walletPriv: WALLET_PRIV, assetIds: [TETH], known });
  ok(withKnown.filter((x) => x.amount != null).length === 11, 'claims the journal already knows are opened without counting against the cap');
  const logsAfterFirst = world.reads.logs;
  const second = await notes.discover({ walletPriv: WALLET_PRIV, assetIds: [TETH] });
  ok(second.filter((x) => x.amount != null).length === 11 && world.reads.logs > logsAfterFirst, 'the next refresh reuses the eight answers and gets on to the rest');
  const logsAfterSecond = world.reads.logs;
  await notes.discover({ walletPriv: WALLET_PRIV, assetIds: [TETH] });
  ok(world.reads.logs === logsAfterSecond, 'and one after that searches Ethereum for none of them again');
  // A claim with no event is looked for once.
  const stray = makeBridge({ assetId: TETH, amount: 333_333n, nullifier: withHex('d1'.repeat(32)), seed: '7f' });
  const w2 = makeWorld([stray]); w2.logs.length = 0;
  const n2 = makeNotes(w2);
  await n2.discover({ walletPriv: WALLET_PRIV, assetIds: [TETH] });
  const l2 = w2.reads.logs;
  await n2.discover({ walletPriv: WALLET_PRIV, assetIds: [TETH] });
  ok(l2 > 0 && w2.reads.logs === l2, 'a claim with no event on Ethereum is searched for once, not on every refresh');
}

console.log(`\n${n} crossout-notes checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
