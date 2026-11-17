// What the vanity shop has on its shelf, and the calls a buyer makes to it (contracts/src/VanityShop.sol, deployed on Ethereum). The shelf is read from the shop's own
// events: a `Listed` puts an address up (or changes its price and nonce), and `Unlisted`, `Sold` and `Kept` take it down. Nothing here touches the page or the wallet.
export const SHOP = '0x00000000000785882df83d4cc6ed45c21eb1176c';
export const MARKET = '0x000000000000b361194cfe6312ee3210d53c15aa';
export const TAC = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279';
export const ROUTER = '0x000000000000fb114709235f1ccbffb925f600e4';       // zRouter, which the zap swaps through
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
  ownerOf: '0x6352211e',         // the market's ownerOf(uint256 id): reverts for a token that does not exist or was used
  addressOf: '0x11a800bc',       // the market's addressOf(uint256 id) -> the address the token stands for
  buyWithEth: '0x01d351d9',      // ShopZap's buyWithEth(bytes swapData, uint256 id, address to, uint8 nonce, uint256 maxPrice, uint256 deadline)
  deploy: '0x61ff715f',          // the market's deploy(uint256 id, bytes initcode) -> address: burns the token, deploys the code at the address it stands for
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

// What cannot be sent a token, said before anything is signed: nothing, the shop, the market and TAC (the shop refuses them), and the contracts it is bought through, the router
// and the zap (a token sent to any of them could never be moved).
export const badRecipient = (to) => { const a = isAddress(to) ? String(to).toLowerCase() : ''; return !a || a === SHOP || a === MARKET || a === TAC || a === ROUTER || (!!ZAP && a === String(ZAP).toLowerCase()); };

// ---- what the page shows around the list
// An address's leading zero digits, from its zero bits: the count a buyer and the market speak of.
export const zerosOf = (bits) => Math.floor(bits / 4);
export const zerosText = (n) => `${n} ${n === 1 ? 'zero' : 'zeros'}`;
// Dollars as text: cents under a hundred, whole dollars from there.
export const usdText = (n) => (n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);
// TAC's price in dollars from ETH's price in dollars and TAC's in ETH (null when either is missing), and what a listing's TAC comes to at it (null without one).
export const tacUsdFrom = ({ ethUsd, tacEth }) => (ethUsd > 0 && tacEth > 0 ? ethUsd * tacEth : null);
export const priceUsd = (wei, tacUsd) => (tacUsd > 0 ? (Number(BigInt(wei)) / 1e18) * tacUsd : null);
// The zero counts on the shelf, fewest first: the filter's choices.
export const zeroTiers = (shelf) => [...new Set(shelf.map((x) => zerosOf(x.bits)))].sort((a, b) => a - b);
// The part of the shelf a filter keeps: `zeros` a zero count (null for any), `q` text to find in the address, as hex digits with or without the 0x; anything else finds nothing.
export function filterShelf(shelf, { zeros = null, q = '' } = {}) {
  const t = String(q ?? '').replace(/\s+/g, '').replace(/^0x/i, '').toLowerCase();
  if (t !== '' && !/^[0-9a-f]+$/.test(t)) return [];
  return shelf.filter((x) => (zeros === null || zerosOf(x.bits) === zeros) && (t === '' || strip(x.vanity).includes(t)));
}

// ---- a bought token
// The token's id as the plain number Etherscan and the market's functions take, and the token's page.
export const tokenNumber = (id) => BigInt(id).toString();
export const tokenUrl = (id) => `https://etherscan.io/nft/${MARKET}/${tokenNumber(id)}`;
export const ownerOfData = (id) => SELECTORS.ownerOf + strip(id);
export const addressOfData = (id) => SELECTORS.addressOf + strip(id);
// A token id as a person types it, a decimal number or 0x and hex, -> the 32-byte id as '0x' and 64 hex digits (null when it is neither or is too big)
export function parseTokenId(text) {
  const t = String(text ?? '').trim().replace(/[\s_,]/g, '');
  const n = /^0x[0-9a-f]+$/i.test(t) ? BigInt(t) : /^\d+$/.test(t) ? BigInt(t) : null;
  return n !== null && n < 2n ** 256n ? '0x' + n.toString(16).padStart(64, '0') : null;
}
// The ids this shop sold to `who` (the Sold event's `to`), newest first, from the shop's logs. Whether one is still held is for the market to say (ownerOf).
export function soldTo(logs, who) {
  const w = strip(who || '');
  if (!/^[0-9a-f]{40}$/.test(w)) return [];
  const at = (l) => num(l.blockNumber) * 1e6 + num(l.logIndex);
  const seen = new Set();
  return (Array.isArray(logs) ? logs : []).filter((l) => l && l.topics?.[0] === TOPICS.sold && isId(l.topics[1]) && strip(l.topics[2] || '').slice(-40) === w && Number.isFinite(at(l)))
    .sort((a, b) => at(b) - at(a)).map((l) => '0x' + strip(l.topics[1])).filter((id) => !seen.has(id) && seen.add(id));
}

