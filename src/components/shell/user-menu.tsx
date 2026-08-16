"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut, Settings, User as UserIcon } from "lucide-react";

const ROLE_LABEL: Record<string, string> = {
  broker: "Broker",
  manager: "Sales manager",
  credit: "Credit",
  admin: "Administrator",
};

export function UserMenu({
  name,
  email,
  role,
  location,
  signOut,
}: {
  name: string;
  email: string;
  role: string;
  location: string | null;
  signOut: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md py-1 pl-1 pr-2 transition-colors hover:bg-accent"
      >
        <Avatar name={name} />
        <span className="hidden text-left leading-tight sm:block">
          <span className="block text-xs font-semibold">{name}</span>
          <span className="block text-[11px] text-muted-foreground">
            {ROLE_LABEL[role] ?? role}
          </span>
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
      </button>

      {open ? (
        <div className="absolute right-0 top-11 z-50 w-64 overflow-hidden rounded-lg border bg-popover shadow-xl">
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <Avatar name={name} size="lg" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{name}</p>
              <p className="truncate text-xs text-muted-foreground">{email}</p>
              {location ? (
                <p className="truncate text-xs text-muted-foreground">{location}</p>
              ) : null}
            </div>
          </div>
          <div className="p-1">
            <Link
              href="/me"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent"
            >
              <UserIcon className="size-4 text-muted-foreground" aria-hidden />
              My book and limits
            </Link>
            {role === "admin" ? (
              <Link
                href="/admin"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <Settings className="size-4 text-muted-foreground" aria-hidden />
                Administration
              </Link>
            ) : null}
          </div>
          <form action={signOut} className="border-t p-1">
            <button className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent">
              <LogOut className="size-4 text-muted-foreground" aria-hidden />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Initials on navy. No photo upload anywhere in this build, so an avatar is
 * always derivable and never a broken image.
 */
function Avatar({ name, size = "sm" }: { name: string; size?: "sm" | "lg" }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full bg-navy-700 font-semibold text-white ${
        size === "lg" ? "size-10 text-sm" : "size-7 text-[11px]"
      }`}
    >
      {initials || "?"}
    </span>
  );
}
