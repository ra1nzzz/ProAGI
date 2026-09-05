# REVIEW Round 3 — 架构、性能与韧性

**范围**：Round 2 修订后的六件套  
**方法**：YT-Review 三维并行只读审查 + 主代理架构/竞态盲区扫描

## 三维趋势评分

- 架构质量与可验证性：**6.3/10**（Round 2 A 6.8）
- 性能、并发与可实施性：**7.4/10**（Round 2 B 6.8）
- 复用性与跨文档一致性：**7.4/10**（Round 2 C 7.1）

评分仅用于比较，8/10 不是硬门禁。P0=0；裁决 `CONDITIONAL`。A 下降说明 Round 2 新增名词尚未全部形成闭合 DTO，不否定其安全方向。

## Round 2 复核

Consent/Retention、privacyEpoch、DeletionJournal、随机删除 marker、Shadow/export 边界、反向索引、fake/real IndexedDB 分层和 M1–M5 命名方向正确。剩余风险已从隐私原则转移到接口可实现性、不可变性、删除窗口和大数据协议。

## 合并 Findings

| ID | Priority | 问题 | 影响 | 采纳修复 |
|---|---|---|---|---|
| R3-01 | P1 | DomainSnapshot/CanonicalMutation/DeletionPlan/Reachability/Export DTO 未定义 | Implementation Ready 仍需实现者自行发明 | 在 SPEC 建完整 tagged DTO registry 与穷尽检查 |
| R3-02 | P1 | Core 文字绑定 IndexedDB request，Port 不平台中立 | memory/SQLite 必须模拟 IDB | Port 只定义原子业务语义；IDB enqueue 规则移至 adapter |
| R3-03 | P1 | preview→import 回传 BehaviorEvent[] 可篡改 | 可绕过 redaction/consent/epoch | inbound ObservationPort 返回只读 DTO + opaque PreviewToken；commit token 时重验 |
| R3-04 | P1 | Port error 的 throw/Result/partial 语义不同 | contract/retry/fail-closed 不可复用 | 统一 DomainResult/BatchResult；transport exception 在 adapter boundary 归一化 |
| R3-05 | P1 | 图中 Store 触发 Projection，CorrectionPort 方向不明 | 依赖倒置和唯一写口失效 | 明确 inbound Observation/Correction use-case ports、outbound Knowledge/Projection/Action/Runtime；App 编排，Store 不回调 |
| R3-06 | P1 | Capability 缺 runtime/privacy/clear/audit，Context 无 resource scope | M3 改核心类型且 deletion confused-deputy | 建 versioned capability registry、ResourceScope 和 operation→capability matrix，应用入口与 commit 双检 |
| R3-07 | P1 | Business/System record 未分；RetentionPolicy wrapper 自举 | policy 自己需要 policy | 分 BusinessEntityType/SystemRecordType 和生命周期；补 store_meta/retention/export/ledger 等类型 |
| R3-08 | P1 | ConsentGrant 不可变但 revokedAt 后写 | 审计方式分叉 | 增加不可变 ConsentRevocation；Grant 本身不修改 |
| R3-09 | P1 | Correction pending→terminal 与“永不修改”冲突 | hash/provenance 失效 | 拆 CorrectionCommand（瞬时）与终态 CorrectionRecord；pending 不持久化 |
| R3-10 | P1 | KnowledgeVersion current→superseded、workflow 状态更新无 revision/CAS | EvidenceRef hash 变旧、并发覆盖 | KnowledgeVersion 不含 status，独立 KnowledgeHead CAS；Question/Skill/Action 使用 append-only WorkflowRevision + head |
| R3-11 | P1 | PRIVATE 只有 epoch，无持久 observationMode | 刷新后可能恢复摄入 | StoreMeta 增 `observationMode=ACTIVE|PRIVATE`，与 recovery mode 正交并定义 Orb 映射 |
| R3-12 | P1 | VersionPins 单 adapter/policy 且 fixture 必填 | M2/M3 无法表达真实多 adapter 输入 | 结构化 adapters/policies/algorithms pins；InputIdentity 单独 tagged fixture/import/readonly |
| R3-13 | P1 | Replay 签名、ReplayKey 和 canonical 字段排除不一致 | 相同 key 可对应不同输入 | SPEC 定义唯一 ReplayInputV1/ReplayKeyV1/CanonicalDomainSnapshotV1；ARCH 只引用 |
| R3-14 | P1 | ARCH EventEnvelope 形成第二套 schema/revision | 非 Event Sourcing 系统双重真相 | 删除 EventEnvelope；migration 直接作用 StoredRecord，规范回收 SPEC |
| R3-15 | P1 | ErrorCode 缺 determinism/capability/protocol/timeout 等 | adapter 发明私有错误 | 扩展稳定错误及 ErrorPolicy registry |
| R3-16 | P1 | Runtime submit unknown 且 cancel requestId 无来源 | M3 timeout/cancel/审计不可实现 | 定义 RuntimeRequest/Handle/Result、deadline/correlation/idempotency；M1 禁用 |
| R3-17 | P1 | factHash unique 会吞掉第二来源 provenance | 跨 adapter 等价以丢来源为代价 | 增 source-stable dedupeKey unique；factHash non-unique；Replay 合并语义、保留观察 provenance |
| R3-18 | P1 | 随机 tombstone仍保留内容 UUIDv5 id；又永久禁止显式重导 | 泄露与抑制不可兼得 | verified 后 tombstone只留随机 ID/type/time；明确新显式 import/consent 可建全新 lineage，但绝不能复活旧 lineage |
| R3-19 | P1 | EvidenceLossPolicy 0 support 仍 append 含旧 statement 的 invalidated | 删除 payload仍可达 | 物理删所有引用旧 evidence 的 revision；仅剩余证据独立满足且 canary-clean 时创建无 parent rederived proposed root，否则删 lineage |
| R3-20 | P1 | 源删除后保留旧 EvaluationResult 的 hash/evidence | 违反 INV-009 与不可达 | privacy 优先：tombstone旧结果；另建无 hash/evidence EvaluationInvalidationReceipt，不留 live deleted EntityRef |
| R3-21 | P1 | AtomicMutationBatch 无 union/store scope/batchHash/ledger | IDB 不能预开 stores，响应丢失会重复写 | 定义平台中立 mutation union、storeNames、batchHash 和原子 CommitLedger |
| R3-22 | P1 | delete commit→audit 仍 NORMAL | 新标签可在审计窗口写引用 | 初始 delete transaction 原子切 RECOVERY_ONLY；audit verified 后另一个事务恢复 NORMAL |
| R3-23 | P1 | 50k/high-fanout 与单短事务冲突 | 原子、短事务、规模不可同时满足 | 采用 journal 驱动分块删除；全过程 RECOVERY_ONLY，持久 work item/progress cursor，chunk 幂等 |
| R3-24 | P1 | journal 原子状态点与 crash resume 未定义 | 跳过/重复 chunk | 冻结状态转换表；attempt/progress 与 chunk 原子；verified 与 NORMAL 原子 |
| R3-25 | P1 | 单标签 audit 看不到其他 tab DOM/heap | 清除成功声明过早 | 注册活动 client + PURGE/PURGED barrier；未 ACK 保持 pending，超时提示关闭其他标签 |
| R3-26 | P1 | clear-all blocked 无超时/终态 | 无限等待或误报成功 | 5 秒后 ERR_STORAGE_BLOCKED/CLEAR_ONLY；仅 deleteDatabase success + cache clear + empty reopen 后成功 |
| R3-27 | P1 | 50k “流式 JSON”无格式、背压、取消语义 | 仍全量 parse/复制，内存峰值不可控 | 冻结 NDJSON V1 与 Worker INIT/CHUNK/ACK/CANCEL/COMPLETE、有界队列和部分提交规则 |
| R3-28 | P1 | loadSnapshot/Projection 全量化但要求增量 250ms | 50k 内存峰值和旧投影覆盖 | 增 scanEntities/loadChangesSince；CommitResult 返回 affected refs；projection cache sourceCursor CAS |
| R3-29 | P1 | quota 无 recovery headroom | 最需删除时 journal 也写不下 | 预留 5MB recovery reserve；失败进入 CLEAR_ONLY，允许净减小删除/deleteDatabase |
| R3-30 | P1 | M3 同时扩 Runtime 与 Projection，M5 无存储迁移协议 | 风险不可归因、历史可能复活 | M3 拆 3a/3b 独立 gate；定义 StorageMigrationV1、禁止长期双写、hash/reachability 对比和回滚 |
| R3-31 | P2 | cursor decimal string 可字典序误比 | 9→10 后旧投影覆盖 | regex + BigInt compare/increment，测边界 |
| R3-32 | P2 | Chromium crash window 无确定 failpoint | 测试 flaky | test-only failpoint，production bundle 静态排除 |
| R3-33 | P2 | 性能矩阵全部进入 verify 过重 | 开发者跳过/runner误报 | PR gate 与 nightly/release tier 分开，Evidence Pack 标 tier |
| R3-34 | P2 | CI 工具链/供应链/build identity 漂移 | 无法重现且当前无 Git | 固定 Node 主基线、Playwright revision；加 audit:deps/CSP；允许 source-tree/artifact hash |
| R3-35 | P2 | SyntheticEventAdapter、Telemetry Port 等旧名/非正式 Port | DI 与安全边界分叉 | 统一 JsonFixtureObservationAdapter；诊断为内部 allowlisted sink，不称第七 Port |
| R3-36 | P2 | ExportEnvelope/Receipt 仍只有文字定义 | Adapter 自行决定 hash/receipt | 补字段级 DTO 与 canonical hash规则 |

