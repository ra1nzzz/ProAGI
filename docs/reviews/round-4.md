# REVIEW Round 4 — UI、无障碍与 EVAL

**范围**：Round 3 六件套与 `reference/Prototype reference1.png`  
**方法**：三维只读 YT review（UI fidelity / WCAG interaction / evaluator closure）+ 主代理盲区扫描

## 趋势评分

- A UI/UX 忠实度与信息架构：**5.4/10**
- B 无障碍与安全交互：**6.4/10**
- C EVAL 闭环：**6.2/10**

分数只作趋势，不是 8/10 门禁。合并去重后：P0=5（其中两项文档冲突在合并过程中已立即修正），裁决 `CONDITIONAL`。领域契约比 Round 3 更完整，但 UI 仍可能退化成“彩色圆 + 卡片”，且 accessibility tree 是此前遗漏的隐私 sink。

## 原型适用边界

参考图只提供视觉语言与 Orb 交互参考，不是整图 gold。M1 采纳暖白画布、深墨标题、蓝强调、细灰分隔、玻璃液体 Orb、26/96px、六态形态和分组卡片；不采纳鼠标轨迹识别、OCR、发送邮件/创建任务、真实执行或 legacy `ProAGIAgent/智图灵助手` 品牌。最终品牌统一 `ProAGI Assistant`。

## 合并 Findings

| ID | Priority | 问题 | 统一修复 |
|---|---|---|---|
| R4-01 | P0 | aria-label/live 可把来源、动作、statement 或错误输入放进 accessibility tree | 固定状态名称；aria-describedby 只用 coarse SourceLabel enum；DOM/a11y tree 纳入 canary sinks |
| R4-02 | P0 | PRIVATE/RECOVERY_ONLY/CLEAR_ONLY/blocked 没有可访问恢复表面 | 定义 RecoverySurface、role/status/alert、动作、初始/返回焦点和跨标签 E2E |
| R4-03 | P0 | “拖拽须有键盘替代”不可执行，违反 dragging movement 等价路径 | 可见 Move Orb 控制：Arrow 8px、Shift 32px、Enter 保存、Escape 取消、Reset、safe-area clamp |
| R4-04 | P0 | EVAL 保留旧 invalid EvaluationResult/tombstone 字段 | 已统一为物理删 result + 随机无关联 receipt，以及 `{id,deletedType,deletedAt}` |
| R4-05 | P0 | deletion crash failpoint 名称在 SPEC/EVAL 不一致 | 已统一加入 `delete-after-fence/chunk/audit-before-verified` registry |
| R4-06 | P1 | 没有 Orb anatomy 与视觉 token；纯色圆也能通过 | 冻结 VisualTokenV1、OrbAnatomyV1 七层和六态 token；结构测试防退化 |
| R4-07 | P1 | 没有页面信息架构 | 冻结 AppShell：status/privacy、Today、Observed、Learned、Correction Impact、Inbox、Replay、detail drawer |
| R4-08 | P1 | 没有 360/768/1280 responsive/reflow 规则 | 冻结三档 grid、顺序、drawer、Orb docking、table-to-card、横向滚动禁区 |
| R4-09 | P1 | recovery mode 与六态 Orb 的组合无 resolver | 定义 PresentationStateResolver 真值表；Orb仍六态，恢复用 ERROR + persistent substate/banner |
| R4-10 | P1 | 首次、合法 abstain、全拒绝、删除后空库、加载失败未区分 | 冻结 EmptyState registry；显示安全 reason/count/CTA，不伪造候选 |
| R4-11 | P1 | projection stale/loading/rebuild 没有 UI contract | 所有 action 绑定 sourceCursor；stale 禁用 correction，delta 完成后原子替换并保焦点 |
| R4-12 | P1 | ErrorPolicy 未映射到可见标题、按钮、focus/live priority | 穷尽 UiErrorContract registry，固定安全文案与 next action |
| R4-13 | P1 | 正常 motion 只有形容词，reduce 只覆盖 Orb | 冻结 MotionToken；reduce 全局关闭 transform/parallax/smooth scroll/skeleton movement |
| R4-14 | P1 | forced-colors/contrast/200%/320px/text spacing 无 pass oracle | 建状态 token矩阵和 fixed viewport/reflow criteria；Windows High Contrast smoke |
| R4-15 | P1 | menu/popover/dialog focus 与 WCAG 1.4.13 未闭合 | 定义 role、初焦点、方向键、dismiss/hover/persist、Escape 与 fallback |
| R4-16 | P1 | aria-live 未规定内容、节流、去重和 privacy epoch 清队列 | UiAnnouncement registry；polite进度按阶段/10%，ERROR单次assertive，装饰Orb不live |
| R4-17 | P1 | Insight/evidence/diff 信息密度缺语义结构 | heading/list/definition list、渐进披露、aria-expanded；diff 不只红绿；confidence 文本等级 |
| R4-18 | P1 | PreviewToken 无独立负例 suite | 篡改、重放、过期、bytes/identity/hash/pin/consent/epoch 变化全部零写并返回固定错误 |
| R4-19 | P1 | immutable Knowledge/workflow heads 无通用 contract | 测旧字节不变、stale CAS、双写一胜、错 parent/type/key、ledger response-loss |
| R4-20 | P1 | ReplayInputV1 无逐字段 metamorphic oracle | 每字段 mutation 改 key；合法重排/排除字段不改；悬空 head/缺 pin fail closed |
| R4-21 | P1 | NDJSON Worker 无协议 evaluator | header/footer/hash/UTF-8/sequence、maxUnacked=2、ACK/CANCEL/crash/staging/partial receipt suite |
| R4-22 | P1 | Projection delta 无等价/gap/CAS oracle | delta=full hash、分页无漏重、9→10 BigInt、gap fallback、stale CAS、delete purge |
| R4-23 | P1 | fixture、gold 与 evaluator 仍可共享 bug | 分 FixtureInputManifest/GoldOracle/EvaluatorManifest artifact/hash/owner；mutation corpus 证明会失败 |
| R4-24 | P1 | 没有统一可审计 oracle schema | 定义 OracleAssertionV1 与 AC/INV 双向 trace；skip/空分母不得 PASS |
| R4-25 | P1 | PR/nightly/release 只有文字，无脚本矩阵/artifact | 加 verify:pr/nightly/release、worker/projection/evaluator/visual scripts与 evidence tier |
| R4-26 | P1 | UI visual regression 缺失，整图又含越界能力 | VisualContractV1 只抽取批准元素；固定 browser/font/viewport/DPR，结构门禁+非门禁 screenshot diff |
| R4-27 | P1 | a11y 只有自然语言与 axe serious | critical=0且serious=0；name/role、键盘、focus、live、reflow、contrast、motion和人工NVDA模板 |
| R4-28 | P1 | UI command 可被 Enter/key repeat/double click 重复提交 | pending lock + commandId/idempotency；一用户意图只提交一次，response-loss 回读 |
| R4-29 | P1 | IDB/Worker/BroadcastChannel 不支持时无安全 UI | unsupported/denied/crash fallback；禁止静默降级 localStorage |
| R4-30 | P1 | evaluator sensitivity/specificity 用极小样本点估计 | 关键负例继续全过 INV；统计另报 exact CI，N不足明确证据不足 |
| R4-31 | P2 | 单击与双击会冲突，长按缺取消 | Today 用可见按钮/menu；双击/长按只作增强，pointercancel 不提交 |
| R4-32 | P2 | correction form 无 label/error/重复提交 contract | native label、describedby/errormessage、error summary、保留输入、脱敏删除确认 |
| R4-33 | P2 | lang/landmark/heading/skip/help 未冻结 | html zh-CN、main/nav/aside、skip link、route title+h1、固定隐私/帮助位置 |
| R4-34 | P2 | accessible name 可能不含可见 label | Label-in-Name contract；aria-label 不得覆盖“预览建议/暂停观察”等可见词 |
| R4-35 | P2 | visual/stat evidence 缺 font/tool/seed version | Evidence Pack 记录 fontHash、visual comparator、statistics profile、bootstrap seed |

