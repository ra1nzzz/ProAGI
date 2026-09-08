# ProAGI Assistant REFERENCE

> 本文件回答“为什么这样实现、依据哪份研究或项目参考”。外部材料是设计依据，不表示复制其代码或已经拥有其能力；当前 schema、隐私边界和阶段状态以仓库内 canonical 文档与代码为准。

## 权威来源映射

| 事实类型 | 唯一责任方 | 说明 |
| --- | --- | --- |
| 北极星目标与长期模块 | [ROADMAP.md](ROADMAP.md) + 用户在 2026-09-08 的明确指示 | ROADMAP 固化“持续记录电脑使用习惯、识别分析归类工作任务操作、持续自学习自进化、终身陪伴、最终走向 AGI AGENT”的目标，并拆成可依赖的阶段和队列。 |
| 当前产品合同 | [final/PRD.md](final/PRD.md) | 只规定当前可验证切片，不把北极星当作已交付能力。 |
| 类型、状态、错误、数据和隐私契约 | [final/SPEC.md](final/SPEC.md) | 实现不得自行扩展兼容语义。 |
| 架构与边界 | [final/ARCH.md](final/ARCH.md) | canonical store、Ports/Adapters、Shadow-only 和删除边界。 |
| 里程碑与阶段顺序 | [final/PLAN.md](final/PLAN.md) | 固定 M1→M2→M3→M4→M5。 |
| Gate、人工证据和放行 | [final/CHECKPOINT.md](final/CHECKPOINT.md) | `PASS/CONDITIONAL/FAIL/STOP` 与 Evidence Pack。 |
| M4 动作裁决边界 | [final/M4-ACTION-DECISION.md](final/M4-ACTION-DECISION.md) | 只记录独立动作 PRD 的准入材料、TRACE case 和 `NEED_MORE_EVIDENCE` 裁决；不提供 live action。 |
| 指标、pilot、fixture、命令 | [final/EVAL.md](final/EVAL.md) | synthetic 与真实价值分开。 |
| 研究与引用汇总 | [research/deep-research-report.md](research/deep-research-report.md) | 研究原文链接和局限性记录。 |
| 短期交接速记 | [../AGENTS.md](../AGENTS.md) | 只保留高频事实和核验命令，不承担完整产品合同。 |

## 模块与参考来源

