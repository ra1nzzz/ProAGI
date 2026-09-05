# ProAGI Assistant 深度调研报告

**研究对象**：`docs/PRD/desktop-agent-complete-prd-v1.1.md`  
**UI/UX 参考**：`reference/Prototype reference1.png`  
**方法**：一手源优先、假设驱动、交叉对比、反例扫描、显式不确定性  
**结论用途**：约束最终 PRD、SPEC、ARCH、PLAN、CHECKPOINT、EVAL 及首个开发切片

---

## 1. 结论：先证明“纠正后不再犯同一个知识错误”，不要先证明“Agent 能点按钮”

PRD 最有价值的主张不是悬浮球、持续截图或对接某个 Runtime，而是：系统能够把个人工作经验沉淀为可复用、可评估、可回滚的能力。要验证这一主张，第一版不应同时承担真实桌面权限、GUI grounding、模型规划、外部副作用和跨平台兼容性。

本研究建议首个垂直切片收敛为 **ProAGI Insight Loop**：

> 白名单化本地行为事件 → Episode → Daily Engineering Report → 带证据的工作模型候选 → 用户接受/编辑/驳回/删除 → 不可变知识版本 → 同类事件 Replay → 展示纠正是否被吸收。

首版 Action 只输出 Shadow Suggestion/Action Intent，不注入鼠标键盘，不修改用户文件，不调用外部服务。这样做不是逃避自动化，而是隔离变量：只有先证明“证据—知识—纠正”的语义稳定，后续执行失败时才知道问题发生在感知、知识、计划还是动作层。

反直觉但更严格的成功标准是：**一次任务做成不算核心成功；用户纠正后，下一次系统能以可审计方式不再犯同一个知识错误，才算完成最小学习闭环。**

---

## 2. 为什么原 PRD 需要重新收敛

PRD 一方面明确要求先做 Research Prototype 和最小闭环，另一方面又在 MVP 优先级中同时纳入 Desktop Daemon、Floating Orb、Windows Perception、Activity Segmentation、Knowledge、Obsidian、Codex、Generic CLI、MCP、Skill Builder、Sandbox、Replay、Shadow 等大量关键路径。这使“验证产品假设”退化为“并行完成一个 Agent OS”。

范围膨胀会让任何失败都无法归因：没有生成好日报，可能是 A11y 缺失、截图识别错误、Episode 分段错误、模型理解错误、Runtime 协议变化或 UI 没有表达清楚。更合理的分层是：

1. **可执行研究切片**：fixture/本地事件导入、Episode、日报、Insight Inbox、纠正、版本、Replay、六态 Orb。
2. **窄真实只读源**：接入一个用户主动选择的低敏事件源，验证 synthetic 之外的噪声与外部效度。
3. **Runtime/知识投影**：Codex/ACP adapter、Markdown/Obsidian projection、CLI/MCP。
4. **经确认的低风险动作**：dry-run、precondition、idempotency key、postcondition、undo/compensation。
5. **真实桌面与更高阶演化**：UIA、按需截图、Sandbox、Skill Evolution；Kernel 修改继续保持实验状态。

---

## 3. 假设裁决

### H1：产品楔子是可见、可纠正的工作模型，而不是立即自动操作

**裁决：有条件强支持。**

Codex app-server 与 ACP 都把计划、工具调用、审批、状态更新、取消和最终结果表示为显式协议对象，而非隐藏在黑箱里。DGM 的自我改进也依赖候选谱系、经验评价和保留失败分支。OSWorld 的低成功率及长程任务失败模式则说明，把执行直接放到首版会引入大量与个人知识无关的噪声。

但“能纠正”不等于“愿意纠正”。Algorithm Aversion 的五项实验发现，参与者在看到算法犯错后，比看到人类犯同样错误更快失去信心，即使算法整体表现更好。因此 MVP 必须测量忽略、关闭、纠正耗时和净节省时间，而不能只展示 accept rate。

### H2：事件/结构化语义优先于持续截图

**裁决：支持，但必须改写为 `allowlisted semantic/event-first + screenshot-on-demand fallback`。**

Microsoft UI Automation 提供 AutomationElement tree、统一属性、control pattern 和定向事件订阅，证明结构化事件是 Windows 感知的合理主通道。OSWorld 也观察到文本轨迹历史优于 screenshot-only history；同时它指出 A11y tree 可能缺失、嘈杂或极大，高分辨率截图在某些任务中仍有增益。

因此 semantic-only 同样错误。截图只应在字段缺失、用户主动提供或诊断时，对当前窗口最小 ROI 做瞬时处理；原图默认不落盘，仅持久化派生语义、置信度和截图哈希。

