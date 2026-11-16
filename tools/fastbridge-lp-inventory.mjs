// READ-ONLY inventory of the house LP's TAC on Bitcoin, split by whether the regular bridge could carry each note home.
// The LP key is read from FB_LP_KEY in the environment, used only to find and open the key's own notes, and never printed. Nothing is sent or signed.
//   FB_LP_KEY=$(security find-generic-password -s tacit-fastbridge-lp -w) node --no-experimental-global-navigator tools/fastbridge-lp-inventory.mjs
// The trace service answers a note in about 50 s, so 89 notes take over an hour: results are kept in $TMPDIR/fastbridge-lp-inventory.json and a rerun carries on from them.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { readFileSync, existsSync } from 'node:fs';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, ''), OUT = `${tmpdir()}/fastbridge-lp-inventory.json`;   // saved as it goes; a second run resumes from it
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const keyHex = String(process.env.FB_LP_KEY || '').trim().replace(/^0x/, '');
if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.log('no key in the environment'); process.exit(1); }
delete process.env.FB_LP_KEY;                       // not left in the environment of anything this process starts
const hardStop = setTimeout(() => { console.log('STOPPED: time limit'); process.exit(3); }, 150 * 60e3); hardStop.unref?.();
const t0 = Date.now(), at = () => `${Math.round((Date.now() - t0) / 1000)}s`;

const { JSDOM } = await import(REPO + '/tests/_jsdom.mjs');
const dom = new JSDOM('', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location, __TACIT_NO_INIT__: true });
if (!globalThis.navigator) globalThis.navigator = dom.window.navigator;
localStorage.setItem('tacit-network-v1', 'mainnet');
const { secp } = await import(REPO + '/dapp/vendor/tacit-deps.min.js');
const T = await import(REPO + '/dapp/tacit.js');
const priv = Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16)));
T.wallet.priv = priv; T.wallet.pub = secp.getPublicKey(priv, true);

const addr = T.wallet.address();
console.log(`${at()} the key's Bitcoin address starts ${addr.slice(0, 10)}… (read only: explorers, then the key's own notes opened from the chain alone)`);
const BASES = ['https://mempool.bitaroo.net/api', 'https://mempool.emzy.de/api', 'https://blockstream.info/api'];
let turn = 0;
async function ex(path) {
  for (let pass = 0; pass < 6; pass++) {
    for (let k = 0; k < BASES.length; k++) {
      const b = BASES[(turn + k) % BASES.length];
      try {
        const r = await fetch(b + path, { signal: AbortSignal.timeout(25000) });
        if (r.ok) { turn++; return await r.json(); }
        if (r.status === 404) return null;
      } catch { /* the next explorer */ }
      await new Promise((x) => setTimeout(x, 400));
    }
    await new Promise((x) => setTimeout(x, 5000 * (pass + 1)));
  }
  throw new Error('explorers unreachable for ' + path.slice(0, 30));
}
const utxos = await ex(`/address/${addr}/utxo`);
const dust = utxos.filter((u) => u.value === 546 && u.status && u.status.confirmed);
console.log(`${at()} ${utxos.length} outputs at the address, ${dust.length} of the note size, in ${new Set(dust.map((u) => u.txid)).size} transactions`);

const { concatBytes } = await import(REPO + '/dapp/vendor/tacit-deps.min.js').then((m) => ({ concatBytes: m.concatBytes || ((...a) => Uint8Array.from(a.flatMap((x) => [...x]))) }));
const hexB = (h) => Uint8Array.from(String(h).match(/../g).map((x) => parseInt(x, 16)));
const rev = (b) => Uint8Array.from([...b].reverse());
const notes = [], unopened = [];
const txCache = new Map();
for (const [i, u] of dust.entries()) {
  let tx = txCache.get(u.txid);
  if (!tx) { tx = await ex('/tx/' + u.txid); txCache.set(u.txid, tx); await new Promise((x) => setTimeout(x, 300)); }
  let opened = null, why = '';
  try {
    const env = T.txOutputEnvelope(tx);
    const dec = env && (env.opcode === 0x22 ? T.decodeCXferBppPayload(env.payload) : env.opcode === 0x23 ? T.decodeCXferPayload(env.payload) : null);
    if (!dec) why = 'envelope opcode 0x' + (env ? env.opcode.toString(16) : '??');
    else if (tx.vin.length < 2) why = 'no second input';
    else {
      const f = tx.vin[1], le = new Uint8Array(4); new DataView(le.buffer).setUint32(0, f.vout >>> 0, true);
      const out = dec.outputs[u.vout];
      if (!out) why = 'no such output';
      else opened = T.openTransferOutput({ priv: T.wallet.priv, pub: T.wallet.pub, senderPubHex: (f.witness && f.witness.length === 2 && f.witness[1].length === 66) ? f.witness[1] : null, anchorBytes: concatBytes(rev(hexB(f.txid)), le), vout: u.vout, ct: out.encryptedAmount, commitment: out.commitment });
    }
  } catch (e) { why = 'error ' + String(e.message).slice(0, 40); }
  if (opened) notes.push({ txid: u.txid, vout: u.vout, amount: BigInt(opened.amount) }); else unopened.push({ txid: u.txid, vout: u.vout, why });
  if ((i + 1) % 25 === 0 || i + 1 === dust.length) console.log(`${at()} opened ${i + 1}/${dust.length}: ${notes.length} notes opened, ${unopened.length} not`);
}
const holding = notes.filter((n) => n.amount > 0n), zero = notes.length - holding.length;
const fmt = (v) => `${(v / 100000000n).toLocaleString('en-US')}.${String(v % 100000000n).padStart(8, '0').slice(0, 2)}`;
const why = {}; for (const x of unopened) why[x.why] = (why[x.why] || 0) + 1;
console.log(`${at()} ${holding.length} notes hold TAC (${fmt(holding.reduce((a, n) => a + n.amount, 0n))} TAC in all), ${zero} open to 0 TAC, ${unopened.length} could not be opened ${JSON.stringify(why)}`);
console.log(`${at()} asking the bridge's trace about each note that holds TAC (public service, paced)…`);
notes.length = 0; notes.push(...holding);

