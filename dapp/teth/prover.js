// Proving a deposit's note with the holder's own PROVE credit on Succinct's prover network, from the tETH page. The prover account is the holder's
// Tacit account (the Ethereum account the pool module derives from the Tacit key): its credit on the network pays for the proof, and it signs the
// request itself. The note's private details go to Succinct's own prover as a private input (self-prover.js), passing through Tacit's API without
// being kept, and the connected wallet then sends the settle. Tacit's relay neither proves nor sends it.
//
// Credit is put in from the connected wallet: PROVE goes to the Tacit account (only what it lacks), then the wallet sends the network's
// permitAndDeposit with a permit the Tacit account signs here, which moves that PROVE into the account's credit. Or ETH, swapped to PROVE for the
// Tacit account in one transaction (zQuoter's route, sent to zRouter), then the same deposit. Each transaction is tried with eth_call first.
//
// self-prover.js is loaded the first time it is needed. Nothing here keeps a key: each use derives the account from the page's `priv()`.
import { secp, keccak_256, sha256, hmac, concatBytes } from '/vendor/tacit-deps.min.js';
import { quoteEthToProve, ethForProve, ZROUTER } from '/relay/abi.js?cb=5078b247';
import { rpc, ethCall, strip, word, now } from '/trade/util.js?cb=aa7aaa7f';

// The permit is signed synchronously, which noble's secp256k1 does once it is given an HMAC (as tacit.js and the sats page give it).
if (!secp.etc.hmacSha256Sync) secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, concatBytes(...m));

let modP = null;
export function loadSelfProver() {
  return (modP ||= import('/self-prover.js?cb=b615e1f8').catch((e) => {
    modP = null;
    throw Object.assign(new Error('Could not load the prover. Try again in a moment.'), { code: 'unavailable', cause: e });
  }));
}

// Which keys prove with their own credit: a yes per key's public part, in this browser. Public data only, and only a preference.
const PREF = 'tacit-trade-own-prover-v1';
const prefs = () => { try { return JSON.parse(localStorage.getItem(PREF) || '{}') || {}; } catch { return {}; } };
export const ownPref = (pubHex) => !!(pubHex && prefs()[pubHex]);
export function setOwnPref(pubHex, on) {
  try { const m = prefs(); if (on) m[pubHex] = true; else delete m[pubHex]; localStorage.setItem(PREF, JSON.stringify(m)); } catch { /* a preference, not state */ }
  if (on) setDevicePref(pubHex, false);
}

// Which keys prove on this computer (tacit-prover on 127.0.0.1), kept the same way. It and the own-credit preference exclude each other.
const DEV = 'tacit-device-prover-v1';
const devs = () => { try { return JSON.parse(localStorage.getItem(DEV) || '{}') || {}; } catch { return {}; } };
export const devicePref = (pubHex) => !!(pubHex && devs()[pubHex]);
export function setDevicePref(pubHex, on) {
  try { const m = devs(); if (on) m[pubHex] = true; else delete m[pubHex]; localStorage.setItem(DEV, JSON.stringify(m)); } catch { /* a preference, not state */ }
  if (on) setOwnPref(pubHex, false);
}
let devP = null;
export function deviceProver() {
  return (devP ||= import('/device-prover.js?cb=92d426ad').then((m) => m.makeDeviceProver({ keccak256: keccak_256 })).catch((e) => {
    devP = null;
    throw Object.assign(new Error('Could not load the prover for this computer. Try again in a moment.'), { code: 'unavailable', cause: e });
  }));
}

const addr = (a) => strip(a).toLowerCase().padStart(64, '0');
const hexv = (v) => '0x' + BigInt(v).toString(16);

// The prover for the key open on the page: self-prover.js's, with the Tacit account as the requester and the module's funding helpers as `sp`.
// `ux` is the pool module (its account() derives the Tacit account); `keyPriv()` the page's key.
export async function proverFor({ ux, keyPriv }) {
  const sp = await loadSelfProver();
  const address = ux.account(keyPriv()).address;
  const p = sp.makeSelfProver({ priv: () => ux.account(keyPriv()).priv, address, secp, keccak256: keccak_256 });
  return { ...p, address, sp, accountPriv: () => ux.account(keyPriv()).priv };
}

// The PROVE the Tacit account holds as a token (not yet credit): what a deposit can move into credit without the wallet sending more.
export const tokenBalance = (sp, who) => ethCall(sp.PROVE_TOKEN, sp.BALANCE_OF_SELECTOR + addr(who)).then((x) => BigInt(x && x !== '0x' ? x : 0));

// The account's credit, what a proof needs on hand, and its PROVE not yet in credit. Each is null when it could not be read.
export async function readCredit(prover) {
  const [credit, need, held] = await Promise.allSettled([prover.balance(), prover.needWei('wrap'), tokenBalance(prover.sp, prover.address)]);
  const v = (r) => (r.status === 'fulfilled' && r.value != null ? BigInt(r.value) : null);
  return { credit: v(credit), need: v(need), held: v(held) };
}
// About how many proofs `wei` of credit pays for: a request needs `need` on hand (readCredit's), and each proof spends about PROVE_PER_PROOF, so the
// first takes `need` and each after it about PROVE_PER_PROOF more. Without `need`, the first counts at PROVE_PER_PROOF too.
export function proofsFor(sp, wei, need = null) {
  if (wei == null) return null;
  const per = BigInt(Math.round((sp?.PROVE_PER_PROOF || 0.4) * 1e6)) * 10n ** 12n, first = need != null ? BigInt(need) : per, have = BigInt(wei);
  return have >= first ? 1 + Number((have - first) / per) : 0;
}

