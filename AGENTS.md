# ProAGI 项目速记

- 北极星：一个持续记录用户的电脑使用习惯、识别分析归类不同时间用户在不同的工作任务中的操作，持续自学习、自进化的终身陪伴性AGENT（最终目标是AGI AGENT）。
- 知识库入口：[ROADMAP](docs/ROADMAP.md)、[COMPLETED](docs/COMPLETED.md)、[REFERENCE](docs/REFERENCE.md)；三者分别负责未完成队列、已完成模块、依据与引用。
- 当前基线（2026-09-09）：M1 工程闭环、M2 consent-bound 窄只读源工程（含 CAS 缩短 retention）、M3a Runtime、M3b Markdown projection、TRACE 证据闭环和 bundled module Worker 预验证已完成；Worker 不可用时 fail closed，用户文件通用 ImportSession streaming 仍未接入。M2 pilot evidence tooling 已准备但真实 pilot 仍 `NOT_RUN`；全量 fork 单测 162/162、双视口 E2E 34/34 通过，跨标签状态传播、删除/PURGE 与 `runtime.worker` 已有本地 Chromium 证据。
- 未完成：M2 participant pilot、真实 live-model evaluation、Gate 1/2/3 证据；M4 独立动作裁决为 `NEED_MORE_EVIDENCE`，M5 Tauri/EXE/UIA 尚未开始。
- 边界：IndexedDB canonical store 是唯一真相；projection 失败只关闭 projection；不自动写 Obsidian/Vault；导出必须用户确认；保持 privacy/purge/recovery、可访问性与只读授权约束。
- 常用核验：`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run test:worker-contract`、`npm.cmd test -- --pool=forks`、`npm.cmd run test:e2e`、`npm.cmd run build`、`node scripts/check-production-artifact.mjs`。
- 提交前：检查 `git status`，只暂存本次文件；不要提交 `dist-inspection/` 或 `scripts/create-evidence ...冲突副本...` 等用户工件。
