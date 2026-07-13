/**
 * Frontrun — Workstream D · Webhook route adapters (the last glue)
 * ----------------------------------------------------------------
 * Thin HTTP wrappers around handleResendWebhook / handleCalcomWebhook. Built on
 * the Web Fetch `Request`/`Response` types, so they drop straight into a Next.js
 * App Router route (Node runtime) OR any Fetch-style server:
 *
 *   // app/api/webhooks/resend/route.ts
 *   import { createResendRoute } from "@/workstream-d-outreach/routes"
 *   import { store } from "@/lib/store"        // A's InsForge StoreProvider
 *   import { bandTriageRunner } from "@/workstream-d-outreach/band"
 *   export const runtime = "nodejs"            // needs node:crypto
 *   export const POST = createResendRoute({ store, triage: bandTriageRunner() })
 *
 *   // app/api/webhooks/calcom/route.ts
 *   export const POST = createCalcomRoute({ store })
 *
 * Each adapter: read raw body → verify signature → parse JSON → dispatch → 200.
 * Status contract (what webhook providers expect):
 *   200 accepted (incl. "unmatched"/"ignored" — a valid event we chose to no-op)
 *   400 unparseable body     401 bad/missing signature     500 handler threw (retry)
 */

import {
  handleCalcomWebhook,
  handleResendWebhook,
  type WebhookDeps,
  type WebhookResult,
} from "./webhooks"
import {
  verifyCalcomSignature,
  verifyResendSignature,
  type SigResult,
} from "./signatures"
import { createResendInboundFetcher } from "./send"

export interface RouteOptions {
  /** Signing secret. Defaults to the provider's env var. */
  secret?: string
}

type FetchRoute = (req: Request) => Promise<Response>

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Shared skeleton: verify → parse → dispatch → map to a Response. */
async function runRoute(
  req: Request,
  verify: (raw: string, headers: Headers) => SigResult,
  dispatch: (payload: any) => Promise<WebhookResult>,
): Promise<Response> {
  const raw = await req.text()

  const sig = verify(raw, req.headers)
  if (!sig.ok) return json({ ok: false, error: sig.reason }, 401)

  let payload: any
  try {
    payload = raw ? JSON.parse(raw) : {}
  } catch {
    return json({ ok: false, error: "invalid json body" }, 400)
  }

  try {
    const result = await dispatch(payload)
    return json(result, 200)
  } catch (err) {
    // Signal failure so the provider retries (idempotent handlers make this safe).
    return json({ ok: false, error: (err as Error).message }, 500)
  }
}

/** Resend delivery + inbound-reply webhook route. */
export function createResendRoute(
  deps: WebhookDeps,
  opts: RouteOptions = {},
): FetchRoute {
  const secret = opts.secret ?? env("RESEND_WEBHOOK_SECRET")
  // Default the inbound body-fetcher from RESEND_API_KEY so real replies (which
  // arrive as metadata-only email.received events) get their body pulled + triaged.
  const fetchInbound = deps.fetchInbound ?? createResendInboundFetcher()
  const withFetch: WebhookDeps = { ...deps, fetchInbound }
  return (req) =>
    runRoute(
      req,
      (raw, headers) => verifyResendSignature(raw, headers, secret),
      (payload) => handleResendWebhook(payload, withFetch),
    )
}

/** Cal.com BOOKING_CREATED webhook route. */
export function createCalcomRoute(
  deps: WebhookDeps,
  opts: RouteOptions = {},
): FetchRoute {
  const secret = opts.secret ?? env("CALCOM_WEBHOOK_SECRET")
  return (req) =>
    runRoute(
      req,
      (raw, headers) => verifyCalcomSignature(raw, headers, secret),
      (payload) => handleCalcomWebhook(payload, deps),
    )
}
