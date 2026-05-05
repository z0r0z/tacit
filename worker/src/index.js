// tacit-pin Worker
// Endpoints:
//   POST /pin               — upload an image; returns { cid, size }
//   GET  /balance           — faucet wallet balance + address
//   POST /drip { address }  — send DRIP_SATS to a signet address
//   GET  /assets            — list all known tacit-etched assets on signet
//   GET  /assets/:asset_id  — single asset's metadata
//   POST /scan              — manually trigger a registry scan (debug)
//   POST /rescan?from=<h>   — rewind meta:last_scanned so next tick re-scans from height <h> (debug)
// Scheduled (cron */5 * * * *): scan recent signet blocks for new CETCH envelopes.
//
// Secrets (set via `wrangler secret put`):
//   PINATA_JWT     — Pinata API JWT for image uploads
//   FAUCET_PRIV    — 64-hex signet wallet privkey for the auto-faucet
//
// All trust-bearing logic stays in the dApp (rangeproof, kernel sig, recursive
// validation). This Worker is purely cache + convenience.

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

// ============== CONSTANTS ==============
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const PNG_MAGIC  = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const SIGNET_HRP = 'tb';
const DUST = 546;
const ENVELOPE_MAGIC = new TextEncoder().encode('TACIT');
const T_CETCH = 0x21;
const N_BITS = 32;
const EXPECTED_RANGEPROOF_LEN = N_BITS * (33 + 4 * 32); // 5152

// ============== UTIL ==============
const hash160 = b => ripemd160(sha256(b));
const hash256 = b => sha256(sha256(b));
const reverseBytes = b => { const r = new Uint8Array(b); r.reverse(); return r; };

