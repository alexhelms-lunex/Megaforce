import { describe, expect, it } from "vitest";
import { qualify, type QualifiableActivity, type QualificationRule } from "./qualify";

/** The shipped default: 120 seconds and the call actually connected. */
const CALL_RULE: QualificationRule = {
  activityType: "call",
  minDurationSeconds: 120,
  allowedResults: ["Call connected", "Accepted"],
  requiredDirection: null,
};

function call(over: Partial<QualifiableActivity> = {}): QualifiableActivity {
  return {
    type: "call",
    durationSeconds: 300,
    result: "Call connected",
    direction: "outbound",
    ...over,
  };
}

describe("qualify -- the duration boundary", () => {
  // Stated explicitly in the build plan, because off-by-one on a threshold is
  // the kind of bug that is invisible until someone audits a month of activity.
  it("fails at 119 seconds and passes at 121", () => {
    expect(qualify(call({ durationSeconds: 119 }), CALL_RULE).qualifies).toBe(false);
    expect(qualify(call({ durationSeconds: 121 }), CALL_RULE).qualifies).toBe(true);
  });

  it("treats the threshold itself as qualifying", () => {
    // 120 means "at least two minutes", not "more than two minutes".
    expect(qualify(call({ durationSeconds: 120 }), CALL_RULE).qualifies).toBe(true);
  });

  it("names the observed duration and the threshold when it fails", () => {
    const { reason } = qualify(call({ durationSeconds: 47 }), CALL_RULE);
    expect(reason).toContain("47s");
    expect(reason).toContain("120s");
  });

  it("fails a call with no duration rather than assuming zero or infinity", () => {
    const v = qualify(call({ durationSeconds: null }), CALL_RULE);
    expect(v.qualifies).toBe(false);
    expect(v.reason).toContain("no duration");
  });
});

describe("qualify -- the result check", () => {
  it("rejects every non-connected outcome and quotes it back", () => {
    for (const result of ["Voicemail", "No Answer", "Busy", "Missed", "Rejected"]) {
      const v = qualify(call({ result }), CALL_RULE);
      expect(v.qualifies, result).toBe(false);
      expect(v.reason).toContain(`"${result}"`);
    }
  });

  it("accepts any result the rule lists", () => {
    expect(qualify(call({ result: "Call connected" }), CALL_RULE).qualifies).toBe(true);
    expect(qualify(call({ result: "Accepted" }), CALL_RULE).qualifies).toBe(true);
  });

  it("skips the result check entirely when the rule lists none", () => {
    const anyResult = { ...CALL_RULE, allowedResults: [] };
    expect(qualify(call({ result: "Voicemail" }), anyResult).qualifies).toBe(true);
  });

  it("fails a missing result when one is required", () => {
    const v = qualify(call({ result: null }), CALL_RULE);
    expect(v.qualifies).toBe(false);
    expect(v.reason).toContain("no call result");
  });
});

describe("qualify -- direction", () => {
  it("ignores direction when the rule does not require one", () => {
    expect(qualify(call({ direction: "inbound" }), CALL_RULE).qualifies).toBe(true);
    expect(qualify(call({ direction: "outbound" }), CALL_RULE).qualifies).toBe(true);
  });

  it("enforces direction when the rule requires it", () => {
    const outboundOnly = { ...CALL_RULE, requiredDirection: "outbound" as const };
    expect(qualify(call({ direction: "outbound" }), outboundOnly).qualifies).toBe(true);
    const v = qualify(call({ direction: "inbound" }), outboundOnly);
    expect(v.qualifies).toBe(false);
    expect(v.reason).toContain("inbound");
    expect(v.reason).toContain("outbound");
  });
});

describe("qualify -- reporting", () => {
  it("reports exactly one reason, the first thing that failed", () => {
    // Both too short AND the wrong result. The rep needs one instruction.
    const v = qualify(call({ durationSeconds: 12, result: "Voicemail" }), CALL_RULE);
    expect(v.qualifies).toBe(false);
    // Result is checked before duration, so that is what is reported.
    expect(v.reason).toContain("Voicemail");
    expect(v.reason).not.toContain("12s");
  });

  it("writes a reason on success too, not only on failure", () => {
    const v = qualify(call({ durationSeconds: 184 }), CALL_RULE);
    expect(v.qualifies).toBe(true);
    expect(v.reason).not.toBe("");
    expect(v.reason).toContain("184s");
  });

  it("fails closed when no rule is configured", () => {
    // An unconfigured type must never silently count as activity -- that would
    // make a dead account look healthy on the dashboard.
    const v = qualify(call(), null);
    expect(v.qualifies).toBe(false);
    expect(v.reason).toContain("no active qualification rule");
  });
});

describe("qualify -- rules really are data", () => {
  it("changes behaviour when the threshold changes, with no code change", () => {
    const short = { ...CALL_RULE, minDurationSeconds: 60 };
    const activity = call({ durationSeconds: 90 });
    expect(qualify(activity, CALL_RULE).qualifies).toBe(false);
    expect(qualify(activity, short).qualifies).toBe(true);
  });

  it("supports a permissive rule for activity types with no duration", () => {
    const emailRule: QualificationRule = {
      activityType: "email",
      minDurationSeconds: 0,
      allowedResults: [],
      requiredDirection: null,
    };
    const email: QualifiableActivity = {
      type: "email",
      durationSeconds: null,
      result: null,
      direction: "outbound",
    };
    expect(qualify(email, emailRule).qualifies).toBe(true);
  });

  it("supports a rule that can never pass, for notes", () => {
    const noteRule: QualificationRule = {
      activityType: "note",
      minDurationSeconds: 2147483647,
      allowedResults: ["__never__"],
      requiredDirection: null,
    };
    const note: QualifiableActivity = {
      type: "note",
      durationSeconds: null,
      result: null,
      direction: null,
    };
    expect(qualify(note, noteRule).qualifies).toBe(false);
  });
});
