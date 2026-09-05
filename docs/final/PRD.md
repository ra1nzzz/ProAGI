# ProAGI Assistant 产品需求文档（精炼版）
**产品品牌**：ProAGI Assistant  
**核心能力**：ProAGI Insight Loop  
**文档状态**：可进入首个研究切片设计与实现  
**范围原则**：本地优先、事件白名单、证据优先、用户可纠正、版本不可变、Shadow-only
---
## 1. 产品定义
ProAGI Assistant 是一个学习用户工作方式的个人助理。
它先把少量、获准的本地行为事件转化为可审阅的工作理解，
再通过用户纠正和 Replay 验证系统是否真正吸收了修订。
首要价值不是“替用户点击按钮”，
而是“让用户看见、纠正并复用系统对其工作方式的理解”。
首个核心场景是开发者每日工程结算：
> 从白名单事件重建工作 Episode，生成 Daily Engineering Report，提出带证据的 Insight，接受用户纠正，并在同类事件 Replay 中证明纠正已被吸收。
本 PRD 内所有 Action 均为 `SHADOW`。
系统不得注入鼠标或键盘，不得修改真实用户文件，不得调用外部写服务。
---
## 2. 产品原则
1. **Evidence before inference**：任何长期结论都必须可追溯到 evidence IDs。
2. **Correction before automation**：先证明系统能吸收纠正，再讨论真实执行。
3. **Allowlist before collection**：只持久化显式白名单字段。
4. **Local ownership, not local secrecy**：运行态数据默认保存在本地并由用户控制，但 local-first 不等于应用级静态加密，不能防同机用户、恶意扩展、浏览器 profile 同步/备份或磁盘取证。
5. **Version, never overwrite**：accept/edit/reject/restore 追加新 revision；隐私 delete 物理移除整个 lineage 的 live payload，仅留下无 payload 的随机 tombstone，不把删除内容保留成历史版本。
6. **Visible uncertainty**：观察、推断、用户确认必须明确区分。
7. **Quiet by default**：建议进入 Inbox，不以频繁弹窗打断用户。
8. **Replaceable boundaries**：领域对象不绑定某个 Runtime、桌面壳或存储实现。
9. **Shadow-only**：建议只展示意图、依据和预期结果，不产生真实副作用。
10. **Synthetic is not value proof**：fixture 只证明工程不变量，不证明用户价值。
---
## 3. 目标用户与 JTBD
### 3.1 首要目标用户
Windows-first 的重度 AI/Coding 用户，包括：
- 长时间使用 IDE、Terminal、Git 和 Browser；
- 已使用 Coding Agent，但个人经验散落在会话和工具中；
- 需要写日报、周报或恢复项目上下文；
- 愿意审阅少量高价值候选，但不愿配置复杂 RPA；
- 对隐私、误学和后台监视高度敏感。
### 3.2 次要用户
有稳定数字工作流的知识工作者可作为后续验证对象，
但不进入首个切片的需求决策。
### 3.3 核心 JTBD
> 当我结束一段开发工作时，我希望系统用最少的本地事件重建我做了什么、它认为我如何工作，以及哪里需要我纠正，从而减少写日报和下次恢复上下文的成本，而不必交出屏幕内容或允许它操作电脑。
### 3.4 用户痛点
- 工作跨应用、碎片化，事后难以准确回忆。
- 手工日报重复且容易漏掉关键上下文。
- 通用 Agent 不保留稳定、可迁移的个人工作模型。
- 活动时间线只记录“发生了什么”，不解释“学到了什么”。
- 黑箱记忆一旦学错，用户不知道如何纠正或验证。
- 自动化过早引入权限、副作用和信任风险。
---
## 4. 核心闭环：ProAGI Insight Loop
标准流程：
```text
白名单 BehaviorEvent
→ Episode
→ Daily Engineering Report
→ Insight Inbox
→ 接受 / 编辑 / 驳回 / 删除
→ 不可变知识 revision
→ 同类事件 Replay
→ 展示纠正前后差异
```
### 4.1 最小成功定义
一次生成正确日报不构成核心成功。
只有当用户纠正一个知识错误后，
系统在相邻同类事件中不再犯同一错误，
且变化可由证据、版本和结果状态审计，
才算完成最小学习闭环。
### 4.2 核心领域对象
- `BehaviorEvent`：事件 ID、时间、`SourceRef`、种类、白名单属性和 `PrivacyDecision`。
- `ConsentGrant`：M2 真实只读来源获准的字段、用途、保留策略、policy 版本和授予/撤回时间；fixture 不伪造 consent。
- `RetentionPolicy`：事件和派生对象的 TTL、到期时间及策略版本。
- `Episode`：起止边界、标题、项目、事件引用、置信度、分段版本。
- `EvidenceRef`：来源实体、变换版本、可达状态和哈希。
- `WorkModelClaim`：陈述、范围、置信度、证据、反证、状态和不可变 revision。
- `Correction`：accept/edit/reject/delete/restore、patch、原因及证据增删。
- `DeletionJournal`：active recovery journal 可暂存最小目标 ID/hash 且仅在 RECOVERY_ONLY 可读；verified 后只留随机无关联 receipt。
- `EvaluationResult`：输入版本、输出哈希、指标和失败原因。
`DailyReportSnapshot` 是可重建投影；`Question`、`SkillCandidate`、`ActionIntent` 是有交互状态的 workflow entity。它们都必须有 evidence/provenance，不得成为第二份工作事实。
### 4.3 Claim Revision、Knowledge Head 与隐私删除
实现级 canonical enum 以 SPEC 为唯一真相：
- Claim revision：`proposed | confirmed | rejected | invalidated`；
- KnowledgeVersion 不含 current/superseded status；独立 KnowledgeHead 只通过 CAS 指向当前 immutable version；
- 隐私删除：只由独立无 payload tombstone 表达，不是 live payload 状态。
- accept/edit/reject：追加相应 revision/version，并 CAS KnowledgeHead；
- 非隐私、仍保留 evidence 的逻辑失效可追加 `invalidated` revision；隐私删除/撤权不得保留失证 revision；
- restore：仅从仍 live 的历史 claim/version 内容创建新的 `confirmed` revision/version；
- delete：物理移除目标 lineage 的 live payload并写随机 deletion marker，永久禁止从 tombstone、缓存、导出或 Replay restore。
---
## 5. 分阶段范围
PLAN 的 M1–M5 是唯一 canonical roadmap；本 PRD 只使用该编号。任何真实动作研究必须另立 PRD，不属于当前路线承诺。
### 5.1 M1：npm + TypeScript/Web 可运行 Insight Loop
目标：用确定性 fixture 证明 Insight Loop 的工程闭环成立。M1a/M1b/M1c 分别称为 **Core Loop**、**Persistence & Deletion**、**Presentation**，命名与 PLAN 保持一致。
包含：
- 仅导入 bundled synthetic fixture 或用户专为测试准备、显式确认不含真实敏感数据的 schema fixture；任意真实本地 JSON 推迟到 M2 consent；
- 写入前白名单过滤和脱敏预览；
- 从事件生成 Episode；
- 生成 Daily Engineering Report；
- 生成带 evidence、scope、confidence 的 Insight 卡片；
- Insight Inbox 支持 accept/edit/reject/delete；
- accept/edit/reject/restore 生成不可变 revision 和 lineage；delete 走物理清除、journal 与无 payload tombstone；
- Replay 同类事件并展示 before/after；
- 证据满足版本化 eligibility predicate 时生成 0..1 个高价值 Question；证据不足时必须明确 abstain；
- 证据满足 eligibility predicate 时生成 0..N 个 SkillCandidate，并以 `ActionIntent(mode="shadow") → ShadowPreview` 呈现；允许为 0；
- 六态 Orb、隐私暂停和可访问性支持；
- 通过正式 application control use cases 执行暂停/恢复、删除恢复、重试PURGE、清空、Replay和显式导出，UI不得直接编排 Store；
- 本地存储、清空和结构化导出；
- 通过独立 gold/evaluator 的领域状态断言完成自动化评估。
M1 完成仅说明 schema、状态机、纠正和 Replay 可工作。
它不证明真实用户愿意使用、真实事件足够有效或自动化执行安全。
### 5.2 M2：一个窄真实只读源
目标：在不增加写权限的前提下验证真实噪声与用户净价值。
在 M1 基础上增加：
- 一个由用户主动选择的低敏、只读真实事件源；
- 不可变 `ConsentGrant`，明确来源、字段、用途、policy 与 `RetentionPolicy`；preview 与 commit 两次复核 active consent 和 `privacyEpoch`；
- readonly event 默认 TTL 7 天、derived 默认 30 天；用户可缩短，延长必须重新 consent；到期、撤权、策略缩短统一走 DeletionPlan/journal；
- 真实事件丢失、重复、乱序和 schema drift 处理；
- 本地 canonical store，并在 M2 前决定 profile/OS 隔离与 key strategy，或在 consent 中明确接受 local-first 的剩余风险；
- 日报、Insight 和纠正的真实 pilot；
- 忽略、关闭、纠正耗时和净节省时间测量；
- Shadow 建议的查看、忽略和“为什么建议”解释；
- 默认无云传输、无真实输入注入、无真实外部写入；用户显式 JSON download 是 `projection.export`，不属于 Action 副作用，但必须单独确认且不可由 Shadow 调用。
M2 pilot 仍为 Shadow-only。
### 5.3 M3：Runtime Adapter 与知识投影（独立子门）
目标：扩大可读性和互操作性，但不改变 Shadow-only 边界。
- **M3a Runtime**：验证 typed request/handle/result、deadline/cancel、capability、协议故障和最小上下文；Codex/ACP provider DTO 不进入 Core。
- **M3b Projection**：验证 Markdown/Obsidian 投影的 sourceCursor CAS、增量更新、全量重建、冲突与删除传播；canonical store 始终是真相源。
M3a/M3b 分别裁决和回滚；一方成功不得掩盖另一方失败。CLI/MCP、多 Runtime、多 projection 和截图实验继续后置。
### 5.4 M4：真实动作独立 PRD 检查点
M4 只裁决 `APPROVE_NEW_PRD | NEED_MORE_EVIDENCE | STOP`，不实现、不演示也不验证 live action；即使批准立项，当前 PRD 与 M1–M5 仍保持 Shadow-only。
### 5.5 M5：Tauri 壳与窄 Windows UIA
在前序阶段门通过后，仅验证原生驻留和一个 allowlisted 应用/控件族的只读 UIA adapter；若 IndexedDB→SQLite，必须用 StorageMigrationV1 冻结源、双库 hash/reachability 对比、原子切换且禁止长期双写，失败回到只读源库。不扩展为全桌面或通用 Computer Use。
### 5.6 长期愿景：Personal Agent Experience Graph（不属于 M1–M5 milestone）
愿景：把长期 Episode、知识、候选技能、评估和反馈连接为个人经验资产；不得用此段替代 PLAN 的 M4/M5 决策门。
候选范围：
- 跨项目 Work Model 与 Workflow Model；
- 证据衰减、冲突和失效机制；
- Runtime 可替换的个人上下文网关；
- 更广的只读桌面语义适配；
- Skill/Workflow 候选的版本比较、Replay 和回滚；
- 跨 Runtime 的能力声明与评估记录；
- 用户可迁移的知识、策略和演化历史。
真实自动执行、Kernel 修改和模型微调不属于本路线图承诺。
如未来探索，必须另立 PRD、威胁模型和安全门禁。
---
## 6. 明确非目标
本 PRD 不做：
- 持续截图或屏幕录像；
- 保存键击内容、剪贴板正文或完整文档正文；
- 鼠标/键盘注入；
- 自动发送邮件、发布内容、付款或删除/移动真实文件；
- 任何未经用户确认的网络传输；
- 把 Codex、ACP、MCP 或 Obsidian 作为核心领域模型；
- 首切片接完整 Windows UIA、Tauri/Rust 和桌面权限链；
- 跨平台原生桌面交付；
- 多 Agent 自博弈、复杂 DAG、云同步或多用户；
- Kernel Rewrite、在线自修改或模型微调；
- 用 synthetic 结果宣称市场需求、留存或用户价值成立。
---
## 7. 用户旅程
### 7.1 首次进入
1. 用户看到 ProAGI Assistant 的用途、Shadow-only 边界，以及“local-first 不等于应用级静态加密或同机不可读”的明确说明。
2. M1 用户主动选择 fixture/local JSON；M2 用户可选择一个只读真实来源。
3. 系统按 `public | local-sensitive | restricted | prohibited` 展示字段分类、将保留/剔除/拒绝的字段、用途、保留期限和导出边界。
4. M2 必须创建不可变、可审计的 `ConsentGrant`；preview 与 commit 都复核 active consent、字段、用途、policy、retention 和 `privacyEpoch` 后才可处理。
5. 用户切换 `PRIVATE` 时必须原子递增 `privacyEpoch`，广播其他标签页停止普通写并清空 preview、队列和定时器；旧 epoch 的 commit 必须 abort。PRIVATE 仍允许 read、delete/clear 和 recovery，恢复只进入 `IDLE`，不补采暂停期间事件。
6. 撤回 consent 必须递增 epoch、阻止新摄入，并按关联 RetentionPolicy 通过同一 DeletionPlan/journal 清除；删除恢复失败时进入 `RECOVERY_ONLY`，冻结普通写直至审计或幂等补偿完成。
### 7.2 每日工程结算
1. 系统把事件分为若干 Episode。
2. 用户查看“我观察了什么”。
3. 系统生成 Daily Engineering Report。
4. 用户查看“我学到了什么”和对应证据。
5. 仅当版本化 eligibility predicate 成立时，明确缺口 MAY 形成至多一个 Question；否则 abstain。
6. 候选结论进入 Insight Inbox，而非直接写成已确认知识。
### 7.3 纠正
1. 用户打开 Insight 卡片。
2. 卡片展示 statement、scope、confidence、evidence 和 counterevidence。
3. 用户可单击接受、驳回、删除，或局部编辑。
4. 系统显示新 revision、变化字段和影响范围。
5. 目标是让典型纠正在 30 秒内完成；该阈值是待验证假设。
### 7.4 Replay
1. 用户选择同类 held-out 事件。
2. 系统构造完整 ReplayInputV1，固定输入集合、Knowledge/Correction heads、asOf/locale/timezone、结构化 VersionPins 与 profiles；UUIDv7/run时间不参与语义排序或hash。
3. 页面并排显示纠正前后输出。
4. 系统以最终领域状态判断修订是否被吸收。
5. 若出现跨 scope 污染、被驳回内容复活或删除内容重现，则判失败。
### 7.5 Shadow 建议
1. 系统发现潜在可复用模式。
2. `SUGGESTION` 状态显示待审数量。
3. 用户看到 Action Intent、依据、前置条件和预期结果。
4. 点击“预览”只展示 Shadow Plan。
5. 不执行真实操作，也不暗示操作已经完成。
---
## 8. 功能需求
### FR-01 事件导入与规范化
- 所有输入必须携带 `schemaVersion`；每个事件必须有稳定 ID、时间、来源和 `PrivacyDecision`。
- 处理顺序必须是：预检 → parse → unknown/结构检查 → 初次类型验证 → NFC/control/Bidi → versioned detector → allowlist/redaction → 二次完整 schema 验证 → hash → commit。
- unknown field/enum 拒绝该 item；optional restricted/secret 字段整字段删除后重验；required/identity secret、prohibited 内容或 detector failure 拒绝整个 item。批量其余合法项可继续，UI 只报告数量和安全错误码，不回显输入。
- 重复、乱序和允许范围内的时钟偏移按确定性策略处理，不得静默改变 canonical 语义。
### FR-02 Episode 分段
- Episode 必须引用源事件 ID。
- 必须记录分段算法/策略版本和置信度。
- 用户可检查边界和项目归属。
- Replay 必须能固定相同版本复现 canonical output。
### FR-03 Daily Engineering Report
- 展示主要 Episode、进展、未确定项和证据入口。
- 明确区分 observed、inferred、user-confirmed。
- 不把缺失事件补写成确定事实。
- 报告内容必须能回链到 Episode 和 EvidenceRef。
### FR-04 Insight Inbox
- 卡片支持 accept/edit/reject/delete。
- 卡片展示 scope、confidence、evidence、counterevidence 和状态。
- 建议默认进入队列，不主动频繁打断。
- 首页优先回答：观察了什么、学到了什么、纠正改变了什么。
### FR-05 纠正与版本
- accept/edit/reject/restore 必须创建新 revision；revision lineage 不得断链或成环。
- 用户可查看 diff；restore 只允许从仍为 live 的 superseded/invalidated revision 创建新的 confirmed revision。
- delete 物理移除整个 lineage 的 live Claim/Knowledge payload，只写无 payload、无 payload-derived digest 的随机 tombstone；deleted lineage 永久返回 `ERR_DELETED_RESTORE_FORBIDDEN`，不得从 tombstone、缓存、旧导出或 Replay 恢复。
### FR-06 Replay 与评估
- Replay 只接受完整 ReplayInputV1；VersionPins 使用结构化 adapters/policies/algorithms，fixture/import/readonly 身份由 InputIdentity 单独表达。
- 结果记录 canonical output hash。
- evaluator 断言最终领域状态，不依赖成功 toast 或点击轨迹。
- 必须包含 held-out 正例和近邻负例。
### FR-07 Question
- 每轮最多突出一个高信息增益问题。
- 用户可回答、跳过或关闭同类问题。
- 回答先形成候选 revision，不直接写成永久事实。
- 问题必须说明为何询问及将影响哪些 claim。
### FR-08 Shadow Action
- M1 对象链统一为 `SkillCandidate → ActionIntent(mode="shadow") → ShadowPreview`。
- UI 只提供“预览建议”，不得出现可误解为真实副作用的“执行”按钮。
- 只能展示计划、前置条件、预期效果和四类禁止副作用。
- 从 ActionPort/ShadowPreview 调用图可达的未授权 external network、process、OS filesystem 与 input injection 必须为 0；canonical IndexedDB、页面同源静态资源和用户显式 `projection.export` 不计为 Action 副作用，但 Shadow 不得调用 export。
### FR-09 本地存储与导出
- canonical store 与 UI、Web API、Markdown 投影解耦。
- M1a 使用 in-memory store；M1b 起领域 payload 必须使用 IndexedDB；localStorage 仅允许无敏感 UI 偏好。
- 导出必须使用版本化 envelope，导出前显示实体类别、数量、最高分类和“旧下载不可远程撤回”边界并再次确认；应用只保留无 payload `ExportReceipt`。
- 应用管理的数据库、缓存、索引、新导出和 Replay 不得恢复已删 payload；已下载到应用控制范围外的旧副本无法远程擦除。
- local-first 不等于应用级 at-rest encryption；M1 仅 synthetic，M2 必须决定 profile/OS 隔离与 key strategy 或让用户在 consent 中明确接受剩余风险。
### FR-10 隐私控制
- 用户可查看当前来源、字段、用途、`DataClassification`、ConsentGrant 和 RetentionPolicy。
- 用户可暂停、恢复、撤回 consent、清空和缩短保留期；无新 consent 不得延长 M2 TTL。
- `PRIVATE` 原子递增 `privacyEpoch` 并停止普通摄入和 action suggestion，但仍允许 read、delete/clear、privacy settings 和 recovery；旧 epoch commit 必须 abort。
- 敏感字段必须写前过滤并二次 schema 校验，不得依赖事后清理；系统时钟不可读时停止新摄入并进入 recovery-only。
---
## 9. 隐私、权限与安全
### 9.1 Data Classification 与默认策略
- `public`：schema enum、粗粒度 appId/fileExt/计数；可持久化并按 export policy 导出。
- `local-sensitive`：时间序列、用户别名 projectKey、statement/reason/answer、scope 和 evidence graph；只进入本地 IDB，导出必须显式确认。
- `restricted`：原始标题/路径/URL/命令、细 detector ID 和可关联来源标识；只可瞬时 preview/redaction，不得持久化、默认展示或导出。
- `prohibited`：secret、键击/剪贴板正文、像素和未授权来源；必须拒绝，不得进入 store、log、cache 或 export。
默认 Raw Screenshot At Rest = 0 bytes、无云传输、无真实执行权限。结构化事件仍可能泄露和关联身份；local-first 仅描述数据位置，不构成设备级保密承诺。
### 9.2 Consent、Retention 与权限
M1 只启用 bundled/synthetic/test-prepared fixture，不伪造 consent；保留期为测试运行期或用户清除。M2 为一个窄真实只读源创建 immutable ConsentGrant；撤权另追加 ConsentRevocation，禁止把 revokedAt 原地写回 Grant。
M2 readonly event 默认 TTL 7 天、derived 默认 30 天；用户可缩短，延长必须重新 consent。preview/commit 双检 active consent 与 `privacyEpoch`；撤权、到期和策略缩短统一走 DeletionPlan/journal，且 PRIVATE 不暂停 TTL。任何读取权限不得与 Action 权限捆绑。
### 9.3 删除、restore 与恢复
删除后，目标及所有直接/间接引用它的 business/system record、ledger/change feed、Worker/preview staging、索引/cache/DOM/a11y/projection/export/replay artifact 必须不可达。T0 精确复核 plan cursor/epoch/hash 后切 RECOVERY_ONLY；在 fence 内分页枚举/处理 work。PURGE generation 覆盖期间新标签（ACK或隔离），RecoveryLease以fencing token保证单恢复者；Audit前seal membership，最终分页清理后用短Tv verified。未ACK、lease冲突或blocked clear不得显示成功。
verified 后只保留无原 entity/content ID、formerHash/semanticKey/自由文本/detector ID 的随机删除 receipt。restore 仅适用于仍保留的 superseded/invalidated revision；旧 lineage 永久禁止恢复，但用户未来显式重新导入同一事实可建立全新 lineage，不得读取 tombstone/缓存/旧导出补回旧内容。关联旧 EvaluationResult payload 必须删除，只留无 hash/evidence/关联 ID 的随机 invalidation receipt。clear-all 默认清除 origin 内全部产品数据和 journal/audit；外部旧下载只提示边界。
### 9.4 威胁重点
- 结构化事件的可推断性和跨事件关联；
- canary secret 或敏感值穿透白名单；
- 跨用户/跨 scope 证据污染；
- 删除后缓存或导出复活；
- provenance 被篡改；
- UI 显示成功但领域状态未变化；
- Preview 双提交、迟到 Worker/partial import、PURGE membership 与 recovery lease 竞态；
- sendBeacon/navigation/download/clipboard/share/service-worker/custom scheme 等浏览器原生通道绕过 Shadow。
---
## 10. UI/UX 与 ProAGI Orb
### 10.1 参考图边界
`reference/Prototype reference1.png` 是 mood board，不是整图 gold。M1 采纳暖白画布、深墨标题、蓝强调、细灰分隔、分组卡片，以及具有透明壳/外环/液体/双高光/底部光环/阴影/状态图标的立体 Orb；禁止退化成纯色圆。图中的鼠标轨迹、OCR、邮件/任务执行和 legacy `ProAGIAgent/智图灵助手` 品牌不进入 M1；产品统一名为 **ProAGI Assistant**。

