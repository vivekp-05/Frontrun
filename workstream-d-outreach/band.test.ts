/**
 * Frontrun — Workstream D · Band triage test harness (no test runner needed)
 * --------------------------------------------------------------------------
 * Proves the Band-orchestrated triage:
 *   1) LOCAL coordinator (mock) classifies green/yellow/red + drafts, and records
 *      a 3-turn transcript (summarize → classify → draft).
 *   2) LIVE Band path (fake fetch) coordinates via the Chat Tasks API — turns are
 *      posted, via === "band" — while the reasoning runs through the gateway.
 *   3) Band unreachable → graceful downgrade to the local coordinator (via "local"),
 *      classification unaffected.
 *   4) bandTriageRunner wires straight into a Resend webhook end-to-end.
 *
 * Run:  npx tsx workstream-d-outreach/band.test.ts   (no keys, no network)
 * Exits non-zero on any failure so it gates the test:d step.
 */

import {
  createBandTriageAgent,
  bandTriageRunner,
  type BandCoordination,
} from "./band"
import { triage, type InboundReply } from "./triage"
import { handleResendWebhook } from "./webhooks"
import { MemStore } from "./store.mock"
import { LeadStatus, type Lead } from "@shared/types"

let failures = 0
function check(name: string, cond: boolean, extra = "") {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"} · ${name}${extra ? ` — ${extra}` : ""}`)
}

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
      filedAt: now,
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

const GREEN = "This is timely — yes, let's talk. When are you free?"
const YELLOW = "Who are you and how did you get my email?"
const RED = "Not interested, please remove me from your list."

// --- 1) Local coordinator (mock) --------------------------------------------

async function testLocal() {
  console.log("\n== Local coordinator (mock) ==")
  const lead = demoLead()

  const cases = [
    { name: "green", text: GREEN, expect: "green", draft: true },
    { name: "yellow", text: YELLOW, expect: "yellow", draft: true },
    { name: "red", text: RED, expect: "red", draft: false },
  ] as const

  for (const c of cases) {
    let log: BandCoordination | undefined
    const agent = createBandTriageAgent({
      local: true,
      onCoordination: (l) => (log = l),
    })
    // Force mock so the reasoning is deterministic + offline.
    const ev = await triage(reply(c.text), lead, { mock: true, llm: agent })

    check(`${c.name}: classified ${ev.classification}`, ev.classification === c.expect, `want ${c.expect}`)
    check(`${c.name}: draft ${Boolean(ev.nextStepDraft)}`, Boolean(ev.nextStepDraft) === c.draft, `want ${c.draft}`)
    check(`${c.name}: coordination logged`, Boolean(log))
    check(`${c.name}: via local`, log?.via === "local", log?.via)
    check(`${c.name}: 3 coordinated turns`, log?.turns.length === 3, String(log?.turns.length))
    check(
      `${c.name}: turn roles summarize→classify→draft`,
      log?.turns.map((t) => t.role).join(",") === "summarizer,classifier,drafter",
      log?.turns.map((t) => t.role).join(","),
    )
    check(
      `${c.name}: agents carry owner/slug handles`,
      log?.turns.every((t) => /^[\w.-]+\/frontrun-\w+$/.test(t.agent)) ?? false,
    )
  }
}

// --- Fake fetch: serves BOTH the gateway and the Band API -------------------

const AGENT_CREDS = {
  summarizer: { id: "a_s", handle: "tester/frontrun-summarizer", key: "k_s" },
  classifier: { id: "a_c", handle: "tester/frontrun-classifier", key: "k_c" },
  drafter: { id: "a_d", handle: "tester/frontrun-drafter", key: "k_d" },
}

// Fake fetch: serves BOTH the InsForge gateway and the real Band Agent API shape.
function fakeFetch(opts: { bandStatus?: number } = {}) {
  const calls: { url: string; body: any; key?: string }[] = []
  const impl = async (url: string, init?: any): Promise<Response> => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ url, body, key: init?.headers?.["X-API-Key"] })

    // InsForge AI Gateway — response shape is { text }, path .../chat/completion.
    if (url.includes("/chat/completion")) {
      const system: string = body?.messages?.[0]?.content ?? ""
      // Match the "You are <Role>" prefix — the Classifier prompt mentions
      // "Summarizer" in its body, so a loose includes() would misroute it.
      let text = ""
      if (system.startsWith("You are Classifier")) text = "green"
      else if (system.startsWith("You are Summarizer")) text = "The prospect wants to talk and asked about availability."
      else text = JSON.stringify({ subject: "Re: quick intro", body: "Great — here's my calendar." })
      return new Response(JSON.stringify({ text }), { status: 200 })
    }

    // Band Agent API (base .../api/v1). Responses are nested under `data`.
    const status = opts.bandStatus ?? 200
    if (url.endsWith("/messages")) return new Response(JSON.stringify({ data: { id: "m1", success: true } }), { status })
    if (url.endsWith("/participants")) return new Response(JSON.stringify({ data: { id: "p1" } }), { status })
    if (url.endsWith("/tasks")) return new Response(JSON.stringify({ data: { id: "t1" } }), { status })
    if (url.endsWith("/agent/chats")) return new Response(JSON.stringify({ data: { id: "chat_1" } }), { status })
    return new Response(JSON.stringify({ data: { ok: true } }), { status })
  }
  return { impl: impl as unknown as typeof fetch, calls }
}

