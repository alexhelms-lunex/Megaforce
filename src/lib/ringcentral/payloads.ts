/**
 * RingCentral-shaped webhook payload construction.
 *
 * One builder, two consumers: the matcher tests and the call simulator. That is
 * on purpose. If the tests invented their own tidy fixture shape, they would
 * verify the matcher against a payload no provider ever sends, and the first
 * real webhook would fail in a way no test predicted.
 *
 * The shape mirrors RingCentral's Call Log Sync notification, which is the
 * event a CRM should subscribe to: it is the only telephony event that carries
 * both how long the call ran and how it ended, and qualification needs both.
 */

export type CallResult =
  | "Call connected"
  | "Accepted"
  | "Voicemail"
  | "Missed"
  | "No Answer"
  | "Busy"
  | "Rejected"
  | "Hang Up";

export interface CallPayloadOptions {
  /** Telephony session id. Also the idempotency key -- reuse it to redeliver. */
  telephonySessionId: string;
  /** The customer's number, in any format. Normalization is the matcher's job. */
  counterpartyNumber: string;
  /** Our number. Never used for matching. */
  ourNumber?: string;
  direction?: "Inbound" | "Outbound";
  durationSeconds?: number;
  /**
   * The union lists the results worth naming; the `string & {}` keeps it open.
   *
   * RingCentral's real log carries plenty more -- "Stopped", "Internal Error",
   * "IP Phone Offline", "Restricted Number", "Partial" -- and a pulled call must
   * carry its result through VERBATIM. Coercing an unrecognised one to a known
   * value would tell the qualifier a call ended in a way it did not, which is
   * the one lie this pipeline must never tell. The odd construction is what
   * keeps editor completion for the common ones while accepting the rest.
   */
  result?: CallResult | (string & {});
  startTime?: Date;
  /** Extension that handled the call; maps to users.rc_extension_id. */
  extensionId?: string;
  contactName?: string;
}

export function buildCallLogPayload(options: CallPayloadOptions): Record<string, unknown> {
  const {
    telephonySessionId,
    counterpartyNumber,
    ourNumber = "+19195550100",
    direction = "Outbound",
    durationSeconds = 180,
    result = "Call connected",
    startTime = new Date(),
    extensionId = "101",
    contactName = "",
  } = options;

  const customer = { phoneNumber: counterpartyNumber, name: contactName };
  const us = { phoneNumber: ourNumber, name: "Megaforce" };

  return {
    uuid: `evt-${telephonySessionId}`,
    event: `/restapi/v1.0/account/~/extension/${extensionId}/call-log-sync?direction=Inbound&direction=Outbound&type=Voice`,
    timestamp: startTime.toISOString(),
    subscriptionId: "sub-simulated",
    ownerId: "acct-simulated",
    body: {
      // telephonySessionId is lifted at the top of the body as well, because the
      // webhook receiver reads it there without parsing further -- it must stay
      // cheap enough to run inside the 300ms budget.
      telephonySessionId,
      changes: [
        {
          type: "History",
          newRecords: [
            {
              id: `cl-${telephonySessionId}`,
              sessionId: telephonySessionId,
              telephonySessionId,
              startTime: startTime.toISOString(),
              duration: durationSeconds,
              type: "Voice",
              direction,
              action: direction === "Outbound" ? "VoIP Call" : "Phone Call",
              result,
              to: direction === "Outbound" ? customer : us,
              from: direction === "Outbound" ? us : customer,
              extension: { id: extensionId, uri: `.../extension/${extensionId}` },
            },
          ],
        },
      ],
    },
  };
}

/**
 * The other event family: a telephony session notification.
 *
 * Included because it is what the build plan names, and because the matcher has
 * to survive receiving it. Note what is missing: no duration and no result, so
 * a call arriving only in this form cannot qualify on its own. That is a real
 * property of the provider, not an oversight, and the qualifier reports it
 * plainly rather than defaulting to a pass.
 */
export function buildTelephonySessionPayload(options: {
  telephonySessionId: string;
  counterpartyNumber: string;
  ourNumber?: string;
  direction?: "Inbound" | "Outbound";
  extensionId?: string;
  statusCode?: string;
}): Record<string, unknown> {
  const {
    telephonySessionId,
    counterpartyNumber,
    ourNumber = "+19195550100",
    direction = "Outbound",
    extensionId = "101",
    statusCode = "Disconnected",
  } = options;

  const customer = { phoneNumber: counterpartyNumber };
  const us = { phoneNumber: ourNumber };

  return {
    uuid: `evt-${telephonySessionId}`,
    event: "/restapi/v1.0/account/~/extension/~/telephony/sessions",
    timestamp: new Date().toISOString(),
    body: {
      sequence: 3,
      sessionId: telephonySessionId,
      telephonySessionId,
      eventTime: new Date().toISOString(),
      parties: [
        {
          id: `p-${telephonySessionId}`,
          extensionId,
          direction,
          to: direction === "Outbound" ? customer : us,
          from: direction === "Outbound" ? us : customer,
          status: { code: statusCode, reason: "Normal" },
          missedCall: false,
        },
      ],
      origin: { type: "Call" },
    },
  };
}

/** Email-shaped payload for POST /api/webhooks/email. */
export function buildEmailPayload(options: {
  messageId: string;
  counterpartyEmail: string;
  ourEmail?: string;
  direction?: "Inbound" | "Outbound";
  subject?: string;
  sentAt?: Date;
}): Record<string, unknown> {
  const {
    messageId,
    counterpartyEmail,
    ourEmail = "rep@megaforce.test",
    direction = "Outbound",
    subject = "Following up",
    sentAt = new Date(),
  } = options;

  return {
    uuid: `evt-${messageId}`,
    timestamp: sentAt.toISOString(),
    body: {
      messageId,
      direction: direction.toLowerCase(),
      from: direction === "Outbound" ? ourEmail : counterpartyEmail,
      to: [direction === "Outbound" ? counterpartyEmail : ourEmail],
      subject,
      sentAt: sentAt.toISOString(),
    },
  };
}
