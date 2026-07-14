/**
 * Frontrun — HydraDB memory adapter · detection graph write.
 *
 * `recordDetection(lead)` writes one memory per detected Form D lead AND the
 * explicit relationship edges (company / founder(s) / round) via the
 * `graphPayload` field on `context.ingest` — HydraDB's supported way to declare
 * edges at ingest time (NOT the Bring-Your-Own-Graph path).
 *
 * graphPayload shape (per HydraDB v2 docs):
 *   { [sourceId]: { entities: { key: {name,type,namespace,identifier?} },
 *                   relations: [ {source,target,predicate,context?} ] } }
 * The sourceId is stable per lead so re-ingestion upserts rather than duplicates.
 */
import type { Lead } from "../../shared/types"
import { memoryClient, type IngestRequest, type MemoryClient } from "./client"
import { readMemoryConfig, type MemoryConfig } from "./config"
import { errMsg } from "./util"

/** Outcome of a fail-soft memory write. `skipped` = adapter disabled (no key). */
export interface MemoryWriteResult {
  written: boolean
  skipped: boolean
  sourceId?: string
  error?: string
}

interface GraphEntity {
  name: string
  type: string
  namespace: string
  identifier?: string
}
interface GraphRelation {
  source: string
  target: string
  predicate: string
  context?: string
}
interface GraphSource {
  entities: Record<string, GraphEntity>
  relations: GraphRelation[]
}
type GraphPayload = Record<string, GraphSource>

export interface RecordDetectionOptions {
  client?: MemoryClient
  config?: MemoryConfig
}

/**
 * Store the detected company + founder(s) + round as a memory with graph edges.
 * Fail-soft: never throws into the caller — returns `written: false` on any error
 * so a HydraDB hiccup can't break the detection pipeline.
 */
export async function recordDetection(
  lead: Lead,
  options: RecordDetectionOptions = {},
): Promise<MemoryWriteResult> {
  const client = options.client ?? memoryClient()
  const config = options.config ?? readMemoryConfig()
  if (!client.enabled) return { written: false, skipped: true }

  try {
    const sourceId = `detection:${lead.id}`
    await client.ingest(buildDetectionIngest(lead, sourceId, config))
    return { written: true, skipped: false, sourceId }
  } catch (err) {
    return { written: false, skipped: false, error: errMsg(err) }
  }
}

/** Pure request builder — exported so the payload is unit-tested without a client. */
export function buildDetectionIngest(
  lead: Lead,
  sourceId: string,
  config: MemoryConfig,
): IngestRequest {
  const signal = lead.signal
  const founders = (signal.relatedPersons ?? []).map((n) => n.trim()).filter(Boolean)

  const memory = {
    id: sourceId,
    title: `Detection · ${signal.companyName}`,
    text: detectionText(lead, founders),
    // Both metadata + additional_metadata are plain objects — HydraDB rejects
    // stringified maps here (the whole `memories` array is stringified once, below).
    metadata: {
      kind: "detection",
      leadId: lead.id,
      company: signal.companyName,
    },
    additional_metadata: {
      filedAt: signal.filedAt,
      amountRaised: signal.amountRaised ?? null,
      edgarUrl: signal.edgarUrl ?? null,
      accessionNumber: signal.accessionNumber,
    },
  }

  return {
    tenantId: config.database,
    subTenantId: config.collection,
    type: "memory",
    upsert: "true",
    memories: JSON.stringify([memory]),
    graphPayload: JSON.stringify(buildDetectionGraph(lead, sourceId, founders)),
  }
}

function buildDetectionGraph(lead: Lead, sourceId: string, founders: string[]): GraphPayload {
  const signal = lead.signal
  const entities: Record<string, GraphEntity> = {
    company: {
      name: signal.companyName,
      type: "COMPANY",
      namespace: "companies",
      identifier: signal.accessionNumber,
    },
  }
  const relations: GraphRelation[] = []

  founders.forEach((name, i) => {
    const key = `founder_${i}`
    entities[key] = { name, type: "PERSON", namespace: "founders" }
    relations.push({
      source: key,
      target: "company",
      predicate: "FOUNDED",
      context: `${name} is named on the Form D filing for ${signal.companyName}.`,
    })
  })

  if (signal.amountRaised || signal.edgarUrl) {
    entities.round = {
      name: signal.amountRaised
        ? `${signal.companyName} ${signal.amountRaised} round`
        : `${signal.companyName} round`,
      type: "FUNDING_ROUND",
      namespace: "rounds",
      identifier: signal.edgarUrl ?? signal.accessionNumber,
    }
    relations.push({
      source: "company",
      target: "round",
      predicate: "RAISED",
      context: signal.amountRaised
        ? `${signal.companyName} raised ${signal.amountRaised}.`
        : `${signal.companyName} filed a Form D.`,
    })
  }

  return { [sourceId]: { entities, relations } }
}

function detectionText(lead: Lead, founders: string[]): string {
  const s = lead.signal
  const amount = s.amountRaised ? ` Amount raised: ${s.amountRaised}.` : ""
  const who = founders.length ? ` Named on the filing: ${founders.join(", ")}.` : ""
  return `${s.companyName} filed SEC Form D (${s.accessionNumber}) on ${s.filedAt}.${amount}${who}`.trim()
}
