/**
 * Frontrun — HydraDB memory adapter · recall before drafting.
 *
 * `recallContext(lead)` asks HydraDB for everything known about this company and
 * its founders — prior memories plus graph relationships — so the drafter can
 * reference real history instead of cold-emailing blind. Uses the unified query
 * with `type: "all"`, `mode: "thinking"` (pulls linked memories) and
 * `graphContext: true` (returns the traversed triplets).
 *
 * Fail-soft: any error / disabled adapter yields an empty, well-formed result.
 */
import type { Lead } from "../../shared/types"
import {
  memoryClient,
  type MemoryClient,
  type QueryRequest,
  type RetrievalResult,
} from "./client"
import { readMemoryConfig, type MemoryConfig } from "./config"
import { asString, dedupe, errMsg } from "./util"

/** A directed graph edge, flattened for the drafter. */
export interface MemoryTriplet {
  source: string
  predicate: string
  target: string
}

export interface RecalledContext {
  /** True when any memory chunk or graph triplet came back. */
  found: boolean
  /** Adapter disabled (no key) — distinct from "found nothing". */
  skipped: boolean
  /** Prior memory/knowledge chunk texts, de-duplicated. */
  memories: string[]
  /** Graph edges connecting the company/founders to related entities. */
  triplets: MemoryTriplet[]
  /** HydraDB's synthesized graph summary, when present. */
  synthesis?: string
  error?: string
}

export interface RecallOptions {
  client?: MemoryClient
  config?: MemoryConfig
  maxResults?: number
}

function empty(patch: Partial<RecalledContext> = {}): RecalledContext {
  return { found: false, skipped: false, memories: [], triplets: [], ...patch }
}

export async function recallContext(
  lead: Lead,
  options: RecallOptions = {},
): Promise<RecalledContext> {
  const client = options.client ?? memoryClient()
  const config = options.config ?? readMemoryConfig()
  if (!client.enabled) return empty({ skipped: true })

  try {
    const result = await client.query(buildRecallQuery(lead, config, options.maxResults))
    return parseRecall(result)
  } catch (err) {
    return empty({ error: errMsg(err) })
  }
}

/** Pure query builder — exported for unit tests. */
export function buildRecallQuery(
  lead: Lead,
  config: MemoryConfig,
  maxResults = 8,
): QueryRequest {
  const s = lead.signal
  const founders = (s.relatedPersons ?? []).filter(Boolean).join(", ")
  const query =
    `Prior context, outreach history, and relationships for ${s.companyName}` +
    (founders ? ` and founders ${founders}.` : ".")
  return {
    database: config.database,
    collection: config.collection,
    type: "all",
    query,
    mode: "thinking",
    graphContext: true,
    maxResults,
  }
}

/** Pure result parser — exported so recall parsing is tested without a client. */
export function parseRecall(result: RetrievalResult | undefined): RecalledContext {
  if (!result) return empty()
  const memories = collectChunks(result)
  const triplets = collectTriplets(result)
  const synthesis = asString(result.graphContext?.synthesisContext) || undefined
  return {
    found: memories.length > 0 || triplets.length > 0,
    skipped: false,
    memories,
    triplets,
    synthesis,
  }
}

function collectChunks(result: RetrievalResult): string[] {
  const texts: string[] = []
  for (const chunk of result.chunks ?? []) {
    const text = asString(chunk.chunkContent)
    if (text) texts.push(text)
  }
  for (const chunk of Object.values(result.additionalContext ?? {})) {
    const text = asString(chunk?.chunkContent)
    if (text) texts.push(text)
  }
  return dedupe(texts)
}

function collectTriplets(result: RetrievalResult): MemoryTriplet[] {
  const paths = [
    ...(result.graphContext?.queryPaths ?? []),
    ...(result.graphContext?.chunkRelations ?? []),
  ]
  const out: MemoryTriplet[] = []
  for (const path of paths) {
    for (const triplet of path.triplets ?? []) {
      const source = nodeName(triplet.source)
      const target = nodeName(triplet.target)
      if (!source || !target) continue
      out.push({ source, predicate: predicateName(triplet.relation), target })
    }
  }
  return dedupeTriplets(out)
}

function nodeName(node: Record<string, unknown> | undefined): string {
  return asString(node?.name) || asString(node?.["canonical_name"])
}

function predicateName(relation: Record<string, unknown> | undefined): string {
  return (
    asString(relation?.["canonicalPredicate"]) ||
    asString(relation?.["canonical_predicate"]) ||
    asString(relation?.predicate) ||
    "related_to"
  )
}

function dedupeTriplets(triplets: MemoryTriplet[]): MemoryTriplet[] {
  const seen = new Set<string>()
  return triplets.filter((t) => {
    const key = `${t.source}|${t.predicate}|${t.target}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
