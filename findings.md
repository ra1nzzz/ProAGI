# Findings

## 资料盘点（Round 1）

- 仓库当前可见产品输入只有：
  - `docs/PRD/desktop-agent-complete-prd-v1.1.md`
  - `reference/Prototype reference.png`
  - `reference/Prototype reference1.png`
- PRD 很长（4375 行），前 2000 行已读取；需继续完整读取。
- 产品定位：本地优先、Runtime/Model 解耦、可验证/可回滚的常驻 Personal Agent OS。
- 核心闭环：观察 → 建模 → 询问 → 学习 → 提案 → 验证 → 技能/工作流 → 执行 → 反馈 → 评估 → 演化。
- MVP 风险集中于：隐私感知、桌面事件采集、任务分段、权限策略、技能验证、Runtime Adapter，以及宏大范围导致无法落地。
- UI 参考图关键约束：六态球体（蓝/绿/紫/橙/红/灰）、低感知 24–28px、主动悬浮 88–110px、颜色之外必须有动画/形态/标签语义；包含点击、长按、拖拽、旋转、右键、双击等交互，以及指针轨迹与建议浮窗。
- 原型图左侧英文品牌仍写 `ProAGIAgent`，PRD 正文推荐 `ProAGI Assistant`，需在最终规范中统一。
- PRD 内存在不可直接验证的内部引用标记（如 `cite...`），研究报告必须替换为真实 URL 与可追溯原文。

## PRD 完整读取后的核心判断

- 当前仓库是绿地项目：除 PRD、两张参考图和本轮规划文件外没有实现代码、包清单或构建配置。
- PRD 的主要矛盾是“Research Prototype/最小闭环”的收敛主张与第 83/91/113 节把 Desktop、Perception、Cognition、Skill、Runtime、CLI、MCP、Obsidian 几乎全部列入 MVP 的范围膨胀。最终五件套必须把 **可演示垂直切片** 与 **后续完整 MVP** 分开。
- 第一条可验证垂直切片应围绕开发者 Daily Engineering Report：模拟/导入 Windows 活动事件 → 分段成 Episode → 生成日报 → 提出一个问题 → 更新带证据的知识 → 展示候选 Skill 状态。真实全局 A11y、Codex app-server、MCP、Obsidian 自动同步宜放在后续里程碑，先以端口/适配器和可替换实现保留架构边界。
- PRD 内部 UI 状态定义冲突：9.6 的六态（LEARNING/EXECUTING/IDLE/SUGGESTION/ERROR/PRIVATE）与 26/27 节的 7 状态及颜色语义不同。参考图明确支持前者，应以六态为 canonical。
- 品牌命名冲突：参考图 `ProAGIAgent`、PRD 推荐 `ProAGI Assistant`。最终实现应采用 `ProAGI Assistant`，将旧名称仅视为视觉参考。
- 资源预算（idle CPU、内存、电池）与实验转化率是待实测目标，不应在开发前写成已保证事实。
- 技术栈建议为 Tauri 2 + Rust + React/TypeScript，但当前执行环境未确认 Rust/Tauri GUI 依赖。可先构建可运行、可测试的 Web/TypeScript 原型及纯领域内核，再挂接 Tauri 壳层。

## Deep Research Phase 0

### 更好的核心问题
不是“怎样把 PRD 中所有模块都实现”，而是：**哪一个最小、隐私可信且可测量的桌面垂直切片，能证明 ProAGI 会从行为证据中形成可纠正知识，并为后续可靠自动化建立接口？**

### 好答案标准
1. 给出至少一个可能引发业内争论的判断，而非竞品功能罗列。
2. 用 3–5 个一手来源验证桌面 Agent 的可行性、隐私边界、评估方式与 Runtime 接口。
3. 明确哪些 PRD 假设被支持、被推翻或仍未知。
4. 研究结论能直接约束 SPEC/ARCH/PLAN/EVAL 和首个开发切片。

### 分析框架与待验证假设
- 框架：Jobs-to-be-Done + 风险调整后的价值链；辅以反事实分析。
- H1：真正的产品楔子不是“自动操作桌面”，而是“让用户可见、可纠正地形成工作模型”；自动化应后置。
- H2：事件与结构化语义优先，比持续截图更适合本地常驻产品的隐私、资源和可解释性目标。
- H3（反直觉）：首版不接真实 Codex/Tauri/A11y 全链路，反而更能降低集成噪声、验证核心学习闭环；但必须用稳定端口避免做成一次性假原型。

