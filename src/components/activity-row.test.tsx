import { describe, expect, it } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { ActivityRow, type FeedActivity } from "./activity-row";

/**
 * What an activity row is allowed to say.
 *
 * ---------------------------------------------------------------------------
 * Alex: "For activities logged the only thing under the title should be notes
 * on the call. Not system notes. It should only say qualified or not
 * qualified. Then in a tab you can put those system notes."
 *
 * That is a rule about CONTENT, and content rules rot silently. Somebody
 * debugging a qualification problem six months from now adds the reason back
 * onto the row "just while I look at this", and it stays. Nothing type-checks
 * it, nothing lints it, and the feed goes back to being three machine
 * sentences per row.
 *
 * So these tests walk the element tree the component returns and assert on the
 * words in it. No DOM, no renderer -- the component is a plain function of its
 * props, and flattening what it returns is enough to answer "is this string on
 * the screen".
 * ---------------------------------------------------------------------------
 */

/** Every piece of text in a returned element tree, joined. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    // A nested component is a function, not an element, until it is called.
    // Calling it is what makes this see inside Notes and SystemNotes.
    if (typeof node.type === "function") {
      const fn = node.type as (p: unknown) => ReactNode;
      try {
        return textOf(fn(node.props));
      } catch {
        return textOf(props.children);
      }
    }
    return textOf(props.children);
  }
  return "";
}

const BASE: FeedActivity = {
  id: "1",
  type: "call",
  direction: "outbound",
  subject: "Outbound call to +1 704 555 0142",
  occurred_at: "2026-08-17T14:00:00Z",
  duration_seconds: 240,
  result: "connected",
  source: "ringcentral",
  qualifies: true,
  qualification_reason: "Four minutes, a contact on file and a stage change",
  stage_outcome: "Quote",
  notes: "They ship 40 loads a week out of Stockton. Wants a rate on the Reno lane.",
  logged_at: "2026-08-17T14:20:00Z",
  account_id: "a1",
  accountName: "Tanglewood Milling",
  userName: "Dana",
};

const render = (a: Partial<FeedActivity>, view: "notes" | "system") =>
  textOf(ActivityRow({ activity: { ...BASE, ...a }, view }));

describe("the notes view", () => {
  it("shows what the person wrote", () => {
    expect(render({}, "notes")).toContain("They ship 40 loads a week");
  });

  it("does not show the qualifier's reasoning", () => {
    expect(render({}, "notes")).not.toContain("Four minutes, a contact on file");
  });

  it("does not show the subject line the phone system generated", () => {
    expect(render({}, "notes")).not.toContain("Outbound call to");
  });

  it("says qualified or not qualified, in those words", () => {
    expect(render({ qualifies: true }, "notes")).toContain("Qualified");
    expect(render({ qualifies: false }, "notes")).toContain("Not qualified");
  });

  it("names the company and whoever made the call", () => {
    const text = render({}, "notes");
    expect(text).toContain("Tanglewood Milling");
    expect(text).toContain("Dana");
  });

  it("says so plainly when a call was never written up", () => {
    // The most actionable row on the screen: the clock is running down while
    // the history says a call happened. An empty line would hide it.
    const text = render({ notes: null, logged_at: null }, "notes");
    expect(text).toContain("Nothing written up yet");
    expect(text).toContain("not written up");
  });

  it("distinguishes an empty note from an unwritten call", () => {
    const written = render({ notes: null, logged_at: "2026-08-17T14:20:00Z" }, "notes");
    expect(written).toContain("No note.");
    expect(written).not.toContain("Nothing written up yet");
  });

  it("does not treat whitespace as a note", () => {
    expect(render({ notes: "   " }, "notes")).toContain("No note.");
  });
});

describe("the system notes view", () => {
  it("carries the reasoning the notes view leaves out", () => {
    const text = render({}, "system");
    expect(text).toContain("Four minutes, a contact on file");
    expect(text).toContain("Outbound call to");
  });

  it("carries where the record came from and how long it lasted", () => {
    const text = render({}, "system");
    expect(text).toContain("ringcentral");
    expect(text).toContain("Captured by");
    expect(text).toContain("Duration");
  });

  it("still says qualified or not qualified", () => {
    // The verdict belongs on the row in both views. It is the reason the feed
    // exists, and hunting for it in a tab would be worse than the old layout.
    expect(render({ qualifies: false }, "system")).toContain("Not qualified");
  });

  it("omits a fact rather than printing an empty label for it", () => {
    const text = render(
      { result: null, duration_seconds: null, subject: null },
      "system",
    );
    expect(text).not.toContain("Result");
    expect(text).not.toContain("Duration");
    expect(text).not.toContain("Subject");
  });

  it("says a call is not written up rather than leaving the field blank", () => {
    expect(render({ logged_at: null }, "system")).toContain("not yet");
  });
});
