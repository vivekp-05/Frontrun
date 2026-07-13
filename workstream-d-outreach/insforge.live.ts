/**
 * Frontrun — Workstream D · InsForge gateway LIVE check (manual; network).
 * Makes REAL model calls through the InsForge Model Gateway. Not part of test:d.
 *
 * Run:  set -a; source .env.local; set +a; npx tsx workstream-d-outreach/insforge.live.ts
 */
import { chatComplete, triage, __internals, type InboundReply } from "./triage"
import { LeadStatus, type Lead } from "@shared/types"

async function main() {
  const opts = __internals.resolveOptions({})
  console.log(`gatewayUrl=${opts.gatewayUrl} | model=${opts.model} | mock=${opts.mock}`)
  if (opts.mock) {
    console.log("Resolved to MOCK — INSFORGE_PROJECT_URL/API_KEY not in env. Aborting.")
    process.exit(1)
  }

  // 1) Direct gateway ping — proves auth + JSON mode work.
  try {
    const raw = await chatComplete(
      [
        { role: "system", content: "You reply with strict JSON only." },
        { role: "user", content: 'Return exactly {"ok": true, "greeting": "hello from insforge"} as JSON.' },
      ],
      opts,
      { jsonMode: true },
    )
    console.log("\n[gateway ping] OK — raw:", raw.slice(0, 200))
  } catch (e) {
    console.log("\n[gateway ping] ERROR:", (e as Error).message)
    process.exit(1)
  }

  // 2) Full triage with REAL reasoning (plain gatewayAgent path).
  const now = new Date().toISOString()
  const lead: Lead = {
    id: "lead_ins_1",
    status: LeadStatus.REPLIED,
    isDemo: true,
    signal: { accessionNumber: "x", companyName: "Northwind Robotics", relatedPersons: ["Alex Rivera"], filedAt: now },
    contact: { name: "Alex Rivera", title: "CEO", email: "alex@northwindrobotics.com", emailConfidence: "high", source: "nimble" },
    draft: { subject: "Congrats on the raise — staffing help?", body: "Hi Alex...", createdAt: now },
    createdAt: now,
    updatedAt: now,
  }
  const reply: InboundReply = {
    id: "reply_ins_1",
    receivedAt: now,
    from: "alex@northwindrobotics.com",
    rawText: "This is timely — yes, let's talk. We're hiring 20 people this quarter. When are you free?",
  }
  const ev = await triage(reply, lead, {}) // real gateway (no mock, no Band)
  console.log("\n[triage] classification:", ev.classification)
  console.log("[triage] summary:", ev.summary)
  console.log("[triage] draft subject:", ev.nextStepDraft?.subject)
  console.log("[triage] draft body[0]:", ev.nextStepDraft?.body.split("\n")[0])
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
