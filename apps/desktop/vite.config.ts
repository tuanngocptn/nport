import { fileURLToPath, URL } from "node:url"

import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { version } from "./src-tauri/tauri.conf.json"

/**
 * Vite serves the WebView; `tauri dev` starts this and then launches the window against it.
 *
 * The port is **fixed and `strictPort`**: `src-tauri/tauri.conf.json` hardcodes `devUrl`, so a Vite
 * that quietly shifted to 1421 because something else held 1420 would leave the window pointing at
 * nothing — with no error, because the config is still valid.
 */
export default defineConfig({
  plugins: [react()],
  // The sidebar's version block, from the same value the installer and the updater use. Read from
  // `tauri.conf.json` rather than `package.json`: the app's version is the bundle's, and the two
  // would drift the first time only one was bumped.
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 1420,
    strictPort: true,
    // The Rust side rebuilds on its own; watching it here means every `cargo` write triggers a
    // full page reload in the WebView for a change the frontend cannot see.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    outDir: "dist",
    // Matches the WebViews we actually ship against, the oldest of which is WebKitGTK.
    target: "es2022",
  },
})
