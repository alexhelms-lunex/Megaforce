"use server";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { siteOrigin } from "@/lib/site-url";

export interface ResetRequestResult {
  sent?: boolean;
  error?: string;
}

/**
 * Send a password reset link.
 *
 * ===========================================================================
 * THE ANSWER IS THE SAME WHETHER OR NOT THE ADDRESS EXISTS.
 *
 * "No account with that email" is a helpful message and an account enumeration
 * oracle: anybody can feed a list of addresses through this form and learn
 * which of them work here. That is the first step of a credential-stuffing run,
 * and it is worth far more to an attacker than it is to the one person a year
 * who mistypes their own address.
 *
 * So this always reports success, and it does not look the address up. The
 * login form already takes the same line for the same reason.
 *
 * Supabase does the rate limiting -- its auth service caps reset emails per
 * address and per hour, which is the correct place for it: a limit enforced in
 * this file would be per serverless instance, and there are many.
 * ===========================================================================
 */
export async function requestPasswordReset(formData: FormData): Promise<ResetRequestResult> {
  try {
    if (!isSupabaseConfigured()) {
      return { error: "This deployment has no login service configured." };
    }

    const email = String(formData.get("email") ?? "")
      .trim()
      .toLowerCase();

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      // The one thing worth saying, because it is about what they typed rather
      // than about who exists.
      return { error: "That does not look like an email address." };
    }

    const supabase = await createClient();
    const origin = await siteOrigin();

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      // The link lands on a route handler, not on a page. Supabase's recovery
      // link carries a one-time code that has to be exchanged for a session
      // server-side before anything is rendered.
      redirectTo: `${origin}/auth/callback?next=/reset-password`,
    });

    if (error) {
      /*
       * Even here the answer stays vague about the address.
       *
       * Two failures are worth naming because they are OUR problem rather than
       * the sender's: the redirect URL not being on Supabase's allow-list, and
       * the rate limit. Everything else reports as sent.
       */
      if (/redirect|not allowed|invalid/i.test(error.message)) {
        return {
          error:
            "The reset link could not be created because this address is not on the " +
            `allowed list in Supabase. An administrator needs to add ${origin}/auth/callback ` +
            "under Authentication → URL Configuration → Redirect URLs.",
        };
      }
      if (/rate|too many|limit/i.test(error.message)) {
        return {
          error: "Too many reset emails have been sent recently. Wait a few minutes and try again.",
        };
      }
      console.error("[reset] failed", { message: error.message });
    }

    return { sent: true };
  } catch (err) {
    console.error("[reset] threw", err);
    // Still not a hint about the address. A thrown error here is ours.
    return { sent: true };
  }
}