// The simplest contract there is for an address that only passes ETH on, and the code that deploys it. Its runtime sends its whole balance to one fixed address on every call and
// reverts when that send fails, so nothing is ever left in it:
//   5f 5f 5f 5f  PUSH0 x4 (no call data, no return data)   47  SELFBALANCE   73 <the address>  PUSH20   5a  GAS   f1  CALL
//   60 22 57  PUSH1 34, JUMPI (a send that worked jumps over the revert)   5f 5f fd  PUSH0 PUSH0 REVERT   5b  JUMPDEST (the end of the code stops it)
// 35 bytes. The creation code (60 23 80 60 09 5f 39 5f f3) copies those 35 bytes to memory and returns them. It takes no ETH of its own, answers any call, and has no way to
// change the address or to send anything but ETH: tokens sent to it stay in it.
export const forwarderRuntime = (to) => `0x5f5f5f5f4773${strip(to)}5af16022575f5ffd5b`;
export const forwarderInit = (to) => `0x60238060095f395ff3${forwarderRuntime(to).slice(2)}`;
// What stops an address from being the one ETH is passed on to, said before anything is signed: not an address, nothing (the empty address burns it), the bought address itself,
// and the shop, the market and TAC (contracts that would turn the ETH away). null when it is fine.
export function forwardRefusal(to, vanity) {
  if (!isAddress(to)) return 'Name the address to pass ETH on to.';
  const a = String(to).toLowerCase();
  if (/^0x0{40}$/.test(a)) return 'That is the empty address: whatever arrived would be lost.';
  if (vanity && a === String(vanity).toLowerCase()) return 'It cannot pass ETH on to itself.';
  if (badRecipient(a)) return 'It cannot pass ETH on to the shop, the market, TAC or the swap contracts.';
  return null;
}
// deploy(uint256 id, bytes initcode)
export function deployData(id, initcode) {
  const code = strip(initcode), pad = (64 - (code.length % 64)) % 64;
  return SELECTORS.deploy + strip(id) + word(64) + word(code.length / 2) + code + '0'.repeat(pad);
}
// the address a call returned (the last 20 bytes of its first word)
export const decodeAddress = (hex) => { const h = strip(hex || ''); return h.length >= 64 ? '0x' + h.slice(24, 64) : null; };
// Creation bytecode as typed or pasted: spaces and a 0x dropped, hex digits only, whole bytes, no more than the 49,152 the EVM takes. -> '0x…', or null
export function initcodeOf(text) {
  const t = String(text ?? '').replace(/\s+/g, '').replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]+$/.test(t) && t.length % 2 === 0 && t.length / 2 <= 49152 ? '0x' + t : null;
}
// What a refusal of the deploy means, by the error's selector: the market's own.
const DEPLOY_REFUSALS = {
  '0x30116425': 'That code does not deploy: it fails when it runs.',      // DeploymentFailed()
  '0x4b6e7f18': 'The wallet connected now does not hold this token.',     // NotOwnerNorApproved()
};
export const deployRefusal = (data) => DEPLOY_REFUSALS[String(data || '').slice(0, 10).toLowerCase()] || null;
// The market gives a constructor the whole balance of the address it deploys from, and anyone can send ETH there beforehand. Code that creates fine on its own, with nothing sent,
// but that the market says does not deploy, is that: a constructor that does not take ETH.
export const deployFailed = (data) => String(data || '').slice(0, 10).toLowerCase() === '0x30116425';
export const ETH_AT_DEPLOY_ADDRESS = 'Someone has sent ETH to the address this one is deployed from, and a constructor that does not take ETH fails when it has some. Make the constructor payable and try again.';

// ---- paying with ETH
// The deployed ShopZap (contracts/src/ShopZap.sol): it swaps the ETH sent to it into TAC through zRouter and buys the address with that TAC in the same transaction. It sits at an address
// bought from this shop, put there by the market's deploy with the creation code the shop page's own form takes (its source is verified on Etherscan and Sourcify). The page offers to
// pay with ETH only when this address holds code.
export const ZAP = '0x000000000110d317ed602ca7ef10a72bd72bd56f';
// A little over the price is asked of the swap, so that a small move of the pool before the transaction lands does not stop it; what is over comes back as TAC.
export const ZAP_MARGIN_BPS = 150n;
// Which of our two pools prices the swap into TAC, by the rule the front page's swap uses for ETH to TAC (evm-trade-venues.js route): the Precision pool unless the Tacit AMM pays over
// one percent more; whichever answered when only one did; null when neither paid. `skip` names venues that were tried and refused.
export function pickVenue(precision, tacit, skip = []) {
  const usable = (q) => (q && q.amountOut > 0n && !skip.includes(q.venue) ? q : null);
  const p = usable(precision), t = usable(tacit);
  if (!p || !t) return p || t;
  return p.amountOut * 100n >= t.amountOut * 99n ? p : t;
}
// buyWithEth(swapData, id, to, nonce, maxPrice, deadline)
export function buyWithEthData({ swapData, id, to, nonce, maxPrice, deadline }) {
  const sw = strip(swapData);
  return SELECTORS.buyWithEth + word(192) + strip(id) + addrWord(to) + word(nonce) + word(maxPrice) + word(deadline) + word(sw.length / 2) + sw + '0'.repeat((64 - (sw.length % 64)) % 64);
}
// The ETH to try next when `amountIn` bought `got` and `needed` is wanted: scaled up to it, and a wei over so that it never rounds short.
export const retryAmountIn = (amountIn, needed, got) => (BigInt(amountIn) * BigInt(needed)) / BigInt(got) + 1n;
// ETH as text: three decimals from 1, four from a thousandth, two significant figures under that.
export function ethText(wei) {
  const n = Number(BigInt(wei)) / 1e18;
  return n >= 1 ? n.toFixed(3) : n >= 0.001 ? n.toFixed(4) : n === 0 ? '0' : n.toPrecision(2);
}
