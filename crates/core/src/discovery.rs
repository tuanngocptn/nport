//! Choosing which node to provision against.
//!
//! `docs/ARCHITECTURE.md` §1 and ADR-0031. A **node** is one deployment of `apps/node` bound to one
//! Cloudflare account and one domain; the **registry** is a directory that lists nodes. This module
//! is the step that goes in front of [`crate::api::Api`]: fetch the list, probe a few, pick one.
//!
//! ## The three properties that shape everything here
//!
//! **The list is advisory.** A registry that is down must not stop a tunnel being created — that is
//! what lets a single directory not be a single point of failure. So the list is cached at
//! `~/.nport/nodes.json`, a fetch failure falls back to the cache, and `--backend` skips all of this
//! entirely (which is how `pnpm dev:cli` and every self-hoster already work).
//!
//! **Selection is the client's, never the registry's.** The registry returns everything it knows,
//! including nodes that are down or full, and ranking happens here. [`rank`] is pure for that reason:
//! the policy is testable without a network, and the I/O around it holds no decisions.
//!
//! **Absent capacity means unknown, and unknown is usable.** A node running an older build publishes
//! neither capacity field (ADR-0046). Sorting it as though it were empty would put it first for
//! everyone; refusing it would delist it for being old rather than for being full. It goes in the
//! middle, and [`Headroom`] is the type that makes that a decision rather than an accident.
//!
//! ## The rule that is not negotiable
//!
//! **Never fail over after `POST /v1/tunnels` has been sent.** It is the one endpoint in the API that
//! is not idempotent, so retrying it against a different node can leave a provisioned tunnel nobody
//! holds the tokens for, still spending a slot against the caller's cap. [`may_try_another_node`]
//! decides, and it is deliberately narrow: a node saying *it* cannot serve is a reason to move on, and
//! a node saying *you* may not is not.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use nport_contract::{ErrorCode, Node, NodeStatus};

use crate::api::{Api, ApiError};

/// How many nodes get probed before one is chosen.
///
/// A bound rather than a target: the list can be long, every probe is a round trip, and a user is
/// waiting. Four is enough that one slow node does not decide the outcome, and few enough that
/// discovery costs about as much as the provisioning call that follows it.
pub const PROBE_LIMIT: usize = 4;

/// The public node directory.
///
/// **The same hostname as node #1**, which is not a mistake (ADR-0049). One hostname fronts a whole
/// deployment: a gateway Worker dispatches `/v1/nodes*` to the registry and everything else to the
/// node. It was `registry.nport.link`, which has never resolved, so nothing depends on the old value.
pub const DEFAULT_REGISTRY: &str = "https://api.nport.link";

/// How long a single probe gets before it is treated as a miss.
///
/// Short on purpose. A node that cannot answer its own `/v1/meta` in two seconds is not a node worth
/// waiting on when there are others in the list, and the whole discovery step happens before the user
/// sees a URL.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// What went wrong finding a node.
#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    /// The registry could not be reached and there was no usable cache.
    #[error("could not reach the registry, and no cached node list is available")]
    Unreachable(#[source] Box<dyn std::error::Error + Send + Sync>),
    /// A list was obtained, but nothing in it answered or had room.
    #[error("no node is available")]
    NoNodeAvailable,
    /// `--node` named something the directory does not list.
    #[error("no node named `{0}` is listed")]
    UnknownNode(String),
    /// The pinned node is listed but did not answer.
    #[error("node `{0}` did not answer")]
    NodeUnreachable(String),
}

impl DiscoveryError {
    /// The registry code a user sees for this.
    #[must_use]
    pub fn code(&self) -> ErrorCode {
        match self {
            // A registry we cannot reach with no cache is indistinguishable, from the user's side,
            // from there being nothing to use — and the action is the same: wait, or `--backend`.
            Self::Unreachable(_) | Self::NoNodeAvailable => ErrorCode::NoNodeAvailable,
            Self::UnknownNode(_) | Self::NodeUnreachable(_) => ErrorCode::NodeUnreachable,
        }
    }
}

/// How much room a node has, as far as anyone can tell.
///
/// Three states rather than a number, because "unknown" is a real answer and the one most easily got
/// wrong: a node that does not publish capacity is not an empty node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Headroom {
    /// Reported full, or as good as: no slots left.
    Full,
    /// Not reported. Usable, and ranked behind a node that says it has room.
    Unknown,
    /// Slots remaining, as last observed.
    Free(u64),
}

