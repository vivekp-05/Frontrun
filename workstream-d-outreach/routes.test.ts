/**
 * Frontrun — Workstream D · Route adapter + signature test harness
 * ----------------------------------------------------------------
 * Proves the HTTP glue: a correctly-signed Resend/Cal.com request verifies,
 * parses, dispatches, and drives the state machine; a tampered or unsigned
 * request is rejected 401; a bad body is 400; and the dev bypass (no secret) works.
 *
 * Run:  npx tsx workstream-d-outreach/routes.test.ts   (no keys, no network)
 */

import crypto from "node:crypto"
import { createResendRoute, createCalcomRoute } from "./routes"
import { MemStore } from "./store.mock"
import { LeadStatus, type Lead } from "@shared/types"

let failures = 0
function check(name: string, cond: boolean, extra = "") {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"} · ${name}${extra ? ` — ${extra}` : ""}`)
}

function leadAt(status: LeadStatus): Lead {
  const now = new Date().toISOString()
  return {
    id: "lead_demo_1",
    status,
    isDemo: true,
    signal: { accessionNumber: "x", companyName: "Northwind Robotics", relatedPersons: [], filedAt: now },
    contact: { name: "Alex Rivera", email: "alex@northwindrobotics.com", emailConfidence: "high", source: "nimble" },
    draft: { subject: "hi", body: "hi", createdAt: now },
    outreach: { messageId: "m_1", sentAt: now },
    createdAt: now,
    updatedAt: now,
  }
}

// --- Signing helpers (mirror signatures.ts) ---------------------------------

const RESEND_SECRET = "whsec_" + Buffer.from("frontrun-resend-test-key").toString("base64")
const CAL_SECRET = "frontrun-calcom-test-secret"

function signResend(body: string, tamper = false) {
  const id = "msg_test"
  const ts = String(Math.floor(Date.now() / 1000))
  const key = Buffer.from(RESEND_SECRET.slice(6), "base64")
  const sig = crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")
  return {
    "svix-id": id,
    "svix-timestamp": ts,
    "svix-signature": `v1,${tamper ? "AAAA" + sig.slice(4) : sig}`,
    "content-type": "application/json",
  }
}

function signCal(body: string, tamper = false) {
  const sig = crypto.createHmac("sha256", CAL_SECRET).update(body).digest("hex")
  return {
    "x-cal-signature-256": tamper ? "deadbeef" + sig.slice(8) : sig,
    "content-type": "application/json",
  }
}

function req(body: string, headers: Record<string, string>): Request {
  return new Request("https://frontrun.test/api/webhooks", { method: "POST", headers, body })
}

// --- Cases ------------------------------------------------------------------

async function main() {
  // 1) Resend delivery — valid signature drives SENT → DELIVERED.
  {
    const store = new MemStore()
    await store.upsertLead(leadAt(LeadStatus.SENT))
    const route = createResendRoute({ store }, { secret: RESEND_SECRET })
    const body = JSON.stringify({
      type: "email.delivered",
      data: { tags: [{ name: "lead_id", value: "lead_demo_1" }] },
    })
    const res = await route(req(body, signResend(body)))
    const out = await res.json()
    check("resend delivered: 200", res.status === 200, String(res.status))
    check("resend delivered: action", out.action === "delivered", out.action)
    check("resend delivered: lead DELIVERED", (await store.getLead("lead_demo_1"))?.status === LeadStatus.DELIVERED)
  }

  // 2) Resend with a TAMPERED signature → 401, no state change.
  {
    const store = new MemStore()
    await store.upsertLead(leadAt(LeadStatus.SENT))
    const route = createResendRoute({ store }, { secret: RESEND_SECRET })
    const body = JSON.stringify({ type: "email.delivered", data: { tags: [{ name: "lead_id", value: "lead_demo_1" }] } })
    const res = await route(req(body, signResend(body, true)))
    check("resend tampered: 401", res.status === 401, String(res.status))
    check("resend tampered: lead unchanged (still SENT)", (await store.getLead("lead_demo_1"))?.status === LeadStatus.SENT)
  }

  // 3) Resend missing signature headers → 401.
  {
    const store = new MemStore()
    const route = createResendRoute({ store }, { secret: RESEND_SECRET })
    const res = await route(req("{}", { "content-type": "application/json" }))
    check("resend unsigned: 401", res.status === 401, String(res.status))
  }

  // 4) Bad JSON with a valid signature → 400.
  {
    const store = new MemStore()
    const route = createResendRoute({ store }, { secret: RESEND_SECRET })
    const body = "not json{"
    const res = await route(req(body, signResend(body)))
    check("resend bad json: 400", res.status === 400, String(res.status))
  }

  // 5) Cal.com booking — valid signature drives GREEN-ish lead → BOOKED.
  {
    const store = new MemStore()
    await store.upsertLead(leadAt(LeadStatus.GREEN))
    const route = createCalcomRoute({ store }, { secret: CAL_SECRET })
    const body = JSON.stringify({
      triggerEvent: "BOOKING_CREATED",
      payload: { metadata: { leadId: "lead_demo_1" }, startTime: "2026-07-20T15:00:00Z" },
    })
    const res = await route(req(body, signCal(body)))
    const out = await res.json()
    check("calcom booking: 200", res.status === 200, String(res.status))
    check("calcom booking: action", out.action === "booked", out.action)
    check("calcom booking: lead BOOKED", (await store.getLead("lead_demo_1"))?.status === LeadStatus.BOOKED)
  }

  // 6) Cal.com tampered signature → 401.
  {
    const store = new MemStore()
    await store.upsertLead(leadAt(LeadStatus.GREEN))
    const route = createCalcomRoute({ store }, { secret: CAL_SECRET })
    const body = JSON.stringify({ triggerEvent: "BOOKING_CREATED", payload: { metadata: { leadId: "lead_demo_1" } } })
    const res = await route(req(body, signCal(body, true)))
    check("calcom tampered: 401", res.status === 401, String(res.status))
    check("calcom tampered: lead unchanged (still GREEN)", (await store.getLead("lead_demo_1"))?.status === LeadStatus.GREEN)
  }

  // 7) Dev bypass — no secret configured → verification passes.
  {
    const store = new MemStore()
    await store.upsertLead(leadAt(LeadStatus.SENT))
    const route = createResendRoute({ store }, { secret: undefined })
    const body = JSON.stringify({ type: "email.delivered", data: { tags: [{ name: "lead_id", value: "lead_demo_1" }] } })
    const res = await route(req(body, { "content-type": "application/json" }))
    check("dev bypass: 200 without signature", res.status === 200, String(res.status))
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
