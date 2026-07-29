import { Inngest } from "inngest";

/**
 * Job runner client.
 *
 * The webhook endpoint's only job is to get the payload on disk and return 200.
 * Everything after that -- parsing, matching, qualifying, writing -- happens
 * here, where taking four seconds and retrying twice is fine. Doing it inline
 * would push the endpoint past the provider's timeout, and a timeout is
 * interpreted as failure and redelivered, so a slow handler manufactures the
 * duplicates it then has to defend against.
 */
export const inngest = new Inngest({
  id: "megaforce-crm",
  eventKey: process.env.INNGEST_EVENT_KEY,
});

/** Event names, in one place so a typo is a compile error rather than silence. */
export const EVENTS = {
  callReceived: "rc/call.received",
  emailReceived: "email/message.received",
  subscriptionRenewal: "rc/subscription.renew",
} as const;

export type ProcessEventData = { rawEventId: string };
