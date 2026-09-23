// What a browser is allowed to keep. Each store here used to write live spend authority into localStorage in
// the clear — the stealth-send refund record, the CDP position descriptor, the imported farm receipt key.
// These checks pin the three rules: a locator stays readable, a derivable secret is not written at all, a
// non-derivable one is sealed under the wallet key, and a record an older build wrote in the clear still
// opens and is rewritten in place rather than stranded.
import { test } from 'node:test';
import assert from 'node:assert';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 } from '../node_modules/@noble/hashes/sha2.js';
import { derivePositionOwnerPriv } from '../dapp/confidential-recovery.js';
import {
  makeSecretStore, makeStealthSendStore, makeCdpPositionStore, makeImportedFarmStore,
  STEALTH_SEND_LS_KEY, CDP_POSITIONS_LS_KEY, FARM_RECORDS_LS_KEY, isSealed,
} from '../dapp/confidential-secret-store.js';

const walletPriv = '0x' + '7a'.repeat(32);
const otherPriv = '0x' + '7b'.repeat(32);
const CONTROLLER = '0x00000000000000000000000000000000000c0ffe';
const curveOrder = secp.CURVE.n;
const xOnly = (priv) => '0x' + Buffer.from(secp.getPublicKey(Buffer.from(priv.replace(/^0x/, ''), 'hex'), true).subarray(1)).toString('hex');
const ownerPrivAt = (k) => derivePositionOwnerPriv({ hmac, sha256, curveOrder }, walletPriv, CONTROLLER, k);

// A localStorage stand-in: the real one's exact contract (strings in, strings out, null when absent).
function fakeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    raw: (k) => (m.has(k) ? m.get(k) : null),
  };
}
// The blunt check that matters: no 32-byte secret anywhere in what the browser wrote.
const assertAbsent = (storage, key, secrets) => {
  const blob = storage.raw(key) || '';
  for (const s of secrets) assert.ok(!blob.toLowerCase().includes(String(s).replace(/^0x/, '').toLowerCase()), `secret found in the clear: ${s}`);
};

test('secret store: a sealed value opens under its own wallet and domain, and under nothing else', async () => {
  const vault = makeSecretStore({ sha256 });
  const blob = await vault.seal(walletPriv, 'stealth-send', { refundPriv: '0x' + '11'.repeat(32) });
  assert.ok(isSealed(blob));
  assert.deepEqual(await vault.open(walletPriv, 'stealth-send', blob), { refundPriv: '0x' + '11'.repeat(32) });
  assert.equal(await vault.open(otherPriv, 'stealth-send', blob), null);      // another wallet
  assert.equal(await vault.open(walletPriv, 'cdp-position', blob), null);      // another record type
  assert.equal(await vault.open(walletPriv, 'stealth-send', { ...blob, ct: blob.ct.replace(/^../, 'ff') }), null); // tampered
  await assert.rejects(vault.seal(null, 'stealth-send', { a: 1 }), /32-byte wallet key/);
});

test('stealth sends: the refund authority is sealed, the locator stays readable', async () => {
  const storage = fakeStorage();
  const store = makeStealthSendStore({ sha256, storage });
  const rec = {
    lockLeaf: '0x' + 'ab'.repeat(32), asset: '0x' + '01'.repeat(32), ticker: 'USDC', dec: 6, amount: '1000000',
    deadline: '1790000000', lCx: '0x' + '02'.repeat(32), lCy: '0x' + '03'.repeat(32), ownerPub: '0x' + '04'.repeat(32),
    lBlinding: '0x' + 'de'.repeat(32), refundPriv: '0x' + 'ad'.repeat(32), refundPub: '0x' + '05'.repeat(32),
    recipientPubHex: '0x' + '06'.repeat(32), txHash: '0x' + '07'.repeat(32), createdAt: 1,
  };
  assert.deepEqual(await store.add(walletPriv, rec), { persisted: true });

  const written = JSON.parse(storage.raw(STEALTH_SEND_LS_KEY));
  assert.equal(written.length, 1);
  assert.equal(written[0].lBlinding, undefined);
  assert.equal(written[0].refundPriv, undefined);
  assert.equal(written[0].amount, '1000000');                 // still renderable without the wallet
  assert.equal(written[0].deadline, '1790000000');
  assert.ok(isSealed(written[0].sec));
  assertAbsent(storage, STEALTH_SEND_LS_KEY, [rec.lBlinding, rec.refundPriv]);

  const [listed] = store.list();
  assert.deepEqual(await store.secretsFor(walletPriv, listed), { lBlinding: rec.lBlinding, refundPriv: rec.refundPriv });
  assert.equal(await store.secretsFor(otherPriv, listed), null);

  store.remove(rec.lockLeaf);
  assert.deepEqual(store.list(), []);
});

