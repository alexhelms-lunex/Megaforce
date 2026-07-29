/**
 * Seed runner.
 *
 *   npm run seed             -- against local Postgres, persisted to .pglite/
 *   npm run seed -- --remote -- against DIRECT_URL (Supabase)
 *
 * Local is the default deliberately. The remote path has to be asked for by
 * name, because "seed" against a real database means "delete everything first".
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createLocalDrizzle } from "../db/drizzle-local";
import { DEFAULT_VOLUMES, seed, type SeedVolumes } from "../db/seed";
import * as schema from "../src/lib/db/schema";
import type { Db } from "../src/lib/matcher";

const LOCAL_DATA_DIR = ".pglite";

function parseArgs(argv: string[]) {
  const remote = argv.includes("--remote");
  const small = argv.includes("--small");
  const volumes: SeedVolumes = small
    ? { users: 10, accounts: 40, contacts: 120, opportunities: 60, activities: 600, days: 180 }
    : DEFAULT_VOLUMES;
  return { remote, volumes };
}

async function main() {
  const { remote, volumes } = parseArgs(process.argv.slice(2));
  const started = Date.now();

  let db: Db;
  let close: () => Promise<void>;

  if (remote) {
    const url = process.env.DIRECT_URL;
    if (!url) throw new Error("--remote requires DIRECT_URL. See .env.example.");
    // Migrations and bulk loads use the DIRECT connection, never the pooler:
    // transaction-mode pooling and long-running DDL do not mix.
    const client = postgres(url, { max: 1, prepare: false });
    db = drizzle(client, { schema });
    close = async () => {
      await client.end();
    };
    console.log(`seeding REMOTE database via DIRECT_URL`);
  } else {
    const local = await createLocalDrizzle(LOCAL_DATA_DIR);
    db = local.db;
    close = () => local.pg.close();
    console.log(`seeding LOCAL database at ./${LOCAL_DATA_DIR}`);
  }

  try {
    const report = await seed(db, volumes, (m) => console.log(`  ${m}`));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`\ndone in ${seconds}s`);
    console.table({
      users: report.users,
      accounts: report.accounts,
      contacts: report.contacts,
      opportunities: report.opportunities,
      activities: report.activities,
      qualifying: report.qualifyingActivities,
    });

    const rate = ((report.qualifyingActivities / report.activities) * 100).toFixed(1);
    console.log(`${rate}% of activity qualified under the current rules.\n`);

    console.log("Landmarks planted for the demo:");
    for (const [key, value] of Object.entries(report.landmarks)) {
      console.log(`  ${key.padEnd(20)} ${value}`);
    }
    console.log(
      "\nAll data is synthetic. Phone numbers use the reserved 555-01xx block;\n" +
        "email domains use .test, which cannot be registered.",
    );
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
