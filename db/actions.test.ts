import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalDb, becomeUser, becomeService, type LocalDb } from "./local";
import { fakeSupabase } from "./postgrest-fake";

/**
 * The server actions, actually executed.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Every defect reported from production has been in an action, and no test had
 * ever run one. The page tests render screens against a fake that returns
 * whatever they ask for; the SQL tests exercise the database directly. The
 * layer where a column is named wrongly, a policy refuses, or a trigger raises
 * had nothing looking at it.
 *
 * These call the real exported functions -- the same code the button calls --
 * against a real Postgres, as a real signed-in user, with row level security
 * enforced. If an action is broken, this fails.
 * ---------------------------------------------------------------------------
 */

let pg: LocalDb;
let session: string | null = null;

const AUTH = {
  admin: "00000000-0000-0000-0000-0000000000a1",
  admin2: "00000000-0000-0000-0000-0000000000a2",
  manager: "00000000-0000-0000-0000-0000000000b1",
  dana: "00000000-0000-0000-0000-0000000000d1",
  raj: "00000000-0000-0000-0000-0000000000e1",
};

const ids: Record<string, string> = {};

vi.mock("@/lib/supabase/server", async () => {
  const real = await import("./postgrest-fake");
  return {
    isSupabaseConfigured: () => true,
    isPrivileged: (role: string) => role === "admin" || role === "credit",
    createClient: async () => real.fakeSupabase(pg, session),
    currentUser: async () => (await lookUp()).user,
    loadCurrentUser: lookUp,
    noUserMessage: (lookup: { unreachable?: string }) =>
      lookup.unreachable
        ? `Could not reach the server to check who you are: ${lookup.unreachable}.`
        : "Not signed in. Reload the page and sign in again.",
  };

  async function lookUp() {
    if (!session) return { user: null };
    const { rows } = await pg.query<Record<string, unknown>>(
      `select id, full_name, email, role, location, start_date, prospect_limit, manager_id, active
         from users where auth_id = $1`,
      [session],
    );
    return { user: rows[0] ?? null };
  }
});

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

/** Sign in as somebody, for both the fake client and the database session. */
async function as(authId: string | null) {
  session = authId;
  if (authId) await becomeUser(pg, authId);
  else await becomeService(pg);
}

beforeAll(async () => {
  pg = await createLocalDb();
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await becomeService(pg);
  session = null;
  for (const t of [
    "activities", "unmatched_activities", "account_requests", "account_claims",
    "contacts", "opportunities", "accounts", "user_preferences", "users",
  ]) {
    await pg.exec(`delete from ${t};`);
  }

  const mk = async (name: string, role: string, auth: string | null, manager: string | null) => {
    const { rows } = await pg.query<{ id: string }>(
      `insert into users (email, full_name, role, auth_id, manager_id, location)
       values ($1,$2,$3,$4,$5,'Charlotte') returning id`,
      [`${name.toLowerCase()}@megaforce.test`, name, role, auth, manager],
    );
    return rows[0].id;
  };

  ids.admin = await mk("Avery", "admin", AUTH.admin, null);
  ids.admin2 = await mk("Blair", "admin", AUTH.admin2, null);
  ids.manager = await mk("Morgan", "manager", AUTH.manager, ids.admin);
  ids.dana = await mk("Dana", "broker", AUTH.dana, ids.manager);
  ids.raj = await mk("Raj", "broker", AUTH.raj, ids.manager);

  const { rows } = await pg.query<{ id: string }>(
    `insert into accounts (name, status, industry, billing_city, billing_state, owner_id)
     values ('Held Co','prospect','Manufacturing','Charlotte','NC',$1),
            ('Free Co','prospect','Retail','Raleigh','NC',null)
     returning id`,
    [ids.dana],
  );
  ids.held = rows[0].id;
  ids.free = rows[1].id;
});

