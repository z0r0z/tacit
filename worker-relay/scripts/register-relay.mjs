// Lists a relay in the relay registry (contracts/src/RelayRegistry.sol, on Ethereum): approves the stake, then registers the relay's url under its own key.
// Run it from the relay's own key: the registry lists whoever sends the call, so no one can list an address that is not theirs, and the relay's quote must
// name that same address or wallets will not use the entry.
//
//   cd worker-relay && npm ci
//   RELAY_KEY=0x… node scripts/register-relay.mjs --url https://relay.example/1/evm-pool/keeper --owner 0x…          every check, sends nothing
//   RELAY_KEY=0x… node scripts/register-relay.mjs --url https://relay.example/1/evm-pool/keeper --owner 0x… --send   the same, then the approval and the listing
//
//   --url      the relay's base URL: https, ending /evm-pool/keeper (the quote is read from <url>/quote). The relay must be running.
//   --owner    who holds the stake and gets it back (startExit, then finishExit after the delay): your own wallet, not the relay's hot key
//   --chain    the chain the relay serves (default 1: the registry lists relays for each chain id)
//   --key-file read the key from a file (one line, hex) instead of RELAY_KEY
//   --rpc      an Ethereum node (default https://ethereum-rpc.publicnode.com)
//   --registry the registry (default 0x00000000000299F48Fb844626ab96c6A20059a01)
//   --amount   the stake in whole TAC (default: the registry's minimum)
//
// The key is read inside this process and never printed. The relay's key needs the stake in TAC (the registry takes it from the key that lists) and a little
// ETH for two transactions.

import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits, formatEther, keccak256, encodeAbiParameters, parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const arg = (name, dflt = undefined) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const SEND = process.argv.includes('--send');
const RPC = arg('rpc', 'https://ethereum-rpc.publicnode.com');
const REGISTRY = arg('registry', '0x00000000000299F48Fb844626ab96c6A20059a01');
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const URL_ = arg('url'), OWNER = arg('owner'), CHAIN = BigInt(arg('chain', '1'));
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const must = (c, m) => { if (!c) { console.error('REFUSED:', m); process.exit(1); } };
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

must(URL_ && /^https:\/\/\S+\/evm-pool\/keeper$/.test(URL_), '--url: the relay\'s base URL, https, ending /evm-pool/keeper');
must(/^0x[0-9a-fA-F]{40}$/.test(OWNER || ''), '--owner: the address that holds the stake and gets it back');
const keyText = arg('key-file') ? readFileSync(arg('key-file'), 'utf8').trim() : (process.env.RELAY_KEY || '').trim();
must(/^(0x)?[0-9a-fA-F]{64}$/.test(keyText), 'the relay\'s key: RELAY_KEY=0x… or --key-file <path>');
const account = privateKeyToAccount(keyText.startsWith('0x') ? keyText : `0x${keyText}`);
must(!eq(OWNER, account.address), '--owner is the relay\'s own key: the stake should sit with an address that does not run on a server');

const abi = parseAbi([
  'function minStake() view returns (uint256)', 'function idOf(bytes32) view returns (uint256)',
  'function register(uint64 chainId, string url, address owner_, uint256 amount) returns (uint256)',
  'function relays(uint256) view returns (address relayer, uint64 chainId, uint32 pos, address owner, uint64 exitAt, uint256 stake)',
  'error BadUrl()', 'error BadChain()', 'error BadOwner()', 'error BelowMinimum()', 'error AlreadyListed()', 'error TokenTookAFee()',
  'error TransferFromFailed()',
]);
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const pub = createPublicClient({ chain: mainnet, transport: http(RPC) });

must((await pub.getChainId()) === 1, 'that node is not Ethereum mainnet');
must((await pub.getCode({ address: REGISTRY }))?.length > 2, `no registry at ${REGISTRY}`);
const minStake = await pub.readContract({ address: REGISTRY, abi, functionName: 'minStake' });
const amount = arg('amount') ? parseUnits(arg('amount'), 18) : minStake;
must(amount >= minStake, `the stake must be at least ${formatUnits(minStake, 18)} TAC`);
log(`registry ${REGISTRY}: minimum stake ${formatUnits(minStake, 18)} TAC; this listing stakes ${formatUnits(amount, 18)} TAC for ${account.address}, owned by ${OWNER}`);

