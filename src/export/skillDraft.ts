// Ontology Phase 2 export: SkillCandidate -> SKILL.md frontmatter 草稿（纯生成函数）。
// 映射依据：mappings/proagi.yaml（SkillCandidate.canonical = Skill candidate，NOT Skill；
//          成熟后才可导出为 SkillPackage/SKILL.md）。
// 铁律：本函数只产出"草稿"文本，绝不发布、不落盘、不注册——是否成熟化由人决定。
// SkillCandidate ≠ Skill：候选是学习产物，Skill 是成熟导出。
import type { SkillCandidate } from '../domain/types';

export function exportSkillFrontmatterDraft(candidate: SkillCandidate): string {
  const lines: string[] = [
    '---',
    `name: ${skillDraftName(candidate)}`,
    `description: ${yamlQuoted(candidate.purpose)}`,
    'version: 0.1.0-draft',
    '# status: draft —— 候选草稿，不等于已发布 Skill（SkillCandidate ≠ Skill）',
    'status: draft',
    'provenance:',
    '  product: proagi',
    `  skillCandidateId: ${yamlQuoted(candidate.id)}`,
    `  workflowKey: ${yamlQuoted(candidate.workflowKey)}`,
    `  revision: ${candidate.revision}`,
    `  actionIntentRevisionId: ${yamlQuoted(candidate.actionIntentRevisionId)}`,
    `  trigger: ${yamlQuoted(candidate.triggerSummary)}`,
    `  estimatedBenefitMinutes: ${candidate.estimatedBenefitMinutes}`,
    `  risk: ${candidate.risk}`,
    `  confidence: ${candidate.confidence}`,
    `  inputs: [${candidate.inputNames.map(yamlQuoted).join(', ')}]`,
    `  outputs: [${candidate.outputNames.map(yamlQuoted).join(', ')}]`,
    `  evidenceCount: ${candidate.evidence.length}`,
    `  localStatus: ${candidate.status}`,
    `  contentHash: ${yamlQuoted(candidate.contentHash)}`,
    '---',
  ];
  return `${lines.join('\n')}\n`;
}

/** SKILL.md 的 name 需为 slug；从候选名派生，失败回退 workflowKey 派生。 */
export function skillDraftName(candidate: SkillCandidate): string {
  const slug = (value: string): string =>
    value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug(candidate.name) || slug(candidate.workflowKey) || 'unnamed-skill-draft';
}

function yamlQuoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}
