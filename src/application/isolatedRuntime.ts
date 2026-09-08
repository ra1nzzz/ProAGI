import { hashCanonical } from '../domain/canonical';
import { z } from 'zod';
import type { Hash, InsightLoopOutput, KnowledgeSnapshot } from '../domain/types';
import {
  evaluationOutputSchema, runtimeRequestSchema, RUNTIME_PROTOCOL_VERSION,
  type EvaluationInput, type RuntimeContext, type RuntimeDescriptor, type RuntimeDriver,
  type RuntimeHandle, type RuntimePort, type RuntimeRequest, type RuntimeResult,
} from './runtimePort';

export interface RuntimeAudit {
  readonly requestId: string;
  readonly correlationId: string;
  readonly phase: 'outbound' | RuntimeResult['status'];
  readonly fieldCount: number;
  readonly bytes: number;
}
interface Job {
  readonly handle: RuntimeHandle;
  readonly callerId: string;
  readonly epoch: number;
  readonly requestHash: Hash;
  readonly controller: AbortController;
  readonly promise: Promise<RuntimeResult>;
  finish(result: RuntimeResult): void;
}

/** Deliberately sends only aggregate numbers: no claims, project names, IDs or raw events. */
export function minimalEvaluationInput(output: InsightLoopOutput, knowledge: KnowledgeSnapshot): EvaluationInput {
  const latest = new Map<string, KnowledgeSnapshot['claims'][number]>();
  for (const claim of knowledge.claims) {
    if (!knowledge.deletedClaimKeys.includes(claim.claimKey) && claim.revision > (latest.get(claim.claimKey)?.revision ?? 0)) latest.set(claim.claimKey, claim);
  }
  const claims = [...latest.values()];
  return {
    eventCount: output.events.length, episodeCount: output.episodes.length,
    proposedCount: claims.filter((claim) => claim.status === 'proposed').length,
    confirmedCount: claims.filter((claim) => claim.status === 'confirmed').length,
    rejectedCount: claims.filter((claim) => claim.status === 'rejected' || claim.status === 'invalidated').length,
  };
}

export class IsolatedRuntime implements RuntimePort {
  private readonly jobs = new Map<string, Job>();
  private readonly keys = new Map<string, Job>();
  private readonly initializationAbort = new AbortController();
  private initialization?: Promise<RuntimeDescriptor>;
  private disposed = false;

