#!/usr/bin/env node
/**
 * check-syntax.cjs — parse-gate for every TypeScript file this repo ships.
 *
 * Why this exists: on 2026-08-03 a commit dropped one `}` from
 * container/agent-runner/src/poll-loop.ts. That directory is bind-mounted
 * read-only at /app/src inside every agent container, so the unparseable file
 * reached production instantly and every agent died at startup for three days
 * while systemd reported the host as healthy. A second, older break of the
 * same shape (a lost `}` plus a lost `/**`) had already made src/ unbuildable
 * for twelve days without anyone noticing.
 *
 * Both were pure syntax errors — the cheapest possible class of bug to catch,
 * missed only because nothing ever parsed these trees. The pre-commit hook
 * formatted src/** and ignored container/** entirely.
 *
 * This checks SYNTAX ONLY (ts.transpileModule reports syntactic diagnostics,
 * not type errors), so it stays fast and has no opinion about formatting or
 * types. It is a floor, not a substitute for `tsc --noEmit`.
 *
 * Usage:
 *   node scripts/check-syntax.cjs                 # both trees, every .ts
 *   node scripts/check-syntax.cjs a.ts b.ts       # only these files
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
// Both trees ship: src/ compiles to the dist/ the host runs, and
// container/agent-runner/src is mounted straight into every agent container.
const TREES = ['src', 'container/agent-runner/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);
const TS_RE = /\.(ts|tsx|mts|cts)$/;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (TS_RE.test(entry.name)) out.push(full);
  }
  return out;
}

const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = argv.length
  ? argv.filter((f) => TS_RE.test(f) && fs.existsSync(f))
  : TREES.reduce((acc, tree) => {
      const dir = path.join(ROOT, tree);
      return fs.existsSync(dir) ? walk(dir, acc) : acc;
    }, []);

let broken = 0;
for (const file of files) {
  const { diagnostics } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
    },
  });
  if (!diagnostics || diagnostics.length === 0) continue;
  broken++;
  const rel = path.relative(ROOT, file);
  for (const d of diagnostics.slice(0, 3)) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    if (d.file && typeof d.start === 'number') {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      console.error(`${rel}(${line + 1},${character + 1}): ${msg}`);
    } else {
      console.error(`${rel}: ${msg}`);
    }
  }
}

if (broken > 0) {
  console.error(`\ncheck-syntax: ${broken} file(s) do not parse. Refusing.`);
  console.error('A file that does not parse here takes the whole agent fleet down at startup.');
  process.exit(1);
}
console.log(`check-syntax: ${files.length} file(s) parse cleanly.`);
