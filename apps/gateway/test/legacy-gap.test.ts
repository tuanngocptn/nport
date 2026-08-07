import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"

/**
 * **The v2 shim is not routed, on purpose, for now.**
 *
 * `apps/node` still carries `POST /` and `DELETE /` from `apps/node/src/routes/legacy.ts`, and roughly forty tests
 * still cover them — all passing, because they drive that app directly. Behind a gateway that forwards
 * only `/v1/*`, none of it is reachable. v3 first; backward compatibility comes back later.
 *
 * This file exists so that gap is **stated rather than discovered**. Tested-but-unreachable code is
 * the exact shape this repository has spent seven defects removing — a claim that something works,
 * with a passing test behind it, and no path from a request to the code. The difference between that
 * and a deliberate gap is whether it is written down.
 *
 * **When `/` is routed again**, the assertion below starts failing, which is the point: it is a
 * tripwire, not a decoration. Delete this file, route `POST /` and `DELETE /` to `NODE`, and let
 * `apps/node`'s legacy tests mean something again.
 */

describe("the v2 compatibility shim", () => {
  it("is unreachable through the gateway, deliberately", async () => {
    // A v2 client posts a bare body to `/`. It gets the gateway's not-found envelope, because nothing
    // forwards the root — `GET /` is the site redirect and there is no `POST /` rule at all.
    const response = await SELF.fetch("https://api.nport.link/", {
      method: "POST",
      body: JSON.stringify({ subdomain: "legacy", port: 3000 }),
    })

    expect(
      response.status,
      "if this is no longer 400, `/` is being routed — delete this file and re-enable v2",
    ).toBe(400)
  })

  it("still redirects a browser at the root", async () => {
    // The one thing at `/` that does work, and the reason a naive "forward everything at /" fix would
    // break the site link instead.
    const response = await SELF.fetch("https://api.nport.link/", { redirect: "manual" })
    expect(response.status).toBe(301)
  })
})
