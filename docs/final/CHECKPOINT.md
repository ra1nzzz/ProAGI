# ProAGI Insight Loop 阶段门与检查点

**产品**：ProAGI Assistant

## 0. 目的

本文件定义从 M1 到 M5 的放行规则、证据格式、回滚要求、完成定义（DoD）以及五轮 review 策略。

- 实体 schema、状态机、错误码、隐私和事务语义以 `docs/final/SPEC.md` 为 canonical；本文件不得另造兼容语义。
- 里程碑顺序与范围以 `docs/final/PLAN.md` 为准。
- 指标定义与阈值性质以 `docs/final/EVAL.md` 为准。
- 阶段门不是功能清单，而是“是否有足够证据允许扩大风险面”的决策。
- `[INV]` 是不可协商不变量；失败即阻断。
- `[PH]` 是待验证产品假设；失败可以导致停止、转向或缩小范围。
- `[STAT]` 是统计判定规则；样本不足只能得出“证据不足”。

## 1. 通用放行状态

每个 Gate 只能处于以下状态之一：

| 状态 | 含义 | 后续动作 |
|---|---|---|
| `PASS` | 所有必需证据成立 | 可进入下一里程碑 |
| `CONDITIONAL` | `[INV]` 全过，但产品/统计证据不足 | 仅允许限定试验，不得扩大权限 |
| `FAIL` | 存在不变量失败或关键 DoD 缺失 | 回滚并修复 |
| `STOP` | 产品价值、隐私或安全收益不成立 | 停止该方向，保留证据 |

禁止用平均分抵消 `[INV]` 失败，禁止以 UI 演示替代自动化证据。

## 2. 证据包规范

每次申请放行必须提交不可歧义的 Evidence Pack：

```text
evidence/<milestone>/<run-id>/
├── manifest.json
├── environment.json
├── versions.json
├── commands.log
├── test-results.json
├── eval-results.json
├── fixture-input/
│   ├── manifest.json
│   └── content-hashes.json
├── gold/
│   ├── oracle.json
│   └── approval.json
├── evaluator/
│   ├── manifest.json
│   └── dependency-boundary.json
├── oracle/
│   ├── assertions.json
│   └── requirement-trace.json
├── mutation/
│   ├── corpus-manifest.json
│   └── killed-survivors.json
├── visual/
│   ├── cases.json
│   ├── screenshot-hashes.json
│   └── approvals.json
├── a11y/
│   ├── axe.json
│   ├── accessibility-tree.json
│   ├── keyboard-focus-live.json
│   └── nvda-smoke.json
├── ci-tier.json
├── artifact-policy.json
├── privacy-report.json
├── provenance-audit.json
├── known-failures.md
├── rollback.md
└── review-decisions.md
```

### 2.1 manifest 最低字段

- milestone、run_id、commit/content hash、开始/结束时间。
- Node/npm/OS/browser 版本和随机种子。
- schema、adapter、policy、evaluator、fixture 版本。
- 执行命令、退出码、重试次数和失败分类。
- canonical output hash、fixture-input/gold/evaluator/oracle/mutation hash 与数据集 hash。
- `ci-tier`（PR/nightly/release）、build artifact hash、固定 Chromium revision、suite 非空证明。
- 指标值、分母、置信区间或“不适用/样本不足”。
- visual case 的 screenshot hash、approval ID、reviewer 与批准时间；a11y/NVDA 的环境和状态。
- reviewer、review round、接受/拒绝理由。

### 2.2 证据质量规则

- 原始测试结果只追加，不手工改写。
- 重跑必须产生新 run-id，不覆盖失败记录。
- evaluator 与被测实现必须独立版本化并受 dependency-boundary 检查；fixture-input、gold、evaluator、oracle 和 mutation corpus 分 artifact、分 hash、分 owner。
- 每个适用 INV/AC 必须双向解析到已执行 oracle assertion；空 suite、skip/todo、`--passWithNoTests`、缺 artifact 或测试设施不可用均记 `NOT_RUN/INVALID`，不得 PASS。
- 截图只能作辅助；领域状态导出才是主要证据。M1c required visual case 必须有 screenshot hash 与 reviewer approval ID，optional hash 不足以完成 M1c。
- artifact-policy 必须覆盖 screenshot、video、HAR、trace、reporter、console、source map 和 CI upload 的扫描、隔离、TTL 与销毁 receipt。
- 失败日志、隐私 canary 命中和回滚记录不得从交付包删除；含 canary 的发布 artifact 必须隔离并销毁，保留无 payload 失败 receipt。
- 实施后状态（2026-09-04）：已存在 package/tests/CI 配置与本地 Evidence Pack；真实 Chromium 已执行双标签 privacyEpoch preview fence，但跨标签删除/PURGE 仍为 `NOT_RUN`。真实 NVDA、人工 visual approval 与 hosted CI 也为 `NOT_RUN`，因此 Gate 1 不得表述为 PASS。

