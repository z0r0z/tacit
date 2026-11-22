// How long a relay wallet's gas lasts — pure arithmetic, so it can be tested with real numbers.
//
// Days, not "settles left": a wallet that carries BOTH roles (the merged relayer key) pays for the maintenance
// lane as well as the settles, and maintenance costs about as much per day as the settles do at any realistic
// volume.

// Gas the wallet burns per day, from the roles it carries. The relay role's burn is the measured figure (`relayBurnGasPerDay`,
// RELAY_BURN_GAS_PER_DAY: headers and attests as they actually ran) when given, else the maintenance model.
export function burnGasPerDay({ roles, maintenanceRunsPerDay = 0, relayBurnGasPerDay = null, expectedOpsPerDay, gas }) {
  let g = 0n;
  if (roles.includes('relay')) g += relayBurnGasPerDay != null ? BigInt(relayBurnGasPerDay) : BigInt(Math.round(maintenanceRunsPerDay)) * gas.maintenance;
  if (roles.includes('settle')) g += BigInt(Math.round(expectedOpsPerDay)) * gas.transfer;
  return g;
}

// Days of gas left at a gas price, or null when it cannot be computed (no price, or nothing burned).
export function runwayDays({ balanceWei, gasPriceWei, ...burn }) {
  const perDay = burnGasPerDay(burn) * BigInt(gasPriceWei ?? 0);
  if (perDay <= 0n) return null;
  return Number(balanceWei) / Number(perDay);
}

// The settle role's burn as the relay's own books measured it: `recent` is the days of the /relay/economics ledger, { date: 'YYYY-MM-DD', gasEth }.
// The larger of the last whole day's gas and today's so far run out to a full day (today is not read in its first tenth, when a few settles say
// little). ETH a day, or null when the books do not say.
export function measuredBurnEthPerDay(recent, now = Date.now()) {
  if (!Array.isArray(recent)) return null;
  const today = new Date(now).toISOString().slice(0, 10);
  const days = recent.filter((r) => r && typeof r.date === 'string' && Number.isFinite(Number(r.gasEth)));
  const whole = days.filter((r) => r.date < today).sort((a, b) => (a.date < b.date ? -1 : 1));
  const last = whole.length ? Number(whole[whole.length - 1].gasEth) : 0;
  const open = days.find((r) => r.date === today), through = (now % 86_400_000) / 86_400_000;
  const pace = open && through >= 0.1 ? Number(open.gasEth) / through : 0;
  const best = Math.max(last, pace);
  return best > 0 ? best : null;
}

// Wei a day the wallet burns at a gas price: the configured burn of the roles it carries (burnGasPerDay), with the settle role's part taken as the
// larger of the configured estimate and the measured one (`measuredSettleEthPerDay`) when there is one.
export function burnWeiPerDay({ gasPriceWei, measuredSettleEthPerDay = null, ...burn }) {
  const price = BigInt(gasPriceWei ?? 0);
  const total = burnGasPerDay(burn) * price;
  if (!burn.roles.includes('settle') || !(measuredSettleEthPerDay > 0)) return total;
  const configured = BigInt(Math.round(burn.expectedOpsPerDay)) * burn.gas.transfer * price;
  const measured = BigInt(Math.round(measuredSettleEthPerDay * 1e18));
  return total - configured + (measured > configured ? measured : configured);
}
