// A name a service uses and nothing declares throws the first time that line runs, and in a long-lived loop it is caught and logged, not noticed. The settle relay
// wrote `lastWorkedAt` after every job for days after the line that declared it was removed: each job ended in an error heartbeat, a pause and a skipped top-up.
// This reads the relay, the API worker, the server and the help desk the way a compiler does and fails on any name that is used and not declared.
// Needs the `typescript` package (a compiler, used only to read the code); without it the test says so and passes.
//   node tests/undeclared-names.test.mjs
import { createRequire } from 'node:module';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let ts;
try { ts = createRequire(import.meta.url)('typescript'); } catch { console.log('skipped: the typescript package is not installed'); process.exit(0); }

const DIRS = ['worker-relay/src', 'worker/src', 'server', 'helpdesk'];
// Names Node provides that the compiler's browser-typed defaults do not know.
const NODE_GLOBALS = new Set(['setImmediate', 'clearImmediate', 'require', 'module', 'exports', '__dirname', '__filename', 'global']);
// Files nothing imports or starts, kept for reference: they are not read.
const UNUSED = new Set(['worker/src/reflection-attest-bigbatch.mjs']);

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    if (f === 'node_modules' || f === 'test' || f === 'tests') continue;
    const p = join(d, f), st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(f) && !/\.test\.m?js$/.test(f) && !UNUSED.has(relative(root, p))) files.push(p);
  }
};
for (const d of DIRS) walk(join(root, d));

const program = ts.createProgram(files, { allowJs: true, checkJs: true, noEmit: true, noResolve: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
const found = [];
for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || !files.includes(sf.fileName)) continue;
  for (const d of program.getSemanticDiagnostics(sf)) {
    if (d.code !== 2304) continue;   // "Cannot find name"
    const name = /Cannot find name '([^']+)'/.exec(ts.flattenDiagnosticMessageText(d.messageText, ' '))?.[1];
    if (!name || NODE_GLOBALS.has(name)) continue;
    const { line } = sf.getLineAndCharacterOfPosition(d.start);
    found.push(`${relative(root, sf.fileName)}:${line + 1}  ${name}`);
  }
}
if (found.length) { console.error(`FAIL ${found.length} name(s) used and not declared:\n  ${found.join('\n  ')}`); process.exit(1); }
console.log(`ok  - ${files.length} files in ${DIRS.join(', ')} use no name that nothing declares`);