## 环境与调研工具

- Node.js v24.15.0、npm 11.12.1 可用；`pnpm`、Rust/Cargo 未在探测输出中出现。
- 当前目录不是 Git 仓库。
- 主会话没有 Tavily/搜索 MCP；内置 WebSearch 又因缺少 `DEEPSEEK_API_KEY` 不可用。已明确采用降级方案：由两个受控研究子代理使用其可用搜索能力获取一手来源，并要求说明任何搜索降级；主代理负责最终交叉验证与写作。
- 确认工具链：Node/npm 可用；pnpm、rustc、cargo 不可用。因此第一开发切片应采用 npm + TypeScript/Web，Tauri/Rust 作为明确的后续壳层适配，不伪称已完成原生桌面集成。
- 两张原型图中，用户明确指定的 `Prototype reference1.png` 是白底设计规范板；另一张为深色概念板，只能作为补充，不能覆盖指定参考。

## Idea Refine 预备约束

- 采用 HMW + JTBD + Constraint-Based Ideation + Pre-mortem，而不是机械运行全部框架。
- MVP 必须只完成一个核心 job，并优先验证最可能失败的假设；“Not Doing” 清单是强制产物。
- 三个候选方向应围绕：A. 可纠正工作模型（优先）；B. 立即自动化助手；C. Runtime/Agent Gateway。最终以用户价值、可行性、差异化择优。

## Idea Refine Phase 1（基于 PRD 已知答案）

### HMW
如何让重度 AI/Coding 用户在不交出敏感桌面内容、不学习复杂 Agent Framework 的前提下，在首次体验中看见一个可纠正的“工作理解”，并为第二天可复用的自动化能力建立证据？

### 已知的 sharpening answers
- 目标用户：Windows-first 的重度 AI/Coding 用户。
- 成功：导入/采集开发活动后形成可解释时间线与日报；用户回答一个高价值问题后，知识变化可追踪；候选技能只进入 Shadow/待批准。
- 约束：本地优先、低打扰、事件优先、敏感内容最小化、绿地项目、当前无 Rust/Tauri 工具链。
- 当前替代方案：手工周报、IDE/Git 历史、聊天助手、活动记录工具、自动化/RPA。
- Why now：Agent Runtime 与桌面自动化能力正在成熟，但长期个体知识仍分散在运行时会话和应用孤岛中。

### 六个方向变体
1. **可纠正时间线**：只做事件导入、Episode 分段、证据检查和用户纠正，不生成自动化。
2. **每日工程结算**：围绕 Daily Engineering Report 完成 Observe→Ask→Learn，候选 Skill 仅展示。
3. **影子学徒**：系统同时给出“如果自动化会怎么做”的 Shadow Plan，但绝不执行外部写操作。
4. **Agent Gateway First**：先做 CLI/MCP 个人知识接口，让 Codex 调用；桌面球体仅展示状态。
5. **Orb-first 信任原型**：优先验证六态球体、隐私暂停、证据解释卡和建议打扰度，学习内核使用模拟数据。
6. **全链路垂直切片**：事件样本→Episode→Knowledge→Question→Report→Candidate Skill→评价，全程本地、每一步有 provenance。

初步收敛：方向 6 作为领域闭环，方向 5 作为交互外壳，方向 2 作为用户可理解的核心 job；方向 3 只保留 Shadow 表达；方向 4 与真实自动化均后置。

## 指定原型的 UI/UX 提取

- 页面视觉：暖白/浅灰背景、深墨色标题、细灰分割线、蓝色编号与强调；信息密度高但分区清晰。
- 球体六态 canonical 色：LEARNING 蓝、EXECUTING 绿、IDLE 紫、SUGGESTION 琥珀、ERROR 红、PRIVATE 灰。颜色必须辅以图标、文本、动画节奏和 `aria-label`。
- 球体尺寸：低感知 24–28px（推荐 26px），主动悬浮 88–110px（推荐 96px）；网页原型可等比放大展示，但设计 token 保留真实桌面尺寸。
- 交互：单击展开状态/建议卡，长按控制面板，拖拽位置，右键隐私/统计/设置，双击唤出聊天；旋转手势属于可选备用操作，不应成为首版关键路径。
- 建议浮窗：1–3 条、必须有执行/忽略/更多；首版所有“执行”只进入 Shadow Preview，避免不可信自动操作。
- 状态页应同时展示：当前可见状态、观察来源、最近 Episode、今日工程报告、待回答问题、候选 Skill、隐私暂停入口。

