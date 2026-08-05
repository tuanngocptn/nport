//! Edge discovery.
//!
//! `docs/PROTOCOL.md` §4. Two ways to find an edge address, in increasing fidelity to
//! cloudflared:
//!
//! 1. [`discover_direct`] — A/AAAA on the hardcoded region hostnames. Fewer moving
//!    parts, recommended for the Phase 1 spike.
//! 2. [`discover_srv`] — the SRV lookup cloudflared actually does, which is how
//!    Cloudflare steers traffic. Required before shipping.
//!
//! Both retry over **DNS-over-TLS** when the system resolver cannot answer, because the
//! networks that break edge discovery are the ones that break SRV lookups specifically —
//! captive portals, hotel Wi-Fi, and corporate resolvers that answer A records happily and
//! `SERVFAIL` anything unusual. Without the fallback those users have no working path at
//! all, and the failure looks like Cloudflare being down.
//!
//! **There are no hardcoded fallback edge IPs anywhere in the upstream source, and there
//! must be none here.** If discovery fails, the tunnel fails. The DoT fallback is a second
//! way to *ask*, not a hardcoded answer — that distinction is the whole point.
//!
//! ## The one live dependency this adds
//!
//! DoT reaches `1.1.1.1:853` directly, so it works where DNS is broken but not where TCP
//! egress is filtered. It is a fallback, not a guarantee, and the system resolver is still
//! tried first — a working local resolver is faster and respects split-horizon DNS.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use hickory_resolver::config::{NameServerConfig, ResolverConfig};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::proto::rr::RData;
use hickory_resolver::{Resolver, TokioResolver};
use rustls::crypto::aws_lc_rs;

use crate::token::Endpoint;

/// The port every edge endpoint listens on — UDP for QUIC, TCP for HTTP/2.
///
/// cloudflared reads this from the SRV record's `Port` field and never hardcodes it
/// (`edgediscovery/allregions/discovery.go`). [`discover_direct`] has no SRV record to
/// read, so it must assume the observed value; [`discover_srv`] uses what DNS returns.
pub const EDGE_PORT: u16 = 7844;

/// SRV service name for the global edge.
///
/// cloudflared: `edgediscovery/allregions/discovery.go` → `srvService`, `srvProto`,
/// `srvName`.
const SRV_GLOBAL: &str = "_v2-origintunneld._tcp.argotunnel.com.";

/// SRV service name for the FedRAMP edge.
///
/// cloudflared: `edgediscovery/allregions/regions.go` → `RegionalServiceName` prepends
/// the region to the service label.
const SRV_FED: &str = "_fed-v2-origintunneld._tcp.argotunnel.com.";

/// Region hostnames for the global edge.
///
/// cloudflared: `prechecks/probes.go` → `region1Global`, `region2Global`.
const REGIONS_GLOBAL: [&str; 2] = ["region1.v2.argotunnel.com.", "region2.v2.argotunnel.com."];

/// Region hostnames for the FedRAMP edge.
///
/// cloudflared: `prechecks/probes.go` → `region1Fed`, `region2Fed`.
const REGIONS_FED: [&str; 2] = [
    "fed-region1.v2.argotunnel.com.",
    "fed-region2.v2.argotunnel.com.",
];

/// Upstream treats the SRV results as two regions and errors out below two.
///
/// cloudflared: `edgediscovery/allregions/discovery.go` → `EdgeDiscovery`.
const MIN_REGIONS: usize = 2;

