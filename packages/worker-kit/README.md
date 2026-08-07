# @nport/worker-kit

The plumbing both NPort Workers share: the error envelope and stateless proof of work. [ADR-0047](../../docs/DECISIONS.md).

| Module | Holds | Why it is shared and not copied |
| --- | --- | --- |
| `errors.ts` | `ApiError`, `envelope`, `retryAfterSeconds` | the envelope's shape is fixed by [`docs/ERRORS.md`](../../docs/ERRORS.md) and parsed by every client. Two copies is how one service starts answering in a shape nothing is parsing for |
| `pow.ts` | issue, verify, and solve a challenge | both services gate writes with the same algorithm. A drifted copy would verify something subtly different from what its sibling issues, and it would look like a client bug |

Consumers: `apps/node` (a node) gates `POST /v1/tunnels`; `apps/registry` gates `POST /v1/nodes`.

**Sharing the algorithm is not sharing the trust boundary.** Each Worker signs with its own `POW_SECRET`, so a challenge issued by one is not solvable for the other.

## What belongs here

**No bindings, no `env`, no Hono.** That is the whole boundary, and it is what lets these tests run under plain vitest instead of `workerd`. Anything that needs a binding stays in the app that owns the binding — which is why the middleware did not move: `requestId`, `rateLimit`, `clientGate` and `requireBindings` are typed against `apps/node`'s own `Env`, and generalising them to share four small functions would trade clarity for reuse nobody asked for.

Codes come from [`@nport/contract`](../contract/README.md), which stays the single authority. This package decides how a failure is *shaped*, never what failures exist.
