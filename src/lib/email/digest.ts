import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { asRows, setting, type JobContext, type JobResult } from "@/lib/jobs/registry";
import { isGraphError, sendMail } from "./graph";
import { render, toHtml } from "./template";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "digest" });

interface Recipient {
  user_id: string;
  full_name: string;
  email: string;
  prospect_limit: number | null;
  owned: number;
  at_risk: number;
  unlogged: number;
  calls_7d: number;
  qualifying_7d: number;
  at_risk_list: { id: string; name: string; state: string; days_left: number | null }[];
}

/**
 * The morning email.
 *
 * One query builds every broker's numbers, then one message each. The
 * alternative -- a query per person -- is four hundred round trips at five in
 * the morning, and the job stops finishing before people wake up.
 *
 * Every message is written to email_log BEFORE the send is attempted. If the
 * process dies mid-run, the rows already written say exactly how far it got;
 * a log written only on success cannot tell "never started" from "died at
 * number two hundred", and those need different responses.
 *
 * A unique index on (user, template, date) makes a double-fired cron harmless.
 * The insert simply loses, and nobody gets two copies.
 */
export async function sendDailyDigest(ctx: JobContext): Promise<JobResult> {
  const [fromName, replyTo, footer, sendWhenEmpty, appUrl] = await Promise.all([
    setting<string>("email.from_name", "Megaforce CRM"),
    setting<string>("email.reply_to", ""),
    setting<string>("email.footer", ""),
    setting<boolean>("email.digest_send_when_empty", false),
    Promise.resolve(process.env.NEXT_PUBLIC_APP_URL?.trim() || ""),
  ]);

  const tmplRows = await db.execute(sql`
    select subject, body, enabled from email_templates where key = 'daily_digest'
  `);
  const tmpl = asRows<{ subject: string; body: string; enabled: boolean }>(tmplRows)[0];
  if (!tmpl || !tmpl.enabled) {
    return { skipped: true, reason: "the daily digest template is switched off" };
  }

  const rows = await db.execute(sql`select * from digest_recipients()`);
  const recipients = asRows<Recipient>(rows);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of recipients) {
    const atRisk = Number(r.at_risk);
    const unlogged = Number(r.unlogged);

    // A daily email that is usually empty is a daily email people filter, and
    // then they miss the one that mattered.
    if (!sendWhenEmpty && atRisk === 0 && unlogged === 0) {
      skipped += 1;
      continue;
    }

    const list = (r.at_risk_list ?? [])
      .map((a) => {
        const when =
          a.days_left === null
            ? "no deadline"
            : a.days_left < 0
              ? `${Math.abs(a.days_left)} days over`
              : `${a.days_left} days left`;
        return `  • ${a.name} — ${when}`;
      })
      .join("\n");

    const tokens = {
      first_name: r.full_name.split(" ")[0],
      full_name: r.full_name,
      owned_count: Number(r.owned),
      prospect_limit: r.prospect_limit ?? "no limit set",
      at_risk_count: atRisk,
      at_risk_list: list || "  (nothing)",
      unlogged_count: unlogged,
      calls_7d: Number(r.calls_7d),
      qualifying_7d: Number(r.qualifying_7d),
      app_url: appUrl,
    };

    const subject = render(tmpl.subject, tokens);
    const text = render(tmpl.body, tokens);

    // Claim the slot first. The unique index is what makes a second run of the
    // same day a no-op rather than a second inbox copy.
    const inserted = await db.execute(sql`
      insert into email_log (template_key, to_user_id, to_address, subject, body, status)
      values ('daily_digest', ${r.user_id}, ${r.email}, ${subject}, ${text}, 'queued')
      on conflict do nothing
      returning id
    `);
    const logId = asRows<{ id: string }>(inserted)[0]?.id;
    if (!logId) {
      skipped += 1; // already sent today
      continue;
    }

    const result = await sendMail({
      to: r.email,
      subject: `${fromName ? "" : ""}${subject}`,
      html: toHtml(text, footer),
      text,
      replyTo: replyTo || undefined,
    });

    if (isGraphError(result)) {
      failed += 1;
      await db.execute(sql`
        update email_log set status = 'failed', error = ${result.error} where id = ${logId}
      `);
      // Keep going. One bad address must not cost the rest of the floor their
      // morning email.
      log.warn({ to: r.email, error: result.error }, "digest send failed");
      continue;
    }

    sent += 1;
    await db.execute(sql`
      update email_log set status = 'sent', sent_at = now() where id = ${logId}
    `);
  }

  log.info({ sent, skipped, failed, trigger: ctx.trigger }, "digest run complete");
  return { recipients: recipients.length, sent, skipped, failed };
}
