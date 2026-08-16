"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { visibleNav } from "./nav";
import { Logo } from "./logo";
import type { NavCounts } from "./sidebar";

/** The same nav as the rail, behind a hamburger, for phones and narrow windows. */
export function MobileNav({ role, counts }: { role: string; counts: NavCounts }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Navigating should close the drawer. Without this it stays open over the
  // page the user just asked for.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent md:hidden"
      >
        <Menu className="size-5" aria-hidden />
      </button>

      {open ? (
        <>
          <div
            className="fixed inset-0 z-50 bg-navy-950/50 md:hidden"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-sidebar text-sidebar-foreground md:hidden">
            <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
              <Logo />
              <button
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="ml-auto text-sidebar-foreground/70 hover:text-white"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 py-3">
              {visibleNav(role).map((section) => (
                <div key={section.heading} className="mb-4">
                  <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/45">
                    {section.heading}
                  </p>
                  {section.items.map((item) => {
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
                        data-active={active}
                        className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent data-[active=true]:bg-sidebar-accent data-[active=true]:text-white"
                      >
                        <Icon className="size-4 shrink-0" aria-hidden />
                        {item.label}
                        {count > 0 ? (
                          <span className="ml-auto rounded-full bg-brand-400 px-1.5 py-0.5 text-[10px] font-bold text-brand-950">
                            {count > 99 ? "99+" : count}
                          </span>
                        ) : null}
                      </Link>
                    );
                  })}
                </div>
              ))}
            </nav>
          </div>
        </>
      ) : null}
    </>
  );
}
