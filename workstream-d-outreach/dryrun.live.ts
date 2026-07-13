/**
 * Frontrun — Workstream D · FULL LIVE dry-run (demo rehearsal).
 * Everything real except the outbound email (Resend forced mock — no verified
 * domain yet, and honesty: never send to a non-controlled address):
 *   A's InsForge store (persistence)  +  Band 3-agent mesh (real coordination)
 *   +  InsForge AI Gateway (real LLM summarize/classify/draft)  +  Cal.com booking.
 *
 * Run:  set -a; source .env.local; set +a; npx tsx workstream-d-outreach/dryrun.live.ts
 */
import { InsforgeStore } from "../workstream-a-backend/store"
import { runOutreach } from "./send"
import { handleResendWebhook, handleCalcomWebhook } from "./webhooks"
import { bandTriageRunner, type BandCoordination } from "./band"
import { LeadStatus, type Lead } from "@shared/types"

const ID = "lead_dryrun_1"

async function main() {
  const store = new InsforgeStore()
  if (!(await store.ping())) { console.log("InsForge unreachable — abort."); process.exit(1) }

  const now = new Date().toISOString()
  const lead: Lead = {
    id: ID,
    status: LeadStatus.DRAFTED,
    isDemo: true,
    signal: { accessionNumber: "dryrun-1", companyName: "Northwind Robotics", relatedPersons: ["Alex Rivera"], amountRaised: "$12,000,000", filedAt: now },
    contact: { name: "Alex Rivera", title: "CEO", email: "alex@northwindrobotics.com", emailConfidence: "high", source: "nimble" },
    draft: { subject: "Congrats on the raise — staffing help?", body: "Hi Alex, saw Northwind just closed its Series A — happy to help you staff up fast.", createdAt: now },
    replies: [],
    createdAt: now, updatedAt: now,
  }
  await store.upsertLead(lead)

  // Run outreach (mock send) → SENT
  await runOutreach([lead], store, { mock: true })
  console.log(`SENT      → ${(await store.getLead(ID))?.status}`)

  // Delivered → DELIVERED
  await handleResendWebhook({ type: "email.delivered", data: { tags: [{ name: "lead_id", value: ID }] } }, { store })
  console.log(`DELIVERED → ${(await store.getLead(ID))?.status}`)

  // Inbound green reply → REAL Band coordination + REAL InsForge reasoning
  let coord: BandCoordination | undefined
  const triage = bandTriageRunner({ onCoordination: (l) => (coord = l) })
  const r = await handleResendWebhook(
    {
      type: "email.received",
      data: {
        to: `dana+${ID}@frontrun.test`,
        from: "alex@northwindrobotics.com",
        text: "This is great timing — we just closed our Series A and need to hire ~20 engineers this quarter. Yes, let's talk. When are you free this week?",
      },
    },
    { store, triage, triageOpts: {} }, // no mock → live gateway + live Band
  )
  console.log(`REPLIED   → triaged: ${r.classification}`)

  // Band coordination trail (the prize story)
  console.log(`\n── Band coordination (${coord?.via}) · room ${coord?.chatId} ──`)
  for (const t of coord?.turns ?? []) console.log(`   @${t.agent}  [${t.role}] ${t.output.slice(0, 90)}`)

  const afterReply = await store.getLead(ID)
  console.log(`\nlead status → ${afterReply?.status}`)
  const draft = afterReply?.replies?.[0]?.nextStepDraft
  console.log(`\n── Drafted next step (real LLM) ──\nSubject: ${draft?.subject}\n${draft?.body}`)

  // Booking → BOOKED
  await handleCalcomWebhook({ triggerEvent: "BOOKING_CREATED", payload: { metadata: { leadId: ID }, startTime: "2026-07-21T16:00:00Z" } }, { store })
  const final = await store.getLead(ID)
  console.log(`\nBOOKED    → ${final?.status} (bookedAt ${final?.outreach?.bookedAt})`)

  const ok = final?.status === LeadStatus.BOOKED && coord?.via === "band"
  console.log(`\n${ok ? "FULL LIVE DRY-RUN OK — A store + Band mesh + InsForge LLM + booking." : "CHECK ABOVE — something ran in fallback."}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
