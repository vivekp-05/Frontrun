/**
 * Frontrun — Workstream D · Band-orchestrated triage agent (the Band prize)
 * -------------------------------------------------------------------------
 * The built-in `gatewayAgent` (triage.ts) does triage in ONE monolithic LLM
 * call. This wraps the same job as a *coordinated multi-agent task* so that
 * Band — the multi-agent coordination sponsor — is load-bearing in the step:
 *
 *     Summarizer  →  Classifier  →  Drafter
 *     (summarize)    (green/yellow/red)  (next-step email, stands down on red)
 *
 * Each specialist is a distinct **registered Band agent** with its own identity
 * and API key. Per reply, they coordinate in a real Band chat room: the
 * Summarizer opens the room, recruits the Classifier + Drafter as participants,
 * and the three hand off via @mentions. Band owns the coordination + the audit
 * trail (the room transcript); the model reasoning for each turn still runs
 * through the InsForge Model Gateway underneath (shared `chatComplete`).
 *
 * Two transports behind one `BandClient` seam:
 *   - HttpBandClient        — Band's Agent API (used when the 3 agent keys are
 *                             configured). This is the prize-load-bearing path.
 *   - LocalBandOrchestrator — runs the same coordinated task in-process and keeps
 *                             a local transcript. PRD §14 fallback: if Band blocks
 *                             we still demo the multi-agent triage, losing only the
 *                             prize, never the loop.
 *
 * Resilience contract: the model reasoning (the gateway call) always runs and its
 * output is returned regardless of whether Band's cloud is reachable — posting to
 * Band is best-effort. If the room can't even be opened we downgrade to the local
 * coordinator; any hard failure bubbles to triage(), which degrades to the mock.
 *
 * VERIFIED against live Band (2026-07, docs.band.ai + app.band.ai). Real API:
 *   base  https://app.band.ai/api/v1   auth header  X-API-Key: <agentKey>
 *   POST /agent/chats                      {chat:{title}}                -> data.id
 *   POST /agent/chats/{id}/participants    {participant:{participant_id,role}}
 *   POST /agent/chats/{id}/messages        {message:{content,mentions:[{handle,id}]}}
 *   GET  /agent/chats/{id}/context         (transcript read-back)
 * Chat Tasks (Beta) 404s on Free tier, so the task board is opt-in (BAND_TASKS=1).
 * Agents are provisioned once by band.provision.mjs (writes keys to .env.local).
 */

import type { EmailDraft, Lead, ReplyClassification } from "@shared/types"
import {
  chatComplete,
  triage,
  bookingLinkFor,
  __internals,
  mockAgent,
  type ChatMessage,
  type GatewayCall,
  type InboundReply,
  type TriageInput,
  type TriageLLM,
  type TriageOptions,
  type TriageResult,
} from "./triage"

const { coerceClassification, templateDraft, defaultSubject, parseModelJson } =
  __internals

// ---------------------------------------------------------------------------
// Agents in the Band mesh
// ---------------------------------------------------------------------------

export type TriageRole = "summarizer" | "classifier" | "drafter"

/** A specialist in the mesh. id/key are set only on the live (HttpBandClient) path. */
export interface BandAgentSpec {
  role: TriageRole
  name: string
  slug: string
  /** Band handle, e.g. "owner/frontrun-summarizer". */
  handle: string
  systemPrompt: string
  /** Registered Band agent UUID (live path). */
  id?: string
  /** That agent's own API key (live path). */
  key?: string
}

type AgentDef = Pick<BandAgentSpec, "role" | "name" | "slug" | "systemPrompt">

