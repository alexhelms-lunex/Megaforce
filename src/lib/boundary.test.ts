import { readFileSync, readdirSync, statSync } from "node:fs";
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
