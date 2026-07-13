/**
 * Loads repo-root `.env.local` then `.env` into process.env — no dependency,
 * uses Node's built-in process.loadEnvFile (Node ≥ 20.12 / 21.7). Import this
 * FIRST (before ./store) so INSFORGE_* keys are present when the store singleton
 * is constructed. Missing files are ignored, so in-memory mode still boots.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env.local", ".env"]) {
  const path = join(root, file);
  if (existsSync(path)) {
    try {
      (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(path);
    } catch {
      /* older Node without loadEnvFile — rely on real env vars instead */
    }
  }
}
