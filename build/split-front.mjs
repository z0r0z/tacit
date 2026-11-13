// Moves code out of the front page's inline module (dapp/index.html) into modules the page imports when they are needed. Two steps:
//
//   node build/split-front.mjs            the sheets, into dapp/front/sheets.js, which the page imports when a sheet first opens (and once
//                                         the page is idle). Run it on an index.html that is not split yet.
//   node build/split-front.mjs --tac      TAC's page, into dapp/front/tac.js, which the page imports when TAC's page opens (/tac/ preloads it).
//                                         Run it on an index.html whose sheets are split and whose TAC page is not. It reads front/sheets.js
//                                         (--sheets) and does not write it.
//   --dry checks and reports, writes nothing; --in a.html --out-html b.html --out-js c.js name the files.
//
// A step's entry points (its SEEDS) and everything only they reach are moved, worked out from the module's top-level binding
// graph each run. A declaration moves only when every reference to it is in moved code and it assigns no binding that stays
// in the page; what sheetsCtx hands the sheets is referenced by the page, so it stays, and the two modules never need each other.
// What the moved code reads from the page's module reaches it through install(ctx): functions, consts and imports by value, and
// let/var bindings through getters, read in the moved code as ctx.X. A step refuses, writing nothing, when the page has something
// it has not been checked against (see its EXPECT below). It needs TypeScript, which is not a dependency of the dapp: run it from
// a checkout whose node_modules has it. Afterwards run `npm run build`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const TAC = process.argv.includes('--tac');
const IN = arg('--in', join(ROOT, 'dapp', 'index.html'));
const OUT_HTML = arg('--out-html', join(ROOT, 'dapp', 'index.html'));
const OUT_JS = arg('--out-js', join(ROOT, 'dapp', 'front', TAC ? 'tac.js' : 'sheets.js'));
const SHEETS_IN = arg('--sheets', join(ROOT, 'dapp', 'front', 'sheets.js'));
const DRY = process.argv.includes('--dry');
const ts = createRequire(join(ROOT, 'package.json'))('typescript');

const fail = (msg) => { console.error(`split-front: ${msg}\nNothing was written.`); process.exit(1); };

// The sheets' entry points. A render.X entry is replaced in the page by a stub that loads the module and then rerenders X
// (rerender only paints a sheet that is open). A function entry keeps its name in the page: once the module is in it calls
// the moved one; before that it loads the module and then runs the code given here (repainting its sheet if that is open).
const SEEDS = {
  'render.wallet': null, 'render.eth': null, 'render.usdt': null, 'render.btc': null, 'render.pts': null, 'render.farm': null, 'render.borrow': null,
  renderProve: "if ($('#sheet-prove').open) reProve();",
  renderAct: "if ($('#sheet-act').open) renderAct();",
};
const MODULE_URL = '/front/sheets.js?cb=00000000';   // npm run build stamps the token

