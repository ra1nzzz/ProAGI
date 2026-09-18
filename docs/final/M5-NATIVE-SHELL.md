# M5 Native Shell

## Status

M5 的 Tauri/Windows 工程原型已完成，Gate 5 仍为 `NOT_RUN`，因此当前产物不是正式放行声明。

前置的 M2 participant pilot、M3 live-model evaluation、Gate 1–3 外部证据和 M4 裁决状态不因本原型改变。相关结果仍按 `NOT_RUN`、`CONDITIONAL` 或 `NEED_MORE_EVIDENCE` 记录。

## Implemented scope

- Tauri 2 shell with NSIS and MSI bundle targets.
- IndexedDB remains the application canonical store; the native shell does not add SQLite or a second truth store.
- Audited IPC commands for status, privacy mode, UIA opt-in, allowlisted observation, and native-state clearing.
- Windows UIA is default-off, explicit opt-in, read-only, and allowlisted to the focused Notepad window/edit/document control family.
- PRIVATE mode and missing opt-in fail closed; raw UIA control names are not returned, and no keyboard/mouse injection path is exposed.
- Native clear disables UIA, enters PRIVATE mode, advances the privacy epoch, and reports that no native payload records were retained.

## Verification

Passed in the repository workspace:

- `npm.cmd run typecheck`
- `npm.cmd run lint`
- `npm.cmd run build`
- `npm.cmd run check:production-artifact`
- `npm.cmd run test:ipc` — 6 passed
- `npm.cmd run test:release-gates` — 19 passed, 1 skipped by design
- `npm.cmd run check:native-artifact` — NSIS and MSI bundles present
- `npm.cmd run tauri:build`
- `npm.cmd run test:native`
- Release EXE startup smoke
- NSIS silent install, uninstall, and install-directory cleanup smoke
- `npm.cmd test` — 163/163 fork unit tests
- `npm.cmd run test:e2e` — 36/36 across `chromium-desktop` and `chromium-320`

Generated release artifacts are under `src-tauri/target/release/bundle/` and are ignored build output.

The native shell stays read-only by contract, not only by dependency features: the
`uiautomation` crate requires its `input` feature for its `core` module, so
`scripts/tests/native-shell.test.mjs` instead forbids every injection or
value-writing entry point (`send_keys`, `set_value`, `invoke_pattern`, `SendInput`,
…) and permits only `get_*` read accessors.

## Remaining Gate 5 evidence

- Supported Windows matrix and signed/packaged release policy.
- Measured UIA coverage, event loss, noise, fallback, idle CPU, memory, disk growth, lock-screen, and sleep behavior.
- Independent manual accessibility/visual and screen-reader evidence.
- Full user-data purge evidence across the canonical Web storage path; the native command currently clears only native shell state because it stores no user payload.

