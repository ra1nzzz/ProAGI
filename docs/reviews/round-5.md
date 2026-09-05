# REVIEW Round 5 — Adversarial Integration / Final Review

**轮次**：5/5（最后一轮；禁止 Round 6）  
**范围**：最终 PRD + SPEC/ARCH/PLAN/CHECKPOINT/EVAL，结合 Round 1–4 与 prototype mood board  
**方法**：三维只读 YT review + 主代理端到端/随机性/删除可达性扫描

## 趋势评分（非门禁）

- A 跨文档一致性与端到端实现：**6.0/10**
- B 安全、并发与性能：**7.0/10**
- C 交付、UI 与 EVAL readiness：**7.0/10**

分数不是 8/10 硬门禁。合并去重后存在 11 个 P0 contract finding，裁决 `CONDITIONAL`。这不触发第六轮；以下 finding 必须在 final stitch 中择优合并并修订，然后直接实施。

## P0 合并清单

| ID | 问题 | 决策与最小修复 |
|---|---|---|
| R5-01 | Capability 有 privacy/storage/recovery，但 Operation/六 Port 无 pause/resume/recover/clear；Replay 只有纯函数 | 冻结 application control use-case contract；不让 UI/adapter 自行编排。Replay use case 构造输入、调用纯 ReplayV1并持久化 terminal EvaluationResult |
| R5-02 | delete CorrectionRecord/KnowledgeVersion/head/ledger/change feed 仍可引用已删 ID，与 verified 不可达冲突 | privacy delete 优先 immutable/append-only；所有关联 record 物理删。delete CorrectionRecord 仅 recovery 临时，Tv 前删除，只留随机无关联 receipts |
| R5-03 | PreviewToken single-use 没有跨标签线性化点 | 增 PreviewCommitGuardV1；token hash guard CAS、mutations、ledger、receipt 同一 transaction；source bytes 只在短期 buffer，无 buffer fail closed |
| R5-04 | DeletionPlan snapshot 到 T0 可被新引用穿越 | T0 必须等值复核 plan.baseCursor/epoch并重算 planHash；冲突零写并重新规划 |
| R5-05 | PURGE required client membership 与“关闭后重试”均未闭合 | T0 建 generation/cutoff；新 client 加 required set或QUARANTINED；Audit前seal；RetryPurge关闭旧generation并原子重算，旧ACK失效 |
| R5-06 | “单实例 recovery lease”没有 DTO/CAS/fencing/steal 规则 | 增 RecoveryLease owner/generation/fencingToken/renew/expiry；每个 recovery transaction CAS token；时钟异常 fail closed |
| R5-07 | Reachability roots 不是从 Store/Sink registry 穷尽生成 | 覆盖所有 IDB stores、ledger/change feed、preview/import staging、Worker/client/UI/a11y/announcement/cache/artifacts；逐 root oracle与藏 canary 负例 |
| R5-08 | NDJSON Worker 使用 string，无法验证非法 UTF-8/原始 byte 上限 | input 分 inline/stream；CHUNK 用 transferable bytes，Worker fatal streaming decoder；App独立重算 canonical bytes/hash |
| R5-09 | ShadowPreview root 未定义，且浏览器副作用 sink 不穷尽 | 定义 ShadowPreviewDTO/正式 renderer root；唯一 ForbiddenBrowserEffectSinkRegistryV1，覆盖 network/navigation/download/clipboard/share/SW/worker bridge/custom schemes |
| R5-10 | DOM/a11y canary 规则误伤合法 local-sensitive statement/reason | approved live local-sensitive 只可进入可见正文/表单及等价 a11y text；禁止进入 accessible name/description/title/data/live/hidden/log/published artifacts；restricted/prohibited/deleted仍全 sink=0 |
| R5-11 | Episode comparator 使用随机 UUIDv7 `id`，破坏 fresh-run 确定性 | 比较器固定 `(occurredAt,kind,factHash,dedupeKey,contentHash)`；随机 ingress ID 不参与语义排序/hash |

## P1 合并清单

