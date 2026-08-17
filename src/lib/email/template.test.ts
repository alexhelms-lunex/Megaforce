import { describe, expect, it } from "vitest";
import { render, tokensUsed, toHtml } from "./template";

/**
 * The template language.
 *
 * Worth testing hard for one reason: administrators edit these in a textarea,
 * and the output goes to four hundred inboxes at five in the morning with
 * nobody awake to notice it went wrong. Every failure mode here is one that
 * would be discovered by a customer rather than by us.
 */

describe("substitution", () => {
  it("replaces a token with its value", () => {
    expect(render("Hello {{first_name}}.", { first_name: "Dana" })).toBe("Hello Dana.");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(render("Hi {{  first_name  }}", { first_name: "Dana" })).toBe("Hi Dana");
  });

  it("renders numbers, including zero", () => {
    // Zero is a real answer -- "0 calls this week" is the message. A naive
    // falsy check would render it as blank and turn a bad week into no news.
    expect(render("{{calls}} calls", { calls: 0 })).toBe("0 calls");
  });

  it("drops an unknown token rather than printing the braces", () => {
    // A visible {{placeholder}} in somebody's inbox is worse than a missing
    // clause, and it is the thing that makes a system look unfinished.
    expect(render("Hello {{nope}}.", {})).toBe("Hello .");
  });

  it("replaces every occurrence, not just the first", () => {
    expect(render("{{n}} and {{n}}", { n: 2 })).toBe("2 and 2");
  });

  it("leaves text alone when there is nothing to substitute", () => {
    expect(render("No tokens here.", { a: 1 })).toBe("No tokens here.");
  });

  it("does not re-process a value that itself looks like a token", () => {
    // Otherwise a company genuinely named "{{admin}}" would substitute again,
    // which is the small door that template injection walks through.
    expect(render("{{name}}", { name: "{{secret}}" })).toBe("{{secret}}");
  });
});

describe("conditionals", () => {
  it("keeps the block when the token has a value", () => {
    expect(render("{{#if n}}You have {{n}}.{{/if}}", { n: 3 })).toBe("You have 3.");
  });

  it("drops the block when the token is zero", () => {
    // "You have 0 calls to write up" is noise. Zero means say nothing.
    expect(render("{{#if n}}You have {{n}}.{{/if}}done", { n: 0 })).toBe("done");
  });

  it("drops the block for an absent, empty or false token", () => {
    for (const value of [undefined, null, "", "   ", false]) {
      expect(render("{{#if x}}shown{{/if}}", { x: value })).toBe("");
    }
  });

  it("handles two separate blocks in one template", () => {
    const out = render("{{#if a}}A{{/if}}{{#if b}}B{{/if}}", { a: 1, b: 0 });
    expect(out).toBe("A");
  });

  it("resolves nested blocks", () => {
    const t = "{{#if outer}}out {{#if inner}}in{{/if}}{{/if}}";
    expect(render(t, { outer: 1, inner: 1 })).toBe("out in");
    expect(render(t, { outer: 1, inner: 0 })).toBe("out ");
    expect(render(t, { outer: 0, inner: 1 })).toBe("");
  });

  it("terminates on an unclosed block instead of hanging", () => {
    // Somebody will delete a {{/if}} by accident. The renderer has to survive
    // it, because the alternative is a scheduled job that never returns.
    const out = render("{{#if a}}dangling", { a: 1 });
    expect(out).toContain("dangling");
  });
});

describe("the token list shown beside the editor", () => {
  it("reports every token, including the ones in conditions", () => {
    expect(tokensUsed("{{#if a}}{{b}}{{/if}} {{c}}")).toEqual(["a", "b", "c"]);
  });

  it("deduplicates", () => {
    expect(tokensUsed("{{a}} {{a}}")).toEqual(["a"]);
  });
});

describe("html rendering", () => {
  it("escapes markup so a company name cannot inject", () => {
    const html = toHtml("Halvorsen <script>alert(1)</script> Foods");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps paragraphs and line breaks", () => {
    const html = toHtml("one\ntwo\n\nthree");
    expect(html).toContain("one<br />two");
    expect(html.match(/<p /g)?.length).toBe(2);
  });

  it("appends the footer when there is one", () => {
    expect(toHtml("body", "unsubscribe note")).toContain("unsubscribe note");
    expect(toHtml("body")).not.toContain("border-top:1px solid");
  });
});