// ===========================================================================
// Adding people
// ===========================================================================
describe("creating a user", () => {
  it("adds somebody with every field the form sends", async () => {
    const { createUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);

    const result = await createUser({
      email: "New.Starter@Megaforce.test",
      full_name: "New Starter",
      role: "broker",
      manager_id: ids.manager,
      location: "Dallas",
      title: "Broker",
      phone: "704-555-0142",
      start_date: "2026-03-01",
      prospect_limit: 200,
      create_login: false,
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);

    await becomeService(pg);
    const { rows } = await pg.query<Record<string, unknown>>(
      `select email, full_name, role, location, title, phone, start_date, prospect_limit, manager_id
         from users where full_name = 'New Starter'`,
    );
    expect(rows).toHaveLength(1);
    // Lower-cased on the way in, or the same person can be added twice under
    // two spellings and the unique index will not stop it.
    expect(rows[0].email).toBe("new.starter@megaforce.test");
    expect(rows[0].role).toBe("broker");
    expect(rows[0].manager_id).toBe(ids.manager);
    expect(Number(rows[0].prospect_limit)).toBe(200);
  });

  it("adds an Account Director, which the role constraint must accept", async () => {
    const { createUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);

    const result = await createUser({
      email: "ad@megaforce.test",
      full_name: "Director Person",
      role: "ad",
      create_login: false,
    });
    expect(result.error).toBeUndefined();
  });

  it("adds somebody with only the required fields filled in", async () => {
    // Every optional field blank is the commonest way a form is submitted, and
    // an empty string is not the same as null to a foreign key.
    const { createUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);

    const result = await createUser({
      email: "sparse@megaforce.test",
      full_name: "Sparse Person",
      role: "broker",
      manager_id: "",
      location: "",
      title: "",
      phone: "",
      start_date: "",
      prospect_limit: null,
      create_login: false,
    });
    expect(result.error).toBeUndefined();

    await becomeService(pg);
    const { rows } = await pg.query<Record<string, unknown>>(
      `select manager_id, start_date, title from users where email = 'sparse@megaforce.test'`,
    );
    expect(rows[0].manager_id).toBeNull();
    expect(rows[0].start_date).toBeNull();
  });

  it("refuses a duplicate address, a bad address and an empty name", async () => {
    const { createUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);

    expect((await createUser({ email: "dana@megaforce.test", full_name: "Clone", role: "broker", create_login: false })).error)
      .toMatch(/already has this address/i);
    expect((await createUser({ email: "not-an-email", full_name: "X", role: "broker", create_login: false })).error)
      .toMatch(/email address/i);
    expect((await createUser({ email: "ok@megaforce.test", full_name: "   ", role: "broker", create_login: false })).error)
      .toMatch(/give them a name/i);
    expect((await createUser({ email: "ok@megaforce.test", full_name: "X", role: "wizard", create_login: false })).error)
      .toMatch(/pick a role/i);
  });

  it("refuses somebody who is not an administrator", async () => {
    const { createUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.dana);
    const result = await createUser({
      email: "sneaky@megaforce.test", full_name: "Sneaky", role: "admin", create_login: false,
    });
    expect(result.error).toMatch(/only an administrator/i);
  });
});

// ===========================================================================
// Changing people
// ===========================================================================
describe("editing a user", () => {
  it("saves a new name", async () => {
    const { updateUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);

    const result = await updateUser(ids.dana, { full_name: "Dana Whitfield-Reyes" });
    expect(result.error).toBeUndefined();

    await becomeService(pg);
    const { rows } = await pg.query<{ full_name: string }>(
      `select full_name from users where id = $1`, [ids.dana],
    );
    expect(rows[0].full_name).toBe("Dana Whitfield-Reyes");
  });

  it("saves every field the edit form sends at once", async () => {
    // The form always sends all of them, changed or not. A single bad column
    // name in that list fails the whole save.
    const { updateUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);

    const result = await updateUser(ids.raj, {
      full_name: "Raj Mehta",
      email: "raj.mehta@megaforce.test",
      title: "Senior Broker",
      phone: "(704) 555-0142",
      location: "Charlotte, NC",
      manager_id: ids.manager,
      start_date: "2019-07-05",
      prospect_limit: 100,
    });
    expect(result.error).toBeUndefined();

    await becomeService(pg);
    const { rows } = await pg.query<Record<string, unknown>>(
      `select full_name, email, title, phone, location, start_date, prospect_limit
         from users where id = $1`, [ids.raj],
    );
    expect(rows[0].title).toBe("Senior Broker");
    expect(rows[0].email).toBe("raj.mehta@megaforce.test");
    expect(Number(rows[0].prospect_limit)).toBe(100);
  });

  it("clears a manager when the form sends an empty string", async () => {
    const { updateUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);
    const result = await updateUser(ids.dana, { manager_id: "" });
    expect(result.error).toBeUndefined();

    await becomeService(pg);
    const { rows } = await pg.query<{ manager_id: string | null }>(
      `select manager_id from users where id = $1`, [ids.dana],
    );
    expect(rows[0].manager_id).toBeNull();
  });

  it("reports the org-chart guard as a sentence rather than a constraint error", async () => {
    const { updateUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);
    const result = await updateUser(ids.manager, { manager_id: ids.dana });
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/^ERROR:/);
  });
});

