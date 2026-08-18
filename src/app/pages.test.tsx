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

/*
 * The phone status is mocked rather than read.
 *
 * ringCentralStatus() talks to RingCentral over HTTP and to Postgres over a
 * socket. Neither exists here, and neither is what this file is for: the
 * question is whether the SCREEN survives every shape that function can
 * return, including the ones nobody looks at until something is broken.
 */
let rcStatus: unknown = null;
vi.mock("@/lib/ringcentral/status", () => ({
  // Falls back to the not-configured shape, so the two whole-application
  // sweeps below cover this screen without having to know it exists.
  ringCentralStatus: async () => rcStatus ?? RC_BASE,
}));

const RC_BASE = {
  configured: false,
  sandbox: true,
  server: "https://platform.devtest.ringcentral.com",
  credentials: [
    { key: "RC_CLIENT_ID", label: "Client ID", present: false, help: "help" },
    { key: "RC_JWT", label: "JWT credential", present: false, help: "help" },
  ],
  subscription: {
    status: "not-configured" as const,
    id: null,
    expiresAt: null,
    deliveringTo: null,
    shouldDeliverTo: "https://example.test/api/webhooks/ringcentral",
    detail: null,
  },
  pipeline: {
    lastCallAt: null,
    callsLast7Days: 0,
    backlog: 0,
    failed: 0,
    unmatchedOpen: 0,
    usersWithoutExtension: 0,
    totalCallers: 0,
    recent: [],
  },
  schemaGaps: [],
};

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
    // The most misleading result this screen can produce: a name typed in,
    // nothing back, and the reader concluding the business has never heard of
    // the company -- when a colleague is working them.
    name: "accounts list, a search that finds nothing",
    load: () => import("./(app)/accounts/page"),
    props: () => ({ searchParams: Promise.resolve({ q: "tanglewood" }) }),
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
    name: "prospects",
    load: () => import("./(app)/prospects/page"),
    props: () => ({ searchParams: Promise.resolve({}) }),
  },
  {
    name: "your customers",
    load: () => import("./(app)/customers/page"),
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
    props: () => ({ searchParams: Promise.resolve({}) }),
  },
  {
    name: "account requests, credit only",
    load: () => import("./(app)/requests/page"),
    props: () => ({ searchParams: Promise.resolve({ kind: "credit" }) }),
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
  {
    name: "phone connection",
    load: () => import("./(app)/admin/integrations/page"),
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

/**
 * The home screen is five different screens now.
 *
 * Credit and admin route to entirely separate components with entirely separate
 * queries, and a manager reorders the sales one. Rendering only the admin case
 * -- which is what this file did, because currentRole defaults to admin -- left
 * three of the five never executed by anything.
 */
describe("the dashboard for every role", () => {
  const roles = ["broker", "manager", "ad", "credit", "admin"];

  for (const role of roles) {
    it(`renders for a ${role}`, async () => {
      currentRole = role;
      try {
        await expect(
          render(SCREENS.find((s) => s.name === "dashboard")!, {
            rpc: {
              dashboard_kpis: [{ owned: 12, at_risk: 2, calls_7d: 40, qualifying_7d: 9 }],
              dashboard_credit: [
                {
                  pending_credit: 3,
                  pending_credit_value: 225000,
                  oldest_pending_days: 7,
                  decided_30d: 10,
                  approved_30d: 8,
                  duplicates_open: 1,
                  customers_without_limit: 4,
                  total_exposure: 1750000,
                  accounts_at_limit: 22,
                },
              ],
              credit_queue: [
                {
                  request_id: "r1",
                  account_id: "a1",
                  account_name: "Tanglewood Milling",
                  billing_city: "Stockton",
                  billing_state: "CA",
                  current_limit: 25000,
                  requested_amount: 75000,
                  reason: "Doubling their lanes",
                  requested_by_name: "Dana",
                  owner_name: "Dana",
                  waiting_days: 7,
                },
              ],
              credit_gaps: [
                {
                  account_id: "a2",
                  account_name: "No Limit Co",
                  billing_city: "Raleigh",
                  billing_state: "NC",
                  owner_name: "Raj",
                  activity_90d: 12,
                },
              ],
              admin_user_counts: [
                { bucket: "active", n: 24 },
                { bucket: "nologin", n: 2 },
              ],
              account_directory_counts: [{ mine: 12, locked: 40, available: 9, total: 61 }],
            },
            from: {
              accounts_with_state: [
                {
                  id: "a1",
                  name: "Tanglewood Milling",
                  owner_name: "Dana",
                  state: "overdue",
                  days_left: 0,
                  billing_city: "Stockton",
                  billing_state: "CA",
                },
              ],
            },
          }),
        ).resolves.toBeUndefined();
      } finally {
        currentRole = "admin";
      }
    });

    it(`renders for a ${role} against an empty database`, async () => {
      currentRole = role;
      try {
        await expect(
          render(SCREENS.find((s) => s.name === "dashboard")!, {}),
        ).resolves.toBeUndefined();
      } finally {
        currentRole = "admin";
      }
    });

    it(`renders for a ${role} when every read fails`, async () => {
      // A credit dashboard that throws when the migration has not run is a
      // credit team with no home screen at all.
      currentRole = role;
      try {
        await expect(
          render(SCREENS.find((s) => s.name === "dashboard")!, { fail: true }),
        ).resolves.toBeUndefined();
      } finally {
        currentRole = "admin";
      }
    });
  }
});

describe("reports, which open differently depending on the job", () => {
  // The credit branch mounts an entirely separate component with its own three
  // queries. Rendering only the admin case left it never executed.
  for (const role of ["broker", "manager", "ad", "credit", "admin"]) {
    it(`renders for a ${role}`, async () => {
      currentRole = role;
      try {
        await expect(
          render(SCREENS.find((s) => s.name === "reports")!, {
            rpc: {
              report_credit_summary: [
                {
                  raised: 8,
                  decided: 6,
                  approved: 5,
                  denied: 1,
                  still_waiting: 2,
                  approved_value: 400000,
                  mean_hours: 51.5,
                  median_hours: 30,
                  slowest_hours: 180,
                },
              ],
              report_credit_by_requester: [
                {
                  requester: "Dana",
                  branch: "Charlotte, NC",
                  raised: 5,
                  approved: 4,
                  denied: 1,
                  pending: 0,
                  approved_value: 300000,
                  approval_rate: 80,
                },
                {
                  requester: "Raj",
                  branch: null,
                  raised: 1,
                  approved: 0,
                  denied: 0,
                  pending: 1,
                  approved_value: 0,
                  approval_rate: null,
                },
              ],
              report_credit_decisions: [
                { day: "2026-08-01", raised: 2, approved: 1, denied: 0 },
                { day: "2026-08-02", raised: 0, approved: 0, denied: 0 },
                { day: "2026-08-03", raised: 1, approved: 2, denied: 1 },
              ],
            },
          }),
        ).resolves.toBeUndefined();
      } finally {
        currentRole = "admin";
      }
    });

    it(`renders for a ${role} when every read fails`, async () => {
      currentRole = role;
      try {
        await expect(
          render(SCREENS.find((s) => s.name === "reports")!, { fail: true }),
        ).resolves.toBeUndefined();
      } finally {
        currentRole = "admin";
      }
    });
  }
});

describe("Prospects, which contains every company in the business", () => {
  /*
   * One row the caller may open and one they may not, because the interesting
   * rendering question is whether a locked row survives having every
   * proprietary column come back null. A page written against the open shape
   * hits `.toLocaleString()` on an undefined and takes the whole screen down.
   */
  const fixture = {
    rpc: {
      prospect_list: [
        {
          id: "a1",
          name: "Tanglewood Milling",
          billing_street: "1 Mill Rd",
          billing_city: "Stockton",
          billing_state: "CA",
          billing_postal_code: "95202",
          billing_country: "US",
          industry: "Nuts/Grains",
          owner_id: "u1",
          owner_name: "Dana",
          ad_owner_id: null,
          ad_owner_name: null,
          available: false,
          can_open: false,
          national_account: false,
          locked_to_credit: false,
          status: null,
          stage: null,
          phone_e164: null,
          website: null,
          credit_limit: null,
          credit_status: null,
          last_activity_at: null,
          last_communicated_at: null,
          contact_count: null,
          child_count: null,
          parent_account_name: null,
          lifecycle_state: null,
          days_left: null,
          total_rows: 2,
        },
        {
          id: "a2",
          name: "Free Co",
          billing_street: "2 Open St",
          billing_city: "Raleigh",
          billing_state: "NC",
          billing_postal_code: "27601",
          billing_country: "US",
          industry: "Retail",
          owner_id: null,
          owner_name: null,
          ad_owner_id: null,
          ad_owner_name: null,
          available: true,
          can_open: true,
          national_account: false,
          locked_to_credit: false,
          status: "prospect",
          stage: "Lead",
          phone_e164: "+19195550101",
          website: "freeco.test",
          credit_limit: null,
          credit_status: null,
          last_activity_at: null,
          last_communicated_at: null,
          contact_count: 0,
          child_count: 0,
          parent_account_name: null,
          lifecycle_state: "available",
          days_left: null,
          total_rows: 2,
        },
      ],
      prospect_counts: [{ total: 2, available: 1, mine: 0, held: 1, customers: 0 }],
      prospect_industries: [{ industry: "Retail", uses: 4 }],
    },
  };

  it("renders a locked row beside an open one", async () => {
    await expect(
      render(SCREENS.find((s) => s.name === "prospects")!, fixture),
    ).resolves.toBeUndefined();
  });

  it("renders your customers from the same rows", async () => {
    await expect(
      render(SCREENS.find((s) => s.name === "your customers")!, fixture),
    ).resolves.toBeUndefined();
  });

  it("renders with nothing on file", async () => {
    await expect(
      render(SCREENS.find((s) => s.name === "prospects")!, {}),
    ).resolves.toBeUndefined();
  });

  it("renders when the function is not in the database yet", async () => {
    // The state every user is in between a deploy and somebody pressing Apply
    // on the setup page. It has to say so rather than showing an empty book.
    await expect(
      render(SCREENS.find((s) => s.name === "prospects")!, {
        failRpc: ["prospect_list", "prospect_counts", "prospect_industries"],
      }),
    ).resolves.toBeUndefined();
  });

  it("sends the old directory address to Prospects rather than 404ing", async () => {
    // There are links to /directory in the accounts empty state, in the
    // command palette and in bookmarks. A dead one reads as a broken app.
    const mod = await import("./(app)/directory/page");
    await expect(
      mod.default({ searchParams: Promise.resolve({ q: "mill", scope: "locked" }) } as never),
    ).rejects.toThrow(/NEXT_REDIRECT/);
  });
});

describe("the phone connection screen, in every state it can be in", () => {
  /*
   * Each of these is a real failure somebody will hit, and every one of them is
   * SILENT in the application itself -- no error, no empty screen, just calls
   * that never arrive. This screen is the only place they become words, so it
   * has to survive rendering all of them.
   */
  const screen = () => SCREENS.find((s) => s.name === "phone connection")!;

  it("renders before anything has been set up", async () => {
    rcStatus = RC_BASE;
    await expect(render(screen(), {})).resolves.toBeUndefined();
  });

  it("says so when the database is behind the deployment", async () => {
    /*
     * The failure this screen exists for, and the one that hid for a day.
     *
     * Database changes are applied by visiting the setup page, not by
     * deploying. When the two drift apart, every call is written down and then
     * refused on the way to being filed -- no error on any screen, because from
     * the application's side the call arrived perfectly well. "Load recent
     * calls" then truthfully reports the payload as already stored and adds
     * nothing, and the two true statements together read as "nothing to do".
     */
    rcStatus = {
      ...RC_BASE,
      configured: true,
      schemaGaps: [
        { what: "activities.extension_id", why: "Every incoming call fails to be filed." },
      ],
    };
    await expect(render(screen(), {})).resolves.toBeUndefined();
  });

  it("renders when the credentials are set but RingCentral refuses them", async () => {
    rcStatus = {
      ...RC_BASE,
      configured: true,
      credentials: RC_BASE.credentials.map((c) => ({ ...c, present: true })),
      subscription: {
        ...RC_BASE.subscription,
        status: "unreachable",
        detail: "RingCentral answered 400: invalid_grant",
      },
    };
    await expect(render(screen(), {})).resolves.toBeUndefined();
  });

  it("renders when calls are being delivered to an old deployment", async () => {
    // The one most likely to happen here, and the hardest to spot: everything
    // reports healthy and the calls are going somewhere else.
    rcStatus = {
      ...RC_BASE,
      configured: true,
      subscription: {
        ...RC_BASE.subscription,
        status: "wrong-address",
        id: "sub-1",
        expiresAt: "2026-08-24T09:00:00Z",
        deliveringTo: "https://old-deployment.vercel.app/api/webhooks/ringcentral",
        detail: "There is a live subscription, but it delivers somewhere else.",
      },
    };
    await expect(render(screen(), {})).resolves.toBeUndefined();
  });

  it("renders when everything is working", async () => {
    rcStatus = {
      ...RC_BASE,
      configured: true,
      sandbox: false,
      server: "https://platform.ringcentral.com",
      credentials: RC_BASE.credentials.map((c) => ({ ...c, present: true })),
      subscription: {
        ...RC_BASE.subscription,
        status: "ok",
        id: "sub-1",
        expiresAt: "2026-08-24T09:00:00Z",
        deliveringTo: RC_BASE.subscription.shouldDeliverTo,
      },
      pipeline: {
        lastCallAt: "2026-08-18T14:02:00Z",
        callsLast7Days: 412,
        backlog: 2,
        failed: 1,
        unmatchedOpen: 6,
        usersWithoutExtension: 3,
        totalCallers: 27,
      },
    };
    await expect(render(screen(), {})).resolves.toBeUndefined();
  });

  it("is a 404 for anybody who is not an administrator", async () => {
    // Not a hidden nav item. The page names which credentials exist, and a
    // button on it repoints where every future call is delivered.
    rcStatus = RC_BASE;
    for (const role of ["broker", "manager", "ad", "credit"]) {
      currentRole = role;
      await expect(render(screen(), {}), role).rejects.toThrow(/NEXT_NOT_FOUND/);
    }
    currentRole = "admin";
  });
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
