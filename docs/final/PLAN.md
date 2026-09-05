# ProAGI Insight Loop 交付计划

## 0. 文档定位

- 本计划将宏大的 Personal Agent OS 愿景收敛为可验证、可回滚的增量路线。
- 产品名统一为 **ProAGI Assistant**；首个产品切片称 **ProAGI Insight Loop**。
- 核心证明不是“Agent 点对一次按钮”，而是“用户纠正后，同类输入不再产生同一知识错误”。
- canonical roadmap 顺序固定：**M1 npm + TypeScript/Web Insight Loop → M2 窄真实只读源 → M3 Runtime Adapter 与知识投影 → M4 真实动作独立 PRD 检查点 → M5 Tauri 壳与窄 Windows UIA**。M4 只做立项/停止裁决，不实现 live action。
- 任一里程碑不得借用后续能力伪装完成当前阶段。
- 评价口径统一引用 `docs/final/EVAL.md`；阶段放行统一引用 `docs/final/CHECKPOINT.md`。
- **当前状态：M1 本地实现与自动化验证完成 / Gate 1 CONDITIONAL**。package、测试、固定 Chromium 与 CI workflow 已落地；本地 exit code 与 Evidence Pack 仅证明已执行的自动化项。NVDA、人工视觉批准、hosted CI 与跨标签删除/PURGE 未执行，不得记录为通过。

## 1. 全程约束

### 1.1 产品约束

- 本地优先；首个切片不依赖云服务、真实模型或外部 Runtime。local-first 不等于应用级 at-rest encryption，不能防同机用户、恶意扩展、profile 同步/备份或磁盘取证。
- 事件/结构化语义优先；截图仅作后续按需 fallback，原图默认不落盘。
- 数据分类统一为 `public | local-sensitive | restricted | prohibited`，source→field→sink 后果以 SPEC 为 canonical；redaction 后必须二次完整 schema 校验。
- 所有推断必须区分 `observed`、`inferred`、`user-confirmed`；所有 WorkModelClaim 必须带 evidence、scope、confidence、revision。
- accept/edit/reject/restore 追加不可变 revision；delete 物理移除整个 lineage 的 live payload，只留无 payload、无 payload-derived digest 的随机 tombstone。restore 仅允许仍为 live 的 superseded/invalidated revision，deleted lineage 永久禁止恢复。
- 首版 Action 仅输出 Suggestion/Shadow Intent。从 ActionPort/ShadowPreview 可达的未授权 external network、process、OS filesystem、input injection 为 0；canonical IndexedDB、同源静态资源和用户显式 `projection.export` 不计为 Action 副作用，但 Shadow 不得调用 export。

### 1.2 工程约束

- 使用 npm；不把 pnpm、Rust、Cargo 或 Tauri 假定为已安装。
- TypeScript strict；领域层不得依赖 React、浏览器存储或具体 Runtime 协议对象。
- 版本化端口：ObservationPort、KnowledgePort、CorrectionPort、**ControlPort**、ActionPort、ProjectionPort、RuntimePort。ControlPort 是 pause/resume/recover/clear/replay 的唯一 application use-case 入口，UI 与 adapter 不得自行编排控制面。
- 固定 fixture、版本 pin 和 canonical serialization，确保可重复 Replay。
- M1 输入仅限仓库 bundled synthetic fixture、生成式 synthetic fixture，以及用户**专为测试准备且确认不含真实敏感工作数据**的 schema fixture；不开放任意真实本地 JSON。真实 JSON/真实只读来源统一推迟到 M2，并受 ConsentGrant、RetentionPolicy 与删除路径约束。
- evaluator 断言最终领域状态，不接受 UI 成功文案或点击轨迹作为成功证明。

### 1.3 统一验证基线

以下命令是计划契约；具体 script 名在 M1 初始化时落入 `package.json`：

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

`npm run verify` 是 `verify:pr` 的稳定别名，串联全部功能/隐私 INV、1k/10k 回归和上述非 nightly-only 检查；nightly 增 50k、100 次 Replay、Worker、删除 crash、多标签和完整 visual matrix；release 在目标 build hash 上重跑 nightly。任何必需 suite 缺测试、skip 或 `--passWithNoTests` 都返回非零。`smoke` 自动启停 preview；`dev` 不是验收命令。Evidence Pack 记录 tier、每步 exit code 与 artifact hash。

