// Private ETH from a swap of BTC, sent on to an Ethereum address once it has arrived (the /btc/ page's "Receive as"): the address checked, the relay's fee
// read before anything is asked, then the note that the swap's claim made (exactly the swap's amount) withdrawn to the address by the relay (the pool
// module's unwrap, as the tETH page withdraws). A choice made for a swap is kept in this browser by key and swap, so a page opened again carries it out.
//
//   checkAddress(text)                       -> { ok, address } | { ok: false, why }      an Ethereum address, its checksum checked when it has one
//   const p = makePayout({ getUx })
//   p.tacitAddress(priv)                     -> the Ethereum address the Tacit key makes (the wallet sheet's; its key can be exported there)
//   p.quote(units)                           -> { fee, net }   pool units (1e-8 ETH): the relay's fee of the withdrawal, and what arrives
//   p.send({ key, units, to })               -> { txHash, fee, net }
//   p.want(pub, id) / p.choose(pub, id, rec) / p.drop(pub, id)    the choice kept for a swap: { to, at, state: 'waiting' | 'sending' | 'sent' | 'failed', tx?, why? }
import { keccak_256, secp, sha256 } from '/vendor/tacit-deps.min.js';
import { makeEvmAccount } from '/evm-account.js';

const KEY = 'tacit-btc-payout-v1:';
const KEEP_MS = 14 * 86400e3;
const ETH_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// EIP-55: an address in one case is taken as written; one in mixed case must carry its checksum (a mistyped character fails it)
export function checksummed(addr) {
  const a = String(addr).replace(/^0x/i, '').toLowerCase();
  const h = hex(keccak_256(new TextEncoder().encode(a)));
  return '0x' + [...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}
export function checkAddress(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, why: 'Enter an Ethereum address.' };
  if (/^(bc1|tb1|[13][a-km-zA-HJ-NP-Z1-9]{20,})/i.test(t)) return { ok: false, why: 'That is a Bitcoin address. This sends ETH: enter an Ethereum address (0x…).' };
  if (/\.eth$/i.test(t)) return { ok: false, why: 'Enter the address itself (0x…), not a name.' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return { ok: false, why: 'An Ethereum address is 0x and 40 letters and digits.' };
  const body = t.slice(2);
  if (/^0+$/.test(body)) return { ok: false, why: 'That is the zero address: nothing sent there can be spent.' };
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && checksummed(t) !== t) return { ok: false, why: 'That address fails its checksum: a character is wrong. Copy it again.' };
  return { ok: true, address: checksummed(t) };
}

const readAll = (pub) => { try { const m = JSON.parse(localStorage.getItem(KEY + pub) || '{}'); return m && typeof m === 'object' ? m : {}; } catch { return {}; } };
const writeAll = (pub, m) => { try { localStorage.setItem(KEY + pub, JSON.stringify(m)); } catch { /* the choice is then only this visit's */ } };

export function makePayout({ getUx }) {
  let acct = null;
  const account = () => (acct ||= makeEvmAccount({ secp, keccak256: keccak_256, sha256 }));
  const tacitAddress = (priv) => checksummed(account().deriveEvmAccount(Uint8Array.from(priv), 'mainnet').address);

  async function quote(units) {
    const ux = await getUx(), v = BigInt(units);
    const minFee = await ux.quoteOpFee('cETH', 'unwrap');
    const { fee, net } = ux.quoteUnwrapFee(v, 'cETH', { minFee });
    return { fee: BigInt(fee), net: BigInt(net) };
  }

  // The swap's note: one of exactly its amount (the claim makes one). Withdrawn whole by the relay, which takes its fee from it; what arrives is the rest.
  async function send({ key, units, to }) {
    const chk = checkAddress(to);
    if (!chk.ok) throw new Error(chk.why);
    const ux = await getUx(), priv = Uint8Array.from(key.priv), want = BigInt(units);
    const { byAsset } = await ux.balance(priv, { bridge: false, cbtc: false });
    const notes = (byAsset[ETH_ID] && byAsset[ETH_ID].notes) || [];
    const note = notes.find((n) => BigInt(n.value) === want);
    if (!note) throw Object.assign(new Error('The ETH from this swap is not in your private balance as one amount yet. Trying again shortly.'), { retry: true });
    const r = await ux.unwrap({ note, walletPriv: priv, recipient: chk.address });
    if (r.status && r.status !== 'settled') throw Object.assign(new Error('The relay has not finished the withdrawal yet.'), { retry: true });
    return { txHash: r.txHash || null, fee: BigInt(r.fee ?? 0n), net: BigInt(r.net ?? 0n) };
  }

  const want = (pub, id) => { const r = readAll(pub)[id]; return r && Date.now() - Number(r.at || 0) < KEEP_MS ? r : null; };
  const choose = (pub, id, rec) => { const m = readAll(pub); m[id] = { at: Date.now(), ...(m[id] || {}), ...rec }; writeAll(pub, m); return m[id]; };
  const drop = (pub, id) => { const m = readAll(pub); delete m[id]; writeAll(pub, m); };
  return { tacitAddress, quote, send, want, choose, drop, checkAddress };
}
