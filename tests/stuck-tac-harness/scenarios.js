const BASE_UNIT = 100000000;
const FLAT_FEE = 10000000;
const DEFAULT_TERMS = Object.freeze({ feeBps: 30, flatFee: FLAT_FEE });
const DEFAULT_CONFIG = Object.freeze({
  bridgeCount: 12,
  startingInventory: 12000 * BASE_UNIT,
  recoveryFloorBps: 10000,
  dailyCap: 600 * BASE_UNIT,
  stuckCeiling: 2500 * BASE_UNIT,
  stallSecs: 180,
});
const SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'normal-recovery', code: 'B-01', name: 'Normal recovery',
    description: 'Funding moves precede exact par-or-better sales. Every fifth clean receipt returns over the ordinary bridge.',
  }),
  Object.freeze({
    id: 'no-buyer', code: 'B-02', name: 'No buyer',
    description: 'Funding selection consumes daily cap and builds unsold reverse stock. Ordinary forwards continue while the gate allows them.',
  }),
  Object.freeze({
    id: 'unread-lineage', code: 'B-03', name: 'Unread lineage',
    description: 'Unread notes remain residual main risk but are excluded from measured stuck exposure, the recovery clock and funding selection.',
  }),
  Object.freeze({
    id: 'floor-not-met', code: 'B-04', name: 'Floor not met',
    description: 'A malformed below-par proposal fails proceeds admission before funding selection. The note stays residual main and daily cap is not consumed.',
  }),
  Object.freeze({
    id: 'daily-cap', code: 'B-05', name: 'Daily cap',
    description: 'Whole-note funding selections charge the daily cap before any quote. Cap-deferred notes remain residual main unsplit.',
  }),
  Object.freeze({
    id: 'stalled-recovery', code: 'B-06', name: 'Sale-aware stall / intake gate',
    description: 'A timed sale reaches stallSecs and closes forward intake. The existing sale still completes and resets the clock; a later refund remains exposure.',
  }),
  Object.freeze({
    id: 'pool-exit', code: 'B-07', name: 'Pool exit',
    description: 'Whole pool-exit notes move from residual main to reverse stock before exact sales. Funding alone never resets the sale clock.',
  }),
  Object.freeze({
    id: 'long-history', code: 'B-08', name: 'Long history · 100 TAC',
    description: 'Deterministic 100 TAC long-history receipts reproduce the published N=1, 10 and 100 gross private Ethereum figures.',
  }),
]);

const tac = (whole) => whole * BASE_UNIT;
const amounts = [240, 180, 320, 260, 140, 300, 220, 200, 280, 160, 250, 190, 310, 170, 230, 270, 150, 290, 210, 260].map(tac);
const STEP_SECS = 60;

function displayTac(value) {
  const whole = Math.floor(value / BASE_UNIT);
  const fraction = String(value % BASE_UNIT).padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function displayBps(value) {
  return `${(value / 100).toFixed(2)}%`;
}

function validInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function configOf(supplied) {
  const config = Object.assign({}, DEFAULT_CONFIG, supplied || {});
  validInteger(config.bridgeCount, 'bridgeCount', 1, 100);
  validInteger(config.startingInventory, 'startingInventory', tac(10000), tac(100000));
  validInteger(config.recoveryFloorBps, 'recoveryFloorBps', 10000, 11000);
  validInteger(config.dailyCap, 'dailyCap', tac(100), tac(10000));
  validInteger(config.stuckCeiling, 'stuckCeiling', tac(100), tac(10000));
  validInteger(config.stallSecs, 'stallSecs', 60, 3600);
  return config;
}

function termsOf(terms) {
  const value = terms || DEFAULT_TERMS;
  validInteger(value.feeBps, 'feeBps', 0, 9999);
  validInteger(value.flatFee, 'flatFee', 0, Number.MAX_SAFE_INTEGER);
  return value;
}

function definitionOf(id) {
  const definition = SCENARIOS.find((item) => item.id === id);
  if (!definition) throw new RangeError(`Unknown scenario: ${id}`);
  return definition;
}

function multiplyBpsFloor(amount, bps) {
  const whole = Math.floor(amount / 10000);
  const remainder = amount % 10000;
  return whole * bps + Math.floor((remainder * bps) / 10000);
}

function reverseFee(evmAmount, terms) {
  validInteger(evmAmount, 'evmAmount', 0, Number.MAX_SAFE_INTEGER);
  const value = termsOf(terms);
  return multiplyBpsFloor(evmAmount, value.feeBps) + value.flatFee;
}

function forwardEthereumPayout(grossAmount, terms) {
  validInteger(grossAmount, 'grossAmount', 0, Number.MAX_SAFE_INTEGER);
  const payout = grossAmount - reverseFee(grossAmount, terms);
  if (payout <= 0) throw new RangeError('grossAmount does not cover the forward fee');
  return payout;
}

function reverseEthereumProceeds(btcValue, terms) {
  validInteger(btcValue, 'btcValue', 1, Number.MAX_SAFE_INTEGER);
  const value = termsOf(terms);
  const output = (evmAmount) => evmAmount - reverseFee(evmAmount, value);
  let low = btcValue + value.flatFee;
  let high = low + multiplyBpsFloor(btcValue, value.feeBps) + 2;
  while (output(high) < btcValue) {
    if (high > Math.floor(Number.MAX_SAFE_INTEGER / 2)) throw new RangeError('btcValue has no safe exact Ethereum proceeds');
    high *= 2;
  }
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (output(middle) >= btcValue) high = middle;
    else low = middle + 1;
  }
  if (output(low) !== btcValue) throw new RangeError('btcValue has no exact Ethereum proceeds under these terms');
  let greatest = low;
  for (let candidate = low + 1; candidate <= Number.MAX_SAFE_INTEGER; candidate += 1) {
    const next = output(candidate);
    if (next > btcValue) break;
    if (next === btcValue) greatest = candidate;
  }
  return greatest;
}

