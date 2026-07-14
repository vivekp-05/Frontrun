import { cn } from "@/lib/utils"

/**
 * Frontrun wordmark — type-led SaaS identity. The one brand device is a small
 * Signal-Cyan accent tick after the name (the Padzy accent tick). No icon mark.
 */
export function Wordmark({
  className,
  showDescriptor = true,
  size = "md",
}: {
  className?: string
  showDescriptor?: boolean
  size?: "md" | "lg"
}) {
  const textSize = size === "lg" ? "text-[24px]" : "text-[17px]"
  const tick =
    size === "lg"
      ? "mb-[4px] ml-1.5 h-[10px] w-[15px]"
      : "mb-[3px] ml-1 h-[7px] w-[11px]"
  return (
    <div className={cn("flex flex-col", className)}>
      {showDescriptor && (
        <span className="kicker mb-1.5 text-[9px]">Autonomous SDR</span>
      )}
      <span
        className={cn(
          "flex items-end font-display font-semibold leading-none tracking-tight text-foreground",
          textSize,
        )}
      >
        Frontrun
        <span aria-hidden className={cn("rounded-[1px] bg-signal", tick)} />
      </span>
    </div>
  )
}
