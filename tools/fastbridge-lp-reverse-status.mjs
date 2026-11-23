#!/usr/bin/env node
// READ-ONLY: the Bitcoin address the fast bridge provider's reverse side (Ethereum -> Bitcoin, fastbridge-lp/README.md "Selling the other way") sells from, and what
// is at it: the TAC notes it can sell and the plain-sat coins that pay its locks' fees. The address is derived from the provider's key, so this tells you where to
// send TAC and sats BEFORE the reverse side is switched on anywhere. Nothing is sent or signed; the key is only used to derive the address and open its own notes,
// and is never printed.
//   FB_LP_KEY=$(security find-generic-password -s tacit-fastbridge-lp -w) node tools/fastbridge-lp-reverse-status.mjs      (Node 22; from the repository root)
// FB_LP_BTC_BASES=https://a/api,https://b/api sets the explorers for the sat coins (https only); the TAC notes are read the way the daemon reads them.

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const keyHex = String(process.env.FB_LP_KEY || '').trim().replace(/^0x/, '');
if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.log('no key in the environment (FB_LP_KEY, 64 hex characters)'); process.exit(1); }
delete process.env.FB_LP_KEY;                       // not left in the environment of anything this process starts
const bases = String(process.env.FB_LP_BTC_BASES || 'https://mempool.space/api,https://blockstream.info/api').split(',').map((b) => b.trim().replace(/\/+$/, '')).filter(Boolean);
if (!bases.length || bases.some((b) => !/^https:\/\/[^\s/][^\s]*$/.test(b))) { console.log('FB_LP_BTC_BASES must be https URLs, comma separated'); process.exit(1); }
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const hardStop = setTimeout(() => { console.log('STOPPED: time limit'); process.exit(3); }, 10 * 60e3); hardStop.unref?.();

// --via-proxy: read Bitcoin the way the daemon on Render does (through the Tacit API's chain proxy, not the public explorers), to see what it sees
if (process.argv.includes('--via-proxy')) { globalThis.__TACIT_WORKER_BASE__ = process.env.TACIT_WORKER_BASE || 'https://api.tacit.finance'; globalThis.__TACIT_CHAIN_VIA_WORKER__ = true; }
const { loadTacit } = await import(REPO + '/worker-relay/src/lib/btc-pool-transparent.js');
const { secp, sha256, hmac, bytesToHex } = await import(REPO + '/dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { setActiveNetwork } = await import(REPO + '/dapp/confidential-deployments.js');
const { makeBtcWallet } = await import(REPO + '/dapp/bitcoin-taproot-wallet.js');
const { reverseKeyOf, makeReverseInventory, reverseOptions } = await import(REPO + '/fastbridge-lp/lib/reverse.mjs');
setActiveNetwork('mainnet');
const key = Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16)));
const wallet = (priv) => makeBtcWallet({ priv, hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 }).prims;
const main = wallet(key), rev = wallet(reverseKeyOf(key));
const addr = rev.wallet.address();
// the wallet module as the daemon loads it (the live pool for notes that came out of it, no location): its own encoders give the two TAC addresses below
const tacit = await loadTacit('mainnet', { livePool: true });
delete globalThis.location;
tacit.wallet.priv = reverseKeyOf(key); tacit.wallet.pub = rev.wallet.pub;
const { unifiedAddress } = await import(REPO + '/dapp/tacit-unified.js');
const tacit1 = unifiedAddress(reverseKeyOf(key)).address;
const tcs1 = tacit.encodeStealthAddress({ network: 'mainnet', recipientPub: rev.wallet.pub });
console.log(`main address      ${main.wallet.address()}   (the provider's earnings, take-fee coins and a maker's stock: not used by the reverse side)`);
console.log(`reverse address   ${addr}   <- send plain sats here (an ordinary Bitcoin send)`);
console.log(`reverse tacit1    ${tacit1}\n                  ^ TAC on Bitcoin sent to this by a wallet's unified send is a plain transfer to this key's own address: the reverse side can sell it as it arrives (no move step)`);
console.log(`reverse tcs1      ${tcs1}\n                  ^ a shielded (silent) address: TAC sent to it lands at a one-time address of this key; once it has confirmed, run tools/lp-run.sh normalize --txid <id> to move it onto the reverse address.\n                  Not the Pay page for either: its TAC goes into the shielded pool, which comes out as pool-exit TAC (not bridgeable home).`);
if (addr === main.wallet.address()) { console.log('the two are the same address: do not switch the reverse side on'); process.exit(1); }
// --copy puts the tacit1 address on the clipboard (macOS), --copy-silent the tcs1 one, and says so; --address-only stops here, with no reads of the chain at all
for (const [flag, name, value] of [['--copy', 'tacit1', tacit1], ['--copy-silent', 'tcs1', tcs1]]) {
  if (!process.argv.includes(flag)) continue;
  try { (await import('node:child_process')).execFileSync('pbcopy', { input: value }); console.log(`\ncopied: the reverse ${name} address (${value.length} characters) is on your clipboard`); }
  catch (e) { console.log(`\nnot copied (${String((e && e.message) || e).slice(0, 80)}): select the ${name} line above`); }
}
if (process.argv.includes('--address-only')) process.exit(0);
const h = await tacit.scanHoldings(true);
const all = (h instanceof Map && h.get(TAC) && h.get(TAC).utxos) || [];
const notes = await makeReverseInventory({ tacit: { scanHoldings: async () => h }, asset: TAC }).notes();
const tac = (v) => { const s = BigInt(v).toString().padStart(9, '0'); return `${s.slice(0, -8)}.${s.slice(-8)}`.replace(/\.?0+$/, ''); };
const total = notes.reduce((s, n) => s + n.amount, 0n);
console.log(`\nTAC at it         ${notes.length} confirmed note${notes.length === 1 ? '' : 's'}, ${tac(total)} TAC in all${all.length > notes.length ? `  (+${all.length - notes.length} not confirmed yet, or received privately and not moved yet: not counted)` : ''}`);
for (const n of [...notes].sort((a, b) => (a.amount < b.amount ? 1 : -1)).slice(0, 12)) console.log(`  ${tac(n.amount).padStart(14)} TAC   ${n.txid.slice(0, 12)}…:${n.vout}   ${n.value} sats`);
if (notes.length > 12) console.log(`  … and ${notes.length - 12} more`);

// the plain-sat coins (a coin at dust size may carry a note, so those are not counted), from the first explorer that answers
let coins = null;
for (const b of bases) {
  try { const r = await fetch(`${b}/address/${addr}/utxo`, { signal: AbortSignal.timeout(25000) }); if (r.ok) { coins = await r.json(); break; } } catch { /* the next */ }
}
if (coins == null) console.log('\nplain sats        could not be read from any explorer');
else {
  const plain = coins.filter((u) => u.status && u.status.confirmed && u.value > rev.DUST), sum = plain.reduce((s, u) => s + u.value, 0);
  console.log(`\nplain sats        ${plain.length} confirmed coin${plain.length === 1 ? '' : 's'}, ${sum} sats in all${coins.length > plain.length + notes.length ? '  (others are unconfirmed or at dust size)' : ''}`);
}
const o = reverseOptions({ btcAsset: TAC, evmAsset: '0x' + TAC, policy: {}, reverse: { enabled: true } });
console.log(`\nWith the defaults it takes ${o.maxOpen} sends at once and at most ${tac(o.maxLocked)} TAC out at once, each paying out one note's worth or less (the daemon picks the smallest note that covers it); the terms are in the README.`);
process.exit(0);
