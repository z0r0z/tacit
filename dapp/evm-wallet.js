// evm-wallet — external Ethereum wallet onboarding for the V1 dapp. Two roles from one connected EOA:
//   1. IDENTITY: personal_sign a fixed domain message → deterministic tacit1 priv (RFC-6979 ⇒ the same EOA
//      always derives the same identity, so recovery = reconnect the wallet anywhere → same holdings).
//   2. FUNDER: the same provider sends pool.wrap() txs (msg.value = ETH), whose note owner is the tacit1
//      identity baked into the wrap commit — so an external wallet can top up a tacit1 note it doesn't hold.
// Faithful port of tacit.js's ethWallet connect/derive (EIP-6963 discovery + EIP-191 recovery guard).
const ETH_SIGNED_PREFIX = '\x19Ethereum Signed Message:\n';

export function makeEvmWallet({ secp, sha256, keccak256, bytesToHex, hexToBytes, prfBytesToScalar, netName = 'mainnet' } = {}) {
  const enc = (s) => new TextEncoder().encode(s);
  const concat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

  // ── EIP-6963 multi-provider discovery (every 6963 wallet also injects window.ethereum as fallback) ──
  const providers = []; // [{ info:{uuid,name,icon,rdns}, provider }]
  let selected = null;
  if (typeof window !== 'undefined') {
    window.addEventListener('eip6963:announceProvider', (e) => {
      const d = e.detail; if (!d || !d.info || !d.provider) return;
      if (!providers.find((p) => p.info.uuid === d.info.uuid)) providers.push(d);
    });
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch { /* ignore */ }
  }
  const injected = () => (typeof window !== 'undefined' ? window.ethereum : null);
  const currentProvider = () => selected || injected();
  const available = () => !!currentProvider() || providers.length > 0;
  function listProviders() { return providers.map((p) => ({ uuid: p.info.uuid, name: p.info.name, icon: p.info.icon, rdns: p.info.rdns })); }
  function selectProvider(uuid) { const p = providers.find((x) => x.info.uuid === uuid); if (p) selected = p.provider; return !!p; }
  function providerLabel() { const a = providers.find((p) => p.provider === currentProvider()); return a?.info?.name || 'Ethereum wallet'; }

  function derivationMsg() {
    return [
      'Sign this message to derive your tacit.finance identity.', '',
      `network: ${netName}`, 'version: 1', '',
      'This signature will not send any transaction or spend any funds.',
    ].join('\n');
  }
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
  // A genuine contract wallet (Safe/Argent) signs non-deterministically → no stable identity. An EIP-7702
  // delegation designator (0xef0100‖impl) is still an EOA, so it's allowed.
  function isContractCode(code) {
    if (typeof code !== 'string' || !/^0x[0-9a-f]*$/i.test(code)) return false;
    if (/^0xef0100[0-9a-f]{40}$/i.test(code)) return false;
    return code.length > 2 && !/^0x0+$/i.test(code);
  }

  // Connect the EOA. When >1 wallet is announced, `pick(list)` chooses one (return its uuid); else the sole
  // provider or window.ethereum is used.
  async function connect({ pick } = {}) {
    if (typeof window !== 'undefined') { try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch { /* ignore */ } }
    let provider = selected;
    if (!provider) {
      if (providers.length >= 2 && typeof pick === 'function') { const uuid = await pick(listProviders()); if (!uuid) throw new Error('no wallet selected'); selectProvider(uuid); provider = selected; }
      else if (providers.length >= 1) { provider = providers[0].provider; selected = provider; }
      else provider = injected();
    }
    if (!provider || typeof provider.request !== 'function') throw new Error('no Ethereum wallet detected — install MetaMask, Rabby, Rainbow, or Coinbase Wallet');
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!Array.isArray(accounts) || !accounts.length) throw new Error('no accounts returned');
    const addr = String(accounts[0]).toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{40}$/.test(addr)) throw new Error('wallet returned malformed address');
    return { provider, address: addr };
  }

  // Derive the deterministic tacit1 identity from a personal_sign over the domain message. Returns
  // { priv (hex), pubHex, address, provider } — priv is the tacit1 secret; provider/address stay for funding.
  async function deriveIdentity({ pick } = {}) {
    const { provider, address } = await connect({ pick });
    let code = '0x'; try { code = await provider.request({ method: 'eth_getCode', params: ['0x' + address, 'latest'] }); } catch { /* treat as EOA */ }
    if (isContractCode(code)) throw new Error('Smart-contract wallets produce non-deterministic signatures and cannot derive a stable tacit identity — use a passkey, seed, or an EOA wallet.');
    const msg = derivationMsg();
    const sig = await provider.request({ method: 'personal_sign', params: ['0x' + bytesToHex(enc(msg)), '0x' + address] });
    if (typeof sig !== 'string' || !sig.startsWith('0x')) throw new Error('wallet returned invalid signature');
    const sigBytes = hexToBytes(sig.slice(2));
    if (sigBytes.length !== 65) throw new Error('signature must be 65 bytes');
    const recovered = recoverAddr(msg, sig);
    if (recovered !== address) throw new Error(`signature is from ${recovered.slice(0, 8)}…, not ${address.slice(0, 8)}… — switch your active account and retry`);
    const priv = prfBytesToScalar(sha256(sigBytes)); sigBytes.fill(0);
    const privHex = priv instanceof Uint8Array ? bytesToHex(priv) : String(priv);
    const pubHex = bytesToHex(secp.getPublicKey(priv instanceof Uint8Array ? priv : hexToBytes(privHex), true));
    return { priv: privHex, pubHex, address, provider, label: providerLabel() };
  }

  // Fund a tacit1 wrap from the external wallet: it signs+pays for the pool.wrap() tx (value = ETH deposited),
  // minting a note owned by the tacit1 identity (owner is inside `data`'s commit). Returns the tx hash.
  async function fundTx({ from, to, data, valueWei = 0n }) {
    const provider = currentProvider();
    if (!provider) throw new Error('no Ethereum wallet connected');
    const params = { from: '0x' + String(from).replace(/^0x/, ''), to, data };
    if (valueWei && BigInt(valueWei) > 0n) params.value = '0x' + BigInt(valueWei).toString(16);
    return provider.request({ method: 'eth_sendTransaction', params: [params] });
  }

  async function chainId() { const p = currentProvider(); if (!p) return null; try { return parseInt(await p.request({ method: 'eth_chainId' }), 16); } catch { return null; } }

  return { available, listProviders, selectProvider, providerLabel, connect, deriveIdentity, fundTx, chainId, derivationMsg };
}
