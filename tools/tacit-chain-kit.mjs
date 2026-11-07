#!/usr/bin/env node
// Builds dapp/admin/tacit-chain/kit.json: the two CreateX CREATE3 deployments of the tacit chain (TacitSeats, then TacitBlocks naming
// it), each at an address the community's salt miners found for Tacit's deployer. The admin page sends them from that deployer; the
// addresses depend only on the salts, so they are known before either contract exists.
//
//   (cd contracts && forge build)
//   node tools/tacit-chain-kit.mjs --bootstrap 0x… --vkey 0x… [--seats-salt 0x… --blocks-salt 0x…] [--rpc URL]
//
// Salts default to the two best in the salt bank (GET /prover/salt/bank) whose addresses hold no code yet. Every parameter is printed
// and written into the kit; the page shows them again before anything is sent.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const fail = (m) => { console.error(`tacit-chain-kit: ${m}`); process.exit(1); };

const DEPLOYER = '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7';
const CREATEX = '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed';
const P = {
  verifier: arg('verifier', '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2'), // SP1 v6.1.0 Groth16, the immutable leaf (not a gateway)
  vkey: arg('vkey'),
  spendVk: JSON.parse(readFileSync(join(ROOT, 'contracts/test/fixtures/tacit-blocks-mainnet.json'), 'utf8')).spendVk,
  tac: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279',
  confidential: '0x000000000Ed1eabD231Be41d93b719056F7febFC',
  confidentialTac: '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b',
  seat: BigInt(arg('seat', String(1000n * 10n ** 18n))),
  slot: BigInt(arg('slot', '50')),
  window: BigInt(arg('window', '600')),
  forceDelay: BigInt(arg('force-delay', '3600')),
  bootstrap: arg('bootstrap'),
};
const RPC = arg('rpc', 'https://ethereum-rpc.publicnode.com');
const API = arg('api', 'https://tacit-api.onrender.com');
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');
const isWord = (w) => /^0x[0-9a-fA-F]{64}$/.test(w || '');
if (!isAddr(P.bootstrap)) fail('--bootstrap: the address that leads while no one holds a seat (the leader service\'s key)');
if (!isWord(P.vkey)) fail('--vkey: the block program\'s verifying key, of the ELF the provers run');

const strip = (h) => h.replace(/^0x/, '').toLowerCase();
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => strip(a).padStart(64, '0');
const PROXY_INIT_HASH = keccak_256(Uint8Array.from([0x67, 0x36, 0x3d, 0x3d, 0x37, 0x36, 0x3d, 0x34, 0xf0, 0x3d, 0x52, 0x60, 0x08, 0x60, 0x18, 0xf3]));
/// CreateX's CREATE3 address for a salt guarded to DEPLOYER (worker/src/salt-pool.js saltAddress).
function create3(salt) {
  const guarded = keccak_256(concatBytes(new Uint8Array(12), hexToBytes(strip(DEPLOYER)), hexToBytes(strip(salt))));
  const proxy = keccak_256(concatBytes(Uint8Array.of(0xff), hexToBytes(strip(CREATEX)), guarded, PROXY_INIT_HASH)).slice(12);
  return '0x' + bytesToHex(keccak_256(concatBytes(Uint8Array.of(0xd6, 0x94), proxy, Uint8Array.of(0x01))).slice(12));
}
const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const codeAt = async (a) => strip(await rpc('eth_getCode', [a, 'latest'])).length > 0;
const artifact = (name) => {
  const j = JSON.parse(readFileSync(join(ROOT, `contracts/out/${name}.sol/${name}.json`), 'utf8'));
  return strip(j.bytecode.object);
};