// the regular bridge's own question, as burndep-ux.js traceNote asks it
const API = 'https://api.tacit.finance';
async function trace(n) {
  for (let a = 0; a < 6; a++) {
    let r;
    try { r = await fetch(API + '/reflection/burndep/trace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: { txid: n.txid, vout: n.vout }, assetId: TAC, maxDepth: 256 }), signal: AbortSignal.timeout(120000) }); }
    catch (e) { return { cls: 'unknown', why: 'network ' + String(e.message).slice(0, 40) }; }
    if (r.status === 429) { await new Promise((x) => setTimeout(x, (Math.min(60, Number(r.headers.get('retry-after')) || 30) + 1) * 1000)); continue; }
    const j = await r.json().catch(() => ({}));
    if (j.pending) { await new Promise((x) => setTimeout(x, Math.min(10, Math.max(2, Number(j.retryAfter) || 3)) * 1000)); continue; }
    if (j.ok) return { cls: 'bridgeable', hops: j.hops };
    const m = String(j.error || r.status);
    const op = /opcode 0x([0-9a-f]{2})/i.exec(m), kind = /classified as '([a-z_]+)'/.exec(m);
    if (/does not recogni/.test(m) || (op && /^6[cd]$/i.test(op[1]))) return { cls: 'shielded-pool exit', why: m.slice(0, 90) };
    if (kind) return { cls: kind[1] === 'crossout_mint' ? 'arrived from Ethereum' : /^(swap|lp_|harvest|protocol_fee|farm)/.test(kind[1]) ? 'pool/farm trade' : 'other', why: m.slice(0, 90) };
    if (/exceed|too long|more than \d+ transfers|max.?depth/i.test(m)) return { cls: 'too long', why: m.slice(0, 90) };
    return { cls: 'other', why: m.slice(0, 120) };
  }
  return { cls: 'unknown', why: 'rate limited' };
}
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : [];
const done = new Set(results.map((r) => `${r.txid}:${r.vout}`));
if (results.length) console.log(`${at()} carrying on from ${results.length} notes traced earlier`);
for (const [i, n] of notes.entries()) {
  if (done.has(`${n.txid}:${n.vout}`)) continue;
  const r = await trace(n);
  results.push({ txid: n.txid, vout: n.vout, amount: n.amount.toString(), ...r });
  if ((i + 1) % 10 === 0 || i + 1 === notes.length) console.log(`${at()} traced ${i + 1}/${notes.length}`);
  writeFileSync(OUT, JSON.stringify(results));
  await new Promise((x) => setTimeout(x, 2500));
}
const by = {};
for (const r of results) { const b = (by[r.cls] ||= { n: 0, amount: 0n }); b.n++; b.amount += BigInt(r.amount); }
console.log('\nSPLIT of the TAC the house LP holds on Bitcoin (read-only):');
const total = results.reduce((a, r) => a + BigInt(r.amount), 0n);
for (const [k, b] of Object.entries(by).sort((a, b) => (b[1].amount > a[1].amount ? 1 : -1))) console.log(`  ${k.padEnd(22)} ${String(b.n).padStart(3)} notes  ${fmt(b.amount).padStart(14)} TAC  ${total > 0n ? (Number(b.amount * 1000n / total) / 10).toFixed(1) : '0'}%`);
console.log(`  ${'TOTAL'.padEnd(22)} ${String(results.length).padStart(3)} notes  ${fmt(total).padStart(14)} TAC`);
const sizes = results.filter((r) => r.cls === 'bridgeable').map((r) => Number(BigInt(r.amount) / 100000000n)).sort((a, b) => b - a);
console.log('bridgeable note sizes (TAC):', sizes.slice(0, 30).join(', ') + (sizes.length > 30 ? ', …' : ''));
console.log('DONE');
process.exit(0);
