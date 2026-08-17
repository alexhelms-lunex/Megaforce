import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SetupNotice } from "@/components/setup-notice";
import { RcDock } from "@/components/rc-dock/dock";
import { PoolDock } from "@/components/pool-dock/dock";
import { AlertBell, type Alert } from "@/components/shell/alert-bell";
import { CommandPalette } from "@/components/shell/command-palette";
import { MobileNav } from "@/components/shell/mobile-nav";
import { Sidebar, type NavCounts } from "@/components/shell/sidebar";
import { UserMenu } from "@/components/shell/user-menu";
import { SettingsButton } from "@/components/shell/settings-button";
import { PreferencesProvider } from "@/components/preferences-provider";
import { DensityShell } from "@/components/density-shell";
import { loadPreferences } from "@/lib/prefs-server";
import { createClient, isPrivileged, isSupabaseConfigured, loadCurrentUser } from "@/lib/supabase/server";
import { DEFAULT_PREFERENCES } from "@/lib/preferences";
import type { LifecycleState } from "@/lib/lifecycle";

export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * The shell.
 *
 * ===========================================================================
 * NOTHING IN HERE MAY THROW.
 *
 * A server action's response carries the re-rendered route as well as the
 * action's return value, and the route includes this layout. So a throw here
 * does not just break one screen -- it rejects the promise of whatever action
 * the person just triggered, and the button reports a failure for a write that
 * already succeeded. That is precisely how Claim, Save on the user form and the
 * role picker all came to report the same "An error occurred in the Server
 * Components render", with three complete try/catch blocks between them.
 *
 * Every await below therefore degrades instead of throwing: an unreachable
 * database produces an empty bell, not a dead screen.
 * ===========================================================================
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!isSupabaseConfigured()) return <SetupNotice />;

  const lookup = await loadCurrentUser();

  // Supabase could not be reached. Deliberately NOT the "no profile" screen
  // below: that one tells an administrator to go and write SQL, which is the
  // wrong instruction entirely when the real problem is a dropped connection
  // that will be gone in ten seconds.
  if (lookup.unreachable) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-lg font-semibold">Could not reach the server</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The application is running, but it could not reach the database to check who you are.
          This is usually brief. Reload in a moment.
        </p>
        <p className="mt-4 rounded-lg border border-border/60 bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
          {lookup.unreachable}
        </p>
      </div>
    );
  }

  const user = lookup.user;
  if (!user) {
    // Authenticated with Supabase but absent from our users table. This is the
    // state a brand new signup lands in, and saying so beats an empty screen.
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-lg font-semibold">No CRM profile for this login</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The sign-in worked, but no row in <span className="font-mono">users</span> has this
          account&apos;s <span className="font-mono">auth_id</span>. Link them with the SQL in the
          README, under &ldquo;Give yourself a login&rdquo;.
        </p>
        <form action={signOut} className="mt-4">
          <Button variant="outline" size="sm">
            Sign out
          </Button>
        </form>
      </div>
    );
  }

  // Deactivated, but still holding a session issued before it happened. The
  // login ban stops the NEXT sign-in; this stops the current one.
  if (user.active === false) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-lg font-semibold">This account has been deactivated</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An administrator has switched off access for {user.full_name}. If that is not what you
          expected, ask them to reactivate you from the People screen.
        </p>
        <form action={signOut} className="mt-4">
          <Button variant="outline" size="sm">
            Sign out
          </Button>
        </form>
      </div>
    );
  }

  const [{ alerts, counts }, prefs] = await Promise.all([
    // Both guarded. A badge that fails to load is a badge; the alternative was
    // a screen that failed to load, and an action that reported a failure it
    // did not have.
    chromeData(user.id, user.role).catch((err) => {
      console.error("[shell] counts unavailable", err);
      return { alerts: [] as Alert[], counts: EMPTY_COUNTS };
    }),
    // Read once, here. Every component that needs a setting takes it from
    // context rather than fetching its own copy -- which is what turned a
    // screen of working toggles into a screen of toggles that did nothing.
    loadPreferences().catch((err) => {
      console.error("[shell] preferences unavailable", err);
      return DEFAULT_PREFERENCES;
    }),
  ]);

  return (
    <PreferencesProvider value={prefs}>
      {/* Density is an attribute rather than a class so the CSS can key off it
          without every component knowing the setting exists. */}
      <DensityShell>
        <Sidebar role={user.role} counts={counts} startCollapsed={prefs.compact_sidebar} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="chrome-blur sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border/60 bg-card/70 px-4">
          <MobileNav role={user.role} counts={counts} />
          <div className="min-w-0 flex-1">
            <CommandPalette role={user.role} />
          </div>
          <AlertBell alerts={alerts} />
          <SettingsButton />
          <UserMenu
            name={user.full_name}
            email={user.email}
            role={user.role}
            location={user.location}
            signOut={signOut}
          />
        </header>

        {/* Bottom padding clears the dock's collapsed tab, which is fixed to the
            bottom-left and would otherwise sit on the last row of a table. */}
        <main className="min-w-0 flex-1 px-4 py-6 pb-24 sm:px-6 lg:px-8">{children}</main>
      </div>

      {/* Bottom-left on every screen, matching where it sits in Salesforce
          today. A broker is on a call while looking at an account; a phone
          that lives on its own page is a phone nobody uses.

          The pool sits beside it for the same reason: claiming happens in the
          middle of doing something else, and sending somebody to another
          screen to do it costs them whatever they were on. */}
        <RcDock />
        <PoolDock />
      </DensityShell>
    </PreferencesProvider>
  );
}

