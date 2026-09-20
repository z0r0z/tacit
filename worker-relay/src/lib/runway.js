// How long a relay wallet's gas lasts — pure arithmetic, so it can be tested with real numbers.
//
// Days, not "settles left": a wallet that carries BOTH roles (the merged relayer key) pays for the maintenance
// lane as well as the settles, and maintenance costs about as much per day as the settles do at any realistic
// volume. Counting only settles overstated the runway ~100x ("635 settles" for a wallet with ~6 days).

// Gas the wallet burns per day, from the roles it carries.
export function burnGasPerDay({ roles, maintenanceRunsPerDay, expectedOpsPerDay, gas }) {
  let g = 0n;
  if (roles.includes('relay')) g += BigInt(Math.round(maintenanceRunsPerDay)) * gas.maintenance;
  if (roles.includes('settle')) g += BigInt(Math.round(expectedOpsPerDay)) * gas.transfer;
  return g;
}

// Days of gas left at a gas price, or null when it cannot be computed (no price, or nothing burned).
export function runwayDays({ balanceWei, gasPriceWei, ...burn }) {
  const perDay = burnGasPerDay(burn) * BigInt(gasPriceWei ?? 0);
  if (perDay <= 0n) return null;
  return Number(balanceWei) / Number(perDay);
}
