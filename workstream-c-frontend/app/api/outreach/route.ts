/**
 * POST /api/outreach — the "Run outreach" action. Sends the demo leads that are
 * ready (isDemo + DRAFTED) via D's runOutreach (real Resend when keyed, else mock),
 * persisting SENT + telemetry through A's store. Only demo leads are ever sent.
 */
import { store } from "@a/store"
import { runOutreach } from "@d/send"
import { LeadStatus } from "@shared/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const all = await store.listLeads()
    const ready = all.filter((l) => l.isDemo && l.status === LeadStatus.DRAFTED)
    const sent = await runOutreach(ready, store)
    return Response.json({ count: sent.length, sent })
  } catch (err) {
    return Response.json({ count: 0, error: String(err) }, { status: 200 })
  }
}
