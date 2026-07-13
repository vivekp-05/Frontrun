/**
 * Frontrun — Workstream D · Webhook handlers
 * ------------------------------------------
 * The "nervous system" that connects send.ts and triage.ts into the live loop
 * and drives the back half of the state machine (PRD §8).
 *
 *   Resend delivery events   -> SENT -> DELIVERED -> (OPENED)   | bounced -> LOST
 *   Resend inbound reply     -> REPLIED -> triage -> GREEN/YELLOW/RED
 *                                       -> FOLLOW_UP_DRAFTED    | red -> LOST
 *   Cal.com BOOKING_CREATED  -> BOOKED
 *
 * Design (locked game plan):
 *   - Framework-agnostic: handlers take an already-parsed JSON payload + deps,
 *     so the same code mounts as a Next.js route OR an InsForge edge function.
 *     The thin HTTP adapter (read body, verify signature, 200) is A/C's to add.
 *   - All persistence goes through the shared `StoreProvider` (A's contract).
 *   - Idempotent: replayed/duplicate webhooks never throw or double-advance.
 *   - A reply PROVES delivery, so an inbound reply first ensures DELIVERED —
 *     this survives the real-world race where the reply beats the delivery ping.
 */

import type {
  EmailDraft,
  Lead,
  LeadStatus as LeadStatusType,
  ReplyClassification,
  ReplyEvent,
  StoreProvider,
} from "@shared/types"
import { LeadStatus } from "@shared/types"
import { triage as defaultTriage, type TriageOptions } from "./triage"

// ---------------------------------------------------------------------------
// Deps + result
// ---------------------------------------------------------------------------

export type TriageRunner = (
  reply: Pick<ReplyEvent, "id" | "receivedAt" | "from" | "rawText">,
  lead: Lead,
  opts?: TriageOptions,
) => Promise<ReplyEvent>

export interface WebhookDeps {
  store: StoreProvider
  /** Injectable so tests can stub the LLM. Defaults to the real triage(). */
  triage?: TriageRunner
  triageOpts?: TriageOptions
  now?: () => string
}

export interface WebhookResult {
  ok: boolean
  /** What happened, for logs / the on-screen "activity" feed. */
  action: string
  leadId?: string
  status?: LeadStatusType
  classification?: ReplyClassification
  note?: string
}

const iso = (deps: WebhookDeps) => (deps.now ? deps.now() : new Date().toISOString())

// ---------------------------------------------------------------------------
// Transition helpers (idempotent + contract-safe)
// ---------------------------------------------------------------------------

/**
 * Advance a lead only if the move is legal; no-op if it's already at/past the
 * target. Returns the resulting lead. Never throws on a duplicate webhook.
 */
async function advance(
  store: StoreProvider,
  leadId: string,
  to: LeadStatusType,
): Promise<{ lead: Lead; moved: boolean }> {
  const lead = await store.getLead(leadId)
  if (!lead) throw new Error(`no lead ${leadId}`)
  if (lead.status === to) return { lead, moved: false }
  try {
    const next = await store.transition(leadId, to)
    return { lead: next, moved: true }
  } catch {
    // Illegal from the current state (e.g. duplicate/out-of-order event) — skip.
    return { lead, moved: false }
  }
}

async function mergeOutreach(
  store: StoreProvider,
  lead: Lead,
  patch: Partial<NonNullable<Lead["outreach"]>>,
): Promise<Lead> {
  return store.upsertLead({
    ...lead,
    outreach: { ...(lead.outreach ?? {}), ...patch },
  })
}

// ---------------------------------------------------------------------------
// Resend webhook — delivery telemetry + inbound replies
// ---------------------------------------------------------------------------

export async function handleResendWebhook(
  payload: any,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  const type: string = payload?.type ?? payload?.event ?? ""
  const data = payload?.data ?? payload

  switch (type) {
    case "email.delivered":
      return onDelivered(data, deps)
    case "email.opened":
      return onOpened(data, deps)
    case "email.bounced":
    case "email.complained":
      return onBounce(data, deps, type)
    case "email.received": // inbound reply from the prospect
      return onInboundReply(data, deps)
    default:
      return { ok: true, action: "ignored", note: `unhandled type "${type}"` }
  }
}

async function onDelivered(data: any, deps: WebhookDeps): Promise<WebhookResult> {
  const leadId = extractOutboundLeadId(data)
  if (!leadId) return { ok: true, action: "delivered:unmatched" }
  const { lead } = await advance(deps.store, leadId, LeadStatus.DELIVERED)
  await mergeOutreach(deps.store, lead, { deliveredAt: iso(deps) })
  return { ok: true, action: "delivered", leadId, status: LeadStatus.DELIVERED }
}