test('stealth sends: a plaintext record from an older build still refunds, and is rewritten sealed', async () => {
  const legacy = {
    lockLeaf: '0x' + 'cd'.repeat(32), asset: '0x' + '01'.repeat(32), ticker: 'ETH', dec: 8, amount: '42',
    deadline: '1790000000', lCx: '0x' + '02'.repeat(32), lCy: '0x' + '03'.repeat(32), ownerPub: '0x' + '04'.repeat(32),
    lBlinding: '0x' + 'be'.repeat(32), refundPriv: '0x' + 'ef'.repeat(32), refundPub: '0x' + '05'.repeat(32),
    recipientPubHex: '0x' + '06'.repeat(32),
  };
  const storage = fakeStorage({ [STEALTH_SEND_LS_KEY]: JSON.stringify([legacy]) });
  const store = makeStealthSendStore({ sha256, storage });

  // Readable before the migration runs: an upgrade must not strand a pending send.
  assert.deepEqual(await store.secretsFor(walletPriv, store.list()[0]), { lBlinding: legacy.lBlinding, refundPriv: legacy.refundPriv });

  assert.deepEqual(await store.migrate(walletPriv), { sealed: 1, failed: 0 });
  assertAbsent(storage, STEALTH_SEND_LS_KEY, [legacy.lBlinding, legacy.refundPriv]);
  const after = store.list()[0];
  assert.ok(isSealed(after.sec));
  assert.equal(after.lockLeaf, legacy.lockLeaf);
  assert.deepEqual(await store.secretsFor(walletPriv, after), { lBlinding: legacy.lBlinding, refundPriv: legacy.refundPriv });

  assert.deepEqual(await store.migrate(walletPriv), { sealed: 0, failed: 0 });   // idempotent
});

test('stealth sends: with no WebCrypto the record is held for the session, never written in the clear', async () => {
  const storage = fakeStorage();
  const store = makeStealthSendStore({ sha256, storage, subtle: null });
  const rec = { lockLeaf: '0x' + 'ee'.repeat(32), amount: '7', lBlinding: '0x' + 'be'.repeat(32), refundPriv: '0x' + 'ef'.repeat(32) };
  assert.deepEqual(await store.add(walletPriv, rec), { persisted: false });
  assert.equal(storage.raw(STEALTH_SEND_LS_KEY), null);
  assert.equal(store.list().length, 1);
  assert.deepEqual(await store.secretsFor(walletPriv, store.list()[0]), { lBlinding: rec.lBlinding, refundPriv: rec.refundPriv });
});

