// What the vanity shop has on its shelf, and the calls a buyer makes to it (contracts/src/VanityShop.sol, deployed on Ethereum). The shelf is read from the shop's own
// events: a `Listed` puts an address up (or changes its price and nonce), and `Unlisted`, `Sold` and `Kept` take it down. Nothing here touches the page or the wallet.
export const SHOP = '0x00000000000785882df83d4cc6ed45c21eb1176c';
export const MARKET = '0x000000000000b361194cfe6312ee3210d53c15aa';
export const TAC = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279';
export const TAC_NAME = 'Tacit Token';      // the name in TAC's permit domain (its version is "1")
export const FROM_BLOCK = 26428082;         // the block the shop was deployed in: its events start there
export const TOPICS = {
  listed: '0x2802f06388a3e8067e9fa7f668de2f85c52cddb739522134cdda89f30ede0c85',    // Listed(uint256 indexed id, address indexed vanity, uint8 nonce, uint128 price)
  unlisted: '0x6318005f6dc5a71d3e4ad5b4d1fe455ef3402d62b64573777af55bb6bfe3daab',  // Unlisted(uint256 indexed id)
  sold: '0x127eb22cbd9a50e7b18b046b3212e650943b4a1c981c96f699611b1f32097eae',      // Sold(uint256 indexed id, address indexed to, address indexed buyer, uint128 price)
  kept: '0x38f594ca806dd6ce2b91f6224c6b232cabf998685d3f4d40ad1aee78ba576354',      // Kept(uint256 indexed id, address indexed to, uint8 nonce)
};
const SELECTORS = {
  buy: '0xb645f70b',             // buy(uint256 id, address to, uint8 nonce, uint256 maxPrice, uint256 deadline)
  buyWithPermit: '0xb6367954',   // buyWithPermit(uint256 id, address to, uint8 nonce, uint256 maxPrice, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
  listings: '0xde74e57b',        // listings(uint256 id) -> (uint128 price, uint8 nonce)
  approve: '0x095ea7b3', balanceOf: '0x70a08231', allowance: '0xdd62ed3e', nonces: '0x7ecebe00',
};

const strip = (h) => String(h).replace(/^0x/i, '').toLowerCase();
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => strip(a).padStart(64, '0');
const num = (v) => { try { return Number(BigInt(v)); } catch { return NaN; } };    // a node's hex quantity as a number, NaN when it is not one
export const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a));
export const isId = (a) => /^0x[0-9a-fA-F]{64}$/.test(String(a));

// The leading zero bits of an address, as the pool and the market count them.
export function zeroBits(address) {
  const h = strip(address);
  let bits = 0;
  for (let i = 0; i < h.length; i++) {
    const n = parseInt(h[i], 16);
    if (n === 0) { bits += 4; continue; }
    bits += Math.clz32(n) - 28;
    break;
  }
  return bits;
}

// The shelf from the shop's logs (eth_getLogs for its address with the four topics above, in any order): each id's last word in block order stands. -> [{ id, vanity,
// nonce, price (a BigInt, TAC wei), bits, block }] for the ids that are for sale.
export function foldShelf(logs) {
  // a log with no block or index to place it by is not one a node gave: it is left out, and the rest still stand
  const placed = [];
  for (const l of Array.isArray(logs) ? logs : []) {
    const at = l ? num(l.blockNumber) * 1e6 + num(l.logIndex) : NaN;
    if (Number.isFinite(at)) placed.push({ l, at });
  }
  const shelf = new Map();
  for (const { l } of placed.sort((a, b) => a.at - b.at)) {
    const t = Array.isArray(l.topics) ? l.topics : [], id = t[1];
    if (!isId(id)) continue;
    const key = strip(id), data = strip(l.data || '0x');
    if (t[0] === TOPICS.listed && isAddress('0x' + strip(t[2] || '').slice(-40)) && data.length >= 128) {
      const vanity = '0x' + strip(t[2]).slice(-40), nonce = Number(BigInt('0x' + data.slice(0, 64))), price = BigInt('0x' + data.slice(64, 128));
      if (price > 0n && nonce <= 254) shelf.set(key, { id: '0x' + key, vanity, nonce, price, bits: zeroBits(vanity), block: num(l.blockNumber) });
    } else if (t[0] === TOPICS.unlisted || t[0] === TOPICS.sold || t[0] === TOPICS.kept) shelf.delete(key);
  }
  return [...shelf.values()];
}

