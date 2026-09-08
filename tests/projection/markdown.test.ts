import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexedDbM1bAdapter, makeBatch, toStoredRecord } from '../../src/adapters/indexedDbM1b';
import { MarkdownProjectionAdapter, MARKDOWN_PROJECTION_ID } from '../../src/adapters/markdownProjection';
import { createBrowserInsightRuntime } from '../../src/application/browserRuntimeComposition';
import type { BrowserInsightRuntime } from '../../src/application/browserInsightRuntime';
import type { ProjectionHeadRecord } from '../../src/application/storageContracts';
import { hashCanonical, sha256 } from '../../src/domain/canonical';

const runtimes: BrowserInsightRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); });
async function setup() {
  const store = new IndexedDbM1bAdapter(`m3-projection-${crypto.randomUUID()}`);
  const core = createBrowserInsightRuntime({ adapterFactory: () => store, channelFactory: () => null });
  runtimes.push(core);
  await core.start();
  const preview = await core.preview();
  await core.commit(preview.token);
  return { store, core, projection: new MarkdownProjectionAdapter(store) };
}

describe('M3 Markdown and Obsidian projection', () => {
  it('keeps incremental correction output equal to a full rebuild, with explicit export confirmation', async () => {
    const { store, core, projection } = await setup();
    const first = await projection.rebuild();
    expect(first.mode).toBe('full');
    expect(first.documentCount).toBeGreaterThan(0);
    const snapshot = vi.spyOn(store, 'readCanonicalSnapshot');
    await core.submit('accept');
    snapshot.mockClear();
    const updated = await projection.rebuild();
    expect(updated.mode).toBe('incremental');
    expect(snapshot).not.toHaveBeenCalled();
    expect(updated.markdown).toContain('user-confirmed');
    const full = await projection.rebuild({ forceFull: true });
    expect(full.markdown).toBe(updated.markdown);
    const cursor = (await store.getMeta()).cursor;
    const exported = await projection.export({ capability: 'projection.export', confirmedHash: full.contentHash, acknowledgeIrrevocable: true });
    expect(exported).toMatchObject({ mediaType: 'text/markdown', notice: 'LOCAL_FILE_CANNOT_BE_REMOTELY_REVOKED', sourceCursor: cursor });
    expect((await store.getMeta()).cursor).toBe(cursor);
    await expect(projection.export({ capability: 'projection.export', confirmedHash: first.contentHash, acknowledgeIrrevocable: true })).rejects.toThrow('ERR_EXPORT_STALE');
  });
  it('falls back after a change-feed gap and handles numeric cursors past nine', async () => {
    const { store, core, projection } = await setup();
    await projection.rebuild();
    for (let i = 0; i < 12; i++) {
      const meta = await store.getMeta();
      await store.commit(makeBatch({ idempotencyKey: crypto.randomUUID(), expectedCursor: meta.cursor, expectedPrivacyEpoch: meta.privacyEpoch, storeNames: [], mutations: [] }));
    }
    expect((await projection.rebuild()).mode).toBe('full');
    await core.recover();
    await core.submit('accept');
    const incremental = await projection.rebuild();
    expect(incremental.mode).toBe('incremental');
    expect(incremental.markdown).toBe((await projection.rebuild({ forceFull: true })).markdown);
  });
  it('rejects a concurrent canonical write before publishing an old snapshot', async () => {
    const { store, projection } = await setup();
    const publish = store.publishProjection.bind(store);
    vi.spyOn(store, 'publishProjection').mockImplementationOnce(async (...args) => {
      const meta = await store.getMeta();
      await store.commit(makeBatch({ idempotencyKey: 'concurrent', expectedCursor: meta.cursor, expectedPrivacyEpoch: meta.privacyEpoch, storeNames: [], mutations: [] }));
      return publish(...args);
    });
    await expect(projection.rebuild()).rejects.toThrow('ERR_PROJECTION_STALE');
    expect(await store.getRecord('projection', MARKDOWN_PROJECTION_ID)).toBeUndefined();
  });
  it('detects manually edited projection content without changing canonical knowledge', async () => {
    const { store, core, projection } = await setup();
    await projection.rebuild();
    const head = (await store.getRecord<ProjectionHeadRecord>('projection', MARKDOWN_PROJECTION_ID))!;
    const payload = { ...(head.payload as object), markdown: 'user edit' };
    await store.publishProjection({ ...head, payload, projectionHash: hashCanonical(payload) }, head.sourceCursor);
    await expect(projection.rebuild()).rejects.toThrow('ERR_PROJECTION_CONFLICT');
    await expect(core.submit('accept')).resolves.toMatchObject({ record: { status: 'applied' } });
    await expect(core.evaluateReplay()).resolves.toBeDefined();
  });
  it('does not trust a consistently rehashed cached claim deletion, including after restart', async () => {
    const { store, projection } = await setup();
    const first = await projection.rebuild();
    const head = (await store.getRecord<ProjectionHeadRecord>('projection', MARKDOWN_PROJECTION_ID))!;
    const markdown = first.markdown.slice(0, first.markdown.indexOf('## ') - 1);
    const payload = { ...(head.payload as object), claims: [], markdown, contentHash: sha256(markdown) };
    await store.publishProjection({ ...head, payload, projectionHash: hashCanonical(payload) }, head.sourceCursor);
    await expect(projection.rebuild()).rejects.toThrow('ERR_PROJECTION_CONFLICT');
    await expect(new MarkdownProjectionAdapter(store).rebuild()).rejects.toThrow('ERR_PROJECTION_CONFLICT');
  });
  it('rejects export when the store incarnation changes at the same cursor', async () => {
    const { store, projection } = await setup();
    const first = await projection.rebuild();
    const meta = await store.getMeta();
    vi.spyOn(store, 'getMeta').mockResolvedValueOnce({ ...meta, incarnation: 'replacement-store' });
    await expect(projection.export({ capability: 'projection.export', confirmedHash: first.contentHash, acknowledgeIrrevocable: true })).rejects.toThrow('ERR_EXPORT_STALE');
  });
  it('propagates lineage deletion into managed Markdown and cannot resurrect it on rebuild', async () => {
    const { store, core, projection } = await setup();
    const first = await projection.rebuild();
    const head = (await store.getRecord<ProjectionHeadRecord>('projection', MARKDOWN_PROJECTION_ID))!;
    const claimId = (head.payload as { claims: { id: string }[] }).claims[0].id;
    await core.submit('delete');
    expect(await store.getRecord('projection', MARKDOWN_PROJECTION_ID)).toBeUndefined();
    const after = await projection.rebuild();
    expect(after.documentCount).toBeLessThan(first.documentCount);
    expect(JSON.stringify(await store.getRecord('projection', MARKDOWN_PROJECTION_ID))).not.toContain(claimId);
  });
  it('escapes active Markdown content and disabling projection preserves correction and Replay', async () => {
    const { store, core, projection } = await setup();
    const snapshot = await store.readCanonicalSnapshot();
    const record = snapshot.business.find((record) => record.recordType === 'work_model_claim_v1')!;
    const base = { ...(record.payload as object), id: 'escape-test', claimKey: 'escape-test', statement: '![image](https://example.test/leak) <script> ![[embed]]' };
    const claim = { ...base, contentHash: hashCanonical(Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'contentHash'))) };
    await store.commit(makeBatch({ idempotencyKey: 'escape-test', expectedCursor: snapshot.meta.cursor, expectedPrivacyEpoch: snapshot.meta.privacyEpoch, storeNames: ['business'], mutations: [{ kind: 'insertImmutable', storeName: 'business', record: toStoredRecord('escape-test', 'work_model_claim_v1', claim) }] }));
    const output = await projection.rebuild();
    expect(output.markdown).not.toContain('![');
    expect(output.markdown).not.toContain('<script>');
    projection.disable();
    await expect(projection.rebuild()).rejects.toThrow('ERR_PROJECTION_DISABLED');
    await core.recover();
    await expect(core.submit('accept')).resolves.toBeDefined();
    await expect(core.evaluateReplay()).resolves.toBeDefined();
  });
});
