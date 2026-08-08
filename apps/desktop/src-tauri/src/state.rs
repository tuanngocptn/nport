//! The tunnels this app is running, and the task that forwards their events.
//!
//! The mockup draws a *list* of tunnels, so the app runs several at once. `crates/core` has no
//! notion of that — a [`Tunnel`] is one tunnel — which makes keeping the set the app's job and this
//! file the only place that knows how many exist.
//!
//! ## Keyed by subdomain
//!
//! The subdomain is the lease, and the server owns it: `Tunnel::subdomain` is the **normalized or
//! generated** name that was actually claimed, not what the user typed. Keying on the claim means
//! two requests for `MyApp` and `myapp` cannot both appear in the list as separate tunnels when the
//! server considers them the same lease — the normalization defect (`docs/ROADMAP.md`, defect 36)
//! one layer up.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use nport_core::tunnel::Tunnel;
use serde::Serialize;

/// What the frontend is told about a running tunnel.
///
/// No token and no `ownerToken`, which is rule 6 and costs nothing here: neither is reachable
/// through [`Tunnel`]'s public API in the first place. The connector holds them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSummary {
    pub url: String,
    pub subdomain: String,
    /// Epoch milliseconds, server-authoritative. Displayed, never enforced (invariant 3).
    pub expires_at: i64,
    /// The local port being tunnelled. Not on `Tunnel` — the app supplied it, so the app keeps it.
    pub local_port: u16,
}

/// What [`Registry`] needs from the thing it stores.
///
/// A trait rather than a concrete [`Tunnel`] **so this file's own logic can be tested**. `Tunnel` has
/// no public constructor and starting one means provisioning against a real control plane, so a
/// registry that stored it directly would be reachable only by an integration test that cannot run
/// in CI — and the parts worth testing here are the bookkeeping, not the tunnelling: what happens on
/// a duplicate subdomain, what `remove` returns for a name that is not there, whether `list` is
/// stable.
pub trait Described {
    fn url(&self) -> &str;
    fn subdomain(&self) -> &str;
    fn expires_at(&self) -> i64;
}

impl Described for Tunnel {
    fn url(&self) -> &str {
        Tunnel::url(self)
    }
    fn subdomain(&self) -> &str {
        Tunnel::subdomain(self)
    }
    fn expires_at(&self) -> i64 {
        Tunnel::expires_at(self)
    }
}

/// The running set.
///
/// A `std::sync::Mutex` rather than tokio's, deliberately: nothing here is held across an `.await`.
/// The one operation that awaits — stopping a tunnel — takes ownership out of the map first and
/// releases the lock before the drain, which is why [`Registry::remove`] returns the value instead
/// of doing the shutdown itself. Holding an async lock across a drain would serialise stopping two
/// tunnels behind each other for no reason (`docs/conventions/rust.md`).
#[derive(Debug, Default)]
pub struct Registry<T> {
    running: Mutex<HashMap<String, Entry<T>>>,
    next_id: AtomicU64,
}

#[derive(Debug)]
struct Entry<T> {
    inner: T,
    local_port: u16,
    id: TunnelId,
}

/// Distinguishes one tunnel from the next tunnel with the same name.
///
/// **Not decoration.** A tunnel's event pump removes it from the registry when it ends, and the only
/// thing it knows is the subdomain — which is not enough: if the same name had been claimed again in
/// the meantime, removing by name would evict the *live* tunnel on the dead one's behalf. The id
/// makes removal mean "remove this tunnel", not "remove whatever is called that".
pub type TunnelId = u64;

/// The concrete registry the app holds as Tauri managed state.
pub type Tunnels = Registry<Tunnel>;

