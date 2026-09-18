'use strict';

/**
 * Compile every source and test file without executing it.
 *
 * This exists because a single misplaced trailing comma inside grouping
 * parentheses — `(expr,)` — is a SyntaxError, and the failure only shows
 * up when the whole suite runs, as a confusing cascade of "test file
 * failed to load". Catching it here makes the cause obvious immediately.
 *
 * Usage: node scripts/check-syntax.js
 */

const fs = require('node:fs',);
const path = require('node:path',);
const vm = require('node:vm',);

const ROOTS = ['src', 'test', 'scripts',];
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs',],);

/** Recursively collect files under a directory. */
function walk(dir, out = [],) {
  if (!fs.existsSync(dir,)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, },)) {
    const full = path.join(dir, entry.name,);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out,);
    } else if (EXTENSIONS.has(path.extname(entry.name,),)) {
      out.push(full,);
    }
  }
  return out;
}

const files = ROOTS.flatMap((root,) => walk(root,),);
const failures = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8',);
  try {
    // Compiles only — nothing is executed, so this is safe to run over
    // files with side effects at import time.
    new vm.Script(source, { filename: file, },);
  } catch (error) {
    failures.push({ file, message: error.message, },);
  }
}

if (failures.length > 0) {
  console.error(`\nSyntax check failed in ${failures.length} file(s):\n`,);
  for (const { file, message, } of failures) {
    console.error(`  ${file}`);
    console.error(`    ${message}\n`);
  }
  process.exit(1,);
}

console.log(`Syntax OK — ${files.length} file(s) compiled.`,);
