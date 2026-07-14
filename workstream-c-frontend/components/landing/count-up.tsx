"use client"

import { useEffect, useRef, useState } from "react"
import { animate, useInView, useReducedMotion } from "framer-motion"

const EASE_SIGNAL = [0.2, 0, 0, 1] as const

/** Counts from 0 → `to` once it scrolls into view. Static under reduced-motion. */
export function CountUp({
  to,
  suffix = "",
  prefix = "",
  duration = 1.3,
}: {
  to: number
  suffix?: string
  prefix?: string
  duration?: number
}) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: "-40px" })
  const [n, setN] = useState(0)

  useEffect(() => {
    if (!inView) return
    if (reduce) {
      setN(to)
      return
    }
    const controls = animate(0, to, {
      duration,
      ease: EASE_SIGNAL,
      onUpdate: (v) => setN(Math.round(v)),
    })
    return () => controls.stop()
  }, [inView, to, duration, reduce])

  return (
    <span ref={ref} className="tabular-nums">
      {prefix}
      {n}
      {suffix}
    </span>
  )
}
