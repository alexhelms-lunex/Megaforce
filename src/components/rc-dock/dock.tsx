"use client";

import { useActionState, useCallback, useEffect, useState, useTransition } from "react";
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
  recentCalls,
  STAGES,
  type DockCall,
  type LogResult,
  type MatchOptions,
} from "./actions";

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
  const [selected, setSelected] = useState<DockCall | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setCalls(await recentCalls());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const unlogged = calls.filter((c) => !c.loggedAt).length;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-0 left-4 z-50 flex items-center gap-2 rounded-t-lg border border-b-0 bg-background px-4 py-2 text-sm font-medium shadow-lg transition-colors hover:bg-muted"
        aria-label="Open the phone"
      >
        <PhoneIcon />
        RingCentral
        {unlogged > 0 ? (
          <span className="rounded-full bg-destructive px-1.5 py-0.5 text-xs font-semibold text-destructive-foreground">
            {unlogged}
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
            Calls{unlogged > 0 ? ` (${unlogged})` : ""}
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
        <CallList calls={calls} loading={loading} onPick={setSelected} />
      )}
    </div>
  );
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
}: {
  calls: DockCall[];
  loading: boolean;
  onPick: (c: DockCall) => void;
}) {
  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }
  if (calls.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No calls yet. They appear here as soon as RingCentral sends them.
      </p>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {calls.map((call) => (
        <button
          key={call.id}
          onClick={() => onPick(call)}
          className="flex w-full items-start gap-3 border-b px-3 py-2.5 text-left transition-colors hover:bg-muted"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">
                {call.accountName ?? call.phone ?? "Unknown number"}
              </span>
              {!call.loggedAt ? (
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
              {call.contactName ?? "no contact matched"} ·{" "}
              {call.direction ?? "—"} · {formatDuration(call.durationSeconds)}
              {call.result ? ` · ${call.result}` : ""}
            </p>
            {/* The reason, on the row. "Why didn't my call count" answered
                where the question gets asked, rather than on another screen. */}
            {call.loggedAt && !call.qualifies ? (
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
