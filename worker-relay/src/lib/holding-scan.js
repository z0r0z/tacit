// An EVM pool's Transact events, read from its chain into the store as far as they are final, a bounded stretch at a time: a
// node that refuses a range is asked for less, a rate limit ends the stretch to resume next cycle, and the cursor only moves
// over blocks whose events are stored.
import { parseAbiItem } from 'viem';

const TRANSACT = parseAbiItem('event Transact(bytes32 indexed nf0, bytes32 indexed nf1, bytes32 outLeaf0, bytes32 outLeaf1, uint256 firstIndex, bytes32 newRoot, address recipient, int256 extAmount, address relayer, uint256 fee, bytes memo0, bytes memo1)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A node's refusal of a range ("block range", "more than 10000 results", "response size") is answered by asking for less; only a
// refusal of the caller ends the stretch.
const RANGE = /block range|range (?:is )?too|too large|too wide|more than [\d,]+ (?:results|logs)|response size|query returned|exceed\w* .*(?:range|results|size)/i;
export const rateLimited = (err) => {
  const text = `${err?.shortMessage || ''} ${err?.message || ''} ${err?.details || ''} ${err?.code ?? ''}`;
  return !RANGE.test(text) && /\brate\b|\b429\b|-32016|-32005|-32011|too many requests|capacity|request limit|limit reached|exceeded.*(?:quota|limit)/i.test(text);
};

export async function scanHoldingChain({ store, client, chainId, pool, deployBlock, confirmations = 12, span = 2000, maxSpan = 2000, budgetMs = 40000, pauseMs = 120, log = () => {}, now = () => Date.now() }) {
  const started = now();
  const head = Number(await client.getBlockNumber());
  const safe = head - confirmations;
  let cursor = store.loadHoldingCursor(chainId) ?? deployBlock - 1;
  let size = span, stored = 0;
  while (cursor < safe && now() - started < budgetMs) {
    const from = cursor + 1, to = Math.min(from + size - 1, safe);
    try {
      const logs = await client.getLogs({ address: pool, event: TRANSACT, fromBlock: BigInt(from), toBlock: BigInt(to) });
      stored += store.saveHoldingEvents(chainId, logs.map((l) => ({
        block: Number(l.blockNumber), logIndex: l.logIndex, firstIndex: l.args.firstIndex.toString(), outLeaf0: l.args.outLeaf0, outLeaf1: l.args.outLeaf1,
        nf0: l.args.nf0, nf1: l.args.nf1, newRoot: l.args.newRoot,
      })));
      store.saveHoldingCursor(chainId, to);
      cursor = to;
      size = Math.min(maxSpan, size * 2);
      if (pauseMs) await sleep(pauseMs);
    } catch (err) {
      if (rateLimited(err)) { log(`holding scan chain ${chainId}: rate limited at block ${from}, resuming next cycle`); break; }
      if (size > 50) { size = Math.max(50, Math.floor(size / 2)); continue; }
      log(`holding scan chain ${chainId}: blocks ${from}-${to} failed: ${err?.shortMessage || err?.message || err}`);
      break;
    }
  }
  return { head, safe, cursor, stored };
}
