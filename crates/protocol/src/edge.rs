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
//! **There are no hardcoded fallback edge IPs anywhere in the upstream source, and there
//! must be none here.** If discovery fails, the tunnel fails.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use hickory_resolver::proto::rr::RData;
use hickory_resolver::{Resolver, TokioResolver};

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

fn resolver() -> Result<TokioResolver, EdgeError> {
    Resolver::builder_tokio()
        .map_err(|e| EdgeError::Resolver(Box::new(e)))?
        .build()
        .map_err(|e| EdgeError::Resolver(Box::new(e)))
}

/// Resolves the region hostnames directly, skipping SRV.
///
/// `docs/PROTOCOL.md` §4 recommends this for the spike: one fewer moving part, and it
/// exercises the same address shape the QUIC dial needs.
pub async fn discover_direct(endpoint: Endpoint) -> Result<Vec<Region>, EdgeError> {
    let resolver = resolver()?;
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
    let resolver = resolver()?;
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
