// The browser wallet for the TAC trade page: found through EIP-6963 (or window.ethereum), asked for an account on Ethereum mainnet,
// and used for the three things the ticket needs: sending a transaction, signing TAC's EIP-2612 permit, and waiting for a receipt.
// Nothing is kept: no key is ever seen here, and the page reads balances through its own RPCs.

import { guardProvider, declinedWords } from '../wallet-prompts.js';

export const MAINNET = '0x1';
// `quick`: the wallet declined before anyone could have answered (see wallet-prompts.js), which the person is told in so many words.
export class UserStopped extends Error { constructor(quick = false) { super(declinedWords({ quick }, 'Nothing was sent.')); this.userStopped = true; this.quick = quick; } }
// A chain id as 0x hex whatever way the wallet gave it (a number, a decimal string, hex with leading zeros).
export const hexChain = (c) => { try { return `0x${BigInt(c).toString(16)}`; } catch { return null; } };
// What a wallet's refusal means to the person. A wallet that says no is the person, not a fault.
function plain(e) {
  const m = e?.message || '';
  if (e?.code === 4001 || /user (rejected|denied)|rejected the request|request rejected|denied (transaction|message)/i.test(m)) return new UserStopped(!!e?.quick);
  if (e?.code === -32002 || /already (pending|processing)|request of type .* pending/i.test(m)) return new Error('Your wallet already has a request open. Answer it there, then try again.');
  if (e?.code === 4100 && !/WalletConnect/.test(m)) return new Error('Your wallet is locked or has not allowed this site. Unlock it and connect again.');
  if (/chain.*not approved|does not support 'wallet_switchEthereumChain'/i.test(m)) return new Error('Your wallet app did not allow Ethereum. Disconnect, then connect again.');
  return e;
}
// A wallet that does not have a call (-32601, or its own words for it).
const lacks = (e) => e?.code === -32601 || e?.code === 4200 || /not (supported|implemented|found)|unsupported|does not (exist|support)|unknown method|invalid method/i.test(e?.message || '');
// Hands this site's permission back to the wallet, so the next Connect asks which account (EIP-2255). A wallet without the call keeps the permission, which is
// then the wallet's to revoke; it is not waited for longer than a moment, and never an error here.
const lcs = (a) => String(a || '').toLowerCase();
const revokeSite = (provider) => Promise.race([
  Promise.resolve().then(() => provider?.request?.({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })).catch(() => {}),
  new Promise((done) => setTimeout(done, 1500)),
]);

