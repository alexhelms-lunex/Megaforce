/**
 * A Supabase client that talks to a real Postgres, for testing server actions.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The server actions are the layer that keeps breaking -- create a user, change
 * a role, claim an account, save a setting -- and nothing in this project had
 * ever executed one. The page tests render screens without touching a database;
 * the SQL tests exercise the database without touching the actions. In between
 * sat every real defect: a column named wrongly, a policy that refuses, a
 * trigger that raises, a shape the code did not expect.
 *
 * The only honest way to test an action is to RUN it, against a real database,
 * as a real user, with row level security on. This is what makes that possible:
 * it presents the surface `@supabase/supabase-js` presents, and underneath it
 * builds SQL and runs it against PGlite.
 *
 * It is a test double, not a reimplementation of PostgREST -- it covers the
 * query shapes this application actually uses, and throws loudly on anything it
 * does not understand rather than silently returning nothing. A fake that
 * quietly returns an empty result is worse than no fake at all: it makes a
 * broken action look like a passing test.
 * ---------------------------------------------------------------------------
 */
import type { LocalDb } from "./local";

interface Filter {
  sql: string;
  params: unknown[];
}

type Op = "select" | "insert" | "update" | "delete" | "upsert";

export interface Result<T = unknown> {
  data: T | null;
  error: { message: string } | null;
  count: number | null;
}

class Builder implements PromiseLike<Result> {
  private op: Op = "select";
  private columns = "*";
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private conflictTarget: string | null = null;
  private filters: Filter[] = [];
  private orderBy: string[] = [];
  private limitN: number | null = null;
  private offsetN = 0;
  private wantCount = false;
  private rowMode: "many" | "one" | "maybe" = "many";

  constructor(
    private db: LocalDb,
    private table: string,
  ) {}

  // -- operations ----------------------------------------------------------

  select(columns = "*", opts?: { count?: string; head?: boolean }) {
    // An embedded resource -- `requester:users!fk(full_name)` -- is a PostgREST
    // join this double does not build. Dropped rather than guessed at, and the
    // column simply comes back absent.
    this.columns = columns
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c && !c.includes("(") && !c.includes(":"))
      .join(", ") || "*";
    if (opts?.count) this.wantCount = true;
    return this;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]) {
    this.op = "insert";
    this.payload = values;
    return this;
  }

  upsert(values: Record<string, unknown>, opts?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = values;
    this.conflictTarget = opts?.onConflict ?? null;
    return this;
  }

  update(values: Record<string, unknown>) {
    this.op = "update";
    this.payload = values;
    return this;
  }

  delete() {
    this.op = "delete";
    return this;
  }

  // -- filters -------------------------------------------------------------

  private push(sql: string, ...params: unknown[]) {
    this.filters.push({ sql, params });
    return this;
  }

  eq(col: string, value: unknown) {
    return value === null ? this.push(`${q(col)} is null`) : this.push(`${q(col)} = ?`, value);
  }
  neq(col: string, value: unknown) {
    return this.push(`${q(col)} is distinct from ?`, value);
  }
  is(col: string, value: unknown) {
    if (value === null) return this.push(`${q(col)} is null`);
    return this.push(`${q(col)} is ?`, value);
  }
  in(col: string, values: unknown[]) {
    if (values.length === 0) return this.push("false");
    return this.push(`${q(col)} = any(?)`, values);
  }
  ilike(col: string, pattern: string) {
    return this.push(`${q(col)} ilike ?`, pattern);
  }
  like(col: string, pattern: string) {
    return this.push(`${q(col)} like ?`, pattern);
  }
  gt(col: string, v: unknown) { return this.push(`${q(col)} > ?`, v); }
  gte(col: string, v: unknown) { return this.push(`${q(col)} >= ?`, v); }
  lt(col: string, v: unknown) { return this.push(`${q(col)} < ?`, v); }
  lte(col: string, v: unknown) { return this.push(`${q(col)} <= ?`, v); }
  not(col: string, op: string, v: unknown) {
    if (op === "is" && v === null) return this.push(`${q(col)} is not null`);
    return this.push(`not (${q(col)} ${op} ?)`, v);
  }

  /** `a.ilike.%x%,b.eq.1` -> `(a ilike '%x%' or b = 1)`. */
  or(expression: string) {
    const parts = splitTop(expression).map((clause) => {
      const first = clause.indexOf(".");
      const second = clause.indexOf(".", first + 1);
      if (first < 0 || second < 0) {
        throw new Error(`postgrest-fake: cannot parse or() clause "${clause}"`);
      }
      const col = clause.slice(0, first);
      const op = clause.slice(first + 1, second);
      const val = clause.slice(second + 1);
      const map: Record<string, string> = {
        eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=",
        like: "like", ilike: "ilike",
      };
      if (op === "is") return `${q(col)} is ${val === "null" ? "null" : val}`;
      if (!map[op]) throw new Error(`postgrest-fake: unsupported or() operator "${op}"`);
      return `${q(col)} ${map[op]} ${literal(val)}`;
    });
    this.filters.push({ sql: `(${parts.join(" or ")})`, params: [] });
    return this;
  }

  // -- modifiers -----------------------------------------------------------

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    const dir = opts?.ascending === false ? "desc" : "asc";
    const nulls =
      opts?.nullsFirst === undefined ? "" : opts.nullsFirst ? " nulls first" : " nulls last";
    this.orderBy.push(`${q(col)} ${dir}${nulls}`);
    return this;
  }
  limit(n: number) { this.limitN = n; return this; }
  range(from: number, to: number) {
    this.offsetN = from;
    this.limitN = to - from + 1;
    return this;
  }
  single() { this.rowMode = "one"; return this; }
  maybeSingle() { this.rowMode = "maybe"; return this; }

  // -- execution -----------------------------------------------------------

  private build(): { sql: string; params: unknown[] } {
    const params: unknown[] = [];

    /*
     * Built on demand, not up front.
     *
     * Placeholders are numbered by the order they are ADDED to `params`, and an
     * UPDATE's SET clause comes before its WHERE in the statement. Building the
     * WHERE eagerly numbered the filters first, so the statement referenced $2
     * and $3 while $1 sat unused -- and Postgres rejects that with "could not
     * determine data type of parameter $1", which reads like a type problem and
     * is really an ordering one.
     */
    const buildWhere = () =>
      this.filters.length
        ? " where " + this.filters.map((f) => bind(f, params)).join(" and ")
        : "";

    if (this.op === "select") {
      const where = buildWhere();
      const order = this.orderBy.length ? ` order by ${this.orderBy.join(", ")}` : "";
      const limit = this.limitN !== null ? ` limit ${this.limitN}` : "";
      const offset = this.offsetN ? ` offset ${this.offsetN}` : "";
      return { sql: `select ${this.columns} from ${q(this.table)}${where}${order}${limit}${offset}`, params };
    }

    if (this.op === "insert" || this.op === "upsert") {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const cols = Object.keys(rows[0]);
      const values = rows
        .map((row) => `(${cols.map((c) => valueSql(row[c], params)).join(", ")})`)
        .join(", ");
      const conflict =
        this.op === "upsert"
          ? ` on conflict (${(this.conflictTarget ?? "id").split(",").map((c) => q(c.trim())).join(", ")}) ` +
            `do update set ${cols.filter((c) => c !== this.conflictTarget).map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`
          : "";
      return {
        sql: `insert into ${q(this.table)} (${cols.map(q).join(", ")}) values ${values}${conflict} returning ${this.columns}`,
        params,
      };
    }

    if (this.op === "update") {
      const sets = Object.entries(this.payload as Record<string, unknown>)
        .map(([c, v]) => `${q(c)} = ${valueSql(v, params)}`)
        .join(", ");
      return {
        sql: `update ${q(this.table)} set ${sets}${buildWhere()} returning ${this.columns}`,
        params,
      };
    }

    return { sql: `delete from ${q(this.table)}${buildWhere()} returning ${this.columns}`, params };
  }

  async run(): Promise<Result> {
    let rows: Record<string, unknown>[];
    try {
      const { sql, params } = this.build();
      const res = await this.db.query<Record<string, unknown>>(sql, params as never[]);
      rows = res.rows;
    } catch (err) {
      // Exactly what supabase-js does with a PostgREST error: a value, not a
      // throw. Actions branch on `error`, so returning it is what makes the
      // test exercise the real path.
      return { data: null, error: { message: (err as Error).message }, count: null };
    }

    if (this.rowMode === "one") {
      if (rows.length !== 1) {
        return {
          data: null,
          error: { message: `JSON object requested, ${rows.length} rows returned` },
          count: null,
        };
      }
      return { data: rows[0], error: null, count: 1 };
    }
    if (this.rowMode === "maybe") {
      return { data: rows[0] ?? null, error: null, count: rows.length };
    }
    return { data: rows, error: null, count: this.wantCount ? rows.length : null };
  }

  then<A, B>(
    onOk?: ((v: Result) => A | PromiseLike<A>) | null,
    onErr?: ((r: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onOk, onErr);
  }
}

