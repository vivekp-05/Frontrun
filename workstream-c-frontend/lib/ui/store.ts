/**
 * Frontrun client store (Zustand) — Track C.
 *
 * LIVE-ONLY. The dashboard reads real leads from Track A's status API
 * (GET /api/leads → InsForge) on a poll. Cards move ONLY when the backend
 * actually changes (a real send / reply / booking) — there is no client-side
 * simulation, so nothing shuffles on its own.
 *
 * `running` = the live poll is active. The top-bar play/pause toggles it.
 * MOCK_LEADS is only the pre-hydration placeholder for the very first paint; the
 * first successful poll replaces it. If the backend has no leads (e.g. InsForge
 * env not set on the deploy), the placeholder stays and `live` stays false.
 */
"use client"

import { create } from "zustand"
import { type Lead } from "@shared/types"
import { INITIAL_DETECTED_TODAY, MOCK_LEADS } from "@/lib/mock/leads"

interface FrontrunState {
  leads: Lead[]
  detectedToday: number
  /** id + timestamp of the most recent real change, for a brief UI flash. */
  lastChangedId: string | null
  lastChangedAt: number | null
  /** True while the live poll is active (top-bar play/pause). */
  running: boolean
  /** True once real leads have been loaded from the backend (/api/leads). */
  live: boolean
  /** Parallel-outreach demo in flight. */
  outreachActive: boolean

  /** Poll the backend once; updates state only when the data actually changed. */
  hydrateFromBackend: () => Promise<boolean>
  /** Resume the live poll. */
  startSimulation: () => void
  /** Pause the live poll. */
  stopSimulation: () => void
  /** "Run outreach": trigger the real send loop through A, then refresh. */
  runOutreachDemo: () => void
  reset: () => void
}

/** Stable signature of the lead set — used to skip no-op re-renders. */
function signature(leads: Lead[]): string {
  return leads
    .map((l) => `${l.id}:${l.status}:${l.updatedAt}`)
    .sort()
    .join("|")
}

export const useFrontrunStore = create<FrontrunState>((set, get) => ({
  leads: MOCK_LEADS,
  detectedToday: INITIAL_DETECTED_TODAY,
  lastChangedId: null,
  lastChangedAt: null,
  running: true,
  live: false,
  outreachActive: false,

  hydrateFromBackend: async () => {
    try {
      const res = await fetch("/api/leads", { cache: "no-store" })
      if (!res.ok) return false
      const data = (await res.json()) as { leads?: Lead[] }
      const leads = Array.isArray(data.leads) ? data.leads : []
      if (leads.length === 0) return false
      const prev = get()
      const next = signature(leads)
      // Only re-set when something actually changed — otherwise the poll would
      // replace the array every tick and re-animate the funnel for no reason.
      if (prev.live && signature(prev.leads) === next) return true
      // Flash the most recently updated lead that changed since the last poll.
      // Skipped on the first hydration (placeholder → live must not flash).
      let lastChangedId: string | null = null
      if (prev.live) {
        const before = new Map(prev.leads.map((l) => [l.id, l]))
        const changed = leads.filter((l) => {
          const old = before.get(l.id)
          return !old || old.status !== l.status || old.updatedAt !== l.updatedAt
        })
        if (changed.length > 0) {
          lastChangedId = changed.reduce((a, b) =>
            new Date(b.updatedAt).getTime() > new Date(a.updatedAt).getTime() ? b : a,
          ).id
        }
      }
      set({
        leads,
        live: true,
        detectedToday: leads.length,
        lastChangedId,
        lastChangedAt: Date.now(),
      })
      return true
    } catch {
      return false
    }
  },

  startSimulation: () => set({ running: true }),
  stopSimulation: () => set({ running: false }),

  runOutreachDemo: () => {
    if (get().outreachActive) return
    set({ outreachActive: true })
    fetch("/api/outreach", { method: "POST" })
      .then(() => get().hydrateFromBackend())
      .catch(() => {})
      .finally(() => set({ outreachActive: false }))
  },

  reset: () => set({ leads: MOCK_LEADS, detectedToday: INITIAL_DETECTED_TODAY, lastChangedId: null, lastChangedAt: null }),
}))
