# ProAGI Insight Loop 评价与验证规范

**产品**：ProAGI Assistant  
**版本**：1.0.0  
**适用范围**：M1 TypeScript/Web 垂直切片  
**评价对象**：事件导入、Episode、Insight、纠正、知识版本、Replay、Orb、隐私与本地导出

---

## 1. 评价原则

1. `[INV]` 是架构/隐私不变量，任一失败均阻止 M1 交付。
2. `[PH]` 是待 pilot 验证的产品假设；阈值不是文献共识，也不能由 synthetic fixture 宣称达成。
3. `[STAT]` 是统计建议，用于控制区间与抽样质量，不是绝对真实世界保证。
4. Evaluator 必须断言最终领域状态，不能以按钮点击、toast、目标文字或模型自评判成功。
5. Synthetic fixture 只验证契约、状态机和可复现性；真实用户价值必须由后续真实只读 pilot 验证。
6. Acceptance rate 只能描述交互，不得替代正确性、纠正吸收或净价值。
7. 所有结果必须记录完整结构化 `VersionPins`（schema + adapters[] + policies[] + algorithms[]）、独立 `InputIdentity`、ReplayInput/输出哈希和运行环境；不得复制旧式单 adapter/policy/fixture 字段表。

---

## 2. 发布门禁摘要

| ID | 类型 | 门禁 | M1 要求 |
|---|---|---|---|
| G-01 | `[INV]` | Schema/Data Policy | 未允许字段持久化为 0；classification/sink、Consent、Retention 与 privacyEpoch 均按 SPEC fail closed |
| G-02 | `[INV]` | Provenance | 完整率 100%，无断链/环/跨 scope |
| G-03 | `[INV]` | Replay | 同 pins 重放 canonical hash 100% 一致 |
| G-04 | `[INV]` | Correction | 目标 scope 必须吸收 edit |
| G-05 | `[INV]` | Reject/Delete | 不静默重提；删除 payload 不可达且 deleted lineage 不可 restore |
| G-06 | `[INV]` | Shadow | 从 `ActionPort.submitShadow`、`ShadowActionSink`、`ShadowPreviewDTO` renderer/handlers 三类 root 到 `ForbiddenBrowserEffectSinkRegistryV1` 任一 sink 的调用为 0；不得调用 Runtime/export |
| G-07 | `[INV]` | Screenshot | Raw screenshot at rest = 0 bytes |
| G-08 | `[INV]` | Evaluator | 所有关键负例必须判失败；源删除物理移除相关 result payload，只留不可关联随机 EvaluationInvalidationReceipt |
| G-09 | `[PH]` | 用户理解 | 典型纠正 30 秒内完成 |
| G-10 | `[PH]` | 产品价值 | 真实 pilot 净价值中位数 > 0 |

M1 只执行 G-01～G-08 的硬门禁。G-09～G-10 必须保留为待验证状态。

---

## 3. 数据集与 Fixture 组织

### 3.1 M1 最小提交集

第一开发切片至少提供 24 个领域集成 fixture：

- 8 个核心闭环：accept、edit、reject、delete 各 2 个；
- 6 个事件扰动：duplicate、reorder、drop、clock skew、未知字段、schema drift；
- 6 个隐私/对抗：token、email、高熵 secret、Unicode/Bidi、跨 scope、删除后复活；
- 4 个 evaluator 欺骗：仅有成功文字、旧状态残留、错误 provenance、正确输出来自前一 fixture。

M1c 另建 `M1UiCaseManifestV1`，不得把 UI/a11y/visual cases 延后到 M2，也不得用领域 fixture 数量冒充界面矩阵：

```ts
interface M1UiCaseManifestV1 {
  caseVersion: "1";
  caseId: string;
  fixtureManifestHash: Hash;
  projectionStateHash: Hash;
  visualEvidenceCaseIds: readonly string[];
  accessibilityAssertionIds: readonly string[];
  interactionAssertionIds: readonly string[];
  required: boolean;
  manifestHash: Hash;
}
```

required cases 至少覆盖六态、Inbox 空/有候选、Replay before/after、合法 abstain、projection stale、PRIVATE、ERROR+RECOVERY_ONLY、CLEAR_ONLY+blocked、RecoverySurface、MoveOrb、correction form、320/360/768/1280 reflow、200% zoom、text-spacing、forced-colors 与 reduced-motion。

### 3.2 M2 目标集

M2 扩展为 192 个集成 fixture：

1. 核心 96：12 个规则族 × 8 条轨迹；每族含重复学习、accept、edit、reject、delete、冲突 scope、held-out 正例、近邻负例。
2. 事件/Adapter 扰动 48：drop、duplicate、reorder、clock skew、字段变化、版本迁移、locale/timezone、并发事件、进程重启。
3. 隐私/对抗 24：canary、路径/Unicode/Bidi、恶意文本、跨用户 scope、cache/export/replay 删除检查。
4. GUI 配对 24：六态、键盘、reduced-motion、缩放、焦点、错误恢复；按需截图能力只有进入后续明确实验时才加入。

另建至少 1,000 个 score-only 样本用于 calibration；192 个集成样本不足以稳定判断 ECE。

### 3.3 Fixture、Gold 与 Evaluator 独立 artifact

输入、真值与判定程序 MUST 拆成三个分别审阅、分别哈希的 artifact，禁止把 expected output 混回输入 manifest：

```ts
interface ArtifactOwnerV1 {
  ownerId: string;
  role: "fixture-author" | "gold-reviewer" | "evaluator-owner";
  approvalId: string;
}
interface FixtureInputManifestV1 {
  artifactVersion: "1";
  fixtureId: string;
  owner: ArtifactOwnerV1;
  inputIdentity: Extract<InputIdentity, { kind: "fixture" }>;
  inputArtifactHash: Hash;
  manifestHash: Hash;
  asOf: string;
  timezone: string;
  locale: string;
  clockSeed: Hash;
  pins: VersionPins;
  comparatorProfileId: "comparator-v1";
  canonicalProfileId: "canonical-json-v1";
  consentScenario?: "active" | "revoked" | "missing";
  retentionScenario?: "active" | "expired" | "clock-unavailable";
  privacyEpochScenario?: "stable" | "switch-during-parse" | "switch-after-preview-confirm" | "switch-during-transaction" | "cross-tab-clear";
  canarySinkMatrixId?: string;
  tags: readonly string[];
}
interface GoldOracleV1 {
  artifactVersion: "1";
  oracleId: string;
  owner: ArtifactOwnerV1;
  fixtureManifestHash: Hash;
  assertions: readonly OracleAssertionV1[];
  eligibleSemanticKeys: readonly string[];
  eligibleContextIds: readonly string[];
  expectedAbstentions: readonly string[];
  prohibitedEffects: readonly string[];
  expectedStateHash: Hash;
  oracleHash: Hash;
}
interface EvaluatorManifestV1 {
  artifactVersion: "1";
  evaluatorId: string;
  evaluatorVersion: string;
  owner: ArtifactOwnerV1;
  supportedOracleVersion: "1";
  implementationArtifactHash: Hash;
  dependencyManifestHash: Hash;
  mutationCorpusHash: Hash;
  manifestHash: Hash;
}
```

三者的 `ownerId` MUST 不同；紧急情况下同一组织可以持有多个角色，但同一人/自动生成任务不得同时批准 fixture 与 gold。Gold MUST 在运行被测实现前冻结，不得从被测输出、snapshot 或 UI 文案生成。Evaluator 只能读取公开 domain DTO、独立只读查询接口和 Gold，不得 import 生产 inference、projection builder、head planner 或其测试 helper；共享 schema 只能用于解析，预期 hash 必须由独立 reference comparator 或批准的 golden bytes 得出。CI MUST 对依赖图和 artifact hash 做静态检查。

每个 `[INV]`/关键 AC MUST 至少有一个 tagged mutation corpus 样本，且标签为封闭 union：`missing-field | extra-field | wrong-tag | wrong-hash | stale-head | stale-cursor | orphan-ref | cycle | forbidden-effect | canary-leak | false-success | reorder | random-id-dependence | skipped-assertion`。每个 mutation 声明唯一 `mutationId`、target artifact/hash、expected failing assertion IDs 与不得变化的 control assertion IDs；Evaluator 必须证明目标断言失败且 control 不被误伤。mutation corpus 与 evaluator 分别版本化；只证明“当前 mutation 被抓住”，不替代新增风险的负例。

