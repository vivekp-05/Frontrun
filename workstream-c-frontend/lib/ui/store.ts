/**
 * Frontrun client store (Zustand) — Track C.
 *
 * Holds the mock leads and simulates live forward transitions on a timer so the
 * dashboard feels real-time with NO backend and NO network calls. When Track A's
 * status API is ready, swap the simulation for polling/subscription; the shape
 * the UI reads (leads + detectedToday) stays identical.
 */
"use client"

import { create } from "zustand"
import {
  type Lead,
  LeadStatus,
  LEAD_TRANSITIONS,
  type ReplyClassification,
} from "@shared/types"
import { INITIAL_DETECTED_TODAY, MOCK_LEADS } from "@/lib/mock/leads"

/** One forward step along the demo "happy path". null = terminal. */
function nextHappyStatus(status: LeadStatus): LeadStatus | null {
  const map: Partial<Record<LeadStatus, LeadStatus>> = {
    [LeadStatus.DETECTED]: LeadStatus.ENRICHED,
    [LeadStatus.ENRICHED]: LeadStatus.DRAFTED,
    [LeadStatus.DRAFTED]: LeadStatus.SENT,
    [LeadStatus.SENT]: LeadStatus.DELIVERED,
    [LeadStatus.DELIVERED]: LeadStatus.REPLIED,
    [LeadStatus.OPENED]: LeadStatus.REPLIED,
    // REPLIED is classified separately (see classifyReply)
    [LeadStatus.GREEN]: LeadStatus.FOLLOW_UP_DRAFTED,
    // YELLOW (neutral "who are you?") is terminal in the demo — a lead that only
    // asked for context must NOT auto-advance into FOLLOW_UP_DRAFTED → BOOKED.
    [LeadStatus.RED]: LeadStatus.LOST,
    [LeadStatus.FOLLOW_UP_DRAFTED]: LeadStatus.BOOKED,
  }
  const next = map[status]
  if (!next) return null
  // Guard against contract drift: only advance if the transition is legal.
  return LEAD_TRANSITIONS[status].includes(next) ? next : null
}

/** Weighted reply classification — biased positive so the demo feels alive. */
function classifyReply(seed: number): ReplyClassification {
  const r = seed % 10
  if (r < 6) return "green"
  if (r < 9) return "yellow"
  return "red"
}

const CLASSIFICATION_STATUS: Record<ReplyClassification, LeadStatus> = {
  green: LeadStatus.GREEN,
  yellow: LeadStatus.YELLOW,
  red: LeadStatus.RED,
}

/** Scripted inbound replies for the parallel-outreach demo (one per verdict). */
const DEMO_REPLY: Record<ReplyClassification, { text: string; summary: string }> = {
  green: {
    text: "This is timely — send a couple of profiles and let's grab time this week.",
    summary: "Interested — wants profiles and a call.",
  },
  yellow: {
    text: "Who is this, and what exactly do you do?",
    summary: "Neutral — wants context before engaging.",
  },
  red: {
    text: "We handle recruiting in-house. Please remove me.",
    summary: "Not interested — recruiting is in-house.",
  },
}

/** Verdicts assigned to the 3 demo companies, in filing order. */
const DEMO_VERDICTS: ReplyClassification[] = ["green", "yellow", "red"]

/** Synthetic companies the simulator "detects" over time. */
const DETECT_POOL: Array<{ name: string; persons: string[]; amount: string; city: string }> = [
  { name: "Kestrel Labs", persons: ["Owen Pratt"], amount: "$11,000,000", city: "Austin, TX" },
  { name: "Fathom Robotics", persons: ["Iris Chen", "Paul Vega"], amount: "$21,000,000", city: "Pittsburgh, PA" },
  { name: "Brightloom", persons: ["Dana Powell"], amount: "$8,000,000", city: "Austin, TX" },
  { name: "Torchlight AI", persons: ["Reza Amini"], amount: "$30,000,000", city: "Palo Alto, CA" },
  { name: "Harbor Logistics", persons: ["Nina Falk", "Omar Reed"], amount: "$16,500,000", city: "Newark, NJ" },
  { name: "Slate Bio", persons: ["Yuki Tanaka"], amount: "$12,000,000", city: "Cambridge, MA" },
  { name: "Northgate Fintech", persons: ["Cole Barnes"], amount: "$44,000,000", city: "New York, NY" },
  { name: "Verdigris Energy", persons: ["Amara Diallo"], amount: "$19,500,000", city: "Boulder, CO" },
]

