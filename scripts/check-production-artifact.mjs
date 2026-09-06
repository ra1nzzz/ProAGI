import { createHash } from 'node:crypto';
import { access, lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const distRoot = resolve(repoRoot, 'dist');
const forbiddenMarkers = Object.freeze([
  '__proagiE2e',
  'commit:after-persisted',
  'purge:before-release',
  'importWithResponseLoss',
  'deleteWithResponseLoss',
  'VITE_PROAGI_E2E_HOOKS',
]);
const artifacts = [];

await access(distRoot);

async function walk(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Production dist contains a symbolic link: ${relative(repoRoot, path)}`);
  if (info.isDirectory()) {
    for (const name of (await readdir(path)).sort()) await walk(join(path, name));
    return;
  }
  if (!info.isFile()) throw new Error(`Production dist contains an unsupported file: ${relative(repoRoot, path)}`);
  const bytes = await readFile(path);
  const text = bytes.toString('utf8');
  const marker = forbiddenMarkers.find((candidate) => text.includes(candidate));
  if (marker) throw new Error(`Production dist contains forbidden E2E marker ${marker}: ${relative(repoRoot, path)}`);
  artifacts.push({ path: relative(repoRoot, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}

await walk(distRoot);
if (artifacts.length === 0) throw new Error('Production dist is empty');
const buildIdentity = createHash('sha256').update(JSON.stringify(artifacts)).digest('hex');
console.log(JSON.stringify({ schemaVersion: '1.0.0', status: 'CLEAN', buildIdentity, artifacts }));
