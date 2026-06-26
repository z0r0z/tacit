// Create / Factory tab — deploy a tacit-compatible asset on Ethereum via the CanonicalAssetFactory. A
// canonical asset's address is deterministic (CREATE2; the salt binds id+minter+metadata), and the EVM-etch
// asset id is DERIVED from the metadata (sha256(ETCH_TAG ‖ chainid ‖ factory ‖ salt ‖ etcher ‖ meta_hash)),
// so it is self-certifying. The user is both etcher and minter, so they hold the freshly-minted supply and
// can wrap it straight into the confidential pool.
//
// The Bitcoin-native etch path stays under Create → "Etch (Bitcoin)"; this is its Ethereum counterpart.
// Until the factory address is pinned in the deployment manifest the surface reports that honestly rather
// than building a transaction that would revert.

import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';

let _ux = null;
function getUx() {
  return _ux || (_ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256 }));
}
const el = (id) => document.getElementById(id);
const _hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const _word = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const _addrWord = (a) => _word(String(a).replace(/^0x/, '').padStart(40, '0'));
const _selector = (sig) => _hex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);

// ABI-encode etchCanonical(address etcher, bytes32 salt, address minter, string symbol_, uint8 decimals_,
// bytes32 cid). One dynamic param (the string), encoded as bytes: offset, then length word + right-padded data.
function etchCanonicalCalldata({ etcher, salt, minter, symbol, decimals, cid }) {
  const sym = new TextEncoder().encode(String(symbol));
  const symHex = _hex(sym);
  const padded = symHex + '0'.repeat((64 - (symHex.length % 64)) % 64);
  const headWords = 6; // etcher, salt, minter, <string offset>, decimals, cid
  const strOffset = headWords * 32;
  const head = _addrWord(etcher) + _word(salt) + _addrWord(minter) + _word(BigInt(strOffset).toString(16))
    + _word(BigInt(decimals).toString(16)) + _word(cid || ('0x' + '00'.repeat(32)));
  const tail = _word(BigInt(sym.length).toString(16)) + padded;
  return '0x' + _selector('etchCanonical(address,bytes32,address,string,uint8,bytes32)') + head + tail;
}

export async function renderFactoryTab(wallet) {
  const body = el('factory-body');
  if (!body) return;
  const ux = getUx();
  if (!wallet || !wallet.priv) {
    body.innerHTML = '<div class="muted">Unlock a wallet to deploy a tacit-compatible asset on Ethereum.</div>';
    return;
  }
  const factoryAddr = ux.cfg && ux.cfg.assetFactory;
  if (!factoryAddr) {
    body.innerHTML = `
      <div class="note-concept" style="margin-bottom:12px;"><b>New asset on Ethereum.</b> Deploy a
        tacit-compatible asset whose public ERC20 face is derived deterministically from its metadata, ready to
        wrap into the confidential pool and trade on either chain.</div>
      <div class="muted" style="font-size:12px;">The canonical asset factory isn't deployed on this network yet.
        To mint a Bitcoin-native confidential asset now, use <a href="#tab=etch">Create → Etch (Bitcoin)</a>.</div>`;
    return;
  }
  const acct = ux.account(wallet.priv);
  body.innerHTML = `
    <div class="note-concept" style="margin-bottom:12px;"><b>New asset on Ethereum.</b> Deploy a
      tacit-compatible asset via the canonical factory. The id is derived from the metadata (self-certifying)
      and the ERC20 address is fixed by it, so it is the same everywhere and can be wrapped straight into the
      confidential pool. You are the minter, so the initial supply is yours.</div>
    <div class="muted" style="font-size:11px;margin-bottom:8px;">Deploying from <code>${acct.address}</code></div>
    <label style="font-size:11px;color:var(--ink-mid);">Symbol</label>
    <input id="factory-symbol" type="text" placeholder="MYA" maxlength="11" style="width:100%;box-sizing:border-box;padding:6px;font-size:13px;border:1px solid var(--ink,#ccc);border-radius:4px;margin:4px 0 8px;">
    <label style="font-size:11px;color:var(--ink-mid);">Decimals</label>
    <input id="factory-decimals" type="number" min="0" max="18" value="8" style="width:100%;box-sizing:border-box;padding:6px;font-size:13px;border:1px solid var(--ink,#ccc);border-radius:4px;margin:4px 0 12px;">
    <button id="factory-btn" style="padding:6px 14px;font-size:13px;cursor:pointer;">Deploy asset</button>
    <div id="factory-status" class="muted" style="font-size:11px;margin-top:8px;"></div>`;

  const btn = el('factory-btn');
  if (btn) btn.onclick = async () => {
    const st = el('factory-status');
    const symbol = (el('factory-symbol').value || '').trim().toUpperCase();
    const decimals = Math.max(0, Math.min(18, Math.floor(Number(el('factory-decimals').value || 8))));
    if (!/^[A-Z0-9]{2,11}$/.test(symbol)) { if (st) st.textContent = 'Enter a 2–11 char symbol (A–Z, 0–9).'; return; }
    btn.disabled = true;
    if (st) st.textContent = 'Deploying the canonical asset…';
    try {
      // A fresh per-deploy salt keeps the (etcher, salt) tuple unique so the derived id is fresh.
      const salt = '0x' + _hex(keccak_256(new TextEncoder().encode(`tacit-factory-salt:${acct.address}:${symbol}:${decimals}:${Date.now()}`)));
      const calldata = etchCanonicalCalldata({ etcher: acct.address, salt, minter: acct.address, symbol, decimals, cid: null });
      const nonce = BigInt(await ux.rpc('eth_getTransactionCount', [acct.address, 'pending']));
      const tip = 1500000000n;
      const base = BigInt(await ux.rpc('eth_gasPrice', []) || '0x3b9aca00');
      const tx = {
        chainId: BigInt(ux.cfg.chainId), nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip,
        gasLimit: 900000n, to: factoryAddr, value: 0n, data: calldata,
      };
      const signed = ux.evmTx.signEip1559(tx, acct.priv);
      const txHash = await ux.rpc('eth_sendRawTransaction', [signed.raw]);
      if (st) st.innerHTML = `Deployed <strong>${symbol}</strong> (${decimals} dec)`
        + (txHash ? ` — <code style="font-size:10px;word-break:break-all;">${txHash}</code>` : '')
        + '. Wrap it into the pool from the Send / Pool surface once the tx confirms.';
    } catch (e) {
      if (st) st.textContent = 'Deploy failed: ' + (e && e.message || e);
      btn.disabled = false;
    }
  };
}