## 主代理直接核验的一手源（降级为已知 URL 直取）

- **OSWorld 官方仓库**：https://github.com/xlang-ai/OSWorld
  - 官方 README 将真实桌面评估建立在隔离 VM/Docker 环境、任务初始化、截图/动作/录像结果和可复核评分上；公共榜单要求由维护方复跑或披露监控轨迹。
  - 判断：PRD 的 Personal Benchmark 必须基于确定性 fixture、结果 evaluator 与隔离执行，不能用“Agent 自报成功”。但首个垂直切片无需复刻 OSWorld 的重型 VM 基础设施。
- **OpenAI Codex app-server 官方 README**：https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
  - 原文要点：`supports bidirectional communication using JSON-RPC 2.0 messages`；默认 stdio 为 JSONL；WebSocket 明确标为 experimental/unsupported；schema 可由当前 Codex 版本生成；连接必须先 initialize。
  - 判断：PRD 把 Runtime 封装在 Adapter 后是正确的；首版不应依赖实验 WebSocket，也不能把 app-server 的 Thread/Turn/Item 泄漏为核心领域对象。
- **Agent Client Protocol 官方仓库**：https://github.com/agentclientprotocol/agent-client-protocol
  - 原文要点：ACP 标准化的是 code editor 与 coding agent 的通信；当前 stable protocol version 为 1；wire compatibility 应看 initialize 协商的 protocolVersion 和 capabilities，而不是 SDK/Schema 包版本。
  - 判断：ACP 是后续 coding-agent adapter，不是通用 Personal Agent OS 内部模型；PRD 将其后置是合理的。
- **Microsoft UI Automation 官方概览**：https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-overview
  - 原文：`provides programmatic access to most user interface (UI) elements on the desktop`，并将不同 UI framework 的属性映射为统一 AutomationElement 属性；客户端订阅特定事件而非接收全局广播。
  - 判断：A11y 能提供结构化 UI 元素语义并支持事件优先采集，但“most”不是“all”；它必须是可降级的平台适配层，不能成为领域事件 schema 的唯一来源。
- **Microsoft Recall 官方开发文档**：https://learn.microsoft.com/en-us/windows/apps/develop/windows-integration/recall/
  - 原文要点：Recall 的快照功能要求用户 opt-in；支持暂停/恢复、过滤应用和网站、管理存储；内容本地保存；应用可用 `SetWindowDisplayAffinity` 阻止内容被捕获。
  - 判断：仅宣称 local-first 不足以建立信任。ProAGI 必须提供显式启停、来源可见、应用/域黑名单和数据删除；事件优先可减少截图风险，但仍须支持操作系统级不可观察信号。
- **Obsidian Properties 官方页面**：https://help.obsidian.md/properties
  - 原文：Properties 是 text、links、dates、checkboxes、numbers 等结构化数据，并以 YAML 存在文件顶部；同一 note 属性名必须唯一，同名属性在 vault 内共享类型；不支持 nested properties、bulk edit、properties 内 Markdown。
  - 判断：适合做可读可编辑的知识投影与交换格式，不适合做 canonical runtime store 或复杂嵌套 provenance。
- **Darwin Gödel Machine 原论文**：https://arxiv.org/abs/2505.22954
  - 原文摘要强调每次代码自修改都以 coding benchmark 经验验证，并保留多样 agent archive；SWE-bench 从 20.0% 提升到 50.0%，Polyglot 从 14.2% 到 30.7%，且实验包含 sandboxing 与 human oversight。
  - 判断：支持“候选→评估→保留/回滚”，不支持消费级产品直接在线改 Kernel；benchmark 目标错配和安全覆盖不足仍是关键风险。

## Phase 1 两组研究的交叉结论

