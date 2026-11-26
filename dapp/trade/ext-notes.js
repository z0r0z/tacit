// Whether a Bitcoin address outside Tacit (a UniSat, Xverse or Leather account) holds coins that may carry a Tacit note, read before that wallet is asked to
// send anything: the wallet does not know Tacit, so it could spend such a coin as plain sats and the note (TAC, cTAC, cBTC) would be lost with it.
//
// A coin may carry a note when the transaction that made it carries a Tacit envelope: a Taproot script-path input whose script is
// <32-byte key> OP_CHECKSIG OP_FALSE OP_IF "TACIT" … — the same rule tacit.js's holdings scan reads a coin by (tacit.js _txOutputEnvelope): a coin of a
// transaction with no envelope is plain sats to it too. Every coin of the address is read; one that cannot be read fails the check (nothing is sent), as
// tacit.js holds back a coin it could not classify.
//
//   const r = await notesAt(address, { fetchImpl, bases })   -> { carriers: [{ txid, vout, value }], coins: n }     throws when the address cannot be read in full

const BASES = ['https://mempool.space/api', 'https://blockstream.info/api'];
const MAGIC = [0x54, 0x41, 0x43, 0x49, 0x54];                       // "TACIT"
const MAX_COINS = 400;

const hexBytes = (h) => { const s = String(h || ''); if (!/^(?:[0-9a-f]{2})*$/i.test(s)) return null; const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return o; };
// a tapscript that opens a Tacit envelope: 0x20 <key> OP_CHECKSIG OP_FALSE OP_IF, then a push of the five bytes "TACIT"
export function isEnvelopeScript(b) {
  if (!b || b.length < 32 + 1 + 1 + 1 + 1 + 1 + MAGIC.length) return false;
  if (b[0] !== 0x20 || b[33] !== 0xac || b[34] !== 0x00 || b[35] !== 0x63 || b[36] !== MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (b[37 + i] !== MAGIC[i]) return false;
  return true;
}
// any input of the transaction revealed through such a script (a script-path spend: the script is the second to last witness item, before the control block)
export function hasEnvelope(tx) {
  for (const vin of (tx && tx.vin) || []) {
    const w = vin && vin.witness;
    if (!Array.isArray(w) || w.length < 3) continue;
    for (const item of w) if (isEnvelopeScript(hexBytes(item))) return true;
  }
  return false;
}

async function getJson(url, fetchImpl) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}
// one read from the first explorer that answers
async function read(path, { fetchImpl, bases }) {
  let last = null;
  for (const b of bases) { try { return await getJson(`${b}${path}`, fetchImpl); } catch (e) { last = e; } }
  throw Object.assign(new Error('the coins of your Bitcoin wallet could not be read just now'), { cause: last, scanFailed: true });
}

export async function notesAt(address, { fetchImpl = (...a) => fetch(...a), bases = BASES } = {}) {
  if (!/^(bc1|[13])[0-9a-zA-Z]{20,90}$/.test(String(address || ''))) throw Object.assign(new Error('your Bitcoin wallet gave no mainnet address'), { scanFailed: true });
  const coins = await read(`/address/${address}/utxo`, { fetchImpl, bases });
  if (!Array.isArray(coins)) throw Object.assign(new Error('the coins of your Bitcoin wallet could not be read just now'), { scanFailed: true });
  if (coins.length > MAX_COINS) throw Object.assign(new Error('your Bitcoin wallet holds too many coins to check here'), { scanFailed: true });
  const txs = new Map(), carriers = [];
  for (const c of coins) {
    const txid = String(c && c.txid || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) throw Object.assign(new Error('the coins of your Bitcoin wallet could not be read just now'), { scanFailed: true });
    if (!txs.has(txid)) txs.set(txid, await read(`/tx/${txid}`, { fetchImpl, bases }));
    if (hasEnvelope(txs.get(txid))) carriers.push({ txid, vout: Number(c.vout), value: Number(c.value) });
  }
  return { carriers, coins: coins.length };
}
