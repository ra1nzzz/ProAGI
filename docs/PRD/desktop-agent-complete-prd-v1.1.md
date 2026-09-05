# 智图灵助理 / ProAGI Assistant 完整 PRD

**文档名称**：智图灵助理（ProAGI Assistant）— Persistent Self-Evolving Personal Agent
**英文品牌**：ProAGI
**文档版本**：PRD v1.1
**文档状态**：可进入架构设计 / Prototype
**产品形态**：桌面常驻 Agent + 智图灵球体 + CLI + MCP Server + Local Knowledge Base
**默认 Agent Runtime**：Codex CLI / Codex App Server
**核心原则**：Runtime 可替换、模型可替换、知识与技能与 Runtime 解耦、本地优先、默认不打扰、所有能力增长必须可验证、可回滚。

---

# 0. 本版 PRD 的核心结论

这不是一个“带悬浮球的 AI 助手”，也不是一个“自动录屏 + RAG”的产品。

它应该被定义为：

> **智图灵助理（ProAGI Assistant）是一个持续存在于用户数字工作环境中的 Personal Agent OS：观察用户如何工作，形成对用户工作世界的动态模型；发现自动化机会；通过苏格拉底式交互主动补齐认知缺口；将经验沉淀为知识、技能和工作流；在真实任务中验证和迭代这些能力；最终让 Agent 随着用户使用而获得越来越强的个体化执行能力。**

产品真正的闭环不是：

`观察 → 总结`

而是：

`观察 → 建模 → 发现缺口 → 主动询问 → 学习 → 提案 → 验证 → 生长技能 → 执行 → 获得反馈 → 评估 → 演化 → 再观察`

因此，“自进化”必须被拆成多个层级：

1. **记忆进化**：越来越了解用户。
2. **知识进化**：越来越理解用户所在的工作领域。
3. **技能进化**：已有技能越来越可靠。
4. **工作流进化**：多个技能越来越能够组合成稳定流程。
5. **策略进化**：学会选择什么时候观察、什么时候询问、什么时候自动化、什么时候交给 Runtime。
6. **Agent 系统进化**：仅在有充分验证与隔离的条件下，允许修改自身的 Prompt、规划器、工具编排器等系统组件。
7. **模型权重训练**：不属于 MVP，也不应该作为产品第一阶段的主要“自训练”路径。

研究领域对 self-evolving agents 的划分也越来越强调“进化对象、时机、机制和评估”的区别，因此本产品不再把“写入记忆”直接包装成模型训练。citeturn917862academia26turn917862academia27

---

# 1. 产品背景

## 1.1 用户正在经历的现实问题

今天的 Agent 大多数是“用户主动提出任务 → Agent 执行任务”。

这个模式存在一个天然限制：

> Agent 只有在用户把问题说出来以后，才能开始帮助用户。

然而大量工作并不是以“我要做一个任务”的形式发生的，而是以连续、碎片化、跨应用的行为发生：

- 打开浏览器搜索数据；
- 复制数据到 Excel；
- 清洗数据；
- 进入后台系统；
- 调整格式；
- 写一封邮件；
- 复制邮件内容到另一处；
- 打开终端执行脚本；
- 修复报错；
- 重新运行；
- 把结果写进周报；
- 最后再把周报发给别人。

用户自己往往并不会把这些行为显式描述成“工作流”。

于是产生一个巨大的空白：

> **用户实际上已经拥有大量隐形工作流，只是没有被机器识别为工作流。**

本产品的使命，就是把这些“隐形能力”显性化，并逐渐变成 Agent 可以理解、调用、复用和执行的能力。

---

# 2. 产品愿景

## 2.1 愿景

> **让每个人拥有一个会越用越懂自己、越用越能替自己工作的个人 Agent。**

未来的个人 Agent 不应该只是一个聊天窗口，而应该像一个长期工作的数字学徒：

- 它知道你经常做什么；
- 知道你习惯怎么做；
- 知道哪些事情你不想自动化；
- 知道自己还不知道什么；
- 会主动询问；
- 会把重复劳动变成工具；
- 会把多个工具组成工作流；
- 会观察工作流失败；
- 会修复自己的技能；
- 会把学习结果记录为个人知识资产；
- 即使换 Agent Runtime，长期积累仍然属于你。

---

# 3. 产品定位

## 3.1 一句话定位

**持续观察、持续学习、持续生长的个人桌面 Agent OS。**

## 3.2 四种身份

产品同时具备四种身份：

### A. Observer

持续观察用户的数字行为，但采用“事件优先、语义压缩、数据最小化”的方式，不默认持续保存高敏感原始内容。

### B. Learner

通过行为、反馈、用户回答、执行结果不断更新用户知识模型。

### C. Builder

自动把成熟模式生长成 Skill、Tool、Workflow、Prompt、Playbook。

### D. Agent Gateway

可以被任何其他 Agent 调用。

例如：

```text
Codex
Claude Code
Gemini CLI
OpenCode
Hermes
OpenClaw
自研 Agent
        │
        ├── query knowledge
        ├── get user preferences
        ├── submit goal
        ├── invoke skill
        ├── receive result
        └── provide feedback
                 │
                 ▼
         Desktop Agent
```

---

# 4. 产品核心原则

## 4.1 Ambient First

默认存在，但默认不打扰。

## 4.2 Local Ownership

用户的记忆、知识、技能、执行历史原则上归用户本地资产所有。

## 4.3 Runtime Agnostic

Codex 只是默认 Runtime，不是产品本体。

## 4.4 Model Agnostic

桌面 Agent 不应假设某个固定模型，也不直接依赖某个模型厂商 API。

## 4.5 Evidence Before Automation

观察到一次行为，不等于理解了一个流程。

任何自动化建议必须建立在足够证据之上。

## 4.6 Verification Before Activation

任何新生长能力默认进入验证状态，不允许“LLM 写完代码 = 新技能上线”。

## 4.7 Reversible by Default

任何自动化能力都必须可禁用、版本化、回滚。

## 4.8 User Is Teacher, Not Operator

用户只负责纠正关键认知，不应该被迫手工配置大量 RPA 流程。

## 4.9 Learning Must Reduce Friction

Agent 的学习成本不能转嫁成“每天填几十个表单”。

## 4.10 Capability Must Compound

系统每一天产生的知识和技能，都应该增强下一天的理解能力。

---

# 5. 与原方案相比必须修正的关键问题

## 5.1 “自训练”定义过于宽泛

原方案容易把：

`Memory Update = Training`

实际上应该定义为：

```text
Memory Update
    ↓
Knowledge Update
    ↓
Skill / Workflow Update
    ↓
Policy Update
    ↓
Agent Architecture Update
    ↓
Model Fine-tuning（远期）
```

前四层完全可以构成真实的个人 Agent 自进化。

MVP 不应该一开始做 LoRA / Fine-tuning，否则会把一个优秀的 Agent 产品拖成模型训练工程。

---

## 5.2 “持续观察”不是持续截图

必须从“Screen Recorder 思维”转变成“Digital Event Sensing 思维”。

第一优先级：

- Window/App event
- Accessibility tree
- Browser DOM / accessibility metadata
- Clipboard event
- File system event
- Terminal / shell event（显式授权）
- Application-specific semantic adapters

第二优先级：

- OCR
- Screenshot
- VLM

第三优先级：

- Computer Use

也就是说：

> **截图应该是补充感知手段，而不是感知系统的主干。**

---

## 5.3 缺少“任务边界识别”

单纯记录“用户做了什么”没有意义。

系统必须回答：

> 用户什么时候开始做一个任务？什么时候结束？中间哪些行为属于同一个任务？

因此需要引入：

**Activity → Episode → Task → Workflow → Skill**

五层抽象。

---

## 5.4 自动化提议不能只看频率

重复三次，不代表值得自动化。

要综合考虑：

- 频率
- 时间成本
- 稳定性
- 认知负担
- 错误概率
- 自动化风险
- 用户痛点
- 自动化后收益
- API 可替代程度
- GUI 脆弱程度
- 是否会产生不可逆副作用

---

## 5.5 缺少 Shadow Mode

自动化系统必须有一个极其重要的中间阶段：

> **Agent 自动执行，但只观察“如果我执行，会发生什么”，不真正改变用户环境。**

也就是：

```text
Candidate Skill
      ↓
Sandbox
      ↓
Replay
      ↓
Dry Run
      ↓
Shadow Mode
      ↓
Human Approved
      ↓
Limited Live
      ↓
Trusted Live
```

这会极大降低风险。

---

## 5.6 缺少“能力可信度”模型

Agent 必须知道：

- 我是否理解这个任务？
- 我做过几次？
- 成功率是多少？
- 最近是否退化？
- 当前环境是否变化？
- 这项技能是否可靠到可以自动执行？

因此每个 Skill 都必须有动态 Confidence / Reliability Score。

---

## 5.7 Obsidian 不应该成为唯一 Source of Truth

Obsidian 是用户可见的知识资产层和长期人机协作层，但不应该直接承担所有运行态数据。

建议：

```text
Canonical Runtime Store
        │
        ├── SQLite/Event Store
        ├── Skill Registry
        ├── Vector / Semantic Index
        └── Execution History
                 │
                 ▼
        Obsidian Projection
        Markdown + YAML
        + Wikilinks
```

Obsidian 作为“可读、可编辑、可迁移的知识投影层”。

Obsidian 当前原生支持 YAML Properties、内部链接和多种 Markdown 扩展，适合作为这一层，但产品内部需要自己维护更严格的数据血缘、版本和冲突处理机制。citeturn808657view0turn808657view1

---

# 6. 用户画像与典型场景

## 6.1 第一目标用户

### Persona A：重度 AI / Coding 用户

特点：

- 长时间使用 IDE、Terminal、Git、Browser、Agent
- 已经使用 Codex / Claude Code / Gemini CLI 等
- 不排斥自动化
- 有大量重复工作
- 可以接受 Agent 运行在后台

这类用户最适合成为第一批核心用户。

### Persona B：知识工作者

例如：

- 产品经理
- 电商运营
- 数据分析师
- 设计师
- 咨询顾问
- 管理者

### Persona C：专业工作流用户

