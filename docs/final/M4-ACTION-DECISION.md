# M4 真实动作独立 PRD 检查点

**状态**：`NEED_MORE_EVIDENCE`（2026-09-08）
**定位**：Gate 4 的准备材料，不是 live action 的实现授权。

## 当前裁决

当前只能裁决为 `NEED_MORE_EVIDENCE`：

- M2 participant pilot 仍为 `NOT_RUN`，没有真实 NetValue、纠正吸收或延迟伤害基线；
- M3 live-model evaluation 仍为 `NOT_RUN`，Gate 2、Gate 3a/3b 仍为 `CONDITIONAL`；
- 尚未选定一个由真实用户价值证据支持的单一动作；
- 当前 ActionPort/ShadowPreview 调用图的 live action 调用数仍为 `0`。

因此当前产品继续保持 Shadow-only，不实现、演示或暗示任何真实动作。

## 立项前必须补齐

只有以下材料全部具备，才可重新裁决：

1. **用户价值证据**：来自受控真实试点的正向净价值、审阅/纠正成本、忽略与退出率，并保留完整分母；synthetic 结果不能替代。
2. **动作级威胁模型**：明确资产、触发边界、最小权限、失败模式、误操作后果、数据流、缓解措施、验证证据和 STOP 条件。
3. **Capability/Consent 契约**：逐动作 allowlist、显式 opt-in、范围/期限绑定、PRIVATE/暂停/撤权即时失效、不可继承；读取权限不得升级为动作权限。
4. **动作协议**：precondition、幂等键、expected effect、postcondition、超时/取消、有限重试、undo/compensation，以及不可补偿时的安全终态。
5. **最终状态 evaluator**：直接检查目标应用/领域最终状态，覆盖 stale、duplicate、permission、timeout、response-loss、compensation 和 `DelayedHarmRate`；不得用按钮点击或 toast 代替。
6. **独立 review**：新动作 PRD 完成五轮 review，并给出 APPROVE、NEED_MORE_EVIDENCE、STOP 的可复核裁决。

在裁决前，候选动作保持“未选定”；不得为了填充路线图而预先创建通用 action adapter、UIA 权限或 IPC 执行通道。

## 人工验证与 TRACE 绑定

每个外部或人工步骤必须使用固定 `caseId/stepId`，经 Application `recordManualCheck` 写入脱敏 `trace_event_v1`：

| caseId | 用途 |
| --- | --- |
| `M4.action-value` | 用户价值与净价值证据审阅 |
| `M4.threat-model` | 动作级威胁模型审阅 |
| `M4.capability-consent` | capability/consent 与撤权边界审阅 |
| `M4.evaluator` | 最终状态、补偿和延迟伤害 evaluator 审阅 |
| `M4.review` | 五轮独立 review 结果 |
| `M4.action-decision` | Gate 4 最终裁决 |

结果只能是 `PASS | FAIL | NOT_RUN`；审核人只能写 token，artifact 只能写 SHA-256，命令与环境日志保留在 Evidence Pack 并与 correlationId/hash 回链。`NOT_RUN` 的原因保留在 Evidence Pack，不写入 TRACE 自由文本。TRACE 记录证据索引，不能替代实际人工审阅。

## 裁决规则与回滚

- `APPROVE_NEW_PRD`：仅允许开始另一个独立动作 PRD；不代表已实现或验证 live action。
- `NEED_MORE_EVIDENCE`：材料缺失、样本不足或依赖 Gate 未通过；继续 Shadow-only。
- `STOP`：净价值持续为负、隐私不变量失败、或动作无法可靠撤销/补偿；删除候选能力并保留无 payload 证据。

一旦发现任何 live action 调用，立即撤销 capability、停用 adapter、回到 Shadow-only，并将 Gate 4 判为 `FAIL`；不得用 UI 文案或日志覆盖真实副作用。

## 依赖与下一步

先完成 `Q-M2-PILOT`、`Q-M3-LIVE-EVAL` 及 Gate 1–3 的外部证据，再为一个具体动作补齐上述材料。当前 M4 的唯一有效产物是本裁决与其 TRACE/Evidence Pack 入口。
