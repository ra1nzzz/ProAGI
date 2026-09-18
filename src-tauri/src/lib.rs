use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

const IPC_SCHEMA_VERSION: &str = "m5-ipc-v1";
const UIA_ALLOWLIST_ID: &str = "windows-notepad-focused-control-v1";

#[derive(Default)]
pub struct NativeState {
    inner: Mutex<NativeStateInner>,
}

#[derive(Default)]
struct NativeStateInner {
    privacy_mode: PrivacyMode,
    privacy_epoch: u64,
    uia_opt_in: bool,
    audit_sequence: u64,
    last_operation: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum PrivacyMode {
    #[default]
    Active,
    Private,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeStatus {
    schema_version: &'static str,
    privacy_mode: PrivacyMode,
    privacy_epoch: u64,
    uia_opt_in: bool,
    uia_allowlist_id: &'static str,
    audit_sequence: u64,
    last_operation: Option<&'static str>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeClearReceipt {
    schema_version: &'static str,
    status: &'static str,
    privacy_epoch: u64,
    native_records_cleared: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiaObservation {
    schema_version: &'static str,
    allowlist_id: &'static str,
    status: &'static str,
    control_type: Option<String>,
    class_name: Option<String>,
    name_hash: Option<String>,
}

fn parse_privacy_mode(mode: &str) -> Result<PrivacyMode, String> {
    match mode {
        "ACTIVE" => Ok(PrivacyMode::Active),
        "PRIVATE" => Ok(PrivacyMode::Private),
        _ => Err("ERR_NATIVE_PRIVACY_MODE".to_string()),
    }
}

fn audit(inner: &mut NativeStateInner, operation: &'static str) {
    inner.audit_sequence = inner.audit_sequence.saturating_add(1);
    inner.last_operation = Some(operation);
}

fn status(inner: &NativeStateInner) -> NativeStatus {
    NativeStatus {
        schema_version: IPC_SCHEMA_VERSION,
        privacy_mode: inner.privacy_mode,
        privacy_epoch: inner.privacy_epoch,
        uia_opt_in: inner.uia_opt_in,
        uia_allowlist_id: UIA_ALLOWLIST_ID,
        audit_sequence: inner.audit_sequence,
        last_operation: inner.last_operation,
    }
}

fn guard_observation(inner: &mut NativeStateInner) -> Result<(), String> {
    if inner.privacy_mode == PrivacyMode::Private {
        audit(inner, "uia-reject-private");
        return Err("ERR_NATIVE_PRIVATE".to_string());
    }
    if !inner.uia_opt_in {
        audit(inner, "uia-reject-opt-in");
        return Err("ERR_UIA_OPT_IN_REQUIRED".to_string());
    }
    Ok(())
}

fn clear_inner(inner: &mut NativeStateInner) -> NativeClearReceipt {
    inner.privacy_mode = PrivacyMode::Private;
    inner.privacy_epoch = inner.privacy_epoch.saturating_add(1);
    inner.uia_opt_in = false;
    audit(inner, "clear");
    NativeClearReceipt {
        schema_version: IPC_SCHEMA_VERSION,
        status: "SUCCEEDED",
        privacy_epoch: inner.privacy_epoch,
        native_records_cleared: 0,
    }
}

#[tauri::command]
fn native_status(state: State<'_, NativeState>) -> Result<NativeStatus, String> {
    state
        .inner
        .lock()
        .map(|inner| status(&inner))
        .map_err(|_| "ERR_NATIVE_STATE_POISONED".to_string())
}

#[tauri::command]
fn set_privacy_mode(mode: String, state: State<'_, NativeState>) -> Result<NativeStatus, String> {
    let next = parse_privacy_mode(&mode)?;
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "ERR_NATIVE_STATE_POISONED".to_string())?;
    if inner.privacy_mode != next {
        inner.privacy_mode = next;
        inner.privacy_epoch = inner.privacy_epoch.saturating_add(1);
    }
    audit(&mut inner, "privacy-mode");
    Ok(status(&inner))
}

#[tauri::command]
fn set_uia_opt_in(enabled: bool, state: State<'_, NativeState>) -> Result<NativeStatus, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "ERR_NATIVE_STATE_POISONED".to_string())?;
    inner.uia_opt_in = enabled;
    audit(&mut inner, "uia-opt-in");
    Ok(status(&inner))
}

#[tauri::command]
fn clear_native_state(state: State<'_, NativeState>) -> Result<NativeClearReceipt, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "ERR_NATIVE_STATE_POISONED".to_string())?;
    Ok(clear_inner(&mut inner))
}

#[tauri::command]
fn observe_allowlisted(state: State<'_, NativeState>) -> Result<UiaObservation, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "ERR_NATIVE_STATE_POISONED".to_string())?;
    guard_observation(&mut inner)?;
    drop(inner);
    let observation = uia::observe_allowlisted();
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "ERR_NATIVE_STATE_POISONED".to_string())?;
    match observation {
        Ok(value) => {
            audit(&mut inner, "uia-observe");
            Ok(value)
        }
        Err(error) => {
            audit(&mut inner, "uia-reject-observe");
            Err(error)
        }
    }
}

#[cfg(windows)]
mod uia {
    use super::{UiaObservation, IPC_SCHEMA_VERSION, UIA_ALLOWLIST_ID};
    use sha2::{Digest, Sha256};
    use std::path::Path;
    use uiautomation::{types::ControlType, UIAutomation};
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    pub fn observe_allowlisted() -> Result<UiaObservation, String> {
        let automation = UIAutomation::new().map_err(|_| "ERR_UIA_UNAVAILABLE".to_string())?;
        let element = automation
            .get_focused_element()
            .map_err(|_| "ERR_UIA_FOCUS_UNAVAILABLE".to_string())?;
        let process_id = element
            .get_process_id()
            .map_err(|_| "ERR_UIA_PROCESS_UNAVAILABLE".to_string())?;
        let process_name = process_name(process_id)?;
        if process_name != "notepad.exe" {
            return Err("ERR_UIA_ALLOWLIST_MISS".to_string());
        }
        let control_type = element
            .get_control_type()
            .map_err(|_| "ERR_UIA_CONTROL_TYPE".to_string())?;
        let class_name = element
            .get_classname()
            .map_err(|_| "ERR_UIA_CLASSNAME".to_string())?;
        let name = element.get_name().map_err(|_| "ERR_UIA_NAME".to_string())?;
        let name_hash = format!("sha256:{:x}", Sha256::digest(name.as_bytes()));
        if control_type != ControlType::Window
            && control_type != ControlType::Edit
            && control_type != ControlType::Document
        {
            return Err("ERR_UIA_CONTROL_NOT_ALLOWLISTED".to_string());
        }
        Ok(UiaObservation {
            schema_version: IPC_SCHEMA_VERSION,
            allowlist_id: UIA_ALLOWLIST_ID,
            status: "OBSERVED",
            control_type: Some(format!("{control_type:?}")),
            class_name: Some(class_name),
            name_hash: Some(name_hash),
        })
    }

