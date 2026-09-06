import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  define: {
    'import.meta.env.VITE_PROAGI_E2E_HOOKS': JSON.stringify(process.env.VITE_PROAGI_E2E_HOOKS ?? ''),
  },
  plugins: [react()],
  server: { host: '127.0.0.1', port: 4173 },
  preview: { host: '127.0.0.1', port: 4173 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
    exclude: ['tests/e2e/**', 'scripts/**', 'node_modules/**', 'dist/**'],
    coverage: { reporter: ['text', 'json-summary'] }
  }
});
