import { describe, expect, it } from 'vitest';
import { PreviewGuard } from '../../src/application/previewGuard';

describe('PreviewGuard exactly-once commit', () => {
  it('deduplicates a double commit with the same idempotency key', async () => {
    const guard = new PreviewGuard<{ value: number }, { committed: number }>(() => 'token-a');
    const token = guard.preview({ value: 7 }, 0);
    let commits = 0;
    const consume = (input: Readonly<{ value: number }>) => ({ committed: input.value + ++commits - 1 });
    const first = await guard.commit(token, 'idem-a', 1, consume);
    const second = await guard.commit(token, 'idem-a', 2, consume);
    expect(second).toBe(first);
    expect(commits).toBe(1);
    expect(guard.activeGuardCount()).toBe(0);
    await expect(guard.commit(token, 'idem-b', 3, consume)).rejects.toThrow('ERR_PREVIEW_CONSUMED');
  });

  it('recovers a committed receipt after response loss without repeating effects', async () => {
    const guard = new PreviewGuard<string, { saved: string }>(() => 'token-loss');
    const token = guard.preview('payload', 0);
    let commits = 0;
    const consume = (value: Readonly<string>) => { commits += 1; return { saved: value }; };
    await expect(guard.commit(token, 'idem-loss', 1, consume, { simulateResponseLoss: true }))
      .rejects.toThrow('SIMULATED_RESPONSE_LOSS');
    const recovered = await guard.commit(token, 'idem-loss', 2, consume);
    expect(recovered.result).toEqual({ saved: 'payload' });
    expect(commits).toBe(1);
    expect(guard.activeGuardCount()).toBe(0);
  });
});