async function onOpened(data: any, deps: WebhookDeps): Promise<WebhookResult> {
  const leadId = extractOutboundLeadId(data)
  if (!leadId) return { ok: true, action: "opened:unmatched" }
  // Opened is directional only (pixel unreliable) — record time, best-effort move.
  const { lead } = await advance(deps.store, leadId, LeadStatus.OPENED)
  await mergeOutreach(deps.store, lead, { openedAt: iso(deps) })
  return { ok: true, action: "opened", leadId, status: lead.status }
}

async function onBounce(
  data: any,
  deps: WebhookDeps,
  type: string,
): Promise<WebhookResult> {
  const leadId = extractOutboundLeadId(data)
  if (!leadId) return { ok: true, action: `${type}:unmatched` }
  const { lead } = await advance(deps.store, leadId, LeadStatus.LOST)
  return {
    ok: true,
    action: type,
    leadId,
    status: lead.status,
    note: "bounced/complained → LOST",
  }
}

/**
 * The reply-loop wow. Map the inbound email to its lead, record the raw reply,
 * run triage, and drive REPLIED → GREEN/YELLOW/RED → FOLLOW_UP_DRAFTED / LOST.
 */
async function onInboundReply(
  data: any,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  const leadId = await resolveInboundLeadId(data, deps.store)
  if (!leadId) {
    return { ok: true, action: "reply:unmatched", note: "no lead for inbound" }
  }

  let lead = await deps.store.getLead(leadId)
  if (!lead) return { ok: true, action: "reply:unmatched", leadId }

  // A reply proves delivery — make sure we're at least DELIVERED first, so the
  // REPLIED transition is legal even if the delivery webhook never/late arrived.
  if (lead.status === LeadStatus.SENT) {
    ;({ lead } = await advance(deps.store, leadId, LeadStatus.DELIVERED))
    lead = await mergeOutreach(deps.store, lead, {
      deliveredAt: lead.outreach?.deliveredAt ?? iso(deps),
    })
  }

  // Record the raw inbound reply before triage (honesty: real text, kept).
  const rawReply: ReplyEvent = {
    id: String(data?.email_id ?? data?.id ?? `reply_${Date.now()}`),
    receivedAt: iso(deps),
    from: extractFromEmail(data) ?? "unknown",
    rawText: extractReplyText(data),
  }
  lead = await deps.store.upsertLead({
    ...lead,
    replies: [...(lead.replies ?? []), rawReply],
  })

  const { moved } = await advance(deps.store, leadId, LeadStatus.REPLIED)
  if (!moved && lead.status !== LeadStatus.REPLIED) {
    // Couldn't reach REPLIED (already classified?) — still ran, report state.
    return { ok: true, action: "reply:duplicate", leadId, status: lead.status }
  }

  // --- Triage ---
  const runTriage = deps.triage ?? (defaultTriage as TriageRunner)
  const triaged = await runTriage(rawReply, lead, deps.triageOpts)

  // Persist the enriched reply (summary/classification/nextStepDraft).
  lead = await replaceReply(deps.store, leadId, triaged)

  const classification = triaged.classification ?? "yellow"
  const targetClass: LeadStatusType =
    classification === "green"
      ? LeadStatus.GREEN
      : classification === "red"
        ? LeadStatus.RED
        : LeadStatus.YELLOW
  ;({ lead } = await advance(deps.store, leadId, targetClass))

  // Next step per class.
  if (classification === "red") {
    ;({ lead } = await advance(deps.store, leadId, LeadStatus.LOST))
    return {
      ok: true,
      action: "triaged",
      leadId,
      status: LeadStatus.LOST,
      classification,
      note: "not interested → stop (opt-out respected)",
    }
  }

  // green / yellow → we have a drafted next step.
  if (triaged.nextStepDraft) {
    ;({ lead } = await advance(deps.store, leadId, LeadStatus.FOLLOW_UP_DRAFTED))
  }
  return {
    ok: true,
    action: "triaged",
    leadId,
    status: lead.status,
    classification,
    note: triaged.nextStepDraft ? "next-step draft ready" : "classified",
  }
}

/** Swap the matching stored reply for its triaged version (or append). */
async function replaceReply(
  store: StoreProvider,
  leadId: string,
  triaged: ReplyEvent,
): Promise<Lead> {
  const lead = await store.getLead(leadId)
  if (!lead) throw new Error(`no lead ${leadId}`)
  const replies = [...(lead.replies ?? [])]
  const idx = replies.findIndex((r) => r.id === triaged.id)
  if (idx >= 0) replies[idx] = triaged
  else replies.push(triaged)
  return store.upsertLead({ ...lead, replies })
}

// ---------------------------------------------------------------------------
// Cal.com webhook — booking detection
// ---------------------------------------------------------------------------