// What this script was checked against. Each list is compared with what the page has now; anything new is refused, so a person
// reads it before the page is split again (then add it here).
const EXPECT = {
  // Where the page's own code reaches an entry point. An entry reached through render[k] (openSheet, rerender, the tab
  // buttons) is not listed: it is the stub until the module is in. Keyed by the referring declaration and the line's text.
  entryRefs: new Set([
    "renderProve <- openProve: keep(d, renderProve);",
    "renderProve <- reProve: const reProve = () => keep($('#sheet-prove'), renderProve);",
    "renderAct <- paintAct: if ($('#sheet-act').open) renderAct();",
    "renderAct <- openAct: function openAct() { renderAct(); const d = $('#sheet-act'); if (!d.open) d.showModal(); syncLink(); }",
    // a button only renderFarmNotes (moved) draws, so the module is in when it is pressed
    "render.farm <- (statement): if (f && !running('farm')) { Object.assign(FARM, { open: 'precision', touched: true, mode: 'tac', reinvest: BigInt(f.dataset.fnFarm) }); keep($('#sheet-farm'), render.farm); $('#pf-go')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }",
  ]),
  // Ids that only moved code draws, and the page code that looks them up. Each was read: it is null-guarded, runs only inside a
  // sheet that has drawn, or is one of the PATCHES below. Keyed by declaration (a statement by its first characters) and id.
  sheetIds: null,   // filled in below
  // Calls in moved const and let initializers, which now run when the module installs. Each was read: pure, same value.
  installCalls: new Set(['T_TRANSACT: bytesToHex', 'T_TRANSACT: keccak_256', 'T_TRANSACT: .encode', 'T_TRANSACT: new TextEncoder', 'ROUND: .flatMap', 'ROUND: .sort']),
};
// Page code that opens a sheet and then at once uses what its renderer draws: before the module is in, that waits for it.
// Each `from` must be found exactly once in the page's module.
const PATCHES = [
  {
    why: 'dashDo presses a button the sheet draws',
    from: "if (press() && !press().disabled) press().click(); else load[sheet]?.().then(() => { rerender(sheet); press()?.click(); }).catch(() => {});",
    to: "withSheets(() => { if (press() && !press().disabled) press().click(); else load[sheet]?.().then(() => { rerender(sheet); press()?.click(); }).catch(() => {}); });",
  },
  {
    why: 'the redeem row scrolls to the borrow sheet\'s redeem block',
    from: "openSheet('borrow'); setTimeout(() => $('#bw-redeem')?.scrollIntoView({ block: 'start' }), 300);",
    to: "openSheet('borrow'); withSheets(() => setTimeout(() => $('#bw-redeem')?.scrollIntoView({ block: 'start' }), 300));",
  },
];
const STMT_IDS = [   // statements, by their first characters
  "(document.addEventListener('click', (e) => { const b = e.target.closest?.('#w-max, #pf-max,):w-max",
  "(document.addEventListener('click', (e) => { const b = e.target.closest?.('#w-max, #pf-max,):d-max",
  "(document.addEventListener('click', (e) => { const b = e.target.closest?.('#w-max, #pf-max,):pf-max",
  "(document.addEventListener('click', (e) => { const b = e.target.closest?.('#w-max, #pf-max,):pf-tmax",
  "($('#sheet-prove').addEventListener('close', () => { clearInterval(SP.timer); delete KEPT['):sp-amt",
  "(document.addEventListener('click', (e) => { const f = e.target.closest?.('[data-fn-farm]')):fn-redeem",
  "(document.addEventListener('click', (e) => { const f = e.target.closest?.('[data-fn-farm]')):fn-turn",
  "(document.addEventListener('click', (e) => { const f = e.target.closest?.('[data-fn-farm]')):pf-go",
  "(setInterval(async () => { const st = S.key ? LOCK.state : null, pub = S.key?.pubHex; if (!):bw-amt",
  "(RETRY.borrow = () => { delete FLASH['bw-status']; rerender('borrow'); };):bw-status",
];
EXPECT.sheetIds = new Set([...(`
openProve:sp-credit
paintProve:sp-credit
paintProve:sp-proofs
paintProve:sp-eth
paintProve:sp-hold
paintProve:sp-amt
paintProve:sp-then
walletBalances:wbal-box
paintWalletBal:wbal-box
outlookPaint:w-amt
outlookPaint:d-amt
outlookPaint:w-rcpt
outlookPaint:w-go
outlookPaint:d-rcpt
outlookPaint:d-go
XA:v1-status
XA:us-status
XA:bw-status
provingNote:d-status
DASH_DO:v1-claim
DASH_DO:v1-back
DASH_DO:fn-redeem
DASH_DO:pf-claim
DASH_DO:bw-see-bonds
hxRdPaint:bw-redeem
`).trim().split('\n'), ...STMT_IDS]);

