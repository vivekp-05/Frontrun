/**
 * Frontrun — Workstream D · Send test harness (no test runner needed)
 * -------------------------------------------------------------------
 * Verifies the MOCK send path: one send returns messageId+sentAt, a parallel
 * batch of 3 all succeed, and bad input (no draft / no contact) fails loudly.
 * Also exercises the REAL Resend path against an injected fake fetch, so the
 * request shape (auth, from, to, tags) is asserted without a live network call.
 *
 * Run:  npx tsx workstream-d-outreach/send.test.ts
 */

import { send, sendMany, createSendProvider, SendError } from "./send"
import { LeadStatus, type Lead } from "@shared/types"

function demoLead(overrides: Partial<Lead> = {}): Lead {
  const now = new Date().toISOString()
  return {
    id: "lead_demo_1",
    status: LeadStatus.DRAFTED,
    isDemo: true,
    signal: {
      accessionNumber: "0001234567-26-000123",
      companyName: "Northwind Robotics",
      relatedPersons: ["Alex Rivera"],
      filedAt: now,
    },
    contact: {
      name: "Alex Rivera",
      email: "alex@northwindrobotics.com",
      emailConfidence: "high",
      source: "nimble",
    },
    draft: {
      subject: "Congrats on the raise — staffing help?",
      body: "Hi Alex,\n\nSaw Northwind just closed its Series A. Happy to help you staff up fast.\n\nDana",
      createdAt: now,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${detail}` : ""}`)
}

async function main() {
  // 1) Mock send returns telemetry.
  const status = await send(demoLead(), { mock: true })
  check("mock send returns messageId", Boolean(status.messageId), status.messageId)
  check("mock send returns sentAt", Boolean(status.sentAt))

  // 2) Parallel batch of 3 (the demo moment) all succeed.
  const leads = [
    demoLead({ id: "lead_demo_1" }),
    demoLead({ id: "lead_demo_2" }),
    demoLead({ id: "lead_demo_3" }),
  ]
  const batch = await sendMany(leads, { mock: true })
  check("parallel batch size is 3", batch.length === 3)
  check("all 3 sent (no errors)", batch.every((r) => r.status && !r.error))
  check(
    "each send has a distinct messageId",
    new Set(batch.map((r) => r.status?.messageId)).size === 3,
  )

  // 3) Bad input fails loudly (same in mock + real).
  let threw = false
  try {
    await send(demoLead({ draft: undefined }), { mock: true })
  } catch (e) {
    threw = e instanceof SendError
  }
  check("missing draft throws SendError", threw)

  threw = false
  try {
    await send(demoLead({ contact: undefined }), { mock: true })
  } catch (e) {
    threw = e instanceof SendError
  }
  check("missing contact email throws SendError", threw)

  // 4) REAL path request shape — assert against an injected fake fetch.
  let captured: { url: string; init: RequestInit } | undefined
  const fakeFetch = (async (url: any, init: any) => {
    captured = { url: String(url), init }
    return new Response(JSON.stringify({ id: "resend_abc123" }), { status: 200 })
  }) as unknown as typeof fetch

  const provider = createSendProvider({
    apiKey: "re_test_key",
    fromEmail: "dana@frontrun.dev",
    fromName: "Dana",
    fetchImpl: fakeFetch,
  })
  const realStatus = await provider.send(demoLead())
  const body = JSON.parse((captured?.init?.body as string) ?? "{}")
  const headers = (captured?.init?.headers ?? {}) as Record<string, string>

  check("real path hits /emails", captured?.url.endsWith("/emails") ?? false)
  check("real path sends bearer auth", headers.Authorization === "Bearer re_test_key")
  check("real path from includes sender", String(body.from).includes("dana@frontrun.dev"))
  check("real path to is the contact", body.to?.[0] === "alex@northwindrobotics.com")
  check("real path tags the lead id", body.tags?.[0]?.value === "lead_demo_1")
  check("real path returns resend id", realStatus.messageId === "resend_abc123")

  console.log(
    `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`,
  )
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
