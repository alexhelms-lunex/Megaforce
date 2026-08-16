import Link from "next/link";

export interface TabSpec {
  key: string;
  label: string;
  count?: number;
}

/**
 * Tabs as links, not state.
 *
 * A tab that lives in component state cannot be linked to, and "look at the
 * Contacts tab on Halvorsen" is a sentence people say every day. Putting the
 * tab in the URL makes that a paste-able link, gives the back button something
 * sensible to do, and lets the command palette drop somebody straight onto the
 * contact they searched for.
 */
export function AccountTabs({
  tabs,
  active,
  basePath,
}: {
  tabs: TabSpec[];
  active: string;
  basePath: string;
}) {
  return (
    <div className="scrollbar-thin -mb-px flex gap-1 overflow-x-auto border-b">
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.key === "overview" ? basePath : `${basePath}?tab=${t.key}`}
            scroll={false}
            data-active={on}
            className="shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground data-[active=true]:border-navy-700 data-[active=true]:text-foreground"
          >
            {t.label}
            {typeof t.count === "number" ? (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
                {t.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
