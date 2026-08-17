"use server";

import { createClient } from "@/lib/supabase/server";
import { checkPassword } from "@/lib/password";

export interface SetPasswordResult {
  ok?: boolean;
  error?: string;
}

/**
 * Set a new password for whoever is holding the recovery session.
 *
 * ===========================================================================
 * THE SESSION IS THE AUTHORISATION, AND IT HAS TO BE.
 *
 * This action takes no email and no user id, and that is the point. It changes
 * the password of the account whose recovery link was clicked -- established by
 * the cookie the callback route set after exchanging a one-time code that only
 * arrives in an email at that address.
 *
 * If it took an address instead, anybody could change anybody's password. The
 * whole security of the flow is that the caller is identified by something they
 * had to receive, not by something they typed.
 * ===========================================================================
 */
export async function setNewPassword(formData: FormData): Promise<SetPasswordResult> {
  try {
    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");

    if (password !== confirm) return { error: "The two passwords do not match." };

    const problem = checkPassword(password);
    if (problem) return { error: problem };

    const supabase = await createClient();

    // Confirm there is a session before trying. Without this, an expired link
    // produces Supabase's "Auth session missing", which reads like a fault.
    const { data, error: sessionError } = await supabase.auth.getUser();
    if (sessionError || !data?.user) {
      return {
        error:
          "This reset link is no longer valid — they expire after an hour and work only once. " +
          "Ask for a new one from the sign-in page.",
      };
    }

    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      if (/same|different from the old/i.test(error.message)) {
        return { error: "That is the password you already had. Choose a different one." };
      }
      return { error: error.message };
    }

    return { ok: true };
  } catch (err) {
    console.error("[reset] set password threw", err);
    return {
      error: `The password could not be changed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
