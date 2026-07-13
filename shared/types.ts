/**
 * Frontrun — Shared Contract (THE merge boundary)
 * ------------------------------------------------
 * Every workstream (A/B/C/D) imports from this file.
 * Agreed in the first 20 minutes. Do NOT change without pinging the whole team.
 *
 * A — Backend/DB owns persistence of `Lead` + status transitions.
 * B — Pipeline emits DETECTED leads and fills enrichment/draft.
 * C — Frontend renders leads by `LeadStatus` columns.
 * D — Outreach sends, and writes back replies/classification/booking.
 */

/** The lead lifecycle state machine (PRD §8). */
export enum LeadStatus {
  DETECTED = "DETECTED",
  ENRICHED = "ENRICHED",
  DRAFTED = "DRAFTED",
  SENT = "SENT",
  DELIVERED = "DELIVERED",
  OPENED = "OPENED", // directional only — pixel unreliable
  REPLIED = "REPLIED",
  GREEN = "GREEN", // interested
  YELLOW = "YELLOW", // neutral / question
  RED = "RED", // not interested
  FOLLOW_UP_DRAFTED = "FOLLOW_UP_DRAFTED",
  BOOKED = "BOOKED",
  LOST = "LOST",
}

/** Valid forward transitions. Backend (A) enforces these. */
export const LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  [LeadStatus.DETECTED]: [LeadStatus.ENRICHED, LeadStatus.LOST],
  [LeadStatus.ENRICHED]: [LeadStatus.DRAFTED, LeadStatus.LOST],
  [LeadStatus.DRAFTED]: [LeadStatus.SENT, LeadStatus.LOST],
  [LeadStatus.SENT]: [LeadStatus.DELIVERED, LeadStatus.LOST],
  [LeadStatus.DELIVERED]: [LeadStatus.OPENED, LeadStatus.REPLIED, LeadStatus.LOST],
  [LeadStatus.OPENED]: [LeadStatus.REPLIED, LeadStatus.LOST],
  [LeadStatus.REPLIED]: [LeadStatus.GREEN, LeadStatus.YELLOW, LeadStatus.RED],
  [LeadStatus.GREEN]: [LeadStatus.FOLLOW_UP_DRAFTED, LeadStatus.BOOKED, LeadStatus.LOST],
  [LeadStatus.YELLOW]: [LeadStatus.FOLLOW_UP_DRAFTED, LeadStatus.LOST],
  [LeadStatus.RED]: [LeadStatus.LOST],
  [LeadStatus.FOLLOW_UP_DRAFTED]: [LeadStatus.SENT, LeadStatus.BOOKED, LeadStatus.LOST],
  [LeadStatus.BOOKED]: [],
  [LeadStatus.LOST]: [],
}

/** Reply triage classification (Band agent, workstream D). */
export type ReplyClassification = "green" | "yellow" | "red"

/** Email confidence tier — verify is probabilistic (PRD §14). */
export type EmailConfidence = "high" | "medium" | "low" | "unverified"

/** The SEC Form D detection signal (workstream B). */
export interface FormDSignal {
  /** EDGAR accession number — unique per filing. */
  accessionNumber: string
  companyName: string
  /** Named execs / directors from the filing. */
  relatedPersons: string[]
  /** Mailing address from the filing (no email — resolved downstream). */
  address?: string
  /** Total offering / amount raised, if disclosed. */
  amountRaised?: string
  filedAt: string // ISO 8601
  /** Link to the EDGAR filing. */
  edgarUrl?: string
}

/** Cited company research brief (You.com Research, workstream B). */
export interface CompanyBrief {
  summary: string
  citations: Citation[]
  /** Confirmation that the raise is real (You.com news). */
  fundingConfirmed?: boolean
}

export interface Citation {
  title: string
  url: string
  snippet?: string
}

/** Resolved + verified contact (Nimble/Hunter + Reoon, workstream B). */
export interface Contact {
  name: string
  title?: string
  email?: string
  emailConfidence: EmailConfidence
  linkedinUrl?: string // draft-only; no automation (PRD §6)
  source: "nimble" | "hunter" | "manual"
}

/** A drafted outreach email. */
export interface EmailDraft {
  subject: string
  body: string
  createdAt: string // ISO 8601
}

/** Lead prioritization score (workstream B · RocketRide pipeline). */
export interface LeadScore {
  /** 0–100 recruiting-agency fit. */
  score: number
  tier: "hot" | "warm" | "cold"
  reasons: string[]
  createdAt: string // ISO 8601
}

/** An inbound reply + its triage (workstream D). */
export interface ReplyEvent {
  id: string
  receivedAt: string // ISO 8601
  from: string
  rawText: string
  summary?: string
  classification?: ReplyClassification
  /** The next-step draft the triage agent produced. */
  nextStepDraft?: EmailDraft
}

/** Outreach delivery telemetry (Resend webhooks, workstream D). */
export interface OutreachStatus {
  messageId?: string
  sentAt?: string
  deliveredAt?: string
  openedAt?: string // directional only
  bookedAt?: string // Cal.com BOOKING_CREATED
}

/**
 * THE Lead object. Single source of truth passed between all workstreams.
 * Backend (A) persists this shape in InsForge.
 */
export interface Lead {
  id: string
  status: LeadStatus
  /** Set true for the 3 controlled parallel-demo companies. */
  isDemo: boolean

  // --- Detection (B) ---
  signal: FormDSignal

  // --- Enrichment (B) ---
  brief?: CompanyBrief
  contact?: Contact

  // --- Draft (B / D) ---
  draft?: EmailDraft

  // --- Prioritization (B) ---
  leadScore?: LeadScore

  // --- Outreach + reply loop (D) ---
  outreach?: OutreachStatus
  replies?: ReplyEvent[]

  // --- Bookkeeping (A) ---
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
}

/** Analytics strip aggregates (Hydra, workstream A). */
export interface FunnelAnalytics {
  counts: Record<LeadStatus, number>
  replyRate: number // replied / delivered
  avgResponseTimeMs?: number
  greenRedRatio?: number
}

/**
 * Thin capability interfaces (PRD §11) — every external tool sits behind one,
 * so sponsors are swappable by config. Implemented per-workstream.
 */
export interface SearchProvider {
  search(query: string): Promise<CompanyBrief>
}
export interface ScrapeProvider {
  scrape(companyName: string, domain?: string): Promise<Partial<Contact>[]>
}
export interface ResolveEmailProvider {
  resolveEmail(name: string, domain: string): Promise<Pick<Contact, "email" | "source">>
}
export interface VerifyProvider {
  verify(email: string): Promise<EmailConfidence>
}
export interface StoreProvider {
  upsertLead(lead: Lead): Promise<Lead>
  getLead(id: string): Promise<Lead | null>
  listLeads(): Promise<Lead[]>
  transition(id: string, to: LeadStatus): Promise<Lead>
}
export interface SendProvider {
  send(lead: Lead): Promise<OutreachStatus>
}
export interface AnalyticsProvider {
  funnel(): Promise<FunnelAnalytics>
}
