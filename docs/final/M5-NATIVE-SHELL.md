# M5 Native Shell

## Status

M5 的 Tauri/Windows 工程原型已完成，Gate 5 仍为 `NOT_RUN`，因此当前产物不是正式放行声明。

前置的 M2 participant pilot、M3 live-model evaluation、Gate 1–3 外部证据和 M4 裁决状态不因本原型改变。相关结果仍按 `NOT_RUN`、`CONDITIONAL` 或 `NEED_MORE_EVIDENCE` 记录。

另外，`native_ipc` CI job 从未执行过（见下文 [native_ipc job is UNVERIFIED](#native_ipc-job-is-unverified)）：它已正确配置，但没有任何实跑记录，因此本文档中的原生验证全部只代表**本机**结果，不代表托管 CI 已确认。

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
- `npm.cmd run test:ipc` — 6 passed locally
- `npm.cmd run test:release-gates` — 22 passed, 1 skipped by design
- `npm.cmd run check:native-artifact` — NSIS and MSI bundles present
- `npm.cmd run tauri:build`
- `npm.cmd run test:native`
- Release EXE startup smoke
- NSIS silent install, uninstall, and install-directory cleanup smoke
- `npm.cmd test` — 163/163 fork unit tests
- `npm.cmd run test:e2e` — 36/36 across `chromium-desktop` and `chromium-320`
- `npm.cmd run build` — clean production bundle

Generated release artifacts are under `src-tauri/target/release/bundle/` and are ignored build output.

## Why the native tests run on a Windows job

The native crate cannot be built or tested on the Linux runners, and adding it there
would fail for no verification benefit:

- `windows-rs` is declared `#![cfg(windows)]`, so it produces an empty crate off
  Windows while every symbol our code references disappears.
- `tauri` unconditionally pulls the full GTK/WebKitGTK stack on Linux, which would
  require `libgtk-3-dev`/`libwebkit2gtk-4.1-dev` just to compile a test binary that
  exercises no Linux code path.

The six IPC unit tests only exercise pure `NativeStateInner` logic, so they are assigned
to a dedicated `native_ipc` job on `windows-latest`. They must **not** be added to the
Linux `pr`/`nightly`/`release` command registries; a gate test enforces both halves of
that rule.

The Rust toolchain is pinned in `src-tauri/rust-toolchain.toml` to match the version
other checks pin for Node and npm, so CI cannot drift from the audited build.

The native shell stays read-only by contract, not only by dependency features: the
`uiautomation` crate requires its `input` feature for its `core` module, so
`scripts/tests/native-shell.test.mjs` instead forbids every injection or
value-writing entry point (`send_keys`, `set_value`, `invoke_pattern`, `SendInput`,
…) and permits only `get_*` read accessors.

## `native_ipc` job is UNVERIFIED

The job has **never executed**. It is configured correctly but has no recorded run, so
nothing above should be read as hosted-CI confirmation.

Measured on 2026-09-18 via the GitHub API:

- The run triggered by this work reports `conclusion: failure` with **zero jobs created**
  (`/actions/runs/<id>/jobs` returns an empty list, and the `github-actions` check suite
  reports `latest_check_runs_count: 0`).
- No log archive exists (`/actions/runs/<id>/logs` returns 404) and `gh run rerun` refuses
  with "this workflow run cannot be retried". These are the signature of a failure that
  happens before a runner is assigned, not a failing test.
- This is not caused by the native job. `main`'s newest run, on a commit that does not
  contain any native change, also reports `jobs=0`; across the last 100 runs on both
  branches, **none** started a job.
- The workflow file itself parses and is `active`: `on` is a literal key, all four jobs
  (`pr`, `nightly`, `native_ipc`, `release_candidate`) are present, and repository
  permissions report `enabled: true` with `allowed_actions: all`.
- The transition is datable: run `34020336503` (2026-09-05) succeeded with 1 job;
  `34023550499` (2026-09-06) failed with 1 job; from `34055769223` (2026-09-06) onward
  every run has created 0 jobs.

Consequences, stated plainly:

- The claim that the native crate "cannot be built on Linux" rests on local `cargo`
  attempts, not on a hosted run. It has not been confirmed by CI.
- That `cargo test` succeeds on `windows-latest` — including whether MSVC and
  `rust-toolchain.toml` resolve correctly on a GitHub runner — is **untested**. The
  gate tests only assert how the command is *registered*, not that it *runs*.

To close this, open the run in the GitHub web UI, which surfaces a startup error the API
does not return (commonly a spending limit or an unverified account), fix that
account-level condition, and confirm the `native_ipc` job actually reaches its
`Verify native IPC contract` step.


## Supported Windows matrix

Verified by actually building and running on this machine, on 2026-09-18:

| Item | Status |
| --- | --- |
| Host OS | Windows 11 (10.0.26200.9168) |
| Toolchain | Rust 1.97.1, `x86_64-pc-windows-msvc` |
| Bundle targets | `nsis` and `msi`, both produced with real byte sizes |
| Silent install / uninstall / directory cleanup | Smoke-tested locally on the NSIS bundle |
| Release EXE startup | Smoke-tested locally |

Not established:

- Any other Windows version or edition. Only this one host was tested, so no support
  matrix beyond "the machine that built it" can be claimed.
- ARM64 or 32-bit builds. Only `x64` artifacts exist.
- Code signing. The bundles are unsigned; there is no signing policy yet.
- Any Windows Server or Windows-on-ARM configuration.

## Remaining Gate 5 evidence

- A genuinely supported Windows matrix and a signed/packaged release policy. The table
  above is a single-host result, not a support commitment.
- Measured UIA coverage, event loss, noise, fallback, idle CPU, memory, disk growth, lock-screen, and sleep behavior.
- Independent manual accessibility/visual and screen-reader evidence.
- A recorded `native_ipc` run. The job is configured but has never executed, so
  `cargo test` on `windows-latest` — and the "Linux cannot build it" reasoning behind
  putting it there — remain unconfirmed by hosted CI.

## User-data purge scope

The two clear operations are deliberately distinct, and neither one hides the other:

- `clear_native_state` clears **only** native shell state: it disables UIA, enters PRIVATE,
  and advances the privacy epoch. Its receipt reports `nativeRecordsCleared: 0` because the
  native shell stores no user payload — there is nothing for it to delete. It never touches
  IndexedDB.
- User data in the canonical Web store is cleared by `revokeConsent`, which runs **before**
  `clearNativeState` in `AppShell.revokeReadonly` and drives the full fenced deletion
  journal (`planDeletion` → `fenceDeletion` → `enumerateDeletionPage` → `deleteChunk` →
  `PURGE_REQUEST`) with cross-tab coordination through the purge broadcast channel.

The UI exposes both paths separately and labels the boundary explicitly: the native-shell
cleanup button states that IndexedDB data is removed via "撤回真实来源授权". A gate test
locks the ordering so the native clear can never silently substitute for the canonical purge.


