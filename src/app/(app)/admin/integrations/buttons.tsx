"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runAction } from "@/lib/run-action";
import {
  claimExtension,
  clearTestCalls,
  setCallBackNumber,
  loadExtensions,
  pullCallsNow,
  renewNow,
  sendTestCall,
  sweepNow,
  testConnection,
  type ActionResult,
  type ExtensionsResult,
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

  /*
   * Deliberately NOT runAction.
   *
   * runAction returns null both when an action REFUSES and when it REJECTS,
   * reporting the reason as a toast either way. That is right for a Save button
   * and wrong for a diagnostic: the reason IS the output of these buttons, and
   * a toast that fades after four seconds is not where somebody reads an error
   * they are about to act on.
   *
   * It also produced a sentence that was not true. A refusal came back as null,
   * this panel could not tell that apart from "never reached the server", and
   * printed the latter -- over the top of a toast carrying the real cause.
   * Somebody diagnosing a failed subscription was told the wrong thing.
   *
   * So the action is called directly and its answer goes on the screen, where
   * it stays until the next press.
   */
  function run(action: () => Promise<ActionResult>, label: string) {
    setReply(null);
    start(async () => {
      try {
        setReply(await action());
      } catch (err) {
        // A rejection rather than a refusal. Uncaught inside a transition this
        // destroys the page, so it is caught and shown like everything else.
        setReply({ error: `${label}: ${describe(err)}` });
      }
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
        {/*
          The one that works before anything else does.
          Delivery only carries calls made while a subscription is alive and
          pointing here, so on day one it carries nothing. This asks RingCentral
          for the calls it already has, which is how somebody sees a call they
          made an hour ago rather than being told to make another one.
        */}
        <Button
          variant="outline"
          size="sm"
          disabled={pending || !configured}
          title={
            configured
              ? "Asks RingCentral for the last 48 hours, including calls made while this was closed."
              : "Add the credentials first."
          }
          onClick={() => run(pullCallsNow, "Could not read the call log")}
        >
          Load recent calls now
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

  /*
   * Deliberately NOT runAction.
   *
   * runAction returns null both when an action REFUSES and when it REJECTS,
   * reporting the reason as a toast either way. That is right for a Save button
   * and wrong for a diagnostic: the reason IS the output of these buttons, and
   * a toast that fades after four seconds is not where somebody reads an error
   * they are about to act on.
   *
   * It also produced a sentence that was not true. A refusal came back as null,
   * this panel could not tell that apart from "never reached the server", and
   * printed the latter -- over the top of a toast carrying the real cause.
   * Somebody diagnosing a failed subscription was told the wrong thing.
   *
   * So the action is called directly and its answer goes on the screen, where
   * it stays until the next press.
   */
  function run(action: () => Promise<ActionResult>, label: string) {
    setReply(null);
    start(async () => {
      try {
        setReply(await action());
      } catch (err) {
        // A rejection rather than a refusal. Uncaught inside a transition this
        // destroys the page, so it is caught and shown like everything else.
        setReply({ error: `${label}: ${describe(err)}` });
      }
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

/**
 * Who can make calls, and whether the CRM would know it was them.
 *
 * ---------------------------------------------------------------------------
 * Answers the question everybody asks first -- "what number do I call to test
 * this" -- and the one that matters at rollout: which extensions the CRM does
 * not yet recognise. An unrecognised extension is not an error anywhere; the
 * call simply gets credited to whoever owns the account, which looks correct
 * and is not.
 *
 * Loaded on a button press rather than with the page. It is two round trips to
 * RingCentral, and most visits to this screen are not about extensions.
 * ---------------------------------------------------------------------------
 */
export function ExtensionList() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ExtensionsResult | null>(null);

  const reload = () =>
    start(async () => {
      const answer = await runAction(loadExtensions, {
        label: "Could not read the extensions",
        quiet: true,
      });
      setResult(answer ?? { error: "That did not reach the server." });
    });

  return (
    <div className="space-y-3">
      <Button variant="outline" size="sm" disabled={pending} onClick={reload}>
        {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
        {result ? "Refresh" : "Show me the numbers and extensions"}
      </Button>

      {result?.error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {result.error}
        </p>
      ) : null}

      {result?.ok ? (
        <div className="space-y-4">
          {result.numbers && result.numbers.length > 0 ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Numbers on this account
              </p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {result.numbers.map((n) => (
                  <li key={n.phoneNumber} className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono">{n.phoneNumber}</span>
                    <span className="text-xs text-muted-foreground">
                      {n.usageType ?? "number"}
                      {n.extensionNumber ? ` · rings extension ${n.extensionNumber}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              People with an extension
            </p>
            {result.extensions && result.extensions.length > 0 ? (
              <div className="mt-1 overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Ext</th>
                      <th className="px-3 py-2 font-medium">Name in RingCentral</th>
                      <th className="px-3 py-2 font-medium">Recognised by the CRM?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.extensions.map((e) => (
                      <tr key={e.extensionNumber} className="border-b last:border-b-0">
                        <td className="px-3 py-2 font-mono">{e.extensionNumber}</td>
                        <td className="px-3 py-2">
                          {e.name}
                          {e.email ? (
                            <span className="block text-xs text-muted-foreground">{e.email}</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          {/*
                            Always editable, including when it already matches.
                            A wrong mapping is worse than a missing one and it is
                            the one the screen used to refuse to fix: the demo
                            data ships with extension 101 on a seeded user, so a
                            real person's calls were credited to somebody who
                            does not exist, the row read a confident green "Yes",
                            and there was no control anywhere to correct it.
                          */}
                          <AttachExtension
                            extension={e.extensionNumber}
                            people={result.people ?? []}
                            suggested={e.suggestedUser}
                            matched={e.matchedUser}
                            matchedId={e.matchedUserId}
                            ringCentralName={e.name}
                            callBackNumber={e.callBackNumber}
                            onDone={reload}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                No user extensions on this account. Nothing can make a call that would reach here.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}


/**
 * Put an extension on a person, from the row that shows it is missing.
 *
 * ---------------------------------------------------------------------------
 * Pre-selected to the suggested match when there is one -- somebody with the
 * same email address and no extension yet -- but never applied on its own. An
 * email address is a good guess, not a fact, and putting the wrong extension on
 * somebody credits their colleague's calls to them from that moment on. One
 * click to accept a guess is quick; a guess applied silently is a data problem
 * discovered in a commission meeting.
 * ---------------------------------------------------------------------------
 */
function AttachExtension({
  extension,
  people,
  suggested,
  matched,
  matchedId,
  ringCentralName,
  callBackNumber,
  onDone,
}: {
  extension: string;
  people: { id: string; name: string }[];
  suggested: { id: string; name: string } | null;
  matched: string | null;
  matchedId: string | null;
  ringCentralName: string;
  callBackNumber: string | null;
  onDone: () => void;
}) {
  const [who, setWho] = useState(matchedId ?? suggested?.id ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  /*
   * The check nobody thinks to make, and the one that caught this.
   *
   * RingCentral knows the handset belongs to Alex Helmsworth. The CRM had it
   * recorded against Leta Schimmel, because the demo seed hands extension 101
   * to a fictional broker. Every real call was filed against a person who does
   * not exist -- and the screen said "Yes", in green, because a mapping existed.
   *
   * Comparing the two names is what turns a confident wrong answer into a
   * visible question. Loose comparison on purpose: "Alex Helmsworth" and "Alex
   * Helmsworth (Sales)" are the same person and a strict match would cry wolf on
   * half the floor.
   */
  const looksWrong =
    Boolean(matched) && !sameName(matched as string, ringCentralName);
  const changed = who !== (matchedId ?? "");

  return (
    <div className="space-y-1.5">
      {matched ? (
        <p className={looksWrong ? "text-amber-700 dark:text-amber-300" : "text-brand-600"}>
          {looksWrong ? `Recorded as ${matched} — RingCentral says ${ringCentralName}` : `Yes — ${matched}`}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={who}
          onChange={(event) => setWho(event.target.value)}
          className="h-8 max-w-[14rem] rounded-md border bg-transparent px-2 text-xs"
          aria-label={`Who uses extension ${extension}`}
        >
          <option value="">Nobody — pick a person</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant={looksWrong ? "default" : "outline"}
          className="h-8"
          disabled={pending || !who || !changed}
          onClick={() =>
            start(async () => {
              setError(null);
              try {
                const answer = await claimExtension(who, extension);
                if (answer.error) setError(answer.error);
                else onDone();
              } catch (err) {
                setError(describe(err));
              }
            })
          }
        >
          {pending ? "Attaching…" : matched ? "Move it" : "Attach"}
        </Button>
      </div>

      {looksWrong ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Calls from {extension} are being credited to {matched}. Move it and every call it has
          already produced moves with it.
        </p>
      ) : suggested && who === suggested.id && !matched ? (
        <p className="text-xs text-muted-foreground">
          Suggested — same email address, and no extension on them yet.
        </p>
      ) : !matched && !suggested ? (
        <p className="text-xs text-muted-foreground">
          Nobody obvious to match. Until this is set, calls from {extension} are credited to
          whoever owns the account.
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {/* Only once somebody actually holds the extension -- a call-back number
          with nobody to ring is a field that cannot mean anything yet. */}
      {matchedId ? (
        <CallBackNumber userId={matchedId} current={callBackNumber} onDone={onDone} />
      ) : null}
    </div>
  );
}

/**
 * The handset that rings when this person presses Call.
 *
 * ---------------------------------------------------------------------------
 * Click-to-call rings YOU first and dials the customer once you answer. Without
 * this it rings the extension's own RingCentral number, which routes back into
 * RingCentral and reaches whatever device that extension is registered to --
 * frequently a desk phone nobody has. The call then rings out in a few seconds
 * and the broker's phone never makes a sound, which reads as a broken dialler.
 *
 * A mobile is the number that is actually in somebody's pocket.
 * ---------------------------------------------------------------------------
 */
function CallBackNumber({
  userId,
  current,
  onDone,
}: {
  userId: string;
  current: string | null;
  onDone: () => void;
}) {
  const [value, setValue] = useState(current ?? "");
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="space-y-1 border-t pt-2">
      <label className="text-xs text-muted-foreground">
        Ring this number when they click to call
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Their mobile, e.g. (323) 555-0142"
          className="h-8 w-52 rounded-md border bg-transparent px-2 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={pending || value.trim() === (current ?? "")}
          onClick={() =>
            start(async () => {
              setNote(null);
              try {
                const answer = await setCallBackNumber(userId, value);
                setNote(answer.error ?? answer.message ?? null);
                if (!answer.error) onDone();
              } catch (err) {
                setNote(describe(err));
              }
            })
          }
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {current
          ? "Leave it empty and save to go back to the extension's own number."
          : "Empty means the extension's own RingCentral number, which may not ring any device."}
      </p>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/** Same person, allowing for titles, middle names and how RingCentral spells it. */
function sameName(a: string, b: string): boolean {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return true;
  // One word in common is not enough -- half the floor shares a first name.
  let shared = 0;
  for (const w of left) if (right.has(w)) shared += 1;
  return shared >= Math.min(2, Math.min(left.size, right.size));
}

/**
 * The whole chain of causes, not just the outermost one.
 *
 * A failed subscription wraps a fetch failure wraps a DNS error, and only the
 * innermost one says anything useful. Next also redacts server errors in
 * production, so the outermost is frequently a sentence about nothing.
 */
function describe(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = current as { message?: string; cause?: unknown };
    if (e?.message && !parts.includes(e.message)) parts.push(e.message);
    current = e?.cause;
  }
  return parts.join(" — ") || String(err);
}
