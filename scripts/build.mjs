import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const manifestPath = path.join(root, 'manifest.json');
const packagePath = path.join(root, 'package.json');

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
if (manifest.version !== pkg.version) {
  throw new Error(`Version mismatch: manifest ${manifest.version} != package ${pkg.version}`);
}

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'main.js')],
  outfile: path.join(dist, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2020'],
  external: ['obsidian'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
});

await Promise.all([
  fs.copyFile(manifestPath, path.join(dist, 'manifest.json')),
  fs.copyFile(path.join(root, 'styles.css'), path.join(dist, 'styles.css')),
]);

const built = await fs.readFile(path.join(dist, 'main.js'), 'utf8');
for (const forbidden of [
  "require('./context-state')",
  "require('./agent-runtime')",
  "require('./agent/",
  'require("./context-state")',
  'require("./agent-runtime")',
  'require("./agent/',
]) {
  if (built.includes(forbidden)) {
    throw new Error(`Bundle still contains an unresolved local runtime import: ${forbidden}`);
  }
}
if (/\/Users\/witch\b/.test(built)) {
  throw new Error('Build contains a developer-specific absolute path.');
}

console.log(`Built Graph AI Workspace ${manifest.version} → dist/`);
console.log('Release assets: dist/main.js, dist/manifest.json, dist/styles.css');