拥有强固定 SOP，例如：

- 财务
- 客服
- 内容生产
- 销售
- 项目管理

---

# 7. 核心用户旅程

## 7.1 Day 0：安装

用户安装后：

1. 启动桌面 Agent。
2. 悬浮球出现。
3. Agent 告知：正在学习，但默认不执行高风险操作。
4. 引导配置观察范围。
5. 选择隐私黑名单应用。
6. 选择知识库目录。
7. 检查 Runtime。
8. 默认发现 Codex CLI。
9. 用户确认。

不要求：

- 先创建大量配置文件；
- 先写 Prompt；
- 先手工录制流程。

---

# 8. 产品核心闭环

```text
                 ┌───────────────────────┐
                 │      用户数字行为      │
                 └───────────┬───────────┘
                             ↓
                    ┌────────────────┐
                    │  Perception    │
                    │    感知层       │
                    └───────┬────────┘
                            ↓
                    ┌────────────────┐
                    │  Activity      │
                    │  Segmentation  │
                    │  活动分段        │
                    └───────┬────────┘
                            ↓
                    ┌────────────────┐
                    │  Cognition     │
                    │  认知建模        │
                    └───────┬────────┘
                            ↓
             ┌──────────────┴──────────────┐
             ↓                             ↓
      高置信度理解                     低置信度理解
             ↓                             ↓
      Knowledge Update              Socratic Question
             │                             ↓
             │                       User Feedback
             │                             ↓
             └──────────────┬──────────────┘
                            ↓
                    ┌────────────────┐
                    │ Opportunity    │
                    │ Discovery      │
                    └───────┬────────┘
                            ↓
                    ┌────────────────┐
                    │ Skill Builder  │
                    │ Workflow Build │
                    └───────┬────────┘
                            ↓
                    ┌────────────────┐
                    │ Verification   │
                    │ Replay/Shadow  │
                    └───────┬────────┘
                            ↓
                    ┌────────────────┐
                    │ Skill Registry │
                    └───────┬────────┘
                            ↓
                    ┌────────────────┐
                    │ Execution      │
                    └───────┬────────┘
                            ↓
                    ┌────────────────┐
                    │ Feedback       │
                    │ Evaluation     │
                    └───────┬────────┘
                            ↓
                       Skill Evolves
                            ↓
                         回到观察
```

---

# 9. 系统总体架构

```text
┌─────────────────────────────────────────────────────────────────┐
│                      Desktop Agent OS                           │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  Ambient Interface                        │  │
│  │   Floating Orb / Command Palette / Daily Report / UI     │  │
│  └────────────────────────────┬──────────────────────────────┘  │
│                               │                                 │
│  ┌────────────────────────────▼──────────────────────────────┐  │
│  │                    Agent Kernel                           │  │
│  │                                                          │  │
│  │ Goal Manager                                             │  │
│  │ Cognition Engine                                         │  │
│  │ Learning Loop                                             │  │
│  │ Opportunity Engine                                       │  │
│  │ Skill/Workflow Engine                                    │  │
│  │ Policy / Permission Engine                               │  │
│  └────────────────────────────┬─────────────────────────────┘  │
│                               │                                 │
│  ┌────────────────────────────▼─────────────────────────────┐  │
│  │                     Perception Bus                       │  │
│  │                                                          │  │
│  │ OS Event │ A11y │ Browser │ Clipboard │ Files │ OCR/VLM │ │
│  └────────────────────────────┬─────────────────────────────┘  │
│                               │                                 │
│  ┌────────────────────────────▼─────────────────────────────┐  │
│  │                     Memory Layer                         │  │
│  │                                                          │  │
│  │ Episodic │ Semantic │ Procedural │ User Profile │ Trace ││  │
│  └────────────────────────────┬─────────────────────────────┘  │
│                               │                                 │
│  ┌────────────────────────────▼─────────────────────────────┐  │
│  │                 Canonical Data Store                     │  │
│  │ SQLite + Event Store + Skill Registry + Artifact Store   │  │
│  └────────────────────────────┬─────────────────────────────┘  │
│                               │                                 │
│                  ┌────────────┴─────────────┐                   │
│                  │                          │                   │
│                  ▼                          ▼                   │
│        Obsidian Projection          CLI / MCP Gateway           │
│                  │                          │                   │
│                  │                          │                   │
└──────────────────┼──────────────────────────┼───────────────────┘
                   │                          │
                   │                    External Agents
                   │                    Codex / Claude / Gemini
                   │                          │
                   ▼                          ▼
             User Knowledge             Goal / Skill API
                   
                   
             Runtime Adapter Layer
                   │
        ┌──────────┼───────────┐
        ▼          ▼           ▼
     Codex       Claude      Generic CLI
    App Server     CLI        / ACP
```

---

# 9.5 产品命名

## 9.5.1 中文名称

**智图灵助理**。

“智”强调智能与认知；“图”强调观察、建模、映射用户数字工作世界；“灵”强调常驻、感知、响应与成长。“智图灵球体”是产品的环境态入口与核心视觉符号。

## 9.5.2 英文名称

推荐采用：

> **ProAGI Assistant**

品牌简称：**ProAGI**

选择理由：

1. 比 **Prospects-AGIBot** 更简洁，不把产品局限在“客户/商业线索”场景，也避免 Bot 的产品形态认知。
2. 比 **ProAGIAgent** 更自然，避免“AGI + Agent”的语义重复。
3. Pro 可以解释为 Professional / Proactive，AGI 对应产品长期愿景，Assistant 负责降低用户理解门槛。
4. 中文品牌与英文品牌可以独立成立：中文侧强调“智图灵”，英文侧强调“ProAGI”。

## 9.5.3 产品命名体系

| 中文 | 英文 | 定位 |
|---|---|---|
| 智图灵助理 | ProAGI Assistant | 完整产品名 |
| 智图灵 | ProAGI | 品牌简称 |
| 智图灵球体 | ProAGI Orb | 桌面环境态入口 |
| 智图灵引擎 | ProAGI Engine | 感知、认知、进化内核 |
| 智图灵 CLI | ProAGI CLI | Agent / 用户命令入口 |
| 智图灵知识库 | ProAGI Knowledge | 用户长期知识资产 |
| 智图灵技能 | ProAGI Skill | 可执行能力单元 |

---

# 9.6 智图灵球体：核心交互器官

智图灵球体不是装饰性的悬浮图标，而是产品的 **Ambient Agent Interface（环境态 Agent 接口）**。

它同时承担四项职责：

- **状态显示**：用户无需打开主界面，即可知道 Agent 当前在观察、执行、待命、提醒还是发生异常。
- **轻量交互**：点击、长按、拖拽和可配置手势。
- **意图捕捉**：结合鼠标指针轨迹、停留位置、可访问性树、窗口上下文和内容语义推断用户当前意图。
- **主动协助**：在待命状态下，根据已知经验与知识库，在不打断工作的情况下提供上下文建议。

## 9.6.1 六态状态机（最多六种）

| 状态 | 英文 ID | 主视觉语义 | 典型动画 | 用户理解 |
|---|---|---|---|---|
| **感知学习中** | `LEARNING` | 蓝色 | 液体缓慢流动、轻微呼吸 | 正在观察并学习，不主动干预 |
| **任务执行中** | `EXECUTING` | 绿色 | 内部流体沿环路流动、进度轨迹 | 正在执行 Goal / Skill / Workflow |
| **待命** | `IDLE` | 紫色 | 极慢呼吸、低频微光 | 已就绪，等待用户动作或目标 |
| **建议可用** | `SUGGESTION` | 金色/琥珀 | 轻微向鼠标方向吸附、脉冲 | 检测到可执行的上下文建议 |
| **错误 / 异常** | `ERROR` | 红色 | 非连续闪烁、流体扰动 | 任务失败、能力不可用或需要处理 |
| **隐私保护中** | `PRIVATE` | 灰白色 | 流体冻结、低亮度 | 已暂停感知/观察 |

设计要求：**颜色绝不能成为唯一状态编码**，必须同时结合形态、动画、tooltip、可访问标签。

状态转换的原则是“由系统驱动、由用户可感知、由操作可追溯”：

```text
PRIVATE <-> IDLE
IDLE -> LEARNING
LEARNING -> IDLE
IDLE -> SUGGESTION
SUGGESTION -> IDLE / EXECUTING
IDLE / LEARNING -> EXECUTING
EXECUTING -> IDLE / ERROR
ERROR -> IDLE
```

## 9.6.2 两档尺寸模式

### A. 低感知模式（Low Attention）

用于长时间驻留。目标是让球体成为“环境中的存在”，而不是持续争夺注意力。

- 直径：**24–32 px**
- 透明度：约 60–80%
- 低频呼吸，不使用大幅位移
- 默认贴靠屏幕边缘 / 用户设置位置
- 感知学习中仅以细微液体流动表达状态
- 不主动弹出完整面板

### B. 主动悬浮模式（Active Orb）

当鼠标主动靠近、用户点击、长按、拖动球体时，球体进入交互增强模式。

- 直径：**80–120 px**，支持用户设置
- 液体流动 + 呼吸 + 内部粒子
- 鼠标接近时产生轻微磁吸 / 视线跟随效果
- 点击、长按、拖动可进入不同交互层
- 交互结束后经过短暂冷却自动缩回低感知模式

核心视觉隐喻：

> **平时是一滴安静的“灵”，需要它时，它才变成可操作的“球”。**

## 9.6.3 感知学习中的鼠标轨迹捕捉

感知学习时，不再只记录“窗口变了什么”，还需要建立 **Pointer + UI Context** 联合轨迹。

### 采集内容

默认记录：

- 鼠标位置 `(x, y)`；
- 时间戳；
- 速度、方向、停留时长；
- 点击 / 双击 / 按下 / 松开等事件类型；
- 当前 App / Window；
- 鼠标附近可访问性树元素；
- 元素 role、name、bounds、state；
- 页面 / 文档 / URL 等上下文。

默认**不记录键盘具体字符内容**。鼠标轨迹用于推断操作语义，不用于记录用户具体输入内容。

### 轨迹与无障碍树联合解释

