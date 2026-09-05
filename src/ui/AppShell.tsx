import { useEffect, useRef, useState } from 'react';
import { BrowserInsightRuntime } from '../application/browserInsightRuntime';
import type { ImportCommit } from '../application/insightService';
import type { CorrectionAction } from '../domain/types';
import { ORB_STATES, ORB_STATE_LABELS, type ContentMode, type OrbState } from './demoViewModel';
import { buildInsightPresentation } from './presentation';
import { Orb, type OrbProfile } from './Orb';
import { RecoverySurface, type RecoveryKind } from './RecoverySurface';

const stateShortLabels: Readonly<Record<OrbState, string>> = {
  LEARNING: '学习',
  EXECUTING: '本地执行',
  IDLE: '空闲',
  SUGGESTION: '建议',
  PRIVATE: '隐私',
  ERROR: '错误',
};

export function AppShell() {
  const [orbState, setOrbState] = useState<OrbState>('IDLE');
  const [previousState, setPreviousState] = useState<OrbState>('IDLE');
  const [canonicalPrivate, setCanonicalPrivate] = useState(false);
  const [orbProfile, setOrbProfile] = useState<OrbProfile>('quiet');
  const [contentMode, setContentMode] = useState<ContentMode>('content');
  const [recovery, setRecovery] = useState<RecoveryKind | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const recoveryInvokerRef = useRef<HTMLElement>(null);
  const detailInvokerRef = useRef<HTMLElement>(null);
  const deleteInvokerRef = useRef<HTMLButtonElement>(null);
  const detailDrawerRef = useRef<HTMLElement>(null);
  const detailCloseRef = useRef<HTMLButtonElement>(null);
  const runtimeRef = useRef<BrowserInsightRuntime | null>(null);
  const [imported, setImported] = useState<ImportCommit | null>(null);
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [domainStatus, setDomainStatus] = useState('正在读取本地 canonical store…');
  const [domainRevision, setDomainRevision] = useState(0);

  if (!runtimeRef.current) runtimeRef.current = new BrowserInsightRuntime();
  const privateMode = canonicalPrivate;

  useEffect(() => {
    const handleExternalPurge = () => {
      setImported(null);
      setPreviewToken(null);
      setDomainStatus('其他标签页已完成隐私清除；当前视图已释放旧数据。');
      setOrbState('IDLE');
    };
    window.addEventListener('proagi:external-purge', handleExternalPurge);
    return () => window.removeEventListener('proagi:external-purge', handleExternalPurge);
  }, []);

  useEffect(() => {
    let active = true;
    void runtimeRef.current!.start().then((snapshot) => {
      if (!active) return;
      setImported(snapshot.imported);
       setCanonicalPrivate(snapshot.observationMode === 'PRIVATE');
      if (snapshot.observationMode === 'PRIVATE') {
        setPreviousState('IDLE');
        setOrbState('PRIVATE');
        setDomainStatus('已从本地 canonical store 恢复隐私模式。');
      } else {
        setDomainStatus(snapshot.imported ? `已从本地 canonical store 恢复，cursor ${snapshot.cursor}。` : '本地 canonical store 已就绪；尚未提交 bundled fixture。');
      }
    }).catch(() => {
      if (!active) return;
      setOrbState('ERROR');
      setDomainStatus('本地 canonical store 无法打开；写操作已禁用。');
    });
    return () => {
      active = false;
      runtimeRef.current?.close();
    };
  }, []);

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

  const togglePrivacy = async () => {
    const nextMode = privateMode ? 'ACTIVE' : 'PRIVATE';
    try {
      const receipt = nextMode === 'PRIVATE'
        ? await runtimeRef.current!.pausePrivacy()
        : await runtimeRef.current!.resumePrivacy();
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

  const runBundledFixture = async () => {
    if (privateMode) {
      setDomainStatus('隐私模式中未导入；请先恢复观察。');
      return;
    }
    setOrbState('LEARNING');
    setPreviewBusy(true);
    try {
      const preview = await runtimeRef.current!.preview();
      setPreviewToken(preview.token);
      setOrbState('SUGGESTION');
      setDomainStatus(`预览已准备：${preview.acceptedCount} 条 synthetic 事件、${preview.episodeCount} 个 Episode、${preview.insightCount} 条 Insight；尚未提交。`);
      setAnnouncement('本地样例预览已准备，请明确确认后提交。');
    } catch {
      setOrbState('ERROR');
      setDomainStatus('预览失败；canonical store 未发生写入。');
    } finally {
      setPreviewBusy(false);
    }
  };

  const commitBundledFixture = async () => {
    setOrbState('EXECUTING');
    try {
      if (!previewToken) throw new Error('ERR_PREVIEW_REQUIRED');
      const committed = await runtimeRef.current!.commit(previewToken);
      setImported(committed);
      setPreviewToken(null);
      setDomainRevision((value) => value + 1);
      setOrbState(committed.output.claims.length ? 'SUGGESTION' : 'LEARNING');
      setDomainStatus(`已持久提交 ${committed.acceptedCount} 条测试事件，生成 ${committed.output.episodes.length} 个 Episode 与 ${committed.output.claims.length} 条 Insight。`);
      setAnnouncement('本地样例已由 IndexedDB PreviewGuard 原子提交。');
    } catch {
      setPreviewToken(null);
      setOrbState('ERROR');
      setDomainStatus('提交失败；canonical store 未显示成功。');
    }
  };

  const performCorrection = async (action: Exclude<CorrectionAction, 'restore'>) => {
    if (!runtimeRef.current!.currentClaim()) {
      setDomainStatus('没有可纠正的 live Insight。');
      return;
    }
    try {
      const result = await runtimeRef.current!.submit(action);
      if (action === 'delete' && result.ok) {
        setPreviewToken(null);
        setImported((await runtimeRef.current!.snapshot()).imported);
      }
      setDomainRevision((value) => value + 1);
      setDomainStatus(result.ok
        ? (action === 'delete' ? 'Insight lineage 已从本地 canonical store 删除；无关事件与报告已保留。' : `${action} 已持久写入不可变 revision；可运行 Replay 验证。`)
        : `纠正未保存：${result.record.errorCode ?? 'unknown'}`);
      setAnnouncement(result.ok ? '纠正已持久保存。' : '纠正尚未保存。');
    } catch (error) {
      const code = safeErrorCode(error);
      if (code === 'ERR_PURGE_CLIENTS_PENDING') setRecovery('blocked');
      setOrbState('ERROR');
      setDomainStatus(`纠正事务失败（${code}）；未显示成功。`);
    }
  };

  const applyCorrection = async (action: Exclude<CorrectionAction, 'restore'>) => {
    if (action === 'delete') {
      setDeleteConfirmOpen(true);
      return;
    }
    await performCorrection(action);
  };

  const runDomainReplay = () => {
    if (!imported) {
      setDomainStatus('请先导入 bundled fixture。');
      return;
    }
    const replay = runtimeRef.current!.evaluateReplay();
    setDomainStatus(`Replay 完成：${replay.output.claims.length} 条 live Insight。`);
    setOrbState('SUGGESTION');
  };

  const renderEmpty = (section: string) => (
    <div className="empty-state">
      <span className="empty-state__mark" aria-hidden="true">○</span>
      <p><strong>{section} 暂无内容</strong></p>
      <p>测试证据不足，因此没有形成推断；系统不会用示例结论填满界面。</p>
    </div>
  );

  const liveClaim = imported ? runtimeRef.current.currentClaim() : undefined;
  const hasLiveClaim = Boolean(liveClaim);
  const viewModel = buildInsightPresentation(imported, liveClaim);
  const showEmpty = contentMode === 'empty' || !imported;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>

      <header className="brand-bar">
        <div>
          <p className="brand-bar__kicker">PERSONAL INSIGHT SYSTEM</p>
          <p className="brand-bar__name">ProAGI <span>Assistant</span></p>
        </div>
        <p className="brand-bar__boundary">Fixture 研究原型 · Shadow-only</p>
      </header>

      <nav aria-label="主要导航" className="sr-only"><a href="#main-content">洞察主界面</a></nav>
      <main id="main-content" tabIndex={-1}>
        <section className="privacy-strip" aria-labelledby="privacy-title">
          <div className="privacy-strip__status" tabIndex={-1} data-global-status>
            <span className={`status-dot status-dot--${privateMode ? 'private' : 'safe'}`} aria-hidden="true" />
            <div>
              <p className="eyebrow">全局状态与隐私</p>
              <h1 id="privacy-title">{privateMode ? '隐私模式已开启' : '仅处理本地测试事件'}</h1>
              <p id="coarse-source">来源：测试事件 · 未连接真实桌面</p>
            </div>
          </div>
          <div className="privacy-strip__actions">
            <button type="button" className="button button--primary" onClick={runBundledFixture} disabled={privateMode || previewBusy || Boolean(imported) || Boolean(previewToken)}>
              {imported ? '本地样例已导入' : '预览本地样例'}
            </button>
            {previewToken ? (
              <button type="button" className="button button--primary" onClick={commitBundledFixture}>确认导入</button>
            ) : null}
            <button type="button" className="button button--quiet" onClick={togglePrivacy}>
              {privateMode ? '恢复观察' : '暂停观察'}
            </button>
            <button type="button" className="button button--quiet" onClick={(event) => startRecovery(event.currentTarget, 'recovery')}>
              查看安全模式
            </button>
          </div>
        </section>

        {recovery ? (
          <RecoverySurface
            kind={recovery}
            returnFocusRef={recoveryInvokerRef}
            onRetry={() => setRecovery('recovery')}
            onDismissDemo={endRecovery}
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
              <button type="button" className="button button--quiet" disabled={!hasLiveClaim || contentMode === 'stale'} onClick={() => applyCorrection('accept')}>接受 Insight</button>
              <button type="button" className="button button--quiet" disabled={!hasLiveClaim || contentMode === 'stale'} onClick={() => applyCorrection('edit')}>编辑范围</button>
              <button type="button" className="button button--quiet" disabled={!hasLiveClaim || contentMode === 'stale'} onClick={() => applyCorrection('reject')}>驳回 Insight</button>
              <button type="button" className="button button--quiet" disabled={!hasLiveClaim || contentMode === 'stale'} onClick={(event) => { deleteInvokerRef.current = event.currentTarget; void applyCorrection('delete'); }}>删除 Insight</button>
              <button type="button" className="button button--primary" disabled={!imported} onClick={runDomainReplay}>运行 Replay</button>
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
            <span className="replay-status"><span aria-hidden="true">{imported ? '✓' : '○'}</span> {imported ? '可确定性重放' : '尚未运行'}</span>
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
