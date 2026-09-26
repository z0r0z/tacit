// A stub Ethereum JSON-RPC server, just faithful enough to drive worker-relay/src/replenish.js end to end.
//
// It answers the reads replenish makes (balances, ERC20 balanceOf/allowance/decimals, zQuoter.buildBestSwap)
// from a fixed scenario, accepts signed transactions, and RECORDS every one: who signed it, where it went,
// what it carried. The test then asserts on what the code actually sent rather than on what its source
// says it does — which is the only kind of check that catches a swap delivered to the wrong recipient.
//
// buildSwapAuto returns callData that is just a marker + the recipient it was asked to deliver to, so a
// recorded swap can be traced back to "who was this swap for".
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../worker-relay/package.json', import.meta.url));
const viem = await import(require.resolve('viem'));
const { encodeFunctionResult, decodeFunctionData, parseTransaction, keccak256, recoverTransactionAddress, toHex } = viem;

export async function startStub({ balances, tokenBalances, zQuoterAbi, addr, nonceRaceFor = [], badProveQuoteFactor = 0, badEthOutFactor = 0, badGasCostFactor = 0 }) {
  const sent = [];
  const raced = new Set(); // addresses that have already had their one injected 'nonce too low'
  const nonces = new Map();
  const lc = (a) => String(a).toLowerCase();
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const hexOf = (n) => '0x' + BigInt(n).toString(16);

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const handle = async ({ id, method, params }) => {
        try {
          switch (method) {
            case 'eth_chainId': return ok(id, '0x1');
            case 'net_version': return ok(id, '1');
            case 'eth_blockNumber': return ok(id, hexOf(24_000_000));
            case 'eth_gasPrice': return ok(id, hexOf(60_000_000));
            case 'eth_maxPriorityFeePerGas': return ok(id, hexOf(1_000_000));
            case 'eth_estimateGas': return ok(id, hexOf(250_000));
            case 'eth_getBlockByNumber': return ok(id, {
              number: hexOf(24_000_000), hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32),
              timestamp: hexOf(1_790_000_000), baseFeePerGas: hexOf(50_000_000), gasLimit: hexOf(30_000_000),
              gasUsed: '0x0', transactions: [], nonce: '0x0000000000000000', difficulty: '0x0', totalDifficulty: '0x0',
              miner: '0x' + '00'.repeat(20), extraData: '0x', logsBloom: '0x' + '00'.repeat(256), sha3Uncles: '0x' + '00'.repeat(32),
              stateRoot: '0x' + '00'.repeat(32), receiptsRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32), size: '0x0', uncles: [],
            });
            case 'eth_getBalance': return ok(id, hexOf(balances[lc(params[0])] ?? 0n));
            case 'eth_getTransactionCount': {
              const a = lc(params[0]); const n = nonces.get(a) ?? 0; return ok(id, hexOf(n));
            }
            case 'eth_call': {
              const { to, data } = params[0];
              const sel = data.slice(0, 10);
              if (lc(to) === lc(addr.zQuoter)) {
                const { functionName, args } = decodeFunctionData({ abi: zQuoterAbi, data });
                // Only the direct route quotes; the via-ETH hub route declines, so replenish keeps the direct one.
                if (functionName !== 'buildBestSwap') return ok(id, '0x');
                const [recipient, exactOut, tokenIn, tokenOut, amount] = args;
                const marker = '0xa11ce000' + (exactOut ? '01' : '00') + lc(recipient).slice(2).padStart(64, '0');
                // Realistic prices, so the code's own sanity checks are exercised rather than bypassed:
                // ETH $1840 (the static fallback the relay uses when no feed answers), stables $1, PROVE $0.25.
                const usdPerUnit = (t) => {
                  t = lc(t);
                  if (t === '0x0000000000000000000000000000000000000000') return 1840 / 1e18;
                  if (t === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' || t === '0xdac17f958d2ee523a2206206994597c13d831ec7') return 1e-6;
                  if (t === lc(addr.prove)) return 0.25 / 1e18;
                  if (t === '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0') return 1.2 * 1840 / 1e18; // wstETH ~ 1.2 stETH ~ 1.2 ETH
                  return 1e-18;
                };
                const inU = usdPerUnit(tokenIn), outU = usdPerUnit(tokenOut);
                // simulate a broken aggregator: dust quotes into PROVE, or into ETH (the wstETH->ETH case seen in production)
                const skew = (lc(tokenOut) === lc(addr.prove) && badProveQuoteFactor) ? badProveQuoteFactor
                  : (lc(tokenOut) === '0x0000000000000000000000000000000000000000' && lc(tokenIn) === '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0' && badEthOutFactor) ? badEthOutFactor : 1;
                // a broken EXACT-OUT quote: the aggregator asks far too much of the input asset for the ETH it sells
                const amountIn = exactOut ? BigInt(Math.ceil(Number(amount) * outU / inU * (badGasCostFactor || 1))) + 1n : amount;
                const amountOut = exactOut ? amount : BigInt(Math.floor(Number(amount) * inU / outU * skew));
                const out = encodeFunctionResult({
                  abi: zQuoterAbi, functionName: 'buildBestSwap',
                  result: [{ source: 1, feeBps: 30n, amountIn, amountOut }, marker, 0n, tokenIn === '0x0000000000000000000000000000000000000000' ? amount : 0n],
                });
                return ok(id, out);
              }
              if (sel === '0x70a08231') { // balanceOf(address)
                const owner = '0x' + data.slice(34, 74);
                return ok(id, '0x' + BigInt(tokenBalances[lc(to)]?.[lc(owner)] ?? 0n).toString(16).padStart(64, '0'));
              }
              if (sel === '0x035faf82') return ok(id, '0x' + (12n * 10n ** 17n).toString(16).padStart(64, '0')); // stEthPerToken() = 1.2e18
              if (sel === '0xdd62ed3e') return ok(id, '0x' + '0'.repeat(64)); // allowance -> 0, forces an approve
              if (sel === '0x313ce567') { // decimals: the stables are 6dp, everything else 18
                const six = ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7'].includes(lc(to));
                return ok(id, '0x' + (six ? 6 : 18).toString(16).padStart(64, '0'));
              }
              return ok(id, '0x');
            }
            case 'eth_sendRawTransaction': {
              const raw = params[0];
              const tx = parseTransaction(raw);
              const from = await recoverTransactionAddress({ serializedTransaction: raw });
              // Simulate losing a nonce race to another service signing with the same key: reject the FIRST send
              // from a chosen address, before broadcast, exactly as a node does.
              if (nonceRaceFor.map(lc).includes(lc(from)) && !raced.has(lc(from))) {
                raced.add(lc(from));
                return { jsonrpc: '2.0', id, error: { code: -32000, message: 'nonce too low: next nonce 5, tx nonce 4' } };
              }
              const hash = keccak256(raw);
              nonces.set(lc(from), (nonces.get(lc(from)) ?? 0) + 1);
              sent.push({ from: lc(from), to: lc(tx.to), value: tx.value ?? 0n, data: tx.data ?? '0x', hash });
              // A plain ETH transfer moves balance, so a later read sees it (replenish re-reads after forwarding).
              if ((tx.data ?? '0x') === '0x' && (tx.value ?? 0n) > 0n) {
                balances[lc(from)] = (balances[lc(from)] ?? 0n) - tx.value;
                balances[lc(tx.to)] = (balances[lc(tx.to)] ?? 0n) + tx.value;
              }
              return ok(id, hash);
            }
            case 'eth_getTransactionReceipt': {
              const t = sent.find((x) => x.hash === params[0]);
              if (!t) return ok(id, null);
              return ok(id, {
                transactionHash: t.hash, transactionIndex: '0x0', blockHash: '0x' + '11'.repeat(32), blockNumber: hexOf(24_000_000),
                from: t.from, to: t.to, cumulativeGasUsed: hexOf(100_000), gasUsed: hexOf(90_000), effectiveGasPrice: hexOf(51_000_000),
                logs: [], logsBloom: '0x' + '00'.repeat(256), status: '0x1', type: '0x2', contractAddress: null,
              });
            }
            default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `stub: ${method} not implemented` } };
          }
        } catch (e) { return { jsonrpc: '2.0', id, error: { code: -32000, message: `stub error in ${method}: ${e.message}` } }; }
      };
      const parsed = JSON.parse(body);
      const out = Array.isArray(parsed) ? await Promise.all(parsed.map(handle)) : await handle(parsed);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, sent, close: () => new Promise((r) => server.close(r)) };
}
