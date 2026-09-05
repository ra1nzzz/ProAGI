# ProAGI Insight Loop 可执行产品/工程规格
**版本**：1.0.0 ｜ **状态**：Contract Frozen / M1 Implementation Active ｜ **产品名**：ProAGI Assistant ｜ **实现目标**：TypeScript/Web 首个垂直切片

## 1. 规范约定

关键词 **MUST（必须）**、**MUST NOT（禁止）**、**SHOULD（应该）**、**SHOULD NOT（不应该）**、**MAY（可以）**具有规范性。
未标注条目为说明性文本；测试名称使用 `AC-*`，不变量使用 `INV-*`，错误码使用 `ERR_*`。
时间 MUST 为 UTC RFC 3339 字符串；哈希 MUST 为小写 `sha256:<64 hex>`。外部摄入/用户命令/审计 `recordId` MUST 为 UUIDv7；Replay 派生实体 `semanticId` MUST 为版本化 namespace + canonical content 派生的 UUIDv5；`runId` 使用 UUIDv7 且排除出 canonical snapshot。
所有 JSON object MUST 拒绝未知字段（等价于 JSON Schema `additionalProperties:false`）。批量导入中的未知字段只拒绝该项并返回逐项错误，不得污染合法项。
所有数值置信度 MUST 位于闭区间 `[0,1]`；所有数组 MUST 无重复 ID。
领域对象 MUST 与 UI、存储和 Runtime SDK 类型解耦。

## 2. 术语

- **BehaviorEvent**：经白名单和写前脱敏后可持久化的最小行为事实。
- **Episode**：按确定性规则归组的一段连续工作事件。
- **EvidenceRef**：从推断对象指向来源及变换的可验证引用。
- **WorkModelClaim**：关于用户工作方式的有范围、置信度和证据的原子主张。
- **Correction**：用户对主张的接受、编辑、驳回或删除指令。
- **KnowledgeVersion**：指向某个不可变 Claim revision 的不可变知识 head 记录，不复制业务 payload。
- **DailyReportSnapshot**：Episode、Claim、Question、SkillCandidate 的可追溯、可重建日投影。
- **Question**：为解决一个明确认知缺口而提出的单个问题。
- **SkillCandidate**：仅描述可能自动化的候选，不含可执行代码。
- **EvaluationResult**：对固定 fixture 与版本 pin 的最终领域状态判定。
- **ActionIntent**：Shadow 模式下“若执行将做什么”的声明，绝非真实动作。
- **Replay**：对固定输入、固定版本和固定知识快照进行纯函数式重算。
- **Canonicalization**：将等价结果归一为唯一字节序列以计算哈希。
- **删除不可达**：被删 payload 无法由查询、索引、缓存、报告、导出或 Replay 恢复。

## 3. 用户故事

- US-01：作为开发者，我要导入本地 fixture，并在写入前预览保留/脱敏/丢弃字段。
- US-02：作为开发者，我要看到事件如何组成 Episode，以及每个结论对应哪些证据。
- US-03：作为开发者，我要获得 Daily Engineering Report，而非只看活动时间线。
- US-04：作为用户，我要用一次点击接受、驳回或删除主张，并可局部编辑 statement/scope。
- US-05：作为用户，我要 Replay 同类事件并比较修正前后，以确认系统吸收了纠正。
- US-06：作为用户，我要暂停观察并确认 PRIVATE 状态下不会摄入数据。
- US-07：作为用户，我要导出并清空本地数据，且删除不会在导出或 Replay 中复活。
- US-08：作为键盘或读屏用户，我要完整操作 Orb、卡片、纠正和导出流程。

## 4. 首个垂直切片

### 4.1 MUST 包含

1. JSON fixture 导入、schema 验证、allowlist、redaction 与导入预览。
2. 确定性 Episode 分段、Daily Engineering Report 和 Insight Inbox。
3. 依据版本化 eligibility predicate 条件式生成 0..N WorkModelClaim、0..1 Question、0..N SkillCandidate；证据不足时 MUST abstain 并给 reason code。测试必须同时覆盖应产出与必须为 0。
4. accept/edit/reject/delete、不可变 KnowledgeVersion 与 lineage。
5. 修正前后 Replay、canonical hash 和 EvaluationResult。
6. 所有 ActionIntent 均 Shadow-only；六态 Orb 显示处理和隐私状态。
7. 浏览器本地持久化、JSON 导出、全量删除。

### 4.2 MUST NOT 包含

- 真实 Windows UIA/A11y 采集、全局鼠标键盘 hook、输入注入或截图。
- 真实 Codex、ACP、MCP、模型 API、网络请求或云同步。
- Tauri/Rust/daemon/native IPC、SQLite、Obsidian 自动投影。
- 文件写入自动化、Shell 执行、邮件发送、浏览器控制或任何外部副作用。
- Skill 代码生成、Sandbox、模型训练、Kernel 修改或多用户。
这些能力 MAY 在未来通过端口适配；本切片不得伪造“已接入”状态。

## 5. 通用 TypeScript 契约

### 5.1 标量、记录类别与生命周期

```ts
export type UUID = string;
export type Timestamp = string;
export type Hash = `sha256:${string}`;
export type SchemaVersion = `${number}.${number}.${number}`;
export type Cursor = string; // ^(0|[1-9][0-9]*)$，比较/递增使用 BigInt
export type Confidence = number;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];
export type DataClassification = "public" | "local-sensitive" | "restricted" | "prohibited";
export type BusinessEntityType =
  | "behavior_event" | "episode" | "work_model_claim" | "correction_record"
  | "knowledge_version" | "daily_report" | "question" | "skill_candidate"
  | "evaluation_result" | "action_intent";
export type SystemRecordType =
  | "store_meta" | "retention_policy" | "consent_grant" | "consent_revocation"
  | "knowledge_head" | "workflow_revision" | "workflow_head" | "commit_ledger"
  | "preview_commit_guard" | "import_session" | "recovery_lease"
  | "deletion_plan" | "deletion_work_item" | "deletion_journal"
  | "client_registration" | "purge_ack" | "reachability_root_receipt"
  | "audit_event" | "export_receipt" | "artifact_disposal_receipt"
  | "evaluation_invalidation_receipt" | "tombstone" | "projection_head"
  | "storage_migration" | "change_record";
export type RecordType = BusinessEntityType | SystemRecordType;
export type EntityType = BusinessEntityType | "evidence_ref";
export type EvidenceTargetType = BusinessEntityType;
export type LifecyclePolicyId = "business-versioned" | "business-projection" | "business-terminal" | "system-singleton" | "system-append-only" | "system-journal";
export interface LifecycleBinding {
  recordType: RecordType;
  policy: LifecyclePolicyId;
  mutableFields: readonly string[];
  deletion: "cascade" | "rebuild" | "retention" | "clear-only";
}
export declare const LIFECYCLE_BINDINGS: Readonly<Record<RecordType, LifecycleBinding>>;
export interface EntityRef { entityType: EvidenceTargetType; entityId: UUID; entityHash: Hash }
export interface Scope {
  projectKey?: string;
  activityKind?: "code" | "test" | "review" | "research" | "build" | "other";
  validFrom?: Timestamp;
  validUntil?: Timestamp;
}
export type SourceRef =
  | { kind: "fixture"; fixtureId: string; manifestHash: Hash; adapterId: string; adapterVersion: string }
  | { kind: "json-import"; importBatchId: UUID; sourceItemKey: string; adapterId: string; adapterVersion: string }
  | { kind: "readonly-adapter"; sourceItemKey: string; adapterId: string; adapterVersion: string; consentId: UUID; policyVersion: string; purpose: string };
export type InputIdentity =
  | { kind: "fixture"; fixtureId: string; manifestHash: Hash }
  | { kind: "json-import"; importBatchId: UUID; inputHash: Hash }
  | { kind: "readonly"; adapterId: string; captureId: string; consentId: UUID; inputHash: Hash };
```

Business records 保存产品事实，System records 保存控制面、head、ledger、receipt 与迁移元数据。每个 `RecordType` MUST 在 `LIFECYCLE_BINDINGS` 恰有一项；缺失或重复返回 `ERR_LIFECYCLE_BINDING_MISSING` 并只读。绑定固定为：`business-terminal`=behavior_event/correction_record/evaluation_result；`business-projection`=daily_report；其余 business=`business-versioned`，状态变化必须追加 revision；`system-singleton`=store_meta/knowledge_head/workflow_head/projection_head 且仅 CAS；`system-journal`=preview_commit_guard/import_session/recovery_lease/deletion_work_item/deletion_journal/client_registration/export_receipt/storage_migration 且 mutableFields 必须逐字段列出；deletion_plan/purge_ack 与其余 system=`system-append-only` 且禁止覆盖。只有 projection 可 rebuild；terminal 与 append-only 的 mutableFields 必须为空。

### 5.2 结构化 pin、权限与统一结果

```ts
export interface ComponentPin { id: string; version: string; integrityHash: Hash }
export interface AdapterPin extends ComponentPin { role: "observation" | "knowledge" | "projection" | "action" | "runtime"; sourceKind?: SourceRef["kind"] }
export interface PolicyPin extends ComponentPin { purpose: "privacy" | "retention" | "capability" | "detector" | "evidence-loss" }
export interface AlgorithmPin extends ComponentPin { purpose: "segmentation" | "inference" | "canonicalization" | "id-generation" | "evaluation" | "migration" }
export interface VersionPins {
  schema: SchemaVersion;
  adapters: readonly AdapterPin[];
  policies: readonly PolicyPin[];
  algorithms: readonly AlgorithmPin[];
}
export type Capability =
  | "observation.preview" | "observation.commit.fixture" | "observation.commit.readonly"
  | "knowledge.read" | "knowledge.commit" | "knowledge.correct" | "knowledge.delete"
  | "projection.rebuild" | "projection.export" | "action.shadow" | "replay.evaluate"
  | "runtime.initialize" | "runtime.submit" | "runtime.cancel"
  | "privacy.read" | "privacy.pause" | "privacy.resume" | "privacy.revoke"
  | "storage.clear" | "audit.read" | "recovery.clean" | "recovery.retry-purge";
export type Operation =
  | "observation.preview" | "observation.commit" | "correction.submit"
  | "knowledge.snapshot" | "knowledge.scan" | "knowledge.changes" | "knowledge.commit"
  | "projection.rebuild" | "projection.export" | "action.shadow" | "replay.evaluate"
  | "control.privacy.pause" | "control.privacy.resume" | "control.privacy.revoke"
  | "control.recovery.resume" | "control.recovery.retry-purge"
  | "control.storage.clear" | "control.export"
  | "runtime.initialize" | "runtime.submit" | "runtime.cancel";
export type ResourceScope =
  | { kind: "installation"; installationId: UUID }
  | { kind: "fixture"; fixtureId: string }
  | { kind: "import"; importBatchId: UUID }
  | { kind: "project"; projectKey: string }
  | { kind: "entity"; entityType: BusinessEntityType; entityId: UUID };
export interface PortRequestContext {
  requestId: UUID;
  correlationId: UUID;
  idempotencyKey: UUID;
  callerId: string;
  operation: Operation;
  capabilities: readonly Capability[];
  resourceScope: ResourceScope;
  purpose: string;
  policyVersion: string;
  privacyEpoch: number;
  consentId?: UUID;
  deadlineAt?: Timestamp;
}
export type DomainResult<T> = { ok: true; value: T } | { ok: false; error: DomainError };
export interface BatchItemError { itemKey: string; error: DomainError }
export type BatchResult<T> =
  | { ok: true; accepted: readonly T[]; rejected: readonly BatchItemError[] }
  | { ok: false; error: DomainError; accepted: readonly []; rejected: readonly BatchItemError[] };
```

所有 Port MUST 用 `DomainResult/BatchResult` 表达预期失败；adapter boundary 将 transport exception 归一化为 `DomainError`。入口与 commit 对 `operation + capability + resourceScope + consentId + privacyEpoch` 双检，禁止 capability 跨 scope 代理。

### 5.3 Preview、snapshot、page/change 与 mutation DTO

```ts
export type PreviewToken = string & { readonly __brand: "PreviewToken" };
export type ImportStreamHandle = string & { readonly __brand: "ImportStreamHandle" };
export type ObservationInputDTO =
  | { kind: "inline"; identity: InputIdentity; mediaType: "application/json"; utf8: string }
  | { kind: "stream"; identity: InputIdentity; mediaType: "application/x-ndjson"; handle: ImportStreamHandle };
export interface PreviewItemDTO {
  itemKey: string;
  decision: "accept" | "redact" | "reject";
  kind?: EventKind;
  occurredAt?: Timestamp;
  retainedFieldNames: readonly string[];
  redactionCount: number;
  errorCode?: ErrorCode;
}
export interface ObservationPreviewDTO {
  token: PreviewToken;
  identity: InputIdentity;
  inputHash: Hash;
  privacyEpoch: number;
  policyPins: readonly PolicyPin[];
  expiresAt: Timestamp;
  items: readonly PreviewItemDTO[];
}
export type PreviewDTO = ObservationPreviewDTO;
export interface PreviewCommitGuardV1 {
  id: UUID;
  tokenHash: Hash;
  binding: {
    inputIdentity: InputIdentity;
    inputHash: Hash;
    bufferHandleHash: Hash;
    policyPinsHash: Hash;
    consentId?: UUID;
    privacyEpoch: number;
    callerId: string;
  };
  expiresAt: Timestamp;
  state: "READY" | "CONSUMED";
  idempotencyKey: UUID;
  receiptId?: UUID;
  contentHash: Hash;
}
export interface ObservationCommitDTO { token: PreviewToken }
export interface ObservationCommitReceipt {
  id: UUID;
  guardId: UUID;
  idempotencyKey: UUID;
  result: BatchResult<UUID>;
  cursor: Cursor;
  batchHash: Hash;
  committedAt: Timestamp;
}
export interface StoredRecord<T = JsonValue> {
  recordSchemaVersion: SchemaVersion;
  recordType: RecordType;
  recordId: UUID;
  writtenAt: Timestamp;
  payload: T;
  contentHash: Hash;
}
export interface UpcastReceipt {
  upcasterId: string;
  recordType: RecordType;
  recordId: UUID;
  fromVersion: SchemaVersion;
  toVersion: SchemaVersion;
  beforeHash: Hash;
  afterHash: Hash;
}
export interface UpcastResult { record: StoredRecord; receipt: UpcastReceipt }
export interface StoredRecordUpcaster {
  id: string;
  recordType: RecordType;
  fromVersion: SchemaVersion;
  toVersion: SchemaVersion;
  upcast(record: Readonly<StoredRecord>): DomainResult<UpcastResult>;
}
export interface MigrationRegistry {
  targetStorageSchemaVersion: SchemaVersion;
  targetExportSchemaVersion: SchemaVersion;
  upcasters: readonly StoredRecordUpcaster[];
  upcast(record: Readonly<StoredRecord>, target: SchemaVersion): DomainResult<UpcastResult>;
}
export interface StorageMigrationV1 {
  id: UUID;
  fromVersion: SchemaVersion;
  toVersion: SchemaVersion;
  state: "PREPARED" | "COPYING" | "VERIFIED" | "SWITCHED" | "ROLLED_BACK" | "FAILED";
  sourceRecordCount: number;
  migratedRecordCount: number;
  sourceHash: Hash;
  migratedHash?: Hash;
  sourceCursor: Cursor;
  switchCursor?: Cursor;
  rollbackOfMigrationId?: UUID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
export interface DomainSnapshot {
  schemaVersion: SchemaVersion;
  cursor: Cursor;
  privacyEpoch: number;
  records: readonly StoredRecord[];
  snapshotHash: Hash;
}
export interface EntityPageDTO { records: readonly StoredRecord[]; nextPageToken?: string; snapshotCursor: Cursor }
export interface ChangeRecordDTO { cursor: Cursor; recordType: RecordType; recordId: UUID; change: "put" | "delete"; contentHash?: Hash }
export interface ChangePageDTO { changes: readonly ChangeRecordDTO[]; nextCursor: Cursor; hasMore: boolean }
export interface ProjectionHeadDTO { projectionId: string; sourceCursor: Cursor; projectionHash: Hash; revision: number }
export type StoreName = "business" | "system" | "heads" | "ledger" | "journal" | "audit" | "projection" | "changes";
export type CanonicalMutation =
  | { kind: "insertImmutable"; storeName: "business" | "system" | "ledger" | "audit" | "changes"; record: StoredRecord }
  | { kind: "casSingleton"; storeName: "heads" | "system"; record: StoredRecord; expectedContentHash: Hash | null }
  | { kind: "deleteIfHash"; storeName: StoreName; recordId: UUID; expectedContentHash: Hash }
  | { kind: "casProjectionHead"; storeName: "projection"; expectedSourceCursor: Cursor; next: ProjectionHeadDTO };
export interface AtomicMutationBatch {
  idempotencyKey: UUID;
  expectedCursor: Cursor;
  expectedPrivacyEpoch: number;
  storeNames: readonly StoreName[];
  mutations: readonly CanonicalMutation[];
  batchHash: Hash;
}
export interface CommitLedger {
  id: UUID;
  idempotencyKey: UUID;
  batchHash: Hash;
  committedCursor: Cursor;
  affectedRefs: readonly { recordType: RecordType; recordId: UUID }[];
  committedAt: Timestamp;
}
export interface CommitResult { cursor: Cursor; applied: boolean; ledger: CommitLedger }
```

