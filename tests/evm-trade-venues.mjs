#!/usr/bin/env node
// Cross-checks dapp/evm-trade-venues.js's hand-rolled calldata encoders/decoders against an
// independent ABI oracle (`cast calldata`/`cast abi-encode`, foundry). zSwap ships as immutable
// page code and can't be imported, so its encoders were ported by re-deriving each function's
// argument layout from its output shape, then confirming byte-for-byte against `cast` here — this
// is the pin the plan called for. Selectors themselves are asserted against the exact values
// zfi-f3 gave us from zSwap.html/live mainnet (not re-derived), since a selector is just a fixed
// 4-byte prefix; only the ARGUMENT BODY encoding is what a wrong layout could get wrong.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  ZERO_ADDR, TAC_ERC20, TAC_POOL_ASSET_ID, CETH_POOL_ASSET_ID,
  ZROUTER, ZQUOTER_V2, PRECISION_ROUTE, PRECISION_LENS, PRECISION_POLICY, PRECISION_GUARD,
  PRECISION_POOL, TACIT_AMM, TACIT_AMM_TIERS, TACIT_AMM_UNIT_SCALE, BOARD_V2, BOARD_V1, BOARD_VIEW,
  BOARD_SWAP_BOL, MULTICALL3, VENUES,
  makeEvmTradeVenues, zswapDeepLink, encErc20Allowance, encErc20Approve, encErc20BalanceOf, decUint256,
  _internal,
} from '../dapp/evm-trade-venues.js';
import { encodeAggregate3, decodeAggregate3 } from '../tools/airdrop-snapshot.mjs';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const body = (calldata) => '0x' + calldata.slice(10); // strip the 4-byte selector, keep the ABI-encoded body
const cast = (...args) => execFileSync('cast', args, { encoding: 'utf8' }).trim();

// Decodes a zRouter.multicall(bytes[]) call back into its individual leg calldatas — the mirror of
// encZRouterMulticall, used only so tests can assert on the ACTUAL composed transaction (every leg
// present, each one snwap-shaped, targeting the right executor) instead of just build()'s top-level
// {to,value,approval}. This is what would have caught the guard/checkpoint-leg wrapping bug: those
// legs must themselves be snwap() calls into GUARD/PROUTE, not raw calldata to those contracts —
// zRouter has no such functions of its own to delegatecall into.
function decodeZRouterMulticall(dataHex) {
  const h = strip0xTest(dataHex).slice(8);
  const nLegs = Number(BigInt('0x' + h.slice(64, 128)));
  const legs = [];
  for (let i = 0; i < nLegs; i++) {
    const off = Number(BigInt('0x' + h.slice((2 + i) * 64, (3 + i) * 64))) / 32;
    const elemStart = 2 + off; // offsets are relative to word 2 (right after the array-length word)
    const len = Number(BigInt('0x' + h.slice(elemStart * 64, (elemStart + 1) * 64)));
    legs.push('0x' + h.slice((elemStart + 1) * 64, (elemStart + 1) * 64 + len * 2));
  }
  return legs;
}
function strip0xTest(h) { return String(h).replace(/^0x/, ''); }
// An snwap(address,uint256,address,address,uint256,address,bytes) call's `executor` (6th static word).
function snwapExecutor(legData) {
  assert.equal(legData.slice(2, 10), '5f3bd1c8', `expected an snwap() leg, got selector ${legData.slice(2, 10)}`);
  const argsStart = 10; // '0x' (2 chars) + the 4-byte selector (8 chars)
  return '0x' + legData.slice(argsStart + 5 * 64 + 24, argsStart + 6 * 64); // executor is the 6th static word (index 5)
}

const A1 = '0x1111111111111111111111111111111111111111';
const A2 = '0x2222222222222222222222222222222222222222';
const A3 = '0x3333333333333333333333333333333333333333';
const A4 = '0x4444444444444444444444444444444444444444';
const B32 = '0x' + 'ab'.repeat(32);

