// The front page's sheets are dapp/front/sheets.js, which the page's inline module imports when one first opens, and TAC's page is
// dapp/front/tac.js, which it imports when TAC's page opens; each one's install(ctx) gets what it reads from the module. A name a module reads
// that ctx does not carry is a ReferenceError only when that sheet or TAC's page opens, and a page name read by value that the page later
// reassigns is stale there. This reads the files the way a compiler does: every name a module reads is its own, the browser's, or taken from
// ctx; ctx carries each of those (a let or var through a getter); the page reads nothing that moved except through its stubs; the two
// modules do not need each other; and TAC's page, /tac/, preloads front/tac.js under the URL the module imports it by.
// Needs the `typescript` package (a compiler, used only to read the code); without it the test says so and passes.
//   node tests/front-sheets.test.mjs [index.html sheets.js tac.js tac/index.html]
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), DAPP = join(ROOT, 'dapp');
let ts;
try { ts = createRequire(import.meta.url)('typescript'); } catch { console.log('skipped: the typescript package is not installed'); process.exit(0); }

let fails = 0;
const ok = (c, msg) => { if (c) console.log(`ok   ${msg}`); else { fails++; console.log(`FAIL ${msg}`); } };

const html = readFileSync(process.argv[2] || join(DAPP, 'index.html'), 'utf8');
const MODULES = [
  { file: 'front/sheets.js', text: readFileSync(process.argv[3] || join(DAPP, 'front', 'sheets.js'), 'utf8'), ctx: 'sheetsCtx', code: 'SHEET_CODE', ready: 'sheetsReady', what: 'sheets' },
  { file: 'front/tac.js', text: readFileSync(process.argv[4] || join(DAPP, 'front', 'tac.js'), 'utf8'), ctx: 'tacCtx', code: 'TAC_CODE', ready: 'tacReady', what: 'TAC\'s page' },
];
const tacPage = readFileSync(process.argv[5] || join(DAPP, 'tac', 'index.html'), 'utf8');
const mains = [...html.matchAll(/<script type="module">\n([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((t) => t.includes('\nconst render = {}, load = {};'));
if (mains.length !== 1) { console.log(`FAIL expected one inline module declaring render, found ${mains.length}`); process.exit(1); }
const main = mains[0];

// one program per file: the page's module with no lib (what does not resolve is free), sheets.js with the browser's lib
function programOf(file, text, lib) {
  const options = { allowJs: true, noResolve: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, types: [], ...(lib ? { lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'] } : { noLib: true }) };
  const host = ts.createCompilerHost(options, true);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const get = host.getSourceFile.bind(host), exists = host.fileExists.bind(host);
  host.getSourceFile = (n, ...a) => (n === file ? sf : get(n, ...a));
  host.fileExists = (n) => n === file || exists(n);
  const p = ts.createProgram([file], options, host);
  return { sf, checker: p.getTypeChecker(), syntax: p.getSyntacticDiagnostics(sf) };
}
// each identifier that reads a binding (not a property name, label or the name a declaration introduces)
function reads(sf, checker, each) {
  const v = (node) => {
    if (ts.isIdentifier(node)) {
      const par = node.parent;
      if (ts.isPropertyAccessExpression(par) && par.name === node) return;
      if ((ts.isPropertyAssignment(par) || ts.isMethodDeclaration(par) || ts.isGetAccessor(par) || ts.isSetAccessor(par) || ts.isPropertyDeclaration(par)) && par.name === node) return;
      if (ts.isLabeledStatement(par) || ts.isBreakOrContinueStatement(par)) return;
      if (ts.isBindingElement(par) && par.propertyName === node) return;
      if ((ts.isVariableDeclaration(par) || ts.isFunctionDeclaration(par) || ts.isFunctionExpression(par) || ts.isClassDeclaration(par) || ts.isClassExpression(par) || ts.isParameter(par) || ts.isBindingElement(par) || ts.isImportSpecifier(par) || ts.isImportClause(par) || ts.isNamespaceImport(par)) && par.name === node) return;
      const shorthand = ts.isShorthandPropertyAssignment(par) && par.name === node;
      each(node, shorthand ? checker.getShorthandAssignmentValueSymbol(par) : checker.getSymbolAtLocation(node));
      return;
    }
    ts.forEachChild(node, v);
  };
  v(sf);
}
const isWrite = (id) => {
  let p = id.parent, c = id;
  while (p && (ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p) || ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && p.initializer === c) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || ts.isParenthesizedExpression(p))) { c = p; p = p.parent; }
  if (p && ts.isBinaryExpression(p) && p.left === c && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
  if ((ts.isPrefixUnaryExpression(id.parent) || ts.isPostfixUnaryExpression(id.parent)) && (id.parent.operator === ts.SyntaxKind.PlusPlusToken || id.parent.operator === ts.SyntaxKind.MinusMinusToken)) return true;
  return !!p && (ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === c;
};

// ── the page's module ──
const M = programOf('/main.js', main, false);
ok(!M.syntax.length, 'the page\'s module parses');
const kind = new Map();   // top-level name -> const | let | var | function | class | import
const topFn = new Map();  // top-level function name -> its declaration
for (const st of M.sf.statements) {
  if (ts.isImportDeclaration(st)) {
    const cl = st.importClause;
    if (cl?.name) kind.set(cl.name.text, 'import');
    if (cl?.namedBindings) { if (ts.isNamespaceImport(cl.namedBindings)) kind.set(cl.namedBindings.name.text, 'import'); else for (const e of cl.namedBindings.elements) kind.set(e.name.text, 'import'); }
  } else if (ts.isVariableStatement(st)) {
    const f = st.declarationList.flags, k = f & ts.NodeFlags.Const ? 'const' : f & ts.NodeFlags.Let ? 'let' : 'var';
    const collect = (b) => { if (ts.isIdentifier(b)) kind.set(b.text, k); else for (const el of b.elements) if (!ts.isOmittedExpression(el)) collect(el.name); };
    for (const d of st.declarationList.declarations) collect(d.name);
  } else if (ts.isFunctionDeclaration(st) && st.name) { kind.set(st.name.text, 'function'); topFn.set(st.name.text, st); }
  else if (ts.isClassDeclaration(st) && st.name) kind.set(st.name.text, 'class');
}
const top = (sym) => !!sym && M.sf.locals.get(sym.escapedName) === sym;
const reassigned = new Set(), freeInMain = new Map();
reads(M.sf, M.checker, (id, sym) => {
  if (top(sym) && isWrite(id)) reassigned.add(id.text);
  if (!sym) freeInMain.set(id.text, (freeInMain.get(id.text) || 0) + 1);
});

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const movedBy = new Map();   // module file -> the names its install declares
for (const M_ of MODULES) {
  const { file, text, ctx: CTX, code: CODE, ready: READY } = M_;
  // the page's ctx: `const ${CTX} = () => ({ a, b, get c() { return c; } })`
  let ctxDecl = null;
  for (const st of M.sf.statements) if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === CTX) ctxDecl = d;
  const byValue = new Set(), getters = new Set(), oddCtx = [];
  const obj = ctxDecl?.initializer && ts.isArrowFunction(ctxDecl.initializer) && ts.isParenthesizedExpression(ctxDecl.initializer.body) ? ctxDecl.initializer.body.expression : null;
  ok(!!obj && ts.isObjectLiteralExpression(obj), `the page declares ${CTX} as an object of names`);
  for (const p of obj?.properties || []) {
    if (ts.isShorthandPropertyAssignment(p)) byValue.add(p.name.text);
    else if (ts.isGetAccessor(p) && ts.isIdentifier(p.name) && p.body?.statements.length === 1 && ts.isReturnStatement(p.body.statements[0]) && p.body.statements[0].expression?.getText() === p.name.text) getters.add(p.name.text);
    else oddCtx.push(p.getText().slice(0, 60));
  }
  ok(!oddCtx.length, `${CTX} holds only names and getters of the same name${oddCtx.length ? `: ${oddCtx.join(' · ')}` : ''}`);
  const undeclared = [...byValue, ...getters].filter((n) => !kind.has(n));
  ok(!undeclared.length, `every name in ${CTX} is declared at the top of the page's module${undeclared.length ? `: ${undeclared.join(', ')}` : ''}`);
  const liveByValue = [...byValue].filter((n) => ['let', 'var'].includes(kind.get(n)) || reassigned.has(n));
  ok(!liveByValue.length, `${CTX} passes no let, var or reassigned binding by value${liveByValue.length ? `: ${liveByValue.join(', ')}` : ''}`);

  // ── the module ──
  const S = programOf(`/${file}`, text, true);
  ok(!S.syntax.length, `${file} parses`);
  const install = S.sf.statements.find((st) => ts.isFunctionDeclaration(st) && st.name?.text === 'install' && (ts.getCombinedModifierFlags(st) & ts.ModifierFlags.ExportDefault) === ts.ModifierFlags.ExportDefault);
  ok(!!install, `${file} exports install as its default`);
  const ctxParam = install?.parameters[0]?.name;
  const first = install?.body.statements[0];
  const D = new Set();
  if (first && ts.isVariableStatement(first) && first.declarationList.declarations.length === 1) {
    const d = first.declarationList.declarations[0];
    if (ts.isObjectBindingPattern(d.name) && d.initializer?.getText() === ctxParam?.getText()) for (const el of d.name.elements) if (!el.propertyName && !el.initializer && !el.dotDotDotToken && ts.isIdentifier(el.name)) D.add(el.name.text);
  }
  ok(D.size > 0, `${file}: install starts by taking names from ${ctxParam?.getText()} (${D.size})`);
  const L = new Set();
  const ctxSym = ctxParam && S.checker.getSymbolAtLocation(ctxParam);
  const otherCtx = [];
  reads(S.sf, S.checker, (id, sym) => {
    if (sym !== ctxSym) return;
    if (ts.isPropertyAccessExpression(id.parent) && id.parent.expression === id) { if (isWrite(id.parent)) otherCtx.push(`writes ${id.parent.getText()}`); else L.add(id.parent.name.text); }
    else if (!(ts.isVariableDeclaration(id.parent) && id.parent === first.declarationList.declarations[0])) otherCtx.push(id.parent.getText().slice(0, 40));
  });
  ok(!otherCtx.length, `${file} uses ctx only to take names from it and read ctx.X${otherCtx.length ? `: ${otherCtx.join(' · ')}` : ''}`);
  const missValue = [...D].filter((n) => !byValue.has(n)), missLive = [...L].filter((n) => !getters.has(n));
  ok(!missValue.length, `${CTX} carries every name ${file} takes from it by value${missValue.length ? `; missing: ${missValue.join(', ')}` : ''}`);
  ok(!missLive.length, `${CTX} has a getter for every ctx.X ${file} reads${missLive.length ? `; missing: ${missLive.join(', ')}` : ''}`);
  const extra = [...byValue].filter((n) => !D.has(n)).concat([...getters].filter((n) => !L.has(n)));
  ok(!extra.length, `${CTX} carries nothing ${file} does not take (npm run build makes it from ${file})${extra.length ? `: ${extra.join(', ')}` : ''}`);

  // every name the module reads is its own, the browser's, or taken from ctx; a browser name the page also declares meant the page's
  const own = (sym) => sym?.declarations?.some((d) => d.getSourceFile() === S.sf);
  const notDeclared = new Set(), pageNames = new Set();
  reads(S.sf, S.checker, (id, sym) => {
    if (own(sym)) return;
    if (!sym) notDeclared.add(id.text);
    else if (kind.has(id.text)) pageNames.add(id.text);
  });
  ok(!notDeclared.size, `${file} reads no name that is neither its own, taken from ctx nor the browser's${notDeclared.size ? `: ${[...notDeclared].join(', ')}` : ''}`);
  ok(!pageNames.size, `${file} reads none of the page's names except through ctx${pageNames.size ? `: ${[...pageNames].join(', ')}` : ''}`);

  // ── what moved: install's own declarations and the render.X and load.X it sets ──
  const movedNames = new Set(), movedRender = new Set(), movedLoad = new Set();
  for (const st of install?.body.statements || []) {
    if (st === first) continue;
    if (ts.isFunctionDeclaration(st) && st.name) movedNames.add(st.name.text);
    else if (ts.isClassDeclaration(st) && st.name) movedNames.add(st.name.text);
    else if (ts.isVariableStatement(st)) { const c = (b) => { if (ts.isIdentifier(b)) movedNames.add(b.text); else for (const el of b.elements) if (!ts.isOmittedExpression(el)) c(el.name); }; for (const d of st.declarationList.declarations) c(d.name); }
    else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && ts.isPropertyAccessExpression(st.expression.left) && ['render', 'load'].includes(st.expression.left.expression.getText())) (st.expression.left.expression.getText() === 'render' ? movedRender : movedLoad).add(st.expression.left.name.text);
  }
  movedBy.set(file, movedNames);
  const ret = install?.body.statements.at(-1);
  const returned = new Set(ret && ts.isReturnStatement(ret) && ret.expression && ts.isObjectLiteralExpression(ret.expression) ? ret.expression.properties.filter(ts.isShorthandPropertyAssignment).map((p) => p.name.text) : []);
  // the page's stubs: a function of the same name that calls ${CODE}.name, and render[k] and load[k] for each render.X and load.X
  const stubs = new Set([...topFn].filter(([n, f]) => f.body?.getText().includes(`${CODE}.${n}(`)).map(([n]) => n));
  ok([...returned].every((n) => stubs.has(n)) && [...stubs].every((n) => returned.has(n) && movedNames.has(n)), `the page has a stub for each function ${file} returns (${[...returned].join(', ')})`);
  const both = [...movedNames].filter((n) => kind.has(n) && !stubs.has(n));
  ok(!both.length, `no name is declared both on the page and in ${file}, apart from the stubs${both.length ? `: ${both.join(', ')}` : ''}`);
  const reached = [...movedNames].filter((n) => freeInMain.has(n));
  ok(!reached.length, `the page reads no name that moved to ${file}${reached.length ? `: ${reached.join(', ')}` : ''}`);
  const loopOf = (re) => { const m = main.match(re); return new Set(m ? JSON.parse(m[1]) : []); };
  const stubbedRender = loopOf(new RegExp(`\\nfor \\(const k of (\\[[^\\]]*\\])\\) render\\[k\\] = \\(\\) => \\{ if \\(!${CODE}\\) `));
  const stubbedLoad = loopOf(new RegExp(`\\nfor \\(const k of (\\[[^\\]]*\\])\\) load\\[k\\] = \\(\\) => ${READY}\\(\\)`));
  const same = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));
  ok(movedRender.size > 0 && same(movedRender, stubbedRender), `render[k] is stubbed on the page for exactly what ${file} renders (${[...movedRender].join(', ')})`);
  ok(same(movedLoad, stubbedLoad), `load[k] is stubbed on the page for exactly what ${file} loads (${[...movedLoad].join(', ') || 'none'})`);
  const setTwice = [...movedRender].filter((k) => new RegExp(`\\nrender\\.${k} = `).test(main)).concat([...movedLoad].filter((k) => new RegExp(`\\nload\\.${k} = `).test(main)));
  ok(!setTwice.length, `the page sets none of those render.X or load.X itself${setTwice.length ? `: ${setTwice.join(', ')}` : ''}`);
  ok(new RegExp(`\\bimport\\('\\/${esc(file)}\\?cb=[0-9a-f]{8}'\\)`).test(main), `the page imports /${file} under a cache-bust token`);
  ok(!MODULES.some((o) => o !== M_ && text.includes(`/${o.file}`)), `${file} does not load the other module`);
}
const [sheetsNames, tacNames] = MODULES.map((x) => movedBy.get(x.file) || new Set());
const inBoth = [...sheetsNames].filter((n) => tacNames.has(n));
ok(!inBoth.length, `front/sheets.js and front/tac.js declare different names (each moved code only it reaches)${inBoth.length ? `: ${inBoth.join(', ')}` : ''}`);

// ── TAC's page preloads front/tac.js under the URL the module imports it by; the front page does not ──
const tacUrl = main.match(/\bimport\('(\/front\/tac\.js\?cb=[0-9a-f]{8})'\)/)?.[1];
const headOf = (t) => t.slice(0, t.indexOf('</head>'));
ok(!!tacUrl && headOf(tacPage).includes(`<link rel="modulepreload" href="${tacUrl}">`), `tac/index.html preloads ${tacUrl} (npm run build makes it from index.html)`);
ok(!headOf(html).includes('/front/tac.js'), 'index.html does not preload /front/tac.js');

if (fails) { console.log(`${fails} failed`); process.exit(1); }
