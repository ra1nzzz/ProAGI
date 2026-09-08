import { z } from 'zod';

export const RUNTIME_PROTOCOL_VERSION = 'proagi-runtime-v1';
export const RUNTIME_CAPABILITIES = ['structured-evaluation', 'cancel'] as const;
export const evaluationInputSchema = z.object({
  eventCount: z.number().int().min(0).max(100_000),
  episodeCount: z.number().int().min(0).max(100_000),
  proposedCount: z.number().int().min(0).max(100_000),
  confirmedCount: z.number().int().min(0).max(100_000),
  rejectedCount: z.number().int().min(0).max(100_000),
}).strict();
export const evaluationOutputSchema = z.object({
  verdict: z.enum(['sufficient', 'insufficient']),
  confidence: z.number().min(0).max(1),
  reasonCode: z.enum(['NO_EVIDENCE', 'NEEDS_REVIEW', 'HAS_CONFIRMED_KNOWLEDGE']),
}).strict();
export type EvaluationInput = z.infer<typeof evaluationInputSchema>;
export type EvaluationOutput = z.infer<typeof evaluationOutputSchema>;

const id = z.string().min(1).max(128);
export const runtimeRequestSchema = z.object({
  requestId: id, correlationId: id, idempotencyKey: id,
  deadlineAt: z.string().datetime(),
  task: z.object({
    kind: z.literal('structured-evaluation'), input: evaluationInputSchema,
    requiredCapabilities: z.array(z.enum(RUNTIME_CAPABILITIES)).max(2),
  }).strict(),
}).strict();
export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;
export interface RuntimeHandle {
  readonly handleId: string;
  readonly requestId: string;
  readonly acceptedAt: string;
  readonly deadlineAt: string;
}
export type RuntimeResult =
  | { readonly status: 'completed'; readonly handle: RuntimeHandle; readonly output: EvaluationOutput; readonly completedAt: string }
  | { readonly status: 'failed'; readonly handle: RuntimeHandle; readonly error: { readonly code: string }; readonly completedAt: string }
  | { readonly status: 'cancelled' | 'timed-out'; readonly handle: RuntimeHandle; readonly completedAt: string };
export interface RuntimeDescriptor {
  readonly runtimeId: string;
  readonly protocolVersion: string;
  readonly capabilities: readonly string[];
}
export interface RuntimeContext {
  readonly callerId: string;
  readonly capabilities: readonly ('runtime.initialize' | 'runtime.submit' | 'runtime.cancel')[];
  readonly purpose: 'insight.structured-evaluation';
  readonly privacyEpoch: number;
  // Separate outbound permission: an M2 read grant never authorizes a provider request.
  readonly outboundApproved: boolean;
}
export interface RuntimePort {
  initialize(ctx: RuntimeContext): Promise<RuntimeDescriptor>;
  submit(ctx: RuntimeContext, request: RuntimeRequest): Promise<RuntimeHandle>;
  result(ctx: RuntimeContext, handle: RuntimeHandle): Promise<RuntimeResult>;
  cancel(ctx: RuntimeContext, handle: RuntimeHandle): Promise<RuntimeResult>;
  dispose(): void;
}
// Provider DTOs stop at this boundary. Only the application validates their output.
export interface RuntimeDriver {
  initialize(signal: AbortSignal): Promise<RuntimeDescriptor>;
  evaluate(input: EvaluationInput, signal: AbortSignal): Promise<unknown>;
  dispose(): void;
}
