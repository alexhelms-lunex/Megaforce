"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { Button } from "@/components/ui/button";
import { claim, release } from "./actions";

/**
 * Claim and release.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE BUTTONS AND NOT FORMS
 *
 * Both were <form action={...}> with a hidden input. That is the idiomatic
 * shape and it was the wrong one here, for a reason that only bites in place:
 * HTML forbids a form inside a form, so wherever one of these landed inside
 * another form the browser's parser silently discarded the inner <form> and
 * left the submit button wired to the OUTER one. Pressing Claim then submitted
 * whatever form it happened to be sitting in. Nothing errored; the button
 * simply did something else.
 *
 * A button calling the server action directly cannot be nested wrongly, works
 * identically inside a table cell, a card header or a dock, and loses nothing
 * -- there was no progressive-enhancement story here anyway, since both of
 * these live behind a login on a JavaScript-rendered screen.
 *
 * The refusal path matters as much as the success path. When somebody else got
 * there first the toast names them, because "could not claim" invites a second
 * click and a support message, while "Dana Whitfield claimed this one first"
 * ends the matter.
 * ---------------------------------------------------------------------------
 */
/*
 * Both buttons take a className, because one of the places they appear is not
 * a page background.
 *
 * The account header is a dark blue gradient, and the default button variants
 * are drawn for a light surface -- so Release rendered there as a near-white
 * slab with white text on it, which read as a rendering fault rather than a
 * button. It sits beside a hand-styled Edit pill, and the fix is for the three
 * of them to agree.
 */
export function ClaimButton({
  accountId,
  size = "sm",
  onClaimed,
  className,
}: {
  accountId: string;
  size?: "sm" | "default";
  onClaimed?: () => void;
  className?: string;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();

  function run() {
    start(async () => {
      const form = new FormData();
      form.set("accountId", accountId);
      // runAction rather than a local try/catch. The local one caught the
      // rejection correctly and then showed Next's redacted message verbatim,
      // which is how "Claim failed: An error occurred in the Server Components
      // render" ended up in front of a broker. runAction goes and fetches what
      // actually happened.
      const result = await runAction(() => claim(form), {
        label: "Claim failed",
        success: "Claimed. The clock starts now.",
      });
      if (!result) return;
      onClaimed?.();
      router.refresh();
    });
  }

  return (
    <Button type="button" size={size} onClick={run} disabled={pending} className={className}>
      {pending ? "Claiming…" : "Claim"}
    </Button>
  );
}

export function ReleaseButton({
  accountId,
  className,
}: {
  accountId: string;
  className?: string;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();

  function run() {
    start(async () => {
      const form = new FormData();
      form.set("accountId", accountId);
      const result = await runAction(() => release(form), {
        label: "Release failed",
        success: "Released. It is back in the available pool.",
      });
      if (result) router.refresh();
    });
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={run}
      disabled={pending}
      className={className}
    >
      {pending ? "Releasing…" : "Release"}
    </Button>
  );
}
