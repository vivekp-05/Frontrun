/**
 * Frontrun — Workstream D · Webhook signature verification
 * --------------------------------------------------------
 * The security half of the thin HTTP adapter. Both verifiers run over the EXACT
 * raw request body (never the re-serialized JSON — signatures are byte-sensitive),
 * so routes.ts reads req.text() BEFORE JSON.parse.
 *
 *   Resend  → Svix scheme: headers svix-id / svix-timestamp / svix-signature,
 *             HMAC-SHA256(base64-decoded whsec_ key, "{id}.{ts}.{body}"), base64.
 *   Cal.com → header x-cal-signature-256 = HMAC-SHA256(secret, body) as hex.
 *
 * Dev bypass: when no secret is configured, verification passes with a reason
 * (mirrors the codebase's "MOCK when no keys" rule so local testing works). In
 * production the secret is set, so tampered/unsigned calls are rejected.
 */

import crypto from "node:crypto"

export interface SigResult {
  ok: boolean
  reason?: string
}

/** Accepts a Web `Headers` object or a plain (lower/any-case) record. */
export type HeaderLike = Headers | Record<string, string | undefined>

function getHeader(headers: HeaderLike, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined
  }
  const rec = headers as Record<string, string | undefined>
  const lower = name.toLowerCase()
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === lower) return rec[k]
  }
  return undefined
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** Verify a Resend (Svix) webhook signature over the raw body. */
export function verifyResendSignature(
  rawBody: string,
  headers: HeaderLike,
  secret: string | undefined,
): SigResult {
  if (!secret) return { ok: true, reason: "no-secret (dev bypass)" }

  const id = getHeader(headers, "svix-id")
  const ts = getHeader(headers, "svix-timestamp")
  const sigHeader = getHeader(headers, "svix-signature")
  if (!id || !ts || !sigHeader) return { ok: false, reason: "missing svix headers" }

  // Replay guard: reject timestamps more than 5 minutes off.
  const skew = Math.abs(Date.now() / 1000 - Number(ts))
  if (Number.isFinite(skew) && skew > 300) return { ok: false, reason: "timestamp skew" }

  const key = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret, "base64")
  const signed = `${id}.${ts}.${rawBody}`
  const expected = crypto.createHmac("sha256", key).update(signed).digest("base64")

  // Header is a space-delimited list of "v1,<sig>" (or bare sig) entries.
  const provided = sigHeader
    .split(" ")
    .map((p) => (p.includes(",") ? p.slice(p.indexOf(",") + 1) : p))
  const match = provided.some((p) => safeEqual(p, expected))
  return match ? { ok: true } : { ok: false, reason: "signature mismatch" }
}

/** Verify a Cal.com webhook signature (HMAC-SHA256 hex over the raw body). */
export function verifyCalcomSignature(
  rawBody: string,
  headers: HeaderLike,
  secret: string | undefined,
): SigResult {
  if (!secret) return { ok: true, reason: "no-secret (dev bypass)" }

  const provided = getHeader(headers, "x-cal-signature-256")
  if (!provided) return { ok: false, reason: "missing x-cal-signature-256" }

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex")
  return safeEqual(provided, expected)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" }
}

export const __sigInternals = { getHeader, safeEqual }
