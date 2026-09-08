import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../../src/adapters/codexAppServer';
import { IsolatedRuntime } from '../../src/application/isolatedRuntime';
import { ctx, request } from './helpers';

type Frame = { id?: number; method?: string; params?: Record<string, unknown>; error?: unknown };
const sent: Frame[] = [];
let fault = '';
const sockets: Socket[] = [];
class Socket extends EventTarget {
  readyState = 0;
  constructor() {
    super(); sockets.push(this);
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  send(text: string) {
    const frame = JSON.parse(text) as Frame;
    sent.push(frame);
    queueMicrotask(() => {
      if (frame.method === 'initialize') this.emit({ id: frame.id, result: { userAgent: fault === 'version' ? 'codex/99.0.0' : 'codex/0.153.4', platformFamily: 'windows', platformOs: 'windows' } });
      if (frame.method === 'thread/start') this.emit({ id: frame.id, result: { thread: { id: 'thread-1', ephemeral: fault !== 'persistent' }, sandbox: { type: 'readOnly' } } });
      if (frame.method === 'turn/start') {
        if (fault === 'disconnect') { this.close(); return; }
        if (fault === 'approval') { this.emit({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' } }); return; }
        const result = { id: frame.id, result: { turn: { id: 'turn-1' } } };
        if (fault === 'pending') { this.emit(result); return; }
        // Provider may notify completion before the turn/start response, and retransmit a response.
        this.emit({ method: 'item/completed', params: { threadId: 'thread-1', turnId: fault === 'foreign-turn' ? 'other-turn' : 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ verdict: 'insufficient', confidence: 0.8, reasonCode: 'NEEDS_REVIEW' }) } } });
        this.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
        this.emit(result);
        this.emit(result);
      }
    });
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  private emit(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
const ports: IsolatedRuntime[] = [];
afterEach(() => {
  ports.splice(0).forEach((port) => port.dispose());
  sockets.splice(0).forEach((socket) => socket.close());
  sent.length = 0; fault = ''; vi.unstubAllGlobals();
});
function setup() {
  vi.stubGlobal('WebSocket', Socket);
  const port = new IsolatedRuntime(new CodexAppServerAdapter('ws://127.0.0.1:4513', 'D:/empty-workspace'), () => 0);
  ports.push(port);
  return port;
}

describe('Codex app-server provider boundary', () => {
  it('uses ephemeral read-only threads, tolerates response races and exposes no provider DTO', async () => {
    const port = setup();
    const handle = await port.submit(ctx, request());
    const result = await port.result(ctx, handle);
    expect(result).toMatchObject({ status: 'completed', output: { reasonCode: 'NEEDS_REVIEW' } });
    expect(JSON.stringify(result)).not.toContain('thread-1');
    expect(sent.find((frame) => frame.method === 'thread/start')?.params).toMatchObject({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
    const turn = sent.find((frame) => frame.method === 'turn/start');
    expect(turn?.params?.sandboxPolicy).toMatchObject({ type: 'readOnly', access: { readableRoots: [] } });
    expect(sockets.every((socket) => socket.readyState === 3)).toBe(true);
  });
  it.each(['persistent', 'disconnect', 'approval', 'foreign-turn'])('fails closed on %s and releases the transport', async (mode) => {
    fault = mode;
    const port = setup();
    const handle = await port.submit(ctx, request());
    const result = await port.result(ctx, handle);
    expect(result.status).toBe('failed');
    if (mode === 'approval') expect(sent).toContainEqual(expect.objectContaining({ id: 99, error: expect.any(Object) }));
    expect(sockets.every((socket) => socket.readyState === 3)).toBe(true);
  });
  it('rejects an untested provider version before creating a thread', async () => {
    fault = 'version';
    const port = setup();
    await expect(port.initialize(ctx)).rejects.toThrow('ERR_RUNTIME_PROTOCOL');
    expect(sent.some((frame) => frame.method === 'thread/start')).toBe(false);
  });
  it('sends turn/interrupt before closing a cancelled provider connection', async () => {
    fault = 'pending';
    const port = setup();
    const handle = await port.submit(ctx, request());
    await vi.waitFor(() => expect(sent.some((frame) => frame.method === 'turn/start')).toBe(true));
    expect((await port.cancel(ctx, handle)).status).toBe('cancelled');
    expect(sent.find((frame) => frame.method === 'turn/interrupt')?.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
  });
  it('rejects non-loopback endpoints and embedded credentials', () => {
    expect(() => new CodexAppServerAdapter('ws://example.com', '/tmp')).toThrow('ERR_RUNTIME_ENDPOINT');
    expect(() => new CodexAppServerAdapter('ws://user:password@127.0.0.1', '/tmp')).toThrow('ERR_RUNTIME_ENDPOINT');
  });
});
