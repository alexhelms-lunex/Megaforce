import { describe, expect, it, vi } from "vitest";

/**
 * Every screen, actually rendered.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Four separate screens have now shipped crashing, and every one produced the
 * same useless page: "An error occurred in the Server Components render. The
 * specific message is omitted in production builds." Next redacts the message,
 * so the only way to find out what broke is to guess.
 *
 * A type check does not catch these. Nor does the build -- these pages are
 * dynamic, so `next build` never executes their bodies. Nor does lint. There
 * was, until now, no step in this project that ran a page's code before a user
 * did.
 *
 * This is that step. Each page is an async function; calling it executes the
 * whole body -- the data handling, the null checks, the arithmetic, the JSX
 * construction. The Supabase client is faked, so no network and no database,
 * and the fake can be told to return empty results or errors, which is where
 * most of these crashes actually live: a page that works with data and throws
 * on a row it did not expect.
 *
 * It does not render client components. Those are covered by boundary.test.ts,
 * which catches the other failure mode -- a prop that cannot cross from the
 * server to the browser.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// The fakes
// ---------------------------------------------------------------------------

/** What the fake Supabase client should hand back for a given call. */
interface Fixture {
  /** Keyed by RPC name. */
  rpc?: Record<string, unknown[]>;
  /** Keyed by table name. */
  from?: Record<string, unknown[]>;
  /** Make every read fail, to exercise the error paths. */
  fail?: boolean;
  /**
   * currentUser() comes back null.
   *
   * This is no longer hypothetical. The auth lookup used to THROW when
   * Supabase could not be reached, which took the whole render down; it now
   * absorbs that and returns null instead. Null is the safer failure by a long
   * way, but only if every page survives it -- a page that reaches straight
   * for `user.id` turns one dropped connection into the same dead screen by a
   * different route.
   */
  noUser?: boolean;
  /**
   * Named RPCs fail while everything else works.
   *
   * `fail` makes the whole database unreachable, which cannot express the case
   * that actually happens on a deploy: the code calls a function the migration
   * has not created yet, and everything else is fine.
   */
  failRpc?: string[];
}

let fixture: Fixture = {};
let currentRole = "admin";

/**
 * A chainable stand-in for the Supabase query builder.
 *
 * Every builder method returns the same proxy, and awaiting it resolves to
 * `{ data, error, count }` -- which is exactly the contract the pages use. A
 * Proxy rather than a hand-written double, so a page calling a builder method
 * this fake has never heard of does not fail for the wrong reason.
 */
function chainable(rows: unknown[], broken = false) {
  const failed = broken || fixture.fail;
  const result = {
    data: failed ? null : rows,
    error: failed ? { message: "relation does not exist" } : null,
    count: failed ? null : rows.length,
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
    rpc: (name: string) =>
      chainable(fixture.rpc?.[name] ?? [], fixture.failRpc?.includes(name) ?? false),
    from: (table: string) => chainable(fixture.from?.[table] ?? []),
    auth: { getUser: async () => ({ data: { user: null } }), signOut: async () => {} },
  }),
  currentUser: async () => (fixture.noUser ? null : SIGNED_IN()),
  loadCurrentUser: async () =>
    fixture.noUser ? { user: null, unreachable: "fetch failed" } : { user: SIGNED_IN() },
  noUserMessage: (lookup: { unreachable?: string }) =>
    lookup.unreachable ? `Could not reach the server: ${lookup.unreachable}` : "Not signed in.",
}));

const SIGNED_IN = () => ({
  id: "11111111-1111-1111-1111-111111111111",
  full_name: "Avery Stone",
  email: "avery@megaforce.test",
  role: currentRole,
  location: "Charlotte",
  start_date: "2020-01-01",
  prospect_limit: 200,
  manager_id: null,
  active: true,
});

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

const ADMIN_USER = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "alex.helmsworth@megaforce.test",
  full_name: "Alex Helmsworth",
  role: "admin",
  title: null,
  location: "Charlotte, NC",
  phone: null,
  start_date: "2019-07-05",
  prospect_limit: null,
  active: true,
  deactivated_at: null,
  manager_id: null,
  manager_name: null,
  has_login: true,
  accounts_held: 0,
  calls_30d: 0,
  created_at: "2026-01-01T00:00:00Z",
  total_rows: 1,
};

interface Screen {
  name: string;
  load: () => Promise<{ default: (props: never) => Promise<unknown> }>;
  props: () => unknown;
  /** Rows this screen needs in order to render its populated state. */
  populated?: Fixture;
}

