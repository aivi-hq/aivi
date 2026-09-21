// Builds every workspace package to dist/, in dependency order. The output is
// the only code that runs: every exports map points at dist/, locally and in
// the published package, so dev, tests and consumers execute the identical
// artifact. Sibling @aivi/* imports resolve through their exports maps to the
// dist/ built just before, so no path mapping is involved.
//
// Per package a tsconfig.build.json is generated (gitignored): the repo
// tsconfig checks sources with noEmit, this one emits JS and declarations.
// Build info lands next to it (gitignored) so repeated builds are incremental.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const workspace = readdirSync(join(root, 'packages')).map(entry => {
  const dir = join(root, 'packages', entry);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const dependencies = Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }).filter(name => name.startsWith('@aivi/'));
  return { name: manifest.name, dir, dependencies };
});

// Dependency order: a package compiles only after the packages it imports did.
const order = [];
const pending = new Set(workspace.map(pkg => pkg.name));
while (pending.size) {
  const ready = workspace.filter(pkg => pending.has(pkg.name) && pkg.dependencies.every(dep => !pending.has(dep)));
  if (!ready.length) throw new Error(`circular workspace dependency: ${[...pending].join(', ')}`);
  for (const pkg of ready) {
    pending.delete(pkg.name);
    order.push(pkg);
  }
}

for (const { name, dir } of order) {
  const config = {
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      verbatimModuleSyntax: true,
      erasableSyntaxOnly: true,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true,
      skipLibCheck: true,
      types: ['node'],
      noEmit: false,
      declaration: true,
      outDir: 'dist',
      rootDir: 'src',
      incremental: true,
      tsBuildInfoFile: 'tsconfig.build.tsbuildinfo',
    },
    include: ['src'],
  };
  writeFileSync(join(dir, 'tsconfig.build.json'), `${JSON.stringify(config, null, 2)}\n`);
  execFileSync(tsc, ['-p', 'tsconfig.build.json'], { cwd: dir, stdio: 'inherit' });
  if (!existsSync(join(dir, 'dist', 'index.js')) && !existsSync(join(dir, 'dist', 'cli.js')))
    throw new Error(`${name}: dist/ has no entry after the build`);
  console.error(`built ${name}`);
}