```text
Pointer Move
      ↓
坐标归一化
      ↓
寻找指针附近 A11y Node / DOM Node
      ↓
候选元素排序
      ↓
结合停留 + 点击 + Window Context
      ↓
形成 Pointer Episode
      ↓
语义理解 / 工作流抽取
```

### 指针终点语义读取

当用户的鼠标移动出现“明显终点”时，系统可以对终点进行更高质量读取：

**终点定义**可综合：

- 速度从高到低快速衰减；
- 100–300ms 以上停留；
- 点击后停留；
- 指针落在可交互元素 bounds 内；
- 窗口上下文在短时间内稳定。

系统优先读取：

1. Accessibility Tree 元素；
2. DOM / 原生控件语义；
3. OCR 文本；
4. 必要时才调用视觉模型。

原则：

> **优先读取指针指向的结构化元素，而不是重新理解整个屏幕。**

## 9.6.4 半透明读取选中框

当系统正在进行“终点读取”或高成本内容理解时，应在对应位置显示轻量半透明选中框。

选中框表达：

- 当前读取目标；
- 元素边界；
- 数据来源：A11y / DOM / OCR / Vision；
- 读取状态：识别中 / 已识别 / 未确定。

视觉要求：

- 线框式，不遮挡内容；
- 半透明；
- 与球体的状态颜色保持同一视觉体系；
- 默认 300–800ms 内完成显示 / 消失，避免形成“高亮骚扰”；
- 可在设置中关闭。

## 9.6.5 待命状态的鼠标手势建议

待命并不意味着“什么都不做”。当用户把鼠标移动到某个区域并出现快速上下移动，Agent 可以把这种动作解释为 **“我可能在寻找/犹豫/不知道下一步怎么做”** 的弱意图信号。

### 默认触发手势

```text
同一区域内
快速向上 → 向下 → 向上（2–3 次）
且在约 0.8–1.5 秒内完成
          ↓
检测到 Pointer Agitation
          ↓
查询经验 + 当前上下文 + 知识库
          ↓
生成 1–3 条候选建议
```

仅当以下条件同时满足才触发：

- 当前状态 = `IDLE`；
- 鼠标处于相对稳定的区域；
- 轨迹不是自然拖拽 / 滚动；
- 同一区域内方向反转达到阈值；
- 最近若干秒没有刚刚关闭的建议。

### 建议浮窗

建议内容优先来自：

1. 已验证 Skill；
2. 当前工作流的下一步；
3. 历史上用户在相同场景最常执行的操作；
4. 相关知识库；
5. 最后才是 LLM 临时推断。

示例：

```text
┌──────────────────────────────┐
│ ✦ 我猜你可能想继续做：        │
│                              │
│ ① 导出当前数据为 Excel        │
│ ② 套用“月报清洗”技能          │
│ ③ 查询这个字段的历史处理方法   │
│                              │
│      [执行] [忽略] [更多]      │
└──────────────────────────────┘
```

### 顺时针 / 逆时针作为备用手势

用户可以在设置中启用：

- 顺时针小范围画圈 → 建议下一步；
- 逆时针小范围画圈 → 查看更多建议 / 撤回；
- 或将两种手势映射为用户自定义动作。

手势设置必须允许：

- 开 / 关；
- 灵敏度；
- 冷却时间；
- 自定义动作映射。

默认关闭高误触风险手势，仅启用待命状态下的“快速上下移动”。

## 9.6.6 球体交互优先级

```text
鼠标接近
   ↓
低感知球体轻微放大
   ↓
点击
   ↓
进入主动悬浮模式
   ↓
状态 / 建议 / Goal / 控制面板
```

交互原则：

- 不因普通鼠标移动而频繁放大；
- 只有靠近球体、点击、长按或明确手势才进入主动状态；
- 建议浮窗必须有明确“关闭 / 忽略”；
- 建议不应自动执行，除非对应 Skill 已被用户授权为低风险自动执行。

---

# 10. 模块定义

# 10.1 Ambient Interface

悬浮球不是产品主界面，而是“环境态接口”。

它只负责：

- 状态；
- 注意力提示；
- 快速反馈；
- 轻交互；
- 打开完整界面。

完整界面应包括：

- Today
- Timeline
- Knowledge
- Skills
- Goals
- Automations
- Questions
- Runtime
- Privacy
- Settings

---

# 10.2 Perception Engine

## 10.2.1 感知优先级

### Level 0：系统事件

- App open/close
- Window focus
- Document change
- File created/modified
- Process state
- Browser tab changes

### Level 1：语义结构

- Accessibility Tree
- DOM
- Application metadata
- UI element state
- Clipboard changes
- Terminal command metadata

### Level 2：内容抽取

- OCR
- Document parser
- local vision model
- local speech transcription（可选）

### Level 3：视觉理解

- Screenshot
- VLM
- Computer Use

原则：越高层越贵、越敏感，所以默认越少使用。

---

## 10.2.2 Perception Event

统一内部事件：

```rust
/// PointerContext 是 PerceptionEvent 的可选扩展，记录鼠标轨迹与终点语义。
pub struct PointerContext {
    pub x: f32,
    pub y: f32,
    pub velocity: f32,
    pub direction: f32,
    pub dwell_ms: u32,
    pub target_node_id: Option<String>,
    pub target_bounds: Option<Rect>,
    pub target_source: Option<String>, // a11y | dom | ocr | vision
}

pub struct PerceptionEvent {
    pub id: EventId,
    pub timestamp: DateTime<Utc>,
    pub source: EventSource,
    pub app: AppIdentity,
    pub window: Option<WindowIdentity>,
    pub action: ActionKind,
    pub semantic_payload: Option<Value>,
    pub sensitivity: SensitivityLevel,
    pub confidence: f32,
    pub provenance: Provenance,
}
```

重要：

**所有记录必须携带 provenance。**

Agent 必须知道：

> “这是用户明确告诉我的，还是我猜的？”

---

# 10.3 Activity Segmentation

## 10.3.1 五层行为抽象

```text
Raw Event
   ↓
Activity
   ↓
Episode
   ↓
Task
   ↓
Workflow
```

### Activity

例如：浏览网页。

### Episode

一段连续工作：

> 13:20–14:05 调研某个产品。

### Task

明确目标：

> 收集 20 个竞品价格。

### Workflow

稳定执行顺序：

> 打开平台 → 搜索 → 导出 → 清洗 → 写入表格。

---

# 10.4 Cognition Engine

Cognition Engine 不直接控制 Runtime，而负责构建用户世界模型。

核心输出：

1. 当前任务推断；
2. 用户意图；
3. 工作类型；
4. 用户偏好；
5. 工作规则；
6. 未知；
7. 冲突认知；
8. 自动化候选。

---

# 10.5 User World Model

建议构建四类长期模型。

## User Model

“用户是谁、做什么、喜欢什么”。

## Work Model

“用户的工作由哪些领域组成”。

## Workflow Model

“用户通常如何完成任务”。

## Agent Model

“Agent 自己已经学会什么、不会什么、哪些能力可靠”。

因此最终系统不是简单的 User Profile，而是：

```text
                User World Model
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
    User Model      Work Model      Agent Model
                       │
                       ▼
                 Workflow Model
```

---

# 10.6 Automation Opportunity Engine

## 10.6.1 自动化机会评分

建议使用：

```text
Opportunity Score =
    Frequency × TimeSaved × Repeatability
    × Confidence × UserPain
    × APIAvailability
    - Risk
    - MaintenanceCost
```

不是所有变量都必须精确计算，第一阶段可以采用 0–1 或 0–5 评分。

## 10.6.2 候选等级

### L0
仅记录，不建议自动化。

### L1
建议生成 Prompt / Template。

### L2
建议生成辅助 Skill。

### L3
建议生成半自动 Workflow。

### L4
建议完全自动化。

### L5
可作为 Trigger 自动运行。

---

# 10.7 Socratic Learning Engine

## 10.7.1 核心定位

苏格拉底提问不是 Chat，而是：

> **主动寻找能最大化信息增益的问题。**

目标不是“多问用户”，而是“少问关键问题”。

---

## 10.7.2 认知缺口类型

- Intent Gap
- Domain Gap
- Workflow Gap
- Preference Gap
- Decision Gap
- Context Gap
- Causal Gap
- Tool Gap
- Error Gap

---

## 10.7.3 Question Value

一个问题只有在以下条件较高时才值得问：

```text
Question Value =
Information Gain
× Affected Workflows
× Automation Potential
× Confidence Impact
÷ User Effort
```

---

## 10.7.4 提问策略

每日推荐：

- 3–8 个核心问题；
- 最大不超过 15 个；
- 同类问题进入冷却；
- 用户可全部跳过；
- 高风险问题不得强迫回答；
- 连续跳过后自动降低优先级。

---

## 10.7.5 用户回答之后

回答不直接作为“事实”写入。

必须经过：

```text
User Answer
   ↓
Interpretation
   ↓
Conflict Check
   ↓
Evidence Merge
   ↓
Confidence Update
   ↓
Knowledge Update
   ↓
Workflow Re-evaluation
```

用户明确说过的事实通常高权重，但仍需要处理时间变化。

例如：

> “我现在主要使用 Cursor。”

不能永久写成：

> 用户永远使用 Cursor。

应该携带 validity / temporal scope。

---

# 10.8 Daily Report

每日汇报不应该只是日志，而是：

> **用户与 Agent 的每日学习结算界面。**

结构：

```text
今日工作
────────────
工作类型分布
主要任务
主要进展

自动化成果
────────────
节省时间
成功执行
新技能

Agent 学到了什么
────────────
新增知识
更新偏好
更新工作流

Agent 不懂什么
────────────
苏格拉底问题

明天可以替你做什么
────────────
自动化候选

知识库变化
────────────
新增 / 修改 / 废弃
```

---

# 10.9 Knowledge Engine

## 10.9.1 知识分类

至少包括：

- 用户偏好
- 工作规则
- 领域知识
- 工作流程
- 工具知识
- 项目知识
- 决策记录
- 经验教训
- Skill
- Workflow
- Agent Reflection

---

## 10.9.2 Canonical Knowledge Record

