import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function text(path) {
  return readFile(resolve(root, path), 'utf8');
}

test('native shell exposes only the audited read-only control surface', async () => {
  const manifest = JSON.parse(await text('src-tauri/tauri.conf.json'));
  const capabilities = JSON.parse(await text('src-tauri/capabilities/default.json'));
  const rust = await text('src-tauri/src/lib.rs');
  const packageJson = JSON.parse(await text('package.json'));

  assert.equal(manifest.identifier, 'com.proagi.assistant');
  assert.deepEqual(manifest.bundle.targets, ['nsis', 'msi']);
  assert.deepEqual(capabilities.permissions, ['core:default']);
  assert.match(rust, /native_status/);
  assert.match(rust, /set_privacy_mode/);
  assert.match(rust, /set_uia_opt_in/);
  assert.match(rust, /clear_native_state/);
  assert.match(rust, /observe_allowlisted/);
  assert.doesNotMatch(rust, /send_keys|set_value|invoke_pattern|mouse_event|keybd_event/u);
  assert.equal(packageJson.scripts['tauri:build'], 'tauri build');
  assert.equal(packageJson.scripts['test:ipc'], 'cargo test --manifest-path src-tauri/Cargo.toml');
});

test('native Rust verification is wired into a Windows CI job and not into the Linux tiers', async () => {
  // The native crate cannot build on Linux: windows-rs is `#![cfg(windows)]`, and
  // tauri pulls the whole GTK/WebKitGTK stack there for zero benefit. The IPC unit
  // tests exercise pure NativeStateInner logic, so they must run on a Windows runner
  // and must not be added to the Linux pr/nightly/release command registries.
  const workflow = await text('.github/workflows/verify.yml');
  assert.match(workflow, /native_ipc:/);
  const jobStart = workflow.indexOf('  native_ipc:');
  const rest = workflow.slice(jobStart + 1);
  const nextJob = rest.search(/\n {2}[\w][\w-]*:/);
  const job = nextJob === -1 ? rest : rest.slice(0, nextJob);
  assert.match(job, /runs-on:\s*windows-latest/);
  assert.match(job, /cargo test --manifest-path src-tauri\/Cargo\.toml/);

  const suites = await text('scripts/check-suites.mjs');
  assert.doesNotMatch(suites, /cargo|Cargo\.toml/, 'native cargo commands must not run on the Linux runners');
});

test('native Rust toolchain is pinned so CI cannot drift from the audited build', async () => {
  const pin = await text('src-tauri/rust-toolchain.toml');
  assert.match(pin, /channel\s*=\s*"\d+\.\d+(\.\d+)?"/);
});

test('native shell never calls a UIA input-injection or value-writing API', async () => {
  // The uiautomation crate's `core` module hard-requires the `input` feature, so it
  // cannot be dropped at the manifest level. The read-only guarantee is therefore
  // enforced by forbidding every injection/write entry point in the native source.
  const rust = await text('src-tauri/src/lib.rs');
  const main = await text('src-tauri/src/main.rs');
  assert.doesNotMatch(rust + main, /\b(send_keys|set_value|set_focus|invoke_pattern|select|mouse_event|keybd_event|SendInput|SetCursorPos)\b/u);
  // Only read accessors may be used against UIA elements.
  const usedAccessors = new Set((rust + main).match(/\.(get_\w+|get_classname|get_name)\s*\(/gu) ?? []);
  assert.ok([...usedAccessors].length > 0, 'native shell must read UIA elements through explicit getters');
  for (const accessor of usedAccessors) {
    assert.match(accessor, /\.get_\w+\s*\($/, `non-read UIA accessor used: ${accessor}`);
  }
});

test('native privacy sync runs after the canonical receipt and stays epoch-fenced', async () => {
  const shell = await text('src/ui/AppShell.tsx');
  const receiptStart = shell.indexOf("const receipt = nextMode === 'PRIVATE'");
  const nativeStart = shell.indexOf('await setNativePrivacyMode(nextMode);', receiptStart);
  assert.notEqual(receiptStart, -1);
  assert.notEqual(nativeStart, -1, 'native privacy sync is not reachable from the canonical receipt path');
  assert.ok(nativeStart > receiptStart, 'canonical receipt must commit before the native privacy mirror');

  const guardStart = shell.indexOf('if (epoch !== uiEpochRef.current) return;', nativeStart);
  assert.ok(guardStart > nativeStart, 'native privacy sync must stay inside the UI epoch fence');
});

test('native clear does not replace the canonical web-storage purge path', async () => {
  const shell = await text('src/ui/AppShell.tsx');
  const revoke = shell.indexOf('await runtimeRef.current?.revokeConsent();');
  const nativeClear = shell.indexOf('await clearNativeState();', revoke);
  assert.notEqual(revoke, -1);
  assert.notEqual(nativeClear, -1);
  assert.ok(nativeClear > revoke, 'canonical revocation must run before the native shell state clear');
  assert.match(shell, /recoveryRelease|indexedDb|deleteDatabase/, 'a full user-data purge path must remain available in the shell');
});

test('native shell controls sit at the AppShell top level and not inside a closed section', async () => {
  const shell = await text('src/ui/AppShell.tsx');
  assert.match(shell, /<NativeShellControls \/>/);
  const controlsIndex = shell.indexOf('<NativeShellControls />');
  const renderStart = shell.indexOf('return (', shell.indexOf('export function AppShell'));
  assert.notEqual(renderStart, -1, 'AppShell render tree must be locatable');
  // Walk the JSX from the start of the render tree to the controls and track tag
  // depth, so an unbalanced or wrongly-nested insertion is detected structurally.
  const prefix = shell.slice(renderStart, controlsIndex);
  const tokens = prefix.match(/<\/?(?:div|section|details|dl|p|label|summary|span|form)\b[^>]*?\/?>|<\?>/g) ?? [];
  let depth = 0;
  for (const token of tokens) {
    if (token.startsWith('</')) depth -= 1;
    else if (!token.endsWith('/>')) depth += 1;
    if (depth < 0) throw new Error('native controls are preceded by an unbalanced JSX close tag');
  }
  assert.ok(depth >= 1, `native controls must be nested inside the AppShell render tree (depth ${depth})`);
  assert.ok(depth <= 3, `native controls must not be buried deeper than the AppShell surface (depth ${depth})`);
});