## 六类盲区

- **幂等**：CommitLedger、batchHash、chunk progress、response-loss replay。
- **安全**：operation-capability confused deputy、PRIVATE 持久状态、UUIDv5 tombstone 泄露、跨标签 purge。
- **可观察性**：统一 ErrorPolicy/Audit，不引入未定义 Telemetry Port；Evidence Pack 标测试 tier/build hash。
- **数据完整性**：Correction/workflow revision、Replay request hash、EvidenceLossPolicy、Evaluation 删除优先级。
- **并发/竞态**：delete 全程 recovery fence、projection cursor CAS、clear blocked、BigInt cursor。
- **外部依赖韧性**：Runtime handle/timeout/cancel、固定 Chromium、M3a/M3b 隔离、M5 storage migration。

## 本轮关键取舍

1. 大删除采用 **RECOVERY_ONLY 下 journal 驱动分块**，不再同时承诺任意规模单事务。
2. privacy delete 优先于历史审计：被删来源关联的 live hash/evidence/result 必须消失；只留随机、无 payload receipt。
3. 用户未来显式重新导入可建立全新 lineage；禁止的是从 tombstone/cache/旧导出自动恢复旧 lineage，而非永久保存内容指纹做全局封禁。
4. Port 核心保持平台中立；IndexedDB 生命周期与 request enqueue 仅属 adapter 规范。
5. 外部 roadmap 仍是 M1–M5，但 M3 内拆 3a/3b 两个可独立 STOP 的 gate。

## 修订完成条件

- SPEC 中所有被引用 DTO/Error/Result/Replay/Migration 类型都有定义；
- preview token 关闭 TOCTOU；唯一 Knowledge writer 和端口方向明确；
- immutable revision/head 策略无原地状态冲突；
- delete audit 窗口全程 recovery-fenced，分块和 crash resume 可测试；
- NDJSON/Worker/change feed/projection CAS/clear blocked/quota reserve 可执行；
- VersionPins/InputIdentity 能表达 M1–M3；
- 六件套 canonical conflict scan 通过。

## 修订完成记录

- SPEC 已补齐 144 个无重复 exported declarations，包括 Result/ErrorPolicy、opaque preview、mutation/ledger、immutable heads、ReplayInputV1、migration、journal chunks、NDJSON Worker 与 export DTO。
- ARCH 已移除 EventEnvelope/Telemetry 假边界并修正依赖方向；PRD/PLAN/CHECKPOINT/EVAL 已同步删除、Replay、M3a/M3b、M5 migration 与性能分层。
- canonical scan：六文档 UTF-8/围栏、关键类型和旧语义禁项均通过；SPEC declaration duplicate=0。
- Round 3 修订完成，下一轮只进入 Round 4 UI/无障碍/EVAL 审查。
