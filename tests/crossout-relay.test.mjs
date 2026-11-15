// Tacit's relay for the Bitcoin step of a bridge to Bitcoin: the ask is checked against the claim on chain (worker/src/crossout-relay.js),
// and the relay (fulfiller/crossout-relay.mjs) sends a real commit/reveal pair from its own key only for a claim the proof covers, keeps
// the signed pair before sending it, follows it to its credit, and declines past its budget, a key's daily count or its coins.
import { keccak_256 } from '@noble/hashes/sha3';
import { secp } from '../dapp/vendor/tacit-deps.min.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeCrossoutMintReveal } from '../dapp/crossout-mint-reveal.js';
import { sha256 } from '@noble/hashes/sha256';
import {
  parseRelayRequest, claimLeaf, claimSlot, recordedTopic, verifyClaim, relayKey, relayInfoKey, relaySpentKey, publicStatus,
} from '../worker/src/crossout-relay.js';
import { makeCrossoutRelay, makeEsplora } from '../fulfiller/crossout-relay.mjs';

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const POOL = '0x000000000ed1eabd231be41d93b719056f7febfc';
const destXonly = hex(secp.getPublicKey(new Uint8Array(32).fill(7), true).slice(1));
const ASK = { claimId: 'c1'.repeat(32), assetId: '45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48', cx: hex(secp.getPublicKey(new Uint8Array(32).fill(9), true).slice(1)), cy: '0'.repeat(63) + '2', destXonly, ethBlock: 24_000_000 };

// ---- the ask, read strictly ----
{
  const a = parseRelayRequest({ ...ASK, claimId: '0x' + ASK.claimId.toUpperCase() });
  ok(a.claimId === ASK.claimId && a.ethBlock === ASK.ethBlock, 'an ask reads its fields as lower-case hex without 0x, and its block as a number');
  for (const [what, bad] of [['a short claim', { claimId: 'ab' }], ['a zero key', { destXonly: '0'.repeat(64) }], ['no block', { ethBlock: 0 }], ['a fractional block', { ethBlock: 1.5 }], ['a non-hex commitment', { cx: 'zz'.repeat(32) }]]) {
    let threw = false; try { parseRelayRequest({ ...ASK, ...bad }); } catch { threw = true; }
    ok(threw, `${what} is refused`);
  }
}

// ---- the claim, checked on chain ----
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const leaf = claimLeaf(keccak_256, ASK);
ok(leaf === pool.btcNoteLeaf('0x' + ASK.assetId, '0x' + ASK.cx, '0x' + ASK.cy, '0x' + ASK.destXonly).replace(/^0x/, ''), 'the claim leaf is the pool\'s btcNoteLeaf');
const pad = (h) => h.replace(/^0x/, '').padStart(64, '0');
// A chain holding each claim in `claims` (ASK's alone by default): its leaf at its slot, its event in its block.
const chainFor = ({ stored = null, block = null, destChain = 1, assetId = null, down = false, claims = [ASK] } = {}) => async (method, params) => {
  if (down) throw new Error('down');
  if (method === 'eth_getStorageAt') {
    const c = claims.find((x) => claimSlot(keccak_256, x.claimId) === params[1]);
    return '0x' + pad(c ? stored ?? claimLeaf(keccak_256, c) : '0');
  }
  if (method === 'eth_getLogs') {
    const f = params[0], c = claims.find((x) => '0x' + x.claimId === f.topics[1]);
    if (!c || f.fromBlock !== '0x' + (block ?? c.ethBlock).toString(16) || f.topics[0] !== recordedTopic(keccak_256)) return [];
    return [{ data: '0x' + pad(destChain.toString(16)) + claimLeaf(keccak_256, c) + 'ee'.repeat(32) + (assetId ?? c.assetId) }];
  }
  throw new Error(method);
};
{
  ok((await verifyClaim({ keccak256: keccak_256, ethRpc: chainFor(), pool: POOL, req: ASK })).ok, 'a burn the pool recorded, landing where the ask says, in its block, is taken');
  const r1 = await verifyClaim({ keccak256: keccak_256, ethRpc: chainFor({ stored: 'ab'.repeat(32) }), pool: POOL, req: ASK });
  ok(!r1.ok && r1.reason === 'not-this-claim' && !r1.retry, 'an ask whose commitment or key is not the claim\'s is refused for good');
  const r2 = await verifyClaim({ keccak256: keccak_256, ethRpc: chainFor({ stored: '0' }), pool: POOL, req: ASK });
  ok(!r2.ok && r2.reason === 'no-claim' && r2.retry, 'a claim the chain does not have yet is asked about again');
  const r3 = await verifyClaim({ keccak256: keccak_256, ethRpc: chainFor({ block: ASK.ethBlock + 5 }), pool: POOL, req: ASK });
  ok(!r3.ok && r3.reason === 'wrong-block', 'an ask naming the wrong block (one the proof may cover too early) is refused');
  const r4 = await verifyClaim({ keccak256: keccak_256, ethRpc: chainFor({ destChain: 2 }), pool: POOL, req: ASK });
  ok(!r4.ok && r4.reason === 'not-this-claim', 'a burn to another chain is not a Bitcoin step');
  const r5 = await verifyClaim({ keccak256: keccak_256, ethRpc: chainFor({ down: true }), pool: POOL, req: ASK });
  ok(!r5.ok && r5.retry && r5.reason === 'chain-unreadable', 'a chain that cannot be read is asked again, not refused');
  ok(!('commitHex' in publicStatus({ status: 'sent', commitHex: 'x', revealTxid: 'r' })) && publicStatus({ status: 'sent', revealTxid: 'r' }).revealTxid === 'r', 'the page is told the state and txids, not the signed hexes');
}

