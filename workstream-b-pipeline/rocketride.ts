import { Lead, LeadStatus, StoreProvider } from "../shared/types"
import { IllegalTransitionError } from "../workstream-a-backend/stateMachine"
import { draftOutreach } from "./draft"
import { enrichContact, EnrichLeadOptions, researchLead } from "./enrich"
import { PipelineEnv } from "./env"
import { detectedLeadFromSignal, pollRecentFormD } from "./pollFormD"
import { scoreLead } from "./score"

export interface RocketRidePipelineInput {
  lead?: Lead
  domain?: string
  persist?: boolean
  includeFunds?: boolean
}

export interface RocketRidePipelineOutput {
  lead: Lead
  steps: Array<
    | "detected"
    | "posted"
    | "resumed"
    | "research_patched"
    | "email_patched"
    | "score_patched"
    | "draft_patched"
    | "enriched"
    | "verified"
    | "drafted"
    | "stored"
  >
}

export interface RocketRidePipelineOptions extends EnrichLeadOptions {
  env?: PipelineEnv
  store?: StoreProvider
}

export async function runRocketRidePipeline(
  input: RocketRidePipelineInput = {},
  options: RocketRidePipelineOptions = {},
): Promise<RocketRidePipelineOutput> {
  const steps: RocketRidePipelineOutput["steps"] = []
  const detectedSignals = input.lead
    ? []
    : await pollRecentFormD({ env: options.env, limit: 1, includeFunds: input.includeFunds })
  const signal = detectedSignals[0]
  const lead = input.lead ?? (signal ? detectedLeadFromSignal(signal) : undefined)

  if (!lead) {
    throw new Error("No recent Form D filings were returned by EDGAR")
  }

  steps.push("detected")

  const persist = Boolean(input.persist && options.store)
  const store = options.store
  let current = lead

  if (persist && store) {
    const existing = await store.getLead(current.id)
    if (existing && existing.status !== LeadStatus.DETECTED) {
      // Already in flight (possibly owned by D past DRAFTED) — never clobber it.
      steps.push("resumed")
      return { lead: existing, steps }
    }
    current = await store.upsertLead(existing ? { ...current, createdAt: existing.createdAt } : current)
    steps.push("posted")
  }

  current = await researchLead(current, { ...options, domain: input.domain })
  if (persist && store) {
    current = await persistData(store, current)
    steps.push("research_patched")
  }

  const enriched = await enrichContact(current, { ...options, domain: input.domain })
  steps.push("enriched")
  if (enriched.contact?.email && enriched.contact.emailConfidence !== "unverified") {
    // Only claimed when a verifier actually assigned a confidence tier.
    steps.push("verified")
  }
  current = enriched
  if (persist && store) {
    current = await persistData(store, enriched)
    current = await advanceStatus(store, current, LeadStatus.ENRICHED)
    steps.push("email_patched")
  }

  const scored = scoreLead(current)
  current = scored
  if (persist && store) {
    current = await persistData(store, scored)
    steps.push("score_patched")
  }

  const drafted = await draftOutreach(current)
  steps.push("drafted")
  current = drafted
  if (persist && store) {
    current = await persistData(store, drafted)
    current = await advanceStatus(store, current, LeadStatus.DRAFTED)
    steps.push("draft_patched")
    steps.push("stored")
  }

  return { lead: current, steps }
}

/**
 * Data-only write: merge the pipeline's fields but keep the STORE's current
 * status — status moves go exclusively through the state machine (A's rule).
 */
async function persistData(store: StoreProvider, lead: Lead): Promise<Lead> {
  const fresh = await store.getLead(lead.id)
  return store.upsertLead({ ...lead, status: fresh?.status ?? lead.status })
}

/** Advance via A's guarded transition; an already-past-it lead is a no-op. */
async function advanceStatus(store: StoreProvider, lead: Lead, to: LeadStatus): Promise<Lead> {
  try {
    return await store.transition(lead.id, to)
  } catch (err) {
    if (err instanceof IllegalTransitionError || /illegal transition/i.test(String((err as Error)?.message))) {
      return (await store.getLead(lead.id)) ?? lead
    }
    throw err
  }
}

export const rocketRideToolDefinition = {
  name: "frontrun_enrich_verify_draft",
  description:
    "Frontrun Track B RocketRide tool: take a detected Form D lead, research it, enrich contact data, verify email confidence, and draft first-touch outreach.",
  inputSchema: {
    type: "object",
    properties: {
      lead: { type: "object", description: "Lead with DETECTED status and Form D signal." },
      domain: { type: "string", description: "Optional company domain for email resolution." },
      persist: { type: "boolean", description: "Set true when a StoreProvider is wired by workstream A." },
      includeFunds: { type: "boolean", description: "Allow fund/LP filings instead of preferring operating companies." },
    },
  },
}
