/**
 * Frontrun — Workstream D · Reply Triage Agent
 * --------------------------------------------
 * The reply-loop wow. When a prospect replies to an outreach email, this agent:
 *   1) summarizes the reply,
 *   2) classifies it green / yellow / red (PRD §8),
 *   3) drafts the correct next step (booking nudge / clarifier / stop).
 *
 * Design (locked game plan):
 *   - PURE + framework-agnostic. `triage()` has no I/O beyond the LLM call, so it
 *     runs identically in a Next.js route, an InsForge edge function, or a test.
 *   - SWAPPABLE LLM behind `TriageLLM`. Band orchestrates the call for the prize;
 *     if Band blocks, the same function runs under a plain orchestrator (PRD §14).
 *   - MOCK path: a deterministic keyword classifier so the whole loop is testable
 *     with zero keys and the sandbox (which can't reach InsForge) stays green.
 *
 * Real LLM path = InsForge AI Gateway (routes via OpenRouter). VERIFIED live 2026-07:
 *   POST {INSFORGE_PROJECT_URL}/api/ai/chat/completion   Bearer {INSFORGE_API_KEY}
 *   body {model, messages, ...}  ->  response { text, metadata:{model,usage} }
 * NOTE: not raw-OpenAI — content is `data.text` (not choices[]), and JSON mode is
 * best-effort (the model may fence ```json); parseModelJson() tolerates both.
 * Valid models: anthropic/claude-haiku-4.5, anthropic/claude-sonnet-4, openai/gpt-4o-mini.
 */

import type {
  Lead,
  ReplyEvent,
  ReplyClassification,
  EmailDraft,
} from "@shared/types"

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The inbound reply, before triage fills in summary/classification/draft. */
export type InboundReply = Pick<
  ReplyEvent,
  "id" | "receivedAt" | "from" | "rawText"
>

/** What the triage agent decides. Merged into a full `ReplyEvent`. */
export interface TriageResult {
  summary: string
  classification: ReplyClassification
  /** Present for green/yellow. Undefined for red — red means stop (mark LOST). */
  nextStepDraft?: EmailDraft
  /** One line of why, for the UI "sources / reasoning" drawer (honesty, PRD §10). */
  reasoning: string
  /** How the decision was made — surfaced so we never fake "AI" on screen. */
  via: "llm" | "mock"
}

export interface TriageOptions {
  /** Force the deterministic path. Auto-on when no gateway/key is available. */
  mock?: boolean
  /** Model Gateway base, e.g. https://<project>.insforge.app/v1 */
  gatewayUrl?: string
  /** InsForge project API key (ik_...). */
  apiKey?: string
  /** OpenRouter-style model name routed by the gateway. */
  model?: string
  /** Booking link dropped into green drafts. */
  calLink?: string
  /** Sender identity used when drafting the next step. */
  fromName?: string
  fromCompany?: string
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /**
   * Custom triage agent (the swappable LLM seam). When set, `triage()` uses it
   * instead of the built-in gateway/mock agents — this is how the Band-orchestrated
   * agent (band.ts) plugs in. Any error still degrades to the deterministic mock.
   */
  llm?: TriageLLM
}

/** The swappable LLM seam. Band wraps this; the plain orchestrator calls it raw. */
export interface TriageLLM {
  classifyAndDraft(input: TriageInput): Promise<TriageResult>
}

export interface TriageInput {
  reply: InboundReply
  lead: Lead
  options: ResolvedOptions
}

// ---------------------------------------------------------------------------
// Option resolution
// ---------------------------------------------------------------------------

interface ResolvedOptions {
  mock: boolean
  gatewayUrl?: string
  apiKey?: string
  model: string
  calLink: string
  fromName: string
  fromCompany: string
  fetchImpl: typeof fetch
}

function env(name: string): string | undefined {
  // Guarded so the module also imports cleanly in non-Node runtimes.
  return typeof process !== "undefined" ? process.env?.[name] : undefined
}