function meetsProceedsFloor(btcValue, evmAmount, floorBps) {
  validInteger(btcValue, 'btcValue', 0, Number.MAX_SAFE_INTEGER);
  validInteger(evmAmount, 'evmAmount', 0, Number.MAX_SAFE_INTEGER);
  validInteger(floorBps, 'floorBps', 0, 1000000);
  return BigInt(evmAmount) * 10000n >= BigInt(btcValue) * BigInt(floorBps);
}

function assessReverseQuote(btcValue, evmAmount, floorBps = 10000, terms) {
  validInteger(btcValue, 'btcValue', 1, Number.MAX_SAFE_INTEGER);
  validInteger(evmAmount, 'evmAmount', 0, Number.MAX_SAFE_INTEGER);
  const expectedE = reverseEthereumProceeds(btcValue, terms);
  const fee = reverseFee(evmAmount, terms);
  const par = evmAmount >= btcValue;
  const floorPass = meetsProceedsFloor(btcValue, evmAmount, floorBps);
  const exactTerms = evmAmount - fee === btcValue;
  const reasons = [];
  if (!par) reasons.push('below-par');
  if (!floorPass) reasons.push('floor-not-met');
  if (!exactTerms) reasons.push('terms-mismatch');
  return { ok: reasons.length === 0, B: btcValue, E: evmAmount, fee, expectedE, par, floorPass, exactTerms, reasons };
}

function receiptClass(id, index) {
  if (id === 'normal-recovery' && index % 5 === 4) return 'tracked';
  if (id === 'no-buyer' && index % 4 === 3) return 'tracked';
  if (id === 'unread-lineage') return 'unread';
  if (id === 'pool-exit') return 'pool-exit';
  return 'long-history';
}

function bridgeAmount(id, index) {
  if (id === 'daily-cap') return tac(400);
  if (id === 'long-history' || id === 'stalled-recovery') return tac(100);
  return amounts[index % amounts.length];
}

function scenarioTime(id, index, config) {
  if (id === 'stalled-recovery') return index === 0 ? 0 : config.stallSecs + (index - 1) * STEP_SECS;
  return index * STEP_SECS;
}

function check(id, name, expected, actual, unit, comparator) {
  const compare = comparator || '=';
  let pass;
  if (compare === '<=') pass = actual <= expected;
  else if (compare === '>=') pass = actual >= expected;
  else if (compare === '>') pass = actual > expected;
  else pass = Object.is(actual, expected);
  return { id, name, expected, actual, unit: unit || 'TAC', comparator: compare, pass };
}