// --- 2) Live Band path (fake fetch) -----------------------------------------

async function testLiveBand() {
  console.log("\n== Live Band path (fake fetch) ==")
  const lead = demoLead()
  const { impl, calls } = fakeFetch()

  let log: BandCoordination | undefined
  const agent = createBandTriageAgent({
    agents: AGENT_CREDS,
    baseUrl: "https://app.band.test/api/v1",
    fetchImpl: impl,
    onCoordination: (l) => (log = l),
  })

  const ev = await triage(reply(GREEN), lead, {
    // live gateway, routed through the same fake fetch
    gatewayUrl: "https://gw.test/v1",
    apiKey: "ik_test",
    fetchImpl: impl,
    llm: agent,
  })

  check("live: classified green", ev.classification === "green", ev.classification)
  check("live: has next-step draft", Boolean(ev.nextStepDraft))
  check("live: via band", log?.via === "band", log?.via)
  check("live: chat id from Band", log?.chatId === "chat_1", log?.chatId)
  const messagePosts = calls.filter((c) => c.url.endsWith("/messages")).length
  check("live: 3 @mention handoffs posted", messagePosts === 3, String(messagePosts))
  check("live: 2 peers recruited", calls.filter((c) => c.url.endsWith("/participants")).length === 2)
  // Each turn posts under its OWN agent key (multi-agent, not one identity).
  const msgKeys = calls.filter((c) => c.url.endsWith("/messages")).map((c) => c.key)
  check("live: turns posted under distinct agent keys", new Set(msgKeys).size === 3, msgKeys.join(","))
  const gatewayCalls = calls.filter((c) => c.url.includes("/chat/completion")).length
  check("live: 3 gateway calls (reasoning underneath)", gatewayCalls === 3, String(gatewayCalls))
}

// --- 3) Band unreachable → local downgrade ----------------------------------

async function testDowngrade() {
  console.log("\n== Band unreachable → local downgrade ==")
  const lead = demoLead()
  const { impl } = fakeFetch({ bandStatus: 500 }) // Band API 500s; gateway still ok

  let log: BandCoordination | undefined
  const agent = createBandTriageAgent({
    agents: AGENT_CREDS,
    baseUrl: "https://app.band.test/api/v1",
    fetchImpl: impl,
    onCoordination: (l) => (log = l),
  })

  const ev = await triage(reply(GREEN), lead, {
    gatewayUrl: "https://gw.test/v1",
    apiKey: "ik_test",
    fetchImpl: impl,
    llm: agent,
  })

  check("downgrade: still classified green", ev.classification === "green", ev.classification)
  check("downgrade: via local (honest — Band didn't coordinate)", log?.via === "local", log?.via)
  check("downgrade: still 3 coordinated turns", log?.turns.length === 3, String(log?.turns.length))
}

// --- 4) End-to-end through a Resend webhook ---------------------------------

async function testWebhookWiring() {
  console.log("\n== bandTriageRunner wired into a Resend webhook ==")
  const store = new MemStore()
  const lead = demoLead()
  lead.status = LeadStatus.DELIVERED // reply proves delivery; start delivered
  await store.upsertLead(lead)

  // Inject the Band runner as the webhook's triage; force mock so it's offline.
  const runner = bandTriageRunner({ local: true })
  const res = await handleResendWebhook(
    {
      type: "email.received",
      data: {
        to: "dana+lead_demo_1@frontrun.test",
        from: "alex@northwindrobotics.com",
        text: GREEN,
      },
    },
    { store, triage: runner, triageOpts: { mock: true } },
  )

  check("webhook: triaged action", res.action === "triaged", res.action)
  check("webhook: classified green", res.classification === "green", res.classification)
  const after = await store.getLead("lead_demo_1")
  check("webhook: lead advanced to FOLLOW_UP_DRAFTED", after?.status === LeadStatus.FOLLOW_UP_DRAFTED, after?.status)
  check("webhook: next-step draft persisted", Boolean(after?.replies?.[0]?.nextStepDraft))
}

// --- Runner -----------------------------------------------------------------

async function main() {
  await testLocal()
  await testLiveBand()
  await testDowngrade()
  await testWebhookWiring()
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