const SCREENS: Screen[] = [
  {
    name: "dashboard",
    load: () => import("./(app)/page"),
    props: () => ({}),
  },
  {
    name: "accounts list",
    load: () => import("./(app)/accounts/page"),
    props: () => ({ searchParams: Promise.resolve({}) }),
  },
  {
    name: "available pool",
    load: () => import("./(app)/available/page"),
    props: () => ({ searchParams: Promise.resolve({}) }),
  },
  {
    name: "reports",
    load: () => import("./(app)/reports/page"),
    props: () => ({ searchParams: Promise.resolve({}) }),
  },
  {
    name: "reports, 12 months, every metric",
    load: () => import("./(app)/reports/page"),
    props: () => ({
      searchParams: Promise.resolve({
        days: "365",
        metrics: "calls,approved,emails,claimed,lost",
        dim: "branch",
        q: "char",
        page: "2",
      }),
    }),
  },
  {
    name: "activity",
    load: () => import("./(app)/activity/page"),
    props: () => ({ searchParams: Promise.resolve({}) }),
  },
  {
    name: "contacts",
    load: () => import("./(app)/contacts/page"),
    props: () => ({ searchParams: Promise.resolve({}) }),
  },
  {
    name: "review queue",
    load: () => import("./(app)/review/page"),
    props: () => ({}),
  },
  {
    name: "account requests",
    load: () => import("./(app)/requests/page"),
    props: () => ({}),
  },
  {
    name: "my book",
    load: () => import("./(app)/me/page"),
    props: () => ({}),
  },
  {
    name: "settings",
    load: () => import("./(app)/settings/page"),
    props: () => ({}),
  },
  {
    name: "admin",
    load: () => import("./(app)/admin/page"),
    props: () => ({ searchParams: Promise.resolve({}) }),
  },
  {
    name: "people list",
    load: () => import("./(app)/admin/users/page"),
    props: () => ({ searchParams: Promise.resolve({}) }),
  },
  {
    name: "add someone",
    load: () => import("./(app)/admin/users/new/page"),
    props: () => ({}),
  },
  {
    name: "edit one person",
    load: () => import("./(app)/admin/users/[id]/page"),
    props: () => ({ params: Promise.resolve({ id: ADMIN_USER.id }) }),
    populated: { rpc: { admin_users: [ADMIN_USER] } },
  },
  {
    name: "roles",
    load: () => import("./(app)/admin/roles/page"),
    props: () => ({}),
  },
];

async function render(screen: Screen, f: Fixture): Promise<void> {
  fixture = f;
  const mod = await screen.load();
  await mod.default(screen.props() as never);
}

describe("every screen renders with no data at all", () => {
  // The commonest real state on a fresh database, and the one that breaks a
  // page written against a populated one: a `[0]` on an empty array, a
  // `.toLocaleString()` on an undefined, a `find()` that returns nothing.
  for (const screen of SCREENS) {
    it(screen.name, async () => {
      if (screen.name === "edit one person") {
        // With nobody to find, this page 404s by design rather than rendering.
        await expect(render(screen, {})).rejects.toThrow(/NEXT_NOT_FOUND/);
        return;
      }
      await expect(render(screen, {})).resolves.toBeUndefined();
    });
  }
});

describe("every screen renders when the database is behind the deployment", () => {
  // Every read fails with "relation does not exist". A page that renders its
  // own error message here is a page somebody can act on; one that throws is a
  // page with a redacted message and a reference number.
  for (const screen of SCREENS) {
    it(screen.name, async () => {
      if (screen.name === "edit one person") {
        await expect(render(screen, { fail: true })).rejects.toThrow(/NEXT_NOT_FOUND/);
        return;
      }
      await expect(render(screen, { fail: true })).resolves.toBeUndefined();
    });
  }
});

describe("every screen survives an unreachable auth server", () => {
  /*
   * The failure that produced three weeks of "An error occurred in the Server
   * Components render". The auth lookup threw, the layout threw, and because a
   * server action's response re-renders the layout, every button on the screen
   * reported a failure for a write that had already gone through.
   *
   * The lookup no longer throws -- it returns null. This is the test that the
   * cure is not a second version of the disease.
   */
  for (const screen of SCREENS) {
    it(screen.name, async () => {
      const result = render(screen, { noUser: true });
      // Some screens redirect or 404 rather than render for a signed-out
      // caller. Both are deliberate. Anything else is not.
      await expect(
        result.then(
          () => "rendered",
          (err: Error) =>
            /NEXT_REDIRECT|NEXT_NOT_FOUND/.test(err.message) ? "sent away" : Promise.reject(err),
        ),
      ).resolves.toMatch(/rendered|sent away/);
    });
  }
});