// the relay has to be what it will be listed as: running at the url, and quoting this key's address
const quote = await (await fetch(`${URL_}/quote`, { signal: AbortSignal.timeout(15_000) })).json().catch(() => null);
must(quote && BigInt(quote.chainId) === CHAIN && eq(quote.relayer, account.address),
  `${URL_}/quote does not answer with chain ${CHAIN} and relayer ${account.address} (it says ${quote ? `chain ${quote.chainId}, relayer ${quote.relayer}` : 'nothing'}): start the relay with this key first`);
log(`the relay at ${URL_} quotes this key's address (fee ${quote.fee} wei)`);

const key = keccak256(encodeAbiParameters([{ type: 'uint64' }, { type: 'address' }], [CHAIN, account.address]));
const already = await pub.readContract({ address: REGISTRY, abi, functionName: 'idOf', args: [key] });
must(already === 0n, `this address is already listed for chain ${CHAIN} (entry ${already}); to change its url, the owner calls setUrl(${already}, url)`);

const [tac, eth, allowance, block] = await Promise.all([
  pub.readContract({ address: TAC, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] }),
  pub.getBalance({ address: account.address }),
  pub.readContract({ address: TAC, abi: tokenAbi, functionName: 'allowance', args: [account.address, REGISTRY] }),
  pub.getBlock(),
]);
log(`${account.address}: ${formatEther(eth)} ETH, ${formatUnits(tac, 18)} TAC`);
const tip = parseGwei('0.1'), maxFee = block.baseFeePerGas * 2n + tip;
must(eth > 500_000n * maxFee * 3n, 'the key needs a little ETH for two transactions');
must(maxFee < parseGwei('20'), 'gas is dear right now: try again later');
if (tac < amount) { log(`\nthe key holds ${formatUnits(tac, 18)} TAC and the stake is ${formatUnits(amount, 18)}. ${SEND ? 'NOT SENDING.' : 'Every other check passed; nothing sent.'}`); process.exit(SEND ? 1 : 0); }
if (allowance >= amount) await pub.simulateContract({ account, address: REGISTRY, abi, functionName: 'register', args: [CHAIN, URL_, OWNER, amount] });
if (!SEND) { log('\nevery check passed; nothing sent. Add --send to list the relay.'); process.exit(0); }

const wallet = createWalletClient({ account, chain: mainnet, transport: http(RPC) });
const send = async (label, req) => {
  const hash = await wallet.writeContract({ ...req, account, chain: mainnet, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 10 * 60_000 });
  log(`${label}: ${r.status} in block ${r.blockNumber} (${hash})`);
  must(r.status === 'success', `${label} reverted`);
};
if (allowance < amount) {
  await send('approve', { address: TAC, abi: tokenAbi, functionName: 'approve', args: [REGISTRY, amount] });
  // a node can still answer from the block before the approval: wait until it shows, or the check below reads a stale allowance and refuses
  for (let i = 0; i < 30 && (await pub.readContract({ address: TAC, abi: tokenAbi, functionName: 'allowance', args: [account.address, REGISTRY] })) < amount; i++) await sleep(2000);
}
await pub.simulateContract({ account, address: REGISTRY, abi, functionName: 'register', args: [CHAIN, URL_, OWNER, amount] });
await send('register', { address: REGISTRY, abi, functionName: 'register', args: [CHAIN, URL_, OWNER, amount] });

const id = await pub.readContract({ address: REGISTRY, abi, functionName: 'idOf', args: [key] });
const e = await pub.readContract({ address: REGISTRY, abi, functionName: 'relays', args: [id] });
must(id !== 0n && eq(e[0], account.address) && eq(e[3], OWNER) && e[5] === amount, 'the entry does not read back as asked');
log(`\nLISTED: entry ${id}, relayer ${e[0]}, chain ${e[1]}, stake ${formatUnits(e[5], 18)} TAC owned by ${e[3]}. Pages pick it up on their next visit.`);
log('To take the stake back: from the owner address call startExit(id), then finishExit(id) once the delay has passed (the registry\'s Etherscan page, Write Contract).');
