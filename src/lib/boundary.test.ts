import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The server/client boundary, checked mechanically.
 *
 * ---------------------------------------------------------------------------
 * A prop crossing from a server component into a client one has to survive
 * being serialised, and a closure cannot. React refuses it, and the refusal is
 * a HARD ERROR at render time -- which Next then redacts in production, so the
 * screen reads "an error occurred in the Server Components render" and says
 * nothing else about which prop on which component.
 *
 * That is exactly how the reports screen shipped broken. It passed
 * `formatLabel={(iso) => formatBucket(iso, grain)}` into a client chart. It
 * type-checked, it built, it lint-passed, and it crashed on every load.
 *
 * Nothing in the toolchain catches it, so this does. It is a text scan rather
 * than a type check because the failure is not a type error -- both sides are
 * perfectly typed.
 * ---------------------------------------------------------------------------
 */

const SRC = path.join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

interface Scan {
  /** Component name -> the client file exporting it. */
  clientComponents: Map<string, string>;
  serverFiles: { file: string; source: string }[];
}

function scan(): Scan {
  const clientComponents = new Map<string, string>();
  const serverFiles: { file: string; source: string }[] = [];

  for (const file of walk(SRC)) {
    const source = readFileSync(file, "utf8");
    const isClient = /^\s*["']use client["']/m.test(source.slice(0, 200));
    if (isClient) {
      for (const m of source.matchAll(/export function (\w+)/g)) {
        clientComponents.set(m[1], path.relative(process.cwd(), file));
      }
    } else {
      serverFiles.push({ file: path.relative(process.cwd(), file), source });
    }
  }
  return { clientComponents, serverFiles };
}

/**
 * Every `prop={(…) => …}` on a client component inside a server file.
 *
 * Server ACTIONS are the one legitimate function across the boundary, and they
 * are never written as an inline arrow at the call site -- they are imported
 * from a "use server" module and passed by name. So an inline arrow is always
 * the mistake.
 */
function offendingProps(): { file: string; component: string; prop: string }[] {
  const { clientComponents, serverFiles } = scan();
  const found: { file: string; component: string; prop: string }[] = [];

  for (const { file, source } of serverFiles) {
    for (const tag of source.matchAll(new RegExp("<([A-Z]\\w*)\\b([^>]*?)/?>", "g"))) {
      const [, component, attrs] = tag;
      if (!clientComponents.has(component)) continue;
      for (const attr of attrs.matchAll(/(\w+)=\{\s*(?:\([^)]*\)|\w+)\s*=>/g)) {
        found.push({ file, component, prop: attr[1] });
      }
    }
  }
  return found;
}

describe("the server/client boundary", () => {
  it("never hands an inline function to a client component from a server file", () => {
    const offenders = offendingProps();
    expect(
      offenders,
      `These crash at render with a message production redacts:\n` +
        offenders.map((o) => `  ${o.file}: <${o.component} ${o.prop}={…} />`).join("\n"),
    ).toEqual([]);
  });

  it("is actually looking at both halves of the application", () => {
    // Guards the test above from passing because the scan found nothing to
    // scan. A green check that checked nothing is the worse failure.
    const { clientComponents, serverFiles } = scan();
    expect(clientComponents.size).toBeGreaterThan(20);
    expect(serverFiles.length).toBeGreaterThan(20);
  });
});


/**
 * Every action handler catches.
 *
 * ---------------------------------------------------------------------------
 * A server action that REFUSES returns `{ error }`, and every handler checked
 * for that. A server action that REJECTS throws inside a React transition, and
 * React sends that to the nearest error boundary -- which replaces the entire
 * screen with "This page did not load" and a message production redacts.
 *
 * Pressing Save on the user form did exactly that. The form's contents were
 * gone, the cause was invisible, and the underlying problem deserved a toast
 * at most. It was one missing try/catch, in nine separate places.
 *
 * So: no handler may await a server action without a guard. runAction() is the
 * guard; a hand-written try/catch is accepted for the few places that need
 * something bespoke.
 * ---------------------------------------------------------------------------
 */
describe("client action handlers", () => {
  function unguardedHandlers(): { file: string; line: number }[] {
    const found: { file: string; line: number }[] = [];

    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/m.test(source.slice(0, 200))) continue;
      // The helper itself quotes the bad pattern in its own comment.
      if (file.endsWith("run-action.ts")) continue;

      const lines = source.split("\n");
      lines.forEach((line, i) => {
        // The shape every handler uses: a transition wrapping an async body.
        if (!/start(Transition)?\(\s*async\s*\(\)\s*=>/.test(line)) return;
        // Look ahead far enough to cover the body of a realistic handler.
        const body = lines.slice(i, i + 20).join("\n");
        if (/runAction|try\s*\{/.test(body)) return;
        found.push({ file: path.relative(process.cwd(), file), line: i + 1 });
      });
    }
    return found;
  }

  it("never awaits a server action without catching a rejection", () => {
    const offenders = unguardedHandlers();
    expect(
      offenders,
      "A rejected action here destroys the page instead of showing a message:\n" +
        offenders.map((o) => `  ${o.file}:${o.line}`).join("\n"),
    ).toEqual([]);
  });

  it("is finding the handlers it is meant to be checking", () => {
    // The scan is only meaningful if it actually matches the pattern in use.
    let handlers = 0;
    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/m.test(source.slice(0, 200))) continue;
      handlers += (source.match(/start(Transition)?\(\s*async\s*\(\)\s*=>/g) ?? []).length;
    }
    expect(handlers).toBeGreaterThan(5);
  });
});

