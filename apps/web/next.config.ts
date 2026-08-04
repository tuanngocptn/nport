import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare"
import type { NextConfig } from "next"

const config: NextConfig = {
  reactStrictMode: true,
  // `@nport/contract` and `@nport/design-tokens` ship TypeScript and CSS source rather than a build
  // step — one definition, no build-order dependency between a package and its consumers
  // (ADR-0014). Next has to be told to compile them, or it treats them as pre-built node_modules
  // and hands raw TS to the runtime.
  transpilePackages: ["@nport/contract", "@nport/design-tokens"],
  // A type error must fail the build. It is the default, and it is stated because the opposite is
  // one line away and the failure it hides reaches production. There is no `eslint` key to match:
  // Next 16 removed the built-in lint step, and Biome is the linter here anyway (ADR-0013).
  typescript: { ignoreBuildErrors: false },
  experimental: {
    // The workspace is on TypeScript 7, whose compiler API Next cannot call — it expects the TS 6
    // shape and throws an unhandled rejection on the first type check, which in `next dev` means
    // the server accepts connections and then never answers one. This tells Next to shell out to
    // the `tsc` CLI instead, which is version-agnostic.
    //
    // The alternative was pinning apps/web to TypeScript 6, i.e. two TypeScript majors in one
    // workspace with `@nport/contract` type-checked by both. That is a worse trade than an
    // experimental flag whose failure mode is a slower type check.
    useTypeScriptCli: true,
  },
}

// Wires the Worker bindings into `next dev`. Without it `getCloudflareContext()` is empty in
// development and every binding-backed route works in production and nowhere else
// (apps/web/CLAUDE.md § Gotchas). Called at module scope on purpose — Next evaluates this file
// before it serves anything.
void initOpenNextCloudflareForDev()

export default config
