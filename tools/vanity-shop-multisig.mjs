#!/usr/bin/env node
// What the ops multisig signs to stock the vanity shop (contracts/src/VanityShop.sol): the calls of a plan the listing tool wrote (tools/vanity-shop-list.mjs --out plan.json),
// the keeps and the listings together as ONE transaction (the multisig's own `batch`), with the typed data its owners sign and the call that sends it once enough have.
//
//   RPC=<endpoint> node tools/vanity-shop-multisig.mjs <plan.json> plan                       what the plan does, call by call, and what the multisig is now
//   RPC=<endpoint> node tools/vanity-shop-multisig.mjs <plan.json> payload                    every call tried as the multisig, then the typed data to sign, its digest and the approval call, at the next nonce
//   RPC=<endpoint> node tools/vanity-shop-multisig.mjs <plan.json> assemble <sig|approved:0xowner>...   the `execute` call data from the signatures collected
//   RPC=<endpoint> node tools/vanity-shop-multisig.mjs <plan.json> queued <nonce>             when it may be run, and its `executeQueued` call data
//
// How the multisig works (the same moves as tools/tac-vault-multisig.mjs): the owners sign Execute(target, value, data, nonce), anyone sends `execute` with the signatures
// sorted by signer, and the call is queued; after the delay anyone sends `executeQueued`. So: sign, send `execute`, wait the delay, send `executeQueued`. Sign only when it is to
// be sent: the nonce is the multisig's next at that time, and a signature is for one nonce and one plan. Each owner may instead approve the digest on chain (`approve(digest,
// true)`) and give `approved:<owner address>` in place of a signature.
//
// It builds a transaction from `keep` and `list` calls to the shop and from nothing else, and what the owners are shown is read back from the calldata itself, not from the
// plan's labels. A plan for another shop, a call with value, or any other call is refused. Nothing is sent: this prints.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { marketAddress } from '../worker/src/salt-pool.js';

const MULTISIG = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
const SHOP = '0x00000000000785882df83d4cc6ed45c21eb1176c';
const KEEP = '0x3960bb02', LIST = '0x5e80527b';              // keep(uint256,uint8,address), list((uint256,uint128,uint8)[])
const U128 = (1n << 128n) - 1n;
const word = (h, i) => h.slice(10 + i * 64, 10 + (i + 1) * 64);   // word i of a call's arguments
const tac = (wei) => Number(wei / 10n ** 12n) / 1e6;

// The calls of a plan: [{ kind: 'keep', id, nonce, to, vanity, bits, data } | { kind: 'list', items: [{ id, price, nonce, vanity, bits }], total, data }]
export function loadCalls(plan, { shop = SHOP } = {}) {
  if (!plan || String(plan.shop).toLowerCase() !== shop) throw new Error('that plan is for another shop');
  if (!Array.isArray(plan.calls) || !plan.calls.length) throw new Error('that plan has no calls');
  const shopHex = shop.slice(2), seen = new Set();
  const entry = (id, nonce, n) => {
    if (id.slice(2, 42) !== shopHex) throw new Error(`call ${n}: ${id} is not an id of this shop`);
    if (!(nonce >= 0 && nonce <= 254)) throw new Error(`call ${n}: nonce ${nonce} is out of range`);
    if (seen.has(id)) throw new Error(`call ${n}: ${id} is in the plan twice`);
    seen.add(id);
    const m = marketAddress(id, nonce);
    return { vanity: m.address, bits: m.bits };
  };
  return plan.calls.map((c, i) => {
    const n = i + 1, data = String(c.data).toLowerCase();
    if (String(c.to).toLowerCase() !== shop) throw new Error(`call ${n} is not to the shop`);
    if (String(c.value) !== '0') throw new Error(`call ${n} carries value`);
    if (!/^0x[0-9a-f]+$/.test(data)) throw new Error(`call ${n} has no calldata`);
    if (data.startsWith(KEEP)) {
      if (data.length !== 10 + 3 * 64) throw new Error(`call ${n}: a keep is three words`);
      const id = '0x' + word(data, 0), nonce = Number(BigInt('0x' + word(data, 1))), to = '0x' + word(data, 2).slice(24);
      if (BigInt('0x' + word(data, 2)) >> 160n !== 0n) throw new Error(`call ${n}: the recipient is not an address`);
      return { kind: 'keep', id, nonce, to, ...entry(id, nonce, n), data };
    }
    if (data.startsWith(LIST)) {
      const count = Number(BigInt('0x' + word(data, 1)));
      if (BigInt('0x' + word(data, 0)) !== 32n || !(count >= 1) || data.length !== 10 + (2 + 3 * count) * 64) throw new Error(`call ${n}: a list is an array of (id, price, nonce)`);
      const items = [];
      for (let k = 0; k < count; k++) {
        const id = '0x' + word(data, 2 + 3 * k), price = BigInt('0x' + word(data, 3 + 3 * k)), nonce = Number(BigInt('0x' + word(data, 4 + 3 * k)));
        if (!(price > 0n && price <= U128)) throw new Error(`call ${n}: a price of ${price}`);
        items.push({ id, price, nonce, ...entry(id, nonce, n) });
      }
      return { kind: 'list', items, total: items.reduce((s, x) => s + x.price, 0n), data };
    }
    throw new Error(`call ${n} is neither keep nor list`);
  });
}