- 两组独立材料都收敛到同一点：**首个证明应是事件→候选工作模型→用户纠正→版本化知识→replay，而不是一次真实 GUI 自动执行。**
- 桌面研究组提出“可纠正表单规则卡”fixture；Runtime/知识组提出“工作模型收件箱”。二者可合并为开发者 Daily Engineering Report 场景下的 **Insight Inbox**：Episode、知识候选、问题和 Shadow Skill 都是可接受/编辑/驳回且有 evidence IDs 的卡片。
- H1 强支持；H2 修正为 `semantic/event-first + screenshot-on-demand fallback`，不能声称 semantic-only 或事件天然隐私；H3 修正为“稳定版本化契约/端口”，不是依赖 TCP/WebSocket。Codex WebSocket 当前明确 experimental/unsupported，ACP v1 的稳定路径集中在协商能力与 stdio framing。
- OSWorld 原论文数据提示：369 个任务、134 个 execution-based evaluator；人类成功率 >72.36%，当时最佳模型仅 12.24%。关键意义不是引用旧模型强弱，而是任务必须固定初态、隔离环境并用结果状态断言。
- 关键反直觉判断：真正最小的成功不是“Agent 做完一次任务”，而是“用户纠正后，系统下一次可审计地不再犯同一个知识错误”。
- 建议领域端口：`ObservationPort`、`KnowledgePort`、`CorrectionPort`、`ActionPort`；首版实现 `SyntheticEventAdapter` 与 `Suggestion/ShadowActionSink`，真实 UIA/Codex 以后替换。
- 建议闭环验收：固定 synthetic traces 归一化确定；每个候选均有 evidence IDs；纠正后 replay 遵从修订；删除后不再建议；默认 0 截图、0 真实点击、0 云传输；敏感字段在写入前被剔除。
- 不确定性：真实应用 UIA 覆盖率/事件丢失率未测；OSWorld 测执行而非知识纠正；事件与截图的相对隐私风险没有统一量化；DGM 证明 benchmark 优化而非通用安全自进化。

## Idea Refine Phase 2 初步压力测试

### 方向 A：可纠正工作模型 / Insight Inbox（选择）
- 用户价值：中高。它直接减少“每天重建上下文”和手工周报，但是否是 painkiller 必须通过用户研究验证。
- 可行性：高。可以用 fixture 和纯领域逻辑完成闭环，不依赖原生权限或模型 API。
- 差异化：高于普通活动日志，因为核心是 evidence-linked claim + correction + replay，不是时间线本身。
- 致命假设：用户愿意看懂并纠正候选；纠正真的能降低后续错误。

### 方向 B：立即自动化助手（暂不选择）
- 用户价值：表面最高，但 GUI grounding、权限、副作用、回滚和 evaluator 同时成为关键路径。
- 可行性：低；一旦失败，无法判断是感知、推理、知识还是执行错误。
- 差异化：容易退化为已有 Computer Use/RPA。

### 方向 C：Agent Gateway First（后置）
- 用户价值：对已有 Codex/Claude 用户有价值，但没有个人知识资产时只是又一个协议桥。
- 可行性：中；Codex/ACP 协议可接，但仍快速演化。
- 差异化：弱于“可纠正个人工作模型”。

### Pre-mortem
1. **用户认为这是漂亮的活动日志而非助手**：首屏必须展示“我学到了什么、依据是什么、纠正后发生了什么”，而非仅列 Timeline。
2. **synthetic fixture 造成虚假成功**：里程碑 2 加入一个极窄只读真实事件源（例如本地 demo event importer/文件事件），但不接真实输入注入。
3. **规则卡鼓励错误确定性**：显示 confidence、反例、证据数量、时间范围和“推断/已确认”状态。
4. **隐私承诺被字段泄露击穿**：白名单 schema、写前 redaction、默认无 raw text、导入预览和一键清除。
5. **架构为未来做得过重**：只冻结六个领域对象与四个端口，协议/数据库/桌面壳均可替换。

## Idea Refine Phase 3 草案

### Recommended Direction
构建 **ProAGI Insight Loop**：一个以开发者 Daily Engineering Report 为任务外壳的可纠正工作模型收件箱。用户导入一组白名单化的本地开发事件，系统形成 Episode、日报、知识候选和一个高价值问题；用户可接受、编辑、驳回或删除；随后 replay 同类事件，系统必须展示修订已被吸收。六态球体是闭环状态与隐私控制入口，不是主产品本身。

### Key Assumptions to Validate
- [ ] 用户能在 30 秒内理解候选结论、证据和置信度，并愿意纠正。
- [ ] 同类事件 replay 后，纠正能确定性降低相同错误，而不是只修改展示文本。
- [ ] 白名单事件足以生成有价值的日报/知识，不需默认记录 raw text 或截图。
- [ ] 用户把六态球体理解为“状态与控制”，而不是持续监视的象征。

