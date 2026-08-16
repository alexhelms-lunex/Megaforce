"use server";

import { createClient } from "@/lib/supabase/server";

/**
 * What the command palette can jump to.
 *
 * One action rather than one per object, because the person typing does not
 * know whether "Halvorsen" is a company or a buyer -- they know the word. The
 * palette runs the searches concurrently and interleaves the results.
 */
export interface SearchHit {
  kind: "account" | "contact";
  id: string;
  /** Where to navigate. Contacts open their account. */
  href: string;
  title: string;
  subtitle: string;
}

export async function globalSearch(query: string): Promise<SearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const supabase = await createClient();
  // PostgREST treats , and ) as syntax inside an or() filter, so a raw query
  // string could otherwise change the meaning of the filter rather than being
  // searched for. Stripped rather than escaped: nobody searches for a comma.
  const safe = q.replace(/[,()*\\]/g, " ").trim();
  if (!safe) return [];

  const [accounts, contacts] = await Promise.all([
    supabase
      .from("accounts_with_state")
      .select("id, name, status, billing_city, billing_state, owner_name")
      .or(`name.ilike.%${safe}%,billing_city.ilike.%${safe}%,website.ilike.%${safe}%`)
      .limit(8),
    supabase
      .from("contacts")
      .select("id, first_name, last_name, title, email, phone_e164, account_id, accounts(name)")
      .or(`first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,email.ilike.%${safe}%`)
      .limit(6),
  ]);

  const hits: SearchHit[] = [];

  for (const a of accounts.data ?? []) {
    const row = a as {
      id: string;
      name: string;
      status: string;
      billing_city: string | null;
      billing_state: string | null;
      owner_name: string | null;
    };
    hits.push({
      kind: "account",
      id: row.id,
      href: `/accounts/${row.id}`,
      title: row.name,
      subtitle: [
        row.billing_city && row.billing_state ? `${row.billing_city}, ${row.billing_state}` : null,
        row.owner_name ?? "unclaimed",
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  for (const c of contacts.data ?? []) {
    const row = c as unknown as {
      id: string;
      first_name: string;
      last_name: string;
      title: string | null;
      email: string | null;
      account_id: string;
      accounts: { name: string } | { name: string }[] | null;
    };
    const account = Array.isArray(row.accounts) ? row.accounts[0] : row.accounts;
    hits.push({
      kind: "contact",
      id: row.id,
      href: `/accounts/${row.account_id}?tab=contacts`,
      title: `${row.first_name} ${row.last_name}`,
      subtitle: [row.title, account?.name].filter(Boolean).join(" · ") || "Contact",
    });
  }

  return hits;
}