const AGENT_DEFS: AgentDef[] = [
  {
    role: "summarizer",
    name: "Frontrun Summarizer",
    slug: "frontrun-summarizer",
    systemPrompt:
      "You are Summarizer, one agent in a coordinated reply-triage team for an " +
      "autonomous SDR at a recruiting agency. In ONE neutral sentence, summarize " +
      "what the prospect actually said in their reply. No preamble, no analysis — " +
      "output only the sentence.",
  },
  {
    role: "classifier",
    name: "Frontrun Classifier",
    slug: "frontrun-classifier",
    systemPrompt:
      "You are Classifier in the triage team. Given the prospect's reply and the " +
      "Summarizer's summary, output EXACTLY ONE word:\n" +
      "- green  = interested / positive / wants to talk or book a call.\n" +
      "- yellow = neutral, a question, 'who are you?', wants more info first.\n" +
      "- red    = not interested / negative / opt-out / 'remove me' / 'stop'.\n" +
      "An explicit opt-out beats an incidental 'yes'. Output only the single word.",
  },
  {
    role: "drafter",
    name: "Frontrun Drafter",
    slug: "frontrun-drafter",
    systemPrompt:
      "You are Drafter in the triage team. Given the classification, write the " +
      "next-step reply.\n" +
      "- green  -> short, warm reply that nudges toward booking a specific call, " +
      "and include the booking link.\n" +
      "- yellow -> short reply that answers the likely question and gently " +
      "re-invites a conversation.\n" +
      "Be concise and human. Never invent that the agency has spoken to them before. " +
      'Output STRICT JSON only: {"subject": "...", "body": "..."}.',
  },
]

/** Merge the static defs with per-agent creds + a resolved handle. */
function buildAgents(cfg: ResolvedBandOptions): BandAgentSpec[] {
  const owner = cfg.ownerHandle.replace(/^@/, "")
  return AGENT_DEFS.map((d) => {
    const cred = cfg.agents[d.role]
    return {
      ...d,
      id: cred?.id,
      key: cred?.key,
      handle: cred?.handle || `${owner}/${d.slug}`,
    }
  })
}

// ---------------------------------------------------------------------------
// Coordination transcript (audit trail — honesty + the demo "watch it think")
// ---------------------------------------------------------------------------

export interface BandTurn {
  agent: string // handle
  role: TriageRole
  output: string
  ms?: number
}

export interface BandCoordination {
  chatId: string
  /** "band" = coordinated via Band's cloud; "local" = in-process fallback. */
  via: "band" | "local"
  turns: BandTurn[]
}

/** The transport seam. Both impls coordinate the same summarize→classify→draft task. */
interface BandClient {
  readonly via: "band" | "local"
  readonly chatId: string
  readonly turns: BandTurn[]
  start(goal: string, agents: BandAgentSpec[]): Promise<void>
  /**
   * Route + record one specialist's turn. `produce` runs the actual reasoning
   * (gateway underneath) — identical across transports; the client only decides
   * where the turn is logged (Band cloud vs. local transcript). `mention` is the
   * peer this turn hands off to (Band messages must @mention to route).
   */
  turn(
    agent: BandAgentSpec,
    produce: () => Promise<string>,
    mention: BandAgentSpec,
  ): Promise<string>
  finish(note: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Local coordinator — the PRD §14 fallback (no Band dependency)
// ---------------------------------------------------------------------------

class LocalBandOrchestrator implements BandClient {
  readonly via = "local" as const
  chatId = "local"
  turns: BandTurn[] = []

  async start(goal: string, _agents: BandAgentSpec[]): Promise<void> {
    const tag = goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)
    this.chatId = `local_chat_${tag}`
  }

  async turn(
    agent: BandAgentSpec,
    produce: () => Promise<string>,
  ): Promise<string> {
    const t0 = Date.now()
    const output = await produce()
    this.turns.push({
      agent: agent.handle,
      role: agent.role,
      output,
      ms: Date.now() - t0,
    })
    return output
  }

  async finish(): Promise<void> {
    /* nothing to settle in-process */
  }
}

// ---------------------------------------------------------------------------
// Band cloud client — Agent API (the prize path, verified live)
// ---------------------------------------------------------------------------

class HttpBandClient implements BandClient {
  chatId = ""
  turns: BandTurn[] = []
  private degraded = false
  private coordinator!: BandAgentSpec

  constructor(
    private readonly cfg: ResolvedBandOptions,
    private readonly fetchImpl: typeof fetch,
  ) {}

  get via(): "band" | "local" {
    // If any Band call failed, be honest: Band did not fully coordinate this run.
    return this.degraded ? "local" : "band"
  }

