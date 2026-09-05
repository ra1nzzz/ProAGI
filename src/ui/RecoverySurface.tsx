import { useEffect, useRef, type RefObject } from 'react';

export type RecoveryKind = 'recovery' | 'blocked';

interface RecoverySurfaceProps {
  kind: RecoveryKind;
  returnFocusRef: RefObject<HTMLElement | null>;
  onRetry: () => void;
  onDismissDemo: () => void;
}

export function RecoverySurface({ kind, returnFocusRef, onRetry, onDismissDemo }: RecoverySurfaceProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const invoker = returnFocusRef.current;
    headingRef.current?.focus();
    return () => {
      if (invoker?.isConnected) invoker.focus();
      else document.querySelector<HTMLElement>('[data-global-status]')?.focus();
    };
  }, [returnFocusRef]);

  const blocked = kind === 'blocked';

  return (
    <section className={`recovery-surface ${blocked ? 'recovery-surface--blocked' : ''}`} role="region" aria-labelledby="recovery-title">
      <div className="recovery-surface__icon" aria-hidden="true">{blocked ? '!' : '↻'}</div>
      <div>
        <p className="eyebrow">安全恢复</p>
        <h2 id="recovery-title" ref={headingRef} tabIndex={-1}>
          {blocked ? '清除尚未完成' : '本地数据仍在恢复'}
        </h2>
        <p>
          {blocked
            ? '另一个 ProAGI 标签页仍占用本地存储。普通写入保持暂停；关闭其他标签页后重试。'
            : '普通写入已暂停。正在核对本地索引与投影；恢复不会自动重新开启观察。'}
        </p>
        <p className="recovery-surface__status" role="status" aria-live="polite" aria-atomic="true">
          {blocked ? '当前状态：CLEAR ONLY · 尚未清除' : '当前状态：RECOVERY ONLY · 仍在恢复'}
        </p>
        {blocked ? <p className="sr-only" role="alert">清除被阻止，数据尚未清除。</p> : null}
        <div className="button-row">
          <button type="button" className="button button--primary" onClick={onRetry}>重试恢复</button>
          <button type="button" className="button button--quiet" onClick={onDismissDemo}>退出恢复演示</button>
        </div>
      </div>
    </section>
  );
}
