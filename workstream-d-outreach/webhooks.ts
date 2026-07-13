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
import type { TriageOptions } from "./triage"
import { bandTriageRunner } from "./band"

// ---------------------------------------------------------------------------
// Deps + result
// ---------------------------------------------------------------------------

export type TriageRunner = (
  reply: Pick<ReplyEvent, "id" | "receivedAt" | "from" | "rawText">,
  lead: Lead,
  opts?: TriageOptions,
) => Promise<ReplyEvent>

/**
 * Default reply-triage = the Band-coordinated agent (Summarizer → Classifier →
 * Drafter). It's always safe as a default: when Band isn't configured it runs the
 * in-process local coordinator, and any reasoning failure degrades to the
 * deterministic mock (triage() catches it). Override per-call with WebhookDeps.triage
 * — e.g. to attach an onCoordination sink for the activity feed.
 */
const defaultTriage: TriageRunner = bandTriageRunner()

/**
 * Fetch the full inbound email body by id. Resend's `email.received` webhook
 * carries only metadata (no body/text), so the reply loop must pull the body
 * from the Received-emails API before triage. Injectable for tests; the default
 * (Resend-backed) is wired in by `createResendRoute` / `createResendInboundFetcher`.
 */
export type InboundFetcher = (emailId: string) => Promise<{
  text?: string
  html?: string
  from?: string
  subject?: string
} | null>

export interface WebhookDeps {
  store: StoreProvider
  /** Injectable so tests can stub the LLM. Defaults to the Band-coordinated triage. */
  triage?: TriageRunner
  triageOpts?: TriageOptions
  /** Fetch the inbound body when the webhook payload omits it (Resend inbound). */
  fetchInbound?: InboundFetcher
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
 * target. Returns the resulting lead (null when the lead doesn't exist — e.g.
 * a stale webhook after a store reset). Never throws on a duplicate webhook.
 */
async function advance(
  store: StoreProvider,
  leadId: string,
  to: LeadStatusType,
): Promise<{ lead: Lead | null; moved: boolean }> {
  const lead = await store.getLead(leadId)
  if (!lead) return { lead: null, moved: false }
  if (lead.status === to) return { lead, moved: false }
  try {
    const next = await store.transition(leadId, to)
    return { lead: next, moved: true }
  } catch (err) {
    // Only swallow contract violations (duplicate/out-of-order events). A real
    // store failure (network, 500) must surface so the provider retries.
    if ((err as Error)?.name?.includes("Transition") || /illegal transition/i.test(String((err as Error)?.message))) {
      return { lead, moved: false }
    }
    throw err
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
  if (!lead) return { ok: true, action: "delivered:unmatched", note: `no lead ${leadId}` }
  // Keep the FIRST delivery timestamp — replayed webhooks must not rewrite it.
  const saved = await mergeOutreach(deps.store, lead, {
    deliveredAt: lead.outreach?.deliveredAt ?? iso(deps),
  })
  return { ok: true, action: "delivered", leadId, status: saved.status }
}

async function onOpened(data: any, deps: WebhookDeps): Promise<WebhookResult> {
  const leadId = extractOutboundLeadId(data)
  if (!leadId) return { ok: true, action: "opened:unmatched" }
  // Opened is directional only (pixel unreliable) — record time, best-effort move.
  const { lead } = await advance(deps.store, leadId, LeadStatus.OPENED)
  if (!lead) return { ok: true, action: "opened:unmatched", note: `no lead ${leadId}` }
  await mergeOutreach(deps.store, lead, { openedAt: lead.outreach?.openedAt ?? iso(deps) })
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
  if (!lead) return { ok: true, action: `${type}:unmatched`, note: `no lead ${leadId}` }
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
    const adv = await advance(deps.store, leadId, LeadStatus.DELIVERED)
    if (!adv.lead) return { ok: true, action: "reply:unmatched", leadId }
    lead = await mergeOutreach(deps.store, adv.lead, {
      deliveredAt: adv.lead.outreach?.deliveredAt ?? iso(deps),
    })
  }

  // Resend's email.received carries only metadata — no body. When there's no
  // inline text, fetch the full email via the Received-emails API so triage sees
  // the actual reply (not just the subject). Falls back to the payload if we can't.
  let src = data
  const emailId = data?.email_id ?? data?.id
  const hasInlineBody = Boolean(data?.text || data?.body?.text || data?.html)
  if (!hasInlineBody && emailId && deps.fetchInbound) {
    const full = await deps.fetchInbound(String(emailId))
    if (full) src = { ...data, ...full } // fetched text/html/from/subject win
  }

  // Record the raw inbound reply before triage (honesty: real text, kept).
  const rawReply: ReplyEvent = {
    id: String(emailId ?? `reply_${Date.now()}`),
    receivedAt: iso(deps),
    from: extractFromEmail(src) ?? "unknown",
    rawText: extractReplyText(src),
  }
  // Idempotency: a replayed webhook (same event id) must not duplicate the reply.
  if ((lead.replies ?? []).some((r) => r.id === rawReply.id)) {
    return { ok: true, action: "reply:duplicate", leadId, status: lead.status }
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

  // --- Triage (Band-coordinated by default) ---
  const runTriage = deps.triage ?? defaultTriage
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
  lead = (await advance(deps.store, leadId, targetClass)).lead ?? lead

  // Next step per class.
  if (classification === "red") {
    lead = (await advance(deps.store, leadId, LeadStatus.LOST)).lead ?? lead
    return {
      ok: true,
      action: "triaged",
      leadId,
      status: lead.status,
      classification,
      note: "not interested → stop (opt-out respected)",
    }
  }

  // green / yellow → we have a drafted next step.
  if (triaged.nextStepDraft) {
    lead = (await advance(deps.store, leadId, LeadStatus.FOLLOW_UP_DRAFTED)).lead ?? lead
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

  const { lead, moved } = await advance(deps.store, leadId, LeadStatus.BOOKED)
  if (!lead) return { ok: true, action: "booking:unmatched", note: `no lead ${leadId}` }
  const booked = lead.status === LeadStatus.BOOKED
  if (booked) {
    await mergeOutreach(deps.store, lead, {
      bookedAt: lead.outreach?.bookedAt ?? booking?.startTime ?? iso(deps),
    })
  }
  // Honest status: report what the store actually says. A booking that arrives
  // before a reply (illegal jump) is surfaced, not claimed as BOOKED.
  return {
    ok: true,
    action: booked ? "booked" : "booking:out-of-order",
    leadId,
    status: lead.status,
    note: moved ? undefined : booked ? "replay — already booked" : `booking event at ${lead.status}`,
  }
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
