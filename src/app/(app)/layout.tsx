import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SetupNotice } from "@/components/setup-notice";
import { RcDock } from "@/components/rc-dock/dock";
import { createClient, currentUser, isSupabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

const NAV = [
  { href: "/accounts", label: "Accounts" },
  { href: "/available", label: "Available" },
  { href: "/review", label: "Review queue" },
];

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

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
          <Link href="/accounts" className="font-semibold tracking-tight">
            Megaforce
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{user.full_name}</span>
            <Badge variant="secondary">{user.role}</Badge>
            <form action={signOut}>
              <Button variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      {/* Extra bottom padding so the dock's collapsed tab never covers the
          last row of a table. */}
      <main className="mx-auto max-w-7xl px-6 py-8 pb-20">{children}</main>

      {/* Bottom-left on every screen, matching where it sits in Salesforce
          today. A broker is on a call while looking at an account; a phone
          that lives on its own page is a phone nobody uses. */}
      <RcDock />
    </div>
  );
}