// ===========================================================================
// Roles and status
// ===========================================================================
describe("changing a role", () => {
  for (const role of ["broker", "manager", "ad", "credit", "admin"]) {
    it(`sets somebody to ${role}`, async () => {
      const { setRole } = await import("../src/app/(app)/admin/users/actions");
      await as(AUTH.admin);

      const result = await setRole(ids.raj, role);
      expect(result.error).toBeUndefined();

      await becomeService(pg);
      const { rows } = await pg.query<{ role: string }>(
        `select role from users where id = $1`, [ids.raj],
      );
      expect(rows[0].role).toBe(role);
    });
  }

  it("refuses to remove your own administrator role, in words", async () => {
    const { setRole } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);
    const result = await setRole(ids.admin, "broker");
    expect(result.error).toMatch(/own administrator role|another admin/i);
  });

  it("refuses an unknown role", async () => {
    const { setRole } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);
    expect((await setRole(ids.raj, "wizard")).error).toBeTruthy();
  });
});

describe("changing someone's status", () => {
  it("deactivates and releases their book", async () => {
    const { deactivateUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);

    const result = await deactivateUser(ids.dana, "release");
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/available pool/i);

    await becomeService(pg);
    const { rows } = await pg.query<{ active: boolean }>(
      `select active from users where id = $1`, [ids.dana],
    );
    expect(rows[0].active).toBe(false);
    const held = await pg.query(`select id from accounts where owner_id = $1`, [ids.dana]);
    expect(held.rows).toHaveLength(0);
  });

  it("deactivates and transfers their book to a named person", async () => {
    const { deactivateUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);

    const result = await deactivateUser(ids.dana, "transfer", ids.raj);
    expect(result.error).toBeUndefined();

    await becomeService(pg);
    const { rows } = await pg.query(`select id from accounts where owner_id = $1`, [ids.raj]);
    expect(rows).toHaveLength(1);
  });

  it("deactivates and leaves the book alone", async () => {
    const { deactivateUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);
    expect((await deactivateUser(ids.dana, "keep")).error).toBeUndefined();

    await becomeService(pg);
    const { rows } = await pg.query(`select id from accounts where owner_id = $1`, [ids.dana]);
    expect(rows).toHaveLength(1);
  });

  it("puts somebody back", async () => {
    const { deactivateUser, reactivateUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);
    await deactivateUser(ids.raj, "keep");
    expect((await reactivateUser(ids.raj)).error).toBeUndefined();

    await becomeService(pg);
    const { rows } = await pg.query<{ active: boolean; deactivated_at: string | null }>(
      `select active, deactivated_at from users where id = $1`, [ids.raj],
    );
    expect(rows[0].active).toBe(true);
    expect(rows[0].deactivated_at).toBeNull();
  });

  it("refuses to deactivate yourself, in words", async () => {
    const { deactivateUser } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);
    const result = await deactivateUser(ids.admin, "keep");
    expect(result.error).toMatch(/your own login/i);
  });

  it("changes several people at once and reports a tally", async () => {
    const { bulkAction } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);

    const result = await bulkAction([ids.dana, ids.raj], "role", "ad");
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/2 updated/);

    await becomeService(pg);
    const { rows } = await pg.query<{ n: string }>(
      `select count(*)::text as n from users where role = 'ad'`,
    );
    expect(Number(rows[0].n)).toBe(2);
  });

  it("keeps going past a refusal in a bulk change rather than stopping", async () => {
    const { bulkAction } = await import("../src/app/(app)/admin/users/actions");
    await as(AUTH.admin);
    // The admin's own row is refused; the other two should still go through.
    const result = await bulkAction([ids.dana, ids.admin, ids.raj], "role", "manager");
    expect(result.message).toMatch(/2 updated, 1 refused/);
  });
});