### 2.3 Evidence Pack 保留期

- **PR tier：14 天**，到期自动删除运行日志、trace、截图和临时 artifact；hash/无 payload 汇总按项目政策处理。
- **nightly tier：90 天**，用于性能和 flaky 趋势；到期按 artifact-policy 清理。
- **release tier：长期保留**批准后的 manifest、命令/退出码、hash、oracle trace、visual/a11y approval 与无 payload 摘要；含业务 payload、secret/canary 或未批准 trace 不得因“长期”而保留。
- 以上仅约束测试证据，不覆盖产品数据的 ConsentGrant/RetentionPolicy；任何更短的隐私删除要求优先。

## 3. 通用 DoD

每个里程碑至少满足：

1. 范围、Not Doing 与宣传边界已写明。
2. `npm ci` 可从提交的 `package-lock.json` 在干净环境安装，Playwright 使用锁定 Chromium revision。
3. Gate 1 的唯一聚合命令 `npm run verify:pr` 返回 0；release 适用时 `npm run verify:release` 返回 0。所有必需 suite 非空，且没有 skip/todo、`--passWithNoTests` 或缺 artifact。
4. 同输入、同版本、同种子产生相同 canonical output hash。
5. 所有适用 `[INV]` 通过。
6. 所有失败都能定位到 fixture、阶段、对象 ID 与原因码。
7. 隐私报告证明 source→field→sink 分类后果正确：unknown item 拒绝、optional restricted/secret drop 后重验、required/identity secret 与 prohibited item 拒绝。**restricted、prohibited 和 deleted canary 在所有受控 sink 中为 0；approved live local-sensitive statement/reason 可且必须在当前可见正文/表单及等价 accessibility text 中读取，但不得进入 accessible name/description/title/data/live/hidden/log 或发布 artifact。**
8. provenance audit 无断链、无环、无跨用户引用。
9. ConsentGrant/RetentionPolicy（适用阶段）、privacyEpoch、PRIVATE capability matrix 与时钟失败策略均有自动证据。
10. 删除、restore、scalable journal enumeration/chunk/finalizing、RecoveryLease、generation/cutoff client purge、all-roots reachability、clear-all、导出与回滚路径已实际演练；旧 lineage 不可 restore，显式新 import 不得链接旧 lineage。
11. local-first 剩余风险已向用户明确；M2 起已决定隔离/key strategy 或在 consent 中记录显式接受。
12. ForbiddenBrowserEffectSink registry 的静态 reachability 与运行时拦截通过；用户显式下载和 canonical IDB 不被误报为 Shadow 副作用，Shadow 不得触达 export 或浏览器 effect sink。
13. 新增风险有 owner、触发条件、缓解和剩余风险。
14. EVAL 中适用指标报告分子、分母与不确定性。
15. 五轮 review 完成，第 5 轮给出明确裁决；不得开启第 6 轮。

## 4. Gate 0：M1 开工准备

### 4.1 进入条件

- 核心问题固定为“纠正能否被同类 Replay 吸收”。
- 领域对象与端口边界形成最小决策记录；ControlPort 是 pause/resume/recover/clear/replay 的唯一 application 入口。
- fixture-input、gold、evaluator、oracle 与 mutation artifact 的所有权分离方案已确定。
- M1 只允许 bundled/synthetic/test-prepared fixture；任意真实 JSON、真实桌面、真实 Runtime 与真实动作均不进入 M1。
- 首实现 scaffold 已定义 `package.json`、提交的 `package-lock.json`、固定 Chromium revision、CI workflow 与全部必需 suite；任何 suite 不得为空。

