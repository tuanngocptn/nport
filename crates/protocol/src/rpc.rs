//! Registration RPC over the control stream.
//!
//! `docs/PROTOCOL.md` §8. Cap'n Proto RPC, two-party vat, Level 1. The **edge** exports
//! the interface; the client calls `bootstrap` and invokes methods on the result.
//!
//! Two things here are easy to get wrong and both are load-bearing:
//!
//! 1. **The control stream carries no signature and no version byte** — unlike every other
//!    stream type (§6, trap 1). It is the first stream opened on the connection and the
//!    Cap'n Proto message goes on it directly. Sending a preamble is the single most
//!    likely first-attempt failure.
//! 2. **`registerConnection` dispatches on `RegistrationServer`'s interface ID**
//!    (`0xf71695ec7fe85497`), method 0, which is what a schema-driven client emits by
//!    default. `TunnelServer`'s `@0` is the deprecated `registerTunnel` (§8).

use std::time::Duration;

use capnp_rpc::rpc_twoparty_capnp::Side;
use capnp_rpc::{RpcSystem, twoparty};
use tokio_util::compat::{TokioAsyncReadCompatExt as _, TokioAsyncWriteCompatExt as _};
use uuid::Uuid;

use crate::schema::tunnelrpc_capnp::{connection_response, registration_server};
use crate::token::TunnelToken;

/// RPC call timeout.
///
/// cloudflared: `cmd/cloudflared/tunnel/cmd.go` → `RpcTimeout`, the `--rpc-timeout` default.
pub const RPC_TIMEOUT: Duration = Duration::from_secs(5);

/// The default feature list, which is sufficient for NPort.
///
/// cloudflared: `features/features.go` → `defaultFeatures`. Order is nondeterministic
/// upstream because it comes from Go map iteration, so the edge cannot be order-sensitive.
///
/// `support_datagram_v2` is advertised and never used — datagrams are out of scope for 3.0
/// (ADR-0020).
pub const DEFAULT_FEATURES: [&str; 5] = [
    "allow_remote_config",
    "serialized_headers",
    "support_datagram_v2",
    "support_quic_eof",
    "management_logs",
];

/// A successful registration.
#[derive(Debug, Clone)]
pub struct ConnectionDetails {
    /// The edge's identifier for this connection.
    pub uuid: Vec<u8>,
    /// Colo airport code. Worth surfacing — it is genuinely useful when a user is
    /// debugging latency.
    pub location_name: String,
    /// Whether the tunnel's configuration is managed remotely.
    ///
    /// NPort creates tunnels with `config_src: "cloudflare"`, so this should be true and
    /// `updateLocalConfiguration` is never called (§9).
    pub tunnel_is_remotely_managed: bool,
}

/// Errors from the registration RPC.
#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    /// The control stream could not be opened.
    #[error("could not open the control stream")]
    OpenStream(#[source] Box<dyn std::error::Error + Send + Sync>),
    /// The Cap'n Proto layer failed — a transport error, or a malformed message.
    #[error("registration RPC failed")]
    Capnp(#[source] capnp::Error),
    /// The call did not complete within [`RPC_TIMEOUT`].
    #[error("registration did not complete within {}s", RPC_TIMEOUT.as_secs())]
    Timeout,
    /// The response arrived but could not be interpreted: an unknown union tag, or text
    /// that is not UTF-8.
    ///
    /// Kept distinct from [`RpcError::Capnp`] because this is what an edge protocol change
    /// looks like from here — risks P4 and P5 — and it should page rather than retry.
    #[error("could not interpret the edge's registration response")]
    Malformed(#[source] Box<dyn std::error::Error + Send + Sync>),
    /// The edge refused the registration.
    #[error("edge refused registration: {cause}")]
    Refused {
        /// The upstream cause string. `EDUPCONN` means rotate the edge address rather
        /// than retrying the same one; a cause containing `Unauthorized` is usually
        /// transient because a freshly created tunnel takes time to propagate (§8).
        cause: String,
        /// How long to wait. **Nanoseconds on the wire** — a Go `time.Duration`.
        retry_after: Option<Duration>,
        /// Whether the edge considers a retry worthwhile at all.
        should_retry: bool,
    },
}

impl From<capnp::Error> for RpcError {
    fn from(error: capnp::Error) -> Self {
        Self::Capnp(error)
    }
}

impl From<capnp::NotInSchema> for RpcError {
    fn from(error: capnp::NotInSchema) -> Self {
        Self::Malformed(Box::new(error))
    }
}

impl From<std::str::Utf8Error> for RpcError {
    fn from(error: std::str::Utf8Error) -> Self {
        Self::Malformed(Box::new(error))
    }
}

/// `<os>_<arch>` in Go's vocabulary, which is what the edge sees from cloudflared.
///
/// cloudflared: `client/config.go` → `ClientInfo.arch`.
#[must_use]
pub fn arch() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "x86" => "386",
        other => other,
    };
    format!("{os}_{arch}")
}