// `busy()`: something here is waiting on the wallet, so a wallet let go of in another tab is not let go of here until it ends.
export function makeWallet({ rpc, leave = null, busy = () => false }) {
  const found = new Map();
  const W = { prov: null, name: '', uuid: null, account: null, chain: null, listeners: new Set() };
  const emit = () => { for (const f of W.listeners) f(); };
  addEventListener('eip6963:announceProvider', (e) => { if (e.detail?.provider?.request) found.set(e.detail.info?.uuid || String(found.size), e.detail); });
  dispatchEvent(new Event('eip6963:requestProvider'));
  // The wallets the page can use: the one used last here first, a phone's WalletConnect after the browser's own.
  const available = () => {
    const l = [...found.values()];
    if (!l.length && globalThis.ethereum?.request) l.push({ info: { name: 'Browser wallet' }, provider: globalThis.ethereum });
    const rank = (w) => (idOf(w) === last ? 0 : w.provider?.isWalletConnect ? 2 : 1);
    return l.sort((a, b) => rank(a) - rank(b));
  };
  const wrap = async (p) => { try { return await p; } catch (e) { throw plain(e); } };
  const req = (method, params) => wrap(W.prov.request({ method, params }));

  // A wallet's listeners are taken off the provider it is leaving, so a wallet left behind cannot change the account of the one in use.
  let off = null;
  // The wallet last connected here, by its EIP-6963 id (or name), so a reload can find it again. Only which wallet: never an account or a key.
  const KEY = 'tacit-trade-wallet';
  const idOf = (w) => w.info?.rdns || w.info?.name || 'Browser wallet';
  let last = null;
  try { last = localStorage.getItem(KEY); } catch { /* storage is a convenience */ }
  const remember = (w) => { last = w ? idOf(w) : null; try { if (w) localStorage.setItem(KEY, last); else localStorage.removeItem(KEY); } catch { /* storage is a convenience */ } };
  // `silent`: asks only for the accounts the wallet already allows this site (eth_accounts opens no prompt); none → not connected. A wallet that
  // refuses, or fails to answer, changes nothing here: the wallet in use stays in use.
  async function connect(w, { silent = false } = {}) {
    const prov = guardProvider(w.provider), ask = (method, params) => wrap(prov.request({ method, params }));
    const accounts = await ask(silent ? 'eth_accounts' : 'eth_requestAccounts');
    if (silent && !accounts?.[0]) return false;
    const chain = hexChain(await ask('eth_chainId'));
    off?.(); off = null;
    W.prov = prov; W.name = w.info?.name || 'Wallet'; W.uuid = w.info?.uuid || null;     // the EIP-6963 id: another module can find this same wallet among the announced ones
    W.account = accounts?.[0] ? String(accounts[0]) : null; W.chain = chain;
    const onAccounts = (a) => { if (prov === W.prov) { W.account = a?.[0] ? String(a[0]) : null; emit(); } }, onChain = (c) => { if (prov === W.prov) { W.chain = hexChain(c); emit(); } };
    prov.on?.('accountsChanged', onAccounts); prov.on?.('chainChanged', onChain);
    off = () => { prov.removeListener?.('accountsChanged', onAccounts); prov.removeListener?.('chainChanged', onChain); };
    remember(w);
    emit();
    return true;
  }
  // Another account of the wallet in use: the wallet's own chooser opens (EIP-2255) and the page follows the account it answers. A wallet without the
  // call is asked for nothing; the person is told to choose in the wallet, which the page follows as it follows any account change.
  async function chooseAccount() {
    if (!W.prov) throw new Error('Connect a wallet first.');
    try { await req('wallet_requestPermissions', [{ eth_accounts: {} }]); }
    catch (e) { throw lacks(e) ? new Error('Choose another account in your wallet. This page follows it.') : e; }
    const a = (await req('eth_accounts'))?.[0], next = a ? String(a) : null;
    if (next !== W.account) { W.account = next; emit(); }
  }
  // On load: the wallet connected last time, if it is here and still allows this site. Wallets announce themselves a moment after
  // the page asks, so this waits briefly for them.
  async function restore() {
    let id = null;
    try { id = localStorage.getItem(KEY); } catch { /* storage is a convenience */ }
    if (!id) return false;
    for (let i = 0; i < 6 && !available().some((w) => idOf(w) === id); i++) { dispatchEvent(new Event('eip6963:requestProvider')); await new Promise((r) => setTimeout(r, 100)); }
    const w = available().find((x) => idOf(x) === id);
    if (!w) return false;
    try { return await connect(w, { silent: true }); } catch { return false; }
  }
  // Another tab of the site connects or disconnects a wallet and this one follows: a wallet connected there is asked for the accounts it already allows,
  // one let go of there is let go of here (a WalletConnect session is cleared from this tab's copy; the permission was handed back there).
  addEventListener('storage', (e) => {
    if (e.storageArea !== localStorage || (e.key !== KEY && e.key !== null)) return;
    if (e.newValue) { if (!W.prov) restore().catch(() => {}); return; }
    const prov = W.prov;
    if (!prov || busy()) return;
    off?.(); off = null; last = null;
    W.prov = null; W.name = ''; W.uuid = null; W.account = null; W.chain = null;
    emit();
    if (prov.isWalletConnect) Promise.resolve(leave?.(prov)).catch(() => {});
  });
  // Forgets the wallet in this page, here and on every other page of the site, and hands the site's permission back to the wallet, so the next Connect
  // asks which account. `leave(provider)` ends a session that lives elsewhere (a WalletConnect pairing).
  async function disconnect() {
    off?.(); off = null;
    const prov = W.prov;
    W.prov = null; W.name = ''; W.uuid = null; W.account = null; W.chain = null;
    remember(null);
    emit();
    try { await (prov?.isWalletConnect ? leave?.(prov) : revokeSite(prov)); } catch { /* the session is gone either way */ }
  }
  // What was reviewed was for one account: a wallet whose account has changed since is not asked to send or sign it.
  const same = (from) => { if (from && String(from).toLowerCase() !== String(W.account || '').toLowerCase()) throw new Error('The wallet’s account changed. Nothing was sent; review it again.'); };
  async function ensureMainnet() {
    W.chain = hexChain(await req('eth_chainId'));
    if (W.chain === MAINNET) return;
    await req('wallet_switchEthereumChain', [{ chainId: MAINNET }]);
    W.chain = hexChain(await req('eth_chainId'));
    if (W.chain !== MAINNET) throw new Error('Switch your wallet to Ethereum mainnet.');
  }
  // Another chain than Ethereum (a job's step on Base, say): switched to, or added first when the wallet has never seen it, from
  // `chain` = { id, name, rpc: [url], explorer, icon? } (the icon is a picture of ours for a wallet that has none for the chain).
  async function ensureChain(chain) {
    const want = hexChain(chain.id);
    W.chain = hexChain(await req('eth_chainId'));
    if (W.chain === want) return;
    try { await req('wallet_switchEthereumChain', [{ chainId: want }]); }
    catch (e) {
      if (!(e?.code === 4902 || /unrecogni[sz]ed|not been added|unknown chain|try adding/i.test(e?.message || ''))) throw e;
      await req('wallet_addEthereumChain', [{ chainId: want, chainName: chain.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: chain.rpc, blockExplorerUrls: [chain.explorer], ...(chain.icon ? { iconUrls: [chain.icon] } : {}) }]);
      // Some wallets switch to a chain they have just added; the rest are asked to.
      if (hexChain(await req('eth_chainId')) !== want) await req('wallet_switchEthereumChain', [{ chainId: want }]);
    }
    W.chain = hexChain(await req('eth_chainId'));
    if (W.chain !== want) throw new Error(`Switch your wallet to ${chain.name}, then try again.`);
  }
  // `chain` (see ensureChain) sends it on that chain; without it, on Ethereum.
  async function sendTx({ to, data, value = 0n, from = null, chain = null, gas = null }) {
    same(from);
    if (chain && hexChain(chain.id) !== MAINNET) await ensureChain(chain); else await ensureMainnet();
    same(from);
    // `gas` sets the limit for a call whose cost a wallet's estimate can fall short of; without it the wallet estimates
    return req('eth_sendTransaction', [{ from: from || W.account, to, data, ...(value ? { value: '0x' + BigInt(value).toString(16) } : {}), ...(gas ? { gas: '0x' + BigInt(gas).toString(16) } : {}) }]);
  }
  // Atomic batches (EIP-5792): calls the wallet sends together in one confirmation (an approval and the call that uses it), where it takes them.
  // A wallet that turns out not to take batches throws { noBatch }, so the caller can send them one by one; one that took a batch and does not
  // say how it went throws { said }. → the hash of the transaction that carried the calls, once it is in a block.
  const BATCH_NO = [4200, -32601, -32602, 5700, 5710, 5740, 5750, 5760], noBatch = new Set();
  async function canBatch() {
    if (!W.prov || !W.account || noBatch.has(lcs(W.account))) return false;
    const caps = await Promise.race([W.prov.request({ method: 'wallet_getCapabilities', params: [W.account] }), new Promise((r) => setTimeout(() => r(null), 4000))]).catch(() => null);
    if (!caps || typeof caps !== 'object') return false;
    const at = (id) => Object.keys(caps).find((k) => { try { return BigInt(k) === BigInt(id); } catch { return false; } });
    return ['supported', 'ready'].includes(caps[at(1) ?? at(0)]?.atomic?.status);
  }
  async function sendCalls(calls, { from = null, sent = () => {} } = {}) {
    same(from);
    await ensureMainnet();
    same(from);
    let id;
    try {
      const r = await W.prov.request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: MAINNET, from: from || W.account, atomicRequired: true,
        calls: calls.map(({ to, data, value }) => ({ to, data, value: '0x' + BigInt(value || 0).toString(16) })) }] });
      id = typeof r === 'string' ? r : r?.id;
    } catch (e) {
      if (!BATCH_NO.includes(e?.code)) throw plain(e);
      noBatch.add(lcs(W.account));
      throw Object.assign(new Error('Your wallet does not send these together.'), { noBatch: true });
    }
    const unknown = (m) => Object.assign(new Error(m), { said: true });
    if (!id) throw unknown('Your wallet did not say what it sent. Check its activity before trying again.');
    sent();
    for (let i = 0, quiet = 0; i < 600; i++) {
      const st = await Promise.race([W.prov.request({ method: 'wallet_getCallsStatus', params: [id] }), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 9000))])
        .then((x) => { quiet = 0; return x; }, () => { if (++quiet > 9) throw unknown('Your wallet sent it but cannot say how it went. Check its activity before trying again.'); return null; });
      const rs = st?.receipts || [], q = String(st?.status ?? '');
      if (rs.some((r) => r?.status === '0x0') || /^(400|500|600)$/.test(q) || /fail|revert|reject/i.test(q)) throw new Error('The wallet’s transaction failed. Nothing was lost but its network fee.');
      const last = rs[rs.length - 1], h = last && (q === '200' || /CONFIRMED|SUCCESS/i.test(q) || rs.length >= calls.length) ? last.transactionHash || last.hash : null;
      if (h) return h;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw unknown('Your wallet has not confirmed it yet. Check its activity before trying again.');
  }
  // TAC's permit to `spender`: the typed data the wallet shows, and the split signature.
  async function signPermit({ token, name, spender, value, deadline, nonce, owner = null }) {
    same(owner);
    await ensureMainnet();
    same(owner);
    const typed = {
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Permit', domain: { name, version: '1', chainId: 1, verifyingContract: token },
      message: { owner: owner || W.account, spender, value: String(value), nonce: String(nonce), deadline: String(deadline) },
    };
    const sig = await req('eth_signTypedData_v4', [owner || W.account, JSON.stringify(typed)]);
    const h = String(sig).replace(/^0x/, '');
    if (h.length !== 130) throw new Error('The wallet returned a signature of the wrong length.');
    let v = parseInt(h.slice(128, 130), 16); if (v < 27) v += 27;
    return { v, r: '0x' + h.slice(0, 64), s: '0x' + h.slice(64, 128) };
  }
  // A plain-text message signed by the account (EIP-191 personal_sign): no transaction, no network switch, nothing sent. A smart-contract wallet answers in
  // a form that is not one 65-byte signature, which a server cannot check against the address.
  async function signMessage(message, from = null) {
    same(from);
    const hex = [...new TextEncoder().encode(message)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const sig = String(await req('personal_sign', ['0x' + hex, from || W.account]));
    same(from);
    if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error('This wallet signs in a form that cannot be checked here (a smart-contract wallet). Use an account with its own key.');
    return sig;
  }
  // Offers the token to the wallet (EIP-747) so that a purchase shows up in it. A wallet without the call, or a no, is not an error here.
  async function watchAsset(options) {
    if (!W.prov) return false;
    try { return !!(await req('wallet_watchAsset', { type: 'ERC20', options })); } catch { return false; }
  }
  // Through the page's own RPCs, so a wallet that is slow to report a receipt does not stall the page.
  // `every` is the time between reads: by default each second for the first minute and a half, so a block is seen within a second of its coming, then every three seconds.
  async function receipt(hash, { timeoutMs = 5 * 60e3, every = null, read = rpc, where = 'Etherscan' } = {}) {
    const t0 = Date.now();
    for (;;) {
      const r = await read('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (r) return r;
      if (Date.now() - t0 > timeoutMs) throw new Error(`Sent, not confirmed yet. Check it on ${where} before sending anything again.`);
      await new Promise((res) => setTimeout(res, every ?? (Date.now() - t0 < 90e3 ? 1000 : 3000)));
    }
  }
  return { state: W, available, connect, restore, disconnect, chooseAccount, ensureMainnet, ensureChain, sendTx, canBatch, sendCalls, signPermit, signMessage, receipt, watchAsset, onChange: (f) => W.listeners.add(f) };
}
