//! The Tauri backend.
//!
//! **Phase 4, in progress.** The window and its one health command are the scaffold; `events` is the
//! first piece of the app proper. The `nport-core` edge the ordering was waiting for now exists —
//! `core` is stable, so consuming it no longer churns it.
//!
//! Nothing here may render a token or an `ownerToken` (rule 6) — redaction happens at the `core`
//! boundary, so the frontend never receives one to leak. `TunnelEvent` and `TunnelSummary` both
//! carry none, so that costs nothing to honour.
//!
//! **Commands registered below need no capability entry.** The ACL gates plugin and `core:`
//! permissions; an app command in `generate_handler!` is invocable without one, which `health` has
//! demonstrated since the scaffold (rule 4, corrected — `docs/ROADMAP.md` defect 47).

use tauri::Manager;

pub mod commands;
pub mod events;
pub mod inspector;
pub mod state;

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
        .manage(state::Tunnels::new())
        .invoke_handler(tauri::generate_handler![
            health,
            commands::start_tunnel,
            commands::stop_tunnel,
            commands::list_tunnels,
            commands::server_limits
        ])
        .build(tauri::generate_context!())
        .expect("the app could not start")
        .run(|app, event| {
            // **Quitting has to release the leases.** A lease left claimed holds the user's own
            // subdomain against them for the rest of its term, so closing the window without this
            // makes `myapp` unavailable to the person who just closed it.
            //
            // `Exit` rather than `ExitRequested`: the latter can be cancelled, and draining tunnels
            // for a quit that then does not happen would stop the app's own tunnels behind the
            // user's back. This is the last point at which anything can still run.
            //
            // `block_on` because `RunEvent` is a synchronous callback and the drain must finish
            // before the process does — a spawned task would be killed by the exit it was racing.
            if matches!(event, tauri::RunEvent::Exit) {
                let tunnels = app.state::<state::Tunnels>();
                tauri::async_runtime::block_on(commands::shutdown_all(&tunnels));
            }
        });
}