## 2. 里程碑总览

| 里程碑 | 核心问题 | 可声称的能力 | 禁止声称 |
|---|---|---|---|
| M1 | 纠正能否被知识闭环吸收 | fixture 驱动的可运行 Insight Loop | 真实桌面理解、真实自动化 |
| M2 | synthetic 外是否仍有用 | 一个用户主动选择的真实只读源 | 全桌面覆盖、UIA 稳定性 |
| M3 | 外部计算与知识投影能否解耦 | Runtime adapter 与只读/导出投影 | Runtime 即长期记忆 |
| M4 | 是否具备另立真实动作 PRD 的证据 | 独立 PRD/威胁模型/evaluator 的立项或停止裁决 | 已实现或已验证任何 live action |
| M5 | 原生桌面感知是否值得扩展 | Tauri 壳与窄 UIA adapter | 跨平台、全量 Computer Use |

## 3. M1：npm + TypeScript/Web 可运行 Insight Loop

### 3.1 目标

用 bundled/synthetic/test-prepared deterministic fixture 跑通；M1 不摄入任意真实本地 JSON：

```text
Prepared Fixture → PreviewCommitGuard → BehaviorEvent import session publish
→ Episode
→ Daily Engineering Report
→ WorkModelClaim / Question / SkillCandidate → ActionIntent(mode="shadow") → ShadowPreview
→ accept | edit | reject | restore → immutable revision
  或 delete → scalable fence/enumerate/chunk/PURGE/audit/finalize
→ Replay before/after
→ 可审计差异
```

### 3.2 任务

**首实现 scaffold（先于 M1a）**：创建 `package.json` 与提交到仓库的 `package-lock.json`；固定 Node/npm 基线和 Playwright Chromium revision；建立 TypeScript strict、构建、lint、CSP、unit/integration/fixture/privacy/replay/worker/projection/evaluator/a11y/visual/E2E/smoke 脚本；每个必需 suite 必须含至少一个真实失败负控，禁止空 suite、`test.skip/todo` 冒充覆盖或 `--passWithNoTests`；CI 先执行干净 `npm ci` 和固定 Chromium 安装，再调用 `verify:pr`。在首个 CI artifact/exit code 产生前只记录 `NOT_RUN`。

**M1a Core Loop**：定义 classification、schema/canonicalizer/comparator 与单一 rule family；用 memory adapter 跑通 prepared fixture→Episode→Claim→correction→Replay。建立 `PreviewCommitGuardV1`，使 token-hash guard CAS、canonical mutations、CommitLedger 与 receipt 共享单一幂等/线性化语义；source bytes 只在短期 buffer，无 buffer 时 fail closed。收窄 immutable/head mutation 为 insert/CAS/delete-if-hash tagged union。建立 ReplayInput metamorphic suites；FixtureInput/GoldOracle/EvaluatorManifest 分 artifact/owner/hash，并用 mutation corpus 证明 evaluator 会失败。加入 `ControlPort`，统一 pause/resume/recover/clear/replay application use cases；M1 不伪造 ConsentGrant。

**M1b Persistence & Deletion**：实现 `IndexedDbKnowledgeAdapter`、原子逻辑字节 accounting/recovery reserve、CommitLedger/change feed、immutable/head CAS、分页读取和 `ImportSession/Head`；完整发布前的 partial import 对 Sensemaking 不可见。NDJSON 使用 transferable raw bytes、fatal streaming decoder、App 独立 canonical hash；拆分 WorkerValidationReceipt 与 App ImportCommitReceipt，并实现有界 backpressure、cancel/dispose。删除采用 T0 等值复核 base cursor/epoch/plan hash并原子 fence → RECOVERY_ONLY 内分页 enumerate → 幂等 chunk → generation/cutoff client PURGE → membership seal → registry-derived all-roots audit → FINALIZING 分页清理 → 短 Tv verified+NORMAL。实现 fenced RecoveryLease owner/generation、RetryPurge 新 generation、5 秒 blocked/CLEAR_ONLY、可计量 5 MiB reserve、启动恢复与随机无关联 receipts；每个 store/sink 都必须有 reachability policy 和藏 canary 负例。用 Worker、ProjectionDeltaOracle 和真实 Chromium 验证 byte/ACK/CANCEL/crash、delta=full、gap、stale CAS、跨标签与删除传播。

