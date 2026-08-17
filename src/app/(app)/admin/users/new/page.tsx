import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { createClient, currentUser } from "@/lib/supabase/server";
import { UserForm } from "../user-form";

export const dynamic = "force-dynamic";

/** Adding somebody. Same form as editing, so the two cannot drift apart. */
export default async function NewUserPage() {
  const me = await currentUser();
  if (!me) return null;
  if (me.role !== "admin") redirect("/");

  const supabase = await createClient();
  const { data } = await supabase
    .from("users")
    .select("id, full_name, role")
    .eq("active", true)
    .order("full_name")
    .limit(500);

  const colleagues = ((data ?? []) as { id: string; full_name: string; role: string }[]).map(
    (u) => ({ id: u.id, name: u.full_name, role: u.role }),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <nav className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link href="/admin/users" className="hover:text-foreground hover:underline">
          People
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <span className="text-foreground">Add someone</span>
      </nav>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Add someone</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A profile is what owns accounts and logs activity. A login is what gets them in. You can
          create one without the other.
        </p>
      </div>

      <UserForm colleagues={colleagues} />
    </div>
  );
}
