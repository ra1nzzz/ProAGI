import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRuntimeAdapter } from '../../src/adapters/fakeRuntime';
import { IsolatedRuntime, minimalEvaluationInput, type RuntimeAudit } from '../../src/application/isolatedRuntime';
import { InsightLoopService } from '../../src/application/insightService';
import { developerDayFixtureJson } from '../../src/fixtures/developerDay';
import { ctx, request } from './helpers';

const ports: IsolatedRuntime[] = [];
afterEach(() => { ports.splice(0).forEach((port) => port.dispose()); });

describe('M3 typed runtime contract', () => {
  it('negotiates, submits once per idempotency key and returns a validated detached result', async () => {
    const driver = new FakeRuntimeAdapter();
    const evaluate = vi.spyOn(driver, 'evaluate');
    const audits: RuntimeAudit[] = [];
    const port = new IsolatedRuntime(driver, () => 0, (entry) => audits.push(entry));
    ports.push(port);
    const input = request();
    const [a, b] = await Promise.all([port.submit(ctx, input), port.submit(ctx, input)]);
    expect(a).toEqual(b);
    expect(evaluate).toHaveBeenCalledTimes(1);
    const result = await port.result(ctx, a);
    expect(result).toMatchObject({ status: 'completed', output: { reasonCode: 'NEEDS_REVIEW' } });
    if (result.status === 'completed') result.output.confidence = 0;
    expect(await port.result(ctx, a)).toMatchObject({ output: { confidence: 1 } });
    expect(audits.map((entry) => entry.phase)).toEqual(['outbound', 'completed']);
    await expect(port.submit(ctx, { ...input, correlationId: 'changed' })).rejects.toThrow('ERR_RUNTIME_IDEMPOTENCY');
    await expect(port.result({ ...ctx, callerId: 'other' }, a)).rejects.toThrow('ERR_RUNTIME_HANDLE');
    await expect(port.result(ctx, { ...a, deadlineAt: 'forged' })).rejects.toThrow('ERR_RUNTIME_HANDLE');
  });

  it('rejects absent outbound permission and unknown input fields before any provider call', async () => {
    const driver = new FakeRuntimeAdapter();
    const initialize = vi.spyOn(driver, 'initialize');
    const port = new IsolatedRuntime(driver, () => 0);
    ports.push(port);
    await expect(port.submit({ ...ctx, outboundApproved: false }, request())).rejects.toThrow('ERR_RUNTIME_CAPABILITY');
    const input = request();
    Object.assign(input.task.input, { statement: 'restricted-canary' });
    await expect(port.submit(ctx, input)).rejects.toThrow('ERR_RUNTIME_REQUEST');
    expect(initialize).not.toHaveBeenCalled();
  });

  it('minimizes a real Core snapshot to counts without provider state entering Core', async () => {
    const core = new InsightLoopService();
    const now = Date.now();
    const preview = core.preview(developerDayFixtureJson, now);
    const committed = await core.commit(preview.token, 'm3-input', now);
    const before = JSON.stringify(core.knowledgeSnapshot());
    const input = minimalEvaluationInput(committed.result.output, core.knowledgeSnapshot());
    expect(Object.keys(input)).toHaveLength(5);
    expect(Object.values(input).every((value) => typeof value === 'number')).toBe(true);
    expect(JSON.stringify(input)).not.toContain('project');
    expect(JSON.stringify(core.knowledgeSnapshot())).toBe(before);
  });
});