/// Registers one connection index with the edge.
///
/// # Concurrency — read this before building anything on top
///
/// `capnp-rpc` is **not `Send`**; it uses `Rc` internally. This function drives the
/// `RpcSystem` inline, concurrently with the single call, rather than spawning it.
///
/// **The returned future is therefore not `Send`, and neither is any future that awaits it.**
/// `tokio::spawn` rejects them outright. That is not a limitation of the long-lived control
/// stream — it applies to registration itself, so dropping the control stream afterwards
/// buys nothing. The Phase 1 pool example hit this immediately and had to put all four
/// connection supervisors on one `LocalSet`.
///
/// `crates/core` should not inherit that shape, because it forces every per-connection task
/// onto a single thread for the sake of one RPC at the start of each connection's life.
/// Confine the non-`Send` region instead: run the `RpcSystem` on a dedicated current-thread
/// runtime (or a `LocalSet` on its own thread) and hand back the [`ConnectionDetails`], which
/// is `Send`. Callers then spawn per-connection tasks normally.
///
/// The same applies with more force to §12's graceful shutdown, which needs the control
/// stream open for the connection's whole life so `unregisterConnection` can be called — a
/// long-lived `RpcSystem` cannot live on a multi-threaded runtime at all.
pub async fn register_connection(
    connection: &quinn::Connection,
    token: &TunnelToken,
    conn_index: u8,
    client_id: Uuid,
    version: &str,
) -> Result<ConnectionDetails, RpcError> {
    // The control stream is the first stream on the connection and takes NO preamble.
    let (send, recv) = connection
        .open_bi()
        .await
        .map_err(|e| RpcError::OpenStream(Box::new(e)))?;

    let network = Box::new(twoparty::VatNetwork::new(
        recv.compat(),
        send.compat_write(),
        Side::Client,
        Default::default(),
    ));
    let mut rpc_system = RpcSystem::new(network, None);
    let client: registration_server::Client = rpc_system.bootstrap(Side::Server);

    let call = async move {
        let mut request = client.register_connection_request();
        {
            let mut params = request.get();

            let mut auth = params.reborrow().init_auth();
            auth.set_account_tag(token.account_tag());
            auth.set_tunnel_secret(token.tunnel_secret());

            // The 16 raw UUID bytes, not the dashed string (§8).
            params
                .reborrow()
                .set_tunnel_id(token.tunnel_id().as_bytes());
            params.reborrow().set_conn_index(conn_index);

            let mut options = params.reborrow().init_options();
            {
                let mut info = options.reborrow().init_client();
                // The connector ID — a per-process random v4 UUID, not the tunnel ID.
                info.set_client_id(client_id.as_bytes());
                info.set_version(version);
                info.set_arch(arch().as_str());

                let mut features = info.init_features(
                    u32::try_from(DEFAULT_FEATURES.len()).expect("five features fit in u32"),
                );
                for (index, feature) in DEFAULT_FEATURES.iter().enumerate() {
                    features.set(
                        u32::try_from(index).expect("five features fit in u32"),
                        *feature,
                    );
                }
            }
            options.set_replace_existing(false);
            options.set_compression_quality(0);
            options.set_num_previous_attempts(0);
        }

        let response = request.send().promise.await?;
        read_connection_response(response.get()?.get_result()?)
    };

    // `select!` drives the RpcSystem while the call is outstanding. If the system finishes
    // first, the peer closed the stream and the call can never complete.
    tokio::time::timeout(RPC_TIMEOUT, async move {
        tokio::select! {
            driver = &mut rpc_system => Err(RpcError::Capnp(
                driver.err().unwrap_or_else(|| capnp::Error::disconnected(
                    "edge closed the control stream before answering".to_owned(),
                )),
            )),
            answer = call => answer,
        }
    })
    .await
    .map_err(|_| RpcError::Timeout)?
}

