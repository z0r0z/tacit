// A private pool for any ERC-20 on Ethereum: the ETH pool's contract (TacitEvmPool, the same circuit, proving key and verifier) with the
// token as its asset, and its own router (TacitEvmPoolRouter: deposits by permit, Permit2 or an approval, deposit and receive boxes, and a
// withdrawal that runs a swap). Both sit at CREATE2 addresses CreateX gives them under open salts fixed by the token, so every page and
// the relay find a token's pool from the token alone, and anyone can open it: one transaction (Multicall3 calling CreateX twice) that
// whoever wants the pool first sends. What it creates is fixed by its init code (the creation code the live TAC pool and router were built
// from, dapp/evm-pool/token-pool-code.json, checked here against their init-code hashes), so whoever sends it, it is the same contract.
// TAC and the TAC vaults' synths have pools of their own already, at mined addresses (FIXED).
//
// `makeTokenPools({ code, keccak256, chain? })`: `code` is token-pool-code.json, `keccak256(bytes) → bytes`, and `chain` the chain's
// constants (TOKEN_POOL_CHAINS), Ethereum's when left out. The same token has a pool of its own on each chain, under salts of that chain.

export const CHAIN_ID = 1;
export const CREATEX = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const VERIFIER = '0x000000b1c0e84CEc8AdF8278B90c4d6400DfB153';
export const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const V1 = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
export const POSEIDON4 = '0x555333f3f677Ca3930Bf7c56ffc75144c51D9767';
const ZERO = '0x0000000000000000000000000000000000000000';
// What a token pool is built with on each chain: the constructor arguments of the live ETH pool and router there (as their immutables
// read), so a token pool on any chain is that chain's ETH pool and router with the token as the asset. V1 is on Ethereum alone: the
// routers on Base and Robinhood Chain were built with none (zero), which leaves their V1 wraps off; the rest is at the same address on all.
export const TOKEN_POOL_CHAINS = {
  1: { chainId: 1, verifier: VERIFIER, zRouter: ZROUTER, permit2: PERMIT2, v1: V1, poseidon4: POSEIDON4 },
  8453: { chainId: 8453, verifier: VERIFIER, zRouter: ZROUTER, permit2: PERMIT2, v1: ZERO, poseidon4: POSEIDON4 },
  4663: { chainId: 4663, verifier: VERIFIER, zRouter: ZROUTER, permit2: PERMIT2, v1: ZERO, poseidon4: POSEIDON4 },
};
export const KEEPERS = 'https://tacit-evm-pool-keepers.onrender.com';
// The relay's address for every Ethereum pool (the ETH pool's keeper sends for the token pools too).
export const RELAYER = '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0';
// CreateX's ContractCreation(address indexed newContract, bytes32 indexed salt): topic 2 is the guarded salt, here keccak256(salt).
export const CREATED_TOPIC = '0xb8fda7e00c6b06a2b54e58521bc5894fee35f1090e5a3bb6390bfe2b98b497f7';
export const SEL = { asset: '0x4800d97f', pool: '0x7535d246', deployCreate2: '0x26307668', aggregate3: '0x82ad56cb' };
// Pools opened before these salts, each with its own keeper route.
export const FIXED = {
  '0xa1313eb9f3a445606d9583bcac3ebeb56a858279': { id: '1-tac', pool: '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe', router: '0x000000fA029Eaf69840C1490Bf9AA6C094794D5a', from: 26201971 },
  '0xa0f6b02561c8ef08335b69ad25e022c0b342147c': { id: '1-tacd', pool: '0x0000007bDb91d1aa0b5D3106Fd1c44C784b33DBA', router: '0x000000e96fcFf90F220fa65F8b82C6114Cd1Cc30', from: 26201971 },
  '0x9de27883c5dc9db47be12e595d59b8f1abec8570': { id: '1-tace', pool: '0x00000091974fB81e7eBA4cF2Cb24869c00a9A1a1', router: '0x000000e66C32bEC739180A5eDeeB40A8225c5223', from: 26201971 },
};

// The tokens whose pools the relay serves once anyone opens them (and the only ones the swap page offers to open): the two dollars most held,
// deep enough on chain that the price its fees are taken at cannot be set by whoever opens the pool. Every other token's holders swap
// privately through the ETH pool (the zap), whose crowd a pool of their own would only split. The relay can be told of more
// (EVM_POOL_TOKEN_POOLS_ALLOW_<chainId>).
// Their addresses are what makeTokenPools derives (tests/evm-pool-tokens.test.mjs checks), here so a page can name them without the code.
// `maxRelayFee`: the most a wallet takes a relay's quote for (base units), about what the ETH pool's 0.05 ETH is.
export const SERVED = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { sym: 'USDC', dec: 6, maxRelayFee: 200_000_000n, pool: '0x6C0be904750Fe1b50cd7207cc94731642d99e908', router: '0xe77D82b9A7B686ADc5F31F4cb83286981AC55FE4' },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { sym: 'USDT', dec: 6, maxRelayFee: 200_000_000n, pool: '0x73872ceEaADd2C603BD057073D403f08DCB31EB9', router: '0x5650c850872bc89FC6E22CBB7a51b0e0DAC97198' },
};

