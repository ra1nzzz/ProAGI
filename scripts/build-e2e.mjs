import { build } from 'vite';

process.env.VITE_PROAGI_E2E_HOOKS = '1';
await build({ build: { outDir: 'dist-e2e' } });