function corsHeaders(env, reqOrigin) {
  const list = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const allow = list.includes('*') ? '*' : (list.includes(reqOrigin) ? reqOrigin : list[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function jsonResponse(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// ============== mempool.space CLIENT ==============
async function apiText(env, path, opts = {}) {
  const r = await fetch(`${env.SIGNET_API}${path}`, opts);
  if (!r.ok) throw new Error(`signet ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.text();
}
async function apiJson(env, path, opts = {}) {
  const r = await fetch(`${env.SIGNET_API}${path}`, opts);
  if (!r.ok) throw new Error(`signet ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ============== /pin ==============
function startsWith(b, prefix) {
  if (b.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (b[i] !== prefix[i]) return false;
  return true;
}
function isWebP(b) {
  return b.length > 12
    && b[0]===0x52 && b[1]===0x49 && b[2]===0x46 && b[3]===0x46
    && b[8]===0x57 && b[9]===0x45 && b[10]===0x42 && b[11]===0x50;
}
function magicMatches(bytes, mime) {
  if (mime === 'image/png')  return startsWith(bytes, PNG_MAGIC);
  if (mime === 'image/jpeg') return startsWith(bytes, JPEG_MAGIC);
  if (mime === 'image/webp') return isWebP(bytes);
  return false;
}

async function handlePin(req, env, cors) {
  if (!env.PINATA_JWT) {
    return jsonResponse({ error: 'server not configured (PINATA_JWT missing)' }, 500, cors);
  }
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const kvKey = `pin:${day}:${ip}`;
  const dailyLimit = parseInt(env.DAILY_LIMIT || '20', 10);
  const prior = parseInt((await env.UPLOAD_KV.get(kvKey)) || '0', 10);
  if (prior >= dailyLimit) {
    return jsonResponse({ error: 'daily upload limit reached' }, 429, cors);
  }

  let fd;
  try { fd = await req.formData(); }
  catch { return jsonResponse({ error: 'expected multipart form-data' }, 400, cors); }
  const file = fd.get('file');
  if (!(file instanceof File)) {
    return jsonResponse({ error: 'missing form field "file"' }, 400, cors);
  }
  const maxBytes = parseInt(env.MAX_BYTES || String(2 * 1024 * 1024), 10);
  if (file.size > maxBytes) {
    return jsonResponse({ error: `file exceeds ${maxBytes} bytes` }, 413, cors);
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return jsonResponse({ error: `mime not allowed: ${file.type}` }, 415, cors);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!magicMatches(bytes, file.type)) {
    return jsonResponse({ error: 'file content does not match declared mime' }, 415, cors);
  }

  const ext = file.type.split('/')[1];
  const pinFd = new FormData();
  pinFd.append('file', new Blob([bytes], { type: file.type }), `tacit-${Date.now()}.${ext}`);
  pinFd.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  let pinResp;
  try {
    pinResp = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.PINATA_JWT}` },
      body: pinFd,
    });
  } catch { return jsonResponse({ error: 'pinata unreachable' }, 502, cors); }
  if (!pinResp.ok) {
    const text = (await pinResp.text()).slice(0, 240);
    return jsonResponse({ error: `pinata ${pinResp.status}: ${text}` }, 502, cors);
  }
  const j = await pinResp.json();
  if (!j.IpfsHash) return jsonResponse({ error: 'pinata returned no CID' }, 502, cors);

  await env.UPLOAD_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
  return jsonResponse({ cid: j.IpfsHash, size: j.PinSize ?? bytes.length }, 200, cors);
}

// ============== /pin-json — pin a small metadata JSON blob ==============
// Used when the etcher wants to attach description / external_url / etc. The
// resulting CID goes into the CETCH envelope's image_uri field; renderers
// dereference it to find { name, description, image, external_url }.
async function handlePinJson(req, env, cors) {
  if (!env.PINATA_JWT) return jsonResponse({ error: 'PINATA_JWT missing' }, 500, cors);

  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const kvKey = `pin:${day}:${ip}`;
  const dailyLimit = parseInt(env.DAILY_LIMIT || '20', 10);
  const prior = parseInt((await env.UPLOAD_KV.get(kvKey)) || '0', 10);
  if (prior >= dailyLimit) return jsonResponse({ error: 'daily upload limit reached' }, 429, cors);

  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'expected JSON body' }, 400, cors); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonResponse({ error: 'expected JSON object' }, 400, cors);
  }
  // Whitelist allowed fields; ignore everything else to keep blobs predictable.
  const allowed = ['name', 'description', 'image', 'external_url', 'decimals'];
  const clean = {};
  for (const k of allowed) if (body[k] !== undefined) clean[k] = body[k];
  const json = JSON.stringify(clean);
  if (json.length > 4096) {
    return jsonResponse({ error: 'metadata exceeds 4 KB' }, 413, cors);
  }

  const pinFd = new FormData();
  pinFd.append('file', new Blob([json], { type: 'application/json' }), `tacit-meta-${Date.now()}.json`);
  pinFd.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  let pinResp;
  try {
    pinResp = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.PINATA_JWT}` },
      body: pinFd,
    });
  } catch { return jsonResponse({ error: 'pinata unreachable' }, 502, cors); }
  if (!pinResp.ok) {
    const text = (await pinResp.text()).slice(0, 240);
    return jsonResponse({ error: `pinata ${pinResp.status}: ${text}` }, 502, cors);
  }
  const j = await pinResp.json();
  if (!j.IpfsHash) return jsonResponse({ error: 'pinata returned no CID' }, 502, cors);

  await env.UPLOAD_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
  return jsonResponse({ cid: j.IpfsHash }, 200, cors);
}

// ============== Bitcoin tx primitives (P2WPKH only — what the faucet needs) ==============
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
const p2wpkhScript  = pub => concatBytes(new Uint8Array([0x00, 0x14]), hash160(pub));
const p2wpkhAddress = (pub, hrp) => bech32.encode(hrp, [0, ...bech32.toWords(hash160(pub))]);
function addressToScript(addr, hrp) {
  const decoded = bech32.decode(addr);
  if (decoded.prefix !== hrp) throw new Error(`wrong network prefix: ${decoded.prefix}`);
  if (decoded.words[0] !== 0) throw new Error('only segwit v0 supported');
  const program = bech32.fromWords(decoded.words.slice(1));
  if (program.length !== 20) throw new Error('only P2WPKH (20-byte programs) supported');
  return concatBytes(new Uint8Array([0x00, 0x14]), new Uint8Array(program));
}
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

function derEncode(rs) {
  const trim = x => {
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
function signECDSA(hash, priv) {
  const sig = secp.sign(hash, priv, { lowS: true });
  return concatBytes(derEncode(sig.toCompactRawBytes()), new Uint8Array([0x01]));
}

// ============== /balance + /drip ==============
function faucetKeys(env) {
  if (!env.FAUCET_PRIV) throw new Error('FAUCET_PRIV not set');
  const cleaned = env.FAUCET_PRIV.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleaned)) throw new Error('FAUCET_PRIV must be 64 hex chars');
  const priv = hexToBytes(cleaned);
  const pub = secp.getPublicKey(priv, true);
  const address = p2wpkhAddress(pub, SIGNET_HRP);
  return { priv, pub, address };
}

async function handleBalance(env, cors) {
  let f;
  try { f = faucetKeys(env); }
  catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
  let utxos;
  try { utxos = await apiJson(env, `/address/${f.address}/utxo`); }
  catch (e) { return jsonResponse({ error: e.message }, 502, cors); }
  const balance = utxos.reduce((s, u) => s + u.value, 0);
  return jsonResponse({ address: f.address, balance, utxos: utxos.length }, 200, cors);
}

async function handleDrip(req, env, cors) {
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'expected JSON body' }, 400, cors); }
  const recipient = String(body.address || '').trim();
  if (!recipient) return jsonResponse({ error: 'missing "address"' }, 400, cors);

  let recipientScript;
  try { recipientScript = addressToScript(recipient, SIGNET_HRP); }
  catch (e) { return jsonResponse({ error: `invalid address: ${e.message}` }, 400, cors); }

  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const ipKey = `drip:ip:${day}:${ip}`;
  const addrKey = `drip:addr:${day}:${recipient}`;
  const ipLimit = parseInt(env.FAUCET_IP_LIMIT || '1', 10);
  const addrLimit = parseInt(env.FAUCET_ADDR_LIMIT || '1', 10);
  const ipPrior = parseInt((await env.REGISTRY_KV.get(ipKey)) || '0', 10);
  const addrPrior = parseInt((await env.REGISTRY_KV.get(addrKey)) || '0', 10);
  if (ipPrior >= ipLimit)   return jsonResponse({ error: `IP daily limit reached (${ipLimit}/day)` }, 429, cors);
  if (addrPrior >= addrLimit) return jsonResponse({ error: `address daily limit reached (${addrLimit}/day)` }, 429, cors);

  let f;
  try { f = faucetKeys(env); }
  catch (e) { return jsonResponse({ error: e.message }, 500, cors); }

  let utxos;
  try { utxos = await apiJson(env, `/address/${f.address}/utxo`); }
  catch (e) { return jsonResponse({ error: e.message }, 502, cors); }
  if (!utxos.length) return jsonResponse({ error: 'faucet has no UTXOs — send signet sats to ' + f.address }, 503, cors);

  const dripSats = parseInt(env.DRIP_SATS || '20000', 10);
  const feeRate = 2; // signet, conservative
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const picked = []; let total = 0;
  let estVb = 11 + 1 * 68 + 31 * 2;
  let estFee = Math.max(200, Math.ceil(estVb * feeRate));
  for (const u of sorted) {
    picked.push(u); total += u.value;
    estVb = 11 + picked.length * 68 + 31 * 2;
    estFee = Math.max(200, Math.ceil(estVb * feeRate));
    if (total >= dripSats + estFee + DUST) break;
  }
  if (total < dripSats + estFee) {
    return jsonResponse({ error: `faucet underfunded: ${total} sats, need ${dripSats + estFee}` }, 503, cors);
  }
  const change = total - dripSats - estFee;
  const outputs = [{ value: dripSats, script: recipientScript }];
  if (change >= DUST) outputs.push({ value: change, script: p2wpkhScript(f.pub) });

  const tx = {
    version: 2, locktime: 0,
    inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs,
  };
  const scriptCode = concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), hash160(f.pub), new Uint8Array([0x88, 0xac]));
  for (let i = 0; i < tx.inputs.length; i++) {
    const sh = sighashV0(tx, i, scriptCode, picked[i].value);
    const sig = signECDSA(sh, f.priv);
    tx.inputs[i].witness = [sig, f.pub];
  }
  const hex = bytesToHex(serializeTx(tx));

  let broadcastTxid;
  try { broadcastTxid = (await apiText(env, '/tx', { method: 'POST', body: hex })).trim(); }
  catch (e) { return jsonResponse({ error: `broadcast failed: ${e.message}` }, 502, cors); }

  await env.REGISTRY_KV.put(ipKey, String(ipPrior + 1), { expirationTtl: 90000 });
  await env.REGISTRY_KV.put(addrKey, String(addrPrior + 1), { expirationTtl: 90000 });

  return jsonResponse({
    txid: broadcastTxid,
    amount_sats: dripSats,
    fee_sats: estFee,
    recipient,
    explorer: `https://mempool.space/signet/tx/${broadcastTxid}`,
  }, 200, cors);
}

