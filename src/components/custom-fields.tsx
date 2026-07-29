import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatMoney } from "@/lib/format";

export interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "boolean";
  options: string[] | null;
  required: boolean;
  sort: number;
}

/**
 * Renders whatever fields an admin has defined.
 *
 * Nothing in this component knows what a "Monthly Retainer" is. It receives a
 * list of field definitions read from the field_defs table and a bag of values
 * out of the row's `custom` jsonb column, and renders the intersection.
 *
 * That is the whole architectural bet: adding a field to the CRM is an INSERT,
 * not a migration and not a deploy. The moment this component hardcoded even
 * one field name, the bet would be lost -- so it never does.
 */
export function CustomFields({
  defs,
  values,
}: {
  defs: FieldDef[];
  values: Record<string, unknown> | null;
}) {
  if (defs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No custom fields are defined yet. Add a row to{" "}
        <span className="font-mono">field_defs</span> and it appears here.
      </p>
    );
  }

  const bag = values ?? {};

  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
      {defs.map((def) => (
        <div key={def.key} className="flex items-baseline justify-between gap-4 border-b py-2">
          <dt className="text-sm text-muted-foreground">{def.label}</dt>
          <dd className="text-sm font-medium">{renderValue(def, bag[def.key])}</dd>
        </div>
      ))}
    </dl>
  );
}

function renderValue(def: FieldDef, value: unknown) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }

  switch (def.type) {
    case "boolean":
      return <Badge variant={value ? "secondary" : "outline"}>{value ? "Yes" : "No"}</Badge>;
    case "number":
      // Money-shaped keys get currency formatting. A `format` column on
      // field_defs would be the cleaner answer once there is a second case.
      return /retainer|amount|value|price|budget/i.test(def.key)
        ? formatMoney(value as number)
        : String(value);
    case "date":
      return formatDateTime(String(value)).replace(/,.*$/, "");
    case "select":
      return <Badge variant="outline">{String(value)}</Badge>;
    default:
      return String(value);
  }
}
