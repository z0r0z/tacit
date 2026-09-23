// Local records, without the spend authority.
//
// The wallet holds nothing: every note re-derives from one wallet signature, so a browser that is read —
// by an extension, by an XSS on this origin, by the next person on a shared machine — yields nothing to
// spend with. Two local records broke that by writing live keys into localStorage next to the data that
// locates them: the stealth-send refund record (lock blinding + refund key = the whole refund authority,
// and buildStealthRefund signs over a caller-chosen refund owner, so a reader refunds to a note of their
// own) and the CDP position descriptor (the position's close key, and the debt note's nullifier key).
//
// This module is the one place that decides what such a record may hold. The rule, in order:
//   1. a locator in the clear — a leaf, a nonce, an amount, a deadline: all of it already public on-chain;
//   2. nothing secret at all where the secret re-derives from the wallet key plus that locator;
//   3. where a secret is genuinely not derivable and the record is the only copy, it is sealed: AES-GCM
//      under sha256(domain ‖ walletPriv), the same shape confidential-otc-tab.js already uses for the
//      maker draft. A reader still gets the blob; the blob is not a key.
//
// Records written by older builds are plaintext, and dropping them would strand a pending send or a live
// position. Every reader here accepts both shapes, and `migrate` rewrites a plaintext record sealed, in
// place, keeping every field it cannot re-derive rather than deleting it.
//
// Sealing needs WebCrypto. Where it is unavailable (an insecure origin), a record is kept for the session
// only and the caller is told — a plaintext write is the one outcome this module will not produce.

import { derivePositionOwnerPriv, privBytes } from './confidential-recovery.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (h) => Uint8Array.from((String(h == null ? '' : h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };
const lc = (h) => String(h == null ? '' : h).toLowerCase();

// localStorage when there is one, and a no-op otherwise (node, a private window with storage denied) so a
// caller never has to guard a read.
export function defaultStorage() {
  try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch { /* denied */ }
  return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}
const readJson = (storage, key, fallback) => {
  try { const v = JSON.parse(storage.getItem(key) || 'null'); return v == null ? fallback : v; } catch { return fallback; }
};
// A write counts only if it reads back: a stubbed or denied storage accepts setItem and keeps nothing, and a
// record the caller believes is saved would then be gone on the next render.
const writeJson = (storage, key, value) => {
  try {
    const json = JSON.stringify(value);
    storage.setItem(key, json);
    return storage.getItem(key) === json;
  } catch { return false; }
};

export const isSealed = (b) => !!b && typeof b === 'object' && b.alg === 'a256gcm' && typeof b.ct === 'string' && typeof b.iv === 'string';

// Seal/open a value under a key only this wallet can compute. The domain separates one record type from
// another, so a blob from one store is not openable as another.
export function makeSecretStore({ sha256, subtle, randomBytes } = {}) {
  if (typeof sha256 !== 'function') throw new Error('secret-store: sha256 is required');
  // `subtle: null` means "there is none here" (the insecure-origin case), not "use the default".
  const _subtle = subtle !== undefined ? subtle : ((globalThis.crypto && globalThis.crypto.subtle) || null);
  const _rand = randomBytes || ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const available = () => !!_subtle;
  const keyFor = async (walletPriv, domain) => {
    if (!_subtle) throw new Error('secret-store: WebCrypto is unavailable on this origin — nothing was written');
    // A missing or malformed key would still hash to something, and that something would be the same for
    // everyone: refuse rather than seal under a key the whole world can compute.
    const pb = walletPriv == null ? null : privBytes(walletPriv);
    if (!pb || pb.length !== 32 || pb.every((b) => b === 0)) throw new Error('secret-store: a 32-byte wallet key is required');
    const km = sha256(cat(enc.encode('tacit-secret-store-v1/' + domain), pb));
    return _subtle.importKey('raw', km, 'AES-GCM', false, ['encrypt', 'decrypt']);
  };
  async function seal(walletPriv, domain, value) {
    const key = await keyFor(walletPriv, domain);
    const iv = _rand(12);
    const ct = new Uint8Array(await _subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))));
    return { v: 1, alg: 'a256gcm', iv: hexOf(iv), ct: hexOf(ct) };
  }
  // null on anything that does not open: a blob of another wallet, another domain, or a corrupted one. The
  // AES-GCM tag is what decides, so a wrong key is a miss rather than garbage.
  async function open(walletPriv, domain, blob) {
    if (!isSealed(blob)) return null;
    try {
      const key = await keyFor(walletPriv, domain);
      const pt = await _subtle.decrypt({ name: 'AES-GCM', iv: bytesOf(blob.iv) }, key, bytesOf(blob.ct));
      return JSON.parse(dec.decode(new Uint8Array(pt)));
    } catch { return null; }
  }
  return { seal, open, isSealed, available };
}

