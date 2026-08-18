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
  /*
   * Starts as null, deliberately, and that is the whole fix.
   *
   * ---------------------------------------------------------------------------
   * This used to seed the state with greetingFor(new Date()) and then set the
   * same value again in the effect. It looked correct and it did nothing.
   *
   * suppressHydrationWarning does more than silence a warning: it tells React to
   * KEEP THE SERVER'S HTML where the two disagree. The server, running in UTC,
   * had written "Good evening". The client's initialiser computed "Good
   * afternoon" -- correctly -- but the DOM kept the server's text. Then the
   * effect called setText with the value the state already held, React compared
   * them, found them equal, and skipped the re-render. Nothing ever replaced the
   * wrong word. Half past four in the afternoon, and the screen said evening.
   *
   * Starting at null guarantees the effect CHANGES the state, which guarantees a
   * re-render, which is what actually replaces the server's text. The fallback
   * below is only ever on screen for the frame before hydration.
   * ---------------------------------------------------------------------------
   */
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const update = () => setText(greetingFor(new Date()));
    update();
    const id = window.setInterval(update, 60_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span suppressHydrationWarning>{`${text ?? greetingFor(new Date())}, ${name}`}</span>
  );
}