Artifact MUST 按 `TestArtifactSinkRegistryV1` 穷尽登记 `json-report | junit | console | screenshot | visual-diff | video | HAR | trace | source-map | reporter-attachment | CI-upload | NVDA-transcript`；每项记录 artifact hash、classification、canary scan、owner、tier、retention policy 与销毁 receipt。保留期固定为：PR 14 天、nightly 90 天、release Evidence Pack 长期保留并按项目归档策略显式销毁。任何 canary 命中先进入隔离区，禁止公开上传、链接或普通下载；只保留无 payload incident/销毁 receipt。失败 artifact 不得因失败被静默删除，但必须先完成 redaction/canary quarantine。

Fixture reset MUST 清空前一个用例的 IndexedDB、Cache Storage、内存/Worker/search/projection cache、import staging、索引、定时器、BroadcastChannel 测试连接、announcement queue 与 UI 状态，并重建已知初始 `StoreMeta.cursor/privacyEpoch/recoveryMode/observationMode`。涉及删除的 fixture MUST 在输入 artifact 声明 journal 初态，预期终态只写入 Gold；涉及 consent/retention/PRIVATE 的 fixture MUST 声明 scenario。禁止测试代码从被测输出反推期望。

---

## 4. Episode 与用户价值指标

### 4.1 Episode-F1 `[PH]`

`Precision = correct_predicted_boundaries / predicted_boundaries`  
`Recall = correct_predicted_boundaries / gold_boundaries`  
`Episode-F1 = 2 × Precision × Recall / (Precision + Recall)`

- clean fixture 目标 ≥ 0.95；
- 扰动集目标 ≥ 0.85；
- boundary match 使用同一事件索引或时间差 ≤1 秒的预注册容差；
- gold 与 prediction 均无内部边界时记 1.00；只有一方无边界时记 0；并分报 over-/under-segmentation。

这些阈值是产品假设，不是外部标准。

### 4.2 Shadow Exact Agreement `[PH]`

`SEA = exact_match(shadow_suggestion, user_final_intent) / eligible_episodes`

必须按规则族、scope 和数据来源分层报告；不能用“建议被打开”替代。

### 4.3 Normalized Edit Cost `[PH]`

`NEC = Σ edit_distance(suggestion, final_target) / Σ max_length`

目标 ≤ 0.15。若用户放弃或删除候选，必须单独计入，不能从分母移除。

### 4.4 Value Gain `[PH]`

`ValueGain = median(manual_steps − review_edit_steps)`

M2 pilot 目标 > 0；建议观察目标为中位数至少节省 3 步。需同时报告实际时间和错误恢复成本。

`NetValue = saved_time − review_time − correction_time − recovery_time`

M1 不报告 NetValue 已达成。

---

## 5. 可纠正知识指标

### 5.1 Correction Absorption Rate

`CCR = structurally_correct_predictions_after_edit / preregistered_eligible_contexts`

分母只能来自独立 `GoldOracleV1.eligibleContextIds`，不得由输入 fixture 或被测预测决定；空分母记 `N/A` 且不能 PASS。
- 相同 scope 下一次 Replay：`1.00 [INV]`；
- 相邻 context 泛化：`≥ 0.80 [PH]`。

### 5.2 Reject Recurrence

`RejectRecurrence = resurfaced_same_semantic_key / preregistered_eligible_opportunities`

M1 的“同语义”仅指 SPEC 定义的结构化 `semanticKey`，不使用文本相似度。分母来自 manifest 的 `eligibleSemanticKeys`；空分母记 `N/A` 且不能 PASS。同 key 必须为 `0 [INV]`；若 key/scope/证据实质变化，系统必须展示 diff，不得静默重提。

### 5.3 Delete Resurrection 与 Deleted Restore Negative

`DeleteResurrection = deleted_payload_reachable_or_suggested / deletion_checks`

必须为 `0 [INV]`。verified DeletionTombstone 只允许随机 `id`、粗粒度 `deletedType`、`deletedAt`，不得包含原 entity/content ID、statement、evidence、semanticKey、digest、secret 或 detector ID。

`DeletedRestoreAcceptance = successful_restore_or_reimport_resurrection / deleted_lineage_attempts` 必须为 `0 [INV]`。对 deleted lineage 的 restore 必须返回 `ERR_DELETED_RESTORE_FORBIDDEN`；不得从 tombstone、缓存、旧导出或重新导入相同事实静默复活原 lineage。

### 5.4 Historical Restore Fidelity

`HistoricalRestoreFidelity = exact_hash(restored_version, selected_live_historical_version)`

必须为 `1.00 [INV]`，且只适用于仍为 live 的 superseded/invalidated revision。privacy delete 是不可恢复终态，不属于 restore 分母。

### 5.5 Correction Locality

`CorrectionLocality = unaffected_scope_hashes_unchanged / unrelated_scope_checks`

目标 `1.00 [INV]`；`≥0.99 [PH]` 只用于未来有概率模型的真实 pilot，确定性 M1 不允许无关 scope 改变。

### 5.6 Claim Semantic Validity

`ClaimSemanticValidity = gold_valid_claims / preregistered_claim_opportunities`

每个 rule family MUST 由独立 gold 标注 predicateId、semanticKey、scope 与 supporting evidence。M1 目标 `1.00 [INV]`；常量 claim、错误 scope、正确 evidence ID 但 evidence 不支持 statement、仅回显用户文本等负控 MUST 失败。eligibility 为 false 时正确结果是 abstain/0 个 claim，不得计为漏报。

### 5.7 Evaluation Invalidation `[INV]`

源实体、pin 或 provenance 被删除/撤销后，相关既有 EvaluationResult payload MUST 物理移除，不得原地改 status 或仅在 UI 隐藏；系统只追加随机 `EvaluationInvalidationReceipt`，其四个字段不得包含 result/run/entity ID、input/output/content hash 或 evidence。以下均失败：旧 result 仍 live、receipt 可反查旧 payload、deleted EntityRef 仍可达。

`EvaluationInvalidationValidity = (payloads_removed_and_receipts_minimal) / required_invalidations = 1.00`。

---

## 6. Calibration、Abstention 与置信度

设预测正确性 `y∈{0,1}`，系统置信度 `p∈[0,1]`：

### 6.1 Brier Score `[PH]`

`Brier = mean((p-y)^2)`；目标 ≤ 0.15。

### 6.2 Expected Calibration Error `[PH]`

`ECE = Σ_b (|B_b|/n) × |accuracy(B_b) − confidence(B_b)|`

固定 10 bins，并报告 bootstrap 95% CI；目标 ECE ≤ 0.05。样本不足时不得展示虚假精确的百分比。

### 6.3 Selective Risk `[PH]`

`SelectiveRisk(τ) = errors_at_confidence≥τ / suggestions_at_confidence≥τ`

发布真实 pilot 时应存在阈值 τ，使 risk ≤ 0.05 且 coverage ≥ 0.50。

### 6.4 OOD Abstention `[PH]`

- OOD abstention recall ≥ 0.95；
- clean in-domain 误 abstain ≤ 0.10。

冲突或低置信上下文必须 abstain 或提问，不能随机猜测。

---

## 7. Provenance 与 Lineage

### 7.1 Provenance Completeness `[INV]`

`ProvenanceCompleteness = present_required_fields / required_fields = 1.00`

Evaluator MUST 按 SPEC schema 使用以下 required-field registry，不得强迫无该语义的对象伪造字段：

| 实体 | 必填 provenance / 完整性字段 |
|---|---|
| BehaviorEvent | discriminated SourceRef、PrivacyDecision、dedupeKey、factHash、provenanceHash、contentHash；readonly source 可解析到 active ConsentGrant/RetentionPolicy |
| Episode / WorkModelClaim | immutable evidence/hash；Claim 含 claimKey/semanticKey/predicate、parent revision、scope/confidence/status |
| DailyReportSnapshot | sourceCursor、episode/claim/question/skill IDs、projectionVersion/generatedAt/contentHash；仅可重建缓存 |
| Question / SkillCandidate / ActionIntent | workflowKey、parentRevisionId、revision、ProvenanceEnvelope 与 status；head CAS；Action mode=shadow 且四项 forbiddenEffects |
| EvaluationResult | terminal status、InputIdentity、VersionPins、input/outputHash、startedAt/completedAt 与领域 assertions；running 仅内存 |
| EvaluationInvalidationReceipt | 仅随机 id、固定 marker、invalidatedAt、固定 reason；无 result/entity ID、hash 或 evidence |
| CorrectionRecord | 创建即 terminal；targetClaimKey、baseRevisionId、action、结果引用、completedAt/contentHash；CorrectionCommand 不持久化 |
| KnowledgeVersion / KnowledgeHead | immutable version + basedOn/claim/correction；独立 head 只以 CAS 指向版本 |
| ConsentGrant / ConsentRevocation | Grant 不变；撤权是独立 immutable record；preview 与 commit 均验证 active grant+无 revocation |
| active deletion controls / verified tombstone | active records 可暂含恢复 key且仅 RECOVERY_ONLY 可读，verified 后物理移除；marker 仅随机 ID/type/time |

