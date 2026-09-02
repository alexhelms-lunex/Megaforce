"use client";

import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/format";

/**
 * A timestamp, in the reader's own timezone.
 *
 * ===========================================================================
 * WHY EVERY DATE IN THIS APPLICATION WAS WRONG
 *
 * Alex: "It says I made a call today a couple hours in the future."
 *
 * It did. formatDateTime calls toLocaleString, which formats in the timezone of
 * whatever is RUNNING it -- and a server component runs on Vercel, in UTC. So a
 * call he made at 2:36 in the afternoon in California was rendered "9:36 PM".
 * Seven hours ahead, on every screen, on every date in the product: activity
 * feeds, the review queue, account requests, the call list.
 *
 * It looks like corrupted data. It is not: the stored instant is correct and
 * always was, and every calculation on top of it -- the clock, expiry, the
 * counts -- has been right the whole time. Only the rendering was in the wrong
 * timezone, and that is much worse than it sounds, because a person cannot tell
 * those two apart by looking, and "the app has invented a call in the future"
 * is a reason to stop trusting everything it says.
 *
 * Same trap as the greeting, one layer down. That one showed the wrong word
 * once; this one shows the wrong time everywhere.
 *
 * HOW
 *
 * The browser knows where it is; the server does not and should not guess.
 * So the server renders its best effort and the browser replaces it on mount --
 * which is the one frame where the two differ, and why suppressHydrationWarning
 * is here.
 *
 * The state starts as null on purpose, and that is not a style choice: seeding
 * it with the formatted value makes the effect a no-op, React skips the
 * re-render, and the server's text stays on screen forever. That precise
 * mistake is what made the greeting fix do nothing the first time.
 * ===========================================================================
 */
export function LocalTime({ iso }: { iso: string | null | undefined }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    setText(formatDateTime(iso));
  }, [iso]);

  return <span suppressHydrationWarning>{text ?? formatDateTime(iso)}</span>;
}