// ---- the relay ----
const memKv = () => {
  const m = new Map();
  return {
    m,
    get: async (k, t) => { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; },
    put: async (k, v) => { m.set(k, String(v)); },
    list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }),
  };
};
const relayPriv = new Uint8Array(32).fill(3);
const prims = makeBtcWallet({ priv: relayPriv, hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => '', fetchFeeRate: async () => 2 }).prims;
const mintReveal = makeCrossoutMintReveal({ secp });
function rig({ coins = [{ txid: 'f1'.repeat(32), vout: 0, value: 20_000, status: { confirmed: true } }], rate = 2, covered = true, minted = null, claims = [ASK], ...opts } = {}) {
  const kv = memKv(), sent = [], onChain = new Map(), spends = new Map(), refuse = new Set();
  let t = 1_700_000_000_000;
  const esplora = {
    utxos: async () => (typeof coins === 'function' ? coins() : coins),
    outspend: async (txid, vout) => spends.get(`${txid}:${vout}`) || { spent: false },
    feeRate: async () => rate,
    txStatus: async (txid) => (onChain.has(txid) ? onChain.get(txid) : null),
    broadcast: async (h) => { sent.push(h); if (refuse.has(h)) throw new Error('bad-txns-inputs-missingorspent'); return 'ok'; },
  };
  const state = { covered, minted };
  const api = async (p) => {
    if (p.startsWith('/reflection/eth-state/covers')) return { covered: state.covered };
    if (p.startsWith('/crossout/minted')) return { status: state.minted ? 'minted' : null, mintedTxid: state.minted };
    return null;
  };
  const relay = makeCrossoutRelay({ kv, network: 'mainnet', pool: POOL, prims, mintReveal, keccak256: keccak_256, api, ethRpc: chainFor({ claims }), esplora, now: () => t, ...opts });
  const ask = async (a = ASK) => kv.put(relayKey('mainnet', a.claimId), JSON.stringify({ ...a, status: 'queued', askedAt: t }));
  const rec = async (c = ASK.claimId) => kv.get(relayKey('mainnet', c), 'json');
  return { kv, relay, sent, onChain, state, ask, rec, spends, refuse, adv: (ms) => { t += ms; } };
}
{
  const r = rig();
  await r.ask();
  const t1 = await r.relay.tick();
  const rec = await r.rec();
  ok(rec.status === 'sent' && r.sent.length === 2 && t1.sent === 1, 'a covered claim is sent: commit then reveal, from the relay\'s own coin');
  ok(rec.revealHex.includes('225120' + destXonly), 'the reveal pays P2TR(destXonly), the holder\'s key, at vout 0');
  ok(r.sent[0] === rec.commitHex && r.sent[1] === rec.revealHex, 'the pair it sent is the pair it kept');
  const info = await r.kv.get(relayInfoKey('mainnet'), 'json');
  ok(info && info.address === prims.wallet.address() && /^bc1q/.test(info.address) && info.ready === true, 'the relay says its address and that it is ready');
  ok(Number(await r.kv.get(relaySpentKey('mainnet', new Date(1_700_000_000_000).toISOString().slice(0, 10)))) > 0, 'what it spent is counted against the day');
  // a restart with the pair kept: Bitcoin has it, so nothing is sent again
  r.onChain.set(rec.revealTxid, { confirmed: false });
  await r.relay.tick();
  ok(r.sent.length === 2, 'a pair Bitcoin has is not sent again');
  // dropped from the mempool: the same pair again, never a new one
  r.onChain.delete(rec.revealTxid);
  await r.relay.tick();
  ok(r.sent.length === 4 && r.sent[2] === rec.commitHex && r.sent[3] === rec.revealHex, 'a dropped pair is sent again as the same pair');
  r.state.minted = rec.revealTxid;
  await r.relay.tick();
  ok((await r.rec()).status === 'minted', 'credited by the reflection: minted');
}
{
  const r = rig({ covered: false });
  await r.ask();
  await r.relay.tick();
  ok((await r.rec()).status === 'waiting' && r.sent.length === 0, 'a claim the proof does not cover yet waits, and nothing is sent');
  r.state.covered = true; r.state.minted = 'aa'.repeat(32);
  await r.relay.tick();
  ok((await r.rec()).status === 'elsewhere' && r.sent.length === 0, 'a claim minted by the holder\'s own pair is left, no sats spent');
}
{
  const r = rig({ rate: 60, maxFeeRate: 25 });
  await r.ask();
  await r.relay.tick();
  ok((await r.rec()).status === 'waiting' && (await r.rec()).note === 'fees' && r.sent.length === 0, 'fees over the ceiling: it waits');
}
{
  const r = rig({ dailySats: 500 });
  await r.ask();
  await r.relay.tick();
  ok((await r.rec()).status === 'declined' && (await r.rec()).reason === 'budget' && r.sent.length === 0, 'past the day\'s budget: declined (the page sends it)');
}
{
  const r = rig({ coins: [{ txid: 'f2'.repeat(32), vout: 0, value: 300, status: { confirmed: true } }] });
  await r.ask();
  await r.relay.tick();
  ok((await r.rec()).status === 'declined' && (await r.rec()).reason === 'funds', 'no coin big enough: declined');
}
{
  const other = { ...ASK, claimId: 'c2'.repeat(32) };
  const r = rig({ perDestDaily: 1, claims: [ASK, other], coins: [{ txid: 'f3'.repeat(32), vout: 0, value: 20_000, status: { confirmed: true } }, { txid: 'f4'.repeat(32), vout: 1, value: 20_000, status: { confirmed: true } }] });
  await r.ask();
  await r.relay.tick();
  r.adv(1000);
  await r.ask(other);
  await r.relay.tick();
  ok((await r.rec()).status === 'sent' && (await r.rec(other.claimId)).status === 'declined' && (await r.rec(other.claimId)).reason === 'limit', 'a key\'s daily count is kept: the second step for the same key that day is declined');
}
{
  const third = { ...ASK, claimId: 'c3'.repeat(32), destXonly: hex(secp.getPublicKey(new Uint8Array(32).fill(8), true).slice(1)) };
  const r = rig({ claims: [ASK, third], coins: [{ txid: 'f5'.repeat(32), vout: 0, value: 20_000, status: { confirmed: true } }] });
  await r.ask();
  await r.ask(third);
  await r.relay.tick();
  const a = await r.rec(), b = await r.rec('c3'.repeat(32));
  ok(a.status === 'sent' && b.status === 'declined' && b.reason === 'funds', 'one coin is never promised to two pairs in a tick');
}
{
  const r = rig();
  await r.kv.put(relayKey('mainnet', ASK.claimId), JSON.stringify({ ...ASK, status: 'queued', askedAt: 1_700_000_000_000 }));
  const bad = rig();
  // a claim the chain says is another's is rejected
  const relay = makeCrossoutRelay({ kv: bad.kv, network: 'mainnet', pool: POOL, prims, mintReveal, keccak256: keccak_256, api: async () => ({ covered: true }), ethRpc: chainFor({ stored: 'ab'.repeat(32) }), esplora: { utxos: async () => [], feeRate: async () => 2, txStatus: async () => null, broadcast: async () => '' }, now: () => 1_700_000_000_000 });
  await bad.ask();
  await relay.tick();
  ok((await bad.rec()).status === 'rejected', 'an ask that does not match its claim is rejected without spending');
  r.adv(4 * 86400e3);
  r.state.covered = false;
  await r.relay.tick();
  ok((await r.rec()).status === 'expired', 'an ask that never became sendable is let go after three days');
}

