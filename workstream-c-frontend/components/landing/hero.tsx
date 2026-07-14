"use client"

import { useRef } from "react"
import Link from "next/link"
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "framer-motion"
import { ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { Wordmark } from "@/components/frontrun/signature"
import { CountUp } from "./count-up"

const EASE_SIGNAL = [0.2, 0, 0, 1] as const

/** The live-signal readout that plays beside the hero headline. */
const SIGNAL_ROWS = [
  { label: "FORM D FILED", value: "SEC EDGAR · same day", live: true },
  { label: "COMPANY", value: "Acme Robotics · Series A" },
  { label: "AMOUNT", value: "$18,000,000" },
  { label: "RESEARCH", value: "brief ready · 6 citations" },
  { label: "EMAIL", value: "resolved · confidence high" },
  { label: "DRAFT", value: "ready to send" },
]

export function Hero() {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLElement>(null)
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end start"],
  })
  // Parallax: content drifts up + fades, the readout drifts faster — depth on scroll.
  const contentY = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : -60])
  const contentOpacity = useTransform(scrollYProgress, [0, 0.75], [1, reduce ? 1 : 0])
  const readoutY = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : -140])

  const enter = (delay: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 24 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.7, delay, ease: EASE_SIGNAL },
        }

  return (
    <header ref={ref} className="relative overflow-hidden border-b border-line">
      {/* Signal-pulse background: hairline grid + a slow scan line. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage: "linear-gradient(to right, var(--line) 1px, transparent 1px)",
            backgroundSize: "160px 100%",
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.5]"
          style={{
            background:
              "radial-gradient(60% 50% at 50% 0%, color-mix(in oklab, var(--signal) 10%, transparent) 0%, transparent 70%)",
          }}
        />
        {!reduce && (
          <motion.div
            className="absolute inset-y-0 w-px bg-signal/25"
            initial={{ left: "-2%" }}
            animate={{ left: "102%" }}
            transition={{ duration: 12, repeat: Infinity, ease: "linear" }}
          />
        )}
      </div>

      {/* Top strip */}
      <div className="relative mx-auto flex w-full max-w-6xl items-center px-6 py-6">
        <Wordmark showDescriptor={false} size="lg" />
      </div>

      <div className="relative mx-auto grid w-full max-w-6xl gap-14 px-6 pb-28 pt-20 md:grid-cols-[1.35fr_auto] md:gap-20 md:pb-40 md:pt-28">
        {/* Headline block */}
        <motion.div style={{ y: contentY, opacity: contentOpacity }}>
          <motion.p className="kicker flex items-center gap-2" {...enter(0)}>
            <span className="relative flex size-1.5">
              {!reduce && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-70" />
              )}
              <span className="relative inline-flex size-1.5 rounded-full bg-signal" />
            </span>
            01 / Autonomous SDR
          </motion.p>

          <h1 className="mt-6 font-display text-[2rem] font-semibold leading-[1.03] tracking-tight text-fg sm:text-5xl md:text-6xl lg:text-7xl">
            {[
              { t: "By the time the", dim: false },
              { t: "press releases,", dim: false },
              { t: "it’s too late.", dim: true },
            ].map((line, i) => (
              <span key={line.t} className="block overflow-hidden pb-[0.1em]">
                <motion.span
                  className={cn(
                    "block whitespace-nowrap",
                    line.dim && "text-fg-subtle",
                  )}
                  initial={reduce ? {} : { y: "115%" }}
                  animate={reduce ? {} : { y: 0 }}
                  transition={{
                    duration: 0.85,
                    delay: 0.12 + i * 0.13,
                    ease: EASE_SIGNAL,
                  }}
                >
                  {line.t}
                </motion.span>
              </span>
            ))}
          </h1>

          <motion.p
            className="mt-8 max-w-lg text-base leading-relaxed text-fg-muted md:text-lg"
            {...enter(0.18)}
          >
            A company files its Form D and starts hiring 20 people. Frontrun
            catches it <span className="text-fg">that day</span> — researches the
            company, finds the founder, drafts the email, and sends it. You&apos;re
            in the inbox before anyone else knows there was a raise.
          </motion.p>

          <motion.div className="mt-10 flex flex-wrap items-center gap-4" {...enter(0.28)}>
            <Link
              href="/gate"
              className="group inline-flex h-12 items-center gap-2 rounded-md bg-signal px-6 font-medium text-signal-foreground transition-all duration-[var(--dur-fast)] hover:bg-signal-strong hover:gap-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
            >
              Watch the live demo
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-fg-faint">
              Reach them first.
            </span>
          </motion.div>

          {/* Animated stat band */}
          <motion.div
            className="mt-12 flex flex-wrap gap-x-10 gap-y-5 border-t border-line pt-7"
            {...enter(0.42)}
          >
            {[
              { v: <CountUp to={9} suffix=" days" />, l: "before the press release" },
              { v: <CountUp to={20} suffix="+" />, l: "roles to fill per raise" },
              { v: <CountUp to={7} />, l: "stages · zero hand-offs" },
            ].map((s) => (
              <div key={s.l}>
                <div className="font-display text-2xl font-semibold tracking-tight text-fg md:text-3xl">
                  {s.v}
                </div>
                <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                  {s.l}
                </div>
              </div>
            ))}
          </motion.div>
        </motion.div>

        {/* Live signal readout — parallax */}
        <motion.aside
          className="hidden self-center md:block"
          style={{ y: readoutY }}
          {...enter(0.34)}
          aria-label="Example detection signal"
        >
          <div className="w-72 rounded-lg border border-line bg-surface/60 p-5 backdrop-blur-sm">
            <div className="mb-4 flex items-center gap-2">
              <span className="relative flex size-2">
                {!reduce && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-60" />
                )}
                <span className="relative inline-flex size-2 rounded-full bg-signal" />
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-signal">
                Live signal
              </span>
            </div>
            <dl className="space-y-3">
              {SIGNAL_ROWS.map((row, i) => (
                <motion.div
                  key={row.label}
                  className="flex items-baseline justify-between gap-4 border-b border-line pb-2.5 last:border-0"
                  initial={reduce ? {} : { opacity: 0, x: 12 }}
                  animate={reduce ? {} : { opacity: 1, x: 0 }}
                  transition={{ duration: 0.5, delay: 0.5 + i * 0.08, ease: EASE_SIGNAL }}
                >
                  <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                    {row.label}
                  </dt>
                  <dd
                    className={
                      row.live
                        ? "font-mono text-xs text-signal"
                        : "font-mono text-xs text-fg-muted"
                    }
                  >
                    {row.value}
                  </dd>
                </motion.div>
              ))}
            </dl>
          </div>
        </motion.aside>
      </div>
    </header>
  )
}