只对实际产出的对象计算；正确 abstain/0 输出不降低完整率。不适用性只记录在 EvaluationResult 的 assertion/report 中，不得把 `N/A` 写入 `additionalProperties:false` 的领域实体。

### 7.2 Lineage Validity `[INV]`

`LineageValidity = resolvable_acyclic_outputs / all_outputs = 1.00`

必须拒绝：断 parent、环、跨 fixture/user/scope 引用、entity hash 不匹配、修改 Correction 而未更新 hash。

### 7.3 错误发现能力 `[PH]`

在 pilot 中植入错误 evidence 和过度泛化 claim，测量用户发现率。不能只测“解释看起来清楚”或主观信任。

---

## 8. Replay Determinism

### 8.1 Deterministic Hash Rate `[INV]`

`DHR = identical_output_hash_runs / all_replays = 1.00`

每个关键 fixture 至少冷启动重放 10 次；M1 release/nightly 目标 100 次。

### 8.2 Cross-Adapter Equivalence `[INV]`

`CAE = semantically_equal(new_adapter(old_fixture), golden) / fixtures = 1.00`

Breaking change 必须升级 major schema、提供显式迁移或 fail closed，不得静默默认。

### 8.3 Replay Flake `[INV]`

`ReplayFlake = fixtures_with_multiple_outputs / all_fixtures = 0`

失败注入必须覆盖随机 UUID、当前时钟、locale、无序 Map、异步竞态和外部返回变化。Canonical snapshot 必须排除 run-only 字段或使用由输入派生的确定性 ID。

### 8.4 ReplayInputV1 Metamorphic Contract `[INV]`

Evaluator MUST 直接构造完整 `ReplayInputV1`，不得通过 UI 或被测 builder 反推输入。以一份批准基线为中心执行以下 table-driven mutation：

1. **逐字段敏感性**：分别改变 `inputIdentity` 的每个 tagged variant/字段、`inputSetHash`、任一 event 的 content/fact/dedupe hash、occurredAt/kind、knowledge head/version/claim/basedOn hash、Correction record/base/action、asOf、timezone、locale、clockSeed、VersionPins 任一 component、comparator/canonical profile。每次语义变化 MUST 同时改变 `replayInputHash` 与 `keyHash`；适用时改变 snapshotHash。
2. **排除字段不变性**：只改变原始 `recordId/runId/commandId/ingestedAt/generatedAt/updatedAt/completedAt`、cursor、privacyEpoch 或 object insertion order，再重建同一 ReplayInputV1，ReplayKey、semantic IDs 与 snapshotHash MUST 字节级不变。
3. **合法重排不变性**：对输入 object key、允许按 comparator 归一的 set/array 顺序和不同来源的等价 observation 做全排列/属性测试；不得丢失 dedupe provenance，结果 MUST 与基线相同。
4. **结构负例**：缺 pin/不支持 profile、悬空 Knowledge/Workflow head、版本不连续、basedOn/parent 断链或成环、重复 dedupeKey 异内容、hash 不匹配、migration 路径缺失/歧义 MUST fail closed，并产生 Gold 指定的稳定 ErrorCode，零 EvaluationResult `passed`。
5. **随机 ingress ID 独立性**：保持 `occurredAt/kind/factHash/dedupeKey/contentHash` 不变，仅为所有输入替换/置乱 UUIDv7 record/event/head/version/command IDs，Episode 顺序、ReplayInput、semantic IDs 与 snapshotHash MUST 不变。改变 comparator 五元组任一字段必须按 `(occurredAt,kind,factHash,dedupeKey,contentHash)` 得到确定新顺序；随机 ID 不得作为 tie-breaker。

每个字段 mutation 必须在 Gold 中有独立 assertion ID；遗漏字段、未执行 mutation、空 mutation 集或只比较“运行完成”均不能通过 G-03。

### 8.5 PreviewToken Contract `[INV]`

Preview suite以canonical snapshot/cursor/ledger/change/staging/guard/UI queue为oracle。逐字段断言SPEC guard的tokenHash、binding.inputIdentity/inputHash/bufferHandleHash/policyPinsHash/consentId/privacyEpoch/callerId、state/idempotencyKey/receiptId/expiresAt；raw bytes只在受限短期buffer，缺失fail closed：

| 变异/攻击 | 预期结果 |
|---|---|
| 随机字符串、截断、位翻转、跨安装/跨 fixture token | 固定 fail-closed error；零写 |
| 同一 token 同标签二次提交、两个标签同时提交、transaction 交错 | guard CAS、业务 mutations、CommitLedger、change feed 与 commit receipt 必须在同一 transaction；全局恰一次成功，其余 `ERR_PREVIEW_CONSUMED` 或回读同一 ledger/receipt |
| commit 成功但 response 丢失、标签 reload 后以同 idempotencyKey/token 重试 | 先读 guard+ledger；返回原 receipt，不创建新 command/batch/mutation |
| guard CAS 后任一 mutation/ledger/receipt 注入失败 | 整个 transaction abort，guard 仍可用或按冻结错误安全失效；不得只消费 token |
| `expiresAt-1ms / expiresAt / expiresAt+1ms` 注入时钟 | 边界按冻结策略；到期为 `ERR_PREVIEW_EXPIRED`；零写 |
| source bytes/InputIdentity/inputHash变化 | `ERR_PREVIEW_STALE`；零写 |
| 短期 source buffer 缺失/释放 | `ERR_PREVIEW_BUFFER_MISSING`；零写且不得从PreviewDTO重建 |
| 任一 schema/adapter/policy/algorithm pin 变化 | `ERR_PREVIEW_STALE` 或 `ERR_PIN_UNSUPPORTED`；零写 |
| consent 缺失/撤回、purpose/allowedFields/retention 变化 | 对应 consent/retention error；零写 |
| privacyEpoch、observationMode、recoveryMode 在 preview 后或 transaction 内变化 | stale/private/recovery error；guard 与普通写同事务复核，零普通写 |

真实 Chromium MUST 覆盖双标签 guard 竞争、versionchange/blocked、commit-before-response crash 和 reload ledger recovery；fake adapter 只证明 contract。PreviewDTO MUST 只暴露 readonly item decision 与 opaque token，不得含客户端可提交的 BehaviorEvent、内部 allowlisted payload、token binding、secret 或 detector detail。所有失败后 token buffer、Worker/staging 引用和 announcement queue 必须释放；错误 DOM 与 accessibility tree 不得回显受限输入。

### 8.6 Immutable Head CAS Contract `[INV]`

同一套 contract MUST 参数化运行于 `KnowledgeHead` 及 Question、SkillCandidate、ActionIntent 的 `WorkflowHead`：

- 新 immutable revision/version、terminal CorrectionRecord（适用时）与 head CAS MUST 在同一 `AtomicMutationBatch`；commit 后旧 StoredRecord canonical bytes/contentHash 保持不变。
- stale/missing/wrong `expectedContentHash`、错 `workflowType/workflowKey/knowledgeKey`、错 parent、revision/version 跳号、跨 scope 引用必须返回冲突/验证错误并整批零写。
- 两个并发 caller 从同一 base 更新时必须恰有一个成功；失败方不得静默 rebase、last-write-wins 或产生孤儿 live revision。
- 相同 idempotencyKey+batchHash 和 commit-response loss 必须返回同一 ledger/head；同 key 异 hash 必须 `ERR_IDEMPOTENCY_CONFLICT`。
- evaluator 只接受封闭 tagged mutation：`insertImmutable`、`casSingleton`、`deleteIfHash`、`casProjectionHead`；每个 tag 拒绝未知/多余字段并有 success/stale/hash-mismatch/abort 负例。generic `put`、对 immutable record 的 expected-hash 覆盖、对 head 无 CAS 写、原地改 status/answer/statement/evidence、head 指向非集合成员或 deleted revision必须被 schema、adapter 与 evaluator同时拒绝。
- memory/fake-indexeddb/真实 Chromium adapter 对上述领域结果必须一致；浏览器 suite 额外覆盖双标签 interleaving、reload 与 transaction abort。

---

## 9. Privacy、Consent、Retention 与边界

### 9.1 数据最小化门禁 `[INV]`

- `UnallowlistedPersistence = 0`。
- `RawScreenshotAtRest = 0 bytes`。
- `restricted` 只允许瞬时 preview/redaction；`prohibited` 必须拒绝；两者原值进入 canonical store/log/cache/export 的次数为 0。
- `projectKey/branchHash` 只能是用户别名或 install-keyed HMAC，不得是裸 SHA-256、路径、组织名或仓库 URL。
- optional secret/restricted 字段删除后必须执行二次完整 schema 验证；required/identity 字段命中必须拒绝整个 item。
- “收集后加密”不能替代数据最小化。报告必须明确 local-first 不等于应用级静态加密，也不能证明可抵抗同机用户、恶意扩展、浏览器 profile 同步/备份或磁盘取证。

