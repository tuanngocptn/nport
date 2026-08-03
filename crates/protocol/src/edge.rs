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

use std::net::SocketAddr;

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
