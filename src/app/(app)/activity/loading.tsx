import { FeedSkeleton, FilterBarSkeleton, PageHeadingSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <div className="space-y-4">
      <PageHeadingSkeleton />
      <FilterBarSkeleton />
      <FeedSkeleton />
    </div>
  );
}