```rust
pub struct KnowledgeItem {
    pub id: String,
    pub title: String,
    pub category: KnowledgeCategory,
    pub content: String,
    pub confidence: f32,
    pub evidence_refs: Vec<EvidenceRef>,
    pub source_type: SourceType,
    pub valid_from: Option<DateTime<Utc>>,
    pub valid_until: Option<DateTime<Utc>>,
    pub status: KnowledgeStatus,
    pub version: u32,
}
```

---

# 10.10 Obsidian Integration

## 10.10.1 定位

Obsidian 是：

- 可见知识资产；
- 用户编辑入口；
- 人机共同维护的长期记忆；
- 导出与迁移格式。

不是：

- 运行时数据库；
- 原始事件日志数据库；
- Skill 执行状态数据库。

---

## 10.10.2 建议目录

```text
DesktopAgentVault/
│
├── 00_Index/
├── 01_User/
├── 02_Work/
├── 03_Projects/
├── 04_Workflows/
├── 05_Skills/
├── 06_Tools/
├── 07_Learnings/
├── 08_Daily/
├── 09_Reports/
└── _AgentMeta/
```

---

## 10.10.3 Frontmatter

示例：

```yaml
---
type: knowledge
category: workflow
title: 周报生成流程
confidence: 0.92
source: observed+user_confirmed
status: active
version: 7
last_verified: 2026-09-04
agent_generated: true
---
```

Obsidian 当前将 Properties 存储于文档顶部的 YAML 区域，并支持文本、列表、数字、布尔、日期等类型，同时支持 `[[wikilinks]]` 等内部链接。citeturn808657view0turn808657view1

---

# 10.11 Knowledge Conflict Resolution

这是原方案中必须新增的核心模块。

可能出现：

```text
User says A
     ↓
Agent observes B
     ↓
Obsidian manually edited to C
```

因此必须建立：

- Evidence priority
- Recency
- User explicit override
- Confidence
- Conflict state

推荐优先级：

```text
Explicit User Instruction
        >
Manual User Edit
        >
Verified Execution Outcome
        >
Repeated Observation
        >
Single Observation
        >
LLM Inference
```

---

# 10.12 Skill Engine

## 10.12.1 Skill 定义

Skill 不只是脚本。

建议包含：

```text
Skill
├── Identity
├── Purpose
├── Trigger
├── Preconditions
├── Inputs
├── Outputs
├── Steps
├── Required Capabilities
├── Permissions
├── Dependencies
├── Evidence
├── Evaluation
├── Confidence
├── Cost
├── Risk
├── Version
├── Rollback
└── Owner
```

---

## 10.12.2 Skill Manifest

```yaml
name: weekly-report.collect
version: 0.8.0
kind: workflow
status: shadow

purpose: "收集过去一周项目进展并生成周报草稿"

triggers:
  - schedule: weekly

inputs:
  - project

outputs:
  - report_draft

capabilities:
  - browser.read
  - filesystem.read
  - document.write

permissions:
  network: read
  filesystem: workspace-only
  destructive_actions: false

verification:
  replay: true
  shadow_runs: 5
  min_success_rate: 0.95

runtime:
  preferred_capability: coding-agent
  fallback: any-compatible
```

---

# 10.13 Skill Lifecycle

```text
Observed
   ↓
Hypothesized
   ↓
Candidate
   ↓
Generated
   ↓
Sandboxed
   ↓
Replayed
   ↓
Shadow
   ↓
Approved
   ↓
Active
   ↓
Degraded
   ↓
Repaired
   ↓
Retired
```

### 核心原则

不能直接从 `Generated → Active`。

---

# 10.14 Skill Verification

## 10.14.1 四层验证

### Layer 1：Static Validation

检查：

- schema
- imports
- permissions
- file scope
- network scope

### Layer 2：Sandbox Validation

隔离执行。

### Layer 3：Replay Validation

使用用户过去的真实轨迹进行回放。

### Layer 4：Shadow Mode

在真实环境中执行计划，但不执行危险动作。

---

# 10.15 Personal Benchmark

这是整个系统最值得新增的核心能力之一。

OSWorld 等公开 benchmark 可以衡量通用 Computer Use 能力，但个人 Agent 真正需要解决的是：

> **“这个 Agent 对这个用户的具体工作到底可靠不可靠？”**

OSWorld 2.0 已在 2026 年发布，并继续强调真实桌面、多应用、长程任务的执行评估；这说明通用 Computer Use 仍需要严谨验证，而产品本身更应该建立用户自己的任务基准。citeturn917862search0turn917862search3

因此系统应该自动建立：

```text
Personal Benchmark
├── Task A
├── Task B
├── Task C
├── Workflow A
├── Workflow B
└── Skill C
```

每个 Skill 都有自己的历史表现：

```text
Success Rate
Average Steps
Average Time
Human Intervention
Error Rate
Regression Rate
```

---

# 10.16 Skill Evolution

Skill 每次运行后生成 Evaluation Record：

```rust
pub struct SkillRunEvaluation {
    pub skill_id: String,
    pub version: String,
    pub success: bool,
    pub duration_ms: u64,
    pub intervention_count: u32,
    pub expected_output_match: f32,
    pub user_correction: Option<String>,
    pub detected_regression: bool,
}
```

当发现退化：

```text
Failure
 ↓
Diagnosis
 ↓
Generate Hypothesis
 ↓
Generate Candidate vNext
 ↓
Replay
 ↓
Compare vCurrent / vNext
 ↓
Promote or Rollback
```

---

# 10.17 Evolution Engine

建议拆为三个 Agent Role，而不是单 Agent 自己审自己：

## Proposer

寻找改进方案。

## Critic

试图发现改进方案的问题。

## Verifier

通过实际测试决定是否应该合并。

可以由同一个 Runtime 的多个独立 Session 执行，也可以未来使用不同 Runtime 进行交叉评审。

DGM 的核心启发正是：把 Agent 改动作为候选变体进行探索，并以经验结果决定是否保留，而不是相信一次模型生成。citeturn917862academia28

---

# 10.18 Agent System Self-Evolution

只允许分级开放：

### Level 1
修改 Prompt。

### Level 2
修改 Skill。

### Level 3
修改 Workflow。

### Level 4
修改 Planner / Policy。

### Level 5
修改 Agent Runtime Adapter / Kernel。

Level 4 以上必须进入隔离环境和严格回归。

Level 5 默认关闭。

产品不应该允许一个正在运行的 Agent 随意改写自己正在执行的 Kernel。

这比直接采用“Gödel Machine 自我修改代码”更适合消费级产品。

---

# 11. Execution Engine

执行优先级：

```text
1. Native API
2. MCP Tool
3. CLI / Script
4. App-specific automation
5. Accessibility automation
6. Browser DOM automation
7. GUI Computer Use
```

核心原则：

> **能不用视觉，就不要用视觉；能不用 GUI，就不要用 GUI。**

---

# 12. Execution Policy

## 12.1 风险分级

### R0
纯读取。

例如：

- 读取网页
- 读取文件
- 查询知识

无需确认。

### R1
可逆写入。

例如：

- 创建草稿
- 新建 Markdown 文件

默认允许。

### R2
可能影响外部系统。

例如：

- 修改 GitHub issue
- 修改在线文档

需要用户策略授权。

### R3
不可逆或高风险操作。

例如：

- 删除文件
- 发送邮件
- 提交付款
- 发布内容

必须确认。

---

# 13. Runtime Abstraction

## 13.1 核心原则

Desktop Agent 不直接调用模型 API。

它只知道：

```text
Task
Context
Constraints
Capabilities
Result
Events
```

---

# 13.2 Runtime Adapter

```rust
pub trait RuntimeAdapter {
    fn capabilities(&self) -> RuntimeCapabilities;
    fn health_check(&self) -> RuntimeHealth;
    fn submit(&self, task: AgentTask) -> EventStream;
    fn cancel(&self, task_id: TaskId);
    fn respond_approval(&self, request_id: String, decision: ApprovalDecision);
}
```

---

# 13.3 Runtime Capability Model

产品不应该写死：

```text
“Claude 适合分析”
“Codex 适合代码”
```

而应该询问 Runtime：

```text
Capabilities:
- code_generation
- browser_use
- image_input
- file_write
- shell
- structured_output
- long_context
- approval
- resume
```

然后进行能力路由。

---

# 13.4 Codex First

第一适配器：

**Codex App Server Adapter**。

Codex 官方 app-server 当前提供基于 JSON-RPC 风格消息的双向协议，stdio 为 JSONL 传输方式，并支持 thread / turn / events / approvals / skills 等能力，适合作为第一 Runtime Adapter。citeturn237698search0

但是必须注意：

> Codex App Server 的协议与会话实现细节属于具体 Runtime 的实现，不应向产品 Kernel 泄漏。

---

# 13.5 ACP

未来接入 ACP 作为标准化 Agent Adapter。

ACP 当前 stable protocol version 为 1，并采用 JSON-RPC 风格通信、session、prompt、update 和权限等机制；协议仓库同时已经存在 v2 文档与演进中的能力，因此产品应该以 ACP Adapter 为“未来标准适配层”，而不是现在把整个内部对象模型直接绑在 ACP 上。citeturn590172search0turn590172search1turn590172search2

---

# 13.6 Runtime Router

```text
Task
 ↓
Capability Requirements
 ↓
Runtime Registry
 ↓
Health
 ↓
Cost
 ↓
Latency
 ↓
Policy
 ↓
Select Runtime
```

示例：

```yaml
route:
  requirements:
    - structured_output
    - code_generation
    - file_write

  preferences:
    reliability: high
    latency: medium
    cost: low

  fallback:
    - runtime: codex
    - runtime: claude
    - runtime: generic-acp
```

---

# 13.7 为什么不能把 Codex Session 当长期记忆

Runtime 是执行层，不应该成为产品唯一的记忆层。

原因包括：

- Runtime 可以切换；
- Runtime 可以升级；
- Runtime 会改变上下文管理；
- Session 格式可能变化；
- 日志体积可能非常大；
- 不应该把用户的核心知识锁在某个 Agent Harness 内。

现实中 Codex 社区目前已经出现长时间、图片密集型 session 导致 JSONL 体积巨大、内存 / swap 和性能问题的报告，因此本产品必须在自己的系统侧做事件抽取、摘要与生命周期管理，而不能把 Runtime 原始日志当永久数据库。citeturn237698search6turn237698search8