### MVP Scope
- 版本化 `BehaviorEvent` fixture 导入与写前脱敏；
- Episode 分段与 Daily Engineering Report；
- Insight Inbox：知识候选、证据、置信度、时间范围；
- accept/edit/reject/delete 与 revision history；
- replay before/after 对比；
- 一个 Socratic Question 和一个 Shadow Skill proposal；
- 指定参考图风格的六态 Orb、隐私暂停与 reduced-motion/accessibility；
- 本地浏览器存储/导出，领域接口与 UI 解耦。

### Not Doing
- 不接真实桌面输入注入或 GUI 自动点击——避免把执行副作用混入学习验证。
- 不持续截图、不保存剪贴板正文/完整路径——先证明最小语义事件是否足够。
- 不接 Codex/ACP/MCP/Obsidian/Tauri 全链路——先冻结领域语义；后续通过 Adapter 接入。
- 不实现 Kernel 自修改、模型训练、复杂 DAG、多用户/云同步。

### Open Questions
- 哪一种窄真实只读事件源最适合作为 synthetic 之后的第二里程碑？
- 用户是更愿意纠正“日报段落”还是“原子工作规则卡”？
- confidence 应如何校准，避免数字制造虚假精确感？
- 用户认为球体何时算“打扰”，建议出现的冷却阈值应如何实测？

## 六件套一致性基线（用于后续 REVIEW）

- 产品/品牌：`ProAGI Assistant`；首个切片：`ProAGI Insight Loop`。
- Canonical UI 状态仅六个：`LEARNING | EXECUTING | IDLE | SUGGESTION | ERROR | PRIVATE`。
- Claim revision 状态统一为 `proposed | confirmed | rejected | invalidated | deleted`；Knowledge head 状态为 `current | superseded`，tombstone 为独立 tagged union。
- Action 首版对象链为 `SkillCandidate → ActionIntent(mode="shadow") → ShadowPreview`；不得有真实 input injection，“执行中”只表示本地推断、导出或 Replay。
- 领域 `schemaVersion` 使用 semver 字符串；摄入/命令 ID 用 UUIDv7，Replay 派生 ID 用 UUIDv5；所有输出记录 pins 与 evidence IDs。
- 运行态 canonical store 与投影分离；M1a 用 memory、M1b 用 IndexedDB，localStorage 仅存无敏感 UI 偏好。
- 删除采用 plan → 短事务 → post-commit audit/幂等补偿；最小 tombstone 不含已删 payload。
- 测试必须区分 `[INV]`、`[PH]`、`[STAT]`；不得把 8/10 文档分数或 synthetic 成功当发布硬门禁/用户价值证明。
- 第一开发切片的真实完成定义：可导入 fixture、生成 Episode/日报/Insight、完成 correction、Replay 体现 revision、切换六态/隐私、测试/构建通过。

## REVIEW Round 1 主代理预扫描

- **状态名冲突**：PRD 使用 `PROPOSED/CONFIRMED/REJECTED/DELETED/INVALIDATED`，SPEC 使用 lowercase `proposed/accepted/rejected/superseded/deleted`；必须建立唯一 canonical enum。
- **存储冲突**：PRD/findings 允许 localStorage 承载领域 payload，SPEC/ARCH 要求 canonical store 为 IndexedDB、localStorage 只存无敏感偏好；应以后者为准。
- **ID/确定性冲突**：SPEC 全局要求 UUIDv7，ARCH Replay 要求由 fixture namespace + canonical content 派生稳定 ID；需区分交互/持久化 ID 与 Replay-derived deterministic ID。
- **去重 hash 歧义**：BehaviorEvent `contentHash` 仅明确排除 ingestedAt/status，若包含 id，重复内容无法幂等；应明确排除 id 和运行态字段。
- **CorrectionLocality 阈值冲突**：PRD 记为 `≥0.99 [PH]`，SPEC/EVAL 对确定性 R0 要求 `1.00 [INV]`；应按 R0 与真实 pilot 分层。
- **模型结构冲突**：ARCH 以 `WorkModelClaimRevision` 为主要对象，SPEC 将 `WorkModelClaim` 和 `KnowledgeVersion` 分离；需要一个实现级 source of truth，避免双重 revision。
- **里程碑命名**：PRD 用 R0/完整 MVP/Phase 2/3，PLAN/CHECKPOINT 用 M1–M5；应添加映射，防止 Gate/验收错配。