/// Turns a `ConnectionResponse` into a result.
///
/// Extracted so the one-shot [`register_connection`] and the long-lived [`Session`] cannot disagree
/// about what the edge said. Two things in here have bitten before and must not drift:
///
/// - **Two hops with the same name.** The RPC results struct has a `result` *pointer* field holding a
///   `ConnectionResponse`, which in turn has a `result` *union*. Reading the wrong one compiles.
/// - **`retryAfter` is nanoseconds**, a Go `time.Duration`. Treating it as milliseconds gives a
///   1000x wrong backoff — the kind of bug that only shows up during an incident.
fn read_connection_response(
    response: connection_response::Reader<'_>,
) -> Result<ConnectionDetails, RpcError> {
    match response.get_result().which()? {
        connection_response::result::Which::Error(error) => {
            let error = error?;
            Err(RpcError::Refused {
                cause: error.get_cause()?.to_str()?.to_owned(),
                retry_after: u64::try_from(error.get_retry_after())
                    .ok()
                    .map(Duration::from_nanos),
                should_retry: error.get_should_retry(),
            })
        }
        connection_response::result::Which::ConnectionDetails(details) => {
            let details = details?;
            Ok(ConnectionDetails {
                uuid: details.get_uuid()?.to_vec(),
                location_name: details.get_location_name()?.to_str()?.to_owned(),
                tunnel_is_remotely_managed: details.get_tunnel_is_remotely_managed(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a `ConnectionResponse` in memory so the reader can be tested without an edge.
    ///
    /// Worth the scaffolding: this is the only part of registration that can be checked hermetically,
    /// and it is where the two traps live. Everything else needs a live run (`-- --ignored`).
    fn response_message() -> capnp::message::Builder<capnp::message::HeapAllocator> {
        capnp::message::Builder::new_default()
    }

    #[test]
    fn reads_connection_details_out_of_the_inner_union() {
        // The two-hop shape: results.result is a pointer to a ConnectionResponse, whose own `result`
        // is the union. Reading the outer one instead compiles and returns nonsense.
        let mut message = response_message();
        {
            let mut response = message.init_root::<connection_response::Builder<'_>>();
            let mut details = response.reborrow().get_result().init_connection_details();
            details.set_uuid(&[1, 2, 3, 4]);
            details.set_location_name("hkg09");
            details.set_tunnel_is_remotely_managed(true);
        }

        let reader = message
            .get_root_as_reader::<connection_response::Reader<'_>>()
            .expect("root");
        let details = read_connection_response(reader).expect("should be details");

        assert_eq!(details.uuid, vec![1, 2, 3, 4]);
        assert_eq!(details.location_name, "hkg09");
        assert!(details.tunnel_is_remotely_managed);
    }

    #[test]
    fn reads_retry_after_as_nanoseconds_not_milliseconds() {
        // A Go `time.Duration`. Reading it as milliseconds gives a 1000x wrong backoff — a bug that
        // only shows up during an incident, which is the worst time to find it.
        let mut message = response_message();
        {
            let mut response = message.init_root::<connection_response::Builder<'_>>();
            let mut error = response.reborrow().get_result().init_error();
            error.set_cause("EDUPCONN");
            // Two seconds, expressed the way Go does.
            error.set_retry_after(2_000_000_000);
            error.set_should_retry(true);
        }

        let reader = message
            .get_root_as_reader::<connection_response::Reader<'_>>()
            .expect("root");
        let error = read_connection_response(reader).expect_err("should be a refusal");

        match error {
            RpcError::Refused {
                cause,
                retry_after,
                should_retry,
            } => {
                assert_eq!(cause, "EDUPCONN");
                assert_eq!(retry_after, Some(Duration::from_secs(2)));
                assert!(should_retry);
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn a_negative_retry_after_is_dropped_rather_than_wrapping() {
        // `retryAfter` is signed on the wire. A negative value cast blindly to u64 becomes roughly
        // 584 years, which would look like a permanent failure to every caller.
        let mut message = response_message();
        {
            let mut response = message.init_root::<connection_response::Builder<'_>>();
            let mut error = response.reborrow().get_result().init_error();
            error.set_cause("nonsense");
            error.set_retry_after(-1);
            error.set_should_retry(false);
        }

        let reader = message
            .get_root_as_reader::<connection_response::Reader<'_>>()
            .expect("root");
        match read_connection_response(reader).expect_err("should be a refusal") {
            RpcError::Refused { retry_after, .. } => assert_eq!(retry_after, None),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn arch_uses_gos_vocabulary() {
        let arch = arch();
        assert!(!arch.contains("macos"), "{arch}");
        assert!(!arch.contains("x86_64"), "{arch}");
        assert!(!arch.contains("aarch64"), "{arch}");
        assert!(arch.contains('_'), "{arch} should be <os>_<arch>");
    }

    #[test]
    fn feature_list_matches_upstreams_defaults() {
        // Exactly the five in features.go → defaultFeatures. Adding one speculatively is
        // how a client starts diverging from what the edge expects.
        assert_eq!(DEFAULT_FEATURES.len(), 5);
        assert!(DEFAULT_FEATURES.contains(&"support_datagram_v2"));
        assert!(DEFAULT_FEATURES.contains(&"support_quic_eof"));
        assert!(!DEFAULT_FEATURES.contains(&"postquantum"));
        // Retired upstream; sending them means the edge silently strips them.
        assert!(!DEFAULT_FEATURES.contains(&"support_datagram_v3"));
        assert!(!DEFAULT_FEATURES.contains(&"support_datagram_v3_1"));
    }

    #[test]
    fn registration_server_interface_id_is_the_one_on_the_wire() {
        // The correction recorded in docs/PROTOCOL.md §8. `TunnelServer`'s @0 is the
        // deprecated registerTunnel, so emitting its ID would call a different method.
        // capnpc bakes the ID into the generated client, so this asserts the schema we
        // vendored still declares it — a re-pin that changed it would fail here.
        let declared = include_str!("../schema/tunnelrpc.capnp");
        assert!(
            declared.contains("interface RegistrationServer @0xf71695ec7fe85497"),
            "vendored schema no longer declares the expected RegistrationServer ID"
        );
        assert!(
            declared.contains("interface TunnelServer @0xea58385c65416035"),
            "vendored schema no longer declares the expected TunnelServer ID"
        );
    }
}
