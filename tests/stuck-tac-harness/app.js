import {
  BASE_UNIT,
  DEFAULT_CONFIG,
  SCENARIOS,
  runScenario,
  runAllScenarios,
} from './scenarios.js';

const byId = (id) => document.getElementById(id);
const controls = byId('controls');
const scenarioSelect = byId('scenario');
const formError = byId('form-error');
const staleNotice = byId('stale-notice');
const runAllBoard = byId('run-all-board');
const fieldIds = ['bridge-count', 'starting-inventory', 'recovery-floor', 'daily-cap', 'stuck-ceiling', 'stall-interval'];
const state = { results: new Map(), activeId: 'normal-recovery', batch: false, dirty: false };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTac(value) {
  if (!Number.isSafeInteger(value)) return 'Invalid amount';
  const negative = value < 0;
  const absolute = Math.abs(value);
  const whole = Math.floor(absolute / BASE_UNIT).toLocaleString('en-GB');
  let fraction = String(absolute % BASE_UNIT).padStart(8, '0').replace(/0+$/, '');
  if (fraction.length < 2) fraction = fraction.padEnd(2, '0');
  return `${negative ? '−' : ''}${whole}.${fraction}`;
}

function formatInputTac(value) {
  const formatted = formatTac(value).replace(/,/g, '');
  return formatted.endsWith('.00') ? formatted.slice(0, -3) : formatted;
}

function formatTime(value) {
  return value === null || value === undefined ? 'Not set' : `t=${value}s`;
}

function formatAssertionValue(assertion, value) {
  if (value === null || value === undefined) return 'Not set';
  if (assertion.unit === 'boolean') return value ? 'Yes' : 'No';
  if (assertion.unit === 'count') return Number(value).toLocaleString('en-GB');
  if (assertion.unit === 'seconds') return `${value}s`;
  return `${formatTac(value)} TAC`;
}

function formatExpected(assertion) {
  const value = formatAssertionValue(assertion, assertion.expected);
  if (assertion.comparator === '<=') return `≤ ${value}`;
  if (assertion.comparator === '>=') return `≥ ${value}`;
  if (assertion.comparator === '>') return `> ${value}`;
  return value;
}

function scaledInteger(raw, decimals, label, field) {
  const text = raw.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2] || '').length > decimals) {
    const error = new Error(`${label} must be a non-negative number with no more than ${decimals} decimal places.`);
    error.field = field;
    throw error;
  }
  const scale = 10 ** decimals;
  const value = Number(match[1]) * scale + Number((match[2] || '').padEnd(decimals, '0'));
  if (!Number.isSafeInteger(value)) {
    const error = new Error(`${label} is too large for exact base-unit accounting.`);
    error.field = field;
    throw error;
  }
  return value;
}

function range(value, minimum, maximum, label, field, suffix) {
  if (value < minimum || value > maximum) {
    const error = new Error(`${label} must be from ${minimum.toLocaleString('en-GB')} to ${maximum.toLocaleString('en-GB')}${suffix || ''}.`);
    error.field = field;
    throw error;
  }
  return value;
}

function clearValidation() {
  fieldIds.forEach((id) => byId(id).removeAttribute('aria-invalid'));
  formError.hidden = true;
  formError.textContent = '';
}

