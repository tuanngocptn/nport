//! Cloudflare Tunnel connector wire protocol: edge discovery, QUIC and HTTP/2
//! transports, Cap'n Proto registration RPC, and per-stream request framing.
//!
//! **Phase 1 complete; Phase 2b in progress.** `docs/ROADMAP.md` tracks what is done.
//!
//! Read `docs/PROTOCOL.md` in full — not skimmed — and `crates/protocol/CLAUDE.md`
//! before adding anything here. Every constant carries a `file:symbol` citation into
//! the pinned cloudflared commit; a value without one is deleted in review.

#![forbid(unsafe_code)]

pub mod connect;
pub mod edge;
pub mod quic;
pub mod rpc;
pub mod token;

use std::future::Future;
use std::net::SocketAddr;

use tokio::io::{AsyncRead, AsyncWrite};

/// What went wrong at the transport layer, as far as anything above it needs to care.
///
/// Deliberately tiny. A caller's only real decision is whether to rotate to another edge address and
/// redial, and both variants mean yes. Anything finer belongs to the transport's own error type
/// ([`quic::QuicError`]), which is where the detail worth logging lives.
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    /// The connection is gone. Rotate and redial.
    #[error("the connection to the edge was lost")]
    ConnectionLost,
    /// The connection is alive but would not give us a stream.
    #[error("the edge refused to open a stream")]
    StreamRejected,
}

/// A live connection to the Cloudflare edge, reduced to what the layers above it need.
///
/// **A transport owns dialling and stream opening. Nothing else.** Registration
/// ([`rpc`]), framing ([`connect`]), and every policy decision are shared across transports and live
/// above this trait — which is what makes ADR-0017's fallback ladder a transport swap rather than a
/// rewrite.
///
/// ## The two methods are not symmetric, and that is the point
///
/// `docs/PROTOCOL.md` §6: the **control** stream is opened by the client and carries no signature and
/// no version byte, while **data** streams are opened by the *edge* and carry both. So the trait has
/// one method for each direction rather than a single `open_stream`.
///
/// That asymmetry is also what lets HTTP/2 implement this at all. Under h2 the roles invert: the
/// client dials TCP+TLS and then runs an HTTP/2 **server** on that socket, and the edge sends requests
/// to it (ADR-0017). `open_control` becomes "issue the request carrying
/// `Cf-Cloudflared-Proxy-Connection-Upgrade: control-stream`" and `accept_data` becomes "accept the
/// next h2 request" — different mechanics, same two questions. A trait built around "the client opens
/// streams" could not express it, and the fallback would be a rewrite.
///
/// ## Halves, not a duplex
///
/// Both transports hand back a send half and a receive half rather than one bidirectional object, and
/// forcing them into a duplex wrapper would only mean splitting them again in the proxy loop, which
/// pumps the two directions independently.
///
/// ## Not dyn-compatible
///
/// The futures here are returned as `impl Future`, so a caller that must pick a transport at runtime
/// wraps the implementors in an enum rather than a `Box<dyn Transport>`. That is the right trade for
/// exactly two implementors: it costs one `match` and keeps the `Send` bounds, which a
/// `Box<dyn Future>` would erase — and `crates/core` needs them to spawn its connection tasks.
pub trait Transport {
    /// The write half of a stream.
    type Send: AsyncWrite + Unpin + Send + 'static;
    /// The read half of a stream.
    type Recv: AsyncRead + Unpin + Send + 'static;

    /// The address that answered. For logs and for the address pool's demotion bookkeeping.
    fn peer(&self) -> SocketAddr;

    /// Opens the control stream, which carries the registration RPC.
    ///
    /// **Must be the first stream on the connection** (`docs/PROTOCOL.md` §6) and **must not** be sent
    /// a signature or version byte. The trait cannot enforce either — ordering is the caller's, and the
    /// preamble is [`connect`]'s — which is why both are said here and in §6's trap 1.
    fn open_control(
        &self,
    ) -> impl Future<Output = Result<(Self::Send, Self::Recv), TransportError>> + Send;

    /// Waits for the edge to open the next data stream: one inbound request.
    ///
    /// Returns [`TransportError::ConnectionLost`] when the connection ends, which is the pool's signal
    /// to rotate and re-register that index.
    fn accept_data(
        &self,
    ) -> impl Future<Output = Result<(Self::Send, Self::Recv), TransportError>> + Send;

    /// Closes the connection.
    ///
    /// Called after `unregisterConnection` and the drain period, never instead of them: closing without
    /// unregistering drops in-flight requests on the floor (`docs/PROTOCOL.md` §12).
    fn close(&self, reason: &str);
}

/// Generated from `schema/`. Not our code, so not our lint standards — but it is our
/// wire identity, so the type IDs in it matter more than anything we wrote by hand.
#[allow(
    clippy::all,
    clippy::pedantic,
    dead_code,
    unreachable_pub,
    unused_qualifications,
    missing_docs
)]
pub mod schema {
    pub mod tunnelrpc_capnp {
        include!(concat!(env!("OUT_DIR"), "/tunnelrpc_capnp.rs"));
    }

