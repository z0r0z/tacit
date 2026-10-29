// TAC backing an account's staked Precision LP shares. Callers supply the pinned
// deployment addresses and read all values at one Ethereum block.
export async function readPrecisionTacStake(call, who, { farm, pool }) {
  const read = async (to, data) => {
    const raw = await call({ to, data });
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw || '')) throw new Error('Could not read the Precision farm');
    return BigInt(raw);
  };
  const staked = await read(farm, `0x98807d84${who.slice(2).toLowerCase().padStart(64, '0')}`);
  if (staked === 0n) return 0n;
  const [reserveTac, supply] = await Promise.all([read(pool, '0x5a76f25e'), read(pool, '0x18160ddd')]);
  if (supply === 0n || staked > supply) throw new Error('Invalid Precision farm share supply');
  return staked * reserveTac / supply;
}
