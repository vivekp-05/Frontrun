/**
 * Frontrun client — Track A backend API.
 *
 * The dashboard reads live leads/analytics straight from A's status API
 * (GET /leads, /analytics) and drives the real outreach loop (POST /outreach +
 * the Resend/Cal.com webhook routes). Same `Lead` shape end to end, so the UI
 * that rendered the simulation renders real InsForge data unchanged.
 */
import type { Lead, FunnelAnalytics } from "@shared/types"

export const API_BASE =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_URL) || "http://localhost:4000"

async function jf<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json() as Promise<T>
}

export const fetchLeads = () => jf<Lead[]>("/leads")
export const fetchAnalytics = () => jf<FunnelAnalytics>("/analytics")

export const upsertLead = (lead: Lead) =>
  jf<Lead>("/leads", { method: "POST", body: JSON.stringify(lead) })

export const runOutreach = (ids?: string[]) =>
  jf<{ attempted: number; results: unknown[] }>("/outreach", {
    method: "POST",
    body: JSON.stringify(ids ? { ids } : {}),
  })

export const resendWebhook = (body: unknown) =>
  jf("/webhooks/resend", { method: "POST", body: JSON.stringify(body) })

export const calcomWebhook = (body: unknown) =>
  jf("/webhooks/calcom", { method: "POST", body: JSON.stringify(body) })

/** Is A's backend reachable? Used to decide live-vs-simulation fallback. */
export async function backendUp(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`, { cache: "no-store" })
    return res.ok
  } catch {
    return false
  }
}