| 模块/功能 | 仓库实现依据 | 研究/开源或平台参考 | 采用内容与明确边界 |
| --- | --- | --- | --- |
| 北极星目标拆解：感知→理解→记忆→陪伴→能力/行动→受约束自进化 | [ROADMAP.md](ROADMAP.md)、[PRD](PRD/desktop-agent-complete-prd-v1.1.md)、[deep-research-report.md](research/deep-research-report.md) | 原始桌面 Agent PRD 与本项目深度调研结论 | 用于排列 M1→M5 与 `F-*` 依赖；长期方向不等于当前能力，所有扩大权限的模块仍需独立证据和阶段 Gate。 |
| 事件优先、低粒度活动记录 | `src/domain/`、M1/M2 schema | [ActivityWatch](https://activitywatch.net/)、[Buckets and events](https://docs.activitywatch.net/en/latest/buckets-and-events.html)、[Security](https://docs.activitywatch.net/en/latest/security.html) | 参考 bucket/event 与本地数据边界；不复制其采集范围，不因此开放全局监听。 |
| Windows 窄只读感知 | M5 规划、未来 UIA adapter | [Microsoft UI Automation](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-overview) | 参考控件语义访问模型；必须 allowlist、只读、可暂停、可降级，当前尚未实现。 |
| 许可、隐私和屏幕访问边界 | M2/M5 consent 与 future screenshot fallback | [Recall privacy controls](https://support.microsoft.com/en-us/windows/privacy/privacy-and-control-over-your-recall-experience-d404f672-7647-41e5-886c-a3c59680af15)、[Apple screen/audio controls](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac) | 参考显式授权、暂停和可控范围；不代表本产品已持续截图或拥有系统权限。 |
| 任务/结果 evaluator | `docs/final/EVAL.md`、`tests/evaluator/` | [OSWorld paper](https://arxiv.org/abs/2404.07972)、[OSWorld](https://github.com/xlang-ai/OSWorld) | 参考执行后状态 evaluator、任务初始状态和可复现评估；当前仍是本地 fixture/Shadow，不是 OSWorld 集成。 |
| Runtime adapter | `src/application/runtimePort.ts`、`src/application/isolatedRuntime.ts`、`src/adapters/fakeRuntime.ts`、`src/adapters/codexAppServer.ts`、[M3-ADAPTERS.md](final/M3-ADAPTERS.md) | [Codex app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server)、[ACP v1](https://agentclientprotocol.com/protocol/v1/overview)、[ACP GitHub](https://github.com/agentclientprotocol/agent-client-protocol) | 参考 typed protocol、能力协商和隔离；provider DTO 不进入 Core，真实模型任务仍 `NOT_RUN`。 |
| M2 participant pilot 取证 | `scripts/pilot-evidence.mjs`、[final/EVAL.md](final/EVAL.md) | [final/CHECKPOINT.md](final/CHECKPOINT.md) 的 Evidence Pack 规则与本项目 TRACE contract | 采用严格 token/数值字段、participant-level 汇总、artifact hash、命令日志和 `manual.check` binding；工具只整理真实输入，不生成参与者结果或自动放行。 |
| Markdown/Obsidian projection | `src/adapters/markdownProjection.ts` | [Obsidian Properties](https://help.obsidian.md/properties) | 参考人机可读、原子属性与 Markdown 生态；canonical truth 仍是 IndexedDB，不自动写 Vault。 |
| provenance 与 lineage | `docs/final/SPEC.md`、`src/domain/` | [W3C PROV-O](https://www.w3.org/TR/prov-o/) | 参考 Entity/Activity/Agent provenance 关系；仓库使用自己的版本化、删除和 scope 契约。 |
| 数据最小化与保留 | `src/application/browserInsightRuntime.ts`、`src/domain/readonlySource.ts`、`tests/privacy/m2-consent.test.ts` | [GDPR Article 5](https://eur-lex.europa.eu/eli/reg/2016/679/oj) | 参考 data minimisation；RetentionPolicy 只能通过 CAS 缩短，旧预览按新 TTL 校验，策略缩短/到期复用删除协议；不是法律合规认证，local-first 也不等于静态加密。 |
| 用户信任、解释与纠正 | AppShell、Insight/Correction/Replay | [Guidelines for Human-AI Interaction](https://doi.org/10.1145/3290605.3300233)、[Algorithm Aversion](https://pubmed.ncbi.nlm.nih.gov/25401381/) | 参考可解释、可纠正和信任校准；当前产品不以接受率替代价值证据。 |
| 置信度与选择性输出 | `docs/final/EVAL.md` | [On Calibration of Modern Neural Networks](https://proceedings.mlr.press/v70/guo17a.html) | 参考 calibration/selective risk 评价；阈值属于待 pilot 验证假设。 |
| 受约束的自进化 | 北极星长期队列 `F-EVOLUTION` | [Darwin Gödel Machine paper](https://arxiv.org/abs/2505.22954)、[DGM](https://github.com/jennyzzt/dgm) | 参考“候选修改→经验验证→保留/回滚”思想；不把在线自修改、模型权重训练或自博弈列为当前能力。 |

## 本地实现与外部参考的关系

1. 外部项目只提供问题分解、协议、评估或交互参考；本项目所有领域 schema、hash、权限、删除和生命周期语义以 `docs/final/SPEC.md` 为准。
2. 任何未来 adapter 必须经现有 Application/Port 进入，不能因参考项目存在就绕过 consent、redaction、TRACE、recovery 或 Shadow-only。
3. 外部引用不能替代人工证据：真实用户价值、模型质量、UIA coverage、NVDA 和视觉批准必须有本项目自己的 artifact 与 `manual.check` TRACE 记录。

## 来源快照与冲突裁决

- 本次知识库维护的输入快照为 commit `ec5ad146ea4e49b2b85b68d6eb86cf6aa69106a9`、tree `cb73d86e5b02e3eabec1ea7fd6f89eaa746a4e27`；本次只更新 ROADMAP/COMPLETED/REFERENCE 的目标、队列、状态与回链，不改变实现或外部证据状态。
- 当前实现基线：M2 pilot evidence runner、TRACE、readonly revoke 竞态修复、授权边界展示、retention shortening、M4 action-decision TRACE 入口和预注册 case 校验已提交于 commit `8a6eb08`（其 tree 为 `5753e347077131b968ad9f02f1eaaaa2bb816d64`）；知识库入口初始提交为 `98ecb82`。live action 仍为 0。
- `dist-inspection/` 与冲突副本脚本属于用户工件，不进入本知识库提交；工作树中的未提交用户工件不被本文件伪装成已发布版本。
- 原始宽 PRD `docs/PRD/desktop-agent-complete-prd-v1.1.md` 是长期愿景与研究输入；`docs/final/PRD.md` 是当前收敛后的可验证合同。两者冲突时，长期方向保留在 ROADMAP，当前范围以 `final` 六件套和代码/测试为准。
- `AGENTS.md` 是交接速记，不与 ROADMAP/COMPLETED/REFERENCE 竞争；它只回链本知识库。
- `evidence/`、`evidence-logs/`、`test-results/` 是运行证据/生成物，不是需求或架构真相；其状态只能通过 manifest、命令退出码和 TRACE/artifact hash 引用。
