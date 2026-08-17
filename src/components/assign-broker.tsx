"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { runAction } from "@/lib/run-action";
import { assignBroker } from "@/app/(app)/accounts/assign-actions";

/**
 * Putting a broker on an account an Account Director opened.
 *
 * ---------------------------------------------------------------------------
 * Alex: "if an account is owned by an AD a manager will have to add the broker
 * to assign them."
 *
 * Deliberately not offered on an ordinary broker's account, and not merely
 * hidden there -- the database refuses it too. Taking an account off its holder
 * stays a transfer request, decided by somebody other than the person who wants
 * it moved, and a manager who could do it with a dropdown would have made that
 * process optional.
 *
 * The wording says "add" rather than "reassign" on purpose. The AD keeps the
 * account; the broker joins it. That is what co-ownership means here, and a
 * control labelled "reassign" would make an AD think they were losing it.
 * ---------------------------------------------------------------------------
 */
export function AssignBroker({
  accountId,
  colleagues,
  holderName,
}: {
  accountId: string;
  colleagues: { id: string; name: string }[];
  holderName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [broker, setBroker] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  if (colleagues.length === 0) return null;

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="size-3.5" aria-hidden />
        Add a broker
      </Button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-xl border border-border/60 bg-muted/30 p-3">
      <Label className="text-xs" htmlFor="assign-broker">
        Who runs this account day to day?
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id="assign-broker"
          value={broker}
          onChange={(e) => setBroker(e.target.value)}
          className="h-9 min-w-56 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Select somebody…</option>
          {colleagues.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={!broker || pending}
          onClick={() =>
            start(async () => {
              const result = await runAction(() => assignBroker(accountId, broker), {
                label: "Could not assign them",
                quiet: true,
              });
              if (result) {
                setOpen(false);
                router.refresh();
              }
            })
          }
        >
          {pending ? "Assigning…" : "Add them"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {holderName ? `${holderName} stays on the account` : "The account director stays on it"} as
        account director. The clock starts on the broker, because they are the one working it.
      </p>
    </div>
  );
}