### 4.2 证据

- 范围表、四级 Data Classification/source→sink matrix、threat model、fixture 目录设计。
- PreviewCommitGuard、ControlPort、ImportSession、RecoveryLease、generation/cutoff PURGE、all-roots registry、ForbiddenBrowserEffectSink registry 与收窄 mutation 设计。
- npm scripts 契约、package-lock hash、固定 Chromium revision、非空 suite 清单、fake-indexeddb/真实 Chromium 职责分工与 CI workflow。
- accept/edit/reject/restore 追加 revision、delete 物理清除 lineage 的 scalable 状态机图。
- 此阶段只有设计/scaffold 证据；没有实际 exit code 时必须写 `NOT_RUN`，不得声称测试已跑。

### 4.3 失败与回滚

若领域模型仍绑定 React、浏览器存储或 Codex/ACP 对象，则退回接口设计，不开始 UI 堆叠。

## 5. Gate 1：M1 Insight Loop 放行

### 5.0 三个内部检查点

| Checkpoint | Entry | Exit | Evidence | Rollback |
|---|---|---|---|---|
| M1a Core / Oracle | scaffold、lockfile、固定 Chromium、非空 suites、prepared-fixture 边界就绪 | memory core、PreviewGuard、immutable CAS、ControlPort、Replay、独立 oracle/mutation 全过 | fixture-input/gold/evaluator/oracle/mutation、unit/integration/replay/evaluator | 回到 scaffold-only；不宣称 M1 |
| M1b Persistence / Delete / Worker / Projection | M1a=`PASS`，schema/oracle hash 冻结 | 真实 Chromium 中 IDB、ImportSession、byte Worker、scalable delete/PURGE/lease/all-roots、reserve、projection CAS 全过 | IDB/Worker/projection、ledger/receipt、crash/blocked/quota/cross-tab/reachability | 回到 M1a memory；删除失败进入 CLEAR_ONLY，不进 M1c |
| M1c Presentation / A11y / Visual | M1b=`PASS`，canonical/recovery 接口冻结 | AppShell/Orb/Recovery/Shadow effect/UI privacy/a11y/visual 全过；required screenshot 均获批准 | visual/a11y、screenshot hash+approval、a11y-tree canary、runtime spies、NVDA | 撤回 UI build，保留 M1b；恢复最小安全只读表面 |

只有 M1a、M1b、M1c **全部 `PASS`**，Gate 1 才能 `PASS`。任一 `FAIL/NOT_RUN/CONDITIONAL` 不得由其他 checkpoint 抵消；NVDA 为 `NOT_RUN` 时 M1c 与 Gate 1 最多 `CONDITIONAL`，并禁止“读屏已通过”“WCAG 2.2 AA 已验证”等宣传。

### 5.1 必过阶段门

