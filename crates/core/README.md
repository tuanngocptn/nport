# nport-core

`TunnelManager`: the tunnel lifecycle. Provision via the control plane, connect through `crates/protocol`, proxy to localhost, tear down. Owns the connection pool, reconnection, the event stream, and the optional traffic inspector.

Shared by `crates/cli` and `apps/desktop` — which is why it is **headless**: no printing, no exiting, no TTY detection. It emits `TunnelEvent`s and lets its consumers decide how to show them.

**Not implemented.** Phase 2b in [`docs/ROADMAP.md`](../../docs/ROADMAP.md).

See [`crates/CLAUDE.md`](../CLAUDE.md) for the layering rules and [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §3 for the lifecycle.
