"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { Inbox, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/info-tip";
import { claim } from "@/app/(app)/available/actions";
import { fetchPool, type PoolAccount } from "./actions";

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
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const refresh = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const result = await fetchPool(q);
      // A failed read used to look identical to an empty pool. It is not the
      // same thing, and telling a broker "every account is held by somebody"
      // when the query actually failed is the worse of the two lies.
      setFailure(result.error);
      setAccounts(result.accounts);
      setTotal(result.total);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "The pool could not be loaded.");
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
      const result = await runAction(() => claim(form), {
        label: "Could not claim it",
        success: `${account.name} is yours. The clock starts now.`,
      });
      if (result) {
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
        className="chrome-blur fixed bottom-0 left-44 z-50 flex items-center gap-2 rounded-t-2xl border border-b-0 border-border/60 bg-card/85 px-4 py-2.5 text-sm font-medium shadow-[0_-4px_24px_-8px_rgba(0,0,0,0.25)] transition-colors hover:bg-accent"
        aria-label="Open the available pool"
      >
        <Inbox className="size-3.5" aria-hidden />
        Available pool
      </button>
    );
  }

  return (
    <div className="chrome-blur fixed bottom-0 left-44 z-50 flex h-[32rem] w-[24rem] max-w-[calc(100vw-2rem)] flex-col rounded-t-2xl border border-b-0 border-border/60 bg-card/95 shadow-[0_-8px_40px_-12px_rgba(0,0,0,0.35)]">
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
        {failure ? (
          <div className="m-3 rounded-md border border-destructive/40 bg-destructive/10 p-3">
            <p className="text-xs font-semibold text-destructive">The pool could not be read</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{failure}</p>
          </div>
        ) : loading && accounts.length === 0 ? (
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
