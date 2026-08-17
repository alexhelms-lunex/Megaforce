/**
 * Colour for the activity feed.
 *
 * ---------------------------------------------------------------------------
 * The feed was one grey column. Every row -- a call, an email, a note -- looked
 * identical until it was read, and the two facts that actually matter were the
 * hardest to find:
 *
 *   Did it COUNT? An approved activity is the only thing that holds the clock.
 *     A feed of thirty rows where four counted looks, in grey, like a feed of
 *     thirty rows.
 *
 *   Is it WAITING on you? An unwritten call is not an approved activity, so the
 *     account is still running down while its own history says otherwise.
 *
 * So type is colour-coded to make the feed scannable, and status is colour
 * coded to make those two facts findable without reading.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL. Every badge here carries words as well --
 * roughly one man in twelve cannot separate the reds from the greens, and this
 * feed decides whose commission survives the month.
 * ---------------------------------------------------------------------------
 */

export interface Tone {
  /** The round icon behind the type glyph. */
  icon: string;
  /** A small pill naming the type. */
  chip: string;
  label: string;
}

/**
 * One hue per kind of contact, chosen to stay apart at chip size in both
 * themes rather than to be pretty in a palette.
 */
export const ACTIVITY_TONE: Record<string, Tone> = {
  call: {
    icon: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
    chip: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-300",
    label: "Call",
  },
  email: {
    icon: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
    chip: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-300",
    label: "Email",
  },
  meeting: {
    icon: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
    chip: "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-300",
    label: "Meeting",
  },
  note: {
    icon: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    chip: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300",
    label: "Note",
  },
};

const UNKNOWN: Tone = {
  icon: "bg-muted text-muted-foreground",
  chip: "border-border bg-muted text-muted-foreground",
  label: "Other",
};

export function activityTone(type: string | null | undefined): Tone {
  return ACTIVITY_TONE[type ?? ""] ?? { ...UNKNOWN, label: type ?? "Other" };
}

/**
 * Whether it held the clock.
 *
 * Green for counted, and deliberately quiet for the rest: "did not count" is
 * the ordinary case, not a fault, and colouring every ordinary row red would
 * make the feed unreadable and the real warnings invisible.
 */
export function countedTone(qualifies: boolean): string {
  return qualifies
    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300"
    : "border-border bg-muted/60 text-muted-foreground";
}

/**
 * A call captured but never written up.
 *
 * Amber rather than red. It is not an error -- it is work outstanding, and the
 * person who has to do it is the person reading. Red is reserved for the flag
 * that says an account is about to be lost.
 */
export const NEEDS_WRITE_UP =
  "border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200";

/** Direction of a call, so inbound and outbound are separable at a glance. */
export function directionTone(direction: string | null | undefined): string | null {
  if (direction === "inbound") {
    return "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-300";
  }
  if (direction === "outbound") {
    return "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300";
  }
  return null;
}