    fn process_name(process_id: u32) -> Result<String, String> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }
            .map_err(|_| "ERR_UIA_PROCESS_OPEN".to_string())?;
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let result = unsafe {
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
        };
        unsafe {
            let _ = CloseHandle(handle);
        }
        result.map_err(|_| "ERR_UIA_PROCESS_NAME".to_string())?;
        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.to_ascii_lowercase())
            .ok_or_else(|| "ERR_UIA_PROCESS_NAME".to_string())
    }
}

#[cfg(not(windows))]
mod uia {
    use super::UiaObservation;

    pub fn observe_allowlisted() -> Result<UiaObservation, String> {
        Err("ERR_UIA_UNSUPPORTED_PLATFORM".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        audit, clear_inner, guard_observation, parse_privacy_mode, status, NativeStateInner,
        PrivacyMode, UIA_ALLOWLIST_ID,
    };

    #[test]
    fn native_state_defaults_to_active_with_uia_disabled() {
        let inner = NativeStateInner::default();
        let snapshot = status(&inner);
        assert_eq!(snapshot.privacy_mode, PrivacyMode::Active);
        assert_eq!(snapshot.privacy_epoch, 0);
        assert!(!snapshot.uia_opt_in);
        assert_eq!(snapshot.uia_allowlist_id, UIA_ALLOWLIST_ID);
    }

    #[test]
    fn privacy_mode_parser_rejects_unknown_values() {
        assert_eq!(parse_privacy_mode("ACTIVE"), Ok(PrivacyMode::Active));
        assert_eq!(parse_privacy_mode("PRIVATE"), Ok(PrivacyMode::Private));
        assert!(parse_privacy_mode("OBSERVE").is_err());
    }

    #[test]
    fn audit_sequence_is_monotonic() {
        let mut inner = NativeStateInner::default();
        audit(&mut inner, "test");
        audit(&mut inner, "test");
        assert_eq!(inner.audit_sequence, 2);
        assert_eq!(inner.last_operation, Some("test"));
    }

    #[test]
    fn observation_requires_explicit_opt_in() {
        let mut inner = NativeStateInner::default();
        assert_eq!(
            guard_observation(&mut inner),
            Err("ERR_UIA_OPT_IN_REQUIRED".to_string())
        );
        assert_eq!(inner.last_operation, Some("uia-reject-opt-in"));
    }

    #[test]
    fn private_mode_blocks_observation() {
        let mut inner = NativeStateInner {
            privacy_mode: PrivacyMode::Private,
            uia_opt_in: true,
            ..NativeStateInner::default()
        };
        assert_eq!(
            guard_observation(&mut inner),
            Err("ERR_NATIVE_PRIVATE".to_string())
        );
        assert_eq!(inner.last_operation, Some("uia-reject-private"));
    }

    #[test]
    fn clear_enters_private_and_disables_uia() {
        let mut inner = NativeStateInner {
            uia_opt_in: true,
            ..NativeStateInner::default()
        };
        let receipt = clear_inner(&mut inner);
        assert_eq!(receipt.status, "SUCCEEDED");
        assert_eq!(receipt.privacy_epoch, 1);
        assert_eq!(receipt.native_records_cleared, 0);
        assert_eq!(inner.privacy_mode, PrivacyMode::Private);
        assert!(!inner.uia_opt_in);
        assert_eq!(inner.last_operation, Some("clear"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(NativeState::default())
        .invoke_handler(tauri::generate_handler![
            native_status,
            set_privacy_mode,
            set_uia_opt_in,
            clear_native_state,
            observe_allowlisted
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
