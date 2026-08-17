"use client";

import { useLinkStatus } from "next/link";
import { Loader2 } from "lucide-react";

/**
 * A spinner on the nav item you just clicked.
 *
 * ---------------------------------------------------------------------------
 * The loading boundaries do most of the work -- the page frame now changes the
 * instant a link is clicked. This covers the gap before that: the moment
 * between the click and the first byte of the new route, during which the old
 * page is still fully drawn and nothing anywhere says that anything is
 * happening.
 *
 * That gap is short on a fast connection and long on a phone in a warehouse,
 * and it is the entire reason people click a nav link twice. Marking the item
 * they clicked costs nothing and answers the only question they have.
 *
 * useLinkStatus has to be called from a component INSIDE the <Link> it reports
 * on -- it reads the pending state off the Link's own context, so hoisting this
 * up a level makes it silently always false rather than an error.
 * ---------------------------------------------------------------------------
 */
export function NavPending({ className = "" }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <Loader2
      className={`size-3.5 shrink-0 animate-spin ${className}`}
      aria-label="Loading"
      role="status"
    />
  );
}