- 只接受 bundled/synthetic/test-prepared fixture；eligible fixture 可生成确定 Episode/Report 与 0..N Claim、0..1 Question、0..N SkillCandidate/Shadow ActionIntent，abstain fixture 必须生成 0 个候选。任意真实 JSON 必须拒绝并推迟到 M2 consent。
- PreviewCommitGuard 的 token-hash CAS、canonical mutation、ledger 与 receipt 同事务；伪造、双提交、跨标签、过期和 response-loss 至多生效一次。
- accept/edit/reject/restore 追加不可变 revision并 CAS head；generic mutation 不可表达覆盖 immutable 或无 CAS head。Replay 由 ControlPort use case 调用纯 core 并持久化 terminal result。
- restore 仅允许仍 live 的历史 revision；旧 lineage restore 失败。未来 M2 显式新 import 可建全新 lineage，但不得链接旧 parent/head 或读取删除 artifacts。
- Replay 展示 before/after，且由 canonical store 重算；RejectRecurrence、DeleteResurrection 为 0；同 scope edit 被吸收，CorrectionLocality 不污染 scope 外结果，ProvenanceCompleteness 为 1。
- 四级 Data Classification、unknown/secret、redaction 二次验证、UntrustedUserText/Bidi/输出编码均通过负控；raw screenshot at rest 为 0 bytes。
- PRIVATE 同事务设置 observationMode=PRIVATE 并递增 privacyEpoch；清空 preview/队列，旧 epoch commit abort。ControlPort 不依赖 BroadcastChannel 才能暂停；刷新后仍 PRIVATE且不补采。
- ImportSession 仅在完整验证后发布；byte Worker 使用 fatal decoder、App 独立重算 hash。取消、崩溃或 partial committed session 不得进入 Sensemaking。
- 删除 T0 等值复核 plan cursor/epoch/hash；RECOVERY_ONLY 内分页 enumerate/chunk/finalize，RecoveryLease 有 generation/fencing。PURGE 在 Audit 前封口 client membership；all-roots registry 包含全部 IDB、ledger/change feed、preview/staging、Worker/client/UI/a11y/announcement/cache/artifact sink。
- clear blocked 保持 CLEAR_ONLY；required clients 未 ACK、roots 非零或 empty reopen 未完成均不得显示成功。逻辑容量与 5 MiB reserve 在事务内原子计量。
- ForbiddenBrowserEffectSink registry 覆盖 network/navigation/download/clipboard/share/service-worker/worker bridge/custom scheme 等；Shadow 静态 reachability 与运行时 effect 均为 0，且不得调用 export。
- AppShell/EmptyState/Projection stale/PresentationStateResolver 按 SPEC registry；Orb 有七层 anatomy/八 part、精确 token、六态文本图标和26/96px，禁止纯色圆。
- restricted/prohibited/deleted canary 在 DOM、a11y、live、cache 与发布 artifact 中均为 0；approved live local-sensitive 正文可在当前可见正文/表单及等价 a11y text 中读取。RecoverySurface、MoveOrb、reflow、forced-colors、reduced-motion、focus/live/error contracts 通过。

### 5.2 必交证据

- clean、perturbed、privacy、adversarial fixture 报告；fixture-input、gold、evaluator、oracle 与 mutation artifacts 均有独立 hash/owner，OracleAssertion 双向 trace 完整。
- PreviewGuard 双提交/response-loss、immutable mutation/CAS、ControlPort、Replay metamorphic 与 evaluator reward-hacking/mutation corpus。
- ImportSession 发布、byte Worker/backpressure/cancel/dispose、App hash、Projection delta/full/CAS 报告。
- correction lineage、deleted restore forbidden、scalable journal enumeration/chunk/finalizing、RecoveryLease steal、PURGE membership/cutoff/retry generation 与逐 root deletion reachability。
- privacyEpoch 在 parse、preview-confirm、transaction-before-commit 及双标签 clear/import 竞态中的证据。
- fake-indexeddb contract/fault injection 报告，以及锁定真实 Chromium 的 transaction inactivity、crash、quota、双标签 blocked/versionchange、启动恢复和 empty reopen 结果；fake 不得替代 browser evidence。
- Shadow effect registry 的静态 reachability、运行时 browser sink 拦截、显式 export confirmation/receipt 与旧下载边界证据。
- AppShell/Orb anatomy 结构结果与 required visual matrix；**每个 required M1c case 必须同时存在 screenshot hash、approval ID、reviewer 和批准时间**，否则 M1c 不是 PASS。
- axe、键盘/focus/live、accessibility-tree canary、approved local-sensitive 可读正例、reflow/forced-colors/reduced-motion 与 NVDA smoke。NVDA 未执行必须写 `NOT_RUN`，M1c/Gate 1 最多 `CONDITIONAL`，且禁止宣传读屏或 WCAG 已验证。
- `verify:pr` 全步骤 exit codes、非空 suite 证明、`ci-tier.json` 与 artifact-policy；release 适用时必须附 `verify:release`、目标 build hash 和 release tier manifest。未运行不得伪作证据。

### 5.3 DoD

用户可在本地启动 Web 应用，用 bundled/synthetic/test-prepared fixture 完成“预览 → 导入 → 审阅 → 纠正 → Replay → 看见改变”；M1 不开放任意真实 JSON，且任何“执行”只表示本地处理或 Shadow Intent。只有三个内部 checkpoint 全部 PASS 才满足 DoD。

### 5.4 回滚

