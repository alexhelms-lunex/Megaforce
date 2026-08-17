"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, CornerDownLeft, Lock, Search, User } from "lucide-react";
import { allNavItems } from "./nav";
import { globalSearch, type SearchHit } from "./search-actions";

/**
 * Cmd-K search.
 *
 * Two things at once: a jump list for the screens, and a live search over
 * companies and people. A CRM's most common navigation is "take me to
 * Halvorsen Foods", and making that a keystroke rather than a page-then-filter
 * is most of the difference between a system people use and one they tolerate.
 *
 * Queries are debounced and the response is discarded if a newer keystroke has
 * already been sent -- otherwise a slow request for "hal" lands after a fast
 * one for "halvorsen" and overwrites the better results.
 */
export function CommandPalette({ role }: { role: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const router = useRouter();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery("");
      setHits([]);
    }
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      const results = await globalSearch(q);
      if (mine !== seq.current) return; // a newer keystroke won
      setHits(results);
      setCursor(0);
      setLoading(false);
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  const navMatches = allNavItems(role).filter((item) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return item.label.toLowerCase().includes(q) || (item.keywords ?? "").includes(q);
  });

  type Row =
    | { type: "nav"; href: string; label: string; icon: React.ElementType }
    | { type: "hit"; hit: SearchHit };

  const rows: Row[] = [
    ...navMatches.map((n) => ({ type: "nav" as const, href: n.href, label: n.label, icon: n.icon })),
    ...hits.map((h) => ({ type: "hit" as const, hit: h })),
  ];

  function go(row: Row) {
    setOpen(false);
    router.push(row.type === "nav" ? row.href : row.hit.href);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex h-9 w-full max-w-md items-center gap-2 rounded-md border bg-card px-3 text-sm text-muted-foreground transition-colors hover:border-ring"
      >
        <Search className="size-4" aria-hidden />
        <span>Search companies, people, screens…</span>
        <kbd className="ml-auto hidden rounded border px-1.5 py-0.5 font-mono text-[10px] sm:block">
          ⌘K
        </kbd>
      </button>
    );
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-navy-950/40 backdrop-blur-[2px]"
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal
        aria-label="Search"
        className="fixed left-1/2 top-[12vh] z-50 w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border bg-popover shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b px-4">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, rows.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter" && rows[cursor]) {
                e.preventDefault();
                go(rows[cursor]);
              }
            }}
            placeholder="Company, contact, city, or a screen…"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {loading ? <span className="text-xs text-muted-foreground">searching…</span> : null}
        </div>

        <div className="scrollbar-thin max-h-[22rem] overflow-y-auto p-1.5">
          {rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {query.trim().length < 2
                ? "Type at least two characters."
                : `Nothing matches “${query.trim()}”.`}
            </p>
          ) : (
            rows.map((row, i) => {
              const key = row.type === "nav" ? `nav:${row.href}` : `hit:${row.hit.kind}:${row.hit.id}`;
              // A locked result gets a padlock rather than a building, so it
              // is obvious before clicking that this one is somebody else's.
              const Icon =
                row.type === "nav"
                  ? row.icon
                  : row.hit.kind === "locked"
                    ? Lock
                    : row.hit.kind === "account"
                      ? Building2
                      : User;
              return (
                <button
                  key={key}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => go(row)}
                  data-active={i === cursor}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors data-[active=true]:bg-accent"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {row.type === "nav" ? row.label : row.hit.title}
                    </span>
                    {row.type === "hit" ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {row.hit.subtitle}
                      </span>
                    ) : null}
                  </span>
                  {row.type === "nav" ? (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Go to
                    </span>
                  ) : row.hit.kind === "locked" ? (
                    <span className="shrink-0 rounded-full border border-amber-300 bg-amber-100 px-1.5 py-px text-[10px] font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                      held
                    </span>
                  ) : null}
                  {i === cursor ? (
                    <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
