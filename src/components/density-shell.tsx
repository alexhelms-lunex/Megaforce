"use client";

import { usePreferences } from "@/components/preferences-provider";

/**
 * The app frame, carrying the live row-height setting.
 *
 * A thin client wrapper for one attribute, and it earns its file: the layout
 * is a server component, so `data-density` written there is fixed until the
 * route re-renders. Read from context instead, the tables tighten the instant
 * the switch moves rather than on the next navigation.
 */
export function DensityShell({ children }: { children: React.ReactNode }) {
  const { density } = usePreferences();
  return (
    <div className="flex min-h-screen" data-density={density}>
      {children}
    </div>
  );
}
