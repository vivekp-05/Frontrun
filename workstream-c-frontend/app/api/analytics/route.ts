/**
 * GET /api/analytics — funnel analytics computed from A's live leads.
 */
import { store } from "@a/store"
import { computeFunnel } from "@a/analytics"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const funnel = computeFunnel(await store.listLeads())
    return Response.json(funnel)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 200 })
  }
}