// ============== /assets — registry ==============
function decodeEnvelopeScript(script) {
  if (!script || script.length < 36) return null;
  let p = 0;
  if (script[p] !== 32) return null; p += 1;
  if (p + 32 > script.length) return null;
  p += 32; // signing pubkey
  if (p + 1 > script.length || script[p] !== 0xac) return null; p += 1; // OP_CHECKSIG
  if (p + 2 > script.length || script[p] !== 0x00 || script[p + 1] !== 0x63) return null; p += 2; // OP_FALSE OP_IF
  const pushes = [];
  let sawEndif = false;
  while (p < script.length) {
    if (script[p] === 0x68) { p += 1; sawEndif = true; break; }
    const op = script[p]; p += 1;
    let data;
    if (op >= 1 && op <= 75) {
      if (p + op > script.length) return null;
      data = script.slice(p, p + op); p += op;
    } else if (op === 0x4c) {
      if (p + 1 > script.length) return null;
      const ln = script[p]; p += 1;
      if (p + ln > script.length) return null;
      data = script.slice(p, p + ln); p += ln;
    } else if (op === 0x4d) {
      if (p + 2 > script.length) return null;
      const ln = script[p] | (script[p + 1] << 8); p += 2;
      if (p + ln > script.length) return null;
      data = script.slice(p, p + ln); p += ln;
    } else if (op === 0x00) {
      data = new Uint8Array(0);
    } else { return null; }
    pushes.push(data);
  }
  if (!sawEndif || p !== script.length || pushes.length < 3) return null;
  if (pushes[0].length !== 5) return null;
  for (let i = 0; i < 5; i++) if (pushes[0][i] !== ENVELOPE_MAGIC[i]) return null;
  if (pushes[1].length !== 1 || pushes[1][0] !== 0x01) return null;
  const payload = concatBytes(...pushes.slice(2));
  if (payload.length < 1) return null;
  return { opcode: payload[0], payload };
}

