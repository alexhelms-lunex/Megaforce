import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SetupNotice } from "@/components/setup-notice";
import { RcDock } from "@/components/rc-dock/dock";
import { AlertBell, type Alert } from "@/components/shell/alert-bell";
import { CommandPalette } from "@/components/shell/command-palette";
import { MobileNav } from "@/components/shell/mobile-nav";
import { Sidebar, type NavCounts } from "@/components/shell/sidebar";
import { UserMenu } from "@/components/shell/user-menu";
import { createClient, currentUser, isPrivileged, isSupabaseConfigured } from "@/lib/supabase/server";
import type { LifecycleState } from "@/lib/lifecycle";

export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!isSupabaseConfigured()) return <SetupNotice />;

  const user = await currentUser();
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

  const { alerts, counts } = await chromeData(user.id, user.role);

  return (
    <div className="flex min-h-screen">
      <Sidebar role={user.role} counts={counts} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-card/85 px-4 backdrop-blur-md">
          <MobileNav role={user.role} counts={counts} />
          <div className="min-w-0 flex-1">
            <CommandPalette role={user.role} />
          </div>
          <AlertBell alerts={alerts} />
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
          that lives on its own page is a phone nobody uses. */}
      <RcDock />
    </div>
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

  const [risk, unlogged, review] = await Promise.all([
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
      // The approvals table arrives with the Account Requests screen. Zero
      // until then, rather than a badge that lies.
      requests: 0,
    },
  };
}