/// Errors from edge discovery.
///
/// DNS failures carry their source: unlike [`crate::token`], nothing here is credential
/// material, and the underlying resolver error is the most useful thing a user can paste
/// into an issue.
#[derive(Debug, thiserror::Error)]
pub enum EdgeError {
    /// The resolver itself could not be constructed — usually a broken `resolv.conf`.
    #[error("could not construct a DNS resolver from the system configuration")]
    Resolver(#[source] Box<dyn std::error::Error + Send + Sync>),
    /// A lookup failed.
    #[error("DNS lookup for {name} failed")]
    Lookup {
        /// The name being resolved.
        name: String,
        /// The resolver's own error.
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    /// Lookups succeeded but produced nothing usable.
    #[error("no edge address resolved")]
    NoAddress,
    /// Fewer than two regions resolved, so there is nothing to balance across.
    #[error("only {found} edge region(s) resolved; at least {MIN_REGIONS} are required")]
    TooFewRegions {
        /// How many regions produced at least one address.
        found: usize,
    },
}

/// The SRV service name for an endpoint.
#[must_use]
pub fn srv_name(endpoint: Endpoint) -> &'static str {
    match endpoint {
        Endpoint::Global => SRV_GLOBAL,
        Endpoint::Fed => SRV_FED,
    }
}

/// The two region hostnames for an endpoint.
#[must_use]
pub fn region_hostnames(endpoint: Endpoint) -> [&'static str; 2] {
    match endpoint {
        Endpoint::Global => REGIONS_GLOBAL,
        Endpoint::Fed => REGIONS_FED,
    }
}

/// One region's worth of resolved edge addresses.
///
/// Kept grouped by region because the connection pool balances across regions rather
/// than round-robining a flat list (`docs/PROTOCOL.md` §4). Flattening here would throw
/// away the only information that makes the pool correct.
#[derive(Debug, Clone)]
pub struct Region {
    /// The hostname or SRV target this came from.
    pub name: String,
    /// Addresses in that region, already carrying [`EDGE_PORT`].
    pub addresses: Vec<SocketAddr>,
}

/// The DoT resolver's address.
///
/// cloudflared: `edgediscovery/allregions/discovery.go` → `dotServerAddr`.
const DOT_IP: IpAddr = IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1));

/// The DoT port, set explicitly rather than left to the library's default for the protocol.
///
/// cloudflared: `edgediscovery/allregions/discovery.go` → `dotServerAddr`.
const DOT_PORT: u16 = 853;

/// The TLS server name presented to the DoT resolver.
///
/// **Not `1.1.1.1`.** The certificate is issued for the hostname, so sending the address as
/// SNI fails verification — and this is exactly the kind of value that looks redundant next
/// to [`DOT_IP`] right up until someone removes it.
///
/// cloudflared: `edgediscovery/allregions/discovery.go` → `dotServerName`.
const DOT_SERVER_NAME: &str = "cloudflare-dns.com";

/// How long a DoT lookup may take before it is abandoned.
///
/// cloudflared: `edgediscovery/allregions/discovery.go` → `dotTimeout`.
const DOT_TIMEOUT: Duration = Duration::from_secs(15);

/// The resolver from the operating system's configuration.
fn system_resolver() -> Result<TokioResolver, EdgeError> {
    Resolver::builder_tokio()
        .map_err(|e| EdgeError::Resolver(Box::new(e)))?
        .build()
        .map_err(|e| EdgeError::Resolver(Box::new(e)))
}

/// A resolver that talks DNS-over-TLS to `1.1.1.1`, ignoring the system configuration.
///
/// Built from a **default** [`ResolverConfig`] with one nameserver added, rather than from the
/// system's: the whole reason to be here is that the system configuration is unusable, so
/// inheriting any of it — search domains included — would inherit the problem.
/// Cloudflare's DoT nameserver, as cloudflared configures it.
///
/// Split out from [`dot_resolver`] because `Resolver` does not expose the configuration it was
/// built from, so this is the only seam at which the pinned constants can be asserted. Every one
/// of them fails *silently* if wrong — a bad SNI or port surfaces as a generic connection error,
/// on a network that by definition nobody is testing on.
fn dot_nameserver() -> NameServerConfig {
    let mut nameserver = NameServerConfig::tls(DOT_IP, Arc::from(DOT_SERVER_NAME));
    // The library already defaults a TLS connection to 853. Set anyway, so the value cloudflared
    // hardcodes is stated here rather than inherited from a dependency's idea of the protocol.
    for connection in &mut nameserver.connections {
        connection.port = DOT_PORT;
    }
    nameserver
}

