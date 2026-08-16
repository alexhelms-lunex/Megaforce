"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { claim, release } from "./actions";

/**
 * Claim and release.
 *
 * The refusal path matters as much as the success path. When somebody else got
 * there first the toast names them, because "could not claim" invites a second
 * click and a support message, while "Dana Whitfield claimed this one first"
 * ends the matter.
 */
export function ClaimButton({ accountId, size = "sm" }: { accountId: string; size?: "sm" | "default" }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <form
      action={(formData) =>
        start(async () => {
          const result = await claim(formData);
          if (result?.error) toast.error(result.error);
          else {
            toast.success("Claimed. The clock starts now.");
            router.refresh();
          }
        })
      }
    >
      <input type="hidden" name="accountId" value={accountId} />
      <Button type="submit" size={size} disabled={pending}>
        {pending ? "Claiming…" : "Claim"}
      </Button>
    </form>
  );
}

export function ReleaseButton({ accountId }: { accountId: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <form
      action={(formData) =>
        start(async () => {
          const result = await release(formData);
          if (result?.error) toast.error(result.error);
          else {
            toast.success("Released. It is back in the available pool.");
            router.refresh();
          }
        })
      }
    >
      <input type="hidden" name="accountId" value={accountId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Releasing…" : "Release"}
      </Button>
    </form>
  );
}