impl Headroom {
    /// Reads the two optional capacity fields the way ADR-0046 intends them.
    #[must_use]
    pub fn of(node: &Node) -> Self {
        match (node.active_tunnels, node.max_active_tunnels) {
            (Some(active), Some(max)) if max > active => Self::Free(max - active),
            (Some(_), Some(_)) => Self::Full,
            // One without the other says nothing useful: a count with no ceiling cannot be compared
            // against anything, and a ceiling with no count is a promise rather than an observation.
            _ => Self::Unknown,
        }
    }

    /// Whether a tunnel could plausibly be created here.
    #[must_use]
    pub const fn usable(self) -> bool {
        !matches!(self, Self::Full)
    }
}

/// A node, with what a probe just learned about it.
#[derive(Debug, Clone)]
pub struct Probed {
    /// The directory entry, as the registry last observed it.
    pub node: Node,
    /// Round-trip time to the node's own `/v1/meta`, or `None` if it did not answer.
    pub latency: Option<Duration>,
    /// Headroom from the probe when it answered, otherwise from the directory entry.
    pub headroom: Headroom,
}

/// Whether the directory thinks a node is worth offering at all.
///
/// `down` nodes stay in the list on purpose — a UI shows them greyed out rather than hiding them
/// (`docs/FEATURES.md` §3) — so filtering them is the client's job, here.
#[must_use]
pub fn offerable(node: &Node) -> bool {
    match node.status {
        NodeStatus::Up | NodeStatus::Degraded => Headroom::of(node).usable(),
        NodeStatus::Down => false,
    }
}

/// Orders probed nodes best-first.
///
/// Pure, and the whole selection policy. The order is: **answered before silent**, then **has room
/// before room unknown**, then **fastest first**. Ties break on the node id so the result is
/// deterministic — an unstable order would make two clients on the same list disagree for no reason,
/// and would make this untestable.
///
/// Latency is measured *here*, by the client, and never taken from the registry: the registry's
/// distance to a node says nothing about the user's, and a number measured in one datacentre and
/// shown to someone on another continent is worse than none (ADR-0046).
#[must_use]
pub fn rank(mut probed: Vec<Probed>) -> Vec<Probed> {
    probed.sort_by(|a, b| {
        // `Headroom`'s derived ordering is Full < Unknown < Free, so reversing puts a node with room
        // first and a full one last. Written out rather than relying on the derive silently: if a
        // variant is ever inserted, this comparison is where the meaning changes.
        b.answered()
            .cmp(&a.answered())
            .then_with(|| b.headroom.cmp(&a.headroom))
            .then_with(|| {
                a.latency
                    .unwrap_or(Duration::MAX)
                    .cmp(&b.latency.unwrap_or(Duration::MAX))
            })
            .then_with(|| a.node.id.cmp(&b.node.id))
    });
    probed
}

impl Probed {
    /// Whether the probe got an answer.
    #[must_use]
    pub const fn answered(&self) -> bool {
        self.latency.is_some()
    }
}

/// Whether a failed create may be retried against a different node.
///
/// **The narrow half of the non-idempotency rule.** `POST /v1/tunnels` is not idempotent, so this
/// returns `true` only when the node *answered* and its answer proves nothing was created.
///
/// - A network failure is always `false`. `ApiError::Unreachable` covers both "never connected" and
///   "died mid-request", and the second one may have created a tunnel. Guessing wrong there leaves a
///   provisioned tunnel nobody holds the tokens for.
/// - A refusal about **the node** is `true`: it is full, or its upstream broke. Another node may not
///   be.
/// - A refusal about **the caller** is `false`, and this is the part worth stating plainly. Failing
///   over on `CONCURRENCY_LIMIT` or `CREATE_QUOTA_EXCEEDED` would let a client shop for a node that
///   has not yet counted it — per-source caps are enforced per node, so N nodes would mean N times
///   the cap. That is `docs/ARCHITECTURE.md` §7's controls defeated by the client politely trying
///   again somewhere else.
/// - A refusal about **the name** is `false` too. `SUBDOMAIN_IN_USE` on one node's domain says
///   nothing about another's, but silently moving would hand back `myapp.nport.dev` to someone who
///   asked for `myapp` and had `nport.link` in mind. Better to say the name is taken.
#[must_use]
pub fn may_try_another_node(error: &ApiError) -> bool {
    match error {
        ApiError::Refused { code, .. } => matches!(
            code,
            ErrorCode::CapacityExhausted
                | ErrorCode::ProvisionFailed
                | ErrorCode::UpstreamCloudflareError
                | ErrorCode::Internal
        ),
        _ => false,
    }
}

