/**
 * Turning form input into `custom` jsonb, and back.
 *
 * The whole admin-defined-fields idea only holds if nothing outside field_defs
 * ever names a field. So this reads the definitions at runtime and coerces
 * whatever the form submitted into the declared type -- an HTML form hands
 * everything over as a string, and storing "45000" where a number belongs makes
 * every later numeric filter and sort quietly wrong.
 *
 * Values are also filtered against the definitions rather than accepted
 * wholesale. Without that, anyone can post arbitrary keys into a jsonb column
 * that has no schema to stop them.
 */

export interface FieldDefinition {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "boolean";
  options: string[] | null;
  required: boolean;
}

export interface FieldError {
  key: string;
  message: string;
}

export interface ParsedCustom {
  values: Record<string, unknown>;
  errors: FieldError[];
}

/**
 * Build the `custom` object for a row from submitted form data.
 *
 * Only keys present in `defs` survive. Empty input becomes null rather than an
 * empty string, so "not filled in" is one value everywhere instead of two that
 * behave differently in a filter.
 */
export function parseCustomFields(form: FormData, defs: FieldDefinition[]): ParsedCustom {
  const values: Record<string, unknown> = {};
  const errors: FieldError[] = [];

  for (const def of defs) {
    const raw = form.get(`custom.${def.key}`);

    if (def.type === "boolean") {
      // An unchecked box submits nothing at all, which is a real false rather
      // than a missing value.
      values[def.key] = raw !== null && raw !== "";
      continue;
    }

    const text = typeof raw === "string" ? raw.trim() : "";

    if (text === "") {
      if (def.required) errors.push({ key: def.key, message: `${def.label} is required.` });
      values[def.key] = null;
      continue;
    }

    switch (def.type) {
      case "number": {
        // Strip the punctuation people type into money fields. "$45,000"
        // becoming NaN is a worse outcome than accepting the commas.
        const cleaned = text.replace(/[$,\s]/g, "");
        const n = Number(cleaned);
        if (!Number.isFinite(n)) {
          errors.push({ key: def.key, message: `${def.label} must be a number.` });
          values[def.key] = null;
        } else {
          values[def.key] = n;
        }
        break;
      }
      case "date": {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
          errors.push({ key: def.key, message: `${def.label} must be a date.` });
          values[def.key] = null;
        } else {
          values[def.key] = text;
        }
        break;
      }
      case "select": {
        // Refuse anything not on the list. A select is a constraint, and a
        // hand-crafted POST is not bound by the browser's dropdown.
        if (def.options && !def.options.includes(text)) {
          errors.push({ key: def.key, message: `${def.label} must be one of the listed options.` });
          values[def.key] = null;
        } else {
          values[def.key] = text;
        }
        break;
      }
      default:
        values[def.key] = text;
    }
  }

  return { values, errors };
}

/**
 * Merge new values over whatever the row already holds.
 *
 * Preserves keys belonging to archived definitions. A field retired last month
 * still has values sitting in jsonb, and replacing the object wholesale would
 * destroy them on the next unrelated edit.
 */
export function mergeCustom(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(existing ?? {}), ...incoming };
}
