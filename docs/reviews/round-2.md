# REVIEW Round 2 — 数据、隐私与安全

**范围**：Round 1 修订后的 PRD + SPEC/ARCH/PLAN/CHECKPOINT/EVAL  
**方法**：YT-Review 三维并行审查 + 主代理隐私/竞态扫描

## 三维趋势评分

- 质量与用户安全：**6.8/10**
- 效率与可实施安全：**6.8/10**
- 复用性与跨文档安全一致性：**7.1/10**

评分只用于趋势，8/10 不是硬门禁。P0=0；裁决 `CONDITIONAL`。

## 已改善

Round 1 已显著修复 UUID、tombstone 类型、roadmap、脚本、semanticKey、投影边界和 DeletionPlan 方向；canonical source 策略基本落地。

## 合并 Findings

| ID | Priority | 问题 | 影响 | 采纳修复 |
|---|---|---|---|---|
| R2-01 | P1 | privacy classification 无字段/sink/后果 registry | `low/moderate` 不能决定持久化与导出 | 建立 public/local-sensitive/restricted/prohibited 数据分类和 source→sink matrix |
| R2-02 | P1 | readonly SourceRef consentId 可选，无 Consent 实体 | 无法证明字段、用途、期限与 policy 获授权 | 增加不可变 ConsentGrant；preview/commit 双检 active；撤回阻止新摄入并按策略清除 |
| R2-03 | P1 | retention 只有文案，无 TTL/schema/purge | 可无限保留仍“合规” | 增加 RetentionPolicy/retentionBasis/expiresAt；M1/M2 默认值、缩短、重启清除、clock failure 规则 |
| R2-04 | P1 | unknown/secret/drop 语义不闭合 | 删除必填字段会产生非法对象 | 决策表：unknown reject item；optional secret drop 后重验；required/identity secret reject item |
| R2-05 | P1 | PRIVATE/clear-all 与进行中事务竞态 | 切换后旧 import 仍可能提交 | 增加 privacyEpoch；preview/commit 携带 epoch，提交前复核；清内存队列/定时器 |
| R2-06 | P1 | delete 后 restore 与 payload 不可达冲突 | 可复活删除内容或无法实现 restore | restore 仅允许未删除 superseded/invalidated；deleted lineage 永久禁止 restore/reimport resurrection |
| R2-07 | P1 | tombstone formerHash/project SHA 形成字典 oracle | 低熵项目/statement 可猜测、跨导出关联 | tombstone 只留随机 deletion marker；禁止裸 payload hash；projectKey 仅 alias 或 keyed token |
| R2-08 | P1 | 自由文本缺 trust/Bidi/XSS/prompt 规则 | statement/reason/answer 可混淆 UI 或未来 Runtime | 统一 UntrustedUserText、NFC/长度/control/Bidi、输出编码、结构化 data channel |
| R2-09 | P1 | local-first 被误解为设备级保密 | IndexedDB 不能防同机用户、扩展、XSS、备份 | 明示非应用级 at-rest encryption；M1 仅 synthetic；M2 必须决定隔离/密钥或显式接受风险 |
| R2-10 | P1 | DomainError 无用户安全状态/下一步 registry | 用户不知道是否已写入、是否仍可达 | 建立 error→copy→safe state→next action registry，不回显 payload |
| R2-11 | P1 | 旧导出提示/manifest/清除文案不足 | 用户误以为外部下载也被删除 | 导出前确认类别/数量/等级；包内写边界声明；清除页列受控外 export IDs |
| R2-12 | P1 | async transaction callback 可任意 await | IndexedDB 可能提前 auto-commit | KnowledgePort 改为同步 enqueue 型事务上下文；禁止非 IDB await；真实 Chromium 测 TransactionInactiveError |
| R2-13 | P1 | expectedCursor/多标签协议不完整 | stale/dedupe/clear/private 写入竞态 | meta store 原子 cursor+privacyEpoch；所有写事务参与；content/dedupe unique index |
| R2-14 | P1 | post-commit crash 无 journal，补偿无幂等状态 | 删除可能永久停在半验证状态 | 增加无 payload DeletionJournal：PLANNED/COMMITTED/VERIFIED/FAILED，启动恢复与 recovery-only transaction |
| R2-15 | P1 | AC-13 仍要求任何 cascade 失败全回滚 | 与 post-commit audit 物理语义冲突 | 拆为事务内失败 abort 与提交后失败冻结写入+补偿；修订 AC |
| R2-16 | P1 | 删除无反向索引 | 50k/100MB 时可能全库扫描和超时 | 建 entity/ref/semanticKey 反向索引，DeletionPlan 分块但 commit 保持可恢复 |
| R2-17 | P1 | fake-indexeddb 不能验证真实 crash/quota/multi-tab | 测试绿不代表浏览器安全 | fake 用 contract；真实 Chromium E2E 覆盖 quota、blocked/versionchange、crash/reload |
| R2-18 | P1 | detector/log/audit 契约不确定 | 非确定、误报或 secret 进入 fieldPath/元数据 | versioned detectorPolicy、固定阈值/Unicode；redaction 后重验；日志 token allowlist；AuditEvent schema/TTL/上限 |
| R2-19 | P1 | Port 无 caller/capability/consent context | ARCH 权限策略无法落实 | PortRequestContext 必填；PRIVATE 只拒绝 observation import/action suggest，不拒绝 read/delete/recovery |
| R2-20 | P1 | “文件写入=0”与 IndexedDB/用户导出冲突 | 门禁误报 | 仅 Shadow 调用图禁止自动外部副作用；用户显式 JSON download 与 canonical IDB 不计为 action |
| R2-21 | P1 | provenance registry 与实体 schema 不闭合 | 硬门无法达成 | Question/Skill/Action/Eval 复用 ProvenanceEnvelope；Report/Correction/Knowledge 补适用字段 |
| R2-22 | P2 | canary 允许 sink 未定义 | DOM 预览会误报或漏报 | 每个 canary 定义允许变换和禁止 sink；原值永不持久化/日志/导出 |
| R2-23 | P2 | redaction rule ID 可泄露敏感类别 | 形成“疑似银行卡/身份”侧信道 | 持久层只存粗粒度计数；细规则 ID 短期审计且随数据删除 |
| R2-24 | P2 | clear-all 后审计计数与空库冲突 | 用户清除预期不明确 | 默认清除 origin 内所有产品数据；无 payload 证据仅允许清除前主动下载 |
| R2-25 | P2 | 100MB/80% 与性能 p95 不可稳定测 | 浏览器 storage estimate 非单 DB，机器基线缺失 | 软预算标 `[STAT]`，记录环境/样本；Worker/分块；不作隐私硬门 |