/// Where the cached node list lives, given a home directory.
///
/// Beside `config.toml` in `~/.nport`. **This crate never resolves the home directory itself** — the
/// caller passes one, and `crates/cli` is what reads `NPORT_HOME`/`HOME`. A library reaching into the
/// environment is how a test ends up writing to a developer's real cache, which is exactly what the
/// first draft of `tunnel.rs`'s failover tests did.
#[must_use]
pub fn cache_path(home: &Path) -> PathBuf {
    home.join(".nport").join("nodes.json")
}

/// Reads the cached list, or `None` if there is not a usable one.
///
/// Every failure is `None` rather than an error: a corrupt or unreadable cache means "discover
/// afresh", never "refuse to work". That is the opposite of how a corrupt *config* is treated
/// (`crates/CLAUDE.md` CLI rule 8), and the difference is intent — a config is something the user
/// wrote and a typo in it must not be guessed at, while this file is one we wrote and can rewrite.
#[must_use]
pub fn load_cache(path: &Path) -> Option<Vec<Node>> {
    let text = std::fs::read_to_string(path).ok()?;
    let cached: CachedList = serde_json::from_str(&text).ok()?;
    if cached.nodes.is_empty() {
        return None;
    }
    Some(cached.nodes)
}

/// Writes the list, best-effort.
///
/// Failure is ignored on purpose and returns nothing to check: a read-only home directory, a full
/// disk, or a sandbox is not a reason to refuse a tunnel. The cost is a discovery round trip next
/// time, which is what would have happened anyway.
pub fn store_cache(path: &Path, nodes: &[Node]) {
    let Some(parent) = path.parent() else { return };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let list = CachedList {
        nodes: nodes.to_vec(),
    };
    if let Ok(text) = serde_json::to_string_pretty(&list) {
        let _ = std::fs::write(path, text);
    }
}

/// The on-disk shape. Its own struct so a future field does not break an old cache.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct CachedList {
    nodes: Vec<Node>,
}

/// Fetches the directory, falling back to the cache when the registry cannot be reached.
///
/// # Errors
///
/// [`DiscoveryError::Unreachable`] only when both the registry and the cache fail.
pub async fn list(registry: &Api, cache: Option<&Path>) -> Result<Vec<Node>, DiscoveryError> {
    match registry.nodes().await {
        Ok(response) => {
            if let Some(path) = cache {
                store_cache(path, &response.nodes);
            }
            Ok(response.nodes)
        }
        Err(error) => cache
            .and_then(load_cache)
            .ok_or_else(|| DiscoveryError::Unreachable(Box::new(error))),
    }
}

/// Probes up to [`PROBE_LIMIT`] offerable nodes and returns them best-first.
///
/// Concurrent, because the whole point of a bound is that four round trips cost one round trip's
/// wall-clock. A node that does not answer inside [`PROBE_TIMEOUT`] is kept in the result with
/// `latency: None` rather than dropped, so [`rank`] can put it last and a caller with nothing better
/// can still try it — which is the difference between "slow" and "gone".
pub async fn probe(nodes: Vec<Node>) -> Vec<Probed> {
    let candidates: Vec<Node> = nodes
        .into_iter()
        .filter(offerable)
        .take(PROBE_LIMIT)
        .collect();

    // `JoinSet` rather than `futures::future::join_all`, to avoid pulling `futures` into this crate
    // for one combinator — tokio's runtime is already here. Results arrive out of order, which costs
    // nothing because `rank` sorts them anyway.
    let mut set = tokio::task::JoinSet::new();
    for node in candidates {
        set.spawn(async move {
            let started = Instant::now();
            let observed = match Api::new(&node.url) {
                Ok(api) => tokio::time::timeout(PROBE_TIMEOUT, api.meta())
                    .await
                    .ok()
                    .and_then(Result::ok),
                // A node whose URL does not parse is a directory entry nobody can use. Kept as a
                // non-answer rather than dropped, so the reason a list came back empty stays visible.
                Err(_) => None,
            };
            let latency = observed.as_ref().map(|_| started.elapsed());
            let headroom = observed.map_or_else(
                || Headroom::of(&node),
                |meta| match (meta.active_tunnels, meta.max_active_tunnels) {
                    (Some(active), Some(max)) if max > active => Headroom::Free(max - active),
                    (Some(_), Some(_)) => Headroom::Full,
                    _ => Headroom::Unknown,
                },
            );
            Probed {
                node,
                latency,
                headroom,
            }
        });
    }

    let mut probed = Vec::new();
    while let Some(joined) = set.join_next().await {
        // A panicking probe task is dropped rather than propagated: one node's entry must not take
        // down a discovery that has three others to consider.
        if let Ok(result) = joined {
            probed.push(result);
        }
    }

    rank(probed)
}

