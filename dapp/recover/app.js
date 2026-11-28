import { HISTORICAL_MESSAGES, inspectStorage, decryptPrivkey, signatureResult, addressActivity } from '/recover/core.js?cb=9e17ec3c';
import { createRecoveryUI } from '/recover/ui.js?cb=0018dc94';

const decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function signAttempt({ provider, message, protocol }) {
  const text = HISTORICAL_MESSAGES.find((x) => x.id === message).text('mainnet');
  let sig;
  if (provider === 'unisat') {
    if (!window.unisat) throw new Error('UniSat is not available in this browser.');
    const accounts = await window.unisat.requestAccounts(); if (!accounts?.[0]) throw new Error('No UniSat account selected.');
    sig = decode(await window.unisat.signMessage(text, protocol === 'ecdsa' ? 'ecdsa' : 'bip322-simple'));
  } else {
    const S = (await import('/vendor/tacit-satsconnect.min.js')).satsConnect;
    const r = await S.request('getAccounts', { purposes: ['payment','ordinals'], message: 'Select the account used with Tacit.' });
    if (r?.status !== 'success') throw new Error('Xverse connection was cancelled.');
    const address = r.result?.find((x) => x.purpose === 'payment')?.address || r.result?.[0]?.address;
    const signed = await S.request('signMessage', { address, message: text, protocol: protocol === 'ecdsa' ? 'ECDSA' : 'BIP322' });
    if (signed?.status !== 'success') throw new Error('Xverse signing was cancelled.'); sig = decode(signed.result.signature);
  }
  const result = signatureResult(sig, 'mainnet'); sig.fill(0);
  // Keep the derived key when the explorer is down; the page offers a retry and still lets the key be revealed.
  try { result.activity = await addressActivity(result.address); } catch (x) { result.activity = null; result.activityError = x.message; }
  return result;
}
createRecoveryUI({ root: document.querySelector('#recover'), storage: localStorage, inspect: inspectStorage, decrypt: decryptPrivkey, activity: addressActivity, signAttempt });