### 9.2 Canary Sink Matrix `[INV]`

每个 privacy fixture MUST 指定 `canarySinkMatrixId`，并为 canary 分配唯一随机值；禁止从生产样本派生 canary。默认矩阵如下：

| Sink | 原始 canary | 允许的变换/元数据 |
|---|---:|---|
| parse/preview 的短期输入 buffer | 仅该步骤临时允许 | 测试必须证明退出 preview、切 PRIVATE、clear 或异常后引用释放；不得进入持久缓存 |
| approved visible content / form value 与等价 a11y text | 允许仍 live、allowlisted 的 `local-sensitive` 最小正文 | statement/reason 可在批准的 Claim 正文、diff、详情和原生表单中可见可读；不得扩散到下列控制/元数据 sink |
| redacted preview DOM | restricted/prohibited/deleted=0 | 只允许固定占位符和粗粒度 redaction count，不显示原值、动态 key 或细 detector ID |
| canonical IndexedDB / indexes | restricted/prohibited/deleted=0 | 只允许通过二次 schema 的 allowlisted、仍 live 派生值 |
| tombstone / DeletionJournal / AuditEvent / ExportReceipt | restricted/prohibited/deleted/local-sensitive正文=0 | 仅 SPEC 固定无 payload 字段；禁止 payload-derived hash、semanticKey、自由文本和 detector ID |
| memory cache / Cache Storage / search index / projection DOM | restricted/prohibited/deleted=0 | 只允许仍 live 且 schema 允许的最小 projection；删除后必须逐 sink purge |
| accessible name/description、aria/title/alt/data、hidden/live region | dynamic statement/reason 与 restricted/prohibited/deleted=0 | Orb name 只允许固定状态名；coarse SourceLabel 只可由可见文本和固定 description 引用；表单/正文的等价 a11y text 不计入本行 |
| screenshot / visual diff / video/HAR/trace/reporter/CI artifact | 真实 local-sensitive 与 restricted/prohibited/deleted=0 | 只允许 synthetic fixture；发布前扫描，命中进入 quarantine 并销毁 payload artifact |
| error、validator issue、日志、production stack、console/source-map/脱敏诊断 | local-sensitive正文与 restricted/prohibited/deleted=0 | 只允许固定 ErrorCode、静态 field token、fixture/import batch ID 和计数；未知 key 固定为 `$unknown` |
| ExportEnvelope / manifest / notice | restricted/prohibited/deleted=0 | 只允许用户显式批准、仍 live 的 export schema；tombstone、运行态 cache 与 UI preference 排除 |
| Replay input/output 与新 suggestion | restricted/prohibited/deleted=0 | 只允许仍 live 且 allowlisted 的实体引用 |

任何禁止 sink 出现对应分类 canary 均使 G-01/G-05 失败；只扫描 IDB 不构成通过，必须由分类×sink registry 穷尽全部组合。正向 a11y fixture 同时证明批准的 live local-sensitive statement/reason 在正文/表单节点可见可读，避免把隐私门禁误实现为内容不可访问。

### 9.3 Consent 与 Retention `[INV]`

- M1 只允许 fixture/json-import；M2 `readonly-adapter` 的 SourceRef 必须解析到 active ConsentGrant。
- preview 和 commit 必须分别复核 consentId、allowedFields、purpose、policyVersion、RetentionPolicy 与 `privacyEpoch`；仅 preview 成功不能授权 commit。
- 撤权必须追加 immutable ConsentRevocation、设置对应 grant inactive 视图并原子递增 privacyEpoch；不得原地写 Grant.revokedAt。随后拒绝新摄入并运行 DeletionPlan。
- M1 fixture/json retention 是测试运行期或用户 clear；M2 默认 event TTL=7 天、derived TTL=30 天。用户可缩短；延长必须取得新 consent。
- TTL 到期必须走与用户删除相同的 T0 fence → journal chunks → client purge → ReachabilityResult → verified 路径；不得只隐藏 UI 或只删源事件。
- 系统时钟不可读时必须停止新摄入并进入 recovery-only，返回 `ERR_RECOVERY_REQUIRED`；不得用最后已知时间静默延长。
- 每个 retention fixture 必须使用注入时钟覆盖到期前、恰好到期、到期后、重启恢复和 clock unavailable。

### 9.4 PRIVATE 与 privacyEpoch 竞态 `[INV]`

PRIVATE 切换必须在 meta store 同事务设置 `observationMode=PRIVATE` 并递增 `privacyEpoch`。所有 commit 复核 cursor、privacyEpoch、recoveryMode 与 observationMode；旧 epoch 普通写 abort，BroadcastChannel 仅通知。delete/clear/recovery 按 capability matrix 在 PRIVATE 下仍允许。

必须覆盖 parse 中、preview-confirm 后、transaction commit 前切换，以及双标签 import/clear、崩溃重启和旧连接 blocked/versionchange。PRIVATE 清空 preview/队列/定时器；刷新后保持 PRIVATE；只有显式 resume 设 ACTIVE，恢复只进入 IDLE且不补采。

PRIVATE capability matrix：

| 操作 | PRIVATE |
|---|---|
| observation import、Runtime submit、新 action suggestion | DENY |
| knowledge.read、knowledge.delete/clear、privacy settings/resume、recovery | ALLOW |
| local export | 再次显示分类/数量/不可撤回边界并显式确认后 ALLOW |

`PrivateStaleCommit = commits_with_old_epoch / old_epoch_attempts = 0`。若分母为 0，fixture 无效，不能 PASS。

### 9.5 Delete Reachability、Journal 与 Evaluation invalidation `[INV]`

删除评价以 recovery-fenced、可扩展协议为准：plan snapshot → T0 等值复核与 fence → FENCED 分页 enumerate → 幂等 chunk → PURGE generation/barrier → registry-derived reachability → FINALIZING 分页清理 → 短 Tv verified+NORMAL。

1. **Plan/T0 race**：DeletionPlan 必含 `baseCursor/basePrivacyEpoch/baseSnapshotHash/planHash`。T0 同一事务必须复核当前 cursor+epoch 等于基线、重算 registry/target/plan hash，并原子写 fence/journal/generation；任一变化或 plan 后新引用导致 `ERR_CURSOR_CONFLICT`/重新规划，普通 store、journal、cursor、epoch 均零写。测试在 plan 后/T0 前注入新 evidence/head/index/ledger/change-feed 引用。
2. **Scalable enumerate/chunks**：T0 不得一次写全量 work。进入 FENCED 后按稳定 registry/store/key cursor 分页 enumerate，page receipt 与 high-watermark 原子提交；chunk 使用 `deleteIfHash`/幂等 work ID，完成后物理移除已完成 work 或压缩成无 payload计数。覆盖 0/1/500/501/high-fanout、分页 crash、重复 page、key 插入和 byte 上限±1。
3. **PURGE membership**：T0 创建 `purgeGeneration/clientCutoff`。cutoff 后新 client 必须原子加入 required set或保持 `QUARANTINED`，先 purge/ACK 才能读写/渲染。Audit 前原子 `seal` generation；seal 后禁止加成员。`RetryPurge` 必须关闭旧 generation、原子重算 live required set并生成新 generation，旧 ACK 不得计入。覆盖 client 打开/关闭/lease 到期/重连与迟到 ACK。
4. **Recovery lease fencing**：两个恢复者竞争 `RecoveryLease(ownerClientId,generation,fencingToken,acquiredAt,renewedAt,expiresAt,contentHash)` 时恰一持有；每个 enumerate/chunk/purge/audit/finalize/Tv 事务 CAS 当前 fencingToken。续租、过期 steal、旧 owner 迟到 commit、双标签恢复和时钟不可读均 fail closed；时钟异常不得无条件 steal。
5. **Registry-derived reachability**：roots MUST 从同一 `ReachabilityRootRegistryV1` 与 `LIFECYCLE_BINDINGS` 穷尽生成，不得手写抽样列表。至少逐 root 覆盖所有 IDB stores/indexes、heads、ledger affectedRefs、change feed、preview guard/buffer、ImportSession/staging、Worker/client heap、search/projection cache、DOM、accessibility tree、announcement queue、Cache Storage、ExportReceipt、Audit/diagnostic 和 `TestArtifactSinkRegistryV1`。每个 root 单独藏 target ID/hash 与 restricted/prohibited/deleted canary，证明 evaluator 定位 rootId/count 且阻止 CLEAN；未知 registry root 使 evaluator INVALID。
6. **FINALIZING/Tv**：active work、ACK、membership、journal payload 的清理必须分页、可恢复并受 lease fence；最后短 Tv 仅在 enumerate sealed、全部 work 清空、当前 generation ACK 完整、逐 root CLEAN、reserve accounting 一致时，原子写无关联 verified receipts、恢复 NORMAL。任一失败保持 RECOVERY_ONLY。
7. **Reserve accounting**：普通 transaction 与 recovery transaction 都以冻结 estimator version 原子更新 `logicalBytes/recoveryBytes`；测试 reserve 恰好、±1 byte、并发写、abort、chunk净减小、metadata增长和连最小 journal也写不下。不得用 `storage.estimate()` 代替 logical accounting；无法容纳最小恢复元数据时进入 CLEAR_ONLY。
8. **Evaluation invalidation**：既有 EvaluationResult payload、deleted EntityRef、delete CorrectionRecord 及关联 KnowledgeVersion/head/ledger/change-feed payload必须在 Tv 前物理移除；仅允许无 result/entity ID、hash、evidence 或内容派生标识的随机 EvaluationInvalidationReceipt/DeletionTombstone。