**M1c Presentation**：先从 SPEC 生成 Visual/AppShell/Layout/Motion/State/Error/Announcement registries，再实现 Report、Inbox、abstain、ShadowPreview。定义正式 ShadowPreview DTO/renderer root 与唯一 `ForbiddenBrowserEffectSinkRegistryV1`，覆盖 network/navigation/download/clipboard/share/service-worker/worker-bridge/custom-scheme 等浏览器 effect；静态 reachability 与运行时拦截双证据。Orb 必须七层/八 part、六态与26/96px；实现 Empty/Stale、PRIVATE+RecoverySurface、MoveOrb键盘等价、360/768/1280与320px/200% reflow、forced-colors、全局 reduced-motion、UI intent 幂等。隐私 sink 规则必须允许 approved live `local-sensitive` 正文进入可见正文/表单及等价 a11y text，同时保证 restricted/prohibited/deleted canary 在所有 sink 为 0。建立结构门禁、required visual matrix、axe+keyboard+focus/live 与 NVDA模板；不得用彩色圆或 screenshot 单独宣称完成。

#### M1a 内部检查点：Core / Oracle

- **Entry**：scaffold、`package-lock.json`、固定 Chromium、非空 suites 与 CI contract 已存在；M1 fixture 边界已锁定。
- **Exit**：memory core、PreviewGuard、immutable CAS、ControlPort、Replay、独立 oracle/mutation corpus 全部有非空自动证据，所有适用 INV 通过。
- **Evidence**：fixture-input/gold/evaluator/oracle/mutation artifacts、unit/integration/replay/evaluator 报告、CI step exit codes。
- **Rollback**：回到 scaffold-only tag/hash；删除未冻结 schema，不把 memory demo 宣称为 M1。

#### M1b 内部检查点：Persistence / Delete / Worker / Projection

- **Entry**：M1a `PASS`，schema 与 oracle hash 已冻结；没有未裁决的 Core P0。
- **Exit**：真实 Chromium 中 IDB transaction、PreviewGuard commit、ImportSession publish、byte Worker、scalable delete/PURGE/lease/all-roots、quota reserve 与 projection CAS 全部通过；fake 结果不得替代浏览器证据。
- **Evidence**：IDB/Worker/projection contract、crash/blocked/quota/cross-tab、root-by-root reachability、ledger/receipt 与 performance-tier artifacts。
- **Rollback**：禁用 IndexedDB adapter并回到 M1a memory mode；若删除不变量失败则进入 CLEAR_ONLY，不继续 M1c 集成。

#### M1c 内部检查点：Presentation / A11y / Visual

- **Entry**：M1b `PASS`，canonical store/delete/recovery 接口冻结；UI 不得绕过 ControlPort、ActionPort 或 ProjectionPort。
- **Exit**：AppShell、Orb、RecoverySurface、Shadow effect registry、UI privacy sinks、键盘/焦点/live、reflow/forced-colors/reduced-motion 全部通过；required visual case 均有 screenshot hash 与 reviewer approval。NVDA 未运行时 M1c 最多 `CONDITIONAL`。
- **Evidence**：visual/a11y artifacts、required screenshot hashes/approval IDs、accessibility-tree canary、Shadow runtime spies、NVDA transcript 或 `NOT_RUN` 限制。
- **Rollback**：保留 M1b canonical core，撤回有问题的 UI build；恢复最小安全只读 RecoverySurface，不以 screenshot baseline 覆盖结构/隐私失败。

**Gate 1 聚合规则**：M1a、M1b、M1c 必须分别有独立裁决且全部 `PASS`，Gate 1 才可 `PASS`。任一 `FAIL/NOT_RUN/CONDITIONAL` 都不得由其他 checkpoint 的分数或证据抵消；NVDA `NOT_RUN` 时 Gate 1 最多 `CONDITIONAL`，且禁止宣传读屏/WCAG 已验证。

### 3.3 依赖与工具链 ADR

