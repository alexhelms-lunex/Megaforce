"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Inbox, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/info-tip";
import { claim } from "@/app/(app)/available/actions";
import { poolAccounts, type PoolAccount } from "./actions";

/**
 * The available pool, as a dock.
 *
 * ---------------------------------------------------------------------------
 * It used to be a page, and being a page was the problem. Claiming is not
 * something a broker sets out to do — it happens in the middle of doing
 * something else: reading a company, finishing a call, noticing a gap. Sending
 * them to another screen to do it means losing whatever they were on, and the
 * back button does not restore a scroll position halfway down eighty rows.
 *
 * So it sits beside the phone, bottom-left, and works the same way: open it,
 * take something, carry on. The page behind it refreshes in place.
 *
 * The page still exists for anyone who wants to browse the pool properly with
 * filters. This is the version for the ten seconds you actually have.
 * ---------------------------------------------------------------------------
 */
export function PoolDock() {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<PoolAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const refresh = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const result = await poolAccounts(q);
      setAccounts(result.accounts);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // Debounced, and only while the panel is open. A search-as-you-type that
    // fires on every keystroke against a book of thousands is how a helpful
    // panel becomes the reason the page is slow.
    const timer = setTimeout(() => void refresh(query), query ? 200 : 0);
    return () => clearTimeout(timer);
  }, [open, query, refresh]);

  function take(account: PoolAccount) {
    start(async () => {
      const form = new FormData();
      form.set("accountId", account.id);
      const result = await claim(form);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`${account.name} is yours. The clock starts now.`);
        // Drop it from the list immediately rather than waiting for the
        // refetch, so a fast second click cannot claim it twice.
        setAccounts((list) => list.filter((a) => a.id !== account.id));
        setTotal((t) => Math.max(0, t - 1));
        router.refresh();
      }
      void refresh(query);
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-0 left-44 z-50 flex items-center gap-2 rounded-t-lg border border-b-0 bg-card px-4 py-2 text-sm font-medium shadow-lg transition-colors hover:bg-accent"
        aria-label="Open the available pool"
      >
        <Inbox className="size-3.5" aria-hidden />
        Available pool
      </button>
    );
  }

  return (
    <div className="fixed bottom-0 left-44 z-50 flex h-[32rem] w-[24rem] max-w-[calc(100vw-2rem)] flex-col rounded-t-lg border border-b-0 bg-card shadow-2xl">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Inbox className="size-3.5" aria-hidden />
        <span className="text-sm font-semibold">Available pool</span>
        <InfoTip k="availablePool" side="bottom" />
        <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
          {total}
        </span>
        <button
          onClick={() => setOpen(false)}
          className="ml-auto rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
          aria-label="Close the available pool"
        >
          ✕
        </button>
      </header>

      <div className="border-b p-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Company, city, industry…"
            className="h-8 w-full rounded-md border bg-background pl-8 pr-2 text-sm outline-none focus:border-ring"
          />
        </div>
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        {loading && accounts.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {query
              ? `Nothing unclaimed matches “${query}”.`
              : "The pool is empty. Every account is held by somebody."}
          </p>
        ) : (
          accounts.map((a) => (
            <div key={a.id} className="flex items-start gap-2 border-b px-3 py-2.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <Link
                  href={`/accounts/${a.id}`}
                  className="block truncate text-sm font-medium hover:underline"
                >
                  {a.name}
                </Link>
                <p className="truncate text-xs text-muted-foreground">
                  {[a.industry, a.city && a.state ? `${a.city}, ${a.state}` : a.state, a.stage]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="truncate text-xs text-muted-foreground/80">
                  {a.contactCount === 0
                    ? "no contacts on file"
                    : `${a.contactCount} contact${a.contactCount === 1 ? "" : "s"}`}
                  {a.releasedDaysAgo !== null ? ` · released ${a.releasedDaysAgo}d ago` : ""}
                </p>
              </div>
              <Button size="sm" variant="brand" disabled={pending} onClick={() => take(a)}>
                Claim
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="border-t px-3 py-2">
        <Link href="/available" className="text-xs font-medium text-primary hover:underline">
          Browse the whole pool with filters →
        </Link>
      </div>
    </div>
  );
}