PreviewToken MUST 由至少 128-bit CSPRNG 产生，只向客户端返回原 token；持久 `PreviewCommitGuardV1` 仅存 tokenHash，不存 token 或 raw bytes。source bytes 只存在带 TTL 的短期 buffer；buffer 缺失必须返回 `ERR_PREVIEW_BUFFER_MISSING`，禁止从 PreviewDTO 重建。commit 重验 binding、expiry、policy/consent/epoch 与 buffer hash，并在同一 transaction 以 tokenHash CAS `READY -> CONSUMED`、执行 mutations、写 ObservationCommitReceipt 与 CommitLedger；任一步失败全部 abort。相同 idempotencyKey 返回同 receipt，第二个不同请求不得消费同 guard。
`CanonicalMutation` 只允许四个 tagged operation：immutable insert 遇已存在 key 必须失败；singleton 只能 CAS；删除必须校验 hash；projection head 必须校验 sourceCursor。禁止 generic put。`storeNames` MUST 是 mutation stores 的去重排序全集；batchHash 覆盖 cursor/epoch/storeNames/mutations。相同 idempotencyKey+hash 返回同 ledger，同 key 异 hash 返回 ERR_IDEMPOTENCY_CONFLICT。

### 5.4 Export、Runtime 与既有包装

```ts
export interface ExportManifestDTO { counts: Readonly<Partial<Record<RecordType, number>>>; highestClassification: DataClassification; recordsHash: Hash }
export interface ExportEnvelopeV1 {
  exportVersion: "1"; exportId: UUID; exportedAt: Timestamp; pins: VersionPins;
  sourceCursor: Cursor; records: readonly StoredRecord[]; manifest: ExportManifestDTO;
  notice: "LOCAL_FILE_CANNOT_BE_REMOTELY_REVOKED"; envelopeHash: Hash;
}
export interface ExportReceipt {
  id: UUID; exportId: UUID; sourceCursor: Cursor; envelopeHash: Hash;
  createdAt: Timestamp; state: "created" | "affected-by-later-deletion";
}
export interface ExportArtifact {
  mediaType: "application/json"; filename: string; utf8: string; envelopeHash: Hash;
}
export interface RuntimeRequest {
  requestId: UUID; correlationId: UUID; idempotencyKey: UUID; deadlineAt: Timestamp;
  task: { kind: "structured-evaluation"; input: JsonValue; requiredCapabilities: readonly string[] };
}
export interface RuntimeHandle { handleId: UUID; requestId: UUID; acceptedAt: Timestamp; deadlineAt: Timestamp }
export type RuntimeResult =
  | { status: "completed"; handle: RuntimeHandle; output: JsonValue; completedAt: Timestamp }
  | { status: "failed"; handle: RuntimeHandle; error: DomainError; completedAt: Timestamp }
  | { status: "cancelled" | "timed-out"; handle: RuntimeHandle; completedAt: Timestamp };
export interface RuntimeDescriptor { runtimeId: string; protocolVersion: string; capabilities: readonly string[] }
export interface ProvenanceEnvelope { evidence: EvidenceRef[]; pins: VersionPins; causedBy: EntityRef[]; contentHash: Hash }
export interface StoredEntity<T extends { id: UUID }> {
  state: "live";
  payload: T;
  contentHash: Hash;
  retentionPolicyId: UUID;
  retentionBasis: "session" | "consent" | "user-setting";
  expiresAt?: Timestamp;
}
export interface RetentionPolicy { id: UUID; sourceKind: SourceRef["kind"]; eventTtlDays: number; derivedTtlDays: number; expiresAt?: Timestamp; policyVersion: string }
export interface ConsentGrant {
  id: UUID; source: Omit<Extract<SourceRef, { kind: "readonly-adapter" }>, "consentId">;
  allowedFields: string[]; purpose: string; retentionPolicyId: UUID; policyVersion: string; grantedAt: Timestamp;
}
export interface ConsentRevocation { id: UUID; consentId: UUID; revokedAt: Timestamp; reason: "user" | "policy" | "expiry"; privacyEpochAfter: number }
export interface UntrustedUserText { value: string; trust: "untrusted-user"; classification: DataClassification }
```

Grant 与 Revocation 均不可变，Grant 不含后写 `revokedAt`。`StoredEntity` 只包装 live 业务 payload；删除 marker 使用 §9 独立随机 `DeletionTombstone`，不得占用原 entity key。Export envelope 平台中立，Web adapter 才下载。Runtime 禁止 `unknown` result，M1 MUST NOT 实例化 RuntimePort。`Scope` 至少含 projectKey/activityKind；validUntil 晚于 validFrom。pin 数组按规范字段排序且 ID 唯一。M1 retention 为测试期或用户清除；M2 readonly 默认 event 7 天、derived 30 天；撤权/到期复用删除路径，PRIVATE 不暂停 TTL。

### 5.5 NDJSON V1、Worker 与 ImportSession DTO

```ts
export interface NdjsonHeaderV1 {
  lineType: "header";
  format: "proagi-behavior-events";
  formatVersion: "1";
  schemaVersion: SchemaVersion;
  inputIdentity: InputIdentity;
  declaredEventCount: number;
}
export interface NdjsonEventV1 {
  lineType: "event";
  sequence: Cursor;
  event: {
    sourceItemKey: string;
    occurredAt: Timestamp;
    kind: EventKind;
    subject: { appId: EventAttributes["appId"]; projectKey?: string };
    attributes: EventAttributes;
  };
}
export interface NdjsonFooterV1 { lineType: "footer"; eventCount: number; orderedEventsHash: Hash }
export type NdjsonLineV1 = NdjsonHeaderV1 | NdjsonEventV1 | NdjsonFooterV1;
export interface ValidatedEventCandidateDTO { sequence: Cursor; event: NdjsonEventV1["event"] }
export interface WorkerInitMessage { type: "INIT"; streamId: UUID; header: NdjsonHeaderV1; maxChunkBytes: number; maxUnacked: 2; decoder: "utf-8-fatal-stream-v1" }
export interface WorkerChunkMessage { type: "CHUNK"; streamId: UUID; chunkId: UUID; sequence: Cursor; bytes: ArrayBuffer; byteLength: number }
export interface WorkerValidatedMessage {
  type: "VALIDATED";
  streamId: UUID;
  chunkId: UUID;
  sequence: Cursor;
  candidates: readonly ValidatedEventCandidateDTO[];
  rejected: readonly BatchItemError[];
  workerBytesHash: Hash;
}
export interface WorkerAckMessage { type: "ACK"; streamId: UUID; chunkId: UUID; sequence: Cursor }
export interface WorkerCancelMessage { type: "CANCEL"; streamId: UUID; requestedAt: Timestamp }
export interface WorkerValidationReceipt {
  streamId: UUID;
  state: "validated" | "cancelled" | "failed";
  rawChunkBytes: number;
  declaredEventCount: number;
  validatedEventCount: number;
  rejectedEventCount: number;
  orderedWorkerBytesHash?: Hash;
  errorCode?: ErrorCode;
}
export interface WorkerCompleteMessage { type: "COMPLETE"; streamId: UUID; receipt: WorkerValidationReceipt }
export type WorkerStreamMessage = WorkerInitMessage | WorkerChunkMessage | WorkerValidatedMessage | WorkerAckMessage | WorkerCancelMessage | WorkerCompleteMessage;
export interface ImportSession {
  id: UUID;
  streamId: UUID;
  inputIdentity: InputIdentity;
  state: "RECEIVING" | "VALIDATED" | "COMMITTING" | "PUBLISHED" | "CANCELLED" | "FAILED";
  baseCursor: Cursor;
  privacyEpoch: number;
  committedBatchHashes: readonly Hash[];
  committedEventCount: number;
  publishedCursor?: Cursor;
  updatedAt: Timestamp;
}
export interface AppImportCommitReceipt {
  sessionId: UUID;
  state: "published" | "cancelled" | "failed";
  appInputHash: Hash;
  appCanonicalEventsHash: Hash;
  committedBatchHashes: readonly Hash[];
  committedEventCount: number;
  publishedCursor?: Cursor;
  errorCode?: ErrorCode;
}
export interface ImportStreamReceipt { worker: WorkerValidationReceipt; app: AppImportCommitReceipt }
export interface ImportStreamController {
  handle: ImportStreamHandle;
  cancel(correlationId: UUID): Promise<DomainResult<ImportStreamReceipt>>;
  dispose(): void;
}
```

### 5.6 UI Contract DTO

```ts
export type SrgbHex = `#${string}`;
export const SRGB_HEX_RUNTIME_PATTERN = "^#[0-9A-F]{6}$" as const;
export declare function isSrgbHex(value: string): value is SrgbHex;
export type OrbState = "LEARNING" | "EXECUTING" | "IDLE" | "SUGGESTION" | "ERROR" | "PRIVATE";
export type DomainPresentationState = "idle" | "learning" | "processing" | "suggestion" | "error";
export type UiViewportClass = "compact-360" | "medium-768" | "wide-1280";

export interface VisualContractV1 {
  version: "visual-contract-v1";
  referenceAsset: "reference/Prototype reference1.png";
  referenceRole: "mood-board-only";
  canonicalBrand: "ProAGI Assistant";
  legacyBrandingMustNotRender: readonly ["ProAGIAgent", "智图灵助手"];
  approvedVisualLanguage: readonly [
    "warm-white-canvas", "ink-heading", "blue-accent", "thin-gray-divider",
    "glass-liquid-orb", "grouped-cards", "low-and-active-orb-scale"
  ];
  prohibitedCapabilityInference: readonly [
    "pointer-tracking", "pointer-intent", "ocr", "screen-capture",
    "email-or-task-write", "live-action", "uia-connected", "runtime-connected"
  ];
}

export interface VisualTokenV1 {
  version: "visual-token-v1";
  color: {
    canvasWarm: "#F7F5EF";
    surface: "#FFFFFF";
    ink: "#111827";
    inkMuted: "#475569";
    accentBlue: "#1677FF";
    border: "#D7DCE3";
    focus: "#005FCC";
  };
  stateColor: {
    LEARNING: "#1473E6";
    EXECUTING: "#2F8F3A";
    IDLE: "#7C3AED";
    SUGGESTION: "#C77800";
    ERROR: "#C62828";
    PRIVATE: "#5F6B7A";
  };
  borderWidthPx: { subtle: 1; strong: 2; focus: 3 };
  radiusPx: { card: 12; panel: 16; pill: 999 };
  focusStyle: { color: "#005FCC"; widthPx: 3; offsetPx: 2; forcedColors: "2px solid Highlight" };
  forcedColors: {
    canvas: "Canvas"; text: "CanvasText"; border: "ButtonText";
    focus: "Highlight"; selected: "Highlight"; selectedText: "HighlightText";
  };
}

export type OrbPart =
  | "shell" | "rim" | "fluid" | "highlight-primary" | "highlight-secondary"
  | "base-halo" | "shadow" | "icon-lock";
export interface OrbAnatomyV1 {
  version: "orb-anatomy-v1";
  layerGroups: readonly ["shell", "rim", "fluid", "highlights", "base-halo", "shadow", "icon-lock"];
  requiredParts: readonly [
    "shell", "rim", "fluid", "highlight-primary", "highlight-secondary",
    "base-halo", "shadow", "icon-lock"
  ];
  semanticPart: "icon-lock";
  iconLockRule: "PRIVATE renders lock; other states render fixed state icon";
  decorativePartsHiddenFromAccessibilityTree: true;
  lowAttentionDiameterPx: 26;
  activeDiameterPx: 96;
}

export interface MotionTokenV1 {
  version: "motion-token-v1";
  transitionMs: { fast: 120; standard: 180; panel: 220 };
  easing: { standard: "cubic-bezier(0.2,0,0,1)"; emphasized: "cubic-bezier(0.2,0,0,1.2)" };
  state: {
    LEARNING: { name: "slow-fluid"; durationMs: 8000; iteration: "infinite" };
    EXECUTING: { name: "progress-flow"; durationMs: 1200; iteration: "infinite" };
    IDLE: { name: "breath"; durationMs: 3200; iteration: "infinite" };
    SUGGESTION: { name: "single-nudge"; durationMs: 240; iteration: 1 };
    ERROR: { name: "ring-pulse"; durationMs: 900; iteration: 2 };
    PRIVATE: { name: "none"; durationMs: 0; iteration: 0 };
  };
  reduced: {
    animation: "none";
    transform: "none";
    parallax: "none";
    smoothScroll: "auto";
    skeletonMovement: "none";
    allowedOpacityMs: 120;
  };
}

export type AppShellRegion =
  | "skip-link" | "global-status-privacy" | "today-header" | "observed"
  | "learned" | "correction-impact" | "insight-inbox" | "replay"
  | "detail-drawer" | "orb-dock";
export interface AppShellV1 {
  version: "app-shell-v1";
  firstScreenOrder: readonly [
    "skip-link", "global-status-privacy", "today-header", "observed",
    "learned", "correction-impact", "insight-inbox", "replay"
  ];
  secondaryRegion: "detail-drawer";
  persistentRegion: "orb-dock";
  landmarks: readonly ["header", "nav", "main", "aside"];
  visibleTodayAction: true;
}

export interface LayoutContractV1 {
  version: "layout-contract-v1";
  breakpointsCssPx: { compact: 360; medium: 768; wide: 1280 };
  compact: { minSupportedWidthPx: 320; columns: 1; drawer: "modal-full-width"; orbDock: "bottom-safe-area" };
  medium: { columns: 2; drawer: "modal-or-side"; orbDock: "right-safe-area" };
  wide: { columns: 12; observedSpan: 3; learnedSpan: 5; inboxSpan: 4; drawer: "right-side"; orbDock: "right-safe-area" };
  reflow200Percent: "at-1280-css-viewport behaves as <=640px single-column without two-dimensional scrolling";
  horizontalScrollAllowedOnlyFor: readonly ["code-sample"];
}

export type RecoveryBannerKey = "recovery-required" | "clear-only" | "private-active" | "storage-blocked";
export interface PresentationResolverInput {
  recoveryMode: RecoveryMode;
  observationMode: StoreMeta["observationMode"];
  domainState: DomainPresentationState;
}
export interface PresentationResolverOutput {
  orbState: OrbState;
  persistentBanners: readonly RecoveryBannerKey[];
  substateKey?: "fenced" | "deleting" | "purge-pending" | "auditing" | "finalizing" | "failed" | "blocked";
}
export type PresentationStateResolver = (input: Readonly<PresentationResolverInput>) => PresentationResolverOutput;

export type EmptyStateKey =
  | "first-run" | "eligible-abstain" | "import-all-rejected" | "after-clear"
  | "no-filter-results" | "no-insights" | "projection-load-failed";
export interface EmptyStateContract {
  key: EmptyStateKey;
  titleKey: string;
  bodyKey: string;
  reasonCodeVisible: boolean;
  countFields: readonly ("accepted" | "rejected" | "evidence")[];
  primaryAction: "choose-fixture" | "review-rejections" | "clear-filter" | "retry-load" | "none";
  mustNotSynthesizeEntity: true;
}
export declare const EMPTY_STATE_REGISTRY: Readonly<Record<EmptyStateKey, EmptyStateContract>>;

export type ProjectionPresentationState =
  | { kind: "loading" }
  | { kind: "current"; sourceCursor: Cursor }
  | { kind: "stale"; shownCursor: Cursor; latestCursor: Cursor }
  | { kind: "rebuilding"; shownCursor: Cursor; targetCursor: Cursor; progressPercent?: number }
  | { kind: "failed"; shownCursor?: Cursor; errorCode: ErrorCode };

export type RecoveryAction = "retry" | "resume-recovery" | "close-other-clients" | "free-space" | "clear-all" | "download-diagnostics";
export interface RecoverySurface {
  mode: Exclude<RecoveryMode, "NORMAL">;
  role: "region";
  labelledBy: string;
  statusRole: "status" | "alert";
  titleKey: string;
  bodyKey: string;
  actions: readonly RecoveryAction[];
  initialFocus: "heading";
  returnFocus: "invoker-or-global-status";
  persistent: true;
}