---

# 14. Goal System

Goal 是产品最高层级的统一任务对象。

```rust
pub struct Goal {
    pub id: GoalId,
    pub source: GoalSource,
    pub instruction: String,
    pub context: GoalContext,
    pub constraints: GoalConstraints,
    pub status: GoalStatus,
    pub plan: Option<Vec<GoalStep>>,
    pub feedback_log: Vec<Feedback>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
```

---

# 15. Goal Source

```text
User
Cognition Engine
External Agent
Scheduled Workflow
Skill Trigger
System Event
```

---

# 16. Goal Lifecycle

```text
Received
 ↓
Classified
 ↓
Planned
 ↓
Awaiting Approval（可选）
 ↓
Running
 ↓
Waiting Feedback（可选）
 ↓
Completed / Failed / Cancelled
 ↓
Evaluation
```

---

# 17. 全面 CLI 化

CLI 不应该只是“启动程序”的辅助命令，而应该成为一级产品界面。

## 17.1 CLI

```bash
desktop-agent start
desktop-agent stop
desktop-agent status
```

## 17.2 Goal

```bash
desktop-agent goal submit "分析过去一周我的工作模式"
desktop-agent goal list
desktop-agent goal get <id>
desktop-agent goal cancel <id>
desktop-agent goal pause <id>
desktop-agent goal resume <id>
```

## 17.3 Feedback

```bash
desktop-agent feedback <goal-id> "这个方向不对"
desktop-agent feedback <goal-id> --approve
desktop-agent feedback <goal-id> --reject
```

## 17.4 Knowledge

```bash
desktop-agent knowledge query "我的代码审查习惯"
desktop-agent knowledge list
desktop-agent knowledge open <id>
desktop-agent knowledge export --format obsidian
```

## 17.5 Skills

```bash
desktop-agent skill list
desktop-agent skill show <name>
desktop-agent skill test <name>
desktop-agent skill run <name>
desktop-agent skill evolve <name>
desktop-agent skill rollback <name> <version>
desktop-agent skill enable <name>
desktop-agent skill disable <name>
```

## 17.6 Questions

```bash
desktop-agent questions list
desktop-agent questions answer <id>
desktop-agent questions skip <id>
```

## 17.7 Runtime

```bash
desktop-agent runtime list
desktop-agent runtime status
desktop-agent runtime health
desktop-agent runtime switch codex
```

---

# 18. JSON CLI 模式

必须支持：

```bash
desktop-agent goal submit \
  --json \
  --input goal.json
```

以及：

```bash
desktop-agent goal get <id> --json
```

这样外部 Agent 可以稳定解析。

禁止让其他 Agent 依赖人类格式的 terminal text。

---

# 19. MCP Server

本产品同时作为 MCP Server。

核心 Tool：

```text
query_knowledge
get_user_preferences
get_workflow
submit_goal
get_goal_status
provide_feedback
list_skills
invoke_skill
inspect_capabilities
```

未来可以增加：

```text
observe_recent_activity
get_relevant_episode
propose_automation
create_skill
request_user_approval
```

但敏感能力必须受 Permission Scope 控制。

---

# 20. Agent-to-Agent Gateway

这是未来极其重要的能力。

外部 Agent 不是简单“调用一个 Tool”，而可以把 Desktop Agent 当成另一个长期存在的 Agent。

例如：

```text
Codex
  │
  │ “请根据这个用户过去的工作方式进行 PR Review”
  ▼
Desktop Agent
  │
  ├── query user knowledge
  ├── query coding workflow
  ├── invoke preference model
  └── return personalized context
```

这意味着 Desktop Agent 是：

> **User Context / Personal Memory / Personal Skill Gateway**

---

# 21. Daemon Architecture

```text
                    desktop-agentd
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
      CLI             MCP Server       Floating UI
        │                │                │
        └────────────────┼────────────────┘
                         ▼
                    Agent Kernel
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   Perception        Cognition        Evolution
        │                │                │
        └────────────────┼────────────────┘
                         ▼
                     Storage
```

推荐使用：

- Unix Domain Socket / Named Pipe
- 本地 loopback HTTP 作为兼容方式

Windows 推荐 Named Pipe；macOS/Linux 使用 Unix Domain Socket。

---

# 22. Local API Security

本地 localhost 不等于安全。

必须具备：

- caller identity
- capability token
- scope
- request signature 或 session key
- rate limit
- approval policy
- audit trail

例如：

```text
Agent A
  ↓
knowledge.read      ✅
skill.invoke         ✅
goal.submit          ✅
email.send          ❌
file.delete         ❌
```

---

# 23. Permission Model

采用 Capability-based Security。

权限格式：

```text
read.screen
read.a11y
read.clipboard
read.files
write.workspace
network.read
network.write
execute.shell
execute.gui
send.external
system.modify
```

每个 Skill 自带声明。

---

# 24. Privacy Architecture

这是产品成败的核心。

如果用户觉得：

> “它在偷看我。”

产品就失败。

如果用户感觉：

> “它在慢慢学会怎么帮助我。”

产品才成立。

---

# 25. Privacy-by-Architecture

## 25.1 默认不保存原始截图

截图仅用于分析。

分析之后：

```text
Screenshot
 ↓
OCR/VLM
 ↓
Semantic Summary
 ↓
Delete Raw Image
```

用户明确开启“保存证据”才长期保存。

---

## 25.2 Sensitive Zone

支持：

- App Blacklist
- Domain Blacklist
- Window Blacklist
- Folder Blacklist
- Screenshot Zone Mask

例如：

```text
银行
支付
密码管理器
私人聊天
医疗
身份信息
```

默认不观察。

---

## 25.3 Sensitive Data Detector

对：

- Password
- API Key
- Token
- Cookie
- Credit Card
- ID Number
- Secret

进行检测。

原则：

> 在写入 Memory 之前过滤，而不是写进去以后再删除。

---

# 26. Privacy States

悬浮球状态必须表达：

```text
OBSERVING
PAUSED
PRIVATE
LEARNING
EXECUTING
WAITING
ERROR
```

用户必须一眼知道：

> 它现在到底在看什么、做什么。

---

# 27. Floating Orb UX

## 27.1 状态

| 状态 | 含义 |
|---|---|
| 灰 | Idle / Paused |
| 蓝 | Observing |
| 紫 | Thinking |
| 绿 | Skill Learning |
| 橙 | User Attention |
| 红 | Error / Risk |

颜色不能成为唯一表达方式，必须同时配合形态、图标、动画、tooltip。

---

# 28. Orb Interaction

### 单击

查看当前状态。

### 双击

打开 Today。

### 长按

进入 Command Palette。

### 右键

快速菜单：

- Pause
- Private
- Ask Agent
- Recent Goals
- New Skill
- Daily Report

### 拖动

修改位置。

---

# 29. 非侵入式原则

Agent 不应该频繁：

- 弹窗；
- 震动；
- 播放声音；
- 要用户回答问题。

默认策略：

```text
Observe Silently
      ↓
Accumulate Evidence
      ↓
Important Opportunity
      ↓
Queue
      ↓
Daily Report
```

仅当：

- 当前 Goal 被阻塞；
- 即时确认可以显著提高成功率；
- 高风险动作需要授权；

才打断用户。

---

# 30. Resource Budget

这是常驻产品必须新增的硬指标。

目标：

## Idle CPU

平均 < 1–2%，短峰值可更高。

## Memory

目标 < 150–250MB（不包含外部 Runtime 和大型模型进程）。

## Screenshot

默认尽量不持续截图。

## VLM

事件触发，而不是固定帧率。

## Battery

电池模式默认降低感知强度。

## Sleep / Lock

设备锁屏后自动进入低功耗模式。

注意：这些是产品目标值，而非第一版即刻保证的硬事实，需要在原型阶段用真实机器测量后再冻结。

---

# 31. Adaptive Sampling

建议状态机：

```text
Idle
  ↓
Light Observe
  ↓
Event Burst
  ↓
Semantic Capture
  ↓
Quiet
```

根据：

- CPU
- Battery
- User Activity
- App Type
- Screen Change
- Current Goal

自动调节采样策略。

---

# 32. Application Adapters

长期看，单纯跨平台 A11y 不够。

应该设计 Adapter SDK：

```text
Generic Observer
       │
       ├── Browser Adapter
       ├── VS Code Adapter
       ├── Terminal Adapter
       ├── Excel Adapter
       ├── Notion Adapter
       ├── Figma Adapter
       └── Custom Adapter
```

这样可以把“应用”变成 Agent 可以理解的语义环境。

---

# 33. Browser Adapter

浏览器是最重要的场景之一。

推荐：

```text
Browser Extension
       ↓
DOM / URL / Tab / Interaction Metadata
       ↓
Desktop Agent
```

优先于截图 OCR。

可获得：

- URL
- 页面标题
- DOM
- 点击元素
- 表单区域
- 页面状态

---

# 34. Terminal Adapter

对编码用户极其重要。

可观察：

- shell command
- exit code
- cwd
- git branch
- test result
- build result

但默认不记录完整敏感 command 内容，需按策略控制。

---

# 35. Coding Environment Adapter

优先支持：

- VS Code
- JetBrains
- Cursor
- Terminal
- GitHub
- Codex

因为第一阶段核心用户很可能是 AI Coding 重度用户。

---

# 36. Knowledge Evolution

每天晚上执行：

```text
Daily Episodes
 ↓
Deduplicate
 ↓
Summarize
 ↓
Extract Knowledge
 ↓
Resolve Conflicts
 ↓
Update Knowledge Graph
 ↓
Update Obsidian
 ↓
Recalculate Confidence
```

---

# 37. Knowledge Decay

不是所有知识都永久有效。

需要：

```text
confidence
freshness
last_verified
validity
usage_frequency
```

长期不再出现的知识逐渐降权。

例如：

> 用户偏好 Python 3.10

如果几年后一直在 Python 3.13，则旧知识应该退化。

---

# 38. Memory Layers