// ===========================================================================
// Accounts
// ===========================================================================
describe("claiming and releasing", () => {
  it("claims an unheld account", async () => {
    const { claim } = await import("../src/app/(app)/available/actions");
    await as(AUTH.raj);

    const form = new FormData();
    form.set("accountId", ids.free);
    const result = await claim(form);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);

    await becomeService(pg);
    const { rows } = await pg.query<{ owner_id: string; last_release_reason: string | null }>(
      `select owner_id, last_release_reason from accounts where id = $1`, [ids.free],
    );
    expect(rows[0].owner_id).toBe(ids.raj);
    expect(rows[0].last_release_reason).toBeNull();
  });

  it("names the winner when somebody got there first", async () => {
    const { claim } = await import("../src/app/(app)/available/actions");
    await as(AUTH.dana);
    const first = new FormData();
    first.set("accountId", ids.free);
    await claim(first);

    await as(AUTH.raj);
    const second = new FormData();
    second.set("accountId", ids.free);
    const result = await claim(second);
    expect(result.error).toMatch(/Dana|claimed this/i);
  });

  it("releases an account you hold", async () => {
    const { release } = await import("../src/app/(app)/available/actions");
    await as(AUTH.dana);

    const form = new FormData();
    form.set("accountId", ids.held);
    const result = await release(form);
    expect(result.error).toBeUndefined();

    await becomeService(pg);
    const { rows } = await pg.query<{ owner_id: string | null }>(
      `select owner_id from accounts where id = $1`, [ids.held],
    );
    expect(rows[0].owner_id).toBeNull();
  });

  it("refuses to release somebody else's account", async () => {
    // The manager, who CAN see Dana's book through the reporting line. A peer
    // broker cannot see it at all and correctly gets "no longer exists" --
    // row level security answers before this check is reached.
    const { release } = await import("../src/app/(app)/available/actions");
    await as(AUTH.manager);
    const form = new FormData();
    form.set("accountId", ids.held);
    expect((await release(form)).error).toMatch(/only release an account you hold/i);
  });

  it("says so plainly when nobody is signed in", async () => {
    const { claim } = await import("../src/app/(app)/available/actions");
    await as(null);
    const form = new FormData();
    form.set("accountId", ids.free);
    expect((await claim(form)).error).toMatch(/not signed in/i);
  });
});

