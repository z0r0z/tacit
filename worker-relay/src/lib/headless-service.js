// The pieces the keeper-style services share (bridge-recover, pool-maker): tacit.js loaded headlessly, a wallet key put into it, a spend lock, a state file, the
// caller's address, and the error that carries an HTTP status. They lived in sats-faucet.js until that service (signet only) was retired.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientKey } from './token-bucket.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAPP = path.resolve(HERE, '../../../dapp');

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// The caller's address (see lib/token-bucket.js: the address Cloudflare saw, else the proxy-appended forwarded hop).
export const clientIp = clientKey;


// Serialises everything that spends from the service's key, so two spends never select the same UTXOs.
export function makeLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

// tacit.js is a browser module: DOM globals and the network must exist before it is imported.
export async function loadTacitHeadless(network = 'mainnet') {
  if (globalThis.__headlessTacit) return globalThis.__headlessTacit;
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const g = globalThis;
  const set = (k, v) => { try { g[k] = v; } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); } };
  set('window', dom.window);
  set('document', dom.window.document);
  set('localStorage', dom.window.localStorage);
  set('location', dom.window.location);
  if (!g.navigator) set('navigator', dom.window.navigator);
  if (!g.crypto) set('crypto', dom.window.crypto);
  g.prompt = () => null;
  g.alert = () => {};
  g.confirm = () => true;
  g.__TACIT_NO_INIT__ = true;
  dom.window.localStorage.setItem('tacit-network-v1', network);
  const tacit = await import(path.join(DAPP, 'tacit.js'));
  const deps = await import(path.join(DAPP, 'vendor/tacit-deps.min.js'));
  if (tacit.NET?.name !== network) throw new Error(`tacit.js loaded for ${tacit.NET?.name}, want ${network}`);
  g.__headlessTacit = { tacit, deps };
  return g.__headlessTacit;
}

// Signing key into the module's wallet; the passphrase path is for browsers.
export function setWalletKey({ tacit, deps }, privHex) {
  const hex = String(privHex || '').trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('the wallet key must be 32-byte hex');
  const priv = deps.hexToBytes(hex);
  tacit.wallet.priv = priv;
  tacit.wallet.pub = deps.secp.getPublicKey(priv, true);
  try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + deps.bytesToHex(tacit.wallet.pub), '1'); } catch {}
  try { tacit.invalidateHoldingsCache(); } catch {}
  return deps.bytesToHex(tacit.wallet.pub);
}

export function openStateFile(statePath) {
  return {
    load() { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } },
    save(s) {
      mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = statePath + '.tmp';
      writeFileSync(tmp, JSON.stringify(s, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2), { mode: 0o600 });
      renameSync(tmp, statePath);
    },
  };
}