- 保留最后一个分别通过 M1a/M1b/M1c 的 schema、fixture、artifact hash 与 build；不得把较低 checkpoint 宣称为 Gate 1。
- schema 迁移失败时只读打开旧数据，不自动覆盖。
- correction 引擎回归时禁用新版本，恢复上一 policy version。
- M1b 删除验证失败时立即停止导出与 Replay并进入 CLEAR_ONLY；不得继续 M1c。M1c 失败只撤回 UI build，保留已通过的 M1b canonical core和最小安全只读 RecoverySurface。

## 6. Gate 2：M2 一个窄真实只读源放行

### 6.1 必过阶段门

- 仅一个用户主动选择的来源；不可变 ConsentGrant 明确 source、allowedFields、purpose、RetentionPolicy、policyVersion 与授予/撤回时间。
- preview 与 commit 双检 active consent、purpose、fields、policy、retention 和 privacyEpoch；撤权立即递增 epoch、阻止新摄入并走 DeletionPlan/journal。
- readonly event 默认 TTL 7 天、derived 默认 30 天；用户可缩短，无新 consent 不得延长。到期/策略缩短/时钟失败/PRIVATE 下 TTL 行为符合 SPEC。
- 导入前可预览；可进入 PRIVATE、恢复、撤销授权和一键清除；PRIVATE 仍允许 read/delete/clear/recovery，恢复不补采。
- adapter 输出仍符合 M1 BehaviorEvent schema；四级分类与 redaction 二次校验不因真实来源弱化。
- drop、duplicate、reorder、clock skew、schema drift 可观测且不静默；privacy canary 无泄漏。
- profile/OS isolation 与 key strategy 已形成决策；若无应用级静态加密，Consent 明示同机用户、恶意扩展、profile 同步/备份和磁盘取证风险。
- 真实数据评价与 synthetic 结果分开报告，所有建议仍为 Shadow-only，export 只能由用户独立显式触发。

### 6.2 证据与 DoD

- 来源数据字典、source→sink matrix、ConsentGrant/RetentionPolicy snapshot、preview/commit deny 测试、TTL purge 与删除传播图。
- privacyEpoch 撤权竞态、启动恢复、clear-all、export confirmation/receipt 和 local-first 风险接受记录。
- 至少一轮预注册 Shadow pilot；报告 NetValue、任务价值、纠正负担、退出/忽略和误解类型，synthetic 与真实结果不得合并。
- 只有 `[INV]` 全过、pilot 未出现不可接受隐私事件，且 **NetValue 中位数 > 0**，Gate 2 才可 `PASS`。
- `[INV]` 全过但样本、置信区间或 NetValue 证据不足时为 `CONDITIONAL`，不得接第二来源或宣传价值已验证。
- 隐私不变量失败，或预注册观察窗内 NetValue 持续为净负，必须 `STOP`；不得通过改阈值或排除退出者转为 PASS。

### 6.3 回滚

关闭 adapter、撤销权限、删除原事件及派生物、重建索引；M1 fixture 模式仍可独立运行。

## 7. Gate 3：M3 两个独立子门

### 7.1 Gate 3a — Runtime

- typed RuntimeRequest/Handle/Result、deadline/cancel、capability 和 idempotency contract 全过。
- Runtime 不可用、超时、取消竞态、重复响应或协议不兼容时 fail closed 且 Core 不损坏。
- 出站最小化/redaction 可审计，provider Thread/Turn/Item 不进入领域对象。
- 证据：fake contract、真实 adapter smoke、故障注入、出站 diff；回滚为撤销 token、停 adapter、清原始响应，只留脱敏 trace。

### 7.2 Gate 3b — Projection

- Markdown/Obsidian projection 可从 canonical store 重建；`sourceCursor` CAS 阻止旧结果覆盖新 head。
- `loadChangesSince` 增量更新、全量 fallback、冲突检测与删除传播全过。
- 证据：projection contract/round-trip/delete/rebuild 报告；回滚为关闭 projection 并保留 canonical store。

### 7.3 独立裁决

Gate 3a 与 3b 分别 `PASS | CONDITIONAL | STOP`、分别回滚；任何一个成功不得掩盖另一个失败。切断二者后，M1/M2 本地读取、纠正和 Replay 仍可运行。

## 8. Gate 4：M4 真实动作独立 PRD 检查点

### 8.1 必过阶段门

