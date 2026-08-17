import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SetupNotice } from "@/components/setup-notice";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { ResetPasswordForm } from "./form";

export const dynamic = "force-dynamic";

/**
 * Setting the new password.
 *
 * Reached only from /auth/callback, which exchanges the one-time code in the
 * email for a session first. So by the time this renders there IS a session --
 * and if there is not, the link was old, and saying so plainly beats rendering
 * a form that will fail on submit.
 */
export default async function ResetPasswordPage() {
  if (!isSupabaseConfigured()) return <SetupNotice />;

  let email: string | null = null;
  let hasSession = false;

  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    hasSession = Boolean(data?.user);
    email = data?.user?.email ?? null;
  } catch {
    // Treated as no session. The page below explains itself either way, and a
    // throw here would produce the redacted error instead of a sentence.
    hasSession = false;
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center p-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{hasSession ? "Choose a new password" : "That link has expired"}</CardTitle>
        </CardHeader>
        <CardContent>
          {hasSession ? (
            <ResetPasswordForm email={email} />
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Reset links last an hour and work once. This one has been used already, or it is
                older than that.
              </p>
              <Link
                href="/forgot-password"
                className="inline-flex h-9 w-full items-center justify-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Send me a new link
              </Link>
              <p className="text-center text-sm">
                <Link
                  href="/login"
                  className="text-muted-foreground hover:text-foreground hover:underline"
                >
                  Back to sign in
                </Link>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
