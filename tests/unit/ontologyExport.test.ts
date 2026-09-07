import { describe, expect, it } from 'vitest';
import { hashCanonical } from '../../src/domain/canonical';
import { materializeBehaviorEvents, parseFixtureJson } from '../../src/domain/fixture';
import type { BehaviorEvent, EvidenceRef, WorkModelClaim } from '../../src/domain/types';
import {
  canonicalClaimSchema,
  canonicalObservationSchema,
  exportClaim,
  exportObservation,
  exportSkillFrontmatterDraft,
  toCanonicalClaimStatus,
} from '../../src/export';

function fixtureEvents(): readonly BehaviorEvent[] {
  const utf8 = JSON.stringify({
    schemaVersion: '1.0.0',
    fixtureId: 'export-test',
    adapterId: 'synthetic-fixture',
    adapterVersion: '1.0.0',
    events: [
      {
        sourceItemKey: 'evt-001',
        occurredAt: '2026-09-07T08:00:00.000Z',
        kind: 'file.changed',
        subject: { appId: 'vscode', projectKey: 'proagi' },
        attributes: { fileExt: 'ts', operation: 'modify', durationMs: 1200 },
      },
      {
        sourceItemKey: 'evt-002',
        occurredAt: '2026-09-07T08:05:00.000Z',
        kind: 'terminal.completed',
        subject: { appId: 'terminal' },
        attributes: { commandClass: 'test', exitCode: 0, testOutcome: 'passed' },
      },
    ],
  });
  return materializeBehaviorEvents(parseFixtureJson(utf8));
}

function evidenceRef(entityType: EvidenceRef['entityType'], entityId: string, role: EvidenceRef['role']): EvidenceRef {
  return {
    entityType,
    entityId,
    entityHash: hashCanonical({ entityType, entityId }),
    role,
    transform: { name: 'test', version: '1.0.0', inputHash: hashCanonical({ seed: entityId }) },
  };
}

function claimFixture(overrides: Partial<WorkModelClaim> = {}): WorkModelClaim {
  return {
    schemaVersion: '1.0.0',
    id: 'claim-rev-42',
    claimKey: 'claim.tests-green-before-commit',
    semanticKey: 'tests-green-before-commit',
    predicateId: 'predicate.workflow.discipline',
    parentRevisionId: 'claim-rev-41',
    revision: 3,
    statement: 'Commit only after the full test suite is green.',
    scope: { projectKey: 'proagi', activityKind: 'code' },
    confidence: 0.82,
    evidence: [evidenceRef('episode', 'ep-1', 'support'), evidenceRef('behavior_event', 'evt-001', 'support')],
    counterEvidence: [evidenceRef('behavior_event', 'evt-002', 'counter')],
    status: 'confirmed',
    contentHash: hashCanonical({ statement: 'Commit only after the full test suite is green.' }),
    ...overrides,
  };
}

describe('exportObservation (ACTION-SPEC §2 alignment)', () => {
  it('maps BehaviorEvent to canonical Observation and passes schema validation', () => {
    const [first] = exportObservation(fixtureEvents());
    expect(first).toMatchObject({
      id: `observation:proagi:${fixtureEvents()[0]?.id}`,
      environmentRef: 'environment:proagi:workstation',
      subject: 'app:vscode/proagi',
      kind: 'event',
      ts: '2026-09-07T08:00:00.000Z',
    });
    expect(first?.content.eventKind).toBe('file.changed');
    expect(first?.content.attributes).toEqual({ fileExt: 'ts', operation: 'modify', durationMs: 1200 });
    expect(first?.content.privacy).toEqual({
      classification: 'local-sensitive',
      policyVersion: 'allowlist-v1',
      redactionCount: 0,
    });
    expect(() => canonicalObservationSchema.parse(first)).not.toThrow();
  });

  it('omits evidence field when there is none and prefixes subject by appId only', () => {
    const [, second] = exportObservation(fixtureEvents());
    expect(second?.subject).toBe('app:terminal');
    expect('evidence' in (second ?? {})).toBe(false);
  });

  it('honors the environmentRef override', () => {
    const [first] = exportObservation(fixtureEvents(), { environmentRef: 'environment:proagi:hexu-desktop' });
    expect(first?.environmentRef).toBe('environment:proagi:hexu-desktop');
    expect(() => canonicalObservationSchema.parse(first)).not.toThrow();
  });

  it('rejects malformed environmentRef in schema', () => {
    const [first] = exportObservation(fixtureEvents(), { environmentRef: 'not-an-environment-ref' });
    expect(() => canonicalObservationSchema.parse(first)).toThrow();
  });

  it('is deterministic and frozen (explicit export, no I/O/clock/randomness)', () => {
    const events = fixtureEvents();
    expect(exportObservation(events)).toEqual(exportObservation(events));
    const [first] = exportObservation(events);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.content)).toBe(true);
  });
});