- CI 主基线固定 Node.js 24.15.0、npm 11.12.1 与 Playwright lockfile 的 Chromium revision；Node 22 LTS 仅作独立兼容矩阵，不得与主基线性能数据混合。Evidence Pack 记录精确版本。
- Web：Vite + React + TypeScript；schema：Zod；unit/integration：Vitest + fake-indexeddb；E2E：Playwright Chromium；a11y：axe-core；lint：ESLint。
- fake-indexeddb 只负责 contract、CAS、索引和可控 fault injection；真实 Chromium 专责 transaction inactivity、reload/close crash window、quota、双标签 import/edit/clear、blocked/versionchange 与启动恢复，最终断言 IDB/领域状态。
- `npm ci` 安装 JS 依赖；CI/browser bootstrap 必须显式安装固定版本的 Playwright Chromium，不假定开发机已有浏览器。
- 研究报告定义的领域对象、不变量与 fixture 分类。
- 不依赖 Rust/Tauri、UIA、Codex/ACP、MCP、Obsidian 或真实外部写入。

### 3.4 产物

- 可启动的 Web 应用与 bundled/synthetic/test-prepared fixture；不包含任意真实本地 JSON 摄入入口。
- `package.json`、提交的 `package-lock.json`、固定 Chromium 安装配置和 CI workflow。
- 纯 TypeScript 领域核心、ControlPort/其他端口与收窄的 mutation/effect registries。
- 可复现 Replay、独立 evaluator/oracle/mutation artifacts 与评价报告。
- scalable delete/PURGE/recovery、byte Worker/import session 与逐 root 隐私证据。
- 六态 Orb、Insight Inbox、required visual approvals 与 a11y evidence。

### 3.5 验证命令

Gate 1 唯一聚合入口为：

```bash
npm run verify:pr
```

`verify:pr` 必须显式串联 typecheck、lint、dependency/CSP、unit、integration、fixtures、privacy、replay、**worker-contract、projection、evaluator、a11y、visual**、真实 Chromium E2E、build 与 smoke；任何必需 suite 为空、skip、未安装固定 Chromium 或缺 artifact 时返回非零。不得在本节维护第二份逐命令清单。

发布候选适用时只使用：

```bash
npm run verify:release
```

`verify:release` 在目标 build hash 上重跑 release 所需 nightly/capacity/visual matrix。本地 `verify:pr` 已有真实 exit code；`verify:nightly`、`verify:release` 与 hosted CI 仍为 `NOT_RUN`，不得声称已通过。

### 3.6 风险与缓解

- **Synthetic 自洽**：M1 仅作为工程门，不宣称用户价值；M2 强制真实只读源。
- **纠正只改 UI**：Replay 从 canonical store 重算，不复用展示缓存。
- **规则过拟合**：held-out 正例与近邻负例分离，检查 CorrectionLocality。
- **provenance 假信任**：同时展示证据、反证、scope 与来源类型。
- **本地存储删除不彻底**：T0 等值复核 plan 基线并原子切 RECOVERY_ONLY；enumeration/chunk/finalizing 均有界，PURGE generation 封口 client membership，RecoveryLease 防双恢复者，reachability roots 从 Store/Sink registry 穷尽派生。
- **Preview/Worker TOCTOU**：PreviewGuard 消费与 commit/ledger 原子；Worker 仅处理 raw bytes，App 独立重算 hash；partial ImportSession 未发布前不得学习。
- **PRIVATE/clear 竞态**：observationMode 与 privacyEpoch 同事务更新；preview commit 重验。clear blocked 保持 CLEAR_ONLY，empty reopen 前不显示成功；BroadcastChannel 只通知，不替代 IDB 正确性。
- **IndexedDB 假安全**：禁止事务 callback 内任意非 IDB await；fake 只验 contract，浏览器语义由锁定版本的真实 Chromium 验证。
- **local-first 被误解为加密**：M1 UI 明示剩余风险；M2 前完成 profile/OS isolation 与 key strategy 决策或在 consent 中显式接受。
- **导出/浏览器 effect 越界**：Shadow roots 以唯一 effect registry 做静态与运行时双检查；导出前确认类别/数量/最高分类与不可撤回边界，Shadow 禁止 export。
- **UI privacy sink 误伤或漏报**：approved live local-sensitive 正文保持可见且可被读屏读取；restricted/prohibited/deleted canary 在 DOM、a11y、live、artifact 等全部 sink 必须为 0。