// ── TAC's page (--tac) ──
// render.tac and load.tac are replaced in the page by stubs that load the module and then rerender TAC's page (only while it is shown)
// or load. A function entry keeps its name in the page: once the module is in it calls the moved one; before that, a string is code run
// once the module is in, true returns a promise of the call made once it is in, and false does nothing (what it paints is not drawn yet).
const TAC_SEEDS = {
  'render.tac': null, 'load.tac': null,
  tpgPayLink: 'tpgPayLink(...a);', tpgTab: 'tpgTab(...a);', tacPoolOpen: 'tacPoolOpen(...a);',
  tacPool: true,
  tcardQuote: false,
};
// Top-level statements that move too, by their first characters: they run when the module installs, not when the page starts. Each was
// read: it listens for what only TAC's page draws, or for a part of it whose handler has nothing to do before the module has drawn it.
const TAC_STATEMENTS = {
  "document.addEventListener('click', (e) => { const b = e.target.closest?.('[data-treq-close], ": 'treq and tco clicks',
  "$('#tac-req')?.addEventListener('close', ": 'tac-req close',
  "$('#tac-req')?.addEventListener('click', ": 'tac-req click',
  "document.addEventListener('click', (e) => { const b = e.target.closest?.('[data-tpg], ": 'tpg and tcd clicks',
  "if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(tpgStick); ": 'tpgStick on resize of the card',
  "window.addEventListener('resize', tpgStick);": 'tpgStick on resize of the window',
  "document.addEventListener('keydown', (e) => { const b = e.target.closest?.('#tcd-tabs ": 'tcd keys',
  "$('#tpg-how').addEventListener('toggle', ": 'tpg-how toggle',
};
// Declarations that stay in the page although only TAC's page reads them: BR_TO_ON takes ?stealth= from the address the page started at,
// which a link to /tac/ does not carry.
const TAC_KEEP = ['BR_TO_ON'];
const TAC_EXPECT = {
  // as EXPECT.entryRefs: the page's tpgHash and SUBLINK route links into TAC's page, tacClaimOpen waits on the pool, tcardQuoteSoon quotes
  // the card (which is not drawn before the module is in)
  entryRefs: new Set([
    "render.tac <- tacPageSet: keep($('#sheet-tac'), render.tac);",
    "load.tac <- tacPageSet: load.tac().then(() => rerender('tac')).catch(() => {});",
    'tacPool <- tacClaimOpen: tacPool().then((api) => {',
    "tacPoolOpen <- SUBLINK: else if (p === 'pool') tacPoolOpen(rest[0] || 'shield', rest[1] || null);",
    "tacPoolOpen <- tpgHash: if (head === 'pool') { tacPoolOpen(rest[0] || 'shield', rest[1] || null); return true; }",
    "tacPoolOpen <- tpgHash: if (head === 'shield' || head === 'send' || head === 'withdraw') { tacPoolOpen(head, rest[0] || null); return true; }",
    "tpgTab <- tpgHash: if (head === 'private' || head === 'cash-out' || head === 'pay' || head === 'receive') { tpgTab({ private: 'priv', 'cash-out': 'out' }[head] || head); return true; }",
    'tpgPayLink <- tpgHash: if (/^to=/.test(h)) { tpgPayLink(new URLSearchParams(h)); return true; }',
    'tcardQuote <- tcardQuoteSoon: const tcardQuoteSoon = debounce(() => tcardQuote(), 150);',
  ]),
  // as EXPECT.sheetIds: status lines of TAC's page that the bridge's and the balance's actions write to; they run on / as well, where
  // TAC's page is not drawn, so each falls back or is null-guarded
  ids: new Set(`
XA:bt-status
brAct:bt-status
brAct:br-rstatus
brAct:br-status
brPublish:tac-bal-status
brChainDue:tac-bal-status
`.trim().split('\n')),
  // the statements' listeners, on document and window and on parts of TAC's page that are in the document from the start
  installCalls: new Set([
    '(treq and tco clicks): document.addEventListener', '(tac-req close): $', '(tac-req close): .addEventListener', '(tac-req click): $', '(tac-req click): .addEventListener',
    '(tpg and tcd clicks): document.addEventListener', '(tpgStick on resize of the card): new ResizeObserver', '(tpgStick on resize of the card): $',
    '(tpgStick on resize of the card): ro.observe', '(tpgStick on resize of the window): window.addEventListener', '(tcd keys): document.addEventListener',
    '(tpg-how toggle): $', '(tpg-how toggle): .addEventListener',
  ]),
};
const TAC_PATCHES = [
  {
    why: 'the bridge link scrolls to the bridge once TAC\'s page has drawn what is above it',
    from: "requestAnimationFrame(() => $('#bridge-body')?.scrollIntoView({ block: 'start', behavior: calmMotion() ? 'auto' : 'smooth' }));",
    to: "withTac(() => requestAnimationFrame(() => $('#bridge-body')?.scrollIntoView({ block: 'start', behavior: calmMotion() ? 'auto' : 'smooth' })));",
  },
];

const STEP = TAC ? {
  seeds: TAC_SEEDS, statements: TAC_STATEMENTS, keep: TAC_KEEP, expect: TAC_EXPECT, patches: TAC_PATCHES,
  file: 'front/tac.js', url: '/front/tac.js?cb=00000000', mark: 'front-tac', ctx: 'tacCtx', code: 'TAC_CODE', ready: 'tacReady', with: 'withTac', warm: 'tacWarm',
  note: "// TAC's page is front/tac.js: it loads when TAC's page opens (/tac/ preloads it), or when a link to it is pointed at or focused.",
  warmCode: `const tacWarm = (e) => { if (!TAC_CODE && e.target.closest?.('a[href^="/tac/"], a[href^="/chain/"]')) tacReady().catch(() => {}); };
for (const t of ['pointerover', 'focusin']) document.addEventListener(t, tacWarm, { passive: true });`,
  head: `// TAC's page. index.html imports this when TAC's page opens (its address, /tac/, preloads it) or a link to it is pointed at, and calls
// install() with what this code reads from its module: let and var bindings are read as ctx.X, so their changes there are seen here.`,
} : {
  seeds: SEEDS, statements: {}, keep: [], expect: { entryRefs: EXPECT.entryRefs, ids: EXPECT.sheetIds, installCalls: EXPECT.installCalls }, patches: PATCHES,
  file: 'front/sheets.js', url: MODULE_URL, mark: 'front-sheets', ctx: 'sheetsCtx', code: 'SHEET_CODE', ready: 'sheetsReady', with: 'withSheets', warm: 'sheetsWarm',
  note: "// The sheets' code is front/sheets.js: it loads when a sheet first opens, on the first press or key, or once the page is idle.",
  warmCode: `const sheetsWarm = () => { sheetsReady().catch(() => {}); };
for (const t of ['pointerdown', 'keydown']) document.addEventListener(t, sheetsWarm, { once: true, capture: true, passive: true });
if (document.readyState === 'complete') (window.requestIdleCallback || setTimeout)(sheetsWarm);
else addEventListener('load', () => (window.requestIdleCallback || setTimeout)(sheetsWarm), { once: true });`,
  head: `// The front page's sheets. index.html imports this when one first opens, or once the page is idle, and calls install() with
// what this code reads from its module: let and var bindings are read as ctx.X, so their changes there are seen here.`,
};
const isMember = (s) => /^(render|load)\./.test(s);