    pub mod quic_metadata_protocol_capnp {
        include!(concat!(env!("OUT_DIR"), "/quic_metadata_protocol_capnp.rs"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex;
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, ReadHalf, WriteHalf, duplex};

    /// A second [`Transport`], built on in-memory pipes and owing nothing to QUIC.
    ///
    /// This is the test that matters for the trait itself. A trait with one implementor tends to end up
    /// shaped like that implementor, and the whole value of ADR-0017's ladder rests on the shape being
    /// general enough for HTTP/2 — where the client runs a *server* and the edge opens the data streams.
    /// If the trait had quietly assumed quinn's `open_bi`/`accept_bi`, writing this would be awkward.
    /// It is not, and that is the assertion.
    ///
    /// It is also the double `crates/core` will drive its proxy loop against without a network.
    struct Loopback {
        peer: SocketAddr,
        /// Streams the "edge" will hand over, oldest first.
        prepared: Mutex<Vec<DuplexStream>>,
    }

    impl Loopback {
        /// Takes the next prepared stream. No `await` while the lock is held — see the async
        /// conventions in `docs/conventions/rust.md`.
        fn take(
            &self,
        ) -> Result<(WriteHalf<DuplexStream>, ReadHalf<DuplexStream>), TransportError> {
            let mut prepared = self.prepared.lock().expect("test lock poisoned");
            if prepared.is_empty() {
                return Err(TransportError::ConnectionLost);
            }
            let stream = prepared.remove(0);
            let (recv, send) = tokio::io::split(stream);
            Ok((send, recv))
        }
    }

    impl Transport for Loopback {
        type Send = WriteHalf<DuplexStream>;
        type Recv = ReadHalf<DuplexStream>;

        fn peer(&self) -> SocketAddr {
            self.peer
        }

        async fn open_control(&self) -> Result<(Self::Send, Self::Recv), TransportError> {
            self.take()
        }

        async fn accept_data(&self) -> Result<(Self::Send, Self::Recv), TransportError> {
            self.take()
        }

        fn close(&self, _reason: &str) {}
    }

    /// Uses a transport through the trait alone, as `crates/core` will.
    ///
    /// Generic on purpose: if any method needed a type only one transport has, this would not compile.
    async fn round_trip<T: Transport>(transport: &T, payload: &[u8]) -> Vec<u8> {
        let (mut send, recv) = transport.open_control().await.expect("control stream");
        send.write_all(payload).await.expect("write");
        // `shutdown`, not `drop`. `tokio::io::split` keeps the underlying stream alive until *both*
        // halves are gone, so dropping only the write half signals no EOF and the far end's
        // `read_to_end` waits forever. The first draft did exactly that and deadlocked.
        send.shutdown().await.expect("shutdown");
        drop(send);
        drop(recv);

        let (send, mut recv) = transport.accept_data().await.expect("data stream");
        drop(send);
        let mut received = Vec::new();
        recv.read_to_end(&mut received).await.expect("read");
        received
    }

    /// Fails a hung test in seconds rather than letting it wedge the suite.
    ///
    /// Worth the wrapper: the deadlock above ran for seven minutes before anything noticed, and a test
    /// that hangs is far harder to read in CI than one that fails.
    async fn within<F: std::future::Future>(future: F) -> F::Output {
        tokio::time::timeout(Duration::from_secs(5), future)
            .await
            .expect("timed out — a stream half was probably left open")
    }

    fn loopback(streams: Vec<DuplexStream>) -> Loopback {
        Loopback {
            peer: "203.0.113.1:7844".parse().expect("test address"),
            prepared: Mutex::new(streams),
        }
    }

    #[tokio::test]
    async fn a_transport_need_not_be_quic() {
        // Two pipes: the control stream we write into, and the data stream the far end answers on.
        let (control_near, mut control_far) = duplex(64);
        let (data_near, mut data_far) = duplex(64);

        let transport = loopback(vec![control_near, data_near]);

        let far = tokio::spawn(async move {
            let mut seen = Vec::new();
            control_far.read_to_end(&mut seen).await.expect("far read");
            data_far.write_all(b"pong").await.expect("far write");
            data_far.shutdown().await.expect("far shutdown");
            seen
        });

        let received = within(round_trip(&transport, b"ping")).await;
        let seen = within(far).await.expect("far task");

        assert_eq!(seen, b"ping");
        assert_eq!(received, b"pong");
    }

    #[tokio::test]
    async fn accept_reports_connection_lost_when_the_far_end_is_done() {
        // The pool's signal to rotate the edge address and re-register that index.
        let transport = loopback(Vec::new());
        let error = transport.accept_data().await.expect_err("should be lost");
        assert!(matches!(error, TransportError::ConnectionLost));
    }

    #[test]
    fn a_transport_reports_the_address_that_answered() {
        // The address pool demotes on failure by peer, so this has to be the address actually dialled.
        let transport = loopback(Vec::new());
        assert_eq!(transport.peer().port(), 7844);
    }
}
