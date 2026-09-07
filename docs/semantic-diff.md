# ProAGI × Canonical Ontology — Semantic Diff

> Ontology 统一 Phase 2（Compatible）产出。基准：`YT-Agent-Ontology`（ACTION-SPEC v0.1 / MEMORY-SPEC v0.1 / mappings/proagi.yaml）。
> 本文档记录**语义对齐与残余差异**，只描述、不重命名——内部术语一律保留（迁移铁律）。

## 1. 实体级语义对照

| ProAGI 内部概念 | Canonical 概念 | 对齐状态 | 差异说明 |
|---|---|---|---|
| BehaviorEvent | Observation(kind:"event") | ✅ 已对齐（导出层 `src/export/observation.ts`） | canonical 顶层字段严格 7 项；本地 kind 改名 `content.eventKind` 避免与 canonical kind 混淆 |
| WorkModelClaim | Knowledge.Claim（元模型） | ✅ 已对齐（导出层 `src/export/claim.ts`） | ProAGI 是 Claim 元模型源头；导出是信封投影，不替代本地 revision 机制 |
| Episode | Memory.EpisodicMemory | ✅ 已对齐（导出层 `src/export/episode.ts`，Phase 3） | layer:"episodic"；eventRefs 复用 Phase 2 的 `observation:proagi:<eventId>` 保持导出层引用一致 |
| Question | Intent.Question | ⬜ 未导出 | learning gap 语义一致，导出待后续阶段 |
| SkillCandidate | Skill candidate（NOT Skill） | ✅ 语义已澄清 | 成熟导出为 SKILL.md frontmatter **草稿**（`src/export/skillDraft.ts`），纯生成、不发布 |
| ActionIntent(mode:"shadow") | Action(mode:"shadow") | ✅ 语义已澄清 | shadow 是 canonical `Action.mode`，**不是**待删除的过渡物；无需导出转换 |
| EvidenceRef | Artifact(kind=evidence) | ✅ 已对齐（导出层 `src/export/artifact.ts`，Phase 3） | Artifact 信封补齐 uri（调用方显式提供）/hash(entityHash)/verification/provenance(transform+role) 元数据；`evidence:proagi:*` 指针仍用于 Claim/Memory 内的轻量引用 |
| KnowledgeSnapshot/Version/Head | Knowledge 版本化模型 | ✅ 即 Canonical | 无需导出转换（源头吸收） |
| CorrectionCommand/Record | Knowledge.Correction | ⬜ 未导出 | 导出信封 `corrections` 恒为 `[]`，修正史导出待后续 |
| DailyReportSnapshot | Artifact(kind=report) | ✅ 已对齐（导出层 `src/export/artifact.ts`，Phase 3） | id=`artifact:proagi:report/<id>`；本地元数据收敛进 provenance.local |

## 2. 状态词汇映射（Claim）

canonical status 词汇 = `proposed | confirmed | revised | refuted`（MEMORY-SPEC §5），本地 = `proposed | confirmed | rejected | invalidated`：

| 本地 ClaimStatus | canonical status | 备注 |
|---|---|---|
| proposed | proposed | 直映 |
| confirmed | confirmed | 直映 |
| rejected | refuted | 反证成立 |
| invalidated | refuted | 本义是 lineage 删除/tombstone，canonical 暂无对应词汇；原值保留在 `provenance.localStatus`，不丢失信息 |

⚠️ 这映射是**导出投影约定**，不是内部模型改动；canonical 若未来吸收 `deleted`（见母仓 findings L186 六态统一建议），此处应同步更新。

## 3. 字段级差异（导出投影内）

- Observation：本地 `subject {appId, projectKey}` → canonical `subject: "app:<appId>[/<projectKey>]"` 字符串 URI；`environmentRef` 默认 `environment:proagi:workstation`（部署侧可用 options 覆盖，规范示例为 `environment:yt:win-chrome-01`）。
- Observation content：保留 `factHash`/`dedupeKey`/`privacy`（classification=local-sensitive）——**显式导出不等于放弃隐私标注**，接收方应尊重该标注。
- Claim：`revision` → `version`；`id`（revision id）→ `head`；`claimKey` → `claim:proagi:<claimKey>` 作 id；其余本地元数据全部收敛进 `provenance`。
- Artifact（Phase 3）：`EvidenceRef.entityHash` → `hash`；`transform` → `provenance.transform`；`uri` 仅由调用方显式提供（本地 evidence/M1 目录结构是 Canonical Evidence 参考，但不自动推断路径）；`verification` 默认 `unverified`，绝不谎报已验证。
- EpisodicMemory（Phase 3）：`eventIds` → `eventRefs`（`observation:proagi:<eventId>`，与 Phase 2 Observation id 同源）；`segmentationVersion` 留档 provenance。

## 4. 残余漂移风险

1. **Observation 双格式漂移**（与 InPeak）：InPeak 侧 kind=dom/network/visual，ProAGI 只产 kind=event；跨产品断言（同一 schema 解析）排 PHASE 9，schema 已在 `src/export/schemas.ts` 导出可复用。
2. **environmentRef 词汇表**：目前仅约定格式（`environment:<scope>:<id>`），生态级环境注册表未建立。
3. **corrections 导出为空**：CorrectionRecord 结构在导出信封中的 canonical 形状未定，先恒 `[]`。
4. **artifact id 段数不统一**：evidence 类为 3 段（`artifact:proagi:evidence/<type>/<id>`）、report 类为 2 段（`artifact:proagi:report/<id>`）；规范示例（`artifact:yt:report-001`）未约束段数，生态统一词汇表落地时需复核。

## 5. 明确不做（Phase 2+3 禁区遵守情况）

- ❌ 未改 insightLoop / KnowledgePort / ShadowActionSink 任何逻辑
- ❌ 未重命名任何内部术语（BehaviorEvent 等原义保留，canonical 形状仅在 `src/export/` 内）
- ❌ 未引入自动外发：全部导出为显式调用纯函数，无 I/O、无时钟、无随机
- ❌ 未把 shadow 模式当过渡物
- ❌ Artifact 导出不自动落盘/不自动推断 uri（evidence/M1 目录由既有流程管理，导出层只做投影）