function stampTelemetry(lead: Lead, next: LeadStatus, nowIso: string): Lead {
  const updated: Lead = { ...lead, status: next, updatedAt: nowIso }
  const outreach = { ...(lead.outreach ?? {}) }

  switch (next) {
    case LeadStatus.SENT:
      outreach.messageId = outreach.messageId ?? `re_sim_${lead.id}`
      outreach.sentAt = nowIso
      updated.outreach = outreach
      break
    case LeadStatus.DELIVERED:
      outreach.deliveredAt = nowIso
      updated.outreach = outreach
      break
    case LeadStatus.REPLIED: {
      const cls = classifyReply(lead.id.length + new Date(nowIso).getSeconds())
      updated.replies = [
        ...(lead.replies ?? []),
        {
          id: `rp_sim_${lead.id}_${(lead.replies?.length ?? 0) + 1}`,
          receivedAt: nowIso,
          from: lead.contact?.email ?? "prospect@example.com",
          rawText: "Thanks for reaching out.",
          classification: cls,
        },
      ]
      // Immediately resolve REPLIED into its classification bucket next tick.
      updated.status = LeadStatus.REPLIED
      break
    }
    case LeadStatus.BOOKED:
      outreach.bookedAt = nowIso
      updated.outreach = outreach
      break
  }
  return updated
}

interface FrontrunState {
  leads: Lead[]
  detectedToday: number
  /** id + timestamp of the most recent change, for a brief UI flash. */
  lastChangedId: string | null
  lastChangedAt: number | null
  running: boolean
  /** True once real leads have been loaded from the backend (/api/leads). */
  live: boolean

  /** Parallel-outreach demo state. */
  outreachActive: boolean
  /** Demo leads are locked from the background sim until this timestamp. */
  demoLockUntil: number

  advanceLead: (id: string) => void
  detectNew: () => void
  tick: () => void
  startSimulation: (intervalMs?: number) => void
  stopSimulation: () => void
  /** Load real leads from A's backend. Returns true if any came back (→ go live). */
  hydrateFromBackend: () => Promise<boolean>
  runOutreachDemo: () => void
  reset: () => void
}

// Module-level interval handle (kept out of React state).
let simInterval: ReturnType<typeof setInterval> | null = null