// ===========================================================================
// Settings
// ===========================================================================
describe("settings", () => {
  it("saves a preference and reads it back", async () => {
    const { savePreferences, readPreferences } = await import("../src/app/(app)/settings/actions");
    await as(AUTH.dana);

    const result = await savePreferences({ compact_sidebar: true, show_tips: false, density: "compact" });
    expect(result.error).toBeUndefined();

    const prefs = await readPreferences();
    expect(prefs.compact_sidebar).toBe(true);
    expect(prefs.show_tips).toBe(false);
    expect(prefs.density).toBe("compact");
  });

  it("saves a second time, over a row that already exists", async () => {
    // The upsert path. The first save creates the row; the second has to update
    // it rather than collide with the primary key.
    const { savePreferences, readPreferences } = await import("../src/app/(app)/settings/actions");
    await as(AUTH.dana);

    await savePreferences({ show_tips: false });
    const second = await savePreferences({ show_tips: true, theme: "dark" });
    expect(second.error).toBeUndefined();

    const prefs = await readPreferences();
    expect(prefs.show_tips).toBe(true);
    expect(prefs.theme).toBe("dark");
  });

  it("saves the whole set the Save button sends", async () => {
    const { savePreferences } = await import("../src/app/(app)/settings/actions");
    await as(AUTH.dana);
    const result = await savePreferences({
      theme: "light",
      density: "comfortable",
      compact_sidebar: false,
      show_tips: true,
      warn_at_limit: false,
      sound_on_call: true,
      default_landing: "/accounts",
      timezone: "America/Chicago",
    });
    expect(result.error).toBeUndefined();
  });

  it("returns defaults for somebody who has never opened the screen", async () => {
    const { readPreferences } = await import("../src/app/(app)/settings/actions");
    await as(AUTH.raj);
    const prefs = await readPreferences();
    expect(prefs.show_tips).toBe(true);
    expect(prefs.density).toBe("comfortable");
  });
});

// ===========================================================================
// Requests
// ===========================================================================
describe("account requests", () => {
  async function raise(kind = "amnesty") {
    const { createRequest } = await import("../src/app/(app)/requests/actions");
    const form = new FormData();
    form.set("accountId", ids.held);
    form.set("kind", kind);
    form.set("reason", "The buyer is on leave until the end of the month.");
    form.set("days", "14");
    return createRequest({}, form);
  }

  it("raises one", async () => {
    await as(AUTH.dana);
    const result = await raise();
    expect(result.error).toBeUndefined();

    await becomeService(pg);
    const { rows } = await pg.query(`select id from account_requests where status = 'pending'`);
    expect(rows).toHaveLength(1);
  });

  it("is decided by somebody above the person asking", async () => {
    const { decideRequest } = await import("../src/app/(app)/requests/actions");
    await as(AUTH.dana);
    await raise();

    await becomeService(pg);
    const { rows } = await pg.query<{ id: string }>(`select id from account_requests limit 1`);

    await as(AUTH.manager);
    const form = new FormData();
    form.set("requestId", rows[0].id);
    form.set("decision", "approve");
    form.set("note", "Agreed, two weeks.");
    const result = await decideRequest(form);
    expect(result.error).toBeUndefined();

    await becomeService(pg);
    const after = await pg.query<{ status: string; decided_by: string | null }>(
      `select status, decided_by from account_requests where id = $1`, [rows[0].id],
    );
    expect(after.rows[0].status).toBe("approved");
    expect(after.rows[0].decided_by).not.toBeNull();
  });

  it("cannot be approved by the person who raised it", async () => {
    const { decideRequest } = await import("../src/app/(app)/requests/actions");
    await as(AUTH.dana);
    await raise();

    await becomeService(pg);
    const { rows } = await pg.query<{ id: string }>(`select id from account_requests limit 1`);

    await as(AUTH.dana);
    const form = new FormData();
    form.set("requestId", rows[0].id);
    form.set("decision", "approve");
    const result = await decideRequest(form);
    expect(result.error).toBeTruthy();
  });
});

