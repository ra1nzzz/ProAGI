# ProAGI 六件套 Final Stitch

**日期**：2026-09-04  
**状态**：文档冻结；转入 M1a → M1b → M1c 实现  
**性质**：五轮 REVIEW 后的主代理择优缝合，**不是 Round 6**

## 1. 输入与停止条件

本次缝合使用原始 PRD、`docs/research/deep-research-report.md`、`reference/Prototype reference1.png`、当前六件套及 `round-1.md` 至 `round-5.md`。评审严格止于 5/5；8/10 仅作趋势比较，不是门禁。

| Round | 质量/可验证性 | 效率/可实施性 | 复用/一致性 | 主要结果 |
|---|---:|---:|---:|---|
| 1 | 7.1 | 5.5 | 5.8 | 收窄为 Insight Loop，建立首批领域边界 |
| 2 | 6.8 | 6.8 | 7.1 | 隐私、consent、删除与 IDB 原子性收敛；P0=0 |
| 3 | 6.3 | 7.4 | 7.4 | Replay、migration、Worker、head/ledger/change feed 收敛 |
| 4 | 5.4 | 6.4 | 6.2 | UI/视觉/a11y/EVAL 深化并修复 5 个 P0 |
| 5 | 6.0 | 7.0 | 7.0 | 对抗式集成暴露 11 个 P0；全部进入本次缝合 |

分数下降不代表倒退：Round 4/5 使用更严格、覆盖更广的检查面。最终结论由风险与可验证契约决定，而非分数平均。

## 2. 最终采纳

### 2.1 P0 全部采纳

1. UI/CLI 只能经正式 application `ObservationPort`、`CorrectionPort`、`ControlPort` 进入；Application 是唯一 canonical writer。
2. `PreviewCommitGuardV1` 持久保存 token hash/binding/state，并在线性化事务内完成 guard CAS、tagged mutations、ledger/change/receipt；response loss 回读原 receipt。
3. 删除 T0 精确校验 cursor、privacyEpoch、snapshot/plan hash；T0 不写全量 work，改为 RECOVERY fence 内分页枚举。
4. PURGE 使用 generation/cutoff/quarantine/seal/retry；新 client 在 purge/ACK 前不可读写或渲染旧数据。
5. `RecoveryLease` 以 generation + fencingToken 阻止双恢复者和旧 owner 迟到提交。
6. reachability 从 `ReachabilityRootRegistryV1`、`LIFECYCLE_BINDINGS` 与测试 artifact registry 穷尽生成，并产生逐 root receipt。
7. 大输入传递原始 transferable bytes；Worker 使用 fatal streaming UTF-8 decoder，Worker validation 与 Application commit receipt 分权。
8. `ImportSession` 完整验证并原子 publish 前不对 Episode/Claim/Report/Projection/Replay 可见；取消或截断默认物理清除 staging。
9. Shadow 使用 `ShadowPreviewDTO` 正式 renderer roots 与 `ForbiddenBrowserEffectSinkRegistryV1`，覆盖 browser-native effect 通道。
10. 合法且仍 live 的 allowlisted local-sensitive statement/reason 可在批准正文/表单及等价 a11y text 中最小展示；restricted/prohibited/deleted 在所有 sink 为 0。
11. UUIDv7/run timestamp 不进入 Episode/Replay 语义排序或 hash；比较器只使用冻结的语义字段。

### 2.2 被选 P1/P2

- mutation 收窄为 immutable insert、singleton CAS、hash-checked delete 与 projection-head CAS；禁止 generic put。
- `logicalBytes/recoveryBytes` 与 estimator version 在事务内核算，5 MiB recovery reserve 不可被普通写侵占。
- 删除增加 `FINALIZING` 分页控制记录清理和短 Tv；privacy delete 优先于 immutable/append-only，linked terminal/version/head/evaluation/ledger/change 均清除。
- BroadcastChannel 只加速通知；正确性依赖 IDB epoch/generation/transaction recheck，无 BC 时安全降级。
- 冻结 `StorageMigrationV1`、correlation/idempotency 传播、artifact sink/retention/disposal、responsive/a11y/focus/name/description 规则。
- M1 仅 bundled/synthetic/test-prepared fixture；任意真实本地 JSON 与真实 source 从 M2 consent 开始。
- M1a/M1b/M1c 均为独立 checkpoint，三者全部 PASS 才可宣称 Gate 1。

## 3. 取舍与拒绝

