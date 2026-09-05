# REVIEW Round 1 — 需求完整性与可验收性

**范围**：最终 PRD + SPEC/ARCH/PLAN/CHECKPOINT/EVAL 初稿  
**方法**：YT-Review 三维并行审查 + 主代理六类盲区预扫描  
**日期状态**：修订前基线

## 三维评分

- 质量与需求可验证性：**7.1/10**
- 效率与可实施性：**5.5/10**
- 复用性与跨文档一致性：**5.8/10**

评分只用于比较后续趋势，不构成 8/10 硬门禁。

## 总体裁决

`CONDITIONAL`。P0 = 0；文档明确了 synthetic 不等于用户价值、Shadow-only、provenance 和最终状态断言，方向正确。但存在会让两个合规实现产生不同语义的 P1 冲突，不能把当前 SPEC 的 “Implementation Ready” 当冻结基线。

## 合并 Findings

| ID | Priority | 文件/章节 | 证据与影响 | 修复方案 |
|---|---|---|---|---|
| R1-01 | P1 | PRD §4.3；SPEC §6.4–6.6；ARCH §6/§11 | Claim/Knowledge 状态和 revision 模型冲突 | SPEC 作为 schema 单一真相；Claim revision 与 Knowledge head 分层，统一 lowercase enum，并定义 restore 为新 revision |
| R1-02 | P1 | PRD §5；PLAN §2；ARCH §22；CHECKPOINT | 存在 R0/M1、M1–M5、M0–M6 三套顺序 | PLAN 的 M1–M5 为 canonical roadmap；其他文档增加映射并停止复制另一套编号 |
| R1-03 | P1 | SPEC §1/§10；ARCH §12；EVAL §8 | UUIDv7 与确定性 Replay ID 冲突 | 外部/用户命令使用 UUIDv7；Replay 派生实体使用 namespace+content 的 UUIDv5；明确排除 run-only 字段 |
| R1-04 | P1 | SPEC BehaviorEvent | contentHash 若含 id 无法幂等去重 | 明确 hash 排除 id、ingestedAt、status，仅覆盖规范化事实字段 |
| R1-05 | P1 | SPEC §10；ARCH §12 | Replay comparator 不一致 | 统一为 `(occurredAt, kind, id)`；各文档引用 SPEC canonicalization |
| R1-06 | P1 | SPEC/ARCH schemaVersion | semver string 与 numeric 冲突 | 统一为 semver string `1.0.0` |
| R1-07 | P1 | PRD FR-09；SPEC §13；ARCH §9 | localStorage/IndexedDB 冲突 | IndexedDB 作为 canonical adapter；localStorage 仅允许无敏感 UI preference |
| R1-08 | P1 | SPEC §7；EVAL §5.5；PRD §11 | CorrectionLocality 的 INV/PH 冲突 | M1 确定性 fixture = 1.00 `[INV]`；真实 pilot ≥0.99 `[PH]` |
| R1-09 | P1 | SPEC §6.9–6.11；EVAL §7 | ActionIntent/EvaluationResult 缺完整 evidence/pins | 增加 evidence/provenance 必填字段；条件式产出允许 0 Claim/Question/Skill |
| R1-10 | P1 | SPEC reject/CCR；EVAL §5 | “同语义/相邻 context”不可执行，分母可操纵 | 增加版本化 `semanticKey`、context matcher、预注册 eligible fixture IDs、空分母规则 |
| R1-11 | P1 | SPEC delete cascade/IDB | 事务后 scan 失败再 rollback 不符合 IndexedDB 自动提交 | 在同一事务提交前做引用计划/检查；提交后独立审计失败进入只读安全模式并清除，不声称可回滚已提交事务 |
| R1-12 | P1 | PRD/PLAN 路线图 | PRD 排除真实执行但 PLAN M4 含 live action | 当前 canonical roadmap 将 M4 标为“独立未来 PRD 的条件性研究”，不属于当前产品承诺 |
| R1-13 | P1 | SPEC/ARCH DailyReport | canonical entity 与 projection 冲突 | 定义 `DailyReportSnapshot` 为可缓存派生快照，canonical truth 仍是 events/claim revisions/corrections；可重建 |
| R1-14 | P1 | SPEC §4/E2E | 强制至少一个 Claim/Question/Skill 会鼓励编造 | 改为条件式 0..N；fixture 分别覆盖产出与 abstain，记录 eligibility reason |
| R1-15 | P1 | 研究主张/EVAL | 合法 evidence 仍可能不支持 statement | 增加 ClaimSemanticValidity 和常量 claim、错误 scope、证据不蕴含 statement 的负控 |
| R1-16 | P1 | Ports/Adapters | 六个 Port 只有名称，方法契约与职责不一 | 在 SPEC 增加最小稳定方法签名；Adapter 名称以后者为 canonical |
| R1-17 | P1 | PLAN/CHECKPOINT 动作指标 | DHR 同时表示 deterministic hash rate 与 delayed harm risk | DHR 只表示 Deterministic Hash Rate；延迟伤害写全称且不缩写 |
| R1-18 | P1 | SPEC/PLAN/EVAL 工程范围 | M1 同时承担 11 对象、23 AC、多测试栈，首切片过重 | M1 内部分 M1a Core、M1b Persistence、M1c UX，但不改变对外交付范围；按阶段验证 |
| R1-19 | P1 | PRD ICP；EVAL pilot | 目标用户与 pilot 设计不可招募/不可复现 | 增加 ICP screener、基线任务、至少两次同类会话、退出计入分母、PASS/CONDITIONAL/STOP |
| R1-20 | P2 | PRD alternate flow；EVAL Episode-F1/30s | 错误旅程、边界容差和计时语义不完整 | 补充部分导入/stale/delete/private/replay-invalid；定义边界匹配和计时区间 |