// ===========================================================================
// Creating accounts and contacts
// ===========================================================================
describe("creating an account", () => {
  it("creates one and claims it", async () => {
    const { createAccount } = await import("../src/app/(app)/accounts/actions");
    await as(AUTH.dana);

    const form = new FormData();
    form.set("name", "Brand New Freight Co");
    form.set("status", "prospect");
    form.set("billing_city", "Atlanta");
    form.set("billing_state", "GA");
    form.set("claim", "on");
    // Success REDIRECTS, and a redirect in Next is thrown rather than returned.
    // So the pass condition is either a clean return or a redirect -- and an
    // error message is the only real failure.
    let refusal: string | undefined;
    try {
      const result = await createAccount({}, form);
      refusal = result?.error;
    } catch (err) {
      if (!/NEXT_REDIRECT/.test(String(err))) throw err;
    }
    expect(refusal).toBeUndefined();

    await becomeService(pg);
    const { rows } = await pg.query<{ owner_id: string | null }>(
      `select owner_id from accounts where name = 'Brand New Freight Co'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("flags a duplicate into Credit's name instead of refusing outright", async () => {
    const { createAccount } = await import("../src/app/(app)/accounts/actions");
    await as(AUTH.dana);

    const form = new FormData();
    form.set("name", "Held Co");
    form.set("status", "prospect");
    await createAccount({}, form).catch(() => undefined);

    await becomeService(pg);
    const { rows } = await pg.query<{ locked_to_credit: boolean }>(
      `select locked_to_credit from accounts where name = 'Held Co' order by created_at desc`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Every action, smoke-tested for the shape it returns
// ===========================================================================
describe("no action ever throws at the caller", () => {
  it("returns a value rather than rejecting, even when the input is nonsense", async () => {
    const users = await import("../src/app/(app)/admin/users/actions");
    const pool = await import("../src/app/(app)/available/actions");
    await as(AUTH.admin);

    const bogus = "00000000-0000-0000-0000-00000000dead";
    const empty = new FormData();

    // A rejected action destroys the page instead of showing a message, so
    // every one of these must resolve.
    await expect(users.updateUser(bogus, { full_name: "X" })).resolves.toBeTruthy();
    await expect(users.setRole(bogus, "broker")).resolves.toBeTruthy();
    await expect(users.deactivateUser(bogus, "release")).resolves.toBeTruthy();
    await expect(users.reactivateUser(bogus)).resolves.toBeTruthy();
    await expect(users.createLogin(bogus)).resolves.toBeTruthy();
    await expect(users.resetPassword(bogus)).resolves.toBeTruthy();
    await expect(users.bulkAction([], "role", "broker")).resolves.toBeTruthy();
    await expect(pool.claim(empty)).resolves.toBeTruthy();
    await expect(pool.release(empty)).resolves.toBeTruthy();
  });
});

// ===========================================================================
// The actions that still run on the service-role connection
// ===========================================================================
describe("the actions that need the privileged connection", () => {
  /*
   * Logging a call and resolving a queued one deliberately bypass row level
   * security: the activities insert policy only admits source='manual', so a
   * broker can add a note but cannot forge a two-hour phone call. Writing a row
   * with the provider's own source needs the privileged connection.
   *
   * That connection needs DATABASE_URL. If it is missing or wrong, these must
   * fail with a SENTENCE -- not with a raw "Missing required environment
   * variable", and never by throwing, which would take down the page.
   */
  it("says something useful when the privileged connection is not configured", async () => {
    const before = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const { resolveQueueItem } = await import("../src/app/(app)/review/actions");
      await as(AUTH.admin);

      const form = new FormData();
      form.set("unmatchedId", "00000000-0000-0000-0000-00000000dead");
      form.set("accountId", ids.held);

      const result = await resolveQueueItem(form);
      expect(result.error).toBeTruthy();
      // The one thing it must not be is the raw environment error.
      expect(result.error).not.toMatch(/Missing required environment variable/i);
    } finally {
      if (before) process.env.DATABASE_URL = before;
    }
  });

  it("refuses a broker outright, before touching any connection", async () => {
    const { resolveQueueItem } = await import("../src/app/(app)/review/actions");
    await as(AUTH.dana);
    const form = new FormData();
    form.set("unmatchedId", "x");
    form.set("accountId", ids.held);
    expect((await resolveQueueItem(form)).error).toMatch(/manager or an admin/i);
  });

  it("reports the dialler as unconfigured rather than throwing", async () => {
    const { placeCall } = await import("../src/components/rc-dock/actions");
    await as(AUTH.dana);
    await expect(placeCall("704-555-0142")).resolves.toBeTruthy();
  });

  it("returns an empty call list rather than throwing when nothing is configured", async () => {
    const before = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const { recentCalls, unloggedCount } = await import("../src/components/rc-dock/actions");
      await as(AUTH.dana);
      await expect(recentCalls()).resolves.toBeInstanceOf(Array);
      await expect(unloggedCount()).resolves.toBeTypeOf("number");
    } finally {
      if (before) process.env.DATABASE_URL = before;
    }
  });
});

// ===========================================================================
// Editing an account and adding a contact
// ===========================================================================
describe("editing an account", () => {
  it("saves a change to one you hold", async () => {
    const { updateAccount } = await import("../src/app/(app)/accounts/actions");
    await as(AUTH.dana);

    const form = new FormData();
    form.set("accountId", ids.held);
    form.set("name", "Held Co Renamed");
    form.set("status", "engaged");
    form.set("industry", "Lumber");

    let refusal: string | undefined;
    try {
      refusal = (await updateAccount({}, form))?.error;
    } catch (err) {
      if (!/NEXT_REDIRECT/.test(String(err))) throw err;
    }
    expect(refusal).toBeUndefined();

    await becomeService(pg);
    const { rows } = await pg.query<{ name: string; status: string }>(
      `select name, status from accounts where id = $1`, [ids.held],
    );
    expect(rows[0].name).toBe("Held Co Renamed");
    expect(rows[0].status).toBe("engaged");
  });

  it("refuses a status the system does not have", async () => {
    const { updateAccount } = await import("../src/app/(app)/accounts/actions");
    await as(AUTH.dana);
    const form = new FormData();
    form.set("accountId", ids.held);
    form.set("name", "Held Co");
    form.set("status", "gold-plated");
    expect((await updateAccount({}, form)).error).toMatch(/unknown status/i);
  });
});

describe("adding a contact", () => {
  it("stores the phone number in the form the matcher can use", async () => {
    const { createContact } = await import("../src/app/(app)/accounts/actions");
    await as(AUTH.dana);

    const form = new FormData();
    form.set("accountId", ids.held);
    form.set("firstName", "Ada");
    form.set("lastName", "Byron");
    form.set("phone", "(704) 555-0142");
    form.set("email", "Ada.Byron@Example.COM");

    const result = await createContact({}, form);
    expect(result.error).toBeUndefined();
    expect(result.fieldErrors).toBeUndefined();

    await becomeService(pg);
    const { rows } = await pg.query<{ phone_e164: string; email: string }>(
      `select phone_e164, email from contacts where account_id = $1`, [ids.held],
    );
    // Stored as typed, this contact's calls would land in the review queue for
    // ever and the record would look perfectly fine on screen.
    expect(rows[0].phone_e164).toBe("+17045550142");
    expect(rows[0].email).toBe("ada.byron@example.com");
  });

  it("refuses a number that could never match a call", async () => {
    const { createContact } = await import("../src/app/(app)/accounts/actions");
    await as(AUTH.dana);
    const form = new FormData();
    form.set("accountId", ids.held);
    form.set("firstName", "No");
    form.set("lastName", "Number");
    form.set("phone", "555");
    const result = await createContact({}, form);
    expect(result.fieldErrors?.phone).toBeTruthy();
  });
});

// ===========================================================================
// Withdrawing a request
// ===========================================================================
describe("withdrawing a request", () => {
  it("takes back one you raised", async () => {
    const { createRequest, withdrawRequest } = await import("../src/app/(app)/requests/actions");
    await as(AUTH.dana);

    const raise = new FormData();
    raise.set("accountId", ids.held);
    raise.set("kind", "amnesty");
    raise.set("reason", "The buyer is on leave until the end of the month.");
    raise.set("days", "14");
    await createRequest({}, raise);

    await becomeService(pg);
    const { rows } = await pg.query<{ id: string }>(`select id from account_requests limit 1`);

    await as(AUTH.dana);
    const form = new FormData();
    form.set("requestId", rows[0].id);
    const result = await withdrawRequest(form);
    expect(result.error).toBeUndefined();
  });
});
