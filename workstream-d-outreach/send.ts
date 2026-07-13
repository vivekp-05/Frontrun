/**
 * Frontrun — Workstream D · Outreach Send (Resend)
 * ------------------------------------------------
 * Implements `SendProvider.send(lead) -> OutreachStatus` (shared contract).
 * Sends the drafted outreach email via Resend and returns delivery telemetry
 * (messageId + sentAt). DELIVERED/OPENED arrive later via webhooks (Phase 2).
 *
 * Design (locked game plan):
 *   - Behind the `SendProvider` interface so the sponsor is swappable by config.
 *   - MOCK path (deterministic, no network) auto-engages when there's no Resend
 *     key — so the sandbox (which can't reach Resend) and pre-key runs stay green.
 *   - Pure of persistence: `send()` returns an `OutreachStatus`. The orchestration
 *     layer writes it back and calls A's `transition(id, SENT)`. We never mutate
 *     the store here — that keeps the merge boundary with A clean.
 *   - Every message is tagged with the lead id so inbound webhooks map events
 *     back to the right lead.
 *
 * Real path = Resend:  POST https://api.resend.com/emails   Bearer {RESEND_API_KEY}
 */

import { LeadStatus, type Lead, type OutreachStatus, type SendProvider, type StoreProvider } from "@shared/types"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SendOptions {
  /** Force the deterministic path. Auto-on when no Resend key is available. */
  mock?: boolean
  apiKey?: string
  /** Verified sender on the Resend domain. Replies must route back here. */
  fromEmail?: string
  /** Display name shown in the From header. */
  fromName?: string
  /** Resend API base (override for tests). */
  apiBase?: string
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

interface ResolvedSendOptions {
  mock: boolean
  apiKey?: string
  fromEmail: string
  fromName: string
  apiBase: string
  fetchImpl: typeof fetch
}

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined
}

function resolveOptions(opts: SendOptions = {}): ResolvedSendOptions {
  const apiKey = opts.apiKey ?? env("RESEND_API_KEY")
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch)
  const forceMock = opts.mock ?? env("MOCK_SEND") === "1"
  const canLive = Boolean(apiKey && fetchImpl)
  return {
    mock: forceMock === true ? true : !canLive,
    apiKey,
    fromEmail: opts.fromEmail ?? env("RESEND_FROM_EMAIL") ?? "dana@frontrun.dev",
    fromName: opts.fromName ?? env("FROM_NAME") ?? "Dana",
    apiBase: opts.apiBase ?? "https://api.resend.com",
    fetchImpl,
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export class SendError extends Error {
  constructor(
    message: string,
    readonly leadId: string,
  ) {
    super(message)
    this.name = "SendError"
  }
}

/** Resend tag values must match /^[A-Za-z0-9_-]+$/. Sanitize the lead id. */
function tagSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_")
}

/**
 * Plus-address the sender so the prospect's reply lands on a per-lead address
 * (dana+lead_demo_1@domain). The inbound webhook reads the lead id straight off
 * the `to` field — deterministic correlation, no guessing by from-email.
 */
export function replyToFor(fromEmail: string, leadId: string): string {
  const at = fromEmail.indexOf("@")
  if (at < 0) return fromEmail
  return `${fromEmail.slice(0, at)}+${tagSafe(leadId)}${fromEmail.slice(at)}`
}

function requireSendable(lead: Lead): { to: string; subject: string; body: string } {
  const to = lead.contact?.email
  if (!to) throw new SendError("lead has no contact email to send to", lead.id)
  if (!lead.draft) throw new SendError("lead has no draft to send", lead.id)
  const subject = lead.draft.subject?.trim()
  const body = lead.draft.body?.trim()
  if (!subject) throw new SendError("draft has no subject", lead.id)
  if (!body) throw new SendError("draft has no body", lead.id)
  return { to, subject, body }
}

