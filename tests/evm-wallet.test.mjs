// dapp/evm-wallet.js with two wallets announced (EIP-6963): which wallet a connect or a sign-in goes to, what a failed one
// keeps, whose account changes reach the page, and the wallet connected last coming back on the next page without a prompt.
//   node tests/evm-wallet.test.mjs
import assert from 'node:assert';
import { secp, sha256, keccak_256, hmac, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { prfBytesToScalar } from '../dapp/prf-wallet.js';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m)); // as tacit.js sets it
globalThis.window = new EventTarget();
const store = new Map();                                                         // this browser's localStorage, shared by every page
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const heard = [];
window.addEventListener('tacit:evm-accounts', (e) => heard.push(e.detail));
const { makeEvmWallet } = await import('../dapp/evm-wallet.js');

let pass = 0;
const ok = (name, c) => { assert.ok(c, name); pass++; console.log('  ok  ' + name); };
const enc = (s) => new TextEncoder().encode(s);

// A browser wallet holding one key: it announces itself, answers the requests a sign-in makes (any of which it can be set
// to refuse, as a person refusing it would), and emits accountsChanged when told.
function wallet(name, privHex) {
  const priv = hexToBytes(privHex), addr = '0x' + bytesToHex(keccak_256(secp.getPublicKey(priv, false).slice(1)).slice(12));
  const on = {}, w = { refuse: new Set(), allowed: false, calls: [] };
  w.provider = {
    async request({ method, params }) {
      w.calls.push(method);
      if (w.refuse.has(method)) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      if (method === 'eth_requestAccounts') { w.allowed = true; return [addr]; }
      if (method === 'eth_accounts') { if (w.hold) await w.hold; return w.allowed ? [addr] : []; }   // what the site was allowed before, with no prompt
      if (method === 'eth_getCode') return '0x';
      if (method === 'personal_sign') {
        const m = hexToBytes(params[0].slice(2)), s = secp.sign(keccak_256(new Uint8Array([...enc(`\x19Ethereum Signed Message:\n${m.length}`), ...m])), priv);
        return '0x' + bytesToHex(s.toCompactRawBytes()) + (27 + s.recovery).toString(16);
      }
      throw new Error('unexpected ' + method);
    },
    on(ev, f) { (on[ev] ||= []).push(f); },
  };
  w.emit = (accounts) => { for (const f of on.accountsChanged || []) f(accounts); };
  w.addr = addr;
  const detail = { info: { uuid: 'uuid-' + name, name, icon: '', rdns: 'test.' + name.toLowerCase() }, provider: w.provider };
  window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
  return w;
}
const A = wallet('A', '11'.repeat(32)), B = wallet('B', '22'.repeat(32));
const evm = makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' });
let picks = 0, choice = 'A';
const pick = async (list) => { picks++; return list.find((w) => w.name === choice)?.uuid; };
// Which wallets' account changes reach the page.
const reach = () => { heard.length = 0; A.emit([]); B.emit([]); return heard.map((d) => (d.provider === A.provider ? 'A' : d.provider === B.provider ? 'B' : '?')).join(); };

A.refuse.add('eth_requestAccounts');
await assert.rejects(evm.connect({ pick }), /rejected/);
A.refuse.clear();
await evm.connect({ pick });
ok('a wallet that refused the connection is asked about again on the next connect', picks === 2);
await evm.connect({ pick });
ok('a wallet that connected is kept: the next connect goes straight to it', picks === 2);
ok('the account changes of the wallet in use reach the page', reach() === 'A');

// The key is locked (the choice forgotten) and opened with the other wallet.
evm.deselectProvider();
choice = 'B';
const idB = await evm.deriveIdentity({ pick });
ok('after a lock the next sign-in asks which wallet', picks === 3 && idB.provider === B.provider && idB.label === 'B');
ok('a wallet connected before and since left is not heard: only the one in use is', reach() === 'B');

