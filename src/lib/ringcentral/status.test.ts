import { describe, expect, it } from "vitest";
import { describeDbError, isUnreachable } from "@/lib/ringcentral/status";

/**
 * Telling "cannot reach the database" apart from "the database said no".
 *
 * ===========================================================================
 * WHY THIS IS WORTH TESTING
 *
 * These two failures need OPPOSITE actions -- check DATABASE_URL versus apply
 * the pending migrations -- and the screen that reports them was getting it
 * backwards. A missing column was announced as "the server cannot reach the
 * database directly", which sent somebody to rotate a connection string that
 * was working perfectly.
 *
 * It got it backwards because Drizzle wraps every failure in an error whose
 * message is the literal SQL. The page saw four hundred characters of SELECT,
 * could make nothing of it, and fell back to the worst assumption. Postgres'
 * own sentence -- "column a.extension_id does not exist" -- was sitting one
 * level down on `.cause` the whole time.
 * ===========================================================================
 */

/** What Drizzle actually throws: its own message, the real one underneath. */
function drizzleError(pgMessage: string, code?: string) {
  const cause = Object.assign(new Error(pgMessage), code ? { code } : {});
  return Object.assign(new Error("Failed query: select * from ( select a.occurred_at ... )"), {
    cause,
  });
}

describe("finding the real reason", () => {
  it("skips Drizzle's message and reports Postgres'", () => {
    const failure = describeDbError(
      drizzleError('column a.extension_id does not exist', "42703"),
    );
    expect(failure.message).toBe("column a.extension_id does not exist");
    expect(failure.message).not.toMatch(/Failed query/);
  });

  it("keeps the SQLSTATE, which is what the decision is made on", () => {
    expect(describeDbError(drizzleError("nope", "42703")).code).toBe("42703");
  });

  it("digs through more than one layer", () => {
    const inner = Object.assign(new Error('relation "live_calls" does not exist'), {
      code: "42P01",
    });
    const middle = Object.assign(new Error("Failed query: select 1"), { cause: inner });
    const outer = Object.assign(new Error("Failed query: select 2"), { cause: middle });
    expect(describeDbError(outer).message).toBe('relation "live_calls" does not exist');
  });

  it("falls back to whatever it was given rather than to nothing", () => {
    expect(describeDbError(new Error("boom")).message).toBe("boom");
    expect(describeDbError("a string").message).toBe("a string");
  });
});

describe("which of the two problems it is", () => {
  it("a missing column is NOT an unreachable database", () => {
    // The exact case that produced the wrong advice on screen.
    const failure = describeDbError(drizzleError("column a.extension_id does not exist", "42703"));
    expect(isUnreachable(failure)).toBe(false);
  });

  it("a missing table is NOT either", () => {
    const failure = describeDbError(drizzleError('relation "live_calls" does not exist', "42P01"));
    expect(isUnreachable(failure)).toBe(false);
  });

  it("a missing function is NOT either", () => {
    const failure = describeDbError(drizzleError("function claim_extension does not exist", "42883"));
    expect(isUnreachable(failure)).toBe(false);
  });

  it("a timeout IS", () => {
    const failure = describeDbError(new Error("The database did not answer within 8s."));
    expect(isUnreachable(failure)).toBe(true);
  });

  it("a refused connection IS", () => {
    const failure = describeDbError(
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:6543"), { code: "ECONNREFUSED" }),
    );
    expect(isUnreachable(failure)).toBe(true);
  });

  it("a rejected password IS — the connection string is what changed", () => {
    const failure = describeDbError(
      Object.assign(new Error("password authentication failed"), { code: "28P01" }),
    );
    expect(isUnreachable(failure)).toBe(true);
  });

  it("reads 'does not exist' even without a code", () => {
    // Some drivers drop the SQLSTATE. The wording is a weaker signal than the
    // code and is used only as a fallback, but guessing "unreachable" here
    // would resurrect the exact wrong advice.
    const failure = describeDbError(drizzleError("column foo does not exist"));
    expect(isUnreachable(failure)).toBe(false);
  });
});
