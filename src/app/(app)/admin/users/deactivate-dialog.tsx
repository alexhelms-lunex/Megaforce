"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AdminUser } from "@/lib/roles";

export type Disposition = "release" | "transfer" | "keep";

/**
 * "What happens to their book?"
 *
 * ---------------------------------------------------------------------------
 * WordPress asks what to do with somebody's posts before it deletes them, and
 * it is the single best thing about that screen. The same question is sharper
 * here, because an account is not an article: it is somebody's commission, and
 * a book of forty released silently is forty conversations the administrator
 * did not know they were starting.
 *
 * So there is no default action and no way past this dialog. Three answers,
 * each of which is a real situation:
 *
 *   Released  -- they have left. The book was going stale from the day they
 *                stopped working it, so it goes back for anyone to claim.
 *   Transfer  -- a handover. Somebody is taking the book on deliberately.
 *   Keep      -- a leave of absence. They are coming back and their book
 *                should be waiting.
 *
 * The count is stated in the sentence, not implied, because "release their
 * accounts" reads very differently when the number is 0 and when it is 40.
 * ---------------------------------------------------------------------------
 */
export function DeactivateDialog({
  person,
  colleagues,
  onClose,
  onConfirm,
}: {
  person: AdminUser;
  colleagues: { id: string; name: string; role: string }[];
  onClose: () => void;
  onConfirm: (disposition: Disposition, transferTo?: string) => void;
}) {
  const [disposition, setDisposition] = useState<Disposition>("release");
  const [transferTo, setTransferTo] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const held = person.accounts_held;
  const options: { key: Disposition; label: string; detail: string }[] = [
    {
      key: "release",
      label: "Return them to the available pool",
      detail:
        held > 0
          ? `All ${held} go back for any broker to claim. The right answer when somebody has left.`
          : "They hold nothing, so nothing moves.",
    },
    {
      key: "transfer",
      label: "Hand the whole book to somebody",
      detail: "For a planned handover, where a named person is taking it on.",
    },
    {
      key: "keep",
      label: "Leave the accounts in their name",
      detail:
        "For a leave of absence. The clock keeps running, so anything already quiet will still time out.",
    },
  ];

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Deactivate ${person.full_name}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border bg-card p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
            <AlertTriangle className="size-4" aria-hidden />
          </span>
          <div>
            <h2 className="text-base font-semibold">Deactivate {person.full_name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              They will not be able to sign in. Their history stays — every activity they logged
              and every account they held keeps their name on it.
            </p>
          </div>
        </div>

        <fieldset className="mt-4 space-y-2">
          <legend className="mb-2 text-sm font-medium">
            {held > 0
              ? `They hold ${held} account${held === 1 ? "" : "s"}. What happens to ${held === 1 ? "it" : "them"}?`
              : "They hold no accounts. What happens if that changes?"}
          </legend>

          {options.map((o) => (
            <label
              key={o.key}
              className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors ${
                disposition === o.key ? "border-primary bg-accent/50" : "hover:bg-accent/30"
              }`}
            >
              <input
                type="radio"
                name="disposition"
                value={o.key}
                checked={disposition === o.key}
                onChange={() => setDisposition(o.key)}
                className="mt-0.5 size-4 accent-[var(--primary)]"
              />
              <span>
                <span className="block text-sm font-medium">{o.label}</span>
                <span className="block text-xs text-muted-foreground">{o.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {disposition === "transfer" ? (
          <label className="mt-3 block">
            <span className="mb-1 block text-sm font-medium">Hand the book to</span>
            <select
              value={transferTo}
              onChange={(e) => setTransferTo(e.target.value)}
              className="h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring"
            >
              <option value="">Choose somebody…</option>
              {colleagues.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.role})
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={disposition === "transfer" && !transferTo}
            onClick={() => onConfirm(disposition, transferTo || undefined)}
          >
            Deactivate {person.full_name.split(" ")[0]}
          </Button>
        </div>
      </div>
    </div>
  );
}