function resolveOptions(opts: TriageOptions = {}): ResolvedOptions {
  const gatewayUrl =
    opts.gatewayUrl ??
    (env("INSFORGE_PROJECT_URL")
      ? env("INSFORGE_PROJECT_URL")!.replace(/\/+$/, "")
      : undefined)
  const apiKey = opts.apiKey ?? env("INSFORGE_API_KEY")
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch)

  // Mock unless we can actually reach a gateway.
  const forceMock =
    opts.mock ?? (env("MOCK_LLM") === "1" || env("MOCK_TRIAGE") === "1")
  const canLive = Boolean(gatewayUrl && apiKey && fetchImpl)
  const mock = forceMock === true ? true : !canLive

  return {
    mock,
    gatewayUrl,
    apiKey,
    model: opts.model ?? env("TRIAGE_MODEL") ?? "anthropic/claude-haiku-4.5",
    calLink: opts.calLink ?? env("CALCOM_LINK") ?? "https://cal.com/frontrun/intro",
    fromName: opts.fromName ?? env("FROM_NAME") ?? "Dana",
    fromCompany: opts.fromCompany ?? env("FROM_COMPANY") ?? "Frontrun Talent",
    fetchImpl,
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Triage one inbound reply. Returns a fully-populated `ReplyEvent`.
 * Never throws on LLM failure — falls back to the deterministic path so the
 * demo loop can't hard-fail on a flaky network.
 */
export async function triage(
  reply: InboundReply,
  lead: Lead,
  opts: TriageOptions = {},
): Promise<ReplyEvent> {
  const options = resolveOptions(opts)
  // A custom agent (e.g. the Band-orchestrated one) takes precedence; it decides
  // internally how to run under mock. Otherwise pick gateway (live) or mock.
  const agent: TriageLLM =
    opts.llm ?? (options.mock ? mockAgent : gatewayAgent)

  let result: TriageResult
  try {
    result = await agent.classifyAndDraft({ reply, lead, options })
  } catch (err) {
    // Resilience: any gateway hiccup degrades to the deterministic classifier
    // rather than dropping the reply. Marked `via: "mock"` so the UI stays honest.
    result = await mockAgent.classifyAndDraft({ reply, lead, options })
    result = {
      ...result,
      reasoning: `${result.reasoning} (llm fallback: ${(err as Error).message})`,
    }
  }

  return {
    id: reply.id,
    receivedAt: reply.receivedAt,
    from: reply.from,
    rawText: reply.rawText,
    summary: result.summary,
    classification: result.classification,
    nextStepDraft: result.nextStepDraft,
  }
}

// ---------------------------------------------------------------------------
// Real path — InsForge Model Gateway (OpenAI-compatible)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the reply-triage agent for an autonomous SDR working on behalf of a recruiting agency. You read a prospect's reply to a cold outreach email and decide what happens next.

Classify the reply as exactly one of:
- "green"  = interested / positive / wants to talk or book a call.
- "yellow" = neutral, a question, "who are you?", "how did you find me?", or asking for more info before committing.
- "red"    = not interested / negative / opt-out / "remove me" / "stop".

Then:
- green  -> draft a short, warm reply that nudges toward booking a specific call, and include the booking link.
- yellow -> draft a short reply that answers the likely question and gently re-invites a conversation.
- red    -> DO NOT draft a reply. Respect the opt-out.

Rules:
- Be concise and human. No corporate filler. No made-up facts about the prospect.
- Never invent that the agency has spoken to them before.
- Output STRICT JSON only, matching the schema. No prose outside JSON.`

function buildUserPrompt(input: TriageInput): string {
  const { reply, lead, options } = input
  const company = lead.signal?.companyName ?? "the company"
  const contact = lead.contact?.name ?? "there"
  const originalSubject = lead.draft?.subject ?? "(unknown)"
  return `CONTEXT
Prospect company: ${company}
Prospect contact: ${contact}
Our sender: ${options.fromName} at ${options.fromCompany}
Our original outreach subject: "${originalSubject}"
Booking link to use for green replies: ${options.calLink}

THE PROSPECT'S REPLY (from ${reply.from}):
"""
${reply.rawText}
"""

Return JSON with this exact shape:
{
  "summary": "one sentence, what the prospect said",
  "classification": "green" | "yellow" | "red",
  "reasoning": "one short sentence: why this class",
  "nextStep": {
    "subject": "reply subject line, or empty string if red",
    "body": "reply body, or empty string if red"
  }
}`
}

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/** What `chatComplete` needs — a structural subset of `ResolvedOptions`. */
export interface GatewayCall {
  gatewayUrl?: string
  apiKey?: string
  model: string
  fetchImpl: typeof fetch
  /** Completion route appended to gatewayUrl. Default = InsForge AI Gateway. */
  completionPath?: string
}

const DEFAULT_COMPLETION_PATH = "/api/ai/chat/completion"

/**
 * One raw chat-completion call against the InsForge AI Gateway. Shared by the
 * built-in `gatewayAgent` and the Band-orchestrated per-step calls (band.ts), so
 * both hit the model the exact same way. Returns the assistant message content.
 * `jsonMode` defaults on (sends response_format; the gateway tolerates but does
 * not enforce it — callers parse defensively). Pass false for free text.
 * Response content is read from `data.text` (InsForge shape) with an OpenAI-shape
 * fallback so a swapped OpenAI-compatible gateway still works.
 */
export async function chatComplete(
  messages: ChatMessage[],
  o: GatewayCall,
  opts: { temperature?: number; jsonMode?: boolean } = {},
): Promise<string> {
  const url = `${o.gatewayUrl}${o.completionPath ?? DEFAULT_COMPLETION_PATH}`
  const res = await o.fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${o.apiKey}`,
    },
    body: JSON.stringify({
      model: o.model,
      messages,
      temperature: opts.temperature ?? 0.3,
      ...(opts.jsonMode === false
        ? {}
        : { response_format: { type: "json_object" } }),
    }),
  })

  if (!res.ok) {
    throw new Error(`gateway ${res.status}: ${await safeText(res)}`)
  }

  const data: any = await res.json()
  // InsForge returns { text }; keep an OpenAI-shape fallback for portability.
  return (
    data?.text ??
    data?.choices?.[0]?.message?.content ??
    data?.message?.content ??
    ""
  )
}

