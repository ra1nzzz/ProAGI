import { useEffect, useState } from 'react';
import { clearNativeState, getNativeStatus, observeAllowlistedNativeControl, setNativeUiaOptIn, type NativeStatus } from '../nativeBridge';

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

  const clear = async () => {
    try {
      const receipt = await clearNativeState();
      const next = await getNativeStatus();
      if (next) setStatus(next);
      if (receipt) {
        setMessage(`原生壳已清理：进入 PRIVATE，privacy epoch 推进到 ${receipt.privacyEpoch}；保留 ${receipt.nativeRecordsCleared} 条原生 payload 记录。`);
      }
    } catch {
      setMessage('原生壳清理未执行；canonical store 未受影响。');
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
      <button type="button" className="button button--quiet" onClick={() => void clear()}>
        清理原生壳状态
      </button>
      <p>清理只作用于原生壳：关闭 UIA、进入 PRIVATE、推进 privacy epoch。IndexedDB 中的用户数据需通过「撤回真实来源授权」清除。</p>
      <p role="status" aria-live="polite">{message}</p>
    </details>
  );
}
