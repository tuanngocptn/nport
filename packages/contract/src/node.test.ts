import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import {
  isValidNodeId,
  MAX_NODE_DOMAIN_LENGTH,
  NODE_PROOF_LABEL,
  nodeProofRecordName,
  nodeProofRecordValue,
  nodeProofSatisfied,
} from "./node"
import { REGISTRY_ROUTES, ROUTES } from "./routes"
import { nodeListResponseSchema, nodeSchema, registerNodeRequestSchema } from "./schemas"
import { SUBDOMAIN_PATTERN, validateSubdomain } from "./subdomain"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

describe("node ids", () => {
  it("accepts the shapes an operator would actually pick", () => {
    for (const id of ["hk1", "nport-hk-1", "eu-west", "node2"]) {
      expect(isValidNodeId(id), id).toBe(true)
    }
  })

  it("refuses anything that would need quoting in a shell or a log line", () => {
    for (const id of ["", "ab", "-hk", "hk-", "HK1", "hk_1", "hk 1", "hk.1", "a".repeat(33)]) {
      expect(isValidNodeId(id), id).toBe(false)
    }
  })
})

describe("the domain proof", () => {
  it("builds the record name under a label no tunnel can ever claim", () => {
    expect(nodeProofRecordName("nport.dev")).toBe("_nport-node.nport.dev")
    // The load-bearing half: an underscore can never pass subdomain validation, so this name is
    // unreachable by any claim. If that stopped being true, a stranger could take the proof record
    // for a domain and register nodes against it.
    expect(SUBDOMAIN_PATTERN.test(NODE_PROOF_LABEL)).toBe(false)
    expect(validateSubdomain(NODE_PROOF_LABEL).ok).toBe(false)
  })

  it("binds the proof to one node id", () => {
    // Without the id, one published record authorises any listing on that domain — including one
    // registered by whoever noticed the record.
    expect(nodeProofRecordValue("hk1")).toBe("nport-node=hk1")
    expect(nodeProofSatisfied(["nport-node=hk1"], "hk1")).toBe(true)
    expect(nodeProofSatisfied(["nport-node=hk1"], "hk2")).toBe(false)
  })

  it("finds its record among the ones a real domain already has", () => {
    const records = ["v=spf1 -all", "google-site-verification=abc", "nport-node=hk1"]
    expect(nodeProofSatisfied(records, "hk1")).toBe(true)
  })

  it("tolerates the quoting and whitespace resolvers and DNS panels add", () => {
    expect(nodeProofSatisfied(['"nport-node=hk1"'], "hk1")).toBe(true)
    expect(nodeProofSatisfied(["  nport-node=hk1\n"], "hk1")).toBe(true)
  })

  it("does not accept a value that merely contains the expected one", () => {
    // The reason `nodeProofSatisfied` compares rather than using `includes`: a substring check would
    // let one record authorise a second id smuggled into the same string.
    expect(nodeProofSatisfied(["nport-node=hk2 nport-node=hk1"], "hk1")).toBe(false)
    expect(nodeProofSatisfied(["xnport-node=hk1"], "hk1")).toBe(false)
  })

  it("refuses an empty record set rather than treating absence as proof", () => {
    expect(nodeProofSatisfied([], "hk1")).toBe(false)
  })
})

describe("the node schemas", () => {
  const entry = {
    id: "hk1",
    url: "https://api.nport.link",
    domain: "nport.link",
    version: "3.0.0",
    status: "up",
    lastSeenAt: 1_767_225_600_000,
  }

  it("accepts an entry with no capacity reported", () => {
    // Absent means unknown, not zero. A third-party node on an older build does not publish these,
    // and rejecting its entry would delist it for being out of date rather than for being full.
    expect(nodeSchema.safeParse(entry).success).toBe(true)
  })

  it("accepts probed capacity when the node reports it", () => {
    expect(
      nodeSchema.safeParse({ ...entry, activeTunnels: 0, maxActiveTunnels: 100 }).success,
    ).toBe(true)
  })

  it("refuses a status outside the three the registry can observe", () => {
    expect(nodeSchema.safeParse({ ...entry, status: "healthy" }).success).toBe(false)
  })

  it("publishes a cache lifetime, so a client does not hardcode one", () => {
    const parsed = nodeListResponseSchema.safeParse({ nodes: [entry], refreshAfterMs: 300_000 })
    expect(parsed.success).toBe(true)
    expect(nodeListResponseSchema.safeParse({ nodes: [entry] }).success).toBe(false)
  })

  it("carries the node's capacity claim, but never its status", () => {
    // **This assertion is inverted from what it was.** The registry used to probe `/v1/meta` for
    // capacity and this test forbade the fields; ADR-0049 removed the probe, so the node reports them.
    // The risk that argued against it is unchanged and accepted: a node claiming `activeTunnels: 0`
    // is picked first by every client. See `nodeSchema`'s docblock for why that trade is the right one.
    const shape = registerNodeRequestSchema.shape
    expect(Object.keys(shape)).toContain("activeTunnels")
    expect(Object.keys(shape)).toContain("maxActiveTunnels")

    // `status` stays out. It is *derived* from how recently a node registered, so a node claiming to
    // be `up` would be claiming the one thing the registry alone can observe.
    expect(Object.keys(shape)).not.toContain("status")
    expect(Object.keys(shape)).not.toContain("lastSeenAt")
  })

  it("accepts a registration with no capacity claim at all", () => {
    // Both fields optional, for `MetaResponse`'s reason: third-party nodes on older builds, against a
    // frozen contract-v1. Absent means unknown, and discovery treats unknown as usable.
    const base = {
      id: "hk1",
      url: "https://api.nport.link",
      domain: "nport.link",
      version: "3.0.0",
      challenge: "c",
      nonce: "n",
    }
    expect(registerNodeRequestSchema.safeParse(base).success).toBe(true)
    expect(
      registerNodeRequestSchema.safeParse({ ...base, activeTunnels: 3, maxActiveTunnels: 100 })
        .success,
    ).toBe(true)
    // Still bounded: a negative count is not "unknown", it is nonsense.
    expect(registerNodeRequestSchema.safeParse({ ...base, activeTunnels: -1 }).success).toBe(false)
  })

  it("bounds every attacker-supplied string on the open endpoint", () => {
    // ADR-0034: the bound lives in the contract, not in the caller. This endpoint is anonymous, and
    // the registry resolves a DNS name built from `domain` and fetches `url`.
    const tooLong = {
      id: "hk1",
      url: "https://api.nport.link",
      domain: `${"a".repeat(MAX_NODE_DOMAIN_LENGTH)}.test`,
      version: "3.0.0",
      challenge: "c",
      nonce: "n",
    }
    expect(registerNodeRequestSchema.safeParse(tooLong).success).toBe(false)
  })
})

