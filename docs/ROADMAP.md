# ProAGI Assistant ROADMAP

> 本文件是项目级路线图与当前状态入口。它只保留未完成事项；已完成模块移至 [COMPLETED.md](COMPLETED.md)。实现依据与外部参考见 [REFERENCE.md](REFERENCE.md)。
>
> 审计日期：2026-09-08。阶段放行仍以 [final/CHECKPOINT.md](final/CHECKPOINT.md) 为准，领域契约仍以 [final/SPEC.md](final/SPEC.md) 为准。

## 北极星目标

一个持续记录用户电脑使用习惯、识别、分析并归类用户在不同时间、不同工作任务中的操作，持续自学习、自进化的终身陪伴性 Agent；最终目标是 AGI Agent。

这是一条长期产品方向，不等于当前版本已经拥有桌面监听、真实执行或 AGI 能力。当前路线必须先用可审计、可撤回、可回放的证据证明每一层能力，再扩大权限和范围。

## 知识库入口与权威边界

- `ROADMAP.md`：当前、未来、阻塞、依赖排序和灵感入队规则。
- `COMPLETED.md`：已经完成并从本路线图移除的模块，附验证边界。
- `REFERENCE.md`：需求、架构、研究、开源项目和实现来源映射。
- `final/PRD.md`：当前阶段产品合同；保留北极星下的可验证切片范围。
- `final/PLAN.md`：M1→M5 阶段顺序和交付计划。
- `final/CHECKPOINT.md`：Gate 证据与放行规则。
- `final/EVAL.md`：指标、fixture、pilot 和评价协议。

## 当前状态

- 已完成 M1 工程闭环、M2 consent-bound 窄只读源工程、M3a typed Runtime/fake/Codex adapter、M3b Markdown projection 工程实现。
- TRACE 诊断、`manual.check` 人工核验记录、脱敏预览与显式导出闭环已完成并提交；TRACE 单测 7/7、全量 fork 单测 160/160、双视口 E2E 30/30、生产构建与 artifact 检查均通过。外部人工 case 的结果仍按 Gate 队列记录，不伪装成自动化完成。
- M2 participant pilot 的脱敏 evidence report、统计/置信区间、artifact binding 与运行日志工具已准备并通过 5/5 专门测试；真实参与者数据仍未运行。
- Gate 1、Gate 2、Gate 3a、Gate 3b 均保持 `CONDITIONAL`；synthetic/自动化结果不得解释为真实用户价值或真实模型质量。
- M2 participant pilot 与真实 live-model evaluation 仍为 `NOT_RUN`；M4、M5 尚未开始。

## 当前队列（只列未完成）

| 顺序 | ID | 模块/目标 | 状态 | 依赖 | 完成定义与 TRACE 证据 |
| --- | --- | --- | --- | --- | --- |
| 0 | `Q-M2-PILOT` | 一个窄真实只读源的 participant pilot | `PREPARED / NOT_RUN / EXTERNAL` | M1 必要证据、ConsentGrant、RetentionPolicy、pilot evidence runner、受控参与者 | 至少 12 名目标开发者、每人 2 次同类会话；记录 consent、preview/commit/revoke/retention、纠正耗时、退出/忽略、NetValue 与置信区间；报告 hash/binding/命令日志齐全，所有人工步骤写入 TRACE。 |
| 0 | `Q-GATE-1` | Gate 1 外部人工/托管证据补齐 | `CONDITIONAL` | 自动化基线 | NVDA、人工视觉批准、托管 CI、跨标签协调等缺项有真实结果；每个 case 有 `PASS/FAIL/NOT_RUN` 和 artifact hash，禁止用 UI 成功文案替代。 |
| 1 | `Q-M3-LIVE-EVAL` | 真实 provider/live-model evaluation | `NOT_RUN` | M2 pilot 结果、provider approval、出站 consent | 真实任务仅使用最小脱敏输入；记录 protocol/version、request/result hash、timeout/cancel、人工评审和模型价值；provider DTO 不进入 Core。 |
| 1 | `Q-GATE-3` | Gate 3a/3b 独立裁决 | `CONDITIONAL` | Q-M3-LIVE-EVAL、TRACE 导出可核验 | Runtime 与 Projection 分别提交 contract/fault/live evidence；任一失败只回滚自身，不影响 Core；证据包由 TRACE 与 artifact manifest 互相回链。 |
| 2 | `Q-M4-DECISION` | 真实动作独立 PRD 检查点 | `NOT_STARTED` | Gate 1–3 证据、真实价值需求 | 只输出 `APPROVE_NEW_PRD | NEED_MORE_EVIDENCE | STOP`；提交动作级威胁模型、consent/capability、幂等、前后置条件、undo/compensation、STOP 条件。当前 PRD 仍 Shadow-only。 |
| 3 | `Q-M5-EXE` | Tauri 壳、Windows UIA 窄只读场景与 EXE | `NOT_STARTED` | 前序 Gate、M4 裁决、受支持 Windows 测试机 | 可复现 Tauri build/installer、IPC 身份与审计、一个 allowlisted UIA 场景、安装/卸载/清除/资源/权限撤销证据；不扩展为全桌面或通用 Computer Use。 |