## 六类盲区

- **幂等性**：contentHash 覆盖字段不清；semantic reject 无稳定 fingerprint。
- **安全性**：删除 tombstone 与必填 payload schema 冲突；Shadow spy 范围需区分 dev server 静态请求和产品运行时网络。
- **可观测性**：命令命名、证据包和性能环境未统一；不能把 `npm run dev` 当有限时长验证命令。
- **数据完整性**：WorkModelClaim 与 KnowledgeVersion 双重存储 statement/scope/evidence 会产生分叉。
- **并发/竞态**：stale revision 已定义，但 IndexedDB 删除事务的 commit 前/后语义错误。
- **外部依赖韧性**：M1 隐含 Vite、测试框架、fake IndexedDB、a11y、property-test 和 schema validator，PLAN 未列最小依赖。

## 本轮采纳

采纳 R1-01～R1-20。修订优先级：

1. 冻结 schema registry、状态机、roadmap 和存储边界；
2. 修复确定性、语义 fingerprint、删除事务与 provenance；
3. 增加负控和 evaluator 分母规则；
4. 将 M1 内部分 M1a/M1b/M1c，并补用户/pilot/alternate flow。

## 本轮拒绝或后置

- 不因“范围过重”删除用户要求的六态 Orb；改为 M1c，在同一 M1 对外交付前完成。
- 不把真实低风险动作移入当前 M1；M4 仅保留为必须另立 PRD 的未来研究检查点。
- 不以平均分要求本轮达到 8/10；P1 修复和后续五轮一致性更重要。

## 修订验证

本轮修订后必须：

- 跨文档只存在一个 Claim/Knowledge 状态注册表和一个里程碑映射；
- Replay ID、排序、schemaVersion、hash 字段一致；
- localStorage 不含领域 payload；
- M1 locality = 1.00 `[INV]`；
- Claim/Question/Skill 条件式产出；
- semanticKey/eligible denominator/ClaimSemanticValidity 可执行；
- 第 2 轮复审数据、隐私和安全边界。

## 修订完成记录

- 已统一 Claim revision/Knowledge head/tombstone 模型、M1–M5 roadmap、UUIDv7/UUIDv5、semver schema、全局 comparator、IndexedDB/localStorage 和 Port 方法契约。
- 已加入 semanticKey、预注册 evaluator 分母、ClaimSemanticValidity、条件式产出和 DailyReportSnapshot 投影边界。
- 已将 M1 拆成 M1a/M1b/M1c，将 M4 改为真实动作独立 PRD 立项门，并统一自动退出的 npm 验证脚本契约。
- 已修复 IndexedDB 删除的 plan→短事务→post-commit audit/补偿语义、外部旧导出边界和 production runtime 零副作用范围。
- 自动 canonical conflict scan 已通过；Round 1 关闭，进入 Round 2 数据、隐私与安全审查。
