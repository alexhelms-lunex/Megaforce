import { ProspectBrowser } from "./browser";

export const dynamic = "force-dynamic";

export default async function ProspectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ProspectBrowser tab="prospects" searchParams={await searchParams} />;
}
