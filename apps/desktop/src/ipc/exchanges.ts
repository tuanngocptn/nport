import type { UnlistenFn } from "@tauri-apps/api/event"
import { listen } from "@tauri-apps/api/event"

/**
 * Captured traffic, arriving from `src-tauri/src/inspector.rs`.
 *
 * Hand-typed until `tauri-specta`, like the rest of `src/ipc/`. The Rust tests pin the exact JSON.
 */

export interface UiBody {
  /** Lossy UTF-8 of what was kept — a body can be anything, and blanking non-text hides the
   *  requests people are debugging. */
  text: string
  total: number
  truncated: boolean
}

export interface Header {
  name: string
  value: string
}

export interface UiExchange {
  id: number
  /** Epoch milliseconds. */
  at: number
  durationMs: number
  kind: "http" | "websocket" | "tcp"
  method: string
  url: string
  /** Absent when the exchange failed before the origin answered. */
  status: number | null
  requestHeaders: Header[]
  responseHeaders: Header[]
  requestBody: UiBody
  responseBody: UiBody
  /** A registry code, or `streamEnded`. */
  failure: string | null
}

export interface ExchangeMessage {
  subdomain: string
  exchange: UiExchange
}

/** Must match `EXCHANGE_EVENT` in `src-tauri/src/inspector.rs`. */
const EXCHANGE_EVENT = "nport://exchange"

/** Subscribes to every tunnel's captured traffic. */
export async function onExchange(handler: (message: ExchangeMessage) => void): Promise<UnlistenFn> {
  return await listen<ExchangeMessage>(EXCHANGE_EVENT, (message) => {
    handler(message.payload)
  })
}
