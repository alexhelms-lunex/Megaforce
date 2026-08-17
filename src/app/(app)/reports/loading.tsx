import { Bar, CardsSkeleton, PageHeadingSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <PageHeadingSkeleton />
        <Bar className="h-8 w-96 max-w-full rounded-full" />
      </div>
      <CardsSkeleton count={8} />
      <div className="rounded-xl border bg-card p-5">
        <Bar className="h-4 w-28" />
        <Bar className="mt-4 h-[260px] w-full" />
      </div>
      <TableSkeleton columns={7} rows={6} />
    </div>
  );
}
