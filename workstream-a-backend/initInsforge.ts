/**
 * One-time InsForge setup — `npm run db:init` (add `--seed` to also load leads).
 *
 * Creates the `leads` table + indexes + `lead_funnel` view in your InsForge
 * project by running schema.sql through the raw-SQL endpoint, then verifies with
 * a row count. Requires INSFORGE_PROJECT_URL + INSFORGE_API_KEY (project API key,
 * `uak_…`) in ../.env.local — see ../.env.example.
 */
import "./env";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { InsforgeStore } from "./store";
import { seedInto, SEED_LEADS } from "./seed";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const base = process.env.INSFORGE_PROJECT_URL;
  const key = process.env.INSFORGE_API_KEY;
  if (!base || !key) {
    console.error(
      "✗ Missing keys. Set INSFORGE_PROJECT_URL and INSFORGE_API_KEY in ../.env.local\n" +
        "  (copy ../.env.example → ../.env.local and fill them in), then re-run `npm run db:init`."
    );
    process.exit(1);
  }

  const store = new InsforgeStore();

  process.stdout.write("• Reaching InsForge… ");
  if (!(await store.ping())) {
    console.error(
      "\n✗ Could not reach InsForge. Check INSFORGE_PROJECT_URL " +
        `(got ${base}) and that INSFORGE_API_KEY is a project API key.`
    );
    process.exit(1);
  }
  console.log("ok");

  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  process.stdout.write("• Creating leads table + funnel view… ");
  await store.init(schema);
  console.log("ok");

  const [{ count }] = await store.sql<{ count: number }>(`select count(*)::int as count from leads`);
  console.log(`• leads table ready — ${count} row(s).`);

  if (process.argv.includes("--seed")) {
    process.stdout.write(`• Seeding ${SEED_LEADS.length} leads… `);
    const n = await seedInto(store);
    console.log(`ok (${n}).`);
  }

  console.log("\n✓ InsForge is set up. Start the status API with:  npm start");
}

main().catch((e) => {
  console.error("\n✗ Init failed:", e?.message ?? e);
  process.exit(1);
});
