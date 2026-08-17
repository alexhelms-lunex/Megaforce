import { PageHeadingSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <div className="space-y-4">
      <PageHeadingSkeleton />
      <TableSkeleton columns={5} rows={6} />
    </div>
  );
}