// ── pending stealth sends ──
// The sender's own backstop for a lock it minted. The chain carries the same refund authority in the sender
// tail of the lock memo (scanSentLocks re-opens it), but a relay that substituted the memo leaves this record
// as the only copy — a known gen5 limit — so the record stays. What changes is that its two secrets, the lock
// blinding and the refund key, are sealed; the locator (lock leaf, commitment, amount, deadline, recipient)
// stays readable so the pending list renders without the wallet being unlocked.
export const STEALTH_SEND_LS_KEY = 'tacit:stealthSends:v1';
const STEALTH_DOMAIN = 'stealth-send';
const STEALTH_SECRETS = ['lBlinding', 'refundPriv'];

export function makeStealthSendStore({ sha256, storage = defaultStorage(), subtle, randomBytes } = {}) {
  const vault = makeSecretStore({ sha256, subtle, randomBytes });
  const session = [];                           // records that could not be sealed: this tab only, never written
  const stored = () => { const v = readJson(storage, STEALTH_SEND_LS_KEY, []); return Array.isArray(v) ? v : []; };
  const list = () => [...stored(), ...session];
  const split = (rec) => {
    const pub = { ...rec }; const secrets = {};
    for (const k of STEALTH_SECRETS) { if (pub[k] != null) secrets[k] = pub[k]; delete pub[k]; }
    return { pub, secrets };
  };

  // Persist one send. Returns { persisted } — false means WebCrypto could not seal it, the record is held for
  // this session only, and the caller should say so rather than let the user believe it survives a reload.
  async function add(walletPriv, rec) {
    const { pub, secrets } = split(rec);
    try {
      const sec = await vault.seal(walletPriv, STEALTH_DOMAIN, secrets);
      const all = stored(); all.push({ ...pub, sec });
      if (!writeJson(storage, STEALTH_SEND_LS_KEY, all)) throw new Error('storage unavailable');
      return { persisted: true };
    } catch {
      session.push({ ...rec });
      return { persisted: false };
    }
  }

  // The refund secrets of one record: sealed, or plaintext from a record an older build wrote.
  async function secretsFor(walletPriv, rec) {
    if (!rec) return null;
    if (rec.sec) return await vault.open(walletPriv, STEALTH_DOMAIN, rec.sec);
    const { secrets } = split(rec);
    return secrets.refundPriv && secrets.lBlinding ? secrets : null;
  }

  function remove(lockLeaf) {
    const keep = stored().filter((r) => lc(r.lockLeaf) !== lc(lockLeaf));
    writeJson(storage, STEALTH_SEND_LS_KEY, keep);
    for (let i = session.length - 1; i >= 0; i--) if (lc(session[i].lockLeaf) === lc(lockLeaf)) session.splice(i, 1);
  }

  // Rewrite every plaintext record sealed. A record that cannot be sealed is left exactly as it was: a
  // pending refund is worth more than a tidy store, and the next call tries again.
  async function migrate(walletPriv) {
    const all = stored();
    const out = []; let sealedCount = 0, failed = 0;
    for (const rec of all) {
      if (!rec || rec.sec || !STEALTH_SECRETS.some((k) => rec[k] != null)) { out.push(rec); continue; }
      const { pub, secrets } = split(rec);
      try { out.push({ ...pub, sec: await vault.seal(walletPriv, STEALTH_DOMAIN, secrets) }); sealedCount++; }
      catch { out.push(rec); failed++; }
    }
    if (sealedCount) writeJson(storage, STEALTH_SEND_LS_KEY, out);
    return { sealed: sealedCount, failed };
  }

  return { list, add, remove, secretsFor, migrate, sealingAvailable: vault.available };
}

// ── CDP position descriptors ──
// A descriptor is a cache of what the chain already holds: recoverCdpPositions rebuilds every position from
// the wallet key alone. The close key is the Nth position key against this controller, so the descriptor
// keeps the nonce and nothing else — the key itself is derived at close time and checked against the owner
// the position was opened under. The debt note's keys come from deriveOutput(walletPriv, debtAnchor,
// 'cdpDebt', 0), so the anchor (a nullifier the settle makes public) replaces them.
export const CDP_POSITIONS_LS_KEY = 'tacit-cdp-positions-v1';
const CDP_DOMAIN = 'cdp-position';
const CDP_SECRETS = ['positionOwnerPriv', 'debtNk', 'debtBlinding'];