### 10.2 AppShell 信息架构
首页按固定顺序提供：全局状态与隐私条 → Today 摘要 → Observed → Learned → Correction Impact → Insight Inbox → Replay。首屏主 CTA 是“导入本地样例”或“审阅 Insight”，不得是执行动作。Evidence/revision/provenance 使用渐进披露的详情抽屉；DailyReport 与 Inbox 是 canonical store 的投影，不建立第二真相源。

必须区分：首次未导入、合法 abstain、全部 item 被安全拒绝、删除后空库、加载/存储失败、projection stale/rebuilding。合法 0 输出必须解释“证据不足，因此没有推断”，不得为了填满界面伪造 Claim/Question/Skill。

### 10.3 Orb 六态与组合状态
Orb 是状态和信任仪表，不是产品主体。Orb 恰为六态：LEARNING 蓝、EXECUTING 绿、IDLE 紫、SUGGESTION 琥珀、ERROR 红、PRIVATE 灰；26px 低感知与 96px 主动尺寸均使用 SPEC 的七层 anatomy。颜色之外必须有固定文本、形态/图标和可见状态说明。

`recoveryMode` 与 `observationMode` 正交：PRIVATE 优先保留灰色锁 Orb；RECOVERY_ONLY/CLEAR_ONLY/blocked/read-only 通过持久安全横幅、子状态和可访问 RecoverySurface 表达，不新增第七 Orb。EXECUTING 文案必须明确“正在本地导入/重放/生成导出”，不得暗示真实环境操作。