const lc = (s) => String(s || '').toLowerCase();
const strip = (h) => String(h).replace(/^0x/, '');
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (h) => { const s = strip(h); return Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16)); };
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => lc(strip(a)).padStart(64, '0');
const padRight = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64);
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
// The keeper route of a token pool opened under these salts: the chain and the token's first ten hex digits (a name the relay's routes take).
export const keeperIdOf = (token, chainId = CHAIN_ID) => (Number(chainId) === CHAIN_ID && FIXED[lc(token)]?.id) || `${Number(chainId)}-x${lc(strip(token)).slice(0, 10)}`;

export function makeTokenPools({ code, keccak256, chain = TOKEN_POOL_CHAINS[CHAIN_ID] }) {
  if (!code?.pool || !code?.router || !code?.check) throw new Error('evm-pool-tokens: no creation code');
  const chainId = Number(chain?.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('evm-pool-tokens: a chain id');
  if (!isAddr(chain.verifier) || BigInt(chain.verifier) === 0n || ![chain.zRouter, chain.permit2, chain.v1, chain.poseidon4].every(isAddr)) {
    throw new Error(`evm-pool-tokens: chain ${chainId}'s verifier, zRouter, Permit2, V1 and Poseidon addresses`);
  }
  const k = (hex) => '0x' + hexOf(keccak256(bytesOf(hex)));
  const initsOf = (c) => ({
    pool: (token) => '0x' + strip(code.pool) + addrWord(c.verifier) + addrWord(token),
    router: (pool) => '0x' + strip(code.router) + [pool, c.zRouter, c.permit2, c.v1, c.poseidon4].map(addrWord).join(''),
  });
  // the code must rebuild the live TAC pool and router (on Ethereum, with Ethereum's arguments), or nothing it would open or find is the
  // pool it claims
  const eth = initsOf(TOKEN_POOL_CHAINS[CHAIN_ID]);
  if (k(eth.pool(code.check.asset)) !== lc(code.check.poolInitHash) || k(eth.router(code.check.pool)) !== lc(code.check.routerInitHash)) {
    throw new Error('evm-pool-tokens: the creation code does not rebuild the live TAC pool and router');
  }
  const { pool: poolInit, router: routerInit } = initsOf(chain);
  // TAC and the synths have their mined pools on Ethereum only
  const fixedOf = (token) => (chainId === CHAIN_ID ? FIXED[lc(token)] : undefined);
  const checksum = (a) => {
    const h = lc(strip(a)), d = hexOf(keccak256(new TextEncoder().encode(h)));
    return '0x' + [...h].map((c, i) => (parseInt(d[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
  };
  // 20 zero bytes and 0x00 (anyone may use it; CreateX guards it as keccak256(salt)), then eleven bytes fixed by the kind, chain and token
  const saltOf = (kind, token) => '0x' + '00'.repeat(21) + k('0x' + hexOf(new TextEncoder().encode(`tacit-evm-token-${kind}-v1`)) + word(chainId) + addrWord(token)).slice(2, 24);
  const create2 = (salt, init) => checksum('0x' + k('0xff' + strip(CREATEX) + strip(k(salt)) + strip(k(init))).slice(-40));

  // → { chainId, token, pool, router, poolSalt?, routerSalt?, poolGuard? (the salt as CreateX logs it), fixed, id, keeper }
  function poolOf(token) {
    if (!isAddr(token) || BigInt(token) === 0n) throw new Error('evm-pool-tokens: a token address');
    const f = fixedOf(token);
    if (f) return { chainId, token: checksum(token), pool: f.pool, router: f.router, fixed: true, from: f.from, id: f.id, keeper: `${KEEPERS}/${f.id}/evm-pool/keeper` };
    const poolSalt = saltOf('pool', token), pool = create2(poolSalt, poolInit(token));
    const routerSalt = saltOf('router', token), router = create2(routerSalt, routerInit(pool));
    const id = keeperIdOf(token, chainId);
    return { chainId, token: checksum(token), pool, router, poolSalt, routerSalt, poolGuard: k(poolSalt), fixed: false, id, keeper: `${KEEPERS}/${id}/evm-pool/keeper` };
  }
  // Whether `address` is the pool (or router) these salts give `token`: what a pool found on chain must be to be served or shown.
  const isPool = (token, address) => lc(poolOf(token).pool) === lc(address);
  const isRouter = (token, address) => lc(poolOf(token).router) === lc(address);

  const deployCall = (salt, init) => SEL.deployCreate2 + strip(salt) + word(64) + word(strip(init).length / 2) + padRight(strip(init));
  // The two deployments one by one, each a CreateX call of its own (the pool first: the router's constructor reads it), as a task's steps
  // send them. → [{ kind, to, data, salt, initCodeHash, expected }] for the pool and its router.
  function deploySteps(token) {
    const p = poolOf(token);
    if (p.fixed) return [];
    return [['pool', p.poolSalt, poolInit(p.token), p.pool], ['router', p.routerSalt, routerInit(p.pool), p.router]]
      .map(([kind, salt, init, expected]) => ({ kind, to: CREATEX, data: deployCall(salt, init), salt, initCodeHash: k(init), expected }));
  }
  // The transaction that opens the token's pool: both contracts in one Multicall3 call, or only the router when the pool is there already
  // (a CreateX deploy of one that exists reverts, so only what is missing is sent). `have`: { pool, router } as found on chain.
  // → { to, data, value: 0n, gas } or null when both exist.
  function openTx(token, have = { pool: false, router: false }) {
    const p = poolOf(token);
    if (p.fixed) return null;
    if (have.pool && have.router) return null;
    if (have.pool) return { to: CREATEX, data: deployCall(p.routerSalt, routerInit(p.pool)), value: 0n, gas: 3_900_000n };
    const calls = [deployCall(p.poolSalt, poolInit(p.token)), deployCall(p.routerSalt, routerInit(p.pool))];
    // aggregate3((address target, bool allowFailure, bytes callData)[]): each tuple holds bytes, so the array is of offsets
    const tuples = calls.map((d) => addrWord(CREATEX) + word(0) + word(96) + word(strip(d).length / 2) + padRight(strip(d)));
    let off = 32 * tuples.length;
    const heads = tuples.map((t) => { const h = word(off); off += t.length / 2; return h; });
    return { to: MULTICALL3, data: SEL.aggregate3 + word(32) + word(calls.length) + heads.join('') + tuples.join(''), value: 0n, gas: 5_200_000n };
  }
  return { chainId, poolOf, isPool, isRouter, openTx, deploySteps, poolInit, routerInit, saltOf };
}

// Whether a token's pool and router are on chain: `ethCall(to, data)` → the hex a view returns ('0x' or a revert where there is none).
// The pool answers ASSET() with the token, the router POOL() with the pool: both asked in one read (Multicall3's aggregate3, each call
// allowed to fail), or one by one where that read gives nothing. → { pool: bool, router: bool }
export async function poolState(tp, token, ethCall) {
  const p = tp.poolOf(token), is = (r, want) => r.length >= 64 && r.slice(24, 64) === lc(strip(want));
  const asks = [[p.pool, SEL.asset, p.token], [p.router, SEL.pool, p.pool]];
  try {
    const got = decodeAggregate3(strip(await ethCall(MULTICALL3, encodeAggregate3(asks.map(([to, data]) => [to, data])))));
    if (got?.length === 2) return { pool: got[0].ok && is(got[0].data, p.token), router: got[1].ok && is(got[1].data, p.pool) };
  } catch { /* one by one, below */ }
  // a revert means there is no such contract function here; a node that failed to answer says nothing of the pool, so that is thrown, not read as "not open"
  const ask = async (to, data, want) => { try { return is(strip(await ethCall(to, data)), want); } catch (e) { if (/revert|execution|invalid opcode|out of gas/i.test(String(e?.message || e))) return false; throw e; } };
  const [pool, router] = await Promise.all(asks.map(([to, data, want]) => ask(to, data, want)));
  return { pool, router };
}

// aggregate3((address target, bool allowFailure, bytes callData)[]) for short calls, each allowed to fail
export function encodeAggregate3(calls) {
  const tuples = calls.map(([to, data]) => { const d = strip(data); return addrWord(to) + word(1) + word(96) + word(d.length / 2) + padRight(d); });
  let off = 32 * tuples.length;
  const heads = tuples.map((t) => { const h = word(off); off += t.length / 2; return h; });
  return SEL.aggregate3 + word(32) + word(calls.length) + heads.join('') + tuples.join('');
}
// its answer, (bool success, bytes returnData)[] → [{ ok, data (hex, no 0x) }], or null when it is not one
export function decodeAggregate3(r) {
  const at = (byte) => BigInt('0x' + (r.slice(byte * 2, byte * 2 + 64) || 'x'));
  try {
    const base = Number(at(0)), n = Number(at(base)), out = [];
    for (let i = 0; i < n; i++) {
      const el = base + 32 + Number(at(base + 32 + 32 * i)), len = Number(at(el + Number(at(el + 32))));
      const from = (el + Number(at(el + 32)) + 32) * 2;
      out.push({ ok: at(el) === 1n, data: r.slice(from, from + len * 2) });
    }
    return out;
  } catch { return null; }
}
