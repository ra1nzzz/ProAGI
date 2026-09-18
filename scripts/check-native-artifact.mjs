import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const bundles = [
  ['nsis', '.exe'],
  ['msi', '.msi'],
];

for (const [kind, extension] of bundles) {
  const directory = resolve(root, 'src-tauri', 'target', 'release', 'bundle', kind);
  const files = (await readdir(directory)).filter((file) => file.toLowerCase().endsWith(extension));
  if (files.length !== 1) throw new Error(`Expected one ${kind} artifact, found ${files.length}`);
  const artifact = resolve(directory, files[0]);
  const details = await stat(artifact);
  if (!details.isFile() || details.size < 10_000) throw new Error(`Invalid ${kind} artifact: ${artifact}`);
  console.log(`${kind}: ${artifact} (${details.size} bytes)`);
}