  constructor(
    private readonly driver: RuntimeDriver,
    private readonly currentEpoch: () => number,
    private readonly audit: (entry: RuntimeAudit) => void = () => undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  async initialize(ctx: RuntimeContext): Promise<RuntimeDescriptor> {
    this.authorize(ctx, 'runtime.initialize');
    this.initialization ??= this.negotiate();
    const descriptor = await this.initialization;
    this.authorize(ctx, 'runtime.initialize');
    return structuredClone(descriptor);
  }

  async submit(ctx: RuntimeContext, request: RuntimeRequest): Promise<RuntimeHandle> {
    this.authorize(ctx, 'runtime.submit');
    const parsed = runtimeRequestSchema.safeParse(request);
    if (!parsed.success) throw new Error('ERR_RUNTIME_REQUEST');
    request = parsed.data;
    const descriptor = await this.initialize(ctx);
    this.authorize(ctx, 'runtime.submit');
    if (request.task.requiredCapabilities.some((capability) => !descriptor.capabilities.includes(capability))) throw new Error('ERR_RUNTIME_CAPABILITY');
    const key = JSON.stringify([ctx.callerId, request.idempotencyKey]);
    const requestHash = hashCanonical(request);
    const previous = this.keys.get(key);
    if (previous) {
      if (previous.requestHash !== requestHash || previous.epoch !== ctx.privacyEpoch) throw new Error('ERR_RUNTIME_IDEMPOTENCY');
      return structuredClone(previous.handle);
    }
    const now = this.now();
    const delay = Date.parse(request.deadlineAt) - now;
    if (delay <= 0 || delay > 300_000) throw new Error('ERR_RUNTIME_DEADLINE');
    // ponytail: bounded session ledger; dispose/recreate after 128 requests instead of silently replaying evicted keys.
    if (this.jobs.size >= 128) throw new Error('ERR_RUNTIME_CAPACITY');
    const controller = new AbortController();
    const handle = Object.freeze({ handleId: crypto.randomUUID(), requestId: request.requestId, acceptedAt: new Date(now).toISOString(), deadlineAt: request.deadlineAt });
    let resolve!: (result: RuntimeResult) => void;
    const promise = new Promise<RuntimeResult>((done) => { resolve = done; });
    let settled = false;
    const timer = setTimeout(() => job.finish({ status: 'timed-out', handle, completedAt: this.timestamp() }), delay);
    const job: Job = {
      handle, callerId: ctx.callerId, epoch: ctx.privacyEpoch, requestHash, controller, promise,
      finish: (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.abort();
        resolve(result);
        this.safeAudit({ requestId: request.requestId, correlationId: request.correlationId, phase: result.status, fieldCount: 0, bytes: 0 });
      },
    };
    this.jobs.set(handle.handleId, job);
    this.keys.set(key, job);
    try {
      this.audit(Object.freeze({ requestId: request.requestId, correlationId: request.correlationId, phase: 'outbound', fieldCount: 5, bytes: new TextEncoder().encode(JSON.stringify(request.task.input)).length }));
    } catch {
      job.finish({ status: 'failed', handle, error: { code: 'ERR_RUNTIME_AUDIT' }, completedAt: this.timestamp() });
      return structuredClone(handle);
    }
    void Promise.resolve().then(() => {
      this.authorize(ctx, 'runtime.submit');
      if (controller.signal.aborted) throw new Error('ERR_RUNTIME_CANCELLED');
      if (this.now() >= Date.parse(handle.deadlineAt)) {
        job.finish({ status: 'timed-out', handle, completedAt: this.timestamp() });
        return;
      }
      return this.driver.evaluate(request.task.input, controller.signal);
    }).then((raw) => {
      if (settled) return;
      this.authorize(ctx, 'runtime.submit');
      if (this.now() >= Date.parse(handle.deadlineAt)) {
        job.finish({ status: 'timed-out', handle, completedAt: this.timestamp() });
        return;
      }
      const output = evaluationOutputSchema.safeParse(raw);
      if (!output.success) throw new Error('ERR_RUNTIME_RESPONSE');
      job.finish({ status: 'completed', handle, output: output.data, completedAt: this.timestamp() });
    }).catch((error: unknown) => {
      const codes = ['ERR_RUNTIME_RESPONSE', 'ERR_RUNTIME_PROTOCOL', 'ERR_RUNTIME_EPOCH', 'ERR_RUNTIME_DISPOSED'];
      const code = error instanceof Error && codes.includes(error.message) ? error.message : 'ERR_RUNTIME_UNAVAILABLE';
      job.finish({ status: 'failed', handle, error: { code }, completedAt: this.timestamp() });
    });
    return structuredClone(handle);
  }

  async result(ctx: RuntimeContext, handle: RuntimeHandle): Promise<RuntimeResult> {
    const job = this.lookup(ctx, handle, 'runtime.submit');
    const result = await job.promise;
    this.lookup(ctx, job.handle, 'runtime.submit');
    return structuredClone(result);
  }

  async cancel(ctx: RuntimeContext, handle: RuntimeHandle): Promise<RuntimeResult> {
    const job = this.lookup(ctx, handle, 'runtime.cancel');
    job.finish({ status: 'cancelled', handle: job.handle, completedAt: this.timestamp() });
    const result = await job.promise;
    this.lookup(ctx, job.handle, 'runtime.cancel');
    return structuredClone(result);
  }

  dispose(): void {
    this.disposed = true;
    this.initializationAbort.abort();
    for (const job of this.jobs.values()) job.finish({ status: 'cancelled', handle: job.handle, completedAt: this.timestamp() });
    this.jobs.clear();
    this.keys.clear();
    this.driver.dispose();
  }

  private async negotiate(): Promise<RuntimeDescriptor> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const descriptor = await Promise.race([
        this.driver.initialize(this.initializationAbort.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { this.initializationAbort.abort(); reject(new Error('ERR_RUNTIME_TIMEOUT')); }, 5_000); }),
      ]);
      const parsed = z.object({ runtimeId: z.string().min(1).max(80), protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION), capabilities: z.array(z.string().max(80)).max(16) }).strict().safeParse(descriptor);
      if (!parsed.success || !parsed.data.capabilities.includes('structured-evaluation') || !parsed.data.capabilities.includes('cancel')) throw new Error('ERR_RUNTIME_PROTOCOL');
      return parsed.data;
    } catch (error) {
      throw new Error(error instanceof Error && ['ERR_RUNTIME_PROTOCOL', 'ERR_RUNTIME_TIMEOUT'].includes(error.message) ? error.message : 'ERR_RUNTIME_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }

  private lookup(ctx: RuntimeContext, handle: RuntimeHandle, capability: RuntimeContext['capabilities'][number]): Job {
    this.authorize(ctx, capability);
    const job = this.jobs.get(handle.handleId);
    if (!job || job.callerId !== ctx.callerId || job.epoch !== ctx.privacyEpoch || hashCanonical(job.handle) !== hashCanonical(handle)) throw new Error('ERR_RUNTIME_HANDLE');
    return job;
  }

  private authorize(ctx: RuntimeContext, capability: RuntimeContext['capabilities'][number]): void {
    if (this.disposed) throw new Error('ERR_RUNTIME_DISPOSED');
    if (!ctx.outboundApproved || ctx.purpose !== 'insight.structured-evaluation' || !ctx.callerId || !ctx.capabilities.includes(capability)) throw new Error('ERR_RUNTIME_CAPABILITY');
    if (!Number.isSafeInteger(ctx.privacyEpoch) || ctx.privacyEpoch !== this.currentEpoch()) throw new Error('ERR_RUNTIME_EPOCH');
  }
  private now(): number {
    const now = this.clock();
    if (!Number.isFinite(now)) throw new Error('ERR_RUNTIME_CLOCK');
    return now;
  }
  private timestamp(): string { const now = this.clock(); return new Date(Number.isFinite(now) ? now : 0).toISOString(); }
  private safeAudit(entry: RuntimeAudit): void { try { this.audit(Object.freeze(entry)); } catch { /* Audit sink cannot break local Core or leave a pending job. */ } }
}
