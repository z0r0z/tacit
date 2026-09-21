#!/usr/bin/env node
// Guard against a mistyped ops address: (1) every address-shaped string near the ops multisig must be exactly it,
// (2) the live role holders on the deployed surface must be the ops multisig (or an explicitly listed pending state).
// Usage: node tools/verify-roles.mjs [--rpc <url>] [--no-chain]     exit 0 = clean, 1 = a problem was found
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const OPS = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
const OPS_LC = OPS.toLowerCase();
const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const RPC = args.includes('--rpc') ? args[args.indexOf('--rpc') + 1] : (process.env.RPC || 'https://ethereum-rpc.publicnode.com');
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'cache', 'broadcast', 'worktrees', 'target', 'lib', 'dist']);
const TEXT = /\.(js|mjs|cjs|ts|sol|md|json|env|yaml|yml|html|txt|sh)$/i;

let problems = 0;
const bad = (m) => { problems++; console.log('  FAIL', m); };
const ok = (m) => console.log('  ok  ', m);

// 1. Near-miss scan. A string counts as "meant to be ops" when it shares the distinctive head or tail of the real
// address (or is within a couple of characters of it), and it is then required to be exactly the real address.
const head = OPS_LC.slice(2, 12), tail = OPS_LC.slice(-10);
const looksLikeOps = (h) => {
  const s = h.toLowerCase();
  if (s === OPS_LC.slice(2)) return true;
  if (s.includes(head) || s.includes(tail)) return true;
  // any 40-hex string within 3 edits of the real one, by position
  if (s.length === 40) { let d = 0; for (let i = 0; i < 40; i++) if (s[i] !== OPS_LC[i + 2] && ++d > 3) return false; return true; }
  return false;
};
let files = 0, exact = 0;
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p); continue; }
    if (!TEXT.test(name) || st.size > 4_000_000) continue;
    files++;
    const txt = readFileSync(p, 'utf8');
    for (const m of txt.matchAll(/0x([0-9a-fA-F]{34,46})/g)) {
      const hex = m[1];
      if (!looksLikeOps(hex)) continue;
      if (hex.length === 40 && ('0x' + hex).toLowerCase() === OPS_LC) {
        exact++;
        if (hex !== hex.toLowerCase() && '0x' + hex !== OPS) bad(`${relative(ROOT, p)}: correct digits but a wrong checksum (mixed-case) casing 0x${hex}`);
      } else bad(`${relative(ROOT, p)}: ${hex.length === 40 ? 'near-miss' : 'wrong length (' + hex.length + ' hex chars)'} 0x${hex}`);
    }
  }
})(ROOT);
console.log(`scanned ${files} files; ${exact} exact mentions of the ops multisig`);
if (!problems) ok('no near-miss or truncated ops address anywhere in the repo');

// 2. Live role holders.
if (!args.includes('--no-chain')) {
  const call = async (to, sig4, ret = 'addr') => {
    const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data: sig4 }, 'latest'] }) })).json();
    if (!r.result || r.result === '0x') return null;
    return '0x' + r.result.slice(-40);
  };
  // getter selectors (keccak256 of the signature, first 4 bytes)
  const SEL = { owner: '0x8da5cb5b', gov: '0x12d43a51', pendingGov: '0x25240810' };
  const deployments = JSON.parse(readFileSync(join(ROOT, 'contracts/deployments/1.json'), 'utf8'));
  if (String(deployments.engineAdmin).toLowerCase() !== OPS_LC) bad(`contracts/deployments/1.json engineAdmin = ${deployments.engineAdmin}`);
  else ok('deployments/1.json engineAdmin is the ops multisig');
  const owner = await call(deployments.engine, SEL.owner);
  if (owner && owner.toLowerCase() === OPS_LC) ok(`CollateralEngine ${deployments.engine} owner() is the ops multisig`);
  else bad(`CollateralEngine owner() = ${owner}`);
  const FARM = '0x000031C47Cb61faB1CE2790a69625FABB71EDE24';
  const gov = await call(FARM, SEL.gov), pending = await call(FARM, SEL.pendingGov);
  if (gov && gov.toLowerCase() === OPS_LC) ok('FarmManager gov() is the ops multisig');
  else if (pending && pending.toLowerCase() === OPS_LC) console.log(`  warn FarmManager gov() = ${gov}; pendingGov() is the ops multisig — awaiting acceptGov()`);
  else bad(`FarmManager gov() = ${gov}, pendingGov() = ${pending}`);
}
console.log(problems ? `\n${problems} problem(s)` : '\nclean');
process.exit(problems ? 1 : 0);
