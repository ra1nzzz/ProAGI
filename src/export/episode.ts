// Ontology Phase 3 (Adopt) export: Episode → canonical EpisodicMemory（MEMORY-SPEC v0.1 §2）。
// 映射依据：mappings/proagi.yaml（Episode.local = time-bounded clusters → Memory.EpisodicMemory）。
// eventRefs 复用 Phase 2 的 observation id（observation:proagi:<eventId>），保持导出层内部引用一致。
// 铁律：纯函数、显式调用；MEMORY-SPEC §7——每个 Memory 写入可溯源（provenance 留档本地 contentHash）。
import type { Episode } from '../domain/types';
import type { CanonicalEpisodicMemory } from './types';
import { toCanonicalEvidenceRef } from './internal';

export function exportEpisode(episode: Episode): CanonicalEpisodicMemory {
  return Object.freeze<CanonicalEpisodicMemory>({
    id: `memory:proagi:episode/${episode.id}`,
    layer: 'episodic',
    title: episode.title,
    startAt: episode.startAt,
    endAt: episode.endAt,
    ...(episode.projectKey === undefined ? {} : { projectKey: episode.projectKey }),
    activityKind: episode.activityKind,
    eventRefs: episode.eventIds.map((eventId) => `observation:proagi:${eventId}`),
    evidence: toCanonicalEvidenceRef(episode.evidence),
    confidence: episode.confidence,
    provenance: Object.freeze({
      product: 'proagi' as const,
      localEpisodeId: episode.id,
      segmentationVersion: episode.segmentationVersion,
      contentHash: episode.contentHash,
    }),
  });
}
