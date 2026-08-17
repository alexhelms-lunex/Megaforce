import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The auth lookup, which is what actually broke.
 *
 * ---------------------------------------------------------------------------
 * Claim, Save on the user form and the role picker all reported the same
 * thing: "An error occurred in the Server Components render. The specific
 * message is omitted in production builds." All three actions have complete
 * try/catch blocks and return their failures as data, so none of them could
 * have produced that message -- which is why reading those three files never
 * found it.
 *
 * It came from the layout. A server action's response re-renders the current
 * route, the route includes the layout, the layout called the auth lookup, and
 * the auth lookup threw: supabase-js converts AUTH errors into `{ data, error }`
 * but RE-THROWS network errors at the caller. So a dropped connection between
 * Vercel and Supabase turned into a dead render, which turned into a rejected
 * action, which turned into a button reporting failure for a write that had
 * already gone through.
 *
 * These tests hold that line. Every one of them is a way the network can fail.
 * ---------------------------------------------------------------------------
 */

let authBehaviour: () => Promise<unknown> = async () => ({
  data: { user: { id: "auth-1" } },
  error: null,
});
let profileBehaviour: () => Promise<unknown> = async () => ({
  data: { id: "u1", full_name: "Avery Stone", role: "admin" },
  error: null,
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}));

vi.mock("./keys", () => ({
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_CLIENT_KEY: "anon-key",
  isSupabaseConfigured: () => true,
  supabaseSecretKey: () => null,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => authBehaviour(),
    },
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => profileBehaviour(),
      };
      return builder;
    },
  }),
}));

beforeEach(() => {
  authBehaviour = async () => ({ data: { user: { id: "auth-1" } }, error: null });
  profileBehaviour = async () => ({
    data: { id: "u1", full_name: "Avery Stone", role: "admin" },
    error: null,
  });
  vi.resetModules();
});

async function load() {
  return import("./server");
}

describe("the auth lookup", () => {
  it("returns the profile when everything works", async () => {
    const { loadCurrentUser } = await load();
    const lookup = await loadCurrentUser();
    expect(lookup.user?.full_name).toBe("Avery Stone");
    expect(lookup.unreachable).toBeUndefined();
  });

  it("does not throw when the auth call throws", async () => {
    // The exact failure. `fetch failed` is what Node reports for a dropped
    // connection, and supabase-js re-throws it rather than returning it.
    authBehaviour = async () => {
      throw new Error("fetch failed");
    };
    const { loadCurrentUser } = await load();
    await expect(loadCurrentUser()).resolves.toEqual({ user: null, unreachable: "fetch failed" });
  });

  it("does not throw when the auth call throws with a nested cause", async () => {
    authBehaviour = async () => {
      throw Object.assign(new Error("fetch failed"), {
        cause: new Error("ECONNRESET"),
      });
    };
    const { loadCurrentUser } = await load();
    const lookup = await loadCurrentUser();
    expect(lookup.user).toBeNull();
    // The real cause, not just the two words Node puts on top of everything.
    expect(lookup.unreachable).toContain("ECONNRESET");
  });

  it("retries once before giving up", async () => {
    let attempt = 0;
    authBehaviour = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("fetch failed");
      return { data: { user: { id: "auth-1" } }, error: null };
    };
    const { loadCurrentUser } = await load();
    const lookup = await loadCurrentUser();
    expect(lookup.user?.full_name).toBe("Avery Stone");
    expect(attempt).toBe(2);
  });

  it("separates a failed profile read from an absent profile", async () => {
    // Two very different problems that both produce no user. One means the
    // database is unreachable; the other means this login has no row. Telling
    // an administrator the first is the second sends them to the README to fix
    // something that is not broken.
    profileBehaviour = async () => ({ data: null, error: { message: "timeout" } });
    const { loadCurrentUser } = await load();
    expect(await loadCurrentUser()).toEqual({ user: null, unreachable: "timeout" });

    vi.resetModules();
    profileBehaviour = async () => ({ data: null, error: null });
    const again = await load();
    expect(await again.loadCurrentUser()).toEqual({ user: null });
  });

  it("reports no user, not an outage, when nobody is signed in", async () => {
    authBehaviour = async () => ({ data: { user: null }, error: null });
    const { loadCurrentUser } = await load();
    expect(await loadCurrentUser()).toEqual({ user: null });
  });

  /*
   * The other half of the same bug: this ran twice per call and was called
   * around a dozen times per page -- in the layout, again inside
   * readPreferences(), again in the page, again in every action. A dozen HTTP
   * round trips of latency on a screen somebody is waiting for, and a dozen
   * independent chances for the throw above.
   *
   * The cure is React's cache(), which memoises for the life of one request.
   * It CANNOT be asserted here: cache() only dedupes inside a React render
   * scope, and vitest has none, so every call below really does hit the fake.
   * An assertion of `authCalls === 1` would therefore be testing the harness
   * rather than the code -- so this asserts the thing that is true everywhere,
   * which is that repeated callers agree and none of them throws.
   *
   * The memoisation itself is guarded structurally instead, below.
   */
  it("gives every caller the same answer", async () => {
    const { currentUser, loadCurrentUser } = await load();
    const results = await Promise.all([
      loadCurrentUser(),
      loadCurrentUser(),
      currentUser(),
      currentUser(),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[2]).toEqual(results[3]);
    expect(results[2]).toEqual(results[0].user);
  });
});

describe("the shape that keeps it fast", () => {
  it("wraps the lookup in React's per-request cache", async () => {
    // Structural, deliberately. Losing this wrapper reintroduces a dozen round
    // trips per page load without breaking a single behavioural test -- the
    // application would simply be slow again, which is exactly the kind of
    // regression nobody notices until somebody complains about it twice.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./server.ts", import.meta.url), "utf8"),
    );
    expect(source).toMatch(/import \{ cache \} from "react"/);
    expect(source).toMatch(/export const loadCurrentUser = cache\(/);
    expect(source).toMatch(/export const createClient = cache\(/);
  });
});

describe("the sentence shown when there is no user", () => {
  it("says sign in again only when that is actually the problem", async () => {
    const { noUserMessage } = await load();
    expect(noUserMessage({ user: null })).toMatch(/sign in again/i);
  });

  it("does not send somebody to a login screen over a dropped connection", async () => {
    const { noUserMessage } = await load();
    const message = noUserMessage({ user: null, unreachable: "fetch failed" });
    expect(message).not.toMatch(/sign in again/i);
    expect(message).toMatch(/fetch failed/);
    // It matters that nothing was written. Somebody who presses Claim and is
    // told only "that failed" presses it again.
    expect(message).toMatch(/Nothing was changed/i);
  });
});
