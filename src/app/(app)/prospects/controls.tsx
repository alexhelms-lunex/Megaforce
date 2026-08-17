"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PAGE_SIZES } from "@/lib/preferences";
import { savePreferences } from "@/app/(app)/settings/actions";

/**
 * How many rows to show.
 *
 * ---------------------------------------------------------------------------
 * Alex: "we want to render 100. But a toggle for brokers to render less down to
 * 10 all the way up to 200 should be available per the users discretion."
 *
 * Two things happen on a change, and both are needed. The URL updates, so the
 * page somebody is looking at can be pasted to a colleague and arrive looking
 * the same. The preference is saved, so tomorrow morning it is still 200
 * without anybody setting it again.
 *
 * The save is fire-and-forget on purpose. It is a display setting: if it does
 * not persist, the worst case is that somebody sets it twice, and blocking the
 * page change on a round trip to make that impossible would make every single
 * change feel slow to fix a rare and harmless failure.
 * ---------------------------------------------------------------------------
 */
export function PageSizePicker({ value }: { value: number }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  function choose(size: number) {
    const next = new URLSearchParams(params.toString());
    next.set("per", String(size));
    // Back to page one. Staying on page 7 while shrinking the page from 200 to
    // 10 lands on an empty screen that looks like a broken filter.
    next.delete("page");
    router.push(`?${next.toString()}`);
    start(async () => {
      try {
        await savePreferences({ rows_per_page: size });
      } catch {
        /* a display preference is not worth an error toast */
      }
    });
  }

  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      Rows
      <select
        value={value}
        disabled={pending}
        onChange={(e) => choose(Number(e.target.value))}
        aria-label="Rows per page"
        className="h-8 rounded-md border bg-background px-1.5 text-xs font-medium text-foreground outline-none focus:border-ring"
      >
        {PAGE_SIZES.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The sort menu.
 *
 * A plain select that navigates, rather than a form the person has to submit.
 * Changing a sort is not a decision anybody wants to confirm.
 */
export function SortPicker({ value }: { value: string }) {
  const router = useRouter();
  const params = useSearchParams();

  const options = [
    { key: "relevance", label: "Best match" },
    { key: "name", label: "Company A–Z" },
    { key: "urgency", label: "Most urgent" },
    { key: "recent", label: "Recently worked" },
  ];

  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      Sort
      <select
        value={value}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString());
          next.set("sort", e.target.value);
          next.delete("page");
          router.push(`?${next.toString()}`);
        }}
        aria-label="Sort order"
        className="h-8 rounded-md border bg-background px-1.5 text-xs font-medium text-foreground outline-none focus:border-ring"
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
