/**
 * Frontrun — HydraDB memory adapter · MANUAL live smoke test.
 *
 * Proves ingest + recall + a graphContext query against the REAL HydraDB API,
 * end to end. This is the ONLY place that makes a live HydraDB call — build and
 * `npm run typecheck` / tests never do (they use the no-op stub or a mock fetch).
 *
 * Run it yourself:
 *   HYDRA_DB_API_KEY=sk_... npx tsx scripts/hydra-smoke.ts
 *   # optional: HYDRA_DB_DATABASE=frontrun HYDRA_DB_COLLECTION=global HYDRA_DB_BASE_URL=...
 *
 * Clean up the demo data it wrote (deletes the two smoke source ids):
 *   HYDRA_DB_API_KEY=sk_... npx tsx scripts/hydra-smoke.ts --cleanup
 *
 * Exit codes: 0 = end-to-end recall succeeded (or cleanup done) · 1 = no key /
 * setup problem · 2 = ran live but recall/cleanup did not complete.
 */
import { HydraDBClient } from "@hydradb/sdk"
import { LeadStatus, type Lead } from "../shared/types"
import {
  createMemoryClient,
  readMemoryConfig,
  recallContext,
  recordDetection,
  recordOutcome,
  type MemoryConfig,
} from "../lib/memory"

/** Stable source ids the smoke run ingests (kept in sync with smokeLead()). */
const SMOKE_SOURCE_IDS = ["detection:smoke-lead-1", "outcome:smoke-lead-1:smoke-reply-1"]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function smokeLead(): Lead {
  const now = new Date().toISOString()
  return {
    id: "smoke-lead-1",
    status: LeadStatus.DETECTED,
    isDemo: true,
    signal: {
      accessionNumber: "0009999999-26-000001",
      companyName: "Hydra Smoke Robotics",
      relatedPersons: ["Dana Smoke", "Riley Test"],
      amountRaised: "$8,000,000",
      filedAt: now,
      edgarUrl: "https://www.sec.gov/example-smoke",
    },
    contact: {
      name: "Dana Smoke",
      title: "CEO",
      email: "dana@hydrasmoke.example",
      emailConfidence: "high",
      source: "manual",
    },
    createdAt: now,
    updatedAt: now,
  }
}

/** Delete the two demo sources this smoke run created. Idempotent. */
async function cleanup(config: MemoryConfig): Promise<void> {
  const client = new HydraDBClient({
    token: config.apiKey as string,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  })
  console.log(
    `HydraDB cleanup · database="${config.database}" collection="${config.collection}"`,
  )
  console.log(`deleting ${SMOKE_SOURCE_IDS.length} smoke sources: ${SMOKE_SOURCE_IDS.join(", ")}`)

  try {
    const res = await client.context.delete({
      database: config.database,
      collection: config.collection,
      ids: SMOKE_SOURCE_IDS,
      type: "memory",
    })
    const data = res.data
    const deleted = data?.deletedCount ?? 0
    console.log(`deletedCount: ${deleted}`)
    if (data?.message) console.log(`message: ${data.message}`)
    for (const item of data?.results ?? []) console.log(`  • ${JSON.stringify(item)}`)

    // Idempotent: deletedCount 0 means the sources are already gone (HydraDB
    // reports success=false in that case) — that's still a clean end-state.
    if (deleted > 0) console.log(`\nPASS · deleted ${deleted} smoke source(s).`)
    else console.log("\nPASS · nothing to delete (already clean).")
    process.exit(0)
  } catch (err) {
    console.error("\nFAIL · delete errored:", err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
}

async function main(): Promise<void> {
  const config = readMemoryConfig()
  if (!config.enabled) {
    console.error(
      "HYDRA_DB_API_KEY is not set — cannot run the live smoke test.\n" +
        "Run: HYDRA_DB_API_KEY=sk_... npx tsx scripts/hydra-smoke.ts",
    )
    process.exit(1)
  }

  if (process.argv.slice(2).includes("--cleanup")) {
    await cleanup(config)
    return
  }

  const client = createMemoryClient(config)
  const lead = smokeLead()
  console.log(
    `HydraDB smoke · database="${config.database}" collection="${config.collection}"` +
      (config.baseUrl ? ` baseUrl="${config.baseUrl}"` : " (default env)"),
  )

  // 1) INGEST — detection graph write.
  const det = await recordDetection(lead, { client, config })
  if (!det.written) {
    console.error("FAIL · ingest (detection) did not write:", det.error ?? "unknown error")
    process.exit(2)
  }
  console.log(`1. ingest OK · source ${det.sourceId} (company + founders + round + edges)`)

  // 2) INGEST — an outcome, so recall has an interaction + a REPLIED edge.
  const out = await recordOutcome(
    lead,
    { id: "smoke-reply-1", from: lead.contact!.email!, rawText: "Yes — let's find time this week." },
    "green",
    { client, config },
  )
  console.log(`2. ingest OK · source ${out.sourceId} (contact —REPLIED_GREEN→ company)`)

  // 3) RECALL + graphContext — poll, since ingestion is asynchronous ("queued").
  const maxTries = 12
  const delayMs = 2500
  let recalled = await recallContext(lead, { client, config })
  for (let attempt = 1; attempt < maxTries && !recalled.found; attempt++) {
    console.log(`   …recall attempt ${attempt}/${maxTries} — nothing yet, waiting ${delayMs}ms`)
    await sleep(delayMs)
    recalled = await recallContext(lead, { client, config })
  }

  if (recalled.error) console.error("   recall error:", recalled.error)

  console.log("3. recall (mode=thinking, graphContext=true):")
  console.log(`   memories (${recalled.memories.length}):`)
  for (const m of recalled.memories.slice(0, 5)) console.log(`     • ${m}`)
  console.log(`   graph triplets (${recalled.triplets.length}):`)
  for (const t of recalled.triplets.slice(0, 10)) console.log(`     • ${t.source} —${t.predicate}→ ${t.target}`)
  if (recalled.synthesis) console.log(`   synthesis: ${recalled.synthesis}`)

  if (!recalled.found) {
    console.error(
      `\nRAN LIVE, but recall returned no context after ${maxTries} tries. ` +
        "Ingestion may still be processing — re-run in a moment.",
    )
    process.exit(2)
  }

  console.log("\nPASS · ingest + recall + graphContext verified end to end.")
  process.exit(0)
}

main().catch((err) => {
  console.error("smoke test threw:", err)
  process.exit(2)
})
