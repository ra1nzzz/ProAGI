import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetSha = process.env.RELEASE_TARGET_SHA;
const runId = process.env.EVIDENCE_RUN_ID;
if (!targetSha || !/^[0-9a-f]{40,64}$/.test(targetSha)) throw new Error('RELEASE_TARGET_SHA must be an exact commit SHA');
if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error('EVIDENCE_RUN_ID is required for release verification');
const git = async (...args) => (await execFile('git', args, { cwd: repoRoot, encoding: 'utf8' })).stdout.trim();
const head = await git('rev-parse', 'HEAD');
if (head !== targetSha) throw new Error(`Release target ${targetSha} does not match HEAD ${head}`);
const dirty = await git('status', '--porcelain=v1', '--untracked-files=all');
if (dirty) throw new Error(`Release candidate worktree is dirty:\n${dirty}`);
const ref = process.env.RELEASE_REF ?? process.env.GITHUB_REF ?? await git('describe', '--tags', '--exact-match', 'HEAD').then((tag) => `refs/tags/${tag}`).catch(() => '');
if (!/^refs\/tags\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ref)) throw new Error('Release verification requires an exact semantic-version tag refs/tags/vMAJOR.MINOR.PATCH');
const tagSha = await git('rev-parse', '--verify', `${ref}^{commit}`).catch(() => '');
if (!tagSha || tagSha !== head) throw new Error(`Release tag ${ref} does not resolve to HEAD ${head}`);

const dist = resolve(repoRoot, 'dist');
await access(dist);
const artifacts = [];
async function walk(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`dist contains a symbolic link: ${relative(repoRoot, path)}`);
  if (info.isDirectory()) {
    for (const name of (await readdir(path)).sort()) await walk(join(path, name));
  } else if (info.isFile()) {
    const bytes = await readFile(path);
    artifacts.push({ path: relative(repoRoot, path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}
await walk(dist);
if (artifacts.length === 0) throw new Error('Release dist is empty');
const report = {
  schemaVersion: '1.0.0', runId, tier: 'release', head, ref, clean: true,
  buildIdentity: createHash('sha256').update(JSON.stringify(artifacts)).digest('hex'), artifacts,
};
const output = resolve(repoRoot, 'test-results', runId, 'release', 'release-binding.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(output);
