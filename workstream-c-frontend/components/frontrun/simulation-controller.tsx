"use client"

import { useEffect } from "react"
import { useFrontrunStore } from "@/lib/ui/store"

/**
 * On mount: try the real backend (A's /api/leads). If real leads come back, go
 * LIVE — poll every few seconds to reflect state changes. If the backend is empty
 * or unreachable, fall back to the client-side simulation so the demo never dies.
 */
export function SimulationController() {
  const hydrate = useFrontrunStore((s) => s.hydrateFromBackend)
  const start = useFrontrunStore((s) => s.startSimulation)
  const stop = useFrontrunStore((s) => s.stopSimulation)

  useEffect(() => {
    let cancelled = false
    let poll: ReturnType<typeof setInterval> | null = null

    void (async () => {
      const liveOk = await hydrate()
      if (cancelled) return
      if (liveOk) {
        poll = setInterval(() => void hydrate(), 4000) // real backend → poll
      } else {
        start() // no real data → simulation fallback
      }
    })()

    return () => {
      cancelled = true
      if (poll) clearInterval(poll)
      stop()
    }
  }, [hydrate, start, stop])

  return null
}
