import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountForm } from "@/components/account-form";
import { updateAccount } from "../../actions";
import { createClient } from "@/lib/supabase/server";
import type { FieldDefinition } from "@/lib/custom-values";

export const dynamic = "force-dynamic";

export default async function EditAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [accountRes, defsRes] = await Promise.all([
    supabase.from("accounts").select("id, name, status, industry, domain, custom").eq("id", id).maybeSingle(),
    supabase
      .from("field_defs")
      .select("key, label, type, options, required")
      .eq("object", "account")
      .eq("archived", false)
      .order("sort"),
  ]);

  // RLS already filtered this. An account the user cannot see returns nothing
  // and renders as a 404, which is the right answer -- "forbidden" would
  // confirm the record exists.
  if (!accountRes.data) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/accounts/${id}`} className="text-sm text-muted-foreground hover:underline">
          ← {accountRes.data.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit company</h1>
        <p className="text-sm text-muted-foreground">
          Ownership is not editable here — moving an account between brokers is an admin action.
        </p>
      </div>

      <AccountForm
        action={updateAccount}
        defs={(defsRes.data ?? []) as FieldDefinition[]}
        account={accountRes.data}
        submitLabel="Save changes"
      />
    </div>
  );
}