// ── read the page ──
const html = readFileSync(IN, 'utf8');
if (TAC) {
  if (html.includes('/front/tac.js') || html.includes('// front-tac:begin')) fail(`${IN} has TAC's page split out already (it names /front/tac.js). Run this on an index.html whose TAC page is not split.`);
  if (!html.includes('// front-sheets:begin')) fail(`${IN} does not have its sheets split out: run \`node build/split-front.mjs\` first.`);
} else if (html.includes('/front/sheets.js') || html.includes('// front-sheets:begin')) fail(`${IN} is split already (it names /front/sheets.js). Run this on an index.html that is not split.`);
const OPEN = '<script type="module">\n';
const starts = [...html.matchAll(/<script type="module">\n/g)].map((m) => m.index);
const blocks = starts.map((s) => ({ s: s + OPEN.length, e: html.indexOf('</script>', s) }));
const mains = blocks.filter((b) => html.slice(b.s, b.e).includes('\nconst render = {}, load = {};'));
if (mains.length !== 1) fail(`expected one inline module declaring \`const render = {}, load = {};\`, found ${mains.length}`);
const { s: MS, e: ME } = mains[0];
const src = html.slice(MS, ME);

// ── parse and bind (no lib: what does not resolve to the module is a global) ──
const FILE = '/main.js';
const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
const host = {
  getSourceFile: (n) => (n === FILE ? sf : undefined), writeFile() {}, getDefaultLibFileName: () => 'lib.d.ts', useCaseSensitiveFileNames: () => true,
  getCanonicalFileName: (f) => f, getCurrentDirectory: () => '/', getNewLine: () => '\n', fileExists: (f) => f === FILE, readFile: () => undefined,
  directoryExists: () => true, getDirectories: () => [],
};
const program = ts.createProgram([FILE], { allowJs: true, noLib: true, noResolve: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, types: [] }, host);
const syntax = program.getSyntacticDiagnostics(sf);
if (syntax.length) fail(`the inline module does not parse: ${ts.flattenDiagnosticMessageText(syntax[0].messageText, '\n')}`);
const checker = program.getTypeChecker();
const locals = sf.locals;
const lineOf = (p) => sf.getLineAndCharacterOfPosition(p).line + 1;
const stmtHead = (n) => src.slice(n.st.getStart(), n.end).replace(/\s+/g, ' ').slice(0, 90);
const lineText = (p) => { const a = src.lastIndexOf('\n', p - 1) + 1, b = src.indexOf('\n', p); return src.slice(a, b < 0 ? src.length : b).trim(); };

// ── nodes: each top-level declaration (one per declarator), each render.X / load.X assignment, and other statements ──
const nodes = [];
const kindOf = new Map();   // top-level name -> const | let | var | function | class | import
for (const st of sf.statements) {
  const start = st.getFullStart(), end = st.getEnd();
  if (ts.isImportDeclaration(st)) {
    const names = [];
    const cl = st.importClause;
    if (cl?.name) names.push(cl.name.text);
    if (cl?.namedBindings) { if (ts.isNamespaceImport(cl.namedBindings)) names.push(cl.namedBindings.name.text); else for (const e of cl.namedBindings.elements) names.push(e.name.text); }
    for (const n of names) kindOf.set(n, 'import');
    nodes.push({ id: `import@${lineOf(st.getStart())}`, kind: 'import', st, start, end, names });
    continue;
  }
  if (ts.isVariableStatement(st)) {
    const f = st.declarationList.flags, kind = f & ts.NodeFlags.Const ? 'const' : f & ts.NodeFlags.Let ? 'let' : 'var';
    const ds = st.declarationList.declarations;
    ds.forEach((d) => {
      const names = [];
      const collect = (b) => { if (ts.isIdentifier(b)) names.push(b.text); else for (const el of b.elements) if (!ts.isOmittedExpression(el)) collect(el.name); };
      collect(d.name);
      for (const n of names) kindOf.set(n, kind);
      nodes.push({ id: names.join(','), kind, st, decl: d, start, end, names, multi: ds.length > 1 });
    });
    continue;
  }
  if (ts.isFunctionDeclaration(st) && st.name) { kindOf.set(st.name.text, 'function'); nodes.push({ id: st.name.text, kind: 'function', st, start, end, names: [st.name.text] }); continue; }
  if (ts.isClassDeclaration(st) && st.name) { kindOf.set(st.name.text, 'class'); nodes.push({ id: st.name.text, kind: 'class', st, start, end, names: [st.name.text] }); continue; }
  const ex = ts.isExpressionStatement(st) && st.expression;
  if (ex && ts.isBinaryExpression(ex) && ex.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(ex.left) && ts.isIdentifier(ex.left.expression) && ['render', 'load'].includes(ex.left.expression.text)) {
    nodes.push({ id: `${ex.left.expression.text}.${ex.left.name.text}`, kind: 'member', st, start, end, names: [] });
    continue;
  }
  nodes.push({ id: `stmt@${lineOf(st.getStart())}`, kind: 'stmt', st, start, end, names: [] });
}
const byName = new Map();
for (const n of nodes) for (const nm of n.names) byName.set(nm, n);
const byId = new Map(nodes.map((n) => [n.id, n]));
for (const n of nodes) if (n.kind === 'member' && nodes.filter((m) => m.id === n.id).length > 1) fail(`${n.id} is assigned at top level more than once`);