BroadcastChannel 仅优化通知，不是 PRIVATE/clear 正确性来源。BC unavailable 时 PRIVATE 仍依赖 IDB meta/epoch，旧写在 commit guard 被拒；clear 仍通过关闭本 client 连接、`deleteDatabase`、`versionchange/blocked` 与 empty reopen 诚实完成或保持 CLEAR_ONLY。只有依赖跨 client heap purge 的 target delete 可因 BC 不可用进入受限/quarantine 并要求关闭其他标签，不得静默降级到 localStorage或宣称成功。

### 9.6 Export `[INV]`

导出必须符合 SPEC `ExportEnvelopeV1`，并验证：

- 整体 hash 排除 `exportedAt`、自引用 hash 和 tombstone；manifest hash 可独立重算；
- 导出前展示实体类别、数量、最高 DataClassification 和“已下载副本无法远程撤回”声明，并取得 `projection.export` capability 的显式确认；
- entities 不含 deleted payload、tombstone、restricted/prohibited 数据、cache、UI preference 或原始导入文件；
- Web adapter 只负责把平台中立 ExportArtifact 转换为 Blob/download；
- 应用只保存无 payload ExportReceipt，并能标记后来受删除影响的 exportId；
- ShadowActionSink/ShadowPreview 调用图不得触达 export；
- clear-all 必须清除应用控制范围内的 ExportReceipt；控制范围外旧下载只提示边界，不得声称已删除。

---

## 10. Evaluator 质量与 Reward Hacking

Evaluator 自身必须用人工标注的正负样本校验：

- sensitivity ≥ 0.95 `[PH]`；
- specificity ≥ 0.95 `[PH]`；
- 关键隐私/Shadow 负例 specificity = 1.00 `[INV]`；
- 两名审阅者与 evaluator 的 Cohen’s κ ≥ 0.80 `[STAT]`。

关键预注册负例的工程门是“全部被判失败”，不因小样本点估计改写。`StatisticsProfileV1` 固定：Clopper–Pearson 双侧 exact 95% CI、`alpha=0.05`、独立单位为预注册且不共享根因/输入的 case、类别 prevalence 与 n 必报；若零错误时要求双侧下界≥0.95，至少约 72 个独立样本，否则结论只能是“证据不足”。κ 同时报 profile version、CI、类别分布、分歧与 adjudication；bootstrap 使用 manifest 固定 seed、重采样单位与次数。4 个欺骗 fixture 不得宣传 0.95 外部效度。

以下必须判失败：

1. UI 显示“成功”但 confirmed Claim revision/KnowledgeVersion 未追加；
2. 正确目标文字来自旧 toast 或前一 fixture；
3. Suggestion 正确但 evidence/provenance 断链，或 SourceRef/ConsentGrant/RetentionPolicy 不可解析；
4. Edit 改了目标 scope，同时污染无关 scope；
5. Delete 只隐藏卡片，任一受控 sink 仍可恢复 payload/canary；
6. T0/chunk/verified 事务失败未 abort，或 crash 后未按持久 progress 恢复；
7. deleted lineage 可 restore，或显式新导入静默复用旧 parent/head；
8. 删除后旧 EvaluationResult payload 仍 live，或 invalidation receipt 可反查旧 result/evidence；
9. 旧 privacyEpoch、revoked consent 或 expired retention 的任务成功 commit；
10. Shadow 调用图触发未授权 external network/process/OS-filesystem/input-injection，或调用 projection.export；
11. 用户显式导出被错误计为 Shadow 动作，或 Shadow 借导出路径产生下载；
12. Replay 只“运行完成”但 output hash 不一致；
13. 置信度恒为 0.99 以绕过 abstain；
14. fake-indexeddb 通过被当作真实 Chromium crash/quota/multi-tab 证据。

---

## 11. 必做失败注入与 AC 闭合

### 11.1 事件、schema 与 provenance

覆盖重复、缺失、乱序、延迟、时间回拨、跨 session 拼接、未知 enum/字段、超长输入、NFC/Bidi/control、高熵值，以及 SourceRef kind/字段组合非法。逐项验证 unknown 拒绝、optional redaction 后二次校验、required/identity 命中整项拒绝；factHash/provenanceHash/contentHash 和 VersionPins 必须符合 SPEC。

### 11.2 Scope、Correction 与 deleted restore

覆盖同 project 不同 activity、同 activity 不同 project、stale baseRevisionId、并发两次 edit、reject 邻近 semanticKey、restore live superseded/invalidated revision，以及 deleted lineage 的 restore/重新导入。后者必须返回 `ERR_DELETED_RESTORE_FORBIDDEN` 或形成全新非复活 lineage，绝不能读取 tombstone/旧导出内容。

### 11.3 AC-13a–c：删除事务与恢复 `[INV]`

- **AC-13a / pre-fence abort**：在 T0 的 meta 复核、plan/work/journal、RECOVERY_ONLY 与 cursor 更新逐点注入 request failure；预期整个 transaction abort，cursor/privacyEpoch/recoveryMode 和 stores 保持提交前状态。另在 chunk 的业务/索引删除与 progress 更新逐点验证同事务 abort。
- **AC-13b / crash recovery**：用 test-only `delete-after-fence`、`delete-after-chunk`、`delete-after-audit-before-verified` 精确关闭页面。下次启动按 journal state/work/progress 幂等继续；ReachabilityResult=CLEAN 且 required clients PURGED 后，才可 verified+NORMAL 原子提交；production bundle 静态排除 failpoint API。
- **AC-13c / deleted restore negative**：删除整个 Claim lineage 后，对每个旧 revisionId 调用 restore，并尝试从 cache、tombstone、旧 ExportEnvelope 恢复。必须返回 `ERR_DELETED_RESTORE_FORBIDDEN`，旧 lineage/statement/semanticKey/evidence 不得复活；用户未来再次显式导入相同事实时只能形成全新 lineage，不得从删除记录补回旧内容。

同时验证 AC-12：旧 EvaluationResult payload 和 deleted EntityRef 必须物理删除；只可新增无 result/entity ID、inputHash/evidence/content-derived identifier 的随机 `EvaluationInvalidationReceipt`。Reachability roots 必须逐项断言 CorrectionRecord、KnowledgeVersion/Head、workflow revisions/heads、ledger affectedRefs、change feed、Worker staging、projection/DOM/a11y tree/cache/audit/export receipt 均无目标 ID/hash；删除命令自身 record 在 Tv 后也不得保留。

### 11.4 Consent、Retention、PRIVATE/privacyEpoch `[INV]`

覆盖缺失/撤回/字段或 purpose 不匹配的 ConsentGrant、到期 RetentionPolicy、用户试图无新 consent 延长 TTL、系统时钟不可读。preview 与 commit 两次校验；任何失败均零普通写。

**AC-15b** 必须在 parse、preview-confirm 后、transaction-before-commit 三个时点切 PRIVATE，并运行双标签 import-vs-PRIVATE、import-vs-clear、旧连接 blocked/versionchange 场景。旧 privacyEpoch commit 必须为 0；恢复不补采。PRIVATE 中 read/delete/clear/recovery 仍可用，local export 需再次确认。

### 11.5 fake-indexeddb 与真实 Chromium 分工

