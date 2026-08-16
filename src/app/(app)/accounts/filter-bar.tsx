"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Columns3, Search, SlidersHorizontal, X } from "lucide-react";
import {
  COLUMNS,
  CREDIT_OPTIONS,
  IDLE_OPTIONS,
  PRESETS,
  SORTS,
  STAGE_OPTIONS,
  STATE_OPTIONS,
  STATUS_OPTIONS,
  activeCount,
  toQueryString,
  type AccountFilters,
} from "@/lib/account-filters";

export interface FilterOptions {
  industries: string[];
  states: { value: string; uses: number }[];
  cities: { value: string; uses: number }[];
  ownerLocations: string[];
  owners: { id: string; name: string }[];
}

/**
 * The filter bar.
 *
 * Three tiers, because a rep uses them at wildly different frequencies:
 * presets are one click and cover most days, the always-visible row handles the
 * common narrowing, and the rest sits behind "More filters" rather than
 * competing for space it does not earn.
 *
 * Everything writes to the URL. Nothing is held here that would be lost by
 * refreshing, opening in a new tab, or sending the link to a colleague.
 */
export function FilterBar({
  filters,
  options,
  columns,
  total,
}: {
  filters: AccountFilters;
  options: FilterOptions;
  columns: string[];
  total: number;
}) {
  const router = useRouter();
  const [q, setQ] = useState(filters.q);
  const [showMore, setShowMore] = useState(
    Boolean(
      filters.city || filters.creditStatus || filters.national || filters.hierarchy ||
        filters.hasContacts || filters.ownerLocation || filters.owner,
    ),
  );

  // The input is uncontrolled by the URL after mount, so a navigation triggered
  // elsewhere (a preset chip, a cleared chip) has to push the new value back in
  // or the box keeps showing a term that is no longer applied.
  useEffect(() => setQ(filters.q), [filters.q]);

  function go(patch: Partial<AccountFilters>, cols = columns) {
    // Any change resets to page one. Landing on page 7 of a 2-page result is
    // the classic filtering bug, and it looks like "no results".
    const qs = toQueryString({ ...filters, ...patch, page: 1 });
    const params = new URLSearchParams(qs);
    if (cols.length > 0) params.set("cols", cols.join(","));
    router.push(`/accounts?${params.toString()}`);
  }

  const active = activeCount(filters);

  return (
    <div className="space-y-3">
      {/* ---- presets ---- */}
      <div className="scrollbar-thin flex gap-1.5 overflow-x-auto pb-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            title={p.description}
            onClick={() => router.push(`/accounts?preset=${p.key}`)}
            data-active={filters.preset === p.key}
            className="shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent data-[active=true]:border-navy-700 data-[active=true]:bg-navy-700 data-[active=true]:text-white"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* ---- primary row ---- */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            go({ q });
          }}
          className="relative min-w-56 flex-1"
        >
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Company, city, street, or website…"
            className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none focus:border-ring"
          />
        </form>

        <Select
          label="Status"
          value={filters.status}
          onChange={(v) => go({ status: v })}
          options={STATUS_OPTIONS}
        />
        <Select
          label="Clock"
          value={filters.state}
          onChange={(v) => go({ state: v })}
          options={STATE_OPTIONS}
        />
        <Select
          label="Stage"
          value={filters.stage}
          onChange={(v) => go({ stage: v })}
          options={STAGE_OPTIONS}
        />
        <Select
          label="Industry"
          value={filters.industry}
          onChange={(v) => go({ industry: v })}
          options={options.industries.map((i) => ({ value: i, label: i }))}
        />
        <Select
          label="State"
          value={filters.billingState}
          onChange={(v) => go({ billingState: v })}
          options={options.states.map((s) => ({
            value: s.value,
            label: `${s.value} (${s.uses})`,
          }))}
        />
        <Select
          label="Quiet for"
          value={filters.idle}
          onChange={(v) => go({ idle: v })}
          options={IDLE_OPTIONS}
        />

        <button
          onClick={() => setShowMore((s) => !s)}
          data-active={showMore}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors hover:bg-accent data-[active=true]:bg-accent"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden />
          More
        </button>

        <div className="ml-auto flex items-center gap-2">
          <ColumnPicker columns={columns} onChange={(cols) => go({}, cols)} />
          <Select
            label="Sort"
            value={filters.sort}
            onChange={(v) => go({ sort: v as AccountFilters["sort"] })}
            options={SORTS.map((s) => ({ value: s.key, label: s.label }))}
            allowEmpty={false}
          />
        </div>
      </div>

      {/* ---- secondary row ---- */}
      {showMore ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed bg-card/60 p-2">
          <Select
            label="City"
            value={filters.city}
            onChange={(v) => go({ city: v })}
            options={options.cities.map((c) => ({ value: c.value, label: `${c.value} (${c.uses})` }))}
          />
          <Select
            label="Owner"
            value={filters.owner}
            onChange={(v) => go({ owner: v, mine: false })}
            options={options.owners.map((o) => ({ value: o.id, label: o.name }))}
          />
          <Select
            label="Owner branch"
            value={filters.ownerLocation}
            onChange={(v) => go({ ownerLocation: v })}
            options={options.ownerLocations.map((l) => ({ value: l, label: l }))}
          />
          <Select
            label="Credit"
            value={filters.creditStatus}
            onChange={(v) => go({ creditStatus: v })}
            options={CREDIT_OPTIONS}
          />
          <Select
            label="National"
            value={filters.national}
            onChange={(v) => go({ national: v })}
            options={[
              { value: "yes", label: "National accounts" },
              { value: "no", label: "Not national" },
            ]}
          />
          <Select
            label="Hierarchy"
            value={filters.hierarchy}
            onChange={(v) => go({ hierarchy: v })}
            options={[
              { value: "parents", label: "Parents only" },
              { value: "children", label: "Children only" },
            ]}
          />
          <Select
            label="Contacts"
            value={filters.hasContacts}
            onChange={(v) => go({ hasContacts: v })}
            options={[
              { value: "yes", label: "Has contacts" },
              { value: "no", label: "Nobody on file" },
            ]}
          />
          <Toggle checked={filters.mine} onChange={(v) => go({ mine: v, unowned: false })}>
            Only mine
          </Toggle>
          <Toggle checked={filters.unowned} onChange={(v) => go({ unowned: v, mine: false })}>
            Unclaimed only
          </Toggle>
        </div>
      ) : null}

      {/* ---- active chips + count ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">{total.toLocaleString()}</span>{" "}
          {total === 1 ? "company" : "companies"}
        </p>
        {active > 0 ? (
          <>
            <span className="text-muted-foreground">·</span>
            {chips(filters, options).map((chip) => (
              <button
                key={chip.key}
                onClick={() => go(chip.clear)}
                className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground transition-colors hover:bg-accent"
              >
                {chip.label}
                <X className="size-3" aria-hidden />
              </button>
            ))}
            <button
              onClick={() => router.push("/accounts")}
              className="text-xs font-medium text-primary hover:underline"
            >
              Clear all
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Select({
  label,
  value,
  onChange,
  options,
  allowEmpty = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  allowEmpty?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-set={value !== ""}
      className="h-9 max-w-44 rounded-md border bg-background px-2 text-sm outline-none focus:border-ring data-[set=true]:border-navy-500 data-[set=true]:bg-navy-50 data-[set=true]:font-medium dark:data-[set=true]:bg-navy-900"
    >
      {allowEmpty ? <option value="">{label}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label
      data-set={checked}
      className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm transition-colors hover:bg-accent data-[set=true]:border-navy-500 data-[set=true]:bg-navy-50 data-[set=true]:font-medium dark:data-[set=true]:bg-navy-900"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3.5 accent-navy-700"
      />
      {children}
    </label>
  );
}

function ColumnPicker({
  columns,
  onChange,
}: {
  columns: string[];
  onChange: (cols: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Choose columns"
        className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors hover:bg-accent"
      >
        <Columns3 className="size-3.5" aria-hidden />
        <span className="hidden sm:inline">Columns</span>
      </button>
      {open ? (
        <div className="absolute right-0 top-11 z-40 w-56 rounded-lg border bg-popover p-1.5 shadow-xl">
          {COLUMNS.map((c) => {
            const on = columns.includes(c.key);
            // The company name is the link to the record. Removing it would
            // leave a table nobody can navigate out of.
            const locked = c.key === "name";
            return (
              <label
                key={c.key}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm ${
                  locked ? "opacity-50" : "cursor-pointer hover:bg-accent"
                }`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={locked}
                  onChange={() =>
                    onChange(
                      on
                        ? columns.filter((k) => k !== c.key)
                        : COLUMNS.filter((d) => d.key === c.key || columns.includes(d.key)).map(
                            (d) => d.key,
                          ),
                    )
                  }
                  className="size-3.5 accent-navy-700"
                />
                {c.label}
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** One removable chip per active filter, labelled the way it was chosen. */
function chips(
  f: AccountFilters,
  options: FilterOptions,
): { key: string; label: string; clear: Partial<AccountFilters> }[] {
  const out: { key: string; label: string; clear: Partial<AccountFilters> }[] = [];
  const add = (key: string, label: string, clear: Partial<AccountFilters>) =>
    out.push({ key, label, clear });

  if (f.q) add("q", `“${f.q}”`, { q: "" });
  if (f.status) add("status", label(STATUS_OPTIONS, f.status), { status: "" });
  if (f.state) add("state", label(STATE_OPTIONS, f.state), { state: "" });
  if (f.stage) add("stage", `Stage: ${f.stage}`, { stage: "" });
  if (f.industry) add("industry", f.industry, { industry: "" });
  if (f.billingState) add("st", `State: ${f.billingState.toUpperCase()}`, { billingState: "" });
  if (f.city) add("city", f.city, { city: "" });
  if (f.owner)
    add("owner", options.owners.find((o) => o.id === f.owner)?.name ?? "Owner", { owner: "" });
  if (f.ownerLocation) add("loc", `Branch: ${f.ownerLocation}`, { ownerLocation: "" });
  if (f.creditStatus) add("credit", label(CREDIT_OPTIONS, f.creditStatus), { creditStatus: "" });
  if (f.national)
    add("national", f.national === "yes" ? "National" : "Not national", { national: "" });
  if (f.hierarchy)
    add("tree", f.hierarchy === "parents" ? "Parents only" : "Children only", { hierarchy: "" });
  if (f.hasContacts)
    add("contacts", f.hasContacts === "yes" ? "Has contacts" : "Nobody on file", {
      hasContacts: "",
    });
  if (f.idle) add("idle", label(IDLE_OPTIONS, f.idle), { idle: "" });
  if (f.mine) add("mine", "Only mine", { mine: false });
  if (f.unowned) add("unowned", "Unclaimed", { unowned: false });

  return out;
}

function label(options: { value: string; label: string }[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}
