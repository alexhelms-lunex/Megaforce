"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createContact } from "@/app/(app)/accounts/actions";
import type { FormState } from "@/app/(app)/accounts/actions";

/**
 * Add a contact.
 *
 * The phone field carries a note about why the format does not matter, because
 * the alternative -- silence -- leaves people typing carefully for no reason,
 * or worse, not typing a number at all. Whatever they enter is normalized on
 * save so the call matcher can find it.
 */
export function ContactForm({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createContact, {} as FormState);
  const formRef = useRef<HTMLFormElement>(null);
  const succeeded = useRef(false);

  useEffect(() => {
    // A returned state with neither an error nor field errors means it saved.
    if (pending) {
      succeeded.current = true;
      return;
    }
    if (succeeded.current && !state.error && !state.fieldErrors) {
      succeeded.current = false;
      formRef.current?.reset();
      setOpen(false);
      toast.success("Contact added. Their calls will match from now on.");
    }
  }, [pending, state]);

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Add contact
      </Button>
    );
  }

  return (
    <form ref={formRef} action={formAction} className="space-y-4 rounded-lg border p-4">
      <input type="hidden" name="accountId" value={accountId} />

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="firstName">First name</Label>
          <Input id="firstName" name="firstName" required autoFocus />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lastName">Last name</Label>
          <Input id="lastName" name="lastName" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="title">Title</Label>
          <Input id="title" name="title" placeholder="Logistics Manager" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" name="phone" placeholder="(704) 555-0142 ext. 210" />
          <p className="text-xs text-muted-foreground">
            Any format. Extensions are fine — it is stored in one canonical form so
            inbound calls match.
          </p>
          {state.fieldErrors?.phone ? (
            <p className="text-xs text-destructive">{state.fieldErrors.phone}</p>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Add contact"}
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