export interface UiErrorContract {
  code: ErrorCode;
  titleKey: string;
  bodyKey: string;
  surface: "inline" | "banner" | "dialog" | "blocking-page";
  announcement: "none" | "polite" | "assertive-once";
  primaryAction: ErrorPolicy["nextAction"];
  dismissible: boolean;
  retainUserInput: boolean;
  focusTarget: "field" | "error-summary" | "dialog-heading" | "global-status";
}
export declare const UI_ERROR_REGISTRY: Readonly<Record<ErrorCode, UiErrorContract>>;

export type UiAnnouncementKey =
  | "import-stage" | "import-progress-10-percent" | "import-complete"
  | "correction-saved" | "projection-stale" | "projection-current"
  | "private-entered" | "private-exited" | "recovery-required" | "error-once";
export interface UiAnnouncementContract {
  key: UiAnnouncementKey;
  priority: "polite" | "assertive";
  dedupeWindowMs: number;
  fixedMessageKey: string;
  mayIncludeOnly: readonly ("coarseSourceLabel" | "percent" | "acceptedCount" | "rejectedCount")[];
}
export declare const UI_ANNOUNCEMENT_REGISTRY: Readonly<Record<UiAnnouncementKey, UiAnnouncementContract>>;

export type CoarseSourceLabel = "测试事件" | "本地 JSON" | "只读来源" | "来源已暂停" | "来源不可用";
export interface SizeProfileV1 {
  id: "size-profile-v1";
  rawChunkBytes: { max: 262144 };
  canonicalMutationBytes: { max: 4194304 };
  estimatedStorageBytes: { warning: 83886080; rejectNormalWrites: 104857600; recoveryReserve: 5242880 };
}
export type ForbiddenBrowserEffectSink =
  | "fetch" | "xhr" | "websocket" | "eventsource" | "beacon"
  | "navigation" | "window-open" | "download" | "clipboard" | "web-share"
  | "service-worker" | "worker-bridge" | "custom-scheme";
export interface ForbiddenBrowserEffectSinkRegistryV1 {
  version: "forbidden-browser-effect-sinks-v1";
  sinks: Readonly<Record<ForbiddenBrowserEffectSink, "deny-from-shadow-root">>;
}
export interface ShadowPreviewDTO {
  intentRevisionId: UUID;
  mode: "shadow";
  summary: string;
  preconditions: readonly string[];
  hypotheticalSteps: readonly { order: number; description: string; effect: string }[];
  expectedEffects: readonly string[];
  forbiddenEffects: readonly ForbiddenBrowserEffectSink[];
  rendererRootId: "shadow-preview-root";
}
export type TestArtifactSink = "screenshot" | "video" | "har" | "trace" | "reporter" | "console" | "source-map" | "ci-upload";
export interface TestArtifactSinkPolicy {
  sink: TestArtifactSink;
  scanBeforeWrite: true;
  isolated: true;
  ttlDays: 14 | 90;
  disposeRequired: true;
}
export interface ArtifactDisposalReceipt { id: UUID; sink: TestArtifactSink; disposedAt: Timestamp; artifactCount: number; remainingCanaryCount: 0 }
export interface TestArtifactSinkRegistryV1 { version: "test-artifact-sinks-v1"; policies: Readonly<Record<TestArtifactSink, TestArtifactSinkPolicy>> }
export interface UiIntentCommand {
  commandId: UUID;
  correlationId: UUID;
  idempotencyKey: UUID;
  intentKey: string;
  kind: "import" | "correct" | "delete" | "export" | "replay" | "privacy-change" | "recover" | "retry-purge" | "clear" | "move-orb";
  baseCursor: Cursor;
  privacyEpoch: number;
  submittedAt: Timestamp;
}
```

`OrbAnatomyV1` 的七个 layer group 中，`highlights` 由 `highlight-primary` 与 `highlight-secondary` 两个必需结构 part 组成；结构门禁因此检查八个 `data-orb-part`，但语义上仍为七层。UI registry 均 MUST 用 `satisfies Readonly<Record<...>>` 保证无缺项、无私有 key。

## 6. 字段级 Schema 与状态机

### 6.1 BehaviorEvent

```ts
export type EventKind =
  | "app.focus" | "file.changed" | "terminal.completed" | "git.changed" | "test.completed";
export type EventAttributes = {
  projectKey?: string;
  appId?: "vscode" | "cursor" | "terminal" | "browser" | "git" | "other";
  fileExt?: string;
  operation?: "open" | "modify" | "create" | "rename";
  commandClass?: "build" | "test" | "lint" | "git" | "package" | "other";
  exitCode?: number;
  branchHash?: Hash;
  testOutcome?: "passed" | "failed" | "skipped";
  durationMs?: number;
};
export interface PrivacyDecision {
  classification: "public" | "local-sensitive";
  policyVersion: string;
  redactionCount: number;
  exportPolicy: "allowed" | "explicit-confirmation";
  retentionClass: "session" | "short";
}
export interface BehaviorEvent {
  schemaVersion: SchemaVersion;
  id: UUID;
  occurredAt: Timestamp;
  ingestedAt: Timestamp;
  source: SourceRef;
  kind: EventKind;
  subject: { appId: EventAttributes["appId"]; projectKey?: string };
  attributes: EventAttributes;
  privacy: PrivacyDecision;
  correlationId?: UUID;
  dedupeKey: Hash;
  factHash: Hash;
  provenanceHash: Hash;
  contentHash: Hash;
}
```
`occurredAt` MUST 不晚于 `ingestedAt + 5min`。`dedupeKey` MUST 由版本化算法覆盖 source kind、adapter ID/version、source-stable item key 与 source identity；它只消除同一来源重试，存储层 MUST 建 unique index。`factHash` 只覆盖 occurredAt/kind/规范化 subject/attributes，MUST 为 non-unique；Replay MAY 以它合并等价事实，但 MUST 保留每个不同 `dedupeKey` 的 provenance。`provenanceHash` 覆盖 dedupeKey+factHash+SourceRef+PrivacyDecision；`contentHash` 覆盖完整 live entity。四个 hash 均排除 id、ingestedAt、correlationId 和存储状态。
相同 `dedupeKey` 且 contentHash 相同 MUST 幂等回读原 live ID；同 key 异 hash 返回 `ERR_DUPLICATE_CONFLICT`。不同来源即使 factHash 相同也 MUST 分别保存，禁止以 factHash 唯一约束吞掉第二来源证据。删除只物理移除 live payload并写独立 tombstone。
MUST NOT 持久化空字段、原命令、文件路径、窗口标题、URL、正文、键击、剪贴板或像素。restricted 输入仅可在内存预览后拒绝/脱敏；prohibited 必须拒绝，均不得降级保存。

### 6.2 EvidenceRef

```ts
export type ImmutableEvidenceTargetType =
  | "behavior_event" | "episode" | "work_model_claim" | "correction_record"
  | "knowledge_version" | "question" | "skill_candidate" | "evaluation_result" | "action_intent";
export interface EvidenceRef {
  id: UUID;
  entityType: ImmutableEvidenceTargetType;
  entityId: UUID;
  entityHash: Hash;
  transform: { name: string; version: string; inputHash: Hash };
  role: "support" | "counter" | "lineage";
}
```
EvidenceRef 本身不可变，且只能指向不可变的 BehaviorEvent、final Episode、WorkModelClaim revision、terminal CorrectionRecord、KnowledgeVersion、Question/SkillCandidate/ActionIntent revision 或 terminal EvaluationResult；MUST NOT 指向任何 head、draft、运行中对象或可重建投影。
`entityHash` MUST 在引用创建与读取时校验；状态变化通过新 revision 和新 EvidenceRef 表达，禁止刷新旧引用。目标删除时旧引用随引用者处理，不得把 EvidenceRef 原地改成 tombstoned。

### 6.3 Episode

```ts
export interface Episode {
  schemaVersion: SchemaVersion;
  id: UUID;
  startAt: Timestamp;
  endAt: Timestamp;
  title: string;
  projectKey?: string;
  activityKind: Scope["activityKind"];
  eventIds: UUID[];
  evidence: EvidenceRef[];
  confidence: Confidence;
  segmentationVersion: string;
  status: "draft" | "final";
  contentHash: Hash;
}
```
状态机：`draft -> final`；final 内容 MUST 不可变。隐私删除不进入 payload 状态机，只物理移除 live entity 并写独立 tombstone。
`eventIds` 的引用可含 UUIDv7，但排序 MUST 复用 `compareBehaviorEventV1=(occurredAt,kind,factHash,dedupeKey,contentHash)`；随机 id 永不参与语义顺序或 hash。eventIds 至少 1 项，边界等于首末事件时间。
跨项目事件 SHOULD 分段；相邻事件间隔 `>30min` MUST 分段；规则相同则结果 MUST 确定。

### 6.4 WorkModelClaim（不可变 revision）

```ts
export type ClaimStatus = "proposed" | "confirmed" | "rejected" | "invalidated";
export interface WorkModelClaim extends ProvenanceEnvelope {
  schemaVersion: SchemaVersion;
  id: UUID;                 // 每个 revision 的唯一 ID
  claimKey: string;         // 同一逻辑 claim 的稳定身份
  semanticKey: string;      // ruleFamilyId + predicateId + normalizedScope
  predicateId: string;      // 结构化规则谓词；statement 只是展示
  parentRevisionId?: UUID;
  revision: number;
  statement: string;
  scope: Scope;
  confidence: Confidence;
  counterEvidence: EvidenceRef[];
  status: ClaimStatus;
  createdAt: Timestamp;
}
```
每个 WorkModelClaim 记录本身就是不可变 revision；不存在原地状态迁移。accept/edit/reject/restore 追加新 revision；privacy delete 物理移除整个 lineage 的 live payload并仅写 tombstone，不创建含 statement/evidence 的 deleted revision。
statement MUST 为 1–500 字符；proposed/confirmed revision 的 evidence MUST 非空；support 与 counter 引用不得重叠。
`semanticKey` MUST 由版本化结构字段计算，M1 禁止用自由文本 embedding 或模型相似度决定 reject 抑制。

### 6.5 CorrectionCommand / CorrectionRecord

```ts
export type JsonPatch =
  | { op: "replace"; path: "/statement"; value: string }
  | { op: "replace"; path: "/scope"; value: Scope }
  | { op: "replace"; path: "/predicateId"; value: string }
  | { op: "add" | "remove"; path: "/evidence"; value: UUID };
