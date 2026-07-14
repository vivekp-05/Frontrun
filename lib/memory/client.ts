/**
 * Frontrun — HydraDB memory adapter · client.
 *
 * Lazy singleton around the official `@hydradb/sdk` HydraDBClient, behind a
 * narrow `MemoryClient` interface. When no API key is configured, callers get a
 * `NoopMemoryClient` that returns empty results and never touches the network —
 * so detect/draft/reply stay safe with zero configuration, and tests run offline
 * (this mirrors store.ts flipping between InMemoryStore and InsforgeStore).
 *
 * `createMemoryClient()` accepts an injectable `fetch` so tests can exercise the
 * real SDK path against a canned Response without a live call.
 */
import { HydraDBClient } from "@hydradb/sdk"
import type { HydraDB } from "@hydradb/sdk"
import { readMemoryConfig, type MemoryConfig } from "./config"

export type IngestRequest = HydraDB.IngestContextRequest
export type QueryRequest = HydraDB.SearchQueryRequest
export type RetrievalResult = HydraDB.SearchV2RetrievalResult

/** The only two HydraDB operations this adapter needs. Both real + no-op honor it. */
export interface MemoryClient {
  /** False for the no-op stub; lets callers skip work without a network probe. */
  readonly enabled: boolean
  ingest(request: IngestRequest): Promise<void>
  query(request: QueryRequest): Promise<RetrievalResult | undefined>
}

export interface MemoryClientDeps {
  /** Injectable fetch — for tests or runtimes without a built-in fetch. */
  fetchImpl?: typeof fetch
}

class SdkMemoryClient implements MemoryClient {
  readonly enabled = true
  private readonly client: HydraDBClient

  constructor(config: MemoryConfig, deps: MemoryClientDeps = {}) {
    this.client = new HydraDBClient({
      token: config.apiKey as string,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
    })
  }

  async ingest(request: IngestRequest): Promise<void> {
    await this.client.context.ingest(request)
  }

  async query(request: QueryRequest): Promise<RetrievalResult | undefined> {
    const envelope = await this.client.query(request)
    return envelope.data
  }
}

class NoopMemoryClient implements MemoryClient {
  readonly enabled = false
  async ingest(): Promise<void> {
    /* no key configured — intentionally does nothing */
  }
  async query(): Promise<RetrievalResult | undefined> {
    return undefined
  }
}

/** Build a client for an explicit config (used by the smoke script + tests). */
export function createMemoryClient(
  config: MemoryConfig = readMemoryConfig(),
  deps: MemoryClientDeps = {},
): MemoryClient {
  if (!config.enabled || !config.apiKey) return new NoopMemoryClient()
  return new SdkMemoryClient(config, deps)
}

let singleton: MemoryClient | undefined

/** The default process-wide client, built lazily from env on first use. */
export function memoryClient(): MemoryClient {
  return (singleton ??= createMemoryClient())
}
