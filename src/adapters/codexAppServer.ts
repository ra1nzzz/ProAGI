import { z } from 'zod';
import { RUNTIME_CAPABILITIES, RUNTIME_PROTOCOL_VERSION, type EvaluationInput, type RuntimeDriver } from '../application/runtimePort';

const object = z.record(z.string(), z.unknown());
const threadResponse = z.object({ thread: z.object({ id: z.string().min(1), ephemeral: z.literal(true) }), sandbox: z.object({ type: z.literal('readOnly') }) });
const turnResponse = z.object({ turn: z.object({ id: z.string().min(1) }) });
const outputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['sufficient', 'insufficient'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasonCode: { type: 'string', enum: ['NO_EVIDENCE', 'NEEDS_REVIEW', 'HAS_CONFIRMED_KNOWLEDGE'] },
  },
  required: ['verdict', 'confidence', 'reasonCode'],
};

/** Codex v2 JSON-RPC adapter. Each evaluation owns an ephemeral thread and connection. */
export class CodexAppServerAdapter implements RuntimeDriver {
  private readonly connections = new Set<CodexConnection>();
  private disposed = false;

  constructor(private readonly endpoint: string, private readonly isolatedCwd: string) {
    const url = new URL(endpoint);
    if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('ERR_RUNTIME_ENDPOINT');
    if (!isolatedCwd) throw new Error('ERR_RUNTIME_WORKSPACE');
  }

  async initialize(signal: AbortSignal) {
    const connection = await this.connect(signal);
    this.release(connection);
    return { runtimeId: 'codex-app-server', protocolVersion: RUNTIME_PROTOCOL_VERSION, capabilities: RUNTIME_CAPABILITIES };
  }

  async evaluate(input: EvaluationInput, signal: AbortSignal): Promise<unknown> {
    const connection = await this.connect(signal);
    try {
      const rawThread = await connection.call('thread/start', {
        ephemeral: true, cwd: this.isolatedCwd, approvalPolicy: 'never', sandbox: 'read-only',
        baseInstructions: 'Evaluate only the supplied aggregate numbers. Return the required JSON object. Do not use tools, files, network, skills, or external context.',
        config: { web_search: 'disabled', 'features.shell_tool': false, 'features.apps': false, 'features.plugins': false },
      });
      const thread = threadResponse.safeParse(rawThread);
      if (!thread.success) throw new Error('ERR_RUNTIME_PROTOCOL');
      signal.throwIfAborted();
      const threadId = thread.data.thread.id;
      let turnId: string | undefined;
      let output: string | undefined;
      let outputTurnId: string | undefined;
      let completedTurn: { id: string; status: string } | undefined;
      let finish!: (output: unknown) => void;
      let fail!: (error: Error) => void;
      const completion = new Promise<unknown>((resolve, reject) => { finish = resolve; fail = reject; });
      // Attach a handler immediately; a transport error may precede turn/start's response.
      void completion.catch(() => undefined);
      const maybeFinish = () => {
        if (!completedTurn || !turnId) return;
        if (completedTurn.id !== turnId || outputTurnId !== turnId || completedTurn.status !== 'completed' || output === undefined) { fail(new Error('ERR_RUNTIME_PROTOCOL')); return; }
        try { finish(JSON.parse(output)); } catch { fail(new Error('ERR_RUNTIME_PROTOCOL')); }
      };
      connection.onFailure = fail;
      connection.onNotification = (method, params) => {
        if (params.threadId !== threadId) return;
        if (method === 'item/completed') {
          const item = object.safeParse(params.item);
          if (!item.success) { fail(new Error('ERR_RUNTIME_PROTOCOL')); return; }
          if (item.data.type === 'agentMessage' && (item.data.phase === 'final_answer' || item.data.phase == null)) {
            if (typeof params.turnId !== 'string' || (turnId !== undefined && params.turnId !== turnId) || (outputTurnId !== undefined && params.turnId !== outputTurnId)) { fail(new Error('ERR_RUNTIME_PROTOCOL')); return; }
            if (typeof item.data.text !== 'string' || item.data.text.length > 16_384 || (output !== undefined && output !== item.data.text)) { fail(new Error('ERR_RUNTIME_PROTOCOL')); return; }
            output = item.data.text;
            outputTurnId = params.turnId;
          }
          // A tool item is a protocol violation, never a Core action or an approval.
          if (!['agentMessage', 'userMessage', 'reasoning', 'plan'].includes(String(item.data.type))) fail(new Error('ERR_RUNTIME_PROTOCOL'));
        }
        if (method === 'turn/completed') {
          const parsed = z.object({ id: z.string(), status: z.string() }).safeParse(params.turn);
          if (!parsed.success) { fail(new Error('ERR_RUNTIME_PROTOCOL')); return; }
          completedTurn = parsed.data;
          maybeFinish();
        }
      };
      const abort = () => {
        if (turnId) connection.notifyRequest('turn/interrupt', { threadId, turnId });
        fail(new Error('ERR_RUNTIME_CANCELLED'));
      };
      connection.onAbort = abort;
      try {
        const turn = turnResponse.safeParse(await connection.call('turn/start', {
          threadId, input: [{ type: 'text', text: JSON.stringify(input) }], approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', access: { type: 'restricted', includePlatformDefaults: false, readableRoots: [] } },
          outputSchema,
        }));
        if (!turn.success) throw new Error('ERR_RUNTIME_PROTOCOL');
        turnId = turn.data.turn.id;
        maybeFinish();
        signal.throwIfAborted();
        return await completion;
      } finally { connection.onAbort = () => undefined; }
    } finally { this.release(connection); }
  }