// A transaction from the wallet, tried first with eth_call from the same account: one that would revert is never put to the wallet. `say(step,
// hash)`: 'confirm', 'sent'. → the transaction's hash, once it has landed.
async function sendChecked({ wallet, from, tx, say }) {
  try { await rpc('eth_call', [{ from, to: tx.to, data: tx.data, ...(tx.value ? { value: hexv(tx.value) } : {}) }, 'latest']); }
  catch (e) { throw new Error(e?.revert ? 'It would not go through, so nothing was sent.' : 'It could not be checked, so nothing was sent. Try again in a moment.'); }
  say('confirm');
  const hash = await wallet.sendTx({ ...tx, from });
  say('sent', hash);
  const rc = await wallet.receipt(hash);
  if (rc.status !== '0x1') throw new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing was lost but its network fee.`);
  return hash;
}

// The network's permitAndDeposit for `amountWei` of the PROVE the Tacit account holds, sent by the wallet: the permit (spender = the network's
// contract) is signed here by the Tacit account, over PROVE's own nonce and domain read from the chain.
async function depositHeld({ prover, wallet, from, amountWei, say }) {
  const sp = prover.sp, acct = prover.address;
  const [nonce, domainSeparator] = await Promise.all([ethCall(sp.PROVE_TOKEN, sp.NONCES_SELECTOR + addr(acct)), ethCall(sp.PROVE_TOKEN, sp.DOMAIN_SEPARATOR_SELECTOR)]);
  const deadline = BigInt(now() + 3600);
  const { v, r, s } = sp.signPermit({ secp, keccak256: keccak_256, privHex: prover.accountPriv(), owner: acct, amountWei, nonce: BigInt(nonce), deadline, domainSeparator });
  say('deposit');
  return sendChecked({ wallet, from, tx: { to: sp.VAPP, data: sp.permitAndDepositData({ from: acct, amountWei, deadline, v, r, s }) }, say });
}

// `amountWei` of PROVE from the wallet into the account's credit: the wallet sends the Tacit account only what it lacks (none when it already holds
// enough), then the deposit. `say(step, detail)`: 'transfer' (the PROVE sent), 'deposit', 'confirm', 'sent' (hash). → { hashes, sent }
export async function fundFromWallet({ prover, wallet, from, amountWei, say = () => {} }) {
  const sp = prover.sp;
  if (amountWei < sp.MIN_DEPOSIT_WEI) throw new Error(`The network takes at least ${Number(sp.MIN_DEPOSIT_WEI) / 1e18} PROVE at a time.`);
  const held = await tokenBalance(sp, prover.address);
  const hashes = [], lack = held >= amountWei ? 0n : amountWei - held;
  if (lack > 0n) {
    say('transfer', lack);
    hashes.push(await sendChecked({ wallet, from, tx: { to: sp.PROVE_TOKEN, data: '0xa9059cbb' + addr(prover.address) + word(lack) }, say }));
  }
  hashes.push(await depositHeld({ prover, wallet, from, amountWei, say }));
  return { hashes, sent: lack };
}

// zQuoter's route from `wei` of ETH to PROVE, built for the Tacit account as the recipient, with a 1% guard on what it buys. Checked before it is
// shown: it spends exactly what was asked, pays the Tacit account, and guards a least amount out (relay/abi.js holds the checks every page shares).
const readCall = ({ to, data, gas }) => rpc('eth_call', [{ to, data, gas }, 'latest']);
const NO_ROUTE = 'Could not find a route from ETH to PROVE. Try again in a moment, or add PROVE from your wallet.';
export const quoteEth = ({ prover, wei }) => quoteEthToProve({ call: readCall, to: prover.address, wei, noRoute: NO_ROUTE });
// The same quote for the ETH that buys at least `want` PROVE, with a little over so the least the swap may buy still covers it.
export const quoteEthFor = ({ prover, want }) => ethForProve({ call: readCall, to: prover.address, want, noRoute: NO_ROUTE });
// ETH swapped to PROVE for the Tacit account, then all the PROVE it holds deposited into its credit. → { hashes, deposited }
export async function fundWithEth({ prover, wallet, from, quote, say = () => {} }) {
  say('swap');
  const hashes = [await sendChecked({ wallet, from, tx: { to: ZROUTER, data: quote.callData, value: quote.msgValue }, say })];
  const held = await tokenBalance(prover.sp, prover.address);
  if (held < prover.sp.MIN_DEPOSIT_WEI) throw new Error('The swap landed, but its PROVE has not reached your Tacit account yet. Add PROVE again in a moment: PROVE already in the account is used first.');
  hashes.push(await depositHeld({ prover, wallet, from, amountWei: held, say }));
  return { hashes, deposited: held };
}
