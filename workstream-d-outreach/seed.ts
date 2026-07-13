/**
 * Frontrun — Workstream D · Demo seed (the 3 controlled prospects)
 * ----------------------------------------------------------------
 * Three demo companies whose "founder inboxes" are teammate addresses we own.
 * These drive the parallel-outreach demo: send all 3, reply from each inbox
 * (positive / question / not-interested), watch triage classify them live.
 *
 * Honesty (PRD §6, §10): these are the ONLY addresses we ever send to. Real
 * detection/enrichment (workstream B) runs on real funded companies, but sends
 * route exclusively to these controlled inboxes.
 *
 * Inbox addresses come from DEMO_INBOX_1..3 (env) or the `inboxes` option.
 */

import { LeadStatus, type Lead, type StoreProvider } from "@shared/types"

export interface SeedOptions {
  /** Overrides DEMO_INBOX_1..3. Index 0..2 map to the three demo leads. */
  inboxes?: string[]
  /** Status to seed at. Default DRAFTED (ready for the "Run outreach" click). */
  status?: LeadStatus
}

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined
}

function inboxAt(opts: SeedOptions, i: number): string {
  const fromOpts = opts.inboxes?.[i]
  const fromEnv = env(`DEMO_INBOX_${i + 1}`)
  // Placeholder is obvious on screen if a real inbox wasn't wired yet.
  return fromOpts || fromEnv || `demo${i + 1}@frontrun.invalid`
}

/** The three demo leads, fully enriched and drafted, ready to send. */
export function demoLeads(opts: SeedOptions = {}): Lead[] {
  const now = new Date().toISOString()
  const status = opts.status ?? LeadStatus.DRAFTED

  const base = (
    i: number,
    company: string,
    person: string,
    title: string,
    amount: string,
    accn: string,
    subject: string,
    body: string,
  ): Lead => ({
    id: `demo_${i + 1}`,
    status,
    isDemo: true,
    signal: {
      accessionNumber: accn,
      companyName: company,
      relatedPersons: [person],
      amountRaised: amount,
      filedAt: now,
      edgarUrl: `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(company)}%22`,
    },
    brief: {
      summary: `${company} just filed a Form D reporting ${amount}. Led by ${person} (${title}); likely to hire aggressively next quarter.`,
      citations: [],
      fundingConfirmed: true,
    },
    contact: {
      name: person,
      title,
      email: inboxAt(opts, i),
      emailConfidence: "high",
      source: "nimble",
    },
    draft: {
      subject,
      body,
      createdAt: now,
    },
    createdAt: now,
    updatedAt: now,
  })

  return [
    base(
      0,
      "Northwind Robotics",
      "Alex Rivera",
      "CEO",
      "$12,000,000",
      "0001834321-26-000123",
      "Congrats on the raise, Alex — scaling the team?",
      `Hi Alex,

Congrats on Northwind's raise. Teams usually hire fast right after — if you're staffing up robotics and engineering roles this quarter, we place vetted candidates in days, not months.

Worth a quick chat?

Dana
Frontrun Talent`,
    ),
    base(
      1,
      "Larkspur Health",
      "Priya Nair",
      "Co-founder",
      "$6,000,000",
      "0001777654-26-000088",
      "Hiring help after the Larkspur seed round?",
      `Hi Priya,

Saw Larkspur just closed its seed round — congrats. We help newly funded health startups hire clinical and eng talent quickly.

Happy to share how; open to a short call?

Dana
Frontrun Talent`,
    ),
    base(
      2,
      "Meridian Analytics",
      "Sam Cole",
      "Founder & CEO",
      "$20,000,000",
      "0001655432-26-000210",
      "Congrats on the Series B, Sam",
      `Hi Sam,

Congrats on Meridian's Series B. A raise that size usually means a big hiring push — we specialize in fast, high-signal placements for data and platform teams.

Would a 15-minute call be useful?

Dana
Frontrun Talent`,
    ),
  ]
}

/** Upsert the three demo leads into any StoreProvider (MemStore now, InsForge later). */
export async function seed(
  store: StoreProvider,
  opts: SeedOptions = {},
): Promise<Lead[]> {
  const leads = demoLeads(opts)
  const out: Lead[] = []
  for (const l of leads) out.push(await store.upsertLead(l))
  return out
}

/** True if any demo inbox is still a placeholder (surface a warning in the UI). */
export function hasPlaceholderInboxes(opts: SeedOptions = {}): boolean {
  return demoLeads(opts).some((l) => l.contact?.email?.endsWith("@frontrun.invalid"))
}
