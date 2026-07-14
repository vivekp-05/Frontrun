/**
 * Frontrun — HydraDB memory adapter tests (no test runner; run with tsx).
 *
 *   npx tsx lib/memory/memory.test.ts
 *
 * Zero network, zero API key required — like store.test.ts / triage.test.ts.
 * Covers: config flip, no-op client, request builders (payload correctness via a
 * spy client), recall parsing, fail-soft behavior, and the real SDK wired to an
 * injected mock fetch. Exits non-zero on any failure so it gates CI.
 */
import { LeadStatus, type Lead, type ReplyClassification } from "../../shared/types"
import { readMemoryConfig } from "./config"
import {
  createMemoryClient,
  type MemoryClient,
  type IngestRequest,
  type QueryRequest,
  type RetrievalResult,
} from "./client"
import { recordDetection, buildDetectionIngest } from "./graph"
import { recallContext, parseRecall } from "./recall"
import { recordOutcome } from "./outcomes"

let passed = 0
let failed = 0
function ok(name: string, cond: boolean): void {
  if (cond) {
    passed++
    console.log("PASS  " + name)
  } else {
    failed++
    console.log("FAIL  " + name)
  }
}

// --- Fixtures ---------------------------------------------------------------

function demoLead(): Lead {
  const now = "2026-07-13T00:00:00.000Z"
  return {
    id: "lead_1",
    status: LeadStatus.DETECTED,
    isDemo: true,
    signal: {
      accessionNumber: "0001234567-26-000123",
      companyName: "Northwind Robotics",
      relatedPersons: ["Alex Rivera", "Sam Okafor"],
      amountRaised: "$12,000,000",
      filedAt: now,
      edgarUrl: "https://www.sec.gov/example",
    },
    contact: {
      name: "Alex Rivera",
      title: "CEO",
      email: "alex@northwindrobotics.com",
      emailConfidence: "high",
      source: "nimble",
    },
    draft: { subject: "Congrats on the raise", body: "Hi Alex, ...", createdAt: now },
    createdAt: now,
    updatedAt: now,
  }
}

const CONFIG = { database: "frontrun", collection: "global", enabled: true, apiKey: "k" }

/** Records the last ingest/query request and returns a scripted result. */
class SpyMemoryClient implements MemoryClient {
  readonly enabled = true
  ingests: IngestRequest[] = []
  queries: QueryRequest[] = []
  constructor(private readonly result: RetrievalResult | undefined = undefined) {}
  async ingest(request: IngestRequest): Promise<void> {
    this.ingests.push(request)
  }
  async query(request: QueryRequest): Promise<RetrievalResult | undefined> {
    this.queries.push(request)
    return this.result
  }
}

/** Always throws — proves fail-soft wrapping. */
class BrokenMemoryClient implements MemoryClient {
  readonly enabled = true
  async ingest(): Promise<void> {
    throw new Error("boom")
  }
  async query(): Promise<RetrievalResult | undefined> {
    throw new Error("boom")
  }
}

