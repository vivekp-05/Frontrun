/**
 * Frontrun — Workstream D · Band provisioning + live smoke (one-time setup)
 * ------------------------------------------------------------------------
 * Uses the HUMAN Band API key (BAND_API_KEY in .env.local) to:
 *   1) register the 3 triage agents (Summarizer / Classifier / Drafter),
 *      capturing each agent's id + handle + one-time agent api_key,
 *   2) persist those into .env.local (gitignored) as BAND_AGENT_*_{ID,KEY,HANDLE},
 *   3) run ONE real coordination end-to-end (room → add participants → task →
 *      3 @mention handoffs) to verify every API shape live.
 *
 * Idempotent on agents: reuses an already-registered agent (by name) when its
 * key is already stored; only registers the ones we don't have a key for.
 *
 * Run (from repo root, network needed):
 *   node workstream-d-outreach/band.provision.mjs
 *
 * Prints responses with api_key REDACTED. Never commit .env.local.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const BASE = "https://app.band.ai/api/v1"
const ENV_PATH = fileURLToPath(new URL("../.env.local", import.meta.url))

const HUMAN_KEY = process.env.BAND_API_KEY
if (!HUMAN_KEY) {
  console.error("BAND_API_KEY not set in the environment")
  process.exit(1)
}

const AGENTS = [
  { role: "SUMMARIZER", name: "Frontrun Summarizer", description: "Summarizes a prospect's inbound reply in one neutral sentence for SDR triage." },
  { role: "CLASSIFIER", name: "Frontrun Classifier", description: "Classifies a prospect reply as green/yellow/red for SDR triage." },
  { role: "DRAFTER", name: "Frontrun Drafter", description: "Drafts the next-step outreach email (booking nudge or clarifier) for SDR triage." },
]

function redact(obj) {
  return JSON.stringify(obj).replace(/"api_key":"[^"]+"/g, '"api_key":"<REDACTED>"')
}

async function call(method, path, key, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "X-API-Key": key,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 400) }
  }
  return { status: res.status, json }
}

// --- .env.local helpers -----------------------------------------------------

function readEnv() {
  try {
    return readFileSync(ENV_PATH, "utf8")
  } catch {
    return ""
  }
}

function upsertEnv(pairs) {
  let content = readEnv()
  for (const [k, v] of Object.entries(pairs)) {
    const line = `${k}=${v}`
    const re = new RegExp(`^${k}=.*$`, "m")
    if (re.test(content)) content = content.replace(re, line)
    else content = content.replace(/\s*$/, "\n") + line + "\n"
  }
  writeFileSync(ENV_PATH, content)
}

function envValue(key) {
  const m = readEnv().match(new RegExp(`^${key}=(.*)$`, "m"))
  return m ? m[1].trim() : undefined
}

// --- Steps ------------------------------------------------------------------

async function whoami() {
  const { status, json } = await call("GET", "/me", HUMAN_KEY)
  console.log(`\n[whoami] HTTP ${status} — user=${json?.data?.user?.handle} plan=${json?.data?.plan?.tier}`)
  if (status !== 200) process.exit(1)
}

async function ensureAgents() {
  const { status, json } = await call("GET", "/me/agents", HUMAN_KEY)
  console.log(`\n[list agents] HTTP ${status} — ${redact(json)}`)
  const existing = Array.isArray(json?.data) ? json.data : json?.data?.agents ?? []

  const provisioned = {}
  for (const a of AGENTS) {
    const storedKey = envValue(`BAND_AGENT_${a.role}_KEY`)
    const match = existing.find((e) => e?.name === a.name)

    if (storedKey && match) {
      console.log(`[agent ${a.role}] reuse existing id=${match.id} handle=${match.handle}`)
      provisioned[a.role] = { id: match.id, handle: match.handle, key: storedKey }
      continue
    }

    // Name-matched agent but no stored key (its key was shown once and lost) —
    // delete the orphan so we can register a fresh one with a retrievable key.
    if (match && !storedKey) {
      const del = await call("DELETE", `/me/agents/${match.id}`, HUMAN_KEY)
      console.log(`[delete orphan ${a.role}] HTTP ${del.status} id=${match.id}`)
    }

    const { status: rs, json: rj } = await call("POST", "/me/agents/register", HUMAN_KEY, {
      agent: { name: a.name, description: a.description },
    })
    console.log(`[register ${a.role}] HTTP ${rs} — ${redact(rj)}`)
    if (rs >= 300) {
      console.error(`  registration failed for ${a.role}`)
      process.exit(1)
    }
    const agent = rj?.data?.agent
    const key = rj?.data?.credentials?.api_key
    provisioned[a.role] = { id: agent?.id, handle: agent?.handle, key }
    upsertEnv({
      [`BAND_AGENT_${a.role}_ID`]: agent?.id ?? "",
      [`BAND_AGENT_${a.role}_HANDLE`]: agent?.handle ?? "",
      [`BAND_AGENT_${a.role}_KEY`]: key ?? "",
    })
  }
  return provisioned
}

async function resolveHandles(agents) {
  for (const [role, a] of Object.entries(agents)) {
    const me = await call("GET", "/agent/me", a.key)
    a.handle = me.json?.data?.handle
    console.log(`[whoami ${role}] HTTP ${me.status} handle=${a.handle}`)
    upsertEnv({ [`BAND_AGENT_${role}_HANDLE`]: a.handle ?? "" })
  }
}

async function smoke(agents) {
  const S = agents.SUMMARIZER, C = agents.CLASSIFIER, D = agents.DRAFTER

  // 1) create room (Summarizer agent — Agent API works on Free)
  const room = await call("POST", "/agent/chats", S.key, {
    chat: { title: "Frontrun triage — SMOKE (Northwind Robotics)" },
  })
  console.log(`\n[create room] HTTP ${room.status} — ${redact(room.json)}`)
  const chatId = room.json?.data?.id
  if (!chatId) process.exit(1)

  // 2) who can Summarizer recruit into this room?
  const peers = await call("GET", `/agent/peers?not_in_chat=${chatId}`, S.key)
  console.log(`[peers] HTTP ${peers.status} — ${redact(peers.json)}`)

  // 3) recruit Classifier + Drafter as participants (Summarizer adds them)
  for (const [role, a] of [["CLASSIFIER", C], ["DRAFTER", D]]) {
    let p = await call("POST", `/agent/chats/${chatId}/participants`, S.key, {
      participant: { participant_id: a.id, role: "member" },
    })
    console.log(`[add ${role}] HTTP ${p.status} — ${redact(p.json)}`)
    if (p.status >= 300) {
      // Peer may need to be a contact first — try, then retry the add.
      const ca = await call("POST", "/agent/contacts/add", S.key, { handle: a.handle })
      console.log(`[contact add ${role}] HTTP ${ca.status} — ${redact(ca.json)}`)
      p = await call("POST", `/agent/chats/${chatId}/participants`, S.key, {
        participant: { participant_id: a.id, role: "member" },
      })
      console.log(`[add ${role} retry] HTTP ${p.status} — ${redact(p.json)}`)
    }
  }

  const plist = await call("GET", `/agent/chats/${chatId}/participants`, S.key)
  console.log(`[participants] HTTP ${plist.status} — ${redact(plist.json)}`)

  // 4) open the task on the room's board (Summarizer)
  const task = await call("POST", `/agent/chats/${chatId}/tasks`, S.key, {
    subject: "Triage inbound reply from Northwind Robotics",
    detail: "Coordinate summarize → classify → draft for the SDR reply loop.",
  })
  console.log(`\n[create task] HTTP ${task.status} — ${redact(task.json)}`)

  // 5) three @mention handoffs (each agent posts via its OWN key)
  const post = async (from, to, content) => {
    const r = await call("POST", `/agent/chats/${chatId}/messages`, from.key, {
      message: { content, mentions: [{ handle: to.handle, id: to.id }] },
    })
    console.log(`[msg ${from.handle} -> @${to.handle}] HTTP ${r.status} — ${redact(r.json)}`)
    return r
  }
  await post(S, C, `@${C.handle} Summary: prospect says the timing is good and wants to talk.`)
  await post(C, D, `@${D.handle} Classification: green (interested).`)
  await post(D, S, `@${S.handle} Draft ready: booking nudge with the Cal.com link.`)

  // 6) read the coordination back (proves the audit trail)
  const ctx = await call("GET", `/agent/chats/${chatId}/context`, S.key)
  console.log(`\n[context] HTTP ${ctx.status} — ${redact(ctx.json).slice(0, 900)}`)
  console.log(`\n[smoke] done. chatId=${chatId}`)
}

// --- Run --------------------------------------------------------------------

await whoami()
const agents = await ensureAgents()
await resolveHandles(agents)
console.log(
  `\n[agents] ` +
    Object.entries(agents)
      .map(([r, a]) => `${r}: id=${a.id} handle=${a.handle} key=${a.key ? "set" : "MISSING"}`)
      .join(" | "),
)
await smoke(agents)
console.log("\nALL DONE — agent keys written to .env.local (gitignored).")