impl<T: Described> Registry<T> {
    #[must_use]
    pub fn new() -> Self {
        Self {
            running: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    /// Adds a tunnel, returning its summary and whatever it displaced.
    ///
    /// **Displacement is possible and is not an error.** The server can hand back a subdomain the
    /// app already has — a lease that expired here but was re-claimed, or the same generated name
    /// twice — and silently dropping the old value would leak a live `Tunnel` whose connections
    /// nobody can ever stop. Returning it makes the caller decide, which is the only place that can
    /// `await` the drain.
    pub fn insert(&self, tunnel: T, local_port: u16) -> (TunnelSummary, TunnelId, Option<T>) {
        let summary = summarize(&tunnel, local_port);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let displaced = self
            .running
            .lock()
            .expect("the tunnel registry lock is never held across a panic")
            .insert(
                tunnel.subdomain().to_owned(),
                Entry {
                    inner: tunnel,
                    local_port,
                    id,
                },
            )
            .map(|entry| entry.inner);

        (summary, id, displaced)
    }

    /// Removes a tunnel **only if it is still the one with this id**.
    ///
    /// What a pump calls when its tunnel ends on its own — a lease expiring, or every connection
    /// giving up. Without this the registry only ever shrank on an explicit stop or on quit, so an
    /// expired tunnel stayed listed forever: `list_tunnels` reported a tunnel that was gone, a
    /// reloaded window seeded rows for it, and its handle was retained for the life of the process.
    ///
    /// The id is what makes it safe to call from a task that may have been overtaken.
    pub fn remove_if(&self, subdomain: &str, id: TunnelId) -> Option<T> {
        let mut running = self
            .running
            .lock()
            .expect("the tunnel registry lock is never held across a panic");

        match running.get(subdomain) {
            Some(entry) if entry.id == id => running.remove(subdomain).map(|entry| entry.inner),
            _ => None,
        }
    }

    /// Takes a tunnel out so the caller can stop it. `None` if that name is not running.
    pub fn remove(&self, subdomain: &str) -> Option<T> {
        self.running
            .lock()
            .expect("the tunnel registry lock is never held across a panic")
            .remove(subdomain)
            .map(|entry| entry.inner)
    }

    /// Every running tunnel, ordered by subdomain.
    ///
    /// Sorted because a `HashMap`'s order is arbitrary *and varies between calls*, and this list is
    /// rendered: an unsorted answer makes rows jump around whenever the frontend refetches.
    pub fn list(&self) -> Vec<TunnelSummary> {
        let mut summaries: Vec<TunnelSummary> = self
            .running
            .lock()
            .expect("the tunnel registry lock is never held across a panic")
            .values()
            .map(|entry| summarize(&entry.inner, entry.local_port))
            .collect();

        summaries.sort_by(|a, b| a.subdomain.cmp(&b.subdomain));
        summaries
    }

    /// Empties the registry, handing back everything for shutdown.
    ///
    /// The app quitting is the case: every tunnel has to be drained and its lease released, and a
    /// lease left claimed holds the user's own subdomain against them for the rest of its term.
    pub fn drain(&self) -> Vec<T> {
        self.running
            .lock()
            .expect("the tunnel registry lock is never held across a panic")
            .drain()
            .map(|(_, entry)| entry.inner)
            .collect()
    }
}

fn summarize<T: Described>(tunnel: &T, local_port: u16) -> TunnelSummary {
    TunnelSummary {
        url: tunnel.url().to_owned(),
        subdomain: tunnel.subdomain().to_owned(),
        expires_at: tunnel.expires_at(),
        local_port,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stands in for a `Tunnel`, which cannot be constructed without provisioning one.
    struct Fake {
        subdomain: String,
        url: String,
    }

    impl Fake {
        fn new(subdomain: &str) -> Self {
            Self {
                subdomain: subdomain.to_owned(),
                url: format!("https://{subdomain}.nport.link"),
            }
        }
    }

    impl Described for Fake {
        fn url(&self) -> &str {
            &self.url
        }
        fn subdomain(&self) -> &str {
            &self.subdomain
        }
        fn expires_at(&self) -> i64 {
            1_786_000_000_000
        }
    }

    #[test]
    fn a_tunnel_is_listed_once_it_is_inserted() {
        let registry: Registry<Fake> = Registry::new();
        let (summary, _id, displaced) = registry.insert(Fake::new("myapp"), 3000);

        assert!(displaced.is_none());
        assert_eq!(summary.subdomain, "myapp");
        assert_eq!(summary.url, "https://myapp.nport.link");
        assert_eq!(summary.local_port, 3000);
        assert_eq!(registry.list(), vec![summary]);
    }

    /// The displaced tunnel comes back rather than being dropped on the floor.
    ///
    /// Dropping it would leak a live tunnel: its connections stay up, its lease stays claimed, and
    /// nothing holds a handle to stop either. The caller is the only place that can `await` a drain,
    /// so it has to be handed the thing to drain.
    #[test]
    fn inserting_the_same_subdomain_hands_back_what_it_replaced() {
        let registry: Registry<Fake> = Registry::new();
        registry.insert(Fake::new("myapp"), 3000);

        let (summary, _id, displaced) = registry.insert(Fake::new("myapp"), 4000);

        assert_eq!(summary.local_port, 4000);
        assert!(displaced.is_some(), "the replaced tunnel would have leaked");
        assert_eq!(registry.list().len(), 1, "one name, one entry");
    }

    /// The bug this exists for: a tunnel that ended by itself was never removed.
    ///
    /// Only `stop_tunnel` and the quit-time drain ever shrank the registry, so an expired lease left
    /// a tunnel listed for the life of the process — `list_tunnels` reporting one that was gone.
    #[test]
    fn a_pump_can_remove_its_own_tunnel_when_it_ends() {
        let registry: Registry<Fake> = Registry::new();
        let (_summary, id, _) = registry.insert(Fake::new("myapp"), 3000);

        assert!(registry.remove_if("myapp", id).is_some());
        assert!(registry.list().is_empty());
    }

    /// **The reason removal is keyed on an id rather than on the name.**
    ///
    /// A dead tunnel's pump wakes up to remove itself, and by then the same name may belong to a new
    /// tunnel. Removing by name would evict the live one on the dead one's behalf — the app would
    /// show nothing while a tunnel was still serving, and nothing could stop it.
    #[test]
    fn a_stale_pump_cannot_evict_the_tunnel_that_replaced_it() {
        let registry: Registry<Fake> = Registry::new();
        let (_summary, old_id, _) = registry.insert(Fake::new("myapp"), 3000);
        let (_summary, new_id, displaced) = registry.insert(Fake::new("myapp"), 4000);
        assert!(displaced.is_some());

        // The old pump finally sees `Stopped` and tries to clean up.
        assert!(
            registry.remove_if("myapp", old_id).is_none(),
            "a stale pump removed the live tunnel"
        );
        assert_eq!(registry.list().len(), 1, "the live tunnel is still listed");

        // The current one can still remove itself.
        assert!(registry.remove_if("myapp", new_id).is_some());
    }

    #[test]
    fn ids_are_not_reused_between_tunnels() {
        let registry: Registry<Fake> = Registry::new();
        let (_s, first, _) = registry.insert(Fake::new("a"), 1);
        let (_s, second, _) = registry.insert(Fake::new("b"), 2);
        registry.remove("a");
        let (_s, third, _) = registry.insert(Fake::new("a"), 3);

        assert_ne!(first, second);
        assert_ne!(second, third);
        assert_ne!(first, third);
    }

    #[test]
    fn removing_a_tunnel_that_is_not_running_is_not_an_error() {
        let registry: Registry<Fake> = Registry::new();
        assert!(registry.remove("nothing-here").is_none());
    }

    #[test]
    fn removing_takes_it_out_of_the_list() {
        let registry: Registry<Fake> = Registry::new();
        registry.insert(Fake::new("a"), 1);
        registry.insert(Fake::new("b"), 2);

        assert!(registry.remove("a").is_some());
        assert_eq!(
            registry
                .list()
                .into_iter()
                .map(|s| s.subdomain)
                .collect::<Vec<_>>(),
            vec!["b"]
        );
    }

    /// A `HashMap`'s iteration order is arbitrary and differs between calls, so an unsorted list
    /// makes rendered rows jump around on every refetch.
    #[test]
    fn the_list_is_ordered_by_subdomain() {
        let registry: Registry<Fake> = Registry::new();
        for name in ["zeta", "alpha", "mid"] {
            registry.insert(Fake::new(name), 3000);
        }

        assert_eq!(
            registry
                .list()
                .into_iter()
                .map(|s| s.subdomain)
                .collect::<Vec<_>>(),
            vec!["alpha", "mid", "zeta"]
        );
    }

    #[test]
    fn draining_empties_the_registry_and_returns_everything() {
        let registry: Registry<Fake> = Registry::new();
        registry.insert(Fake::new("a"), 1);
        registry.insert(Fake::new("b"), 2);

        assert_eq!(registry.drain().len(), 2);
        assert!(registry.list().is_empty());
    }
}
