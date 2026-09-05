import { hashCanonical, semanticId } from './canonical';
import type {
  ActionIntent, ActivityKind, BehaviorEvent, DailyReportSnapshot, Episode, EvidenceRef,
  InsightLoopOutput, KnowledgeSnapshot, Question, Scope, SkillCandidate, WorkModelClaim,
} from './types';
import { FORBIDDEN_EFFECTS } from './types';

const THIRTY_MINUTES = 30 * 60 * 1000;

export function compareBehaviorEvents(a: BehaviorEvent, b: BehaviorEvent): number {
  return a.occurredAt.localeCompare(b.occurredAt)
    || a.kind.localeCompare(b.kind)
    || a.factHash.localeCompare(b.factHash)
    || a.dedupeKey.localeCompare(b.dedupeKey)
    || a.contentHash.localeCompare(b.contentHash);
}

export function dedupeAndSortEvents(events: readonly BehaviorEvent[]): readonly BehaviorEvent[] {
  const byDedupe = new Map<string, BehaviorEvent>();
  for (const event of events) {
    const previous = byDedupe.get(event.dedupeKey);
    if (previous && previous.contentHash !== event.contentHash) throw new Error('ERR_DUPLICATE_CONFLICT');
    if (!previous) byDedupe.set(event.dedupeKey, event);
  }
  return [...byDedupe.values()].sort(compareBehaviorEvents);
}

export function segmentEpisodes(input: readonly BehaviorEvent[]): readonly Episode[] {
  const events = dedupeAndSortEvents(input);
  const groups: BehaviorEvent[][] = [];
  for (const event of events) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    const projectChanged = previous?.subject.projectKey !== event.subject.projectKey;
    const gap = previous ? Date.parse(event.occurredAt) - Date.parse(previous.occurredAt) : 0;
    if (!current || projectChanged || gap > THIRTY_MINUTES) groups.push([event]);
    else current.push(event);
  }
  return groups.map(buildEpisode);
}

function buildEpisode(events: readonly BehaviorEvent[]): Episode {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) throw new Error('ERR_SCHEMA_INVALID');
  const activityKind = inferActivityKind(events);
  const evidence = events.map((event): EvidenceRef => ({
    entityType: 'behavior_event', entityId: event.id, entityHash: event.contentHash, role: 'support',
    transform: { name: 'segment-v1', version: '1.0.0', inputHash: event.factHash },
  }));
  const semantic = {
    schemaVersion: '1.0.0' as const,
    startAt: first.occurredAt,
    endAt: last.occurredAt,
    title: episodeTitle(first.subject.projectKey, activityKind),
    ...(first.subject.projectKey ? { projectKey: first.subject.projectKey } : {}),
    activityKind,
    eventIds: events.map((event) => event.id),
    evidence,
    confidence: 1,
    segmentationVersion: 'segment-v1' as const,
    status: 'final' as const,
  };
  return Object.freeze({ ...semantic, id: semanticId('episode-v1', semantic), contentHash: hashCanonical(semantic) });
}

function inferActivityKind(events: readonly BehaviorEvent[]): ActivityKind {
  if (events.some((event) => event.kind === 'test.completed')) return 'test';
  if (events.some((event) => event.attributes.commandClass === 'build')) return 'build';
  if (events.some((event) => event.kind === 'file.changed')) return 'code';
  if (events.some((event) => event.subject.appId === 'browser')) return 'research';
  return 'other';
}

function episodeTitle(projectKey: string | undefined, activity: ActivityKind): string {
  return `${projectKey ?? 'unscoped'} · ${activity}`;
}

export interface RunInsightLoopOptions {
  readonly asOf: string;
  readonly timezone: string;
  readonly knowledge?: KnowledgeSnapshot;
}

