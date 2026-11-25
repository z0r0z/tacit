// The pledger's standing signer: it holds the pledger's key and signs draws from their pledges, nothing else.
//
//   node tools/pledge-signer.mjs --desk https://tacit-btcswap-desk.onrender.com --key ~/.config/tacit/pledge.key --pledges ~/.config/tacit/pledges.json [--port 8788]
//
// The key file holds one line: the pledger's Bitcoin private key in hex (64 chars). PLEDGE_SIGNER_KEY sets it
// instead of --key; --key wins. The key is read once at start, never logged, never sent anywhere, never written.
// The pledges file is the pledger's own record of the pledges they funded, one entry per pledge id:
//
//   { "pl-<16 hex>": { "pledgerPub": "<66 hex>", "pledgerXonly": "<64 hex>", "maxDiscountBps": 500,
//                      "csvBlocks": 144, "lock": { "txid": "<64 hex>", "vout": 0 },
//                      "joint": { "deskPub": "<66 hex>", "refundXonly": "<64 hex>" } } }
//
// It is written when the pledge is funded (the offer response gives deskPub and csvBlocks, the lock gives the
// outpoint). The signer trusts only this file for what a pledge is; the desk's API is used only for live state
// (phase, drawn, committed) and the swap's phase. A draw is signed only when every check below passes:
//
//   * the pledge is in this file, funded or spent, and the draw's amount fits what is left of it;
//   * the draw's discount is within the pledge's maxDiscountBps;
//   * the swap is accepted at the desk;
//   * the draw spends the pledge's own lock, and pays the desk's wallet (from the desk's /info) and nothing else.
//
// A refusal is a 403 with a reason, and nothing is signed. The desk, on a refusal, funds the swap elsewhere.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import * as S from '../dapp/btcswap.js';
import * as M from '../dapp/musig2.js';
import { txFromJson } from '../dapp/adaptor-btc-tx.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DESK = arg('--desk', 'https://tacit-btcswap-desk.onrender.com').replace(/\/$/, '');
const PORT = Number(arg('--port', '8788'));

const keyHex = (() => {
  const fromFile = arg('--key', null);
  const raw = fromFile ? readFileSync(fromFile, 'utf8') : (process.env.PLEDGE_SIGNER_KEY || '');
  const hex = raw.trim().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('pledge-signer: --key must be a file holding one 64-hex private key, or set PLEDGE_SIGNER_KEY');
  return hex;
})();
const pledgesPath = arg('--pledges', null);
if (!pledgesPath) throw new Error('pledge-signer: --pledges <file> is required: the pledger\'s own record of their pledges');
const pledges = JSON.parse(readFileSync(pledgesPath, 'utf8'));

const { prims } = makeBtcWallet({ priv: hexToBytes(keyHex), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
const wallet = prims.wallet;
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

async function getJson(path) {
  const res = await fetch(`${DESK}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// A draw request, checked against the pledger's own record and the desk's live state. Returns the partial signature,
// or null with the reason logged when the draw is not one the pledger agreed to.
async function signDraw(req) {
  const mine = pledges[req.pledgeId];
  if (!mine) return [null, 'unknown pledge: this signer holds no such pledge'];
  const [live, swap, info] = await Promise.all([
    getJson(`/pledges/${req.pledgeId}`).catch(() => null),
    getJson(`/swap/${req.swapId}`).catch(() => null),
    getJson('/info').catch(() => null),
  ]);
  if (!live) return [null, 'the desk does not know this pledge'];
  if (live.phase !== 'funded' && live.phase !== 'spent') return [null, `the pledge is ${live.phase}`];
  const remaining = BigInt(live.amount) - BigInt(live.drawn) - BigInt(live.committed || '0');
  if (BigInt(req.amount) > remaining) return [null, `the draw is ${req.amount} but only ${remaining} is left of this pledge`];
  if (req.discountBps > mine.maxDiscountBps) return [null, `the discount is ${req.discountBps}bps but this pledge allows ${mine.maxDiscountBps}bps`];
  if (!swap || swap.phase !== 'accepted') return [null, `the swap is ${swap?.phase ?? 'unknown'}, not accepted`];
  const reveal = txFromJson(req.revealJson);
  if (reveal.inputs[1].txid !== mine.lock.txid || reveal.inputs[1].vout !== mine.lock.vout) return [null, 'the draw does not spend this pledge\'s lock'];
  const deskScript = bytesToHex(prims.p2wpkhScript(hexToBytes(info.deskPub)));
  if (bytesToHex(reveal.outputs[0].script) !== deskScript) return [null, 'the draw does not pay the desk\'s wallet'];
  const joint = S.jointLock({ prims, holderPub: mine.pledgerPub, deskPub: mine.joint.deskPub, deskXonly: mine.joint.refundXonly, csvBlocks: mine.csvBlocks, refundXonly: mine.joint.refundXonly });
  const nonce = M.nonceGen({ sk: wallet.priv, pk: wallet.pub, aggXonly: joint.keys.xonly, msg: hexToBytes(req.sighash) });
  const sess = M.session({ keys: joint.keys, pubnonces: [hexToBytes(req.deskNonce), nonce.pubnonce], msg: hexToBytes(req.sighash), T: null });
  return [{ pubnonce: bytesToHex(nonce.pubnonce), psig: bytesToHex(M.partialSign({ secnonce: nonce.secnonce, sk: wallet.priv, sess })) }, null];
}

const server = createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (req.method !== 'POST' || req.url !== '/sign-draw') return send(404, { error: 'only POST /sign-draw' });
    const body = JSON.parse(await new Promise((ok, no) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s)); req.on('error', no); }));
    const [sig, why] = await signDraw(body);
    if (!sig) { log({ level: 'refused', pledgeId: body.pledgeId, swapId: body.swapId, why }); return send(403, { ok: false, why }); }
    log({ level: 'signed', pledgeId: body.pledgeId, swapId: body.swapId, amount: body.amount, discountBps: body.discountBps });
    return send(200, sig);
  } catch (e) { log({ level: 'error', error: String((e && e.message) || e) }); return send(500, { error: 'signer error' }); }
});

server.listen(PORT, () => {
  log({ level: 'info', msg: 'pledge signer up', desk: DESK, port: PORT, pledges: Object.keys(pledges).length, address: prims.wallet.address() });
});
