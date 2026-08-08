import { invoke } from "@tauri-apps/api/core"

/**
 * `~/.nport/config.toml`, the same file the CLI reads (ADR-0051).
 *
 * Every field is optional: the file sets defaults, it does not require anything.
 */
export interface Settings {
  subdomain?: string | null
  backend?: string | null
  registry?: string | null
  node?: string | null
  lang?: string | null
  port?: number | null
}

export async function readSettings(): Promise<Settings> {
  return await invoke<Settings>("read_settings")
}

export async function writeSettings(settings: Settings): Promise<void> {
  await invoke("write_settings", { settings })
}
