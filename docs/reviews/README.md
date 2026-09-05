# ProAGI 六件套 REVIEW 协议

## 范围

每轮同时审查：

- `docs/final/PRD.md`
- `docs/final/SPEC.md`
- `docs/final/ARCH.md`
- `docs/final/PLAN.md`
- `docs/final/CHECKPOINT.md`
- `docs/final/EVAL.md`

参考证据：`docs/research/deep-research-report.md`、原始 PRD 与 `reference/Prototype reference1.png`。

## 固定规则

1. 每轮由三个互不依赖的 reviewer 并行执行：
   - A：质量与需求可验证性；
   - B：效率、架构与可实施性；
   - C：复用性、跨文档一致性与演进边界。
2. 主代理补充六类盲区：幂等、安全、可观测性、数据完整性、并发/竞态、外部依赖韧性。
3. 每个问题必须提供文件、章节/行号、证据、优先级和具体修订建议。
4. 分数用于比较修订趋势，不作为 8/10 硬门禁；P0、隐私不变量、删除级联和 Shadow-only 违例必须处理。
5. 每轮先保存 `round-N.md`，再修订六件套；下一轮必须审查修订后的当前版本。
6. 达到第 5 轮立即停止继续 review，不因分数追加第 6 轮；主代理对五轮建议按证据、风险和一致性择优缝合，并保存 `final-stitch.md`。

## 五轮关注点

### Round 1 — 需求完整性与可验收性

检查目标用户/JTBD、范围、非目标、术语、用户流程、验收条件以及 synthetic 与真实价值之间的边界。

### Round 2 — 数据、隐私与安全

检查 schema、provenance、revision、删除级联、字段白名单、fail-closed、跨用户隔离、权限和 Shadow-only。

### Round 3 — 架构、性能与韧性

检查 Ports/Adapters、依赖方向、确定性 Replay、幂等、错误分类、并发、存储、迁移、可观测性和外部协议隔离。

### Round 4 — UI/UX、无障碍与 EVAL

检查指定参考图六态、状态非颜色表达、键盘/reduced-motion、隐私控制、指标公式、fixture、失败注入和 reward hacking。

### Round 5 — 对抗式集成与最终取舍

从“实现者会误读什么、测试会漏什么、文档互相冲突什么”出发做最终审查；列出保留/拒绝/合并建议，随后停止迭代并执行最终缝合。

## 每轮报告模板

```markdown
# REVIEW Round N

## 三维评分
- 质量与可验证性：X/10
- 效率与可实施性：X/10
- 复用性与一致性：X/10

## Findings
| ID | Priority | File/Section | Evidence | Fix |

## 六类盲区
...

## 本轮采纳与拒绝
...

## 修订验证
...
```
