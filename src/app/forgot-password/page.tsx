import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SetupNotice } from "@/components/setup-notice";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { ForgotPasswordForm } from "./form";

export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  if (!isSupabaseConfigured()) return <SetupNotice />;

  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center p-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Reset your password</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            Enter the address you sign in with. We will email you a link that lets you set a new
            password. The link works once and expires after an hour.
          </p>
          <ForgotPasswordForm />
        </CardContent>
      </Card>
    </div>
  );
}
