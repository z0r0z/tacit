import { readFileSync } from 'node:fs';

const deny = (code, reason) => ({ allowed: false, code, reason });
const MEASUREMENT_SCOPE = 'eligible_leased_main_candidates_plus_reverse_stock_and_pending';
const reasonOk = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const baseUnits = (value) => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,79})$/.test(value)) return BigInt(value);
  return null;
};
const tacUnits = (value) => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,29})(?:\.(\d{1,8}))?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
};

export function rebalanceStatusFreshSecs(tickSecs) {
  if (!Number.isSafeInteger(tickSecs) || tickSecs < 1) throw new Error('rebalance tickSecs must be a positive whole number');
  return Math.max(3 * tickSecs, 60);
}

export function validateRebalanceStatus(status, { nowSecs, freshSecs, expectedMaxStuckBaseUnits = null } = {}) {
  if (!Number.isSafeInteger(nowSecs) || nowSecs < 0) throw new Error('nowSecs must be a non-negative whole number');
  if (!Number.isSafeInteger(freshSecs) || freshSecs < 1) throw new Error('freshSecs must be a positive whole number');
  const expectedMaxStuck = expectedMaxStuckBaseUnits == null ? null : baseUnits(expectedMaxStuckBaseUnits);
  if (expectedMaxStuckBaseUnits != null && (expectedMaxStuck == null || expectedMaxStuck <= 0n)) throw new Error('expectedMaxStuckBaseUnits must be a positive base-unit integer');
  if (status == null) return deny('missing', 'reverse rebalance status is missing');
  if (typeof status !== 'object' || Array.isArray(status)) return deny('malformed', 'reverse rebalance status is malformed');
  if (status.version !== 1) return deny('wrong_version', 'reverse rebalance status version must be 1');
  if (status.kind !== 'status' || status.id !== 'status') return deny('wrong_identity', 'reverse rebalance status kind and id must be status');
  if (status.enabled !== true || status.dryRun !== false) return deny('non_live', 'reverse rebalance status must be enabled and live');
  if (!Number.isSafeInteger(status.ts) || status.ts < 0) return deny('malformed', 'reverse rebalance status has an invalid timestamp');
  if (typeof status.intakeAllowed !== 'boolean' || typeof status.stalled !== 'boolean') return deny('malformed', 'reverse rebalance status has invalid intake or stall flags');
  if (status.intakeAllowed ? status.intakeReason !== null : !reasonOk(status.intakeReason)) return deny('malformed', 'reverse rebalance status has an invalid intake reason');
  if (status.stalled ? !reasonOk(status.stallReason) : status.stallReason !== null) return deny('malformed', 'reverse rebalance status has an invalid stall reason');
  const maxStuck = tacUnits(status.maxStuckTac), measuredStuck = tacUnits(status.measuredStuckTac);
  const maxBase = typeof status.maxStuckBaseUnits === 'string' ? baseUnits(status.maxStuckBaseUnits) : null;
  const measuredBase = typeof status.measuredStuckBaseUnits === 'string' ? baseUnits(status.measuredStuckBaseUnits) : null;
  if (maxStuck == null || maxStuck <= 0n || measuredStuck == null || maxBase == null || measuredBase == null) return deny('malformed', 'reverse rebalance status has invalid stuck TAC amounts');
  if (maxStuck !== maxBase || measuredStuck !== measuredBase) return deny('amount_mismatch', 'reverse rebalance status TAC text and base units disagree');
  if (expectedMaxStuck != null && maxStuck !== expectedMaxStuck) return deny('ceiling_mismatch', 'reverse rebalance status uses a different maxStuckTac ceiling');
  if (status.measurementScope !== MEASUREMENT_SCOPE) return deny('measurement_scope', 'reverse rebalance status has an unexpected or missing measurement scope');
  if (status.buyerDemandGuaranteed !== false) return deny('buyer_demand_untrusted', 'reverse rebalance status cannot guarantee buyer demand');
  if (status.ts > nowSecs) return deny('future', 'reverse rebalance status timestamp is in the future');
  if (nowSecs - status.ts > freshSecs) return deny('stale', 'reverse rebalance status is stale');
  if (measuredStuck > maxStuck && status.intakeAllowed) return deny('stuck_ceiling', 'measured stuck TAC exceeds maxStuckTac');
  if (status.stalled && status.intakeAllowed) return deny('stalled', 'reverse rebalance is stalled');
  if (!status.intakeAllowed) return deny('intake_paused', `reverse rebalancer reports ${status.intakeReason}`);
  return { allowed: true, code: null, reason: null };
}

export function makeRebalanceIntakeGate({ statusFile = null, readStatus = null, now = () => Math.floor(Date.now() / 1000), tickSecs = 60, freshSecs = null, expectedMaxStuckBaseUnits = null } = {}) {
  const maxAge = freshSecs ?? rebalanceStatusFreshSecs(tickSecs);
  if (!Number.isSafeInteger(maxAge) || maxAge < 1) throw new Error('freshSecs must be a positive whole number');
  const expectedMaxStuck = expectedMaxStuckBaseUnits == null ? null : baseUnits(expectedMaxStuckBaseUnits);
  if (expectedMaxStuckBaseUnits != null && (expectedMaxStuck == null || expectedMaxStuck <= 0n)) throw new Error('expectedMaxStuckBaseUnits must be a positive base-unit integer');
  if (readStatus != null && typeof readStatus !== 'function') throw new Error('readStatus must be a function');
  if (readStatus == null && !statusFile) throw new Error('statusFile or readStatus is required');
  const read = readStatus || (() => JSON.parse(readFileSync(statusFile, 'utf8')));
  return async () => {
    let status;
    try { status = await read(); }
    catch (e) {
      if (e?.code === 'ENOENT') return deny('missing', 'reverse rebalance status is missing');
      if (e instanceof SyntaxError) return deny('malformed', 'reverse rebalance status is malformed JSON');
      return deny('unreadable', 'reverse rebalance status could not be read');
    }
    return validateRebalanceStatus(status, { nowSecs: now(), freshSecs: maxAge, expectedMaxStuckBaseUnits: expectedMaxStuck });
  };
}
