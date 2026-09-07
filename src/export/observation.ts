// Ontology Phase 2 export: BehaviorEvent -> canonical Observation.
// 映射依据：mappings/proagi.yaml（BehaviorEvent.canonical = Observation{kind:"event"}）
//          ACTION-SPEC v0.1 §2（Observation 统一格式）。
// 铁律：导出必须显式调用——本模块是纯函数，无 I/O、无时钟、无自动外发；
//       本地观察数据默认不出本机，输出如何传输由调用方决定。
import type { BehaviorEvent } from '../domain/types';
import type { CanonicalObservation } from './types';

export const DEFAULT_ENVIRONMENT_REF = 'environment:proagi:workstation';

export interface ExportObservationOptions {
  /** 部署侧环境标识（如 environment:proagi:hexu-desktop）；默认单机工作站。 */
  readonly environmentRef?: string;
}

export function exportObservation(
  events: readonly BehaviorEvent[],
  options: ExportObservationOptions = {},
): readonly CanonicalObservation[] {
  const environmentRef = options.environmentRef ?? DEFAULT_ENVIRONMENT_REF;
  return events.map((event) => Object.freeze<CanonicalObservation>({
    id: `observation:proagi:${event.id}`,
    environmentRef,
    subject: event.subject.projectKey
      ? `app:${event.subject.appId}/${event.subject.projectKey}`
      : `app:${event.subject.appId}`,
    kind: 'event',
    content: Object.freeze({
      eventKind: event.kind,
      sourceItemKey: event.sourceItemKey,
      attributes: Object.freeze({ ...event.attributes }),
      factHash: event.factHash,
      dedupeKey: event.dedupeKey,
      privacy: Object.freeze({ ...event.privacy }),
    }),
    ts: event.occurredAt,
  }));
}