function runScenario(id, suppliedConfig) {
  const definition = definitionOf(id);
  const config = configOf(suppliedConfig);
  const events = [];
  const forwards = [];
  const fundingMoves = [];
  const sales = [];
  const refunds = [];
  const gateHistory = [];
  const watchHistory = [];
  const mainNotes = [];
  const reverseNotes = [];
  const dailyUsed = {};
  let activeSale = null;
  let sequence = 0;
  let baselineGrossPrivate = config.startingInventory;
  let rebalancedGrossPrivate = config.startingInventory;
  let minimumGrossPrivate = rebalancedGrossPrivate;
  let minimumBaseline = baselineGrossPrivate;
  let totalBridged = 0;
  let forwardPayoutTotal = 0;
  let forwardFees = 0;
  let cleanReturned = 0;
  let baselineStuck = 0;
  let fundingSelectedB = 0;
  let soldStuckB = 0;
  let reverseProceedsE = 0;
  let reverseFeeTotal = 0;
  let refundedB = 0;
  let quarantined = 0;
  let completedBridges = 0;
  let refusedBridges = 0;
  let gateRefusals = 0;
  let stallGateRefusals = 0;
  let boundaryStallRefusals = 0;
  let activeContinuationsAfterGate = 0;
  let capDeferrals = 0;
  let floorRefusals = 0;
  let belowParRefusals = 0;
  let maximumDailyUsed = 0;
  let watchSince = null;
  let lastSaleAt = null;
  let lastRefundAt = null;
  let gateOpen = false;
  let gateReason = null;
  let gateOpenCount = 0;
  let previousExposure = new Set();

  const sumNotes = (notes) => notes.reduce((total, note) => total + note.B, 0);
  const admissionQuote = (B) => assessReverseQuote(B, id === 'floor-not-met' ? B - 1 : reverseEthereumProceeds(B), config.recoveryFloorBps);
  const eligibleNote = (note) => note.readable && admissionQuote(note.B).ok;
  const residualMain = () => sumNotes(mainNotes);
  const eligibleMainStuck = () => sumNotes(mainNotes.filter(eligibleNote));
  const unsoldReverseStock = () => sumNotes(reverseNotes);
  const activeSaleB = () => activeSale ? activeSale.B : 0;
  const measuredStuck = () => eligibleMainStuck() + unsoldReverseStock() + activeSaleB();
  const exposureIds = () => {
    const ids = mainNotes.filter(eligibleNote).map((note) => `main:${note.noteId}`);
    ids.push(...reverseNotes.map((note) => note.stockId));
    if (activeSale) ids.push(`sale:${activeSale.noteId}`);
    return ids.sort();
  };
  const clockReference = () => lastSaleAt !== null && (watchSince === null || lastSaleAt >= watchSince) ? lastSaleAt : watchSince;
  const stallElapsed = (now) => {
    const reference = clockReference();
    return measuredStuck() > 0 && reference !== null ? Math.max(0, now - reference) : 0;
  };
  const reasonAt = (now) => {
    if (measuredStuck() > config.stuckCeiling) return 'stuck-ceiling';
    if (measuredStuck() > 0 && stallElapsed(now) >= config.stallSecs) return 'no-completed-sale';
    return null;
  };
  const emit = (kind, tone, title, detail, amount, asset, bridge, day, at) => {
    events.push({
      sequence: ++sequence, day, bridge, at, kind, tone, title, detail,
      amount: amount == null ? null : amount,
      asset: amount == null ? null : asset,
    });
  };
  const syncWatch = (now, bridge, day) => {
    const current = new Set(exposureIds());
    const added = [...current].some((item) => !previousExposure.has(item));
    if (measuredStuck() === 0) watchSince = null;
    else if (added) {
      watchSince = now;
      watchHistory.push({ at: now, watchSince, items: [...current] });
      emit('clock', 'neutral', 'New exposure · full watch interval', `t=${now}s · New measured exposure receives the full ${config.stallSecs}s interval. Unread residual risk is excluded.`, null, null, bridge, day, now);
    }
    previousExposure = current;
  };
  const updateGate = (now, bridge, day) => {
    const reason = reasonAt(now);
    if (reason && !gateOpen) {
      gateOpenCount += 1;
      gateHistory.push({ at: now, open: true, reason, lastSaleAt });
      emit('gate', 'bad', reason === 'stuck-ceiling' ? 'Forward intake gate opened · measured stuck ceiling' : 'Forward intake gate opened · no completed sale', `t=${now}s · ${reason === 'stuck-ceiling' ? `Measured stuck ${displayTac(measuredStuck())} exceeds ceiling ${displayTac(config.stuckCeiling)}.` : `No completed sale for ${stallElapsed(now)}s; funding moves and active sales still count as exposure.`} Existing swaps continue.`, null, null, bridge, day, now);
    } else if (!reason && gateOpen) {
      gateHistory.push({ at: now, open: false, reason: null, lastSaleAt });
      emit('gate', 'good', 'Forward intake gate cleared', `t=${now}s · ${lastSaleAt !== null ? `Latest completed sale is t=${lastSaleAt}s.` : 'Measured exposure returned within limits.'} Existing swap progress was never stopped.`, null, null, bridge, day, now);
    }
    gateOpen = reason !== null;
    gateReason = reason;
  };
  const completeSale = (now, bridge, day) => {
    const sale = activeSale;
    if (!sale) return;
    if (gateOpen) activeContinuationsAfterGate += 1;
    activeSale = null;
    soldStuckB += sale.B;
    reverseProceedsE += sale.E;
    reverseFeeTotal += sale.E - sale.B;
    lastSaleAt = now;
    rebalancedGrossPrivate += sale.E;
    sales.push({ ...sale, completedAt: now, fee: sale.E - sale.B, premium: sale.E - sale.B });
    emit('fill', 'good', 'Reverse sale completed · exact E received', `t=${now}s · Funding was not completion. This sale resets the recovery clock. B ${displayTac(sale.B)}; E ${displayTac(sale.E)}; retained premium ${displayTac(sale.E - sale.B)}.`, sale.E, 'ETH', bridge, day, now);
  };
  const refundSale = (now, bridge, day) => {
    const sale = activeSale;
    if (!sale) return;
    if (gateOpen) activeContinuationsAfterGate += 1;
    activeSale = null;
    refundedB += sale.B;
    lastRefundAt = now;
    reverseNotes.push({ ...sale, stockId: `refund:${sale.noteId}`, refunded: true });
    refunds.push({ ...sale, refundedAt: now });
    emit('refund', 'warn', 'Reverse sale refunded · exposure remains', `t=${now}s · Refund is not a completed sale and does not reset lastSaleAt. B ${displayTac(sale.B)} returns to unsold reverse exposure.`, sale.B, 'BTC', bridge, day, now);
  };
  const processDueSale = (now, bridge, day, phase) => {
    if (!activeSale || activeSale.dueAt === null || activeSale.dueAt > now) return;
    const expectedPhase = activeSale.outcome === 'done' ? 'after' : 'before';
    if (phase !== expectedPhase) return;
    if (activeSale.outcome === 'done') completeSale(now, bridge, day);
    else refundSale(now, bridge, day);
  };

  const recover = (now, bridge, day) => {
    if (id === 'unread-lineage') {
      if (residualMain() > 0) emit('guard', 'warn', 'Unread residual main · no funding selection', `t=${now}s · ${displayTac(quarantined)} TAC remains residual risk but adds zero to measured stuck exposure.`, null, null, bridge, day, now);
      return;
    }
    const ineligible = mainNotes.filter((note) => note.readable && !eligibleNote(note)).sort((a, b) => a.B - b.B || a.noteId.localeCompare(b.noteId))[0];
    if (ineligible) {
      const quote = admissionQuote(ineligible.B);
      floorRefusals += 1;
      if (!quote.par) belowParRefusals += 1;
      const why = !quote.par ? `E ${displayTac(quote.E)} is below B ${displayTac(ineligible.B)} and cannot be produced by the current client.` : `E ${displayTac(quote.E)} does not meet the ${displayBps(config.recoveryFloorBps)} floor for B ${displayTac(ineligible.B)}.`;
      emit('guard', 'warn', 'Funding admission refused · proceeds guard', `t=${now}s · ${why} The note remains residual main and daily cap is not consumed. Reasons: ${quote.reasons.join(', ')}.`, null, null, bridge, day, now);
    }
    const candidate = mainNotes.filter(eligibleNote).sort((a, b) => a.B - b.B || a.noteId.localeCompare(b.noteId))[0];
    if (candidate) {
      const used = dailyUsed[day] || 0;
      if (used + candidate.B > config.dailyCap) {
        capDeferrals += 1;
        emit('cap', 'warn', 'Funding cap · whole note deferred', `t=${now}s · Funding selection would exceed daily cap. B ${displayTac(candidate.B)} remains residual main; no partial move and no quote.`, candidate.B, 'BTC', bridge, day, now);
      } else {
        mainNotes.splice(mainNotes.indexOf(candidate), 1);
        dailyUsed[day] = used + candidate.B;
        maximumDailyUsed = Math.max(maximumDailyUsed, dailyUsed[day]);
        fundingSelectedB += candidate.B;
        const stock = { ...candidate, stockId: `reverse:${candidate.noteId}`, refunded: false };
        reverseNotes.push(stock);
        fundingMoves.push({ ...candidate, selectedAt: now, day, B: candidate.B });
        emit('funding', 'neutral', 'Funding move selected · daily cap charged', `t=${now}s · B ${displayTac(candidate.B)} moved to reverse stock. Cap is consumed now, before buyer demand or a sale. Funding is not recovery.`, candidate.B, 'BTC', bridge, day, now);
      }
    }

    if (activeSale || reverseNotes.length === 0) return;
    if (id === 'no-buyer') {
      emit('guard', 'warn', 'No buyer · funded reverse stock remains unsold', `t=${now}s · Unsold B ${displayTac(unsoldReverseStock())} remains exposed. The funding cap already consumed is not refunded.`, null, null, bridge, day, now);
      return;
    }
    const stock = reverseNotes.sort((a, b) => a.B - b.B || a.noteId.localeCompare(b.noteId))[0];
    if (id === 'stalled-recovery' && (stock.bridge > 3 || stock.refunded)) {
      emit('guard', 'warn', 'No later buyer · refund and reverse stock remain exposed', `t=${now}s · The fixture keeps this reverse stock unsold so the sale-aware clock remains observable.`, null, null, bridge, day, now);
      return;
    }
    const B = stock.B;
    const E = id === 'floor-not-met' ? B - 1 : reverseEthereumProceeds(B);
    const quote = assessReverseQuote(B, E, config.recoveryFloorBps);
    if (!quote.ok) {
      floorRefusals += 1;
      if (!quote.par) belowParRefusals += 1;
      const why = !quote.par ? `E ${displayTac(E)} is below B ${displayTac(B)} and cannot be produced by the current client.` : `E ${displayTac(E)} does not meet the ${displayBps(config.recoveryFloorBps)} floor for B ${displayTac(B)}.`;
      emit('guard', 'warn', 'Reverse quote refused · reverse stock retained', `t=${now}s · ${why} Funding cap remains consumed. Reasons: ${quote.reasons.join(', ')}.`, null, null, bridge, day, now);
      return;
    }
    reverseNotes.splice(reverseNotes.indexOf(stock), 1);
    const timed = id === 'stalled-recovery' && !stock.refunded && stock.bridge <= 3;
    activeSale = {
      ...stock, B, E, startedAt: now,
      outcome: timed && stock.bridge === 3 ? 'refund' : 'done',
      dueAt: timed ? scenarioTime(id, stock.bridge === 1 ? 1 : 3, config) : null,
    };
    emit('lock', 'neutral', 'Reverse sale active · funding is not completion', `t=${now}s · B ${displayTac(B)} is active sale exposure for exact E ${displayTac(E)}. ${timed ? 'This fixture delays the outcome.' : 'Completion is evaluated in this step.'}`, B, 'BTC', bridge, day, now);
    if (!timed) completeSale(now, bridge, day);
  };

  const steps = id === 'stalled-recovery' && (config.bridgeCount === 1 || config.bridgeCount === 3) ? config.bridgeCount + 1 : config.bridgeCount;
  for (let index = 0; index < steps; index += 1) {
    const hasRequest = index < config.bridgeCount;
    const bridge = index + 1;
    const now = scenarioTime(id, index, config);
    const day = Math.floor(now / (2 * STEP_SECS)) + 1;
    const reference = `t=${now}s · B${String(bridge).padStart(3, '0')}`;
    processDueSale(now, bridge, day, 'before');
    syncWatch(now, bridge, day);
    updateGate(now, bridge, day);

    if (hasRequest && gateOpen) {
      refusedBridges += 1;
      gateRefusals += 1;
      if (gateReason === 'no-completed-sale') {
        stallGateRefusals += 1;
        if (now === config.stallSecs) boundaryStallRefusals += 1;
      }
      emit('gate', 'bad', 'Forward refused · intake gate open', `${reference} · No forward y, Bitcoin receipt or funding selection is created. Existing reverse sales continue to their outcomes.`, null, null, bridge, day, now);
    } else if (hasRequest) {
      const A = bridgeAmount(id, index);
      const y = forwardEthereumPayout(A);
      if (y > rebalancedGrossPrivate || y > baselineGrossPrivate) {
        refusedBridges += 1;
        emit('guard', 'warn', 'Forward refused · gross private inventory', `${reference} · Required y ${displayTac(y)} is unavailable in a paired baseline path. No payout, receipt or funding move. Actual quotable capacity is separately excluded.`, null, null, bridge, day, now);
      } else {
        completedBridges += 1;
        totalBridged += A;
        forwardPayoutTotal += y;
        forwardFees += A - y;
        baselineGrossPrivate -= y;
        rebalancedGrossPrivate -= y;
        minimumGrossPrivate = Math.min(minimumGrossPrivate, rebalancedGrossPrivate);
        minimumBaseline = Math.min(minimumBaseline, baselineGrossPrivate);
        const classification = receiptClass(id, index);
        const noteId = `N${String(bridge).padStart(3, '0')}`;
        forwards.push({ bridge, day, noteId, A, y, fee: A - y, classification, cleanReturned: classification === 'tracked' ? A : 0, at: now });
        if (classification === 'tracked') {
          cleanReturned += A;
          baselineGrossPrivate += A;
          rebalancedGrossPrivate += A;
          emit('forward', 'neutral', 'Forward payout · clean tracked receipt', `${reference} · A ${displayTac(A)} received; y ${displayTac(y)} paid. Forward fee ${displayTac(A - y)}. Native sats and exact pool cut costs are excluded.`, -y, 'ETH', bridge, day, now);
          emit('clean-return', 'good', 'Ordinary bridge return · clean A', `${reference} · A ${displayTac(A)} added back to gross private Ethereum by the reporting horizon. No TAC return fee; native sats costs excluded.`, A, 'ETH', bridge, day, now);
        } else {
          const readable = classification !== 'unread';
          const note = { noteId, bridge, B: A, classification, readable };
          mainNotes.push(note);
          baselineStuck += A;
          if (!readable) quarantined += A;
          emit(readable ? 'forward' : 'quarantine', readable ? 'neutral' : 'warn', `Forward payout · ${readable ? classification : 'unread lineage'}`, `${reference} · A ${displayTac(A)} received; y ${displayTac(y)} paid. Forward fee ${displayTac(A - y)}. ${readable ? 'Eligible residual main.' : 'Residual main risk, excluded from measured stuck.'}`, -y, 'ETH', bridge, day, now);
        }
      }
    }

    recover(now, bridge, day);
    processDueSale(now, bridge, day, 'after');
    syncWatch(now, bridge, day);
    updateGate(now, bridge, day);
  }

  const reversePremium = reverseProceedsE - soldStuckB;
  const main = residualMain();
  const reverseStock = unsoldReverseStock();
  const active = activeSaleB();
  const measured = measuredStuck();
  const summary = {
    requestedBridges: config.bridgeCount,
    completedBridges,
    refusedBridges,
    startingInventory: config.startingInventory,
    baselineGrossPrivate,
    rebalancedGrossPrivate,
    totalBridged,
    forwardPayoutTotal,
    forwardFees,
    cleanReturned,
    baselineStuck,
    residualMain: main,
    residualMainNoteCount: mainNotes.length,
    eligibleMainStuck: eligibleMainStuck(),
    proceedsExcludedMain: sumNotes(mainNotes.filter((note) => note.readable && !eligibleNote(note))),
    unsoldReverseStock: reverseStock,
    reverseStockNoteCount: reverseNotes.length,
    activeSaleB: active,
    measuredStuck: measured,
    fundingSelectedB,
    soldStuckB,
    reverseProceedsE,
    reversePremium,
    reverseFeeTotal,
    refundedB,
    quarantined,
    settledRecoveries: sales.length,
    capDeferrals,
    floorRefusals,
    belowParRefusals,
    gateRefusals,
    stallGateRefusals,
    boundaryStallRefusals,
    activeContinuationsAfterGate,
    gateOpen,
    gateReason,
    gateOpenCount,
    watchSince,
    lastSaleAt,
    lastRefundAt,
    stallElapsed: stallElapsed(scenarioTime(id, steps - 1, config)),
    stallSecs: config.stallSecs,
    maximumDailyUsed,
    minimumGrossPrivate,
    minimumBaseline,
    dailyUsed,
    nativeSatsCosts: null,
    poolNoteCutCosts: null,
    poolNoteCutReserves: null,
    quotableCapacity: null,
    nativeSatsCostsExcluded: true,
    poolCutAndCapacityExcluded: true,
    buyerDemandGuaranteed: false,
  };

  const wholeNoteSales = sales.every((sale) => {
    const source = forwards.find((forward) => forward.noteId === sale.noteId);
    return source && source.A === sale.B && source.classification === sale.classification;
  });
  const exactSales = sales.every((sale) => assessReverseQuote(sale.B, sale.E, config.recoveryFloorBps).ok);
  const fundingByDay = {};
  for (const move of fundingMoves) fundingByDay[move.day] = (fundingByDay[move.day] || 0) + move.B;
  const capMatchesFunding = Object.keys({ ...dailyUsed, ...fundingByDay }).every((day) => (dailyUsed[day] || 0) === (fundingByDay[day] || 0));
  const refusedIds = new Set(events.filter((event) => event.title.startsWith('Forward refused')).map((event) => event.bridge));
  const refusedWithoutReceipt = [...refusedIds].every((bridge) => !forwards.some((forward) => forward.bridge === bridge));
  const assertions = [
    check('baseline-reconciliation', 'Baseline gross subtracts forward y and adds ordinary clean A', config.startingInventory - forwardPayoutTotal + cleanReturned, baselineGrossPrivate),
    check('rebalanced-reconciliation', 'Rebalanced gross adds exact E only for completed sales', baselineGrossPrivate + reverseProceedsE, rebalancedGrossPrivate),
    check('forward-conservation', 'Every gross A equals forward y plus forward fee', totalBridged, forwardPayoutTotal + forwardFees),
    check('clean-return-accounting', 'Every clean tracked A returns with no TAC return fee', forwards.filter((forward) => forward.classification === 'tracked').reduce((sum, forward) => sum + forward.A, 0), cleanReturned),
    check('stuck-conservation', 'B is residual main, reverse stock, active sale or sold', baselineStuck, main + reverseStock + active + soldStuckB),
    check('receipt-classification', 'Every received A is clean returned or stuck', totalBridged, cleanReturned + baselineStuck),
    check('reverse-premium', 'Retained premium E-B equals the exact reverse fee', reverseFeeTotal, reversePremium),
    check('par-and-floor', 'Every completed sale satisfies exact terms, par and the floor', true, exactSales, 'boolean'),
    check('whole-note-fixture', 'This economics fixture sells complete notes without combining or change', true, wholeNoteSales, 'boolean'),
    check('daily-cap', 'Daily funding selections never exceed the cap', config.dailyCap, maximumDailyUsed, 'TAC', '<='),
    check('daily-cap-source', 'Daily cap comes from funding selection, not buyer completion', true, capMatchesFunding, 'boolean'),
    check('unread-ceiling-exclusion', 'Measured stuck excludes unread and proceeds-ineligible main risk', main + reverseStock + active - quarantined - summary.proceedsExcludedMain, measured),
    check('gross-nonnegative', 'Both gross private Ethereum paths remain non-negative', 0, Math.min(minimumGrossPrivate, minimumBaseline), 'TAC', '>='),
    check('bridge-accounting', 'Every requested forward completes or is refused', config.bridgeCount, completedBridges + refusedBridges, 'count'),
    check('gate-forward-guard', 'Gate refusals create no forward payout or receipt', true, refusedWithoutReceipt, 'boolean'),
    check('watch-full-interval', 'Every new measured exposure starts a fresh watch interval', true, watchHistory.every((entry) => entry.at === entry.watchSince), 'boolean'),
    check('integer-accounting', 'All TAC balances use safe integer base units', true, [totalBridged, forwardPayoutTotal, cleanReturned, baselineStuck, main, reverseStock, active, soldStuckB, reverseProceedsE, baselineGrossPrivate, rebalancedGrossPrivate].every(Number.isSafeInteger), 'boolean'),
  ];

  if (id === 'normal-recovery') {
    assertions.push(check('normal-no-active', 'Immediate normal sales leave no active sale at the horizon', 0, active));
  } else if (id === 'no-buyer') {
    assertions.push(check('buyer-no-sale', 'No buyer means no active or sold B', 0, active + soldStuckB));
    assertions.push(check('buyer-reverse-stock', 'Every funded no-buyer note remains unsold reverse stock', fundingSelectedB, reverseStock));
    assertions.push(check('buyer-cap-consumed', 'No buyer does not refund funding cap', fundingSelectedB, Object.values(dailyUsed).reduce((sum, value) => sum + value, 0)));
    assertions.push(check('buyer-forward-continues', 'Ordinary forwards occur before any gate or inventory refusal', true, completedBridges > 0, 'boolean'));
  } else if (id === 'unread-lineage') {
    assertions.push(check('lineage-quarantine', 'Every unread note remains residual main quarantine', baselineStuck, quarantined));
    assertions.push(check('lineage-not-measured', 'Unread lineage adds zero to measured stuck exposure', 0, measured));
    assertions.push(check('lineage-no-gate', 'Unread residual risk alone cannot open the measured gate', false, gateOpen, 'boolean'));
    assertions.push(check('lineage-no-funding', 'Unread lineage never consumes funding cap', 0, fundingSelectedB));
  } else if (id === 'floor-not-met') {
    if (belowParRefusals > 0) assertions.push(check('below-par-refusal', 'Below-par quotes are refused after funding without sale', true, active + soldStuckB === 0, 'boolean'));
    else assertions.push(check('below-par-cap-first', 'Cap deferral can prevent the quote without inventing a refusal', true, capDeferrals > 0 && active + soldStuckB === 0, 'boolean'));
    assertions.push(check('floor-reverse-stock', 'Refused funded notes remain unsold reverse stock', fundingSelectedB, reverseStock));
    assertions.push(check('floor-no-proceeds', 'No accepted quote produces Ethereum proceeds', 0, reverseProceedsE));
  } else if (id === 'daily-cap') {
    assertions.push(check('cap-no-active', 'Immediate cap-limited sales leave no active sale', 0, active));
    assertions.push(check('cap-whole-funding', 'Every cap-funded note is a complete 400 TAC fixture note', true, fundingMoves.every((move) => move.B === tac(400)), 'boolean'));
  } else if (id === 'stalled-recovery') {
    const firstQuoteAccepted = assessReverseQuote(tac(100), reverseEthereumProceeds(tac(100)), config.recoveryFloorBps).ok;
    assertions.push(check('sale-clock-stall', 'Accepted exposure can stall; proceeds refusal cannot invent a timed stall', true, firstQuoteAccepted ? gateHistory.some((entry) => entry.open && entry.reason === 'no-completed-sale' && entry.at === config.stallSecs && entry.lastSaleAt === null) : !gateHistory.some((entry) => entry.reason === 'no-completed-sale'), 'boolean'));
    assertions.push(check('sale-continues-after-gate', 'An accepted existing sale completes after the gate; a refused quote cannot fabricate one', firstQuoteAccepted ? 1 : 0, activeContinuationsAfterGate, 'count'));
    assertions.push(check('sale-resets-clock', 'Only a completed sale sets lastSaleAt', firstQuoteAccepted ? config.stallSecs : null, lastSaleAt, 'seconds'));
    assertions.push(check('stall-forward-refusal', 'Only accepted exposure can cause the first stall-boundary refusal', firstQuoteAccepted && config.bridgeCount >= 2 ? 1 : 0, boundaryStallRefusals, 'count'));
    assertions.push(check('refund-remains-exposure', 'An accepted later refund stays as unsold reverse exposure', firstQuoteAccepted && config.bridgeCount >= 3 ? tac(100) : 0, refundedB));
    assertions.push(check('refund-not-sale', 'A refund never advances lastSaleAt', firstQuoteAccepted ? config.stallSecs : null, lastSaleAt, 'seconds'));
  } else if (id === 'pool-exit') {
    assertions.push(check('pool-exit-whole-route', 'Only whole pool-exit notes enter completed sales', true, sales.every((sale) => sale.classification === 'pool-exit'), 'boolean'));
    assertions.push(check('pool-exit-no-active', 'Immediate pool-exit sales leave no active sale', 0, active));
  } else if (id === 'long-history') {
    assertions.push(check('long-history-published-amounts', 'Every receipt is 100 TAC and every completed sale uses published exact E', true, forwards.every((forward) => forward.A === tac(100)) && sales.every((sale) => sale.E === 10040120361), 'boolean'));
    assertions.push(check('long-history-no-active', 'Immediate long-history sales leave no active sale', 0, active));
  }

  let status = 'No completed sale';
  let tone = 'warn';
  if (gateOpen) { status = gateReason === 'stuck-ceiling' ? 'Gate open · ceiling' : 'Gate open · sale clock'; tone = 'bad'; }
  else if (id === 'unread-lineage') status = 'Residual risk only';
  else if (active > 0) status = 'Sale in flight';
  else if (id === 'no-buyer') status = 'Unsold reverse stock';
  else if (id === 'floor-not-met') status = 'Below par · refused';
  else if (floorRefusals > 0 && soldStuckB === 0) status = 'Below floor';
  else if ((main + reverseStock > 0) && soldStuckB > 0) status = 'Residual within limits';
  else if (soldStuckB > 0) { status = lastSaleAt !== null && gateOpenCount > 0 ? 'Sale recovered · gate clear' : 'Recovered'; tone = 'good'; }

  return {
    id, code: definition.code, name: definition.name, description: definition.description,
    config, status, tone, summary, forwards, fundingMoves, sales, refunds, gateHistory, watchHistory, events,
    assertions, passed: assertions.every((assertion) => assertion.pass),
  };
}

function runAllScenarios(config) {
  return SCENARIOS.map((scenario) => runScenario(scenario.id, config));
}

export {
  BASE_UNIT,
  FLAT_FEE,
  DEFAULT_TERMS,
  DEFAULT_CONFIG,
  SCENARIOS,
  reverseFee,
  forwardEthereumPayout,
  reverseEthereumProceeds,
  meetsProceedsFloor,
  assessReverseQuote,
  runScenario,
  runAllScenarios,
};
