"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FieldDefinition } from "@/lib/custom-values";
import type { FormState } from "@/app/(app)/accounts/actions";

const STATUS_OPTIONS = [
  { value: "prospect", label: "Prospect" },
  { value: "engaged", label: "Engaged" },
  { value: "customer", label: "Customer" },
  { value: "do_not_contact", label: "Do not contact" },
];

/**
 * The account form, for both creating and editing.
 *
 * The lower half is rendered entirely from field_defs. Nothing in this file
 * names a single custom field, which is the property that makes adding one an
 * INSERT rather than a deploy. The moment a field name appeared here as a
 * literal, that promise would be broken.
 */
export function AccountForm({
  action,
  defs,
  account,
  submitLabel,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  defs: FieldDefinition[];
  account?: {
    id: string;
    name: string;
    status: string;
    industry: string | null;
    domain: string | null;
    custom: Record<string, unknown> | null;
  };
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {} as FormState);
  const custom = account?.custom ?? {};

  return (
    <form action={formAction} className="max-w-2xl space-y-6">
      {account ? <input type="hidden" name="accountId" value={account.id} /> : null}

      {state.error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Company name</Label>
          <Input id="name" name="name" defaultValue={account?.name ?? ""} required autoFocus />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="status">Status</Label>
            <select
              id="status"
              name="status"
              defaultValue={account?.status ?? "prospect"}
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="industry">Industry</Label>
            <Input id="industry" name="industry" defaultValue={account?.industry ?? ""} />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="domain">Website</Label>
          <Input
            id="domain"
            name="domain"
            placeholder="ironwoodmfg.com"
            defaultValue={account?.domain ?? ""}
          />
        </div>
      </div>

      {defs.length > 0 ? (
        <div className="space-y-4 border-t pt-6">
          <div>
            <h2 className="text-sm font-semibold">Details</h2>
            <p className="text-xs text-muted-foreground">
              These come from the field definitions. Add one there and it appears here.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {defs.map((def) => (
              <CustomField
                key={def.key}
                def={def}
                value={custom[def.key]}
                error={state.fieldErrors?.[def.key]}
              />
            ))}
          </div>
        </div>
      ) : null}

      {!account ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="claim" value="1" defaultChecked />
          Claim this account for myself
          <span className="text-muted-foreground">
            — leave unticked to put it straight in the available pool
          </span>
        </label>
      ) : null}

      <div className="flex items-center gap-3 border-t pt-6">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        <Link
          href={account ? `/accounts/${account.id}` : "/accounts"}
          className="text-sm text-muted-foreground hover:underline"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

function CustomField({
  def,
  value,
  error,
}: {
  def: FieldDefinition;
  value: unknown;
  error?: string;
}) {
  const name = `custom.${def.key}`;
  const stringValue = value === null || value === undefined ? "" : String(value);

  return (
    <div className="space-y-2">
      <Label htmlFor={name}>
        {def.label}
        {def.required ? <span className="text-destructive"> *</span> : null}
      </Label>

      {def.type === "select" ? (
        <select
          id={name}
          name={name}
          defaultValue={stringValue}
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
        >
          <option value="">—</option>
          {(def.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : def.type === "boolean" ? (
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" id={name} name={name} defaultChecked={value === true} />
          Yes
        </label>
      ) : (
        <Input
          id={name}
          name={name}
          type={def.type === "date" ? "date" : "text"}
          // Deliberately not type="number": browsers reject the commas and
          // currency symbols people actually type, and the parser handles them.
          inputMode={def.type === "number" ? "decimal" : undefined}
          defaultValue={stringValue}
        />
      )}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