export function makeCdpPositionStore({ sha256, hmac, secp, curveOrder, storage = defaultStorage(), subtle, randomBytes } = {}) {
  if (typeof hmac !== 'function' || !secp) throw new Error('cdp-position-store: hmac and secp are required');
  const N = BigInt(curveOrder || secp.CURVE.n);
  const vault = makeSecretStore({ sha256, subtle, randomBytes });
  const session = [];
  const stored = () => { const v = readJson(storage, CDP_POSITIONS_LS_KEY, []); return Array.isArray(v) ? v : []; };
  const list = () => [...stored(), ...session];
  const derive = (walletPriv, controller, keyNonce) => derivePositionOwnerPriv({ hmac, sha256, curveOrder: N }, walletPriv, controller, keyNonce);
  const xOnlyOf = (priv) => '0x' + hexOf(secp.getPublicKey(bytesOf(priv), true).subarray(1));
  const split = (rec) => {
    const pub = { ...rec }; const secrets = {};
    for (const k of CDP_SECRETS) { if (pub[k] != null) secrets[k] = pub[k]; delete pub[k]; }
    return { pub, secrets };
  };

  // Store one opening. Its keys are dropped, not sealed: they re-derive from (walletPriv, controller,
  // keyNonce) and the anchor. A descriptor whose nonce does not reproduce the owner it was opened under
  // would not be re-derivable, so that one is sealed instead of being written bare.
  async function add(walletPriv, rec) {
    const { pub, secrets } = split(rec);
    const leftover = { ...secrets };
    if (Number.isInteger(pub.keyNonce) && pub.positionOwner
      && lc(xOnlyOf(derive(walletPriv, pub.controller, pub.keyNonce))) === lc(pub.positionOwner)) delete leftover.positionOwnerPriv;
    if (pub.debtAnchor) { delete leftover.debtNk; delete leftover.debtBlinding; }
    if (!Object.keys(leftover).length) {
      const all = stored(); all.push(pub);
      if (writeJson(storage, CDP_POSITIONS_LS_KEY, all)) return { persisted: true, sealed: false };
      session.push({ ...rec });
      return { persisted: false, sealed: false };
    }
    try {
      const sec = await vault.seal(walletPriv, CDP_DOMAIN, leftover);
      const all = stored(); all.push({ ...pub, sec });
      if (!writeJson(storage, CDP_POSITIONS_LS_KEY, all)) throw new Error('storage unavailable');
      return { persisted: true, sealed: true };
    } catch {
      session.push({ ...rec });
      return { persisted: false, sealed: false };
    }
  }

  // The key that signs this position's close: derived from the nonce where the descriptor has one (and only
  // when it reproduces the owner the position was opened under), then the sealed copy, then a plaintext copy
  // an older build wrote or a position handed over in memory by recoverCdpPositions.
  async function ownerPrivFor(walletPriv, rec) {
    if (!rec) return null;
    // A derived key is used only when it reproduces the owner the position was opened under. A descriptor
    // with no owner recorded at all predates per-position owners (it was opened under the identity owner),
    // so deriving one for it would sign under the wrong key: its own copy answers instead.
    const owner = lc(rec.positionOwner || '');
    if (owner && Number.isInteger(rec.keyNonce) && rec.controller) {
      const d = derive(walletPriv, rec.controller, rec.keyNonce);
      if (lc(xOnlyOf(d)) === owner) return d;
    }
    if (rec.sec) {
      const s = await vault.open(walletPriv, CDP_DOMAIN, rec.sec);
      if (s && s.positionOwnerPriv) return s.positionOwnerPriv;
    }
    return rec.positionOwnerPriv || null;
  }

  // The debt note's nullifier key and blinding, re-derived from the anchor the descriptor keeps. `deriveOutput`
  // is ux.deriveOutput. Older descriptors carry no anchor; their sealed or plaintext copy answers instead.
  async function debtKeysFor(walletPriv, rec, deriveOutput) {
    if (rec && rec.debtAnchor && typeof deriveOutput === 'function') {
      const k = deriveOutput(walletPriv, rec.debtAnchor, 'cdpDebt', 0);
      return { debtNk: k.nk, debtBlinding: k.blindingHex };
    }
    if (rec && rec.sec) {
      const s = await vault.open(walletPriv, CDP_DOMAIN, rec.sec);
      if (s && s.debtNk) return { debtNk: s.debtNk, debtBlinding: s.debtBlinding };
    }
    if (rec && rec.debtNk) return { debtNk: rec.debtNk, debtBlinding: rec.debtBlinding };
    return null;
  }

  function remove(pred) {
    const keep = stored().filter((r) => !pred(r));
    writeJson(storage, CDP_POSITIONS_LS_KEY, keep);
    for (let i = session.length - 1; i >= 0; i--) if (pred(session[i])) session.splice(i, 1);
  }

  // Plaintext descriptors → derivable, or sealed. A descriptor that predates the key nonce gets one back by
  // walking nonces until the derived owner matches the one it was opened under (the same walk
  // recoverCdpPositions does against the chain); what that finds is a locator, so the key can then be dropped.
  // Anything still not derivable keeps every secret it has, sealed.
  async function migrate(walletPriv, { maxNonceScan = 64 } = {}) {
    const all = stored();
    const out = []; let derivableCount = 0, sealedCount = 0, failed = 0;
    for (const rec of all) {
      if (!rec || rec.sec || !CDP_SECRETS.some((k) => rec[k] != null)) { out.push(rec); continue; }
      const { pub, secrets } = split(rec);
      const owner = lc(pub.positionOwner || '');
      let keyNonce = owner && pub.controller && Number.isInteger(pub.keyNonce) ? pub.keyNonce : null;
      if (owner && pub.controller) {
        if (keyNonce != null && lc(xOnlyOf(derive(walletPriv, pub.controller, keyNonce))) !== owner) keyNonce = null;
        if (keyNonce == null) {
          for (let k = 0; k < maxNonceScan; k++) {
            if (lc(xOnlyOf(derive(walletPriv, pub.controller, k))) === owner) { keyNonce = k; break; }
          }
        }
      }
      // Only what re-derives is dropped: the close key once the nonce reproduces it, the debt keys once the
      // descriptor carries the anchor they derive from. Whatever is left is sealed rather than deleted.
      const leftover = { ...secrets };
      if (keyNonce != null) delete leftover.positionOwnerPriv;
      if (pub.debtAnchor) { delete leftover.debtNk; delete leftover.debtBlinding; }
      if (!Object.keys(leftover).length) { out.push({ ...pub, keyNonce }); derivableCount++; continue; }
      try {
        const sealedRec = { ...pub, sec: await vault.seal(walletPriv, CDP_DOMAIN, leftover) };
        if (keyNonce != null) sealedRec.keyNonce = keyNonce;
        out.push(sealedRec); sealedCount++;
      } catch { out.push(rec); failed++; }
    }
    if (derivableCount || sealedCount) writeJson(storage, CDP_POSITIONS_LS_KEY, out);
    return { derivable: derivableCount, sealed: sealedCount, failed };
  }

  return { list, add, remove, ownerPrivFor, debtKeysFor, migrate, sealingAvailable: vault.available };
}