const gatewayAgent: TriageLLM = {
  async classifyAndDraft(input: TriageInput): Promise<TriageResult> {
    const { options } = input
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input) },
    ]
    const content = await chatComplete(messages, options)
    const parsed = parseModelJson(content)
    return normalizeResult(parsed, input, "llm")
  },
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return "<no body>"
  }
}

function parseModelJson(content: string): any {
  const trimmed = content.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Tolerate ```json fences or leading prose.
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    throw new Error("model returned non-JSON content")
  }
}

/** Coerce a raw model object into a validated TriageResult. */
function normalizeResult(
  raw: any,
  input: TriageInput,
  via: "llm" | "mock",
): TriageResult {
  const classification = coerceClassification(raw?.classification)
  const summary = String(raw?.summary ?? "").trim() || "(no summary)"
  const reasoning = String(raw?.reasoning ?? "").trim() || "(no reasoning)"

  let nextStepDraft: EmailDraft | undefined
  if (classification !== "red") {
    const subject = String(raw?.nextStep?.subject ?? "").trim()
    const body = String(raw?.nextStep?.body ?? "").trim()
    if (subject || body) {
      nextStepDraft = {
        subject: subject || defaultSubject(classification, input),
        body: body || "",
        createdAt: new Date().toISOString(),
      }
    } else {
      // Model classified green/yellow but gave no draft — synthesize one.
      nextStepDraft = templateDraft(classification, input)
    }
  }

  return { summary, classification, nextStepDraft, reasoning, via }
}

function coerceClassification(v: any): ReplyClassification {
  const s = String(v ?? "").toLowerCase()
  if (s.includes("green")) return "green"
  if (s.includes("red")) return "red"
  return "yellow"
}

// ---------------------------------------------------------------------------
// Mock path — deterministic keyword classifier + templated drafts
// ---------------------------------------------------------------------------

const RED_SIGNALS = [
  "not interested",
  "no thanks",
  "no thank you",
  "unsubscribe",
  "remove me",
  "take me off",
  "stop emailing",
  "please stop",
  "not a fit",
  "we're all set",
  "we are all set",
  "no need",
]

const GREEN_SIGNALS = [
  "interested",
  "let's talk",
  "lets talk",
  "let's chat",
  "lets chat",
  "book",
  "schedule",
  "set up a call",
  "sounds good",
  "happy to",
  "yes",
  "sure",
  "when are you free",
  "grab time",
  "calendar",
  "call this week",
]

const YELLOW_SIGNALS = [
  "who are you",
  "how did you",
  "where did you get",
  "what is this",
  "what's this",
  "more info",
  "tell me more",
  "what do you do",
  "can you send",
  "?",
]

export const mockAgent: TriageLLM = {
  async classifyAndDraft(input: TriageInput): Promise<TriageResult> {
    const text = input.reply.rawText.toLowerCase()
    const has = (list: string[]) => list.find((s) => text.includes(s))

    const red = has(RED_SIGNALS)
    const green = has(GREEN_SIGNALS)
    const yellow = has(YELLOW_SIGNALS)

    // Precedence: an explicit opt-out wins over an incidental "yes".
    let classification: ReplyClassification
    let reasoning: string
    if (red) {
      classification = "red"
      reasoning = `matched opt-out signal "${red}"`
    } else if (green) {
      classification = "green"
      reasoning = `matched interest signal "${green}"`
    } else if (yellow) {
      classification = "yellow"
      reasoning = `matched question signal "${yellow}"`
    } else {
      classification = "yellow"
      reasoning = "no strong signal — defaulting to neutral/question"
    }

    const summary = summarize(input.reply.rawText)
    const nextStepDraft =
      classification === "red" ? undefined : templateDraft(classification, input)

    return { summary, classification, nextStepDraft, reasoning, via: "mock" }
  },
}

/** Cheap extractive summary for the mock path: first meaningful sentence. */
function summarize(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim()
  const firstSentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean
  const s = firstSentence.length > 140 ? `${firstSentence.slice(0, 137)}...` : firstSentence
  return s || "(empty reply)"
}

// ---------------------------------------------------------------------------
// Draft templates (shared by mock + LLM-fallback synthesis)
// ---------------------------------------------------------------------------

function defaultSubject(c: ReplyClassification, input: TriageInput): string {
  const base = input.lead.draft?.subject
  const re = base ? `Re: ${base.replace(/^re:\s*/i, "")}` : "Re: quick intro"
  return re
}

function templateDraft(
  classification: ReplyClassification,
  input: TriageInput,
): EmailDraft {
  const { lead, options } = input
  const contactFirst = (lead.contact?.name ?? "there").split(" ")[0]
  const subject = defaultSubject(classification, input)
  let body: string

  if (classification === "green") {
    body = `Hi ${contactFirst},

Great to hear from you — glad this landed at the right time. The quickest next step is a 20-minute call so I can share how we help teams staff up fast after a raise.

Grab whatever works here: ${options.calLink}

Talk soon,
${options.fromName}
${options.fromCompany}`
  } else {
    // yellow — answer the likely "who/why" and re-invite.
    body = `Hi ${contactFirst},

Fair question. I'm ${options.fromName} with ${options.fromCompany} — we help newly funded teams hire quickly, and I reached out because it looked like you may be scaling up soon.

Happy to send a short overview, or if it's easier, here's my calendar for a quick chat: ${options.calLink}

Either way, no pressure at all.

Best,
${options.fromName}`
  }

  return { subject, body, createdAt: new Date().toISOString() }
}

// ---------------------------------------------------------------------------
// Convenience: expose the mock normalizer for tests
// ---------------------------------------------------------------------------

export const __internals = {
  resolveOptions,
  normalizeResult,
  coerceClassification,
  templateDraft,
  summarize,
  parseModelJson,
  defaultSubject,
}
