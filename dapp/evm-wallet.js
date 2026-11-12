import { identityMessage } from './identity-message.js';
import { guardProvider } from './wallet-prompts.js';

export { declinedWords, stillWaiting } from './wallet-prompts.js';

const ETH_SIGNED_PREFIX = '\x19Ethereum Signed Message:\n';

const REMEMBERED = 'tacit-trade-wallet';
const BARE = 'Browser wallet';
const idOf = (info) => info?.rdns || info?.name || BARE;

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export function makeEvmWallet({ secp, sha256, keccak256, bytesToHex, hexToBytes, prfBytesToScalar, netName = 'mainnet' } = {}) {
  const enc = (s) => new TextEncoder().encode(s);
  const concat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

  const providers = [];
  let selected = null;
  let active = null;
  const heard = new WeakSet();
  if (typeof window !== 'undefined') {
    window.addEventListener('eip6963:announceProvider', (e) => {
      const d = e.detail; if (!d || !d.info || !d.provider) return;
      if (!providers.find((p) => p.info.uuid === d.info.uuid || p.provider === d.provider)) providers.push(d);
    });
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch { }
  }
  const injected = () => (typeof window !== 'undefined' ? window.ethereum : null);
  const currentProvider = () => guardProvider(selected || injected());
  const available = () => !!currentProvider() || providers.length > 0;
  const hasBrowserWallet = () => !!injected() || providers.some((p) => !p.provider.isWalletConnect);
  const ordered = () => [...providers].sort((a, b) => !!a.provider.isWalletConnect - !!b.provider.isWalletConnect);
  function listProviders() { return ordered().map((p) => ({ uuid: p.info.uuid, name: p.info.name, icon: p.info.icon, rdns: p.info.rdns })); }
  function selectProvider(uuid) { const p = providers.find((x) => x.info.uuid === uuid); if (p) selected = p.provider; return !!p; }
  function deselectProvider() { selected = null; }
  function providerLabel() { const a = providers.find((p) => p.provider === currentProvider()); return a?.info?.name || 'Ethereum wallet'; }

  function derivationMsg() { return identityMessage({ netName }); }
  function eip191Hash(msg) { const m = enc(msg); return keccak256(concat(enc(`${ETH_SIGNED_PREFIX}${m.length}`), m)); }
  function recoverAddr(msg, sigHex) {
    const clean = String(sigHex).toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{130}$/.test(clean)) throw new Error('eth signature must be 65 bytes');
    const r = clean.slice(0, 64), s = clean.slice(64, 128), vByte = parseInt(clean.slice(128, 130), 16);
    let rec; if (vByte === 27 || vByte === 28) rec = vByte - 27; else if (vByte === 0 || vByte === 1) rec = vByte; else throw new Error(`unsupported v: ${vByte}`);
    const sig = secp.Signature.fromCompact(r + s).addRecoveryBit(rec);
    const pub = sig.recoverPublicKey(eip191Hash(msg)).toRawBytes(false);
    if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('recovered pubkey malformed');
    return bytesToHex(keccak256(pub.slice(1)).slice(12));
  }
  function isContractCode(code) {
    if (typeof code !== 'string' || !/^0x[0-9a-f]*$/i.test(code)) return false;
    if (/^0xef0100[0-9a-f]{40}$/i.test(code)) return false;
    return code.length > 2 && !/^0x0+$/i.test(code);
  }

  const capped = (p, ms, fallback) => new Promise((done) => {
    const t = setTimeout(() => done(fallback), ms);
    Promise.resolve(p).then(done, () => done(fallback)).finally(() => clearTimeout(t));
  });

  async function reach({ pick, silent = false } = {}) {
    if (typeof window !== 'undefined') { try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch { } }
    if (!selected && !providers.length) await new Promise((r) => setTimeout(r, 120));
    let provider = selected, chosen = null;
    if (!provider) {
      if (providers.length >= 2 && typeof pick === 'function') {
        const uuid = await pick(listProviders());
        if (!uuid) throw Object.assign(new Error('Wallet choice cancelled'), { code: 4001 });
        chosen = providers.find((x) => x.info.uuid === uuid)?.provider;
        if (!chosen) throw new Error('selected wallet vanished — reload the page and reconnect');
      }
      else if (providers.length >= 1) chosen = ordered()[0].provider;
      provider = chosen || injected();
    }
    if (!provider || typeof provider.request !== 'function') throw new Error('no Ethereum wallet detected — install MetaMask, Rabby, Rainbow, or Coinbase Wallet');
    guardProvider(provider);
    let accounts = silent ? await capped(provider.request({ method: 'eth_accounts' }), 1500, []) : [];
    if (!Array.isArray(accounts) || !accounts.length) accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!Array.isArray(accounts) || !accounts.length) throw new Error('no accounts returned');
    const addr = String(accounts[0]).toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{40}$/.test(addr)) throw new Error('wallet returned malformed address');
    return { provider, address: addr, chosen };
  }
  const remember = (provider) => {
    const info = providers.find((p) => p.provider === provider)?.info;
    try { localStorage.setItem(REMEMBERED, idOf(info)); } catch { }
  };
  function forget() {
    selected = null; active = null;
    try { localStorage.removeItem(REMEMBERED); } catch { }
  }
  const revoke = (p) => Promise.race([
    Promise.resolve().then(() => p.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })).catch(() => {}),
    new Promise((done) => setTimeout(done, 1500)),
  ]);
  async function disconnect() {
    const was = active || selected;
    forget();
    if (!was) return;
    try { window.dispatchEvent(new CustomEvent('tacit:evm-accounts', { detail: { accounts: [], provider: was } })); } catch { }
    try { await (was.isWalletConnect ? was.endSession?.() : revoke(was)); } catch { }
  }
  const elsewhere = new Set();
  const onElsewhere = (fn) => { elsewhere.add(fn); return () => elsewhere.delete(fn); };
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.storageArea !== localStorage || (e.key !== REMEMBERED && e.key !== null)) return;
      if (e.newValue) { if (!active) for (const fn of elsewhere) { try { fn(); } catch { } } return; }
      const was = active;
      if (!was) return;
      selected = null; active = null;
      try { window.dispatchEvent(new CustomEvent('tacit:evm-accounts', { detail: { accounts: [], provider: was } })); } catch { }
      if (was.isWalletConnect) Promise.resolve(was.endSession?.()).catch(() => {});
    });
  }
  async function restore() {
    let id = null;
    try { id = localStorage.getItem(REMEMBERED); } catch { }
    if (!id || typeof window === 'undefined') return null;
    const find = () => ordered().find((p) => idOf(p.info) === id)?.provider || (id === BARE ? injected() : null);
    let provider = find();
    for (let i = 0; !provider && i < 6; i++) {
      try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch { }
      await new Promise((r) => setTimeout(r, 100));
      provider = find();
    }
    if (typeof provider?.request !== 'function') return null;
    guardProvider(provider);
    let accounts;
    try { accounts = await provider.request({ method: 'eth_accounts' }); } catch { return null; }
    const address = String(accounts?.[0] || '').toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{40}$/.test(address) || active) return null;
    use({ provider, chosen: provider });
    return { provider, address };
  }
  function use({ provider, chosen }) {
    if (chosen) selected = chosen;
    active = provider;
    remember(provider);
    if (heard.has(provider)) return;
    heard.add(provider);
    try {
      provider.on?.('accountsChanged', (accs) => {
        if (provider !== active) return;
        try { window.dispatchEvent(new CustomEvent('tacit:evm-accounts', { detail: { accounts: accs || [], provider } })); } catch { }
      });
    } catch { }
  }

  async function connect({ pick } = {}) {
    const c = await reach({ pick });
    use(c);
    return { provider: c.provider, address: c.address };
  }

  async function changeAccount({ pick } = {}) {
    const provider = active || selected || injected();
    if (!provider || typeof provider.request !== 'function') throw new Error('no Ethereum wallet connected');
    guardProvider(provider);
    if (provider.isWalletConnect) { await disconnect(); return connect({ pick }); }
    try { await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }); }
    catch (e) {
      if (e?.code === -32601 || e?.code === 4200 || /not (supported|implemented|found)|unsupported|does not (exist|support)|unknown method|invalid method/i.test(e?.message || '')) throw new Error('Choose another account in your wallet. This page follows it.');
      throw e;
    }
    const address = String((await provider.request({ method: 'eth_accounts' }))?.[0] || '').toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{40}$/.test(address)) throw new Error('no accounts returned');
    use({ provider, chosen: provider });
    return { provider, address };
  }

  const NO_ANSWER = Symbol('no answer'), STILL_READING = Symbol('still reading');
  const CODE_WAIT_MS = 250;
  const CONTRACT_WALLET = 'Smart-contract wallets produce non-deterministic signatures and cannot derive a stable tacit identity — use a passkey, seed, or an EOA wallet.';
  const codes = new Map();
  function codeOf(provider, address) {
    let read = codes.get(address);
    if (!read) {
      read = capped(provider.request({ method: 'eth_getCode', params: ['0x' + address, 'latest'] }), 1500, NO_ANSWER).then((code) => { if (code === NO_ANSWER) codes.delete(address); return code; });
      codes.set(address, read);
    }
    return read;
  }
  async function warm() {
    const provider = active || selected;
    if (!provider || typeof provider.request !== 'function') return;
    try {
      const accounts = await capped(provider.request({ method: 'eth_accounts' }), 1500, []);
      const address = String(accounts?.[0] || '').toLowerCase().replace(/^0x/, '');
      if (/^[0-9a-f]{40}$/.test(address) && !readAnchor(address)) codeOf(provider, address);
    } catch { }
  }

  const ANCHOR_KEY = 'tacit-eth-identity-anchor:';
  function readAnchor(address) {
    try { return localStorage.getItem(ANCHOR_KEY + String(address).toLowerCase()) || null; } catch { return null; }
  }
  function writeAnchor(address, pubHex) {
    try { localStorage.setItem(ANCHOR_KEY + String(address).toLowerCase(), pubHex); } catch { }
  }

  async function deriveIdentity({ pick, expect, onStep } = {}) {
    const step = (s) => { try { onStep?.(s); } catch { } };
    step('account');
    const c = await reach({ pick, silent: true }), { provider, address } = c;
    const want = expect && String(expect).toLowerCase().replace(/^0x/, '');
    if (want && address !== want) throw new Error(`Switch your wallet to 0x${want.slice(0, 4)}…${want.slice(-4)}, the account this Tacit wallet was opened with.`);
    const anchored = !!readAnchor(address);
    const reading = anchored ? null : codeOf(provider, address);
    const early = reading ? await capped(reading, CODE_WAIT_MS, STILL_READING) : '0x';
    if (isContractCode(early)) throw new Error(CONTRACT_WALLET);
    const msg = derivationMsg();
    step('sign');
    const sig = await provider.request({ method: 'personal_sign', params: ['0x' + bytesToHex(enc(msg)), '0x' + address] });
    if (early === STILL_READING && isContractCode(await reading)) throw new Error(CONTRACT_WALLET);
    if (typeof sig !== 'string' || !sig.startsWith('0x')) throw new Error('wallet returned invalid signature');
    const sigBytes = hexToBytes(sig.slice(2));
    if (sigBytes.length !== 65) throw new Error('signature must be 65 bytes');
    const recovered = recoverAddr(msg, sig);
    if (recovered !== address) throw new Error(`signature is from ${recovered.slice(0, 8)}…, not ${address.slice(0, 8)}… — switch your active account and retry`);
    if (sigBytes[64] === 0 || sigBytes[64] === 1) sigBytes[64] += 27;

    const sHigh = (() => {
      let s = 0n;
      for (let i = 32; i < 64; i++) s = (s << 8n) | BigInt(sigBytes[i]);
      return s > SECP_N / 2n;
    })();
    if (sHigh) {
      sigBytes.fill(0);
      throw new Error('wallet returned a non-canonical (high-s) signature — refusing to derive an identity '
        + 'from it. Every compliant signer produces the canonical form, so this usually means the signature '
        + 'was altered in transit. Reconnect with a wallet you trust and retry; nothing was derived or spent.');
    }
    if (!anchored) {
      step('confirm');
      const again = await provider.request({ method: 'personal_sign', params: ['0x' + bytesToHex(enc(msg)), '0x' + address] });
      const b = typeof again === 'string' && again.startsWith('0x') ? hexToBytes(again.slice(2)) : null;
      if (b && b.length === 65 && (b[64] === 0 || b[64] === 1)) b[64] += 27;
      const same = !!b && b.length === 65 && b.every((x, i) => x === sigBytes[i]);
      if (b) b.fill(0);
      if (!same) {
        sigBytes.fill(0);
        throw new Error('This wallet signed the Tacit message differently the second time, so it cannot hold a stable Tacit key: '
        + 'anything sent to it could not be opened again. Nothing was derived. Use a passkey or another wallet.');
      }
    }
    const priv = prfBytesToScalar(sha256(sigBytes)); sigBytes.fill(0);
    const privHex = priv instanceof Uint8Array ? bytesToHex(priv) : String(priv);
    const pubHex = bytesToHex(secp.getPublicKey(priv instanceof Uint8Array ? priv : hexToBytes(privHex), true));
    const prior = readAnchor(address);
    if (prior && prior !== pubHex) {
      throw new Error('this account previously derived a different Tacit identity — refusing to open a different, '
        + 'empty wallet. Your funds are safe on-chain under the original key; reconnect the original wallet/account, '
        + 'or clear this account\u2019s anchor if you are certain you want the new derivation.');
    }
    if (!prior) writeAnchor(address, pubHex);
    use(c);
    return { priv: privHex, pubHex, address, provider, label: providerLabel() };
  }

  async function fundTx({ from, to, data, valueWei = 0n }) {
    const provider = currentProvider();
    if (!provider) throw new Error('no Ethereum wallet connected');
    const params = { from: '0x' + String(from).replace(/^0x/, ''), to, data };
    if (valueWei && BigInt(valueWei) > 0n) params.value = '0x' + BigInt(valueWei).toString(16);
    return provider.request({ method: 'eth_sendTransaction', params: [params] });
  }

  async function chainId() { const p = currentProvider(); if (!p) return null; try { return Number(await p.request({ method: 'eth_chainId' })); } catch { return null; } }

  async function signErc2612({ token, name, version = '1', owner, spender, value, nonce, deadline, provider: via = null }) {
    const provider = via || currentProvider();
    if (!provider) throw new Error('no Ethereum wallet connected');
    const cid = via ? BigInt(await via.request({ method: 'eth_chainId' })) : await chainId();
    if (cid == null) throw new Error('could not read the wallet\'s network');
    const payload = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
        ],
        Permit: [
          { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      domain: { name, version, chainId: Number(cid), verifyingContract: token },
      message: {
        owner, spender, value: String(value), nonce: String(nonce), deadline: String(deadline),
      },
    };
    const sig = await provider.request({ method: 'eth_signTypedData_v4', params: [owner, JSON.stringify(payload)] });
    const h = String(sig).replace(/^0x/, '');
    if (h.length !== 130) throw new Error('permit signature malformed');
    let v = parseInt(h.slice(128, 130), 16);
    if (v < 27) v += 27;
    return { v, r: '0x' + h.slice(0, 64), s: '0x' + h.slice(64, 128) };
  }

  const provider = () => currentProvider() || null;
  return { provider, available, hasBrowserWallet, listProviders, selectProvider, deselectProvider, providerLabel, connect, changeAccount, restore, onElsewhere, forget, disconnect, deriveIdentity, warm, signErc2612, fundTx, chainId, derivationMsg };
}