更重要的是，结构化事件并不天然隐私。项目名、窗口标题、URL、命令、时间序列可能比像素更易检索、关联和推断。隐私判断必须基于字段可推断性、关联能力、保留期限和用途，而不是数据格式。

### H3：稳定契约与模拟事件应先于真实全链路

**裁决：工程层面强支持，产品价值层面不充分。**

OSWorld 依靠固定初态、隔离环境、配置与 execution-based evaluator 才获得可复现结果。Codex app-server 支持 JSON-RPC/JSONL，但明确声明 WebSocket 仍为 experimental/unsupported；ACP 当前稳定协议版本为 v1，兼容性由 initialize 时协商的 protocolVersion 与 capabilities 决定。

所以“稳定端口”应指版本化、可替换、可回放的内部契约，不是固定 TCP/WebSocket。Synthetic fixture 可验证 schema、状态机、纠正与 Replay 不变量，却不能证明用户价值、真实噪声鲁棒性或执行安全。完成工程切片后，必须加入一个用户自选、只读、短期保留的真实事件源。

---

## 4. 三种代表路径的交叉对比

### Microsoft Recall：以截图覆盖面换取高安全控制成本

Recall 用周期快照和本地索引解决“找回曾经见过的内容”，并提供 opt-in、暂停、应用/网站过滤、删除和本地处理。它证明广覆盖桌面记忆有明确用途，也证明 local-first 远远不够：产品仍必须提供持续状态可见、排除范围、删除和操作系统级保护。官方文档还承认过滤并非绝对，嵌入内容等仍可能被捕获。

ProAGI 不应在首版复制 Recall 的截图安全控制面。它应先用字段白名单和来源可见性证明“少量事件能否产生可纠正知识”。

### OSWorld：以真实执行和隔离 evaluator 测任务结果

OSWorld 构建真实操作系统环境、固定任务初态和自定义 execution-based evaluator。原论文包含 369 个任务；人类完成率超过 72.36%，当时最佳模型仅 12.24%。这些数字会随模型和版本变化，但研究方法的意义稳定：任务成功必须由最终状态断言，而非 Agent 自报或点击轨迹相似度。

ProAGI 的首版不需要重建重型 VM benchmark，但必须继承其思想：fixture reset、结果状态断言、负面样本和可复核 provenance。真正执行桌面动作时，再升级到隔离环境和副作用评价。

### ActivityWatch：结构化本地事件可用，但活动日志不等于个人知识

ActivityWatch 的 watcher → bucket → JSON event → API/query 模型证明 event-first、本地化、可扩展分类可以形成有用摘要。其安全文档也暴露边界：本机 API、静态数据保护和同机恶意进程仍需要额外威胁模型。

ProAGI 的差异不能只是更漂亮的活动时间线，而应是：每个推断都有 evidence IDs、适用范围、置信度和反例；用户操作生成不可变版本；Replay 能证明纠正是否真正影响后续推断。

---

## 5. 推荐产品方向：ProAGI Insight Loop

### 5.1 核心 Job

> 当我结束一段开发工作时，我希望系统用最少的本地事件重建我做了什么、它认为我如何工作，以及哪里需要我纠正，从而减少日报和下次恢复上下文的成本，而不必交出屏幕内容或允许它直接操作电脑。

### 5.2 最小领域对象

- `BehaviorEvent`：版本、事件 ID、时间、来源、种类、脱敏 subject/attributes、privacy 标记、correlation ID。
- `Episode`：边界、标题、项目、事件引用、推断置信度和分段版本。
- `EvidenceRef`：来源事件、变换版本、保留状态、哈希。
- `WorkModelClaim`：statement、scope、confidence、evidence、counterevidence、status、revision。
- `Correction`：accept/edit/reject/delete、patch、reason、evidence additions/removals。
- `EvaluationResult`：fixture、版本 pin、canonical output hash、指标与失败原因。
- `DailyReport`、`Question`、`SkillCandidate` 是以上对象的产品投影，不得成为不可追溯的独立真相。

### 5.3 稳定端口

- `ObservationPort`：首版 `SyntheticEventAdapter`/JSON import，后续 `WindowsUIAAdapter`。
- `KnowledgePort`：产生候选而非直接覆盖已确认知识。
- `CorrectionPort`：保留 lineage，修改不能擦除历史证据。
- `ActionPort`：首版仅 `SuggestionSink`；以后真实动作必须包含 precondition、idempotency key、expected effect、postcondition、undo/compensation。
- `ProjectionPort`：运行态 canonical store 与 Markdown/Obsidian 投影分离。
- `RuntimePort`：领域对象不得泄漏 Codex Thread/Turn/Item 或 ACP 私有扩展。

