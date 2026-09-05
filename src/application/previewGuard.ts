import { hashCanonical } from '../domain/canonical';
import type { Hash } from '../domain/types';

export interface PreviewReceipt<T> {
  readonly tokenHash: Hash;
  readonly idempotencyKey: string;
  readonly result: T;
  readonly resultHash: Hash;
}

interface Guard<TInput, TResult> {
  readonly tokenHash: Hash;
  readonly input: TInput;
  readonly inputHash: Hash;
  readonly expiresAt: number;
  state: 'READY' | 'CONSUMED';
  idempotencyKey?: string;
  receipt?: PreviewReceipt<TResult>;
}

export class PreviewGuard<TInput, TResult> {
  private readonly guards = new Map<string, Guard<TInput, TResult>>();
  private readonly ledger = new Map<string, PreviewReceipt<TResult>>();
  private readonly consumedTokens = new Map<string, string>();

  constructor(private readonly tokenFactory: () => string = secureToken) {}

  preview(input: TInput, now: number, ttlMs = 60_000): string {
    const token = this.tokenFactory();
    if (this.guards.has(token)) throw new Error('ERR_IDEMPOTENCY_CONFLICT');
    this.guards.set(token, {
      tokenHash: hashCanonical(token),
      input,
      inputHash: hashCanonical(input),
      expiresAt: now + ttlMs,
      state: 'READY',
    });
    return token;
  }

  async commit(
    token: string,
    idempotencyKey: string,
    now: number,
    consume: (input: Readonly<TInput>) => TResult,
    options: { readonly simulateResponseLoss?: boolean } = {},
  ): Promise<PreviewReceipt<TResult>> {
    const prior = this.ledger.get(idempotencyKey);
    if (prior) {
      if (hashCanonical(token) !== prior.tokenHash) throw new Error('ERR_IDEMPOTENCY_CONFLICT');
      return prior;
    }
    const guard = this.guards.get(token);
    if (!guard) {
      if (this.consumedTokens.has(token)) throw new Error('ERR_PREVIEW_CONSUMED');
      throw new Error('ERR_PREVIEW_STALE');
    }
    if (now >= guard.expiresAt) {
      this.guards.delete(token);
      throw new Error('ERR_PREVIEW_EXPIRED');
    }
    if (guard.inputHash !== hashCanonical(guard.input)) {
      this.guards.delete(token);
      throw new Error('ERR_PREVIEW_STALE');
    }
    if (guard.state === 'CONSUMED') throw new Error('ERR_PREVIEW_CONSUMED');

    // M1a in-memory transaction: consume must complete before guard and ledger publish together.
    const result = consume(guard.input);
    const receipt: PreviewReceipt<TResult> = Object.freeze({
      tokenHash: guard.tokenHash,
      idempotencyKey,
      result,
      resultHash: hashCanonical(result),
    });
    this.ledger.set(idempotencyKey, receipt);
    this.consumedTokens.set(token, idempotencyKey);
    this.guards.delete(token);
    if (options.simulateResponseLoss) throw new Error('SIMULATED_RESPONSE_LOSS');
    return receipt;
  }

  ledgerReceipt(idempotencyKey: string): PreviewReceipt<TResult> | undefined {
    return this.ledger.get(idempotencyKey);
  }

  activeGuardCount(): number {
    return this.guards.size;
  }
}

function secureToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}
