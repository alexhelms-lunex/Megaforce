"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createRequest, type RequestResult } from "@/app/(app)/requests/actions";
import { REQUEST_KINDS } from "@/lib/request-kinds";

/**
 * Ask to keep an account.
 *
 * Lives on the company page rather than on the requests screen, because the
 * moment somebody wants amnesty is the moment they are looking at the clock
 * running out — not later, from a menu two levels away.
 */
export function RequestForm({
  accountId,
  accountStatus,
  colleagues,
}: {
  accountId: string;
  accountStatus: string;
  colleagues: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>(accountStatus === "customer" ? "extension" : "amnesty");
  const [state, formAction, pending] = useActionState(createRequest, {} as RequestResult);
  const router = useRouter();

  useEffect(() => {
    if (state.ok) {
      toast.success("Request raised. Your manager sees it on the Account requests screen.");
      setOpen(false);
      router.refresh();
    }
  }, [state.ok, router]);

  const spec = REQUEST_KINDS.find((k) => k.value === kind);

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ShieldCheck className="size-3.5" aria-hidden />
        Request
      </Button>
    );
  }

  return (
    <form action={formAction} className="w-full space-y-3 rounded-lg border bg-card p-4">
      <input type="hidden" name="accountId" value={accountId} />

      <div className="space-y-1.5">
        <Label className="text-xs">What are you asking for?</Label>
        <select
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
        >
          {REQUEST_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        {spec ? <p className="text-xs text-muted-foreground">{spec.help}</p> : null}
      </div>

      {spec?.needsDays ? (
        <div className="space-y-1.5">
          <Label className="text-xs">How many days?</Label>
          <input
            name="days"
            type="number"
            min={1}
            max={365}
            defaultValue={30}
            className="h-9 w-32 rounded-md border bg-background px-2 text-sm tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            Maximum 365. The policy caps any single hold at a year without a Sales Director.
          </p>
        </div>
      ) : null}

      {spec?.needsTarget ? (
        <div className="space-y-1.5">
          <Label className="text-xs">Transfer to</Label>
          <select
            name="transferTo"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            defaultValue=""
          >
            <option value="">Select…</option>
            {colleagues.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label className="text-xs">
          Why <span className="text-destructive">*</span>
        </Label>
        <Textarea
          name="reason"
          rows={3}
          required
          placeholder="What is happening on this account that justifies it."
        />
        <p className="text-xs text-muted-foreground">
          Whoever approves this has to justify it too. Give them something to work with.
        </p>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Sending…" : "Send request"}
        </Button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-muted-foreground hover:underline"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
