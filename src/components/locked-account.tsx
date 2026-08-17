import Link from "next/link";
import { Lock, MapPin, UserRound } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { CompanyMap } from "@/components/company-map";

export interface DirectoryEntry {
  id: string;
  name: string;
  billing_street: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_postal_code: string | null;
  billing_country: string | null;
  owner_id: string | null;
  owner_name: string | null;
  ad_owner_id: string | null;
  ad_owner_name: string | null;
  available: boolean;
  can_open: boolean;
  held_since?: string | null;
}

/**
 * A company somebody else is working.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS AT ALL
 *
 * A colleague's account used to 404. That is technically honest -- row level
 * security really does make the row invisible -- and it is the wrong answer to
 * the question actually being asked, which is "is this company already
 * somebody's?"
 *
 * Answering that costs nothing proprietary. The name and address came from
 * outside the company; the holder's name is on every other screen already. What
 * it saves is two brokers cold-calling the same buyer in the same week, each
 * believing the company was untouched -- which is worse for the business than
 * either of them knowing.
 *
 * So the page says exactly three things: this exists, here is where it is, and
 * this person has it. Everything that represents somebody's WORK -- the
 * contacts they found, the calls they made, the notes they wrote, the terms
 * they negotiated -- is not here and is not fetched.
 *
 * The tone matters. This is not an error and it is not a permission failure; it
 * is the ownership rule working. A red "access denied" would read as a fault
 * and generate a support message. It reads as information instead.
 * ---------------------------------------------------------------------------
 */
export function LockedAccount({ entry }: { entry: DirectoryEntry }) {
  const holder = entry.owner_name ?? "somebody";
  const address = [
    entry.billing_street,
    [entry.billing_city, entry.billing_state].filter(Boolean).join(", "),
    entry.billing_postal_code,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <nav className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link href="/accounts" className="hover:text-foreground hover:underline">
          Accounts
        </Link>
        <span aria-hidden>›</span>
        <span className="text-foreground">{entry.name}</span>
      </nav>

      <div className="overflow-hidden rounded-2xl border border-border/60">
        <div className="border-b border-border/60 bg-muted/40 px-6 py-5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{entry.name}</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <Lock className="size-3" aria-hidden />
              Held by {holder}
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {holder} is working this company, so the contacts, calls, notes and pipeline inside it
            belong to them. You can see that it exists and where it is — that is what stops two
            people calling the same buyer in the same week.
          </p>
        </div>

        <div className="grid gap-px bg-border/60 sm:grid-cols-2">
          <Field icon={<UserRound className="size-3.5" aria-hidden />} label="Held by">
            {entry.owner_name ?? "—"}
            {entry.ad_owner_name ? (
              <span className="block text-xs font-normal text-muted-foreground">
                with {entry.ad_owner_name} as account director
              </span>
            ) : null}
          </Field>
          <Field icon={<MapPin className="size-3.5" aria-hidden />} label="Location">
            {address || "No address on file"}
          </Field>
        </div>
      </div>

      {entry.billing_city || entry.billing_state ? (
        <Card size="sm">
          <CardContent className="p-0">
            <CompanyMap
              name={entry.name}
              address={{
                street: entry.billing_street,
                city: entry.billing_city,
                state: entry.billing_state,
                postalCode: entry.billing_postal_code,
                country: entry.billing_country,
                latitude: null,
                longitude: null,
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card size="sm">
        <CardContent className="space-y-3 text-sm">
          <h2 className="font-semibold">What happens next</h2>
          <p className="text-muted-foreground">
            Every held account is on a clock. If {holder} stops working this one, it returns to the
            available pool automatically and anybody can claim it — at which point everything inside
            it opens up.
          </p>
          <p className="text-muted-foreground">
            If you have a reason to take it over now, ask your manager to raise a transfer. Do not
            work it in parallel; the calls will not count for you and the company gets two people
            from the same brokerage in the same week.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Link
              href="/available"
              className="inline-flex h-9 items-center rounded-full border border-border px-4 text-sm font-medium transition-colors hover:bg-accent"
            >
              Browse the available pool
            </Link>
            <Link
              href="/accounts"
              className="inline-flex h-9 items-center rounded-full border border-border px-4 text-sm font-medium transition-colors hover:bg-accent"
            >
              Back to accounts
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card px-6 py-4">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-sm font-medium">{children}</p>
    </div>
  );
}