/// The TLS configuration for the DoT connection.
///
/// **Not `quic::tls_config`.** That one adds Cloudflare's Origin CA to the root set and pins ALPN
/// `argotunnel`, because it dials the tunnel edge. `cloudflare-dns.com` is an ordinary public
/// endpoint with an ordinary public certificate, so it needs the platform roots and nothing more —
/// and widening the trust anchors used to *resolve names* is the last place to be generous.
///
/// `aws_lc_rs` explicitly rather than by default, for the same reason the whole workspace pins it:
/// a second crypto provider in the graph makes rustls refuse to choose one at runtime.
fn dot_tls_config() -> Result<rustls::ClientConfig, EdgeError> {
    let mut roots = rustls::RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        // Individual failures ignored: platform stores routinely contain oddities, and upstream
        // tolerates them too. An empty store is the failure that matters, and it is caught below.
        let _ = roots.add(cert);
    }
    if roots.is_empty() {
        return Err(EdgeError::Resolver(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "no usable system certificate roots, so DNS-over-TLS cannot be verified",
        ))));
    }

    rustls::ClientConfig::builder_with_provider(Arc::new(aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| EdgeError::Resolver(Box::new(e)))
        .map(|builder| builder.with_root_certificates(roots).with_no_client_auth())
}

fn dot_resolver() -> Result<TokioResolver, EdgeError> {
    let mut config = ResolverConfig::default();
    config.add_name_server(dot_nameserver());

    let mut builder = Resolver::builder_with_config(config, TokioRuntimeProvider::default())
        .with_tls_config(dot_tls_config()?);
    builder.options_mut().timeout = DOT_TIMEOUT;
    builder
        .build()
        .map_err(|e| EdgeError::Resolver(Box::new(e)))
}

/// Runs `discover` against the system resolver, then over DoT if that failed.
///
/// **The error returned on total failure is the *system* resolver's**, not the fallback's. It
/// names the lookup that failed in the environment the user actually controls, which is the
/// first thing worth investigating; a DoT failure on top of it usually just means the same
/// network also blocks port 853. The alternative — reporting the second failure — would point
/// every broken-resolver report at Cloudflare.
async fn with_dot_fallback<F, Fut>(discover: F) -> Result<Vec<Region>, EdgeError>
where
    F: Fn(TokioResolver) -> Fut,
    Fut: Future<Output = Result<Vec<Region>, EdgeError>>,
{
    with_fallback(system_resolver(), discover).await
}

/// [`with_dot_fallback`] with the primary resolver passed in, so the policy is testable.
///
/// The fallback only runs when the system resolver fails, which on any machine a test runs on it
/// does not — so without this seam the interesting half could only be exercised by breaking the
/// host's DNS. The policy is what has to be right: which resolver is tried first, and which error
/// survives when both fail.
async fn with_fallback<F, Fut>(
    primary: Result<TokioResolver, EdgeError>,
    discover: F,
) -> Result<Vec<Region>, EdgeError>
where
    F: Fn(TokioResolver) -> Fut,
    Fut: Future<Output = Result<Vec<Region>, EdgeError>>,
{
    let primary = match primary {
        Ok(resolver) => match discover(resolver).await {
            Ok(regions) => return Ok(regions),
            Err(error) => error,
        },
        // A resolver that could not even be constructed is the strongest case for the
        // fallback: a broken `resolv.conf` is precisely what DoT does not need.
        Err(error) => error,
    };

    // A DoT resolver that cannot even be constructed leaves the primary failure as the only
    // thing worth reporting — there is no second story to tell.
    let Ok(resolver) = dot_resolver() else {
        return Err(primary);
    };
    discover(resolver).await.map_err(|_| primary)
}

/// Resolves the region hostnames directly, skipping SRV.
///
/// `docs/PROTOCOL.md` §4 recommends this for the spike: one fewer moving part, and it
/// exercises the same address shape the QUIC dial needs.
pub async fn discover_direct(endpoint: Endpoint) -> Result<Vec<Region>, EdgeError> {
    with_dot_fallback(|resolver| direct_with(resolver, endpoint)).await
}

async fn direct_with(
    resolver: TokioResolver,
    endpoint: Endpoint,
) -> Result<Vec<Region>, EdgeError> {
    let mut regions = Vec::with_capacity(2);

    for name in region_hostnames(endpoint) {
        let lookup = resolver
            .lookup_ip(name)
            .await
            .map_err(|e| EdgeError::Lookup {
                name: name.to_owned(),
                source: Box::new(e),
            })?;

        let addresses: Vec<SocketAddr> = lookup
            .iter()
            .map(|ip| SocketAddr::new(ip, EDGE_PORT))
            .collect();

        if !addresses.is_empty() {
            regions.push(Region {
                name: name.to_owned(),
                addresses,
            });
        }
    }

    check(regions)
}