// A sign-in with a wallet chosen for it fails at the signature.
evm.deselectProvider();
choice = 'A';
A.refuse.add('personal_sign');
await assert.rejects(evm.deriveIdentity({ pick }), /rejected/);
ok('a sign-in that failed leaves the wallet in use as it was', reach() === 'B');
A.refuse.clear();
const p0 = picks;
const idA = await evm.deriveIdentity({ pick });
ok('the sign-in after it asks which wallet again', picks === p0 + 1 && idA.provider === A.provider);
ok('and once it succeeds, its wallet is the one heard', reach() === 'A');

// A sign-in with the wallet chosen before fails at the signature: that choice stands.
A.refuse.add('personal_sign');
const p1 = picks;
await assert.rejects(evm.deriveIdentity({ pick }), /rejected/);
A.refuse.clear();
await evm.deriveIdentity({ pick });
ok('a wallet chosen before stays chosen after a failed sign-in with it', picks === p1);

// A sign-in for a known account that the wallet is not on is refused before it signs, and keeps nothing.
evm.deselectProvider();
choice = 'B';
await assert.rejects(evm.deriveIdentity({ pick, expect: idA.address }), /Switch your wallet/);
const p2 = picks;
choice = 'A';
await evm.deriveIdentity({ pick, expect: idA.address });
ok('a sign-in refused for the wrong account asks which wallet again', picks === p2 + 1 && reach() === 'A');

// The wallet connected last is remembered by which wallet it is, and the next page connects it again with no prompt.
ok('the wallet a sign-in used last is the one recorded, by name and not by account', store.get('tacit-trade-wallet') === 'test.a');
const prompts = () => A.calls.concat(B.calls).filter((m) => m === 'eth_requestAccounts' || m === 'personal_sign').length;
const before = prompts(), askedB = B.calls.length;
evm.forget(); store.set('tacit-trade-wallet', 'test.a');                         // the page before is closed: it hears nothing more
const next = makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' });   // another page
const back = await next.restore();
ok('a page that opens next gets that wallet and its account back', back?.provider === A.provider && back.address === A.addr.slice(2));
ok('with no prompt, no signature, and without so much as asking the other wallet', prompts() === before && B.calls.length === askedB);
const p3 = picks;
await next.connect({ pick });
ok('and its next connect goes straight to that wallet', picks === p3);
heard.length = 0; A.emit([]);
ok('whose account changes reach the page that restored it', heard.length === 1 && heard[0].provider === A.provider);

// A wallet that no longer allows the site, or one that is not there, gives nothing.
A.allowed = false;
ok('a wallet that no longer allows the site is not restored', (await makeEvmWallet({}).restore()) === null);
A.allowed = true;
store.set('tacit-trade-wallet', 'test.gone');
const t0 = Date.now();
ok('a remembered wallet that is not in this browser gives nothing, after a short wait', (await makeEvmWallet({}).restore()) === null && Date.now() - t0 < 2000);
store.delete('tacit-trade-wallet');
const calls0 = A.calls.length + B.calls.length;
ok('and with no wallet remembered, no wallet is asked anything', (await makeEvmWallet({}).restore()) === null && A.calls.length + B.calls.length === calls0);

// A person quicker than the restore keeps their choice.
store.set('tacit-trade-wallet', 'test.a');
const quick = makeEvmWallet({});
let release; A.hold = new Promise((r) => { release = r; });                      // the remembered wallet is slow to answer
const slow = quick.restore();
await quick.connect({ pick: async (l) => l.find((w) => w.name === 'B').uuid });
release(); A.hold = null;
ok('a wallet connected while the restore runs is not replaced by it', (await slow) === null && store.get('tacit-trade-wallet') === 'test.b');

// Disconnect: forgotten here and for the next page, and no longer heard.
await quick.restore();                                                           // (no-op: B is in use)
quick.forget();
ok('Disconnect clears the record', store.get('tacit-trade-wallet') === undefined);
heard.length = 0; B.emit([]);
ok('and the wallet is no longer heard', heard.length === 0);
ok('a page that opens after finds nothing to restore', (await makeEvmWallet({}).restore()) === null);


