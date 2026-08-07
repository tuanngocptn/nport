# @nport/worker-kit

The plumbing both NPort Workers share: the error envelope and stateless proof of work. [ADR-0047](../../docs/DECISIONS.md).

| Module | Holds | Why it is shared and not copied |
| --- | --- | --- |
| `errors.ts` | `ApiError`, `envelope`, `retryAfterSeconds` | the envelope's shape is fixed by [`docs/ERRORS.md`](../../docs/ERRORS.md) and parsed by every client. Two copies is how one service starts answering in a shape nothing is parsing for |
| `pow.ts` | issue, verify, and solve a challenge | both services gate writes with the same algorithm. A drifted copy would verify something subtly different from what its sibling issues, and it would look like a client bug |

Consumers: `apps/node` (a node) gates `POST /v1/tunnels`; `apps/registry` gates `POST /v1/nodes`; `apps/gateway` derives every caller's source identity and forwards it to both.

**Sharing the algorithm is not sharing the trust boundary.** Each Worker signs with its own `POW_SECRET`, so a challenge issued by one is not solvable for the other.

## What belongs here

**No bindings, no `env`, no Hono.** That is the whole boundary, and it is what lets these tests run under plain vitest instead of `workerd`. Anything that needs a binding stays in the app that owns the binding.

**That boundary is why the duplicated middleware went to a Worker rather than here.** `requestId`, `rateLimit` and `clientGate` existed in near-identical form in two apps and could not move into this package — `rateLimit` reads a binding, and all three are typed against an app's own `Env`. ADR-0049 put them in `apps/gateway` instead, which is a Worker and may hold bindings, and both services now read the results.

What *did* come here is the part with no binding in it: `forwarded.ts` holds the two header names those results travel under, and one function to read them. Two string literals in three files is how a caller ends up sharing one identity with everyone else, and the names are the one thing all three Workers must spell identically.

Codes come from [`@nport/contract`](../contract/README.md), which stays the single authority. This package decides how a failure is *shaped*, never what failures exist.
