# M2 Readonly Test Results Data Pack

状态：自动化不变量通过；真实 participant pilot 未运行；Gate 2 = `CONDITIONAL`。

## 来源决策

M2 只接收用户主动选择的一份本地 JSON 文件，格式为 Playwright JSON report 或公开的 `events` schema。它由 `readonly-test-results` adapter 解析为 M1 `BehaviorEvent`，不监听桌面、不联网、不执行动作。一次 runtime 只允许一个 active ConsentGrant；更换来源必须先撤回授权并完成删除。

## 数据字典

| 输入字段 | 允许值/限制 | 处理 | 持久化位置 |
| --- | --- | --- | --- |
| `schemaVersion` | 字符串版本 | 记录来源版本；不进入事件语义 | preview buffer 短暂存在 |
| `capturedAt` / `startedAt` | ISO timestamp | 用于 clock-skew 基线 | 不单独持久化 |
| `timezone`, `locale` | 最长 80/32 字符 | 只生成 locale-timezone diagnostic | BehaviorEvent privacy/provenance |
| `projectAlias` | 安全 token ≤80 | 映射到 `projectKey` | `subject`/`attributes` |
| `sourceItemKey` | 安全 token ≤80 | 去重与 provenance 锚点 | BehaviorEvent/source |
| `occurredAt` | 有效 ISO timestamp | 排序、clock-skew 校验 | BehaviorEvent |
| `kind` | M1 event kind union | schema 校验 | BehaviorEvent |
| `subject.appId`, `subject.projectKey` | allowlist + 安全 token | 语义主体 | BehaviorEvent |
| `attributes.commandClass` | `test`（或 M1 allowlist） | 低粒度操作类别 | BehaviorEvent |
| `attributes.testOutcome` | `passed`/`failed`/`skipped` | 测试结果 | BehaviorEvent |
| `attributes.durationMs`, `exitCode` | 有界整数 | 运行统计 | BehaviorEvent |
| `attributes.fileExt`, `operation` | 有界 allowlist | 粗粒度文件/操作信息 | BehaviorEvent |
| `error`, `errors`, `stdout`, `stderr`, `attachments` | 禁止落库 | 仅增加 redaction count | 不持久化 |
| 未知字段 | 拒绝 | `ERR_UNKNOWN_FIELD` + `schema-drift` | 不持久化 |

原始 JSON 只作为带 `inputHash` 的短期 PreviewGuard buffer 存在；commit 后不作为业务记录保存。业务事件带 `local-sensitive`、ConsentGrant、policyVersion、dedupe/fact/provenance hashes。Episode、Claim、Question、SkillCandidate、ActionIntent、Report 是 derived records，不包含原始错误正文。

## Source → sink matrix

| source | application boundary | allowed sink | forbidden sink/effect |
| --- | --- | --- | --- |
| 用户选中的 JSON bytes | `ReadonlyTestResultsAdapter.preview` | parser diagnostics、Preview DTO | 网络、桌面监听、动作执行 |
| accepted event fields | `ObservationPort` → PreviewGuard | business `behavior_event_v1` | 原始 JSON、stdout/stderr、截图 |
| accepted events | Insight Loop | 30-day derived lineage | export、外部 telemetry |
| consent metadata | `ControlPort` | immutable system Grant/Revocation + ledger | Grant 原地写 revokedAt |
| retention metadata | application commit | event 7-day / derived 30-day TTL | 无 consent 延长 TTL |
| user revoke/expiry | `revokeConsent` / retention worker | M1 DeletionPlan/journal + privacy epoch | 只删 UI 或孤立派生物 |
| UI presentation | AppShell | coarse source label、preview/rejection/diagnostic copy | 真实桌面已连接、自动执行成功 |
| export | existing explicit export boundary | 仅用户另行确认的 receipt | M2 自动导出 |

## Consent and retention snapshot

`ConsentGrant` 是 immutable：`source`, `allowedFields`, `purpose`, `retentionPolicyId`, `policyVersion`, `grantedAt`, `riskAccepted`, `riskVersion` 和 `contentHash` 必须存在。撤回追加独立 `ConsentRevocation`，先线性化 `privacyEpoch`，再用 M1 删除协议清除事件及所有可达派生 lineage。Preview 和 commit 各自验证 active grant、purpose、字段 hash、policy、retention 和 epoch。

默认策略：event TTL = 7 天，derived TTL = 30 天；只允许缩短。PRIVATE 不暂停 TTL。时钟不可读或删除审计失败时进入 recovery-only，普通写入关闭。

M2 采用 local-first 风险接受而非应用级静态加密：用户确认同机用户、恶意扩展、profile 同步/备份和磁盘取证仍可能读取本地数据。M2 不授予任何读取之外的能力。

## Pilot package

每名参与者使用一份自己主动选择的真实 Playwright/test-results JSON；记录 source hash、ConsentGrant hash、adapter/policy versions、preview accepted/rejected/diagnostics、commit cursor、纠正耗时、忽略/退出、误解类型和删除确认。synthetic fixture 与真实 pilot 分开统计。

当前 package 只包含自动化证据，尚无参与者数据、NetValue 或置信区间，因此不得把 Gate 2 标为 `PASS`。预注册 pilot 目标为至少 12 名目标开发者、每人 2 次同类会话；`[INV]` 全过且 NetValue 中位数 > 0 才能升级为 `PASS`，样本不足为 `CONDITIONAL`，隐私事件或持续净负价值为 `STOP`。
