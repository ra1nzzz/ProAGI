# ProAGI Assistant COMPLETED

> 本文件记录已经完成的模块。北极星目标与未完成队列见 [ROADMAP.md](ROADMAP.md)；模块从 ROADMAP 移入这里后，不再作为未完成事项重复排队；阶段 Gate 和外部证据若仍不足，继续留在 ROADMAP。

## 记录规则

- “工程完成”只表示当前代码、契约和自动化证据达到已声明范围，不代表真实用户价值、真实模型质量或阶段 Gate 已放行。
- 任何 `NOT_RUN`、`CONDITIONAL` 或失败的外部证据都不能写成完成。
- 删除/撤权、隐私、可访问性和 Shadow-only 边界属于完成定义的一部分，不能因功能可演示而省略。

## 移入规则

- 只有代码、契约和声明范围内的自动化证据齐全，模块才从 ROADMAP 移入本文件。
- 真实参与者、真实模型、人工视觉/NVDA、托管 CI 等外部证据未完成时，只记录已完成的工程切片，未完成项继续留在 ROADMAP。
- 移入条目保留实现依据、验证边界和回链；新增灵感先按 ROADMAP 的入队规则排序，不直接写入完成列表。

## 已完成模块

### `C-M1-CORE` — Insight Loop 核心闭环

- bundled/synthetic fixture 的预览、校验、脱敏、导入和确定性 Episode/Report/Insight 生成。
- Insight accept/edit/reject/delete；不可变 revision、Knowledge head CAS、provenance 和 Replay before/after。
- Question/SkillCandidate/Shadow ActionIntent 只作为有证据的候选，证据不足时 abstain。
- 依据：[final/PRD.md](final/PRD.md)、[final/SPEC.md](final/SPEC.md)、`src/domain/`、`tests/`。

### `C-M1-PERSISTENCE` — 本地 canonical store、隐私与恢复

- IndexedDB canonical store、cursor/epoch/incarnation、Preview/Import guard、幂等 receipt、delete lineage、PURGE/recovery 及 clear 边界。
- PRIVATE、Consent/Retention 相关工程约束、删除不可复活、跨标签旧 preview fencing；本地 Chromium 已验证跨标签状态传播、删除/PURGE 协调与 peer runtime 释放。
- 依据：[final/ARCH.md](final/ARCH.md)、[final/CHECKPOINT.md](final/CHECKPOINT.md)、`src/adapters/indexedDbM1b.ts`、集成/E2E 测试。

### `C-M1-PRESENTATION` — Web AppShell 与 Shadow UI

- ProAGI Assistant AppShell、六态 Orb、Today/Observed/Learned/Inbox/Replay、隐私和 Recovery surface。
- 键盘/focus、320px/桌面 reflow、forced-colors、reduced-motion、axe 与 Shadow browser-effect 约束。
- 依据：[final/PRD.md](final/PRD.md)、[final/SPEC.md](final/SPEC.md)、`src/ui/`、`tests/a11y/`、`tests/e2e/`。

### `C-M2-READONLY-ENGINEERING` — consent-bound 窄只读源工程

- `readonly-test-results` adapter、ConsentGrant/Revocation、字段白名单、preview/commit 双校验、event/derived TTL、用户可缩短的 CAS retention policy、retention expiry 和撤权删除路径。
- 策略缩短会取消待提交预览、禁止延长（除非重新 consent）、按新 TTL 计算到期并复用 DeletionPlan/journal；只读事件内部临时字段不会穿透持久化 schema，重载恢复可严格校验。
- 输入范围是用户主动选择的测试结果 JSON；不监听桌面、不联网、不注入输入、不执行动作。
- 真实 participant pilot、NetValue 与 Gate 2 仍未完成，保留在 ROADMAP 的 `Q-M2-PILOT`。
- 依据：[final/M2-READONLY-DATA-PACK.md](final/M2-READONLY-DATA-PACK.md)、[final/EVAL.md](final/EVAL.md)、M2 集成测试。

### `C-M2-PILOT-EVIDENCE-TOOLING` — participant pilot 脱敏取证工具