## 六类盲区扫描

- **幂等**：factHash unique index、journal idempotency key、重复补偿与 clear 后旧标签写入均需锁定。
- **安全**：低熵 hash oracle、动态 fieldPath、未授权 readonly source、自由文本 XSS/Bidi/prompt injection 是主风险。
- **可观测性**：AuditEvent 必须固定 schema、无 payload、有 TTL/容量，并能区分“未写入/事务 abort/commit 后恢复中”。
- **数据完整性**：redaction 后二次校验；证据删除采用确定 EvidenceLossPolicy；旧 EvaluationResult 不原地改写。
- **并发/竞态**：cursor/privacyEpoch/mode 在同一 IDB transaction 原子复核；PRIVATE、clear-all、delete 与双标签 import 必测。
- **外部依赖韧性**：M1 无外部服务；剩余风险为真实 Chromium 与 fake IDB 差异、quota、Playwright revision 和 npm 供应链。

## 本轮修订原则

1. 删除后不可恢复优先于历史回滚；restore 只针对仍保留的非删除 revision。
2. tombstone/journal/audit 都不得复制业务 payload、裸 hash、自由文本或敏感 detector ID。
3. PRIVATE/clear-all 首先冻结普通写；只允许 recovery-only 清除事务。
4. “本地”不等于“加密”或“同机不可读”；M2 前必须形成明确决策。
5. Shadow 零副作用以调用图和用户意图为边界，不把正常 IndexedDB 或显式下载误判为动作。

## Round 1 遗留一并修正

- 清理 PRD 中残留 R0/MVP/Phase 编号。
- 清理 AC 中 `Claim accepted`、强制 Question/Skill 和 AC-13 全回滚旧语义。
- 清理所有 live entity 的 `deleted` payload 状态，删除统一用独立 tombstone。

## 修订完成条件

- Consent/Retention/Data Classification/PortRequestContext/DeletionJournal 成为可执行 schema；
- privacyEpoch、cursor 和 delete journal 有竞态/启动恢复测试；
- delete lineage 不能 restore；tombstone 不含 payload-derived digest；
- PRIVATE 仍允许 read/delete/recovery；
- redaction 后二次 schema 校验；
- EVAL/AC 与事务前后语义一致；
- 真实 Chromium 与 fake IndexedDB 测试职责分开。

## 修订完成记录

- 六件套已同步 ConsentGrant/RetentionPolicy、四级分类、fact/provenance hash、PortRequestContext、meta cursor/privacyEpoch、DeletionJournal、RECOVERY_ONLY/CLEAR_ONLY、无 hash tombstone、delete/restore 分离、ExportReceipt 和 Shadow 调用图边界。
- SPEC 的 AC 已拆为事务内 abort、commit 后 journal 恢复和 deleted restore negative；EVAL 已增加 Canary Sink Matrix、HistoricalRestoreFidelity、真实 Chromium并发/crash/quota 协议。
- ARCH 已冻结 production self-only CSP、反向索引、batch commit、BroadcastChannel 仅通知不作正确性来源，以及 fake/real IndexedDB 测试职责。
- PRD/PLAN/CHECKPOINT 已统一 M1–M5、0..N abstention、local-first 风险和用户安全文案。
- 结构/术语/canonical scan 已通过，输出：`Round-2 canonical conflict scan passed`；六份 Markdown UTF-8 可读、代码围栏成对。
- Round 2 结束。下一轮只能是 README 规定的 Round 3，不追加同主题 review。