## 六类盲区

- **幂等**：pointer/keyboard/double-click 和 live announcements 也必须去重；不只后端 ledger。
- **安全**：accessibility tree、aria/data/title、截图 artifact 是新的 canary sinks。
- **可观察性**：记录无 payload 的 uiStateKey/focusTarget/liveMessageKey 序列和 tier/artifact hash。
- **数据完整性**：所有成功表面绑定最新 cursor/epoch/modes；stale projection 不得可纠正。
- **并发/竞态**：epoch/clear 到来时取消旧 UI task、清 announcement queue、恢复焦点，不能播报旧成功。
- **外部依赖韧性**：axe 不替代 NVDA/forced-colors/zoom；IDB/Worker/BC 缺失必须安全失败。

## 合并时已关闭的重新打开项

- EVAL G-08、invalidation metric、AC-12 与 tombstone shape 已同步 SPEC。
- SPEC 与 EVAL deletion failpoints 已统一。
- ARCH 已移除旧 capability 名称复制，改为引用 SPEC registry。

## 修订完成条件

1. PRD/SPEC 冻结 AppShell、visual/anatomy/motion/responsive/state/empty/error/a11y contracts；
2. EVAL 增 Preview/head/Replay/Worker/Projection/oracle independence suites；
3. PLAN/CHECKPOINT 增 UI/visual/a11y scripts、evidence 和 gates；
4. accessibility tree canary、RecoverySurface 和 drag alternative 三项 P0 可自动验证；
5. canonical conflict 与结构扫描通过后，才启动 Round 5。

## 修订完成记录

- SPEC 新增完整 §5.6 UI DTO 并重写 §12；Visual/AppShell/Layout/State/Recovery/Error/Announcement/MoveOrb contracts 已冻结，旧动态来源 aria-label 已移除。
- EVAL 新增 PreviewToken、immutable heads、Replay metamorphic、Worker、Projection delta、独立 fixture/gold/evaluator、OracleAssertion、visual/a11y/recovery/UI idempotency suites；planned scripts 与 tier/evidence 模板已同步。
- PRD/ARCH/PLAN/CHECKPOINT 已同步 mood-board边界、AppShell、七层 Orb、responsive/forced-colors、accessibility-tree privacy、RecoverySurface 与新 contract suites。
- 六件套结构扫描通过：UTF-8、Markdown fence 配对；SPEC exported declarations 与 EVAL interfaces 无重复；旧动态 aria、旧 invalid result、旧 capability 与旧 unique factHash 均为 0。
- Round 4 修订完成；下一步只进行第 5 轮 adversarial integration/final stitch，不开启 Round 6。
