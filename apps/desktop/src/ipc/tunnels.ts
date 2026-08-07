import { invoke } from "@tauri-apps/api/core"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { listen } from "@tauri-apps/api/event"

/**
 * The tunnel half of the IPC boundary.
 *
 * **Hand-typed, and it has to stay honest by hand.** From later in Phase 4 these types come from
 * `src/generated/bindings.ts` via `tauri-specta`, at which point a renamed command or a changed
 * payload fails at `tsc` instead of at runtime. Until then the authority is
 * `src-tauri/src/commands.rs` and `src-tauri/src/events.rs`, whose tests pin the exact JSON — so a
 * drift here shows up as a payload the Rust test asserts and this file does not describe.
 */

/** A running tunnel, as `list_tunnels` and `start_tunnel` report it. */
export interface TunnelSummary {
  url: string
  subdomain: string
  /** Epoch milliseconds, server-authoritative. Display only — the server enforces it (invariant 3). */
  expiresAt: number
  localPort: number
}

/**
 * A code from the frozen registry — `LOCAL_PORT_CLOSED`, not a sentence.
 *
 * Deliberately `string` rather than a union of all 33: the union belongs to the generated bindings,
 * and hand-maintaining a second copy of the registry here is the drift `packages/contract` exists to
 * prevent. What the UI does with it is look up a translation and build a `/errors/<slug>` link, and
 * neither needs the compiler to know the whole set.
 */
export type ErrorCode = string

export interface CommandError {
  code: ErrorCode
}

/** Why a tunnel stopped. **None of these is a failure** — `leaseExpired` is the design working. */
export type ShutdownReason = "requested" | "leaseExpired" | "connectionsExhausted"

/**
 * Everything a tunnel reports, discriminated by `type`.
 *
 * One channel rather than an event per variant, because ordering between separate Tauri channels is
 * not guaranteed and `connectionUp` arriving before `provisioned` would render a tunnel that is up
 * before it exists.
 */
export type TunnelEvent =
  | { type: "provisioned"; url: string; subdomain: string; expiresAt: number }
  | { type: "connectionUp"; index: number; colo: string }
  | { type: "connectionLost"; index: number }
  | { type: "connectionRetrying"; index: number; attempt: number; delayMs: number }
  | { type: "connectionGaveUp"; index: number; code: ErrorCode }
  | { type: "shuttingDown"; reason: ShutdownReason }
  | { type: "stopped"; drained: boolean }

/** The Tauri event name. Must match `TUNNEL_EVENT` in `src-tauri/src/events.rs`. */
const TUNNEL_EVENT = "nport://tunnel"

/**
 * Starts a tunnel. Resolves once the URL is live; the rest arrives through {@link onTunnelEvent}.
 *
 * `subdomain` is sent **raw**, not normalized here: the server owns the value that becomes a lease
 * key, and a client that normalized first would be a second authority on the path.
 */
export async function startTunnel(options: {
  localPort: number
  subdomain?: string
  backend?: string
  registry?: string
}): Promise<TunnelSummary> {
  return await invoke<TunnelSummary>("start_tunnel", options)
}

/** Stops a tunnel: drains its connections, then releases the lease. */
export async function stopTunnel(subdomain: string): Promise<void> {
  await invoke("stop_tunnel", { subdomain })
}

/** Every tunnel this app is running, ordered by subdomain. */
export async function listTunnels(): Promise<TunnelSummary[]> {
  return await invoke<TunnelSummary[]>("list_tunnels")
}

/**
 * Subscribes to every tunnel's events.
 *
 * **Call `listTunnels` after subscribing, not before.** A tunnel started between the two would
 * otherwise be missed by both — absent from the list, and its `provisioned` event fired before the
 * listener existed. The same ordering hazard `start_tunnel` handles on the Rust side by emitting
 * `provisioned` itself rather than relying on the broadcast the caller was too late to receive.
 */
export async function onTunnelEvent(handler: (event: TunnelEvent) => void): Promise<UnlistenFn> {
  return await listen<TunnelEvent>(TUNNEL_EVENT, (message) => {
    handler(message.payload)
  })
}
