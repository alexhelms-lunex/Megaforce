"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/info-tip";
import { ROLES, type AdminUser } from "@/lib/roles";
import { createUser, resetPassword, setRole, updateUser } from "./actions";

interface Colleague {
  id: string;
  name: string;
  role: string;
}

/**
 * Add somebody, or change them.
 *
 * ---------------------------------------------------------------------------
 * One component for both, because the fields are the same and two forms drift.
 * What differs is what can be done alongside them: a new person can be given a
 * login as they are created; an existing one can have theirs reset.
 *
 * The role picker shows what each role SEES rather than only its name. "Who
 * can see whose accounts" is the most misunderstood thing in this application,
 * and the moment somebody is choosing between Broker and Manager is exactly
 * when the answer is worth having in front of them.
 * ---------------------------------------------------------------------------
 */
export function UserForm({
  user,
  colleagues,
  isSelf = false,
}: {
  /** Absent when adding somebody. */
  user?: AdminUser;
  colleagues: Colleague[];
  isSelf?: boolean;
}) {
  const editing = Boolean(user);
  const [pending, start] = useTransition();
  const [issued, setIssued] = useState<string | null>(null);
  const router = useRouter();

  const [form, setForm] = useState({
    full_name: user?.full_name ?? "",
    email: user?.email ?? "",
    role: user?.role ?? "broker",
    title: user?.title ?? "",
    phone: user?.phone ?? "",
    location: user?.location ?? "",
    manager_id: user?.manager_id ?? "",
    start_date: user?.start_date ?? "",
    prospect_limit: user?.prospect_limit != null ? String(user.prospect_limit) : "",
    create_login: true,
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function submit() {
    start(async () => {
      const limit = form.prospect_limit.trim() === "" ? null : Number(form.prospect_limit);
      if (limit !== null && (!Number.isFinite(limit) || limit < 0)) {
        toast.error("The prospect limit has to be a number.");
        return;
      }

      if (!editing) {
        const result = await createUser({
          email: form.email,
          full_name: form.full_name,
          role: form.role,
          manager_id: form.manager_id,
          location: form.location,
          title: form.title,
          phone: form.phone,
          start_date: form.start_date,
          prospect_limit: limit,
          create_login: form.create_login,
        });
        if (result.error) return void toast.error(result.error);
        if (result.password) setIssued(result.password);
        toast.success(result.message ?? "Added.");
        if (!result.password) router.push("/admin/users");
        else router.refresh();
        return;
      }

      // The role goes through its own function, which is where the last-admin
      // refusal lives. Sending it with the rest would turn that into a
      // constraint violation nobody can read.
      if (form.role !== user!.role) {
        const roleResult = await setRole(user!.id, form.role);
        if (roleResult.error) return void toast.error(roleResult.error);
      }

      const result = await updateUser(user!.id, {
        full_name: form.full_name,
        email: form.email,
        title: form.title,
        phone: form.phone,
        location: form.location,
        manager_id: form.manager_id,
        start_date: form.start_date,
        prospect_limit: limit,
      });
      if (result.error) return void toast.error(result.error);
      toast.success(result.message ?? "Saved.");
      router.refresh();
    });
  }

  const chosenRole = ROLES.find((r) => r.key === form.role);

  return (
    <div className="space-y-4">
      {issued ? (
        <Card className="border-brand-400/60">
          <CardContent className="py-4">
            <p className="text-sm font-semibold">Their password — shown once</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Nothing stores this in a form anybody can read back. Copy it now and give it to
              them; they can change it once they are in.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <code className="rounded-lg bg-muted px-3 py-1.5 font-mono text-sm">{issued}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(issued);
                  toast.success("Copied.");
                }}
              >
                <Copy className="size-3.5" aria-hidden />
                Copy
              </Button>
              <Link
                href="/admin/users"
                className="ml-auto text-sm font-medium text-primary hover:underline"
              >
                Done →
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Who they are</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required>
            <input
              value={form.full_name}
              onChange={(e) => set("full_name", e.target.value)}
              className={inputClass}
              placeholder="Dana Whitfield"
            />
          </Field>

          <Field
            label="Email"
            required
            help="Also the sign-in address. Changing it here changes both, so they keep getting in."
          >
            <input
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              className={inputClass}
              placeholder="dana@example.com"
            />
          </Field>

          <Field label="Job title">
            <input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              className={inputClass}
              placeholder="Senior Broker"
            />
          </Field>

          <Field label="Phone">
            <input
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
              className={inputClass}
              placeholder="(704) 555-0142"
            />
          </Field>

          <Field label="Branch" help="Used to group the reports by office.">
            <input
              value={form.location}
              onChange={(e) => set("location", e.target.value)}
              className={inputClass}
              placeholder="Charlotte"
            />
          </Field>

          <Field label="Start date" help="Their tier, and so their prospect limit, follows from this.">
            <input
              type="date"
              value={form.start_date}
              onChange={(e) => set("start_date", e.target.value)}
              className={inputClass}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5 text-base">
            What they can do
            <InfoTip
              side="bottom"
              text="The role decides what they see. The manager decides whose accounts roll up to whom — a manager sees everyone beneath them in this chart, however many levels down."
            />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {ROLES.map((r) => (
              <label
                key={r.key}
                className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors ${
                  form.role === r.key ? "border-primary bg-accent/50" : "hover:bg-accent/30"
                }`}
              >
                <input
                  type="radio"
                  name="role"
                  checked={form.role === r.key}
                  onChange={() => set("role", r.key)}
                  className="mt-0.5 size-4 accent-[var(--primary)]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{r.label}</span>
                  <span className="block text-xs text-muted-foreground">{r.summary}</span>
                </span>
              </label>
            ))}
          </div>

          {chosenRole ? (
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Visibility: </span>
              {chosenRole.scope}
            </p>
          ) : null}

          {isSelf && form.role !== "admin" ? (
            <p className="rounded-lg border border-amber-400/60 bg-amber-50 px-3 py-2 text-xs dark:bg-amber-950/30">
              You are editing your own account. The database will refuse to remove your own
              administrator role — ask another admin to do it.
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Reports to" help="Leave blank for somebody at the top of the chart.">
              <select
                value={form.manager_id}
                onChange={(e) => set("manager_id", e.target.value)}
                className={inputClass}
              >
                <option value="">Nobody</option>
                {colleagues
                  .filter((c) => c.id !== user?.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.role})
                    </option>
                  ))}
              </select>
            </Field>

            <Field
              label="Prospect limit"
              help="How many accounts they may hold. Blank means the tier default for their start date."
            >
              <input
                type="number"
                min={0}
                value={form.prospect_limit}
                onChange={(e) => set("prospect_limit", e.target.value)}
                className={inputClass}
                placeholder="200"
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      {!editing ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Getting them in</CardTitle>
          </CardHeader>
          <CardContent>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={form.create_login}
                onChange={(e) => set("create_login", e.target.checked)}
                className="mt-0.5 size-4 accent-[var(--primary)]"
              />
              <span>
                <span className="block text-sm font-medium">Create a login now</span>
                <span className="block text-xs text-muted-foreground">
                  A password is generated and shown to you once. Leave this off for somebody
                  whose first day has not arrived — they can own accounts before they can sign
                  in, and you can add the login later from their row.
                </span>
              </span>
            </label>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Their login</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">
              {user!.has_login
                ? "They can sign in with the email address above."
                : "They have no login yet, so they cannot sign in."}
            </p>
            {user!.has_login ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const result = await resetPassword(user!.id);
                    if (result.error) return void toast.error(result.error);
                    setIssued(result.password ?? null);
                    toast.success(result.message ?? "Password reset.");
                  })
                }
              >
                <KeyRound className="size-3.5" aria-hidden />
                Set a new password
              </Button>
            ) : null}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end gap-2">
        <Link
          href="/admin/users"
          className="inline-flex h-9 items-center rounded-full border px-4 text-sm font-medium transition-colors hover:bg-accent"
        >
          Cancel
        </Link>
        <Button onClick={submit} disabled={pending}>
          {pending ? "Saving…" : editing ? "Save changes" : "Add them"}
        </Button>
      </div>
    </div>
  );
}

const inputClass =
  "h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring";

function Field({
  label,
  help,
  required,
  children,
}: {
  label: string;
  help?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </span>
      {children}
      {help ? <span className="mt-1 block text-xs text-muted-foreground">{help}</span> : null}
    </label>
  );
}