const isTop = (sym) => sym && locals.get(sym.escapedName) === sym;
function isWrite(id) {
  let p = id.parent, c = id;
  while (p && (ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p) || ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && p.initializer === c) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || ts.isParenthesizedExpression(p))) { c = p; p = p.parent; }
  if (p && ts.isBinaryExpression(p) && p.left === c && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
  if ((ts.isPrefixUnaryExpression(id.parent) || ts.isPostfixUnaryExpression(id.parent)) && (id.parent.operator === ts.SyntaxKind.PlusPlusToken || id.parent.operator === ts.SyntaxKind.MinusMinusToken)) return true;
  if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === c) return true;
  return false;
}
// inside a function that the statement itself does not run when it runs
const deferred = (node, st) => { for (let p = node.parent; p && p !== st; p = p.parent) if (ts.isFunctionLike(p)) return true; return ts.isFunctionLike(st) || ts.isClassDeclaration(st); };
const inFn = (node, st, arrows) => { for (let p = node.parent; p && p !== st.parent; p = p.parent) if (ts.isFunctionLike(p) && (arrows || !ts.isArrowFunction(p))) return true; return false; };

// ── references ──
const refs = new Map(nodes.map((n) => [n.id, []]));   // node id -> [{ name, target, pos, write, eager, shorthand }]
const oddities = new Map(nodes.map((n) => [n.id, []]));
for (const n of nodes) {
  if (n.kind === 'import') continue;
  const out = refs.get(n.id), odd = oddities.get(n.id);
  const visit = (node) => {
    if (node.pos >= n.end || node.end <= n.start) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword && !inFn(node, n.st, false)) odd.push(`this at line ${lineOf(node.getStart())}`);
    if (ts.isMetaProperty(node)) odd.push(`${node.getText()} at line ${lineOf(node.getStart())}`);
    if (ts.isAwaitExpression(node) && !inFn(node, n.st, true)) odd.push(`top-level await at line ${lineOf(node.getStart())}`);
    if (ts.isForOfStatement(node) && node.awaitModifier && !inFn(node, n.st, true)) odd.push(`top-level for await at line ${lineOf(node.getStart())}`);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = node.arguments[0];
      if (!a || !ts.isStringLiteralLike(a)) odd.push(`import() of a computed specifier at line ${lineOf(node.getStart())}`);
      else if (!a.text.startsWith('/') && !/^https:/.test(a.text)) odd.push(`import('${a.text}') is relative (line ${lineOf(node.getStart())})`);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && /^(Worker|SharedWorker)$/.test(node.expression.text)) {
      const a = node.arguments?.[0];
      if (!a || !ts.isStringLiteralLike(a) || !a.text.startsWith('/')) odd.push(`new ${node.expression.text} with a relative or computed URL at line ${lineOf(node.getStart())}`);
    }
    if (ts.isIdentifier(node)) {
      const par = node.parent;
      if (node.text === 'arguments' && !inFn(node, n.st, false)) odd.push(`arguments at line ${lineOf(node.getStart())}`);
      if (ts.isPropertyAccessExpression(par) && par.name === node) return;
      if ((ts.isPropertyAssignment(par) || ts.isMethodDeclaration(par) || ts.isPropertyDeclaration(par) || ts.isGetAccessor(par) || ts.isSetAccessor(par) || ts.isPropertySignature(par) || ts.isEnumMember(par)) && par.name === node) return;
      if (ts.isLabeledStatement(par) || ts.isBreakOrContinueStatement(par)) return;
      if (ts.isBindingElement(par) && par.propertyName === node) return;
      const shorthand = ts.isShorthandPropertyAssignment(par) && par.name === node;
      const sym = shorthand ? checker.getShorthandAssignmentValueSymbol(par) : checker.getSymbolAtLocation(node);
      if (!isTop(sym)) return;
      const tgt = byName.get(node.text);
      if (!tgt) return;
      if (n.names.includes(node.text) && par.name === node && (ts.isVariableDeclaration(par) || ts.isFunctionDeclaration(par) || ts.isClassDeclaration(par) || ts.isBindingElement(par))) return;
      let target = tgt.id;
      if ((node.text === 'render' || node.text === 'load') && ts.isPropertyAccessExpression(par) && par.expression === node && byId.has(`${node.text}.${par.name.text}`)) target = `${node.text}.${par.name.text}`;
      out.push({ name: node.text, target, pos: node.getStart(), write: isWrite(node), eager: !deferred(node, n.st), shorthand });
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(n.st, visit);
}
const inbound = new Map(nodes.map((n) => [n.id, new Set()]));
for (const n of nodes) for (const r of refs.get(n.id)) if (r.target !== n.id) inbound.get(r.target).add(n.id);
const writers = new Map();   // name -> Set(node id)
for (const n of nodes) for (const r of refs.get(n.id)) if (r.write) { if (!writers.has(r.name)) writers.set(r.name, new Set()); writers.get(r.name).add(n.id); }

