import { describe, expect, it } from 'vitest';
import { hashCanonical } from '../../src/domain/canonical';
import type { DailyReportSnapshot, Episode, EvidenceRef } from '../../src/domain/types';
import {
  canonicalArtifactSchema,
  canonicalEpisodicMemorySchema,
  exportEpisode,
  exportEvidenceArtifact,
  exportReportArtifact,
} from '../../src/export';

function evidenceRef(entityType: EvidenceRef['entityType'], entityId: string, role: EvidenceRef['role']): EvidenceRef {
  return {
    entityType,
    entityId,
    entityHash: hashCanonical({ entityType, entityId }),
    role,
    transform: { name: 'segment-v1', version: '1.0.0', inputHash: hashCanonical({ seed: entityId }) },
  };
}

function episodeFixture(overrides: Partial<Episode> = {}): Episode {
  return {
    schemaVersion: '1.0.0',
    id: 'ep-7',
    startAt: '2026-09-07T08:00:00.000Z',
    endAt: '2026-09-07T08:30:00.000Z',
    title: 'Refactor export layer',
    projectKey: 'proagi',
    activityKind: 'code',
    eventIds: ['evt-a', 'evt-b'],
    evidence: [evidenceRef('behavior_event', 'evt-a', 'support'), evidenceRef('episode', 'ep-7', 'lineage')],
    confidence: 0.9,
    segmentationVersion: 'segment-v1',
    status: 'final',
    contentHash: hashCanonical({ id: 'ep-7' }),
    ...overrides,
  };
}

function reportFixture(): DailyReportSnapshot {
  return {
    schemaVersion: '1.0.0',
    id: 'report-2026-09-07',
    projectionVersion: 'daily-report-v1',
    localDate: '2026-09-07',
    timezone: 'Asia/Shanghai',
    episodeIds: ['ep-7'],
    sections: {
      work: [{ episodeId: 'ep-7', summary: 'Landed ontology export layer.' }],
      learnedClaimIds: ['claim-1'],
      questionIds: ['q-1'],
      skillCandidateIds: ['skill-1'],
    },
    evidence: [evidenceRef('episode', 'ep-7', 'support')],
    status: 'published',
    contentHash: hashCanonical({ id: 'report-2026-09-07' }),
  };
}

describe('exportEpisode (MEMORY-SPEC §2 EpisodicMemory adoption)', () => {
  it('maps Episode to canonical EpisodicMemory and passes schema validation', () => {
    const memory = exportEpisode(episodeFixture());
    expect(memory).toMatchObject({
      id: 'memory:proagi:episode/ep-7',
      layer: 'episodic',
      title: 'Refactor export layer',
      startAt: '2026-09-07T08:00:00.000Z',
      endAt: '2026-09-07T08:30:00.000Z',
      projectKey: 'proagi',
      activityKind: 'code',
      confidence: 0.9,
    });
    expect(memory.eventRefs).toEqual(['observation:proagi:evt-a', 'observation:proagi:evt-b']);
    expect(memory.evidence).toEqual([
      {
        ref: 'evidence:proagi:behavior_event/evt-a',
        role: 'support',
        entityHash: hashCanonical({ entityType: 'behavior_event', entityId: 'evt-a' }),
      },
      {
        ref: 'evidence:proagi:episode/ep-7',
        role: 'lineage',
        entityHash: hashCanonical({ entityType: 'episode', entityId: 'ep-7' }),
      },
    ]);
    expect(memory.provenance).toEqual({
      product: 'proagi',
      localEpisodeId: 'ep-7',
      segmentationVersion: 'segment-v1',
      contentHash: hashCanonical({ id: 'ep-7' }),
    });
    expect(() => canonicalEpisodicMemorySchema.parse(memory)).not.toThrow();
  });

  it('omits projectKey when absent and stays deterministic + frozen', () => {
    const episode = episodeFixture({ projectKey: undefined });
    const memory = exportEpisode(episode);
    expect('projectKey' in memory).toBe(false);
    expect(exportEpisode(episode)).toEqual(memory);
    expect(Object.isFrozen(memory)).toBe(true);
  });
});

describe('exportEvidenceArtifact (ARTIFACT-SPEC §2, kind=evidence)', () => {
  it('wraps an EvidenceRef into the canonical Artifact envelope with hash/provenance', () => {
    const artifact = exportEvidenceArtifact(evidenceRef('behavior_event', 'evt-a', 'support'));
    expect(artifact).toMatchObject({
      id: 'artifact:proagi:evidence/behavior_event/evt-a',
      kind: 'evidence',
      hash: hashCanonical({ entityType: 'behavior_event', entityId: 'evt-a' }),
      verification: { status: 'unverified' },
      provenance: {
        createdBy: 'agent:proagi',
        transform: { name: 'segment-v1', version: '1.0.0', inputHash: hashCanonical({ seed: 'evt-a' }) },
        local: { role: 'support' },
      },
    });
    expect('uri' in artifact).toBe(false);
    expect(() => canonicalArtifactSchema.parse(artifact)).not.toThrow();
  });

  it('carries caller-supplied uri and explicit verification, never inventing either', () => {
    const ref = evidenceRef('episode', 'ep-7', 'support');
    const artifact = exportEvidenceArtifact(ref, {
      uri: 'file:///evidence/2026-09-07/manifest.json',
      verification: { status: 'passed', method: 'hash-match', result: 'entityHash matches content' },
    });
    expect(artifact.uri).toBe('file:///evidence/2026-09-07/manifest.json');
    expect(artifact.verification).toEqual({ status: 'passed', method: 'hash-match', result: 'entityHash matches content' });
    expect(() => canonicalArtifactSchema.parse(artifact)).not.toThrow();
    const unverified = exportEvidenceArtifact(ref);
    expect(unverified.verification.status).toBe('unverified');
  });
});

describe('exportReportArtifact (ARTIFACT-SPEC §2, kind=report)', () => {
  it('wraps DailyReportSnapshot into the canonical Artifact envelope', () => {
    const artifact = exportReportArtifact(reportFixture());
    expect(artifact).toMatchObject({
      id: 'artifact:proagi:report/report-2026-09-07',
      kind: 'report',
      hash: hashCanonical({ id: 'report-2026-09-07' }),
      provenance: {
        createdBy: 'agent:proagi',
        local: {
          projectionVersion: 'daily-report-v1',
          localDate: '2026-09-07',
          timezone: 'Asia/Shanghai',
          episodeCount: 1,
          learnedClaimCount: 1,
          questionCount: 1,
          skillCandidateCount: 1,
        },
      },
    });
    expect(() => canonicalArtifactSchema.parse(artifact)).not.toThrow();
    expect(exportReportArtifact(reportFixture())).toEqual(artifact);
  });
});
