import { useEffect, useState } from 'react';
import { getNativeStatus, observeAllowlistedNativeControl, setNativeUiaOptIn, type NativeStatus } from '../nativeBridge';

export function NativeShellControls() {
  const [status, setStatus] = useState<NativeStatus | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getNativeStatus().then((next) => {
      if (!cancelled) setStatus(next);
    }).catch(() => {
      if (!cancelled) setMessage('原生控制面不可用；UIA 保持关闭。');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  const toggleUia = async (enabled: boolean) => {
    try {
      const next = await setNativeUiaOptIn(enabled);
      if (next) {
        setStatus(next);
        setMessage(enabled ? 'UIA 已显式启用，仅允许读取白名单控件。' : 'UIA 已关闭。');
      }
    } catch {
      setMessage('UIA 状态未改变；权限或原生控制面不可用。');
    }
  };

  const observe = async () => {
    try {
      const result = await observeAllowlistedNativeControl();
      if (result) setMessage('只读 UIA 观察已完成；未显示原始控件正文。');
    } catch {
      setMessage('UIA 观察未执行或未命中白名单；没有降级采集。');
    }
  };

  return (
    <details className="consent-details native-shell-controls">
      <summary>Windows 窄 UIA（默认关闭）</summary>
      <p>仅允许 {status.uiaAllowlistId}；只读、无键盘/鼠标注入，不保存原始控件正文。</p>
      <label className="checkbox-row">
        <input type="checkbox" checked={status.uiaOptIn} onChange={(event) => void toggleUia(event.target.checked)} />
        我明确允许本次只读 UIA 观察
      </label>
      <button type="button" className="button button--quiet" onClick={() => void observe()} disabled={!status.uiaOptIn || status.privacyMode === 'PRIVATE'}>
        读取当前白名单控件
      </button>
      <p role="status" aria-live="polite">{message}</p>
    </details>
  );
}