// ── the moved set ──
const SEEDS_ = STEP.seeds;
for (const s of Object.keys(SEEDS_)) {
  const n = byId.get(s);
  if (!n) fail(`entry point ${s} is not a top-level declaration or render.X/load.X assignment any more`);
  if (isMember(s) ? n.kind !== 'member' : n.kind !== 'function') fail(`entry point ${s} is a ${n.kind}, expected ${isMember(s) ? `a ${s.split('.')[0]}.X assignment` : 'a function declaration'}`);
}
const flat = (n) => src.slice(n.st.getStart(), n.end).replace(/\s+/g, ' ');
const stmtLabel = new Map();   // statement node id -> its label in STEP.statements
for (const [h, label] of Object.entries(STEP.statements)) {
  const hit = nodes.filter((n) => n.kind === 'stmt' && flat(n).startsWith(h));
  if (hit.length !== 1) fail(`expected one top-level statement starting \`${h}\`, found ${hit.length}`);
  stmtLabel.set(hit[0].id, label);
}
const seeds = new Set([...Object.keys(SEEDS_), ...stmtLabel.keys()]);
const nameOf = (id) => (stmtLabel.has(id) ? `(${stmtLabel.get(id)})` : id);
for (const k of STEP.keep) if (!byName.has(k)) console.warn(`split-front: note, ${k} is kept in the page but the page no longer declares it`);
const movable = (n) => !['stmt', 'import', 'member'].includes(n.kind) && !n.multi && n.id !== 'render' && n.id !== 'load' && !n.names.some((x) => STEP.keep.includes(x));
// everything the entry points reach, then less what the page reaches
const moved = new Set(seeds);
for (const q = [...seeds]; q.length;) for (const r of refs.get(q.pop())) {
  const t = byId.get(r.target);
  if (!moved.has(t.id) && movable(t)) { moved.add(t.id); q.push(t.id); }
}
// keep in the page what assigns a binding the page keeps, and then what the page now reaches
const declOf = (name) => byName.get(name)?.id;
for (let changed = true; changed;) {
  changed = false;
  for (const id of [...moved]) {
    if (seeds.has(id)) continue;
    const writesOut = refs.get(id).some((r) => r.write && !moved.has(declOf(r.name)));
    const reachedOut = [...inbound.get(id)].some((x) => !moved.has(x));
    if (writesOut || reachedOut) { moved.delete(id); changed = true; }
  }
}
const order = nodes.filter((n) => moved.has(n.id));


