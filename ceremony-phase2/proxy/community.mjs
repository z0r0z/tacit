import { createHash, randomBytes } from 'node:crypto';

export const COMMUNITY_PATHS = new Set(['/api/community/challenge', '/api/community/verify']);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;
const BALANCE_OF = '70a08231';
const CONTRACTS = [
  ['tac', '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279'],
  ['wei', '0x0000000000696760e15f265e828db644a0c242eb'],
  ['zorgz', '0x00000000008835cef3e0d2333695f288ee6b63a6'],
];
const challenges = new Map();
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (!r.ok || j.error || typeof j.result !== 'string') throw new Error(j.error?.message || `Ethereum RPC answered ${r.status}`);
  return j.result;
}

async function recover(rpcURL, message, signature) {
  const prefix = `\x19Ethereum Signed Message:\n${Buffer.byteLength(message)}`;
  const digest = await rpc(rpcURL, 'web3_sha3', ['0x' + hex(prefix + message)]);
  const raw = signature.slice(2);
  const r = raw.slice(0, 64), s = raw.slice(64, 128);
  let v = parseInt(raw.slice(128), 16);
  if (v < 27) v += 27;
  if (v !== 27 && v !== 28) throw new Error('invalid signature recovery id');
  const input = digest.slice(2) + v.toString(16).padStart(64, '0') + r + s;
  const out = await rpc(rpcURL, 'eth_call', [{ to: '0x0000000000000000000000000000000000000001', data: '0x' + input }, 'latest']);
  return out.length >= 42 ? '0x' + out.slice(-40).toLowerCase() : '';
}

async function signals(rpcURL, address) {
  const data = '0x' + BALANCE_OF + address.slice(2).toLowerCase().padStart(64, '0');
  const found = [];
  for (const [name, contract] of CONTRACTS) {
    const out = await rpc(rpcURL, 'eth_call', [{ to: contract, data }, 'latest']);
    if (BigInt(out) > 0n) found.push(name);
  }
  return found;
}

async function body(req, limit = 4096) {
  const chunks = []; let n = 0;
  for await (const chunk of req) { n += chunk.length; if (n > limit) throw new Error('request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function handleCommunity(req, res, { upstream, cors, rpcURL, priorityKey }) {
  const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }); res.end(JSON.stringify(value)); };
  if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
  if (!rpcURL || !priorityKey) return send(503, { error: 'the community lane is not available yet' });
  const token = String(req.headers['x-ceremony-token'] || '').trim();
  if (!/^[0-9a-f]{32}$/i.test(token)) return send(401, { error: 'join the line before proving community participation' });
  const key = tokenHash(token);
  if (req.url.split('?')[0] === '/api/community/challenge') {
    // A random token must not allocate memory or obtain a signing prompt. This call also keeps a real place alive.
    const place = await fetch(upstream + '/api/slot', { headers: { 'x-ceremony-token': token }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!place?.ok) return send(place?.status === 404 ? 404 : 502, { error: place?.status === 404 ? 'that queue place no longer exists' : 'the coordinator did not answer' });
    const now = Date.now();
    for (const [k, v] of challenges) if (Date.parse(v.expires) < now) challenges.delete(k);
    if (challenges.size >= 1000) challenges.delete(challenges.keys().next().value);
    const expires = new Date(Date.now() + 10 * 60_000).toISOString();
    const nonce = randomBytes(16).toString('hex');
    const message = ['Tacit Praxis community lane', 'This signature proves community participation only. It cannot move funds.', `Queue: ${key}`, `Nonce: ${nonce}`, `Expires: ${expires}`].join('\n');
    challenges.set(key, { nonce, expires, message });
    return send(200, { message, expires });
  }
  let input;
  try { input = await body(req); } catch { return send(400, { error: 'invalid request' }); }
  if (!ADDRESS.test(input.address || '') || !SIG.test(input.signature || '')) return send(400, { error: 'an address and wallet signature are required' });
  const challenge = challenges.get(key);
  challenges.delete(key); // every signature attempt is one-shot
  if (!challenge || Date.parse(challenge.expires) < Date.now()) return send(409, { error: 'the proof expired; sign a fresh message' });
  try {
    const address = input.address.toLowerCase();
    if (await recover(rpcURL, challenge.message, input.signature) !== address) return send(403, { error: 'the wallet signature does not match that address' });
    const held = await signals(rpcURL, address);
    if (!held.length) return send(403, { error: 'this wallet does not currently hold TAC, a .wei name, or zOrgz' });
    const level = held.length >= 2 ? 2 : 1;
    const r = await fetch(upstream + '/api/community', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ceremony-token': token, 'x-ceremony-priority-key': priorityKey }, body: JSON.stringify({ supporter: address, level, signals: held }), signal: AbortSignal.timeout(8000) });
    const result = await r.json().catch(() => ({}));
    return send(r.status, r.ok ? { ...result, address, level, signals: held } : { error: result.error || 'the coordinator could not upgrade this place' });
  } catch {
    return send(502, { error: 'wallet ownership could not be checked right now; your queue place is unchanged' });
  }
}