// ── selectors: pinned to the exact values reported live (zfi-f3, zSwap e650437 / mainnet eth_call) ──
{
  assert.equal(ZROUTER.toLowerCase(), '0x000000000000fb114709235f1ccbffb925f600e4');
  assert.equal(ZQUOTER_V2.toLowerCase(), '0x000000bd2db80567c23e353ca95a251c573cbf9b');
  assert.equal(PRECISION_ROUTE.toLowerCase(), '0x0000007be74558a1f8c9045301c6f44c8ed0c9eb'.toLowerCase());
  assert.equal(TACIT_AMM.toLowerCase(), '0x00000000e36c7ec997cc59dcda9e03673b448119');
  assert.equal(TACIT_AMM_TIERS.join(','), '30,5,100,1');
  assert.equal(TACIT_AMM_UNIT_SCALE, 10n ** 10n);
  ok('addresses/tiers match the values confirmed against zSwap + mainnet');
}

// ── encAggregate3 / decAggregate3 vs. the already-shipped tools/airdrop-snapshot.mjs implementation ──
{
  const calls = [{ to: A1, data: '0xdeadbeef' }, { to: A2, data: '0xcafe' }];
  const mine = _internal.encAggregate3(calls);
  const oracle = encodeAggregate3(calls.map((c) => ({ target: c.to, data: c.data })));
  assert.equal(mine, oracle);
  ok('encAggregate3 matches tools/airdrop-snapshot.mjs byte-for-byte');

  const oracleBody = body(cast('calldata', 'dummy((address,bool,bytes)[])',
    `[(${A1},true,0xdeadbeef),(${A2},true,0xcafe)]`));
  assert.equal(body(mine), oracleBody);
  ok('encAggregate3 body matches an independent cast ABI encoding of the same (address,bool,bytes)[] shape');

  const ret = cast('abi-encode', 'f((bool,bytes)[])', '[(true,0xdeadbeef),(false,0x)]');
  const decMine = _internal.decAggregate3(ret, 2);
  const decOracle = decodeAggregate3(ret);
  assert.deepEqual(decMine, decOracle.map((r) => (r.success ? r.data : null)));
  assert.deepEqual(decMine, ['0xdeadbeef', null]);
  ok('decAggregate3 matches tools/airdrop-snapshot.mjs and decodes success/failure + bytes correctly');
}

// ── route / snwap / checkpoint / zRouter multicall / TacitPublicAmm — dynamic + static encoders ──
{
  const mine = _internal.encPrecisionRoute({ tokenIn: A2, tokenOut: A3, amountIn: 1000n, minOut: 900n, to: A4, pools: [A1] });
  const oracle = cast('calldata', 'route(address[],address,address,uint256,uint256,address)',
    `[${A1}]`, A2, A3, '1000', '900', A4);
  assert.equal(mine, oracle);
  ok('encPrecisionRoute matches an independently-encoded route(address[],address,address,uint256,uint256,address) call');

  const snwapMine = _internal.encSnwap({ tokenIn: A2, amountIn: 1000n, recipient: A3, tokenOut: A4, minOut: 900n, executor: A1, data: '0xdeadbeef' });
  const snwapOracle = cast('calldata', 'snwap(address,uint256,address,address,uint256,address,bytes)',
    A2, '1000', A3, A4, '900', A1, '0xdeadbeef');
  assert.equal(snwapMine, snwapOracle);
  ok('encSnwap matches snwap(address,uint256,address,address,uint256,address,bytes)');

  const guardMine = _internal.encGuardDeadline(1234n);
  const guardOracle = cast('calldata', 'deadline(uint256,address)', '1234', ZROUTER);
  assert.equal(guardMine, guardOracle);
  ok('encGuardDeadline matches deadline(uint256,address) with ZROUTER as the allowed executor');

  const mcMine = _internal.encZRouterMulticall(['0xdeadbeef', '0xcafe']);
  const mcOracle = cast('calldata', 'multicall(bytes[])', '[0xdeadbeef,0xcafe]');
  assert.equal(mcMine, mcOracle);
  ok('encZRouterMulticall matches the standard multicall(bytes[]) encoding');

  const tqMine = _internal.encTacitQuote({ assetIn: B32, assetOut: TAC_POOL_ASSET_ID, feeBps: 30, amountIn: 12345n });
  const tqOracle = cast('calldata', 'quoteSwap(bytes32,bytes32,uint32,uint256)', B32, TAC_POOL_ASSET_ID, '30', '12345');
  assert.equal(body(tqMine), body(tqOracle));
  ok('encTacitQuote body matches quoteSwap(bytes32,bytes32,uint32,uint256)');

  const tsMine = _internal.encTacitSwap({ assetIn: B32, assetOut: TAC_POOL_ASSET_ID, feeBps: 30, amountIn: 12345n, minOut: 100n, deadline: 999n, to: A1 });
  const tsOracle = cast('calldata', 'swapPublic(bytes32,bytes32,uint32,uint256,uint256,uint64,address)',
    B32, TAC_POOL_ASSET_ID, '30', '12345', '100', '999', A1);
  assert.equal(body(tsMine), body(tsOracle));
  ok('encTacitSwap body matches swapPublic(bytes32,bytes32,uint32,uint256,uint256,uint64,address)');
}

