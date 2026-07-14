import { Reveal, RevealGroup, RevealItem } from "./reveal"

const TIMELINE = [
  {
    day: "Day 0",
    event: "Form D hits SEC EDGAR. Nobody is watching.",
    tone: "signal" as const,
  },
  {
    day: "Day 2",
    event: "The fastest agency hears a rumor, starts researching.",
    tone: "muted" as const,
  },
  {
    day: "Day 9",
    event: "The press release drops. 10 agencies send the same template.",
    tone: "muted" as const,
  },
  {
    day: "Day 10",
    event: "The deal is already gone.",
    tone: "danger" as const,
  },
]

export function Problem() {
  return (
    <section className="border-b border-line">
      <div className="mx-auto grid w-full max-w-6xl gap-12 px-6 py-20 md:grid-cols-2 md:gap-20 md:py-24">
        <Reveal>
          <p className="kicker">02 / The problem</p>
          <h2 className="mt-5 font-display text-3xl font-semibold tracking-tight text-fg md:text-4xl">
            First to the inbox
            <br />
            wins the deal.
          </h2>
          <p className="mt-6 max-w-md leading-relaxed text-fg-muted">
            A company that just raised a Series A will hire 20–50 people next
            quarter — and 10 recruiting agencies race to the same door.
            Whoever reaches out first wins the placements.
          </p>
          <p className="mt-4 max-w-md leading-relaxed text-fg-muted">
            Small agencies lose twice: they find out late, and they reach out
            generic. The filing was public the whole time.
          </p>
        </Reveal>

        <RevealGroup className="self-center" stagger={0.16}>
          <ol className="border-l border-line">
            {TIMELINE.map((t) => (
              <RevealItem key={t.day}>
                <li className="relative py-4 pl-6">
                  <span
                    aria-hidden
                    className={
                      t.tone === "signal"
                        ? "absolute -left-px top-5 h-4 w-[2px] rounded-[2px] bg-signal"
                        : t.tone === "danger"
                          ? "absolute -left-px top-5 h-4 w-[2px] rounded-[2px] bg-danger"
                          : "absolute -left-px top-5 h-4 w-[2px] rounded-[2px] bg-line-strong"
                    }
                  />
                  <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-fg-subtle">
                    {t.day}
                  </span>
                  <p
                    className={
                      t.tone === "danger"
                        ? "mt-1 text-sm text-danger"
                        : "mt-1 text-sm text-fg"
                    }
                  >
                    {t.event}
                  </p>
                </li>
              </RevealItem>
            ))}
          </ol>
        </RevealGroup>
      </div>
    </section>
  )
}
