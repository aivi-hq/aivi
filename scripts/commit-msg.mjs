#!/usr/bin/env node
// Conventional Commits check for the commit-msg hook: `type(scope)!: subject`.
// Kept dependency-free on purpose; this is one regular expression.
import { readFileSync } from 'node:fs';

const TYPES = ['feat', 'fix', 'docs', 'chore', 'refactor', 'test', 'perf', 'build', 'ci', 'style', 'revert'];
const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9-]*\\))?!?: [^\\s].{0,71}$`);
const SKIP = /^(Merge |fixup! |squash! |Revert ")/;

const file = process.argv[2];
if (!file) {
  console.error('usage: commit-msg.mjs <commit message file>');
  process.exit(2);
}
const header = readFileSync(file, 'utf8')
  .split('\n')
  .find(line => line.trim() && !line.startsWith('#'));

if (!header || SKIP.test(header)) process.exit(0);
if (HEADER.test(header) && !header.endsWith('.')) process.exit(0);

console.error(`Commit message does not follow Conventional Commits:\n\n  ${header}\n`);
console.error(`Expected: type(scope)!: subject   (scope and ! optional, subject 1-72 chars, no trailing period)`);
console.error(`Types:    ${TYPES.join(', ')}`);
process.exit(1);
