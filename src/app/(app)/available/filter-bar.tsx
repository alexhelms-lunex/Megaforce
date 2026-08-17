"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { InfoTip } from "@/components/info-tip";

/**
 * Narrowing the pool.
 *
 * Deliberately smaller than the account list's filter bar. The pool is a place
 * you arrive at wanting a specific kind of company — a vertical, a state, a
 * name you half remember — not a place you build a saved report. Four controls
 * cover that, and everything lives in the URL so a link to "unclaimed
 * manufacturing in North Carolina" is a link somebody can send.
 */
export function PoolFilterBar({
  industries,
  states,
}: {
  industries: string[];
  states: string[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");

  // A cleared chip or a Back navigation changes the URL without touching this
  // input, so it has to follow along or it keeps showing a dead search term.
  useEffect(() => setQ(params.get("q") ?? ""), [params]);

  function go(patch: Record<string, string>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    // Any change resets to page one. Landing on page 7 of a 2-page result is
    // the classic filtering bug, and it looks exactly like "no results".
    next.delete("page");
    router.push(`/available?${next.toString()}`);
  }

  const industry = params.get("industry") ?? "";
  const state = params.get("state") ?? "";
  const sort = params.get("sort") ?? "recent";
  const active = [q, industry, state].filter(Boolean).length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go({ q });
        }}
        className="relative min-w-[14rem] flex-1"
      >
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Company, city, industry…"
          aria-label="Search the available pool"
          className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus:border-ring"
        />
      </form>

      <label className="inline-flex items-center gap-1 text-sm">
        <span className="sr-only">Industry</span>
        <select
          value={industry}
          onChange={(e) => go({ industry: e.target.value })}
          className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:border-ring"
        >
          <option value="">All industries</option>
          {industries.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
        <InfoTip k="filterIndustry" side="bottom" />
      </label>

      <label className="inline-flex items-center gap-1 text-sm">
        <span className="sr-only">State</span>
        <select
          value={state}
          onChange={(e) => go({ state: e.target.value })}
          className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:border-ring"
        >
          <option value="">All states</option>
          {states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <InfoTip k="filterState" side="bottom" />
      </label>

      <label className="inline-flex items-center gap-1 text-sm">
        <span className="sr-only">Sort</span>
        <select
          value={sort}
          onChange={(e) => go({ sort: e.target.value === "recent" ? "" : e.target.value })}
          className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:border-ring"
        >
          <option value="recent">Recently released first</option>
          <option value="oldest">Longest sitting first</option>
          <option value="name">Company A–Z</option>
        </select>
        <InfoTip
          side="bottom"
          text="Recently released first is the default because those accounts are warm — somebody was working them until days ago. Longest sitting finds the ones nobody has touched in months."
        />
      </label>

      {active > 0 ? (
        <button
          onClick={() => router.push("/available")}
          className="inline-flex h-9 items-center gap-1 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-accent"
        >
          <X className="size-3.5" aria-hidden />
          Clear {active}
        </button>
      ) : null}
    </div>
  );
}
