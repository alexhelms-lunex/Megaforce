import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/info-tip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { createClient } from "@/lib/supabase/server";
import { formatDuration } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { ResolveForm, type AccountOption } from "./resolve-form";
import { LocalTime } from "@/components/local-time";

export const dynamic = "force-dynamic";

/** Plain-language explanations. The queue is read by humans, not by engineers. */
const REASONS: Record<string, { label: string; explain: string }> = {
  no_contact_match: {
    label: "Unknown number",
    explain: "No contact in the CRM holds this number, so there was no account to attach it to.",
  },
  multiple_accounts: {
    label: "Two possible accounts",
    explain:
      "This number appears at more than one account. Guessing would file the call against the wrong customer, so it waits for a person.",
  },
  unusable_phone_number: {
    label: "No usable caller ID",
    explain:
      "The caller withheld their number, or what arrived was not a number the system could use as a match key.",
  },
  unusable_email_address: {
    label: "No usable address",
    explain: "The message arrived without an address that could be matched to a contact.",
  },
};

export default async function ReviewPage() {
  const supabase = await createClient();

  // RLS restricts this table to managers and admins; a rep sees an empty queue
  // rather than a permission error.
  const { data: items, error } = await supabase
    .from("unmatched_activities")
    .select(
      "id, reason, phone_e164, email, direction, duration_seconds, result, occurred_at, created_at, candidate_account_ids",
    )
    .is("resolved_at", null)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return <p className="text-sm text-destructive">Could not load the queue: {error.message}</p>;
  }

  const queue = items ?? [];

  // Candidate names for the ambiguous items, in one round trip rather than one
  // per row.
  const candidateIds = [...new Set(queue.flatMap((i) => i.candidate_account_ids ?? []))];
  const { data: candidateAccounts } = candidateIds.length
    ? await supabase.from("accounts").select("id, name").in("id", candidateIds)
    : { data: [] as AccountOption[] };

  // For items with no candidates at all, the reviewer needs something to pick
  // from. Capped, because this is a picker and not a browser.
  const { data: allAccounts } = await supabase
    .from("accounts")
    .select("id, name")
    .order("name")
    .limit(300);

  const byId = new Map((candidateAccounts ?? []).map((a) => [a.id, a as AccountOption]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">Review queue<InfoTip k="reviewQueue" side="bottom" /></h1>
        <p className="text-sm text-muted-foreground">
          Calls and emails the system refused to guess about. {queue.length} waiting.
        </p>
      </div>

      {queue.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Nothing waiting. Every captured call landed on an account.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {queue.map((item) => {
            const meta = REASONS[item.reason] ?? {
              label: item.reason,
              explain: "Held for review.",
            };
            const candidates = (item.candidate_account_ids ?? [])
              .map((id: string) => byId.get(id))
              .filter(Boolean) as AccountOption[];
            const options = candidates.length > 0 ? candidates : ((allAccounts ?? []) as AccountOption[]);

            return (
              <Card key={item.id}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <CardTitle className="text-base">
                      {item.phone_e164 ? formatPhone(item.phone_e164) : item.email ?? "Unknown"}
                    </CardTitle>
                    <Badge variant="outline">{meta.label}</Badge>
                    {item.direction ? (
                      <span className="text-xs text-muted-foreground">{item.direction}</span>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">{meta.explain}</p>
                  <p className="text-xs text-muted-foreground">
                    <LocalTime iso={item.occurred_at ?? item.created_at} />
                    {item.duration_seconds !== null
                      ? ` · ${formatDuration(item.duration_seconds)}`
                      : ""}
                    {item.result ? ` · ${item.result}` : ""}
                  </p>
                  <Separator />
                  <ResolveForm unmatchedId={item.id} options={options} />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