---

## 6. UI/UX 约束：球体是信任仪表，不是产品替身

指定参考图的六态作为 canonical：

| 状态 | 颜色 | 必须同时表达的语义 |
|---|---|---|
| LEARNING | 蓝 | 缓慢旋转/水流，显示当前观察来源 |
| EXECUTING | 绿 | 流动推进；首版仅表示本地处理/Replay，不暗示真实动作 |
| IDLE | 紫 | 呼吸光晕，可随时响应 |
| SUGGESTION | 琥珀 | 微弹提示并显示待审卡数量 |
| ERROR | 红 | 波纹/图标/文本，不只依赖颜色 |
| PRIVATE | 灰 | 锁图标、暂停来源和恢复入口 |

低感知模式 24–28px（token 26px），主动悬浮 88–110px（token 96px）。单击展开状态/Insight，长按控制面板，拖拽位置，右键隐私/统计/设置，双击聊天。旋转手势后置。所有状态必须有文本和 `aria-label`，并支持 reduced motion。

首页不应以 Timeline 为中心，而应回答三件事：**我观察了什么、我学到了什么、你的纠正改变了什么。**

---

## 7. 反例与失败条件

### Synthetic 自洽陷阱

Fixture 同时编码事件语义、正确答案和 Replay 目标时，系统可能只是在复现设计者的世界。缓解方式是严格区分：fixture 只做工程门禁；真实价值需要用户自选事件、独立真值和后续实际复用。

### 纠正劳动超过收益

复杂 ontology、provenance 和版本 UI 可能把用户变成数据管理员。首版纠正必须以单击和局部字段编辑为主，并衡量：

`净价值 = 节省时间 − 审阅时间 − 纠正时间 − 错误恢复时间`

### Provenance 制造虚假信任

“有来源”不等于“推断正确”。UI 应区分 `observed`、`inferred`、`user-confirmed`，展示反证与适用范围，并植入错误推断测试用户是否能发现，而不是只问“是否信任”。

### Shadow 回避执行风险

纯 Shadow 不能验证权限拒绝、stale state、重复执行、不可逆副作用或补偿失败。因此首版只能声称验证学习/建议契约。后续阶段必须加入经确认、可撤销、可观察结果的低风险动作与 dry-run diff，才可声称验证自动化执行。

### 删除只是 UI 假象

删除原始事件时，派生知识、索引、缓存、导出和 Replay 产物必须级联不可达。允许最小 tombstone，但不得保留已删除 payload。

---

## 8. 评价框架

### 8.1 不可协商不变量 `[INV]`

- 100% WorkModelClaim 有完整可解析 evidence。
- 同 fixture、同 schema/adapter/policy 版本的 canonical output hash 完全一致。
- 同 scope 的 edit 下一次 Replay 必须吸收；reject 不得静默重提；delete 不得复活。
- 未列入 allowlist 的字段持久化数量为 0。
- 默认 Raw Screenshot At Rest = 0 bytes；无真实输入注入、无云传输。
- Provenance lineage 无断链、无环、无跨用户引用；篡改必须被检出。
- evaluator 以最终领域状态断言，不以 UI 成功文案或点击序列断言。

### 8.2 产品假设 `[PH]`

以下是待 pilot 修订的目标，不是文献共识：

- 用户在 30 秒内理解并完成一次候选纠正。
- Episode-F1：clean fixture ≥ 0.95，扰动集 ≥ 0.85。
- 相邻 context 的 Correction Absorption ≥ 0.80。
- Correction Locality ≥ 0.99。
- Brier ≤ 0.15、ECE ≤ 0.05；低样本阶段只展示 reliability bins，不假装精确校准。
- 存在阈值使 Selective Risk ≤ 0.05 且 Coverage ≥ 0.50。
- 净步骤节省中位数 > 0；acceptance rate 只能描述行为，不能代替价值。

### 8.3 Fixture 设计

完整 MVP 目标为 192 个集成 fixture + 1,000 个 score-only calibration fixture；第一开发切片先实现能扩展到该规模的结构：

- 核心闭环：accept/edit/reject/delete、冲突 scope、held-out 正例、近邻负例。
- 事件扰动：drop、duplicate、reorder、clock skew、schema drift、locale/timezone、进程重启。
- 隐私/对抗：canary secret、超长/Unicode/Bidi、跨用户 scope、删除后 cache/export/replay。
- GUI evaluator：成功文字但状态未变、旧 toast/旧状态残留、provenance 缺失均判失败。

