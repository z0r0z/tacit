// Standalone scanHoldings debug for founder
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const dapp = await import('/Users/z/tacit/dapp/tacit.js');
const { hexToBytes, bytesToHex } = await import('@noble/hashes/utils');
const wallets = JSON.parse(await (await import('fs/promises')).readFile('/Users/z/tacit/.local/amm-e2e-signet-wallets.json', 'utf8'));
const founderPrivHex = wallets.founder.priv_hex;
const founderAddr = wallets.founder.address;
const founderPub = wallets.founder.pub_hex;
console.log('founder addr:', founderAddr);
console.log('founder pub :', founderPub);

// Load wallet by setting priv/pub directly (matches harness's useWallet)
dapp.wallet.priv = hexToBytes(founderPrivHex);
dapp.wallet.pub = hexToBytes(founderPub);
dapp.invalidateHoldingsCache();
console.log('wallet pub  :', bytesToHex(dapp.wallet.pub));
console.log('wallet addr :', dapp.wallet.address);

// scanHoldings
console.log('\nscanning…');
const holdings = await dapp.scanHoldings();
console.log(`scanned ${holdings.size} assets`);
for (const [aid, h] of holdings) {
  const meta = await dapp.getAssetMeta(aid);
  const ticker = meta?.ticker || '(no ticker)';
  console.log(`  ${aid.slice(0,16)}…  ${ticker.padEnd(12)}  bal=${h.balance}  utxos=${h.utxos?.length || 0}`);
}

const LP_ASSET = '4b12867dc721f2578e6fd2c5af3bb50d25450de7f964b465e5e17426f0ee10bb';
const lp = holdings.get(LP_ASSET);
console.log('\nlp_asset_id =', LP_ASSET.slice(0,16) + '…');
console.log('lp holdings :', lp);
