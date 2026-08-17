/**
 * The template language, such as it is.
 *
 * {{token}} substitution and {{#if token}}...{{/if}} blocks. That is the whole
 * grammar, and it is deliberately the whole grammar: templates are edited by an
 * administrator in a textarea, and every construct beyond these two is another
 * way for somebody to break the morning email at four in the afternoon.
 *
 * Pure, and separated from anything that sends, so the rendering can be tested
 * exhaustively without a mail server anywhere near it.
 */

export type Tokens = Record<string, string | number | boolean | null | undefined>;

/** A token is truthy unless it is absent, false, empty, or the number zero. */
function truthy(value: Tokens[string]): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

export function render(template: string, tokens: Tokens): string {
  // Conditionals first, so a token inside a false block is never substituted --
  // and so an unknown token inside a removed block cannot be reported missing.
  const withConditionals = renderConditionals(template, tokens);
  return renderTokens(withConditionals, tokens);
}

/**
 * Innermost-first, repeatedly, so nested blocks resolve correctly.
 *
 * A single non-greedy pass would mis-pair the closing tags of nested blocks and
 * silently emit half a template.
 */
function renderConditionals(input: string, tokens: Tokens): string {
  const block = /\{\{#if\s+([\w.]+)\s*\}\}((?:(?!\{\{#if)[\s\S])*?)\{\{\/if\}\}/;
  let out = input;
  // Bounded rather than while(true): a malformed template must not spin.
  for (let i = 0; i < 20; i++) {
    const next = out.replace(block, (_m, key: string, body: string) =>
      truthy(tokens[key]) ? body : "",
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

function renderTokens(input: string, tokens: Tokens): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const value = tokens[key];
    // An unknown token renders empty rather than leaving {{like_this}} in
    // somebody's inbox. A visible placeholder in a customer-facing email is
    // worse than a missing sentence.
    if (value === undefined || value === null || value === false) return "";
    return String(value);
  });
}

/** Which tokens a template references. Shown beside the editor. */
export function tokensUsed(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*(?:#if\s+)?([\w.]+)\s*\}\}/g)) {
    if (m[1] !== "if") found.add(m[1]);
  }
  return [...found].sort();
}

/** Plain text to a minimal HTML body, preserving paragraphs and line breaks. */
export function toHtml(text: string, footer?: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, "<br />")}</p>`)
    .join("");

  return [
    // Inter first, then the faces every mail client actually has. Webfonts are
    // unreliable in email -- Outlook desktop ignores them outright -- so the
    // fallback chain is doing the real work here; naming Inter first simply
    // means the digest matches the application anywhere it can.
    `<div style="font-family:Inter,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#0d1b2a;max-width:600px">`,
    `<div style="border-top:4px solid #1b1bff;padding-top:16px">${paragraphs}</div>`,
    footer
      ? `<p style="margin-top:24px;padding-top:12px;border-top:1px solid #d9e2ec;font-size:12px;color:#5a6b80">${footer
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")}</p>`
      : "",
    `</div>`,
  ].join("");
}