export interface CorrectionCommand {
  commandId: UUID;
  targetClaimKey: string;
  baseRevisionId: UUID;
  action: "accept" | "edit" | "reject" | "delete" | "restore";
  restoreFromRevisionId?: UUID;
  patch: readonly JsonPatch[];
  reason?: UntrustedUserText;
  submittedAt: Timestamp;
}
export interface CorrectionRecord {
  schemaVersion: SchemaVersion;
  id: UUID;
  commandId: UUID;
  targetClaimKey: string;
  baseRevisionId: UUID;
  action: CorrectionCommand["action"];
  appliedPatch: readonly JsonPatch[];
  reason?: UntrustedUserText;
  completedAt: Timestamp;
  status: "applied" | "failed";
  resultClaimRevisionId?: UUID;
  resultKnowledgeVersionId?: UUID;
  errorCode?: ErrorCode;
  contentHash: Hash;
}
```
`CorrectionCommand` 是瞬时 inbound DTO，不持久化；`CorrectionRecord` 创建时已终态、append-only 且永不原地修改，不存在持久 pending。CorrectionRecord.contentHash 由 targetClaimKey、base/result claim contentHash、result knowledge contentHash、action、规范化 patch/reason、status/errorCode 计算，排除 id/commandId、各 UUIDv7 引用值和 submitted/completed 时间。
accept/reject/delete 的 patch MUST 为空；edit 至少含一个允许路径；restore 仅提供 restoreFromRevisionId。accept/edit/reject/restore 成功时产生新 Claim revision；delete 只产生终态 record、DeletionJournal 与无 payload tombstone。
restoreFromRevisionId 只能指向仍 live 的历史 revision；已删 lineage 返回 `ERR_DELETED_RESTORE_FORBIDDEN`。`baseRevisionId` 非当前 head 返回 `ERR_REVISION_CONFLICT`，禁止 last-write-wins。

### 6.6 KnowledgeVersion / KnowledgeHead

```ts
export interface KnowledgeVersion {
  schemaVersion: SchemaVersion;
  id: UUID;
  knowledgeKey: string;
  version: number;
  claimRevisionId: UUID;
  basedOnVersionId?: UUID;
  causedByCorrectionId: UUID;
  createdAt: Timestamp;
  contentHash: Hash;
}
export interface KnowledgeHead {
  schemaVersion: SchemaVersion;
  id: UUID;
  knowledgeKey: string;
  versionId: UUID;
  version: number;
  updatedAt: Timestamp;
  contentHash: Hash;
}
```
KnowledgeVersion 是不可变 append-only record，只引用不可变 Claim revision，不复制 statement/scope/evidence，且 MUST NOT 含 current/superseded/status。`version` 从 1 连续递增，basedOnVersionId 指向同 key 前一版本且无环。其 contentHash 覆盖 knowledgeKey/version 与被引用 claim、previous version、CorrectionRecord 的 contentHash，排除自身/引用 UUIDv7 和 createdAt；KnowledgeHead.contentHash 同理覆盖 key/version/versionContentHash，排除 id/versionId/updatedAt。
每个 knowledgeKey 恰有零或一个 KnowledgeHead。切换当前版本 MUST 在 `AtomicMutationBatch` 中以 `CanonicalMutation.casSingleton.expectedContentHash` 对旧 head 做 CAS，并与新 KnowledgeVersion 原子提交；CAS 失败返回 `ERR_REVISION_CONFLICT`，禁止修改旧 version。
reject 追加 rejected Claim revision，并以 semanticKey 创建确定性抑制知识版本；restore 只能从仍 live 的历史 revision 创建新 KnowledgeVersion 并 CAS head。删除语义留给 §9，本节不定义删除执行流程。

### 6.7 DailyReportSnapshot（可重建投影）

```ts
export interface DailyReportSnapshot {
  schemaVersion: SchemaVersion;
  id: UUID;
  sourceCursor: string;
  projectionVersion: string;
  localDate: string;
  timezone: string;
  episodeIds: UUID[];
  sections: {
    work: { episodeId: UUID; summary: string }[];
    learnedClaimIds: UUID[];
    questionIds: UUID[];
    skillCandidateIds: UUID[];
    correctionImpact: { correctionId: UUID; beforeHash: Hash; afterHash: Hash }[];
  };
  evidence: EvidenceRef[];
  generatedAt: Timestamp;
  status: "draft" | "published" | "stale";
  contentHash: Hash;
}
```
DailyReportSnapshot 不是 canonical truth；它是可丢弃缓存，由 BehaviorEvent、Claim revision、CorrectionRecord 与 KnowledgeHead 确定性重建。
状态机：`draft -> published`；`published -> stale`；`stale -> published`。localDate MUST 为 `YYYY-MM-DD`。
来源删除后缓存 MUST 进入 stale；重建使用确定性 semanticId/contentHash 并移除不可达内容。投影损坏不得反向覆盖 canonical store。

### 6.8 WorkflowHead / Question revision

```ts
export type WorkflowEntityType = "question" | "skill_candidate" | "action_intent";
export interface WorkflowHead {
  schemaVersion: SchemaVersion;
  id: UUID;
  workflowType: WorkflowEntityType;
  workflowKey: string;
  revisionId: UUID;
  revision: number;
  updatedAt: Timestamp;
  contentHash: Hash;
}
export interface Question extends ProvenanceEnvelope {
  schemaVersion: SchemaVersion;
  id: UUID;
  workflowKey: string;
  parentRevisionId?: UUID;
  revision: number;
  prompt: string;
  gapType: "intent" | "workflow" | "preference" | "context" | "error";
  scope: Scope;
  evidence: EvidenceRef[];
  expectedInformationGain: Confidence;
  createdAt: Timestamp;
  answeredAt?: Timestamp;
  answer?: { choice?: string; text?: string };
  status: "queued" | "shown" | "answered" | "skipped" | "expired";
}
```
Question 每条记录均为不可变 revision。允许的 head 状态路径是 `queued -> shown|expired`、`shown -> answered|skipped|expired`；每次转换 MUST 追加 `revision+1`、设置 parentRevisionId，并以旧 WorkflowHead contentHash 做 CAS 后指向新 revision，禁止原地改 status/answer/answeredAt。首 revision 的 parent 缺失且 revision=1；终态不得再追加状态转换。
prompt 为 1–300 字符；answer/answeredAt 仅 answered revision 存在；回答经推断与冲突检查，不能直接成为事实。首切片每日报告至多生成 1 个问题。

### 6.9 SkillCandidate revision

```ts
export interface SkillCandidate extends ProvenanceEnvelope {
  schemaVersion: SchemaVersion;
  id: UUID;
  workflowKey: string;
  parentRevisionId?: UUID;
  revision: number;
  name: string;
  purpose: string;
  triggerSummary: string;
  inputNames: string[];
  outputNames: string[];
  evidence: EvidenceRef[];
  estimatedBenefitMinutes: number;
  risk: "low" | "moderate" | "high" | "critical";
  confidence: Confidence;
  actionIntentRevisionId: UUID;
  status: "proposed" | "shadow_ready" | "shadow_evaluated" | "dismissed";
}
```
允许的 head 状态路径是 `proposed -> shadow_ready|dismissed`、`shadow_ready -> shadow_evaluated|dismissed`。每次变化 MUST 追加不可变 revision 并 CAS 对应 WorkflowHead；禁止原地改 status 或任何业务字段。首切片不得出现 active/approved/executing。
evidence MUST 非空；actionIntentRevisionId MUST 指向同候选产生的、mode=shadow 的不可变 ActionIntent revision。不同 workflowKey 不得共享 head。

### 6.10 EvaluationRun / EvaluationResult / InvalidationReceipt

```ts
export interface EvaluationRun {
  runId: UUID;
  inputIdentity: InputIdentity;
  startedAt: Timestamp;
  status: "running";
}
export interface EvaluationResult extends ProvenanceEnvelope {
  schemaVersion: SchemaVersion;
  id: UUID;
  inputIdentity: InputIdentity;
  runId: UUID;
  pins: VersionPins;
  knowledgeVersionIds: UUID[];
  inputHash: Hash;
  outputHash: Hash;
  assertions: { id: string; passed: boolean; expected: JsonValue; actual: JsonValue }[];
  metrics: {
    correctionAbsorbed: boolean;
    localityPreserved: boolean;
    deletedPayloadReachable: boolean;
  };
  failureCodes: ErrorCode[];
  startedAt: Timestamp;
  completedAt: Timestamp;
  status: "passed" | "failed";
}
export interface EvaluationInvalidationReceipt {
  id: UUID;
  marker: "evaluation-invalidated";
  invalidatedAt: Timestamp;
  reason: "SOURCE_DELETED" | "PIN_REVOKED" | "PROVENANCE_BROKEN";
}
```
`EvaluationRun` 仅存在于内存，running 不得持久化。持久 EvaluationResult 创建时必须直接为 passed 或 failed，之后不可变；passed 要求全部 assertions 通过、correctionAbsorbed/localityPreserved=true 且 deletedPayloadReachable=false。
源删除时 MUST 物理移除关联旧 EvaluationResult payload，并追加 `EvaluationInvalidationReceipt`。receipt.id MUST 为随机 UUIDv7；receipt 只能含上列四字段，MUST NOT 含 result/run/entity ID、inputHash、outputHash、evidence、contentHash、fixture、canary 或任何内容派生标识，因此不能指回旧 payload。
Evaluator MUST 断言最终领域状态，不得以 toast、文案或点击轨迹作为成功依据。

### 6.11 ActionIntent revision

```ts
export interface ActionIntent extends ProvenanceEnvelope {
  schemaVersion: SchemaVersion;
  id: UUID;
  workflowKey: string;
  parentRevisionId?: UUID;
  revision: number;
  skillCandidateRevisionId: UUID;
  mode: "shadow";
  summary: string;
  preconditions: string[];
  hypotheticalSteps: { order: number; description: string; effect: string }[];
  expectedEffects: string[];
  forbiddenEffects: ("input-injection" | "filesystem-write" | "network" | "process-exec")[];
  createdAt: Timestamp;
  status: "draft" | "previewed" | "evaluated" | "dismissed";
}
```
允许的 head 状态路径是 `draft -> previewed|dismissed`、`previewed -> evaluated|dismissed`。每次变化 MUST 追加不可变 revision 并 CAS 对应 WorkflowHead；禁止原地改 status。skillCandidateRevisionId 必须指向不可变 SkillCandidate revision。
`mode` MUST 恒为 shadow；forbiddenEffects MUST 完整包含四项。M1 UI 只使用“预览建议”；点击通过新 revision 进入 previewed，绝不调用外部 adapter，也不得出现“执行/运行/应用技能”文案。
Question、SkillCandidate 与 ActionIntent 的 head CAS MUST 与新 revision 在同一 AtomicMutationBatch 提交；head 的 workflowType/workflowKey 必须匹配 revision，revision 序号连续，parentRevisionId 必须等于旧 head.revisionId。

## 7. 全局不变量

- INV-001：所有实际产出的 Claim、Report、Question、SkillCandidate、ActionIntent 与 EvaluationResult MUST 满足按实体类型定义的 provenance 字段；未产出时不得伪造对象凑数。
- INV-002：同 fixture、pins、知识版本集合的 canonical output hash MUST 完全一致。
- INV-003：edit 后预注册 eligible 的相邻同 scope Replay MUST 吸收结构化 predicate/statement/scope 修订。
- INV-004：reject 的同 `semanticKey` 候选 MUST 被抑制；delete 的 payload MUST 不复活。
- INV-005：Correction Locality：目标 scope 外 canonical 结果 MUST 字节级不变。
- INV-006：未列入 allowlist 的持久化字段数 MUST 为 0。
- INV-007：raw screenshot at rest MUST 为 0 bytes；从 ActionPort/ShadowPreview 调用图可达的未授权外部网络、process、OS filesystem、输入注入调用 MUST 为 0。canonical IndexedDB 与用户显式 `projection.export` 下载不属于 Action 副作用。
- INV-008：provenance MUST 无断链、无环、无跨 fixture/user 引用；篡改 MUST 被检出。
- INV-009：派生对象不得引用 deleted 实体；tombstone 不得保留 payload。
- INV-010：UI 投影不得成为 source of truth；刷新后 MUST 从 canonical store 重建。
- INV-011：ClaimSemanticValidity：每个 rule family 的独立 gold MUST 验证 predicate、scope 与 evidence entailment；常量 claim、错误 scope 和“证据存在但不支持结论”负控 MUST 失败。

### 7.1 Port 方向与平台中立方法契约

```ts
export interface PrivacyControlReceipt { observationMode: StoreMeta["observationMode"]; privacyEpoch: number; cursor: Cursor }
export interface RecoveryControlReceipt { recoveryMode: RecoveryMode; journalState?: ActiveDeletionJournal["state"]; cursor: Cursor }
export interface ReplayEvaluationCommand {
  inputIdentity: InputIdentity;
  asOf: Timestamp;
  timezone: string;
  locale: string;
  clockSeed: Hash;
  pins: VersionPins;
}
export interface ReplayEvaluationReceipt {
  replayKey: ReplayKeyV1;
  snapshotHash: Hash;
  evaluationResult: EvaluationResult;
  committedCursor: Cursor;
}
// inbound use-case ports：由 UI/CLI 调用 application
export interface ObservationPort {
  preview(ctx: PortRequestContext, input: ObservationInputDTO): Promise<DomainResult<ObservationPreviewDTO>>;
  commit(ctx: PortRequestContext, request: ObservationCommitDTO): Promise<DomainResult<ObservationCommitReceipt>>;
}
export interface CorrectionPort {
  submit(ctx: PortRequestContext, command: CorrectionCommand): Promise<DomainResult<CorrectionRecord>>;
}
export interface ControlPort {
  pausePrivacy(ctx: PortRequestContext): Promise<DomainResult<PrivacyControlReceipt>>;
  resumePrivacy(ctx: PortRequestContext): Promise<DomainResult<PrivacyControlReceipt>>;
  revokeConsent(ctx: PortRequestContext, revocation: ConsentRevocation): Promise<DomainResult<PrivacyControlReceipt>>;
  recover(ctx: PortRequestContext): Promise<DomainResult<RecoveryControlReceipt>>;
  retryPurge(ctx: PortRequestContext, deletionId: UUID): Promise<DomainResult<RecoveryControlReceipt>>;
  clear(ctx: PortRequestContext): Promise<DomainResult<ClearAllResult>>;
  evaluateReplay(ctx: PortRequestContext, command: ReplayEvaluationCommand): Promise<DomainResult<ReplayEvaluationReceipt>>;
  export(ctx: PortRequestContext): Promise<DomainResult<ExportEnvelopeV1>>;
}

// outbound driven ports：由 application 调用 adapter
export interface KnowledgePort {
  loadSnapshot(ctx: PortRequestContext): Promise<DomainResult<DomainSnapshot>>;
  scanEntities(ctx: PortRequestContext, recordTypes: readonly RecordType[], pageToken?: string): Promise<DomainResult<EntityPageDTO>>;
  loadChangesSince(ctx: PortRequestContext, after: Cursor, limit: number): Promise<DomainResult<ChangePageDTO>>;
  commit(ctx: PortRequestContext, batch: AtomicMutationBatch): Promise<DomainResult<CommitResult>>;
}
export interface ProjectionPort {
  rebuild(ctx: PortRequestContext, snapshot: DomainSnapshot, expectedHead?: ProjectionHeadDTO): Promise<DomainResult<DailyReportSnapshot>>;
  export(ctx: PortRequestContext, snapshot: DomainSnapshot): Promise<DomainResult<ExportEnvelopeV1>>;
}
export interface ActionPort {
  submitShadow(ctx: PortRequestContext, intent: ActionIntent): Promise<DomainResult<ActionIntent>>;
}
export interface RuntimePort {
  initialize(ctx: PortRequestContext): Promise<DomainResult<RuntimeDescriptor>>;
  submit(ctx: PortRequestContext, request: RuntimeRequest): Promise<DomainResult<RuntimeHandle>>;
  result(ctx: PortRequestContext, handle: RuntimeHandle): Promise<DomainResult<RuntimeResult>>;
  cancel(ctx: PortRequestContext, handle: RuntimeHandle): Promise<DomainResult<RuntimeResult>>;
}
```

| operation | 必需 capability | 允许的 ResourceScope |
|---|---|---|
| observation.preview | observation.preview | fixture/import/project |
| observation.commit | observation.commit.fixture 或 observation.commit.readonly | 与 token 的 InputIdentity 完全一致 |
| correction.submit | knowledge.correct 或 knowledge.delete | entity/project |
| knowledge.snapshot/scan/changes | knowledge.read | installation/project/entity |
| knowledge.commit | knowledge.commit | 与 batch 所有 record scope 的交集 |
| projection.rebuild | projection.rebuild | installation/project |
| projection.export | projection.export | installation/project |
| action.shadow | action.shadow | project/entity |
| replay.evaluate | replay.evaluate + knowledge.read + knowledge.commit | fixture/import/project |
| control.privacy.pause/resume | privacy.pause/privacy.resume | installation |
| control.privacy.revoke | privacy.revoke + knowledge.delete | installation/project |
| control.recovery.resume | recovery.clean | installation |
| control.recovery.retry-purge | recovery.retry-purge | installation/entity |
| control.storage.clear | storage.clear | installation |
| control.export | projection.export + knowledge.read | installation/project |
| runtime.initialize/submit/cancel | 对应 runtime capability | installation/project |

App 是唯一编排者与 Knowledge writer；Store/Knowledge adapter MUST NOT 回调 inbound Port 或主动触发 Projection。CorrectionPort 校验 command 后构造 terminal record 与 mutation batch，并仅经 KnowledgePort commit。EvaluateReplay use case MUST 读取固定 cursor snapshot、构造并校验 ReplayInputV1、调用纯 ReplayV1、运行 final-state assertions，并通过 KnowledgePort 持久化 terminal EvaluationResult；UI 不得直接调用纯函数或自行拼 input。ControlPort 是 pause/resume/recover/retryPurge/clear/replay/export 的唯一 application 入口。
UiIntentCommand 的 commandId/correlationId/idempotencyKey MUST 原样传播到 PortRequestContext、CorrectionCommand/Control command、AtomicMutationBatch、CommitLedger、receipt、AuditEvent 与 UiAnnouncement dedupe；任一层不得重生 ID。所有 Port 只承诺原子业务语义，不得暴露 IDB request/transaction、Blob、SQLite connection 或 transport 私有类型。M1 实例化 `JsonFixtureObservationAdapter`、`InMemoryKnowledgeAdapter`/`IndexedDbKnowledgeAdapter`、`WebCorrectionAdapter`、`WebProjectionAdapter`、`ShadowActionSink`；RuntimePort 仅冻结 typed boundary，M1 MUST NOT 实例化。共享 contract test MUST 覆盖 result、operation-capability-scope、consent、epoch、opaque token、CAS 和幂等 ledger。

## 8. 错误语义与 ErrorPolicy

```ts
export type ErrorCode =
  | "ERR_SCHEMA_INVALID" | "ERR_UNKNOWN_FIELD" | "ERR_PRIVACY_FIELD_DENIED"
  | "ERR_REDACTION_FAILED" | "ERR_DUPLICATE_CONFLICT" | "ERR_NOT_FOUND"
  | "ERR_INVALID_TRANSITION" | "ERR_REVISION_CONFLICT" | "ERR_CURSOR_CONFLICT"
  | "ERR_EVIDENCE_BROKEN" | "ERR_HASH_MISMATCH" | "ERR_LINEAGE_CYCLE"
  | "ERR_SCOPE_INVALID" | "ERR_CAPABILITY_DENIED" | "ERR_OPERATION_DENIED"
  | "ERR_LIFECYCLE_BINDING_MISSING" | "ERR_IDEMPOTENCY_CONFLICT"
  | "ERR_PREVIEW_STALE" | "ERR_PREVIEW_EXPIRED" | "ERR_PREVIEW_CONSUMED" | "ERR_PREVIEW_BUFFER_MISSING"
  | "ERR_CANONICALIZATION" | "ERR_DETERMINISM_VIOLATION"
  | "ERR_REPLAY_PIN_MISSING" | "ERR_PIN_UNSUPPORTED" | "ERR_PAGE_TOKEN_INVALID"
  | "ERR_DELETE_INCOMPLETE" | "ERR_PRIVATE_MODE" | "ERR_CONSENT_REQUIRED"
  | "ERR_CONSENT_REVOKED" | "ERR_RETENTION_EXPIRED"
  | "ERR_DELETED_RESTORE_FORBIDDEN" | "ERR_RECOVERY_REQUIRED" | "ERR_RECOVERY_LEASE_LOST" | "ERR_PURGE_GENERATION_STALE"
  | "ERR_SHADOW_VIOLATION" | "ERR_STORAGE_QUOTA" | "ERR_STORAGE_BLOCKED"
  | "ERR_EXPORT_FAILED" | "ERR_PROTOCOL_MISMATCH" | "ERR_STREAM_DECODE" | "ERR_TRANSPORT_FAILURE"
  | "ERR_TIMEOUT" | "ERR_CANCELLED" | "ERR_RUNTIME_UNAVAILABLE"
  | "ERR_RUNTIME_DISABLED" | "ERR_INTERNAL";
export interface DomainError {
  code: ErrorCode;
  message: string;
  recordType?: RecordType | "evidence_ref";
  recordId?: UUID;
  fieldPath?: string;
  retryable: boolean;
  correlationId: UUID;
  details?: Readonly<Record<string, string | number | boolean>>;
}
export type SafeState = "UNCHANGED" | "READ_ONLY" | "PRIVATE" | "RECOVERY_ONLY" | "CLEAR_ONLY";
export type RetryPolicy =
  | { kind: "never" }
  | { kind: "user-after-change" }
  | { kind: "bounded"; maxAttempts: number; backoffMs: readonly number[] };