// ---- keeping up: a pair whose coin was taken is signed again with another coin; a failed one too; nobody declined for a read or a wait ----
{
  // two coins; the first pair is signed on the bigger one, then that coin goes to another transaction (11-15: a pair marked sent before it was
  // ever broadcast left its coin unheld, and a later claim was signed on it)
  const A = { txid: 'a1'.repeat(32), vout: 0, value: 30_000, status: { confirmed: true } }, B = { txid: 'b1'.repeat(32), vout: 0, value: 20_000, status: { confirmed: true } };
  let coins = [A, B];
  const r = rig({ coins: () => coins });
  await r.ask();
  await r.relay.tick();
  const first = await r.rec();
  ok(first.status === 'sent' && first.fundingUtxo.txid === A.txid, 'the pair is signed on the bigger coin and sent');
  // Bitcoin never took it (it was dropped), and the coin is now spent by another transaction
  r.spends.set(`${A.txid}:0`, { spent: true, txid: 'cc'.repeat(32) });
  coins = [B];
  r.refuse.add(first.commitHex);
  await r.relay.tick();
  const back = await r.rec();
  ok(back.status === 'queued' && back.note === 'coin-taken' && !back.commitHex && back.deadCommits[0] === first.commitTxid, 'a pair whose coin went elsewhere is dropped, and its claim goes back to be signed');
  await r.relay.tick();
  const again = await r.rec();
  ok(again.status === 'sent' && again.fundingUtxo.txid === B.txid && again.revealTxid !== first.revealTxid, 'and the next tick signs and sends it with the other coin');
  ok(again.revealHex.includes('225120' + destXonly), 'still paying the holder\'s key');
}
{
  // a record given up as refused (the old relay's end state) recovers once its coin is seen taken
  const C = { txid: 'c2'.repeat(32), vout: 0, value: 20_000, status: { confirmed: true } };
  const r = rig({ coins: [C] });
  await r.kv.put(relayKey('mainnet', ASK.claimId), JSON.stringify({ ...ASK, status: 'failed', reason: 'refused', askedAt: 1_700_000_000_000, commitTxid: 'dd'.repeat(32),
    revealTxid: 'ee'.repeat(32), commitHex: '00', revealHex: '00', fundingUtxo: { txid: 'ff'.repeat(32), vout: 1, value: 39_740 } }));
  await r.relay.tick();
  ok((await r.rec()).status === 'failed', 'a failed pair whose coin is still unspent is left as it is (it is not sent again forever)');
  r.spends.set(`${'ff'.repeat(32)}:1`, { spent: true, txid: '99'.repeat(32) });
  await r.relay.tick();
  ok((await r.rec()).status === 'queued', 'once its coin is seen spent elsewhere, the claim is queued again');
  await r.relay.tick();
  ok((await r.rec()).status === 'sent' && (await r.rec()).fundingUtxo.txid === C.txid, 'and sent with a coin the relay has');
  r.state.minted = 'ab'.repeat(32);
  const r2 = rig({ coins: [C], minted: 'ab'.repeat(32) });
  await r2.kv.put(relayKey('mainnet', ASK.claimId), JSON.stringify({ ...ASK, status: 'failed', reason: 'refused', askedAt: 1_700_000_000_000, commitTxid: 'dd'.repeat(32), revealTxid: 'ee'.repeat(32), commitHex: '00', revealHex: '00', fundingUtxo: { txid: 'ff'.repeat(32), vout: 1, value: 39_740 } }));
  await r2.relay.tick();
  ok((await r2.rec()).status === 'elsewhere' && r2.sent.length === 0, 'a failed claim the holder minted meanwhile is left: no second pair');
}
{
  // the only coin big enough is the last step's change, waiting for its block: the ask waits, it is not declined
  const r = rig({ coins: [{ txid: '1c'.repeat(32), vout: 1, value: 37_980, status: { confirmed: false } }] });
  await r.ask();
  await r.relay.tick();
  ok((await r.rec()).status === 'waiting' && (await r.rec()).note === 'coin' && r.sent.length === 0, 'a coin waiting for its confirmation: the ask waits for it');
  // a read that gives no list: nobody is declined for it
  const r2 = rig({ coins: () => null });
  await r2.ask();
  await r2.relay.tick();
  ok((await r2.rec()).status === 'queued', 'an unreadable coin list declines nobody');
  // truly none: declined, and the page sends it
  const r3 = rig({ coins: [] });
  await r3.ask();
  await r3.relay.tick();
  ok((await r3.rec()).status === 'declined' && (await r3.rec()).reason === 'funds', 'no coin at all: declined (the holder\'s page sends it)');
}

