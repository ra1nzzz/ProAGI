import { materializeBehaviorEvents, parseFixtureJson } from '../domain/fixture';
import { runInsightLoop } from '../domain/insightLoop';
import { replayV1, type ReplaySnapshotV1 } from '../domain/replay';
import type { BehaviorEvent, CorrectionCommand, InsightLoopOutput, KnowledgeSnapshot, WorkModelClaim } from '../domain/types';
import { InMemoryKnowledgePort } from './knowledge';
import { PreviewGuard, type PreviewReceipt } from './previewGuard';
import { ShadowActionSink } from './action';

export interface ImportCommit {
  readonly events: readonly BehaviorEvent[];
  readonly output: InsightLoopOutput;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
}

export class InsightLoopService {
  readonly knowledge = new InMemoryKnowledgePort();
  readonly shadow = new ShadowActionSink();
  private readonly guard: PreviewGuard<string, ImportCommit>;
  private events: readonly BehaviorEvent[] = [];

  constructor(tokenFactory?: () => string) {
    this.guard = new PreviewGuard(tokenFactory);
  }

  fork(): InsightLoopService {
    const clone = new InsightLoopService();
    clone.events = this.events;
    clone.knowledge.hydrate(this.knowledge.snapshot());
    return clone;
  }

  restoreEvents(events: readonly BehaviorEvent[]): void {
    this.events = events;
  }

  knowledgeSnapshot(): KnowledgeSnapshot {
    return this.knowledge.snapshot();
  }

  hydrateKnowledge(snapshot: KnowledgeSnapshot): void {
    this.knowledge.hydrate(snapshot);
  }

  currentClaim(claimKey: string): WorkModelClaim | undefined {
    return this.knowledge.currentClaim(claimKey);
  }

  preview(utf8: string, now: number): { readonly token: string; readonly acceptedCount: number; readonly rejectedCount: number } {
    const parsed = parseFixtureJson(utf8);
    return {
      token: this.guard.preview(utf8, now),
      acceptedCount: parsed.accepted.length,
      rejectedCount: parsed.rejected.length,
    };
  }

  commit(
    token: string,
    idempotencyKey: string,
    now: number,
    options: { readonly simulateResponseLoss?: boolean } = {},
  ): Promise<PreviewReceipt<ImportCommit>> {
    return this.guard.commit(token, idempotencyKey, now, (utf8) => {
      const parsed = parseFixtureJson(utf8);
      const events = materializeBehaviorEvents(parsed);
      const output = runInsightLoop(events, { asOf: maxOccurredAt(events), timezone: 'UTC', knowledge: this.knowledge.snapshot() });
      this.events = events;
      this.knowledge.registerProposed(output.claims);
      output.actionIntents.forEach((intent) => this.shadow.submit(intent));
      return Object.freeze({ events, output, acceptedCount: parsed.accepted.length, rejectedCount: parsed.rejected.length });
    }, options);
  }

  correct(command: CorrectionCommand) {
    return this.knowledge.submitCorrection(command);
  }

  replay(): ReplaySnapshotV1 {
    return replayV1({
      replayInputVersion: '1',
      events: this.events,
      knowledge: this.knowledge.snapshot(),
      asOf: maxOccurredAt(this.events),
      timezone: 'UTC',
      locale: 'zh-CN',
      clockSeed: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      pins: {
        schema: '1.0.0', segmentation: 'segment-v1', inference: 'insight-v1', canonicalization: 'canonical-json-v1',
      },
    });
  }
}

function maxOccurredAt(events: readonly BehaviorEvent[]): string {
  return events.reduce((max, event) => event.occurredAt > max ? event.occurredAt : max, '1970-01-01T00:00:00Z');
}
