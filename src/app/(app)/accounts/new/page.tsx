import Link from "next/link";
import { AccountForm } from "@/components/account-form";
import { createAccount } from "../actions";
import { createClient } from "@/lib/supabase/server";
import type { FieldDefinition } from "@/lib/custom-values";

export const dynamic = "force-dynamic";

export default async function NewAccountPage() {
  const supabase = await createClient();

  // The form's lower half is built from these rows, not from anything written
  // in the component.
  const { data } = await supabase
    .from("field_defs")
    .select("key, label, type, options, required")
    .eq("object", "account")
    .eq("archived", false)
    .order("sort");

  return (
    <div className="space-y-6">
      <div>
        <Link href="/accounts" className="text-sm text-muted-foreground hover:underline">
          ← Accounts
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New company</h1>
        <p className="text-sm text-muted-foreground">
          Claiming it starts your clock. Log a qualifying call within 45 days to keep it.
        </p>
      </div>

      <AccountForm
        action={createAccount}
        defs={(data ?? []) as FieldDefinition[]}
        submitLabel="Create company"
      />
    </div>
  );
}
