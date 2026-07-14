import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { Reveal } from "./reveal"
import { SignalOrb } from "./signal-orb"
import { SponsorMarquee } from "./sponsor-belt"

export function Close() {
  return (
    <section id="live-demo" className="scroll-mt-16 border-t border-line">
      {/* Built-on strip — the full reward stack, compact */}
      <div className="border-b border-line py-10">
        <p className="kicker mx-auto w-full max-w-6xl px-6">04 / Built on the stack</p>
        <div className="mt-6">
          <SponsorMarquee />
        </div>
      </div>

      {/* Closing CTA with the signal-orb motif */}
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 py-24 md:grid-cols-[auto_1fr] md:gap-20 md:py-32">
        <Reveal className="flex justify-center md:justify-start">
          <SignalOrb size={260} />
        </Reveal>
        <Reveal delay={0.05}>
          <p className="kicker">The demo</p>
          <h2 className="mt-5 font-display text-4xl font-semibold leading-[1.04] tracking-tight text-fg md:text-6xl">
            The raise just filed.
            <br />
            <span className="text-fg-subtle">You&apos;re already in.</span>
          </h2>
          <p className="mt-6 max-w-md leading-relaxed text-fg-muted">
            Real filings, real research, live sends, live triage — watch the whole
            loop run, end to end.
          </p>
          <Link
            href="/gate"
            className="group mt-9 inline-flex h-12 items-center gap-2 rounded-md bg-signal px-6 font-medium text-signal-foreground transition-all duration-[var(--dur-fast)] hover:gap-3 hover:bg-signal-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            See the live demo
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </Reveal>
      </div>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-2 px-6 py-8 sm:flex-row sm:items-center">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
            Built by Sharique Khatri &amp; Vivek Patel
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-faint">
            © 2026 FrontRun. All rights reserved.
          </span>
        </div>
      </footer>
    </section>
  )
}
