"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, RotateCcw, UserMinus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/info-tip";
import { ROLES, ROLE_BADGE, ROLE_LABEL, type AdminUser } from "@/lib/roles";
import { runAction } from "@/lib/run-action";
import { bulkAction, createLogin, deactivateUser, reactivateUser } from "./actions";
import { DeactivateDialog } from "./deactivate-dialog";

/**
 * The list.
 *
 * ---------------------------------------------------------------------------
 * The checkbox column and the bulk-actions bar are the parts worth being
 * careful about. Selecting eight people and pressing "Deactivate" is one
 * click away from returning several hundred accounts to the pool, so:
 *
 *   - The action bar only appears once something is selected, and says how
 *     many. A bar that is always there gets pressed by accident.
 *   - Deactivation always goes through the dialog, even in bulk, because
 *     "what happens to their accounts" has no safe default to assume.
 *   - The signed-in administrator's own row cannot be selected. Locking
 *     yourself out is refused by the database anyway, but a checkbox that
 *     leads only to a refusal is a checkbox that should not be there.
 * ---------------------------------------------------------------------------
 */
export function UserTable({
  users,
  colleagues,
  currentUserId,
  page,
  pages,
  total,
  params,
}: {
  users: AdminUser[];
  colleagues: { id: string; name: string; role: string }[];
  currentUserId: string;
  page: number;
  pages: number;
  total: number;
  params: Record<string, string | string[] | undefined>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<AdminUser | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const selectable = users.filter((u) => u.id !== currentUserId);
  const allSelected = selectable.length > 0 && selected.size === selectable.length;

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function run(
    label: string,
    fn: () => Promise<{ ok?: true; message?: string; error?: string; password?: string }>,
  ) {
    start(async () => {
      // Through runAction, so a rejected action is a toast rather than the
      // whole screen being replaced by an error boundary.
      const result = await runAction(fn, { success: label, label: "That did not work" });
      if (!result) return;
      setSelected(new Set());
      router.refresh();
    });
  }

  return (
    <>
      {selected.size > 0 ? (
        <div className="chrome-blur sticky top-14 z-30 flex flex-wrap items-center gap-2 rounded-xl border bg-card/90 px-3 py-2 shadow-sm">
          <span className="text-sm font-medium">
            {selected.size} selected
          </span>
          <span className="text-xs text-muted-foreground">Change role to</span>
          {ROLES.map((r) => (
            <Button
              key={r.key}
              size="xs"
              variant="outline"
              disabled={pending}
              onClick={() => run("Roles changed.", () => bulkAction([...selected], "role", r.key))}
            >
              {r.label}
            </Button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <Button
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => run("Reactivated.", () => bulkAction([...selected], "reactivate"))}
          >
            Reactivate
          </Button>
          <Button
            size="xs"
            variant="destructive"
            disabled={pending}
            onClick={() =>
              run("Deactivated, accounts released.", () =>
                bulkAction([...selected], "deactivate", "release"),
              )
            }
          >
            Deactivate &amp; release their books
          </Button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-2xl border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select everyone on this page"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(selectable.map((u) => u.id)))
                  }
                  className="size-4 rounded border-input accent-[var(--primary)]"
                />
              </th>
              <th className="px-3 py-2.5 font-medium">Name</th>
              <th className="px-3 py-2.5 font-medium">
                <span className="inline-flex items-center gap-1">
                  Role
                  <InfoTip
                    side="bottom"
                    text="Decides what they can see and change. A broker sees their own accounts; a manager sees their whole reporting line; credit and admins see everything."
                  />
                </span>
              </th>
              <th className="px-3 py-2.5 font-medium">Reports to</th>
              <th className="px-3 py-2.5 font-medium">Branch</th>
              <th className="px-3 py-2.5 text-right font-medium">
                <span className="inline-flex items-center gap-1">
                  Accounts
                  <InfoTip
                    side="bottom"
                    text="How much book they are holding right now. The question behind every conversation about whether somebody can take more."
                  />
                </span>
              </th>
              <th className="px-3 py-2.5 text-right font-medium">Calls 30d</th>
              <th className="px-3 py-2.5 font-medium">
                <span className="inline-flex items-center gap-1">
                  Login
                  <InfoTip
                    side="bottom"
                    text="A profile owns accounts and logs activity. A login is what gets somebody in. Someone can exist without one — the ordinary state of a starter whose first day is next week."
                  />
                </span>
              </th>
              <th className="px-3 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-sm text-muted-foreground">
                  Nobody matches those filters.
                </td>
              </tr>
            ) : (
              users.map((u) => {
                const isMe = u.id === currentUserId;
                return (
                  <tr
                    key={u.id}
                    className={`border-b last:border-b-0 hover:bg-accent/40 ${
                      u.active ? "" : "opacity-60"
                    }`}
                  >
                    <td className="px-3 py-2.5">
                      {isMe ? (
                        <span
                          className="block size-4"
                          title="You cannot bulk-edit your own account"
                        />
                      ) : (
                        <input
                          type="checkbox"
                          aria-label={`Select ${u.full_name}`}
                          checked={selected.has(u.id)}
                          onChange={() => toggle(u.id)}
                          className="size-4 rounded border-input accent-[var(--primary)]"
                        />
                      )}
                    </td>

                    <td className="px-3 py-2.5">
                      <Link
                        href={`/admin/users/${u.id}`}
                        className="font-medium hover:underline"
                      >
                        {u.full_name}
                      </Link>
                      {isMe ? (
                        <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>
                      ) : null}
                      {!u.active ? (
                        <span className="ml-1.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium">
                          deactivated
                        </span>
                      ) : null}
                      <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                    </td>

                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${
                          ROLE_BADGE[u.role] ?? ROLE_BADGE.broker
                        }`}
                      >
                        {ROLE_LABEL[u.role] ?? u.role}
                      </span>
                    </td>

                    <td className="px-3 py-2.5 text-muted-foreground">
                      {u.manager_name ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{u.location ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {u.accounts_held > 0 ? (
                        <Link
                          href={`/accounts?owner=${u.id}`}
                          className="hover:underline"
                        >
                          {u.accounts_held}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                      {u.prospect_limit ? (
                        <span className="text-xs text-muted-foreground"> / {u.prospect_limit}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {u.calls_30d}
                    </td>

                    <td className="px-3 py-2.5">
                      {u.has_login ? (
                        <span className="text-xs text-muted-foreground">yes</span>
                      ) : (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={pending}
                          onClick={() => run("Login created.", () => createLogin(u.id))}
                        >
                          Create login
                        </Button>
                      )}
                    </td>

                    <td className="px-3 py-2.5">
                      <div className="flex justify-end gap-1">
                        <Link
                          href={`/admin/users/${u.id}`}
                          className="inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium transition-colors hover:bg-accent"
                        >
                          Edit
                        </Link>
                        {u.active ? (
                          isMe ? null : (
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={pending}
                              title="Deactivate"
                              onClick={() => setLeaving(u)}
                            >
                              <UserMinus className="size-3.5" aria-hidden />
                            </Button>
                          )
                        ) : (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={pending}
                            title="Reactivate"
                            onClick={() => run("Back in.", () => reactivateUser(u.id))}
                          >
                            <RotateCcw className="size-3.5" aria-hidden />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {page} of {pages} · {total} people
          </span>
          <div className="flex gap-2">
            <PageLink params={params} page={page - 1} disabled={page <= 1}>
              ← Previous
            </PageLink>
            <PageLink params={params} page={page + 1} disabled={page >= pages}>
              Next →
            </PageLink>
          </div>
        </div>
      ) : null}

      {leaving ? (
        <DeactivateDialog
          person={leaving}
          colleagues={colleagues.filter((c) => c.id !== leaving.id)}
          onClose={() => setLeaving(null)}
          onConfirm={(disposition, transferTo) => {
            setLeaving(null);
            run("Deactivated.", () => deactivateUser(leaving.id, disposition, transferTo));
          }}
        />
      ) : null}
    </>
  );
}

function PageLink({
  params,
  page,
  disabled,
  children,
}: {
  params: Record<string, string | string[] | undefined>;
  page: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="rounded-full border px-4 py-1.5 text-muted-foreground/50">{children}</span>
    );
  }
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === "page") continue;
    const value = Array.isArray(v) ? v[0] : v;
    if (value) next.set(k, value);
  }
  next.set("page", String(page));
  return (
    <Link
      href={`/admin/users?${next.toString()}`}
      className="rounded-full border px-4 py-1.5 font-medium transition-colors hover:bg-accent"
    >
      {children}
    </Link>
  );
}

/** Re-exported so the icon import is used where it reads best. */
export { KeyRound };
