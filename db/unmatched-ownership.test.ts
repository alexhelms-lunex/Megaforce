import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalDrizzle, type LocalDrizzle } from "./drizzle-local";
import { becomeUser, becomeService, type LocalDb } from "./local";
import * as schema from "../src/lib/db/schema";
import { storeRawEvent, extractExternalId } from "../src/lib/ingest";
import { processRawEvent } from "../src/lib/matcher";
import { buildCallLogPayload } from "../src/lib/ringcentral/payloads";

/**
 * A call that matched nothing is still somebody's call.
 *
 * ===========================================================================
 * Alex: "I want it to see all calls connected to the ring central account
 * live, within our ring central tab. Even calls to number not in the CRM."
 *
 * Before 0033 that was impossible, and not because of the screen. The
 * unmatched_activities row recorded the number, the duration and the result and
 * NOTHING about who made the call -- so there was no way to ask "show me my
 * unmatched calls". Every call to a number not yet on file vanished from the
 * broker's view and surfaced only in a manager-only queue, which is exactly
 * backwards: the person who made the call is the one person who knows who it
 * was with.
 *
 * The tests below prove the row now knows whose it is, that the right people
 * can see it, and -- the part with teeth -- that a broker cannot use the new
 * access to reach a colleague's call or push activity onto a colleague's book.
 * ===========================================================================
 */

let db: LocalDrizzle;
let pg: LocalDb;

const AUTH = {
  dana: "00000000-0000-0000-0000-0000000000d1",
  raj: "00000000-0000-0000-0000-0000000000e1",
  manager: "00000000-0000-0000-0000-0000000000b1",
};

const ids: Record<string, string> = {};

beforeAll(async () => {
  ({ db, pg } = await createLocalDrizzle());
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await becomeService(pg);
  await pg.exec(`
    delete from unmatched_activities;
    delete from activities;
    delete from raw_events;
    delete from contacts;
    delete from accounts;
    delete from users;
  `);

  const mk = async (name: string, role: string, auth: string, ext: string | null, mgr: string | null) => {
    const { rows } = await pg.query<{ id: string }>(
      `insert into users (email, full_name, role, auth_id, rc_extension_id, manager_id)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [`${name.toLowerCase()}@megaforce.test`, name, role, auth, ext, mgr],
    );
    return rows[0].id;
  };

  ids.manager = await mk("Morgan", "manager", AUTH.manager, null, null);
  ids.dana = await mk("Dana", "broker", AUTH.dana, "101", ids.manager);
  ids.raj = await mk("Raj", "broker", AUTH.raj, "102", ids.manager);

  const { rows } = await pg.query<{ id: string }>(
    `insert into accounts (name, status, owner_id) values ('Danas Co','prospect',$1),
                                                          ('Rajs Co','prospect',$2)
     returning id`,
    [ids.dana, ids.raj],
  );
  ids.danasCo = rows[0].id;
  ids.rajsCo = rows[1].id;
});

/** A call from an extension to a number nobody has on file. */
async function callFrom(extension: string | null, session: string): Promise<void> {
  const payload = buildCallLogPayload({
    telephonySessionId: session,
    counterpartyNumber: "+19995550000",
    durationSeconds: 240,
    extensionId: extension ?? "999",
  });
  const { id } = await storeRawEvent(
    db,
    "ringcentral",
    extractExternalId(payload, "ringcentral"),
    payload,
  );
  const outcome = await processRawEvent(db, id);
  expect(outcome.status).toBe("unmatched");
}

async function visibleTo(auth: string): Promise<string[]> {
  await becomeUser(pg, auth);
  const { rows } = await pg.query<{ phone_e164: string; id: string }>(
    `select id, phone_e164 from unmatched_activities where resolved_at is null`,
  );
  await becomeService(pg);
  return rows.map((r) => r.id);
}

// ===========================================================================
describe("the row knows whose call it was", () => {
  it("records the extension and the person behind it", async () => {
    await callFrom("101", "s1");

    const { rows } = await pg.query<{ extension_id: string; user_id: string }>(
      `select extension_id, user_id from unmatched_activities`,
    );
    expect(rows[0].extension_id).toBe("101");
    expect(rows[0].user_id).toBe(ids.dana);
  });

  it("keeps the extension even when it belongs to nobody", async () => {
    // The state every deployment is in on its first day, and the reason the
    // column is nullable. Throwing the extension away would make an
    // unrecognised one impossible to diagnose later.
    await callFrom("999", "s2");

    const { rows } = await pg.query<{ extension_id: string; user_id: string | null }>(
      `select extension_id, user_id from unmatched_activities`,
    );
    expect(rows[0].extension_id).toBe("999");
    expect(rows[0].user_id).toBeNull();
  });
});

describe("who can see it", () => {
  it("shows a broker their own unmatched call", async () => {
    await callFrom("101", "s3");
    expect(await visibleTo(AUTH.dana)).toHaveLength(1);
  });

  it("does not show it to a colleague", async () => {
    // The whole reason this could not simply be opened to everybody.
    await callFrom("101", "s4");
    expect(await visibleTo(AUTH.raj)).toHaveLength(0);
  });

  it("shows it to a manager, who triages the queue", async () => {
    await callFrom("101", "s5");
    expect(await visibleTo(AUTH.manager)).toHaveLength(1);
  });

  it("keeps an orphan call visible to the people who triage", async () => {
    // An extension nobody has claimed. It must not vanish -- an orphan call in
    // no dock at all is the failure this whole change exists to end.
    await callFrom("999", "s6");
    expect(await visibleTo(AUTH.manager)).toHaveLength(1);
    expect(await visibleTo(AUTH.dana)).toHaveLength(0);
  });
});

describe("what a broker still cannot do", () => {
  it("cannot reach a colleague's unmatched call by id", async () => {
    await callFrom("102", "s7");
    const { rows } = await pg.query<{ id: string }>(`select id from unmatched_activities`);

    await becomeUser(pg, AUTH.dana);
    const seen = await pg.query(`select id from unmatched_activities where id = $1`, [rows[0].id]);
    expect(seen.rows).toHaveLength(0);
  });

  it("cannot resolve a colleague's call, and is told nothing by trying", async () => {
    // An UPDATE that RLS filters out matches zero rows and reports success.
    // The assertion is on the row count, not on an error being raised.
    await callFrom("102", "s8");

    await becomeUser(pg, AUTH.dana);
    const res = await pg.query(
      `update unmatched_activities set resolved_at = now() returning id`,
    );
    expect(res.rows).toHaveLength(0);
  });

  it("still cannot forge a call, which is what the whole control rests on", async () => {
    // The insert policy admits source='manual' only. A broker who could write a
    // provider-sourced row could manufacture the activity that holds an account.
    await becomeUser(pg, AUTH.dana);
    await expect(
      pg.query(
        `insert into activities (account_id, user_id, type, source, occurred_at, qualifies,
                                 qualification_reason, duration_seconds, result)
         values ($1, $2, 'call', 'ringcentral', now(), true, 'forged', 600, 'Call connected')`,
        [ids.danasCo, ids.dana],
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });
});