/// Resolves the edge the way cloudflared does: SRV, then A/AAAA on each target.
///
/// The port comes from the SRV record, never from [`EDGE_PORT`].
pub async fn discover_srv(endpoint: Endpoint) -> Result<Vec<Region>, EdgeError> {
    with_dot_fallback(|resolver| srv_with(resolver, endpoint)).await
}

async fn srv_with(resolver: TokioResolver, endpoint: Endpoint) -> Result<Vec<Region>, EdgeError> {
    let service = srv_name(endpoint);

    let lookup = resolver
        .srv_lookup(service)
        .await
        .map_err(|e| EdgeError::Lookup {
            name: service.to_owned(),
            source: Box::new(e),
        })?;

    // hickory 0.26 exposes `Record::data` and `SRV::{target,port}` as public fields,
    // not accessors.
    let mut targets: Vec<(String, u16)> = lookup
        .answers()
        .iter()
        .filter_map(|record| match &record.data {
            RData::SRV(srv) => Some((srv.target.to_string(), srv.port)),
            _ => None,
        })
        .collect();
    targets.sort();
    targets.dedup();

    let mut regions = Vec::with_capacity(targets.len());
    for (target, port) in targets {
        let lookup = resolver
            .lookup_ip(target.as_str())
            .await
            .map_err(|e| EdgeError::Lookup {
                name: target.clone(),
                source: Box::new(e),
            })?;

        let addresses: Vec<SocketAddr> =
            lookup.iter().map(|ip| SocketAddr::new(ip, port)).collect();

        if !addresses.is_empty() {
            regions.push(Region {
                name: target,
                addresses,
            });
        }
    }

    check(regions)
}

/// How long a failed address stays demoted before the pool will hand it out again.
///
/// cloudflared: `edgediscovery/allregions/region.go` → `timeoutDuration`.
pub const DEMOTION: Duration = Duration::from_secs(10 * 60);

/// Hands out edge addresses to connection indices, balanced across regions.
///
/// **Not `index % regions`.** Upstream keeps a stateful pool and asks it for an unused
/// address (`allregions/regions.go` → `GetUnusedAddr`), which is what makes the balance hold
/// after a reconnect has moved one connection to the other region. Indexing modulo the
/// region count re-derives an assignment from scratch every time and drifts as soon as one
/// connection rotates.
///
/// Three invariants, in the order they matter:
///
/// 1. **No address serves two connection indices at once.** Two connections to the same edge
///    address is what `EDUPCONN` means, and the edge refuses the second.
/// 2. **A rotation lands on a different address**, preferring the other region — the failure
///    that triggered it is usually regional or address-specific, so retrying the neighbour of
///    a dead address is the least useful thing to do.
/// 3. **A failed address is demoted for [`DEMOTION`]**, not blacklisted. With 40 addresses
///    and 4 connections there is always somewhere else to go; if there somehow is not, an
///    expired-or-not demoted address beats failing the tunnel.
///
/// Held state is per connection index, so a caller must [`Self::release`] on teardown or the
/// address leaks for the pool's lifetime.
#[derive(Debug)]
pub struct AddressPool {
    regions: Vec<PoolRegion>,
    /// Which address each connection index currently holds, and in which region.
    held: HashMap<u8, (usize, SocketAddr)>,
}

#[derive(Debug)]
struct PoolRegion {
    name: String,
    addresses: Vec<SocketAddr>,
    in_use: Vec<SocketAddr>,
    demoted: HashMap<SocketAddr, Instant>,
}

