# M3 Runtime 与 Markdown Projection

2026-09-08：M3a/M3b 工程实现已完成。M2 participant pilot 与真实 live-model evaluation `NOT_RUN`；本次不改变 Gate 2，也不宣称 Gate 3 全面放行。

## M3a Runtime

`IsolatedRuntime` 实现 typed RuntimePort；`FakeRuntimeAdapter` 与 `CodexAppServerAdapter` 共用契约。应用负责 capability、独立出站确认、privacy epoch、deadline（最多 5 分钟）、幂等和结果校验；provider 只返回待验证的数据。

首个任务严格收敛为 structured-evaluation，input 仅含 event/episode/proposed/confirmed/rejected 五个计数。`minimalEvaluationInput` 从当前 live Core snapshot 产生计数；项目名、claim 正文、证据、原始事件和来源标识均不进入请求。返回值只有 verdict/confidence/reasonCode，不自动提交为知识或动作。M2 读取授权不能代替 Runtime 出站确认。

每个端口实例最多保存 128 个幂等条目，达到上限需 dispose/recreate；不驱逐旧 key 后重发。取消/超时只产生一个 terminal result，迟到成功和重复响应不能覆盖它。result/cancel 在 await 后再次核对原 job 的 caller/epoch；出站前复核绝对 deadline，避免计时器尚未调度时发送过期任务。关闭实例清除结果缓存。审计只含 request/correlation ID、阶段、字段数与字节数；出站审计失败不调用 provider，错误正文不向外传播。

真实 adapter 使用 loopback WebSocket、每次独立 ephemeral thread、read-only sandbox、受限读根、关闭 shell/web/apps/plugins 配置，并拒绝 server tool/approval 请求。Codex Thread/Turn/Item DTO 仅在 adapter 内存在。当前兼容范围锁定本机 `codex-cli 0.153.x`；其他版本 fail closed，需重新验协议。初始化握手校验平台字段和版本后发布该 adapter 支持的能力。

协议依据：[官方 Codex app-server 文档](https://learn.chatgpt.com/docs/app-server)，并用本机 `codex-cli 0.153.4 app-server generate-ts` 核对字段。生成的协议文件仅留在 ignored `test-results/m3/protocol`，不将 provider 类型引入 Core。

可复现验证：

```sh
npm run test:runtime-contract
npm run test:runtime-faults
npm run eval -- --suite runtime-isolation
codex app-server --listen ws://127.0.0.1:4513
# 在另一终端执行：
npm run smoke:runtime -- --endpoint ws://127.0.0.1:4513
```

真实 smoke 仅握手，未创建 thread、未调用模型、未传出用户数据；证据明确写 `liveModelEvaluation: NOT_RUN`。完整真实 provider 任务和进程内策略有效性验收仍需受控试点。生产 Web App 默认不实例化 Runtime；后续设置入口需要独立出站确认及生命周期关闭处理。

## M3b Projection

`MarkdownProjectionAdapter` 实现 ProjectionPort，输出一个 Obsidian 可读的 `proagi-knowledge.md`。保留 claim 状态（inferred/user-confirmed）、revision、scope、confidence、证据及反证引用；转义 HTML、远程图片与 Obsidian embed 语法。只投影结构化 claim，不写回 canonical store。

- `rebuild()`：每次 adapter 冷启动先从 IndexedDB 真相源全量生成，不把自洽重算 hash 的缓存当作真相；实例只记住自己发布的 head hash。此后用 `loadChangesSince` 读取变更，正常纠正仅加载改变的 claim；缺口、删除、epoch/incarnation 变化、超出 delta 上限时全量重建。
- 发布同事务复核 canonical cursor/epoch/incarnation、原 projection hash 和 sourceCursor，阻止旧结果以及同游标并发覆盖。projection payload 与 Markdown hash 均校验，手工编辑冲突不覆盖。
- 托管投影保留结构化 claim/evidence 引用，M1 DeletionPlan 的既有 reachability 扫描可清除全部相关投影；重建只能使用仍然 live 的 canonical records。
- `export()`：需独立 `projection.export`、用户确认当前内容 hash，以及不可撤回确认；持有 root mutation lease 至 artifact 交接，并复核 cursor/epoch/incarnation。返回 Markdown artifact，不自行触发下载或写 Obsidian vault。已下载副本不能远程撤回。
- `disable()` 仅关闭本 adapter。本地读取、纠正和 Replay 继续工作。

增量 change log 当前复用既有字符串游标索引并按数值排序；metadata-only cursor gap 保守触发全量重建。生产 AppShell 提供 opt-in 重建、增量/全量重建、状态与 Markdown 预览，以及带 hash/不可逆确认的浏览器下载；投影异常只关闭投影。尚不新增 SQLite、持续 vault 同步、第二种投影或自动 OS/Vault 写入；E2E hook 仍仅在测试构建启用，生产 artifact gate 检查其移除。

```sh
npm run test:projection
npm run eval -- --suite projection-isolation
npx playwright test tests/e2e/m3-projection.spec.ts
```

## 独立验收与后续

自动化报告由 `eval` 校验非空 Vitest JSON 后输出到 `test-results/m3a/<run>/`、`test-results/m3b/<run>/`；runtime suite 已加入 PR 必需套件。真实握手证据为 `test-results/m3/runtime-smoke.json`，Chromium 报告由现有 Playwright runner 生成。

提交前复查增加了跨 turn 响应、返回时 epoch 变更、过期出站、投影缓存重算 hash、同 cursor 新 incarnation 和 adapter 替换后的授权隔离回归。报告校验绑定实际必需测试文件，不能用无关的绿色测试替代。M3a 独立评估 24/24，M3b 9/9，均保持 CONDITIONAL。

验证中发现既有 a11y 测试未等待数据库启动，已与集成测试统一就绪等待。首次 Chromium 桌面删除场景出现 runtime fault，失败 trace 保留于 `test-results/local-1788832116748-31796/`；补充错误码附件后两种视口各重复两次通过。另以确定性测试复现并修复 lease renewal 遇到正常 purge quiescence 被误判为致命故障，真正的 storage fault 仍保持阻断。Windows release-gates 为 14 PASS / 1 既有平台限定 SKIP；本轮不宣称完整 release gate PASS。

最终代码验证：161/161 单测通过，M3b 生产入口与 M2 readonly consent/revoke/retention-shortening 路径锁定 Chromium 两个项目 32/32 通过；M2 精确文件评估 7/7，pilot evidence tooling 6/6。lint、TypeScript、production build 和 production artifact 检查通过。并行负载下旧删除压力用例曾触及原 20 秒限制；停止并行验证后在 13.8 秒通过，未修改测试限制。

Gate 3a / 3b 各自保持 CONDITIONAL；后续是受控真实模型任务验收与 M2 participant pilot。Runtime 可独立 dispose，Projection 可独立 disable；不会因一个子门通过而替另一个放行。M4 真实动作仍未实现。