/** Minimal, honest HTML wrapper — preserves the plain-text draft line breaks. */
function toHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;white-space:pre-wrap">${escaped}</div>`
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/** Build a SendProvider bound to the given options (real or mock). */
export function createSendProvider(opts: SendOptions = {}): SendProvider {
  const options = resolveOptions(opts)
  return {
    send: (lead: Lead) =>
      options.mock ? mockSend(lead, options) : resendSend(lead, options),
  }
}

/** Convenience: send one lead with ad-hoc options. */
export function send(lead: Lead, opts: SendOptions = {}): Promise<OutreachStatus> {
  return createSendProvider(opts).send(lead)
}

/**
 * Send many leads in PARALLEL — this is the "3 companies at once" demo moment.
 * Never rejects: returns a per-lead result so one failure can't sink the batch.
 */
export async function sendMany(
  leads: Lead[],
  opts: SendOptions = {},
): Promise<Array<{ leadId: string; status?: OutreachStatus; error?: string }>> {
  const provider = createSendProvider(opts)
  return Promise.all(
    leads.map(async (lead) => {
      try {
        const status = await provider.send(lead)
        return { leadId: lead.id, status }
      } catch (err) {
        return { leadId: lead.id, error: (err as Error).message }
      }
    }),
  )
}

/**
 * The "Run outreach" entry point: send each lead, persist telemetry, and advance
 * it to SENT via A's store — all in parallel. This is what the dashboard button
 * calls. Never rejects; returns a per-lead result.
 */
export async function runOutreach(
  leads: Lead[],
  store: StoreProvider,
  opts: SendOptions = {},
): Promise<Array<{ leadId: string; status?: OutreachStatus; error?: string }>> {
  const provider = createSendProvider(opts)
  return Promise.all(
    leads.map(async (lead) => {
      try {
        const status = await provider.send(lead)
        const fresh = (await store.getLead(lead.id)) ?? lead
        await store.upsertLead({
          ...fresh,
          outreach: { ...(fresh.outreach ?? {}), ...status },
        })
        await store.transition(lead.id, LeadStatus.SENT)
        return { leadId: lead.id, status }
      } catch (err) {
        return { leadId: lead.id, error: (err as Error).message }
      }
    }),
  )
}

// ---------------------------------------------------------------------------
// Real path — Resend
// ---------------------------------------------------------------------------

async function resendSend(
  lead: Lead,
  options: ResolvedSendOptions,
): Promise<OutreachStatus> {
  const { to, subject, body } = requireSendable(lead)

  const res = await options.fetchImpl(`${options.apiBase}/emails`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
      // Idempotency: retrying a send won't double-email the prospect.
      "Idempotency-Key": `frontrun-${tagSafe(lead.id)}`,
    },
    body: JSON.stringify({
      from: `${options.fromName} <${options.fromEmail}>`,
      to: [to],
      // Prospect replies here → inbound webhook reads the lead id off the address.
      reply_to: replyToFor(options.fromEmail, lead.id),
      subject,
      text: body,
      html: toHtml(body),
      // Maps delivery/open events back to this lead (outbound telemetry).
      tags: [{ name: "lead_id", value: tagSafe(lead.id) }],
      headers: { "X-Frontrun-Lead-Id": lead.id },
    }),
  })

  if (!res.ok) {
    throw new SendError(`resend ${res.status}: ${await safeText(res)}`, lead.id)
  }

  const data: any = await res.json().catch(() => ({}))
  return {
    messageId: data?.id ?? undefined,
    sentAt: new Date().toISOString(),
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return "<no body>"
  }
}

// ---------------------------------------------------------------------------
// Mock path — deterministic, no network
// ---------------------------------------------------------------------------

async function mockSend(
  lead: Lead,
  _options: ResolvedSendOptions,
): Promise<OutreachStatus> {
  // Still validate — the mock must fail on the same bad input the real one would,
  // so tests catch missing drafts/contacts before we ever hit the network.
  requireSendable(lead)
  return {
    messageId: `mock_${tagSafe(lead.id)}_${Date.now()}`,
    sentAt: new Date().toISOString(),
  }
}

export const __internals = { resolveOptions, requireSendable, tagSafe, toHtml }