// ── Disconnect hands the permission back, and Switch opens the wallet's own chooser ──────────────────────────────────────────────────────
// A wallet holding several accounts: it announces itself, allows the site once asked, takes the permission back (EIP-2255) and offers its account
// chooser (wallet_requestPermissions) unless told it has neither, and says what it was asked.
function multi(name, accounts, { revoke = true, choose = true } = {}) {
  const on = {}, w = { accounts, at: 0, allowed: false, calls: [], revoke, choose, picks: 0 };
  const cur = () => w.accounts[w.at];
  w.provider = {
    async request({ method }) {
      w.calls.push(method);
      if (method === 'eth_requestAccounts') { w.allowed = true; return [cur()]; }
      if (method === 'eth_accounts') return w.allowed ? [cur()] : [];
      if (method === 'wallet_revokePermissions') {
        if (!w.revoke) throw Object.assign(new Error('The method wallet_revokePermissions does not exist'), { code: -32601 });
        if (w.stall) await new Promise(() => {});
        w.allowed = false; return null;
      }
      if (method === 'wallet_requestPermissions') {
        if (!w.choose) throw Object.assign(new Error('Method not found'), { code: -32601 });
        if (w.refuseChoice) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        w.at = (w.at + 1) % w.accounts.length; w.picks++;
        return [{ parentCapability: 'eth_accounts' }];
      }
      throw new Error('unexpected ' + method);
    },
    on(ev, f) { (on[ev] ||= []).push(f); },
  };
  w.emit = (accs) => { for (const f of on.accountsChanged || []) f(accs); };
  const detail = { info: { uuid: 'uuid-' + name, name, icon: '', rdns: 'test.' + name.toLowerCase() }, provider: w.provider };
  window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
  return w;
}
const strip = (a) => a.slice(2);
const A1 = '0x' + 'a1'.repeat(20), A2 = '0x' + 'a2'.repeat(20);
const M = multi('M', [A1, A2]);
const mine = makeEvmWallet({});
const pickM = async (l) => l.find((w) => w.name === 'M')?.uuid;
await mine.connect({ pick: pickM });
heard.length = 0;
const sw = await mine.changeAccount({ pick: pickM });
ok('Switch opens the wallet\'s own chooser and returns the account it answers', M.picks === 1 && sw.address === strip(A2) && sw.provider === M.provider);
heard.length = 0; M.emit([A1]);
ok('and the wallet stays the one in use, so its next account change reaches the page', heard.length === 1 && heard[0].accounts[0] === A1);
M.refuseChoice = true;
await assert.rejects(mine.changeAccount({ pick: pickM }), (e) => e.code === 4001);
M.refuseChoice = false;
ok('a chooser the person closes is a refusal the page can tell apart (4001), and changes nothing', store.get('tacit-trade-wallet') === 'test.m');
M.choose = false;
await assert.rejects(mine.changeAccount({ pick: pickM }), /Choose another account in your wallet/);
M.choose = true;
ok('a wallet without a chooser is not left hanging: the person is told to choose in it', true);
await assert.rejects(makeEvmWallet({}).changeAccount(), /no Ethereum wallet connected|no accounts/);
ok('and a page with no wallet connected is told so', true);

// Disconnect
heard.length = 0;
M.calls.length = 0;
await mine.disconnect();
ok('Disconnect hands the site\'s permission back to the wallet', M.calls.includes('wallet_revokePermissions') && M.allowed === false);
ok('and tells every page once that the wallet has no accounts, as the wallet locking would', heard.length === 1 && heard[0].accounts.length === 0 && heard[0].provider === M.provider);
ok('the record is cleared and the wallet is no longer heard', store.get('tacit-trade-wallet') === undefined && (heard.length = 0, M.emit([A1]), heard.length === 0));
ok('a page that opens next finds nothing to restore, and the wallet asks again on the next connect', (await makeEvmWallet({}).restore()) === null && (await mine.connect({ pick: pickM })).address === strip(A2) && M.calls.filter((m) => m === 'eth_requestAccounts').length === 1);

// a wallet with no way to take the permission back is let go of all the same
const N = multi('N', [A1], { revoke: false });
const noRevoke = makeEvmWallet({});
await noRevoke.connect({ pick: async (l) => l.find((w) => w.name === 'N').uuid });
heard.length = 0;
await noRevoke.disconnect();
ok('a wallet without wallet_revokePermissions is let go of all the same, with no error', heard.length === 1 && store.get('tacit-trade-wallet') === undefined);