  dispose(): void {
    this.disposed = true;
    for (const connection of this.connections) connection.close();
    this.connections.clear();
  }

  private async connect(signal: AbortSignal): Promise<CodexConnection> {
    if (this.disposed) throw new Error('ERR_RUNTIME_DISPOSED');
    signal.throwIfAborted();
    const connection = new CodexConnection(new WebSocket(this.endpoint), signal);
    this.connections.add(connection);
    try {
      await connection.ready;
      const handshake = z.object({ userAgent: z.string().min(1), platformFamily: z.string(), platformOs: z.string() }).safeParse(await connection.call('initialize', {
        clientInfo: { name: 'proagi_insight', title: 'ProAGI Insight', version: '0.1.0' },
      }));
      // Pin the tested CLI family; future provider protocol changes require a fresh smoke.
      if (!handshake.success || !/\b0\.153\.\d+\b/.test(handshake.data.userAgent)) throw new Error('ERR_RUNTIME_PROTOCOL');
      connection.notify('initialized', {});
      return connection;
    } catch (error) { this.release(connection); throw error; }
  }
  private release(connection: CodexConnection): void { connection.close(); this.connections.delete(connection); }
}

class CodexConnection {
  readonly ready: Promise<void>;
  onNotification: (method: string, params: Record<string, unknown>) => void = () => undefined;
  onFailure: (error: Error) => void = () => undefined;
  onAbort: () => void = () => undefined;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly abort: () => void;
  private readonly signal: AbortSignal;

  constructor(private readonly socket: WebSocket, signal: AbortSignal) {
    this.signal = signal;
    this.abort = () => { this.onAbort(); this.close(); };
    signal.addEventListener('abort', this.abort, { once: true });
    this.ready = new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      const failed = () => reject(new Error('ERR_RUNTIME_UNAVAILABLE'));
      socket.addEventListener('error', failed, { once: true });
      socket.addEventListener('close', failed, { once: true });
    });
    socket.addEventListener('message', (event) => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 131_072) throw new Error('ERR_RUNTIME_PROTOCOL');
        const message = object.parse(JSON.parse(event.data));
        if (typeof message.method === 'string') {
          if ('id' in message) {
            socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Client capabilities do not include tools or approvals' } }));
            throw new Error('ERR_RUNTIME_PROTOCOL');
          }
          this.onNotification(message.method, object.parse(message.params ?? {}));
        } else if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id);
          if (!pending) return; // Duplicate or already-cancelled response.
          this.pending.delete(message.id);
          if ('error' in message || !('result' in message)) pending.reject(new Error('ERR_RUNTIME_PROTOCOL'));
          else pending.resolve(message.result);
        } else throw new Error('ERR_RUNTIME_PROTOCOL');
      } catch { this.fail(new Error('ERR_RUNTIME_PROTOCOL')); }
    });
    socket.addEventListener('close', () => this.fail(new Error('ERR_RUNTIME_UNAVAILABLE')));
    socket.addEventListener('error', () => this.fail(new Error('ERR_RUNTIME_UNAVAILABLE')));
  }
  call(method: string, params: unknown): Promise<unknown> {
    if (this.socket.readyState !== 1 || this.signal.aborted) return Promise.reject(new Error('ERR_RUNTIME_UNAVAILABLE'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { this.pending.delete(id); reject(new Error('ERR_RUNTIME_UNAVAILABLE')); }
    });
  }
  notify(method: string, params: unknown): void { this.socket.send(JSON.stringify({ method, params })); }
  notifyRequest(method: string, params: unknown): void {
    if (this.socket.readyState === 1) this.socket.send(JSON.stringify({ id: ++this.nextId, method, params }));
  }
  close(): void {
    this.signal.removeEventListener('abort', this.abort);
    this.fail(new Error('ERR_RUNTIME_UNAVAILABLE'));
    this.onNotification = () => undefined;
    this.onFailure = () => undefined;
    this.socket.close();
  }
  private fail(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.onFailure(error);
  }
}