// ── imported farm positions ──
// Everything a wallet bonds itself is derived (lpBondPosition) and nothing is stored. The one record that
// exists is a position opened under a key this wallet cannot derive — an externally-held receipt the holder
// pasted in — so there is nothing to re-derive and the key itself has to be kept. It is sealed: the receipt
// leaf, the pool and the share count stay readable (all of them on-chain), the signing key does not.
export const FARM_RECORDS_LS_KEY = 'tacit:farm-position-records:v1';
const FARM_DOMAIN = 'farm-position';

export function makeImportedFarmStore({ sha256, storage = defaultStorage(), subtle, randomBytes } = {}) {
  const vault = makeSecretStore({ sha256, subtle, randomBytes });
  const session = new Map();                    // records that could not be sealed: this tab only
  const stored = () => { const v = readJson(storage, FARM_RECORDS_LS_KEY, {}); return v && typeof v === 'object' ? v : {}; };

  // Every imported record, with `ownerPriv` in hand. A record sealed to another wallet simply does not open
  // and is skipped — it is not this wallet's position.
  async function list(walletPriv) {
    const out = new Map(session);
    for (const [k, rec] of Object.entries(stored())) {
      if (!rec) continue;
      if (rec.sec) {
        const s = await vault.open(walletPriv, FARM_DOMAIN, rec.sec);
        if (s && s.ownerPriv) out.set(k, { ...rec, ownerPriv: s.ownerPriv, sec: undefined });
        continue;
      }
      out.set(k, rec);                          // plaintext, from an older build: still usable, resealed by migrate
    }
    return [...out.values()];
  }

  async function add(walletPriv, rec) {
    const { ownerPriv, ...pub } = rec;
    session.set(pub.receiptLeaf, { ...rec });   // usable for this session whatever storage does
    try {
      const sec = await vault.seal(walletPriv, FARM_DOMAIN, { ownerPriv });
      const all = stored();
      all[pub.receiptLeaf] = { ...pub, sec };
      if (!writeJson(storage, FARM_RECORDS_LS_KEY, all)) throw new Error('storage unavailable');
      return { persisted: true };
    } catch {
      return { persisted: false };
    }
  }

  async function migrate(walletPriv) {
    const all = stored();
    let sealedCount = 0, failed = 0;
    for (const [k, rec] of Object.entries(all)) {
      if (!rec || rec.sec || !rec.ownerPriv) continue;
      const { ownerPriv, ...pub } = rec;
      try { all[k] = { ...pub, sec: await vault.seal(walletPriv, FARM_DOMAIN, { ownerPriv }) }; sealedCount++; }
      catch { failed++; }
    }
    if (sealedCount) writeJson(storage, FARM_RECORDS_LS_KEY, all);
    return { sealed: sealedCount, failed };
  }

  return { list, add, migrate, sealingAvailable: vault.available };
}
