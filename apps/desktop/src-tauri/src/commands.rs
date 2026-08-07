//! What the WebView is allowed to ask for.
//!
//! Three commands, and everything slow about them happens in Rust: starting a tunnel awaits a
//! provision and a QUIC handshake, and the progress of both arrives as events rather than as a
//! return value the frontend would have to poll for (`apps/desktop/CLAUDE.md` rule 11).
//!
//! ## Errors carry codes, never prose
//!
//! `CommandError` is an [`ErrorCode`] and nothing else. Only the layer that knows the user's
//! language may turn a code into words — that is `crates/cli`'s rule for the terminal and it is the
//! WebView's here. A command that returned `error.to_string()` would put English in the Rust half of
//! a translated app, which is defect R20 wearing a different hat.

use nport_contract::ClientKind;
use nport_contract::ErrorCode;
use nport_core::event::TunnelEvent;
use nport_core::manager::TunnelConfig;
use nport_core::tunnel::Tunnel;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::events::{TUNNEL_EVENT, UiEvent};
use crate::state::{TunnelSummary, Tunnels};

/// How long a tunnel gets to drain before its connections are cut.
///
/// Matches `crates/cli`'s. A GUI could afford to wait longer than a terminal, but the value is a
/// property of the edge's patience rather than of the interface, and two consumers disagreeing about
/// it would make a bug reproduce in one and not the other.
const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(10);

/// A failure the frontend can act on.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    /// The registry spelling — `LOCAL_PORT_CLOSED` — so the WebView can key a translation and link
    /// to `nport.link/errors/<slug>`.
    pub code: ErrorCode,
}

impl From<ErrorCode> for CommandError {
    fn from(code: ErrorCode) -> Self {
        Self { code }
    }
}

/// Starts a tunnel and begins forwarding its events.
///
/// # Errors
///
/// Any [`ErrorCode`] a provision or an edge connection can produce.
#[tauri::command]
pub async fn start_tunnel(
    app: AppHandle,
    tunnels: State<'_, Tunnels>,
    local_port: u16,
    subdomain: Option<String>,
    backend: Option<String>,
    registry: Option<String>,
) -> Result<TunnelSummary, CommandError> {
    let config = TunnelConfig {
        local_port,
        // The **raw** request, exactly as `crates/cli` sends it. The server normalizes and owns the
        // value that becomes a lease key; normalizing here would put a second authority on the path
        // and is how a deployment ends up refusing its own hostnames (defect 36).
        subdomain,
        backend: backend.unwrap_or_else(|| nport_core::api::DEFAULT_BACKEND.to_owned()),
        registry,
        nodes_cache: nodes_cache(&app),
        node: None,
        shutdown_grace: SHUTDOWN_GRACE,
    };

    let tunnel = Tunnel::start(config, ClientKind::Desktop, None)
        .await
        .map_err(|error| CommandError::from(error.code()))?;

    // **Before the pump subscribes, and deliberately.** `Provisioned` was broadcast while
    // `Tunnel::start` was still running, so a receiver created now never sees it — which is why the
    // URL is on the type as well as in the stream. `crates/cli` synthesises the same event for the
    // same reason; a UI that waited for it to arrive would wait forever.
    let provisioned = TunnelEvent::Provisioned {
        url: tunnel.url().to_owned(),
        subdomain: tunnel.subdomain().to_owned(),
        expires_at: tunnel.expires_at(),
    };
    emit(&app, &provisioned);

    let events = tunnel.events();
    let (summary, displaced) = tunnels.insert(tunnel, local_port);

    // The server handed back a name this app already had. Stop the old one rather than dropping it:
    // a dropped `Tunnel` leaves its connections up and its lease claimed with no handle to either.
    if let Some(old) = displaced {
        old.shutdown().await;
    }

    pump(app.clone(), events);
    Ok(summary)
}

/// Stops a tunnel: drains its connections, then releases the lease.
///
/// # Errors
///
/// [`ErrorCode::TunnelNotFound`] if no tunnel by that name is running here.
#[tauri::command]
pub async fn stop_tunnel(
    tunnels: State<'_, Tunnels>,
    subdomain: String,
) -> Result<(), CommandError> {
    // Taken out of the registry first so the lock is released before the drain — stopping two
    // tunnels must not serialise one behind the other.
    let tunnel = tunnels
        .remove(&subdomain)
        .ok_or_else(|| CommandError::from(ErrorCode::TunnelNotFound))?;

    tunnel.shutdown().await;
    Ok(())
}

/// Every tunnel this app is running, ordered by subdomain.
///
/// The frontend's source of truth on mount and after a reload; the event stream carries changes
/// from there. Deliberately not `async` — it reads a `Mutex` and returns.
#[tauri::command]
#[must_use]
pub fn list_tunnels(tunnels: State<'_, Tunnels>) -> Vec<TunnelSummary> {
    tunnels.list()
}

/// Forwards one tunnel's events to the WebView until the tunnel ends.
///
/// **This is the defined shutdown path** the Rust conventions require of a spawned task, and it is
/// the reason no cancellation token is needed: the broadcast sender lives inside the `Tunnel`, so
/// dropping the tunnel closes the channel, `recv` returns `Closed`, and the loop ends. A task that
/// outlived its tunnel would be a leak per running tunnel.
///
/// `Lagged` is the other ending worth naming, and it is **not** fatal: a broadcast receiver that
/// falls behind loses messages and keeps going. Breaking there would silence a tunnel permanently
/// because the UI was briefly slow.
fn pump(app: AppHandle, mut events: tokio::sync::broadcast::Receiver<TunnelEvent>) {
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => emit(&app, &event),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Emits one event, if this build knows how to describe it.
///
/// A variant `UiEvent` does not cover is dropped rather than forwarded as a placeholder — see
/// `events::UiEvent::from_core`, and the test there that stops this from happening silently for a
/// variant that should have been handled.
fn emit(app: &AppHandle, event: &TunnelEvent) {
    if let Some(ui) = UiEvent::from_core(event) {
        // A failed emit means the window is gone, which is not something a tunnel can act on.
        let _ = app.emit(TUNNEL_EVENT, ui);
    }
}

/// Where the discovered node list is cached, or `None` if this platform has no data directory.
///
/// **`core` resolves nothing itself** (`crates/CLAUDE.md` rule 9): a library that read `HOME` would
/// write into a developer's real `~/.nport` from inside a test, which is exactly what the first
/// draft of the failover tests did. So the app resolves the path and passes it in — through Tauri's
/// resolver rather than `$HOME`, because a desktop app's data belongs where the platform puts it,
/// not next to the CLI's config.
///
/// `None` keeps the node list in memory for the session rather than refusing to work, which is the
/// same fallback `crates/cli` takes when there is no home directory.
fn nodes_cache(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    // Best-effort: if it cannot be created, `core` will fail to write and carry on in memory.
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("nodes.json"))
}

/// Stops every running tunnel. Called when the app is quitting.
///
/// **A lease left claimed holds the user's own subdomain against them** for the rest of its term —
/// so quitting without this means `myapp` is unavailable to the person who just closed the window.
pub async fn shutdown_all(tunnels: &Tunnels) {
    for tunnel in tunnels.drain() {
        tunnel.shutdown().await;
    }
}