  async start(goal: string, agents: BandAgentSpec[]): Promise<void> {
    this.coordinator = agents[0] // Summarizer opens + owns the room
    // Room creation must succeed — else openClient() downgrades us to local.
    const room = await this.post(this.coordinator.key!, "/agent/chats", {
      chat: { title: goal },
    })
    this.chatId = String(room?.data?.id ?? "")
    if (!this.chatId) throw new Error("band: no chat id")

    // Recruit the other specialists (best-effort; we can still post as coordinator).
    for (const a of agents.slice(1)) {
      try {
        await this.post(
          this.coordinator.key!,
          `/agent/chats/${this.chatId}/participants`,
          { participant: { participant_id: a.id, role: "member" } },
        )
      } catch {
        this.degraded = true
      }
    }

    // Chat Tasks are Beta (404 on Free) — only attempt when explicitly enabled.
    if (this.cfg.enableTasks) {
      try {
        await this.post(
          this.coordinator.key!,
          `/agent/chats/${this.chatId}/tasks`,
          { subject: goal, detail: "summarize → classify → draft" },
        )
      } catch {
        /* task board unavailable — coordination still lives in the messages */
      }
    }
  }

  async turn(
    agent: BandAgentSpec,
    produce: () => Promise<string>,
    mention: BandAgentSpec,
  ): Promise<string> {
    const t0 = Date.now()
    // Reasoning first — must succeed or bubble to triage()'s mock fallback.
    const output = await produce()
    this.turns.push({
      agent: agent.handle,
      role: agent.role,
      output,
      ms: Date.now() - t0,
    })
    // Post the turn into the room as THIS agent (its own key), @mentioning the
    // next specialist so Band routes the handoff. Best-effort: losing it costs
    // the cloud trail (and the prize for this run), never the reply itself.
    try {
      await this.post(agent.key!, `/agent/chats/${this.chatId}/messages`, {
        message: {
          content: `@${mention.handle} ${labelFor(agent.role)}: ${output}`,
          mentions: [{ handle: mention.handle, id: mention.id }],
        },
      })
    } catch {
      this.degraded = true
    }
    return output
  }

  async finish(): Promise<void> {
    /* the room + messages ARE the record; nothing else to settle */
  }

  private async post(key: string, path: string, body: unknown): Promise<any> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": key,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`band ${res.status}`)
    return res.json().catch(() => ({}))
  }
}

function labelFor(role: TriageRole): string {
  return role === "summarizer"
    ? "Summary"
    : role === "classifier"
      ? "Classification"
      : "Next-step draft"
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface AgentCred {
  id?: string
  handle?: string
  key?: string
}

export interface BandTriageOptions {
  /** Band Agent API base. Default https://app.band.ai/api/v1 */
  baseUrl?: string
  /** The @owner in owner/agent-slug handles (fallback when creds omit handle). */
  ownerHandle?: string
  /** Per-role agent credentials (id/handle/key). Default: read from env. */
  agents?: Partial<Record<TriageRole, AgentCred>>
  /** Force in-process coordination even if creds are present (tests/demo safety). */
  local?: boolean
  /** Attempt the Beta Chat Tasks board (404s on Free). Default false. */
  enableTasks?: boolean
  fetchImpl?: typeof fetch
  /** Sink for the coordination transcript (activity feed / demo drawer). */
  onCoordination?: (log: BandCoordination) => void
}

interface ResolvedBandOptions {
  baseUrl: string
  ownerHandle: string
  agents: Record<TriageRole, AgentCred>
  local: boolean
  enableTasks: boolean
  onCoordination?: (log: BandCoordination) => void
}

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined
}

function credFromEnv(role: TriageRole): AgentCred {
  const R = role.toUpperCase()
  return {
    id: env(`BAND_AGENT_${R}_ID`),
    handle: env(`BAND_AGENT_${R}_HANDLE`),
    key: env(`BAND_AGENT_${R}_KEY`),
  }
}

