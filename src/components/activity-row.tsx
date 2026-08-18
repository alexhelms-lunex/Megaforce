import Link from "next/link";
import { Mail, PhoneCall, StickyNote, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  NEEDS_WRITE_UP,
  activityTone,
  countedTone,
  directionTone,
} from "@/lib/activity-style";
import { formatDateTime, formatDuration } from "@/lib/format";

/**
 * One row of the activity feed.
 *
 * ===========================================================================
 * WHAT ALEX ASKED FOR, AND WHY IT IS THE RIGHT CALL
 *
 *   "For activities logged the only thing under the title should be notes on
 *    the call. Not system notes. It should only say qualified or not qualified.
 *    Then in a tab you can put those system notes but the first thing we see."
 *
 * Every row used to carry four lines: the company, a subject line the phone
 * system wrote, whatever the broker typed, and a sentence explaining how the
 * qualifier reached its verdict. Three of those four were written by machines,
 * and they sat above and below the one line a person wrote — so scanning a
 * feed for "what did we actually say to them" meant reading past two machine
 * sentences per row, thirty times.
 *
 * The verdict still has to be on the row: it is the whole reason the feed
 * exists. But it is a two-word answer, so it is a badge on the right rather
 * than a sentence in the body. The REASONING behind the verdict is a different
 * question — asked rarely, and only when the verdict looks wrong — so it moves
 * behind a tab.
 *
 * THE ONE THING THE NOTES VIEW MUST NOT DO
 *
 * An unwritten call has no note. Rendering nothing there would make it
 * indistinguishable from a call somebody wrote up in one word, when it is in
 * fact the most actionable row on the screen — the account's clock is running
 * down while its own history says a call happened. So the empty case is
 * explicit, and it is the amber one.
 * ===========================================================================
 */

export interface FeedActivity {
  id: string;
  type: string;
  direction: string | null;
  subject: string | null;
  occurred_at: string;
  duration_seconds: number | null;
  result: string | null;
  source: string | null;
  qualifies: boolean;
  qualification_reason: string;
  stage_outcome: string | null;
  notes: string | null;
  logged_at: string | null;
  account_id?: string | null;
  accountName?: string | null;
  userName?: string | null;
}

export type FeedView = "notes" | "system";

const TYPE_ICON: Record<string, React.ElementType> = {
  call: PhoneCall,
  email: Mail,
  meeting: Users,
  note: StickyNote,
};

export function ActivityRow({
  activity: a,
  view,
  showAccount = true,
}: {
  activity: FeedActivity;
  view: FeedView;
  /** Off on an account's own page, where every row is the same company. */
  showAccount?: boolean;
}) {
  const Icon = TYPE_ICON[a.type] ?? StickyNote;
  const tone = activityTone(a.type);
  const direction = directionTone(a.direction);
  const needsWriteUp = a.type === "call" && !a.logged_at;

  return (
    <li className="flex items-start gap-3 px-5 py-3 hover:bg-accent/40">
      {/* Coloured by TYPE. The type is what a scan is looking for; the verdict
          is on the right, in words, where the decision gets made. */}
      <span
        className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${tone.icon}`}
      >
        <Icon className="size-3.5" aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {showAccount ? (
            a.account_id && a.accountName ? (
              <Link
                href={`/accounts/${a.account_id}`}
                className="truncate text-sm font-medium hover:underline"
              >
                {a.accountName}
              </Link>
            ) : (
              <span className="text-sm font-medium italic text-muted-foreground">
                no company matched
              </span>
            )
          ) : null}
          <span className={`rounded-full border px-1.5 py-px text-[10px] font-medium ${tone.chip}`}>
            {tone.label}
          </span>
          {direction ? (
            <span
              className={`rounded-full border px-1.5 py-px text-[10px] font-medium ${direction}`}
            >
              {a.direction}
            </span>
          ) : null}
          {a.stage_outcome ? (
            <Badge variant="secondary" className="text-[10px]">
              → {a.stage_outcome}
            </Badge>
          ) : null}
          {needsWriteUp ? (
            <span
              className={`rounded-full border px-1.5 py-px text-[10px] font-semibold ${NEEDS_WRITE_UP}`}
            >
              not written up
            </span>
          ) : null}
        </div>

        {view === "notes" ? <Notes activity={a} /> : <SystemNotes activity={a} />}
      </div>

      <div className="shrink-0 text-right">
        <p className="whitespace-nowrap text-xs text-muted-foreground">
          {formatDateTime(a.occurred_at)}
        </p>
        {a.userName ? (
          <p className="truncate text-xs text-muted-foreground/80">{a.userName}</p>
        ) : null}
        {/* Alex: "It should only say qualified or not qualified." */}
        <span
          className={`mt-1 inline-flex rounded-full border px-1.5 py-px text-[10px] font-medium ${countedTone(
            a.qualifies,
          )}`}
        >
          {a.qualifies ? "Qualified" : "Not qualified"}
        </span>
      </div>
    </li>
  );
}

/** What the person wrote, and nothing else. */
function Notes({ activity: a }: { activity: FeedActivity }) {
  if (a.notes && a.notes.trim()) {
    return <p className="mt-0.5 whitespace-pre-line text-sm">{a.notes}</p>;
  }
  if (a.type === "call" && !a.logged_at) {
    return (
      <p className="mt-0.5 text-sm font-medium text-amber-700 dark:text-amber-300">
        Nothing written up yet — this call is not holding the clock.
      </p>
    );
  }
  return <p className="mt-0.5 text-sm text-muted-foreground/70">No note.</p>;
}

/**
 * Everything a machine wrote about this activity.
 *
 * Laid out as labelled facts rather than as a paragraph. Somebody opens this
 * tab with one question — usually "why did this not count" — and a list they
 * can run an eye down answers it faster than prose.
 */
function SystemNotes({ activity: a }: { activity: FeedActivity }) {
  const facts: [string, string | null][] = [
    ["Subject", a.subject],
    ["Verdict", a.qualification_reason || null],
    ["Result", a.result],
    ["Duration", a.duration_seconds !== null ? formatDuration(a.duration_seconds) : null],
    ["Captured by", a.source],
    ["Written up", a.logged_at ? formatDateTime(a.logged_at) : "not yet"],
  ];

  return (
    <dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
      {facts.map(([label, value]) =>
        value ? (
          <div key={label} className="flex gap-1.5">
            <dt className="shrink-0 font-medium text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate text-foreground/90">{value}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

/**
 * The two tabs, as links.
 *
 * Links rather than client state so the choice is in the URL: a manager asking
 * "why did none of Tuesday count" can send the answer rather than describing
 * how to get to it.
 */
export function FeedViewTabs({
  view,
  hrefFor,
}: {
  view: FeedView;
  hrefFor: (view: FeedView) => string;
}) {
  const tabs: { key: FeedView; label: string; hint: string }[] = [
    { key: "notes", label: "Notes", hint: "What the person wrote." },
    {
      key: "system",
      label: "System notes",
      hint: "The subject line, the qualifier's verdict, the duration and where the record came from.",
    },
  ];

  return (
    <div className="inline-flex rounded-full border p-0.5">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={hrefFor(t.key)}
          title={t.hint}
          aria-current={view === t.key ? "page" : undefined}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            view === t.key
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
