/**
 * Frontrun — Workstream D · Full-loop integration test
 * ----------------------------------------------------
 * Drives the entire D-scope pipeline through the REAL handlers, end to end:
 *   seed 3 demo leads -> runOutreach (SENT) -> delivered webhook (DELIVERED)
 *   -> inbound replies (green/yellow/red) -> triage -> classification + drafts
 *   -> Cal.com booking (BOOKED) -> idempotent duplicate webhook (no-op).
 *
 * Everything runs against MemStore + mock send + mock triage, so it passes with
 * zero network / keys. Run:  npx tsx workstream-d-outreach/webhooks.test.ts
 */

import { LeadStatus } from "@shared/types"
import { MemStore } from "./store.mock"
import { seed } from "./seed"
import { runOutreach } from "./send"
import { handleResendWebhook, handleCalcomWebhook } from "./webhooks"

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${detail}` : ""}`)
}

const INBOXES = [
  "founder1@demo.test",
  "founder2@demo.test",
  "founder3@demo.test",
]

// Simulate an inbound Resend reply, plus-addressed back to the lead.
function inbound(leadId: string, from: string, text: string) {
  return {
    type: "email.received",
    data: {
      email_id: `in_${leadId}_${Math.random().toString(36).slice(2, 7)}`,
      from,
      to: [`dana+${leadId}@frontrun.dev`],
      subject: "Re: Congrats on the raise",
      text,
    },
  }
}

async function main() {
  const store = new MemStore()
  const deps = { store, triageOpts: { mock: true as const } }

  // 1) Seed + verify demo leads.
  const seeded = await seed(store, { inboxes: INBOXES })
  check("seeded 3 demo leads", seeded.length === 3)
  check("all marked isDemo", seeded.every((l) => l.isDemo))
  check("demo status DRAFTED", seeded.every((l) => l.status === LeadStatus.DRAFTED))

  // 2) Run outreach in parallel -> SENT.
  const results = await runOutreach(seeded, store, { mock: true })
  check("outreach sent all 3", results.every((r) => r.status && !r.error))
  const afterSend = await store.listLeads()
  check("all at SENT", afterSend.every((l) => l.status === LeadStatus.SENT))
  check(
    "messageId persisted",
    afterSend.every((l) => Boolean(l.outreach?.messageId)),
  )

  // 3) Delivery webhook for demo_1 -> DELIVERED.
  const del = await handleResendWebhook(
    { type: "email.delivered", data: { tags: [{ name: "lead_id", value: "demo_1" }] } },
    deps,
  )
  check("delivered handled", del.action === "delivered", del.action)
  check(
    "demo_1 is DELIVERED",
    (await store.getLead("demo_1"))?.status === LeadStatus.DELIVERED,
  )

  // 4) GREEN reply -> REPLIED -> GREEN -> FOLLOW_UP_DRAFTED.
  const green = await handleResendWebhook(
    inbound("demo_1", INBOXES[0], "This is great timing — yes, let's talk. When are you free?"),
    deps,
  )
  check("green classified", green.classification === "green", String(green.classification))
  const l1 = await store.getLead("demo_1")
  check("demo_1 FOLLOW_UP_DRAFTED", l1?.status === LeadStatus.FOLLOW_UP_DRAFTED, l1?.status)
  check("green reply has next-step draft", Boolean(l1?.replies?.[0]?.nextStepDraft))
  check("green reply summarized", Boolean(l1?.replies?.[0]?.summary))

  // 5) RED reply (demo_2, from-email fallback, no plus tag) -> LOST.
  const redPayload = {
    type: "email.received",
    data: {
      email_id: "in_demo_2_x",
      from: INBOXES[1],
      to: ["dana@frontrun.dev"], // no plus tag -> forces from-email match
      text: "Not interested, please remove me from your list.",
    },
  }
  const red = await handleResendWebhook(redPayload, deps)
  check("red classified", red.classification === "red", String(red.classification))
  const l2 = await store.getLead("demo_2")
  check("demo_2 is LOST", l2?.status === LeadStatus.LOST, l2?.status)
  check("red reply has NO draft (opt-out)", !l2?.replies?.[0]?.nextStepDraft)

  // 6) YELLOW reply (demo_3) -> FOLLOW_UP_DRAFTED.
  const yellow = await handleResendWebhook(
    inbound("demo_3", INBOXES[2], "Who are you and how did you get my email?"),
    deps,
  )
  check("yellow classified", yellow.classification === "yellow", String(yellow.classification))
  const l3 = await store.getLead("demo_3")
  check("demo_3 FOLLOW_UP_DRAFTED", l3?.status === LeadStatus.FOLLOW_UP_DRAFTED, l3?.status)

  // 7) Cal.com booking for demo_1 (attendee email match) -> BOOKED.
  const book = await handleCalcomWebhook(
    {
      triggerEvent: "BOOKING_CREATED",
      payload: { attendees: [{ email: INBOXES[0] }], startTime: new Date().toISOString() },
    },
    deps,
  )
  check("booking handled", book.action === "booked", book.action)
  const l1b = await store.getLead("demo_1")
  check("demo_1 is BOOKED", l1b?.status === LeadStatus.BOOKED, l1b?.status)
  check("bookedAt recorded", Boolean(l1b?.outreach?.bookedAt))

  // 8) Idempotency: replay the delivered webhook for a booked lead -> no crash, still BOOKED.
  await handleResendWebhook(
    { type: "email.delivered", data: { tags: [{ name: "lead_id", value: "demo_1" }] } },
    deps,
  )
  check(
    "duplicate webhook is no-op",
    (await store.getLead("demo_1"))?.status === LeadStatus.BOOKED,
  )

  // 9) Unmatched inbound -> graceful.
  const unmatched = await handleResendWebhook(
    inbound("does_not_exist", "stranger@nowhere.test", "hi"),
    deps,
  )
  check("unmatched inbound is graceful", unmatched.ok && unmatched.action === "reply:unmatched")

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
