export type NativePrivacyMode = 'ACTIVE' | 'PRIVATE';

export interface NativeStatus {
  readonly schemaVersion: 'm5-ipc-v1';
  readonly privacyMode: NativePrivacyMode;
  readonly privacyEpoch: number;
  readonly uiaOptIn: boolean;
  readonly uiaAllowlistId: string;
  readonly auditSequence: number;
  readonly lastOperation: string | null;
}

export interface NativeClearReceipt {
  readonly schemaVersion: 'm5-ipc-v1';
  readonly status: 'SUCCEEDED';
  readonly privacyEpoch: number;
  readonly nativeRecordsCleared: number;
}

function isNativeShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isNativeShell()) return null;
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(command, args);
}

export function setNativePrivacyMode(mode: NativePrivacyMode): Promise<NativeStatus | null> {
  return invoke<NativeStatus>('set_privacy_mode', { mode });
}

export function getNativeStatus(): Promise<NativeStatus | null> {
  return invoke<NativeStatus>('native_status');
}

export function setNativeUiaOptIn(enabled: boolean): Promise<NativeStatus | null> {
  return invoke<NativeStatus>('set_uia_opt_in', { enabled });
}

export function observeAllowlistedNativeControl(): Promise<unknown | null> {
  return invoke('observe_allowlisted');
}

export function clearNativeState(): Promise<NativeClearReceipt | null> {
  return invoke<NativeClearReceipt>('clear_native_state');
}
