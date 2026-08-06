//! The `nport` binary: parse, provision, render, stop.
//!
//! This crate is the only one that formats text for humans and the only one that knows the user's
//! language. Everything it prints comes from [`i18n`] and [`render`]; everything it *does* comes
//! from `crates/core`, which is headless and emits events.
//!
//! The order in `main` is deliberate, and it is four of v2's defects in sequence:
//!
//! 1. **Parse first.** `--help` and `--version` answer before a config file is read, a locale is
//!    resolved, or a socket is opened. v2's `nport -v` hung on a fresh install behind a prompt.
//! 2. **Check the requested name, then probe the local port, and only then provision.** Both fail
//!    before anything is claimed. The name goes first because it is pure — refusing `-s my_app`
//!    should not depend on whether a socket answers — and because the alternative is a proof-of-work
//!    solve and a round trip spent to be told what `nport_contract::subdomain` already knows.
//!    Failing with `LOCAL_PORT_CLOSED` beats creating a tunnel to nothing and printing a URL that
//!    answers 502.
//! 3. **Never prompt** (ADR-0019). There is no TTY detection anywhere in this crate.
//! 4. **Shutdown is structured and re-entrant.** A second Ctrl+C exits immediately rather than
//!    firing a second delete — v2's signal handler called an async cleanup it never awaited.

#![forbid(unsafe_code)]

mod args;
mod config;
mod i18n;
mod render;

use std::process::ExitCode;
use std::time::Duration;

use clap::Parser as _;
use nport_contract::subdomain::check_subdomain;
use nport_contract::{ClientKind, ErrorCode};
use nport_core::event::{ShutdownReason, TunnelEvent};
use nport_core::manager::TunnelConfig;
use nport_core::tunnel::Tunnel;
use tokio::sync::broadcast::error::RecvError;

use crate::args::Args;
use crate::i18n::{Lang, Message};
use crate::render::{Renderer, Stream, Verbosity};

/// How long the connections get to drain on Ctrl+C.
///
/// **Not the library's 30 seconds**, and `docs/PROTOCOL.md` §12 says so explicitly: a developer
/// pressing Ctrl+C expects a prompt exit, not half a minute of apparent hang. Choosing the
/// user-facing number is this crate's job, which is exactly why `core` makes it a config value
/// rather than a constant.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// The exit code for a tunnel stopped by a signal, by convention 128 + SIGINT.
const EXIT_INTERRUPTED: i32 = 130;

fn main() -> ExitCode {
    // Parsed before anything else exists — no runtime, no config, no network. `--help` and
    // `--version` are handled inside this call and never reach the code below.
    let args = match Args::try_parse() {
        Ok(args) => args,
        Err(error) => {
            // clap prints help and version to stdout, errors to stderr, each with the right exit
            // code. Re-implementing that is how a CLI ends up printing `--help` to stderr.
            let _ = error.print();
            return if error.use_stderr() {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            };
        }
    };

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("nport: could not start ({error}) [{}]", ErrorCode::Internal);
            return ExitCode::FAILURE;
        }
    };

    runtime.block_on(run(args))
}