- 当前产品仍为 Shadow-only，live action 调用数必须为 0。
- 提交独立动作 PRD、真实用户价值证据、威胁模型、capability/consent、风险分级和支持矩阵。
- 预注册 precondition、idempotency、expected/postcondition、undo/compensation、retry 与 DelayedHarmRate evaluator。
- 新 PRD 定义自己的五轮 review、STOP 条件和宣传边界。

### 8.2 裁决与证据

证据包只裁决 `APPROVE_NEW_PRD | NEED_MORE_EVIDENCE | STOP`。`APPROVE_NEW_PRD` 也不代表已实现或验证动作；Gate 4 不接受 action demo 代替独立 PRD。

### 8.3 回滚

若发现任何 live 调用路径，立即移除 adapter、撤销 capability、恢复 Shadow-only，并将 Gate 4 判 `FAIL`。

## 9. Gate 5：M5 Tauri 壳与窄 Windows UIA 放行

### 9.1 必过阶段门

- Tauri shell 不改变 M1 领域语义与评价结果。
- IndexedDB→SQLite 若发生，`StorageMigrationV1` 必须通过源库只读冻结、目标导入、双库计数/hash/reachability/tombstone/journal/epoch 对比和原子切换；禁止长期双写，失败回到只读源库。
- 本地 IPC 有身份、scope 与审计，不因 loopback 假设安全。
- 仅 allowlisted 应用/控件族进入 UIA adapter。
- PRIVATE、锁屏、休眠时停止观察。
- A11y 缺失/噪声不会触发高权限动作。
- screenshot-on-demand 仅取最小 ROI，原图默认不落盘。
- 资源数据来自真实机器测量，不写成预先保证。

### 9.2 证据与 DoD

- 安装、升级、卸载、权限撤销和数据清除实测。
- UIA coverage、event loss、noise 与 fallback 比例。
- idle CPU、内存、磁盘增长、锁屏行为测量。
- Windows 支持矩阵与明确未支持范围。

### 9.3 回滚

禁用 UIA adapter → 删除临时截图 → 撤销 OS 权限 → 保留 Web/fixture 模式 → 必要时卸载原生壳且验证用户数据清除。

## 10. 五轮 review 策略

Review 的轮次主题、A/B/C 三维、盲区扫描、评分用途和第 5 轮缝合规则只以 `docs/reviews/README.md` 为规范源，本文件不复制另一套主题。

- 五轮已顺序完成并保存 `round-1.md` 至 `round-5.md`；不得开始第 6 轮。
- 每轮都执行质量、效率、复用三维；轮次主题与审查维度是二维矩阵，不互相替代。
- 8/10 只用于趋势，不是硬门禁；任何 `[INV]` 失败不能被平均分抵消。
- 第 5 轮已按“证据强度 → 风险降低 → 范围最小 → 可逆性 → 实现成本”完成择优缝合；本次修订直接沉淀在 PLAN/CHECKPOINT。下一步是 M1a→M1b→M1c 实现和取证，不创建 Round 6。

## 11. 发布与宣传门

- Gate 1 后只能称“fixture 驱动的可纠正 Insight Loop”。
- Gate 2 后只能称“在指定只读来源上完成有限真实验证”。
- Gate 3 后可称“支持一个隔离 Runtime/投影 adapter”。
- Gate 4 后最多可称“已完成是否另立真实动作 PRD 的裁决”，不得称已实现或验证 live action。
- Gate 5 后可称“在支持矩阵内完成窄 Windows UIA 验证”。
- 未完成的阶段一律不得使用“全桌面”“自主执行”“持续自进化”“生产安全”等表述。

## 12. 停止条件

出现以下任一情况，应暂停扩展而不是继续堆功能：

- 同一 `[INV]` 连续修复仍失败。
- 删除后数据或推断复活。
- canary 离开许可边界。
- evaluator 可被展示文案或被测系统轻易操纵。
- 用户纠正成本持续高于节省时间。
- 真实只读源无法产生比活动日志更有用的可纠正知识。
- 若 M4 另立动作 PRD，候选低风险动作仍无法可靠回滚或出现未预期副作用；当前 M1–M5 不得用动作演示绕过该独立门。

停止不是项目失败；它是阶段门正确阻止风险扩大的证据。
