/**
 * The headers a request carries once it has come through `apps/gateway`.
 *
 * This Worker declares no `routes` (ADR-0049), so **every** real request reaches it through a service
 * binding with these already set. A test that omits them is testing a shape production cannot produce
 * — and since `src/middleware/forwarded.ts` fails closed without a source hash, it would be testing
 * the refusal rather than the route.
 *
 * Kept here rather than repeated per file so the two header names have one spelling on this side, as
 * they do on the gateway's.
 */
export const GATEWAY = {
  "x-nport-source-hash": "test-source-default",
  "x-nport-request-id": "test-request-id",
} as const

/** `asGateway({ "user-agent": … })` — the forwarded headers, plus whatever the test cares about. */
export function asGateway(extra: Record<string, string> = {}): Record<string, string> {
  return { ...GATEWAY, ...extra }
}
