# ProAGI 项目速记

- 北极星：持续记录用户电脑使用习惯，识别/分析/归类不同时间与工作任务中的操作，持续自学习、自进化，成为终身陪伴 Agent，最终走向 AGI Agent。
- 知识库入口：[ROADMAP](docs/ROADMAP.md)、[COMPLETED](docs/COMPLETED.md)、[REFERENCE](docs/REFERENCE.md)；三者分别负责未完成队列、已完成模块、依据与引用。
- 当前基线：M1 工程闭环、M2 consent-bound 窄只读源工程（含 CAS 缩短 retention）、M3a Runtime、M3b Markdown projection 和 TRACE 证据闭环已完成；M2 pilot evidence tooling 已准备但真实 pilot 仍 `NOT_RUN`。最新实现提交为 `023e2e7`，全量 fork 单测 161/161、双视口 E2E 32/32 通过。
- 未完成：M2 participant pilot、真实 live-model evaluation、Gate 1/2/3 证据；M4 独立动作裁决和 M5 Tauri/EXE/UIA 尚未开始。
- 边界：IndexedDB canonical store 是唯一真相；projection 失败只关闭 projection；不自动写 Obsidian/Vault；导出必须用户确认；保持 privacy/purge/recovery、可访问性与只读授权约束。
- 常用核验：`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd test -- --pool=forks`、`npm.cmd run test:e2e`、`npm.cmd run build`、`node scripts/check-production-artifact.mjs`。
- 提交前：检查 `git status`，只暂存本次文件；不要提交 `dist-inspection/` 或 `scripts/create-evidence ...冲突副本...` 等用户工件。
