/**
 * Frontrun — HydraDB memory adapter · outcome write.
 *
 * `recordOutcome(lead, reply, classification)` writes the reply interaction and
 * its green/yellow/red verdict back to memory, and records a
 * contact —REPLIED_<VERDICT>→ company edge in the graph. This is what lets a
 * future recall know "we already heard back from this company, and how".
 *
 * Fail-soft: never throws into the caller (webhook path must not break on a
 * HydraDB error).
 */
import type { Lead, ReplyClassification, ReplyEvent } from "../../shared/types"
import { memoryClient, type IngestRequest, type MemoryClient } from "./client"
import { readMemoryConfig, type MemoryConfig } from "./config"
import { type MemoryWriteResult } from "./graph"
import { errMsg, snippet } from "./util"

/** The reply fields needed to record an outcome (a subset of ReplyEvent). */
export type OutcomeReply = Pick<ReplyEvent, "id" | "from" | "rawText"> &
  Partial<Pick<ReplyEvent, "receivedAt" | "summary">>

export interface RecordOutcomeOptions {
  client?: MemoryClient
  config?: MemoryConfig
}

export async function recordOutcome(
  lead: Lead,
  reply: OutcomeReply,
  classification: ReplyClassification,
  options: RecordOutcomeOptions = {},
): Promise<MemoryWriteResult> {
  const client = options.client ?? memoryClient()
  const config = options.config ?? readMemoryConfig()
  if (!client.enabled) return { written: false, skipped: true }

  try {
    const sourceId = `outcome:${lead.id}:${reply.id}`
    await client.ingest(buildOutcomeIngest(lead, reply, classification, sourceId, config))
    return { written: true, skipped: false, sourceId }
  } catch (err) {
    return { written: false, skipped: false, error: errMsg(err) }
  }
}

/** Pure request builder — exported for unit tests. */
export function buildOutcomeIngest(
  lead: Lead,
  reply: OutcomeReply,
  classification: ReplyClassification,
  sourceId: string,
  config: MemoryConfig,
): IngestRequest {
  const company = lead.signal.companyName
  const contactName = lead.contact?.name ?? reply.from
  const gist = reply.summary ?? snippet(reply.rawText)
  const verdict = classification.toUpperCase()

  const memory = {
    id: sourceId,
    title: `Outcome · ${company} · ${classification}`,
    text: `${contactName} at ${company} replied "${verdict}" to Frontrun outreach. ${gist}`,
    // Both metadata + additional_metadata are plain objects — HydraDB rejects
    // stringified maps here (the whole `memories` array is stringified once, below).
    metadata: {
      kind: "outcome",
      leadId: lead.id,
      company,
      classification,
    },
    additional_metadata: {
      replyId: reply.id,
      from: reply.from,
      receivedAt: reply.receivedAt ?? null,
    },
  }

  const graph = {
    [sourceId]: {
      entities: {
        company: {
          name: company,
          type: "COMPANY",
          namespace: "companies",
          identifier: lead.signal.accessionNumber,
        },
        contact: {
          name: contactName,
          type: "PERSON",
          // A resolved contact that matches a filing person is a founder; an
          // unknown replying address is just a contact.
          namespace: lead.contact?.name ? "founders" : "contacts",
        },
      },
      relations: [
        {
          source: "contact",
          target: "company",
          predicate: `REPLIED_${verdict}`,
          context: gist,
        },
      ],
    },
  }

  return {
    tenantId: config.database,
    subTenantId: config.collection,
    type: "memory",
    upsert: "true",
    memories: JSON.stringify([memory]),
    graphPayload: JSON.stringify(graph),
  }
}