```text
L0 Raw Event
L1 Episodic Memory
L2 Semantic Memory
L3 Procedural Memory
L4 User Model
L5 Work Model
L6 Skill Knowledge
L7 Agent Policy
```

---

# 39. Memory Retrieval

查询 Knowledge 时，不应该直接 Vector Search 全库。

建议：

```text
Query
 ↓
Intent classify
 ↓
Scope filter
 ↓
Temporal filter
 ↓
Semantic retrieval
 ↓
Evidence ranking
 ↓
Conflict check
 ↓
Answer
```

---

# 40. Agent Reflection

每天学习之后产生 Reflection：

```text
What did I learn?
What did I misunderstand?
What predictions failed?
What patterns repeated?
What should I ask?
What skills should evolve?
What should be forgotten?
```

这比简单“总结今天发生了什么”更接近真正的持续学习。

---

# 41. Anti-Hallucination Learning

最危险的情况是：

> Agent 观察一次，就把猜测写成事实。

因此所有长期知识必须有：

- evidence
- source
- confidence
- confirmation state

状态：

```text
Observed
Inferred
Hypothesized
Confirmed
Deprecated
Conflicted
```

---

# 42. Automation Generation Pipeline

```text
Candidate Pattern
      ↓
Generalize
      ↓
Identify Inputs
      ↓
Identify Outputs
      ↓
Identify Preconditions
      ↓
Choose Execution Strategy
      ↓
Generate Skill
      ↓
Generate Evaluator
      ↓
Replay
      ↓
Shadow
      ↓
Human Approval
      ↓
Register Skill
```

注意：

> **Skill Builder 不仅生成“执行器”，还必须生成“评估器”。**

这是原方案必须重点强化的一点。

---

# 43. Skill Evaluator

每个 Skill 都必须知道：

> 什么叫成功？

例如：

“生成周报”成功不是“模型说生成完毕”，而是：

- 文件存在；
- 格式正确；
- 数据完整；
- 数据来源正确；
- 没有重复条目；
- 关键数字与源数据一致。

---

# 44. Generated Evaluator

允许 Agent 自动生成 evaluator。

例如：

```text
Skill: Export sales data

Evaluator:
- row_count >= expected
- no empty required fields
- checksum matches source
- file exists
```

Skill 与 Evaluator 一起生长。

---

# 45. Workflow Engine

不建议第一版直接引入 Temporal/Prefect。

第一版建议：

**Declarative Workflow + Local State Machine**。

例如：

```yaml
workflow:
  name: daily-sales-report

steps:
  - collect
  - validate
  - transform
  - summarize
  - save
  - notify
```

后期再考虑复杂 DAG / Distributed Execution。

---

# 46. Triggers

工作流可以由：

- Schedule
- User command
- App event
- File event
- Pattern detected
- Goal completion
- Skill completion
- External Agent

触发。

---

# 47. Event Bus

内部应采用统一 Event Bus：

```text
PerceptionEvent
GoalEvent
SkillEvent
KnowledgeEvent
RuntimeEvent
UserEvent
SecurityEvent
```

所有组件都通过 Event Bus 协作，而不是互相直接调用。

这样未来可以演进成真正的 Agent OS。

---

# 48. Event Sourcing

不要求所有东西完整 Event Sourcing，但关键对象建议事件化：

- Goal
- Skill
- Knowledge
- Permission
- Runtime

原因：

> 自进化系统必须能够解释“为什么现在变成了这样”。

---

# 49. Auditability

用户应该可以问：

> “你为什么认为我喜欢这个工作流？”

系统能回答：

```text
Evidence:
- 12 次观察
- 3 次成功执行
- 1 次用户明确确认
- 最近验证：2026-09-03
```

这是长期 Agent 信任的基础。

---

# 50. Goal / Knowledge / Skill 三者关系

```text
Goal
 ↓
Execution
 ↓
Experience
 ↓
Knowledge
 ↓
Skill
 ↓
Workflow
 ↓
New Goal can reuse them
```

所以 Goal 不只是任务队列，而是 Agent 学习的重要数据源。

---

# 51. Feedback Model

反馈来源包括：

### Explicit

- 👍
- 👎
- approve
- reject
- free text

### Implicit

- 用户是否修改输出；
- 是否撤销操作；
- 是否重复执行；
- 是否立即手工重做；
- 是否打开生成文件；
- 是否重复相同 Goal。

### Environmental

- command exit code
- test result
- file validation
- API response
- external system result

---

# 52. Implicit Feedback 必须谨慎

“用户修改了输出”不一定代表 Skill 失败。

可能是：

- 用户新增需求；
- 用户临时改变偏好；
- Agent 结果已经正确但用户想进一步编辑。

所以隐式反馈只能作为 evidence，而不是直接判定失败。

---

# 53. Self-Healing

Skill 出错时：

```text
Detect
 ↓
Classify Error
 ↓
Recover if safe
 ↓
Retry if idempotent
 ↓
Fallback
 ↓
Ask User
 ↓
Learn
```

禁止：

> 无限自动重试。

必须有 retry budget。

---

# 54. Runtime Failure

例如 Codex 不可用：

```text
Codex unavailable
 ↓
Health Check
 ↓
Retry
 ↓
Fallback Runtime
 ↓
If no Runtime
 ↓
Queue Goal
```

不能因为 Runtime 挂掉而损坏本地知识和技能。

---

# 55. Runtime Switch

切换 Runtime 时：

```text
New Runtime
 ↓
Health Check
 ↓
Capability Check
 ↓
Warm-up
 ↓
Atomic Switch
```

正在执行的 Goal：

- 默认继续原 Runtime；或
- 安全暂停后迁移；

而不是直接粗暴终止。

---

# 56. Cross-Runtime Portability

Skill 必须包含：

```text
Required Capabilities
```

而不是：

```text
Required Runtime = Codex
```

例如：

```yaml
required_capabilities:
  - shell
  - filesystem.read
  - structured_output
```

这样任何符合条件的 Runtime 都可以执行。

---

# 57. Model Portability

同理，Skill 不绑定：

```text
GPT-x
Claude-x
Gemini-x
```

而绑定：

```text
Reasoning > high
Context > 64k
Vision = true
Structured Output = true
```

Runtime 自己解决如何满足。

---

# 58. CLI-as-First-Class Interface

未来目标：

> **任何 Agent 都可以通过 CLI/MCP 使用 Desktop Agent，而用户甚至不需要打开桌面 UI。**

因此 GUI 只是一个 visualization layer。

---

# 59. External Agent Use Cases

### Use Case A：获取用户偏好

```bash
desktop-agent knowledge query "我的产品设计偏好"
```

### Use Case B：委托任务

```bash
desktop-agent goal submit "按照我过去的方式整理这个项目"
```

### Use Case C：调用个人 Skill

```bash
desktop-agent skill run generate-weekly-report
```

### Use Case D：请求 Agent 学习

```bash
desktop-agent goal submit "学习我处理这类售后数据的方式"
```

---

# 60. UX Information Architecture

完整 UI 建议：

```text
Today
├── Current Status
├── Today Summary
├── Automation Wins
└── Questions

Timeline
├── Activities
├── Episodes
└── Goals

Knowledge
├── User
├── Work
├── Projects
├── Preferences
└── Learnings

Skills
├── Active
├── Growing
├── Failed
└── Archived

Automations
├── Suggestions
├── Active
└── Savings

Goals
├── Running
├── Waiting
└── Completed

Runtime
├── Active
├── Installed
├── Health
└── Routing

Privacy
├── Observation
├── Sensitive Apps
├── Sensitive Domains
└── Permissions
```

---

# 61. Product Metrics

## 61.1 North Star Metric

建议定义：

> **每周由 Agent 可靠完成、并被用户接受的工作价值。**

可量化为：

```text
Verified Automation Hours Saved / Week
```

而不是：

- Token 消耗；
- 问题回答数量；
- 知识库条目数量；
- Skill 数量。

---

# 62. Learning Metrics

### Knowledge Precision

Agent 的长期知识中，有多少是用户认可的。

### Knowledge Freshness

长期知识是否更新。

### Question Efficiency

每个用户回答平均解决多少认知缺口。

### Uncertainty Reduction

一段时间后，未知比例是否下降。

---

# 63. Automation Metrics

### Opportunity Precision

建议自动化中真正值得自动化的比例。

### Skill Activation Rate

生成后真正被用户启用的比例。

### Skill Success Rate

真实执行成功率。

### Human Intervention Rate

每次自动化需要多少人工干预。

### Regression Rate

技能升级后的退化率。

---

# 64. Trust Metrics

### Unexpected Action Rate

用户未预期动作发生率。

目标接近 0。

### Privacy Incident Rate

目标：0。

### Permission Escape

目标：0。

### Rollback Success

必须接近 100%。

---

# 65. Performance Metrics

必须测量：

- idle CPU
- peak CPU
- memory
- disk growth
- battery impact
- screenshot volume
- OCR volume
- VLM calls
- Runtime calls

---

# 66. Cost Metrics

每个 Goal 都记录：

```text
runtime
model
input tokens
output tokens
duration
estimated cost
retry count
```

但核心产品不能要求用户理解 Token。

用户应该看到：

> 今日 Agent 成本：$X
> 今日节省时间：Y 分钟
> ROI：Z 倍

---

# 67. Daily Learning Budget

必须可配置：

```yaml
learning:
  max_questions_per_day: 8
  max_background_goals: 5
  max_runtime_cost: 2.0
  allow_vlm: true
  allow_external_network: true
```

---

# 68. Battery Policy

```text
AC Power:
 Full learning

Battery:
 Reduced perception

Low Battery:
 Minimal observation

Sleep:
 Pause
```

---

# 69. Failure Philosophy

Agent 失败不能被隐藏。

失败应该变成：

```text
Failure
 ↓
Explain
 ↓
Learn
 ↓
Improve
```

用户应该看到：

> “这次失败让我发现了一个我之前不知道的条件，下次我会在执行前先检查它。”

这才是真正的自进化体验。

---

# 70. Transparency

所有重要行为应该可以解释：

- 为什么观察？
- 为什么建议？
- 为什么生成这个 Skill？
- 为什么调用这个 Runtime？
- 为什么需要权限？
- 为什么问这个问题？
- 为什么认为执行成功？