---

## 9. MVP 明确不做

- 不持续截图，不保存剪贴板正文、键击内容或完整文档正文。
- 不注入鼠标键盘，不自动发送邮件、删除/移动真实文件。
- 不把 Codex app-server、ACP、MCP 或 Obsidian 当作核心领域模型。
- 不在第一切片接完整 Tauri/Rust/Windows UIA 权限链；当前环境先实现可测试的 TypeScript/Web 垂直切片。
- 不实现多 Agent 自博弈、Kernel Rewrite、模型微调、复杂 DAG、云同步或多用户。
- 不宣称 synthetic fixture 证明了真实用户价值。

---

## 10. 仍然不知道什么

1. 重度开发者是否愿意长期纠正工作模型；这需要真实 pilot，而非文档推理。
2. 真实目标应用中的 UIA 覆盖率、事件丢失率和控件语义质量。
3. 事件和截图在具体字段、保留期与查询能力下的相对隐私风险。
4. 用户更愿意纠正日报段落、原子规则卡，还是一次低摩擦问题。
5. 何种窄真实只读事件源能在低权限下提供足够价值。
6. Shadow 建议何时应升级为经确认的低风险执行。
7. 长期并发、同步与历史量增大后，Markdown 投影和 canonical store 的边界如何演进。

---

## 11. 信息源

1. **Microsoft UI Automation Overview**  
   https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-overview  
   > “UI Automation provides programmatic access to most user interface (UI) elements on the desktop…”

2. **Microsoft Recall overview / privacy controls**  
   https://learn.microsoft.com/en-us/windows/apps/develop/windows-integration/recall/  
   https://support.microsoft.com/en-us/windows/privacy/privacy-and-control-over-your-recall-experience-d404f672-7647-41e5-886c-a3c59680af15

3. **Apple screen and system audio recording controls**  
   https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac  
   > “You can decide which apps and websites are allowed to record your screen and audio.”

4. **OSWorld paper and official project**  
   https://arxiv.org/abs/2404.07972  
   https://github.com/xlang-ai/OSWorld  
   > “Each task example… includes a detailed initial state setup configuration and a custom execution-based evaluation script for reliable, reproducible evaluation.”

5. **OpenAI Codex app-server README**  
   https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md  
   > “Websocket transport is currently experimental and unsupported. Do not rely on it for production workloads.”

6. **Agent Client Protocol v1**  
   https://agentclientprotocol.com/protocol/v1/overview  
   https://agentclientprotocol.com/protocol/v1/transports  
   https://github.com/agentclientprotocol/agent-client-protocol

7. **ActivityWatch overview, data model and security**  
   https://activitywatch.net/  
   https://docs.activitywatch.net/en/latest/buckets-and-events.html  
   https://docs.activitywatch.net/en/latest/security.html

8. **Obsidian Properties**  
   https://help.obsidian.md/properties  
   > “Properties are meant for small, atomic bits of information that are both human and machine readable.”

9. **Darwin Gödel Machine**  
   https://arxiv.org/abs/2505.22954  
   https://github.com/jennyzzt/dgm  
   > “Instead of requiring formal proofs, we empirically validate self-modifications against a benchmark…”

10. **Algorithm Aversion**  
    https://pubmed.ncbi.nlm.nih.gov/25401381/  
    > “people more quickly lose confidence in algorithmic than human forecasters after seeing them make the same mistake.”

11. **On Calibration of Modern Neural Networks**  
    https://proceedings.mlr.press/v70/guo17a.html  
    > “modern neural networks… are poorly calibrated.”

12. **W3C PROV-O Recommendation**  
    https://www.w3.org/TR/prov-o/  
    > PROV-O defines entities, activities, agents and provenance chains for interoperable provenance representation.

13. **GDPR Article 5 — data minimisation principle**  
    https://eur-lex.europa.eu/eli/reg/2016/679/oj

14. **Guidelines for Human-AI Interaction**  
    https://doi.org/10.1145/3290605.3300233

---

## 12. 研究局限与工具降级说明

当前主会话没有 Tavily/专用搜索 MCP；内置 WebSearch 因缺少 `DEEPSEEK_API_KEY` 无法使用。研究因此降级为：受控子代理直读已知官方域名/论文，以及主代理通过已知 canonical URL 直接核验原文。没有使用搜索结果摘要替代原文。部分二手扩展和纵向用户留存数据未覆盖；所有数值阈值均明确区分为系统不变量或待验证产品假设。
