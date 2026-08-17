"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { Button } from "@/components/ui/button";
import { decideRequest, withdrawRequest } from "./actions";

/**
 * Approve, deny, or withdraw.
 *
 * Denying opens a note field first. An approval explains itself; a refusal does
 * not, and a rep who loses an account to a bare "denied" will ask their manager
 * in person anyway — so the note is collected here rather than in that
 * conversation.
 */
export function DecideButtons({ requestId }: { requestId: string }) {
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  function send(decision: "approve" | "deny") {
    const form = new FormData();
    form.set("requestId", requestId);
    form.set("decision", decision);
    form.set("note", note);
    start(async () => {
      const result = await runAction(() => decideRequest(form), {
        label: "Could not record that decision",
        success: decision === "approve" ? "Approved." : "Denied.",
      });
      if (!result) return;
      setDenying(false);
      setNote("");
      router.refresh();
    });
  }

  if (denying) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          autoFocus
          placeholder="Why not?"
          className="h-8 min-w-48 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus:border-ring"
        />
        <Button size="sm" variant="destructive" disabled={pending} onClick={() => send("deny")}>
          {pending ? "Saving…" : "Confirm deny"}
        </Button>
        <button
          onClick={() => setDenying(false)}
          className="text-xs text-muted-foreground hover:underline"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="brand" disabled={pending} onClick={() => send("approve")}>
        {pending ? "Saving…" : "Approve"}
      </Button>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => setDenying(true)}>
        Deny
      </Button>
    </div>
  );
}

export function WithdrawButton({ requestId }: { requestId: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const form = new FormData();
          form.set("requestId", requestId);
          const result = await runAction(() => withdrawRequest(form), {
            label: "Could not withdraw it",
            success: "Withdrawn.",
          });
          if (result) router.refresh();
        })
      }
    >
      {pending ? "…" : "Withdraw"}
    </Button>
  );
}