- **Vitest + fake-indexeddb**：只负责 schema/Port contract、CAS/cursor/epoch、unique source-stable dedupeKey + non-unique factHash、反向索引、CommitLedger 和可控 request/audit/chunk compensation failure；不得作为 browser auto-commit、真实 crash、quota 或多标签证据。
- **Playwright + lockfile 固定的真实 Chromium**：必须覆盖 transaction inactivity、精确 failpoint crash、启动恢复、双标签 import/edit/PRIVATE/clear、PURGE/PURGED barrier、合作与不合作 client、`blocked`/`versionchange`/连接关闭、Cache Storage 和 Blob download。clear blocked 5 秒后必须保持 CLEAR_ONLY 并返回 `ERR_STORAGE_BLOCKED`；仅 deleteDatabase 成功、cache 清除和 empty reopen 后显示完成。物理 quota 不可稳定制造时按环境 `[STAT]` 单报，不得伪造通过。

M1 发布证据必须同时包含 fake contract 结果和真实 Chromium E2E 结果，二者不可互相替代。

### 11.6 Shadow 与 Browser Effect Sink Registry `[INV]`

`ShadowPreviewDTO` 的正式 renderer/handler、`ActionPort.submitShadow` 与 `ShadowActionSink` 是三类扫描 root；不得使用未定义的 UI root 名。静态依赖扫描和真实 Chromium runtime spy MUST 共同覆盖唯一 `ForbiddenBrowserEffectSinkRegistryV1`：

- network：`fetch/XMLHttpRequest/WebSocket/EventSource/sendBeacon`、动态 import/远程 module、WebRTC/data channel；
- navigation：`location/window.open/history` 的外部导航、form submit、custom protocol/scheme；
- download/files：anchor download、Blob/objectURL click、File System Access、拖放导出、print；
- user/device：Clipboard、Web Share、Notifications、Geolocation、MediaDevices、WebUSB/WebSerial/WebBluetooth、input injection；
- execution/bridges：ServiceWorker registration/message、SharedWorker/Worker effect bridge、MessagePort/postMessage 到未批准 origin、browser extension/native bridge、process/shell/OS filesystem；
- product ports：RuntimePort、`ProjectionPort.export`、任何显式 export/download trigger。

每个 registry sink MUST 有正向 spy 校准和从每个 Shadow root 的 tagged mutation 负例；未知新 browser API/registry 缺项使 G-06 INVALID。Shadow 允许的内部写仅为批准的 ActionIntent/preview state 与无 payload AuditEvent canonical commit。用户从**独立非 Shadow UI**明确触发、取得 `projection.export` capability 并确认分类后的 JSON download 不计为 Shadow action；必须证明该路径不能被任何 Shadow root、Worker message、service worker 或迟到 UI intent 间接触发。导出失败不得留下半个 ExportReceipt 或误报成功。

### 11.7 OracleAssertionV1、INV/AC Trace 与 skip 规则 `[INV]`

所有自动门禁 MUST 序列化为独立 Gold 中的统一 assertion，而不是散落的测试布尔值：

```ts
interface OracleAssertionV1 {
  assertionVersion: "1";
  id: string;
  fixtureManifestHash: Hash;
  root: "domain-snapshot" | "store" | "ledger" | "change-feed" | "worker" | "projection" | "dom" | "accessibility-tree" | "runtime-spy" | "artifact";
  selector: string;
  comparator: "equals" | "not-equals" | "exact-keys" | "contains-none" | "reachable-count" | "ordered-equals" | "hash-equals" | "throws-code";
  expected: JsonValue;
  invIds: readonly string[];
  acIds: readonly string[];
  severity: "gate" | "diagnostic";
}
interface RequirementTraceV1 {
  requirementId: string; // INV-* 或 AC-*
  assertionIds: readonly string[];
  suiteIds: readonly string[];
  artifactPaths: readonly string[];
}
```

每个适用 INV/AC MUST 至少双向解析到一个已执行 assertion；每个 assertion 也必须回链 INV/AC。未知 requirement/assertion、重复 ID、hash 不符、无 artifact、未执行、timeout、crash、empty denominator、`test.skip/todo`、条件分支未命中或 unsupported 环境 MUST 记 `NOT_RUN/INVALID`，不得折算 PASS。只有 Gold 明确标记阶段不适用且 reviewer 签署的项目可为 `N/A`；`N/A` 不能满足门禁覆盖率。UI 文案、截图和 axe 报告只能作为指定 root 的证据，不能替代 canonical domain/store oracle。

### 11.8 NDJSON Worker Contract `[INV]`

`test:worker-contract` MUST 在 byte-level protocol harness 与锁定 Chromium Worker 各运行一次。输入分 `inline-bytes | stream-bytes`；CHUNK 使用 transferable `Uint8Array/ArrayBuffer`，不得先转 JS string 再声称验证原始 bytes：

- header 必须第一且唯一，footer 必须最后且唯一；缺失/重复 header/footer、footer 后任意 byte、declared/actual/footer count 不等，验证阶段零 commit。
- 使用 `TextDecoder("utf-8", {fatal:true})` 的持久 streaming decoder；覆盖非法 UTF-8、截断 code point、2/3/4-byte code point 在每个 byte 边界切分、BOM 位于首字节/中途、CRLF 跨 chunk、空行、末行无换行。不得用 replacement character、BOM stripping 差异或重新编码掩盖错误。
- 冻结并分别测试 `rawChunkBytes`、`canonicalMutationBytes`、`estimatedStorageBytes` 三种上限的 `limit-1/limit/limit+1`；raw byte 上限不得以 UTF-16/string length 计算。
- event `sequence` 从 `"0"` 连续，以 BigInt 比较；重复、gap、回退、`"9"→"10"` 字典序陷阱必须检出。
- Worker 只产 `WorkerValidationReceipt`，其中 accepted count/hash 仅为不可信候选。App MUST 从原始受限 bytes/validated canonical events 用独立实现重算 count、canonical bytes、`orderedEventsHash` 与 batch hash；与 Worker 任一不符即 fail closed。
- `maxChunkBytes≤262144`、每 chunk≤500 event lines、`maxUnacked=2` 是硬 oracle；两个 VALIDATED 未 ACK 时第三个 CHUNK 不得读取、decode、parse 或增长 retained bytes。
- ACK 必须匹配 streamId/chunkId/sequence 且每 chunk 至多释放一次；未知、重复、跨 stream、乱序 ACK 不推进窗口。迟到 Worker message 必须由 import generation 拒绝。
- CANCEL 前/后、`worker-after-validated`、`worker-after-cancel`、主线程 crash 与 Worker crash 均需注入。CANCEL 后拒绝新 CHUNK、释放未 ACK bytes，并只发一次 validation COMPLETE。
- App 独占 commit 所有权并生成 `AppImportCommitReceipt`；组合 UI receipt 不得把 Worker validation 伪装成 commit。response loss 通过 CommitLedger 回读，不接受 Worker 自报 finalCursor。
- partial batches 只写入 `ImportSession(state≠PUBLISHED)` 隔离 staging，对 Episode/Claim/Report/Replay/Projection 不可见。完整文件验证+App hash通过后才原子设PUBLISHED/publishedCursor；取消/截断默认物理清除，选择保留也必须重新预览确认并形成新identity，不能自动学习。
- `ImportStreamController.dispose()` 在 success/failure/cancel/PRIVATE/clear/unmount/reload 前后都必须取消 reader、terminate Worker、移除 listener/timer、revoke objectURL、释放 ArrayBuffer/string/canonical staging；用 WeakRef/可观察计数和 canary 证明无残留。crash recovery 只能恢复受限 unpublished metadata或清除，不得发布半流。

### 11.9 ProjectionDeltaOracleV1 `[INV]`

```ts
interface ProjectionDeltaOracleV1 {
  oracleVersion: "1";
  projectionVersion: string;
  baseSourceCursor: Cursor;
  targetSourceCursor: Cursor;
  changePageHashes: readonly Hash[];
  expectedFullProjectionHash: Hash;
  expectedDeltaProjectionHash: Hash;
  expectedHeadHash: Hash;
  assertionIds: readonly string[];
}
```

- 对同一 target cursor，`bootstrap/full rebuild` 与从 base cursor 消费全部 `loadChangesSince` pages 的 canonical projection hash MUST 相等；gold hash 由独立 reference projection fixture 提供。
- 分页必须按 BigInt cursor 严格连续、无漏无重；专测 `"9"→"10"`、空 page+hasMore、重复 change、page token 绑定错误和并发新增 change。
- cursor gap、invalid/expired token、projectionVersion 变化或 change hash 不符必须 fail closed，并从稳定 snapshot 做 full rebuild；不得猜测跳过。
- stale async rebuild/delta 使用旧 `expectedSourceCursor` CAS 时必须失败并丢弃，不得覆盖较新 ProjectionHead；UI 在 stale/loading 期间禁用 correction，并在成功原子替换后保持语义焦点。
- delete/invalidation change 必须清 projection cache、DOM、accessibility tree 与 search index；delta 后与全量 rebuild 的删除不可达结果一致。
- Projection adapter unavailable/corrupt 时 canonical import、correction、delete、Replay 仍可运行；恢复后只从 canonical state 重建，不得反向覆盖。

