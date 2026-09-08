# ProAGI 项目速记

- 定位：local-first Insight Loop；IndexedDB canonical store 是唯一真相，UI、Replay、Markdown 都是可丢弃派生层。
- 已完成：M1 工程闭环；M2 consent-bound 窄只读源工程实现（真实 participant pilot 仍 `NOT_RUN`）；M3a typed Runtime/fake/Codex adapter；M3b Markdown projection 的全量/增量重建、cursor/epoch/incarnation/CAS、删除传播、转义、预览与显式不可逆导出。
- 当前推进：M3b 生产入口已实现并完成定向浏览器验证，待最终文档同步、提交与推送。
- 未完成：M2 participant pilot（少量真实参与者、明确 consent/retention/revoke 的受控试用）；真实 live-model evaluation；Gate 1/2/3 仍按证据保持 `CONDITIONAL`。M4/M5 未开始。
- 边界：projection 失败只关闭 projection，不得影响 Core；不自动写 Obsidian/Vault；导出必须用户确认；保持 privacy/purge/recovery、可访问性与只读授权约束。
- 常用核验：`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd test`、`npm.cmd run test:e2e -- tests/e2e/m3-projection.spec.ts`、`npm.cmd run build`、`node scripts/check-production-artifact.mjs`。
- 提交前：检查 `git status`，只暂存本次文件；不要提交 `dist-inspection/` 或 `scripts/create-evidence ...冲突副本...` 等用户工件。
