import { SponsorLogo, type Sponsor } from "./sponsor-logo"

const BELT: Sponsor[] = [
  { slug: "insforge", name: "InsForge" },
  { slug: "youcom", name: "You.com" },
  { slug: "nimble", name: "Nimble" },
  { slug: "rocketride", name: "RocketRide" },
  { slug: "band", name: "Band" },
  { slug: "hydra", name: "Hydra DB" },
  { slug: "resend", name: "Resend" },
  { slug: "calcom", name: "Cal.com" },
  { slug: "tavily", name: "Tavily" },
]

/**
 * Infinite horizontal marquee of the full reward stack. Two identical copies of
 * the row scroll -50% for a seamless loop; pauses on hover; reduced motion stops
 * it globally. Reusable (embedded in the closing screen).
 */
export function SponsorMarquee() {
  return (
    <div
      className="belt group relative overflow-hidden"
      style={{
        maskImage:
          "linear-gradient(to right, transparent, black 12%, black 88%, transparent)",
      }}
    >
      <style>{`
        @keyframes belt-scroll {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
        .belt-track { animation: belt-scroll 36s linear infinite; width: max-content; }
        .belt:hover .belt-track { animation-play-state: paused; }
        @media (prefers-reduced-motion: reduce) {
          .belt-track { animation: none; }
        }
      `}</style>
      <div className="belt-track flex items-center">
        {[0, 1].map((copy) => (
          <ul key={copy} aria-hidden={copy === 1} className="flex shrink-0 items-center">
            {BELT.map((s) => (
              <li
                key={s.slug}
                className="flex h-16 items-center border-r border-line px-10 opacity-60 transition-opacity duration-[var(--dur-fast)] hover:opacity-100"
              >
                <SponsorLogo sponsor={s} imgClassName="h-5" />
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  )
}
