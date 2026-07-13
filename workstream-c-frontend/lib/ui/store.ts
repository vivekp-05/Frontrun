/**
 * Frontrun client store (Zustand) — Track C.
 *
 * LIVE mode: reads real leads from Track A's status API (GET /leads, /analytics)
 * on a poll, and drives the real outreach loop through A's routes (POST /outreach
 * + the Resend/Cal.com webhook handlers). The `Lead` shape is shared end to end,
 * so the UI renders real InsForge data unchanged.
 *
 * If the backend is unreachable it falls back to the built-in simulation over
 * MOCK_LEADS, so the dashboard is never blank.
 */
"use client"

import { create } from "zustand"
import { type Lead, LeadStatus, LEAD_TRANSITIONS, type ReplyClassification } from "@shared/types"
import { INITIAL_DETECTED_TODAY, MOCK_LEADS } from "@/lib/mock/leads"
import {
  backendUp,
  calcomWebhook,
  fetchLeads,
  resendWebhook,
  runOutreach as apiRunOutreach,
  upsertLead,
} from "@/lib/ui/api"

const DEMO_IDS = ["demo_1", "demo_2", "demo_3"]

/** Scripted inbound replies for the parallel-outreach demo (one per verdict). */
const DEMO_REPLY: Record<ReplyClassification, string> = {
  green: "This is great timing — we just closed and need to hire fast. Can we book a call this week?",
  yellow: "Who are you exactly, and how did you get my email?",
  red: "Not interested. Please remove me from your list.",
}
const DEMO_VERDICTS: ReplyClassification[] = ["green", "yellow", "red"]

// ── simulation fallback (only if the backend is down) ────────────────────────
function nextHappyStatus(status: LeadStatus): LeadStatus | null {
  const map: Partial<Record<LeadStatus, LeadStatus>> = {
    [LeadStatus.DETECTED]: LeadStatus.ENRICHED,
    [LeadStatus.ENRICHED]: LeadStatus.DRAFTED,
    [LeadStatus.DRAFTED]: LeadStatus.SENT,
    [LeadStatus.SENT]: LeadStatus.DELIVERED,
    [LeadStatus.DELIVERED]: LeadStatus.REPLIED,
    [LeadStatus.OPENED]: LeadStatus.REPLIED,
    [LeadStatus.GREEN]: LeadStatus.FOLLOW_UP_DRAFTED,
    [LeadStatus.RED]: LeadStatus.LOST,
    [LeadStatus.FOLLOW_UP_DRAFTED]: LeadStatus.BOOKED,
  }
  const next = map[status]
  if (!next) return null
  return LEAD_TRANSITIONS[status].includes(next) ? next : null
}

interface FrontrunState {
  leads: Lead[]
  detectedToday: number
  lastChangedId: string | null
  lastChangedAt: number | null
  running: boolean
  live: boolean
  outreachActive: boolean
  demoLockUntil: number

  advanceLead: (id: string) => void
  detectNew: () => void
  tick: () => void
  startSimulation: (intervalMs?: number) => void
  stopSimulation: () => void
  runOutreachDemo: () => void
  reset: () => void
}

let simInterval: ReturnType<typeof setInterval> | null = null
let lastStatuses: Record<string, LeadStatus> = {}

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
    // Fallback-only (simulation). Live mode advances via the backend.
    const nowIso = new Date().toISOString()
    set((state) => ({
      leads: state.leads.map((lead) => {
        if (lead.id !== id) return lead
        const next = nextHappyStatus(lead.status)
        return next ? { ...lead, status: next, updatedAt: nowIso } : lead
      }),
      lastChangedId: id,
      lastChangedAt: Date.now(),
    }))
  },

  detectNew: () => {},

  tick: () => {
    // Simulation fallback: nudge a random lead forward.
    const { leads, advanceLead } = get()
    const movable = leads.filter((l) => nextHappyStatus(l.status) !== null)
    if (movable.length) advanceLead(movable[Math.floor(Math.random() * movable.length)].id)
  },

  // startSimulation is the mount hook C already calls — now it starts LIVE polling
  // of A's backend, falling back to the local simulation only if A is unreachable.
  startSimulation: async (intervalMs = 2500) => {
    if (get().running || simInterval) return
    set({ running: true })

    const refresh = async () => {
      try {
        const leads = await fetchLeads()
        // Flash whichever lead's status changed since the last poll.
        let changed: string | null = null
        for (const l of leads) {
          if (lastStatuses[l.id] && lastStatuses[l.id] !== l.status) changed = l.id
          lastStatuses[l.id] = l.status
        }
        set({
          leads,
          live: true,
          detectedToday: leads.length,
          ...(changed ? { lastChangedId: changed, lastChangedAt: Date.now() } : {}),
        })
      } catch {
        // backend blip — keep last leads
      }
    }

    if (await backendUp()) {
      await refresh()
      simInterval = setInterval(refresh, intervalMs)
    } else {
      // Backend down → local simulation so the dashboard still animates.
      set({ live: false })
      simInterval = setInterval(() => get().tick(), 3200)
    }
  },

  stopSimulation: () => {
    if (simInterval) {
      clearInterval(simInterval)
      simInterval = null
    }
    set({ running: false })
  },

  // Drives the REAL loop through A: send → deliver → reply → live triage → book.
  // Polling reflects each transition as it lands in InsForge.
  runOutreachDemo: async () => {
    if (get().outreachActive) return
    if (!get().live) return // simulation mode has no backend to drive
    set({ outreachActive: true })

    const to = (id: string) => [`dana+${id}@frontrun.dev`]
    const from = (id: string) =>
      get().leads.find((l) => l.id === id)?.contact?.email ?? `prospect@${id}.dev`
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

    try {
      // Reset the demo trio to a clean DRAFTED start so the button is re-runnable.
      await Promise.all(
        DEMO_IDS.map((id) => {
          const l = get().leads.find((x) => x.id === id)
          if (!l) return Promise.resolve()
          return upsertLead({ ...l, status: LeadStatus.DRAFTED, outreach: undefined, replies: [] }).catch(() => {})
        }),
      )
      await wait(400)
      await apiRunOutreach(DEMO_IDS) // DRAFTED → SENT (parallel)
      await wait(1200)
      for (const id of DEMO_IDS) {
        await resendWebhook({ type: "email.delivered", data: { tags: [{ name: "lead_id", value: id }] } })
      }
      await wait(1400)
      // Inbound replies → backend triages live (green / yellow / red).
      await Promise.all(
        DEMO_IDS.map((id, i) =>
          resendWebhook({
            type: "email.received",
            data: {
              email_id: `rp_run_${id}_${Date.now()}`,
              from: from(id),
              to: to(id),
              text: DEMO_REPLY[DEMO_VERDICTS[i % 3]],
            },
          }),
        ),
      )
      await wait(2600)
      // Book the green lead → BOOKED.
      await calcomWebhook({
        triggerEvent: "BOOKING_CREATED",
        payload: { metadata: { leadId: "demo_1" }, startTime: new Date().toISOString() },
      })
    } catch {
      // best-effort demo driver
    } finally {
      setTimeout(() => set({ outreachActive: false }), 1500)
    }
  },

  reset: () => {
    get().stopSimulation()
    lastStatuses = {}
    set({ leads: MOCK_LEADS, detectedToday: INITIAL_DETECTED_TODAY, lastChangedId: null, lastChangedAt: null })
  },
}))
