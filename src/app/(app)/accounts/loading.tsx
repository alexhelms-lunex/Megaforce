import { FilterBarSkeleton, PageHeadingSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1600px] space-y-4">
      <PageHeadingSkeleton wide />
      <FilterBarSkeleton />
      <TableSkeleton columns={7} />
    </div>
  );
}
