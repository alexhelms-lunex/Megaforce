"use client";

import { useActionState, useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { runAction } from "@/lib/run-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  logCall,
  matchOptions,
  placeCall,
  attachCall,
  dockHealth,
  liveCalls,
  recentCalls,
  searchCompanies,
  syncRecentCalls,
  type DockCall,
  type DockHealth,
  type LiveCall,
  type LogResult,
  type MatchOptions,
} from "./actions";
import { STAGES } from "./stages";

/** How many calls the list starts with, and how many each "show more" adds. */
const PAGE = 40;
const MAX_PAGE = 400;

/**
 * The RingCentral dock.
 *
 * Anchored bottom-left and present on every screen, matching where it sits in
 * Salesforce today. That position is not decoration: a broker is on a call
 * while looking at an account, and a phone that lives on its own page is a
 * phone nobody uses.
 *
 * Collapsed it is a single tab with a count of calls still to write up. That
 * count is the whole point of the dock — an unlogged call is not an approved
 * activity, so every number on that badge is an account quietly running down
 * its clock.
 */
export function RcDock() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"calls" | "dialer">("calls");
  const [calls, setCalls] = useState<DockCall[]>([]);
  const [live, setLive] = useState<LiveCall[]>([]);
  const [health, setHealth] = useState<DockHealth | null>(null);
  const [selected, setSelected] = useState<DockCall | null>(null);
  const [loading, setLoading] = useState(false);
  /*
   * How far back the list currently reaches.
   *
   * Alex: "we dont need to auto load calls from 150 calls a go however, it
   * would be useful to have the ability to scroll that far down."
   *
   * So it starts small and grows only when somebody asks. Loading four hundred
   * calls for everybody, on every open, to serve the rare occasion somebody
   * scrolls back a fortnight, is the wrong trade in the other direction.
   */
  const [limit, setLimit] = useState(PAGE);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setCalls(await recentCalls(limit));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  /*
   * Live calls, on their own clock.
   *
   * Separate from the list because it answers a different question at a
   * different speed. The list is history and fifteen seconds is fine; a phone
   * that started ringing fifteen seconds ago has already been answered. This is
   * one small indexed query, so four seconds costs little and is the difference
   * between the dock feeling connected to the phone and feeling like a report.
   */
  const refreshLive = useCallback(async () => {
    setLive(await liveCalls());
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    void refreshLive();
    void dockHealth().then(setHealth);
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshLive();
    }, 4_000);
    return () => window.clearInterval(id);
  }, [open, refreshLive]);

  /*
   * A call that has just ended becomes a row in the list -- but only after the
   * call log has been pulled, which takes a moment. Refreshing the list when a
   * live call disappears is what makes the hand-off invisible.
   */
  const liveCount = live.filter((c) => c.state !== "ended").length;
  const previousLiveCount = usePrevious(liveCount);
  useEffect(() => {
    if (previousLiveCount !== undefined && liveCount < previousLiveCount) {
      void syncRecentCalls().then(() => refresh());
    }
  }, [liveCount, previousLiveCount, refresh]);

  /*
   * Ask RingCentral for anything that happened while this was closed.
   *
   * Alex: "This needs to load like calls even when the app wasnt open."
   *
   * The webhook only carries calls made while a live subscription is pointing
   * here. Before one exists -- day one, and any day one has lapsed -- it
   * carries nothing at all, and the dock looks like a phone system with no
   * calls in it rather than a CRM that was not listening.
   *
   * Fired alongside the read above, NOT before it. The list draws from the
   * database instantly and re-draws only if the pull actually brought something
   * new. Waiting on a network round trip before showing calls we already had
   * would make the dock slower for the ordinary case in order to help the rare
   * one. The server throttles this to once a minute across everybody.
   */
  useEffect(() => {
    if (!open) return;
    let live = true;
    void syncRecentCalls().then((r) => {
      if (live && r.imported > 0) void refresh();
    });
    return () => {
      live = false;
    };
  }, [open, refresh]);

  /*
   * Live, while the dock is open.
   *
   * Alex asked to see calls "live". A call arrives here through a webhook and a
   * database write, so there is nothing to push to the browser -- polling is
   * what makes it feel live, and fifteen seconds is comfortably faster than
   * somebody finishes a call and looks down.
   *
   * Only while OPEN and only while the tab is VISIBLE. A dock nobody is looking
   * at that queries every fifteen seconds all day is a cost with no reader, and
   * a laptop full of background tabs doing it is worse.
   */
  useEffect(() => {
    if (!open) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const id = window.setInterval(tick, 15_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [open, refresh]);

  // An unmatched call is outstanding work too -- more so, since nobody has even
  // said who it was with. Counting only unlogged matched calls understated the
  // badge by exactly the calls this change exists to surface.
  const outstanding = calls.filter((c) => c.kind === "unmatched" || !c.loggedAt).length;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-0 left-4 z-50 flex items-center gap-2 rounded-t-lg border border-b-0 bg-background px-4 py-2 text-sm font-medium shadow-lg transition-colors hover:bg-muted"
        aria-label="Open the phone"
      >
        <PhoneIcon />
        RingCentral
        {/* A call in progress outranks a backlog. Somebody on a call wants the
            dock open now; somebody with four to write up can finish reading the
            sentence they are on. */}
        {liveCount > 0 ? (
          <span className="flex items-center gap-1 rounded-full bg-emerald-600 px-1.5 py-0.5 text-xs font-semibold text-white">
            <span className="size-1.5 animate-pulse rounded-full bg-white" aria-hidden />
            On a call
          </span>
        ) : outstanding > 0 ? (
          <span className="rounded-full bg-destructive px-1.5 py-0.5 text-xs font-semibold text-destructive-foreground">
            {outstanding}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <div className="fixed bottom-0 left-4 z-50 flex h-[32rem] w-[26rem] flex-col rounded-t-lg border border-b-0 bg-background shadow-2xl">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <PhoneIcon />
        <span className="text-sm font-semibold">RingCentral</span>
        <div className="ml-2 flex gap-1">
          <TabButton active={tab === "calls"} onClick={() => setTab("calls")}>
            Calls{outstanding > 0 ? ` (${outstanding})` : ""}
          </TabButton>
          <TabButton active={tab === "dialer"} onClick={() => setTab("dialer")}>
            Dial
          </TabButton>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="ml-auto rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
          aria-label="Close the phone"
        >
          ✕
        </button>
      </header>

      {tab === "dialer" ? (
        <Dialer />
      ) : selected?.kind === "unmatched" ? (
        <AttachForm
          call={selected}
          onDone={() => {
            setSelected(null);
            void refresh();
          }}
          onCancel={() => setSelected(null)}
        />
      ) : selected ? (
        <LogForm
          call={selected}
          onDone={() => {
            setSelected(null);
            void refresh();
          }}
          onCancel={() => setSelected(null)}
        />
      ) : (
        <>
          <LiveStrip calls={live} />
          <HealthNote health={health} />
          <CallList
            calls={calls}
            loading={loading}
            onPick={setSelected}
            canLoadMore={calls.length >= limit && limit < MAX_PAGE}
            onLoadMore={() => setLimit((n) => Math.min(n + PAGE, MAX_PAGE))}
          />
        </>
      )}
    </div>
  );
}

/**
 * The call happening right now, with a second counter that actually counts.
 *
 * ---------------------------------------------------------------------------
 * Alex: "If I make a call right now it needs to show there even if the person
 * has not even picked up. with a live second counter."
 *
 * The counter ticks in the browser rather than being polled. A number that
 * jumped forward four seconds at a time would look broken, and asking the
 * server what time it is every second to render a clock is absurd -- the
 * database knows when the call was answered, and the elapsed time is arithmetic
 * from there.
 *
 * It runs from ANSWERED, not from ringing. Ring time is not talk time, and the
 * policy that decides whether a call counts turns on sixty seconds of it --
 * showing a broker 1:05 when they have been talking for forty seconds would be
 * telling them they are past a threshold they have not reached.
 * ---------------------------------------------------------------------------
 */
function LiveStrip({ calls }: { calls: LiveCall[] }) {
  const [, tick] = useState(0);

  // One timer for the strip, not one per call. Only runs while there is
  // something to count.
  useEffect(() => {
    if (calls.length === 0) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [calls.length]);

  if (calls.length === 0) return null;

  return (
    <div className="border-b bg-emerald-50/60 dark:bg-emerald-950/30">
      {calls.map((call) => {
        const ringing = call.state === "ringing";
        const ended = call.state === "ended";
        const since = call.answeredAt ?? call.startedAt;
        const seconds = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));

        return (
          <div key={call.id} className="flex items-center gap-3 px-3 py-2.5">
            <span
              className={`size-2 shrink-0 rounded-full ${
                ended ? "bg-muted-foreground" : ringing ? "animate-pulse bg-amber-500" : "animate-pulse bg-emerald-500"
              }`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {call.accountName ?? call.contactName ?? call.phone ?? "Unknown number"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {ended
                  ? "Just ended — writing it up in a moment"
                  : ringing
                    ? call.direction === "inbound"
                      ? "Ringing you now"
                      : "Ringing them now"
                    : (call.contactName ?? call.phone ?? "connected")}
              </p>
            </div>
            <span
              className={`shrink-0 text-sm font-semibold tabular-nums ${
                ended ? "text-muted-foreground" : "text-emerald-700 dark:text-emerald-300"
              }`}
            >
              {ringing && !call.answeredAt ? "—" : formatClock(seconds)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Why the dock is empty when the phone has been ringing all morning.
 *
 * Because the dock shows only your own calls, "no calls today" and "every call
 * today was credited to somebody else" look identical -- an empty list. They
 * need opposite actions, so the one that is fixable says so.
 */
function HealthNote({ health }: { health: DockHealth | null }) {
  if (!health || health.extension) return null;

  return (
    <div className="border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs dark:border-amber-900 dark:bg-amber-950/40">
      <p className="font-medium text-amber-900 dark:text-amber-200">
        No RingCentral extension is recorded against you.
      </p>
      <p className="mt-0.5 text-amber-800 dark:text-amber-300">
        Calls you make cannot be recognised as yours, so this list will stay empty
        {health.unclaimed > 0 ? ` — ${health.unclaimed} already waiting` : ""}.{" "}
        {health.canFix ? (
          <Link href="/admin/integrations" className="font-medium underline">
            Attach your extension →
          </Link>
        ) : (
          "Ask an administrator to attach it."
        )}
      </p>
    </div>
  );
}

/** Remembers the previous render's value. Used to notice a live call ending. */
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref.current;
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
        active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}

function CallList({
  calls,
  loading,
  onPick,
  canLoadMore,
  onLoadMore,
}: {
  calls: DockCall[];
  loading: boolean;
  onPick: (c: DockCall) => void;
  canLoadMore: boolean;
  onLoadMore: () => void;
}) {
  // Only on the FIRST load. Replacing the list with "Loading…" every fifteen
  // seconds would make a dock somebody is reading flicker on a timer.
  if (loading && calls.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }
  if (calls.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No calls yet. Every call on your extension appears here within seconds —
        including ones to numbers nobody has on file.
      </p>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {calls.map((call) => (
        <button
          key={call.id}
          onClick={() => onPick(call)}
          /* An amber left edge on the calls that belong to nobody yet. The list
             is scanned, not read, and "which of these has no company on it" is
             the question it gets scanned for. */
          className={`flex w-full items-start gap-3 border-b border-l-[3px] px-3 py-2.5 text-left transition-colors hover:bg-muted ${
            call.kind === "unmatched" ? "border-l-amber-400" : "border-l-transparent"
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">
                {call.accountName ?? call.phone ?? "Unknown number"}
              </span>
              {call.kind === "unmatched" ? (
                <Badge variant="destructive" className="shrink-0 text-[10px]">
                  Whose is this?
                </Badge>
              ) : !call.loggedAt ? (
                <Badge variant="destructive" className="shrink-0 text-[10px]">
                  Needs logging
                </Badge>
              ) : call.qualifies ? (
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  Counted
                </Badge>
              ) : (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  Did not count
                </Badge>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {call.kind === "unmatched"
                ? "no company on file"
                : (call.contactName ?? "no contact matched")}{" "}
              · {call.direction ?? "—"} · {formatDuration(call.durationSeconds)}
              {call.result ? ` · ${call.result}` : ""}
            </p>
            {/* The reason, on the row. "Why didn't my call count" answered
                where the question gets asked, rather than on another screen. */}
            {call.kind === "unmatched" || (call.loggedAt && !call.qualifies) ? (
              <p className="truncate text-xs text-muted-foreground/80">
                {call.qualificationReason}
              </p>
            ) : null}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatWhen(call.occurredAt)}
          </span>
        </button>
      ))}

      {/* Deeper history on request. Nothing is ever removed from this list --
          a written-up call sinks below the outstanding ones and stays there. */}
      {canLoadMore ? (
        <button
          onClick={onLoadMore}
          className="w-full px-3 py-2.5 text-center text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
        >
          Show older calls
        </button>
      ) : (
        <p className="px-3 py-2.5 text-center text-xs text-muted-foreground">
          That is every call on your extension.
        </p>
      )}
    </div>
  );
}

/**
 * The log form. Every field is required, per policy.
 *
 * The company list is filtered to accounts whose contacts hold this number, so
 * a broker is confirming rather than searching. Picking a company then narrows
 * the contact list to that company.
 */
function LogForm({
  call,
  onDone,
  onCancel,
}: {
  call: DockCall;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [options, setOptions] = useState<MatchOptions>({ accounts: [], contacts: [] });
  const [accountId, setAccountId] = useState(call.accountId ?? "");
  const [contactId, setContactId] = useState("");
  const [state, formAction, pending] = useActionState(logCall, {} as LogResult);
  const router = useRouter();

  useEffect(() => {
    if (!call.phone) return;
    void matchOptions(call.phone).then((o) => {
      setOptions(o);
      if (!call.accountId && o.accounts.length === 1) setAccountId(o.accounts[0].id);
    });
  }, [call.phone, call.accountId]);

  useEffect(() => {
    const forAccount = options.contacts.filter((c) => c.accountId === accountId);
    setContactId(forAccount.length === 1 ? forAccount[0].id : "");
  }, [accountId, options.contacts]);

  useEffect(() => {
    if (state.ok) {
      toast.success("Logged. The account's clock has reset.");
      router.refresh();
      onDone();
    }
  }, [state.ok, onDone, router]);

  const contactsForAccount = options.contacts.filter((c) => c.accountId === accountId);

  return (
    <form action={formAction} className="flex flex-1 flex-col overflow-y-auto p-3">
      <input type="hidden" name="activityId" value={call.id} />

      <div className="mb-3 rounded-md border bg-muted/40 px-3 py-2">
        <p className="text-sm font-medium">{call.phone ?? "Unknown number"}</p>
        <p className="text-xs text-muted-foreground">
          {call.direction ?? "—"} · {formatDuration(call.durationSeconds)}
          {call.result ? ` · ${call.result}` : ""} · {formatWhen(call.occurredAt)}
        </p>
      </div>

      {state.error ? <p className="mb-2 text-sm text-destructive">{state.error}</p> : null}

      <div className="space-y-3">
        <Field label="Company" error={state.fieldErrors?.accountId}>
          <select
            name="accountId"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
          >
            <option value="">Select…</option>
            {options.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.contactCount > 1 ? ` (${a.contactCount} contacts)` : ""}
              </option>
            ))}
          </select>
          {options.accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No company on file holds this number. Add the contact first, or resolve it
              from the review queue.
            </p>
          ) : options.accounts.length > 1 ? (
            <p className="text-xs text-muted-foreground">
              This number is on file at {options.accounts.length} companies. Pick the one you
              actually spoke to.
            </p>
          ) : null}
        </Field>

        <Field label="Contact" error={state.fieldErrors?.contactId}>
          <select
            name="contactId"
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            disabled={!accountId}
            className="h-9 w-full rounded-md border bg-transparent px-2 text-sm disabled:opacity-50"
          >
            <option value="">Select…</option>
            {contactsForAccount.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} — {c.detail}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Notes" error={state.fieldErrors?.notes}>
          <Textarea name="notes" rows={4} placeholder="What was said, and what happens next." />
        </Field>

        <Field label="Stage" error={state.fieldErrors?.stageOutcome}>
          <div className="flex flex-wrap gap-1.5">
            {STAGES.map((s) => (
              <label
                key={s}
                className="cursor-pointer rounded-md border px-2.5 py-1 text-xs transition-colors has-[:checked]:border-foreground has-[:checked]:bg-foreground has-[:checked]:text-background"
              >
                <input type="radio" name="stageOutcome" value={s} className="sr-only" />
                {s}
              </label>
            ))}
          </div>
        </Field>
      </div>

      <div className="mt-4 flex items-center gap-2 border-t pt-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save log"}
        </Button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-muted-foreground hover:underline"
        >
          Back
        </button>
        <span className="ml-auto text-xs text-muted-foreground">All fields required</span>
      </div>
    </form>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">
        {label} <span className="text-destructive">*</span>
      </Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function Dialer() {
  const [number, setNumber] = useState("");
  const [pending, start] = useTransition();
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

  return (
    <div className="flex flex-1 flex-col p-4">
      <Input
        value={number}
        onChange={(e) => setNumber(e.target.value)}
        placeholder="(704) 555-0142"
        className="mb-3 text-center text-lg tabular-nums"
      />
      <div className="mx-auto grid w-48 grid-cols-3 gap-2">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setNumber((n) => n + k)}
            className="rounded-md border py-2.5 text-lg font-medium transition-colors hover:bg-muted"
          >
            {k}
          </button>
        ))}
      </div>
      <div className="mx-auto mt-3 flex w-48 gap-2">
        <Button
          className="flex-1"
          disabled={pending || !number}
          onClick={() =>
            start(async () => {
              await runAction(() => placeCall(number), {
                label: "Could not place the call",
                success: "Ringing your handset now.",
              });
            })
          }
        >
          {pending ? "Dialling…" : "Call"}
        </Button>
        <Button variant="outline" onClick={() => setNumber((n) => n.slice(0, -1))}>
          ⌫
        </Button>
      </div>
      <p className="mt-auto text-xs text-muted-foreground">
        Click-to-call rings your handset first, then the customer. The call appears under
        Calls when it ends — remember it does not count until you write it up.
      </p>
    </div>
  );
}

function PhoneIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.68 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.32 1.85.55 2.81.68A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

/** m:ss, like a phone. Zero-padded so the width does not jump every ten seconds. */
function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}


/**
 * Saying which company an unmatched call was with.
 *
 * ---------------------------------------------------------------------------
 * Deliberately NOT the log form. That form asks for a contact, notes and a
 * stage, and none of them can be answered yet: there is no contact on file --
 * that is the whole reason the call is here.
 *
 * So this asks the one question that unblocks everything else, and then the
 * call becomes an ordinary unlogged call which gets written up in the usual
 * way. Two small steps rather than one form that cannot be completed.
 *
 * The company list is every company the person can open, searched as they type,
 * because by definition the number gives no clue which one it is.
 * ---------------------------------------------------------------------------
 */
function AttachForm({
  call,
  onDone,
  onCancel,
}: {
  call: DockCall;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; detail: string }[]>([]);
  const [pending, start] = useTransition();
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    /*
     * Debounced, and the answer is thrown away if a newer keystroke has
     * happened. Without the second half, a slow reply for "ta" can land after
     * a fast one for "tanglewood" and the list flips back to the wrong results
     * under the person's finger.
     */
    let live = true;
    setSearching(true);
    const id = window.setTimeout(() => {
      void searchCompanies(query)
        .then((r) => {
          if (live) setResults(r);
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [query]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b px-3 py-2.5">
        <p className="text-sm font-medium">{call.phone ?? "Unknown number"}</p>
        <p className="text-xs text-muted-foreground">
          {call.direction ?? "—"} · {formatDuration(call.durationSeconds)}
          {call.result ? ` · ${call.result}` : ""} · {formatWhen(call.occurredAt)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{call.qualificationReason}</p>
      </div>

      <div className="border-b p-3">
        <label className="text-xs font-medium" htmlFor="attach-search">
          Which company was this with?
        </label>
        <input
          id="attach-search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Start typing a company name…"
          className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm outline-none focus:border-ring"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {query.trim().length < 2 ? (
          <p className="p-3 text-xs text-muted-foreground">
            Type at least two letters. Only companies you can open are listed.
          </p>
        ) : searching ? (
          <p className="p-3 text-xs text-muted-foreground">Searching…</p>
        ) : results.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            Nothing matches. If this company is not in the CRM yet, add it from Prospects and the
            call will still be here when you come back.
          </p>
        ) : (
          results.map((r) => (
            <button
              key={r.id}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const ok = await runAction(() => attachCall(call.id, r.id), {
                    label: "Could not attach that call",
                    quiet: true,
                  });
                  if (ok) onDone();
                })
              }
              className="flex w-full flex-col items-start border-b px-3 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
            >
              <span className="text-sm font-medium">{r.name}</span>
              <span className="text-xs text-muted-foreground">{r.detail}</span>
            </button>
          ))
        )}
      </div>

      <div className="border-t p-3">
        <button
          onClick={onCancel}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Back to the list
        </button>
      </div>
    </div>
  );
}
