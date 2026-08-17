import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { asRows, setting, type JobResult } from "@/lib/jobs/registry";
import { credentials } from "@/lib/integrations/store";
import { isGraphError, listMessages, type GraphMessage } from "./graph";
import { qualify, toRule } from "@/lib/qualify";
import * as schema from "@/lib/db/schema";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "inbox" });

/**
 * Turning Outlook mail into activity.
 *
 * The prospecting policy is strict about what counts, and it is the reason this
 * is not simply "log every email":
 *
 *   an email counts only when the other party is a CONTACT ON FILE.
 *
 * Alex was explicit -- "IT MUST BE ON FILE it will not count if it is not in
 * salesforce". So the address on the message is matched against contacts, and a
 * message to somebody nobody has ever added is not activity. That is a feature:
 * it means the clock cannot be reset by emailing a stranger, and it gives
 * brokers a concrete reason to keep contacts current.
 *
 * Both directions are read. A broker's outbound pitch counts and never appears
 * in the Inbox folder, so the whole mailbox is scanned rather than one folder.
 */

/** Which mailboxes to read: every broker and manager who has an email address. */
async function mailboxes(): Promise<{ userId: string; address: string }[]> {
  const rows = await db.execute(sql`
    select id, email from users
     where email is not null and role in ('broker','manager')
     order by email
  `);
  return asRows<{ id: string; email: string }>(rows).map((r) => ({
    userId: r.id,
    address: r.email,
  }));
}

export async function syncMailboxes(): Promise<JobResult> {
  const creds = await credentials("microsoft");
  if (!creds) {
    return { skipped: true, reason: "Microsoft 365 is not connected" };
  }

  // Deliberate overlap: a message that arrives while a run is in flight would
  // otherwise fall between two windows and never be seen. Duplicates are
  // impossible anyway -- the external id carries the message id.
  const lookback = Number(await setting<number>("inbox.lookback_minutes", 90));
  const since = new Date(Date.now() - Math.max(15, lookback) * 60_000);

  const boxes = await mailboxes();
  let read = 0;
  let logged = 0;
  let unmatched = 0;
  let failedBoxes = 0;

  const rule = await activeEmailRule();

  for (const box of boxes) {
    const messages = await listMessages(box.address, since);
    if (isGraphError(messages)) {
      failedBoxes += 1;
      log.warn({ mailbox: box.address, error: messages.error }, "mailbox unreadable");
      continue;
    }

    read += messages.length;

    for (const message of messages) {
      const outcome = await logMessage(message, box, rule);
      if (outcome === "logged") logged += 1;
      else if (outcome === "unmatched") unmatched += 1;
    }
  }

  return { mailboxes: boxes.length, read, logged, unmatched, failedBoxes };
}

async function activeEmailRule() {
  const rows = await db
    .select()
    .from(schema.qualificationRules)
    .where(
      sql`${schema.qualificationRules.activityType} = 'email' and ${schema.qualificationRules.active}`,
    )
    .limit(1);
  return rows[0] ? toRule(rows[0]) : null;
}

type Outcome = "logged" | "unmatched" | "duplicate" | "self";

/**
 * One message.
 *
 * Returns rather than throws, because one malformed message must not abandon
 * the rest of the mailbox.
 */
async function logMessage(
  message: GraphMessage,
  box: { userId: string; address: string },
  rule: ReturnType<typeof toRule> | null,
): Promise<Outcome> {
  const fromAddress = message.from?.emailAddress?.address?.toLowerCase() ?? null;
  const toAddresses = (message.toRecipients ?? [])
    .map((r) => r.emailAddress?.address?.toLowerCase())
    .filter((a): a is string => Boolean(a));

  const mine = box.address.toLowerCase();
  const outbound = fromAddress === mine;

  // The other party -- whoever is not the broker. Internal mail between two
  // colleagues is not customer activity and is dropped here.
  const others = outbound ? toAddresses.filter((a) => a !== mine) : fromAddress ? [fromAddress] : [];
  if (others.length === 0) return "self";

  const matched = await db.execute(sql`
    select c.id as contact_id, c.account_id, a.owner_id
      from contacts c
      join accounts a on a.id = c.account_id
     where lower(c.email) = any(${sql`array[${sql.join(
       others.map((o) => sql`${o}`),
       sql`, `,
     )}]::text[]`})
     limit 2
  `);
  const hits = asRows<{ contact_id: string; account_id: string; owner_id: string | null }>(matched);

  const externalId = `msgraph:${message.internetMessageId || message.id}`;

  if (hits.length === 0) {
    // Nobody on file. Per policy this is not activity -- but it is worth
    // knowing about, so it goes to the review queue where a broker can add the
    // contact and resolve it, rather than vanishing.
    await recordUnmatched(message, box, others[0], externalId);
    return "unmatched";
  }

  const hit = hits[0];
  const occurredAt = new Date(message.sentDateTime || message.receivedDateTime);
  const verdict = qualify(
    {
      type: "email",
      durationSeconds: null,
      result: null,
      direction: outbound ? "outbound" : "inbound",
    },
    rule,
  );

  // externalId carries the message id and the table has a unique index on it,
  // so the deliberate lookback overlap cannot produce a second copy.
  const inserted = await db.execute(sql`
    insert into activities
      (account_id, contact_id, user_id, type, direction, subject, occurred_at,
       source, external_id, qualifies, qualification_reason)
    values
      (${hit.account_id}, ${hit.contact_id}, ${box.userId}, 'email',
       ${outbound ? "outbound" : "inbound"},
       ${message.subject ?? "(no subject)"}, ${occurredAt.toISOString()},
       'outlook', ${externalId}, ${verdict.qualifies}, ${verdict.reason})
    on conflict (external_id) where external_id is not null do nothing
    returning id
  `);

  return asRows<{ id: string }>(inserted).length > 0 ? "logged" : "duplicate";
}

async function recordUnmatched(
  message: GraphMessage,
  box: { userId: string; address: string },
  otherAddress: string,
  externalId: string,
): Promise<void> {
  await db.execute(sql`
    insert into raw_events (source, external_id, payload)
    values ('email', ${externalId}, ${JSON.stringify({
      from: message.from?.emailAddress?.address ?? null,
      to: (message.toRecipients ?? []).map((r) => r.emailAddress?.address),
      subject: message.subject,
      receivedDateTime: message.receivedDateTime,
      mailbox: box.address,
    })}::jsonb)
    on conflict (source, external_id) do nothing
  `);

  await db.execute(sql`
    insert into unmatched_activities (raw_event_id, email, subject, direction, occurred_at, reason)
    select r.id, ${otherAddress}, ${message.subject ?? "(no subject)"},
           ${message.from?.emailAddress?.address?.toLowerCase() === box.address.toLowerCase()
             ? "outbound"
             : "inbound"},
           ${new Date(message.receivedDateTime).toISOString()},
           'no contact on file has this email address'
      from raw_events r
     where r.source = 'email' and r.external_id = ${externalId}
       and not exists (
         select 1 from unmatched_activities u where u.raw_event_id = r.id
       )
  `);
}