## REVIEW Round 2 主代理预扫描

- **Retention 未冻结**：六件套要求“显示/调整保留期”，但没有 M1/M2 默认 TTL、到期删除动作和 clock-skew 规则。
- **Consent 不闭合**：`SourceRef.consentId` 可选，未规定 readonly-adapter 时必填，也没有 ConsentRecord schema、撤回后的 cascade 或版本绑定。
- **Tombstone hash 泄露**：`formerHash/entityHash/semanticKey` 可能成为低熵 statement/project 的离线字典 oracle；需明确只保留不含 payload-derived digest 的随机 deletion marker，或使用有威胁模型的 keyed token。
- **Clear-all 歧义**：SPEC 允许保留审计计数，与用户对“一键清除”的预期可能冲突；默认应清空 origin 内全部产品数据，仅在显式选择时另导出无 payload 证据。
- **本地不等于静态加密**：未明确 IndexedDB 依赖 OS/browser profile 防护，不能宣称应用级 encryption at rest；需要风险披露与 M2 决策门。
- **CSP/供应链不够可执行**：ARCH 只写 CSP/lockfile；应禁止 remote scripts/fonts、固定 self-only production CSP、对 dynamic HTML 和依赖更新建测试。
- **删除补偿竞态**：post-commit audit 失败后必须先冻结所有写入，再做幂等补偿；否则新导入可在审计与补偿之间复活引用。
- **SourceRef milestone allowlist**：M1 只能 fixture/json-import；readonly-adapter 必须由 M2 schema/policy + consent 显式启用，不能仅靠 union 成员。

## REVIEW Round 2 合并裁决与新基线

- 三维趋势：质量 6.8、效率 6.8、复用/一致性 7.1；P0=0，CONDITIONAL；详见 `docs/reviews/round-2.md`。
- 隐私删除不是业务 payload 状态：所有 live schema 移除 `deleted`，tombstone 只存原 ID、类型、随机 deletionId、deletedAt，不存 payload-derived hash。
- restore 只允许仍存在的 superseded/invalidated revision；privacy delete 是终态，删除 lineage 不得 restore/replay/re-import resurrection。
- SourceRef 是 discriminated union；readonly source 必带 active ConsentGrant；RetentionPolicy 独立于 reachability。
- BehaviorEvent 分离 factHash（去重/Replay）与 provenanceHash（来源审计）；contentHash 是实体完整性。
- 所有 Port 接受 PortRequestContext；KnowledgePort 使用事务外纯 planning + 事务内预生成 batch commit，禁止任意 async callback。
- IDB meta store 原子管理 cursor/privacyEpoch/mode；未验证 DeletionJournal 启动恢复；RECOVERY_ONLY 允许清除而拒绝普通写。
- fake-indexeddb 只证明 contract；quota/crash/transaction inactivity/multi-tab 必须用真实 Chromium。
- Shadow 零副作用限定到 ActionPort/ShadowPreview 调用图；canonical IDB 和用户显式 export 不属于 action。

## REVIEW Round 3 主代理预扫描

- **VersionPins 对真实源不可用**：`VersionPins.fixture` 对所有 provenance 强制必填，M2 readonly source 没有 fixture；应改为通用 `inputSet`/dataset pin，并让 EvaluationResult 的 fixtureId 只在 fixture run 必填。
- **Correction 不可变与 pending 状态机矛盾**：同一 schema 既要求 `pending -> applied|failed`，又要求永不原地修改；应把 pending 限定为内存 request，持久化 `CorrectionRecord` 直接终态，或用独立 attempt/result records。
- **EvidenceLossPolicy 会保留被删派生 payload**：0 support 时 append invalidated 仍携带旧 statement/evidence；应删除所有引用目标 evidence 的旧 revision，只在剩余证据独立满足且 canary scan 清洁时创建无 parent 的 rederived proposed root，否则删除 lineage。
- **CSP 有策略但缺验证命令**：PLAN 的统一命令没有 `audit:deps`/CSP build 检查；供应链发现无法进入 verify。
- **Node/Chromium 基线仍漂移**：PLAN 写 Node 22 或 24、Chromium current stable；应固定 CI 主基线与 Playwright lockfile revision，兼容矩阵另列。
- **性能 evidence 假设 Git commit**：EVAL 要求记录 commit/build，但当前目录不是 Git repo；应允许 artifact/source-tree hash 作为 canonical build identity。
- **EventEnvelope 与 canonical entity store 重叠**：ARCH 引入 event envelope/streamRevision，但系统并非 event sourced，SPEC 也无此持久化对象；需明确只用于未来 adapter envelope或删除该层，避免双重 revision/cursor。
- **factHash 唯一索引丢 provenance**：相同事实经不同 source/adapter 摄入时，`events.byFactHash(unique)` 只保留第一份 SourceRef；应增加 source-stable `dedupeKey` 唯一索引，factHash 为非唯一语义索引，Replay 合并语义但保留全部 Observation provenance。
- **跨标签内存不可审计**：单标签 `ReachabilityAuditV1` 无法读取其他 renderer 的 JS heap/DOM；删除不能在未收到已注册活动标签 purge ACK 前宣称 verified，冻结/失联标签应保持删除 pending 并提示关闭窗口，不能伪造零可达。
- **Export schema 仍是文字引用**：`ExportEnvelopeV1/ExportReceipt` 被多文档引用但 SPEC 无完整字段级 interface；与 DomainSnapshot/CanonicalMutation 一样应归入平台中立 DTO registry。