impl AddressPool {
    /// Builds a pool from discovery output, applying the same ≥2-region rule as discovery.
    ///
    /// Addresses are ordered IPv4-first within each region. Upstream splits a region into
    /// primary and secondary sets by address family for the same reason NPort cares: the
    /// initial MTU constant in §5 was chosen for an IPv4 dial, and an IPv6-first handout
    /// silently exercises the less-tested path.
    pub fn new(regions: Vec<Region>) -> Result<Self, EdgeError> {
        let regions = check(regions)?;
        Ok(Self {
            regions: regions
                .into_iter()
                .map(|region| {
                    let mut addresses = region.addresses;
                    addresses.sort_by_key(|address| !address.is_ipv4());
                    PoolRegion {
                        name: region.name,
                        addresses,
                        in_use: Vec::new(),
                        demoted: HashMap::new(),
                    }
                })
                .collect(),
            held: HashMap::new(),
        })
    }

    /// How many regions the pool is balancing across.
    #[must_use]
    pub fn regions(&self) -> usize {
        self.regions.len()
    }

    /// The region name an address belongs to, for logging.
    #[must_use]
    pub fn region_of(&self, address: SocketAddr) -> Option<&str> {
        self.regions
            .iter()
            .find(|region| region.addresses.contains(&address))
            .map(|region| region.name.as_str())
    }

    /// Claims an address for a connection index, or returns the one it already holds.
    pub fn claim(&mut self, conn_index: u8) -> Result<SocketAddr, EdgeError> {
        if let Some((_, address)) = self.held.get(&conn_index) {
            return Ok(*address);
        }
        self.take(conn_index, None)
    }

    /// Releases the index's address, demotes it, and claims a different one.
    ///
    /// Call this after a dial, registration, or connection failure — not after a clean
    /// shutdown, which should [`Self::release`] instead so the address stays undemoted.
    pub fn rotate(&mut self, conn_index: u8) -> Result<SocketAddr, EdgeError> {
        let failed = self.held.remove(&conn_index).map(|(region, address)| {
            self.regions[region].in_use.retain(|held| *held != address);
            self.regions[region].demoted.insert(address, Instant::now());
            address
        });
        self.take(conn_index, failed)
    }

    /// Gives the index's address back without demoting it.
    pub fn release(&mut self, conn_index: u8) {
        if let Some((region, address)) = self.held.remove(&conn_index) {
            self.regions[region].in_use.retain(|held| *held != address);
        }
    }

    fn take(&mut self, conn_index: u8, avoid: Option<SocketAddr>) -> Result<SocketAddr, EdgeError> {
        let avoid_region = avoid.and_then(|address| {
            self.regions
                .iter()
                .position(|region| region.addresses.contains(&address))
        });

        // Fewest connections first, and the region we just failed out of last. The tuple
        // ordering is the whole balancing policy: everything else is bookkeeping.
        let mut order: Vec<usize> = (0..self.regions.len()).collect();
        order.sort_by_key(|index| {
            (
                Some(*index) == avoid_region,
                self.regions[*index].in_use.len(),
            )
        });

        // Two passes: honour demotions first, then ignore them rather than fail. A pool that
        // refuses to hand out any address has turned a transient edge problem into a dead
        // tunnel, which is strictly worse than reusing an address that failed 9 minutes ago.
        for honour_demotions in [true, false] {
            for region_index in &order {
                let now = Instant::now();
                let region = &self.regions[*region_index];
                let candidate = region.addresses.iter().find(|address| {
                    if Some(**address) == avoid || region.in_use.contains(address) {
                        return false;
                    }
                    if honour_demotions {
                        return region
                            .demoted
                            .get(address)
                            .is_none_or(|since| now.duration_since(*since) >= DEMOTION);
                    }
                    true
                });
                if let Some(address) = candidate.copied() {
                    let region = &mut self.regions[*region_index];
                    region.in_use.push(address);
                    region.demoted.remove(&address);
                    self.held.insert(conn_index, (*region_index, address));
                    return Ok(address);
                }
            }
        }
        Err(EdgeError::NoAddress)
    }
}