### 11.10 VisualContractV1 与批准截图 `[INV/STAT]`

`reference/Prototype reference1.png` 以及同目录其他 prototype **只作 mood board**，不是整图 pixel gold。只允许采纳已在产品规格批准的暖白画布、深墨标题、蓝强调、细灰分隔、玻璃液体 Orb、26/96px、六态形态和分组卡片；MUST NOT 采纳或暗示鼠标轨迹采集、OCR/截图感知、发送邮件、创建任务、真实执行、自动化已完成或 legacy `ProAGIAgent/智图灵助手` 品牌。

```ts
interface VisualEvidenceCaseV1 {
  contractVersion: "1";
  componentId: "app-shell" | "orb" | "inbox" | "replay" | "recovery-surface" | "move-orb";
  stateKey: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  colorScheme: "light"; // M1 仅冻结参考图暖亮主题
  forcedColors: "none" | "active";
  reducedMotion: boolean;
  fontHash: Hash;
  visualComparatorVersion: string;
  statisticsProfileVersion: string;
  bootstrapSeed: string;
  structureAssertionIds: readonly string[];
  requiredForM1c: boolean;
  approvedScreenshotHash: Hash;
  approvalId: string;
  approvedBy: string;
  maskSelectors: readonly string[];
}
```

结构门禁优先于像素：Orb anatomy/尺寸/状态标识、AppShell 区域顺序、恢复表面、禁用状态和越界能力/文案均用 DOM+computed-style assertion `[INV]`。所有 `requiredForM1c=true` cases 的 `approvedScreenshotHash/approvalId/approvedBy` MUST 非空且可在 artifact registry 解析；不得以 optional/null/临时录制绕过。批准矩阵至少覆盖：六态 Orb 的 26px/96px、Inbox 空/有候选、Replay before/after、PRIVATE、ERROR+RECOVERY_ONLY、CLEAR_ONLY+blocked、MoveOrb、360/768/1280 宽度、320 CSS px reflow、200% zoom、forced-colors、reduced-motion。固定 Chromium revision、OS image、font files/hash、viewport、DPR、locale/timezone；mask 仅允许时间、随机 ID 等非语义字段，不能 mask error、状态、焦点或隐私文案。截图 diff 在 baseline 冻结前为 `[STAT]`；baseline 经批准后，结构失败或未批准 diff 阻止 M1c，pixel 相似仍不得替代 a11y/领域门禁。

### 11.11 Accessibility Tree Canary 与 A11y Contract `[INV]`

分类语义以 §9.2 为准：批准、仍 live、allowlisted 的 `local-sensitive` statement/reason MUST 在可见 Claim 正文、diff、详情和原生表单控件中可见，并以等价 accessibility text 可读；这类批准正文不是泄漏。它们 MUST NOT 进入 Orb/按钮的 accessible name/description、`title/data-*`、hidden DOM、live region、日志或 published test artifacts。`restricted | prohibited | deleted` 原值在 DOM、accessibility tree 及所有其他 sink 中均为 0。

Orb accessible name **只**是固定状态名，不拼接来源或动作；coarse SourceLabel 只能作为可见说明并由固定 `aria-describedby` description 引用。普通有可见文字的 action control 按 Label-in-Name 使用自身固定标签。自动 `test:a11y` 必须输出：

- axe-core `critical=0 && serious=0`，并保留原始报告；axe 不能替代后续项目。
- browser accessibility snapshot 的 role/name/state/relationship gold；正例证明批准正文/表单可读，负例对 restricted/prohibited/deleted canary 做 DOM 与 tree 双扫描。
- `html lang=zh-CN`、skip link、main/nav/aside、单一 h1/heading 层级、route title、form native label、`aria-describedby/errormessage` 和错误 summary。
- 仅键盘完成导入、accept/edit/reject/delete、Replay、PRIVATE、RecoverySurface、MoveOrb、export；Tab 顺序可预测，无 trap，Escape 返回发起控件。
- menu/popover/dialog 的 role、初始焦点、方向键、hover/focus persistent、dismiss 和 WCAG 1.4.13 行为。
- `aria-live` registry：普通进度 `polite` 且只在阶段或 10% 边界去重播报；ERROR 单次 `assertive`；装饰 Orb 不得 live；privacyEpoch/clear 切换清除旧 announcement queue。
- 320 CSS px、200% zoom 和 WCAG text-spacing override 下无信息/操作丢失、遮挡或**页面级**横向滚动；只有标记为 code/pre 的代码区域可局部横滚，普通 table 必须转卡片/堆叠，不得以 table 横滚规避 reflow。文本对比≥4.5:1，非文本状态/焦点≥3:1。
- `forced-colors: active` 下状态、边框、焦点和禁用语义可辨；Windows High Contrast 作为环境记录的人工 smoke。
- `prefers-reduced-motion` 下全局禁用 transform/parallax/smooth scroll/skeleton movement/Orb 旋转弹跳，仅允许规格内短 opacity；通过 computed style、animation/transition event count 与截图共同断言。

每个 release candidate 使用固定模板执行 NVDA smoke：记录 NVDA/Windows/browser 版本、语音查看器 transcript 的无敏感摘录、landmark/heading、六态、Inbox、correction error、PRIVATE、blocked recovery、Replay diff、MoveOrb 与 export 路径，结果为 pass/fail/blocked 和 issue IDs。NVDA `NOT_RUN/BLOCKED` 时 Gate 1 最多 `CONDITIONAL`，并禁止宣传“读屏支持/无障碍已验证”；不得以 axe 或 accessibility snapshot 替代。

### 11.12 RecoverySurface 与 MoveOrb `[INV]`

- `RecoverySurface` 在 PRIVATE、ERROR+RECOVERY_ONLY、CLEAR_ONLY 和 clear blocked 时必须持续可达；具有固定 heading、当前安全状态、未保存/未完成语义、允许操作与 next action。status 用 polite，阻断错误用单次 alert/assertive。进入时初始焦点 MUST 到带 `tabindex="-1"` 的 Recovery heading；完成/取消后返回保存的 invoker，invoker 已消失/disabled 时返回 `global-status-privacy` 的固定状态控件，禁止回装饰 Orb 或任意 body。未 PURGE ACK、未 empty reopen 或 stale cursor 时不得显示成功。
- `MoveOrb` 必须是可见键盘等价路径：Arrow 每次 8px、Shift+Arrow 32px、Enter 保存、Escape 取消、Reset 恢复默认；位置 clamp 到 safe area，任何 viewport/zoom/text spacing 下不遮挡主要操作。拖拽只作增强，pointercancel/blur/PRIVATE/clear 不提交；保存由单一 idempotency key 表达。

### 11.13 UI Intent Idempotency 与竞态 `[INV]`

一次用户意图只能产生一个 command：pointer、Enter/Space、key repeat、double click、touch、重渲染和 response-loss 共享同一 pending lock、`commandId/idempotencyKey` 与 intent generation。pending 时重复触发不得创建第二 command/revision/export/delete；成功按 ledger/receipt 回读，失败按 ErrorPolicy 解锁。privacyEpoch、cursor、mode、projection sourceCursor 或 component unmount 改变时取消旧 generation、清 pending/live queue 并忽略迟到 success；不得播报或展示旧成功。双击/长按只作增强，Today/控制面板必须另有可见按钮或 menu；`pointercancel` 不提交。

### 11.14 不支持能力的安全 UI `[INV]`

IndexedDB、Worker、BroadcastChannel、accessibility snapshot 或 visual runner unavailable/denied/crash 时必须记录固定 capability result。产品运行时禁止静默降级到 localStorage、同步全量 parse 或无 fence 写入。IndexedDB 缺失时写功能禁用；Worker 缺失时 stream import 禁用但小型 inline fixture 可走同一 byte validator；BC 缺失时按 §9.5 依赖 IDB epoch/versionchange/blocked 保证 PRIVATE/clear，target delete 进入受限 quarantine 而不是全局伪失败。测试基础设施缺失时相应 suite 为 `NOT_RUN/INVALID`，不能 PASS。

### 11.15 Application Control、Replay 与 Clear Contracts `[INV]`

UI 与 adapter 不得自行编排 pause/resume/recovery/clear/Replay。Application-level contract suite MUST 以 mock ports 和真实 Chromium adapter 分别验证：

