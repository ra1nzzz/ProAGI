import { afterEach, describe, expect, it, vi } from 'vitest';
import { IsolatedRuntime } from '../../src/application/isolatedRuntime';
import type { RuntimeDriver } from '../../src/application/runtimePort';
import { ctx, descriptor, request } from './helpers';

const ports: IsolatedRuntime[] = [];
afterEach(() => { ports.splice(0).forEach((port) => port.dispose()); vi.useRealTimers(); });
function port(evaluate: RuntimeDriver['evaluate'], epoch: () => number = () => 0) {
  const runtime = new IsolatedRuntime({ initialize: descriptor, evaluate, dispose: () => undefined }, epoch);
  ports.push(runtime);
  return runtime;
}
const valid = { verdict: 'insufficient', confidence: 0.5, reasonCode: 'NEEDS_REVIEW' };

describe('M3 runtime fault isolation', () => {
  it('times out even when a provider ignores abort; late success cannot replace the terminal result', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const runtime = port(() => new Promise((resolve) => { finish = resolve; }));
    const handle = await runtime.submit(ctx, request());
    const result = runtime.result(ctx, handle);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await result).toMatchObject({ status: 'timed-out' });
    finish(valid);
    await Promise.resolve();
    expect(await runtime.result(ctx, handle)).toMatchObject({ status: 'timed-out' });
  });
  it('linearizes cancellation before a competing response and makes repeated cancel idempotent', async () => {
    let finish!: (value: unknown) => void;
    const runtime = port(() => new Promise((resolve) => { finish = resolve; }));
    const handle = await runtime.submit(ctx, request());
    const cancelled = await runtime.cancel(ctx, handle);
    finish(valid);
    expect(cancelled.status).toBe('cancelled');
    expect(await runtime.cancel(ctx, handle)).toEqual(cancelled);
    expect(await runtime.result(ctx, handle)).toEqual(cancelled);
  });
  it.each([null, { ...valid, providerThread: 'canary' }, { ...valid, confidence: 2 }])('rejects malformed provider output: %j', async (output) => {
    const runtime = port(async () => output);
    const handle = await runtime.submit(ctx, request());
    expect(await runtime.result(ctx, handle)).toMatchObject({ status: 'failed', error: { code: 'ERR_RUNTIME_RESPONSE' } });
  });
  it('redacts provider crashes and remains separate from the canonical store', async () => {
    const runtime = port(async () => { throw new Error('SECRET_PROVIDER_KEY and raw user text'); });
    const handle = await runtime.submit(ctx, request());
    const result = await runtime.result(ctx, handle);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'ERR_RUNTIME_UNAVAILABLE' } });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('refuses outbound work if its audit sink fails', async () => {
    const evaluate = vi.fn(async () => valid);
    const runtime = new IsolatedRuntime({ initialize: descriptor, evaluate, dispose: () => undefined }, () => 0, () => { throw new Error('audit unavailable'); });
    ports.push(runtime);
    const handle = await runtime.submit(ctx, request());
    expect(await runtime.result(ctx, handle)).toMatchObject({ status: 'failed', error: { code: 'ERR_RUNTIME_AUDIT' } });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('rejects a stale privacy epoch while the provider is still running', async () => {
    let epoch = 0;
    let finish!: (value: unknown) => void;
    const runtime = port(() => new Promise((resolve) => { finish = resolve; }), () => epoch);
    const handle = await runtime.submit(ctx, request());
    epoch = 1;
    finish(valid);
    await expect(runtime.result(ctx, handle)).rejects.toThrow('ERR_RUNTIME_EPOCH');
    await expect(runtime.result({ ...ctx, privacyEpoch: 1 }, handle)).rejects.toThrow('ERR_RUNTIME_HANDLE');
  });
  it.each(['result', 'cancel'] as const)('rechecks the original job binding after awaiting %s', async (method) => {
    let epoch = 0;
    const runtime = port(async () => valid, () => epoch);
    const handle = await runtime.submit(ctx, request());
    await runtime.result(ctx, handle);
    const mutable = { ...ctx };
    const pending = runtime[method](mutable, handle);
    mutable.privacyEpoch = ++epoch;
    await expect(pending).rejects.toThrow('ERR_RUNTIME_HANDLE');
  });
  it('does not dispatch after the absolute deadline even before the timer runs', async () => {
    let now = Date.now();
    const evaluate = vi.fn(async () => valid);
    const runtime = new IsolatedRuntime({ initialize: descriptor, evaluate, dispose: () => undefined }, () => 0,
      (entry) => { if (entry.phase === 'outbound') now += 20_000; }, () => now);
    ports.push(runtime);
    const handle = await runtime.submit(ctx, request());
    expect(await runtime.result(ctx, handle)).toMatchObject({ status: 'timed-out' });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('fails negotiation on protocol mismatch and bounds a hung handshake', async () => {
    const bad = new IsolatedRuntime({ initialize: async () => ({ runtimeId: 'bad', protocolVersion: 'v99', capabilities: [] }), evaluate: vi.fn(), dispose: () => undefined }, () => 0);
    ports.push(bad);
    await expect(bad.initialize(ctx)).rejects.toThrow('ERR_RUNTIME_PROTOCOL');
    vi.useFakeTimers();
    const hung = new IsolatedRuntime({ initialize: () => new Promise(() => undefined), evaluate: vi.fn(), dispose: () => undefined }, () => 0);
    ports.push(hung);
    const result = expect(hung.initialize(ctx)).rejects.toThrow('ERR_RUNTIME_TIMEOUT');
    await vi.advanceTimersByTimeAsync(5_001);
    await result;
  });
  it('cancels pending work and rejects later calls after disposal', async () => {
    const runtime = port(() => new Promise(() => undefined));
    const handle = await runtime.submit(ctx, request());
    runtime.dispose();
    await expect(runtime.result(ctx, handle)).rejects.toThrow('ERR_RUNTIME_DISPOSED');
    await expect(runtime.submit(ctx, request())).rejects.toThrow('ERR_RUNTIME_DISPOSED');
  });
});
