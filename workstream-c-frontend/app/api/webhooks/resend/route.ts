/**
 * POST /api/webhooks/resend — Resend delivery + inbound-reply webhook.
 * Verifies the Svix signature, fetches the inbound body, runs Band triage, and
 * drives the state machine through A's store. (D's adapter; needs node:crypto.)
 */
import { store } from "@a/store"
import { createResendRoute } from "@d/routes"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = createResendRoute({ store })