function readConfig() {
  clearValidation();
  const bridgeText = byId('bridge-count').value.trim();
  if (!/^\d+$/.test(bridgeText)) {
    const error = new Error('Bridge count must be a whole number.');
    error.field = 'bridge-count';
    throw error;
  }
  const bridgeCount = range(Number(bridgeText), 1, 100, 'Bridge count', 'bridge-count');
  const startingInventory = range(
    scaledInteger(byId('starting-inventory').value, 8, 'Starting gross private inventory', 'starting-inventory'),
    10000 * BASE_UNIT, 100000 * BASE_UNIT, 'Starting gross private inventory', 'starting-inventory', ' TAC',
  );
  const recoveryFloorBps = scaledInteger(byId('recovery-floor').value, 2, 'Recovery floor', 'recovery-floor');
  if (recoveryFloorBps < 10000 || recoveryFloorBps > 11000) {
    const error = new Error('Recovery floor must be from 100.00% to 110.00%.');
    error.field = 'recovery-floor';
    throw error;
  }
  const dailyCap = range(
    scaledInteger(byId('daily-cap').value, 8, 'Daily funding cap', 'daily-cap'),
    100 * BASE_UNIT, 10000 * BASE_UNIT, 'Daily funding cap', 'daily-cap', ' TAC',
  );
  const stuckCeiling = range(
    scaledInteger(byId('stuck-ceiling').value, 8, 'Measured stuck ceiling', 'stuck-ceiling'),
    100 * BASE_UNIT, 10000 * BASE_UNIT, 'Measured stuck ceiling', 'stuck-ceiling', ' TAC',
  );
  const stallSecs = range(
    scaledInteger(byId('stall-interval').value, 0, 'Stall interval', 'stall-interval'),
    60, 3600, 'Stall interval', 'stall-interval', ' seconds',
  );
  return { bridgeCount, startingInventory, recoveryFloorBps, dailyCap, stuckCeiling, stallSecs };
}

function showValidationError(error, focusOnError) {
  const message = error instanceof Error ? error.message : String(error);
  formError.textContent = message;
  formError.hidden = false;
  if (error.field) {
    const field = byId(error.field);
    field.setAttribute('aria-invalid', 'true');
    if (focusOnError) field.focus();
  }
  byId('live-status').textContent = `Scenario not run. ${message}`;
}

function updateBrief() {
  const definition = SCENARIOS.find((item) => item.id === scenarioSelect.value);
  byId('scenario-code').textContent = `${definition.code} / ${definition.name}`;
  byId('scenario-description').textContent = definition.description;
}

function updateStale() {
  staleNotice.hidden = !state.dirty;
  if (state.batch) byId('run-all-title').textContent = state.dirty ? 'All scenarios · previous inputs' : 'All scenarios · current inputs';
}

function renderEvents(result) {
  const body = byId('events-body');
  body.replaceChildren();
  result.events.forEach((event, index) => {
    const row = element('tr', `ledger-row event-row ${event.tone}`);
    row.style.setProperty('--order', Math.min(index, 12));
    row.append(element('td', 'event-ref', `T${String(event.at).padStart(4, '0')}.${String(event.sequence).padStart(3, '0')}`));
    const entry = element('td');
    entry.append(element('span', 'event-title', event.title));
    entry.append(element('span', 'event-detail', event.detail));
    row.append(entry);
    const positive = event.kind === 'fill' || event.kind === 'clean-return';
    let amount = '·';
    if (event.amount !== null) {
      amount = event.amount < 0 ? `−${formatTac(Math.abs(event.amount))}` : formatTac(event.amount);
      if (positive) amount = `+${amount}`;
      amount = `${amount} ${event.asset}`;
    }
    row.append(element('td', `event-amount${positive ? ' positive' : event.amount < 0 ? ' negative' : ''}`, amount));
    body.append(row);
  });
  const days = new Set(result.events.map((event) => event.day)).size;
  byId('event-count').textContent = `${result.events.length} entries · ${days} ${days === 1 ? 'day' : 'days'}`;
}

function renderAssertions(result) {
  const body = byId('assertions-body');
  body.replaceChildren();
  result.assertions.forEach((assertion, index) => {
    const row = element('tr', `ledger-row assertion-row${assertion.pass ? '' : ' fail'}`);
    row.style.setProperty('--order', Math.min(index, 12));
    const name = element('td', 'assertion-name');
    name.append(element('span', `assertion-state${assertion.pass ? '' : ' fail'}`, assertion.pass ? 'PASS' : 'FAIL'));
    name.append(document.createElement('br'));
    name.append(document.createTextNode(assertion.name));
    row.append(name);
    row.append(element('td', 'assertion-value', formatExpected(assertion)));
    row.append(element('td', 'assertion-value actual', formatAssertionValue(assertion, assertion.actual)));
    body.append(row);
  });
  const passed = result.assertions.filter((assertion) => assertion.pass).length;
  byId('assertion-count').textContent = `${passed} / ${result.assertions.length} passing`;
}

