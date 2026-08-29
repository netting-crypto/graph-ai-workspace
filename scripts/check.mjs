import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
const versions = JSON.parse(await fs.readFile(path.join(root, 'versions.json'), 'utf8'));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');

if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error(`manifest.json version must be x.y.z, got ${manifest.version}`);
}
if (manifest.version !== pkg.version) {
  throw new Error(`Version mismatch: manifest ${manifest.version} != package ${pkg.version}`);
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error(`versions.json must map ${manifest.version} to ${manifest.minAppVersion}`);
}
if (!manifest.isDesktopOnly) {
  throw new Error('This plugin uses child_process and must remain desktop-only.');
}
if (/demo/i.test(manifest.name)) {
  throw new Error('Public plugin name must not contain “Demo”.');
}
if (manifest.id !== 'graph-ai-workspace') {
  throw new Error(`Manifest id must be graph-ai-workspace, got ${manifest.id}`);
}
if (!gitignore.split(/\r?\n/).some((line) => line.trim() === 'data.json')) {
  throw new Error('.gitignore must exclude data.json.');
}

const allFiles = await walk(root);
const jsFiles = allFiles.filter((file) => file.endsWith('.js'));
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Syntax check failed for ${path.relative(root, file)}:\n${result.stderr || result.stdout}`);
  }
}

const publishableSource = allFiles.filter((file) => (
  /\.(?:js|mjs|json|css|md)$/.test(file)
  && path.basename(file) !== 'data.json'
));
for (const file of publishableSource) {
  const text = await fs.readFile(file, 'utf8');
  if (/\/Users\/witch\b/.test(text)) {
    throw new Error(`Developer-specific absolute path found in ${path.relative(root, file)}`);
  }
  if (/\bsk-[A-Za-z0-9]{32,}\b/.test(text)) {
    throw new Error(`Possible API key found in ${path.relative(root, file)}`);
  }
}

console.log(`Checks passed for Graph AI Workspace ${manifest.version}.`);
console.log(`Validated ${jsFiles.length} JavaScript source files.`);
console.log('data.json is local-only and excluded from Git/release builds.');
