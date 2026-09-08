interface ImportMetaEnv {
  readonly VITE_PROAGI_E2E_HOOKS?: string;
  readonly VITEST?: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