test('cdp positions: a new descriptor stores the nonce and the anchor, and no key at all', async () => {
  const storage = fakeStorage();
  const store = makeCdpPositionStore({ sha256, hmac, secp, curveOrder, storage });
  const keyNonce = 2;
  const priv = ownerPrivAt(keyNonce);
  const debtNk = '0x' + '5a'.repeat(32);
  const r = await store.add(walletPriv, {
    controller: CONTROLLER, debtValue: '100', keyNonce, positionOwner: xOnly(priv), rateSnapshot: '0x' + '0'.repeat(63) + '1',
    debtAnchor: '0x' + '9a'.repeat(32), basket: [{ asset: '0x' + '01'.repeat(32), value: '5' }], debtNk, debtBlinding: '0x' + '5b'.repeat(32),
  });
  assert.deepEqual(r, { persisted: true, sealed: false });
  const written = JSON.parse(storage.raw(CDP_POSITIONS_LS_KEY))[0];
  assert.equal(written.positionOwnerPriv, undefined);
  assert.equal(written.debtNk, undefined);
  assert.equal(written.debtBlinding, undefined);
  assert.equal(written.sec, undefined);                        // nothing to seal: all of it re-derives
  assert.equal(written.keyNonce, keyNonce);
  assertAbsent(storage, CDP_POSITIONS_LS_KEY, [priv, debtNk]);

  assert.equal(await store.ownerPrivFor(walletPriv, store.list()[0]), priv);
  assert.equal(await store.ownerPrivFor(otherPriv, store.list()[0]), null);     // a different wallet derives a different key

  // The debt note's keys come back through ux.deriveOutput, from the anchor the descriptor kept.
  const deriveOutput = (_priv, anchor, role, index) => ({ nk: `nk:${anchor}:${role}:${index}`, blindingHex: `b:${anchor}` });
  assert.deepEqual(await store.debtKeysFor(walletPriv, store.list()[0], deriveOutput),
    { debtNk: `nk:0x${'9a'.repeat(32)}:cdpDebt:0`, debtBlinding: `b:0x${'9a'.repeat(32)}` });
});

test('cdp positions: plaintext descriptors migrate — derivable keys dropped, a nonce recovered by walking, the rest sealed', async () => {
  const withNonce = { controller: CONTROLLER, debtValue: '1', keyNonce: 0, positionOwner: xOnly(ownerPrivAt(0)), positionOwnerPriv: ownerPrivAt(0), debtNk: '0x' + 'aa'.repeat(32), debtBlinding: '0x' + 'ab'.repeat(32), debtAnchor: '0x' + '9a'.repeat(32), basket: [] };
  const noNonce = { controller: CONTROLLER, debtValue: '2', positionOwner: xOnly(ownerPrivAt(5)), positionOwnerPriv: ownerPrivAt(5), basket: [] };
  const foreign = { controller: CONTROLLER, debtValue: '3', positionOwner: xOnly('0x' + '3c'.repeat(32)), positionOwnerPriv: '0x' + '3c'.repeat(32), basket: [] };
  const storage = fakeStorage({ [CDP_POSITIONS_LS_KEY]: JSON.stringify([withNonce, noNonce, foreign]) });
  const store = makeCdpPositionStore({ sha256, hmac, secp, curveOrder, storage });

  // Closable before the migration too — the plaintext copy is still honoured.
  assert.equal(await store.ownerPrivFor(walletPriv, store.list()[2]), foreign.positionOwnerPriv);

  assert.deepEqual(await store.migrate(walletPriv), { derivable: 2, sealed: 1, failed: 0 });
  const after = JSON.parse(storage.raw(CDP_POSITIONS_LS_KEY));
  assert.equal(after[0].positionOwnerPriv, undefined);
  assert.equal(after[0].debtNk, undefined);                    // the anchor re-derives it
  assert.equal(after[1].keyNonce, 5);                          // recovered by walking nonces against the owner
  assert.equal(after[1].positionOwnerPriv, undefined);
  assert.ok(isSealed(after[2].sec));                           // a key this wallet cannot derive: sealed, not dropped
  assert.equal(after[2].positionOwnerPriv, undefined);
  assertAbsent(storage, CDP_POSITIONS_LS_KEY, [withNonce.positionOwnerPriv, withNonce.debtNk, noNonce.positionOwnerPriv, foreign.positionOwnerPriv]);

  const list = store.list();
  assert.equal(await store.ownerPrivFor(walletPriv, list[0]), ownerPrivAt(0));
  assert.equal(await store.ownerPrivFor(walletPriv, list[1]), ownerPrivAt(5));
  assert.equal(await store.ownerPrivFor(walletPriv, list[2]), foreign.positionOwnerPriv);
  assert.equal(await store.ownerPrivFor(otherPriv, list[2]), null);

  // A descriptor whose nonce does not reproduce its owner is not silently mis-derived.
  assert.equal(await store.ownerPrivFor(walletPriv, { ...list[0], keyNonce: 9 }), null);

  assert.deepEqual(await store.migrate(walletPriv), { derivable: 0, sealed: 0, failed: 0 });   // idempotent
});