function resolveBandOptions(opts: BandTriageOptions): ResolvedBandOptions {
  const agents = {} as Record<TriageRole, AgentCred>
  for (const role of ["summarizer", "classifier", "drafter"] as TriageRole[]) {
    agents[role] = { ...credFromEnv(role), ...opts.agents?.[role] }
  }
  // Live coordination needs all three agents' keys (each posts under its own id).
  const haveAllKeys = (["summarizer", "classifier", "drafter"] as TriageRole[]).every(
    (r) => Boolean(agents[r].key && agents[r].id),
  )
  // Owner handle: explicit, env, or inferred from a configured agent handle.
  const inferredOwner = agents.summarizer.handle?.split("/")[0]
  return {
    baseUrl: (opts.baseUrl ?? env("BAND_API_URL") ?? "https://app.band.ai/api/v1").replace(/\/+$/, ""),
    ownerHandle: opts.ownerHandle ?? env("BAND_OWNER_HANDLE") ?? inferredOwner ?? "frontrun",
    agents,
    local: opts.local ?? !haveAllKeys,
    enableTasks: opts.enableTasks ?? env("BAND_TASKS") === "1",
    onCoordination: opts.onCoordination,
  }
}

// ---------------------------------------------------------------------------
// Per-turn reasoning (gateway underneath, or deterministic mock)
// ---------------------------------------------------------------------------

interface Shared {
  summary?: string
  classification?: ReplyClassification
  /** Precomputed once in mock mode so turns mirror the built-in classifier. */
  mock?: TriageResult
}

function summarizerMessages(input: TriageInput): ChatMessage[] {
  return [
    { role: "system", content: AGENT_DEFS[0].systemPrompt },
    {
      role: "user",
      content: `The prospect (${input.reply.from}) replied:\n"""\n${input.reply.rawText}\n"""`,
    },
  ]
}

function classifierMessages(input: TriageInput, shared: Shared): ChatMessage[] {
  return [
    { role: "system", content: AGENT_DEFS[1].systemPrompt },
    {
      role: "user",
      content:
        `Summarizer's summary: ${shared.summary ?? "(none)"}\n\n` +
        `Prospect's raw reply:\n"""\n${input.reply.rawText}\n"""\n\n` +
        `One word (green / yellow / red):`,
    },
  ]
}

function drafterMessages(input: TriageInput, shared: Shared): ChatMessage[] {
  const { lead, options } = input
  const company = lead.signal?.companyName ?? "the company"
  const contact = lead.contact?.name ?? "there"
  const originalSubject = lead.draft?.subject ?? "(unknown)"
  return [
    { role: "system", content: AGENT_DEFS[2].systemPrompt },
    {
      role: "user",
      content: `CONTEXT
Prospect company: ${company}
Prospect contact: ${contact}
Our sender: ${options.fromName} at ${options.fromCompany}
Our original outreach subject: "${originalSubject}"
Booking link (use for green, EXACTLY as-is): ${bookingLinkFor(lead, options.calLink)}

Summary of their reply: ${shared.summary ?? "(none)"}
Classification: ${shared.classification}

Write the ${shared.classification} next-step reply as JSON {"subject": "...", "body": "..."}.`,
    },
  ]
}

/** Run one specialist's turn — mock slice, or a single gateway call. */
async function runTurn(
  role: TriageRole,
  input: TriageInput,
  shared: Shared,
): Promise<string> {
  const { options } = input

  if (options.mock) {
    // Deterministic — sourced from the built-in mock so classifications stay
    // identical to the plain path (and the offline tests keep passing).
    const m = shared.mock!
    if (role === "summarizer") return m.summary
    if (role === "classifier") return m.classification
    return m.nextStepDraft
      ? JSON.stringify({
          subject: m.nextStepDraft.subject,
          body: m.nextStepDraft.body,
        })
      : ""
  }

  // Live — one gateway call per role (the model reasoning "underneath" Band).
  if (role === "summarizer") {
    return chatComplete(summarizerMessages(input), options, { jsonMode: false })
  }
  if (role === "classifier") {
    return chatComplete(classifierMessages(input, shared), options, {
      jsonMode: false,
      temperature: 0,
    })
  }
  return chatComplete(drafterMessages(input, shared), options, { jsonMode: true })
}

/** Parse the Drafter's JSON output into an EmailDraft, or template a fallback. */
function toDraft(
  raw: string,
  classification: ReplyClassification,
  input: TriageInput,
): EmailDraft {
  try {
    const j = parseModelJson(raw)
    const subject = String(j?.subject ?? "").trim()
    const body = String(j?.body ?? "").trim()
    if (subject || body) {
      return {
        subject: subject || defaultSubject(classification, input),
        body,
        createdAt: new Date().toISOString(),
      }
    }
  } catch {
    /* fall through to template */
  }
  return templateDraft(classification, input)
}

