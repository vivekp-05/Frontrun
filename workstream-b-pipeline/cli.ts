import { createStore } from "../workstream-a-backend/store"
import { readPipelineEnv } from "./env"
import { runRocketRidePipeline } from "./rocketride"

declare const process: {
  argv: string[]
  env: Record<string, string | undefined>
  stdin: AsyncIterable<string | Uint8Array>
  exitCode?: number
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const stdinArgs = args.jsonStdin ? await readJsonStdin() : {}
  const input = { ...args, ...stdinArgs }
  const env = readPipelineEnv()
  const store = input.persist ? createStore() : undefined
  const result = await runRocketRidePipeline(
    {
      domain: input.domain,
      persist: input.persist,
      includeFunds: input.includeFunds,
    },
    {
      env,
      store,
    },
  )

  const lead = result.lead
  const payload = {
    steps: result.steps,
    lead: {
      id: lead.id,
      status: lead.status,
      companyName: lead.signal.companyName,
      filedAt: lead.signal.filedAt,
      edgarUrl: lead.signal.edgarUrl,
      fundingConfirmed: lead.brief?.fundingConfirmed,
      researchSummary: lead.brief?.summary,
      citations: lead.brief?.citations,
      contact: lead.contact,
      email: lead.contact?.email,
      leadScore: lead.leadScore,
      draft: lead.draft,
      draftEmail: lead.draft,
    },
  }

  console.log(JSON.stringify(payload, null, 2))
}

function parseArgs(args: string[]): { domain?: string; persist: boolean; includeFunds: boolean; jsonStdin: boolean } {
  const parsed: { domain?: string; persist: boolean; includeFunds: boolean; jsonStdin: boolean } = {
    persist: false,
    includeFunds: false,
    jsonStdin: false,
  }

  for (const arg of args) {
    if (arg === "--persist") parsed.persist = true
    if (arg === "--include-funds") parsed.includeFunds = true
    if (arg === "--json-stdin") parsed.jsonStdin = true
    if (arg.startsWith("--domain=")) parsed.domain = arg.slice("--domain=".length)
  }

  return parsed
}

async function readJsonStdin(): Promise<Partial<ReturnType<typeof parseArgs>>> {
  const chunks: Uint8Array[] = []

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
  }

  const input = new TextDecoder().decode(concat(chunks)).trim()
  if (!input) return {}

  const parsed = JSON.parse(input) as {
    domain?: string
    persist?: boolean
    includeFunds?: boolean
    include_funds?: boolean
  }

  return {
    domain: parsed.domain,
    persist: parsed.persist ?? false,
    includeFunds: parsed.includeFunds ?? parsed.include_funds ?? false,
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(length)
  let offset = 0

  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }

  return output
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})