test('imported farm positions: the externally-held receipt key is sealed, and a plaintext one is resealed', async () => {
  const receiptLeaf = '0x' + 'f0'.repeat(32);
  const ownerPriv = '0x' + 'f1'.repeat(32);
  const storage = fakeStorage();
  const store = makeImportedFarmStore({ sha256, storage });
  assert.deepEqual(await store.add(walletPriv, { receiptLeaf, lpAsset: '0x' + '01'.repeat(32), shares: '10', owner: xOnly(ownerPriv), nonce: '0x' + '00'.repeat(32), ownerPriv }), { persisted: true });
  assertAbsent(storage, FARM_RECORDS_LS_KEY, [ownerPriv]);
  const [one] = await store.list(walletPriv);
  assert.equal(one.ownerPriv, ownerPriv);
  assert.equal(one.shares, '10');
  // After a reload the session cache is gone and only what storage holds is left: it does not open elsewhere.
  const reloaded = makeImportedFarmStore({ sha256, storage });
  assert.equal((await reloaded.list(walletPriv))[0].ownerPriv, ownerPriv);
  assert.deepEqual(await reloaded.list(otherPriv), []);

  const legacyLeaf = '0x' + 'f2'.repeat(32);
  const legacyPriv = '0x' + 'f3'.repeat(32);
  const st2 = fakeStorage({ [FARM_RECORDS_LS_KEY]: JSON.stringify({ [legacyLeaf]: { receiptLeaf: legacyLeaf, lpAsset: '0x' + '01'.repeat(32), shares: '4', owner: xOnly(legacyPriv), nonce: '0x' + '00'.repeat(32), ownerPriv: legacyPriv } }) });
  const store2 = makeImportedFarmStore({ sha256, storage: st2 });
  assert.equal((await store2.list(walletPriv))[0].ownerPriv, legacyPriv);   // usable before the migration
  assert.deepEqual(await store2.migrate(walletPriv), { sealed: 1, failed: 0 });
  assertAbsent(st2, FARM_RECORDS_LS_KEY, [legacyPriv]);
  assert.equal((await store2.list(walletPriv))[0].ownerPriv, legacyPriv);   // and after it
});

test('cdp positions: a descriptor with no owner recorded keeps its own key rather than deriving a wrong one', async () => {
  // Pre-dates per-position owners: the position was opened under the identity owner, so the Nth-position key
  // is not its key. Sealing it is the only safe answer — deriving one would sign the close under the wrong key.
  const ancient = { controller: CONTROLLER, debtValue: '9', keyNonce: 0, positionOwnerPriv: '0x' + '4d'.repeat(32), basket: [] };
  const storage = fakeStorage({ [CDP_POSITIONS_LS_KEY]: JSON.stringify([ancient]) });
  const store = makeCdpPositionStore({ sha256, hmac, secp, curveOrder, storage });
  assert.equal(await store.ownerPrivFor(walletPriv, store.list()[0]), ancient.positionOwnerPriv);
  assert.deepEqual(await store.migrate(walletPriv), { derivable: 0, sealed: 1, failed: 0 });
  assertAbsent(storage, CDP_POSITIONS_LS_KEY, [ancient.positionOwnerPriv]);
  assert.equal(await store.ownerPrivFor(walletPriv, store.list()[0]), ancient.positionOwnerPriv);
});