// ---------------------------------------------------------------------------
// The Band-orchestrated TriageLLM (drop-in for gatewayAgent)
// ---------------------------------------------------------------------------

/**
 * Build a `TriageLLM` that runs triage as a Band-coordinated 3-agent task.
 * Pass to `triage(reply, lead, { llm })`, or use `bandTriageRunner()` to wire it
 * straight into `WebhookDeps.triage`.
 */
export function createBandTriageAgent(opts: BandTriageOptions = {}): TriageLLM {
  const cfg = resolveBandOptions(opts)

  return {
    async classifyAndDraft(input: TriageInput): Promise<TriageResult> {
      const { options } = input
      const agents = buildAgents(cfg)
      const [summarizer, classifier, drafter] = agents
      const shared: Shared = {}
      if (options.mock) {
        shared.mock = await mockAgent.classifyAndDraft(input)
      }

      const company = input.lead.signal?.companyName ?? "the prospect"
      const goal = `Frontrun triage — ${company}`
      const fetchImpl = opts.fetchImpl ?? options.fetchImpl
      const client = await openClient(cfg, fetchImpl, goal, agents)

      // 1) Summarize → hands off to Classifier
      const summary =
        (await client.turn(summarizer, () => runTurn("summarizer", input, shared), classifier)).trim() ||
        shared.mock?.summary ||
        "(no summary)"
      shared.summary = summary

      // 2) Classify (sees the summary) → hands off to Drafter
      const classRaw = await client.turn(
        classifier,
        () => runTurn("classifier", input, shared),
        drafter,
      )
      const classification = coerceClassification(classRaw)
      shared.classification = classification

      // 3) Draft (sees summary + classification; stands down on red) → back to Summarizer
      let nextStepDraft: EmailDraft | undefined
      if (classification === "red") {
        await client.turn(drafter, async () => "stand down — prospect opted out", summarizer)
      } else {
        const draftRaw = await client.turn(
          drafter,
          () => runTurn("drafter", input, shared),
          summarizer,
        )
        nextStepDraft = toDraft(draftRaw, classification, input)
      }

      await client.finish(classification)

      const log: BandCoordination = {
        chatId: client.chatId,
        via: client.via,
        turns: client.turns,
      }
      cfg.onCoordination?.(log)

      const via: "llm" | "mock" = options.mock ? "mock" : "llm"
      const reasoning =
        `Band(${client.via}) coordinated ${client.turns.length} agents ` +
        `(summarize → classify → draft) → ${classification}`

      return { summary, classification, nextStepDraft, reasoning, via }
    },
  }
}

/** Open + start a client, downgrading Band→local if the room can't be opened. */
async function openClient(
  cfg: ResolvedBandOptions,
  fetchImpl: typeof fetch,
  goal: string,
  agents: BandAgentSpec[],
): Promise<BandClient> {
  if (!cfg.local) {
    const http = new HttpBandClient(cfg, fetchImpl)
    try {
      await http.start(goal, agents)
      return http
    } catch {
      // Band unreachable / misconfigured — sanctioned PRD §14 fallback.
    }
  }
  const local = new LocalBandOrchestrator()
  await local.start(goal, agents)
  return local
}

// ---------------------------------------------------------------------------
// Convenience: a TriageRunner for WebhookDeps.triage
// ---------------------------------------------------------------------------

/** Structurally identical to webhooks' `TriageRunner` (no import cycle). */
export type BandTriageRunner = (
  reply: InboundReply,
  lead: Lead,
  opts?: TriageOptions,
) => Promise<import("@shared/types").ReplyEvent>

/**
 * A ready-to-inject `WebhookDeps.triage`: runs the standard triage() but with the
 * Band-orchestrated agent as the LLM. Falls back exactly like triage() does.
 */
export function bandTriageRunner(bandOpts: BandTriageOptions = {}): BandTriageRunner {
  const llm = createBandTriageAgent(bandOpts)
  return (reply, lead, opts) => triage(reply, lead, { ...opts, llm })
}

export const __bandInternals = {
  buildAgents,
  LocalBandOrchestrator,
  HttpBandClient,
  resolveBandOptions,
  toDraft,
  labelFor,
}