export function runInsightLoop(eventsInput: readonly BehaviorEvent[], options: RunInsightLoopOptions): InsightLoopOutput {
  const events = dedupeAndSortEvents(eventsInput);
  const episodes = segmentEpisodes(events);
  const proposedClaims = inferClaims(episodes, events);
  const claims = applyKnowledge(proposedClaims, options.knowledge);
  const questions = inferQuestions(episodes, events);
  const { skills, intents } = inferSkills(episodes, events);
  const report = buildReport(episodes, claims, questions, skills, options.asOf, options.timezone);
  const semantic = { events, episodes, claims, questions, skillCandidates: skills, actionIntents: intents, report };
  return Object.freeze({ ...semantic, snapshotHash: hashCanonical(semantic) });
}

function inferClaims(episodes: readonly Episode[], events: readonly BehaviorEvent[]): readonly WorkModelClaim[] {
  const projects = [...new Set(events.map((event) => event.subject.projectKey).filter((value): value is string => Boolean(value)))].sort();
  return projects.flatMap((projectKey) => {
    const scoped = events.filter((event) => event.subject.projectKey === projectKey);
    const changedIndexes = scoped.flatMap((event, index) => event.kind === 'file.changed' ? [index] : []);
    const passedIndexes = scoped.flatMap((event, index) => event.kind === 'test.completed' && event.attributes.testOutcome === 'passed' ? [index] : []);
    const hasOrderedPair = changedIndexes.some((changedIndex) => passedIndexes.some((passedIndex) => passedIndex > changedIndex));
    if (!hasOrderedPair) return [];
    const scope: Scope = { projectKey, activityKind: 'test' };
    const episodeEvidence = episodes.filter((episode) => episode.projectKey === projectKey).map(episodeRef);
    const semantic = {
      schemaVersion: '1.0.0' as const,
      claimKey: `claim:test-after-change:${projectKey}`,
      semanticKey: `workflow-v1:test-after-change:${projectKey}:test`,
      predicateId: 'test-after-change-v1',
      revision: 1,
      statement: `在 ${projectKey} 修改代码后运行测试`,
      scope,
      confidence: 0.9,
      evidence: episodeEvidence,
      counterEvidence: [] as readonly EvidenceRef[],
      status: 'proposed' as const,
    };
    return [Object.freeze({ ...semantic, id: semanticId('claim-v1', semantic), contentHash: hashCanonical(semantic) })];
  });
}

function inferQuestions(episodes: readonly Episode[], events: readonly BehaviorEvent[]): readonly Question[] {
  const failed = events.find((event) => event.kind === 'test.completed' && event.attributes.testOutcome === 'failed');
  if (!failed) return [];
  const episode = episodes.find((candidate) => candidate.eventIds.includes(failed.id));
  if (!episode) return [];
  const scope: Scope = { ...(episode.projectKey ? { projectKey: episode.projectKey } : {}), activityKind: 'test' };
  const semantic = {
    schemaVersion: '1.0.0' as const,
    workflowKey: `question:test-failure:${episode.projectKey ?? 'unscoped'}`,
    revision: 1 as const,
    prompt: '这次测试失败是否阻塞了当前工作？',
    gapType: 'error' as const,
    scope,
    evidence: [episodeRef(episode)],
    expectedInformationGain: 0.8,
    status: 'queued' as const,
  };
  return [Object.freeze({ ...semantic, id: semanticId('question-v1', semantic), contentHash: hashCanonical(semantic) })];
}

