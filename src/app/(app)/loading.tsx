import { PageHeadingSkeleton, TableSkeleton } from "@/components/skeleton";

/**
 * The fallback boundary for every screen in the application.
 *
 * A route with its own loading.tsx uses that one; everything else lands here.
 * Having a catch-all matters more than having a perfect shape per screen: a
 * missing boundary means the click does nothing at all until the server
 * finishes, and a new page added next month inherits this rather than
 * inheriting the old dead-screen behaviour.
 */
export default function Loading() {
  return (
    <div className="space-y-4">
      <PageHeadingSkeleton />
      <TableSkeleton />
    </div>
  );
}