## REVIEW Round 5 最终 canonical 裁决

> Round 1–3 条目是历史诊断；若与本节或 `docs/final/SPEC.md` 冲突，以当前 SPEC 与 final-stitch 为准。

- 评审止于 5/5，不开启 Round 6；分数只作趋势。最终修订后直接执行 M1a→M1b→M1c。
- UI/CLI 只通过正式 application ControlPort/use cases 触发 privacy、recovery、retry purge、clear、Replay 和 export；adapter/React 不自行编排。
- PreviewToken 由持久 guard 在同一 transaction 原子消费并写 mutations/ledger/receipt；raw source bytes 不持久，buffer 丢失 fail closed。
- 删除采用 T0 plan baseline equality → fence内分页enumeration/chunks → generation client purge/quarantine/seal → all-root audit → FINALIZING → 短Tv；RecoveryLease 用 fencing token。
- privacy delete 优先 immutable/append-only：所有关联 claim/workflow/knowledge/correction/evaluation/ledger/change/projection/cache records 物理删除；verified 只留随机无关联 receipt/tombstone。
- NDJSON 大输入从原始 transferable bytes 在 Worker 中 fatal streaming decode；Worker只拥有 validation receipt，Application独立重算并拥有 commit receipt。未完整发布 ImportSession 不进入 Sensemaking。
- Shadow 测试以正式 ShadowPreview renderer 和 ActionPort roots扫描唯一 browser-effect sink registry，不只检查 fetch/WebSocket。
- 合法、仍live且allowlisted的 local-sensitive正文可在可见语义节点/表单及等价a11y text中最小展示；restricted/prohibited/deleted在全sink为0；正文不得扩散到name/live/hidden/log/published artifacts。
- UUIDv7、run timestamp、cursor/epoch 不参与 Replay/Episode 语义排序或hash；事件比较器使用 source-stable hashes。
- M1 仅 bundled/synthetic/test-prepared fixtures；任意真实本地数据从 M2 consent 开始。Gate 1 在package/tests/CI/evidence实际运行前为NOT_RUN。

## 实施级 YT Audit 裁决（Round 32–33；非文档 Review Round 6）

- 三个独立 reviewer 一致识别的最高风险是：单 claim delete 错接 `clearAll()`、CacheStorage 未验证却可成功、source-stable dedupe 未落地、application root 未注册。四项均已在当前 M1 路径修复并增加真实/contract 回归。
- 关键 P1 已关闭：preview/privacy T0 竞态、并发 preview/raw buffer、commit response loss、transient command 持久化、KnowledgeVersion/Head 缺失、NFC key collision、假时间戳、Worker error/backpressure/allowlist、future projection cursor、recovery reserve accounting、13-sink Shadow registry、axe 与 CI evidence log。
- 保留的条件项：完整 PortRequestContext/DomainResult、跨标签状态传播与删除协调、大 store cursor pagination、完整 lifecycle/artifact closed registry、Worker 在 bundled UI 产品路径的真实接线、全量 provenance graph evaluator。
- 因上述范围项及 NVDA/人工视觉/hosted CI 未执行，最终自动化绿灯只支持 Gate 1 `CONDITIONAL`，不支持 `PASS` 或真实用户价值/真实桌面自动化声明。