describe("the screens that carry real rows", () => {
  it("renders one person on the edit screen", async () => {
    await expect(
      render(SCREENS.find((s) => s.name === "edit one person")!, {
        rpc: { admin_user: [ADMIN_USER] },
      }),
    ).resolves.toBeUndefined();
  });

  /*
   * The window between deploying the single-row lookup and running setup.
   *
   * admin_user() does not exist yet, so the read errors, and the page falls
   * back to the old list-and-find. Without that fallback every person's edit
   * screen 404s until somebody applies the migration -- including the screen an
   * administrator would use to work out why.
   */
  it("falls back to the list when the single-row lookup is not in the database yet", async () => {
    await expect(
      render(SCREENS.find((s) => s.name === "edit one person")!, {
        failRpc: ["admin_user"],
        rpc: { admin_users: [ADMIN_USER] },
      }),
    ).resolves.toBeUndefined();
  });

  it("renders a deactivated person, whose row carries a date the others do not", async () => {
    await expect(
      render(SCREENS.find((s) => s.name === "edit one person")!, {
        rpc: {
          admin_user: [
            { ...ADMIN_USER, active: false, deactivated_at: "2026-02-01T09:00:00Z" },
          ],
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("renders the people list with a mix of roles, including the new one", async () => {
    await expect(
      render(SCREENS.find((s) => s.name === "people list")!, {
        rpc: {
          admin_users: [
            ADMIN_USER,
            { ...ADMIN_USER, id: "33", role: "ad", full_name: "Dana Reyes" },
            { ...ADMIN_USER, id: "44", role: "credit", full_name: "Sam Okafor", has_login: false },
            { ...ADMIN_USER, id: "55", role: "broker", full_name: "Lee Park", active: false },
          ],
          admin_user_counts: [
            { bucket: "all", n: 4 },
            { bucket: "active", n: 3 },
          ],
        },
        from: { users: [{ id: "33", full_name: "Dana Reyes", role: "ad" }] },
      }),
    ).resolves.toBeUndefined();
  });

  it("renders reports with figures, including a metric that has no comparison", async () => {
    await expect(
      render(SCREENS.find((s) => s.name === "reports")!, {
        rpc: {
          report_window: [
            { metric: "calls", value: 120, previous: 100 },
            { metric: "approved", value: 60, previous: 0 },
            { metric: "accounts_held", value: 40, previous: null },
          ],
          report_series: [
            { bucket: "2026-02-01", calls: 4, approved: 2, emails: 1, claimed: 0, lost: 0 },
            { bucket: "2026-02-02", calls: 0, approved: 0, emails: 0, claimed: 0, lost: 1 },
          ],
          report_breakdown: [
            {
              key: "Dana",
              label: "Dana",
              calls: 10,
              approved: 5,
              hit_rate: 50,
              accounts: 3,
              claimed: 1,
              lost: 0,
              total_rows: 1,
            },
          ],
          report_dimensions: [{ key: "broker", label: "Broker", hint: "Calls to whoever made them." }],
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("renders the roles matrix", async () => {
    await expect(
      render(SCREENS.find((s) => s.name === "roles")!, {
        rpc: {
          role_capabilities: [
            {
              capability: "See their own accounts",
              area: "Accounts",
              broker: true,
              manager: true,
              ad: true,
              credit: true,
              admin: true,
              detail: "Everyone sees what they hold.",
            },
          ],
          role_catalogue: [
            { key: "broker", label: "Broker", summary: "Holds a book.", sort: 1 },
            { key: "ad", label: "Account Director", summary: "Co-owns national accounts.", sort: 3 },
          ],
          admin_user_counts: [{ bucket: "broker", n: 12 }],
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("the screens an ordinary broker must not reach", () => {
  it("sends a broker away from the people screen rather than showing an empty one", async () => {
    currentRole = "broker";
    try {
      await expect(
        render(SCREENS.find((s) => s.name === "people list")!, {}),
      ).rejects.toThrow(/NEXT_REDIRECT/);
      await expect(render(SCREENS.find((s) => s.name === "roles")!, {})).rejects.toThrow(
        /NEXT_REDIRECT/,
      );
    } finally {
      currentRole = "admin";
    }
  });
});
