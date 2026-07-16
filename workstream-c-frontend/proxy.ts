import { NextResponse, type NextRequest } from "next/server"

/**
 * Access gate. The pitch (/pitch) and the gate screen (/gate) are public; the
 * dashboard (/, /funnel, /leads, /analytics) and its data API (/api/*) require a
 * valid `frontrun_access` cookie whose value matches DASHBOARD_ACCESS_KEY.
 *
 *  - unauthed bare domain "/"        → /pitch   (public sees the pitch by default)
 *  - unauthed deep dashboard link    → /gate    (enter the access key)
 *  - unauthed /api/* (except access) → 401 JSON  (data isn't scrapable either)
 *
 * Exception: /api/webhooks/* is public. Resend and Cal.com POST there without our
 * cookie, so gating them freezes every lead at SENT. Safe to expose: each webhook
 * route authenticates itself by verifying the provider's signature (Svix /
 * x-cal-signature-256) over the raw body inside the handler — forged or unsigned
 * calls are rejected there, and the routes never return dashboard data.
 *
 * Fails CLOSED: if no key is configured, nothing unlocks.
 */

const PUBLIC_PAGES = new Set(["/pitch", "/gate"])

function isAuthed(req: NextRequest): boolean {
  const key = process.env.DASHBOARD_ACCESS_KEY
  if (!key) return false // misconfigured → stay locked
  return req.cookies.get("frontrun_access")?.value === key
}

export function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl

  // Always public: the access API, provider webhooks (self-authenticating via
  // signature verification in their handlers), and the two public pages.
  if (
    pathname.startsWith("/api/access") ||
    pathname.startsWith("/api/webhooks/") ||
    PUBLIC_PAGES.has(pathname)
  ) {
    return NextResponse.next()
  }

  if (isAuthed(req)) return NextResponse.next()

  // --- not authed ---
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "access required", hint: "unlock the dashboard first" },
      { status: 401 },
    )
  }

  const url = req.nextUrl.clone()
  url.search = ""
  url.pathname = pathname === "/" ? "/pitch" : "/gate"
  return NextResponse.redirect(url)
}

export const config = {
  // Run on everything except static assets + public brand images.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|brand/).*)"],
}