/**
 * The shell, which is the one server component that is on every screen.
 *
 * ---------------------------------------------------------------------------
 * A server action's response re-renders the current route, and the route
 * includes the layout. So a throw in the layout does not break one screen -- it
 * rejects the promise of whatever action the person just pressed, and the
 * button reports a failure for a write that already succeeded.
 *
 * That is how Claim, Save on the user form and the role picker all came to
 * report the identical "An error occurred in the Server Components render",
 * with three complete try/catch blocks between them and nothing wrong in any
 * of the three files anybody kept re-reading.
 *
 * The fix was to make the shell incapable of throwing. This keeps it that way,
 * because the next person to add a widget to the header will not know any of
 * the above.
 * ---------------------------------------------------------------------------
 */
describe("the application shell", () => {
  const layout = readFileSync(path.join(SRC, "app", "(app)", "layout.tsx"), "utf8");

  it("uses the auth lookup that cannot throw", () => {
    // currentUser() returns null on failure and is fine nearly everywhere. The
    // layout needs loadCurrentUser(), which reports WHY there is no user --
    // the difference between showing a login prompt and showing "could not
    // reach the server", and the difference between an administrator editing
    // SQL and an administrator waiting ten seconds.
    expect(layout).toMatch(/loadCurrentUser\(\)/);
    expect(layout).not.toMatch(/\bawait currentUser\(\)/);
  });

  it("catches every data call it makes", () => {
    /*
     * Each `await` on a line that fetches something must be guarded. Written as
     * a scan rather than a rule anybody has to remember, because the cost of
     * forgetting is not a broken layout -- it is every button on every screen
     * reporting a failure it did not have.
     */
    const guarded = /\.catch\(|try\s*\{/;
    const fetching = [/chromeData\(/, /loadPreferences\(/];

    for (const pattern of fetching) {
      const line = layout.split("\n").find((l) => pattern.test(l) && !l.trim().startsWith("*"));
      expect(line, `${pattern} should appear in the layout`).toBeTruthy();
      // The call and its .catch() may sit on different lines, so the window is
      // the call plus the few lines after it.
      const index = layout.split("\n").findIndex((l) => l === line);
      const window = layout.split("\n").slice(index, index + 6).join("\n");
      expect(guarded.test(window), `${pattern} is unguarded in the layout`).toBe(true);
    }
  });
});

/**
 * Where Next looks for the instrumentation hook.
 *
 * ---------------------------------------------------------------------------
 * This file was at the repository root while the application lives in src/.
 * Next only loads it from ONE of those two places -- the src/ one, when a src
 * directory exists -- so the hook was never compiled into the build and never
 * ran.
 *
 * The consequence was worse than not having it. onRequestError is what captures
 * the real message behind production's redaction, so /api/errors answered
 * "nothing has failed" every single time, seconds after something had. That
 * reads as evidence the error is not real, and it cost several rounds of
 * looking in the wrong place while the one instrument built to prevent exactly
 * that was switched off.
 *
 * Nothing else catches this. It is not a type error, it is not a lint error,
 * and the build succeeds -- the file is simply ignored.
 * ---------------------------------------------------------------------------
 */
describe("the instrumentation hook", () => {
  it("lives where Next will actually load it from", () => {
    const inSrc = existsSync(path.join(SRC, "instrumentation.ts"));
    const atRoot = existsSync(path.join(process.cwd(), "instrumentation.ts"));

    expect(inSrc, "instrumentation.ts must be in src/, since the app is in src/app").toBe(true);
    expect(atRoot, "a copy at the root is the one Next ignores — delete it").toBe(false);
  });

  it("is compiled into the build when one has been made", () => {
    // Only meaningful after `npm run build`, so it skips rather than failing on
    // a clean checkout. When a build IS present, its absence is the bug above.
    const built = path.join(process.cwd(), ".next", "server");
    if (!existsSync(built)) return;
    expect(
      existsSync(path.join(built, "instrumentation.js")),
      "no instrumentation.js in .next/server — Next did not pick the hook up",
    ).toBe(true);
  });
});

/**
 * What a "use server" file is allowed to export.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONE THAT COST THE MOST.
 *
 * A "use server" module may export async functions and nothing else. Every
 * export becomes a callable server reference, so a plain array or object has no
 * meaning as one, and Next refuses the WHOLE MODULE:
 *
 *     A "use server" file can only export async functions, found object.
 *
 * It refuses it at RUNTIME, when an action is invoked. `next build` succeeds.
 * The types pass. Lint passes. Every screen renders perfectly. Then every
 * button in the application fails -- and the failure arrives as Next's redacted
 * "An error occurred in the Server Components render", the same sentence used
 * for genuine crashes.
 *
 * The offender was one line: `export const STAGES = [...]` in the phone dock's
 * action file. The dock is on every page, so the invalid module sat in every
 * page's server-action graph, and Claim, Save on the user form and the role
 * picker all failed identically while being individually correct. Three rounds
 * of fixes went into those three files. None of them had a bug.
 *
 * Nothing in the toolchain catches this. This does.
 * ---------------------------------------------------------------------------
 */
describe("server action modules", () => {
  const serverFiles = walk(SRC).filter((file) => {
    const head = readFileSync(file, "utf8").slice(0, 200);
    return /^\s*["']use server["']/.test(head);
  });

  it("finds the action files it is meant to be checking", () => {
    // A scan that matches nothing passes silently and protects nothing.
    expect(serverFiles.length).toBeGreaterThan(4);
  });

  for (const file of serverFiles) {
    it(`${path.relative(SRC, file)} exports only async functions`, () => {
      const source = readFileSync(file, "utf8");
      const offenders: string[] = [];

      for (const [index, line] of source.split("\n").entries()) {
        // `export type` and `export interface` are erased before this file ever
        // reaches Next, so they are not exports at runtime and are fine.
        if (/^export\s+(type|interface)\b/.test(line)) continue;
        if (/^export\s+async\s+function\b/.test(line)) continue;
        if (/^export\s*\{[^}]*\btype\b/.test(line)) continue;

        if (/^export\b/.test(line)) {
          offenders.push(`line ${index + 1}: ${line.trim()}`);
        }
      }

      expect(
        offenders,
        `A "use server" file may only export async functions. Move these into a ` +
          `plain module and import them:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});

/**
 * Migrations have to survive being run twice.
 *
 * ---------------------------------------------------------------------------
 * Setup re-runs the whole migration set every time, because people re-run it
 * when something looks wrong -- and a setup button that is only safe once is
 * a trap, not a button.
 *
 * The specific way this breaks is subtle enough to have caught this project
 * three times, in 0021, 0024 and 0030. `create or replace function` cannot
 * change a return type or add a parameter; it creates an OVERLOAD instead. So
 * a migration that widens a signature has to drop the old one first. On the
 * SECOND run, though, an earlier migration has already recreated the old
 * signature and the new one is still there from the first run -- so the drop
 * clears one and the create collides with the other, and setup stops dead at
 * that file with an error nobody would connect to it.
 *
 * The rule: a migration using a bare `create function` must drop that
 * function's name somewhere in the same file, and must drop EVERY signature it
 * has ever had rather than only the one being replaced.
 *
 * This checks the first half statically, which is the cheap half. The second
 * half is only provable against a real database, which is what the double-run
 * in setup/run.test.ts is for.
 * ---------------------------------------------------------------------------
 */
describe("migrations are safe to re-run", () => {
  const migrationsDir = path.join(process.cwd(), "db", "migrations");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  it("finds the migrations it is meant to be checking", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    it(`${file} drops any function it creates outright`, () => {
      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      // Comments carry example SQL and prose about dropping; stripping them
      // keeps this measuring the statements rather than the explanation.
      const code = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

      const created = [...code.matchAll(/\bcreate\s+function\s+([a-z0-9_]+)\s*\(/gi)]
        .map((m) => m[1].toLowerCase());
      const dropped = new Set(
        [...code.matchAll(/\bdrop\s+function\s+if\s+exists\s+([a-z0-9_]+)\s*\(/gi)]
          .map((m) => m[1].toLowerCase()),
      );

      const undropped = [...new Set(created)].filter((name) => !dropped.has(name));
      expect(
        undropped,
        `${file} uses a bare "create function" for ${undropped.join(", ")} without a ` +
          `matching "drop function if exists". On a second run of setup that fails with ` +
          `"function already exists". Either drop it first — every signature it has ever ` +
          `had — or use "create or replace" if the signature is unchanged.`,
      ).toEqual([]);
    });
  }
});

/**
 * Every screen has something to show while it is loading.
 *
 * ---------------------------------------------------------------------------
 * Every page in this application is `export const dynamic = "force-dynamic"`,
 * because every one of them reads rows that depend on who is asking. In the App
 * Router a dynamic route with no loading boundary renders NOTHING until the
 * server has finished: the browser stays on the old page, the click looks like
 * it did nothing, and people click again.
 *
 * There was no loading.tsx anywhere in this project, which is most of why "load
 * times are long between pages" was the complaint rather than "pages take half
 * a second". A route group boundary at (app)/loading.tsx covers everything, so
 * this only has to check that the catch-all is there -- but it checks the
 * per-screen ones too, because a boundary shaped like the page it stands in for
 * is the difference between a page arriving and a page jumping.
 * ---------------------------------------------------------------------------
 */
describe("loading boundaries", () => {
  const group = path.join(SRC, "app", "(app)");

  it("has a catch-all boundary for the whole application", () => {
    // The one that matters most: a screen added next month inherits this
    // rather than inheriting the old dead-click behaviour.
    expect(existsSync(path.join(group, "loading.tsx"))).toBe(true);
  });

  it("gives the screens people move between most their own", () => {
    // Not every route -- an admin form does not need a table skeleton. These
    // are the ones in the main navigation, which is where the movement is.
    for (const route of ["prospects", "customers", "accounts", "available", "contacts", "activity", "reports"]) {
      expect(
        existsSync(path.join(group, route, "loading.tsx")),
        `${route} has no loading.tsx, so clicking it leaves the old page on screen`,
      ).toBe(true);
    }
  });

  it("keeps every page in the group dynamic, which is why the boundaries matter", () => {
    // If a page ever stops being force-dynamic this reasoning changes, and the
    // reasoning is what the comment above is made of.
    const pages = walk(group).filter((f) => path.basename(f) === "page.tsx");
    expect(pages.length).toBeGreaterThan(10);

    const notDynamic = pages.filter((f) => {
      const source = readFileSync(f, "utf8");
      // A page that re-exports another screen inherits its parent's setting.
      if (/export \{[^}]*\} from/.test(source)) return false;
      return !/export const dynamic = "force-dynamic"/.test(source);
    });

    expect(
      notDynamic.map((f) => path.relative(group, f)),
      "these pages are not force-dynamic; check they are meant to be cached",
    ).toEqual([]);
  });
});