export const useFrontrunStore = create<FrontrunState>((set, get) => ({
  leads: MOCK_LEADS,
  detectedToday: INITIAL_DETECTED_TODAY,
  lastChangedId: null,
  lastChangedAt: null,
  running: false,
  live: false,
  outreachActive: false,
  demoLockUntil: 0,

  advanceLead: (id) => {
    const nowIso = new Date().toISOString()
    set((state) => ({
      leads: state.leads.map((lead) => {
        if (lead.id !== id) return lead
        // A freshly-REPLIED lead resolves into green/yellow/red.
        if (lead.status === LeadStatus.REPLIED) {
          const cls = lead.replies?.[lead.replies.length - 1]?.classification ?? "green"
          return { ...lead, status: CLASSIFICATION_STATUS[cls], updatedAt: nowIso }
        }
        const next = nextHappyStatus(lead.status)
        if (!next) return lead
        return stampTelemetry(lead, next, nowIso)
      }),
      lastChangedId: id,
      lastChangedAt: Date.now(),
    }))
  },

  detectNew: () => {
    const { leads, detectedToday } = get()
    const simCount = leads.filter((l) => l.id.startsWith("ld_sim_")).length
    const pick = DETECT_POOL[simCount % DETECT_POOL.length]
    const nowIso = new Date().toISOString()
    const id = `ld_sim_${simCount + 1}`
    const accession = `0009${String(100000 + simCount).slice(-6)}-26-00${String(
      1000 + simCount,
    ).slice(-4)}`
    const lead: Lead = {
      id,
      status: LeadStatus.DETECTED,
      isDemo: false,
      signal: {
        accessionNumber: accession,
        companyName: pick.name,
        relatedPersons: pick.persons,
        address: pick.city,
        amountRaised: pick.amount,
        filedAt: nowIso,
        edgarUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=D",
      },
      createdAt: nowIso,
      updatedAt: nowIso,
    }
    set({
      leads: [lead, ...leads],
      detectedToday: detectedToday + 1,
      lastChangedId: id,
      lastChangedAt: Date.now(),
    })
  },

  tick: () => {
    const { leads, advanceLead, detectNew } = get()

    // ~1 in 4 ticks: a brand-new company is detected.
    if (Math.random() < 0.25) {
      detectNew()
      return
    }

    // Otherwise advance a random non-terminal lead one step.
    const lockUntil = get().demoLockUntil
    const nowMs = Date.now()
    const movable = leads.filter((l) => {
      if (l.isDemo && nowMs < lockUntil) return false // reserved by the outreach demo
      if (l.status === LeadStatus.REPLIED) return true
      return nextHappyStatus(l.status) !== null
    })
    if (movable.length === 0) {
      detectNew()
      return
    }
    const target = movable[Math.floor(Math.random() * movable.length)]
    advanceLead(target.id)
  },

  startSimulation: (intervalMs = 3200) => {
    if (get().running || simInterval) return
    simInterval = setInterval(() => get().tick(), intervalMs)
    set({ running: true })
  },

  stopSimulation: () => {
    if (simInterval) {
      clearInterval(simInterval)
      simInterval = null
    }
    set({ running: false })
  },

  hydrateFromBackend: async () => {
    try {
      const res = await fetch("/api/leads", { cache: "no-store" })
      if (!res.ok) return false
      const data = (await res.json()) as { leads?: Lead[] }
      const leads = Array.isArray(data.leads) ? data.leads : []
      if (leads.length === 0) return false
      set({
        leads,
        live: true,
        detectedToday: leads.length,
        lastChangedAt: Date.now(),
      })
      return true
    } catch {
      return false
    }
  },

  runOutreachDemo: () => {
    // Live backend: trigger the real outreach send, then refresh from the store.
    if (get().live) {
      set({ outreachActive: true })
      fetch("/api/outreach", { method: "POST" })
        .then(() => get().hydrateFromBackend())
        .catch(() => {})
        .finally(() => set({ outreachActive: false }))
      return
    }
    if (get().outreachActive) return
    // Fixed filing order → stable verdict assignment (green / yellow / red).
    const demoIds = MOCK_LEADS.filter((l) => l.isDemo).map((l) => l.id)
    set({ outreachActive: true, demoLockUntil: Date.now() + 8000 })

    const patch = (id: string, mut: (l: Lead) => Lead) =>
      set((state) => ({
        leads: state.leads.map((l) => (l.id === id ? mut(l) : l)),
        lastChangedId: id,
        lastChangedAt: Date.now(),
      }))
    const iso = () => new Date().toISOString()

    // Reset all three to a clean "ready to send" start.
    demoIds.forEach((id) =>
      patch(id, (l) => ({
        ...l,
        status: LeadStatus.DRAFTED,
        outreach: undefined,
        replies: undefined,
        updatedAt: iso(),
      })),
    )

    // Fire the pipeline in parallel — small per-lead stagger keeps it alive.
    demoIds.forEach((id, i) => {
      const off = i * 160
      const verdict = DEMO_VERDICTS[i % DEMO_VERDICTS.length]

      setTimeout(() => {
        patch(id, (l) => ({
          ...l,
          status: LeadStatus.SENT,
          outreach: { messageId: `re_run_${id}`, sentAt: iso() },
          updatedAt: iso(),
        }))
      }, 450 + off)

      setTimeout(() => {
        patch(id, (l) => ({
          ...l,
          status: LeadStatus.DELIVERED,
          outreach: { ...(l.outreach ?? {}), deliveredAt: iso() },
          updatedAt: iso(),
        }))
      }, 1500 + off)

      setTimeout(() => {
        patch(id, (l) => ({
          ...l,
          status: LeadStatus.REPLIED,
          replies: [
            {
              id: `rp_run_${id}`,
              receivedAt: iso(),
              from: l.contact?.email ?? "prospect@example.com",
              rawText: DEMO_REPLY[verdict].text,
              summary: DEMO_REPLY[verdict].summary,
              classification: verdict,
            },
          ],
          updatedAt: iso(),
        }))
      }, 2800 + off)

      setTimeout(() => {
        patch(id, (l) => ({ ...l, status: CLASSIFICATION_STATUS[verdict], updatedAt: iso() }))
      }, 3600 + off)
    })

    setTimeout(() => set({ outreachActive: false }), 4200 + demoIds.length * 160)
  },

  reset: () => {
    get().stopSimulation()
    set({
      leads: MOCK_LEADS,
      detectedToday: INITIAL_DETECTED_TODAY,
      lastChangedId: null,
      lastChangedAt: null,
    })
  },
}))
