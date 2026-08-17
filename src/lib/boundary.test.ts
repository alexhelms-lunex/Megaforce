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
    const fetching = [/chromeData\(/, /readPreferences\(/];

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
