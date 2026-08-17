import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/info-tip";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/format";

/**
 * The report Customer Credit is actually judged on.
 *
 * ---------------------------------------------------------------------------
 * The rest of Reports measures selling: calls made, activities approved,
 * accounts claimed, accounts lost. Every one of those is structurally zero for
 * Credit -- they hold no book and make no calls -- so the page they were sent
 * to was a screen of zeroes with their name last on the leaderboard.
 *
 * A credit function is judged on throughput and turnaround, and turnaround is
 * the one that matters: a broker cannot quote without a limit, so every day of
 * delay is a stalled deal. Until this existed, the only person who knew how
 * long credit took was the broker who was waiting, and the only way to say so
 * was to ask again.
 *
 * The median sits beside the mean deliberately. One request that sat over a
 * bank holiday drags an average into uselessness, and then the conversation is
 * about the average rather than about the request.
 * ---------------------------------------------------------------------------
 */

interface Summary {
  raised: number;
  decided: number;
  approved: number;
  denied: number;
  still_waiting: number;
  approved_value: number;
  mean_hours: number | null;
  median_hours: number | null;
  slowest_hours: number | null;
}

interface Requester {
  requester: string;
  branch: string | null;
  raised: number;
  approved: number;
  denied: number;
  pending: number;
  approved_value: number;
  approval_rate: number | null;
}

