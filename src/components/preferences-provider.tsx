"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_PREFERENCES, type Preferences } from "@/lib/preferences";

/**
 * A person's own settings, live.
 *
 * ---------------------------------------------------------------------------
 * The settings screen wrote every one of these to the database and NOTHING
 * read them back. Toggling "collapse the sidebar" saved a row, showed a
 * success state, and changed nothing on any screen -- which is worse than not
 * offering the setting, because the person concludes the application ignores
 * them rather than that the feature is missing.
 *
 * The first fix put the saved values into context from the server layout. That
 * made the settings REAL but not IMMEDIATE: the sidebar changed on the next
 * navigation, because a server-rendered layout only re-reads when the route
 * re-renders. Flipping a switch and watching nothing happen is the same
 * experience as the original bug, whatever the cause.
 *
 * So the context holds state rather than a value. The server seeds it; the
 * settings screen pushes changes into it the instant a control moves; the
 * database write happens separately and can take as long as it likes. Nothing
 * on screen is ever waiting on a round trip.
 * ---------------------------------------------------------------------------
 */
interface PreferencesContextValue {
  preferences: Preferences;
  /** Apply immediately, everywhere. Does not save -- the screen does that. */
  apply: (patch: Partial<Preferences>) => void;
}

const PreferencesContext = createContext<PreferencesContextValue>({
  preferences: DEFAULT_PREFERENCES,
  apply: () => {},
});

export function PreferencesProvider({
  value,
  children,
}: {
  value: Preferences;
  children: React.ReactNode;
}) {
  const [preferences, setPreferences] = useState<Preferences>(value);

  // Follow the server when it hands down a new set -- after a save, or after
  // signing in as somebody else. Compared by content rather than by reference
  // because the layout builds a fresh object on every render.
  const signature = JSON.stringify(value);
  useEffect(() => {
    setPreferences(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const apply = useCallback((patch: Partial<Preferences>) => {
    setPreferences((p) => ({ ...p, ...patch }));
  }, []);

  const context = useMemo(() => ({ preferences, apply }), [preferences, apply]);

  return <PreferencesContext.Provider value={context}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): Preferences {
  return useContext(PreferencesContext).preferences;
}

/** For the settings screen, which needs to push changes as well as read them. */
export function useApplyPreferences(): (patch: Partial<Preferences>) => void {
  return useContext(PreferencesContext).apply;
}
