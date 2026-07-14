"use client"

import { motion, useReducedMotion } from "framer-motion"
import { cn } from "@/lib/utils"

/**
 * The Frontrun signal motif — a dark, glowing sphere with concentric detection
 * pulses and a slow radar sweep. The recurring brand device (hero + close),
 * our answer to a soft-orb hero without copying it. Respects reduced-motion.
 */
export function SignalOrb({
  className,
  size = 300,
}: {
  className?: string
  size?: number
}) {
  const reduce = useReducedMotion()
  return (
    <div
      aria-hidden
      className={cn("relative", className)}
      style={{ width: size, height: size }}
    >
      {/* concentric detection pulses */}
      {!reduce &&
        [0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="absolute inset-0 rounded-full border border-signal/25"
            initial={{ scale: 0.55, opacity: 0 }}
            animate={{ scale: 1.35, opacity: [0, 0.45, 0] }}
            transition={{ duration: 4.5, repeat: Infinity, delay: i * 1.5, ease: "easeOut" }}
          />
        ))}

      {/* static ring */}
      <div className="absolute inset-[8%] rounded-full border border-line" />

      {/* the sphere */}
      <div
        className="absolute inset-[16%] rounded-full"
        style={{
          background:
            "radial-gradient(circle at 34% 28%, color-mix(in oklab, var(--signal) 60%, #0b1418) 0%, #0c1620 48%, #06080b 100%)",
          boxShadow:
            "0 0 90px -20px color-mix(in oklab, var(--signal) 45%, transparent), inset 0 0 70px -12px color-mix(in oklab, var(--signal) 30%, transparent)",
        }}
      />

      {/* radar sweep */}
      {!reduce && (
        <motion.div
          className="absolute inset-[16%] overflow-hidden rounded-full"
          animate={{ rotate: 360 }}
          transition={{ duration: 7, repeat: Infinity, ease: "linear" }}
        >
          <div
            className="absolute left-1/2 top-0 h-1/2 w-1/2 origin-bottom-left"
            style={{
              background:
                "conic-gradient(from 0deg, color-mix(in oklab, var(--signal) 42%, transparent), transparent 55%)",
            }}
          />
        </motion.div>
      )}
    </div>
  )
}