/** Split on top-level commas, so `name.ilike.%a,b%` is not torn in half. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

function q(identifier: string): string {
  return identifier
    .split(".")
    .map((part) => `"${part.replace(/"/g, "")}"`)
    .join(".");
}

function literal(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * A value as SQL.
 *
 * NULL goes in as a literal rather than a parameter: Postgres cannot infer the
 * type of a bare `$1` holding null in a SET or VALUES clause and refuses the
 * statement with "could not determine data type of parameter". PostgREST never
 * meets this because it sends typed JSON. A literal `null` is not user input,
 * so nothing is put at risk by writing it inline.
 */
function valueSql(v: unknown, params: unknown[]): string {
  return v === null || v === undefined ? "null" : `$${params.push(v)}`;
}

function bind(f: Filter, params: unknown[]): string {
  let i = 0;
  return f.sql.replace(/\?/g, () => `$${params.push(f.params[i++])}`);
}

/**
 * The client itself.
 *
 * `auth` is present but inert: these tests care about what the DATABASE does
 * with an action, and Supabase's hosted auth service is not part of that.
 */
export function fakeSupabase(db: LocalDb, authId: string | null) {
  return {
    from: (table: string) => new Builder(db, table),

    rpc: (name: string, args: Record<string, unknown> = {}) => {
      const keys = Object.keys(args);
      const params = keys.map((k) => args[k]);
      const call = keys.length
        ? `${q(name)}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`
        : `${q(name)}()`;
      return {
        then(onOk: (v: Result) => unknown, onErr?: (e: unknown) => unknown) {
          return db
            .query<Record<string, unknown>>(`select * from ${call}`, params as never[])
            .then((res) => {
              const rows = res.rows;
              // A function returning a scalar comes back as one row with one
              // column; supabase-js unwraps that to the value itself.
              if (rows.length === 1 && Object.keys(rows[0]).length === 1) {
                const only = Object.values(rows[0])[0];
                return { data: only, error: null, count: null };
              }
              return { data: rows, error: null, count: rows.length };
            })
            .catch((err: Error) => ({ data: null, error: { message: err.message }, count: null }))
            .then(onOk, onErr);
        },
      };
    },

    auth: {
      getUser: async () => ({ data: { user: authId ? { id: authId } : null }, error: null }),
      signOut: async () => ({ error: null }),
    },
  };
}