// the salts: given, or the bank's best two whose addresses are still empty
let seatsSalt = arg('seats-salt'), blocksSalt = arg('blocks-salt');
if (!seatsSalt || !blocksSalt) {
  const { bank } = await (await fetch(`${API}/prover/salt/bank`)).json();
  const free = [];
  for (const b of bank) {
    if (b.salt.slice(2, 42).toLowerCase() !== strip(DEPLOYER) || create3(b.salt) !== b.address.toLowerCase()) continue;
    if (!(await codeAt(b.address))) free.push(b);
    if (free.length === 2) break;
  }
  if (free.length < 2) fail('the salt bank has fewer than two unused salts');
  // the best salt goes to the contract people see: TacitBlocks holds the TAC and is what wallets name
  blocksSalt = blocksSalt || free[0].salt;
  seatsSalt = seatsSalt || free.find((b) => b.salt !== blocksSalt).salt;
}
for (const s of [seatsSalt, blocksSalt]) if (!isWord(s) || s.slice(2, 42).toLowerCase() !== strip(DEPLOYER)) fail(`${s}: not a salt guarded to the deployer`);
const seatsAt = create3(seatsSalt), blocksAt = create3(blocksSalt);

// the verifier must be the immutable Groth16 leaf: its codehash is checked here and on the page
const verifierCodehash = '0x' + bytesToHex(keccak_256(hexToBytes(strip(await rpc('eth_getCode', [P.verifier, 'latest'])))));
const seatsInit = '0x' + artifact('TacitSeats') + addrWord(P.tac) + word(P.seat) + word(P.slot) + addrWord(P.bootstrap);
const blocksInit = '0x' + artifact('TacitBlocks') + addrWord(P.verifier) + strip(P.vkey) + strip(P.spendVk) + addrWord(seatsAt)
  + word(P.window) + word(P.forceDelay) + addrWord(P.tac) + addrWord(P.confidential) + strip(P.confidentialTac);
const hash = (h) => '0x' + bytesToHex(keccak_256(hexToBytes(strip(h))));

const sel = (sig) => '0x' + bytesToHex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const check = (sig, want) => ({ name: sig.replace('()', ''), sel: sel(sig), want: '0x' + want });
const kit = {
  rpc: ['https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
  deploySelector: sel('deployCreate3(bytes32,bytes)'),
  name: 'Tacit chain',
  chainId: 1,
  factory: CREATEX,
  deployer: DEPLOYER,
  params: Object.fromEntries(Object.entries({ ...P, verifierCodehash }).map(([k, v]) => [k, String(v)])),
  steps: [
    { name: 'TacitSeats', salt: seatsSalt, expected: seatsAt, initHash: hash(seatsInit), initCode: seatsInit, checks: [
      check('TAC()', addrWord(P.tac)), check('SEAT()', word(P.seat)), check('SLOT_BLOCKS()', word(P.slot)), check('BOOTSTRAP()', addrWord(P.bootstrap)),
    ] },
    { name: 'TacitBlocks', salt: blocksSalt, expected: blocksAt, initHash: hash(blocksInit), initCode: blocksInit, checks: [
      check('VERIFIER()', addrWord(P.verifier)), check('BLOCK_VKEY()', strip(P.vkey)), check('SPEND_VK()', strip(P.spendVk)), check('TURNS()', addrWord(seatsAt)),
      check('WINDOW()', word(P.window)), check('FORCE_DELAY()', word(P.forceDelay)), check('TAC()', addrWord(P.tac)),
      check('CONFIDENTIAL()', addrWord(P.confidential)), check('CONFIDENTIAL_TAC()', strip(P.confidentialTac)),
    ] },
  ],
};
mkdirSync(join(ROOT, 'dapp/admin/tacit-chain'), { recursive: true });
writeFileSync(join(ROOT, 'dapp/admin/tacit-chain/kit.json'), JSON.stringify(kit, null, 1) + '\n');
console.log(JSON.stringify({ seats: seatsAt, blocks: blocksAt, verifierCodehash, params: kit.params }, null, 1));

// the page: its one inline script, pinned in its CSP by hash
{
  const { createHash } = await import('node:crypto');
  const src = readFileSync(join(ROOT, 'dapp/admin/tacit-chain/index.src.html'), 'utf8');
  const script = src.match(/<script>([\s\S]*?)<\/script>/)[1];
  const h = 'sha256-' + createHash('sha256').update(script).digest('base64');
  writeFileSync(join(ROOT, 'dapp/admin/tacit-chain/index.html'), src.replace('__SCRIPT_HASH__', h));
}
