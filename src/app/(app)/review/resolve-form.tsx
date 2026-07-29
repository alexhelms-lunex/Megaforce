"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { resolveQueueItem } from "./actions";

export interface AccountOption {
  id: string;
  name: string;
}

/**
 * The resolve control.
 *
 * For an ambiguous call the choices are exactly the accounts that matched, so
 * the reviewer is confirming rather than searching. For an unmatched number
 * there is nothing to narrow by, so the full visible list is offered.
 */
export function ResolveForm({
  unmatchedId,
  options,
}: {
  unmatchedId: string;
  options: AccountOption[];
}) {
  const [accountId, setAccountId] = useState(options[0]?.id ?? "");
  const [pending, startTransition] = useTransition();

  if (options.length === 0) {
    return <p className="text-xs text-muted-foreground">No account available to attach to.</p>;
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      action={(formData) => {
        startTransition(async () => {
          const result = await resolveQueueItem(formData);
          if (result?.error) toast.error(result.error);
          else toast.success("Attached, and the call is now on the account's timeline.");
        });
      }}
    >
      <input type="hidden" name="unmatchedId" value={unmatchedId} />
      <select
        name="accountId"
        value={accountId}
        onChange={(e) => setAccountId(e.target.value)}
        className="h-9 max-w-xs rounded-md border bg-transparent px-3 text-sm"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Attaching…" : "Attach to account"}
      </Button>
    </form>
  );
}
