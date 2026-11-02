// tacit.finance/assets: Tacit's own assets, each row leading to its page. A price is shown where there is one: TAC at the Precision pool, tETH at
// Chainlink's ETH and cBTC at its BTC (each is worth what it is made of), read once on arrival. Under them, the farms where liquidity earns TAC (farms.js).
import { ethCall, wordAt, now, usd, $ } from '/trade/util.js?cb=e53086bb';
import { showFarms } from '/assets/farms.js?cb=2ca11e5a';

const CHAINLINK = { eth: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', btc: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' };
const PRECISION_POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E';
const fresh = (x) => (x && wordAt(x, 3) > BigInt(now() - 6 * 3600) && wordAt(x, 1) > 0n ? Number(wordAt(x, 1)) / 1e8 : null);
const put = (id, v) => { const el = $(id); if (el && v != null) el.textContent = usd(v); };

const reads = Promise.allSettled([ethCall(PRECISION_POOL, '0x2af1f249'), ethCall(CHAINLINK.eth, '0xfeaf968c'), ethCall(CHAINLINK.btc, '0xfeaf968c')]).then((r) => r.map((x) => (x.status === 'fulfilled' ? x.value : null)));
showFarms(reads.then(([, eth, btc]) => ({ ethUsd: fresh(eth), btcUsd: fresh(btc) })));
const [pool, eth, btc] = await reads;
const ethUsd = fresh(eth), btcUsd = fresh(btc), root = pool ? Number(wordAt(pool, 0)) / 1e18 : 0;
put('#px-tac', ethUsd && root > 0 ? ethUsd / (root * root) : null);
put('#px-teth', ethUsd);
put('#px-cbtc', btcUsd);
