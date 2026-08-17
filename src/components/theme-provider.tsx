"use client";

import { ThemeProvider as NextThemes } from "next-themes";

/**
 * Dark mode.
 *
 * `attribute="class"` puts `.dark` on <html>, which is what the token blocks in
 * globals.css key off. `disableTransitionOnChange` stops every colour on the
 * page animating at once when somebody flips the switch — without it the toggle
 * looks broken rather than instant.
 *
 * The choice is persisted twice on purpose: next-themes writes localStorage so
 * the correct theme is applied before the first paint and nobody gets a white
 * flash, and the preference is also saved to the database so it follows the
 * person to a second machine.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemes
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="megaforce-theme"
    >
      {children}
    </NextThemes>
  );
}
