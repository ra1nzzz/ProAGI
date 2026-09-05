import { NdjsonWorkerProtocol, WorkerProtocolError, type NdjsonHeader } from './ndjsonProtocol';

export type NdjsonWorkerInput =
  | { type: 'INIT'; streamId: string; header: NdjsonHeader; maxChunkBytes: number; maxUnacked: 2 }
  | { type: 'CHUNK'; streamId: string; chunkId: string; sequence: string; bytes: ArrayBuffer; byteLength: number }
  | { type: 'ACK'; streamId: string; chunkId: string; sequence: string }
  | { type: 'CANCEL'; streamId: string }
  | { type: 'FINISH'; streamId: string };

export interface WorkerMessageScope {
  onmessage: ((event: MessageEvent<NdjsonWorkerInput>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export function installNdjsonWorker(scope: WorkerMessageScope): () => void {
  let protocol: NdjsonWorkerProtocol | undefined;
  scope.onmessage = (event) => {
    const message = event.data;
    try {
      if (message.type === 'INIT') {
        if (protocol) throw new WorkerProtocolError('ERR_WORKER_ALREADY_INITIALIZED');
        protocol = new NdjsonWorkerProtocol(message.streamId, message.header, message.maxChunkBytes, message.maxUnacked);
        return;
      }
      if (!protocol) throw new WorkerProtocolError('ERR_WORKER_NOT_INITIALIZED');
      if (message.type === 'CHUNK') {
        const result = protocol.pushChunk(message);
        if (result.status === 'backpressure') {
          scope.postMessage({ ...result, streamId: message.streamId, chunkId: message.chunkId, sequence: message.sequence, bytes: message.bytes }, [message.bytes]);
        } else {
          scope.postMessage(result);
        }
      } else if (message.type === 'ACK') {
        protocol.ack(message);
      } else if (message.type === 'CANCEL') {
        scope.postMessage(protocol.cancel());
      } else if (message.type === 'FINISH') {
        scope.postMessage(protocol.finish());
      }
    } catch (error) {
      scope.postMessage({
        type: 'ERROR',
        streamId: message.streamId,
        errorCode: error instanceof WorkerProtocolError ? error.code : 'ERR_WORKER_FAILURE',
      });
    }
  };
  return () => {
    protocol?.dispose();
    protocol = undefined;
    scope.onmessage = null;
  };
}
