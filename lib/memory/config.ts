/**
 * Frontrun — HydraDB memory adapter · configuration.
 * Reads env once, with safe defaults. `enabled` is false whenever no API key is
 * present, so the whole adapter degrades to a no-op with zero configuration
 * (mirrors the store.ts InsForge-vs-in-memory flip).
 */

export interface MemoryConfig {
  /** HydraDB bearer token. Absent → adapter disabled (no-op). */
  apiKey?: string
  /** Optional custom API base URL; SDK default environment when unset. */
  baseUrl?: string
  /** HydraDB database (tenant) — the hard isolation boundary. */
  database: string
  /** HydraDB collection (sub-tenant) — per-seat / per-workspace scope. */
  collection: string
  /** True only when an API key is available. */
  enabled: boolean
}

const DEFAULT_DATABASE = "frontrun"
const DEFAULT_COLLECTION = "global"

/** Guarded env read (module also imports cleanly in non-Node runtimes). */
function env(name: string): string | undefined {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

/** Build the effective config. Overrides win over env; env wins over defaults. */
export function readMemoryConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  const apiKey = overrides.apiKey ?? env("HYDRA_DB_API_KEY")
  const baseUrl = overrides.baseUrl ?? env("HYDRA_DB_BASE_URL")
  const database = overrides.database ?? env("HYDRA_DB_DATABASE") ?? DEFAULT_DATABASE
  const collection = overrides.collection ?? env("HYDRA_DB_COLLECTION") ?? DEFAULT_COLLECTION
  const enabled = overrides.enabled ?? Boolean(apiKey)
  return { apiKey, baseUrl, database, collection, enabled }
}