// ---- the chain: reads through the API's proxy, broadcasts to explorers in turn ----
{
  const calls = [];
  const f = async (url, init) => {
    calls.push([url, init?.method || 'GET']);
    if (url.startsWith('https://api.x/chain/v1/fees')) return { ok: true, status: 200, json: async () => ({ halfHourFee: 3, fastestFee: 5 }) };
    if (url.startsWith('https://a.x/tx')) return { ok: false, status: 503, text: async () => 'busy' };
    if (url.startsWith('https://b.x/tx')) return { ok: true, status: 200, text: async () => 'txid\n' };
    if (url.startsWith('https://r.x/tx')) return { ok: false, status: 400, text: async () => 'sendrawtransaction RPC error: bad-txns-inputs-missingorspent' };
    return { ok: false, status: 404, json: async () => null };
  };
  const ch = makeEsplora({ read: 'https://api.x/chain', query: 'network=mainnet', send: ['https://a.x', 'https://b.x'] }, f);
  ok((await ch.feeRate()) === 3 && calls[0][0] === 'https://api.x/chain/v1/fees/recommended?network=mainnet', 'reads go to the API\'s chain proxy, with the network');
  ok((await ch.broadcast('00')) === 'txid' && calls.filter((c) => c[1] === 'POST').length === 2, 'a busy explorer is passed over for the next');
  ok((await ch.txStatus('ab'.repeat(32))) === null, 'a transaction no explorer has reads as not on Bitcoin');
  // a transaction nobody has seen: the explorers answer {"confirmed":false} from /status (HTTP 200) and 404 from /tx, and it is NOT on Bitcoin
  const seen = async (url) => {
    if (/\/tx\/[0-9a-f]{64}\/status/.test(url)) return { ok: true, status: 200, json: async () => ({ confirmed: false }) };
    if (url.includes('/tx/' + 'aa'.repeat(32))) return { ok: true, status: 200, json: async () => ({ txid: 'aa'.repeat(32), status: { confirmed: false } }) };
    if (url.includes('/tx/' + 'bb'.repeat(32))) return { ok: true, status: 200, json: async () => ({ txid: 'bb'.repeat(32), status: { confirmed: true, block_height: 1 } }) };
    return { ok: false, status: 404, json: async () => { throw new Error('Transaction not found'); } };
  };
  const sch = makeEsplora({ read: 'https://api.x/chain', query: 'network=mainnet' }, seen);
  ok((await sch.txStatus('cc'.repeat(32))) === null, 'a transaction no explorer has is NOT on Bitcoin, though /status says confirmed:false for it');
  ok((await sch.txStatus('aa'.repeat(32))).confirmed === false && (await sch.txStatus('bb'.repeat(32))).confirmed === true, 'one in the mempool is unconfirmed, one in a block confirmed');
  // the proxy cooling: reads fall back to the backups, and an Esplora with only estimates still gives a rate
  const cool = async (url, init) => {
    if (url.startsWith('https://api.x/')) return { ok: false, status: 503, json: async () => ({ error: 'all upstreams cooling' }) };
    if (url.startsWith('https://bs.x/v1/fees')) return { ok: false, status: 404, json: async () => null };
    if (url.startsWith('https://bs.x/fee-estimates')) return { ok: true, status: 200, json: async () => ({ 1: 4.2, 3: 2.4, 6: 1.1 }) };
    if (url.startsWith('https://bs.x/address/')) return { ok: true, status: 200, json: async () => [{ txid: 'aa', vout: 0, value: 5, status: { confirmed: true } }] };
    return f(url, init);
  };
  const backed = makeEsplora({ read: 'https://api.x/chain', query: 'network=mainnet', backup: ['https://bs.x'] }, cool);
  ok((await backed.feeRate()) === 3, 'with the proxy cooling, the rate comes from a backup\'s estimates (rounded up)');
  ok((await backed.utxos('bc1q')).length === 1, 'and so do the coins');
  const refuse = makeEsplora({ read: 'https://api.x/chain', send: ['https://r.x', 'https://b.x'] }, f);
  let msg = ''; try { await refuse.broadcast('00'); } catch (e) { msg = e.message; }
  ok(/bad-txns/.test(msg) && !calls.some((c) => c[0] === 'https://b.x/tx' && calls.filter((d) => d[0] === 'https://r.x/tx').length && c === calls.at(-1)), 'a transaction Bitcoin refuses is not offered to every explorer');
}

console.log(`\n${n} crossout-relay checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
