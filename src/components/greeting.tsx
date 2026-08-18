"use client";

import { useEffect, useState } from "react";
import { greetingFor } from "@/lib/greeting";

/**
 * The greeting, on the reader's clock rather than the server's.
 *
 * ===========================================================================
 * WHY THIS IS A CLIENT COMPONENT
 *
 * A dashboard is a server component, so `new Date()` in it is the SERVER's
 * clock -- and on Vercel that is UTC. Alex, in California, opened the CRM at
 * ten past eleven in the morning and was told good evening, because it was
 * ten past six in the evening in Greenwich.
 *
 * Fixing the boundaries without fixing the clock would have left it wrong by
 * seven or eight hours and looked, from the code, entirely correct.
 *
 * Reading the browser's clock is also the only answer that stays right with
 * people in more than one time zone. A configured company timezone would be one
 * more thing to set, one more thing to forget, and still wrong for the branch
 * that is not in it.
 *
 * The server renders its own best guess first and the browser corrects it on
 * mount, which is why suppressHydrationWarning is here: the two genuinely
 * differ, deliberately, and that is not a bug to be warned about.
 *
 * It re-checks every minute, so a dashboard left open across half past five
 * changes its mind rather than saying good afternoon until midnight.
 * ===========================================================================
 */
export function Greeting({ name }: { name: string }) {
  const [text, setText] = useState(() => greetingFor(new Date()));

  useEffect(() => {
    const update = () => setText(greetingFor(new Date()));
    update();
    const id = window.setInterval(update, 60_000);
    return () => window.clearInterval(id);
  }, []);

  return <span suppressHydrationWarning>{`${text}, ${name}`}</span>;
}