// one that never answers is not waited for
const S = multi('S', [A1]); S.stall = true;
const stalled = makeEvmWallet({});
await stalled.connect({ pick: async (l) => l.find((w) => w.name === 'S').uuid });
const t2 = Date.now();
await stalled.disconnect();
ok('a wallet that never answers the revoke is waited for only a moment', Date.now() - t2 < 3000);

// WalletConnect: the session ends in the wallet app, and Switch pairs again
const wc = { isWalletConnect: true, ended: 0, paired: 0, on() {}, async endSession() { wc.ended++; }, async request({ method }) { if (method === 'eth_requestAccounts') { wc.paired++; return [A2]; } throw new Error('unexpected ' + method); } };
const wcDetail = { info: { uuid: 'uuid-wc', name: 'WalletConnect', icon: '', rdns: 'com.walletconnect' }, provider: wc };
const announceWc = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: wcDetail }));
window.addEventListener('eip6963:requestProvider', announceWc);
const viaWc = makeEvmWallet({});
const pickWc = async (l) => l.find((w) => w.name === 'WalletConnect').uuid;
await viaWc.connect({ pick: pickWc });
heard.length = 0;
const again = await viaWc.changeAccount({ pick: pickWc });
ok('Switch on a WalletConnect session ends it in the wallet app and pairs again', wc.ended === 1 && wc.paired === 2 && again.address === strip(A2) && heard.some((d) => d.accounts.length === 0));
await viaWc.disconnect();
ok('Disconnect ends a WalletConnect session in the wallet app', wc.ended === 2);
window.removeEventListener('eip6963:requestProvider', announceWc);

// Another tab of the site
const storage = (key, newValue) => window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue, storageArea: localStorage }));
const tab = makeEvmWallet({});
let restored = 0; tab.onElsewhere(() => { restored++; });
storage('tacit-trade-wallet', 'test.m');
ok('a wallet connected in another tab calls what the page gave to restore it', restored === 1);
await tab.connect({ pick: pickM });
storage('tacit-trade-wallet', 'test.m');
ok('and not when this tab has a wallet of its own', restored === 1);
heard.length = 0;
storage('tacit-trade-wallet', null);
// (every page-instance of this process that had a wallet in use hears it; a real page has one)
ok('a wallet disconnected in another tab is disconnected here: the page is told it has no accounts', heard.some((d) => d.provider === M.provider && d.accounts.length === 0) && heard.every((d) => d.accounts.length === 0));
heard.length = 0; M.emit([A2]);
ok('and it is not heard after', heard.length === 0);
storage('some-other-key', null);
ok('another record changing in storage is nothing to it', restored === 1);

// A sign-in is not held up before the wallet is asked to sign
const C = wallet('C', '33'.repeat(32));
const pickC = async (l) => l.find((w) => w.name === 'C').uuid;
const steps = [];
const first = makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' });
const baseC = C.calls.length;
const stuck = new Promise(() => {});
const getCode = C.provider.request;
C.provider.request = (r) => (r.method === 'eth_getCode' ? (C.calls.push('eth_getCode'), stuck) : getCode(r));
C.allowed = true;
const t3 = Date.now();
const idC = await first.deriveIdentity({ pick: pickC, onStep: (s) => steps.push(s) });
const callsC = C.calls.slice(baseC);
ok('the account the site may already read is taken with no request that could prompt', callsC[0] === 'eth_accounts' && !callsC.includes('eth_requestAccounts'));
ok('the first sign-in signs twice, and says so at each step', callsC.filter((m) => m === 'personal_sign').length === 2 && steps.join() === 'account,sign,confirm');
ok('a wallet whose node never answers the code read is waited for only a moment, then asked to sign', callsC.includes('eth_getCode') && Date.now() - t3 < 4000 && idC.address === strip(C.addr));

