import Link from "next/link";
import { Settings2 } from "lucide-react";
import { currentUser } from "@/lib/supabase/server";
import { readPreferences } from "./actions";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

/**
 * Personal settings.
 *
 * Deliberately separate from /admin. This screen changes nothing anybody else
 * sees; that one changes the rules the company runs on. Putting a colour picker
 * next to a retention threshold invites somebody to treat them as the same kind
 * of decision.
 */
export default async function SettingsPage() {
  const me = await currentUser();
  if (!me) return null;
  const prefs = await readPreferences();

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Settings2 className="size-5 text-muted-foreground" aria-hidden />
            Settings
          </h1>
          <p className="text-sm text-muted-foreground">
            Yours alone. Nothing here changes what anybody else sees.
          </p>
        </div>
        {me.role === "admin" ? (
          <Link
            href="/admin"
            className="inline-flex h-9 items-center rounded-full border bg-card px-4 text-sm font-medium transition-colors hover:bg-accent"
          >
            Company administration
          </Link>
        ) : null}
      </header>

      <SettingsForm initial={prefs} />
    </div>
  );
}
