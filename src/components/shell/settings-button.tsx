"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings2 } from "lucide-react";

/**
 * Settings, in the top right.
 *
 * It was buried in the avatar menu, which is where an application puts things
 * it does not expect anybody to use. Settings here is not that: it holds dark
 * mode, the status colours, and which emails reach you -- three things people
 * change in their first ten minutes and then hunt for again a week later.
 */
export function SettingsButton() {
  const pathname = usePathname();
  const active = pathname.startsWith("/settings");

  return (
    <Link
      href="/settings"
      aria-label="Settings"
      aria-current={active ? "page" : undefined}
      data-active={active}
      title="Settings"
      className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[active=true]:bg-accent data-[active=true]:text-foreground"
    >
      <Settings2 className="size-4.5" aria-hidden />
    </Link>
  );
}