function inferSkills(episodes: readonly Episode[], events: readonly BehaviorEvent[]): {
  readonly skills: readonly SkillCandidate[]; readonly intents: readonly ActionIntent[];
} {
  const projects = [...new Set(events.filter((event) => event.kind === 'test.completed' && event.attributes.testOutcome === 'passed')
    .map((event) => event.subject.projectKey).filter((value): value is string => Boolean(value)))].sort();
  const skills: SkillCandidate[] = [];
  const intents: ActionIntent[] = [];
  for (const projectKey of projects) {
    const evidence = episodes.filter((episode) => episode.projectKey === projectKey).map(episodeRef);
    if (evidence.length === 0) continue;
    const workflowKey = `skill:daily-test-summary:${projectKey}`;
    const intentSemantic = {
      schemaVersion: '1.0.0' as const,
      workflowKey,
      revision: 1 as const,
      mode: 'shadow' as const,
      summary: `预览 ${projectKey} 的测试摘要步骤`,
      preconditions: ['存在已完成的白名单测试事件'],
      hypotheticalSteps: [{ order: 1, description: '汇总测试结果', effect: '仅生成本地预览' }],
      expectedEffects: ['展示一份无外部副作用的摘要预览'],
      forbiddenEffects: FORBIDDEN_EFFECTS,
      status: 'draft' as const,
    };
    const intent: ActionIntent = Object.freeze({
      ...intentSemantic,
      id: semanticId('action-intent-v1', intentSemantic),
      contentHash: hashCanonical(intentSemantic),
    });
    const skillSemantic = {
      schemaVersion: '1.0.0' as const,
      workflowKey,
      revision: 1 as const,
      name: `${projectKey} 测试摘要候选`,
      purpose: '减少每日工程总结中的测试结果整理步骤',
      triggerSummary: '检测到已完成的测试事件时提出预览',
      inputNames: ['test-events'],
      outputNames: ['shadow-preview'],
      evidence,
      estimatedBenefitMinutes: 5,
      risk: 'low' as const,
      confidence: 0.8,
      actionIntentRevisionId: intent.id,
      status: 'proposed' as const,
    };
    intents.push(intent);
    skills.push(Object.freeze({ ...skillSemantic, id: semanticId('skill-v1', skillSemantic), contentHash: hashCanonical(skillSemantic) }));
  }
  return { skills, intents };
}

function applyKnowledge(proposed: readonly WorkModelClaim[], knowledge: KnowledgeSnapshot | undefined): readonly WorkModelClaim[] {
  if (!knowledge) return proposed;
  return proposed.flatMap((claim) => {
    if (knowledge.deletedClaimKeys.includes(claim.claimKey)) return [];
    const head = knowledge.heads.find((candidate) => candidate.knowledgeKey === claim.claimKey);
    const version = head && knowledge.versions.find((candidate) => candidate.id === head.versionId);
    const learned = version && knowledge.claims.find((candidate) => candidate.id === version.claimRevisionId);
    if (!learned) return [claim];
    if (learned.semanticKey === claim.semanticKey && learned.status === 'rejected') return [];
    if (learned.scope.projectKey === claim.scope.projectKey && learned.status === 'confirmed') return [learned];
    return [claim];
  }).sort((a, b) => a.semanticKey.localeCompare(b.semanticKey));
}

function buildReport(
  episodes: readonly Episode[], claims: readonly WorkModelClaim[], questions: readonly Question[],
  skills: readonly SkillCandidate[], asOf: string, timezone: string,
): DailyReportSnapshot {
  const localDate = asOf.slice(0, 10);
  const evidence = episodes.map(episodeRef);
  const semantic = {
    schemaVersion: '1.0.0' as const,
    projectionVersion: 'daily-report-v1' as const,
    localDate,
    timezone,
    episodeIds: episodes.map((episode) => episode.id),
    sections: {
      work: episodes.map((episode) => ({ episodeId: episode.id, summary: episode.title })),
      learnedClaimIds: claims.map((claim) => claim.id),
      questionIds: questions.map((question) => question.id),
      skillCandidateIds: skills.map((skill) => skill.id),
    },
    evidence,
    status: 'published' as const,
  };
  return Object.freeze({ ...semantic, id: semanticId('report-v1', semantic), contentHash: hashCanonical(semantic) });
}

function episodeRef(episode: Episode): EvidenceRef {
  return {
    entityType: 'episode', entityId: episode.id, entityHash: episode.contentHash, role: 'support',
    transform: { name: 'insight-v1', version: '1.0.0', inputHash: episode.contentHash },
  };
}
