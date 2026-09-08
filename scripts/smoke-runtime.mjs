import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--endpoint') throw new Error('Usage: npm run smoke:runtime -- --endpoint ws://127.0.0.1:4513');
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { CodexAppServerAdapter } = await server.ssrLoadModule('/src/adapters/codexAppServer.ts');
  const adapter = new CodexAppServerAdapter(args[1], resolve('test-results/m3/empty-workspace'));
  try {
    const descriptor = await adapter.initialize(AbortSignal.timeout(5_000));
    const output = resolve('test-results/m3/runtime-smoke.json');
    await mkdir(resolve('test-results/m3'), { recursive: true });
    const evidence = {
      schemaVersion: '1.0.0', executedAt: new Date().toISOString(), descriptor,
      realAppServerHandshake: 'PASS', liveModelEvaluation: 'NOT_RUN',
      note: 'Handshake only: no user data, thread, model request, or action is submitted.',
    };
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally { adapter.dispose(); }
} finally { await server.close(); }
