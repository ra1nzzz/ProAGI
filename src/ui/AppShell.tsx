import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createWindowRuntimeNotificationPort } from '../application/browserInsightRuntime';
import type { BrowserInsightRuntime, BrowserRuntimeTestHooks } from '../application/browserInsightRuntime';
import { createBrowserInsightRuntime, DEFAULT_RUNTIME_DATABASE_NAME } from '../application/browserRuntimeComposition';
import { IndexedDbM1bAdapter } from '../adapters/indexedDbM1b';
import { MarkdownProjectionAdapter } from '../adapters/markdownProjection';
import { EXTERNAL_PURGE_EVENT, PURGE_COMMITTED_EVENT, RUNTIME_ERROR_EVENT, RUNTIME_SNAPSHOT_EVENT, type ExternalPurgeNotification, type PurgeCommittedNotification, type RuntimeErrorNotification, type RuntimeNotificationPort, type RuntimeSnapshotNotification } from '../application/ports';
import type { ImportCommit } from '../application/insightService';
import type { CorrectionAction } from '../domain/types';
import type { ReplaySnapshotV1 } from '../domain/replay';
import type { ReadonlyConsentSnapshot } from '../application/m2Consent';
import type { MarkdownProjection } from '../application/projectionPort';
import type { TraceExportPreview, TraceManualCheck } from '../application/trace';
import type { Hash } from '../domain/types';
import { sha256 } from '../domain/canonical';
import { ORB_STATES, ORB_STATE_LABELS, type ContentMode, type OrbState } from './demoViewModel';
import { buildInsightPresentation } from './presentation';
import { Orb, type OrbProfile } from './Orb';
import { RecoverySurface, type RecoveryKind } from './RecoverySurface';

interface ProagiE2eHarness {
  hit?: (name: 'commit:after-persisted' | 'purge:before-release') => Promise<void>;
  deletionResponseLoss?: boolean;
  runtime?: {
    importWithResponseLoss: () => Promise<void>;
    deleteWithResponseLoss?: () => Promise<void>;
    projectionRebuild?: (forceFull?: boolean) => Promise<MarkdownProjection>;
  };
}

const stateShortLabels: Readonly<Record<OrbState, string>> = {
  LEARNING: '学习',
  EXECUTING: '本地执行',
  IDLE: '空闲',
  SUGGESTION: '建议',
  PRIVATE: '隐私',
  ERROR: '错误',
};

const MANUAL_TRACE_CASES = [
  { value: 'M1c.nvda', label: 'M1c · NVDA' },
  { value: 'M1c.visual', label: 'M1c · 人工视觉' },
  { value: 'M2.pilot', label: 'M2 · participant pilot' },
  { value: 'M3.live-model', label: 'M3 · live-model evaluation' },
  { value: 'M5.native-smoke', label: 'M5 · native/EXE smoke' },
] as const;
type ManualTraceCaseId = typeof MANUAL_TRACE_CASES[number]['value'];

export interface AppShellProps {
  readonly runtimeFactory?: (notificationPort: RuntimeNotificationPort) => BrowserInsightRuntime;
}

