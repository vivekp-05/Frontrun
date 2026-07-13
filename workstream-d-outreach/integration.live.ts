/**
 * Frontrun — Workstream D · Integration smoke: D loop over A's REAL InsForge store.
 * Not part of test:d (hits live InsForge). Proves the back-half state machine
 * persists through A's InsforgeStore end-to-end:
 *   DRAFTED → runOutreach → SENT → delivered → DELIVERED → reply → REPLIED
 *           → triage → GREEN → FOLLOW_UP_DRAFTED → booking → BOOKED
 * Resend is forced to MOCK (no real emails); triage uses MOCK reasoning
 * (deterministic, free) so this isolates the store integration.
 *
 * Run:  set -a; source .env.local; set +a; npx tsx workstream-d-outreach/integration.live.ts
 */
import { InsforgeStore } from "../workstream-a-backend/store"
import { runOutreach } from "./send"
import { handleResendWebhook, handleCalcomWebhook } from "./webhooks"
import { LeadStatus, type Lead } from "@shared/types"

const ID = "lead_smoke_d1"

async function main() {
  const store = new InsforgeStore()
  console.log(`InsForge base: ${process.env.INSFORGE_PROJECT_URL} | table: ${process.env.INSFORGE_LEADS_TABLE ?? "leads"}`)

  // 0) Connectivity — SELECT 1.
  const up = await store.ping()
  console.log(`[ping] InsForge reachable: ${up}`)
  if (!up) {
    console.log("Aborting — InsForge not reachable (check keys / rawsql endpoint).")
    process.exit(1)
  }

  const show = async (label: string) => {
    const l = await store.getLead(ID)
    console.log(`  ${label.padEnd(22)} status=${l?.status} outreach=${JSON.stringify(l?.outreach ?? {})}`)
    return l
  }

  // 1) Seed a DRAFTED demo lead directly (upsert sets status, bypassing the FSM),
  //    so re-runs reset cleanly regardless of the prior terminal state.
  const now = new Date().toISOString()
  const lead: Lead = {
    id: ID,
    status: LeadStatus.DRAFTED,
    isDemo: true,
    signal: { accessionNumber: "smoke-1", companyName: "Northwind Robotics", relatedPersons: ["Alex Rivera"], filedAt: now },
    contact: { name: "Alex Rivera", title: "CEO", email: "alex@northwindrobotics.com", emailConfidence: "high", source: "nimble" },
    draft: { subject: "Congrats on the raise — staffing help?", body: "Hi Alex, saw Northwind just closed its round...", createdAt: now },
    replies: [],
    createdAt: now,
    updatedAt: now,
  }
  await store.upsertLead(lead)
  await show("1. seeded DRAFTED")

  // 2) Run outreach (Resend forced mock) → SENT
  const results = await runOutreach([lead], store, { mock: true })
  console.log(`  runOutreach: ${JSON.stringify(results[0])}`)
  await show("2. after outreach")

  // 3) Resend delivery webhook → DELIVERED
  await handleResendWebhook(
    { type: "email.delivered", data: { tags: [{ name: "lead_id", value: ID }] } },
    { store },
  )
  await show("3. after delivered")

  // 4) Inbound reply (green) → REPLIED → GREEN → FOLLOW_UP_DRAFTED (mock triage)
  const r = await handleResendWebhook(
    {
      type: "email.received",
      data: { to: `dana+${ID}@frontrun.test`, from: "alex@northwindrobotics.com", text: "This is timely — yes, let's talk. When are you free?" },
    },
    { store, triageOpts: { mock: true } },
  )
  console.log(`  triage webhook: action=${r.action} class=${r.classification}`)
  const afterReply = await show("4. after reply+triage")
  console.log(`  reply persisted: class=${afterReply?.replies?.[0]?.classification} draftSubject="${afterReply?.replies?.[0]?.nextStepDraft?.subject ?? ""}"`)

  // 5) Cal.com booking → BOOKED
  await handleCalcomWebhook(
    { triggerEvent: "BOOKING_CREATED", payload: { metadata: { leadId: ID }, startTime: "2026-07-20T15:00:00Z" } },
    { store },
  )
  const final = await show("5. after booking")

  const ok = final?.status === LeadStatus.BOOKED
  console.log(`\n${ok ? "LOOP OK — persisted through A's InsForge store to BOOKED." : "INCOMPLETE — see statuses above."}`)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
