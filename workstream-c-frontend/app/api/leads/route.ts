/**
 * GET /api/leads — live leads from A's InsForge StoreProvider.
 * On any failure returns 200 + empty list so the dashboard falls back to the sim.
 */
import { store } from "@a/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const leads = await store.listLeads()
    return Response.json({ leads })
  } catch (err) {
    return Response.json({ leads: [], error: String(err) })
  }
}