async fn run(args: Args) -> ExitCode {
    // Lazily, and only now: a `--help` above never touched the disk.
    let configured = match config::load(config::path(env).as_deref()) {
        Ok(configured) => configured.unwrap_or_default(),
        Err(error) => {
            // A corrupt file is a clear error, never a silent default — a typo must not quietly
            // change what the tool does.
            //
            // **Resolved without the config, because the config is what failed.** This used to print
            // `{error}` directly, which is `thiserror`'s English Display — so `--lang es` and
            // `NPORT_LANG=vi` were both ignored on the one path where the user is already confused.
            // That is defect R20's shape (prose reaching a user outside the i18n path), and it was
            // structural: the renderer did not exist yet. It does not need the file to exist — the
            // flag and the environment are exactly the two sources a user can still set while their
            // config is broken.
            let renderer = Renderer::new(
                Lang::detect(args.lang.as_deref(), None, env),
                Verbosity::Normal,
            );
            // Sentence, code, then the specific reason in parentheses — the same shape the port probe
            // below uses. The reason comes from `toml` and stays English, which is the right trade:
            // "unknown field `porrt`, expected one of …" is what makes this actionable, and it is a
            // technical detail rather than a sentence.
            eprintln!("nport: {} ({error})", renderer.error(error.code()));
            return ExitCode::FAILURE;
        }
    };

    let lang = Lang::detect(args.lang.as_deref(), configured.lang.as_deref(), env);
    let renderer = Renderer::new(
        lang,
        if args.quiet {
            Verbosity::Quiet
        } else {
            Verbosity::Normal
        },
    );

    let Some(port) = args.resolved_port().or(configured.port) else {
        // Not a clap requirement, because the config file may supply it. Usage rather than a code:
        // nothing has been attempted yet.
        eprintln!("nport: a port is required — try `nport 3000`, or `nport --help`");
        return ExitCode::FAILURE;
    };
    if port == 0 {
        eprintln!("nport: {}", renderer.error(ErrorCode::LocalPortInvalid));
        return ExitCode::FAILURE;
    }

    let subdomain = args.subdomain.or(configured.subdomain);
    // The server would refuse this too, and it is authoritative (invariant 3) — but it would refuse
    // it *after* a challenge, a solve, and a round trip, and the answer cannot differ: the rules are
    // the contract's, mirrored in `nport_contract::subdomain` and pinned to the same fixtures.
    // Ahead of the port probe because this opens no socket, so `-s my_app` reports the name rather
    // than whichever of the two problems happened to be checked first.
    if let Some(requested) = subdomain.as_deref() {
        if let Err(reason) = check_subdomain(requested) {
            // Sentence, code, then the specific reason in parentheses — the shape the config and port
            // failures already use. The reason is the contract's own spelling, so this line reads the
            // same whether the refusal came from here or from the server's `details.reason`.
            eprintln!(
                "nport: {} ({reason})",
                renderer.error(ErrorCode::InvalidSubdomain)
            );
            return ExitCode::FAILURE;
        }
    }

    // Before provisioning, not after. A tunnel to a port nothing is listening on is a URL that
    // answers 502, and the user is left to work out why.
    if let Err(error) = probe(port).await {
        eprintln!(
            "nport: {} ({error})",
            renderer.error(ErrorCode::LocalPortClosed)
        );
        return ExitCode::FAILURE;
    }

    // **`--backend` wins, and winning means skipping discovery** (ADR-0031). An explicit backend — from
    // the flag or from `~/.nport/config.toml` — is a statement about which server to use, so asking a
    // directory for one instead would be ignoring it. That is also what keeps every self-hosted
    // deployment and `pnpm dev:cli` on exactly the path they were on before federation existed.
    let backend = args.backend.or(configured.backend);
    let registry = if backend.is_some() {
        None
    } else {
        Some(
            args.registry
                .or(configured.registry)
                .unwrap_or_else(|| nport_core::discovery::DEFAULT_REGISTRY.to_owned()),
        )
    };

    let config = TunnelConfig {
        local_port: port,
        // The **raw** request, not the normalized one. The server normalizes again and owns the value
        // that becomes a lease key; sending our version would put a second authority on the path.
        subdomain,
        backend: backend.unwrap_or_else(|| nport_core::api::DEFAULT_BACKEND.to_owned()),
        registry,
        // `None` when there is no home directory to write to, which keeps the list in memory for that
        // run rather than refusing to work. `core` resolves nothing itself.
        nodes_cache: config::nodes_path(env),
        node: args.node.or(configured.node),
        shutdown_grace: SHUTDOWN_GRACE,
    };

    // The CLI attaches no inspector: it has nothing to show, and one nobody reads is overhead on
    // every request (`nport_core::inspector`).
    let tunnel = match Tunnel::start(config, ClientKind::Cli, None).await {
        Ok(tunnel) => tunnel,
        Err(error) => {
            eprintln!("nport: {}", renderer.error(error.code()));
            return ExitCode::FAILURE;
        }
    };

    serve(tunnel, renderer, port).await
}

