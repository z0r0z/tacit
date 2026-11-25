// End-to-end Bitcoin settlement on a disconnected private signet. See btcswap-desk/README.md.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { makePledge, makePledgedFunding } from '../btcswap-desk/pledge.mjs';
import { makeMemoryStore } from '../fastbridge-lp/lib/store.mjs';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit } from '../dapp/adaptor-btc-tx.js';
import { makeBtcSwapDesk, deskClient } from '../dapp/btcswap-desk.js';
import { makeBtcSwapHolder } from '../dapp/btcswap-holder.js';
import { makeOwnNotes } from '../dapp/btcswap-notes.js';
import { makeNoteResolver } from '../dapp/btc-pool-zap.js';
import { bigintToBytes32, signSchnorr } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import { tacit, etchNote, scalar, P } from './lib/btc-sim.mjs';

const dir = process.env.BTCSWAP_SIGNET_DIR;
assert.ok(dir, 'set BTCSWAP_SIGNET_DIR to the private node data directory');
const cliArgs = ['-signet', '-rpcconnect=127.0.0.1', '-datadir=' + dir, '-rpcport=' + (process.env.BTCSWAP_SIGNET_PORT || 38332)];
function rpc(method, ...args) {
  const s = execFileSync('bitcoin-cli', [...cliArgs, method, ...args.map(String)], { encoding: 'utf8' }).trim();
  if (!s) return null;
  if (/^[{[]/.test(s) || /^\d{1,12}$/.test(s)) return JSON.parse(s);
  return s;
}
const chain = rpc('getblockchaininfo');
assert.equal(chain.chain, 'signet');
assert.equal(chain.signet_challenge, '51');
assert.equal(rpc('getnetworkinfo').networkactive, false);
const walletName = 'pledge-' + randomBytes(6).toString('hex');
rpc('createwallet', walletName);
cliArgs.push('-rpcwallet=' + walletName);
const miner = rpc('getnewaddress');
const mine = (n) => assert.equal(rpc('generatetoaddress', n, miner, 2_000_000_000).length, n);
mine(101);

const sats = (v) => Math.round(v * 100_000_000);
const known = new Set(), spent = new Map();
const point = (id, v) => id + ':' + v;
const tip = () => rpc('getblockcount');
function fetchTx(id) {
  const tx = rpc('getrawtransaction', id, true);
  return { txid: id, vin: tx.vin.map((i) => ({ ...i, witness: i.txinwitness || [] })),
    vout: tx.vout.map((o) => ({ value: sats(o.value), scriptpubkey: o.scriptPubKey.hex })),
    status: { confirmed: tx.confirmations > 0, block_height: tx.confirmations > 0 ? tip() + 1 - tx.confirmations : 0 } };
}
function send(hex, id) {
  if (known.has(id)) return;
  assert.equal(rpc('sendrawtransaction', hex), id);
  known.add(id);
  for (const i of fetchTx(id).vin) spent.set(point(i.txid, i.vout), id);
}
const broadcast = async (p) => { send(p.commitHex, p.commitTxid); send(p.revealHex, p.revealTxid || p.txid); };
function pay(address, amount) {
  const id = rpc('sendtoaddress', address, (amount / 100_000_000).toFixed(8));
  known.add(id);
  return id;
}
const kit = tacitKit(tacit);
const resolveNote = makeNoteResolver({ validateOutpoint: tacit.validateOutpoint, getParentEnvelopeData: tacit.getParentEnvelopeData, txOutputEnvelope: tacit.txOutputEnvelope, fetchTx });
function party() {
  const { prims } = makeBtcWallet({ priv: randomBytes(32), hrp: 'tb' });
  const wallet = { priv: prims.wallet.priv, pub: prims.wallet.pub, xonly: prims.wallet.xonly() };
  const script = prims.p2wpkhScript(wallet.pub), own = bytesToHex(script), address = prims.wallet.address();
  const history = async () => [...known].map(fetchTx).filter((t) => t.vout.some((o) => o.scriptpubkey === own));
  const satsUtxos = async () => {
    const coins = [];
    for (const t of await history()) for (const [vout, o] of t.vout.entries()) {
      if (o.scriptpubkey === own && o.value > 546 && t.status.confirmed && rpc('gettxout', t.txid, vout)) coins.push({ txid: t.txid, vout, value: o.value });
    }
    return coins;
  };
  return { prims, wallet, address, script, tx: makeAdaptorBtcTx({ prims, kit }), history, satsUtxos, fetchTx, resolveNote, tip, broadcast,
    feeRate: async () => 2, crossLaneBlocked: async () => null,
    status: async (id) => { const tx = fetchTx(id); return { height: tx.status.block_height, confirmations: tx.status.confirmed ? tip() + 1 - tx.status.block_height : 0 }; },
    outspend: async (id, v) => { if (rpc('gettxout', id, v)) return null; const by = spent.get(point(id, v)); assert.ok(by, 'spend must be in the fixture'); return by; } };
}
const maker = party(), holder = party();
pay(maker.address, 250_000);
pay(holder.address, 250_000);
// Fund the upstream test etch's actual script and sign its reveal for that outpoint.
const signer = scalar('private signet test etch'), r = scalar('supply'), supply = 300_000n;
const etch = etchNote({ ticker: 'DESK', value: supply, r, script: maker.script, signerD: signer });
const commit = pay(rpc('decodescript', bytesToHex(etch.commitSpk)).address, etch.prevouts[0].value);
const vout = fetchTx(commit).vout.findIndex((o) => o.scriptpubkey === bytesToHex(etch.commitSpk));
const reveal = etch.reveal;
Object.assign(reveal.inputs[0], { txid: commit, vout });
reveal.inputs[0].witness[0] = signSchnorr(P.tapSighash(reveal, 0, etch.prevouts, etch.leaf, 0), bigintToBytes32(signer));
const genesis = P.txid(reveal);
send(bytesToHex(P.serializeTx(reveal)), genesis);
mine(1);
const asset = tacit.assetIdFor(genesis, 0), assetHex = bytesToHex(asset);
const anchor = concatBytes(hexToBytes(genesis).reverse(), new Uint8Array(4));
const parts = [holder, maker, maker].map((p, i) => ({ amount: 100_000n, script: p.script,
  blinding: kit.deriveChangeBlinding(p.wallet.priv, anchor, i), keystream: kit.deriveAmountKeystreamSelf(p.wallet.priv, anchor, i) }));
const split = maker.tx.transfer({ asset, inputs: [{ txid: genesis, vout: 0, value: 546, amount: supply, blinding: r, spk: maker.script, witnessSizes: [72, 33],
  sign: (tx, i, prev) => maker.prims.signP2wpkhInput(tx, i, prev[i].value) }], outputs: parts, satsUtxos: await maker.satsUtxos(), feeRate: 2 });
await broadcast(split);
mine(1);

const root = point(split.revealTxid, 1);
// The private chain has no Ethereum reflection. Supply that boundary only: the
// desk's two notes are tracked, the holder's is untracked and new outputs await the fold.
const tracking = async (notes) => new Map(notes.map(({ txid, vout }) => [point(txid, vout),
  txid !== split.revealTxid ? 'new' : vout === 0 ? 'untracked' : 'tracked']));
const now = () => Math.floor(Date.now() / 1000);
const store = makeMemoryStore(), holderStore = makeMemoryStore();
const desk = makeBtcSwapDesk({ seed: randomBytes(32), now, store, quotes: makeMemoryStore(), btc: maker, tracking,
  inventory: makeOwnNotes({ btc: maker, tacit, asset: assetHex, ttlMs: 0 }),
  policy: { asset: assetHex, feeBps: 500, minAmount: 1n, maxAmount: supply, csvHolder: 288, csvDesk: 144 },
  pledge: makePledge({ outpoints: [root], minDiscountBps: 400, maxDiscountBps: 600, maxMinerFeeSats: 10_000 }),
  pledgedFunding: makePledgedFunding(maker, tacit.txOutputEnvelope) });
const api = deskClient({ base: 'http://desk.test', fetchImpl: async (url, init) => {
  const res = await desk.handle({ method: init.method, path: new URL(url).pathname, body: init.body && JSON.parse(init.body) });
  return Response.json(res.body, { status: res.status });
} });
assert.equal((await api.info()).available, '100000');
const q = await api.quote('100000');
assert.equal(q.out, '95000');
const side = makeBtcSwapHolder({ seed: randomBytes(32), now, store: holderStore, btc: holder, desk: api, tracking, policy: { csvBlocks: 288, minConfs: 2 } });
const h = await side.start({ asset, amount: 100_000n, notes: [{ txid: split.revealTxid, vout: 0, value: 546, amount: 100_000n, blinding: parts[0].blinding }], quote: q });
for (let i = 0; i < 30; i++) {
  await side.step(await holderStore.get(h.id));
  await desk.tick();
  if ((await holderStore.get(h.id)).phase === 'done' && (await store.get(h.id))?.phase === 'done') break;
  mine(1);
}
const paid = await holderStore.get(h.id), sold = await store.get(h.id);
assert.equal(paid.phase, 'done', paid.lastError);
assert.equal(sold?.phase, 'done', sold?.lastError);
assert.deepEqual(sold.noteInputs.map((n) => point(n.txid, n.vout)), [root]);
assert.equal(paid.note.amount, '95000');
assert.ok((await holder.status(paid.note.txid)).confirmations > 0);
assert.ok((await maker.status(sold.take.txid)).confirmations > 0);
assert.ok(await resolveNote(paid.note.txid, 0));
assert.ok(await resolveNote(sold.take.txid, 0));
assert.ok(rpc('gettxout', split.revealTxid, 2), 'the equally sized unpledged note remained unspent');
console.log(`Private signet confirmed both claims. Holder: ${paid.note.txid}. Desk: ${sold.take.txid}. Unpledged: ${split.revealTxid}:2.`);
process.exit(0);
