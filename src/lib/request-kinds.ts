/**
 * What an account request can ask for.
 *
 * A plain module rather than part of the server actions file: a "use server"
 * module may only export async functions, so a constant living there breaks the
 * build at the point Next.js collects page data — long after the code looks
 * correct.
 */
export const REQUEST_KINDS = [
  {
    value: "amnesty",
    label: "Amnesty — let me keep this prospect",
    help: "The clock has run out or is about to. Ask your manager for more time.",
    needsDays: true,
    needsTarget: false,
    needsAmount: false,
  },
  {
    value: "extension",
    label: "Extension — hold this customer longer",
    help: "A customer past its window. Per policy this is the Sales Director's call.",
    needsDays: true,
    needsTarget: false,
    needsAmount: false,
  },
  {
    value: "national",
    label: "Promote to national account",
    help: "Proposes the account as national. Somebody else approves it.",
    needsDays: false,
    needsTarget: false,
    needsAmount: false,
  },
  {
    value: "transfer",
    label: "Transfer to another rep",
    help: "Hand the account over. The receiving rep's clock starts fresh.",
    needsDays: false,
    needsTarget: true,
    needsAmount: false,
  },
  {
    value: "credit",
    label: "Credit limit — ask Customer Credit to set or raise it",
    help:
      "Goes to Customer Credit, not to your manager. Say what limit you need and why — a lane " +
      "count or a monthly spend is the argument that gets it approved.",
    needsDays: false,
    needsTarget: false,
    needsAmount: true,
  },
  {
    value: "release",
    label: "Release it early",
    help: "Give it back to the pool now rather than waiting for the clock.",
    needsDays: false,
    needsTarget: false,
    needsAmount: false,
  },
] as const;

export type RequestKind = (typeof REQUEST_KINDS)[number]["value"];

export const REQUEST_KIND_LABEL: Record<string, string> = {
  amnesty: "Amnesty",
  extension: "Extension",
  national: "National account",
  credit: "Credit limit",
  transfer: "Transfer",
  release: "Early release",
};