### 10.4 响应式与交互
- 1280px：主内容 + Inbox/Orb 辅助区；768px：两列；360px/320 CSS px reflow：单列，顺序保持，不允许双轴滚动或关键 CTA 被 Orb 遮挡。
- Today 必须有可见按钮/menu；双击和长按仅作增强，不能是唯一路径。
- Orb 指针拖拽必须有“移动球体”键盘模式、取消、重置和 viewport safe-area clamp；位置偏好仅为无敏感粗粒度 UI preference。
- 每个 UI intent 只生成一个 commandId/idempotency key；pending 时锁定重复提交，response loss 回读原 receipt。

### 10.5 隐私与无障碍
Orb/button accessible name 只使用固定状态与可见标签；粗粒度来源仅进入批准 description。仍 live 且 allowlisted 的 local-sensitive statement/reason 只可在当前可见正文语义节点或表单控件最小展示，并提供等价 a11y text；不得进入 name/description/title/data-*、hidden/live region、日志或发布 artifact。restricted/prohibited/deleted 原值在全部 DOM/a11y/sink 必须为 0。

所有主流程必须支持键盘、读屏、200% zoom、320px reflow、text spacing、forced-colors 和 reduced-motion。RecoverySurface 提供原生按钮、状态/警报、确定焦点与返回规则；拖拽有键盘等价；menu/popover/dialog 遵循对应焦点模式。ERROR/blocked 必须明确“尚未保存/尚未清除/仍在恢复”，不能先显示成功。
---
## 11. 成功指标与验收
### 11.1 `[INV]` 工程不变量
- 100% `WorkModelClaim` 有完整可解析 evidence。
- 相同输入与版本组合产生相同 canonical output hash。
- 同 scope 的 edit 在下一次 Replay 被吸收。
- reject 不得静默重提，delete 不得复活。
- 未列入 allowlist 的持久化字段数为 0。
- Raw Screenshot At Rest = 0 bytes。
- 从 ActionPort/ShadowPreview 调用图可达的未授权 external network、process、OS filesystem 和 input injection 次数均为 0；canonical IndexedDB、同源静态资源与用户显式 export 不计为 Action 副作用，且 Shadow 调用 export 次数为 0。
- provenance lineage 无断链、无环、无跨用户引用。
- evaluator 以最终领域状态断言结果。
### 11.2 `[PH]` 待 pilot 验证的产品假设
- 从卡片首次可操作到 correction committed 的总时间目标 ≤30 秒，并分报理解/编辑/确认时间与放弃率。
- clean fixture 的 Episode-F1 ≥ 0.95。
- 扰动集的 Episode-F1 ≥ 0.85。
- 相邻 context 的 Correction Absorption ≥ 0.80。
- M2 真实概率场景的 Correction Locality ≥ 0.99；M1 确定性 fixture 必须为 1.00 `[INV]`。
- 存在阈值使 Selective Risk ≤ 0.05 且 Coverage ≥ 0.50。
- 净步骤节省中位数 > 0。
- 用户理解 Orb 是状态控制，而非持续监视。
这些阈值不是行业事实，也不是未经 pilot 即可宣称达成的价值证明。
### 11.3 `[STAT]` 观察性指标
- accept/edit/reject/delete 分布；
- Insight 忽略率和关闭率；
- 单次审阅与纠正耗时；
- 日报被打开、复制或再次查看的比例；
- Question 跳过率；
- PRIVATE 使用频率；
- 每日净价值：节省时间减去审阅、纠正和错误恢复时间。
Acceptance rate 只能描述行为，不能替代用户价值。
### 11.4 M1 完成定义
M1a Core/Oracle、M1b Persistence/Delete/Worker/Projection、M1c UI/A11y/Visual 是内部 checkpoint；任一失败只能标内部 FAIL/NOT_RUN，三者全部通过才可宣称 Gate 1。
- 可导入 fixture；
- 可生成 Episode、日报和 Insight；
- 可完成 accept/edit/reject/restore，以及隐私优先的 delete 协议；
- Replay 可体现 revision；
- 六态/七层 Orb 忠实于批准视觉合同；PRIVATE/RecoverySurface/Empty/Stale 组合、MoveOrb键盘路径和 accessibility-tree 隐私门禁通过；
- 320px/200% reflow、forced-colors、全局 reduced-motion、键盘/focus/live、结构/visual/a11y evidence 通过；
- fake-indexeddb contract/fault injection 与真实 Chromium 的 transaction、crash、quota、多标签/恢复通过；Preview/head/Replay/Worker/Projection contract suites 通过；
- fixture/gold/evaluator artifact 独立，全部测试/构建实际运行且无 skip/空 suite；
- 不变量全部满足。
---
## 12. 风险与缓解
### 风险 1：Synthetic 自洽陷阱
系统可能只复现 fixture 设计者预设的世界。
**缓解**：M1 只作工程门禁；M2 必须使用用户自选只读真实源和独立真值。
### 风险 2：纠正成本超过收益
复杂证据和版本界面可能把用户变成数据管理员。
**缓解**：单击操作、局部编辑、一次只突出一个高价值问题，并测量净价值。
### 风险 3：Provenance 制造虚假信任
“有证据”不代表推断正确。
**缓解**：展示 observed/inferred/confirmed、反证、范围和置信度；加入错误推断可发现性测试。
### 风险 4：结构化事件泄露隐私
标题、路径、URL 和时间序列仍可推断敏感信息。
**缓解**：字段白名单、写前脱敏、短期保留、来源预览和级联删除。
### 风险 5：Shadow 被误解为已执行
用户可能将绿色状态或“执行”文案理解为真实操作。
**缓解**：明确标注“本地处理/Replay/Shadow Preview”，禁止成功暗示和真实副作用。
### 风险 6：范围再次膨胀
桌面壳、Runtime、CLI、MCP、Obsidian 和自动化同时进入关键路径会导致失败不可归因。
**缓解**：严格按 M1→M2→M3→M4→M5 设阶段门，未满足上一阶段指标不得扩面。
---
## 13. 开放问题
1. 哪个窄真实只读事件源最适合 M2 pilot？
2. 用户更愿意纠正日报段落还是原子规则卡？
3. confidence 如何表达才能避免虚假精确感？
4. 白名单事件是否足以产生可用日报，无需正文或截图？
5. 用户愿意纠正工作模型多久，何时产生疲劳？
6. Orb 的建议冷却时间和打扰阈值应如何实测？
7. 长期数据增长后，canonical store 与 Markdown 投影如何保持边界？
8. 何种证据足以让 rejected claim 在新情境下重新进入候选？
9. 如何独立验证纠正吸收不是只改展示文本？
10. Shadow-only 产品在哪个使用频率下能形成持续价值？
---
## 14. 发布与决策门
- M1 发布语义：Web 工程研究原型，不宣传真实用户价值。
- M2 发布语义：窄只读 pilot，不宣传自动化执行能力。
- M3 决策门：真实 pilot 显示净价值为正、隐私不变量持续满足，才考虑 Runtime + projection。
- M4 决策门：知识版本、Replay 和跨投影一致性稳定后，只决定是否另立真实动作 PRD；不实施 live action。
- M5：在前置门满足后评估 Tauri + 窄 Windows UIA。
- 任何真实执行探索：必须移出本 PRD，重新评审权限、幂等、前后置条件、补偿和隔离 evaluator。
ProAGI Assistant 的长期方向仍是把个人 Experience、Knowledge、Skills、Workflows、Policies 与 Evaluations 沉淀为用户可拥有、可迁移的 Personal Agent Experience Graph。
但当前唯一承诺是：
> 先把“白名单事件 → 可纠正 Insight → 版本 → Replay”做对，并始终保持 Shadow-only。