function renderRunAll() {
  runAllBoard.hidden = !state.batch;
  if (!state.batch) return;
  const body = byId('run-all-body');
  body.replaceChildren();
  let passed = 0;
  let total = 0;
  SCENARIOS.forEach((definition, index) => {
    const result = state.results.get(definition.id);
    if (!result) return;
    const row = element('tr', 'ledger-row');
    row.style.setProperty('--order', Math.min(index, 12));
    const nameCell = element('td');
    const button = element('button', `scenario-jump${result.id === state.activeId ? ' active' : ''}`, `${result.code} · ${result.name}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(result.id === state.activeId));
    button.setAttribute('aria-label', `View ${result.name} result`);
    button.addEventListener('click', () => {
      scenarioSelect.value = result.id;
      updateBrief();
      renderResult(result);
      byId('live-status').textContent = `${result.name} selected from the batch register.`;
    });
    nameCell.append(button);
    row.append(nameCell);
    row.append(element('td', '', `+${formatTac(result.summary.reverseProceedsE)} TAC`));
    row.append(element('td', '', `${formatTac(result.summary.residualMain)} TAC`));
    row.append(element('td', '', `${formatTac(result.summary.unsoldReverseStock)} TAC`));
    row.append(element('td', '', `${formatTac(result.summary.activeSaleB)} TAC`));
    const localPassed = result.assertions.filter((assertion) => assertion.pass).length;
    passed += localPassed;
    total += result.assertions.length;
    row.append(element('td', result.passed ? 'table-pass' : 'table-fail', `${localPassed} / ${result.assertions.length} ${result.passed ? 'pass' : 'fail'}`));
    body.append(row);
  });
  byId('run-all-count').textContent = `${passed} / ${total} checks passing`;
}

function renderResult(result) {
  state.activeId = result.id;
  const summary = result.summary;
  byId('result-title').textContent = result.name;
  byId('result-status').textContent = result.status;
  byId('result-status').className = `status-chip ${result.tone}`;
  byId('run-context').textContent = `${result.code} · ${summary.completedBridges} / ${summary.requestedBridges} forwards completed · floor ${(result.config.recoveryFloorBps / 100).toFixed(2)}% · funding cap ${formatTac(result.config.dailyCap)} / day · measured ceiling ${formatTac(result.config.stuckCeiling)}`;
  byId('baseline-gross').textContent = formatTac(summary.baselineGrossPrivate);
  byId('rebalanced-gross').textContent = formatTac(summary.rebalancedGrossPrivate);
  byId('rebalanced-note').textContent = `Baseline gross ${formatTac(summary.baselineGrossPrivate)} plus exact reverse E ${formatTac(summary.reverseProceedsE)}. Not quotable capacity.`;
  byId('reverse-proceeds').textContent = `+${formatTac(summary.reverseProceedsE)} TAC`;
  byId('sold-stuck').textContent = `${formatTac(summary.soldStuckB)} TAC B`;
  byId('settled-count').textContent = String(summary.settledRecoveries);
  byId('forward-fees').textContent = formatTac(summary.forwardFees);
  byId('forward-fees-note').textContent = `Gross A ${formatTac(summary.totalBridged)} less forward y ${formatTac(summary.forwardPayoutTotal)}. No extra Ethereum credit.`;
  byId('reverse-premium').textContent = formatTac(summary.reversePremium);
  byId('premium-note').textContent = `Exact reverse E ${formatTac(summary.reverseProceedsE)} less sold B ${formatTac(summary.soldStuckB)}.`;
  byId('clean-returned').textContent = formatTac(summary.cleanReturned);
  byId('residual-main').textContent = formatTac(summary.residualMain);
  byId('residual-main-note').textContent = `${summary.residualMainNoteCount} main notes. Unread ${formatTac(summary.quarantined)} and proceeds-ineligible ${formatTac(summary.proceedsExcludedMain)} TAC are excluded from measured stuck.`;
  byId('unsold-reverse').textContent = formatTac(summary.unsoldReverseStock);
  byId('unsold-reverse-note').textContent = `${summary.reverseStockNoteCount} funded notes unsold. Funding selected B ${formatTac(summary.fundingSelectedB)}; cap already consumed.`;
  byId('active-sale').textContent = formatTac(summary.activeSaleB);
  byId('measured-stuck').textContent = `${formatTac(summary.measuredStuck)} TAC`;
  byId('watch-since').textContent = formatTime(summary.watchSince);
  byId('last-sale').textContent = formatTime(summary.lastSaleAt);
  byId('last-refund').textContent = formatTime(summary.lastRefundAt);
  byId('stall-elapsed').textContent = `${summary.stallElapsed}s / ${summary.stallSecs}s`;
  byId('gate-state').textContent = summary.gateOpen ? `Open · ${summary.gateReason}` : 'Clear';
  byId('gate-state').className = summary.gateOpen ? 'clock-value bad-text' : 'clock-value good-text';
  renderEvents(result);
  renderAssertions(result);
  renderRunAll();
  updateStale();
}

function executeSelected({ preserveBatch = false, focusOnError = true, announce = true } = {}) {
  try {
    const config = readConfig();
    const result = runScenario(scenarioSelect.value, config);
    state.results.set(result.id, result);
    state.batch = preserveBatch;
    state.dirty = false;
    renderResult(result);
    if (announce) {
      const passed = result.assertions.filter((assertion) => assertion.pass).length;
      byId('live-status').textContent = `${result.name} complete. ${passed} of ${result.assertions.length} assertions passing.`;
    }
  } catch (error) {
    showValidationError(error, focusOnError);
  }
}

function executeAll() {
  try {
    const config = readConfig();
    const results = runAllScenarios(config);
    state.results = new Map(results.map((result) => [result.id, result]));
    state.batch = true;
    state.dirty = false;
    const active = state.results.get(scenarioSelect.value) || results[0];
    scenarioSelect.value = active.id;
    updateBrief();
    renderResult(active);
    const passed = results.reduce((sum, result) => sum + result.assertions.filter((assertion) => assertion.pass).length, 0);
    const total = results.reduce((sum, result) => sum + result.assertions.length, 0);
    byId('live-status').textContent = `All ${results.length} scenarios complete. ${passed} of ${total} assertions passing.`;
  } catch (error) {
    showValidationError(error, true);
  }
}

function reset() {
  scenarioSelect.value = 'normal-recovery';
  byId('bridge-count').value = String(DEFAULT_CONFIG.bridgeCount);
  byId('starting-inventory').value = formatInputTac(DEFAULT_CONFIG.startingInventory);
  byId('recovery-floor').value = (DEFAULT_CONFIG.recoveryFloorBps / 100).toFixed(2).replace(/\.00$/, '');
  byId('daily-cap').value = formatInputTac(DEFAULT_CONFIG.dailyCap);
  byId('stuck-ceiling').value = formatInputTac(DEFAULT_CONFIG.stuckCeiling);
  byId('stall-interval').value = String(DEFAULT_CONFIG.stallSecs);
  state.results.clear();
  state.batch = false;
  state.dirty = false;
  clearValidation();
  updateBrief();
  executeSelected({ announce: false });
  byId('live-status').textContent = 'Defaults restored. Normal recovery has been run in memory.';
}

SCENARIOS.forEach((definition) => {
  const option = element('option', '', `${definition.code} · ${definition.name}`);
  option.value = definition.id;
  scenarioSelect.append(option);
});
scenarioSelect.value = state.activeId;
updateBrief();
controls.addEventListener('submit', (event) => { event.preventDefault(); executeSelected(); });
byId('run-all').addEventListener('click', executeAll);
byId('reset').addEventListener('click', reset);
scenarioSelect.addEventListener('change', () => {
  updateBrief();
  const cached = state.results.get(scenarioSelect.value);
  if (cached) renderResult(cached);
  else executeSelected({ preserveBatch: state.batch, focusOnError: false });
});
fieldIds.forEach((id) => {
  byId(id).addEventListener('input', () => {
    state.dirty = true;
    byId(id).removeAttribute('aria-invalid');
    formError.hidden = true;
    updateStale();
  });
});
executeSelected({ announce: false });
