"use client"

import { useMemo, useState } from "react"
import { AnimatePresence } from "framer-motion"
import { LeadStatus } from "@shared/types"
import { useFrontrunStore } from "@/lib/ui/store"
import { useNow } from "@/lib/ui/use-now"
import { padCount } from "@/lib/ui/format"
import { LeadRow } from "@/components/frontrun/lead-row"
import { LiveDot } from "@/components/frontrun/live-dot"
import { LeadDetailSheet } from "@/components/lead-detail/lead-detail-sheet"

const OUTREACH = new Set([LeadStatus.SENT, LeadStatus.DELIVERED, LeadStatus.OPENED])
const IN_REPLY = new Set([
  LeadStatus.REPLIED,
  LeadStatus.GREEN,
  LeadStatus.YELLOW,
  LeadStatus.RED,
  LeadStatus.FOLLOW_UP_DRAFTED,
])

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="bg-surface p-4">
      <p className="kicker">{label}</p>
      <p
        className="mt-2 font-mono text-2xl font-medium tabular-nums leading-none"
        style={{ color: tone }}
      >
        {padCount(value, 2)}
      </p>
    </div>
  )
}

export default function Page() {
  const leads = useFrontrunStore((s) => s.leads)
  const lastChangedId = useFrontrunStore((s) => s.lastChangedId)
  const live = useFrontrunStore((s) => s.live)
  const now = useNow(1000)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = leads.find((l) => l.id === selectedId) ?? null

  const sorted = useMemo(
    () =>
      [...leads].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [leads],
  )

  const stats = useMemo(
    () => ({
      total: leads.length,
      outreach: leads.filter((l) => OUTREACH.has(l.status)).length,
      replied: leads.filter((l) => IN_REPLY.has(l.status)).length,
      booked: leads.filter((l) => l.status === LeadStatus.BOOKED).length,
    }),
    [leads],
  )

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      {/* Header */}
      <header className="flex flex-col gap-1.5">
        <p className="kicker">01 / Live pipeline</p>
        <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground">
          Signal Feed
        </h2>
        <p className="max-w-xl text-sm text-fg-muted">
          Companies that just filed a Form D — detected the day the raise drops, then
          researched, drafted, sent, and triaged end to end.
        </p>
      </header>

      {/* Stat strip — hairline-divided (exposed structure) */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4">
        <Stat label="In pipeline" value={stats.total} />
        <Stat label="In outreach" value={stats.outreach} tone="var(--signal)" />
        <Stat label="Replied" value={stats.replied} />
        <Stat label="Booked" value={stats.booked} tone="var(--success)" />
      </div>

      {/* Feed */}
      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5">
          <div className="flex items-baseline gap-2">
            <span className="kicker">Signal feed</span>
            <span className="font-mono text-[11px] tabular-nums text-fg-subtle">
              {padCount(leads.length, 2)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <LiveDot tone="signal" live />
            <span className="kicker text-signal">Streaming</span>
          </div>
        </div>

        <div className="flex flex-col">
          <AnimatePresence initial={false}>
            {sorted.map((lead) => (
              <LeadRow
                key={lead.id}
                lead={lead}
                now={now}
                flash={lead.id === lastChangedId}
                onSelect={() => setSelectedId(lead.id)}
              />
            ))}
          </AnimatePresence>
        </div>
      </section>

      <LeadDetailSheet lead={selected} onClose={() => setSelectedId(null)} />

      <p className="font-mono text-[11px] text-fg-faint">
        {live
          ? "Live · Track A backend on InsForge · polling /api/leads. Outreach, triage & booking run for real."
          : "Placeholder data · polling /api/leads until Track A’s backend answers. Nothing is simulated — the feed goes live on the first successful poll."}
      </p>
    </div>
  )
}