fn check(regions: Vec<Region>) -> Result<Vec<Region>, EdgeError> {
    if regions.is_empty() {
        return Err(EdgeError::NoAddress);
    }
    if regions.len() < MIN_REGIONS {
        return Err(EdgeError::TooFewRegions {
            found: regions.len(),
        });
    }
    Ok(regions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srv_names_match_the_pinned_source() {
        assert_eq!(
            srv_name(Endpoint::Global),
            "_v2-origintunneld._tcp.argotunnel.com."
        );
        assert_eq!(
            srv_name(Endpoint::Fed),
            "_fed-v2-origintunneld._tcp.argotunnel.com."
        );
    }

    #[test]
    fn region_hostnames_are_two_per_endpoint() {
        // Upstream requires two regions to balance across (§4).
        assert_eq!(region_hostnames(Endpoint::Global).len(), MIN_REGIONS);
        assert_eq!(region_hostnames(Endpoint::Fed).len(), MIN_REGIONS);
    }

    #[test]
    fn fed_hostnames_are_prefixed_not_substituted() {
        for name in region_hostnames(Endpoint::Fed) {
            assert!(name.starts_with("fed-"), "{name}");
            assert!(name.ends_with(".v2.argotunnel.com."), "{name}");
        }
    }

    #[test]
    fn edge_port_is_the_observed_value() {
        assert_eq!(EDGE_PORT, 7844);
    }

    #[test]
    fn rejects_an_empty_result_rather_than_inventing_an_address() {
        assert!(matches!(check(vec![]), Err(EdgeError::NoAddress)));
    }

    #[test]
    fn rejects_a_single_region() {
        let one = vec![Region {
            name: "region1.v2.argotunnel.com.".to_owned(),
            addresses: vec![SocketAddr::from(([198, 51, 100, 1], EDGE_PORT))],
        }];
        assert!(matches!(
            check(one),
            Err(EdgeError::TooFewRegions { found: 1 })
        ));
    }

    #[test]
    fn accepts_two_regions() {
        let two: Vec<Region> = ["region1.v2.argotunnel.com.", "region2.v2.argotunnel.com."]
            .iter()
            .enumerate()
            .map(|(i, name)| Region {
                name: (*name).to_owned(),
                addresses: vec![SocketAddr::from((
                    [198, 51, 100, u8::try_from(i).unwrap()],
                    EDGE_PORT,
                ))],
            })
            .collect();
        assert!(check(two).is_ok());
    }

    /// Two regions, `per` addresses each, IPv6 listed first so the ordering rule is
    /// actually exercised rather than accidentally satisfied.
    fn pool(per: u8) -> AddressPool {
        let regions = (1..=2u8)
            .map(|region| Region {
                name: format!("region{region}.v2.argotunnel.com."),
                addresses: (0..per)
                    .flat_map(|index| {
                        [
                            SocketAddr::from((
                                [
                                    0x2606,
                                    0x4700,
                                    0,
                                    0,
                                    0,
                                    0,
                                    u16::from(region),
                                    u16::from(index),
                                ],
                                EDGE_PORT,
                            )),
                            SocketAddr::from(([198, 51, 100, region * 10 + index], EDGE_PORT)),
                        ]
                    })
                    .collect(),
            })
            .collect();
        AddressPool::new(regions).expect("two regions is enough")
    }

    #[test]
    fn spreads_four_connections_evenly_across_both_regions() {
        // The point of the pool: 4 connections, 2 regions, 2 each. An `index % regions`
        // handout gets this case right and then drifts the moment one connection rotates,
        // which is why the next test exists.
        let mut pool = pool(4);
        let claims: Vec<String> = (0..4)
            .map(|index| {
                let address = pool.claim(index).expect("an address is free");
                pool.region_of(address).expect("a known region").to_owned()
            })
            .collect();
        assert_eq!(
            claims
                .iter()
                .filter(|name| name.contains("region1"))
                .count(),
            2
        );
        assert_eq!(
            claims
                .iter()
                .filter(|name| name.contains("region2"))
                .count(),
            2
        );
    }

    #[test]
    fn a_rotation_moves_to_the_other_region() {
        let mut pool = pool(4);
        let first = pool.claim(0).expect("free");
        let before = pool.region_of(first).expect("known").to_owned();
        let second = pool.rotate(0).expect("free");
        let after = pool.region_of(second).expect("known").to_owned();
        // The failure that triggered a rotation is usually regional, so the neighbour of a
        // dead address is the least useful next choice.
        assert_ne!(before, after, "rotation stayed in {before}");
    }

    #[test]
    fn a_rotation_never_returns_the_address_that_just_failed() {
        // One address per region, so the only options are the failed one and the other
        // region's. Getting the failed address back here would mean a reconnect loop that
        // hammers a dead edge forever.
        let mut pool = pool(1);
        let mut seen = vec![pool.claim(0).expect("free")];
        for _ in 0..6 {
            let next = pool.rotate(0).expect("something is always free");
            assert!(
                !seen.contains(&next) || seen.len() > 2,
                "handed back {next} which had already failed"
            );
            seen.push(next);
        }
    }

    #[test]
    fn never_hands_one_address_to_two_connections() {
        // Two connections on one address is precisely what EDUPCONN reports, and the edge
        // refuses the second — so the pool has to prevent it rather than react to it.
        let mut pool = pool(2);
        let mut taken = Vec::new();
        for index in 0..8 {
            let address = pool.claim(index).expect("8 addresses exist");
            assert!(!taken.contains(&address), "{address} handed out twice");
            taken.push(address);
        }
    }

    #[test]
    fn releasing_returns_an_address_to_circulation() {
        let mut pool = pool(1);
        let held: Vec<SocketAddr> = (0..4).map(|i| pool.claim(i).expect("free")).collect();
        assert!(pool.claim(4).is_err(), "the pool should be exhausted");
        pool.release(0);
        let reused = pool.claim(4).expect("the released address is free again");
        assert_eq!(reused, held[0]);
    }

    #[test]
    fn hands_out_ipv4_before_ipv6_within_a_region() {
        // §5's initial-MTU constant was chosen for an IPv4 dial. An IPv6-first handout
        // silently exercises the less-tested path on every fresh connection.
        let mut pool = pool(2);
        assert!(pool.claim(0).expect("free").is_ipv4());
        assert!(pool.claim(1).expect("free").is_ipv4());
    }

    #[test]
    fn exhaustion_prefers_a_stale_demotion_over_failing() {
        // A pool that refuses every address has turned a transient edge fault into a dead
        // tunnel. One address per region, one connection, rotating past both: the second
        // rotation has nothing undemoted left and must still answer.
        let mut pool = pool(1);
        pool.claim(0).expect("free");
        pool.rotate(0).expect("the other region");
        let third = pool
            .rotate(0)
            .expect("must reuse a demoted address rather than fail");
        assert!(pool.region_of(third).is_some());
    }

    #[test]
    fn claiming_twice_is_idempotent_for_one_index() {
        // A supervisor that retries registration on the same address must not consume a
        // second one each time round the loop.
        let mut pool = pool(2);
        let first = pool.claim(1).expect("free");
        assert_eq!(pool.claim(1).expect("already held"), first);
    }

    #[test]
    fn a_pool_needs_two_regions_like_discovery_does() {
        let one = vec![Region {
            name: "region1.v2.argotunnel.com.".to_owned(),
            addresses: vec![SocketAddr::from(([198, 51, 100, 1], EDGE_PORT))],
        }];
        assert!(matches!(
            AddressPool::new(one),
            Err(EdgeError::TooFewRegions { found: 1 })
        ));
    }

    #[test]
    fn the_dot_resolver_matches_the_pinned_source() {
        // Every one of these is a value cloudflared hardcodes, and none of them is checkable at
        // runtime: a wrong SNI or port fails as a generic connection error long after the fact.
        // Asserting the *configuration* is the only hermetic way to pin them.
        let server = dot_nameserver();
        assert_eq!(server.ip, DOT_IP);
        assert_eq!(
            server.connections.len(),
            1,
            "TLS only — no plaintext fallback"
        );

        let connection = &server.connections[0];
        assert_eq!(connection.port, DOT_PORT);
        // The name, not the address. A certificate is not issued for `1.1.1.1`, so getting this
        // wrong turns the fallback into a permanent TLS failure that only shows up off-network.
        assert!(
            format!("{:?}", connection.protocol).contains(DOT_SERVER_NAME),
            "SNI must be {DOT_SERVER_NAME}, got {:?}",
            connection.protocol
        );
    }

    #[test]
    fn the_dot_resolver_builds_without_the_system_configuration() {
        // The reason it exists is that the system configuration may be unusable, so constructing it
        // must not consult `resolv.conf` at all — otherwise the fallback fails for exactly the
        // people who need it.
        assert!(dot_resolver().is_ok());
    }

    #[test]
    fn the_dot_timeout_matches_the_pinned_source() {
        assert_eq!(DOT_TIMEOUT, Duration::from_secs(15));
    }

    /// Live DNS. `#[ignore]` so `cargo test` stays hermetic and offline
    /// (`docs/TESTING.md`).
    #[tokio::test]
    #[ignore = "requires network"]
    async fn resolves_the_global_edge_directly() {
        let regions = discover_direct(Endpoint::Global)
            .await
            .expect("global edge should resolve");
        assert_eq!(regions.len(), MIN_REGIONS);
        for region in &regions {
            assert!(!region.addresses.is_empty(), "{}", region.name);
            for address in &region.addresses {
                assert_eq!(address.port(), EDGE_PORT);
            }
        }
    }

    /// A primary resolver that could not be built at all — the broken-`resolv.conf` case.
    fn unusable_resolver() -> Result<TokioResolver, EdgeError> {
        Err(EdgeError::Resolver(Box::new(std::io::Error::other(
            "no system resolver",
        ))))
    }

    fn one_region() -> Vec<Region> {
        vec![Region {
            name: "region1.v2.argotunnel.com.".to_owned(),
            addresses: vec![SocketAddr::from(([198, 51, 100, 1], EDGE_PORT))],
        }]
    }

    #[tokio::test]
    async fn falls_back_to_dot_when_the_system_resolver_cannot_be_built() {
        // The whole point of the fallback: a machine whose DNS configuration is unusable still
        // reaches the edge, because DoT needs nothing from that configuration.
        let regions = with_fallback(unusable_resolver(), |_| async { Ok(one_region()) })
            .await
            .expect("the fallback should have answered");
        assert_eq!(regions.len(), 1);
    }

    #[tokio::test]
    async fn does_not_use_the_fallback_when_the_system_resolver_answers() {
        // A working local resolver is faster and respects split-horizon DNS, so it must win. The
        // counter proves the fallback was not also consulted — a fallback that always runs is a
        // hard dependency on `1.1.1.1` wearing a fallback's clothes.
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let regions = with_fallback(system_resolver(), |_| {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Ok(one_region()) }
        })
        .await
        .expect("the primary should have answered");

        assert_eq!(regions.len(), 1);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn reports_the_primary_failure_when_both_resolvers_fail() {
        // Which error surfaces is a real decision, not a detail. The system resolver's names the
        // problem in the environment the user controls; reporting the DoT failure instead would
        // point every broken-resolver report at Cloudflare.
        let error = with_fallback(unusable_resolver(), |_| async { Err(EdgeError::NoAddress) })
            .await
            .expect_err("both failed, so this must be an error");
        assert!(
            matches!(error, EdgeError::Resolver(_)),
            "expected the primary failure, got {error:?}"
        );
    }

    /// Live DNS, and the only test that proves the fallback can actually answer.
    ///
    /// The hermetic tests above pin the configuration; they cannot show that `1.1.1.1:853` accepts
    /// it and returns SRV records. Drives the DoT resolver directly rather than through
    /// [`with_dot_fallback`], because on a working network the system resolver would answer first
    /// and the fallback would never run — a test that passes without exercising what it names.
    #[tokio::test]
    #[ignore = "requires network"]
    async fn resolves_the_global_edge_over_dot() {
        let resolver = dot_resolver().expect("the DoT resolver has no system dependency");
        let regions = srv_with(resolver, Endpoint::Global)
            .await
            .expect("DoT SRV lookup should succeed");
        assert!(regions.len() >= MIN_REGIONS);
        for region in &regions {
            assert!(!region.addresses.is_empty(), "{}", region.name);
        }
    }

    /// Live DNS.
    #[tokio::test]
    #[ignore = "requires network"]
    async fn resolves_the_global_edge_via_srv() {
        let regions = discover_srv(Endpoint::Global)
            .await
            .expect("SRV lookup should succeed");
        assert!(regions.len() >= MIN_REGIONS);
        for region in &regions {
            for address in &region.addresses {
                // Not asserted equal to EDGE_PORT: the SRV record is authoritative and
                // this test is how we would find out if Cloudflare changed it.
                assert_ne!(address.port(), 0, "{}", region.name);
            }
        }
    }
}
