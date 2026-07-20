"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowRight, Lock, Mail, Globe } from "lucide-react"
import { Wordmark } from "@/components/frontrun/signature"

export default function GatePage() {
  const router = useRouter()
  const [key, setKey] = useState("")
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!key.trim() || loading) return
    setLoading(true)
    setError(false)
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      })
      if (res.ok) {
        router.push("/")
        router.refresh()
        return
      }
      setError(true)
    } catch {
      setError(true)
    }
    setLoading(false)
  }

  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden bg-background px-6 text-foreground">
      {/* faint signal grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.3]"
        style={{
          backgroundImage: "linear-gradient(to right, var(--line) 1px, transparent 1px)",
          backgroundSize: "160px 100%",
        }}
      />

      <div className="relative w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Wordmark showDescriptor={false} />
        </div>

        <div className="rounded-xl border border-line bg-surface p-7 shadow-2xl shadow-black/20">
          <span className="inline-flex items-center gap-2 rounded-md border border-line bg-inset px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
            <Lock className="size-3" />
            Private dashboard
          </span>

          <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-fg">
            This dashboard is private.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-fg-muted">
            The live FrontRun dashboard is available by request. Have an access
            key? Enter it below. Otherwise, reach out and I&apos;ll get you in.
          </p>

          <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
            <input
              type="password"
              value={key}
              onChange={(e) => {
                setKey(e.target.value)
                if (error) setError(false)
              }}
              placeholder="Access key"
              autoFocus
              aria-label="Access key"
              className="h-11 w-full rounded-md border border-line-strong bg-inset px-3.5 font-mono text-sm text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-signal"
            />
            <button
              type="submit"
              disabled={loading}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-signal px-5 font-medium text-signal-foreground transition-colors hover:bg-signal-strong disabled:opacity-60"
            >
              {loading ? "Unlocking…" : "Unlock dashboard"}
              {!loading && <ArrowRight className="size-4" />}
            </button>
          </form>

          {error && (
            <p className="mt-3 text-sm text-red-400">
              That key didn&apos;t work. Reach out for access below.
            </p>
          )}

          <div className="mt-7 border-t border-line pt-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-faint">
              Reach out for access
            </p>
            <div className="mt-3 flex flex-col gap-2.5">
              <a
                href="mailto:in.vivekpatel@gmail.com"
                className="inline-flex items-center gap-2.5 text-sm text-fg-muted transition-colors hover:text-fg"
              >
                <Mail className="size-4 text-fg-subtle" />
                in.vivekpatel@gmail.com
              </a>
              <a
                href="https://vivek-patel.xyz"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2.5 text-sm text-fg-muted transition-colors hover:text-fg"
              >
                <Globe className="size-4 text-fg-subtle" />
                vivek-patel.xyz
              </a>
            </div>
          </div>
        </div>

        <div className="mt-6 text-center">
          <Link
            href="/pitch"
            className="font-mono text-[11px] uppercase tracking-[0.16em] text-fg-subtle transition-colors hover:text-fg"
          >
            ← Back to overview
          </Link>
        </div>
      </div>
    </main>
  )
}