- `scripts/pilot-evidence.mjs` 严格校验 participant/session token、consent 生命周期、retention、纠正结果与 NetValue；拒绝未知字段、自由文本和原始工作内容。
- 生成 participant-level 汇总、确定性 bootstrap 95% 区间、报告 content hash、artifact hash、TRACE binding 和 payload-free 运行日志；默认不产生 `PASS`，真实 pilot 仍在 ROADMAP。
- 真实浏览器中的 consent→preview→commit→revoke/delete 路径已在两个 Chromium 视口各通过 1/1，并记录 `M2.pilot` `NOT_RUN` TRACE；这不是 participant pilot 结果。
- 依据与实现：[final/EVAL.md](final/EVAL.md)、`scripts/pilot-evidence.mjs`、`scripts/tests/pilot-evidence.test.mjs`。

### `C-M3A-RUNTIME` — typed Runtime/fake/Codex adapter 工程

- typed request/handle/result、capability、deadline/cancel、idempotency、protocol mismatch 与 provider DTO 隔离。
- Fake contract 和 Codex 初始化握手已具备；真实 live-model 任务仍 `NOT_RUN`，不把握手当模型质量证据。
- 依据：[final/M3-ADAPTERS.md](final/M3-ADAPTERS.md)、`src/application/runtimePort.ts`、`src/application/isolatedRuntime.ts`、`src/adapters/`、Runtime contract/fault tests。

### `C-M3B-PROJECTION` — Markdown Projection 工程

- canonical store 到 Markdown 的全量/增量重建、sourceCursor/epoch/incarnation/CAS、冲突、删除传播、转义、预览、禁用和显式不可逆导出。
- 不自动写 Obsidian/Vault；projection 失败只关闭投影，不影响 Core。
- Projection 自动化和双视口 E2E 已有证据；TRACE 记录与导出已作为独立模块完成，外部人工 case 仍由 ROADMAP 的 Gate 队列管理。
- 依据：[final/M3-ADAPTERS.md](final/M3-ADAPTERS.md)、`src/adapters/markdownProjection.ts`、`tests/projection/`、`tests/e2e/m3-projection.spec.ts`。

### `C-TRACE-EVIDENCE` — 本地 TRACE 与人工核验闭环

- Runtime、Projection、隐私状态和手动核验均写入本地脱敏 `trace_event_v1`；人工核验使用固定 case、step/reviewer token、`PASS/FAIL/NOT_RUN` 和可选 artifact SHA-256，入口覆盖 M1c、M2 pilot、M3 live-model、M4 action decision 与 M5 native smoke。
- TRACE 采用严格字段白名单，拒绝原始输入、路径、动态敏感字段和自由文本；持久化边界为 30 天、最多 2048 条、最多 1 MiB，内存队列最多 512 条，sink 失败不影响 Core。
- 导出必须先生成预览、用户明确确认后导出；通过不可变预览快照避免异步诊断造成 hash 竞态，并在 privacy/revoke/clear/close/manual check 或外部状态变化时失效。
- 依据与实现：[final/ARCH.md](final/ARCH.md)、[final/EVAL.md](final/EVAL.md)、`src/application/trace.ts`、`src/application/browserInsightRuntime.ts`、`tests/trace/`、`tests/e2e/app.spec.ts`。

### `C-DOCS-BASELINE` — PRD、架构、计划与评价基线

- 原始 PRD、研究报告、最终 PRD/SPEC/ARCH/PLAN/CHECKPOINT/EVAL 及五轮 review 已完成冻结和回链。
- 本三件套（ROADMAP/COMPLETED/REFERENCE）是其上的项目级导航，不替代领域契约或 Gate 规则。

## 验证摘要

- Fork pool 单测：162/162 通过；`typecheck`、`lint`、production build、CSP、suite completeness 和 production artifact 检查均通过。
- Chromium 双视口 E2E：34/34 通过；包含 M2 consent/revoke/delete、授权边界展示、保留期缩短、跨标签状态传播与删除/PURGE 协调、M2/M4 人工 `manual.check` 写入、脱敏 TRACE 审计和显式导出核验。生产 artifact 状态为 `CLEAN`，build identity 为 `aa0c2394ff435d9e79bd57547fcac780b804135fb6d3a811812a544e7f13040e`。
- M2 pilot evidence tooling：6/6 通过；覆盖严格字段/隐私拒绝、participant-level 统计、确定性区间、artifact binding、CLI 和失败日志。
- Release gates：14 项通过，1 项显式 `SKIP`（Windows 不执行 POSIX 超时测试），无失败；SKIP 仍不等于真实 live-model 或外部人工证据。
- Gate 1、Gate 2、Gate 3a、Gate 3b 仍是 `CONDITIONAL`；NVDA、人工视觉批准、participant pilot、真实 live-model evaluation 等外部证据不可由自动化替代。