describe('exportClaim (MEMORY-SPEC §5 alignment)', () => {
  it('maps WorkModelClaim to canonical Claim envelope and passes schema validation', () => {
    const canonical = exportClaim(claimFixture());
    expect(canonical).toMatchObject({
      id: 'claim:proagi:claim.tests-green-before-commit',
      statement: 'Commit only after the full test suite is green.',
      confidence: 0.82,
      status: 'confirmed',
      version: 3,
      head: 'claim-rev-42',
    });
    expect(canonical.evidence).toHaveLength(2);
    expect(canonical.evidence[0]).toEqual({
      ref: 'evidence:proagi:episode/ep-1',
      role: 'support',
      entityHash: hashCanonical({ entityType: 'episode', entityId: 'ep-1' }),
    });
    expect(canonical.counterEvidence).toEqual([
      {
        ref: 'evidence:proagi:behavior_event/evt-002',
        role: 'counter',
        entityHash: hashCanonical({ entityType: 'behavior_event', entityId: 'evt-002' }),
      },
    ]);
    expect(canonical.provenance).toMatchObject({
      product: 'proagi',
      localClaimId: 'claim-rev-42',
      claimKey: 'claim.tests-green-before-commit',
      parentRevisionId: 'claim-rev-41',
      localStatus: 'confirmed',
    });
    expect(() => canonicalClaimSchema.parse(canonical)).not.toThrow();
  });

  it('maps status vocabulary: proposed/confirmed direct, rejected/invalidated -> refuted', () => {
    expect(toCanonicalClaimStatus('proposed')).toBe('proposed');
    expect(toCanonicalClaimStatus('confirmed')).toBe('confirmed');
    expect(toCanonicalClaimStatus('rejected')).toBe('refuted');
    expect(toCanonicalClaimStatus('invalidated')).toBe('refuted');
    const refuted = exportClaim(claimFixture({ status: 'rejected' }));
    expect(refuted.status).toBe('refuted');
    expect(refuted.provenance.localStatus).toBe('rejected');
  });

  it('keeps corrections empty in Phase 2 and omits parentRevisionId when absent', () => {
    const orphan = exportClaim(claimFixture({ parentRevisionId: undefined }));
    expect(orphan.corrections).toEqual([]);
    expect('parentRevisionId' in orphan.provenance).toBe(false);
  });
});

describe('exportSkillFrontmatterDraft (SkillCandidate ≠ Skill)', () => {
  it('generates a draft-only SKILL.md frontmatter block', () => {
    const candidate = {
      schemaVersion: '1.0.0' as const,
      id: 'skill-cand-1',
      workflowKey: 'wf.run-tests-before-commit',
      revision: 1 as const,
      name: 'Run Tests Before Commit',
      purpose: 'Avoid committing when the test suite is red.',
      triggerSummary: 'git.changed followed by terminal.completed(commandClass=test)',
      inputNames: ['git.changed', 'test.completed'],
      outputNames: ['commit.advice'],
      evidence: [evidenceRef('episode', 'ep-9', 'support')],
      estimatedBenefitMinutes: 12,
      risk: 'low' as const,
      confidence: 0.74,
      actionIntentRevisionId: 'intent-1',
      status: 'proposed' as const,
      contentHash: hashCanonical({ id: 'skill-cand-1' }),
    };
    const draft = exportSkillFrontmatterDraft(candidate);
    expect(draft.startsWith('---\n')).toBe(true);
    expect(draft.endsWith('---\n')).toBe(true);
    expect(draft).toContain('name: run-tests-before-commit');
    expect(draft).toContain('status: draft');
    expect(draft).toContain('skillCandidateId: "skill-cand-1"');
    expect(draft).toContain('confidence: 0.74');
    expect(draft).toContain('inputs: ["git.changed", "test.completed"]');
    expect(draft).toContain('contentHash: "sha256:');
    expect(draft).toContain('SkillCandidate ≠ Skill');
    expect(exportSkillFrontmatterDraft(candidate)).toBe(draft);
  });

  it('slugifies names and escapes YAML-hostile characters in quoted strings', () => {
    const draft = exportSkillFrontmatterDraft({
      schemaVersion: '1.0.0',
      id: 'skill-cand-2',
      workflowKey: 'wf.中文候选',
      revision: 1,
      name: 'Ünïcode 名字 with "quotes" &\nnewline',
      purpose: 'line1\nline2',
      triggerSummary: 't',
      inputNames: [],
      outputNames: [],
      evidence: [],
      estimatedBenefitMinutes: 5,
      risk: 'low',
      confidence: 0.5,
      actionIntentRevisionId: 'intent-2',
      status: 'proposed',
      contentHash: hashCanonical({ id: 'skill-cand-2' }),
    });
    expect(draft).toContain('name: u-ni-code-with-quotes-newline');
    expect(draft).toContain('description: "line1 line2"');
    expect(draft).not.toContain('line1\nline2');
    expect(draft).not.toContain('"quotes"');
  });
});
