/**
 * Workstream A — AnalyticsProvider (the Hydra prize surface).
 *
 * Computes the funnel aggregates the dashboard strip renders. `computeFunnel`
 * is a pure function over leads so it is trivially testable; the provider just
 * reads the store and calls it. When Hydra is wired, swap the in-process
 * reduction for a columnar aggregation query — the `FunnelAnalytics` shape the
 * frontend consumes does not change (PRD §11).
 */
import { Lead, LeadStatus, FunnelAnalytics, StoreProvider, AnalyticsProvider } from "../shared/types";

/** All statuses initialised to 0 so the frontend can render every column. */
function zeroCounts(): Record<LeadStatus, number> {
  const c = {} as Record<LeadStatus, number>;
  for (const s of Object.values(LeadStatus)) c[s] = 0;
  return c;
}

/** Latest reply classification for a lead, if any. */
function latestClassification(lead: Lead): "green" | "yellow" | "red" | undefined {
  const replies = lead.replies ?? [];
  for (let i = replies.length - 1; i >= 0; i--) {
    if (replies[i].classification) return replies[i].classification;
  }
  return undefined;
}

/** Pure funnel reduction. */
export function computeFunnel(leads: Lead[]): FunnelAnalytics {
  const counts = zeroCounts();
  let delivered = 0;
  let replied = 0;
  let green = 0;
  let red = 0;
  let respSum = 0;
  let respN = 0;

  for (const lead of leads) {
    counts[lead.status] = (counts[lead.status] ?? 0) + 1;

    if (lead.outreach?.deliveredAt) delivered++;
    const replies = lead.replies ?? [];
    if (replies.length > 0) replied++;

    const cls = latestClassification(lead);
    if (cls === "green") green++;
    else if (cls === "red") red++;

    // response time: first reply minus send time
    const sentAt = lead.outreach?.sentAt;
    const firstReplyAt = replies[0]?.receivedAt;
    if (sentAt && firstReplyAt) {
      const ms = Date.parse(firstReplyAt) - Date.parse(sentAt);
      if (Number.isFinite(ms) && ms >= 0) {
        respSum += ms;
        respN++;
      }
    }
  }

  return {
    counts,
    replyRate: delivered > 0 ? replied / delivered : 0,
    avgResponseTimeMs: respN > 0 ? Math.round(respSum / respN) : undefined,
    greenRedRatio: red > 0 ? green / red : green > 0 ? Infinity : 0,
  };
}

/** Reads the store and returns live funnel analytics. */
export class LeadAnalytics implements AnalyticsProvider {
  constructor(private store: StoreProvider) {}
  async funnel(): Promise<FunnelAnalytics> {
    return computeFunnel(await this.store.listLeads());
  }
}

export function createAnalytics(store: StoreProvider): AnalyticsProvider {
  return new LeadAnalytics(store);
}
