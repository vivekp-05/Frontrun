"use client"

import { useEffect, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { Reveal } from "./reveal"
import { cn } from "@/lib/utils"

type Stage = {
  n: string
  title: string
  sponsor: string
  detail: string
  live?: boolean
}

const STEP_MS = 2800

const STAGES: Stage[] = [
  {
    n: "01",
    title: "Detect",
    sponsor: "SEC EDGAR",
    detail:
      "A Form D filing hits EDGAR the day a company raises. FrontRun catches it same-day — with the real exec names and amount, before the press runs.",
    live: true,
  },
  {
    n: "02",
    title: "Research",
    sponsor: "You.com",
    detail:
      "A cited company brief confirms the raise and profiles the target — so the outreach is grounded in real, verifiable facts.",
  },
  {
    n: "03",
    title: "Enrich",
    sponsor: "Nimble · Hunter · Reoon",
    detail:
      "Resolves the founder and a verified email, with the confidence tier shown honestly — never a guessed address.",
  },
  {
    n: "04",
    title: "Draft",
    sponsor: "RocketRide",
    detail:
      "Enrich → verify → draft, packaged as one pipeline tool. Out comes a personalized outreach email, ready to send.",
  },
  {
    n: "05",
    title: "Send",
    sponsor: "Resend",
    detail:
      "Sent from a verified domain to controlled demo inboxes, with live delivered / opened tracking on every message.",
  },
  {
    n: "06",
    title: "Triage",
    sponsor: "Band",
    detail:
      "Replies come back classified green / yellow / red by a coordinated 3-agent team — with the next step already drafted.",
    live: true,
  },
  {
    n: "07",
    title: "Book",
    sponsor: "Cal.com",
    detail:
      "A green reply gets a booking link that maps straight back to the lead — flipping it to Booked, automatically.",
  },
]

export function HowItRuns() {
  const reduce = useReducedMotion()
  const [active, setActive] = useState(0)
  const [paused, setPaused] = useState(false)
  const s = STAGES[active]

  // Auto-advance through every step; pauses on hover/focus so you can explore.
  useEffect(() => {
    if (reduce || paused) return
    const id = setInterval(
      () => setActive((a) => (a + 1) % STAGES.length),
      STEP_MS,
    )
    return () => clearInterval(id)
  }, [reduce, paused])

  return (
    <section className="border-t border-line bg-background">
      <div className="mx-auto w-full max-w-6xl px-6 py-20 md:py-28">
        <Reveal>
          <p className="kicker">03 / How it runs</p>
          <h2 className="mt-6 max-w-2xl font-display text-3xl font-semibold leading-[1.05] tracking-tight text-fg md:text-5xl">
            Detect to booked,
            <br />
            <span className="text-fg-subtle">in one loop.</span>
          </h2>
          <p className="mt-5 max-w-lg leading-relaxed text-fg-muted">
            One AI employee runs the whole conversation — every stage a real
            integration on live data. It plays through on its own;{" "}
            <span className="text-fg">hover to explore.</span>
          </p>
        </Reveal>

        {/* interactive + auto-advancing pipeline */}
        <div
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <Reveal delay={0.05}>
            <div className="mt-12 flex flex-wrap items-center gap-2">
              {STAGES.map((st, i) => (
                <div key={st.n} className="flex items-center gap-2">
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onFocus={() => {
                      setPaused(true)
                      setActive(i)
                    }}
                    onClick={() => {
                      setPaused(true)
                      setActive(i)
                    }}
                    aria-pressed={i === active}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2 transition-colors",
                      i === active
                        ? "border-signal/50 bg-signal/10"
                        : "border-line bg-surface hover:border-line-strong",
                    )}
                  >
                    <span className="font-mono text-[10px] text-fg-faint">{st.n}</span>
                    <span
                      className={cn(
                        "text-sm font-medium",
                        i === active ? "text-fg" : "text-fg-muted",
                      )}
                    >
                      {st.title}
                    </span>
                    {st.live && <span className="size-1.5 rounded-full bg-signal" />}
                  </button>
                  {i < STAGES.length - 1 && (
                    <span aria-hidden className="hidden text-fg-faint sm:inline">
                      →
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Reveal>

          {/* peek panel */}
          <div className="mt-6 min-h-[10.5rem] overflow-hidden rounded-xl border border-line bg-surface p-6 md:p-8">
            <AnimatePresence mode="wait">
              <motion.div
                key={active}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-xs text-fg-faint">{s.n}</span>
                  <span className="inline-block rounded-md border border-line bg-inset px-2 py-1 font-mono text-[10px] tracking-wide text-fg-subtle">
                    {s.sponsor}
                  </span>
                  {s.live && (
                    <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-signal">
                      <span className="size-1.5 rounded-full bg-signal" />
                      live
                    </span>
                  )}
                </div>
                <h3 className="mt-4 font-display text-2xl font-semibold tracking-tight text-fg">
                  {s.title}
                </h3>
                <p className="mt-2 max-w-xl leading-relaxed text-fg-muted">{s.detail}</p>
              </motion.div>
            </AnimatePresence>

            {/* auto-advance progress bar */}
            {!reduce && !paused && (
              <motion.div
                key={`bar-${active}`}
                className="mt-5 h-0.5 origin-left rounded-full bg-signal/40"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: STEP_MS / 1000, ease: "linear" }}
              />
            )}
          </div>
        </div>

        {/* foundation + triage legend, compact */}
        <Reveal delay={0.1}>
          <div className="mt-7 flex flex-wrap items-center gap-x-8 gap-y-3">
            <span className="font-mono text-[11px] text-fg-subtle">
              Every state persists to <span className="text-fg">InsForge</span> · one guarded state machine
            </span>
            <span className="hidden h-3 w-px bg-line sm:inline-block" />
            {(["green → book", "yellow → clarify", "red → stop"] as const).map(
              (label) => (
                <span
                  key={label}
                  className="font-mono text-[11px] tracking-[0.06em] text-fg-subtle"
                >
                  {label}
                </span>
              ),
            )}
          </div>
        </Reveal>
      </div>
    </section>
  )
}
