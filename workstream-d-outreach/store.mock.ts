/**
 * Frontrun — Workstream D · In-memory StoreProvider (stand-in for A)
 * ------------------------------------------------------------------
 * A local, dependency-free implementation of the shared `StoreProvider` so D's
 * webhook loop is fully testable before backend (A) ships InsForge persistence.
 * It ENFORCES the contract's `LEAD_TRANSITIONS`, so any illegal state move in
 * D's code fails loudly here instead of silently in the demo.
 *
 * Swap for A's real InsForge-backed StoreProvider at Phase 4 — same interface.
 */

import {
  LEAD_TRANSITIONS,
  LeadStatus,
  type Lead,
  type StoreProvider,
} from "@shared/types"

export class TransitionError extends Error {
  constructor(from: LeadStatus, to: LeadStatus, leadId: string) {
    super(`illegal transition ${from} -> ${to} for ${leadId}`)
    this.name = "TransitionError"
  }
}

export class MemStore implements StoreProvider {
  private leads = new Map<string, Lead>()

  constructor(seed: Lead[] = []) {
    for (const l of seed) this.leads.set(l.id, l)
  }

  async upsertLead(lead: Lead): Promise<Lead> {
    const next = { ...lead, updatedAt: new Date().toISOString() }
    this.leads.set(next.id, next)
    return next
  }

  async getLead(id: string): Promise<Lead | null> {
    return this.leads.get(id) ?? null
  }

  async listLeads(): Promise<Lead[]> {
    return [...this.leads.values()]
  }

  async transition(id: string, to: LeadStatus): Promise<Lead> {
    const lead = this.leads.get(id)
    if (!lead) throw new Error(`no lead ${id}`)
    const allowed = LEAD_TRANSITIONS[lead.status] ?? []
    if (!allowed.includes(to)) {
      throw new TransitionError(lead.status, to, id)
    }
    const next: Lead = { ...lead, status: to, updatedAt: new Date().toISOString() }
    this.leads.set(id, next)
    return next
  }

  /** Test/demo convenience: patch fields without a status change. */
  async patch(id: string, patch: Partial<Lead>): Promise<Lead> {
    const lead = this.leads.get(id)
    if (!lead) throw new Error(`no lead ${id}`)
    const next = { ...lead, ...patch, id, updatedAt: new Date().toISOString() }
    this.leads.set(id, next)
    return next
  }
}