---

# 71. Agent Explainability Card

每个自动化建议：

```text
我发现：
你过去 14 天执行了 9 次类似操作。

平均耗时：18 分钟。

我认为：
这是一个稳定工作流。

我的依据：
9 次观察 + 2 次成功复现。

我建议：
生成“周报收集器”。

预计：
每周节省约 2.7 小时。

风险：
低。

下一步：
[运行 Shadow Test] [暂不]
```

---

# 72. Security Threat Model

必须防御：

### Prompt Injection

用户浏览网页时，网页内容可能指令 Agent。

因此：

> 外部内容永远不是高权限指令源。

### Malicious Skill

Skill 必须签名 / 来源可追溯。

### Tool Abuse

每个 Tool 必须 capability scope。

### Data Exfiltration

禁止未经授权把本地 Memory 上传到外部 Runtime。

### Runtime Compromise

Runtime 进程只获得必要路径和权限。

### Supply Chain

Skill 依赖需要 manifest + integrity hash。

---

# 73. Data Exfiltration Policy

外部 Runtime 提交任务时：

不能默认发送整个 Memory。

应该：

```text
Goal
 ↓
Context Requirement
 ↓
Minimal Relevant Knowledge
 ↓
Redaction
 ↓
Runtime
```

即：

> **Context Minimization**。

---

# 74. Local-first Architecture

默认本地保存：

- Raw events
- Episodes
- Knowledge
- Skills
- Reports
- Audit
- Evaluation

云端只接收执行该 Goal 所必要的信息。

---

# 75. Data Retention

建议：

### Raw Evidence

默认 24 小时～7 天，可配置。

### Episodic Memory

长期保存，但压缩。

### Semantic Knowledge

长期保存。

### Execution Logs

按体积与时间双重清理。

### Skill Versions

长期保存关键版本。

---

# 76. Codex 日志隔离策略

不能把 Codex rollout JSONL 原样复制到自己的数据库。

应该：

```text
Runtime Raw Stream
 ↓
Event Normalizer
 ↓
Relevant Events
 ↓
Execution Trace
 ↓
Delete / Expire Raw
```

尤其考虑到当前 Codex 社区已经出现大型 JSONL / inline image 造成磁盘、内存和 swap 激增的真实案例，因此这里应该作为产品架构的硬约束，而不是优化项。citeturn237698search6turn237698search2

---

# 77. Tech Stack Recommendation

## Desktop

**Tauri 2.x + Rust + TypeScript UI**

原因：

- 常驻桌面；
- 跨平台；
- 原生能力；
- 低资源；
- Rust 适合事件管线与系统 API。

---

# 78. UI Stack

推荐：

- React
- TypeScript
- Tailwind / CSS Variables
- Motion / WebGL（适量）

悬浮球尽量原生轻量。

---

# 79. Storage Stack

第一版：

```text
SQLite
 ├── event metadata
 ├── episodes
 ├── knowledge
 ├── skills
 ├── goals
 ├── evaluation
 └── permissions
```

文件系统：

- Skill source
- artifacts
- markdown
- screenshots（临时）

向量检索可以先基于 SQLite/本地索引，避免第一版就引入复杂 Vector DB。

---

# 80. Workflow Engine

MVP：自研轻量状态机。

未来：

- DAG
- Parallel execution
- Retry policy
- Compensation
- Durable execution

再评估 Temporal 等方案。

---

# 81. Perception OS Support

## Windows

第一优先级：

- UI Automation
- Win32 window events
- Clipboard
- File system watcher
- Browser extension

## macOS

- Accessibility API
- NSWorkspace
- Pasteboard
- FSEvents

## Linux

- AT-SPI
- XDG / Wayland compatible observers
- inotify

---

# 82. Why Windows-first is reasonable

如果目标是快速验证 MVP，建议先 Windows。

因为：

- 用户桌面 Agent 的大量办公自动化需求集中在 Windows；
- UI Automation 生态成熟；
- 浏览器 + Excel + Office 场景价值高；
- 更容易验证“普通知识工作者”的自动化价值。

macOS 作为第二目标。

---

# 83. MVP Scope

## P0 必须

### Desktop

- Tauri shell
- Floating Orb
- daemon
- local IPC

### Perception

- active app/window
- accessibility tree
- clipboard metadata
- file events
- browser extension基础

### Cognition

- activity segmentation
- daily summary
- basic knowledge extraction
- uncertainty tracking

### Learning

- Socratic Questions
- user answers
- knowledge update

### Skill

- skill manifest
- candidate generation
- sandbox
- manual approval
- versioning

### Runtime

- Codex Adapter
- Generic CLI Adapter
- Runtime Router

### CLI

- status
- goal
- knowledge
- skill
- runtime
- question

### MCP

- query_knowledge
- submit_goal
- get_goal_status
- list_skills
- invoke_skill

### Obsidian

- export
- auto projection
- file watcher

---

# 84. MVP 明确不做

- 自动修改自身 Kernel；
- 自动 fine-tuning 模型；
- 自动进行高风险外部操作；
- 大规模屏幕录制；
- 多人协作；
- 云端同步账号体系；
- 企业权限系统；
- 复杂插件市场；
- 全量 Computer Use；
- 复杂 DAG 分布式调度。

---

# 85. Phase 0：Research Prototype

目标：证明三件事：

### Hypothesis 1

Agent 能从自然桌面事件中识别“任务”。

### Hypothesis 2

Agent 能从重复任务中发现真正有价值的自动化机会。

### Hypothesis 3

Agent 可以通过少量苏格拉底问题显著提高对用户的理解。

只做：

- Windows observer
- Timeline
- Daily report
- Question
- Knowledge

先不要做完整自动化。

---

# 86. Phase 1：MVP

### 目标

实现：

```text
Observe
→ Understand
→ Ask
→ Learn
```

用户开始感觉：

> “这个东西真的越来越懂我。”

---

# 87. Phase 2：Skill Growth

实现：

```text
Observe
→ Discover
→ Build
→ Sandbox
→ Shadow
→ Approve
→ Run
```

---

# 88. Phase 3：Self-Evolving Workflow

实现：

```text
Run
→ Evaluate
→ Diagnose
→ Evolve
→ Replay
→ Promote
```

---

# 89. Phase 4：Agent Gateway

实现：

```text
Any Agent
     ↓
Desktop Agent
     ↓
Personal Context
     ↓
Personal Skills
     ↓
Personal Execution
```

这个阶段产品价值会发生一次明显跃迁。

---

# 90. Phase 5：Personal Agent OS

最终：

```text
Apps
Files
Browser
Agents
Models
Knowledge
Skills
Goals

          ↓

     Personal Agent OS
```

---

# 91. MVP 详细验收标准

## Observation

- 能稳定识别 active application
- 能获取核心 A11y 信息
- 能处理窗口切换
- 能过滤敏感 App
- 不保存原始截图为长期数据

## Cognition

- 能生成工作时间线
- 能形成 Episode
- 能标识 uncertainty

## Daily Learning

- 至少生成 3 个有效知识条目
- 至少生成 1 个有价值问题
- 用户回答后知识发生可追踪变化

## Skill

- 能从候选模式生成 Skill
- 能 sandbox
- 能 replay
- 能 shadow
- 能 version
- 能 rollback

## Runtime

- Codex 可接入
- Runtime 可切换
- Runtime 失败不损坏 Core

## CLI

- 所有核心能力可 CLI 调用
- JSON 输出稳定

## MCP

- 外部 Agent 可 query knowledge
- 可 submit goal
- 可 inspect skill

---

# 92. 第一阶段成功标准

不要以“功能完成多少”衡量。

而应该用以下实验衡量：

### 30 位真实用户 / 或 10 位重度测试用户

连续使用 2 周。

观察：

1. Agent 能否正确识别工作类型；
2. 用户是否认为 Daily Report 有价值；
3. 用户平均每天愿意回答多少问题；
4. 自动化建议命中率；
5. 有多少用户愿意启用 Skill；
6. 系统是否明显影响性能；
7. 用户是否产生“它越来越懂我”的主观感受。

---

# 93. 关键实验指标

建议目标：

### Question Acceptance

> 60% 以上用户愿意回答高价值问题。

### Automation Proposal Acceptance

> 30% 以上。

### Skill Activation

> 被批准的候选中 > 50% 实际运行。

### Reliable Skill

> 活跃 Skill 在稳定场景下 > 95% 成功率。

这些是产品实验目标，不是既有行业事实，需要通过真实用户测试校准。

---

# 94. 最重要的产品指标：Capability Compounding

建议建立一个内部指标：

```text
Capability Compounding Rate
=
本周新增的可复用可靠能力
÷
上周已有能力
```

但不能简单数 Skill。

真正要统计：

> **新增、真实使用、可靠、复用的能力。**

---

# 95. Agent Intelligence Dashboard

用户可以看到：

```text
我的 Agent

理解领域：12
工作流：43
技能：28
自动化：17

本周：
新学知识：31
新增技能：4
技能升级：7

节省时间：5h 42m

未知问题：8

可靠执行：96.7%
```

这样产品的“成长感”会非常强。

---

# 96. 用户心智模型

用户不应该觉得：

> “我需要学习怎么使用一个复杂的 Agent Framework。”

而应该觉得：

> “我养了一个数字学徒。”

它：

- 会偷学；
- 会提问；
- 会犯错；
- 会复盘；
- 会记住；
- 会长技能；
- 会越来越有用。

---

# 97. 产品命名方向

可考虑：

### Desktop Agent

技术中性。

### Apprentice

强调“数字学徒”。

### Ambient Agent

强调存在感而非对话框。

### Personal Agent OS

强调平台。

### Growing Agent

强调持续成长。

如果希望形成独立产品品牌，建议避免直接使用“AI Assistant”作为主产品名。

---

# 98. 差异化定位

| 产品类型 | 是否观察 | 是否主动学习 | 是否长技能 | 是否用户专属知识 | 是否可被外部 Agent 调用 |
|---|---:|---:|---:|---:|---:|
| Chatbot | ❌ | ❌ | ❌ | 弱 | 弱 |
| RPA | 部分 | ❌ | ✅ | ❌ | 弱 |
| Computer Use | 临时 | ❌ | 弱 | ❌ | 部分 |
| Coding Agent | 项目内 | 部分 | ✅ | 部分 | ✅ |
| **本产品** | **✅** | **✅** | **✅** | **✅** | **✅** |