// ── checks ──
const EX = TAC ? 'TAC_EXPECT' : 'EXPECT', EX_IDS = TAC ? 'TAC_EXPECT.ids' : 'EXPECT.sheetIds';
const OTHER_CTX = TAC ? 'sheetsCtx' : null;   // what the page hands the sheets: one reference, whatever the line holds
const problems = [];
for (const n of order) for (const o of oddities.get(n.id)) problems.push(`${nameOf(n.id)}: ${o}`);
for (const n of order) for (const r of refs.get(n.id)) if (r.write && !moved.has(declOf(r.name))) problems.push(`${nameOf(n.id)} assigns ${r.name}, which stays in the page (line ${lineOf(r.pos)})`);
const seen = new Set();
for (const n of order) for (const x of inbound.get(n.id)) {
  if (moved.has(x)) continue;
  if (!seeds.has(n.id)) { problems.push(`${n.id} is moved but the page's ${x} reads it`); continue; }
  for (const r of refs.get(x)) if (r.target === n.id) {
    const key = x === OTHER_CTX ? `${n.id} <- ${x}` : `${n.id} <- ${byId.get(x).kind === 'stmt' ? '(statement)' : x}: ${lineText(r.pos)}`;
    seen.add(key);
    if (!STEP.expect.entryRefs.has(key)) problems.push(`new reference to an entry point, read it and add it to ${EX}.entryRefs if a stub serves it:\n    ${key}`);
  }
}
for (const k of STEP.expect.entryRefs) if (!seen.has(k)) console.warn(`split-front: note, ${EX}.entryRefs lists a reference the page no longer has: ${k}`);
for (const k of Object.keys(SEEDS_)) if (isMember(k) && !moved.has(k)) problems.push(`${k} is not moved`);
// a function entry's stub needs the stubs' bindings, which are set where the stubs are: nothing before them may call one as the page starts
const stubAt = byId.get('render').end;
for (const n of nodes) if (!moved.has(n.id) && n.start < stubAt) for (const r of refs.get(n.id)) if (r.eager && r.target in SEEDS_ && !isMember(r.target)) problems.push(`${nameOf(n.id)} calls the entry point ${r.target} before the stubs are set (line ${lineOf(r.pos)})`);
// the moved code's consts, lets and statements run when the module installs, not when the page starts: their first values must
// not depend on when that is, so they may read only the page's consts, functions and imports, and call only what was checked
const calleeOf = (node) => {
  const c = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
  const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? (ts.isIdentifier(c.expression) ? `${c.expression.text}.` : '.') + c.name.text : '(expr)';
  return (ts.isNewExpression(node) ? 'new ' : '') + name;
};
const installCalls = new Set();
for (const n of order) {
  if (n.kind === 'function' || n.kind === 'class') continue;
  for (const r of refs.get(n.id)) if (r.eager && !moved.has(r.target) && !['const', 'function', 'import'].includes(kindOf.get(r.name))) problems.push(`${nameOf(n.id)} reads the page's ${kindOf.get(r.name)} ${r.name} as it is declared (line ${lineOf(r.pos)})`);
  const v = (node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) installCalls.add(`${nameOf(n.id)}: ${calleeOf(node)}`);
    ts.forEachChild(node, v);
  };
  ts.forEachChild(n.decl || n.st, v);
}
for (const c of installCalls) if (!STEP.expect.installCalls.has(c)) problems.push(`moved code runs ${c} when the module installs (it ran when the page started): check that it gives the same value and has no other effect, then add "${c}" to ${EX}.installCalls`);
for (const c of STEP.expect.installCalls) if (!installCalls.has(c)) console.warn(`split-front: note, ${EX}.installCalls lists a call the moved code no longer makes: ${c}`);
// a top-level await after the stubs would let the module install before the page's later bindings are set
for (const n of nodes) if (!moved.has(n.id) && n.start >= stubAt) for (const o of oddities.get(n.id)) if (/await/.test(o)) problems.push(`the page has a ${o} after the stubs`);
// names this adds
const movedText = order.map((n) => src.slice(n.start, n.end)).join('');
const ADDED = [STEP.ctx, STEP.code, STEP.ready, STEP.with, STEP.warm];
for (const w of ADDED) if (new RegExp(`\\b${w}\\b`).test(src)) problems.push(`the page already uses the name ${w}`);
for (const w of ['ctx', 'install']) if (new RegExp(`\\b${w}\\b`).test(movedText)) problems.push(`moved code already uses the name ${w}`);

