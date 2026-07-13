/**
 * Frontrun — Workstream D · Band LIVE check (manual; hits real Band, network).
 * Not part of `test:d`. Uses the registered agent keys from .env.local and runs
 * triage with MOCK reasoning (no LLM/gateway spend) but REAL Band coordination —
 * proving band.ts's HttpBandClient drives the live Agent API end-to-end.
 *
 * Run:  set -a; source .env.local; set +a; npx tsx workstream-d-outreach/band.live.ts
 */
import { createBandTriageAgent, type BandCoordination } from "./band"
import { triage, type InboundReply } from "./triage"
import { LeadStatus, type Lead } from "@shared/types"

const now = new Date().toISOString()
const lead: Lead = {
  id: "lead_live_1",
  status: LeadStatus.REPLIED,
  isDemo: true,
  signal: { accessionNumber: "x", companyName: "Northwind Robotics", relatedPersons: ["Alex Rivera"], filedAt: now },
  contact: { name: "Alex Rivera", title: "CEO", email: "alex@northwindrobotics.com", emailConfidence: "high", source: "nimble" },
  draft: { subject: "Congrats on the raise — staffing help?", body: "Hi Alex...", createdAt: now },
  createdAt: now,
  updatedAt: now,
}
const reply: InboundReply = {
  id: "reply_live_1",
  receivedAt: now,
  from: "alex@northwindrobotics.com",
  rawText: "This is timely — yes, let's talk. When are you free this week?",
}

async function main() {
  let log: BandCoordination | undefined
  const agent = createBandTriageAgent({ onCoordination: (l) => (log = l) })

  const ev = await triage(reply, lead, { mock: true, llm: agent }) // mock reasoning, real Band

  console.log("classification:", ev.classification)
  console.log("via:", log?.via, "| chatId:", log?.chatId)
  console.log("turns:")
  for (const t of log?.turns ?? []) console.log(`  ${t.role} (${t.agent}) [${t.ms}ms]: ${t.output.slice(0, 80)}`)
  console.log(log?.via === "band" ? "\nLIVE OK — coordinated via real Band." : "\nFELL BACK TO LOCAL — check agent keys in .env.local.")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
