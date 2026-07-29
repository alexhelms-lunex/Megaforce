/**
 * Call simulator.
 *
 *   npm run simulate                    -- against the local seeded database
 *   npm run simulate -- --remote        -- against DIRECT_URL
 *   npm run simulate -- --http http://localhost:3000
 *                                       -- POST at the real webhook endpoint
 *
 * This stands in for RingCentral until a sandbox app exists and the app is
 * deployed somewhere with a public URL. It is not a mock of the matcher: it
 * builds genuine RingCentral-shaped payloads with the same builder the tests
 * use, stores them through the same storeRawEvent, and runs them through the
 * same processRawEvent. The only thing missing is the network hop, and --http
 * adds even that.
 *
 * Every scenario below is a case that has actually broken a CRM integration
 * somewhere. Running all of them takes a couple of seconds and populates the
 * review queue with real work to demonstrate.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createLocalDrizzle } from "../db/drizzle-local";
import * as schema from "../src/lib/db/schema";
import { firstRow } from "../src/lib/db/rows";
import { extractExternalId, storeRawEvent } from "../src/lib/ingest";
import { processRawEvent, type Db, type ProcessOutcome } from "../src/lib/matcher";
import { buildCallLogPayload, type CallResult } from "../src/lib/ringcentral/payloads";

interface Scenario {
  label: string;
  /** What a person watching the demo should understand from this one. */
  expectation: string;
  payload: Record<string, unknown>;
  /** Deliver this payload twice, to demonstrate idempotency. */
  deliverTwice?: boolean;
}

async function pickFixtures(db: Db) {
  // A number that sits at exactly one account: the happy path.
  const unique = await db.execute<{ phone_e164: string; name: string }>(sql`
    select c.phone_e164, a.name
      from contacts c
      join accounts a on a.id = c.account_id
     where c.phone_e164 is not null
     group by c.phone_e164, a.name
    having count(distinct c.account_id) = 1
     limit 1
  `);

  // A number that sits at two accounts: the planted ambiguity.
  const ambiguous = await db.execute<{ phone_e164: string; n: number }>(sql`
    select phone_e164, count(distinct account_id)::int as n
      from contacts
     where phone_e164 is not null
     group by phone_e164
    having count(distinct account_id) > 1
     limit 1
  `);

  const uniqueRow = firstRow<{ phone_e164: string; name: string }>(unique);
  const ambiguousRow = firstRow<{ phone_e164: string }>(ambiguous);

  if (!uniqueRow) {
    throw new Error("no seeded contacts found. Run `npm run seed` first.");
  }

  return {
    knownPhone: uniqueRow.phone_e164,
    knownAccount: uniqueRow.name,
    ambiguousPhone: ambiguousRow?.phone_e164 ?? null,
  };
}

function buildScenarios(f: {
  knownPhone: string;
  knownAccount: string;
  ambiguousPhone: string | null;
}): Scenario[] {
  const stamp = Date.now();
  const call = (
    id: string,
    over: Partial<Parameters<typeof buildCallLogPayload>[0]> = {},
  ) =>
    buildCallLogPayload({
      telephonySessionId: `sim-${stamp}-${id}`,
      counterpartyNumber: f.knownPhone,
      ...over,
    });

  const scenarios: Scenario[] = [
    {
      label: "connected call, 4 minutes",
      expectation: `logs against ${f.knownAccount} and QUALIFIES`,
      payload: call("a", { durationSeconds: 244, result: "Call connected" }),
    },
    {
      label: "connected call, 119 seconds",
      expectation: "logs, but does NOT qualify -- one second under the threshold",
      payload: call("b", { durationSeconds: 119, result: "Call connected" }),
    },
    {
      label: "connected call, 121 seconds",
      expectation: "logs and QUALIFIES -- one second over",
      payload: call("c", { durationSeconds: 121, result: "Call connected" }),
    },
    {
      label: "voicemail, 5 minutes",
      expectation: "logs, does NOT qualify. Long, but nobody answered",
      payload: call("d", { durationSeconds: 300, result: "Voicemail" }),
    },
    {
      label: "inbound call from the customer",
      expectation: "picks the CUSTOMER's number, not ours",
      payload: call("e", { direction: "Inbound", durationSeconds: 400 }),
    },
    {
      label: "number written with an extension",
      expectation: "normalizes to the same key and still matches",
      payload: call("f", {
        counterpartyNumber: `${formatLoosely(f.knownPhone)} ext. 214`,
        durationSeconds: 300,
      }),
    },
    {
      label: "unknown number",
      expectation: "matches nothing -> REVIEW QUEUE, zero activities",
      payload: call("g", { counterpartyNumber: "+17045559999", durationSeconds: 300 }),
    },
    {
      label: "withheld caller ID",
      expectation: "refuses to guess -> REVIEW QUEUE",
      payload: call("h", { counterpartyNumber: "anonymous", durationSeconds: 300 }),
    },
    {
      label: "the same webhook delivered twice",
      expectation: "creates exactly ONE activity",
      payload: call("i", { durationSeconds: 300 }),
      deliverTwice: true,
    },
  ];

  if (f.ambiguousPhone) {
    scenarios.splice(7, 0, {
      label: "number that exists at two accounts",
      expectation: "refuses to pick one -> REVIEW QUEUE, zero activities",
      payload: call("j", { counterpartyNumber: f.ambiguousPhone, durationSeconds: 300 }),
    });
  }

  return scenarios;
}