export async function handleCalcomWebhook(
  payload: any,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  const trigger: string = payload?.triggerEvent ?? payload?.event ?? ""
  if (trigger !== "BOOKING_CREATED") {
    return { ok: true, action: "ignored", note: `unhandled trigger "${trigger}"` }
  }

  const booking = payload?.payload ?? payload
  const leadId = await resolveBookingLeadId(booking, deps.store)
  if (!leadId) return { ok: true, action: "booking:unmatched" }

  const { lead } = await advance(deps.store, leadId, LeadStatus.BOOKED)
  await mergeOutreach(deps.store, lead, {
    bookedAt: booking?.startTime ?? iso(deps),
  })
  return { ok: true, action: "booked", leadId, status: LeadStatus.BOOKED }
}

// ---------------------------------------------------------------------------
// Payload extractors (defensive — real shapes vary; validated at deploy)
// ---------------------------------------------------------------------------

/** Outbound events carry our lead-id tag + header. Read whichever is present. */
export function extractOutboundLeadId(data: any): string | undefined {
  // tags as array of {name,value}
  const tags = data?.tags
  if (Array.isArray(tags)) {
    const t = tags.find((x: any) => x?.name === "lead_id")
    if (t?.value) return String(t.value)
  }
  // tags as a flat object { lead_id: "..." }
  if (tags && typeof tags === "object" && tags.lead_id) return String(tags.lead_id)
  // header fallback
  const headers = data?.headers
  if (Array.isArray(headers)) {
    const h = headers.find(
      (x: any) => String(x?.name).toLowerCase() === "x-frontrun-lead-id",
    )
    if (h?.value) return String(h.value)
  }
  if (headers && typeof headers === "object") {
    const v = headers["X-Frontrun-Lead-Id"] ?? headers["x-frontrun-lead-id"]
    if (v) return String(v)
  }
  return undefined
}

/** Inbound: read the lead id off our plus-addressed recipient (dana+ID@...). */
export function parsePlusLeadId(toField: any): string | undefined {
  const addrs: string[] = Array.isArray(toField)
    ? toField.map(addrString)
    : [addrString(toField)]
  for (const a of addrs) {
    const m = a.match(/\+([A-Za-z0-9_-]+)@/)
    if (m) return m[1]
  }
  return undefined
}

/** Resolve inbound reply → lead id: plus-address first, then from-email match. */
export async function resolveInboundLeadId(
  data: any,
  store: StoreProvider,
): Promise<string | undefined> {
  const plus = parsePlusLeadId(data?.to)
  if (plus) return plus
  // Fallback: match the sender to a live lead's contact email.
  const from = extractFromEmail(data)
  if (!from) return undefined
  const leads = await store.listLeads()
  const active = new Set<LeadStatusType>([
    LeadStatus.SENT,
    LeadStatus.DELIVERED,
    LeadStatus.OPENED,
  ])
  const hit = leads.find(
    (l) =>
      l.contact?.email?.toLowerCase() === from.toLowerCase() &&
      active.has(l.status),
  )
  return hit?.id
}

/** Cal.com booking → lead id: metadata.leadId first, then attendee email. */
export async function resolveBookingLeadId(
  booking: any,
  store: StoreProvider,
): Promise<string | undefined> {
  const metaId = booking?.metadata?.leadId ?? booking?.metadata?.lead_id
  if (metaId) return String(metaId)
  const attendeeEmail: string | undefined =
    booking?.attendees?.[0]?.email ?? booking?.responses?.email?.value
  if (!attendeeEmail) return undefined
  const leads = await store.listLeads()
  const hit = leads.find(
    (l) => l.contact?.email?.toLowerCase() === attendeeEmail.toLowerCase(),
  )
  return hit?.id
}

function addrString(v: any): string {
  if (!v) return ""
  if (typeof v === "string") return v
  if (typeof v === "object") return String(v.email ?? v.address ?? "")
  return String(v)
}

function extractFromEmail(data: any): string | undefined {
  const raw = addrString(data?.from) || addrString(data?.sender)
  if (!raw) return undefined
  // "Name <a@b.com>" -> a@b.com
  const m = raw.match(/<([^>]+)>/)
  return (m ? m[1] : raw).trim() || undefined
}

function extractReplyText(data: any): string {
  const text = data?.text ?? data?.body?.text ?? ""
  if (text) return stripQuotedTail(String(text))
  const html = data?.html ?? data?.body?.html ?? ""
  if (html) return stripQuotedTail(String(html).replace(/<[^>]+>/g, " "))
  return String(data?.subject ?? "")
}

/** Trim the quoted original ("On ... wrote:") so triage sees just the new text. */
function stripQuotedTail(s: string): string {
  const cut = s.search(/\n?On .+wrote:|\n>+ |-----Original Message-----/)
  const body = cut > 0 ? s.slice(0, cut) : s
  return body.replace(/\s+\n/g, "\n").trim()
}

export const __internals = {
  advance,
  extractReplyText,
  stripQuotedTail,
  extractFromEmail,
}