export async function CreditReport({
  from,
  to,
  window,
}: {
  from: string;
  to: string;
  /** The period spelled out, so the card names the same dates the page does. */
  window: string;
}) {
  const supabase = await createClient();

  const [summaryRes, byRequesterRes, dailyRes] = await Promise.all([
    supabase.rpc("report_credit_summary", { p_from: from, p_to: to }),
    supabase.rpc("report_credit_by_requester", { p_from: from, p_to: to, p_limit: 25 }),
    supabase.rpc("report_credit_decisions", { p_from: from, p_to: to }),
  ]);

  const s: Summary = {
    raised: 0,
    decided: 0,
    approved: 0,
    denied: 0,
    still_waiting: 0,
    approved_value: 0,
    mean_hours: null,
    median_hours: null,
    slowest_hours: null,
    ...((summaryRes.data as Summary[] | null)?.[0] ?? {}),
  };
  const requesters = (byRequesterRes.data ?? []) as Requester[];
  const daily = (dailyRes.data ?? []) as {
    day: string;
    raised: number;
    approved: number;
    denied: number;
  }[];

  const failure = summaryRes.error?.message ?? null;
  const busiest = Math.max(1, ...daily.map((d) => Number(d.raised) + Number(d.approved)));

  return (
    <section className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          Credit · {window}
          <InfoTip text="Throughput and turnaround on credit limit requests. This is what a credit function is measured on — the selling figures below are about work you do not do." />
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          How much came in, how much went out, and how long people waited.
        </p>
      </div>

      {failure ? (
        <Card size="sm">
          <CardContent className="text-sm">
            <p className="font-medium">The credit report is not available yet.</p>
            <p className="mt-1 text-muted-foreground">
              An administrator needs to apply the latest database changes from the setup page.
            </p>
            <p className="mt-2 font-mono text-xs text-muted-foreground">{failure}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="Raised"
          value={Number(s.raised).toLocaleString()}
          detail={`${Number(s.still_waiting).toLocaleString()} still waiting`}
          help="Credit limit requests created in this window, whoever raised them."
        />
        <Figure
          label="Approved"
          value={Number(s.approved).toLocaleString()}
          detail={`${formatMoney(Number(s.approved_value))} of limit granted`}
          help="Decided in your favour in this window. The value is the sum of the limits set, not the increase over what was there before."
        />
        <Figure
          label="Typical wait"
          value={s.median_hours === null ? "—" : hours(Number(s.median_hours))}
          detail={s.mean_hours === null ? "nothing decided yet" : `${hours(Number(s.mean_hours))} on average`}
          tone={s.median_hours !== null && Number(s.median_hours) > 48 ? "warn" : "calm"}
          help="The MEDIAN time from raised to decided — half were faster, half slower. The median leads because one request that sat over a bank holiday drags an average into uselessness."
        />
        <Figure
          label="Slowest"
          value={s.slowest_hours === null ? "—" : hours(Number(s.slowest_hours))}
          detail="longest single wait"
          tone={s.slowest_hours !== null && Number(s.slowest_hours) > 120 ? "warn" : "calm"}
          help="The worst case in this window. Somebody's deal was blocked for this long, and they are the person who remembers it."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Day by day
            <InfoTip text="Raised against decided. Empty days are drawn rather than skipped — a series that omits them makes a quiet fortnight look like a gentle decline." />
          </CardTitle>
        </CardHeader>
        <CardContent>
          {daily.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing in this window.
            </p>
          ) : (
            <div className="flex h-32 items-end gap-px">
              {daily.map((d) => {
                const raised = Number(d.raised);
                const approved = Number(d.approved);
                const denied = Number(d.denied);
                return (
                  <div
                    key={d.day}
                    className="group relative flex flex-1 flex-col justify-end gap-px"
                    title={`${d.day}: ${raised} raised, ${approved} approved, ${denied} denied`}
                  >
                    <div
                      className="w-full rounded-t-sm bg-sky-500/70"
                      style={{ height: `${(raised / busiest) * 60}%` }}
                    />
                    <div
                      className="w-full bg-emerald-500/70"
                      style={{ height: `${(approved / busiest) * 60}%` }}
                    />
                    {denied > 0 ? (
                      <div
                        className="w-full bg-rose-500/60"
                        style={{ height: `${(denied / busiest) * 60}%` }}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
            <Key className="bg-sky-500/70" label="raised" />
            <Key className="bg-emerald-500/70" label="approved" />
            <Key className="bg-rose-500/60" label="denied" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Who is asking
            <InfoTip text="A broker approved nine times in ten is reading their customers correctly. One at three in ten is asking for the wrong things — which is a coaching conversation for their manager, not a credit problem." />
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {requesters.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Nobody has raised a credit request in this window.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-6 py-2 font-medium">Person</th>
                    <th className="px-3 py-2 font-medium">Branch</th>
                    <th className="px-3 py-2 text-right font-medium">Raised</th>
                    <th className="px-3 py-2 text-right font-medium">Approved</th>
                    <th className="px-3 py-2 text-right font-medium">Denied</th>
                    <th className="px-3 py-2 text-right font-medium">Waiting</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                    <th className="px-6 py-2 text-right font-medium">Granted</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {requesters.map((r) => (
                    <tr key={r.requester} className="hover:bg-accent/30">
                      <td className="px-6 py-2 font-medium">{r.requester}</td>
                      <td className="px-3 py-2 text-muted-foreground">{r.branch ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(r.raised)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(r.approved)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(r.denied)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(r.pending)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.approval_rate === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          `${Number(r.approval_rate)}%`
                        )}
                      </td>
                      <td className="px-6 py-2 text-right tabular-nums">
                        {formatMoney(Number(r.approved_value))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** Hours below two days, days above. Nobody reads "137 hours". */
function hours(value: number): string {
  if (value < 48) return `${Math.round(value)}h`;
  return `${(value / 24).toFixed(1)}d`;
}

function Figure({
  label,
  value,
  detail,
  tone = "calm",
  help,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "calm" | "warn";
  help: string;
}) {
  return (
    <div
      className={`rounded-2xl border bg-card p-5 ${
        tone === "warn" ? "border-amber-300 dark:border-amber-900" : "border-border/60"
      }`}
    >
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        <InfoTip text={help} />
      </p>
      <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

function Key({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`size-2.5 rounded-sm ${className}`} aria-hidden />
      {label}
    </span>
  );
}
