import { RUNTIME_CAPABILITIES, RUNTIME_PROTOCOL_VERSION, type EvaluationInput, type EvaluationOutput, type RuntimeDriver } from '../application/runtimePort';

export class FakeRuntimeAdapter implements RuntimeDriver {
  async initialize() { return { runtimeId: 'fake', protocolVersion: RUNTIME_PROTOCOL_VERSION, capabilities: RUNTIME_CAPABILITIES }; }
  async evaluate(input: EvaluationInput, signal: AbortSignal): Promise<EvaluationOutput> {
    signal.throwIfAborted();
    return {
      verdict: input.confirmedCount > 0 ? 'sufficient' : 'insufficient', confidence: 1,
      reasonCode: input.eventCount === 0 ? 'NO_EVIDENCE' : input.confirmedCount > 0 ? 'HAS_CONFIRMED_KNOWLEDGE' : 'NEEDS_REVIEW',
    };
  }
  dispose(): void { /* No transport or retained context. */ }
}
