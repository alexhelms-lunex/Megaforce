import { ProspectBrowser } from "@/app/(app)/prospects/browser";

export const dynamic = "force-dynamic";

/**
 * "Your customers", which is the Prospects list with one scope forced.
 *
 * Its own route rather than a query parameter on Prospects, because Alex asked
 * for two primary tabs and a tab is a place -- it has an address, it can be
 * bookmarked, and the browser's back button steps through it. A tab that is
 * really a filter behaves subtly differently from every other tab in the
 * application and people notice without being able to say why.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ProspectBrowser tab="customers" searchParams={await searchParams} />;
}