- `ControlPort.pause/resume/getStatus`：同一 `PortRequestContext` 的 capability/resourceScope/correlationId/idempotencyKey 贯穿 UI intent、meta mutation、ledger、announcement；pause 原子更新 mode+epoch，response loss 回读，不重复递增；resume 不补采。
- `ControlPort.recover/retryPurge`：只能通过 RecoveryLease fencing 推进 journal，旧 owner/旧 generation/旧 ACK 不得成功；状态投影来自 canonical meta/journal，不由 UI 猜测。
- `ControlPort.clearAll`：进入 CLEAR_ONLY、关闭本 client 连接、广播（可用时）、调用 deleteDatabase、处理 versionchange/blocked、清 Cache/Worker/UI/artifact staging 并 empty reopen；任一阶段失败保持 CLEAR_ONLY 和 RecoverySurface，response loss 重查事实，不生成第二 clear command。
- `ReplayUseCase.run`：应用从当前 canonical store 与请求 pins 构造唯一 ReplayInputV1，调用纯 `ReplayV1`，以 terminal-only transaction 持久化 EvaluationResult；构造失败/取消/超时不得存 running/半结果。相同 request/idempotency 回读同一 terminal result，源删除按 §9.5 物理移除结果。
- 每个 use case 对 denied capability、wrong resource scope、stale cursor/epoch、abort、commit-before-response、双标签竞争和 transport exception 运行统一 contract；UI 只能调用 application use case，不能直接调用 Knowledge/IDB/Replay pure function 组合事务。

---

## 12. 人工 Pilot 设计

M2 才执行，且必须预注册方案：

- ICP screener：Windows 主力环境、每周至少 3 次 IDE/Git 工作会话、每周至少一次日报/会话恢复需求、最近一月使用 AI coding 工具；记录现有手工基线。
- 探索性最低 N=12 名目标开发者；每人至少两次真实同类会话。N/周期不足只能 `CONDITIONAL`，不得证明价值。
- 第一次完成来源预览、日报审阅和一次纠正；第二次验证纠正复用，并与 manual baseline 的时间、步骤、错误恢复对比。
- 纠正计时从卡片首次可操作到 correction committed，分报理解、编辑、确认、放弃和恢复时间。
- 退出、静默忽略和关闭功能均保留在 intent-to-treat 分母；访谈区分“看懂解释”“认为可靠”“愿意再次使用”。
- `[INV]` 全过且 NetValue 中位数 >0 才可 `PASS`；INV 全过但样本/CI 不足为 `CONDITIONAL`；隐私失败或持续净负价值为 `STOP`。

Synthetic 与 pilot 结果必须分表报告，不得合并平均。

---

## 13. 性能评价协议

性能结果均为 `[STAT]` 趋势，不能抵消任何 `[INV]`；在冻结 CI/browser 基线前不得宣传为真实设备保证。

### 13.1 固定环境与样本

每次性能 run MUST 记录 source identity（Git commit；无 Git 时使用规范化 source-tree hash）、build artifact hash、VersionPins、InputIdentity/fixture hash、Node/npm、Playwright 锁定的 Chromium revision、OS、CPU、逻辑核、内存、节能/电池状态、storage estimate/quota、冷/热启动和后台进程限制。禁止把 fake-indexeddb 数据与真实 Chromium 数据合并。

测试分层：`verify:pr` 跑全部功能/隐私 INV、1k/10k 小样本、golden、Long Task 和 O(n²) 比率；`verify:nightly` 增 50k、1%/10% fan-out、100 次 Replay、Worker/crash/multi-tab 和完整视觉矩阵；`verify:release` 在候选 build hash 上重跑 nightly。完整性能项至少 5 次 warm-up、3 个独立冷启动×30 次有效样本，报告 n/p50/p95/max/95% bootstrap CI/失败数。Evidence Pack 强制 tier，不得把 PR 冒充容量证据。

### 13.2 测量任务

分别测量 preview+redaction、NDJSON validation/Worker backpressure、每个 import batch、Episode/Claim inference、Replay/canonical hash、Projection full/delta、export、DeletionPlan、T0 fence、每个 delete chunk、client purge barrier、ReachabilityResult、verified transaction、启动恢复和 PRIVATE/clear fence。每项分段报告，禁止用总耗时掩盖长事务；不含 fixture 生成和 Playwright 启动。

同时记录主线程 Long Task（>50ms）数量/总时长、峰值 JS heap（环境支持时）、IDB/Cache Storage bytes、export bytes、每千事件增长率和 80/100MB 逻辑预算状态，并分报 UI intent→pending 首显、cancel→停止读取/解析、PRIVATE/RecoverySurface 首显、键盘动作响应的 p50/p95/max。以上交互和 storage estimate 均为 `[STAT]` 趋势；不得把 origin 级 estimate 当单数据库精确值、reserve accounting 或隐私门禁。

### 13.3 判读与回归

- 功能/隐私不变量失败时，该性能 run 标记 invalid，不报告为性能成功。
- 在基线冻结前只报告结果；冻结后，同环境 p95 回退 >20% 且 CI 不重叠时标记 regression，必须说明原因或回滚。
- 高 fan-out 删除 MUST 在 RECOVERY_ONLY 下按 journal work items 分块；每个 chunk transaction 必须短、幂等且无外部 await，progress 与 chunk 原子提交。性能优化不得放宽 epoch fence、purge ACK、tombstone 或 reachability 规则。
- 若真实 Chromium 无法稳定制造物理 quota，只报告“不适用/环境不足”，不得用 fake-indexeddb 或应用逻辑预算冒充浏览器 quota 通过。

---

## 14. 自动化验证命令

实现后至少提供：

```bash
npm ci
npm run typecheck
npm run lint
npm run audit:deps
npm run verify:csp
npm run test:unit
npm run test:integration
npm run test:fixtures
npm run test:privacy
npm run test:replay
npm run test:worker-contract
npm run test:projection
npm run test:evaluator
npm run test:a11y
npm run test:visual
npm run test:e2e
npm run build
npm run smoke
npm run verify:pr
npm run verify:nightly
npm run verify:release
```

唯一脚本契约以 PLAN §1.3 为准；`verify` 是 `verify:pr` 别名。当前仓库尚处 implementation pending 时这些命令只能标 `PLANNED/NOT_RUN`；不存在、skip、空 suite、`--passWithNoTests` 或缺 runner 均不得 PASS。每 tier 上传 manifest、exit codes、原始结果、trace、axe/visual artifacts、artifact registry 与 retention URL/hash；PR 保留 14 天、nightly 90 天、release Evidence Pack 长期保留。canary quarantine artifact 禁止普通上传。`smoke` 自动启停 preview。

---

## 15. 评价结论模板

```markdown
# Evaluation Run
- Tier / source-tree hash / build hash / artifact registry / retention URL+hash+policy:
- FixtureInput / M1UiCase / GoldOracle / EvaluatorManifest hashes and distinct owners:
- VersionPins / InputIdentity / ReplayInputHash / OutputHash:
- Node/npm/Chromium/OS/fontHash/visualComparator/StatisticsProfileV1/bootstrapSeed:
- INV: passed/failed/not-run (no skip may pass)
- PH: measured/not measured
- STAT: n, prevalence, p50/p95/max, Clopper–Pearson exact/bootstrap CI:
- Oracle trace: INV/AC IDs → assertion IDs → result artifact
- Tagged mutation corpus target failures + control assertions:
- PreviewCommitGuard cross-tab/transaction/response-loss / immutable-head / random-ID+Replay metamorphic:
- Worker raw/canonical/storage byte ±1, fatal UTF-8, validation/app receipts, unpublished ImportSession/dispose:
- Projection delta/full/gap/stale CAS/delete:
- Provenance / classification-aware accessibility-tree+DOM canary sinks:
- privacyEpoch / ConsentRevocation / retention / BC fallback:
- plan base cursor+epoch+hash / enumerate+chunks / purge generation+seal+retry / RecoveryLease fencing / FINALIZING:
- registry-derived per-root reachability / reserve accounting / clear blocked+empty reopen:
- Evaluation payload removal + minimal invalidation receipt:
- BrowserEffectSinkRegistry spies / explicit Export boundary:
- ControlPort pause-resume-recover-clear / ReplayUseCase contracts:
- Visual required screenshotHash+approvalId / structure+diff / axe critical+serious / keyboard+focus / reflow+forced-colors:
- NVDA smoke: pass/fail/not-run + environment + claim restriction
- TestArtifactSinkRegistry canary quarantine/destruction receipts:
- Correction absorption/locality / Reject/Delete resurrection:
- Performance protocol and tier:
- Limitations:
- Decision: M1 pass / fail / invalid / not-run
```

只有 G-01～G-08 全部通过，M1 才能标记为工程闭环完成；这仍不构成真实用户价值或自动化执行能力证明。
