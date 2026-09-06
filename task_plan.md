# ProAGI 交付计划

## 目标
以 `docs/PRD/desktop-agent-complete-prd-v1.1.md` 与 `reference/Prototype reference1.png` 为输入，完成深度调研、五件套（SPEC/ARCH/PLAN/CHECKPOINT/EVAL）、最多五轮文档评审与择优缝合，并依据最终六件套实现和验证产品。

## 阶段
1. **资料盘点与约束提取** — complete
   - 完整读取 PRD、原型参考及仓库现状
   - 明确 MVP、目标用户、成功标准、技术与隐私边界
2. **深度调研** — complete
   - Phase 0 建立分析框架与待验证假设
   - 一手源精读、竞品/反例/数据交叉验证
   - 已输出 `docs/research/deep-research-report.md`
3. **Idea Refine 与五件套** — complete
   - 已完成 PRD 对照、发散、压力测试和收敛
   - 已输出 `docs/final/PRD.md` 与 `SPEC.md`、`ARCH.md`、`PLAN.md`、`CHECKPOINT.md`、`EVAL.md`
4. **五轮 REVIEW 与修订** — complete
   - 每轮按代码质量/效率/复用性及六类盲区审查六件套
   - 8/10 不是硬门禁；第 5 轮停止并择优缝合
5. **开发实施** — complete
   - 已按最终六件套完成 M1 synthetic Insight Loop 垂直切片
   - UI/UX 已对齐参考图的暖白 AppShell、六态球体与等价交互
6. **验证与交付** — complete（Gate 1 CONDITIONAL）
   - 98/98 Vitest、26/26 Chromium、2/2 smoke、nightly privacy 26/26、nightly worker 7/7、typecheck/lint/CSP/audit/build 全部通过
   - NVDA、人工视觉批准、hosted CI 与跨标签删除/PURGE 诚实保留 `NOT_RUN`
7. **Quiescence / atomic verify hardening** — complete（Gate 1 CONDITIONAL；release binding 需真实 semver tag CI）
   - 同 databaseName adapter 共享 RootCoordinator；root freeze hooks、mutation lease 与最终 readwrite Tv
   - terminal verification receipt 原子绑定 audit hash、root revision、journal hash、lease generation/token digest
   - durable purge watermark 与 frozen-tab visibility catch-up；补充 Playwright/response-loss/TOCTOU regression
   - 三维 YT review 与 PR/nightly gates 已完成；release binding 保留真实 semver tag CI 条件；本阶段以最终原子提交/push 交付

## 关键约束
- deep-research 任意时刻并行 subagent ≤ 7；子代理不得再派子代理。
- 外部调研内容只进入 `findings.md` 或最终研究报告，不写入本计划。
- 评审最多 5 轮，评分仅供比较，不作为硬门禁。
- 高风险桌面行为默认不执行；本地优先、可验证、可回滚。
- 不擅自提交 Git commit。

## 遇到的错误
| 错误 | 尝试次数 | 解决方案 |
|---|---:|---|
| `git status` 失败：当前目录不是 Git 仓库 | 1 | 将项目视为无版本库绿地目录，不再依赖 Git 元数据 |
| 内置 WebSearch 缺少 `DEEPSEEK_API_KEY` | 1 | 已委派带独立搜索能力的受控研究代理；主代理不重复同一失败调用 |
| 连续编辑同一文件触发“文件已变化”观察保护 | 2 | 每次后续编辑前重新读取，或合并为一次替换 |
| FTC 页面直取返回 403 | 1 | 未绕过站点限制；正式报告不依赖该未核验引文 |
| `pdftotext` 不可用 | 1 | 使用可直接读取的 HTML/Markdown/摘要来源核验，不重复转换 |
| 4 个文档代理长时间读取超长原始 PRD 且未产出 | 1 | 中断原 turn，复用同一代理并缩小为研究报告+一致性基线，限制篇幅后直接写文件 |
| planning skill 引用的 `scripts/session-catchup.py` 不存在 | 2 | 已手工读取三份规划文件与 goal/file 状态完成恢复，不伪造脚本结果 |
| 六件套品牌基线首次校验失败（ARCH/CHECKPOINT/EVAL 缺产品全名） | 2 | 在三个文档头部补充 `ProAGI Assistant` 后重跑，六文件校验通过 |
| impossible timestamp 测试的字段路径预期漏写 `/` | 1 | 按实际固定错误路径改为 `/occurredAt` 后通过 |
| target-lineage 删除最初比较了 wrapper hash 与 claim hash | 1 | 改为校验 payload claim hash、用 wrapper hash执行存储删除 |
| target-lineage audit 首次发现 application runtime 仍持有 report claim ID | 1 | 注册运行时 root 并在 audit 前同时释放 claim 与 report 引用 |
| `test-results/verify-pr.log` 被 Playwright output 清理 | 1 | 日志迁移至独立 `evidence-logs/verify-pr.log` 并重跑完整门禁 |