### 3.7 M1 明确延期

- 真实桌面事件、持续截图、UIA、鼠标键盘注入。
- Codex app-server、ACP、MCP、Generic CLI Runtime。
- Obsidian 自动同步、SQLite 性能优化。
- Tauri/Rust daemon、Named Pipe、系统托盘。
- 真实文件写入、邮件、发布、删除或任何高风险动作。
- Kernel rewrite、模型微调、多 Agent、自博弈、复杂 DAG、云同步、多用户。

## 4. M2：一个窄真实只读源

### 4.1 目标

验证非 synthetic 噪声下，白名单语义事件能否形成有用 Episode、报告与可纠正候选。**任意真实 JSON 与真实只读来源首次只允许在 M2 出现**，必须先完成 consent、预览、retention 与删除边界。

### 4.2 任务

1. 通过决策记录选择一个来源，例如用户主动选择的真实 JSON、脱敏 Git 或测试结果导入；来源启用前必须先取得明确 ConsentGrant。
2. 实现不可变 ConsentGrant 与独立 ConsentRevocation；Grant 含 source/allowedFields/purpose/retentionPolicyId/policyVersion/grantedAt，禁止后写 revokedAt。preview/commit 双检 active grant、无 revocation、purpose/fields/retention/privacyEpoch。
3. readonly event 默认 TTL 7 天、derived 默认 30 天；允许缩短，延长需新 consent；撤回、到期、策略缩短复用 M1 DeletionPlan/journal，PRIVATE 不暂停 TTL，时钟失败进入 recovery-only。
4. 决定 profile/OS isolation 与 key strategy；若不实现应用级静态加密，consent 必须明确同机用户、扩展、同步/备份和磁盘取证残余风险。
5. 实现独立 readonly input adapter，调用 application 的 inbound ObservationPort；领域 schema 不随来源变化。
6. 处理 drop、duplicate、reorder、clock skew、schema drift、locale/timezone，并按四级分类和 redaction 二次校验。
7. 建立导入前预览、安全拒绝原因和字段级 provenance。
8. 运行小规模 Shadow pilot，不开启动作；export 只能由用户另行明确触发。

### 4.3 依赖与产物

- 依赖 M1 全部门通过。
- 产物：单一只读 adapter、数据字典、consent 流程、保留策略、噪声测试与 pilot 数据包。

### 4.4 验证命令

```bash
npm run verify
npm run test:fixtures -- --suite m2-noise
npm run test:privacy -- --adapter real-readonly
npm run eval -- --source real-readonly --mode shadow
```

### 4.5 风险与延期

- 风险：真实字段可关联推断身份；缓解为最小字段、短期保留、导入预览和 canary。
- 风险：单一来源外部效度弱；结论限定在该来源，不扩写为“桌面理解”。
- 延期：第二来源、浏览器扩展、终端全文、剪贴板正文、全局窗口监听、截图 fallback。

## 5. M3：Runtime Adapter 与知识投影（独立子门）

### 5.1 共同前提

依赖 M2 证明真实只读输入具有最低可用性。M3a 与 M3b 分别验收、分别回滚并可独立 `PASS | CONDITIONAL | STOP`；任何一方成功不得掩盖另一方失败。

### 5.2 M3a Runtime

1. 先实现 RuntimePort fake adapter，再接一个真实 adapter。
2. 冻结 typed RuntimeRequest/Handle/Result、capability negotiation、deadline、cancel、timeout 与 idempotency。
3. 做最小上下文、出站 redaction/audit、响应 schema 和 protocol mismatch 验证；provider DTO 不进入 Core。
4. 注入崩溃、超时、取消竞态、重复响应和版本不兼容。

```bash
npm run verify
npm run test:runtime-contract
npm run test:runtime-faults
npm run eval -- --suite runtime-isolation
```

### 5.3 M3b Projection

1. 实现 Markdown/Obsidian ProjectionPort adapter，但 canonical store 仍是唯一真相。
2. 验证 `sourceCursor` CAS、`loadChangesSince` 增量更新、全量重建、冲突检测与删除传播。
3. M3b 的失败只能关闭 projection，不得停止 M1/M2 本地纠正与 Replay。