C.provider.request = getCode;
steps.length = 0;
const baseC2 = C.calls.length;
const again2 = makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' });
const idC2 = await again2.deriveIdentity({ pick: pickC, onStep: (s) => steps.push(s) });
const callsC2 = C.calls.slice(baseC2);
ok('an account that opened its key here is signed for at once: its code is not read, and it signs once', callsC2.join() === 'eth_accounts,personal_sign' && steps.join() === 'account,sign');
ok('and it opens the same key', idC2.priv === idC.priv && idC2.pubHex === idC.pubHex);

C.allowed = false;
const baseC3 = C.calls.length;
await makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' }).deriveIdentity({ pick: pickC });
ok('a wallet that has not allowed the site is asked, as ever', C.calls.slice(baseC3).slice(0, 2).join() === 'eth_accounts,eth_requestAccounts');

// The code read is not in front of the prompt: a slow node costs the sign-in a moment at most, and a contract is still refused
const slowCode = (w, ms, code = '0x') => { const base = w.provider.request; w.provider.request = async (r) => { if (r.method !== 'eth_getCode') return base(r); w.calls.push('eth_getCode'); w.codeAskedAt = Date.now(); await new Promise((d) => setTimeout(d, ms)); return code; }; return () => { w.provider.request = base; }; };
const E = wallet('E', '55'.repeat(32));
const pickE = async (l) => l.find((w) => w.name === 'E').uuid;
E.allowed = true;
const undoE = slowCode(E, 900);
const baseE = E.calls.length, tE = Date.now();
let signedAt = 0;
const askE = E.provider.request;
E.provider.request = (r) => { if (r.method === 'personal_sign' && !signedAt) signedAt = Date.now(); return askE(r); };
const idE = await makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' }).deriveIdentity({ pick: pickE });
ok('a code read that takes most of a second does not hold the first prompt back', signedAt - tE < 600 && idE.address === strip(E.addr));
ok('and it was still read (before the sign-in finished), once', E.calls.slice(baseE).filter((m) => m === 'eth_getCode').length === 1);
E.provider.request = askE; undoE();

const F = wallet('F', '66'.repeat(32));
const pickF = async (l) => l.find((w) => w.name === 'F').uuid;
F.allowed = true;
slowCode(F, 700, '0x6080604052');
const baseF = F.calls.length;
await assert.rejects(makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' }).deriveIdentity({ pick: pickF }), /Smart-contract wallets/);
ok('a contract wallet whose node was slow is still refused, after one signature and before a second is asked', F.calls.slice(baseF).filter((m) => m === 'personal_sign').length === 1);

// warm: the code read is started while the sheet is read, and the sign-in takes it from there
const G = wallet('G', '77'.repeat(32));
const pickG = async (l) => l.find((w) => w.name === 'G').uuid;
const warmed = makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' });
await warmed.warm();
ok('warming a wallet that is not in use asks nothing', G.calls.length === 0);
await warmed.connect({ pick: pickG });
const baseG = G.calls.length;
await warmed.warm();
await new Promise((d) => setTimeout(d, 20));
ok('warming reads the accounts (which cannot prompt) and starts the code read, nothing that could prompt', G.calls.slice(baseG).join() === 'eth_accounts,eth_getCode');
const baseG2 = G.calls.length;
await warmed.warm();
ok('warming again reads the code no more', G.calls.slice(baseG2).join() === 'eth_accounts');
const stepsG = [];
await warmed.deriveIdentity({ pick: pickG, onStep: (s) => stepsG.push(s) });
ok('the sign-in after it does not read the code again, and signs twice as the first sign-in does', G.calls.slice(baseG2).filter((m) => m === 'eth_getCode').length === 0 && G.calls.filter((m) => m === 'personal_sign').length === 2 && stepsG.join() === 'account,sign,confirm');

const throwing = wallet('D', '44'.repeat(32));
throwing.provider.request = async () => { throw new Error('wallet is not ready'); };
await assert.rejects(makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' }).deriveIdentity({ pick: async (l) => l.find((w) => w.name === 'D').uuid, onStep: () => { throw new Error('a listener must not break it'); } }), /wallet is not ready/);
ok('a wallet that errs gives its own error, even with a step listener that throws', true);

console.log(`\n${pass} passed, 0 failed`);
