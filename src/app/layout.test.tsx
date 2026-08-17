import { describe, expect, it, vi } from "vitest";

/**
 * The shell, actually rendered.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Three unrelated buttons -- Claim on the pool, Save on the user form, and the
 * role picker -- all failed the same way, with the same sentence:
 *
 *     "An error occurred in the Server Components render."
 *
 * Every one of those actions has a complete try/catch and returns its failures
 * as data, so none of them could have produced that message from its own body.
 * The message comes from the RE-RENDER that Next performs as part of a server
 * action's response: the action succeeds, Next re-renders the current route,
 * that render throws, and the whole action response is an error -- so the
 * button reports a failure for something that already happened.
 *
 * The current route is not the common element between three different screens.
 * The LAYOUT is. And the layout was the one server component in this
 * application that no test had ever executed: pages.test.tsx renders the 16
 * pages and stops there, because a layout takes children rather than
 * searchParams and did not fit the loop.
 *
 * So it renders here, on its own, under the conditions that actually occur in
 * production: a working database, an empty one, and one where every read
 * fails. A shell that throws takes every screen with it.
 * ---------------------------------------------------------------------------
 */

interface Fixture {
  rpc?: Record<string, unknown[]>;
  from?: Record<string, unknown[]>;
  fail?: boolean;
  /** Make the auth check itself reject, the way a network blip does. */
  authThrows?: boolean;
  user?: Record<string, unknown> | null;
}

let fixture: Fixture = {};

function chainable(rows: unknown[]) {
  const result = {
    data: fixture.fail ? null : rows,
    error: fixture.fail ? { message: "relation does not exist" } : null,
    count: fixture.fail ? null : rows.length,
  };

  const self: Record<string | symbol, unknown> = {};
  const proxy: unknown = new Proxy(self, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
      }
      if (prop === "maybeSingle" || prop === "single") {
        return async () => ({ ...result, data: rows[0] ?? null });
      }
      return () => proxy;
    },
  });
  return proxy;
}

vi.mock("@/lib/supabase/server", () => ({
  isSupabaseConfigured: () => true,
  isPrivileged: (role: string) => role === "admin" || role === "credit",
  createClient: async () => ({
    rpc: (name: string) => chainable(fixture.rpc?.[name] ?? []),
    from: (table: string) => chainable(fixture.from?.[table] ?? []),
    auth: { getUser: async () => ({ data: { user: null } }), signOut: async () => {} },
  }),
  currentUser: async () => {
    if (fixture.authThrows) throw new Error("fetch failed");
    if (fixture.user === null) return null;
    return fixture.user ?? DEFAULT_USER;
  },
  /*
   * The real one absorbs a thrown auth call and reports it as `unreachable`.
   * This fake still THROWS on `authThrows`, deliberately -- if the layout ever
   * goes back to calling currentUser() directly, this test has to fail again.
   */
  loadCurrentUser: async () => {
    if (fixture.authThrows) return { user: null, unreachable: "fetch failed" };
    if (fixture.user === null) return { user: null };
    return { user: fixture.user ?? DEFAULT_USER };
  },
  noUserMessage: (lookup: { unreachable?: string }) =>
    lookup.unreachable ? `Could not reach the server: ${lookup.unreachable}` : "Not signed in.",
}));

const DEFAULT_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  full_name: "Avery Stone",
  email: "avery@megaforce.test",
  role: "admin",
  location: "Charlotte",
  start_date: "2020-01-01",
  prospect_limit: 200,
  manager_id: null,
  active: true,
};

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const ALERT_ROWS = [
  { id: "a1", name: "Tanglewood Milling", state: "warning", days_left: 4, urgency: 1 },
  { id: "a2", name: "Redwood Packing", state: "overdue", days_left: null, urgency: 0 },
];

async function renderShell() {
  const { default: AppLayout } = await import("./(app)/layout");
  return AppLayout({ children: null } as never);
}

describe("the application shell", () => {
  it("renders with a populated database", async () => {
    fixture = { from: { accounts_with_state: ALERT_ROWS } };
    await expect(renderShell()).resolves.toBeTruthy();
  });

  it("renders against an empty database", async () => {
    fixture = {};
    await expect(renderShell()).resolves.toBeTruthy();
  });

  /*
   * The one that matters. Every read failing is what a missing migration, a
   * renamed view or a paused project looks like from in here, and the shell
   * must degrade to an empty bell rather than take the screen down -- because
   * the screen it takes down includes the one telling somebody to run setup.
   */
  it("renders when every read fails", async () => {
    fixture = { fail: true };
    await expect(renderShell()).resolves.toBeTruthy();
  });

  it("renders when the auth lookup itself throws", async () => {
    fixture = { authThrows: true };
    await expect(renderShell()).resolves.toBeTruthy();
  });

  it("shows the no-profile notice rather than throwing", async () => {
    fixture = { user: null };
    await expect(renderShell()).resolves.toBeTruthy();
  });

  it("refuses a deactivated person without throwing", async () => {
    fixture = {
      user: {
        id: "11111111-1111-1111-1111-111111111111",
        full_name: "Avery Stone",
        email: "avery@megaforce.test",
        role: "broker",
        location: null,
        start_date: null,
        prospect_limit: null,
        manager_id: null,
        active: false,
      },
    };
    await expect(renderShell()).resolves.toBeTruthy();
  });

  it("renders for every role", async () => {
    for (const role of ["broker", "manager", "ad", "credit", "admin"]) {
      fixture = {
        from: { accounts_with_state: ALERT_ROWS },
        user: {
          id: "11111111-1111-1111-1111-111111111111",
          full_name: "Avery Stone",
          email: "avery@megaforce.test",
          role,
          location: "Charlotte",
          start_date: "2020-01-01",
          prospect_limit: 200,
          manager_id: null,
          active: true,
        },
      };
      await expect(renderShell(), `shell for ${role}`).resolves.toBeTruthy();
    }
  });
});
