/**
 * Workstream A — seed leads so C can render and B/D can transition by hour 3.
 * These are real SEC Form D companies (pulled 2026-07-13) plus the 3 controlled
 * demo companies for the parallel-outreach demo (isDemo = true). B replaces the
 * real ones with live detection; the demo trio stays.
 */
import { Lead, LeadStatus } from "../shared/types";

function iso(d = new Date()): string {
  return d.toISOString();
}

function makeLead(p: {
  id: string;
  company: string;
  persons: string[];
  amount: string;
  filedAt: string;
  address: string;
  isDemo?: boolean;
  status?: LeadStatus;
}): Lead {
  const t = iso();
  return {
    id: p.id,
    status: p.status ?? LeadStatus.DETECTED,
    isDemo: p.isDemo ?? false,
    signal: {
      accessionNumber: `demo-${p.id}`,
      companyName: p.company,
      relatedPersons: p.persons,
      address: p.address,
      amountRaised: p.amount,
      filedAt: p.filedAt,
      edgarUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${p.id}&type=D`,
    },
    createdAt: t,
    updatedAt: t,
    replies: [],
  };
}

/** Real SEC Form D leads (start at DETECTED — B enriches them). */
export const REAL_SEED: Lead[] = [
  makeLead({ id: "1708694", company: "Point2 Technology Inc.", persons: ["Jinho Park", "Jay Jeong"], amount: "62557918", filedAt: "2026-06-26", address: "100 Century Center Ct Ste 415, San Jose, CA 95112" }),
  makeLead({ id: "1716702", company: "PatientFi, Inc.", persons: ["Todd Watts", "Derrick Hoag"], amount: "13000000", filedAt: "2026-06-15", address: "530 Technology Drive Suite 350, Irvine, CA 92618" }),
  makeLead({ id: "2141371", company: "Choice AI Inc.", persons: ["Neha Mittal"], amount: "18694940", filedAt: "2026-06-24", address: "945 Market St Suite 501, San Francisco, CA 94103" }),
];

/** 3 controlled demo companies for the parallel-send demo (start DRAFTED). */
export const DEMO_SEED: Lead[] = [
  makeLead({ id: "9001", company: "Northwind AI", persons: ["Alex Rivera"], amount: "12000000", filedAt: "2026-07-11", address: "San Francisco, CA", isDemo: true, status: LeadStatus.DRAFTED }),
  makeLead({ id: "9002", company: "Ledgerpry", persons: ["Sam Okafor"], amount: "8500000", filedAt: "2026-07-11", address: "Palo Alto, CA", isDemo: true, status: LeadStatus.DRAFTED }),
  makeLead({ id: "9003", company: "Voltmix Robotics", persons: ["Priya Desai"], amount: "22000000", filedAt: "2026-07-11", address: "Oakland, CA", isDemo: true, status: LeadStatus.DRAFTED }),
];

export const SEED_LEADS: Lead[] = [...DEMO_SEED, ...REAL_SEED];

/** Load the seed into any StoreProvider. */
export async function seedInto(store: { upsertLead: (l: Lead) => Promise<Lead> }): Promise<number> {
  for (const l of SEED_LEADS) await store.upsertLead(l);
  return SEED_LEADS.length;
}
