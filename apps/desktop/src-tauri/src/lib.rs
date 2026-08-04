//! The Tauri backend.
//!
//! **Scaffold.** The app is Phase 4 (`apps/desktop/CLAUDE.md`); this is a window, one command, and
//! the wiring that proves both work. It deliberately does **not** depend on `nport-core` yet —
//! that edge is what Phase 4 waits for a stable core API to add, and adding it early is exactly the
//! churn the ordering exists to avoid.
//!
//! Two rules from `apps/desktop/CLAUDE.md` already apply to the one command below. Every command
//! needs an entry in `capabilities/default.json` or it is denied at runtime with an error that does
//! not say why (rule 4). And nothing here may render a token or an `ownerToken` — redaction happens
//! at the `core` boundary, so the frontend never receives one to leak (rule 6).

/// A liveness probe for the IPC boundary.
///
/// Its only job is to fail loudly if the bridge is misconfigured, which is why the frontend calls it
/// on mount. From Phase 4 this file's signatures are what `tauri-specta` reads to generate
/// `src/generated/bindings.ts`, so the shape of a command is a contract, not an implementation
/// detail (rule 3).
#[tauri::command]
fn health() -> String {
    format!("nport-desktop {} · ipc ok", env!("CARGO_PKG_VERSION"))
}

/// Builds and runs the app.
///
/// # Panics
///
/// If Tauri cannot start — a malformed `tauri.conf.json`, or no display server. There is nothing to
/// recover to at this point: the process exists to show a window, and a GUI that returns an error to
/// a terminal nobody is watching is worse than a crash with a message.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![health])
        .run(tauri::generate_context!())
        .expect("the app could not start");
}
