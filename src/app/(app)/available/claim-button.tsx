"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
export function ClaimButton({
  accountId,
  size = "sm",
  onClaimed,
}: {
  accountId: string;
  size?: "sm" | "default";
  onClaimed?: () => void;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();

  function run() {
    start(async () => {
      try {
        const form = new FormData();
        form.set("accountId", accountId);
        const result = await claim(form);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        toast.success("Claimed. The clock starts now.");
        onClaimed?.();
        router.refresh();
      } catch (err) {
        // A server action that throws rejects the promise here. Without this
        // the click produces no toast, no navigation and no error -- which is
        // indistinguishable from a button that is not wired up at all.
        toast.error(
          err instanceof Error
            ? `Claim failed: ${err.message}`
            : "Claim failed. Try again, or check the Admin screen.",
        );
      }
    });
  }

  return (
    <Button type="button" size={size} onClick={run} disabled={pending}>
      {pending ? "Claiming…" : "Claim"}
    </Button>
  );
}

export function ReleaseButton({ accountId }: { accountId: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  function run() {
    start(async () => {
      try {
        const form = new FormData();
        form.set("accountId", accountId);
        const result = await release(form);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        toast.success("Released. It is back in the available pool.");
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error
            ? `Release failed: ${err.message}`
            : "Release failed. Try again, or check the Admin screen.",
        );
      }
    });
  }

  return (
    <Button type="button" size="sm" variant="outline" onClick={run} disabled={pending}>
      {pending ? "Releasing…" : "Release"}
    </Button>
  );
}