真正的差异化：

> **它不是执行某个任务的 Agent，而是长期学习“用户如何工作”的 Agent。**

---

# 99. 最大产品护城河

不是：

- 模型；
- UI；
- OCR；
- CLI；
- MCP。

因为这些都可以被复制。

真正护城河是：

```text
长期个人工作数据
        +
长期知识模型
        +
长期技能库
        +
执行结果
        +
用户反馈
        +
个人 Benchmark
        +
Agent Evolution History
```

也就是：

> **Personal Agent Experience Graph**。

---

# 100. Personal Agent Experience Graph

建议未来内部定义：

```text
User
 │
 ├── WorksAt
 ├── UsesTool
 ├── Prefers
 ├── Avoids
 ├── Performs
 ├── Knows
 ├── Repeats
 └── Trusts

Workflow
 │
 ├── Contains Skill
 ├── Uses Tool
 ├── Produces Artifact
 ├── Has Trigger
 └── Has Evaluation
```

最终变成：

> 用户自己的 Agent Experience Graph。

---

# 101. 为什么这是比“知识库”更重要的概念

传统知识库回答：

> “用户知道什么？”

Experience Graph 回答：

> “用户如何工作？”

而真正的 Personal Agent，后者更加重要。

---

# 102. 未来 Agent Runtime 的位置

最终 Runtime 会变成：

```text
Desktop Agent OS
       │
       ├── Personal Context
       ├── Personal Knowledge
       ├── Personal Skills
       ├── Personal Policies
       └── Goals
              │
              ▼
      Runtime Abstraction
              │
      ┌───────┼────────┐
      ▼       ▼        ▼
    Codex   Claude   Gemini
```

也就是说：

> Runtime 越来越像“计算引擎”，而 Desktop Agent 才是“个人智能操作系统”。

---

# 103. 重要架构决策

## ADR-001

**Desktop Agent 是系统主体，Runtime 是外接计算器。**

## ADR-002

**知识的 Canonical Store 在 Desktop Agent，不在 Runtime。**

## ADR-003

**Obsidian 是知识资产投影，不是运行态数据库。**

## ADR-004

**Skill 与 Runtime 解耦。**

## ADR-005

**Screenshot 是补充感知，而不是主感知。**

## ADR-006

**所有 Skill 必须拥有 Evaluator。**

## ADR-007

**新 Skill 默认 Shadow，不直接 Active。**

## ADR-008

**自进化优先发生在 Memory / Knowledge / Skill / Workflow 层。**

## ADR-009

**Kernel 自修改属于高级实验能力。**

## ADR-010

**每个重要结论必须有 Evidence 和 Confidence。**

---

# 104. 第一版最值得砍掉的东西

为了避免“过度工程化”，第一版不应该同时开发：

- 完整跨平台；
- 复杂向量数据库；
- Temporal；
- 多模型本地部署；
- ACP 全家桶；
- 多 Agent 自博弈；
- Kernel Self Rewrite；
- 大规模 Computer Use。

第一版只需要证明：

```text
我观察你
↓
我越来越理解你
↓
我发现你在重复做某件事
↓
我告诉你
↓
我帮你长出第一个 Skill
↓
我成功帮你做掉它
↓
第二次我做得更好
```

如果这个循环成立，产品成立。

---

# 105. 最小可行产品的最小闭环

甚至可以继续缩小到：

```text
Windows
+
Active Window
+
Accessibility Tree
+
Daily Report
+
Socratic Questions
+
Codex CLI
+
Skill Manifest
+
One Workflow
+
Obsidian Sync
```

不需要一开始实现所有自动化能力。

---

# 106. 建议的第一条完整 Demo

第一条 Demo 不建议选“自动化银行操作”或复杂 Computer Use。

建议选择：

> **开发者每日代码工作总结 → 自动生成 Daily Engineering Report。**

流程：

```text
VS Code
Git
Terminal
Browser
    ↓
Observe
    ↓
Identify coding episodes
    ↓
Understand projects
    ↓
Generate Daily Report
    ↓
Ask one question
    ↓
Learn preference
    ↓
Generate report skill
    ↓
Next day automatically run
    ↓
User corrects report
    ↓
Skill evolves
```

这条链可以同时证明：

- 观察；
- 认知；
- 问答；
- 知识；
- 技能；
- 执行；
- 反馈；
- 自进化。

---

# 107. 第二条 Demo

> **自动学习用户的数据整理流程。**

例如：

```text
Browser
 ↓
Copy Data
 ↓
Excel
 ↓
Clean
 ↓
Format
 ↓
Export
```

Agent：

1. 发现行为重复；
2. 判断价值；
3. 提议自动化；
4. Shadow；
5. 用户批准；
6. 生长 Skill；
7. 下次直接执行。

这比“聊天机器人帮用户做一次 Excel”更能证明本产品的不同。

---

# 108. 第三条 Demo：外部 Agent 调用

在 Codex 中：

```text
“根据我平时的开发方式审查这个 PR。”
```

Codex：

```bash
desktop-agent knowledge query "代码审查偏好"
```

然后读取：

```text
User preference
Review workflow
Existing skill
Past failures
```

最后完成个性化工作。

这将证明：

> Desktop Agent 已经成为“用户智能基础设施”。

---

# 109. 长期产品形态

未来用户不再有：

```text
ChatGPT
Claude
Codex
Gemini
各种 Skill
各种 Memory
```

彼此割裂的问题。

而是：

```text
             Personal Agent OS
                    │
      ┌─────────────┼─────────────┐
      ▼             ▼             ▼
  Knowledge       Skills        Goals
      │             │             │
      └─────────────┼─────────────┘
                    ▼
             Runtime Router
                    │
        ┌───────────┼────────────┐
        ▼           ▼            ▼
      Codex       Claude       Gemini
```

---

# 110. 产品最终定义

最终不要把这个产品描述成：

> “桌面上的 AI 助手。”

更准确的定义应该是：

> **一个持续学习用户工作方式，并把个人经验逐渐转化为机器可执行能力的 Personal Agent OS。**

它的核心资产也不是 Chat History，而是：

```text
Experience
Knowledge
Skills
Workflows
Policies
Evaluations
Trust
```

它的核心能力也不是回答问题，而是：

```text
Notice
Understand
Ask
Remember
Build
Verify
Act
Learn
Evolve
```

---

# 111. 参考研究与技术依据

本 PRD 在原始方案基础上，补充参考以下方向：

1. **A Comprehensive Survey of Self-Evolving AI Agents**：用于区分系统输入、Agent、环境与优化器，以及 self-evolution 的不同对象。citeturn917862academia26
2. **A Survey of Self-Evolving Agents**：用于理解“进化什么、什么时候进化、如何进化”的分类框架。citeturn917862academia27
3. **Darwin Gödel Machine**：用于“候选变体 → 经验验证 → 保留/回滚”的进化思想。citeturn917862academia28
4. **OSWorld / OSWorld 2.0**：用于认识真实桌面 Computer Use 的评估问题，并据此提出 Personal Benchmark。citeturn917862search0turn917862search3
5. **OpenAI Codex app-server**：作为第一 Runtime Adapter 的协议基础。citeturn237698search0
6. **Agent Client Protocol**：作为未来 Runtime / Agent 互操作方向。citeturn590172search0turn590172search1
7. **Obsidian Properties / Obsidian Flavored Markdown**：作为知识资产投影格式依据。citeturn808657view0turn808657view1

---

# 112. 最终建议：研发时遵循“三条铁律”

## 铁律一

**不要先做“全能 Agent”，先做“会学习一个人的 Agent”。**

## 铁律二

**不要先做“自我修改”，先做“可验证的技能进化”。**

## 铁律三

**不要先做“复杂 Agent Framework”，先把 Observe → Learn → Skill → Execute → Evaluate 这个飞轮跑通。**

---

# 113. 开发优先级总表

| 优先级 | 模块 | MVP | Phase 2 | Phase 3 |
|---|---|---:|---:|---:|
| P0 | Desktop Daemon | ✅ | ✅ | ✅ |
| P0 | Floating Orb | ✅ | ✅ | ✅ |
| P0 | Windows Perception | ✅ | ✅ | ✅ |
| P0 | Activity Segmentation | ✅ | ✅ | ✅ |
| P0 | Daily Report | ✅ | ✅ | ✅ |
| P0 | Socratic Learning | ✅ | ✅ | ✅ |
| P0 | Knowledge Store | ✅ | ✅ | ✅ |
| P0 | Obsidian Sync | ✅ | ✅ | ✅ |
| P0 | Codex Adapter | ✅ | ✅ | ✅ |
| P0 | Generic CLI Adapter | ✅ | ✅ | ✅ |
| P0 | CLI | ✅ | ✅ | ✅ |
| P0 | MCP | ✅ | ✅ | ✅ |
| P1 | Skill Builder | ✅ | ✅ | ✅ |
| P1 | Sandbox | ✅ | ✅ | ✅ |
| P1 | Replay | ✅ | ✅ | ✅ |
| P1 | Shadow | ✅ | ✅ | ✅ |
| P1 | Evaluator Generator |  | ✅ | ✅ |
| P1 | Skill Evolution |  | ✅ | ✅ |
| P1 | Personal Benchmark |  | ✅ | ✅ |
| P1 | Browser Adapter | ✅ | ✅ | ✅ |
| P1 | Terminal Adapter | ✅ | ✅ | ✅ |
| P2 | ACP |  | ✅ | ✅ |
| P2 | Multi-Agent Evolution |  |  | ✅ |
| P2 | Kernel Evolution |  |  | Experimental |
| P2 | Model Fine-tuning |  |  | Experimental |

---

# 114. 一句话开发战略

> **先把它做成一个“安静地观察、精准地询问、可靠地记忆、谨慎地自动化”的数字学徒；当这个数字学徒拥有足够多的个人经验之后，再让它成为一个真正能够持续自我进化的 Personal Agent OS。**

