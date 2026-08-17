/**
 * Reading the analytics engine.
 *
 * The shape mirrors 0019: a WINDOW, a set of METRICS, and a set of DIMENSIONS.
 * Everything the screen shows is a combination of the three, which is why there
 * is one fetcher per concept rather than one per card.
 *
 * All of them run SECURITY INVOKER, so row level security decides what a caller
 * can see before any of this. `scope` narrows further; it cannot widen.
 */
import { createClient } from "@/lib/supabase/server";
import {
  METRICS,
  classify,
  percentChange,
  rate,
  type BreakdownRow,
  type Grain,
  type MetricValue,
  type ReportError,
  type Scope,
  type SeriesPoint,
} from "./report-metrics";

export * from "./report-metrics";

export async function fetchTotals(
  from: string,
  to: string,
  scope: Scope,
): Promise<{ metrics: MetricValue[]; error: ReportError | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("report_window", {
    p_from: from,
    p_to: to,
    p_scope: scope,
  });

  if (error) return { metrics: [], error: classify(error.message) };

  const raw = new Map<string, { value: number; previous: number | null }>();
  for (const row of (data ?? []) as { metric: string; value: number; previous: number | null }[]) {
    raw.set(row.metric, {
      value: Number(row.value ?? 0),
      previous: row.previous === null ? null : Number(row.previous),
    });
  }

  // Hit rate is derived rather than returned, so it cannot disagree with the
  // two figures it is made of -- which are sitting on the same screen.
  const calls = raw.get("calls");
  const approved = raw.get("approved");
  raw.set("hit_rate", {
    value: rate(approved?.value, calls?.value),
    previous:
      calls?.previous == null || approved?.previous == null
        ? null
        : rate(approved.previous, calls.previous),
  });

  const metrics = METRICS.map((m) => {
    const found = raw.get(m.key) ?? { value: 0, previous: null };
    return {
      key: m.key,
      label: m.label,
      hint: m.hint,
      value: found.value,
      previous: found.previous,
      delta: percentChange(found.value, found.previous),
      good: m.good,
      suffix: "suffix" in m ? m.suffix : undefined,
    } satisfies MetricValue;
  });

  return { metrics, error: null };
}

export async function fetchSeries(
  from: string,
  to: string,
  scope: Scope,
  grain: Grain,
): Promise<{ points: SeriesPoint[]; error: ReportError | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("report_series", {
    p_from: from,
    p_to: to,
    p_scope: scope,
    p_grain: grain,
  });

  if (error) return { points: [], error: classify(error.message) };

  const points = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    bucket: String(r.bucket),
    calls: Number(r.calls ?? 0),
    approved: Number(r.approved ?? 0),
    emails: Number(r.emails ?? 0),
    claimed: Number(r.claimed ?? 0),
    lost: Number(r.lost ?? 0),
  }));

  return { points, error: null };
}

export async function fetchBreakdown(
  from: string,
  to: string,
  scope: Scope,
  dimension: string,
  search: string,
  limit: number,
  offset: number,
): Promise<{ rows: BreakdownRow[]; total: number; error: ReportError | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("report_breakdown", {
    p_from: from,
    p_to: to,
    p_scope: scope,
    p_dimension: dimension,
    p_search: search,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) return { rows: [], total: 0, error: classify(error.message) };

  const raw = (data ?? []) as Record<string, unknown>[];
  return {
    error: null,
    total: raw.length > 0 ? Number(raw[0].total_rows ?? raw.length) : 0,
    rows: raw.map((r) => ({
      key: String(r.key),
      label: String(r.label ?? r.key),
      calls: Number(r.calls ?? 0),
      approved: Number(r.approved ?? 0),
      hitRate: Number(r.hit_rate ?? 0),
      accounts: Number(r.accounts ?? 0),
      claimed: Number(r.claimed ?? 0),
      lost: Number(r.lost ?? 0),
    })),
  };
}

export interface Dimension {
  key: string;
  label: string;
  hint: string;
}

export async function fetchDimensions(): Promise<Dimension[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("report_dimensions");
  if (error || !data) {
    // The menu is chrome. If it cannot be read, the screen still works on the
    // default dimension rather than failing whole.
    return [{ key: "broker", label: "Broker", hint: "" }];
  }
  return (data as Dimension[]).map((d) => ({ key: d.key, label: d.label, hint: d.hint }));
}