// ── buildBestSwap: input encoding + decoding a synthetic (Quote,bytes,uint256,uint256) return ──
{
  const bbsMine = _internal.encBuildBestSwap({ to: A1, exactOut: false, tokenIn: ZERO_ADDR, tokenOut: TAC_ERC20, amount: 10n ** 16n, slippageBps: 100n, deadline: 999n });
  const bbsOracle = cast('calldata', 'buildBestSwap(address,bool,address,address,uint256,uint256,uint256)',
    A1, 'false', ZERO_ADDR, TAC_ERC20, (10n ** 16n).toString(), '100', '999');
  assert.equal(body(bbsMine), body(bbsOracle));
  ok('encBuildBestSwap body matches buildBestSwap(address,bool,address,address,uint256,uint256,uint256)');

  const fakeReturn = cast('abi-encode', 'f((uint8,uint256,uint256,uint256),bytes,uint256,uint256)',
    '(3,30,1000000000000000,17700000000000000000000)', '0xfeedface', '17345000000000000000000', '1000000000000000');
  const decoded = _internal.decBuildBestSwap(fakeReturn);
  assert.equal(decoded.amountOut, 17700000000000000000000n);
  assert.equal(decoded.feeBps, 30n);
  assert.equal(decoded.callData, '0xfeedface');
  assert.equal(decoded.amountLimit, 17345000000000000000000n);
  assert.equal(decoded.msgValue, 1000000000000000n);
  ok('decBuildBestSwap correctly extracts amountOut/feeBps/callData/amountLimit/msgValue from a synthetic return');

  assert.equal(_internal.decBuildBestSwap(null), null);
  assert.equal(_internal.decBuildBestSwap('0x'), null);
  ok('decBuildBestSwap fails closed on empty/short returndata (a revert, not a zero quote)');
}

// ── quoteBest decode (address, uint256) ──
{
  const fake = cast('abi-encode', 'f(address,uint256)', A1, '4242');
  const decoded = _internal.decQuoteBest(fake);
  assert.equal(decoded.pool.toLowerCase(), A1.toLowerCase());
  assert.equal(decoded.amountOut, 4242n);
  ok('decQuoteBest extracts (pool, amountOut) from a synthetic PrecisionPoolLens.quoteBest return');

  const zeroPool = cast('abi-encode', 'f(address,uint256)', ZERO_ADDR, '4242');
  assert.equal(_internal.decQuoteBest(zeroPool), null, 'a zero pool address (no pool found) must decode to null, not a phantom quote');
  ok('decQuoteBest treats a zero pool address as no-quote');
}

