import { FakeRuntimeAdapter } from '../../src/adapters/fakeRuntime';
import type { RuntimeContext, RuntimeRequest } from '../../src/application/runtimePort';

export const ctx: RuntimeContext = {
  callerId: 'test-client', purpose: 'insight.structured-evaluation', privacyEpoch: 0, outboundApproved: true,
  capabilities: ['runtime.initialize', 'runtime.submit', 'runtime.cancel'],
};
export function request(): RuntimeRequest {
  return {
    requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    task: { kind: 'structured-evaluation', requiredCapabilities: ['structured-evaluation', 'cancel'], input: { eventCount: 3, episodeCount: 1, proposedCount: 1, confirmedCount: 0, rejectedCount: 0 } },
  };
}
export const descriptor = () => new FakeRuntimeAdapter().initialize();
