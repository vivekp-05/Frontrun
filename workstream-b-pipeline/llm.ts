/**
 * Minimal InsForge AI-gateway chat client for workstream B's drafting step.
 *
 * Deliberately a small duplicate of workstream D's gateway helper (triage.ts) —
 * workstreams stay decoupled, so B carries its own copy instead of importing
 * across the seam. Verified gateway shape (see triage.ts, live 2026-07):
 *   POST {INSFORGE_PROJECT_URL}/api/ai/chat/completion   Bearer {INSFORGE_API_KEY}
 *   -> { text } (InsForge shape), with an OpenAI choices[] fallback for portability.
 * JSON mode is best-effort — the model may fence ```json; parseModelJson() tolerates both.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface DraftLLMEnv {
  INSFORGE_PROJECT_URL?: string
  INSFORGE_API_KEY?: string
  DRAFT_MODEL?: string
  FROM_NAME?: string
  MOCK_LLM?: string
}

type ProcessLike = {
  env?: Record<string, string | undefined>
}

declare const process: ProcessLike | undefined

export const DEFAULT_DRAFT_MODEL = "anthropic/claude-haiku-4.5"

export function readDraftLLMEnv(overrides: DraftLLMEnv = {}): DraftLLMEnv {
  const env = typeof process === "undefined" ? {} : process.env ?? {}

  return {
    INSFORGE_PROJECT_URL: overrides.INSFORGE_PROJECT_URL ?? env.INSFORGE_PROJECT_URL,
    INSFORGE_API_KEY: overrides.INSFORGE_API_KEY ?? env.INSFORGE_API_KEY,
    DRAFT_MODEL: overrides.DRAFT_MODEL ?? env.DRAFT_MODEL,
    FROM_NAME: overrides.FROM_NAME ?? env.FROM_NAME,
    MOCK_LLM: overrides.MOCK_LLM ?? env.MOCK_LLM,
  }
}

/** MOCK_LLM=1 forces the deterministic (no-network) path, same switch as D. */
export function isMockLLM(env: DraftLLMEnv): boolean {
  return env.MOCK_LLM === "1"
}

/** One raw chat-completion call. Throws on missing config or any gateway error. */
export async function chatComplete(
  messages: ChatMessage[],
  env: DraftLLMEnv,
  opts: { temperature?: number } = {},
): Promise<string> {
  const gatewayUrl = env.INSFORGE_PROJECT_URL?.replace(/\/+$/, "")
  if (!gatewayUrl || !env.INSFORGE_API_KEY) {
    throw new Error("InsForge gateway not configured (INSFORGE_PROJECT_URL / INSFORGE_API_KEY)")
  }

  const res = await fetch(`${gatewayUrl}/api/ai/chat/completion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.INSFORGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.DRAFT_MODEL ?? DEFAULT_DRAFT_MODEL,
      messages,
      temperature: opts.temperature ?? 0.3,
      response_format: { type: "json_object" },
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

export function parseModelJson(content: string): any {
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

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return "<no body>"
  }
}
