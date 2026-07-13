/**
 * POST /api/webhooks/calcom — Cal.com BOOKING_CREATED webhook.
 * Verifies the HMAC signature and flips the lead to BOOKED via A's store.
 */
import { store } from "@a/store"
import { createCalcomRoute } from "@d/routes"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = createCalcomRoute({ store })
