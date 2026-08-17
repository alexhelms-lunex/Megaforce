import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertOctagon, ShieldCheck, UserPlus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { InfoTip } from "@/components/info-tip";
import { createClient, currentUser } from "@/lib/supabase/server";
import { ROLES, type AdminUser } from "@/lib/roles";
import { UserTable } from "./user-table";
import { UserFilters } from "./filters";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * The people screen.
 *
 * ---------------------------------------------------------------------------
 * Modelled on WordPress's Users list, because it is the shape everybody
 * already knows and because the shape is right: filter links with counts
 * across the top, a search box, a checkbox column driving bulk actions, and
 * one row per person carrying the few facts that make a name mean something.
 *
 * Two columns are here that WordPress does not have, and they are the ones
 * that matter in this application. "Accounts" is how much book somebody is
 * holding, which is the question behind every conversation about whether they
 * can take more. And "Login" separates a person who EXISTS from a person who
 * can get IN -- the ordinary state of a starter whose first day is Monday, and
 * previously invisible, so somebody added on Friday looked identical to
 * somebody who had been locked out.
 * ---------------------------------------------------------------------------
 */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await currentUser();
  if (!me) return null;
  // Not an error page. Somebody who is not an admin has no business knowing
  // this screen exists, and sending them home is a clearer answer than a
  // refusal they cannot act on.
  if (me.role !== "admin") redirect("/");

  const params = await searchParams;
  const one = (key: string) => {
    const v = params[key];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };

  const search = one("q");
  const role = ROLES.some((r) => r.key === one("role")) ? one("role") : "";
  const status = ["active", "inactive", "all", "nologin"].includes(one("status"))
    ? one("status")
    : "active";
  const page = Math.max(1, Number(one("page")) || 1);

  const supabase = await createClient();
  const [listRes, countRes, managersRes] = await Promise.all([
    supabase.rpc("admin_users", {
      p_search: search,
      p_role: role,
      p_status: status,
      p_limit: PAGE_SIZE,
      p_offset: (page - 1) * PAGE_SIZE,
    }),
    supabase.rpc("admin_user_counts"),
    supabase
      .from("users")
      .select("id, full_name, role")
      .eq("active", true)
      .order("full_name")
      .limit(500),
  ]);

  const error = listRes.error?.message ?? null;
  const users = (listRes.data ?? []) as unknown as AdminUser[];
  const counts = Object.fromEntries(
    ((countRes.data ?? []) as { bucket: string; n: number }[]).map((r) => [r.bucket, Number(r.n)]),
  );
  const colleagues = ((managersRes.data ?? []) as { id: string; full_name: string; role: string }[])
    .map((u) => ({ id: u.id, name: u.full_name, role: u.role }));

  const total = users.length > 0 ? Number(users[0].total_rows) : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            People
            <InfoTip
              side="bottom"
              text="Everyone with a profile in Megaforce. A profile is what owns accounts and logs activity; a login is what gets somebody in. The two are separate, so a starter can exist before their first day."
            />
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {counts.active ?? 0} active · {counts.inactive ?? 0} deactivated ·{" "}
            {counts.nologin ?? 0} with no login yet
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/admin/roles"
            className="inline-flex h-9 items-center gap-1.5 rounded-full border bg-card px-4 text-sm font-medium transition-colors hover:bg-accent"
          >
            <ShieldCheck className="size-3.5" aria-hidden />
            What each role can do
          </Link>
          <Link
            href="/admin/users/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/85"
          >
            <UserPlus className="size-3.5" aria-hidden />
            Add someone
          </Link>
        </div>
      </header>

      {error ? (
        <Card className="border-destructive/40">
          <CardContent className="space-y-2 py-5">
            <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <AlertOctagon className="size-4" aria-hidden />
              The user list could not be read
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {/does not exist|schema cache|could not find/i.test(error)
                ? "The database is behind this version of the app. Re-run setup from the Admin screen to apply the latest migrations."
                : "The query failed."}
            </p>
            <p className="font-mono text-xs text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <UserFilters counts={counts} role={role} status={status} search={search} />

          <UserTable
            users={users}
            colleagues={colleagues}
            currentUserId={me.id}
            page={page}
            pages={pages}
            total={total}
            params={params}
          />
        </>
      )}
    </div>
  );
}
