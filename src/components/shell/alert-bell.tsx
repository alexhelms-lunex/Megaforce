"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { LifecycleFlag } from "@/components/lifecycle-flag";
import type { LifecycleState } from "@/lib/lifecycle";

export interface Alert {
  id: string;
  name: string;
  state: LifecycleState;
  daysLeft: number | null;
}

/**
 * The bell.
 *
 * The prospecting policy puts an alert here at day 21 -- the point at which an
 * account is nine days from being taken. That is the one number in the system
 * a broker cannot afford to miss, so it gets the loudest surface in the chrome
 * and it is sorted worst-first.
 *
 * The count is red, not brand green. Green here would read as "all clear",
 * which is the opposite of what a number on this bell means.
 */
export function AlertBell({ alerts }: { alerts: Alert[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={
          alerts.length === 0
            ? "No accounts need attention"
            : `${alerts.length} accounts need attention`
        }
        className="relative flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Bell className="size-4.5" aria-hidden />
        {alerts.length > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white">
            {alerts.length > 9 ? "9+" : alerts.length}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-11 z-50 w-88 overflow-hidden rounded-lg border bg-popover shadow-xl">
          <div className="border-b px-4 py-2.5">
            <p className="text-sm font-semibold">Accounts needing attention</p>
            <p className="text-xs text-muted-foreground">
              Past day 21. Log a qualifying call to reset the clock.
            </p>
          </div>
          {alerts.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing at risk. Your book is current.
            </p>
          ) : (
            <div className="scrollbar-thin max-h-80 overflow-y-auto">
              {alerts.map((a) => (
                <Link
                  key={a.id}
                  href={`/accounts/${a.id}`}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 border-b px-4 py-2.5 transition-colors last:border-b-0 hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.name}</span>
                  <LifecycleFlag state={a.state} daysLeft={a.daysLeft} />
                </Link>
              ))}
            </div>
          )}
          <Link
            href="/accounts?preset=at-risk"
            onClick={() => setOpen(false)}
            className="block border-t px-4 py-2.5 text-center text-xs font-medium text-primary hover:bg-accent"
          >
            See everything at risk
          </Link>
        </div>
      ) : null}
    </div>
  );
}
