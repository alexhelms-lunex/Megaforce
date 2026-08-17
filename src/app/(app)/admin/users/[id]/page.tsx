import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient, currentUser } from "@/lib/supabase/server";
import { ROLE_BADGE, ROLE_LABEL, type AdminUser } from "@/lib/roles";
import { formatDateTime } from "@/lib/format";
import { UserForm } from "../user-form";

export const dynamic = "force-dynamic";

/**
 * One person.
 *
 * The read goes through admin_users() with a search rather than a plain select,
 * so this screen and the list are looking at exactly the same shape -- including
 * the counts, which a select on `users` would not carry.
 */
export default async function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await currentUser();
  if (!me) return null;
  if (me.role !== "admin") redirect("/");

  const supabase = await createClient();
  const [listRes, colleaguesRes] = await Promise.all([
    supabase.rpc("admin_users", {
      p_search: "",
      p_role: "",
      p_status: "all",
      p_limit: 200,
      p_offset: 0,
    }),
    supabase.from("users").select("id, full_name, role").eq("active", true).order("full_name").limit(500),
  ]);

  const all = (listRes.data ?? []) as unknown as AdminUser[];
  const user = all.find((u) => u.id === id);
  if (!user) notFound();

  const colleagues = ((colleaguesRes.data ?? []) as { id: string; full_name: string; role: string }[])
    .map((u) => ({ id: u.id, name: u.full_name, role: u.role }));

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <nav className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link href="/admin/users" className="hover:text-foreground hover:underline">
          People
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <span className="text-foreground">{user.full_name}</span>
      </nav>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{user.full_name}</h1>
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${
            ROLE_BADGE[user.role] ?? ROLE_BADGE.broker
          }`}
        >
          {ROLE_LABEL[user.role] ?? user.role}
        </span>
        {!user.active ? (
          <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
            deactivated {user.deactivated_at ? formatDateTime(user.deactivated_at) : ""}
          </span>
        ) : null}
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-base">Where they stand</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Stat label="Accounts held" value={user.accounts_held} href={`/accounts?owner=${user.id}`} />
          <Stat label="Calls, last 30 days" value={user.calls_30d} />
          <Stat label="Reports to" value={user.manager_name ?? "Nobody"} />
        </CardContent>
      </Card>

      <UserForm user={user} colleagues={colleagues} isSelf={user.id === me.id} />
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: string | number; href?: string }) {
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </>
  );
  return href ? (
    <Link href={href} className="rounded-lg transition-colors hover:bg-accent/40">
      {body}
    </Link>
  ) : (
    <div>{body}</div>
  );
}