| ID | 问题 | 决策 |
|---|---|---|
| R5-12 | generic mutation 可表达覆盖 immutable/head无CAS | 拆 insertImmutable/casSingleton/deleteIfHash/casProjectionHead tagged union |
| R5-13 | T0 写全部 work、Tv 删全部 work/ACK，规模上不成立 | FENCED内分页enumerate；chunk处理后移除work；FINALIZING分页清理，最后短Tv |
| R5-14 | 5MiB reserve无原子 logical accounting | StoreMeta加 logical/recovery bytes与estimator version，普通事务原子更新 |
| R5-15 | Worker自报accepted/hash，COMPLETE却声称App commit结果 | 分 WorkerValidationReceipt 与 App ImportCommitReceipt；App独立校验和组合UI receipt |
| R5-16 | partial committed import可能从截断文件学习 | ImportSession/Head：完整发布前对Sensemaking不可见；取消默认删除或重新确认 |
| R5-17 | BC只是通知却在缺失时禁止PRIVATE/clear | PRIVATE仍以IDB meta/epoch正确；仅依赖跨client purge的target delete降级，clear尝试versionchange/blocked并诚实提示 |
| R5-18 | StorageMigrationV1 被多文档引用但SPEC未定义 | 现在冻结DTO/状态/hash/count/switch/rollback；实现仍留M5 |
| R5-19 | PortRequestContext/UiIntent 缺 correlation/idempotency 传播 | 加 correlationId/idempotencyKey；一次intent贯穿command/batch/ledger/announcement |
| R5-20 | UI oracle在name/description、table横滚、Recovery焦点上漂移 | name仅固定状态，coarse source只description；仅code可横滚；Recovery初焦点heading，返回invoker否则global status |
| R5-21 | PLAN M1局部脚本漏新增suite | §3.5以verify:pr为唯一聚合，release适用时verify:release；禁止双列表漂移 |
| R5-22 | M1a/b/c无内部checkpoint | 增1a core/oracle、1b persistence/delete/worker/projection、1c UI/a11y/visual；只有三者全过才Gate1 |
| R5-23 | Evidence Pack树落后、retention/NVDA规则不清 | 增独立input/gold/evaluator/oracle/mutation/visual/a11y/tier artifacts；PR14d/nightly90d/release长期；NVDA NOT_RUN最多CONDITIONAL且禁宣传 |
| R5-24 | Visual required baseline仍optional | M1c required cases强制screenshotHash+approvalId；pixel不替代结构/a11y |
| R5-25 | M1 local JSON可能误收真实敏感数据 | M1仅 bundled/synthetic/用户专为测试准备的 schema fixture；任意真实数据推迟到M2 consent |
| R5-26 | M2 Gate可在无正NetValue时PASS | NetValue median>0才PASS；证据不足CONDITIONAL；持续净负STOP |
| R5-27 | evaluator与replay包物理边界不足 | replay-core、reference-evaluator、gold-artifacts分包并用lint/dependency graph强制 |

## P2 合并清单

1. SPEC状态统一 `Contract Ready / Implementation Pending`，实现证据前Gate1=NOT_RUN。
2. ARCH telemetry目录改diagnostics，避免暗示第七Port；DailyReport统一DailyReportSnapshot。
3. Visual sRGB 用运行时 schema `^#[0-9A-F]{6}$`，不只模板字面量。
4. 冻结 rawChunkBytes/canonicalMutationBytes/estimatedStorageBytes 三种上限与±1测试。
5. TestArtifactSinkRegistry覆盖video/HAR/trace/reporter/console/source-map/CI upload；扫描、隔离、TTL、销毁receipt。
6. ImportStreamController.dispose清理reader/worker/listener/timer/objectURL/buffer。
7. 性能增加非门禁交互p95/LongTask/cancel响应/Recovery首显趋势。
8. statisticsProfile冻结Clopper–Pearson双侧95%、alpha、独立单位与bootstrap seed。

## Round 4 复核

Visual/AppShell/Orb anatomy、RecoverySurface、MoveOrb、Preview/head/Replay/Worker/Projection evaluator已显著闭合。重新打开项集中在：Preview原子消费、跨标签删除membership、合法正文可访问隐私边界、字节流所有权与真实application入口。Round4结构扫描本身有效，但不等于实现测试。

## 六类盲区

- **幂等性**：token、UI intent、batch ledger、Worker receipt、PURGE generation、recovery lease必须有单一代际链。
- **安全性**：browser-native effects、a11y语义位置和测试artifact是主要新sink。
- **可观察性**：仅记录无payload guard state、lease generation、client cutoff、root counts/high-watermark与artifact policy。
- **数据完整性**：T0基线、随机ID排序、partial import visibility、generic put和Worker hash owner是主要风险。
- **并发竞态**：plan后新引用、PURGE/Audit间新client、双recovery owner、双token commit、迟到Worker message必须有确定barrier fixture。
- **外部依赖韧性**：真实Chromium覆盖IDB/Worker/BC/quota/versionchange；fake不得替代；不支持环境INVALID/安全降级。

## 最终轮裁决

- **不得开启 Round 6**。
- final stitch 按顺序：P0 privacy/linearization → P0 byte/effect/a11y → P1 scalability/ownership → delivery/evidence。
- 修订后直接进入 M1a→M1b→M1c 实现；无package/tests/CI/evidence之前 Gate1 必须是 NOT_RUN。

## 修订完成记录

Round 5全部P0与被选P1已在六件套关闭：application ControlPort、guard atomic consume、T0 baseline、FENCED分页、PURGE generation/quarantine/seal/retry、RecoveryLease、registry-derived audit、fatal byte Worker、ImportSession publish、browser effect registry、合法正文a11y、tagged mutations、reserve accounting与migration DTO均已同步。结构/命名/旧语义扫描结果及未采纳项记录在 `final-stitch.md`；本记录不是第6轮Review。