// ids only moved code draws, and the code that looks them up: the page's, and the sheets' (which do not wait for TAC's page)
const idsIn = (t) => new Set([...t.matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map((m) => m[1]));
const setIds = (t) => [...t.matchAll(/\.id\s*=\s*['"`]([A-Za-z][\w-]*)['"`]/g)].map((m) => m[1]);
const mainText = nodes.filter((n) => !moved.has(n.id)).map((n) => src.slice(n.start, n.end)).join('');
const sideText = TAC ? readFileSync(SHEETS_IN, 'utf8') : '';
const outsideIds = new Set([...idsIn(html.slice(0, MS) + html.slice(ME)), ...idsIn(mainText), ...setIds(mainText), ...idsIn(sideText), ...setIds(sideText)]);
const onlyMoved = [...new Set([...idsIn(movedText), ...[...movedText.matchAll(/(?<!href=)['"`]#([A-Za-z][\w-]*[\w])(?![\w$=-])/g)].map((m) => m[1])])].filter((x) => !outsideIds.has(x));
const lookups = new Set();
const lookIn = (who, t) => { for (const x of onlyMoved) if (new RegExp(`['"\`#]${x.replace(/-/g, '\\-')}(?![\\w-])`).test(t)) lookups.add(`${who}:${x}`); };
for (const n of nodes) if (!moved.has(n.id) && n.kind !== 'import') lookIn(n.kind === 'stmt' ? `(${stmtHead(n)})` : n.id, src.slice(n.start, n.end));
if (TAC) lookIn('front/sheets.js', sideText);
for (const k of lookups) if (!STEP.expect.ids.has(k)) problems.push(`code outside ${STEP.file} looks up ${k.split(':')[1]}, which only ${STEP.file} draws (${k.split(':')[0]}): if it can run before the module is in, make it wait with ${STEP.with}() in its PATCHES, then add "${k}" to ${EX_IDS}`);
for (const k of STEP.expect.ids) if (!lookups.has(k)) console.warn(`split-front: note, ${EX_IDS} lists a lookup the page no longer has: ${k}`);
if (problems.length) fail(`refusing to split:\n  - ${problems.join('\n  - ')}`);

// ── what crosses: page names the moved code reads ──
const LIVE = (name) => ['let', 'var'].includes(kindOf.get(name));
const byValue = new Set(), live = new Set();
const edits = [];   // [pos in src, name, shorthand]
for (const n of order) for (const r of refs.get(n.id)) {
  if (moved.has(declOf(r.name))) continue;
  if (LIVE(r.name)) { live.add(r.name); edits.push([r.pos, r.name, r.shorthand]); } else byValue.add(r.name);
}
for (const name of byValue) if (writers.has(name)) fail(`the page reassigns ${name} (a ${kindOf.get(name)}), which the moved code would read by value`);

// ── the module ──
edits.sort((a, b) => a[0] - b[0]);
const pieces = [];
for (const n of order) {
  let p = n.start;
  for (const [pos, name, shorthand] of edits) {
    if (pos < n.start || pos >= n.end) continue;
    pieces.push(src.slice(p, pos), shorthand ? `${name}: ctx.${name}` : `ctx.${name}`);
    p = pos + name.length;
  }
  pieces.push(src.slice(p, n.end));
}
const body = pieces.join('');
const D = [...byValue].sort(), L = [...live].sort();
const entries = Object.keys(SEEDS_).filter((s) => !isMember(s));
const moduleJs = `${STEP.head}
export default function install(ctx) {
const { ${D.join(', ')} } = ctx;
${body.replace(/^\n+/, '')}
return { ${entries.join(', ')} };
}
`;

// ── the page ──
const { ctx: CTX, code: CODE, ready: READY, with: WITH } = STEP;
const ctxBlock = (d, l) => `// ${STEP.mark}:begin\nconst ${CTX} = () => ({ ${[...d, ...l.map((x) => `get ${x}() { return ${x}; }`)].join(', ')} });\n// ${STEP.mark}:end`;
const membersOf = (o) => Object.keys(SEEDS_).filter((s) => s.startsWith(`${o}.`)).map((s) => s.slice(o.length + 1));
const renders = membersOf('render'), loads = membersOf('load');
const entryStub = (e) => {
  const v = SEEDS_[e], head = `function ${e}(...a) { if (${CODE}) return ${CODE}.${e}(...a);`;
  return v === false ? `${head} }` : v === true ? `${head} return ${READY}().then(() => ${CODE}.${e}(...a)); }` : `${head} ${WITH}(() => { ${v} }); }`;
};
const stub = `
${STEP.note}
${ctxBlock(D, L)}
let ${CODE} = null;
const ${READY} = lazy(() => import('${STEP.url}').then((m) => { ${CODE} ||= m.default(${CTX}()); }));
const ${WITH} = (f) => (${CODE} ? f() : ${READY}().then(f, () => {}));
${renders.length ? `for (const k of ${JSON.stringify(renders)}) render[k] = () => { if (!${CODE}) ${WITH}(() => rerender(k)); };\n` : ''}${loads.length ? `for (const k of ${JSON.stringify(loads)}) load[k] = () => ${READY}().then(() => load[k]());\n` : ''}${entries.map(entryStub).join('\n')}
${STEP.warmCode}`;
let main = '';
{
  let p = 0;
  for (const n of order) { main += src.slice(p, n.start); p = n.end; }
  main += src.slice(p);
}
const anchor = '\nconst render = {}, load = {};';
if (main.split(anchor).length !== 2) fail('expected `const render = {}, load = {};` once in the page module');
main = main.replace(anchor, () => anchor + stub);
for (const pt of STEP.patches) {
  const k = main.split(pt.from).length - 1;
  if (k !== 1) fail(`${pt.why}: expected its code once in the page module, found it ${k} times:\n    ${pt.from}`);
  main = main.replace(pt.from, () => pt.to);
}
const out = html.slice(0, MS) + main + html.slice(ME);

// ── both halves must parse ──
for (const [name, text] of [['index.html module', main], [STEP.file, moduleJs]]) {
  const f = ts.createSourceFile('/x.js', text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const d = f.parseDiagnostics || [];
  if (d.length) fail(`${name} would not parse: ${ts.flattenDiagnosticMessageText(d[0].messageText, '\n')} at ${f.getLineAndCharacterOfPosition(d[0].start).line + 1}`);
}

console.log(`split-front: moving ${order.length} declarations and statements (${movedText.length} bytes) to ${STEP.file}; ctx ${D.length} names by value, ${L.length} live (${L.join(', ')})`);
console.log(`  index.html ${html.length} -> ${out.length} bytes; ${STEP.file} ${moduleJs.length} bytes`);
if (DRY) process.exit(0);
writeFileSync(OUT_HTML, out);
mkdirSync(dirname(OUT_JS), { recursive: true });
writeFileSync(OUT_JS, moduleJs);