/** Re-render E.164 the way a person might have typed it. */
function formatLoosely(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

function describe(outcome: ProcessOutcome): string {
  switch (outcome.status) {
    case "matched":
      return outcome.qualifies ? "matched, QUALIFIED" : `matched, not qualified`;
    case "unmatched":
      return `review queue (${outcome.reason})`;
    case "duplicate":
      return "duplicate, ignored";
    case "already_processed":
      return "already processed, ignored";
    default:
      return `unparseable: ${outcome.detail}`;
  }
}

function reasonOf(outcome: ProcessOutcome): string {
  return outcome.status === "matched" ? outcome.reason : "";
}

async function deliverOverHttp(baseUrl: string, payload: unknown): Promise<void> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/webhooks/ringcentral`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.RC_WEBHOOK_SECRET
        ? { "verification-token": process.env.RC_WEBHOOK_SECRET }
        : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`webhook returned ${res.status}: ${await res.text()}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const remote = argv.includes("--remote");
  const httpIndex = argv.indexOf("--http");
  const httpBase = httpIndex >= 0 ? argv[httpIndex + 1] : null;

  let db: Db;
  let close: () => Promise<void>;

  if (remote) {
    const url = process.env.DIRECT_URL;
    if (!url) throw new Error("--remote requires DIRECT_URL");
    const client = postgres(url, { max: 1, prepare: false });
    db = drizzle(client, { schema });
    close = async () => {
      await client.end();
    };
  } else {
    const local = await createLocalDrizzle(".pglite");
    db = local.db;
    close = () => local.pg.close();
  }

  try {
    const fixtures = await pickFixtures(db);
    const scenarios = buildScenarios(fixtures);

    console.log(`\nSimulating ${scenarios.length} inbound calls`);
    console.log(`Known good number: ${fixtures.knownPhone} (${fixtures.knownAccount})`);
    if (fixtures.ambiguousPhone) {
      console.log(`Ambiguous number:  ${fixtures.ambiguousPhone} (two accounts)`);
    }
    if (httpBase) console.log(`Delivering over HTTP to ${httpBase}`);
    console.log("");

    const rows: Record<string, string>[] = [];

    for (const scenario of scenarios) {
      const deliveries = scenario.deliverTwice ? 2 : 1;
      let outcome: ProcessOutcome | null = null;

      for (let i = 0; i < deliveries; i++) {
        if (httpBase) {
          // Exercise the real endpoint, including its dedupe and its handoff.
          await deliverOverHttp(httpBase, scenario.payload);
          await new Promise((r) => setTimeout(r, 250));
          outcome = { status: "already_processed" };
        } else {
          const externalId = extractExternalId(scenario.payload, "ringcentral");
          const stored = await storeRawEvent(db, "ringcentral", externalId, scenario.payload);
          outcome = stored.isNew
            ? await processRawEvent(db, stored.id)
            : { status: "already_processed" };
        }
      }

      rows.push({
        scenario: scenario.label,
        result: outcome ? describe(outcome) : "delivered",
        expected: scenario.expectation,
      });
    }

    console.table(rows);

    if (!httpBase) {
      const queued = await db.execute<{ c: string }>(
        sql`select count(*)::text c from unmatched_activities where resolved_at is null`,
      );
      console.log(
        `\nReview queue now holds ${firstRow<{ c: string }>(queued)?.c ?? "0"} unresolved item(s).`,
      );
    }
    console.log("");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
