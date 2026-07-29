/**
 * Qualification: deciding whether a captured activity counts.
 *
 * Two things make this module worth its own file.
 *
 * 1. The RULES ARE DATA. They arrive as a row from qualification_rules, not as
 *    constants in this file. Changing "two minutes" to "one minute" is an admin
 *    action, not a deploy. That is the difference between a CRM and a script.
 *
 * 2. A REASON IS ALWAYS PRODUCED, on pass and on fail alike, and it quotes the
 *    actual evidence: the observed duration, the provider's own result string,
 *    the threshold that was applied. When a rep asks "why didn't my call log",
 *    the answer is one column on one row, readable in five seconds, instead of
 *    a support ticket and an afternoon in the logs.
 *
 * This function is deliberately pure. It touches no database and no clock, so
 * every branch is testable without fixtures.
 */

export type ActivityType = "call" | "email" | "meeting" | "note";
export type Direction = "inbound" | "outbound" | null;

/** A rule row, narrowed to what the decision actually needs. */
export interface QualificationRule {
  activityType: ActivityType;
  minDurationSeconds: number;
  /** Empty means any provider result is acceptable. */
  allowedResults: string[];
  /** null means either direction qualifies. */
  requiredDirection: Direction;
}

/** The observable facts about one captured activity. */
export interface QualifiableActivity {
  type: ActivityType;
  durationSeconds: number | null;
  /** Provider outcome verbatim: "Call connected", "Voicemail", "No Answer". */
  result: string | null;
  direction: Direction;
}

export interface QualificationVerdict {
  qualifies: boolean;
  reason: string;
}

/** The rule applied when the database has none for this activity type. */
export const FALLBACK_RULE: QualificationRule = {
  activityType: "call",
  minDurationSeconds: 120,
  allowedResults: ["Call connected", "Accepted"],
  requiredDirection: null,
};

/**
 * Apply a rule to an activity.
 *
 * Checks run cheapest-and-most-decisive first, and the FIRST failure is the one
 * reported. A call that was both too short and went to voicemail gets one clear
 * reason, not a list -- the rep needs to know what to do differently, not a
 * complete audit of every condition.
 */
export function qualify(
  activity: QualifiableActivity,
  rule: QualificationRule | null | undefined,
): QualificationVerdict {
  if (!rule) {
    // Fail closed. An unconfigured activity type must not silently inflate
    // account health; better a visible "no rule" than a wrong "qualified".
    return {
      qualifies: false,
      reason: `no active qualification rule is configured for ${activity.type} activity`,
    };
  }

  if (rule.requiredDirection && activity.direction !== rule.requiredDirection) {
    return {
      qualifies: false,
      reason:
        `direction ${activity.direction ?? "unknown"} does not match the ` +
        `required ${rule.requiredDirection}`,
    };
  }

  if (rule.allowedResults.length > 0) {
    const result = activity.result ?? "";
    if (!rule.allowedResults.includes(result)) {
      return {
        qualifies: false,
        reason: result
          ? `call result "${result}" is not one of the qualifying results ` +
            `(${rule.allowedResults.join(", ")})`
          : `no call result was reported, and one of ` +
            `(${rule.allowedResults.join(", ")}) is required`,
      };
    }
  }

  if (rule.minDurationSeconds > 0) {
    const duration = activity.durationSeconds;
    if (duration === null || duration === undefined) {
      return {
        qualifies: false,
        reason: `no duration was reported, and at least ${rule.minDurationSeconds}s is required`,
      };
    }
    if (duration < rule.minDurationSeconds) {
      return {
        qualifies: false,
        reason: `duration ${duration}s is below the ${rule.minDurationSeconds}s threshold`,
      };
    }
  }

  return { qualifies: true, reason: describePass(activity, rule) };
}

function describePass(activity: QualifiableActivity, rule: QualificationRule): string {
  const parts: string[] = [];
  if (activity.result) parts.push(`result "${activity.result}"`);
  if (rule.minDurationSeconds > 0 && activity.durationSeconds !== null) {
    parts.push(`duration ${activity.durationSeconds}s met the ${rule.minDurationSeconds}s threshold`);
  }
  if (parts.length === 0) parts.push("no conditions configured to fail");
  return `qualified: ${parts.join(", ")}`;
}

/** Narrow a raw qualification_rules row into the shape qualify() expects. */
export function toRule(row: {
  activityType: string;
  minDurationSeconds: number;
  allowedResults: string[] | null;
  requiredDirection: string | null;
}): QualificationRule {
  return {
    activityType: row.activityType as ActivityType,
    minDurationSeconds: row.minDurationSeconds,
    allowedResults: row.allowedResults ?? [],
    requiredDirection: (row.requiredDirection ?? null) as Direction,
  };
}