// ── ERC20 helpers ──
{
  const allow = encErc20Allowance(A1, A2);
  const allowOracle = cast('calldata', 'allowance(address,address)', A1, A2);
  assert.equal(allow, allowOracle);
  const appr = encErc20Approve(A2, 5000n);
  const apprOracle = cast('calldata', 'approve(address,uint256)', A2, '5000');
  assert.equal(appr, apprOracle);
  const balOf = encErc20BalanceOf(A1);
  const balOfOracle = cast('calldata', 'balanceOf(address)', A1);
  assert.equal(balOf, balOfOracle);
  ok('ERC20 allowance/approve/balanceOf encoders match standard ABI encoding');

  const balReturn = cast('abi-encode', 'f(uint256)', '99999');
  assert.equal(decUint256(balReturn), 99999n);
  assert.equal(decUint256(null), 0n);
  ok('decUint256 decodes a plain uint256 return and fails safe to 0n on no data');
}

// ── decCandidateCount: the board's `candidates()` return puts the array behind whatever the
// function's other return values push its offset to — SBVIEW's real shape puts one static uint
// before it (offset 64, not the "offset 32" a lone array return would have), so a naive
// fixed-word-index read undercounts. Cover both shapes. ──
{
  const soleArray = cast('abi-encode', 'f(uint256[])', '[]');
  assert.equal(_internal.decCandidateCount(soleArray), 0);
  // A leading static return (offset 64, not 32) with a NON-empty array: a fixed-word-index reader
  // would misread the static field (99) as the count. It must read 3 (the real length), not 99.
  const withExtraWord = cast('abi-encode', 'f(uint256[],uint256)', '[1,2,3]', '99');
  assert.equal(_internal.decCandidateCount(withExtraWord), 3, 'a leading static return value must not be misread as the array length');
  ok('decCandidateCount reads the array length at its actual offset, not a hardcoded word index');
}

// ── alignDown: TacitPublicAmm's 1e10 granularity rule ──
{
  assert.equal(_internal.alignDown(10n ** 16n, TACIT_AMM_UNIT_SCALE), 10n ** 16n, 'an exact multiple stays unchanged');
  assert.equal(_internal.alignDown(10n ** 16n + 1n, TACIT_AMM_UNIT_SCALE), 10n ** 16n, 'dust below the 1e10 grain is floored off');
  assert.equal(_internal.alignDown(5n, TACIT_AMM_UNIT_SCALE), 0n, 'an amount smaller than one grain aligns to zero');
  ok('alignDown floors to the Tacit AMM\'s 1e10 unit scale');
}

// ── zswapDeepLink ──
{
  const eth2tac = zswapDeepLink({ host: 'https://zswap.example', dir: 'ETH_TO_TAC', amount: '0.01' });
  assert.equal(eth2tac, `https://zswap.example/#token=ETH&out=${TAC_ERC20}&amount=0.01`);
  const tac2eth = zswapDeepLink({ host: 'https://zswap.example/', dir: 'TAC_TO_ETH' });
  assert.equal(tac2eth, `https://zswap.example/#token=${TAC_ERC20}&out=ETH`);
  assert.equal(zswapDeepLink({ host: null, dir: 'ETH_TO_TAC' }), null, 'no host configured (not yet confirmed) means no link, not a guessed one');
  ok('zswapDeepLink builds the confirmed #token=/out=/amount= hash shape and omits itself with no host');
}