export interface ErrorPolicy {
  code: ErrorCode;
  retry: RetryPolicy;
  safeState: SafeState;
  audit: "none" | "metadata-only" | "security";
  userMessageKey: string;
  nextAction: "none" | "retry" | "repreview" | "refresh" | "grant-consent" | "free-space" | "close-other-clients" | "clear-all" | "contact-support";
}
export declare const ERROR_POLICY: Readonly<Record<ErrorCode, ErrorPolicy>>;
```

每个 ErrorCode MUST 在 `ERROR_POLICY` 恰有一个条目；启动发现缺项/重复项返回 `ERR_INTERNAL` 并进入 READ_ONLY。schema/privacy/capability/hash/determinism/revision/idempotency/lifecycle/shadow/protocol 错误 MUST fail closed 且 retry=never；preview stale/expired/consumed 的 nextAction=repreview；cursor conflict 的 nextAction=refresh；timeout/transport 仅可按 policy bounded retry；quota 需用户释放空间，blocked 需关闭其他 client；M1 Runtime 调用固定返回 `ERR_RUNTIME_DISABLED`。
所有 adapter 的 throw/rejection、协议异常与超时 MUST 在 boundary 分别映射为 `ERR_TRANSPORT_FAILURE/ERR_PROTOCOL_MISMATCH/ERR_TIMEOUT`；领域层不得观察原 exception。若 transport 结果不确定，写操作 MUST 先以 idempotencyKey 查询 CommitLedger，不得盲重试。
批量导入 MUST 用 `BatchResult` 返回逐项错误；合法项可提交，但 UI 只显示“已保存 N、拒绝 M”。PRIVATE 返回 `ERR_PRIVATE_MODE`；授权缺失/撤回分别返回 `ERR_CONSENT_REQUIRED/ERR_CONSENT_REVOKED`。所有失败的 `safeState`、固定文案和 nextAction 只由 registry 决定，adapter 不得发明私有错误码。
`fieldPath` 只能是 schema 静态 token，未知/动态 key 固定 `$unknown`；message/details/audit 不得含输入、动态 key、validator issue、stack、自由文本或 secret。未知异常映射 `ERR_INTERNAL`；`correlationId` MUST 存在且不可由敏感 payload 派生。

## 9. Privacy、Redaction 与 Delete Cascade

### 9.1 Data Classification 与 allowlist

| 分类 | 示例 | 持久化/展示/导出 |
|---|---|---|
| `public` | schema enum、粗粒度 appId、fileExt、计数 | 可存；正常展示；按导出 policy |
| `local-sensitive` | 时间序列、用户别名 projectKey、statement/reason/answer、scope、evidence graph | 仅本地 IDB；最小展示；导出必须显式确认 |
| `restricted` | 原始标题/路径/URL/命令、细 detector ID、可关联来源标识 | 仅瞬时 preview/redaction；不得持久化或默认 DOM/导出 |
| `prohibited` | secret、键击/剪贴板正文、像素、未授权来源 | 拒绝；不得进入 store/log/cache/export |

BehaviorEvent 顶层、subject、attributes 仅允许本 schema 字段。`projectKey/branchHash` 只允许用户别名或 `HMAC-SHA256(installKey, normalizedValue)`；禁止裸 SHA-256、路径、组织名、仓库 URL。细 redaction rule ID 不持久化，只存粗粒度 count；Audit TTL 内也不得写命中值。
M1 policy 只启用 fixture/json-import；M2 readonly-adapter 必须引用 active ConsentGrant，preview 与 commit 两次校验 consent/purpose/fields/policy/retention，撤回即递增 privacyEpoch、拒绝新摄入并按 ConsentGrant 的清除策略运行 DeletionPlan。

### 9.2 写前 redaction 决策表

流程 MUST 为：字节/深度预检 → parse → 未知字段/结构检查 → 初次类型验证 → NFC 与 control/Bidi 处理 → versioned DetectorPolicy → allowlist/redaction → **二次完整 schema 验证** → fact/provenance/content hash → commit。
- unknown field/enum：拒绝该 item；批量其余合法项可继续；
- optional field 命中 restricted/secret：整字段删除后二次校验；
- required/identity 字段命中：拒绝整个 item；
- prohibited source/content 或 detector 失败：fail closed。
`DetectorPolicyV1` 固定规则 ID、正则/算法版本、NFC 顺序、控制/Bidi 策略、高熵最短长度 20/阈值 4.0 bits-char，并 allowlist 合法 UUID/hash；地域 PII 仅承诺 fixture 预注册模式，不宣称全球覆盖。policy version 纳入 VersionPins 与 golden 正/近邻负例。
所有 statement/reason/answer/prompt/summary 等自由文本视为 UntrustedUserText：1–500 字符、NFC、拒绝未允许控制字符、隔离/标记 Bidi、HTML context 输出编码；未来 Runtime 只能放结构化 data channel，禁止拼接成 system/tool 指令。
日志仅记录固定 ErrorCode、fixture/import batch ID、静态 field token 与计数；未知 key 记 `$unknown`，不得序列化原 validator issue、动态 key、输入、敏感 detector ID或 stack。

### 9.3 Delete cascade、Journal 与 Reachability

#### 9.3.1 DTO

```ts
export type RecoveryMode = "NORMAL" | "RECOVERY_ONLY" | "CLEAR_ONLY";
export interface StoreMeta {
  key: "canonical";
  cursor: Cursor;
  privacyEpoch: number;
  observationMode: "ACTIVE" | "PRIVATE";
  recoveryMode: RecoveryMode;
  schemaVersion: SchemaVersion;
  logicalBytes: number;
  recoveryBytes: number;
  recoveryReserveBytes: 5242880;
  sizeEstimatorVersion: "storage-size-v1";
}
export type DeletionCause = "user-delete" | "consent-revoked" | "retention-expired" | "clear-all";
export interface DeletionPlan {
  id: UUID;
  target: { recordType: RecordType; recordId: UUID; contentHash: Hash };
  cause: DeletionCause;
  baseCursor: Cursor;
  basePrivacyEpoch: number;
  baseSnapshotHash: Hash;
  policyVersion: string;
  closureRulesHash: Hash;
  planHash: Hash;
  createdAt: Timestamp;
}
export type DeletionWorkAction = "delete-record" | "delete-index-entry" | "invalidate-projection" | "rederive-claim-root" | "purge-cache";
export interface DeletionWorkItem {
  id: UUID;
  deletionId: UUID;
  ordinal: Cursor;
  action: DeletionWorkAction;
  targets: readonly { storeName: StoreName; recordType: RecordType; recordId: UUID; expectedContentHash?: Hash }[];
  attempts: number;
  createdAt: Timestamp;
}
export interface ActiveDeletionJournal {
  id: UUID;
  state: "FENCED" | "DELETING" | "PURGE_PENDING" | "AUDITING" | "FINALIZING" | "FAILED";
  planId: UUID;
  planHash: Hash;
  baseCursor: Cursor;
  basePrivacyEpoch: number;
  enumeration: { registryIndex: number; pageToken?: string; complete: boolean; enumeratedCount: number };
  progress: { nextOrdinal: Cursor; completedCount: number; totalCount: number };
  purge: { generation: UUID; cutoff: Timestamp; sealedAt?: Timestamp; requiredClientIds: readonly UUID[] };
  finalizing: { registryIndex: number; pageToken?: string; removedControlCount: number };
  attempts: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  errorCode?: ErrorCode;
}
export interface VerifiedDeletionJournal { id: UUID; state: "VERIFIED"; deletedType: RecordType; workItemCount: number; createdAt: Timestamp; verifiedAt: Timestamp }
export type DeletionJournal = ActiveDeletionJournal | VerifiedDeletionJournal;
export interface ClientRegistration {
  clientId: UUID;
  openedAt: Timestamp;
  leaseExpiresAt: Timestamp;
  state: "ACTIVE" | "CLOSING" | "QUARANTINED";
  purgeGeneration?: UUID;
}
export interface ClientPurgeRequest { deletionId: UUID; generation: UUID; cutoff: Timestamp; issuedAt: Timestamp; deadlineAt: Timestamp; command: "PURGE" }
export interface ClientPurgeAck { id: UUID; deletionId: UUID; generation: UUID; clientId: UUID; acknowledgedAt: Timestamp; result: "PURGED" }
export interface RecoveryLease {
  id: "recovery-lease";
  ownerClientId: UUID;
  generation: number;
  fencingToken: UUID;
  acquiredAt: Timestamp;
  renewedAt: Timestamp;
  expiresAt: Timestamp;
  contentHash: Hash;
}
export type ReachabilityRootId =
  | "idb.meta" | "idb.liveEntities" | "idb.systemRecords" | "idb.knowledgeHeads" | "idb.workflowHeads" | "idb.projectionHeads"
  | "idb.commitLedger" | "idb.changeFeed" | "idb.importStaging" | "idb.deletionPlans" | "idb.activeDeletionJournals"
  | "idb.verifiedDeletionJournals" | "idb.deletionWorkItems" | "idb.clientRegistrations" | "idb.purgeAcks"
  | "idb.tombstones" | "idb.auditEvents" | "idb.exportReceipts"
  | "preview.buffer" | "preview.guard" | "import.session" | "import.controller" | "worker.heap" | "worker.message-queue"
  | "client.heap" | "ui.visible" | "ui.hidden" | "a11y.name" | "a11y.description" | "a11y.text" | "announcement.live"
  | "local.ui-preferences" | "cache.storage" | "search.index" | "shadow.renderer" | "browser.effect-sinks" | "test.artifacts";