/// Renders events until the tunnel ends or the user stops it.
async fn serve(tunnel: Tunnel, renderer: Renderer, port: u16) -> ExitCode {
    let mut events = tunnel.events();

    // `Provisioned` was sent before this receiver existed, which is why the URL is on the type as
    // well as in the stream.
    show(
        &renderer,
        &TunnelEvent::Provisioned {
            url: tunnel.url().to_owned(),
            subdomain: tunnel.subdomain().to_owned(),
            expires_at: tunnel.expires_at(),
        },
        port,
    );

    let mut ended = None;

    loop {
        tokio::select! {
            signal = tokio::signal::ctrl_c() => {
                if signal.is_err() {
                    // No signal handler available — a container without one, usually. Nothing to do
                    // but keep serving; the lease still expires on its own.
                    continue;
                }
                eprintln!("nport: {}", renderer.say(Message::ShuttingDown));
                eprintln!("nport: {}", renderer.say(Message::PressAgainToForce));
                break;
            }
            event = events.recv() => match event {
                Ok(event) => {
                    if let TunnelEvent::ShuttingDown { reason } = event {
                        ended = Some(reason);
                    }
                    let last = matches!(event, TunnelEvent::Stopped { .. });
                    show(&renderer, &event, port);
                    if last {
                        // The tunnel ended on its own; there is nothing left to stop.
                        return match ended {
                            // Every connection gave up. Exiting non-zero is what lets a supervisor
                            // notice — a CLI that vanishes quietly is defect R1 all over again.
                            Some(ShutdownReason::ConnectionsExhausted) => ExitCode::FAILURE,
                            _ => ExitCode::SUCCESS,
                        };
                    }
                }
                // The sender is gone, or this receiver fell behind. Neither is worth ending on.
                Err(RecvError::Closed) => break,
                Err(RecvError::Lagged(_)) => {}
            },
        }
    }

    // A second Ctrl+C during the drain exits immediately. The lease is left to expire on its own,
    // which `docs/API.md` guarantees is safe — and waiting is precisely what someone pressing it
    // twice has just said they do not want to do. Re-entrancy is structural rather than guarded:
    // `shutdown` consumes the tunnel, so there is no second one to start.
    let forced = tokio::spawn(async {
        if tokio::signal::ctrl_c().await.is_ok() {
            std::process::exit(EXIT_INTERRUPTED);
        }
    });

    tunnel.shutdown().await;
    forced.abort();
    eprintln!("nport: {}", renderer.say(Message::Stopped));
    ExitCode::SUCCESS
}

fn show(renderer: &Renderer, event: &TunnelEvent, port: u16) {
    // One event can produce lines on both streams — `Provisioned` puts the URL on stdout and its
    // banner on stderr, so `URL=$(nport 3000)` captures the URL and nothing else.
    for (stream, line) in renderer.event(event, port) {
        match stream {
            Stream::Stdout => println!("{line}"),
            Stream::Stderr => eprintln!("{line}"),
        }
    }
}

/// Is anything listening on `port`?
///
/// A TCP connect, not a bind: binding would report "free" for exactly the port that *is* serving,
/// which is backwards. `crates/CLAUDE.md`, CLI rule 6.
async fn probe(port: u16) -> std::io::Result<()> {
    let address = std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port));
    tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect(address),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "the probe timed out"))??;
    Ok(())
}

/// The process environment, as a lookup.
///
/// Everything that reads it takes one of these, so no test has to touch the real one — a global that
/// makes tests order-dependent the moment two of them disagree.
fn env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A config failure is reported in the user's language, not in English.
    ///
    /// The fix this pins is an ordering one: the config error used to be printed before `lang` was
    /// resolved, because resolution consulted the config — so `--lang` and `NPORT_LANG` were both
    /// ignored on the one path where the user is already puzzled. Resolution does not need the file:
    /// the flag and the environment are exactly the two sources still available when it is broken.
    #[test]
    fn a_config_failure_still_honours_the_language() {
        let no_env = |_: &str| None;

        for (flag, expected) in [("vi", "không đọc được"), ("es", "no se pudo leer")] {
            // `None` for the config's contribution, which is what `main` passes on this path.
            let renderer = Renderer::new(Lang::detect(Some(flag), None, no_env), Verbosity::Normal);
            let line = renderer.error(nport_contract::ErrorCode::ConfigUnreadable);
            assert!(
                line.contains(expected),
                "--lang {flag} should have been honoured: {line}"
            );
        }
    }

    #[tokio::test]
    async fn the_probe_sees_a_listening_port_and_a_closed_one() {
        // The check that turns "your URL answers 502" into "nothing is listening on that port",
        // before a tunnel exists to be confused by.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();

        assert!(probe(port).await.is_ok());

        drop(listener);
        assert!(
            probe(port).await.is_err(),
            "a closed port must not look open"
        );
    }
}
