import { EmailDraft, Lead, LeadStatus } from "../shared/types"
import { ChatMessage, DraftLLMEnv, chatComplete, isMockLLM, parseModelJson, readDraftLLMEnv } from "./llm"

export async function draftOutreach(lead: Lead, env: DraftLLMEnv = readDraftLLMEnv()): Promise<Lead> {
  const draft = await createEmailDraft(lead, env)
  const now = new Date().toISOString()

  return {
    ...lead,
    status: LeadStatus.DRAFTED,
    draft,
    updatedAt: now,
  }
}

/**
 * LLM-first drafting via the InsForge AI gateway, with an honest fallback:
 * ANY failure (missing keys, network, bad JSON) degrades to the static template.
 * Tagged `via: "llm" | "template"` so the UI never fakes AI provenance (PRD §10).
 */
export async function createEmailDraft(lead: Lead, env: DraftLLMEnv = readDraftLLMEnv()): Promise<EmailDraft> {
  if (isMockLLM(env)) return templateEmailDraft(lead, env)

  try {
    return await llmEmailDraft(lead, env)
  } catch {
    return templateEmailDraft(lead, env)
  }
}

const SYSTEM_PROMPT = `You are an SDR for a technical-recruiting agency writing first-touch cold outreach.

You are given a company's SEC Form D funding signal (company, execs, amount raised), an optional research brief, and the resolved contact. Write a concise (under 140 words), personalized cold email. The ask: a 15-minute intro call this week about their hiring plans post-raise.

Rules:
- Be concise and human. No corporate filler. No made-up facts about the prospect.
- No placeholders like [Name] — use the real contact name, or a natural greeting without one.
- Sign off with the sender name.
- Output STRICT JSON only: {"subject": string, "body": string}. No prose outside JSON.`

function buildUserPrompt(lead: Lead, fromName: string): string {
  const signal = lead.signal
  return `CONTEXT
Company: ${signal.companyName}
Named execs/directors: ${signal.relatedPersons.length ? signal.relatedPersons.join(", ") : "(none listed)"}
Amount raised: ${signal.amountRaised ?? "(not disclosed — recent Form D filing)"}
Research brief: ${lead.brief?.summary ?? "(none)"}
Funding confirmed by coverage: ${lead.brief?.fundingConfirmed ? "yes" : "no — Form D signal only"}
Contact: ${lead.contact?.name ?? "(unknown)"}${lead.contact?.title ? `, ${lead.contact.title}` : ""}
Sender name: ${fromName}

Return JSON: {"subject": string, "body": string}`
}

async function llmEmailDraft(lead: Lead, env: DraftLLMEnv): Promise<EmailDraft> {
  const fromName = senderName(env)
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(lead, fromName) },
  ]
  const parsed = parseModelJson(await chatComplete(messages, env))
  // Strings only — String() would turn a schema-drifted object into a truthy
  // "[object Object]" and slip past the empty-draft guard below.
  const subject = typeof parsed?.subject === "string" ? parsed.subject.trim() : ""
  const body = typeof parsed?.body === "string" ? parsed.body.trim() : ""
  if (!subject || !body) {
    throw new Error("model returned an empty or non-string subject/body")
  }
  // Output guardrails (the prompt embeds untrusted web text via the research
  // brief): cap lengths and refuse links — a first-touch draft never needs a
  // URL, so any injected "include this link" content degrades to the template.
  if (subject.length > 150 || /[\r\n]/.test(subject)) {
    throw new Error("model subject is too long or multi-line")
  }
  if (body.length > 2000 || /https?:\/\/|www\./i.test(`${subject} ${body}`)) {
    throw new Error("model draft is too long or contains a link")
  }

  return {
    subject,
    body,
    createdAt: new Date().toISOString(),
    via: "llm",
  }
}

export function templateEmailDraft(lead: Lead, env: DraftLLMEnv = readDraftLLMEnv()): EmailDraft {
  const company = lead.signal.companyName
  const contactName = firstName(lead.contact?.name)
  const raise = lead.signal.amountRaised ? ` on the ${lead.signal.amountRaised} raise` : " after the Form D filing"
  const proof = lead.brief?.fundingConfirmed
    ? "I saw the raise confirmed in recent coverage"
    : "I saw the new Form D signal"

  return {
    subject: `${company} hiring after the raise?`,
    body: [
      `Hi ${contactName},`,
      "",
      `${proof}${raise}. Teams usually turn that capital into a hiring plan quickly, and that is where my team can help.`,
      "",
      `We specialize in fast technical recruiting for venture-backed companies: calibrated searches, founder-friendly reporting, and shortlist delivery before the market catches up.`,
      "",
      `Worth a 15 minute intro this week to compare your hiring plan against the roles that usually follow this kind of funding event?`,
      "",
      "Best,",
      senderName(env),
    ].join("\n"),
    createdAt: new Date().toISOString(),
    via: "template",
  }
}

function senderName(env: DraftLLMEnv): string {
  return env.FROM_NAME ?? "Dana"
}

function firstName(name?: string): string {
  if (!name) return "there"
  if (/^founder at/i.test(name)) return "there"
  return name.split(/\s+/)[0] ?? "there"
}