export interface ReachabilityRootRegistryV1 { version: "reachability-roots-v1"; roots: Readonly<Record<ReachabilityRootId, "required">> }
export interface ReachabilityRootReceipt {
  id: UUID;
  deletionId: UUID;
  rootId: ReachabilityRootId;
  oracleVersion: "reachability-oracle-v1";
  scannedItemCount: number;
  forbiddenReferenceCount: number;
  canaryCount: number;
  highWatermark?: Cursor;
  auditedAt: Timestamp;
}
export interface ReachabilityResult {
  deletionId: UUID;
  generation: UUID;
  auditedAt: Timestamp;
  receipts: readonly ReachabilityRootReceipt[];
  reachableCount: number;
  canaryClean: boolean;
  allRequiredClientsPurged: boolean;
  registryComplete: boolean;
  outcome: "CLEAN" | "REACHABLE" | "CLIENTS_PENDING" | "REGISTRY_INCOMPLETE";
}
export interface DeletionTombstone { id: UUID; deletedType: RecordType; deletedAt: Timestamp }
export interface ClearAllResult { state: "SUCCEEDED" | "BLOCKED"; databaseDeleted: boolean; cachesCleared: boolean; emptyReopenVerified: boolean; errorCode?: "ERR_STORAGE_BLOCKED" }
export interface AuditEvent { id: UUID; occurredAt: Timestamp; actor: "local-user" | "system-recovery"; capability: Capability; operation: string; resultCode: ErrorCode | "OK"; correlationId: UUID }
```

DeletionPlan 在 T0 前由只读 snapshot 纯函数生成，但不预写全部 work。planHash MUST 覆盖 target、cause、baseCursor、basePrivacyEpoch、baseSnapshotHash、policyVersion 与 closureRulesHash。
`ReachabilityRootRegistryV1` MUST 由 canonical IDB Store registry、Preview/Import/Worker/Client/UI sink registry、ForbiddenBrowserEffectSinkRegistryV1 与 TestArtifactSinkRegistryV1 穷尽合并；启动时集合不等、重复或出现未登记 store/sink 必须 fail closed。每个 union root（包括所有 IDB stores、preview buffer/guard、import session/controller/staging、Worker heap/queue、client heap、可见/隐藏 UI、a11y name/description/text、announcement live、local UI preference、cache/search、Shadow renderer、浏览器 effect sink 与测试 artifact）必须产生恰一 ReachabilityRootReceipt；漏 root 时 registryComplete=false，禁止 CLEAN。

#### 9.3.2 原子状态点、分页 work 与恢复 lease

允许转换仅为 `FENCED -> DELETING -> PURGE_PENDING -> AUDITING -> FINALIZING -> VERIFIED`；AUDITING 发现残留可回 DELETING；活动态可到 FAILED，FAILED 不得恢复 NORMAL。每次转换 MUST 与 journal progress、StoreMeta accounting/cursor 和 RecoveryLease fencing 校验在同一短事务提交。

1. **T0 fence**：事务内 MUST 等值复核 `StoreMeta.cursor===plan.baseCursor`、`privacyEpoch===plan.basePrivacyEpoch`、`recoveryMode=NORMAL`，从该 cursor 的 canonical roots 重算 baseSnapshotHash 和 planHash；任一不等则零写入、返回 ERR_CURSOR_CONFLICT 并重新规划。成功时只写 plan + FENCED journal，把 mode 设 RECOVERY_ONLY、创建随机 purge generation/cutoff、更新 logicalBytes/recoveryBytes/cursor；MUST NOT 在 T0 写全量 work items。
2. **FENCED enumeration**：按 ReachabilityRootRegistryV1 的持久 registryIndex/pageToken 分页枚举反向闭包，每页最多 500 key/4 MiB，创建有序 work items并与 enumeration progress、count、cursor 同事务提交；完成标记后才转 DELETING。crash 从持久 pageToken 恢复，重复页以 work ID 幂等。
3. **DELETING chunks**：每个短事务执行下一 work item 的 deleteIfHash/幂等动作，并在同事务更新 completedCount、bytes/cursor后**物理移除已完成 work item**，不得积累 done rows。commit 前 crash 全不可见，commit 后不得重跑已移除 item。
4. **PURGE/AUDIT**：work 清空后转 PURGE_PENDING；generation membership sealed 后才进 AUDITING。Audit 使用 registry 生成逐 root receipts；若 forbiddenReferenceCount/canaryCount 非零则分页补 work 并回 DELETING。
5. **FINALIZING**：首轮 audit clean 后进入 FINALIZING，按 registryIndex/pageToken 分页移除 active plan、旧 ACK、staging、guard/buffer、临时 receipts 与含旧 ID/hash 的 recovery records；每页有界且 progress 同事务。完成后重跑全部 roots，要求每 root receipt 为 0。
6. **短 Tv**：只在 final receipts 完整、全零且 clients purged 时，一个短事务删除已清空的 active journal，写无关联 VerifiedDeletionJournal/随机 tombstone/必要随机 invalidation receipt，恢复 NORMAL并更新 bytes/cursor。Tv 不扫描、不分页、不删除大集合；失败继续 RECOVERY_ONLY。

RecoveryLease 以 casSingleton 获取。owner 每 2 秒 renew，expiry 至少 6 秒；每个 recovery transaction 必须复核 owner/generation/fencingToken/未过期。steal 仅在 expiry 后以旧 contentHash CAS，generation+1并生成新 fencingToken；旧 owner 下一次写返回 ERR_RECOVERY_LEASE_LOST。系统时钟回拨、不可用或跨过最大漂移时 fail closed，不得续租/steal/恢复 NORMAL。

#### 9.3.3 Purge membership、retry、clear 与恢复空间

T0 cutoff 前 lease 未过期的 ACTIVE clients 进入 required set；cutoff 后打开的 client MUST 原子加入当前 required set，或保持 QUARANTINED 且不可读取/渲染 canonical payload。进入 AUDITING 前必须 seal generation；seal 后新 client 一律 QUARANTINED 到 VERIFIED。ACK 必须匹配 generation，旧 generation ACK 无效。

5 秒未集齐 ACK 时保持 PURGE_PENDING并提示关闭其他标签。`ControlPort.retryPurge` MUST 原子关闭旧 generation、删除其 ACK、创建新 generation/cutoff、重新计算 active+quarantined membership并更新 journal；迟到旧 ACK 返回 ERR_PURGE_GENERATION_STALE。client lease 过期不等于 ACK。

clear-all 必须先进入 CLEAR_ONLY并按 §9 的 client/blocked 语义执行；5 秒 blocked 返回 ERR_STORAGE_BLOCKED。仅数据库删除成功、所有 registered artifact/cache/UI sinks dispose 且 empty reopen 成功才 SUCCEEDED。

StoreMeta 的 logicalBytes/recoveryBytes MUST 由 `sizeEstimatorVersion` 的确定 estimator 在每次 transaction 原子更新，并保持 `logicalBytes>=0`、`recoveryBytes>=0`、`recoveryBytes<=5242880`。普通写不得侵占 5 MiB reserve；无法写最小 T0/lease 时进入 CLEAR_ONLY。

#### 9.3.4 隐私删除后的语义

EvidenceLossPolicy MUST 物理删除所有直接或间接引用已删 evidence 的旧 WorkModelClaim/Question/SkillCandidate/ActionIntent revision；不得追加含旧 statement/evidence/hash 的 invalidated revision。仅当从仍 live 的证据独立重跑 predicate 后满足阈值、且完整 redaction/canary scan 为 clean，才可创建 `parentRevisionId` 缺失、`revision=1`、`status=proposed` 的全新 rederived root 与新 head；否则删除整个 lineage。confirmed claim 失证不得自动保持 confirmed，删除 counter-evidence 不得提高 confidence。

关联 EvaluationResult payload MUST 物理删除；最终只能写 §6 的随机 EvaluationInvalidationReceipt，禁止 resultId/runId/inputHash/outputHash/evidence/contentHash 或可反查旧结果的关联。verified 后 DeletionTombstone 只能保留随机 UUIDv7 `id`、粗粒度 `deletedType` 与 `deletedAt`；MUST NOT 保留原 entity/content ID、formerHash、semanticKey、reason、evidence、动态路径、detector ID 或 canary。

隐私删除优先于 immutable/append-only 语义：DeletionPlan 的反向闭包 MUST 包含引用目标的 CorrectionRecord、KnowledgeVersion/Head、workflow head/revision、EvaluationResult、CommitLedger.affectedRefs、change-feed recordId、projection/search/Worker staging，以及任何 business/system/audit/export receipt；含目标 ID/hash 的整个 record 必须物理删除，禁止原地抹字段。删除动作自身的 CorrectionRecord 在 recovery 期间可用于恢复，但 Tv 前也必须移除。随机 receipt/tombstone 只在 Tv 原子事务写入，不是 chunk work；否则 ReachabilityResult 不得为 CLEAN。

删除完成后不得从 tombstone、cache、旧 projection、旧 export 或 receipt 恢复旧 lineage。用户未来主动提供新 consent 并显式重新 import 相同事实时，系统 MAY 建立全新 event ID、dedupe lineage、claim/workflow key 与 heads；不得借此链接或复活旧 lineage。已下载导出仍在控制边界外，UI 必须提示，新导出不得含已删 payload。

## 10. Replay Canonicalization

### 10.1 唯一输入、Key 与签名

```ts
export interface ReplayEventRefV1 {
  eventContentHash: Hash;
  dedupeKey: Hash;
  factHash: Hash;
  occurredAt: Timestamp;
  kind: EventKind;
}
export interface ReplayKnowledgeVersionRefV1 {
  version: number;
  versionContentHash: Hash;
  claimRevisionContentHash: Hash;
  basedOnVersionContentHash?: Hash;
}
export interface ReplayKnowledgeSetV1 {
  knowledgeKey: string;
  head: { version: number; versionContentHash: Hash };
  versions: readonly ReplayKnowledgeVersionRefV1[];
}
export interface ReplayCorrectionRefV1 {
  recordContentHash: Hash;
  targetClaimKey: string;
  baseRevisionContentHash: Hash;
  action: CorrectionRecord["action"];
}
export interface ComparatorProfileV1 {
  id: "comparator-v1";
  eventOrder: "occurredAt-kind-factHash-dedupeKey";
  knowledgeOrder: "knowledgeKey-version-versionContentHash";
  correctionOrder: "targetClaimKey-baseRevisionContentHash-action-recordContentHash";
  stringOrder: "unicode-code-point";
}
export interface CanonicalProfileV1 {
  id: "canonical-json-v1";
  unicode: "NFC";
  newline: "LF";
  objectKeys: "unicode-code-point";
  optionalFields: "omit";
  confidenceDigits: 6;
  encoding: "UTF-8";
}
export interface ReplayInputV1 {
  replayInputVersion: "1";
  inputIdentity: InputIdentity;
  inputSetHash: Hash;
  events: readonly ReplayEventRefV1[];
  knowledge: readonly ReplayKnowledgeSetV1[];
  corrections: readonly ReplayCorrectionRefV1[];
  asOf: Timestamp;
  timezone: string;
  locale: string;
  clockSeed: Hash;
  pins: VersionPins;
  comparatorProfile: ComparatorProfileV1;
  canonicalProfile: CanonicalProfileV1;
}
export interface ReplayKeyV1 {
  replayKeyVersion: "1";
  inputIdentity: InputIdentity;
  inputSetHash: Hash;
  eventSetHash: Hash;
  knowledgeSetHash: Hash;
  correctionSetHash: Hash;
  asOf: Timestamp;
  timezone: string;
  locale: string;
  clockSeed: Hash;
  pinsHash: Hash;
  comparatorProfileId: ComparatorProfileV1["id"];
  canonicalProfileId: CanonicalProfileV1["id"];
  replayInputHash: Hash;
  keyHash: Hash;
}
export type ReplayV1 = (input: Readonly<ReplayInputV1>) => DomainResult<CanonicalDomainSnapshotV1>;
```

Replay 的唯一公开签名 MUST 为 `ReplayV1`，只接受一个完整 `ReplayInputV1`；禁止重载为 events/knowledge/pins 等位置参数。`inputSetHash` MUST 覆盖排序后的 events、knowledge（head + version set）和 corrections 三个集合。三个 set hash 分别覆盖各自完整数组；`replayInputHash` 覆盖 ReplayInputV1 每个字段；`keyHash` 覆盖 ReplayKeyV1 除自身外每个字段。因此任何 identity、集合、asOf、timezone、locale、clockSeed、pin 或 profile 变化 MUST 产生不同 key。

输入排序固定为 profile 字面规则。ReplayInput builder MUST 先用持久 ID 解引用并校验 live immutable record，再只写上述 semantic/content hashes；UUIDv7 eventId、recordId、headId、versionId、commandId 和时间戳不得进入 ReplayInput/hash。events 不以 factHash 丢弃来源：相同 factHash MAY 合并语义事实，但每个 source-stable dedupeKey/eventContentHash 必须留在 canonical evidence。knowledge versions 按 version 连续并校验 head 的 versionContentHash 指向集合成员；corrections 只接受 terminal CorrectionRecord。缺 pin、head 悬空、hash 不符、重复 dedupeKey 异内容或 profile 不支持 MUST fail closed。

### 10.2 CanonicalDomainSnapshotV1 字段投影

```ts
export interface CanonicalEvidenceV1 {
  sourceType: ImmutableEvidenceTargetType;
  sourceSemanticId: UUID;
  sourceContentHash: Hash;
  role: "support" | "counter" | "lineage";
  transformId: string;
  transformVersion: string;
}
export interface CanonicalEntityV1 {
  entityType: BusinessEntityType;
  semanticId: UUID;
  semanticFields: JsonValue;
  evidence: readonly CanonicalEvidenceV1[];
  contentHash: Hash;
}
export interface CanonicalKnowledgeHeadV1 {
  knowledgeKey: string;
  versionSemanticId: UUID;
  version: number;
  contentHash: Hash;
}
export interface CanonicalWorkflowHeadV1 {
  workflowType: WorkflowEntityType;
  workflowKey: string;
  revisionSemanticId: UUID;
  revision: number;
  contentHash: Hash;
}
export interface CanonicalDomainSnapshotV1 {
  snapshotVersion: "1";
  schemaVersion: SchemaVersion;
  replayKey: ReplayKeyV1;
  asOf: Timestamp;
  timezone: string;
  locale: string;
  entities: readonly CanonicalEntityV1[];
  knowledgeHeads: readonly CanonicalKnowledgeHeadV1[];
  workflowHeads: readonly CanonicalWorkflowHeadV1[];
  snapshotHash: Hash;
}
```

`semanticFields` MUST 是按 entityType 的封闭投影，禁止透传整个 StoredRecord：

| entityType | MUST 保留的 semanticFields | MUST 排除 |
|---|---|---|
| behavior_event | occurredAt、kind、subject、attributes、factHash、排序后的 observation dedupeKey/contentHash 集合 | id、ingestedAt、correlationId、provenanceHash、record contentHash |
| episode | startAt、endAt、title、projectKey、activityKind、event semantic IDs、confidence、segmentationVersion、status | id、存储时间、record contentHash |
| work_model_claim | claimKey、semanticKey、predicateId、parent semantic ID、revision、statement、scope、confidence、counter evidence、status | id、createdAt、record contentHash |
| correction_record | targetClaimKey、base semantic ID、action、appliedPatch、reason、result semantic IDs、status/errorCode | id、commandId、submittedAt/completedAt、record contentHash |
| knowledge_version | knowledgeKey、version、claim semantic ID、basedOn semantic ID、correction semantic ID | id、createdAt、record contentHash |
| daily_report | localDate、timezone、episode/claim/question/skill semantic IDs、correctionImpact 的 before/after hash、status | id、generatedAt、sourceCursor、record contentHash |
| question | workflowKey、parent semantic ID、revision、prompt、gapType、scope、evidence、informationGain、answer、status | id、createdAt、answeredAt、record contentHash |
| skill_candidate | workflowKey、parent semantic ID、revision、name/purpose/trigger、inputs/outputs、benefit/risk/confidence、action semantic ID、status | id、存储时间、record contentHash |
| action_intent | workflowKey、parent semantic ID、revision、skill semantic ID、mode、summary、preconditions/steps/effects/forbiddenEffects、status | id、createdAt、record contentHash |
| evaluation_result | InputIdentity、pins、knowledge semantic IDs、inputHash、outputHash、assertions、metrics、failureCodes、status | id、runId、startedAt、completedAt、record contentHash |

`occurredAt`、Episode startAt/endAt、Scope validFrom/validUntil、Replay asOf、timezone 与 locale 是语义输入，MUST 保留。`createdAt/generatedAt/ingestedAt/updatedAt/completedAt/answeredAt/startedAt`、runId、cursor、privacyEpoch、客户端/事务时间、随机 record ID 均为非语义字段，MUST 按上表逐实体排除；不得用模糊“等字段”规则扩张或缩减。

每个实体先对 `{entityType,semanticFields,evidence}` 用 CanonicalProfileV1 序列化并计算 contentHash，再用 VersionPins 中 `id-generation` algorithm 的固定 namespace 对 `entityType + ":" + contentHash` 生成 UUIDv5 semanticId。父引用和 head MUST 使用 semanticId。相同输入的所有 semanticId/contentHash/snapshotHash 必须一致；禁止 UUIDv4/v7、系统时间或遍历顺序参与派生。snapshotHash 覆盖 snapshot 除自身外全部字段。

CanonicalProfileV1 规则：object key 按 Unicode code point；字符串 NFC、LF、去尾随空白；可选缺失字段省略且禁止 null 代替；数组按字段 comparator 排序，集合去重；有限 number 的 `-0` 转 0，禁止 NaN/Infinity，confidence 四舍五入六位并去尾零；最终为无缩进 UTF-8 JSON、无 BOM、无尾换行。

### 10.3 StoredRecord MigrationRegistry / Upcaster

Replay 与 export 在读取旧 StoredRecord 后 MUST 先调用 §5 `MigrationRegistry.upcast(record,target)`；Replay target 是 ReplayInput.pins.schema，export target 固定为 `targetExportSchemaVersion`。Upcaster MUST 是无 I/O、无时钟、无随机、无全局可变状态的纯函数，并只从一个明确 fromVersion 到一个明确 toVersion；registry 按 recordType 选择唯一无环链。

Upcaster MUST 把输入视为 Readonly，返回新的 StoredRecord 与 UpcastReceipt，禁止修改、覆盖或回写旧 record，也禁止长期双写。receipt.beforeHash 必须等于旧 contentHash；afterHash 必须由目标版本完整 record canonical bytes 重算，且等于返回 record.contentHash。相同输入与 upcaster chain 的 before/after hash 必须确定。

缺少路径、路径歧义、循环、recordType 改变、目标版本不等于请求版本或 hash 校验失败 MUST 以 `ERR_SCHEMA_INVALID` fail closed；不得跳过版本、猜测字段默认值或退回原 payload。ExportEnvelopeV1 的 schema 与 records MUST 全部达到 targetExportSchemaVersion，并在 manifest/hash 中包含该目标版本；迁移 receipt 可进入无 payload 诊断，但不得替代导出记录。

### 10.4 Replay 验收

- 同 ReplayInputV1 重复运行或改变原始 object 插入顺序，ReplayKey、semantic IDs、entity hashes 与 snapshotHash MUST 相同。
- 改变任一 ReplayInputV1 字段，replayInputHash 与 keyHash MUST 改变；测试必须逐字段 mutation 覆盖。
- 仅改变排除字段（如 ingestedAt/runId/generatedAt）且重建同一 ReplayInputV1 时 snapshotHash MUST 不变；改变 occurredAt/scope/asOf/timezone/locale 时 MUST 改变。
- 修正吸收通过 before/after snapshot 的目标 scope 语义断言；locality 通过非目标 scope 子树 hash 相等断言。
- migration 测试必须覆盖多跳、缺跳、歧义、循环、输入未修改、before/after hash 与 target export schema。

## 11. Shadow-only 行为

本切片唯一 ActionPort 实现 MUST 为 `ShadowActionSink`，只持久化/展示 ActionIntent。
production browser bundle 中从 application/domain/action 入口可达的代码 MUST 不包含 OS input、shell、Runtime、真实 filesystem writer 或非同源静态资源网络路径；build/test tooling、dev HMR、E2E runner 和页面同源静态资源加载不在运行时副作用计数内。
M1 UI 的动作按钮统一为“预览建议”，不得出现“运行/执行/应用技能”文案。
Shadow preview MUST 显示 preconditions、步骤、预期效果和四类禁止副作用。
检测到任何副作用尝试 MUST 中止、记录 `ERR_SHADOW_VIOLATION`、Orb 进入 ERROR，且不自动重试。
EXECUTING Orb 在首切片仅表示本地导入处理、Replay 或导出计算，不得暗示真实环境动作。

## 12. UI Contract：视觉、信息架构、六态与可访问交互

本节与 §5.6 DTO 共同构成 M1 UI 的规范源。实现不得以“有六个颜色”替代视觉结构、状态语义、恢复路径或可访问性。

### 12.1 VisualContractV1 与原型边界

`reference/Prototype reference1.png` MUST 仅作为 mood board，不是逐像素整图 gold，也不是能力清单。M1 只采纳 `VisualContractV1.approvedVisualLanguage`：暖白画布、深墨标题、蓝色强调、细灰分隔、分组卡片、玻璃液体 Orb 及 26/96px 双尺度。品牌 MUST 始终为 `ProAGI Assistant`；任何可见文本、accessible name、title、metadata、fixture 或 screenshot baseline MUST NOT 出现 `ProAGIAgent` 或 `智图灵助手`。

原型中的鼠标轨迹、指针意图、OCR、截图、发送邮件、创建任务、真实执行、UIA 或 Runtime 连接均属于 `prohibitedCapabilityInference`。M1 MUST NOT 实现、模拟已连接状态或用文案暗示这些能力；旋转、双击和长按只可作为增强快捷方式，不能成为任务完成的唯一入口。

### 12.2 VisualTokenV1、对比度与 forced colors

实现 MUST 以单一、类型穷尽的 `VisualTokenV1` 生成 CSS custom properties；组件不得复制私有色值。六态主色 MUST 精确使用 `stateColor` 的 sRGB 值。暖白只用于 canvas，正文使用 ink/inkMuted；状态色不得直接承载小字号正文。默认字体 MUST 为本地 system-ui/CJK sans-serif stack，禁止远程字体；视觉证据包记录实际 font family 与 font hash/平台字体版本。

所有正文/背景组合对比度 MUST ≥4.5:1，大字号文本 MUST ≥3:1，焦点、边框、图标和状态形状相邻色 MUST ≥3:1。Focus ring 必须使用 token 的 3px/2px offset，不能被 overflow 裁剪，也不能仅靠 box-shadow 在 forced-colors 下表达。

`@media (forced-colors: active)` 时 MUST 停用传达状态所非必需的渐变、透明和阴影，使用 `Canvas/CanvasText/ButtonText/Highlight/HighlightText`；交互控件保持 `forced-color-adjust:auto`。状态仍由固定图标、可见中文文本与结构表达，不能要求用户区分系统覆盖后的颜色。Windows High Contrast 下焦点、选中、ERROR 和 PRIVATE 必须仍可辨识。

### 12.3 OrbAnatomyV1 结构门禁

Orb 语义状态恰为六个：`LEARNING`、`EXECUTING`、`IDLE`、`SUGGESTION`、`ERROR`、`PRIVATE`，不得增加第七 Orb 状态。每个 Orb DOM 必须包含 `OrbAnatomyV1.requiredParts` 的八个命名 part，其中双 highlight 合并为一个 highlights 材质层，因此整体为七个 layer group：

1. `shell`：半透明外壳；
2. `rim`：清晰外环；
3. `fluid`：状态色内部液体形态；
4. `highlights`：`highlight-primary` 与 `highlight-secondary` 两个镜面高光 part；
5. `base-halo`：底部椭圆光环；
6. `shadow`：与画布分离的投影；
7. `icon-lock`：固定状态图标，PRIVATE 必须为锁。

七个材质层/语义层不得用一个纯色 `border-radius:50%` 元素替代。结构测试 MUST 查询每个 `data-orb-part` 恰有一个；除 `icon-lock` 外全部 `aria-hidden="true"`，不得进入 accessibility tree。状态图标本身可视但不单独获得焦点；button 的可访问名称由可见状态文本提供。

低感知尺寸 MUST 为 26px，允许产品设置落在 24–28px；主动尺寸 MUST 为 96px，允许 88–110px。尺寸变化不得改变点击目标下限、焦点环或 safe-area clamp。ERROR 使用固定错误图标和最多两次波纹；PRIVATE 的 fluid 必须冻结且显示锁，不能只把球改灰。

### 12.4 MotionTokenV1 与全局 reduced-motion

普通模式只能使用 `MotionTokenV1`：LEARNING 8s 慢流、EXECUTING 1.2s 推进、IDLE 3.2s 呼吸、SUGGESTION 单次 240ms 微弹、ERROR 最多两次 900ms ring pulse、PRIVATE 静止。状态切换、panel、popover 使用对应 transition token。任何动画不得每秒闪烁超过三次，不得无限弹跳或以位移持续吸引注意。

`prefers-reduced-motion: reduce` 是全应用策略，不只作用于 Orb：MUST 禁止 Orb 动画、transform 位移/缩放、parallax、smooth scroll、animated skeleton/shimmer、drawer 滑动和自动滚动；只允许最长 120ms opacity 变化。信息、进度和完成状态必须无需动画仍完整。运行中切换系统偏好必须立即停止已有 animation，而不是等待下一次 mount。

### 12.5 AppShellV1 与首屏信息层级

页面 MUST 按 `AppShellV1.firstScreenOrder` 提供：skip link → 全局状态/隐私控制 → Today 标题与可见入口 → “我观察了什么” → “我学到了什么” → “你的纠正改变了什么” → Insight Inbox → Replay。Timeline 不得成为首屏主角。

- `global-status-privacy` MUST 始终可见，包含可见的暂停/恢复按钮、CoarseSourceLabel 和安全模式入口；
- `observed` 展示 Episode 与缺失/不确定信息，不补写事实；
- `learned` 展示 claim、scope、confidence 文本等级、evidence/counterevidence 摘要；
- `correction-impact` 展示 before/after 和影响范围，不只用红/绿；
- `insight-inbox` 容纳 claim/question/skill candidate，按 heading + list 组织；
- `replay` 展示输入版本、目标 scope、hash 结果和失败原因；
- `detail-drawer` 承载渐进披露的 evidence、lineage、diff、ShadowPreview；
- Today MUST 有始终可见的 button/link，双击 Orb 不能是唯一入口。

卡片标题使用 heading；键值信息使用 definition list；事件/证据集合使用 list/table 语义。折叠详情必须有 `aria-expanded/aria-controls`。confidence 同时显示固定文本等级“低/中/高”和数值；diff 同时使用 `+/-`、标签和文字，不得只用颜色或删除线。

### 12.6 LayoutContractV1、320px 与 200% reflow

布局 MUST 在固定 CSS viewport 360、768、1280px 验证，并支持最窄 320px：

| viewport | 布局 | 固定行为 |
|---|---|---|
| 320–767px | 单栏 | 按 AppShell 顺序排列；drawer 为全宽 modal；Orb 停靠底部 safe area |
| 768–1279px | 两栏 | Observed/Learned 优先，Inbox/Replay 随后；drawer 可 modal 或侧栏；Orb 停靠右侧 |
| ≥1280px | 12 栏 | Observed 3、Learned/Impact 5、Inbox 4；Replay 下一行全宽；drawer 右侧 |

1280 CSS px viewport 在 200% zoom 下 MUST 按不大于 640px 的单栏规则 reflow。除明确标记的 code sample 外，页面、表格、dialog、drawer 与卡片 MUST 不产生双向滚动；业务表格在 compact 下转为带表头标签的 card/list。文本间距覆盖 line-height 1.5、段后 2em、letter-spacing 0.12em、word-spacing 0.16em 时不得截断或遮挡 controls。

Orb/drawer 使用 `env(safe-area-inset-*)` 与至少 8px viewport inset；virtual keyboard、resize 和 zoom 后必须重新 clamp。固定 Orb 不得遮住 PRIVATE、恢复、删除、导出确认或 correction submit。

### 12.7 PresentationStateResolver

Resolver MUST 是总函数并按以下顺序计算，不得由组件各自猜测状态：

1. 根据 recoveryMode 产生持久 banner：RECOVERY_ONLY → `recovery-required`，CLEAR_ONLY → `clear-only`；blocked 追加 `storage-blocked`。
2. observationMode=PRIVATE 时追加 `private-active`。
3. Orb：若 observationMode=PRIVATE，则为 PRIVATE；否则若 recoveryMode≠NORMAL，则为 ERROR；否则映射 domainState：idle→IDLE、learning→LEARNING、processing→EXECUTING、suggestion→SUGGESTION、error→ERROR。
4. journal state 映射固定 substate：FENCED→fenced、DELETING→deleting、PURGE_PENDING→purge-pending、AUDITING→auditing、FAILED→failed；blocked clear→blocked。

| recoveryMode | observationMode | Orb | 持久表面 |
|---|---|---|---|
| NORMAL | ACTIVE | domain 映射 | 无 recovery banner |
| NORMAL | PRIVATE | PRIVATE | private-active |
| RECOVERY_ONLY | ACTIVE | ERROR | recovery-required + substate |
| RECOVERY_ONLY | PRIVATE | PRIVATE | recovery-required + private-active + substate |
| CLEAR_ONLY | ACTIVE | ERROR | clear-only/blocked |
| CLEAR_ONLY | PRIVATE | PRIVATE | clear-only/blocked + private-active |

PRIVATE 与 recoveryMode 正交；PRIVATE Orb 不能隐藏 recovery banner。恢复完成只进入 IDLE，不补采暂停期间事件。EXECUTING 仅表示本地导入处理、Replay 或导出计算，文案必须写明对象，不得暗示真实环境动作。

### 12.8 EmptyState registry

`EMPTY_STATE_REGISTRY` MUST 穷尽以下状态并使用固定安全 message key：

| key | 含义 | 必须显示 | 主动作 |
|---|---|---|---|
| first-run | 尚未导入 | M1 仅 fixture/JSON、不会观察桌面 | choose-fixture |
| eligible-abstain | 合法证据不足 | evidence count、固定 reason code、“未形成结论” | none |
| import-all-rejected | 所有 item 被安全拒绝 | accepted/rejected count，不回显 payload | review-rejections |
| after-clear | 已验证空库 | “本设备应用数据已清空”；旧下载边界 | choose-fixture |
| no-filter-results | 当前筛选无匹配 | 当前筛选条件 | clear-filter |
| no-insights | 有事件但无候选 | 不伪造 Question/Skill/Claim | none |
| projection-load-failed | 投影未加载 | 固定 ErrorCode 和“canonical 未被覆盖” | retry-load |

空态不得使用虚构卡片、样例 claim 或假成功数据填充业务区域。示例内容只能在显式标记的 onboarding illustration 中出现，且不进入 canonical store、指标或 accessibility live region。

### 12.9 Projection loading、stale 与原子替换

UI MUST 使用 `ProjectionPresentationState`。loading 显示静态 skeleton；stale/rebuilding MAY 继续显示旧投影，但必须有持久“正在更新”标记，所有 correction/delete/export 动作绑定 `shownCursor` 并在 stale 时禁用。不得对旧 projection 乐观提交。

Projection 完成后只有 sourceCursor CAS 成功才可一次性替换 read model；失败则保持 stale 并重新读取。替换必须按稳定 entity key 保留焦点、展开状态和滚动锚点；目标实体消失时焦点移到所属 section heading。failed 状态不得清空 canonical 数据或伪装成 first-run。

### 12.10 RecoverySurface 与可见恢复动作

RECOVERY_ONLY/CLEAR_ONLY 必须渲染 `RecoverySurface`，不能只改变 Orb 颜色。Surface 为持久 `role="region"`，由 heading 命名；阶段进度使用嵌套 `role="status"`，不可恢复/blocked 错误使用单次 `role="alert"`。进入安全模式时焦点移到 heading；恢复完成返回 invoker，invoker 不存在则返回 global status。

动作必须由当前 ErrorPolicy/RecoveryMode 穷尽决定：

- RECOVERY_ONLY：`resume-recovery`、适用时 `close-other-clients/free-space`、`download-diagnostics`、最终 `clear-all`；
- CLEAR_ONLY：只允许 `close-other-clients/free-space/clear-all` 与无业务 payload 的帮助；
- blocked：主动作是关闭其他 ProAGI 标签后重试，不能显示完成；
- recovery 进行中：显示固定阶段名和粗粒度 progress，不显示 target ID、statement、路径、hash 或 canary。

PRIVATE 下 RecoverySurface 仍必须可操作；恢复动作不得隐式 resume observation。关闭 dialog、route change 或刷新不得隐藏仍未解除的安全模式 banner。

### 12.11 CoarseSourceLabel 与 accessibility tree 隐私

Orb 的 accessible name MUST 只取固定可见状态名：`ProAGI：感知学习中|本地处理中|待命|建议可用|错误|隐私保护中`，不得拼接来源、动作、statement、reason、validator issue、路径、URL、命令、项目名或其他动态输入。可见状态文本必须包含 accessible name 的核心词，满足 Label in Name。

来源只可通过可见文本及 `aria-describedby` 引用 `CoarseSourceLabel` 五个固定值之一；不得把 adapter/source 原值插入 aria-label、aria-description、title、alt、data-*、hidden DOM 或 live region。DOM 与完整 accessibility tree 都属于 privacy canary sink；restricted/prohibited 原值出现次数必须为 0。装饰 Orb part、视觉 diff 标记和背景 illustration 必须 `aria-hidden=true`。

### 12.12 UiErrorContract 与 UiAnnouncement

每个 `ErrorCode` MUST 在 `UI_ERROR_REGISTRY` 恰有一项，并与 `ERROR_POLICY` 的 nextAction/safeState 一致；启动时缺项、重复或未知私有错误码必须进入 READ_ONLY/ERROR。错误正文只能来自固定 message key，动态字段只允许静态 field token 和粗粒度计数，不得回显 payload。

- field validation → inline + error summary，焦点到首个错误字段；
- stale/cursor conflict → banner，主动作 refresh；
- destructive confirmation → modal dialog，初焦点在取消；
- RECOVERY_ONLY/CLEAR_ONLY → blocking RecoverySurface；
- ERROR assertive announcement 每个 correlationId 只播报一次，不能循环；
- 进度 polite announcement 只在阶段变化或跨越 10% 阶梯时播报；
- 相同 key/value 在 dedupeWindow 内不得重复播报。

`UI_ANNOUNCEMENT_REGISTRY` 必须穷尽允许的 announcement。内容只可插入 coarseSourceLabel、percent、acceptedCount、rejectedCount；不得插入 statement、reason、路径、错误输入或动态来源。进入 PRIVATE、privacyEpoch 变化、clear 或 recovery fence 时必须取消旧 UI task、清空 announcement queue，禁止播报旧 epoch 的“导入成功/纠正成功”。Orb 装饰本身不得设置 aria-live。

### 12.13 Menu、popover、dialog 与焦点

Orb 是一个 button。Enter/Space 与单击打开状态/Inbox popover；Shift+F10 或可见“更多”按钮打开 menu。Menu 使用 `role=menu/menuitem`、Arrow/Home/End 导航、Escape 关闭并返回 Orb；无 JavaScript 增强时，可见按钮/链接仍可到达相同页面。

非模态建议使用 popover：不得自动抢焦点；hover 或 focus 进入后保持可操作；指针离开不得立即消失；Escape、关闭和忽略均可 dismiss。Tooltip 仅作补充，不能承载任务必需信息，并满足 hover/focus/persistent/dismissible。

需要确认删除、清空、导出或丢弃编辑时使用 modal dialog：初焦点置于最安全动作，Tab 被约束在 dialog 内，Escape 的行为必须明确，关闭后焦点回 invoker。背景设 inert/等价机制，但 dialog 自身、RecoverySurface 和系统级 PRIVATE 入口不得被错误隐藏。

每个 route/view 必须恰有一个可见 h1；heading 不跳级。任何 panel 替换、错误出现、数据刷新都不得把焦点重置到 body。

### 12.14 Move Orb 等价键盘路径

拖拽不是必需路径。设置/menu 中 MUST 有可见“移动球体”动作，进入 MoveOrb 模式后：

- Arrow 每次移动 8 CSS px；Shift+Arrow 每次 32 CSS px；
- Enter 保存位置并退出；Escape 恢复进入模式前的位置并退出；
- 可见“重置位置”将 Orb 放回当前布局规定的 safe-area dock；
- 每次移动都 clamp 到 viewport、safe-area、8px inset 和不遮挡关键 CTA 的区域；
- resize、zoom、orientation/virtual keyboard 变化后重新 clamp；
- 移动过程用节流 polite 文案播报“上/下/左/右，位置已限制”，不播报精确屏幕坐标。

保存位置属于无敏感 UI preference，可使用 localStorage；不得写入 canonical business record。pointercancel、lostpointercapture、切 PRIVATE 或进入 recovery 时必须取消未保存拖拽，不提交位置。

### 12.15 单击、双击、长按仅作增强

单击/Enter/Space 是 canonical Orb 操作。Today 和控制面板必须有可见 button/menuitem；双击打开 Today、长按打开控制面板 MAY 作为增强，但其失败不影响任务完成。实现双击时必须取消待执行的单击 side effect，避免先开 popover 再导航；长按必须有移动阈值、超时和 pointercancel，取消时不得提交命令。旋转手势 MUST NOT 实现。

### 12.16 UI intent 幂等与 pending lock

所有产生领域写入或安全状态变化的用户意图 MUST 先创建 `UiIntentCommand(commandId,intentKey,baseCursor,privacyEpoch)`。`intentKey` 由 action kind、目标稳定 key、baseCursor 和 privacyEpoch 构成；同一 pending intent 的 click、Enter、Space、key repeat、双击或 pointerup 只能复用同一 commandId，不得二次 submit。

提交期间控件 MUST 原生 disabled（不可 disabled 时使用 aria-disabled 且拦截 handler）、显示固定 pending 文本并保留焦点。响应丢失时先通过 CommitLedger/最新 canonical state 查询 commandId/idempotency 结果，禁止生成新 commandId 盲重试。成功只在最新 cursor/epoch/mode 与 receipt 匹配后显示；失败按 UiErrorContract 解锁或保持安全锁。重复 announcement 也按 commandId/correlationId 去重。

### 12.17 浏览器能力不可用时的安全失败

M1 启动 MUST 明确探测 IndexedDB、Worker 与 BroadcastChannel：

| 不可用/失败 | 安全行为 |
|---|---|
| IndexedDB unsupported/denied/open failed | 不进入业务 UI；显示 blocking unsupported surface；只允许帮助、重试和清浏览器站点数据；禁止降级 localStorage 或宣称持久化 |
| Worker unsupported/start/crash/protocol mismatch | 取消 stream，释放 input/staging/preview，committed=0（提交期则按 receipt 报已提交 batch）；禁止主线程静默解析大文件 |
| BroadcastChannel unsupported | 不开放需要跨标签正确性的普通写、PRIVATE 切换、删除或 clear；显示“此浏览器不支持安全的多标签协调”，禁止轮询/内存事件假装等价 |
| BroadcastChannel runtime failure | 原子递增 epoch/进入安全模式；取消旧任务；要求关闭其他标签或使用受支持浏览器 |

任何能力失败都必须使用固定 ErrorCode/UiErrorContract，不得显示 fixture 示例冒充已加载数据。重新探测成功后重新读取 StoreMeta/journal/cursor，不得复用旧 preview token。

### 12.18 文档语义、Label in Name 与 correction form

根 `<html>` MUST 为 `lang="zh-CN"`；页面 MUST 有跳到 `<main>` 的首个可聚焦 skip link，以及 header、nav、main、aside landmarks。route title 与唯一 h1 同步；Privacy 与 Help 必须位于固定、可见导航位置。

所有 icon button 必须有固定中文可访问名称；有可见文字的控件，其 accessible name MUST 包含同序可见文字，例如“预览建议”“暂停观察”“恢复观察”“删除”“保存修改”。禁止用不含可见 label 的 aria-label 覆盖按钮文字。

Correction form MUST 使用原生 `<form>`、`<label for>`、fieldset/legend（适用时）和 button。statement/scope 每个字段有帮助文本、字符/范围限制和稳定 describedby；错误同时出现在字段旁及顶部 error summary，使用 `aria-invalid` 与 `aria-errormessage`，summary 链接到字段。验证失败或 revision conflict 时保留用户输入；不得把输入写入日志/live announcement。

删除确认必须明确“将物理删除整个 lineage 且不可恢复”，显示实体类别而非 statement/敏感内容，并要求独立确认。accept/reject/delete 的 pending lock 与 commandId 规则同样适用。提交成功后焦点移到新 revision heading或所属 Inbox heading；失败回到 error summary/目标字段。

### 12.19 M1 边界与 UI 验收

M1 UI MUST 明示“fixture/本地 JSON 研究原型”“未连接真实桌面”“Shadow-only”。不得渲染真实观察指示灯、UIA connected、Runtime connected、自动发送/写文件成功或类似假状态。ActionIntent 唯一 CTA 为“预览建议”，不得出现“运行/执行/应用技能”。

自动门禁至少包括：VisualContract legacy/prohibited 文案扫描、VisualToken 类型穷尽、Orb anatomy part 数量、六态文本/图标、forced-colors、320/360/768/1280 与 200% reflow、global reduced-motion、PresentationStateResolver 笛卡尔表、EmptyState/UiError/UiAnnouncement registry 穷尽、accessibility-tree canary、RecoverySurface focus/actions、MoveOrb 键盘路径、pending intent 去重、unsupported API safe failure、landmarks/skip/Label-in-Name/correction form。视觉 screenshot diff 只比较 `VisualContractV1` 批准区域并作为趋势证据，不能代替结构、领域状态或隐私门禁。

## 13. 本地持久化与导出

### 13.1 Store、索引与容量

canonical store MUST 使用 IndexedDB；localStorage 仅可保存无敏感 UI 偏好。local-first 不等于静态加密，产品必须说明其不能防同机用户、恶意扩展、profile 同步/备份或磁盘取证；M1 仅 synthetic，M2 的残余风险必须进入 consent。

IDB schema MUST 明确定义以下 stores，不得把控制记录混入业务 payload：

- `meta`：唯一 StoreMeta；
- `liveEntities` 与 `systemRecords`：live business/system StoredRecord；
- `knowledgeHeads`、`workflowHeads`、`projectionHeads`：CAS heads；
- `commitLedger`、`changeFeed`、`previewCommitGuards`、短期 `previewBuffers`、`importSessions` 与受限 `importStaging`；
- `recoveryLease`、`deletionPlans`、`activeDeletionJournals`、`verifiedDeletionJournals`、`deletionWorkItems`、`clientRegistrations`、`purgeAcks`、`reachabilityRootReceipts`；
- `tombstones`、`auditEvents`、`exportReceipts`、`artifactDisposalReceipts`。

最小索引 MUST 为：`events.byDedupeKey(unique)`、`events.byFactHash(nonunique)`、`episodes.byEventId`、`claims.byEvidenceEntityId`、`knowledgeVersions.byClaimRevisionId`、`workflowRevisions.byEvidenceEntityId`、`evaluations.byInputEntityId`、`changeFeed.byCursor`、`deletionWorkItems.byDeletionAndStateOrdinal`、`journals.byState`。factHash 只服务 Replay 语义聚合，不得唯一；ConstraintError 仅按 dedupeKey 回读，相同 key+contentHash 幂等，不同 contentHash 返回 ERR_DUPLICATE_CONFLICT。

SizeProfileV1 固定 80/100 MiB 阈值与 5 MiB reserve。每个写事务 MUST 用 StoreMeta.sizeEstimatorVersion 对 mutation 计算 deterministic byte delta，并原子更新 logicalBytes/recoveryBytes；±1 byte 边界必须测试。普通 import/correction/projection/export staging 不得侵占 reserve；recovery 使用也不得让 recoveryBytes 超限。`navigator.storage.estimate()` 仅作提示，不能替代逻辑 accounting；达到配额时 read/delete/recovery/clear 仍可用。

### 13.2 平台中立 batch 到 IDB transaction

Application 只能提交 §5 平台中立 `AtomicMutationBatch`。IDB adapter MUST 在创建 transaction 前验证 batchHash，并把 `storeNames` 映射为完整、去重、排序的具体 store 集合；transaction 必须预开这些 stores以及固定必需的 `meta/commitLedger/changeFeed`，开始后不得动态增加 store。mutation 引用未声明 store、storeNames 不等于实际集合或映射未知 MUST fail closed。

每个普通 batch 的单个短 transaction MUST：

1. 读取并复核 expectedCursor、expectedPrivacyEpoch；
2. 要求 `recoveryMode=NORMAL`；
3. 复核 observationMode，observation commit 必须为 ACTIVE，PRIVATE 下其他操作按 capability matrix；
4. 查询 idempotencyKey：同 key+batchHash 返回原 CommitLedger，不重复 mutation；同 key 异 hash 报 ERR_IDEMPOTENCY_CONFLICT；
5. 穷尽执行 insertImmutable/casSingleton/deleteIfHash/casProjectionHead，并拒绝 generic put；
6. 为每个 affected ref 追加 ChangeRecordDTO；
7. 写 CommitLedger，原子更新 logicalBytes/recoveryBytes，并将 cursor 用 BigInt 加一。

步骤 1–7 MUST 同事务成功或 abort；adapter 不得在 transaction 内等待网络、Worker、用户 callback 或任意非 IDB promise。事务提交但响应丢失时，重试必须先查 ledger。一个 batch 最多 500 个 record mutation 或 4 MiB 估算 payload；50k import MUST 分为多个 batch，禁止宣称整个文件单事务原子。每个已提交 batch 独立可恢复并出现在 receipt。

KnowledgePort `scanEntities` 的 page token MUST 绑定 snapshotCursor、recordTypes 与最后 key；读取期间 cursor 改变时，旧 token 返回 ERR_CURSOR_CONFLICT。`loadChangesSince` 必须按 BigInt cursor 顺序分页并返回 hasMore。Projection 首次可从 snapshot bootstrap，之后 SHOULD 消费 change feed；写 projection 时以 ProjectionHeadDTO.sourceCursor CAS，CAS 失败丢弃本次投影并从新 cursor 重算，旧 projection 不得覆盖新 head。projection cache rebuild 不递增 canonical cursor。

首次启动必须记录 schemaVersion；更高未知版本保持只读。开放普通写前必须执行 migration registry 检查，并优先恢复 §9 的 active deletion journal。多标签使用 BroadcastChannel 加 versionchange/blocked/close；它只做协调，不替代 transaction 内 meta 复核。

### 13.3 NDJSON V1 与 Worker 背压

大输入 MUST 使用 §5 `NdjsonLineV1`：第一条且仅一条 header，中间恰为 `declaredEventCount` 条 event，最后一条且仅一条 footer。event.sequence 必须从 `"0"` 连续递增并以 BigInt 比较；footer.eventCount 必须等于 header 声明与实际计数，orderedEventsHash 覆盖按 sequence 的原始规范化 event 行。footer 后有非空字节、缺行、重复 header/footer、计数/hash 不符均整流验证失败。

主线程与 Worker 仅使用 `INIT/CHUNK/VALIDATED/ACK/CANCEL/COMPLETE` tagged messages：

1. INIT 冻结 streamId、header、maxChunkBytes；maxChunkBytes MUST ≤ 262,144，maxUnacked 固定 2；
2. CHUNK 只按原始 byteLength≤262,144 切 transferable bytes，可落在多字节码点、CRLF或行中；主线程不得先解码找边界；
3. Worker 用持久 `TextDecoder("utf-8",{fatal:true})` streaming decode并负责BOM/CRLF/LF/行 framing，再校验每批最多500 event行、连续sequence、schema/allowlist/redaction/hash后发VALIDATED；
4. Worker 最多保留 2 个未 ACK 的 VALIDATED，达到上限必须停止读取/解析后续 CHUNK；主线程持久接收结果或安全释放缓冲后才发 ACK；
5. 收到 CANCEL 后 Worker 停止接收新 chunk、释放未 ACK 缓冲，并且只发一次 COMPLETE；
6. 正常流只有在 header、全部 event、footer 与 orderedEventsHash **完整验证通过后** 才可进入 commit 阶段。

完整验证不等于单事务：Application 以独立 canonicalizer/schema 重新校验 candidates并计算 appCanonicalEventsHash，再按§13.2上限把 batch提交到 `ImportSession` 隔离 staging。收到取消时当前transaction可完成或abort但不启动下一batch；已提交staging batch不伪称回滚，却在session publish前对Sensemaking/Projection/Replay不可见，默认由dispose/delete协议清除。只有全部batch ledger与footer/hash对齐，Application才原子设PUBLISHED/publishedCursor。UI区分“暂存N条，尚未发布”与“已发布N条”，不得称截断输入已保存。

Worker不得访问canonical store或声明committed cursor；它只产生WorkerValidationReceipt。Application复核streamId/chunkId/sequence/workerBytesHash、最新epoch/modes及每个candidate exact schema，再独立生成AppImportCommitReceipt并组合ImportStreamReceipt。staging计入普通100MB逻辑预算且不得侵占5MiB recovery reserve；publish/cancel/fail/PRIVATE/clear/unmount时ImportStreamController.dispose幂等释放reader/Worker/listener/timer/objectURL/buffer，取消/失败默认物理删unpublished staging。

### 13.4 导出与 clear

导出使用 §5 `ExportEnvelopeV1` 的准确字段 `{exportVersion,exportId,exportedAt,pins,sourceCursor,records,manifest,notice,envelopeHash}`。records 必须先经 §10 MigrationRegistry 转为 targetExportSchemaVersion；manifest.recordsHash 与 envelopeHash 按 §10 canonical profile 计算，排除 exportedAt、自引用 envelopeHash 与 tombstone。导出前显示类别、数量、最高分类和“本地文件不可远程撤回”，并要求显式确认。Web adapter 只把平台中立 ExportArtifact 转换为下载；canonical store 仅保存无 payload ExportReceipt，Shadow 不得调用 export。

clear-all、跨 client PURGE、5 秒 blocked、ERR_STORAGE_BLOCKED、CLEAR_ONLY 与成功条件完全引用 §9.3，不在本节建立第二套状态机。清除成功后默认不留用户相关计数；如需证明，用户必须在清除前主动下载无 payload evidence。

### 13.5 Test-only failpoints

测试构建 MUST 提供确定性 failpoints：`after-meta-check`、`after-mutation-n`、`before-head-cas`、`before-change-feed`、`before-ledger`、`before-transaction-complete`、`after-commit-before-response`、`delete-after-fence`、`delete-after-chunk`、`delete-after-audit-before-verified`、`worker-after-validated`、`worker-after-cancel`。每个点必须可按 batch/stream ID 单次触发，用于证明 abort、ledger 幂等、response-loss、背压、取消 receipt 和 crash resume。

failpoint API、标志、字符串表与分支 MUST 由 production bundler 条件编译并经静态扫描确认不存在于 production application bundle；仅运行时 `if (production)` 禁用不合格。fake-indexeddb 只承担 contract/fault injection；固定 revision 的真实 Chromium MUST 覆盖 transaction inactivity、reload/crash、quota、双标签 blocked/versionchange、Worker backpressure/cancel 与持久化恢复。

## 14. 端到端用例与验收条件

### E2E-01 导入至日报

Given manifest 明确标为 eligible 的 clean fixture 含 code/test/git 事件，When 用户预览并导入，Then 按 manifest 生成确定 Episode/Report/Claim/Question/SkillCandidate/Shadow ActionIntent；另有 abstain fixture 必须生成 0 个对应候选。
- AC-01：两次冷启动导入的 domain outputHash 相同。
- AC-02：每个实际产出的派生对象 evidence 可反查到 live event，hash 校验通过；0 输出不伪造对象。
- AC-03：持久化扫描找不到未允许字段、secret canary、raw path、URL 或 command。

### E2E-02 接受

Given proposed Claim，When accept，Then 持久化 terminal applied CorrectionRecord、追加 confirmed Claim revision 与 KnowledgeVersion v1，并由 KnowledgeHead CAS 指向 v1。
- AC-04：刷新页面后状态与 lineage 不变。
- AC-05：同输入 Replay 采用 v1，EvaluationResult passed。

### E2E-03 编辑吸收与局部性

Given Claim 错将 test-first 推断为 build-first，When 用户编辑 statement/scope，Then 产生新 revision 与 KnowledgeVersion。
- AC-06：相邻 held-out 正例 Replay 输出采用编辑值，`correctionAbsorbed=true`。
- AC-07：近邻负例及 scope 外子树 hash 不变，`localityPreserved=true`。
- AC-08：旧 KnowledgeVersion 仍可审计，但 KnowledgeHead 只指向新版本。

### E2E-04 驳回不重提

Given proposed Claim，When reject 后 Replay 相同及乱序/重复输入，Then 不出现同 scope 同语义候选。
- AC-09：Correction applied 且抑制知识可追溯。
- AC-10：仅改变无关 ID 或输入顺序不绕过抑制。

### E2E-05 删除级联

Given event 已派生到全部对象并导出过，When 删除 event，Then cascade 成功且重建。
- AC-11：查询、Inbox、Report、索引、新导出和 Replay 均不可达原 payload/canary。
- AC-12：旧 EvaluationResult payload 与 deleted EntityRef 消失；只存在无原 ID/hash/evidence 的随机 EvaluationInvalidationReceipt 和 DeletionTombstone。
- AC-13a：T0 fence transaction 任一 request 失败则全部 abort、cursor/recoveryMode/stores 不变。
- AC-13b：test-only failpoint 在 T0/chunk/audit 原子点崩溃后，启动按 journal state/progress 幂等恢复；reachability=0 且 required clients PURGED 后才 verified+NORMAL。
- AC-13c：旧 revision restore 返回 `ERR_DELETED_RESTORE_FORBIDDEN`；未来显式新 import 只能创建全新 lineage。

### E2E-06 隐私与 PRIVATE

Given Orb 进入 PRIVATE，When 导入事件，Then 返回 `ERR_PRIVATE_MODE` 且零普通写入。
- AC-14：恢复后只进入 IDLE，不补写暂停事件；PRIVATE 仍允许 read/delete/clear/recovery。
- AC-15：unknown item 拒绝；optional secret drop 后重验；required secret 拒绝；日志无原值/动态 key。
- AC-15b：在 parse、preview-confirm、transaction-before-commit 切 PRIVATE，旧 privacyEpoch 均不能提交；双标签 clear/import 也不得复活数据。

### E2E-07 Shadow 边界

Given SkillCandidate，When 用户选择“仅影子预览”，Then ActionIntent 变 previewed，仅显示 hypotheticalSteps。
- AC-16：从 submitShadow/ShadowPreview 调用图可达的未授权 external network、process、OS filesystem、input injection spy 均为 0；仅允许 ActionIntent/审计写 canonical store，Shadow 不得调用 export。
- AC-17：模拟副作用请求得到 `ERR_SHADOW_VIOLATION`，Orb 为 ERROR。

### E2E-08 Orb 无障碍

Given 键盘、读屏模拟、zoom/forced-colors/reduced-motion，When 遍历六态、菜单、恢复和MoveOrb，Then 所有关键操作可完成。
- AC-18：六态固定文本/图标/name、七层结构齐全；axe critical=0且serious=0，DOM/accessibility-tree canary=0。
- AC-19：Enter/Space、Shift+F10、Escape/Tab、MoveOrb Arrow/Shift+Arrow/Enter/Reset、RecoverySurface 焦点与返回符合§12。
- AC-20：320px/200%/text-spacing无关键裁切或双轴滚动；forced-colors可辨；reduced-motion全局禁非必要位移，ERROR不高频闪烁。

### E2E-09 本地恢复与导出

Given 完整闭环，When 刷新、离线重开并导出，Then canonical 状态一致。
- AC-21：刷新前后每类实体数与 hash 相同。
- AC-22：导出 manifest hash 可独立重算，且不含 deleted payload 或非 allowlist 字段。
- AC-23：清除全部后重开为空库，旧下载文件不可撤回的边界已提示。

## 15. 测试与完成定义

单元测试 MUST 覆盖每个 schema 边界、所有合法/非法状态转换、hash、排序、redaction 和错误映射。
属性测试 MUST 随机置乱/重复事件，证明 canonical hash 不变；随机编辑目标 scope，证明 locality。
Vitest + fake-indexeddb 覆盖 contract、CAS、索引和可控 request/audit/compensation failure；它不能单独证明真实 quota/crash/multi-tab。
Playwright + lockfile 固定的真实 Chromium MUST 覆盖 transaction inactivity、reload/close crash window、双标签导入/edit/clear、blocked/versionchange 与持久化恢复。E2E 用最终 IDB/领域快照断言，不以 UI 文案单独判定。
CI 只扫描 production application bundle 从 ActionPort/ShadowPreview 可达的 forbidden external network/process/OS-fs/input 调用；dev HMR、test runner、同源静态资源、canonical IDB 和用户显式 export 不计为 action。
完成定义：全部 MUST 条款有自动测试或静态检查；所有 AC（含 13a–c、15b）与 INV-001 至 INV-011 全绿；`SPEC.md` 与实现 schema 同版本。

## 16. 明确声明边界

本规格只证明：白名单事件可形成可审计工作理解，且用户纠正能被确定性 Replay 吸收。
本规格不证明真实桌面噪声鲁棒性、用户长期价值、UIA 覆盖率、模型质量或自动化执行安全；任何演示、README 或 UI MUST NOT 声称已接入真实 UIA、Codex、Tauri 或完成桌面自动化。
下一阶段只有在本规格全部完成后，才 MAY 增加一个用户主动选择、只读、短期保留的真实事件源。
