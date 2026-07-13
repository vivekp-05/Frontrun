/**
 * Frontrun — Workstream D · REAL inbound proof (manual; hits live Resend).
 * Feeds handleResendWebhook a metadata-only email.received (like Resend actually
 * sends) carrying a REAL received-email id, with the real createResendInboundFetcher.
 * Proves: metadata webhook → fetch real body from Resend → map lead → triage.
 *
 * Pass the received email id as argv[2] (from GET /emails/receiving).
 * Run: set -a; source .env.local; set +a; npx tsx workstream-d-outreach/inbound.live.ts <emailId>
 */
import { handleResendWebhook } from "./webhooks"
import { createResendInboundFetcher } from "./send"
import { MemStore } from "./store.mock"
import { LeadStatus, type Lead } from "@shared/types"

async function main() {
  const EMAIL_ID = process.argv[2]
  if (!EMAIL_ID) { console.log("usage: inbound.live.ts <receivedEmailId>"); process.exit(1) }

  const store = new MemStore()
  const now = new Date().toISOString()
  const lead: Lead = {
    id: "lead_livetest", status: LeadStatus.DELIVERED, isDemo: true,
    signal: { accessionNumber: "x", companyName: "Northwind Robotics", relatedPersons: [], filedAt: now },
    contact: { name: "Alex Rivera", email: "alex@northwindrobotics.com", emailConfidence: "high", source: "nimble" },
    draft: { subject: "Congrats on the raise — staffing help?", body: "Hi Alex...", createdAt: now },
    outreach: { messageId: "m", sentAt: now, deliveredAt: now }, replies: [],
    createdAt: now, updatedAt: now,
  }
  await store.upsertLead(lead)

  const fetchInbound = createResendInboundFetcher()
  console.log("fetchInbound wired from RESEND_API_KEY:", Boolean(fetchInbound))

  // Metadata-only payload — exactly what Resend's email.received delivers (no body).
  const r = await handleResendWebhook(
    {
      type: "email.received",
      data: {
        email_id: EMAIL_ID,
        to: ["dana+lead_livetest@untuemei.resend.app"],
        from: "alex@northwindrobotics.com",
        subject: "Re: Congrats on the raise — staffing help?",
      },
    },
    { store, fetchInbound, triageOpts: { mock: true } },
  )

  console.log("webhook action:", r.action, "| classification:", r.classification)
  const l = await store.getLead("lead_livetest")
  console.log("lead status:", l?.status)
  console.log("raw reply text (fetched live from Resend):", JSON.stringify(l?.replies?.[0]?.rawText))
  const ok = l?.status === LeadStatus.FOLLOW_UP_DRAFTED && Boolean(l?.replies?.[0]?.rawText)
  console.log(ok ? "\nREAL INBOUND OK — metadata webhook → live body fetch → triage → FOLLOW_UP_DRAFTED." : "\nCHECK ABOVE")
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