// The rarest first, the cheaper first among equals.
export const sortShelf = (list) => [...list].sort((a, b) => b.bits - a.bits || (a.price < b.price ? -1 : a.price > b.price ? 1 : 0) || (a.id < b.id ? -1 : 1));

// An address as two parts for the page: its leading zero digits, and the rest. The whole address is always shown, never a shortened one.
export function addressParts(address, bits = zeroBits(address)) {
  const a = '0x' + strip(address), z = Math.min(Math.floor(bits / 4), 40);
  return { zeros: a.slice(0, 2 + z), rest: a.slice(2 + z) };
}
// TAC wei as text: whole TAC with grouping, and up to two decimals when under 100
export function tacText(wei) {
  const n = BigInt(wei), whole = n / 10n ** 18n, frac = (n % 10n ** 18n).toString().padStart(18, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const dec = whole < 100n ? frac.slice(0, 2).replace(/0+$/, '') : '';
  return dec ? `${grouped}.${dec}` : grouped;
}

// ---- the calls
export const buyData = ({ id, to, nonce, maxPrice, deadline }) => SELECTORS.buy + strip(id) + addrWord(to) + word(nonce) + word(maxPrice) + word(deadline);
export const buyWithPermitData = ({ id, to, nonce, maxPrice, deadline, v, r, s }) => SELECTORS.buyWithPermit + strip(id) + addrWord(to) + word(nonce) + word(maxPrice) + word(deadline) + word(v) + strip(r).padStart(64, '0') + strip(s).padStart(64, '0');
export const approveData = (spender, amount) => SELECTORS.approve + addrWord(spender) + word(amount);
export const listingsData = (id) => SELECTORS.listings + strip(id);
export const balanceOfData = (who) => SELECTORS.balanceOf + addrWord(who);
export const allowanceData = (owner, spender) => SELECTORS.allowance + addrWord(owner) + addrWord(spender);
export const noncesData = (who) => SELECTORS.nonces + addrWord(who);
// listings(id) -> { price, nonce }: price 0 means it is not for sale
export function decodeListing(hex) {
  const h = strip(hex || '');
  if (h.length < 128) return null;
  return { price: BigInt('0x' + h.slice(0, 64)), nonce: Number(BigInt('0x' + h.slice(64, 128)) & 0xffn) };
}
export const decodeWord = (hex) => { const h = strip(hex || ''); return h.length >= 64 ? BigInt('0x' + h.slice(0, 64)) : null; };

// What a refusal means to a buyer, by the selector of the error a node's check of the purchase returns (the shop's own, and the TAC transfer's).
const REFUSALS = {
  '0x665c1c57': 'That one was just sold or taken down.',                                // NotListed()
  '0xe8c1821f': 'Its price changed.',                                                  // ListingChanged()
  '0xf2e3adf8': 'Its price changed.',                                                  // PriceAboveMax()
  '0x203d82d8': 'This took too long to confirm.',                                      // Expired()
  '0x67a2cc26': 'That address cannot hold the token.',                                 // BadRecipient()
  '0x7939f424': 'The shop could not take the TAC from this account.',                  // TransferFromFailed(), TAC's transferFrom
};
export const refusalWords = (data) => REFUSALS[String(data || '').slice(0, 10).toLowerCase()] || null;

// What the shop would refuse for a recipient, said before anything is signed: nothing, itself, the market and TAC (a token sent there could never be moved).
export const badRecipient = (to) => { const a = isAddress(to) ? String(to).toLowerCase() : ''; return !a || a === SHOP || a === MARKET || a === TAC; };