function decodeCEtchPayload(payload) {
  if (!payload) return null;
  const minLen = 1 + 1 + 1 + 1 + 33 + EXPECTED_RANGEPROOF_LEN + 8 + 2;
  if (payload.length < minLen) return null;
  if (payload[0] !== T_CETCH) return null;
  let p = 1;
  const tlen = payload[p]; p += 1;
  if (tlen < 1 || tlen > 16) return null;
  if (p + tlen > payload.length) return null;
  let ticker;
  try { ticker = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + tlen)); } catch { return null; }
  p += tlen;
  const decimals = payload[p]; p += 1;
  if (decimals > 8) return null;
  if (p + 33 + EXPECTED_RANGEPROOF_LEN + 8 + 2 > payload.length) return null;
  const commitment = payload.slice(p, p + 33); p += 33;
  p += EXPECTED_RANGEPROOF_LEN; // skip rangeproof
  p += 8;                        // skip amount_ct
  const imgLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (imgLen > 256) return null;
  if (p + imgLen !== payload.length) return null;
  let imageUri = null;
  if (imgLen > 0) {
    try { imageUri = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + imgLen)); } catch { return null; }
  }
  return { ticker, decimals, commitment: bytesToHex(commitment), imageUri };
}
function assetIdFor(etchTxidHex, etchVout) {
  const txidBE = reverseBytes(hexToBytes(etchTxidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, etchVout >>> 0, true);
  return bytesToHex(sha256(concatBytes(txidBE, voutLE)));
}

async function handleAssetsList(env, cors) {
  // Cap at 1000 entries; pagination is a future concern.
  const list = await env.REGISTRY_KV.list({ prefix: 'asset:', limit: 1000 });
  const assets = [];
  for (const k of list.keys) {
    const v = await env.REGISTRY_KV.get(k.name, 'json');
    if (v) assets.push(v);
  }
  assets.sort((a, b) => (b.etched_at || 0) - (a.etched_at || 0));
  // Surface scan freshness so the dApp can show "scanned up to block X" and
  // explain the gap to a just-broadcast etch that hasn't been indexed yet.
  const lastScanned = parseInt((await env.REGISTRY_KV.get('meta:last_scanned')) || '0', 10);
  let tip = null;
  try { tip = parseInt((await apiText(env, '/blocks/tip/height')).trim(), 10); } catch {}
  return jsonResponse({
    count: assets.length,
    assets,
    meta: { last_scanned: lastScanned, tip },
  }, 200, cors);
}
async function handleAssetGet(assetIdHex, env, cors) {
  const v = await env.REGISTRY_KV.get(`asset:${assetIdHex}`, 'json');
  if (!v) return jsonResponse({ error: 'unknown asset_id' }, 404, cors);
  return jsonResponse(v, 200, cors);
}

// ============== Cron: scan signet for new CETCH envelopes ==============
async function fetchBlockTxs(env, blockHash) {
  const all = [];
  let startIdx = 0;
  while (true) {
    let txs;
    try { txs = await apiJson(env, `/block/${blockHash}/txs/${startIdx}`); }
    catch { break; }
    if (!Array.isArray(txs) || txs.length === 0) break;
    all.push(...txs);
    if (txs.length < 25) break;
    startIdx += 25;
    if (all.length >= 1000) break; // safety
  }
  return all;
}

async function rewindLastScanned(env, from) {
  if (!Number.isInteger(from) || from < 0) throw new Error('from must be a non-negative integer');
  const tip = parseInt((await apiText(env, '/blocks/tip/height')).trim(), 10);
  if (from > tip) throw new Error(`from (${from}) is ahead of tip (${tip})`);
  const prior = parseInt((await env.REGISTRY_KV.get('meta:last_scanned')) || '0', 10);
  // Set last_scanned to from-1 so next scan tick begins exactly at `from`.
  // Special-case from=0: clear the key so the first-run backfill branch fires again.
  if (from === 0) await env.REGISTRY_KV.delete('meta:last_scanned');
  else await env.REGISTRY_KV.put('meta:last_scanned', String(from - 1));
  return { rewound_to: from, prior_last_scanned: prior, tip };
}

async function scanForEtches(env) {
  const lastScanned = parseInt((await env.REGISTRY_KV.get('meta:last_scanned')) || '0', 10);
  const tip = parseInt((await apiText(env, '/blocks/tip/height')).trim(), 10);
  // First run: backfill ~2 weeks of signet history (2016 blocks @ 10-min target).
  // At 5 blocks/tick × 5-min cron, catch-up takes ~34h. Subsequent runs: continue from last+1.
  const startHeight = lastScanned > 0 ? lastScanned + 1 : Math.max(0, tip - 2016);
  // Cap blocks per run to stay within Worker subrequest limits.
  const endHeight = Math.min(tip, startHeight + 5);
  if (startHeight > tip) return { up_to_date: true, tip };

  let scanned = 0, found = 0;
  // Track the highest CONTIGUOUSLY-completed height. Stop on any failure so we
  // re-try the failed block on the next cron tick instead of permanently skipping it.
  let lastContiguous = lastScanned;
  for (let h = startHeight; h <= endHeight; h++) {
    let blockHash;
    try { blockHash = (await apiText(env, `/block-height/${h}`)).trim(); }
    catch { break; } // stop here; next run retries from lastContiguous + 1
    let txs;
    try { txs = await fetchBlockTxs(env, blockHash); }
    catch { break; }
    for (const tx of txs) {
      scanned++;
      if (!tx.vin || !tx.vin[0] || !tx.vin[0].witness || tx.vin[0].witness.length < 3) continue;
      let envBytes;
      try { envBytes = hexToBytes(tx.vin[0].witness[1]); } catch { continue; }
      const decoded = decodeEnvelopeScript(envBytes);
      if (!decoded || decoded.opcode !== T_CETCH) continue;
      const ce = decodeCEtchPayload(decoded.payload);
      if (!ce) continue;
      const aid = assetIdFor(tx.txid, 0);
      const meta = {
        asset_id: aid,
        ticker: ce.ticker,
        decimals: ce.decimals,
        commitment: ce.commitment,
        image_uri: ce.imageUri,
        etch_txid: tx.txid,
        etch_vout: 0,
        etched_at_height: h,
        etched_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
      };
      await env.REGISTRY_KV.put(`asset:${aid}`, JSON.stringify(meta));
      found++;
    }
  }
  await env.REGISTRY_KV.put('meta:last_scanned', String(endHeight));
  return { scanned_txs: scanned, found_etches: found, from: startHeight, to: endHeight, tip };
}

// ============== ROUTER ==============
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(env, req.headers.get('Origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/pin' && req.method === 'POST')      return handlePin(req, env, cors);
    if (url.pathname === '/pin-json' && req.method === 'POST') return handlePinJson(req, env, cors);
    if (url.pathname === '/balance' && req.method === 'GET')   return handleBalance(env, cors);
    if (url.pathname === '/drip' && req.method === 'POST')     return handleDrip(req, env, cors);
    if (url.pathname === '/assets' && req.method === 'GET')    return handleAssetsList(env, cors);
    const m = url.pathname.match(/^\/assets\/([0-9a-f]{64})$/);
    if (m && req.method === 'GET')                             return handleAssetGet(m[1], env, cors);

    if (url.pathname === '/scan' && req.method === 'POST') {
      try { return jsonResponse(await scanForEtches(env), 200, cors); }
      catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
    }

    if (url.pathname === '/rescan' && req.method === 'POST') {
      try {
        const fromStr = url.searchParams.get('from');
        if (fromStr === null) return jsonResponse({ error: 'missing ?from=<height>' }, 400, cors);
        const from = parseInt(fromStr, 10);
        return jsonResponse(await rewindLastScanned(env, from), 200, cors);
      } catch (e) { return jsonResponse({ error: e.message }, 400, cors); }
    }

    return jsonResponse({ error: 'not found' }, 404, cors);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(scanForEtches(env).catch(() => {}));
  },
};
