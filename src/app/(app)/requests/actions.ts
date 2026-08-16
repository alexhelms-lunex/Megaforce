"use server";

import { revalidatePath } from "next/cache";
import { createClient, currentUser } from "@/lib/supabase/server";
import { REQUEST_KINDS } from "@/lib/request-kinds";


export interface RequestResult {
  ok?: true;
  error?: string;
}

/**
 * Raise a request against an account.
 *
 * requested_by is taken from the session, never from the form. The row level
 * security policy checks the same thing with a WITH CHECK clause, so a crafted
 * POST cannot file a request in a colleague's name even if this function were
 * bypassed entirely.
 */
export async function createRequest(_prev: RequestResult, form: FormData): Promise<RequestResult> {
  const me = await currentUser();
  if (!me) return { error: "Not signed in." };

  const accountId = String(form.get("accountId") ?? "");
  const kind = String(form.get("kind") ?? "");
  const reason = String(form.get("reason") ?? "").trim();
  const rawDays = String(form.get("days") ?? "").trim();
  const transferTo = String(form.get("transferTo") ?? "");

  const spec = REQUEST_KINDS.find((k) => k.value === kind);
  if (!accountId) return { error: "No account." };
  if (!spec) return { error: "Pick what you are asking for." };
  if (!reason) return { error: "Say why. Whoever approves this has to justify it too." };

  let days: number | null = null;
  if (spec.needsDays) {
    days = Number.parseInt(rawDays || "30", 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return { error: "Days must be between 1 and 365." };
    }
  }
  if (spec.needsTarget && !transferTo) return { error: "Pick who it should go to." };

  const supabase = await createClient();
  const { error } = await supabase.from("account_requests").insert({
    account_id: accountId,
    requested_by: me.id,
    kind,
    reason,
    days,
    transfer_to: spec.needsTarget ? transferTo : null,
    status: "pending",
  });

  if (error) {
    // The unique partial index is the likeliest failure and the least obvious,
    // so it gets its own sentence rather than a Postgres error code.
    if (error.code === "23505") {
      return { error: "There is already an open request on this account." };
    }
    return { error: error.message };
  }

  revalidatePath("/requests");
  revalidatePath(`/accounts/${accountId}`);
  return { ok: true };
}

/**
 * Approve or deny.
 *
 * Delegates to decide_account_request(), which writes the decision and applies
 * its effect in one transaction. Doing those as two statements from here would
 * mean a crash between them leaves a request marked approved that granted
 * nothing — and the holder finds out when the account disappears.
 */
export async function decideRequest(form: FormData): Promise<RequestResult> {
  const me = await currentUser();
  if (!me) return { error: "Not signed in." };

  const id = String(form.get("requestId") ?? "");
  const approve = String(form.get("decision") ?? "") === "approve";
  const note = String(form.get("note") ?? "").trim() || null;
  if (!id) return { error: "No request." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decide_account_request", {
    p_request_id: id,
    p_approve: approve,
    p_note: note,
  });

  if (error) return { error: error.message };
  // The function returns a sentence when it refuses -- self-approval, or a
  // request somebody else already decided.
  if (data && data !== "approved" && data !== "denied") return { error: String(data) };

  revalidatePath("/requests");
  revalidatePath("/accounts");
  return { ok: true };
}

/** Take back a request you raised, while it is still open. */
export async function withdrawRequest(form: FormData): Promise<RequestResult> {
  const me = await currentUser();
  if (!me) return { error: "Not signed in." };

  const id = String(form.get("requestId") ?? "");
  const supabase = await createClient();
  const { error } = await supabase
    .from("account_requests")
    .update({ status: "withdrawn" })
    .eq("id", id)
    .eq("requested_by", me.id)
    .eq("status", "pending");

  if (error) return { error: error.message };
  revalidatePath("/requests");
  return { ok: true };
}
