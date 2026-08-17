"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { ROLES } from "@/lib/roles";

/**
 * The filter links, with counts.
 *
 * Straight out of WordPress, and the counts are the reason. "Admin (1)" across
 * the top is the fastest way to notice that a role has exactly one person in
 * it who happens to have left — which is the failure this whole screen exists
 * to make visible before it happens rather than after.
 */
export function UserFilters({
  counts,
  role,
  status,
  search,
}: {
  counts: Record<string, number>;
  role: string;
  status: string;
  search: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(search);

  useEffect(() => setQ(search), [search]);

  function go(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    next.delete("page");
    router.push(`/admin/users?${next.toString()}`);
  }

  const statuses = [
    { key: "active", label: "Active", n: counts.active },
    { key: "inactive", label: "Deactivated", n: counts.inactive },
    { key: "nologin", label: "No login yet", n: counts.nologin },
    { key: "all", label: "All", n: counts.all },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-2 text-sm">
        {statuses.map((s, i) => (
          <span key={s.key} className="flex items-center">
            {i > 0 ? <span className="px-1.5 text-muted-foreground/40">|</span> : null}
            <button
              onClick={() => go({ status: s.key })}
              className={`rounded-md px-1.5 py-0.5 transition-colors ${
                status === s.key
                  ? "font-semibold text-foreground"
                  : "text-primary hover:underline"
              }`}
            >
              {s.label}{" "}
              <span className="tabular-nums text-muted-foreground">({s.n ?? 0})</span>
            </button>
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => go({ role: null })}
            aria-pressed={role === ""}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              role === "" ? "bg-primary text-primary-foreground" : "border hover:bg-accent"
            }`}
          >
            Every role
          </button>
          {ROLES.map((r) => (
            <button
              key={r.key}
              onClick={() => go({ role: r.key })}
              aria-pressed={role === r.key}
              title={r.scope}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                role === r.key ? "bg-primary text-primary-foreground" : "border hover:bg-accent"
              }`}
            >
              {r.label}{" "}
              <span className="tabular-nums opacity-70">{counts[r.key] ?? 0}</span>
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            go({ q });
          }}
          className="relative w-full sm:w-64"
        >
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, email or branch…"
            aria-label="Search people"
            className="h-9 w-full rounded-full border bg-background pl-9 pr-8 text-sm outline-none focus:border-ring"
          />
          {q ? (
            <button
              type="button"
              onClick={() => {
                setQ("");
                go({ q: null });
              }}
              aria-label="Clear the search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </form>
      </div>
    </div>
  );
}
