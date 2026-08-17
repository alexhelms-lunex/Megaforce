import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLUMN_HELP, DEFINITIONS, POLICY, type DefinitionKey } from "./definitions";

/**
 * The explanations, tested like code.
 *
 * ---------------------------------------------------------------------------
 * These are not decoration. They are the only place a broker can find out why
 * an account is about to leave their name, and they shipped saying "released at
 * 45 days" for a week after the database had moved to 31. Nobody noticed,
 * because prose does not fail a build.
 *
 * So three things are checked mechanically:
 *
 *   1. Every key referenced anywhere in the application exists in the registry.
 *      A typo renders NOTHING -- InfoTip returns null on an empty body -- which
 *      is indistinguishable from "the info icons do not work", and that is
 *      exactly the report that came back.
 *
 *   2. The policy numbers in POLICY match the numbers the database enforces in
 *      ensure_policy_thresholds(). This is the drift that actually happened.
 *
 *   3. No definition contains a hard-coded threshold that contradicts POLICY.
 * ---------------------------------------------------------------------------
 */

const SRC = path.join(process.cwd(), "src");
const MIGRATIONS = path.join(process.cwd(), "db", "migrations");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Every `k="…"` and `info="…"` literal used in a component. */
function referencedKeys(): { key: string; file: string }[] {
  const found: { key: string; file: string }[] = [];
  for (const file of walk(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\b(?:k|info)="([a-zA-Z]+)"/g)) {
      found.push({ key: match[1], file: path.relative(process.cwd(), file) });
    }
  }
  return found;
}

describe("the definitions registry", () => {
  it("has an entry for every key referenced in the application", () => {
    const missing = referencedKeys().filter(({ key }) => !(key in DEFINITIONS));
    expect(missing, `unknown definition keys: ${JSON.stringify(missing)}`).toEqual([]);
  });

  it("references at least one key, so the scan is actually finding things", () => {
    // Guards the test above from passing vacuously if the regex ever stops
    // matching -- a green suite that checks nothing is the worse failure.
    expect(referencedKeys().length).toBeGreaterThan(10);
  });

  it("gives every entry a title and a body worth reading", () => {
    for (const [key, definition] of Object.entries(DEFINITIONS)) {
      expect(definition.title, `${key} has no title`).toBeTruthy();
      expect(definition.body.length, `${key} body is too short to explain anything`)
        .toBeGreaterThan(40);
    }
  });

  it("points every account-list column at a definition that exists", () => {
    for (const [column, key] of Object.entries(COLUMN_HELP)) {
      if (key === undefined) continue;
      expect(DEFINITIONS[key as DefinitionKey], `column ${column} → ${key}`).toBeDefined();
    }
  });
});

describe("the policy numbers", () => {
  /**
   * Read the thresholds straight out of the migration that enforces them.
   *
   * 0018 holds them as a VALUES list, which is the closest thing this codebase
   * has to a single source of truth for the policy:
   *
   *     ('prospect', 14, 21, 31),
   *     ('customer', 90, 150, 181)
   */
  function thresholdsFromMigration(applies: string): [number, number, number] {
    const sql = readFileSync(
      path.join(MIGRATIONS, "0018_self_healing_thresholds.sql"),
      "utf8",
    );
    const match = sql.match(
      new RegExp(`\\('${applies}',\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)\\)`),
    );
    if (!match) throw new Error(`no ${applies} row in ensure_policy_thresholds()`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  it("match what the database enforces for a prospect", () => {
    const [warning, expiring, release] = thresholdsFromMigration("prospect");
    expect(POLICY.prospect).toEqual({ warning, expiring, release });
  });

  it("match what the database enforces for a customer", () => {
    const [warning, expiring, release] = thresholdsFromMigration("customer");
    expect(POLICY.customer).toEqual({ warning, expiring, release });
  });

  it("do not leave a superseded threshold sitting in any explanation", () => {
    // 45 and 30 were the previous prospect release and expiry days. Either
    // reappearing in prose beside the word "day" means an explanation has been
    // written by hand against numbers that no longer apply -- which is the
    // precise defect this file exists to prevent recurring.
    const stale = Object.entries(DEFINITIONS).filter(([, d]) =>
      /\b(45|30)\s*(?:days?|\/)/.test(`${d.body} ${d.formula ?? ""}`),
    );
    expect(stale.map(([k]) => k), "stale thresholds in prose").toEqual([]);
  });

  it("orders each set of thresholds so a state can actually be reached", () => {
    for (const [name, t] of Object.entries(POLICY)) {
      expect(t.warning, `${name}: warning must come first`).toBeLessThan(t.expiring);
      expect(t.expiring, `${name}: expiring must come before release`).toBeLessThan(t.release);
    }
  });
});
