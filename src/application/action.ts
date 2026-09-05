import { hashCanonical } from '../domain/canonical';
import { FORBIDDEN_EFFECTS, type ActionIntent, type ForbiddenEffect } from '../domain/types';

export const FORBIDDEN_BROWSER_EFFECT_SINK_REGISTRY = Object.freeze({
  version: 'forbidden-browser-effect-sinks-v1' as const,
  sinks: Object.freeze(Object.fromEntries(FORBIDDEN_EFFECTS.map((sink) => [sink, 'deny-from-shadow-root'])) as Readonly<Record<ForbiddenEffect, 'deny-from-shadow-root'>>),
});

export class ShadowActionSink {
  private readonly intents = new Map<string, ActionIntent>();

  submit(intent: ActionIntent): ActionIntent {
    if (intent.mode !== 'shadow') throw new Error('ERR_SHADOW_VIOLATION');
    const required = new Set<ForbiddenEffect>(FORBIDDEN_EFFECTS);
    if (intent.forbiddenEffects.length !== required.size || intent.forbiddenEffects.some((effect) => !required.delete(effect))) {
      throw new Error('ERR_SHADOW_VIOLATION');
    }
    const prior = this.intents.get(intent.contentHash);
    if (prior) return prior;
    const verified = Object.freeze({ ...intent, contentHash: hashCanonical(stripHash(intent)) });
    if (verified.contentHash !== intent.contentHash) throw new Error('ERR_HASH_MISMATCH');
    this.intents.set(intent.contentHash, intent);
    return intent;
  }

  list(): readonly ActionIntent[] {
    return [...this.intents.values()].sort((a, b) => a.contentHash.localeCompare(b.contentHash));
  }
}

function stripHash(intent: ActionIntent): Omit<ActionIntent, 'id' | 'contentHash'> {
  return {
    schemaVersion: intent.schemaVersion,
    workflowKey: intent.workflowKey,
    revision: intent.revision,
    mode: intent.mode,
    summary: intent.summary,
    preconditions: intent.preconditions,
    hypotheticalSteps: intent.hypotheticalSteps,
    expectedEffects: intent.expectedEffects,
    forbiddenEffects: intent.forbiddenEffects,
    status: intent.status,
  };
}