```bash
npm run verify
npm run test:projection
npm run eval -- --suite projection-isolation
```

### 5.4 风险与延期

- Runtime 风险：协议对象或原始日志泄漏；用 dependency rule、短期归一化 trace 与独立开关阻断。
- Projection 风险：外部编辑覆盖 canonical truth；所有导入变化转换为 Correction，旧 cursor 不得覆盖新 head。
- 延期：多 Runtime 路由、完整 CLI/MCP gateway、双向 Obsidian 实时同步。

## 6. M4：真实动作独立 PRD 检查点

### 6.1 目标

M4 不实现或验证 live action；它只裁决是否已有足够证据另立真实动作 PRD。当前 PRD 与六件套始终 Shadow-only。

### 6.2 必须提交的立项材料

1. 独立 PRD 与用户价值证据，说明为何 Shadow 无法满足需求。
2. 动作级威胁模型、capability/consent、风险分级和支持矩阵。
3. precondition、idempotency key、expected effect、postcondition、undo/compensation 与 retry budget 契约。
4. 最终状态 evaluator、stale/duplicate/permission/compensation/DelayedHarmRate 观察窗设计。
5. 新的五轮 review 与明确 STOP 条件。

### 6.3 裁决

输出只能是 `APPROVE_NEW_PRD | NEED_MORE_EVIDENCE | STOP`。即使 `APPROVE_NEW_PRD` 也不代表本项目已具备动作能力；实现、测试与宣传必须由新 PRD 管理。

## 7. M5：Tauri 壳与窄 Windows UIA

### 7.1 目标

在 M1–M3 语义稳定且 M4 不要求引入 live action 的前提下，验证原生驻留与一个窄 UIA 场景，不改写领域契约。

### 7.2 任务

1. 补齐 Rust/Cargo/Tauri 工具链与可复现环境说明。
2. 将 Web UI 封装为 Tauri shell；实现托盘、暂停、PRIVATE 与本地 IPC。
3. 若引入 SQLite，执行 `StorageMigrationV1`：源 IndexedDB 冻结只读、目标导入、双库计数/hash/reachability 对比、原子切换；禁止长期双写，失败回到只读源库并清除目标。
4. 接一个 allowlisted 应用/控件族的 WindowsUIAAdapter。
5. 支持事件订阅、缺失/噪声树降级和 screenshot-on-demand 最小 ROI。
6. 默认原图不落盘；记录派生语义、置信度、hash 与删除证明。
7. 测 idle CPU、内存、磁盘增长与锁屏/休眠行为，但不预先承诺目标达成。

### 7.3 依赖、产物与验证

- 依赖前四阶段门和受支持的 Windows 测试机。
- 产物：Tauri 包、窄 UIA adapter、权限说明、资源测量、卸载/清除验证。

```bash
npm run verify
npm run tauri:build
npm run test:ipc
npm run test:uia -- --app allowlisted
npm run test:privacy -- --suite screenshot-on-demand
npm run eval -- --suite native-smoke
```

### 7.4 风险与明确延期

- 风险：A11y 缺失、过大或语义不稳；adapter 必须可降级且不污染领域对象。
- 风险：原生权限降低信任；显式 opt-in、来源可见、随时暂停、可彻底清除。
- 延期：macOS/Linux、全局 UIA、持续截图、通用 Computer Use、生产级自动更新。

## 8. 跨里程碑依赖规则

- 只允许 `M1 → M2 → M3 → M4 → M5` 顺序放行。
- 后续里程碑可做 spike，但不得并入主线或作为前一阶段完成证据。
- 任一 `[INV]` 失败立即阻断；`[PH]` 失败触发产品决策，不得改 evaluator 掩盖。
- `[STAT]` 样本不足时结论必须写“证据不足”，不得按点估计强行放行。
- 每阶段都保留上一稳定版本、schema migration、数据导出与一键清除路径。

## 9. 总体完成定义

- M1 是当前唯一承诺交付；M2–M5 是有门槛的后续路线。
- 每个阶段都有可运行产物、命令化验证、证据包、回滚说明和已知限制。
- 所有阈值在 EVAL 中标注为 `[INV]`、`[PH]` 或 `[STAT]`，并标明来源性质。
- 任何宣传用语不得超过已经通过的阶段门。
