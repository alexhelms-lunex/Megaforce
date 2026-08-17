/**
 * What a screen looks like while it is being fetched.
 *
 * ===========================================================================
 * WHY THIS EXISTS AT ALL
 *
 * Alex, twice: "Response times switching tabs and updating the reporting are
 * super slow" and "load times are long between pages. how can we make this
 * website feel very responsive."
 *
 * The second complaint has a cause that is not the first one. Every page in
 * this application is `export const dynamic = "force-dynamic"` -- it has to be,
 * since every one of them reads rows that depend on who is asking. In the App
 * Router a dynamic route with NO loading boundary does not render anything
 * until the server has finished: the browser stays on the old page, the click
 * appears to have done nothing, and people click again.
 *
 * There was no loading.tsx anywhere in this project. So the whole of every
 * server render -- auth, preferences, badge counts, then the page's own
 * queries -- happened before a single pixel moved. Half a second of real work
 * reads as a broken link.
 *
 * A loading boundary changes that with no work removed at all. The shell,
 * the sidebar and the title paint instantly, the skeleton stands in for the
 * part that is still coming, and the same half second reads as a page
 * arriving. It also lets Next prefetch the boundary on hover, so by the time
 * the click lands the frame is already there.
 *
 * WHY THE SHAPES MATTER
 *
 * A skeleton that does not match what replaces it makes the page jump when the
 * data lands, which is worse than a spinner. These mirror the real layouts --
 * a title of about the right width, a filter bar of about the right height, a
 * table with the right number of columns.
 * ===========================================================================
 */

/** One shimmering block. Everything else here is made of these. */
export function Bar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

export function PageHeadingSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className="space-y-2">
      <Bar className={wide ? "h-8 w-72" : "h-8 w-48"} />
      <Bar className="h-4 w-96 max-w-full" />
    </div>
  );
}

/**
 * A table standing in for a list.
 *
 * Eight rows rather than the page size. The skeleton is there to say "a table
 * is coming", and drawing two hundred shimmering rows to say it costs more to
 * render than some of the pages it stands in for.
 */
export function TableSkeleton({ columns = 6, rows = 8 }: { columns?: number; rows?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex gap-3 border-b bg-muted/40 px-4 py-3">
        {Array.from({ length: columns }, (_, i) => (
          <Bar key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
          {Array.from({ length: columns }, (_, c) => (
            <Bar
              key={c}
              // Varied widths, so it reads as content rather than as a grid.
              // Deterministic from the indices: Math.random() here would
              // produce different markup on the server and the client and
              // React would report a hydration mismatch.
              className={`h-3.5 flex-1 ${(r + c) % 3 === 0 ? "opacity-60" : ""}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="space-y-3 rounded-xl border bg-card p-4">
          <Bar className="h-3 w-24" />
          <Bar className="h-8 w-20" />
          <Bar className="h-3 w-28" />
        </div>
      ))}
    </div>
  );
}

export function FilterBarSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
      <Bar className="h-9 min-w-60 flex-1" />
      <Bar className="h-9 w-16" />
      <Bar className="h-9 w-40" />
      <Bar className="h-9 w-24" />
    </div>
  );
}

export function FeedSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="rounded-lg border bg-card">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-3 border-b px-5 py-3 last:border-b-0">
          <Bar className="size-7 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Bar className="h-3.5 w-56 max-w-full" />
            <Bar className="h-3 w-80 max-w-full opacity-60" />
          </div>
          <Bar className="h-3 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}