// What each call does, in words, read from its calldata.
export function describeCalls(calls) {
  return calls.map((c) => {
    if (c.kind === 'keep') return `keep ${c.vanity} (${c.bits} bits, nonce ${c.nonce}): mint its token to ${c.to}`;
    const n = c.items.length, bits = c.items.map((x) => x.bits), lo = Math.min(...bits), hi = Math.max(...bits);
    const cheap = c.items.reduce((m, x) => (x.price < m ? x.price : m), c.items[0].price), dear = c.items.reduce((m, x) => (x.price > m ? x.price : m), 0n);
    const prices = cheap === dear ? `${tac(cheap)} TAC` : `${tac(cheap)} to ${tac(dear)} TAC`;
    return `list ${n} salt${n === 1 ? '' : 's'} (${lo === hi ? lo : `${lo} to ${hi}`} bits) at ${prices}${n === 1 ? '' : ` each, ${tac(c.total).toLocaleString('en-US')} TAC in all`}`;
  });
}

// ---- command line ----

async function main(argv) {
  const [file, cmd, ...rest] = argv;
  const RPC = process.env.RPC;
  if (!file || !cmd) { console.error('plan.json plan | payload | assemble <sig>... | queued <nonce>'); process.exit(2); }
  if (!RPC) { console.error('set RPC'); process.exit(2); }
  const calls = loadCalls(JSON.parse(readFileSync(file, 'utf8')));
  const cast = (args) => execFileSync('cast', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }).trim();
  const view = (to, sig, ...a) => cast(['call', to, sig, ...a, '--rpc-url', RPC]).split('\n')[0].split(' ')[0];
  const batch = cast(['calldata', 'batch(address[],uint256[],bytes[])', `[${calls.map(() => SHOP).join(',')}]`, `[${calls.map(() => 0).join(',')}]`, `[${calls.map((c) => c.data).join(',')}]`]);
  const nonceNow = () => Number(view(MULTISIG, 'nonce()(uint32)'));
  const digestOf = (nonce) => cast(['call', MULTISIG, 'getTransactionHash(address,uint256,bytes,uint32)(bytes32)', MULTISIG, '0', batch, String(nonce), '--rpc-url', RPC]);

  if (cmd === 'plan') {
    console.log(`ops multisig ${MULTISIG}: ${view(MULTISIG, 'threshold()(uint16)')} of ${view(MULTISIG, 'ownerCount()(uint16)')}, delay ${Number(view(MULTISIG, 'delay()(uint32)')) / 60} min, next nonce ${nonceNow()}`);
    console.log(`shop ${SHOP}\n`);
    describeCalls(calls).forEach((d, i) => console.log(`${i + 1}. ${d}`));
    console.log(`\nall ${calls.length} as one transaction: the multisig's batch, ${(batch.length - 2) / 2} bytes of call data`);
  } else if (cmd === 'payload') {
    for (const c of calls) cast(['call', SHOP, '--data', c.data, '--from', MULTISIG, '--rpc-url', RPC]);          // each call as the multisig, so one the shop would refuse stops here
    cast(['call', MULTISIG, '--data', batch, '--from', MULTISIG, '--rpc-url', RPC]);                              // and all of them together, as the multisig makes it
    const nonce = nonceNow(), digest = digestOf(nonce);
    const typedData = {
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], Execute: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'nonce', type: 'uint32' }] },
      primaryType: 'Execute', domain: { name: 'Multisig', version: '1', chainId: 1, verifyingContract: MULTISIG }, message: { target: MULTISIG, value: '0', data: batch, nonce },
    };
    console.log(JSON.stringify({
      to: MULTISIG, target: MULTISIG, value: '0', nonce, digest, does: describeCalls(calls), data: batch, typedData,
      approveCall: { to: MULTISIG, data: cast(['calldata', 'approve(bytes32,bool)', digest, 'true']) },
      signWithCast: `cast wallet sign --no-hash ${digest} --account <keystore>   (each owner; any two)`,
    }, null, 2));
  } else if (cmd === 'assemble') {
    const nonce = nonceNow(), digest = digestOf(nonce), threshold = Number(view(MULTISIG, 'threshold()(uint16)'));
    const pad = (h, n = 64) => h.replace(/^0x/, '').toLowerCase().padStart(n, '0');
    const entries = rest.map((s) => {
      if (s.startsWith('approved:')) {
        const owner = s.slice(9).toLowerCase();
        if (view(MULTISIG, 'approved(address,bytes32)(bool)', owner, digest) !== 'true') throw new Error(`${owner} has not approved ${digest}`);
        return { signer: owner, sig: `${pad(owner)}${'0'.repeat(64)}00` };
      }
      const h = s.replace(/^0x/, '');
      if (h.length !== 130) throw new Error('a signature is 65 bytes');
      const v = parseInt(h.slice(128), 16) < 27 ? parseInt(h.slice(128), 16) + 27 : parseInt(h.slice(128), 16);
      const out = cast(['call', '0x0000000000000000000000000000000000000001', '--data', `0x${pad(digest)}${pad(v.toString(16))}${h.slice(0, 64)}${h.slice(64, 128)}`, '--rpc-url', RPC]);
      return { signer: `0x${out.slice(-40)}`.toLowerCase(), sig: `${h.slice(0, 128)}${v.toString(16)}` };
    });
    for (const e of entries) if (view(MULTISIG, 'isOwner(address)(bool)', e.signer) !== 'true') throw new Error(`${e.signer} is not an owner of the multisig (wrong nonce or plan?)`);
    const uniq = [...new Map(entries.map((e) => [e.signer, e])).values()].sort((x, y) => (BigInt(x.signer) < BigInt(y.signer) ? -1 : 1));
    if (uniq.length < threshold) throw new Error(`${uniq.length} owners of ${threshold} needed`);
    const sigs = `0x${uniq.slice(0, threshold).map((e) => e.sig).join('')}`;
    console.log(JSON.stringify({ nonce, digest, signers: uniq.slice(0, threshold).map((e) => e.signer), to: MULTISIG, value: '0', data: cast(['calldata', 'execute(address,uint256,bytes,bytes)', MULTISIG, '0', batch, sigs]) }, null, 2));
  } else if (cmd === 'queued') {
    const nonce = rest[0];
    if (nonce == null) { console.error('give the nonce the plan was sent at'); process.exit(2); }
    const digest = digestOf(Number(nonce)), eta = BigInt(view(MULTISIG, 'queued(bytes32)(uint256)', digest));
    const now = BigInt(cast(['block', 'latest', '--field', 'timestamp', '--rpc-url', RPC]));        // the chain's clock, which is what the multisig tests
    console.log(JSON.stringify({
      nonce: Number(nonce), digest, queuedUntil: eta === 0n ? null : new Date(Number(eta) * 1000).toISOString(),
      state: eta === 0n ? 'not queued (not sent, or already run)' : now >= eta ? 'ready: anyone can send executeQueued' : `wait ${Number(eta - now)} s`,
      to: MULTISIG, value: '0', data: cast(['calldata', 'executeQueued(address,uint256,bytes,uint32)', MULTISIG, '0', batch, String(nonce)]),
    }, null, 2));
  } else {
    console.error('plan | payload | assemble <sig>... | queued <nonce>');
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
