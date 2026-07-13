/**
 * Frontrun — Workstream D · Triage test harness (no test runner needed)
 * ---------------------------------------------------------------------
 * Runs the deterministic MOCK path against 3 canned replies and asserts the
 * green / yellow / red classification + next-step-draft behavior.
 *
 * Run:  npx tsx workstream-d-outreach/triage.test.ts
 * (or)  node --experimental-strip-types workstream-d-outreach/triage.test.ts
 *
 * Exits non-zero on any failure so it can gate CI / the typecheck step.
 */

import { triage, bookingLinkFor, type InboundReply } from "./triage"
import { LeadStatus, type Lead } from "@shared/types"

// --- Fixtures ---------------------------------------------------------------

function demoLead(): Lead {
  const now = new Date().toISOString()
  return {
    id: "lead_demo_1",
    status: LeadStatus.REPLIED,
    isDemo: true,
    signal: {
      accessionNumber: "0001234567-26-000123",
      companyName: "Northwind Robotics",
      relatedPersons: ["Alex Rivera"],
      address: "500 Howard St, San Francisco, CA",
      amountRaised: "$12,000,000",
      filedAt: now,
      edgarUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany",
    },
    contact: {
      name: "Alex Rivera",
      title: "CEO",
      email: "alex@northwindrobotics.com",
      emailConfidence: "high",
      source: "nimble",
    },
    draft: {
      subject: "Congrats on the raise — staffing help?",
      body: "Hi Alex, saw Northwind just closed its Series A...",
      createdAt: now,
    },
    createdAt: now,
    updatedAt: now,
  }
}

function reply(rawText: string): InboundReply {
  return {
    id: `reply_${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: new Date().toISOString(),
    from: "alex@northwindrobotics.com",
    rawText,
  }
}

// --- Cases ------------------------------------------------------------------

const CASES = [
  {
    name: "GREEN — interested, wants to talk",
    text: "This is timely — yes, let's talk. We're hiring 20 people this quarter. When are you free?",
    expect: "green" as const,
    expectDraft: true,
  },
  {
    name: "YELLOW — neutral question",
    text: "Who are you and how did you get my email? What does your agency actually do?",
    expect: "yellow" as const,
    expectDraft: true,
  },
  {
    name: "RED — not interested / opt-out",
    text: "Not interested, please remove me from your list. Thanks.",
    expect: "red" as const,
    expectDraft: false,
  },
]

// --- Runner -----------------------------------------------------------------

async function main() {
  let failures = 0
  const lead = demoLead()

  for (const c of CASES) {
    // Force mock so this passes offline / in the sandbox (no InsForge reach).
    const ev = await triage(reply(c.text), lead, { mock: true })
    const gotClass = ev.classification
    const gotDraft = Boolean(ev.nextStepDraft)

    const classOk = gotClass === c.expect
    const draftOk = gotDraft === c.expectDraft
    const pass = classOk && draftOk

    if (!pass) failures++

    console.log(`\n${pass ? "PASS" : "FAIL"} · ${c.name}`)
    console.log(`  reply:    ${c.text}`)
    console.log(`  summary:  ${ev.summary}`)
    console.log(
      `  class:    ${gotClass} (want ${c.expect})${classOk ? "" : "  <-- MISMATCH"}`,
    )
    console.log(
      `  draft?:   ${gotDraft} (want ${c.expectDraft})${draftOk ? "" : "  <-- MISMATCH"}`,
    )
    if (ev.nextStepDraft) {
      console.log(`  subject:  ${ev.nextStepDraft.subject}`)
      console.log(
        `  body:     ${ev.nextStepDraft.body.split("\n")[0]} ...`,
      )
    }
  }

  // --- Booking link carries the lead id (deterministic BOOKING_CREATED mapping) ---
  const link = bookingLinkFor(lead, "https://cal.com/vivek/intro")
  const linkOk =
    link.includes("metadata") && link.includes(lead.id) && link.includes("northwindrobotics.com")
  if (!linkOk) failures++
  console.log(`\n${linkOk ? "PASS" : "FAIL"} · booking link embeds leadId + prefilled email`)
  console.log(`  link: ${link}`)

  const greenEv = await triage(reply("yes, let's talk"), lead, { mock: true })
  const draftHasId = Boolean(greenEv.nextStepDraft?.body.includes(lead.id))
  if (!draftHasId) failures++
  console.log(`${draftHasId ? "PASS" : "FAIL"} · green draft links to per-lead booking url`)

  console.log(
    `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} · ${CASES.length} cases`,
  )
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