export function AppShell({ runtimeFactory }: AppShellProps = {}) {
  const [orbState, setOrbState] = useState<OrbState>('IDLE');
  const [previousState, setPreviousState] = useState<OrbState>('IDLE');
  const [canonicalPrivate, setCanonicalPrivate] = useState(false);
  const [orbProfile, setOrbProfile] = useState<OrbProfile>('quiet');
  const [contentMode, setContentMode] = useState<ContentMode>('content');
  const [recovery, setRecovery] = useState<RecoveryKind | null>(null);
  const [runtimeFaulted, setRuntimeFaulted] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const recoveryInvokerRef = useRef<HTMLElement>(null);
  const detailInvokerRef = useRef<HTMLElement>(null);
  const deleteInvokerRef = useRef<HTMLButtonElement>(null);
  const detailDrawerRef = useRef<HTMLElement>(null);
  const detailCloseRef = useRef<HTMLButtonElement>(null);
  const runtimeRef = useRef<BrowserInsightRuntime | null>(null);
  const [imported, setImported] = useState<ImportCommit | null>(null);
  const [replaySnapshot, setReplaySnapshot] = useState<ReplaySnapshotV1 | null>(null);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const uiEpochRef = useRef(0);
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [domainStatus, setDomainStatus] = useState('正在读取本地 canonical store…');
  const [domainRevision, setDomainRevision] = useState(0);
  const purgeCommitCallbacksRef = useRef<PurgeCommittedNotification[]>([]);
  const [purgeCommitVersion, setPurgeCommitVersion] = useState(0);
  const [readonlyConsent, setReadonlyConsent] = useState<ReadonlyConsentSnapshot | null>(null);
  const [readonlyFile, setReadonlyFile] = useState<File | null>(null);
  const [readonlyConsentOpen, setReadonlyConsentOpen] = useState(false);
  const [readonlyBusy, setReadonlyBusy] = useState(false);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [eventTtlDays, setEventTtlDays] = useState(7);
  const [derivedTtlDays, setDerivedTtlDays] = useState(30);
  const readonlyFileRef = useRef<HTMLInputElement>(null);
  const projectionStoreRef = useRef<IndexedDbM1bAdapter | null>(null);
  const projectionRef = useRef<MarkdownProjectionAdapter | null>(null);
  const projectionRequestRef = useRef(0);
  const [projection, setProjection] = useState<MarkdownProjection | null>(null);
  const [projectionEnabled, setProjectionEnabled] = useState(false);
  const [projectionBusy, setProjectionBusy] = useState(false);
  const [projectionError, setProjectionError] = useState<string | null>(null);
  const [projectionExportOpen, setProjectionExportOpen] = useState(false);
  const [projectionExportAcknowledged, setProjectionExportAcknowledged] = useState(false);
  const [tracePreview, setTracePreview] = useState<TraceExportPreview | null>(null);
  const [traceExportOpen, setTraceExportOpen] = useState(false);
  const [traceExportAcknowledged, setTraceExportAcknowledged] = useState(false);
  const [traceBusy, setTraceBusy] = useState(false);
  const [manualTraceCaseId, setManualTraceCaseId] = useState<ManualTraceCaseId>('M1c.visual');
  const [manualTraceStepId, setManualTraceStepId] = useState('visual-approval');
  const [manualTraceReviewerId, setManualTraceReviewerId] = useState('');
  const [manualTraceResult, setManualTraceResult] = useState<TraceManualCheck['result']>('NOT_RUN');
  const [manualTraceArtifactHash, setManualTraceArtifactHash] = useState('');

  const privateMode = canonicalPrivate;

  const disposeProjection = useCallback(() => {
    projectionRequestRef.current += 1;
    projectionRef.current?.disable();
    projectionRef.current = null;
    projectionStoreRef.current?.dispose();
    projectionStoreRef.current = null;
    setProjection(null);
    setProjectionEnabled(false);
    setProjectionBusy(false);
    setProjectionError(null);
    setProjectionExportOpen(false);
    setProjectionExportAcknowledged(false);
  }, []);

  const invalidateProjection = useCallback(() => {
    projectionRequestRef.current += 1;
    setProjection(null);
    setProjectionBusy(false);
    setProjectionExportOpen(false);
    setProjectionExportAcknowledged(false);
  }, []);

  useLayoutEffect(() => {
    let mounted = true;
    const pendingCallbacks = purgeCommitCallbacksRef;
    const handleExternalPurge = (event: Event) => {
      const detail = (event as CustomEvent<ExternalPurgeNotification>).detail;
      if (detail?.external !== false) uiEpochRef.current += 1;
      disposeProjection();
      setImported(null);
      setReplaySnapshot(null);
      setPreviewToken(null);
      setPreviewBusy(false);
      setDeletionBusy(false);
      setDeleteConfirmOpen(false);
      setDomainStatus(detail?.external === false
        ? '本页正在执行隐私清除；当前视图已释放旧数据。'
        : '其他标签页正在执行隐私清除；当前视图已释放旧数据，等待 canonical verification。');
      setOrbState('IDLE');
      if (mounted && detail?.requestId) purgeCommitCallbacksRef.current.push({ requestId: detail.requestId });
      setPurgeCommitVersion((version) => version + 1);
    };
    const handleRuntimeSnapshot = (event: Event) => {
      const detail = (event as CustomEvent<RuntimeSnapshotNotification>).detail;
      if (!detail) return;
      if ((detail.purge && !detail.purgeVerified) || (detail.purgeVerified && detail.externalPurge)) uiEpochRef.current += 1;
      if (detail.imported !== undefined) {
        setImported(detail.imported);
        setReplaySnapshot(null);
        invalidateProjection();
      }
      if (detail.observationMode) {
        setCanonicalPrivate(detail.observationMode === 'PRIVATE');
        if (detail.observationMode === 'PRIVATE') disposeProjection();
      }
       if (detail.runtimeFaulted !== undefined) setRuntimeFaulted(detail.runtimeFaulted);
      if (detail.purge) {
        disposeProjection();
        setReplaySnapshot(null);
        setPreviewToken(null);
        setPreviewBusy(false);
        setDeletionBusy(false);
        setDeleteConfirmOpen(false);
        setOrbState('IDLE');
      }
      if (detail.purgeVerified) {
        setDomainStatus(`${detail.externalPurge ? '其他标签页' : '本页'}已完成隐私清除，并经 canonical store 验证。`);
      } else if (!detail.purge && detail.imported !== undefined) {
        setDomainStatus(detail.imported ? '本地 canonical store 已刷新。' : '本地 canonical store 已就绪；尚未提交 bundled fixture。');
      }
    };
    const handleRuntimeError = (event: Event) => {
      const detail = (event as CustomEvent<RuntimeErrorNotification>).detail;
      if (!detail || typeof detail.code !== 'string' || typeof detail.operation !== 'string') return;
      uiEpochRef.current += 1;
      disposeProjection();
      setRuntimeFaulted(true);
       setRecovery(detail.code.includes('PURGE') ? 'blocked' : 'recovery');
      setOrbState('ERROR');
      setPreviewBusy(false);
      setDeletionBusy(false);
      setDomainStatus('本地运行时需要安全恢复；普通写入已暂停。');
      setAnnouncement(`本地运行时报告 ${detail.code}（${detail.operation}），请重试恢复。`);
    };
    window.addEventListener(EXTERNAL_PURGE_EVENT, handleExternalPurge);
    window.addEventListener(RUNTIME_SNAPSHOT_EVENT, handleRuntimeSnapshot);
    window.addEventListener(RUNTIME_ERROR_EVENT, handleRuntimeError);
    return () => {
      mounted = false;
      pendingCallbacks.current.splice(0);
      window.removeEventListener(EXTERNAL_PURGE_EVENT, handleExternalPurge);
      window.removeEventListener(RUNTIME_SNAPSHOT_EVENT, handleRuntimeSnapshot);
      window.removeEventListener(RUNTIME_ERROR_EVENT, handleRuntimeError);
    };
  }, [disposeProjection, invalidateProjection]);

  useLayoutEffect(() => {
    const callbacks = purgeCommitCallbacksRef.current.splice(0);
    callbacks.forEach((detail) => window.dispatchEvent(new CustomEvent<PurgeCommittedNotification>(PURGE_COMMITTED_EVENT, { detail })));
  }, [purgeCommitVersion]);

  useEffect(() => {
    let active = true;
    let runtime: BrowserInsightRuntime;
    let closeProjection: () => void = () => undefined;
    const notificationPort = createWindowRuntimeNotificationPort();
    if (import.meta.env.VITE_PROAGI_E2E_HOOKS === '1') {
      const harness = (window as Window & { __proagiE2e?: ProagiE2eHarness }).__proagiE2e;
      const testHooks: BrowserRuntimeTestHooks = {
        afterCommitPersisted: () => harness?.hit?.('commit:after-persisted'),
        beforePurgeRelease: () => harness?.hit?.('purge:before-release'),
        simulateDeletionResponseLoss: () => harness?.deletionResponseLoss === true,
      };
      runtime = createBrowserInsightRuntime({ testHooks, notificationPort });
      if (harness) {
        let projection: Promise<import('../adapters/markdownProjection').MarkdownProjectionAdapter> | undefined;
        harness.runtime = {
          projectionRebuild: async (forceFull = false) => {
            projection ??= Promise.all([import('../adapters/indexedDbM1b'), import('../adapters/markdownProjection')]).then(([{ IndexedDbM1bAdapter }, { MarkdownProjectionAdapter }]) => {
              if (!active) throw new Error('ERR_PROJECTION_DISABLED');
              const store = new IndexedDbM1bAdapter('proagi-insight-loop-m1-v1');
              const adapter = new MarkdownProjectionAdapter(store);
              closeProjection = () => { adapter.disable(); store.dispose(); };
              return adapter;
            });
            return (await projection).rebuild({ forceFull });
          },
          importWithResponseLoss: async () => {
            await runtime.preview();
            await runtime.commitBundled({ simulateResponseLoss: true });
          },
          deleteWithResponseLoss: async () => {
            harness.deletionResponseLoss = true;
            try {
              await runtime.preview();
              await runtime.commitBundled();
              await runtime.submit('delete');
            } finally {
              harness.deletionResponseLoss = false;
            }
          },
        };
      }
    } else {
      runtime = runtimeFactory ? runtimeFactory(notificationPort) : createBrowserInsightRuntime({ notificationPort });
    }
    runtimeRef.current = runtime;
    setRuntimeReady(true);
    const epoch = uiEpochRef.current;
    const consentLoadTimer = window.setTimeout(() => {
      void runtime.getReadonlyConsent().then((consent) => {
        if (active && epoch === uiEpochRef.current) setReadonlyConsent(consent);
      }).catch(() => undefined);
    }, 250);
    void runtime.start().then((snapshot) => {
      if (!active || epoch !== uiEpochRef.current) return;
      setImported(snapshot.imported);
      setReadonlyConsent(snapshot.readonlyConsent);
      setReplaySnapshot(null);
      setCanonicalPrivate(snapshot.observationMode === 'PRIVATE');
      setRuntimeFaulted(snapshot.runtimeFaulted);
       if (snapshot.observationMode === 'PRIVATE') {
        setPreviousState('IDLE');
        setOrbState('PRIVATE');
        setDomainStatus('已从本地 canonical store 恢复隐私模式。');
      } else {
        setDomainStatus(snapshot.imported ? `已从本地 canonical store 恢复，cursor ${snapshot.cursor}。` : '本地 canonical store 已就绪；尚未提交 bundled fixture。');
      }
    }).catch((error) => {
      if (!active || epoch !== uiEpochRef.current) return;
      setOrbState('ERROR');
      setRuntimeFaulted(true);
       setDomainStatus(`本地 canonical store 无法打开（${safeErrorCode(error)}）；写操作已禁用。`);

    });
    return () => {
      active = false;
      window.clearTimeout(consentLoadTimer);
      closeProjection();
      projectionRequestRef.current += 1;
      projectionRef.current?.disable();
      projectionRef.current = null;
      projectionStoreRef.current?.dispose();
      projectionStoreRef.current = null;
      uiEpochRef.current += 1;
      if (runtimeRef.current === runtime) runtimeRef.current = null;
       void runtime.close();

    };
  }, [runtimeFactory]);

  useEffect(() => {
    if (!detailOpen) return;
    const returnTarget = detailInvokerRef.current;
    detailCloseRef.current?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDetailOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !detailDrawerRef.current) return;
      const focusable = Array.from(detailDrawerRef.current.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])'))
        .filter((element) => !element.hasAttribute('disabled'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [detailOpen]);

  useEffect(() => {
    if (!deleteConfirmOpen) return;
    const returnTarget = deleteInvokerRef.current;
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    const cancel = dialog?.querySelector<HTMLButtonElement>('button');
    cancel?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setDeleteConfirmOpen(false); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).filter((el) => !el.disabled);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('keydown', handleKeyDown); if (returnTarget?.isConnected) returnTarget.focus(); };
  }, [deleteConfirmOpen]);

  const syncRuntimeFault = async (epoch: number): Promise<boolean> => {
    if (epoch !== uiEpochRef.current) return false;
    const runtime = runtimeRef.current;
    if (!runtime) return false;
    try {
      const snapshot = await runtime.snapshot();
      if (epoch !== uiEpochRef.current) return false;
      setRuntimeFaulted(snapshot.runtimeFaulted);
      if (snapshot.runtimeFaulted) {
        setRecovery('recovery');
        setOrbState('ERROR');
      }
      return snapshot.runtimeFaulted;
    } catch {
      if (epoch !== uiEpochRef.current) return false;
      setRuntimeFaulted(true);
      setRecovery('recovery');
      setOrbState('ERROR');
      return true;
    }
  };

  const getProjectionAdapter = (): MarkdownProjectionAdapter => {
    let adapter = projectionRef.current;
    if (!adapter) {
      const store = new IndexedDbM1bAdapter(DEFAULT_RUNTIME_DATABASE_NAME);
      adapter = new MarkdownProjectionAdapter(store);
      projectionStoreRef.current = store;
      projectionRef.current = adapter;
    }
    return adapter;
  };

  const rebuildProjection = async (forceFull = false) => {
    const epoch = uiEpochRef.current;
    if (runtimeFaulted) {
      setProjectionError('ERR_RUNTIME_FAULTED');
      return;
    }
    if (privateMode) {
      setProjectionError('ERR_PRIVATE_MODE');
      return;
    }
    if (!runtimeReady) {
      setProjectionError('ERR_RUNTIME_UNAVAILABLE');
      return;
    }
    const request = projectionRequestRef.current + 1;
    projectionRequestRef.current = request;
    setProjectionBusy(true);
    setProjectionError(null);
    try {
      const next = await getProjectionAdapter().rebuild({ forceFull });
      if (epoch !== uiEpochRef.current || request !== projectionRequestRef.current) return;
      setProjection(next);
      setProjectionEnabled(true);
      setAnnouncement(`Markdown 投影已${forceFull ? '全量' : '增量'}重建，${next.documentCount} 个文档。`);
    } catch (error) {
      if (epoch !== uiEpochRef.current || request !== projectionRequestRef.current) return;
      disposeProjection();
      setProjectionError(safeErrorCode(error));
      setAnnouncement('Markdown 投影已停用；canonical store 与 Insight Loop 未受影响。');
    } finally {
      if (epoch === uiEpochRef.current && request === projectionRequestRef.current) setProjectionBusy(false);
    }
  };

  const openProjectionExport = () => {
    if (!projection || !projectionRef.current || projectionBusy) return;
    setProjectionExportAcknowledged(false);
    setProjectionExportOpen(true);
  };

  const exportProjection = async () => {
    const epoch = uiEpochRef.current;
    const current = projection;
    const adapter = projectionRef.current;
    const request = projectionRequestRef.current;
    if (!current || !adapter || !projectionExportAcknowledged) return;
    setProjectionBusy(true);
    try {
      const artifact = await adapter.export({
        capability: 'projection.export',
        confirmedHash: current.contentHash,
        acknowledgeIrrevocable: true,
      });
      if (epoch !== uiEpochRef.current || request !== projectionRequestRef.current) return;
      const url = URL.createObjectURL(new Blob([artifact.markdown], { type: `${artifact.mediaType};charset=utf-8` }));
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = artifact.filename;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      setProjection(artifact);
      setProjectionExportOpen(false);
      setProjectionExportAcknowledged(false);
      setAnnouncement('Markdown 已导出为本地文件；应用不会自动写入 Obsidian Vault。');
    } catch (error) {
      if (epoch !== uiEpochRef.current || request !== projectionRequestRef.current) return;
      disposeProjection();
      setProjectionError(safeErrorCode(error));
      setAnnouncement('Markdown 导出未完成；投影已停用，canonical store 未受影响。');
    } finally {
      if (epoch === uiEpochRef.current && request === projectionRequestRef.current) setProjectionBusy(false);
    }
  };

  const disableProjection = () => {
    disposeProjection();
    setAnnouncement('Markdown 投影已禁用；canonical store 未改变。');
  };

  const prepareTraceExport = async () => {
    const runtime = runtimeRef.current;
    if (!runtime || traceBusy) return;
    setTraceBusy(true);
    try {
      const next = await runtime.prepareTraceExport();
      setTracePreview(next);
      setTraceExportAcknowledged(false);
      setTraceExportOpen(true);
      setAnnouncement(`TRACE 诊断包已准备，包含 ${next.eventCount} 条脱敏事件。`);
    } catch (error) {
      setAnnouncement(`TRACE 诊断包准备失败（${safeErrorCode(error)}）。`);
    } finally {
      setTraceBusy(false);
    }
  };

  const exportTrace = async () => {
    const runtime = runtimeRef.current;
    const current = tracePreview;
    if (!runtime || !current || !traceExportAcknowledged || traceBusy) return;
    setTraceBusy(true);
    try {
      const artifact = await runtime.exportTrace({ confirmedHash: current.contentHash, acknowledgeIrrevocable: true });
      const url = URL.createObjectURL(new Blob([artifact.content], { type: `${artifact.mediaType};charset=utf-8` }));
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = artifact.filename;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      setTracePreview(artifact);
      setTraceExportOpen(false);
      setTraceExportAcknowledged(false);
      setAnnouncement('TRACE 诊断包已导出；内容仅含脱敏本地诊断与哈希。');
    } catch (error) {
      setAnnouncement(`TRACE 导出未完成（${safeErrorCode(error)}）；请重新准备。`);
    } finally {
      setTraceBusy(false);
    }
  };

  const recordManualTraceCheck = async () => {
    const runtime = runtimeRef.current;
    if (!runtime || traceBusy) return;
    setTraceBusy(true);
    try {
      const artifactHash = manualTraceArtifactHash.trim();
      await runtime.recordManualCheck({
        caseId: manualTraceCaseId,
        stepId: manualTraceStepId.trim(),
        reviewerId: manualTraceReviewerId.trim(),
        result: manualTraceResult,
        artifactHashes: artifactHash ? [artifactHash as Hash] : [],
      });
      setTracePreview(null);
      setTraceExportOpen(false);
      setTraceExportAcknowledged(false);
      setAnnouncement('人工核验结果已记录到 TRACE；请重新准备诊断包。');
    } catch (error) {
      setAnnouncement(`人工核验未记录（${safeErrorCode(error)}）。`);
    } finally {
      setTraceBusy(false);
    }
  };

  const togglePrivacy = async () => {
    if (runtimeFaulted) {
      setDomainStatus('本地运行时需要先完成安全恢复；普通写入保持暂停。');
      return;
    }
    const epoch = uiEpochRef.current;
    const nextMode = privateMode ? 'ACTIVE' : 'PRIVATE';
    try {
      const receipt = nextMode === 'PRIVATE'
        ? await runtimeRef.current!.pausePrivacy()
        : await runtimeRef.current!.resumePrivacy();
      if (epoch !== uiEpochRef.current) return;
      if (nextMode === 'PRIVATE') {
        disposeProjection();
      }
      setCanonicalPrivate(nextMode === 'PRIVATE');
       if (nextMode === 'PRIVATE') {
        setPreviewToken(null);
        setPreviousState(orbState === 'PRIVATE' ? 'IDLE' : orbState);
        setOrbState('PRIVATE');
        setAnnouncement(`隐私模式已开启，privacy epoch ${receipt.privacyEpoch}；未提交 preview 已失效。`);
      } else {
        setOrbState(previousState === 'PRIVATE' ? 'IDLE' : previousState);
        setAnnouncement(`隐私模式已关闭，privacy epoch ${receipt.privacyEpoch}；不会补录暂停期间事件。`);
      }
    } catch {
      if (epoch !== uiEpochRef.current) return;
      await syncRuntimeFault(epoch);
      if (epoch !== uiEpochRef.current) return;
      setOrbState('ERROR');
      setDomainStatus('隐私模式事务失败；写操作保持受阻。');
    }
  };

  const chooseState = (state: OrbState) => {
    // This isolated View Model picker is visual-only; canonical privacy gates use canonicalPrivate.
    if (state !== 'PRIVATE') setPreviousState(state);
    setOrbState(state);
    setAnnouncement(`演示状态已切换：${ORB_STATE_LABELS[state]}（不改变 canonical runtime）`);
  };

  const startRecovery = (invoker: HTMLElement, kind: RecoveryKind) => {
    recoveryInvokerRef.current = invoker;
    setRecovery(kind);
    setPreviousState(orbState === 'PRIVATE' ? previousState : orbState);
    if (orbState !== 'PRIVATE') setOrbState('ERROR');
  };

  const endRecovery = () => {
    setRecovery(null);
    setOrbState(privateMode ? 'PRIVATE' : 'LEARNING');
    setAnnouncement('恢复演示已结束。尚未连接真实存储。');
  };

  const chooseReadonlyFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
      setReadonlyFile(file);
    if (file) { setRiskAccepted(false); setReadonlyConsentOpen(true); }
    event.target.value = '';
  };

  const authorizeReadonlyFile = async () => {
    const file = readonlyFile;
    const epoch = uiEpochRef.current + 1;
    uiEpochRef.current = epoch;
    if (!file || !runtimeRef.current) return;
    if (!riskAccepted) { setDomainStatus('请先明确接受 local-first 剩余风险。'); return; }
    setReadonlyBusy(true);
    try {
      const sourceItemKey = `readonly-${sha256(`${file.name}|${file.size}|${file.lastModified}`).slice(7, 23)}`;
      const consent = await runtimeRef.current.grantReadonlyConsent({ sourceItemKey, eventTtlDays, derivedTtlDays });
      const preview = await runtimeRef.current.previewReadonly({ utf8: await file.text(), sourceItemKey });
      if (epoch !== uiEpochRef.current) return;
      setReadonlyConsent(consent);
      setPreviewToken(preview.token);
      setReadonlyConsentOpen(false);
      setOrbState('SUGGESTION');
      setDomainStatus(`真实只读来源预览已准备：${preview.acceptedCount} 条事件、${preview.episodeCount} 个 Episode、${preview.insightCount} 条 Insight；尚未提交。`);
      setAnnouncement('真实只读来源已授权并完成导入前预览。');
    } catch (error) {
      if (epoch !== uiEpochRef.current) return;
      setDomainStatus(`真实只读来源未启用（${safeErrorCode(error)}）；canonical store 未显示成功。`);
    } finally {
      if (epoch === uiEpochRef.current) setReadonlyBusy(false);
    }
  };

  const revokeReadonly = async () => {
    const epoch = uiEpochRef.current;
    try {
      await runtimeRef.current?.revokeConsent();
      if (epoch !== uiEpochRef.current) return;
      disposeProjection();
      setReadonlyConsent(null);
      setReadonlyFile(null);
      setImported(null);
      setPreviewToken(null);
      setDomainStatus('真实来源授权已撤回，相关事件与派生 lineage 已按删除协议清除。');
      setAnnouncement('真实来源授权已撤回。');
    } catch (error) {
      if (epoch === uiEpochRef.current) setDomainStatus(`撤回失败（${safeErrorCode(error)}）；未显示成功。`);
    }
  };

  const expireReadonly = async () => {
    try {
      const count = await runtimeRef.current?.expireReadonlyRetention();
      invalidateProjection();
      setDomainStatus(`保留期清理完成：发现 ${count ?? 0} 条到期真实只读事件。`);
    } catch (error) {
      setDomainStatus(`保留期清理失败（${safeErrorCode(error)}）；未显示成功。`);
    }
  };

  const runBundledFixture = async () => {
    const epoch = uiEpochRef.current;
    if (runtimeFaulted) {
      setDomainStatus('本地运行时需要先完成安全恢复；普通写入保持暂停。');
      return;
    }
    if (privateMode) {
      setDomainStatus('隐私模式中未导入；请先恢复观察。');
      return;
    }
    setOrbState('LEARNING');
    setPreviewBusy(true);
    try {
      const preview = await runtimeRef.current!.preview();
      if (epoch !== uiEpochRef.current) return;
      setPreviewToken(preview.token);
      setOrbState('SUGGESTION');
      setDomainStatus(`预览已准备：${preview.acceptedCount} 条 synthetic 事件、${preview.episodeCount} 个 Episode、${preview.insightCount} 条 Insight；尚未提交。`);
      setAnnouncement('本地样例预览已准备，请明确确认后提交。');
    } catch {
      if (epoch !== uiEpochRef.current) return;
      await syncRuntimeFault(epoch);
      if (epoch !== uiEpochRef.current) return;
      setOrbState('ERROR');
      setDomainStatus('预览失败；canonical store 未发生写入。');
    } finally {
      if (epoch === uiEpochRef.current) setPreviewBusy(false);
    }
  };

  const commitBundledFixture = async () => {
    const epoch = uiEpochRef.current;
    if (runtimeFaulted) {
      setDomainStatus('本地运行时需要先完成安全恢复；普通写入保持暂停。');
      return;
    }
    setOrbState('EXECUTING');
    try {
      if (!previewToken) throw new Error('ERR_PREVIEW_REQUIRED');
      const committed = await runtimeRef.current!.commit(previewToken);
      if (epoch !== uiEpochRef.current) return;
      setImported(committed);
      setReplaySnapshot(null);
      setPreviewToken(null);
      invalidateProjection();
      setDomainRevision((value) => value + 1);
      setOrbState(committed.output.claims.length ? 'SUGGESTION' : 'LEARNING');
      setDomainStatus(committed.source === 'readonly-test-results'
        ? `真实只读来源已持久提交 ${committed.acceptedCount} 条事件，生成 ${committed.output.episodes.length} 个 Episode 与 ${committed.output.claims.length} 条 Insight。`
        : `本地样例已持久提交 ${committed.acceptedCount} 条测试事件，生成 ${committed.output.episodes.length} 个 Episode 与 ${committed.output.claims.length} 条 Insight。`);
      setAnnouncement(`${committed.source === 'readonly-test-results' ? '真实只读来源' : '本地样例'}已由 IndexedDB PreviewGuard 原子提交。`);
    } catch {
      if (epoch !== uiEpochRef.current) return;
      await syncRuntimeFault(epoch);
      if (epoch !== uiEpochRef.current) return;
      setPreviewToken(null);
      setOrbState('ERROR');
      setDomainStatus('提交失败；canonical store 未显示成功。');
    }
  };

  const performCorrection = async (action: Exclude<CorrectionAction, 'restore'>) => {
    const epoch = uiEpochRef.current;
    if (runtimeFaulted) {
      setDomainStatus('本地运行时需要先完成安全恢复；普通写入保持暂停。');
      return;
    }
    if (action === 'delete') setDeletionBusy(true);
    try {
      if (!runtimeRef.current!.currentClaim()) {
        if (action === 'delete') setDeletionBusy(false);
        setDomainStatus('没有可纠正的 live Insight。');
        return;
      }
      const result = await runtimeRef.current!.submit(action);
      if (epoch !== uiEpochRef.current) return;
      if (action === 'delete' && result.ok) {
        setReplaySnapshot(null);
        setPreviewToken(null);
        const snapshot = await runtimeRef.current!.snapshot();
        if (epoch !== uiEpochRef.current) return;
        setImported(snapshot.imported);
      }
      if (result.ok) {
        setReplaySnapshot(null);
        invalidateProjection();
      }
      setDomainRevision((value) => value + 1);
      setDomainStatus(result.ok
        ? (action === 'delete' ? 'Insight lineage 已从本地 canonical store 删除；无关事件与报告已保留。' : `${action} 已持久写入不可变 revision；可运行 Replay 验证。`)
        : `纠正未保存：${result.record.errorCode ?? 'unknown'}`);
      setAnnouncement(result.ok ? '纠正已持久保存。' : '纠正尚未保存。');
      if (action === 'delete') setDeletionBusy(false);
    } catch (error) {
      if (epoch !== uiEpochRef.current) return;
      const code = safeErrorCode(error);
      const faulted = await syncRuntimeFault(epoch);
      if (epoch !== uiEpochRef.current) return;
      if (!faulted && code === 'ERR_PURGE_CLIENTS_PENDING') setRecovery('blocked');
      setOrbState('ERROR');
      setDomainStatus(`纠正事务失败（${code}）；未显示成功。`);
      if (action === 'delete') setDeletionBusy(false);
    }
  };

  const applyCorrection = async (action: Exclude<CorrectionAction, 'restore'>) => {
    if (runtimeFaulted) {
      setDomainStatus('本地运行时需要先完成安全恢复；普通写入保持暂停。');
      return;
    }
    if (action === 'delete') {
      setDeleteConfirmOpen(true);
      return;
    }
    await performCorrection(action);
  };

  const runDomainReplay = async () => {
    const epoch = uiEpochRef.current;
    if (runtimeFaulted) {
      setDomainStatus('本地运行时需要先完成安全恢复；普通写入保持暂停。');
      return;
    }
    if (!imported) {
      setDomainStatus('请先导入 bundled fixture。');
      return;
    }
    try {
      const replay = await runtimeRef.current!.evaluateReplay();
      if (epoch !== uiEpochRef.current) return;
      setReplaySnapshot(replay);
      setDomainStatus(`Replay 完成：${replay.output.claims.length} 条 live Insight。`);
      setOrbState('SUGGESTION');
    } catch (error) {
      if (epoch !== uiEpochRef.current) return;
      await syncRuntimeFault(epoch);
      if (epoch !== uiEpochRef.current) return;
      setOrbState('ERROR');
      setDomainStatus(`Replay 失败（${safeErrorCode(error)}）；未显示成功。`);
    }
  };

  const renderEmpty = (section: string) => (
    <div className="empty-state">
      <span className="empty-state__mark" aria-hidden="true">○</span>
      <p><strong>{section} 暂无内容</strong></p>
      <p>测试证据不足，因此没有形成推断；系统不会用示例结论填满界面。</p>
    </div>
  );

  const liveClaim = imported && runtimeReady && runtimeRef.current ? runtimeRef.current.currentClaim() : undefined;
  const hasLiveClaim = Boolean(liveClaim);
  const viewModel = buildInsightPresentation(imported, liveClaim, replaySnapshot);
  const showEmpty = contentMode === 'empty' || !imported;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>

      <header className="brand-bar">
        <div>
          <p className="brand-bar__kicker">PERSONAL INSIGHT SYSTEM</p>
          <p className="brand-bar__name">ProAGI <span>Assistant</span></p>
        </div>
        <p className="brand-bar__boundary">Fixture 研究原型</p>
      </header>

      <nav aria-label="主要导航" className="sr-only"><a href="#main-content">洞察主界面</a></nav>
      <main id="main-content" tabIndex={-1}>
        <section className="privacy-strip" aria-labelledby="privacy-title">
          <div className="privacy-strip__status" tabIndex={-1} data-global-status>
            <span className={`status-dot status-dot--${privateMode ? 'private' : 'safe'}`} aria-hidden="true" />
            <div>
              <p className="eyebrow">全局状态与隐私</p>
              <h1 id="privacy-title">{privateMode ? '隐私模式已开启' : '仅处理本地测试事件'}</h1>
            <p id="coarse-source">来源：{readonlyConsent?.grant && !readonlyConsent.revoked ? '用户授权的真实只读测试结果' : '测试事件'} · Shadow-only</p>
            </div>
          </div>
          <div className="privacy-strip__actions">
            <button type="button" className="button button--primary" onClick={runBundledFixture} disabled={runtimeFaulted || privateMode || previewBusy || Boolean(imported) || Boolean(previewToken)}>
              {imported ? '本地样例已导入' : '预览本地样例'}
            </button>
            {previewToken ? (
              <button type="button" className="button button--primary" onClick={commitBundledFixture} disabled={runtimeFaulted}>确认导入</button>
            ) : null}
            <button type="button" className="button button--quiet" onClick={togglePrivacy} disabled={runtimeFaulted}>
              {privateMode ? '恢复观察' : '暂停观察'}
            </button>
            <button type="button" className="button button--quiet" onClick={(event) => startRecovery(event.currentTarget, 'recovery')}>
              查看安全模式
            </button>
            <label className="button button--quiet">
              选择真实只读 JSON
              <input ref={readonlyFileRef} data-testid="readonly-file" type="file" accept="application/json,.json" onChange={chooseReadonlyFile} hidden />
            </label>
            {readonlyConsent?.grant && !readonlyConsent.revoked ? <>
              <button type="button" className="button button--quiet" onClick={() => void revokeReadonly()} disabled={readonlyBusy}>撤回真实来源授权</button>
              <button type="button" className="button button--quiet" onClick={() => void expireReadonly()} disabled={readonlyBusy}>清理到期数据</button>
            </> : null}
          </div>
        </section>

        {readonlyConsent?.grant && !readonlyConsent.revoked ? (
          <details className="consent-details">
            <summary>查看当前真实只读授权边界</summary>
            <dl className="consent-details__grid">
              <div><dt>来源</dt><dd>readonly-test-results（用户主动选择）</dd></div>
              <div><dt>数据分类</dt><dd>local-sensitive</dd></div>
              <div><dt>用途</dt><dd>{readonlyConsent.grant.purpose}</dd></div>
              <div><dt>保留策略</dt><dd>事件 {readonlyConsent.policy.eventTtlDays} 天 · 派生 {readonlyConsent.policy.derivedTtlDays} 天</dd></div>
            </dl>
            <p className="consent-details__fields">字段白名单<code>{readonlyConsent.grant.allowedFields.join(' · ')}</code></p>
            <p className="consent-details__notice">当前来源只读、Shadow-only；不联网、不注入输入、不自动写入外部文件。撤回授权会删除该来源的事件与派生 lineage。</p>
          </details>
        ) : null}

        {readonlyConsentOpen && readonlyFile ? (
          <section className="stale-banner" role="dialog" aria-modal="true" aria-labelledby="readonly-consent-title">
            <div>
              <p className="eyebrow">M2 · 明确授权</p>
              <h2 id="readonly-consent-title">允许读取这份真实测试结果？</h2>
              <p>仅保留白名单字段：事件时间、类型、测试结果、耗时和用户提供的来源别名；不会联网、执行动作或保存原始错误正文。</p>
              <p>默认保留：事件 7 天，派生 Insight 30 天。撤回授权会递增 privacy epoch，并删除该来源的事件与派生 lineage。</p>
              <div className="button-row" aria-label="保留期设置">
                <label>事件保留 <select value={eventTtlDays} onChange={(event) => setEventTtlDays(Number(event.target.value))}><option value={1}>1 天</option><option value={3}>3 天</option><option value={7}>7 天</option></select></label>
                <label>派生保留 <select value={derivedTtlDays} onChange={(event) => setDerivedTtlDays(Number(event.target.value))}><option value={1}>1 天</option><option value={7}>7 天</option><option value={30}>30 天</option></select></label>
              </div>
              <label className="checkbox-row"><input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} /> 我已知悉 local-first 不能防同机用户、恶意扩展、profile 同步/备份或磁盘取证。</label>
            </div>
            <div className="segmented-control">
              <button type="button" className="button button--quiet" onClick={() => { setReadonlyConsentOpen(false); setReadonlyFile(null); }}>取消</button>
              <button type="button" className="button button--primary" onClick={() => void authorizeReadonlyFile()} disabled={!riskAccepted || readonlyBusy}>{readonlyBusy ? '分析中…' : '授权并预览'}</button>
            </div>
          </section>
        ) : null}

        {recovery ? (
          <RecoverySurface
            kind={recovery}
            returnFocusRef={recoveryInvokerRef}
            onRetry={() => {
               void (async () => {
                 try {
                   const runtime = runtimeRef.current;
                   if (!runtime) throw new Error('ERR_RUNTIME_UNAVAILABLE');
                   await runtime.recover();
                   const snapshot = await runtime.snapshot();
                   setImported(snapshot.imported);
                   setCanonicalPrivate(snapshot.observationMode === 'PRIVATE');
       setRuntimeFaulted(snapshot.runtimeFaulted);

                   setRecovery(null);
                   setDomainStatus('本地删除恢复已完成，并已刷新 canonical snapshot。');
                 } catch (error) {
                   setRuntimeFaulted(true);
                   setDomainStatus(`恢复未完成（${safeErrorCode(error)}）；普通写入保持暂停。`);
                 }
               })();
             }}
            onDismissDemo={endRecovery}
             dismissible={!runtimeFaulted}
          />
        ) : null}

        <section className="today-panel" aria-labelledby="today-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{viewModel.today.dateLabel}</p>
              <h2 id="today-title">Today</h2>
            </div>
            <button type="button" className="text-button" onClick={(event) => { detailInvokerRef.current = event.currentTarget; setDetailOpen(true); }}>查看证据详情</button>
          </div>
          <p className="today-panel__headline">{viewModel.today.headline}</p>
          <p className="today-panel__summary">{viewModel.today.summary}</p>
          <dl className="metric-grid">
            {viewModel.today.metrics.map((metric) => (
              <div key={metric.label}>
                <dt>{metric.label}</dt>
                <dd>{metric.value}</dd>
              </div>
            ))}
          </dl>
          <div className="domain-loop" data-domain-revision={domainRevision}>
            <p className="eyebrow">可运行 Insight Loop</p>
            <p className="domain-loop__status" role="status">{domainStatus}</p>
            <div className="button-row" aria-label="领域操作">
              <button type="button" className="button button--quiet" disabled={runtimeFaulted || privateMode || !hasLiveClaim || contentMode === 'stale'} onClick={() => applyCorrection('accept')}>接受 Insight</button>
              <button type="button" className="button button--quiet" disabled={runtimeFaulted || privateMode || !hasLiveClaim || contentMode === 'stale'} onClick={() => applyCorrection('edit')}>编辑范围</button>
              <button type="button" className="button button--quiet" disabled={runtimeFaulted || privateMode || !hasLiveClaim || contentMode === 'stale'} onClick={() => applyCorrection('reject')}>驳回 Insight</button>
              <button type="button" className="button button--quiet" disabled={runtimeFaulted || !hasLiveClaim || contentMode === 'stale' || deletionBusy} onClick={(event) => { deleteInvokerRef.current = event.currentTarget; void applyCorrection('delete'); }}>删除 Insight</button>
              <button type="button" className="button button--primary" disabled={runtimeFaulted || !imported} onClick={runDomainReplay}>运行 Replay</button>
            </div>
          </div>
        </section>

        <div className="insight-grid">
          <section className="content-card observed-panel" aria-labelledby="observed-title">
            <div className="section-heading">
              <div><p className="section-number">01</p><h2 id="observed-title">我观察了什么</h2></div>
              <span className="count-badge">{viewModel.observed.length} 段</span>
            </div>
            {showEmpty ? renderEmpty('Observed') : (
              <ol className="episode-list">
                {viewModel.observed.map((episode) => (
                  <li key={episode.time}>
                    <time>{episode.time}</time>
                    <div><h3>{episode.title}</h3><p>{episode.detail}</p><span>{episode.kind}</span></div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="content-card learned-panel" aria-labelledby="learned-title">
            <div className="section-heading">
              <div><p className="section-number">02</p><h2 id="learned-title">我学到了什么</h2></div>
              <span className="confidence-chip">{viewModel.learned.confidence}</span>
            </div>
            {showEmpty ? renderEmpty('Learned') : (
              <article className="claim-card">
                <p className="claim-card__statement">{viewModel.learned.statement}</p>
                <dl>
                  <div><dt>适用范围</dt><dd>{viewModel.learned.scope}</dd></div>
                  <div><dt>信心</dt><dd>{viewModel.learned.confidence} · {viewModel.learned.confidenceValue}</dd></div>
                  <div><dt>支持证据</dt><dd>{viewModel.learned.evidence}</dd></div>
                  <div><dt>反向证据</dt><dd>{viewModel.learned.counterEvidence}</dd></div>
                </dl>
              </article>
            )}
          </section>

          <section className="content-card impact-panel" aria-labelledby="impact-title">
            <div className="section-heading">
              <div><p className="section-number">03</p><h2 id="impact-title">你的纠正改变了什么</h2></div>
              <span className="change-chip">范围内更新</span>
            </div>
            {showEmpty ? renderEmpty('Correction Impact') : (
              <div className="diff-card">
                <div className="diff-card__row diff-card__row--before"><span aria-hidden="true">−</span><div><strong>修改前</strong><p>{viewModel.correction.before}</p></div></div>
                <div className="diff-card__row diff-card__row--after"><span aria-hidden="true">+</span><div><strong>修改后</strong><p>{viewModel.correction.after}</p></div></div>
                <p className="diff-card__scope">{viewModel.correction.impact}</p>
              </div>
            )}
          </section>

          <section className="content-card inbox-panel" aria-labelledby="inbox-title">
            <div className="section-heading">
              <div><p className="section-number">04</p><h2 id="inbox-title">Insight Inbox</h2></div>
              <span className="count-badge">{viewModel.inbox.length} 待审阅</span>
            </div>
            {showEmpty ? renderEmpty('Inbox') : (
              <ul className="inbox-list">
                {viewModel.inbox.map((item) => (
                  <li key={item.title}>
                    <p className="eyebrow">{item.eyebrow}</p>
                    <h3>{item.title}</h3>
                    <p>{item.detail}</p>
                    <button type="button" className="text-button" onClick={() => setAnnouncement('审阅面板已准备。')}>{item.action}</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className="replay-panel" aria-labelledby="replay-title">
          <div className="section-heading">
            <div><p className="section-number">05</p><h2 id="replay-title">Replay</h2></div>
            <span className="replay-status"><span aria-hidden="true">{replaySnapshot ? '✓' : '○'}</span> {replaySnapshot ? '可确定性重放' : '尚未运行'}</span>
          </div>
          {showEmpty ? renderEmpty('Replay') : (
            <div className="replay-grid">
              <dl>
                <div><dt>输入版本</dt><dd>{viewModel.replay.fixture}</dd></div>
                <div><dt>目标范围</dt><dd>{viewModel.replay.scope}</dd></div>
                <div><dt>输出哈希</dt><dd><code>{viewModel.replay.hash}</code></dd></div>
              </dl>
              <div className="replay-result"><p><strong>修订前</strong> · {viewModel.replay.before}</p><p><strong>修订后</strong> · {viewModel.replay.after}</p></div>
            </div>
          )}
        </section>

        <section className="content-card projection-panel" aria-labelledby="projection-title">
          <div className="section-heading">
            <div><p className="section-number">06</p><h2 id="projection-title">本地知识投影</h2></div>
            <span className="replay-status"><span aria-hidden="true">{projection ? '✓' : '○'}</span> {projection ? '已同步' : projectionEnabled ? '等待重建' : '未启用'}</span>
          </div>
          <p className="projection-panel__copy">按需把 canonical store 渲染为本地 Markdown 预览。投影是可删除的派生缓存，不改变 Insight Loop 的唯一真相。</p>
          {projection ? (
            <>
              <dl className="projection-meta">
                <div><dt>源 cursor</dt><dd>{projection.sourceCursor}</dd></div>
                <div><dt>文档数</dt><dd>{projection.documentCount}</dd></div>
                <div><dt>重建方式</dt><dd>{projection.mode === 'full' ? '全量' : '增量'}</dd></div>
                <div><dt>privacy epoch</dt><dd>{projection.privacyEpoch}</dd></div>
                <div><dt>内容哈希</dt><dd><code>{projection.contentHash}</code></dd></div>
              </dl>
              <pre className="projection-preview" aria-label="Markdown 投影预览">{projection.markdown}</pre>
            </>
          ) : (
            <p className="projection-panel__empty">{projectionEnabled ? 'canonical store 已变化或投影尚未生成；请重建后再预览或导出。' : '投影默认关闭；启用后才会读取 canonical store 并生成本地预览。'}</p>
          )}
          <div className="button-row" aria-label="Markdown 投影操作">
            {!projectionEnabled ? (
              <button type="button" className="button button--primary" onClick={() => void rebuildProjection(true)} disabled={runtimeFaulted || privateMode || !runtimeReady || projectionBusy}>启用并重建投影</button>
            ) : (
              <>
                <button type="button" className="button button--primary" onClick={() => void rebuildProjection(false)} disabled={runtimeFaulted || privateMode || projectionBusy}>增量重建</button>
                <button type="button" className="button button--quiet" onClick={() => void rebuildProjection(true)} disabled={runtimeFaulted || privateMode || projectionBusy}>全量重建</button>
                <button type="button" className="button button--quiet" onClick={disableProjection} disabled={projectionBusy}>禁用投影</button>
              </>
            )}
            {projection ? <button type="button" className="button button--quiet" onClick={openProjectionExport} disabled={runtimeFaulted || privateMode || projectionBusy}>导出 Markdown</button> : null}
          </div>
          {projectionExportOpen && projection ? (
            <fieldset className="projection-export">
              <legend>确认导出 Markdown</legend>
              <p>将下载 <code>proagi-knowledge.md</code> 到本地文件。应用不会自动写入 Obsidian Vault；导出的副本无法被应用远程撤回。</p>
              <label className="checkbox-row"><input type="checkbox" checked={projectionExportAcknowledged} onChange={(event) => setProjectionExportAcknowledged(event.target.checked)} /> 我确认这是一次不可逆的本地文件导出。</label>
              <div className="button-row">
                <button type="button" className="button button--quiet" onClick={() => { setProjectionExportOpen(false); setProjectionExportAcknowledged(false); }} disabled={projectionBusy}>取消</button>
                <button type="button" className="button button--primary" onClick={() => void exportProjection()} disabled={!projectionExportAcknowledged || projectionBusy || runtimeFaulted || privateMode}>确认导出</button>
              </div>
            </fieldset>
          ) : null}
          {projectionError ? <p className="projection-panel__error" role="status">投影已停用（{projectionError}）；canonical store 与 Insight Loop 未受影响。</p> : null}
        </section>

        {deleteConfirmOpen ? (
          <section className="stale-banner" role="alertdialog" aria-modal="true" aria-labelledby="delete-confirm-title" aria-describedby="delete-confirm-copy">
            <div>
              <p className="eyebrow">不可逆操作</p>
              <h2 id="delete-confirm-title">删除这条 Insight 及其完整 lineage？</h2>
              <p id="delete-confirm-copy">这将移除相关修订、知识版本、纠正记录与报告引用；无关事件会保留。</p>
            </div>
            <div className="segmented-control">
              <button type="button" autoFocus className="button button--quiet" onClick={() => setDeleteConfirmOpen(false)}>取消</button>
              <button type="button" className="button button--primary" onClick={() => { setDeleteConfirmOpen(false); void performCorrection('delete'); }}>确认删除</button>
            </div>
          </section>
        ) : null}

        {contentMode === 'stale' ? (
          <section className="stale-banner" role="status" aria-labelledby="stale-title">
            <div>
              <p className="eyebrow">投影状态</p>
              <h2 id="stale-title">当前摘要需要重建</h2>
              <p>canonical 测试数据未被覆盖；重建完成前纠正操作保持禁用。</p>
            </div>
            <button type="button" className="button button--quiet" onClick={() => setContentMode('content')}>重建演示投影</button>
          </section>
        ) : null}

        <section className="demo-controls" aria-labelledby="demo-controls-title">
          <div>
            <p className="eyebrow">本地 View Model</p>
            <h2 id="demo-controls-title">界面状态预览</h2>
          </div>
          <div className="segmented-control" aria-label="内容状态">
            {(['content', 'empty', 'stale'] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={contentMode === mode} onClick={() => setContentMode(mode)}>
                {mode === 'content' ? '有内容' : mode === 'empty' ? '空状态' : '投影过期'}
              </button>
            ))}
            <button type="button" aria-pressed={recovery === 'blocked'} onClick={(event) => startRecovery(event.currentTarget, 'blocked')}>清除受阻</button>
          </div>
          <div className="state-picker" aria-label="球体状态">
            {ORB_STATES.map((state) => (
              <button key={state} type="button" aria-pressed={orbState === state} onClick={() => chooseState(state)}>
                <span className={`mini-state mini-state--${state.toLowerCase()}`} aria-hidden="true" />
                {stateShortLabels[state]}
              </button>
            ))}
          </div>
        </section>
      </main>

      {detailOpen ? (
        <div className="drawer-backdrop" role="presentation">
          <aside ref={detailDrawerRef} className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
            <p className="eyebrow">渐进披露</p>
            <h2 id="drawer-title">证据与版本详情</h2>
            <p>此抽屉只展示本地演示 view model 中已批准的正文，不改变 canonical 数据。</p>
            <dl>
              <div><dt>来源</dt><dd>测试事件</dd></div>
              <div><dt>版本</dt><dd>revision 2</dd></div>
              <div><dt>范围</dt><dd>{viewModel.learned.scope}</dd></div>
            </dl>
            <div className="button-row">
              <button type="button" className="button button--quiet" onClick={() => void prepareTraceExport()} disabled={traceBusy}>准备 TRACE 诊断包</button>
            </div>
            {traceExportOpen && tracePreview ? (
              <fieldset className="projection-export">
                <legend>确认导出 TRACE</legend>
                <p>包含 {tracePreview.eventCount} 条固定 schema 的本地诊断事件，不包含原始输入、正文、路径或动态字段；导出文件无法被应用远程撤回。</p>
                <p><code>{tracePreview.contentHash}</code></p>
                <label className="checkbox-row"><input type="checkbox" checked={traceExportAcknowledged} onChange={(event) => setTraceExportAcknowledged(event.target.checked)} /> 我确认这是一次不可逆的本地诊断导出。</label>
                <div className="button-row">
                  <button type="button" className="button button--quiet" onClick={() => { setTraceExportOpen(false); setTraceExportAcknowledged(false); }} disabled={traceBusy}>取消</button>
                  <button type="button" className="button button--primary" onClick={() => void exportTrace()} disabled={!traceExportAcknowledged || traceBusy}>确认导出</button>
                </div>
              </fieldset>
            ) : null}
            <fieldset className="projection-export trace-manual-check">
              <legend>记录人工核验</legend>
              <p>仅记录固定用例、步骤 token、审核人 token、结果和 SHA-256；不记录正文、路径、截图内容或自由文本。</p>
              <label>用例<select value={manualTraceCaseId} onChange={(event) => setManualTraceCaseId(event.target.value as ManualTraceCaseId)}>{MANUAL_TRACE_CASES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              <label>步骤 token<input value={manualTraceStepId} onChange={(event) => setManualTraceStepId(event.target.value)} pattern="[A-Za-z0-9._:-]{1,128}" maxLength={128} /></label>
              <label>审核人 token<input value={manualTraceReviewerId} onChange={(event) => setManualTraceReviewerId(event.target.value)} pattern="[A-Za-z0-9._:-]{1,128}" maxLength={128} /></label>
              <label>结果<select value={manualTraceResult} onChange={(event) => setManualTraceResult(event.target.value as TraceManualCheck['result'])}><option value="PASS">PASS</option><option value="FAIL">FAIL</option><option value="NOT_RUN">NOT_RUN</option></select></label>
              <label>artifact SHA-256（可选）<input value={manualTraceArtifactHash} onChange={(event) => setManualTraceArtifactHash(event.target.value)} placeholder="sha256:..." pattern="sha256:[0-9a-f]{64}" maxLength={71} /></label>
              <div className="button-row"><button type="button" className="button button--quiet" onClick={() => void recordManualTraceCheck()} disabled={!manualTraceStepId.trim() || !manualTraceReviewerId.trim() || traceBusy}>写入 TRACE</button></div>
            </fieldset>
            <button ref={detailCloseRef} type="button" className="button button--primary" onClick={() => setDetailOpen(false)}>关闭详情</button>
          </aside>
        </div>
      ) : null}

      <Orb state={orbState} profile={orbProfile} onProfileChange={setOrbProfile} />
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    </div>
  );
}

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : '';
  return /^ERR_[A-Z0-9_]+$/.test(code) ? code : 'ERR_UNKNOWN';
}