// ── quoteAll / build against a scripted ethCall (no network) ──
{
  // A minimal ethCall stub: routes by `to` + a thin sniff of the selector, so quoteAll's shape
  // (which calls land in Multicall3 vs. which go raw) is exercised without a real RPC.
  const calls = { agg3: 0 };
  // Decode an aggregate3 CALL (the mirror image of _internal.decAggregate3, which decodes its
  // RETURN) back into individual (to,data) sub-calls, purely so this stub can answer each one by
  // address+selector without hardcoding call order or count — quoteAll fires its Precision, Tacit
  // AMM and boards batches concurrently, so their arrival order isn't guaranteed.
  function decodeAggregate3Call(data) {
    const h = body(data).slice(2);
    const n = Number(BigInt('0x' + h.slice(64, 128)));
    const subs = [];
    for (let i = 0; i < n; i++) {
      const w = 2 + Number(BigInt('0x' + h.slice((2 + i) * 64, (3 + i) * 64))) / 32;
      const to2 = '0x' + h.slice(w * 64 + 24, w * 64 + 64);
      const boWords = Number(BigInt('0x' + h.slice((w + 2) * 64, (w + 3) * 64))) / 32;
      const lenWordIdx = w + boWords;
      const len = Number(BigInt('0x' + h.slice(lenWordIdx * 64, (lenWordIdx + 1) * 64)));
      const d2 = '0x' + h.slice((lenWordIdx + 1) * 64, (lenWordIdx + 1) * 64 + len * 2);
      subs.push({ to: to2, data: d2 });
    }
    return subs;
  }
  const word30 = () => (30n).toString(16).padStart(64, '0');
  async function ethCall(to, data) {
    if (to.toLowerCase() === MULTICALL3.toLowerCase()) {
      calls.agg3++;
      const subs = decodeAggregate3Call(data);
      const rets = subs.map((c) => {
        if (c.to.toLowerCase() === PRECISION_LENS.toLowerCase() && c.data.slice(2, 10) === '2adaa389') {
          return cast('abi-encode', 'f(address,uint256)', PRECISION_POOL, '17700000000000000000000');
        }
        if (c.to.toLowerCase() === PRECISION_LENS.toLowerCase() && c.data.slice(2, 10) === 'ef66de32') {
          return cast('abi-encode', 'f(uint256)', '30');
        }
        if (c.to.toLowerCase() === PRECISION_POLICY.toLowerCase()) {
          return cast('abi-encode', 'f(bool[])', '[true]');
        }
        if (c.to.toLowerCase() === TACIT_AMM.toLowerCase()) {
          // Only the 30bps tier is founded — every other tier call reverts (null), same as live.
          return c.data.includes(word30()) ? cast('abi-encode', 'f(uint256)', '694000000000000000000') : null;
        }
        if (c.to.toLowerCase() === BOARD_VIEW.toLowerCase()) {
          return cast('abi-encode', 'f(uint256[])', '[]'); // no resting orders
        }
        return null;
      });
      return encodeReturnsForBatch(rets);
    }
    if (to.toLowerCase() === ZQUOTER_V2.toLowerCase()) {
      const e = new Error('execution reverted: custom error 0x6586e129');
      throw e;
    }
    throw new Error(`unexpected ethCall to ${to}`);
  }
  // Wrap returned bytes-or-null values into a (bool,bytes)[] aggregate3 return.
  function encodeReturnsForBatch(rets) {
    const tuples = rets.map((r) => (r == null ? '(false,0x)' : `(true,${r})`));
    return cast('abi-encode', 'f((bool,bytes)[])', `[${tuples.join(',')}]`);
  }

  const venues = makeEvmTradeVenues({ ethCall });
  const result = await venues.quoteAll({ dir: 'ETH_TO_TAC', amountIn: 10n ** 16n, account: A1, includeZQuoter: true });
  // quotePrecision issues two sequential batches (quoteBest, then effFee+routable), quoteTacitAmm
  // and quoteBoards one each — 4 Multicall3 round-trips total; zQuoter never goes through one.
  assert.equal(calls.agg3, 4, 'precision (x2) + tacit-amm + boards batch through Multicall3; zQuoter never does');
  assert.ok(result.precision && result.precision.amountOut === 17700000000000000000000n);
  assert.ok(result.tacitAmm && result.tacitAmm.amountOut === 694000000000000000000n);
  assert.equal(result.zquoter.status, 'no-route');
  assert.equal(result.best.venue, VENUES.PRECISION, 'the band beats the shallow Tacit tier at this size, exactly like the live comparison zfi ran');
  ok('quoteAll batches the cheap views through Multicall3, keeps zQuoter raw, and ranks the band above the Tacit AMM');

  // A slow/misbehaving RPC answering zQuoter's heavy-gas raw call (observed: 15s+ against
  // 1rpc.io) must never hold back the whole quote — Precision/Tacit AMM are always ready
  // within ~1-2s and shouldn't wait on a venue that's usually going to say "no route" anyway.
  {
    const slowEthCall = (to, data, block, opts) => {
      if (to.toLowerCase() === ZQUOTER_V2.toLowerCase()) return new Promise((r) => setTimeout(() => r(null), 60000));
      return ethCall(to, data, block, opts);
    };
    const slowVenues = makeEvmTradeVenues({ ethCall: slowEthCall });
    const t0 = Date.now();
    const slowResult = await slowVenues.quoteAll({ dir: 'ETH_TO_TAC', amountIn: 10n ** 16n, account: A1, includeZQuoter: true });
    const elapsedMs = Date.now() - t0;
    assert.ok(elapsedMs < 5000, `expected quoteAll to return within the ~4s zQuoter budget, took ${elapsedMs}ms`);
    assert.equal(slowResult.zquoter.status, 'timeout');
    assert.equal(slowResult.best.venue, VENUES.PRECISION, 'the other venues still resolve normally despite zQuoter timing out');
  }
  ok('quoteAll caps a stuck zQuoter probe to its own budget instead of blocking the whole quote');

  const built = venues.build({ quote: result.best, dir: 'ETH_TO_TAC', account: A1, slippageBps: 50 });
  assert.equal(built.to.toLowerCase(), ZROUTER.toLowerCase());
  assert.equal(built.value, 10n ** 16n);
  assert.equal(built.approval, null, 'a native-ETH-in Precision leg needs no ERC20 approval');
  {
    const legs = decodeZRouterMulticall(built.data);
    assert.equal(legs.length, 2, 'native-ETH-in Precision: [guard, route] — no checkpoint leg needed (nothing else can spend msg.value mid-tx)');
    assert.equal(snwapExecutor(legs[0]).toLowerCase(), PRECISION_GUARD.toLowerCase(), 'leg 0 must be an snwap() INTO the guard contract, not raw calldata targeting it directly (zRouter has no deadline() of its own)');
    assert.equal(snwapExecutor(legs[1]).toLowerCase(), PRECISION_ROUTE.toLowerCase(), 'leg 1 must be an snwap() into the Precision route executor');
  }
  ok('build() assembles a native-ETH Precision leg targeting zRouter with the full amount as msg.value, both inner legs correctly snwap-wrapped');

  // ETH-in Tacit AMM: build() must route through zRouter's snwap (so the trade also earns zRouter
  // points, per zfi), not a direct AMM call.
  const tacitBuilt = venues.build({ quote: result.tacitAmm, dir: 'ETH_TO_TAC', account: A1, slippageBps: 50 });
  assert.equal(tacitBuilt.to.toLowerCase(), ZROUTER.toLowerCase());
  assert.equal(tacitBuilt.value, result.tacitAmm.amountIn);
  assert.equal(tacitBuilt.approval, null);
  ok('build() routes an ETH-in Tacit AMM leg through zRouter.snwap rather than calling the AMM directly');

  // A floor the caller already showed the user rides into the calldata as given; without one it is
  // derived from the quote and the slippage.
  {
    const word64 = (v) => v.toString(16).padStart(64, '0');
    const derived = (result.best.amountOut * 9950n) / 10000n;
    const reviewed = (result.best.amountOut * 9000n) / 10000n;
    const plain = venues.build({ quote: result.best, dir: 'ETH_TO_TAC', account: A1, slippageBps: 50 });
    const pinned = venues.build({ quote: result.best, dir: 'ETH_TO_TAC', account: A1, slippageBps: 50, minOut: reviewed });
    assert.ok(plain.data.includes(word64(derived)) && !plain.data.includes(word64(reviewed)), 'no floor given: derived from the quote');
    assert.ok(pinned.data.includes(word64(reviewed)) && !pinned.data.includes(word64(derived)), 'the reviewed floor is the one sent');
    const tacitFloor = (result.tacitAmm.amountOut * 9000n) / 10000n;
    const tacitPinned = venues.build({ quote: result.tacitAmm, dir: 'ETH_TO_TAC', account: A1, slippageBps: 50, minOut: tacitFloor });
    assert.ok(tacitPinned.data.includes(word64(tacitFloor)), 'the Tacit AMM leg takes it too');
    assert.throws(() => venues.build({ quote: result.best, dir: 'ETH_TO_TAC', account: A1, slippageBps: 50, minOut: result.best.amountOut + 1n }), /minOut/, 'a floor above the quote could only revert');
  }
  ok('build() sends the floor it is given, and refuses one above the quote');

  // TAC-in Precision: needs the checkpoint leg (binds the pulled funds to this exact route) and an
  // approval on zRouter, never on PRECISION_ROUTE directly (snwap is what pulls the funds).
  const keccak256 = (bytes) => hexToBytesFromCastKeccak(bytes);
  function hexToBytesFromCastKeccak(bytes) {
    const hex = cast('keccak', '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
    return Uint8Array.from((hex.replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  }
  const tacInQuote = { venue: VENUES.PRECISION, amountIn: 5000n * 10n ** 18n, amountOut: 3n * 10n ** 17n, tokenIn: TAC_ERC20, tokenOut: ZERO_ADDR, pool: PRECISION_POOL };
  const venuesWithKeccak = makeEvmTradeVenues({ ethCall, keccak256 });
  const tacInBuilt = venuesWithKeccak.build({ quote: tacInQuote, dir: 'TAC_TO_ETH', account: A1, slippageBps: 50 });
  assert.equal(tacInBuilt.to.toLowerCase(), ZROUTER.toLowerCase());
  assert.equal(tacInBuilt.value, 0n);
  assert.ok(tacInBuilt.approval);
  assert.equal(tacInBuilt.approval.token.toLowerCase(), TAC_ERC20.toLowerCase());
  assert.equal(tacInBuilt.approval.spender.toLowerCase(), ZROUTER.toLowerCase());
  assert.equal(tacInBuilt.approval.amount, tacInQuote.amountIn);
  {
    const legs = decodeZRouterMulticall(tacInBuilt.data);
    assert.equal(legs.length, 3, 'TAC-in Precision: [guard, checkpoint, route]');
    assert.equal(snwapExecutor(legs[0]).toLowerCase(), PRECISION_GUARD.toLowerCase(), 'leg 0 (guard) into GUARD');
    assert.equal(snwapExecutor(legs[1]).toLowerCase(), PRECISION_ROUTE.toLowerCase(), 'leg 1 (checkpoint) into PROUTE, not a raw checkpoint() call');
    assert.equal(snwapExecutor(legs[2]).toLowerCase(), PRECISION_ROUTE.toLowerCase(), 'leg 2 (the actual route) into PROUTE');
  }
  ok('build() puts a TAC-in Precision route behind an approval on zRouter (snwap pulls the funds, not PRECISION_ROUTE), with guard+checkpoint both correctly snwap-wrapped');

  // TAC-in Tacit AMM: this direction can't go through snwap (the AMM would try to pull from
  // zRouter's SafeExecutor, not the user), so it must be a direct approve + swapPublic call.
  const tacitTacInQuote = { venue: VENUES.TACIT_AMM, amountIn: 5000n * 10n ** 18n, amountOut: 3n * 10n ** 17n, assetIn: TAC_POOL_ASSET_ID, assetOut: CETH_POOL_ASSET_ID, feeBps: 30n };
  const tacitTacInBuilt = venues.build({ quote: tacitTacInQuote, dir: 'TAC_TO_ETH', account: A1, slippageBps: 50 });
  assert.equal(tacitTacInBuilt.to.toLowerCase(), TACIT_AMM.toLowerCase());
  assert.equal(tacitTacInBuilt.value, 0n);
  assert.equal(tacitTacInBuilt.approval.token.toLowerCase(), TAC_ERC20.toLowerCase());
  assert.equal(tacitTacInBuilt.approval.spender.toLowerCase(), TACIT_AMM.toLowerCase());
  ok('build() sends a TAC-in Tacit AMM swap direct to the AMM (approve first), never through snwap');
}

console.log(`\n${n} evm-trade-venues checks passed`);