/// The full sequence: list, probe, rank — and honour `--node` if one was pinned.
///
/// # Errors
///
/// See [`DiscoveryError`]. A pinned node that is missing or silent is a hard failure, because the user
/// asked for that one specifically and quietly using another would be the wrong kind of helpful.
pub async fn select(
    registry: &Api,
    cache: Option<&Path>,
    pinned: Option<&str>,
) -> Result<Vec<Probed>, DiscoveryError> {
    let nodes = list(registry, cache).await?;

    if let Some(id) = pinned {
        let node = nodes
            .into_iter()
            .find(|node| node.id == id)
            .ok_or_else(|| DiscoveryError::UnknownNode(id.to_owned()))?;
        let probed = probe(vec![node]).await;
        // `probe` filters unofferable nodes, so an empty result means the pin named a node the
        // directory has marked down or full — worth saying, rather than falling back to another.
        return match probed.into_iter().next() {
            Some(probed) if probed.answered() => Ok(vec![probed]),
            _ => Err(DiscoveryError::NodeUnreachable(id.to_owned())),
        };
    }

    let probed = probe(nodes).await;
    if probed.iter().any(Probed::answered) {
        Ok(probed)
    } else {
        Err(DiscoveryError::NoNodeAvailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, status: NodeStatus, active: Option<u64>, max: Option<u64>) -> Node {
        Node {
            id: id.to_owned(),
            url: format!("https://api.{id}.test"),
            domain: format!("{id}.test"),
            region: None,
            version: "3.0.0".to_owned(),
            status,
            active_tunnels: active,
            max_active_tunnels: max,
            last_seen_at: 1,
        }
    }

    fn probed(id: &str, latency: Option<u64>, headroom: Headroom) -> Probed {
        Probed {
            node: node(id, NodeStatus::Up, None, None),
            latency: latency.map(Duration::from_millis),
            headroom,
        }
    }

    #[test]
    fn absent_capacity_is_unknown_rather_than_empty() {
        // The distinction ADR-0046 made the fields optional for. A node on an older build publishes
        // neither, and reading that as "no tunnels, all yours" would put it first for every client.
        assert_eq!(
            Headroom::of(&node("a", NodeStatus::Up, None, None)),
            Headroom::Unknown
        );
        assert_eq!(
            Headroom::of(&node("a", NodeStatus::Up, Some(5), None)),
            Headroom::Unknown
        );
        assert_eq!(
            Headroom::of(&node("a", NodeStatus::Up, None, Some(100))),
            Headroom::Unknown
        );
        assert_eq!(
            Headroom::of(&node("a", NodeStatus::Up, Some(10), Some(100))),
            Headroom::Free(90)
        );
        assert_eq!(
            Headroom::of(&node("a", NodeStatus::Up, Some(100), Some(100))),
            Headroom::Full
        );
    }

    #[test]
    fn a_full_node_is_not_offerable_but_an_unknown_one_is() {
        assert!(offerable(&node("a", NodeStatus::Up, Some(1), Some(100))));
        assert!(offerable(&node("a", NodeStatus::Up, None, None)));
        // Degraded is still worth trying: the registry's last probe failed, not necessarily ours.
        assert!(offerable(&node("a", NodeStatus::Degraded, None, None)));
        assert!(!offerable(&node("a", NodeStatus::Up, Some(100), Some(100))));
        assert!(!offerable(&node("a", NodeStatus::Down, Some(0), Some(100))));
    }

    #[test]
    fn ranking_puts_an_answering_node_ahead_of_a_silent_one() {
        // Even a slow answer beats no answer: a node that did not reply may be gone, and the one that
        // replied in 900 ms demonstrably is not.
        let order = rank(vec![
            probed("silent", None, Headroom::Free(50)),
            probed("slow", Some(900), Headroom::Free(1)),
        ]);
        assert_eq!(order[0].node.id, "slow");
    }

    #[test]
    fn ranking_prefers_room_over_speed() {
        // A fast node with no room cannot serve at all, so latency is the wrong tie-break to reach
        // for first. Full nodes are filtered before this, but `Unknown` is not.
        let order = rank(vec![
            probed("fast-unknown", Some(10), Headroom::Unknown),
            probed("slower-free", Some(200), Headroom::Free(10)),
        ]);
        assert_eq!(order[0].node.id, "slower-free");
    }

    #[test]
    fn ranking_prefers_speed_once_room_is_equal() {
        let order = rank(vec![
            probed("far", Some(300), Headroom::Free(10)),
            probed("near", Some(20), Headroom::Free(10)),
        ]);
        assert_eq!(order[0].node.id, "near");
    }

    #[test]
    fn ranking_is_deterministic_on_a_tie() {
        // Two clients reading one list must agree, and an unstable sort would make this untestable.
        let first = rank(vec![
            probed("b", Some(50), Headroom::Free(10)),
            probed("a", Some(50), Headroom::Free(10)),
        ]);
        let second = rank(vec![
            probed("a", Some(50), Headroom::Free(10)),
            probed("b", Some(50), Headroom::Free(10)),
        ]);
        assert_eq!(first[0].node.id, "a");
        assert_eq!(second[0].node.id, "a");
    }

    /// The non-idempotency rule, which is the one thing here that can lose a user's tunnel.
    #[test]
    fn failover_is_allowed_only_when_the_node_answered_that_it_could_not_serve() {
        let refused = |code| ApiError::Refused {
            status: 503,
            code,
            message: String::new(),
            retry_after: None,
        };

        // The node's problem: another node may not have it.
        assert!(may_try_another_node(&refused(ErrorCode::CapacityExhausted)));
        assert!(may_try_another_node(&refused(
            ErrorCode::UpstreamCloudflareError
        )));
        assert!(may_try_another_node(&refused(ErrorCode::ProvisionFailed)));
        assert!(may_try_another_node(&refused(ErrorCode::Internal)));

        // **The caller's problem, and failing over would defeat the cap.** Per-source limits are
        // enforced per node, so shopping for a node that has not counted this caller yet would
        // multiply the cap by the size of the directory.
        assert!(!may_try_another_node(&refused(ErrorCode::ConcurrencyLimit)));
        assert!(!may_try_another_node(&refused(
            ErrorCode::CreateQuotaExceeded
        )));
        assert!(!may_try_another_node(&refused(ErrorCode::RateLimited)));

        // The name's problem: moving would silently change the domain the user gets.
        assert!(!may_try_another_node(&refused(ErrorCode::SubdomainInUse)));
        assert!(!may_try_another_node(&refused(
            ErrorCode::SubdomainReserved
        )));
        assert!(!may_try_another_node(&refused(ErrorCode::InvalidSubdomain)));

        // **A network failure is never a reason to try elsewhere**, because "died mid-request" is
        // indistinguishable from "never sent" and the first one may have created a tunnel.
        assert!(!may_try_another_node(&ApiError::Unreachable(Box::new(
            std::io::Error::other("reset")
        ))));
    }

    #[test]
    fn a_missing_or_corrupt_cache_is_no_cache_rather_than_an_error() {
        let dir = std::env::temp_dir().join("nport-discovery-cache");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");

        let missing = dir.join("nothing.json");
        assert!(load_cache(&missing).is_none());

        let corrupt = dir.join("corrupt.json");
        std::fs::write(&corrupt, "{ this is not json").expect("write");
        assert!(load_cache(&corrupt).is_none());

        // An empty list is not a usable cache either: it would look like a successful discovery that
        // found nothing, and send the user to `NO_NODE_AVAILABLE` instead of to the registry.
        let empty = dir.join("empty.json");
        std::fs::write(&empty, r#"{"nodes":[]}"#).expect("write");
        assert!(load_cache(&empty).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stored_list_round_trips() {
        let dir = std::env::temp_dir().join("nport-discovery-roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        let path = cache_path(&dir);

        // Creates `~/.nport` on the way: a first run has no directory yet.
        store_cache(&path, &[node("hk1", NodeStatus::Up, Some(3), Some(100))]);
        let loaded = load_cache(&path).expect("a list was written");

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "hk1");
        // The optional fields survive as `Some`, not as zero — the cache must not lose the
        // distinction the contract went to trouble to keep.
        assert_eq!(loaded[0].active_tunnels, Some(3));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn storing_into_an_unwritable_place_is_silent() {
        // A read-only home or a sandbox is not a reason to refuse a tunnel; the cost is one discovery
        // round trip next time, which is what would have happened anyway.
        store_cache(Path::new("/nonexistent-root-abc/.nport/nodes.json"), &[]);
    }

    #[test]
    fn the_cache_lives_beside_the_config() {
        // Same directory as `config.toml`, and `NPORT_HOME` moves both — which is the seam that keeps
        // a test off a developer's real cache.
        assert!(cache_path(Path::new("/home/x")).ends_with(".nport/nodes.json"));
    }
}
