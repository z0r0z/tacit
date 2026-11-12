// Whether a pool is one its factory lists. A contract answers `factory()` however it likes, so that answer only says which factory to ask: the
// factory's own registry has to give back this pool's address for the pool's own token pair. The lookup differs by kind of factory
// (Uniswap V2 getPair; Uniswap V3 getPool by fee; Aerodrome getPool by stable flag; Aerodrome Slipstream getPool by tick spacing), so each is tried.
const view = (name, outputs, inputs = []) => [{ type: 'function', name, stateMutability: 'view', inputs, outputs }];
const addr = { type: 'address' };
const TOKEN0 = view('token0', [addr]), TOKEN1 = view('token1', [addr]);
const FEE = view('fee', [{ type: 'uint24' }]), STABLE = view('stable', [{ type: 'bool' }]), TICK_SPACING = view('tickSpacing', [{ type: 'int24' }]);
const V2_GET_PAIR = view('getPair', [addr], [addr, addr].map((t) => ({ ...t })));
const getPool = (third) => view('getPool', [addr], [addr, addr, third]);
const V3_GET_POOL = getPool({ type: 'uint24' }), AERO_GET_POOL = getPool({ type: 'bool' }), CL_GET_POOL = getPool({ type: 'int24' });

// a failed read that says nothing about the pool: the node did not answer, as against a call the contract reverted
const unanswered = (e) => { for (let x = e; x; x = x.cause) if (x.name === 'HttpRequestError' || x.name === 'TimeoutError') return true; return false; };

/// true when `factory` lists `pool`; false when it does not (or the pool has none of the shapes a pool of that factory has).
/// Throws when a read could not be made at all, so the caller tries again instead of taking that for "not listed".
export async function factoryListsPool(client, factory, pool) {
  const rd = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const same = (got) => typeof got === 'string' && got.toLowerCase() === String(pool).toLowerCase();
  let t0, t1;
  try { [t0, t1] = await Promise.all([rd(pool, TOKEN0, 'token0'), rd(pool, TOKEN1, 'token1')]); } catch (e) { if (unanswered(e)) throw e; return false; }
  const lookups = [
    () => rd(factory, V2_GET_PAIR, 'getPair', [t0, t1]),
    async () => rd(factory, V3_GET_POOL, 'getPool', [t0, t1, await rd(pool, FEE, 'fee')]),
    async () => rd(factory, AERO_GET_POOL, 'getPool', [t0, t1, await rd(pool, STABLE, 'stable')]),
    async () => rd(factory, CL_GET_POOL, 'getPool', [t0, t1, await rd(pool, TICK_SPACING, 'tickSpacing')]),
  ];
  let broken = null;
  for (const look of lookups) {
    try { if (same(await look())) return true; } catch (e) { if (unanswered(e)) broken = e; /* else: not this factory's kind of lookup */ }
  }
  if (broken) throw broken;
  return false;
}
