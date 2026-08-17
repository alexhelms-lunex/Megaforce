"use client";

import { useState, useTransition } from "react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bell, Check, Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/info-tip";
import { LIFECYCLE, type LifecycleState } from "@/lib/lifecycle";
import {
  ALERT_TYPES,
  LANDING_OPTIONS,
  TIMEZONES,
  type Preferences,
} from "@/lib/preferences";
import { PRESETS } from "@/lib/account-filters";
import { saveAlert, savePreferences } from "./actions";

/**
 * Personal settings.
 *
 * Everything saves the moment it is changed. No Save button, because a settings
 * screen with one has two states -- what you see and what is stored -- and the
 * gap between them is where people lose work. The toast is the confirmation.
 *
 * Optimistic: the control moves immediately and rolls back if the write fails.
 * A theme toggle that waits for a round trip feels broken even when it works.
 */
export function SettingsForm({ initial }: { initial: Preferences }) {
  const [prefs, setPrefs] = useState(initial);
  const [, start] = useTransition();
  const { setTheme } = useTheme();
  const router = useRouter();

  function update(patch: Partial<Preferences>) {
    const previous = prefs;
    setPrefs((p) => ({ ...p, ...patch }));
    start(async () => {
      const result = await savePreferences(patch);
      if (result.error) {
        setPrefs(previous);
        toast.error(result.error);
      } else {
        router.refresh();
      }
    });
  }

  function toggleAlert(key: string, channel: "app" | "email", value: boolean) {
    const previous = prefs.alerts;
    setPrefs((p) => ({
      ...p,
      alerts: { ...p.alerts, [key]: { ...(p.alerts[key] ?? { app: true, email: true }), [channel]: value } },
    }));
    start(async () => {
      const result = await saveAlert(key, channel, value);
      if (result.error) {
        setPrefs((p) => ({ ...p, alerts: previous }));
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-5">
      {/* ---- appearance ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Appearance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Row label="Theme" help="Dark mode follows your machine unless you pick one.">
            <div className="flex gap-1 rounded-full border p-0.5">
              {[
                { value: "system", label: "Auto", icon: Monitor },
                { value: "light", label: "Light", icon: Sun },
                { value: "dark", label: "Dark", icon: Moon },
              ].map((o) => {
                const Icon = o.icon;
                const on = prefs.theme === o.value;
                return (
                  <button
                    key={o.value}
                    onClick={() => {
                      // next-themes writes localStorage so the choice applies
                      // before the first paint on the next load; the database
                      // copy is what makes it follow you to another machine.
                      setTheme(o.value);
                      update({ theme: o.value as Preferences["theme"] });
                    }}
                    data-active={on}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent data-[active=true]:bg-navy-700 data-[active=true]:text-white"
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {o.label}
                  </button>
                );
              })}
            </div>
          </Row>

          <Row
            label="Row height"
            help="Compact fits about a third more rows on screen. Useful on a laptop, hard on the eyes all day."
          >
            <Choice
              value={prefs.density}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
              onChange={(v) => update({ density: v as Preferences["density"] })}
            />
          </Row>

          <Row
            label="Collapse the sidebar by default"
            help="Starts every session with the navigation rail narrowed to icons."
          >
            <Toggle
              checked={prefs.compact_sidebar}
              onChange={(v) => update({ compact_sidebar: v })}
            />
          </Row>

          <Row
            label="Show the info markers"
            help="The small i beside metrics and filters. Turn them off once the team knows the system."
          >
            <Toggle checked={prefs.show_tips} onChange={(v) => update({ show_tips: v })} />
          </Row>
        </CardContent>
      </Card>

      {/* ---- status colours ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5 text-base">
            Status colours
            <InfoTip k="lifecycleState" />
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Roughly one man in twelve cannot separate the ambers from the reds. Every flag also
            carries a word and a number, but if these colours do not work for you, change them.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {(Object.keys(LIFECYCLE) as LifecycleState[]).map((state) => {
            const custom = prefs.lifecycle_colors[state];
            return (
              <div key={state} className="flex flex-wrap items-center gap-3">
                <span
                  className={`inline-flex min-w-32 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${LIFECYCLE[state].className}`}
                  style={custom ? { backgroundColor: custom, borderColor: custom } : undefined}
                >
                  <span
                    aria-hidden
                    className={`size-1.5 rounded-full ${LIFECYCLE[state].dotClassName}`}
                  />
                  {LIFECYCLE[state].label}
                </span>
                <input
                  type="color"
                  aria-label={`Colour for ${LIFECYCLE[state].label}`}
                  value={custom ?? "#ffffff"}
                  onChange={(e) =>
                    update({
                      lifecycle_colors: { ...prefs.lifecycle_colors, [state]: e.target.value },
                    })
                  }
                  className="size-8 cursor-pointer rounded border bg-transparent"
                />
                {custom ? (
                  <button
                    onClick={() => {
                      const next = { ...prefs.lifecycle_colors };
                      delete next[state];
                      update({ lifecycle_colors: next });
                    }}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                  >
                    <RotateCcw className="size-3" aria-hidden />
                    Reset
                  </button>
                ) : null}
                <span className="text-xs text-muted-foreground">{LIFECYCLE[state].meaning}</span>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ---- alerts ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5 text-base">
            <Bell className="size-4" aria-hidden />
            Alerts
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Pick which events reach you, and how. Anything switched off here still happens — you
            simply are not told about it.
          </p>
        </CardHeader>
        <CardContent className="px-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-6 py-2 font-medium">Event</th>
                <th className="w-20 px-3 py-2 text-center font-medium">In app</th>
                <th className="w-20 px-6 py-2 text-center font-medium">Email</th>
              </tr>
            </thead>
            <tbody>
              {ALERT_TYPES.map((a) => {
                const value = prefs.alerts[a.key] ?? { app: true, email: true };
                return (
                  <tr key={a.key} className="border-b last:border-b-0">
                    <td className="px-6 py-3">
                      <span className="font-medium">{a.label}</span>
                      <span className="block text-xs text-muted-foreground">{a.help}</span>
                    </td>
                    <td className="px-3 py-3 text-center">
                      <Toggle
                        checked={value.app}
                        onChange={(v) => toggleAlert(a.key, "app", v)}
                      />
                    </td>
                    <td className="px-6 py-3 text-center">
                      <Toggle
                        checked={value.email}
                        onChange={(v) => toggleAlert(a.key, "email", v)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* ---- workflow ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Working preferences</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Row label="Open on" help="The screen you land on after signing in.">
            <Select
              value={prefs.default_landing}
              options={LANDING_OPTIONS}
              onChange={(v) => update({ default_landing: v })}
            />
          </Row>

          <Row label="Accounts opens on" help="Which preset the Accounts screen starts with.">
            <Select
              value={prefs.default_account_preset}
              options={PRESETS.map((p) => ({ value: p.key, label: p.label }))}
              onChange={(v) => update({ default_account_preset: v })}
            />
          </Row>

          <Row label="Timezone" help="Used for dates on screen and for when your morning email arrives.">
            <Select
              value={prefs.timezone}
              options={TIMEZONES.map((t) => ({ value: t, label: t.replace("America/", "").replace("_", " ") }))}
              onChange={(v) => update({ timezone: v })}
            />
          </Row>

          <Row
            label="Warn me when I am at my limit"
            help="Stops you claiming past your tier's cap without noticing."
          >
            <Toggle checked={prefs.warn_at_limit} onChange={(v) => update({ warn_at_limit: v })} />
          </Row>

          <Row
            label="Sound when a call lands"
            help="A short chime when RingCentral drops a new call into the dock."
          >
            <Toggle checked={prefs.sound_on_call} onChange={(v) => update({ sound_on_call: v })} />
          </Row>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Row({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-brand-500" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`inline-block size-4 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function Choice({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-full border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          data-active={value === o.value}
          className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent data-[active=true]:bg-navy-700 data-[active=true]:text-white"
        >
          {value === o.value ? <Check className="size-3" aria-hidden /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 min-w-44 rounded-md border bg-background px-2 text-sm"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