| 建议 | 裁决 | 理由 |
|---|---|---|
| 不增加 ControlPort，把全部控制操作散到原 ports | 部分拒绝 | 采纳“不增加新的 outbound infrastructure adapter”，但保留一个正式 inbound `ControlPort`；否则 React/CLI 会自行编排 recovery/clear/export，违反 Application 唯一 writer。 |
| 为 enumeration 再增加一个顶层状态 | 拒绝 | `FENCED` 内使用持久 pagination cursor/hash 完成枚举，减少状态数且保留 crash resume。 |
| 让 Worker receipt 直接作为 commit 真值 | 拒绝 | Worker 不可信且无 writer 权；Application 必须独立 schema/hash 并拥有 commit receipt。 |
| 截断 import 保留已提交业务记录 | 拒绝 | 只可保留不可见 staging；默认清除。若用户要保留，必须重新预览、确认并发布为新完整 session。 |
| 禁止 statement/reason 出现在全部 DOM/a11y | 拒绝 | 会使合法正文不可用、不可读屏；改为按分类与语义位置限制扩散。 |
| 以 visual diff 数字替代设计审核 | 拒绝 | required cases 保留 screenshot hash + approval，pixel diff 仅辅助；结构、隐私、a11y 失败不可被图片分数覆盖。 |
| NVDA 未运行仍宣称读屏/WCAG 通过 | 拒绝 | NVDA=`NOT_RUN` 时 M1c/Gate 1 最多 `CONDITIONAL`，禁止相关宣传。 |
| 文档标记 Implementation Ready | 拒绝 | 当前为 Contract Ready / Implementation Pending；代码、测试、CI 与 Evidence Pack 运行后再升级。 |

## 4. 一致性验证

最终扫描已验证：

- 六份 Markdown 围栏全部配对；
- SPEC 195 个 interface/type/class/enum 声明无重复，EVAL 本地声明无重复；
- 六件套不存在旧 `occurredAt,kind,id` comparator、unique factHash、`current | superseded` Knowledge 状态、generic put 或 `Implementation Ready`；
- ControlPort 方法名、Worker/App receipt、ImportSession publish、root/effect/artifact registry 使用当前 SPEC 名称；
- `round-1.md` 至 `round-5.md` 恰为五份，无 Round 6。

## 5. 冻结清单与 SHA-256

| Artifact | SHA-256 |
|---|---|
| `docs/final/PRD.md` | `3c8f2f336295ff757e5aa538cf39501cd6479175e2904e0f9b1606d17ddf5c5a` |
| `docs/final/SPEC.md` | `096e8814f83e7648917460c4c04c330992b665c39e77f22eb77c67d00ac8a96b` |
| `docs/final/ARCH.md` | `334f88a6363acf52bf05facb4a0485684b4bbd1192b6cd5052dcf749a3192dac` |
| `docs/final/PLAN.md` | `c1d931d99a9de8b7d47ab242e541296042e570d7dda1f8182ea6914041877f8f` |
| `docs/final/CHECKPOINT.md` | `6dcb7cc6efc51c5f4ce7ac6a80b105814a7f25930ca0382f9255c3fa5e461ec7` |
| `docs/final/EVAL.md` | `246075b758a43a865d5e87906462695495d49c378ec22fb099144ed098556fb4` |
| `docs/research/deep-research-report.md` | `ed59aff405a01a963960c43b9c1abc587ca42043bccce282839b21c2db14c641` |
| `reference/Prototype reference1.png` | `5f271e42b8b757c1b4c5c57a324480a59e182ddb4fde5bcaddb8122a9dbd8170` |

> 上表是 final stitch 完成后的冻结文档 hash；实现阶段若因已批准 change control 更新契约，Evidence Pack 必须记录新旧 hash 与原因。仓库当前没有 Git 元数据，不伪造 commit hash。

## 6. 交接状态

- Deep Research：完成。
- Idea Refine 与 PRD 对比收敛：完成。
- PRD + SPEC/ARCH/PLAN/CHECKPOINT/EVAL：完成最终缝合。
- REVIEW：完成且止于 5/5。
- Gate 1：`NOT_RUN`；尚无 package、测试、CI 和 Evidence Pack。
- 下一步：依 PLAN 先搭建 npm/React/TypeScript scaffold 与非空测试，再完成 M1a Core/Oracle、M1b IndexedDB/Delete/Worker/Projection、M1c AppShell/Orb/A11y/Visual。