async function main(): Promise<void> {
  const lead = demoLead()

  // ── config ──
  const noKey = readMemoryConfig({ apiKey: undefined })
  ok("config: no key → disabled", noKey.enabled === false)
  ok("config: defaults database/collection", noKey.database === "frontrun" && noKey.collection === "global")
  const withKey = readMemoryConfig({ apiKey: "k", database: "d", collection: "c" })
  ok("config: key → enabled + overrides win", withKey.enabled === true && withKey.database === "d" && withKey.collection === "c")

  // ── no-op client (zero key) ──
  const noop = createMemoryClient(noKey)
  ok("client: no key → disabled no-op", noop.enabled === false)
  ok("no-op query returns undefined", (await noop.query({})) === undefined)
  const dWrite = await recordDetection(lead, { client: noop, config: noKey })
  ok("recordDetection no key → skipped, not written", dWrite.written === false && dWrite.skipped === true)
  const rRead = await recallContext(lead, { client: noop, config: noKey })
  ok("recallContext no key → skipped, empty", rRead.skipped === true && rRead.found === false && rRead.memories.length === 0)

  // ── recordDetection builds the correct ingest payload ──
  const detSpy = new SpyMemoryClient()
  const det = await recordDetection(lead, { client: detSpy, config: CONFIG })
  ok("recordDetection → written with stable sourceId", det.written === true && det.sourceId === "detection:lead_1")
  const detReq = detSpy.ingests[0]
  ok("ingest: tenant + collection + memory type + upsert", detReq?.tenantId === "frontrun" && detReq?.subTenantId === "global" && detReq?.type === "memory" && detReq?.upsert === "true")
  const detMemories = JSON.parse(detReq!.memories!)
  ok("ingest: one memory, stable id, company in text", detMemories.length === 1 && detMemories[0].id === "detection:lead_1" && /Northwind Robotics/.test(detMemories[0].text))
  ok("ingest: memory metadata (object) carries leadId", detMemories[0].metadata.leadId === "lead_1")
  const detGraph = JSON.parse(detReq!.graphPayload!)["detection:lead_1"]
  ok("graph: company + 2 founders + round entities", detGraph.entities.company.name === "Northwind Robotics" && detGraph.entities.founder_0.name === "Alex Rivera" && detGraph.entities.founder_1.name === "Sam Okafor" && detGraph.entities.round.type === "FUNDING_ROUND")
  const preds = detGraph.relations.map((r: { predicate: string }) => r.predicate)
  ok("graph: FOUNDED (x2) + RAISED edges", preds.filter((p: string) => p === "FOUNDED").length === 2 && preds.includes("RAISED"))

  // builder is pure + independent of a client
  const pure = buildDetectionIngest(lead, "detection:lead_1", CONFIG)
  ok("buildDetectionIngest is pure/deterministic", JSON.stringify(pure) === JSON.stringify(detReq))

  // ── round omitted when no amount + no edgar url ──
  const bare: Lead = { ...lead, signal: { ...lead.signal, amountRaised: undefined, edgarUrl: undefined } }
  const bareGraph = JSON.parse(buildDetectionIngest(bare, "detection:lead_1", CONFIG).graphPayload!)["detection:lead_1"]
  ok("graph: no round entity without amount/edgar", bareGraph.entities.round === undefined && !bareGraph.relations.some((r: { predicate: string }) => r.predicate === "RAISED"))

  // ── recall builds the query + parses results ──
  const canned: RetrievalResult = {
    chunks: [{ chunkContent: "Northwind raised $12M Series A; founder Alex Rivera." }],
    graphContext: {
      queryPaths: [
        {
          triplets: [
            {
              source: { name: "Alex Rivera" },
              relation: { canonicalPredicate: "FOUNDED" },
              target: { name: "Northwind Robotics" },
            },
          ],
        },
      ],
      synthesisContext: "Known prior raise and founder.",
    },
  }
  const recSpy = new SpyMemoryClient(canned)
  const rec = await recallContext(lead, { client: recSpy, config: CONFIG })
  const q = recSpy.queries[0]
  ok("recall query: database/collection/type/mode/graphContext", q?.database === "frontrun" && q?.collection === "global" && q?.type === "all" && q?.mode === "thinking" && q?.graphContext === true)
  ok("recall query mentions company + founders", /Northwind Robotics/.test(q!.query!) && /Alex Rivera/.test(q!.query!))
  ok("recall: found true with memory + triplet", rec.found === true && rec.memories.length === 1 && rec.triplets.length === 1)
  ok("recall: triplet flattened source→predicate→target", rec.triplets[0].source === "Alex Rivera" && rec.triplets[0].predicate === "FOUNDED" && rec.triplets[0].target === "Northwind Robotics")
  ok("recall: synthesis surfaced", rec.synthesis === "Known prior raise and founder.")
  ok("parseRecall(undefined) → empty, not found", parseRecall(undefined).found === false)

  // ── recordOutcome builds the correct payload ──
  const outSpy = new SpyMemoryClient()
  const cls: ReplyClassification = "green"
  const out = await recordOutcome(lead, { id: "r1", from: "alex@northwindrobotics.com", rawText: "Yes, let's talk!" }, cls, { client: outSpy, config: CONFIG })
  ok("recordOutcome → written with composite sourceId", out.written === true && out.sourceId === "outcome:lead_1:r1")
  const outReq = outSpy.ingests[0]
  const outMem = JSON.parse(outReq!.memories!)[0]
  ok("outcome memory: classification in metadata + text", outMem.metadata.classification === "green" && /GREEN/.test(outMem.text))
  const outRel = JSON.parse(outReq!.graphPayload!)["outcome:lead_1:r1"].relations[0]
  ok("outcome graph: contact —REPLIED_GREEN→ company", outRel.source === "contact" && outRel.target === "company" && outRel.predicate === "REPLIED_GREEN")

  // ── fail-soft: a throwing client never propagates ──
  const broken = new BrokenMemoryClient()
  const failWrite = await recordDetection(lead, { client: broken, config: CONFIG })
  ok("recordDetection fail-soft: written false + error, no throw", failWrite.written === false && !!failWrite.error)
  const failRead = await recallContext(lead, { client: broken, config: CONFIG })
  ok("recallContext fail-soft: found false + error, no throw", failRead.found === false && !!failRead.error)
  const failOut = await recordOutcome(lead, { id: "r1", from: "x", rawText: "no" }, "red", { client: broken, config: CONFIG })
  ok("recordOutcome fail-soft: written false + error, no throw", failOut.written === false && !!failOut.error)

  // ── real SDK client wired to an injected mock fetch ──
  const calls: { url: string; auth: string | null }[] = []
  const mockFetch = (async (input: unknown, init?: RequestInit) => {
    const req = input as { url?: string; headers?: HeadersInit }
    const url = typeof input === "string" ? input : req?.url ?? String(input)
    const headers = new Headers(init?.headers ?? req?.headers)
    calls.push({ url, auth: headers.get("authorization") })
    return new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch

  const live = createMemoryClient(CONFIG, { fetchImpl: mockFetch })
  ok("client: with key → enabled (real SDK)", live.enabled === true)
  const liveResult = await live.query({ database: "frontrun", type: "all", query: "hi", graphContext: true })
  ok("mock-fetch: query hit fetch with bearer token", calls.length === 1 && calls[0].auth === "Bearer k")
  ok("mock-fetch: empty envelope resolves to an object (no throw)", typeof liveResult === "object")
  ok("mock-fetch: no-key path never calls fetch", createMemoryClient(noKey, { fetchImpl: mockFetch }).enabled === false && calls.length === 1)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