/**
 * The numbers in the chrome.
 *
 * One round of queries for the whole shell rather than each widget fetching its
 * own, and every count is scoped by the same row level security as the screens
 * they link to -- a badge promising eleven items that opens a list of three is
 * worse than no badge.
 */
const EMPTY_COUNTS: NavCounts = { expiring: 0, unlogged: 0, review: 0, requests: 0 };

async function chromeData(
  userId: string,
  role: string,
): Promise<{ alerts: Alert[]; counts: NavCounts }> {
  const supabase = await createClient();
  const privileged = isPrivileged(role);

  // The bell is about the accounts YOU will lose. A manager sees their reports'
  // books through RLS, so the scope widens naturally; only credit and admin,
  // who own nothing, get an unfiltered view that would otherwise be noise.
  let atRisk = supabase
    .from("accounts_with_state")
    .select("id, name, state, days_left")
    .in("state", ["warning", "expiring", "overdue"])
    .order("urgency", { ascending: true })
    .order("days_left", { ascending: true, nullsFirst: false })
    .limit(50);
  if (!privileged) atRisk = atRisk.eq("owner_id", userId);

  const [risk, unlogged, review, requests] = await Promise.all([
    atRisk,
    supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("type", "call")
      .is("logged_at", null),
    supabase
      .from("unmatched_activities")
      .select("id", { count: "exact", head: true })
      .is("resolved_at", null),
    // Open requests raised by somebody else. RLS already limits this to the
    // caller's reporting line, so a broker sees zero and a manager sees their
    // own queue -- the badge and the screen agree without a role check here.
    supabase
      .from("account_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .neq("requested_by", userId),
  ]);

  const alerts = ((risk.data ?? []) as { id: string; name: string; state: string; days_left: number | null }[])
    .map((r) => ({
      id: r.id,
      name: r.name,
      state: r.state as LifecycleState,
      daysLeft: r.days_left,
    }))
    .slice(0, 25);

  return {
    alerts,
    counts: {
      expiring: risk.data?.length ?? 0,
      unlogged: unlogged.count ?? 0,
      review: review.count ?? 0,
      requests: requests.count ?? 0,
    },
  };
}
