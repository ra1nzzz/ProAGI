# ProAGI Assistant COMPLETED

> 本文件记录已经完成的模块。模块从 [ROADMAP.md](ROADMAP.md) 移入这里后，不再作为未完成事项重复排队；阶段 Gate 和外部证据若仍不足，继续留在 ROADMAP。

## 记录规则

- “工程完成”只表示当前代码、契约和自动化证据达到已声明范围，不代表真实用户价值、真实模型质量或阶段 Gate 已放行。
- 任何 `NOT_RUN`、`CONDITIONAL` 或失败的外部证据都不能写成完成。
- 删除/撤权、隐私、可访问性和 Shadow-only 边界属于完成定义的一部分，不能因功能可演示而省略。

## 已完成模块

### `C-M1-CORE` — Insight Loop 核心闭环

- bundled/synthetic fixture 的预览、校验、脱敏、导入和确定性 Episode/Report/Insight 生成。
- Insight accept/edit/reject/delete；不可变 revision、Knowledge head CAS、provenance 和 Replay before/after。
- Question/SkillCandidate/Shadow ActionIntent 只作为有证据的候选，证据不足时 abstain。
- 依据：[final/PRD.md](final/PRD.md)、[final/SPEC.md](final/SPEC.md)、`src/domain/`、`tests/`。

### `C-M1-PERSISTENCE` — 本地 canonical store、隐私与恢复

- IndexedDB canonical store、cursor/epoch/incarnation、Preview/Import guard、幂等 receipt、delete lineage、PURGE/recovery 及 clear 边界。
- PRIVATE、Consent/Retention 相关工程约束、删除不可复活、跨标签旧 preview fencing。
- 依据：[final/ARCH.md](final/ARCH.md)、[final/CHECKPOINT.md](final/CHECKPOINT.md)、`src/adapters/indexedDbM1b.ts`、集成/E2E 测试。

### `C-M1-PRESENTATION` — Web AppShell 与 Shadow UI

- ProAGI Assistant AppShell、六态 Orb、Today/Observed/Learned/Inbox/Replay、隐私和 Recovery surface。
- 键盘/focus、320px/桌面 reflow、forced-colors、reduced-motion、axe 与 Shadow browser-effect 约束。
- 依据：[final/PRD.md](final/PRD.md)、[final/SPEC.md](final/SPEC.md)、`src/ui/`、`tests/a11y/`、`tests/e2e/`。

### `C-M2-READONLY-ENGINEERING` — consent-bound 窄只读源工程

- `readonly-test-results` adapter、ConsentGrant/Revocation、字段白名单、preview/commit 双校验、event/derived TTL、retention expiry 和撤权删除路径。
- 输入范围是用户主动选择的测试结果 JSON；不监听桌面、不联网、不注入输入、不执行动作。
- 真实 participant pilot、NetValue 与 Gate 2 仍未完成，保留在 ROADMAP 的 `Q-M2-PILOT`。
- 依据：[final/M2-READONLY-DATA-PACK.md](final/M2-READONLY-DATA-PACK.md)、[final/EVAL.md](final/EVAL.md)、M2 集成测试。

### `C-M3A-RUNTIME` — typed Runtime/fake/Codex adapter 工程

- typed request/handle/result、capability、deadline/cancel、idempotency、protocol mismatch 与 provider DTO 隔离。
- Fake contract 和 Codex 初始化握手已具备；真实 live-model 任务仍 `NOT_RUN`，不把握手当模型质量证据。
- 依据：[final/M3-ADAPTERS.md](final/M3-ADAPTERS.md)、`src/application/runtimePort.ts`、`src/application/isolatedRuntime.ts`、`src/adapters/`、Runtime contract/fault tests。

### `C-M3B-PROJECTION` — Markdown Projection 工程

- canonical store 到 Markdown 的全量/增量重建、sourceCursor/epoch/incarnation/CAS、冲突、删除传播、转义、预览、禁用和显式不可逆导出。
- 不自动写 Obsidian/Vault；projection 失败只关闭投影，不影响 Core。
- Projection 自动化和既有双视口 E2E 已有证据；新的 TRACE 导出用例仍失败，因此 TRACE 不能在此处提前计为完成。
- 依据：[final/M3-ADAPTERS.md](final/M3-ADAPTERS.md)、`src/adapters/markdownProjection.ts`、`tests/projection/`、`tests/e2e/m3-projection.spec.ts`。

### `C-DOCS-BASELINE` — PRD、架构、计划与评价基线

- 原始 PRD、研究报告、最终 PRD/SPEC/ARCH/PLAN/CHECKPOINT/EVAL 及五轮 review 已完成冻结和回链。
- 本三件套（ROADMAP/COMPLETED/REFERENCE）是其上的项目级导航，不替代领域契约或 Gate 规则。

## 验证摘要

- Fork pool 单测基线：153/153 通过；typecheck、lint、production build、production artifact 检查已有通过记录。
- Chromium 双视口既有应用/M3b 流程已有通过记录；TRACE 新导出用例最近一次仍为 `ERR_EXPORT_STALE`，状态为未完成。
- Gate 1、Gate 2、Gate 3a、Gate 3b 仍是 `CONDITIONAL`；NVDA、人工视觉批准、participant pilot、真实 live-model evaluation 等外部证据不可由自动化替代。
