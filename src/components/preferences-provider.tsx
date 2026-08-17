"use client";

import { createContext, useContext } from "react";
import { DEFAULT_PREFERENCES, type Preferences } from "@/lib/preferences";

/**
 * A person's own settings, available to any component that renders for them.
 *
 * ---------------------------------------------------------------------------
 * The settings screen wrote every one of these to the database and NOTHING
 * read them back. Toggling "collapse the sidebar" saved a row, showed a
 * success state, and changed nothing on any screen -- which is worse than not
 * offering the setting, because the person now believes the application
 * ignores them rather than that the feature is missing.
 *
 * The cause was structural rather than an oversight: the settings live in the
 * database, the components that need them are client components deep in the
 * tree, and there was no route between the two. One context, filled once by
 * the server layout, is that route. Anything needing a preference reads it
 * here rather than fetching its own copy.
 *
 * Defaults are merged in, so a person who has never opened the settings screen
 * -- and therefore has no row -- gets the same experience as everyone else
 * instead of a screen full of undefined.
 * ---------------------------------------------------------------------------
 */
const PreferencesContext = createContext<Preferences>(DEFAULT_PREFERENCES);

export function PreferencesProvider({
  value,
  children,
}: {
  value: Preferences;
  children: React.ReactNode;
}) {
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): Preferences {
  return useContext(PreferencesContext);
}
