// A pool counts when its factory lists it for the pool's own token pair, not when the pool says which factory it has.
//   node tests/pool-registry.test.mjs
import assert from 'node:assert';
import { factoryListsPool } from '../worker-relay/src/lib/pool-registry.js';
const A = (n) => '0x' + n.toString(16).padStart(40, '0');
const F = A(0xf0), T0 = A(1), T1 = A(2);
const revert = () => Object.assign(new Error('execution reverted'), { name: 'ContractFunctionExecutionError', cause: { name: 'ContractFunctionRevertedError' } });
const down = () => Object.assign(new Error('fetch failed'), { name: 'ContractFunctionExecutionError', cause: { name: 'HttpRequestError' } });

// a chain: contracts with views, and one factory with a registry of each kind
function chain({ pools = {}, registry = {}, offline = false }) {
  return {
    async readContract({ address, abi, functionName, args = [] }) {
      if (offline) throw down();
      const kind = abi[0].inputs.map((i) => i.type).join(',');
      if (address.toLowerCase() === F) {
        const key = `${functionName}(${kind})|${args.map((x) => String(x).toLowerCase()).join(',')}`;
        if (!(key in registry)) throw revert();
        return registry[key];
      }
      const p = pools[address.toLowerCase()];
      if (!p || !(functionName in p)) throw revert();
      return p[functionName];
    },
  };
}
const pair = A(0xa1), v3 = A(0xa2), aero = A(0xa3), cl = A(0xa4), fake = A(0xbad);
const registry = {
  [`getPair(address,address)|${T0},${T1}`]: pair,
  [`getPool(address,address,uint24)|${T0},${T1},3000`]: v3,
  [`getPool(address,address,bool)|${T0},${T1},false`]: aero,
  [`getPool(address,address,int24)|${T0},${T1},100`]: cl,
};
const pools = {
  [pair]: { token0: T0, token1: T1 }, [v3]: { token0: T0, token1: T1, fee: 3000 }, [aero]: { token0: T0, token1: T1, stable: false }, [cl]: { token0: T0, token1: T1, tickSpacing: 100 },
  // a contract that takes the shape of a pool of each kind and names the real tokens, and one that has no tokens at all
  [fake]: { token0: T0, token1: T1, fee: 3000, stable: false, tickSpacing: 100 }, [A(0x77)]: {},
};
const c = chain({ pools, registry });
let n = 0;
const ok = (cond, m) => { assert.ok(cond, m); console.log('ok  -', m); n++; };
ok(await factoryListsPool(c, F, pair) === true, 'a Uniswap V2 style pair the factory lists');
ok(await factoryListsPool(c, F, v3) === true, 'a Uniswap V3 style pool the factory lists (by fee)');
ok(await factoryListsPool(c, F, aero) === true, 'an Aerodrome pool the factory lists (by stable flag)');
ok(await factoryListsPool(c, F, cl) === true, 'a Slipstream pool the factory lists (by tick spacing)');
ok(await factoryListsPool(c, F, fake) === false, 'a contract with the right shape and tokens that the factory does not list');
ok(await factoryListsPool(c, F, A(0x77)) === false, 'a contract with no pool views');
ok(await factoryListsPool(c, F, A(0x99)) === false, 'an address with no contract');
ok(await factoryListsPool(c, F, pair.toUpperCase().replace('0X', '0x')) === true, 'the address compares in any letter case');
// a node that does not answer is not an answer
const err = await factoryListsPool(chain({ pools, registry, offline: true }), F, pair).then(() => null, (e) => e);
ok(err && err.name === 'ContractFunctionExecutionError', 'a node that does not answer throws, so the caller tries again');
const flaky = { async readContract(a) { if (a.functionName === 'getPair') throw down(); return c.readContract(a); } };
ok(await factoryListsPool(flaky, F, v3) === true, 'a lookup that cannot be made does not hide a pool another lookup lists');
const flaky2 = { async readContract(a) { if (a.functionName === 'getPool') throw down(); return c.readContract(a); } };
ok(await factoryListsPool(flaky2, F, fake).then(() => 'listed', () => 'threw') === 'threw', 'and a pool no lookup could confirm is not called unlisted on a failed read');
console.log(`${n} ok`);