describe("the two service documents", () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(join(REPO, "schema", name), "utf8")) as {
      info: { title: string }
      servers: Array<{ url: string }>
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, unknown> }
    }

  const api = read("nport-node.openapi.json")
  const registry = read("nport-registry.openapi.json")

  it("keeps the registry's routes in its own document", () => {
    for (const route of REGISTRY_ROUTES) {
      expect(
        registry.paths[route.path]?.[route.method.toLowerCase()],
        `${route.method} ${route.path} missing from the registry document`,
      ).toBeDefined()
    }
  })

  it("points both documents at the one host, and still titles them apart", () => {
    // **This used to assert two different hosts** — ADR-0046's original argument for two documents.
    // ADR-0049 put both services behind one gateway on one hostname, so that argument is gone and the
    // documents now stand on the two assertions below instead.
    expect(api.servers[0]?.url).toBe("https://api.nport.link")
    expect(registry.servers[0]?.url).toBe("https://api.nport.link")
    expect(api.info.title).not.toBe(registry.info.title)
  })

  it("keeps the two path spaces disjoint, which is what makes one host work", () => {
    // The gateway dispatches on the path prefix, so an overlap is not a documentation problem — it is
    // a request nobody can route. Every registry path must be under `/v1/nodes`, and no node path may
    // be. `GET /v1/challenge` is the case that forced this: both services had one, signed with
    // deliberately different secrets, so the registry's moved to `/v1/nodes/challenge`.
    for (const path of Object.keys(registry.paths)) {
      expect(path, `${path} is a registry route outside /v1/nodes`).toMatch(/^\/v1\/nodes/)
    }
    for (const path of Object.keys(api.paths)) {
      expect(path, `${path} is a node route inside the registry's space`).not.toMatch(
        /^\/v1\/nodes/,
      )
    }
  })

  it("does not leak node routes into the control-plane document", () => {
    expect(Object.keys(api.paths)).not.toContain("/v1/nodes")
    expect(Object.keys(registry.paths)).not.toContain("/v1/tunnels")
  })

  it("gives each document only the components it reaches", () => {
    expect(Object.keys(registry.components.schemas)).toContain("Node")
    expect(Object.keys(registry.components.schemas)).not.toContain("CreateTunnelRequest")
    expect(Object.keys(api.components.schemas)).not.toContain("Node")
    // `Error` is in both, because every route in both can fail.
    expect(Object.keys(api.components.schemas)).toContain("Error")
    expect(Object.keys(registry.components.schemas)).toContain("Error")
  })

  it("references a nested component rather than copying it", () => {
    // What the zod registry buys, and what `cargo xtask codegen` needs in order to emit `Vec<Node>`
    // instead of inventing a name for an anonymous object.
    const list = registry.components.schemas.NodeListResponse as {
      properties: { nodes: { items: { $ref?: string } } }
    }
    expect(list.properties.nodes.items.$ref).toBe("#/components/schemas/Node")

    const node = registry.components.schemas.Node as {
      properties: { status: { $ref?: string } }
    }
    expect(node.properties.status.$ref).toBe("#/components/schemas/NodeStatus")
  })

  it("still resolves every ref it emits", () => {
    // A `$ref` to a component the document filtered out would be a broken document — the failure
    // mode the reachability walk in `componentsFor` exists to avoid.
    for (const document of [api, registry]) {
      const names = new Set(Object.keys(document.components.schemas))
      const refs = JSON.stringify(document).match(/#\/components\/schemas\/[A-Za-z]+/g) ?? []
      for (const ref of refs) {
        expect(names, `${ref} does not resolve`).toContain(ref.split("/").pop())
      }
    }
  })

  it("leaves the control plane's own route table untouched", () => {
    // Federation is additive to `contract-v1`; nothing existing changes shape.
    for (const route of ROUTES) {
      expect(api.paths[route.path]?.[route.method.toLowerCase()]).toBeDefined()
    }
  })
})
