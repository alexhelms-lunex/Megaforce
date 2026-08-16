"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { visibleNav } from "./nav";
import { Logo } from "./logo";

export interface NavCounts {
  expiring: number;
  unlogged: number;
  review: number;
  requests: number;
}

/**
 * The navy rail.
 *
 * Counts are passed in from the server rather than fetched here, so the badges
 * are correct on first paint. A nav badge that appears a second late is a nav
 * badge nobody trusts, and these particular numbers -- accounts about to be
 * lost, calls not yet written up -- are the reason a broker opens the CRM.
 */
export function Sidebar({ role, counts }: { role: string; counts: NavCounts }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const sections = visibleNav(role);

  return (
    <aside
      data-collapsed={collapsed}
      className="sticky top-0 hidden h-screen shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex data-[collapsed=false]:w-60 data-[collapsed=true]:w-16"
    >
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
        <Logo compact={collapsed} />
      </div>

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 py-3">
        {sections.map((section) => (
          <div key={section.heading} className="mb-4">
            {!collapsed ? (
              <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/45">
                {section.heading}
              </p>
            ) : (
              <div className="mx-3 mb-2 border-t border-sidebar-border" />
            )}

            {section.items.map((item) => {
              // Exact match for the dashboard, prefix match for everything
              // else -- otherwise "/" lights up on every page.
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname === item.href || pathname.startsWith(`${item.href}/`);
              const count = item.badge ? counts[item.badge] : 0;
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  data-active={active}
                  className="group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-white"
                >
                  {active ? (
                    <span
                      aria-hidden
                      className="brand-accent-bar absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r"
                    />
                  ) : null}
                  <Icon className="size-4 shrink-0" aria-hidden />
                  {!collapsed ? <span className="truncate">{item.label}</span> : null}
                  {count > 0 ? (
                    <span
                      className={
                        collapsed
                          ? "absolute right-1.5 top-1.5 size-2 rounded-full bg-brand-400"
                          : "ml-auto rounded-full bg-brand-400 px-1.5 py-0.5 text-[10px] font-bold text-brand-950"
                      }
                    >
                      {collapsed ? "" : count > 99 ? "99+" : count}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-3 border-t border-sidebar-border px-4 py-3 text-xs text-sidebar-foreground/60 transition-colors hover:text-white"
      >
        {collapsed ? (
          <PanelLeftOpen className="size-4" aria-hidden />
        ) : (
          <>
            <PanelLeftClose className="size-4" aria-hidden />
            Collapse
          </>
        )}
      </button>
    </aside>
  );
}
