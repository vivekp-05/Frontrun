/**
 * Frontrun — HydraDB memory adapter · shared internals.
 * Tiny, dependency-free helpers reused across graph/recall/outcomes so the
 * fail-soft + coercion logic lives in exactly one place.
 */

/** Normalize any thrown value into a message string (never throws itself). */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Coerce an unknown wire value (graph nodes are `Record<string, unknown>`) to a string. */
export function asString(value: unknown): string {
  if (typeof value === "string") return value
  return value == null ? "" : String(value)
}

/** Whitespace-collapse + length-cap a free-text blob for memory titles/context. */
export function snippet(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** Order-preserving string de-duplication. */
export function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}