## 未来队列（依赖排序）

这些是北极星目标的后续生产化模块；M1 中已经存在的最小原型不在此重复计数。

| 顺序 | ID | 目标模块 | 依赖 | 进入条件 |
| --- | --- | --- | --- | --- |
| 5 | `F-PERCEPTION` | 事件优先的真实感知适配器：浏览器、终端、IDE、窄 UIA | M2 pilot、M5 shell/UIA | 先完成来源 consent、字段/分类矩阵和事件丢失/噪声证据；截图只作为独立授权的最小 ROI fallback。 |
| 6 | `F-SEGMENTATION` | Activity→Episode→Task→Workflow 分层与跨时间任务识别 | F-PERCEPTION | 有真实事件基线、时区/乱序/缺失鲁棒性和 Episode/Workflow evaluator。 |
| 7 | `F-WORLD-MODEL` | User/Work/Workflow/Agent world model、冲突、衰减、检索 | F-SEGMENTATION | 证据 provenance、scope、revision、删除和 Replay 语义稳定。 |
| 8 | `F-FEEDBACK` | Socratic Question、日报、显式/隐式反馈与个人 benchmark | F-WORLD-MODEL、Q-M2-PILOT | 用户理解、纠正负担、净价值和 abstention 通过 pilot；隐式反馈不得单独写成事实。 |
| 9 | `F-SKILL` | Skill/Tool/Workflow 生成、静态/沙箱/Replay/Shadow 四层验证 | F-WORLD-MODEL、F-FEEDBACK、Q-M4-DECISION | 候选能力可回放、可比较、可回滚；未经批准不能执行。 |
| 10 | `F-RUNTIME` | 多 Runtime 路由、CLI、MCP、A2A Gateway、daemon | Q-M3-LIVE-EVAL、F-WORLD-MODEL | 每个入口复用 Application contract；身份、scope、出站审计和 provider 隔离有证据。 |
| 11 | `F-ACTION` | 经独立动作 PRD 批准后的低风险执行 | Q-M4-DECISION、F-SKILL、F-RUNTIME | 仅逐动作 capability/consent；pre/postcondition、幂等、undo、补偿和 DelayedHarmRate evaluator 全部成立。 |
| 12 | `F-EVOLUTION` | 受约束的策略、技能与 Agent 系统自进化 | F-SKILL、F-ACTION、长期评估 | proposer/critic/verifier、隔离、版本、回滚、人工批准和基准提升同时成立；模型权重训练不自动进入产品。 |

## 阻塞与风险

| 阻塞项 | 影响 | 解除条件 |
| --- | --- | --- |
| 缺真实参与者与真实来源 | Q-M2-PILOT、Gate 2 | 受控试点、明确 consent/retention/revoke、预注册方案与人工 TRACE 记录。 |
| 真实模型任务尚未批准/运行 | Q-M3-LIVE-EVAL、Gate 3a | 通过 provider/出站边界审查并取得可核验的 live evidence。 |
| Gate 1 的 NVDA、人工视觉、托管 CI 等证据不足 | Gate 1 不能升级为 `PASS` | 每个缺项真实执行并写入 `manual.check`，不能以自动化近似替代。 |
| M4 尚无独立动作 PRD | 所有 live action | 完成新 PRD、威胁模型、evaluator 和五轮 review；在此之前保持 Shadow-only。 |
| M5 尚未建立 Tauri/EXE/UIA 交付链 | 原生常驻、EXE、桌面感知 | 前序 Gate 和 M4 允许后，建立可复现原生构建与窄 UIA 证据。 |

## 新灵感入队规则

1. 先创建 `I-YYYYMMDD-NN`，记录灵感、用户价值、数据分类、权限影响、预期证据和来源；不直接写代码。
2. 若能映射到已有 `Q-*`/`F-*`，放入该队列的“候选项”，补充依赖和验收条件；不新建里程碑。
3. 若没有对应队列，先创建最小 `F-INBOX-*` 条目，明确它依赖哪些现有模块，再按依赖关系插队。
4. 排序优先级固定为：安全/隐私/数据完整性阻塞 → 解锁前置依赖 → 用户价值证据 → 实现成本。新灵感不得绕过 M1→M2→M3→M4→M5 的阶段门。
5. 每次纳入或拒绝灵感都在本文件写一句裁决理由；已实现后从 ROADMAP 移到 COMPLETED，并保留来源回链。

当前没有未归类、可以绕过上述队列的新灵感；现有原始 PRD 模块均已映射到本路线图。

## 下一步

先准备 `Q-M2-PILOT` 的受控试点与 `Q-GATE-1` 人工 case 记录；TRACE 已提供统一核验与导出路径。不要在外部证据完成前扩大来源或实现真实动作。
