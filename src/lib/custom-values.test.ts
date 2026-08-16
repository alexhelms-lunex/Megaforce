import { describe, expect, it } from "vitest";
import { mergeCustom, parseCustomFields, type FieldDefinition } from "./custom-values";

const DEFS: FieldDefinition[] = [
  { key: "annual_freight_spend", label: "Annual Freight Spend", type: "number", options: null, required: false },
  { key: "volume_band", label: "Shipping Volume", type: "select", options: ["1-5 loads/wk", "50+ loads/wk"], required: false },
  { key: "shipping_from", label: "Ships From", type: "text", options: null, required: true },
  { key: "renewal", label: "Renewal", type: "date", options: null, required: false },
  { key: "referenceable", label: "Referenceable", type: "boolean", options: null, required: false },
];

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("parseCustomFields", () => {
  it("coerces each value to its declared type", () => {
    const { values, errors } = parseCustomFields(
      form({
        "custom.annual_freight_spend": "450000",
        "custom.volume_band": "50+ loads/wk",
        "custom.shipping_from": "Charlotte, NC",
        "custom.renewal": "2027-03-01",
        "custom.referenceable": "on",
      }),
      DEFS,
    );

    expect(errors).toEqual([]);
    // A form submits everything as text. Storing "450000" where a number
    // belongs makes every later numeric filter and sort quietly wrong.
    expect(values.annual_freight_spend).toBe(450000);
    expect(typeof values.annual_freight_spend).toBe("number");
    expect(values.referenceable).toBe(true);
    expect(values.shipping_from).toBe("Charlotte, NC");
  });

  it("accepts money typed the way people actually type it", () => {
    const { values, errors } = parseCustomFields(
      form({ "custom.annual_freight_spend": "$1,250,000", "custom.shipping_from": "Dallas, TX" }),
      DEFS,
    );
    expect(errors).toEqual([]);
    expect(values.annual_freight_spend).toBe(1_250_000);
  });

  it("treats an unchecked box as false, not as missing", () => {
    const { values } = parseCustomFields(form({ "custom.shipping_from": "Reno, NV" }), DEFS);
    expect(values.referenceable).toBe(false);
  });

  it("turns blank input into null rather than an empty string", () => {
    // Otherwise "not filled in" has two representations that behave
    // differently in a filter.
    const { values } = parseCustomFields(
      form({ "custom.annual_freight_spend": "  ", "custom.shipping_from": "Boise, ID" }),
      DEFS,
    );
    expect(values.annual_freight_spend).toBeNull();
  });

  it("reports a required field left blank, by its label", () => {
    const { errors } = parseCustomFields(form({}), DEFS);
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("shipping_from");
    expect(errors[0].message).toContain("Ships From");
  });

  it("rejects a number that is not one", () => {
    const { errors, values } = parseCustomFields(
      form({ "custom.annual_freight_spend": "lots", "custom.shipping_from": "Ames, IA" }),
      DEFS,
    );
    expect(errors.map((e) => e.key)).toContain("annual_freight_spend");
    expect(values.annual_freight_spend).toBeNull();
  });

  it("refuses a select value that is not on the list", () => {
    // A dropdown is a constraint, and a hand-crafted POST is not bound by the
    // browser's markup.
    const { errors } = parseCustomFields(
      form({ "custom.volume_band": "made up", "custom.shipping_from": "Tulsa, OK" }),
      DEFS,
    );
    expect(errors.map((e) => e.key)).toContain("volume_band");
  });

  it("ignores keys that no definition claims", () => {
    // custom is schemaless jsonb, so without this anyone can post arbitrary
    // keys straight into it.
    const fd = form({ "custom.shipping_from": "Erie, PA" });
    fd.set("custom.is_admin", "true");
    fd.set("custom.injected", "whatever");

    const { values } = parseCustomFields(fd, DEFS);
    expect(values).not.toHaveProperty("is_admin");
    expect(values).not.toHaveProperty("injected");
    expect(Object.keys(values).sort()).toEqual(DEFS.map((d) => d.key).sort());
  });

  it("rejects a malformed date", () => {
    const { errors } = parseCustomFields(
      form({ "custom.renewal": "next tuesday", "custom.shipping_from": "Mesa, AZ" }),
      DEFS,
    );
    expect(errors.map((e) => e.key)).toContain("renewal");
  });
});

describe("mergeCustom", () => {
  it("keeps values belonging to retired fields", () => {
    // A field archived last month still has data sitting in jsonb. Replacing
    // the object wholesale would destroy it on the next unrelated edit.
    const merged = mergeCustom(
      { monthly_retainer: 8000, shipping_from: "Old City, ST" },
      { shipping_from: "New City, ST" },
    );
    expect(merged.monthly_retainer).toBe(8000);
    expect(merged.shipping_from).toBe("New City, ST");
  });

  it("copes with a row that has no custom object yet", () => {
    expect(mergeCustom(null, { a: 1 })).toEqual({ a: 1 });
    expect(mergeCustom(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});
