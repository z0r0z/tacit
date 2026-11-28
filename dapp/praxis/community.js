const API = 'https://tacit-praxis-ceremony.onrender.com/api/community';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function connectCommunityWallet() {
  if (!globalThis.ethereum?.request) throw new Error('Open this page in a browser with an Ethereum wallet');
  const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
  const address = String(accounts?.[0] || '');
  if (!ADDRESS.test(address)) throw new Error('The wallet did not provide an Ethereum address');
  return address;
}

async function post(path, token, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'X-Ceremony-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Community proof answered ${r.status}`);
  return j;
}

export async function proveCommunity(token, address) {
  const { message } = await post('/challenge', token);
  let signature;
  try { signature = await ethereum.request({ method: 'personal_sign', params: [message, address] }); }
  catch (e) {
    if (e?.code === 4001) throw new Error('Signature cancelled; your ordinary queue place is unchanged');
    signature = await ethereum.request({ method: 'personal_sign', params: [address, message] });
  }
  return post('/verify', token, { address, signature });
}

export const signalLabel = (s) => ({ tac: 'TAC holder', wei: '.wei name', zorgz: 'zOrgz' }[s] || s);
