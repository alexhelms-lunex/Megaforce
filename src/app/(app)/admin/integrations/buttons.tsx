"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runAction } from "@/lib/run-action";
import {
  clearTestCalls,
  renewNow,
  sendTestCall,
  sweepNow,
  testConnection,
  type ActionResult,
} from "./actions";

/**
 * The three buttons on the status screen.
 *
 * ---------------------------------------------------------------------------
 * The answer is shown INLINE, under the buttons, not only as a toast. A toast
 * is right for "saved"; it is wrong for a diagnostic. Somebody pressing Test
 * connection is about to read the reply carefully, possibly copy it, and
 * compare it against what they typed into RingCentral ten minutes ago -- and a
 * message that disappears after four seconds makes them press the button again
 * to read the end of the sentence.
 *
 * The failures are the whole point of the screen, so they are kept until the
 * next press rather than cleared on a timer.
 * ---------------------------------------------------------------------------
 */
export function IntegrationButtons({ configured }: { configured: boolean }) {
  const [pending, start] = useTransition();
  const [reply, setReply] = useState<ActionResult | null>(null);
  const router = useRouter();

  function run(action: () => Promise<ActionResult>, label: string) {
    setReply(null);
    start(async () => {
      const result = await runAction(action, { label, quiet: true });
      // runAction returns null when the action itself failed to reach the
      // server, which it has already reported. Anything else is an answer.
      setReply(result ?? { error: `${label} did not reach the server.` });
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => run(testConnection, "Could not test the connection")}
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          Test the connection
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pending || !configured}
          title={configured ? undefined : "Add the credentials first."}
          onClick={() => run(renewNow, "Could not renew the subscription")}
        >
          Start or renew call delivery
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => run(sweepNow, "Could not run the sweep")}
        >
          File anything waiting
        </Button>
      </div>

      {reply ? (
        <p
          role="status"
          className={`rounded-lg border px-3 py-2 text-sm ${
            reply.error
              ? "border-destructive/40 bg-destructive/5 text-destructive"
              : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200"
          }`}
        >
          {reply.error ?? reply.message}{" "}
          {reply.href ? (
            <Link href={reply.href} className="font-medium underline">
              Go and look →
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Calls, without a phone system.
 *
 * ---------------------------------------------------------------------------
 * Separate from the buttons above because it answers a different question. The
 * three above ask "is RingCentral connected"; these ask "does the CRM do the
 * right thing with a call", and that question has an answer today, before
 * anybody has signed up for anything.
 *
 * The three kinds are the three outcomes that exist, and the middle one is the
 * point of the whole design: a call the phone system saw, which does NOT count
 * until a person writes it up.
 * ---------------------------------------------------------------------------
 */
export function TestCallButtons() {
  const [pending, start] = useTransition();
  const [reply, setReply] = useState<ActionResult | null>(null);
  const router = useRouter();

  function run(action: () => Promise<ActionResult>, label: string) {
    setReply(null);
    start(async () => {
      const result = await runAction(action, { label, quiet: true });
      setReply(result ?? { error: `${label} did not reach the server.` });
      router.refresh();
    });
  }

  const kinds = [
    {
      key: "connected" as const,
      label: "A real conversation",
      hint: "3m 34s, answered. Lands on an account NOT counting, because nobody has written it up yet.",
    },
    {
      key: "brief" as const,
      label: "Too short to count",
      hint: "25 seconds. Can never count, however carefully it is written up.",
    },
    {
      key: "unknown" as const,
      label: "A number nobody knows",
      hint: "Matches no contact on file, so it goes to the review queue rather than being dropped.",
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {kinds.map((k) => (
          <Button
            key={k.key}
            variant="outline"
            size="sm"
            disabled={pending}
            title={k.hint}
            onClick={() => run(() => sendTestCall(k.key), "Could not send the test call")}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {k.label}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => run(clearTestCalls, "Could not clear the test calls")}
        >
          Remove them all
        </Button>
      </div>

      {reply ? (
        <p
          role="status"
          className={`rounded-lg border px-3 py-2 text-sm ${
            reply.error
              ? "border-destructive/40 bg-destructive/5 text-destructive"
              : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200"
          }`}
        >
          {reply.error ?? reply.message}{" "}
          {reply.href ? (
            <Link href={reply.href} className="font-medium underline">
              Go and look →
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
