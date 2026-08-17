import "server-only";
import { credentials, recordHealth } from "@/lib/integrations/store";
import { logger } from "@/lib/logger";

/**
 * Microsoft 365, through the Graph API.
 *
 * One client for both halves of the email system: the morning digest goes out
 * through sendMail, and inbox logging comes back through listMessages. They
 * share an app registration, a token, and a health status, so "is Outlook
 * connected" has exactly one answer on the settings screen rather than two that
 * can disagree.
 *
 * Client-credentials flow rather than per-user OAuth: the CRM reads and sends on
 * behalf of the organisation, and nobody wants to re-consent forty brokers
 * every time a refresh token lapses. The trade is that the app registration
 * needs Mail.Read and Mail.Send as application permissions with admin consent,
 * which is stated on the settings screen.
 */

const log = logger.child({ component: "graph" });
const GRAPH = "https://graph.microsoft.com/v1.0";

export interface GraphError {
  error: string;
}

/**
 * Tokens are cached in module scope for their lifetime, minus a minute.
 *
 * Serverless makes this a per-instance cache, which is exactly the right
 * granularity: an instance handling a digest run for four hundred brokers
 * fetches one token rather than four hundred, and a cold start simply fetches
 * its own.
 */
let cached: { token: string; expires: number } | null = null;

export async function graphToken(): Promise<string | GraphError> {
  if (cached && cached.expires > Date.now()) return cached.token;

  const creds = await credentials("microsoft");
  if (!creds) {
    return { error: "Microsoft 365 is not connected, or the encryption key does not match." };
  }

  const tenant = creds.config.tenant_id?.trim();
  const clientId = creds.config.client_id?.trim();
  const clientSecret = creds.secrets.client_secret?.trim();
  if (!tenant || !clientId || !clientSecret) {
    return { error: "Microsoft 365 is missing its tenant ID, client ID or client secret." };
  }

  try {
    const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      // Microsoft's error bodies name the actual problem -- an expired secret,
      // a missing consent -- and that sentence is far more use on the settings
      // screen than "401".
      const message = `Microsoft refused the credentials (${res.status}). ${firstLine(detail)}`;
      await recordHealth("microsoft", false, message);
      return { error: message };
    }

    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = {
      token: body.access_token,
      expires: Date.now() + Math.max(60, body.expires_in - 60) * 1000,
    };
    await recordHealth("microsoft", true);
    return cached.token;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordHealth("microsoft", false, message);
    return { error: `Could not reach Microsoft: ${message}` };
  }
}

function firstLine(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error_description?: string; error?: string };
    return (parsed.error_description ?? parsed.error ?? text).split("\n")[0].slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

export interface SendOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

/** Send one message as the configured mailbox. */
export async function sendMail(opts: SendOptions): Promise<{ ok: true } | GraphError> {
  const token = await graphToken();
  if (typeof token !== "string") return token;

  const creds = await credentials("microsoft");
  const from = creds?.config.send_as?.trim();
  if (!from) {
    return { error: "No send-as mailbox is configured for Microsoft 365." };
  }

  try {
    const res = await fetch(`${GRAPH}/users/${encodeURIComponent(from)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: opts.subject,
          body: { contentType: "HTML", content: opts.html },
          toRecipients: [{ emailAddress: { address: opts.to } }],
          ...(opts.replyTo
            ? { replyTo: [{ emailAddress: { address: opts.replyTo } }] }
            : {}),
        },
        saveToSentItems: true,
      }),
    });

    if (!res.ok) {
      const message = `Graph refused the send (${res.status}). ${firstLine(await res.text())}`;
      await recordHealth("microsoft", false, message);
      return { error: message };
    }
    await recordHealth("microsoft", true);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordHealth("microsoft", false, message);
    return { error: message };
  }
}

export interface GraphMessage {
  id: string;
  internetMessageId: string;
  subject: string | null;
  receivedDateTime: string;
  sentDateTime: string;
  from: { emailAddress: { address: string; name?: string } } | null;
  toRecipients: { emailAddress: { address: string } }[];
  bodyPreview: string | null;
}

/**
 * Messages in a mailbox since a given moment, both directions.
 *
 * The policy counts an email either way as long as the other party is a contact
 * on file, so this reads the whole mailbox rather than only the inbox -- a
 * broker's outbound pitch counts, and it never appears in Inbox.
 */
export async function listMessages(
  mailbox: string,
  since: Date,
  limit = 200,
): Promise<GraphMessage[] | GraphError> {
  const token = await graphToken();
  if (typeof token !== "string") return token;

  const filter = `receivedDateTime ge ${since.toISOString()}`;
  const select =
    "id,internetMessageId,subject,receivedDateTime,sentDateTime,from,toRecipients,bodyPreview";
  const url =
    `${GRAPH}/users/${encodeURIComponent(mailbox)}/messages` +
    `?$filter=${encodeURIComponent(filter)}&$select=${select}&$top=${limit}` +
    `&$orderby=${encodeURIComponent("receivedDateTime desc")}`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const message = `Graph refused the read (${res.status}). ${firstLine(await res.text())}`;
      await recordHealth("microsoft", false, message);
      return { error: message };
    }
    const body = (await res.json()) as { value: GraphMessage[] };
    await recordHealth("microsoft", true);
    return body.value ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, mailbox }, "mailbox read failed");
    await recordHealth("microsoft", false, message);
    return { error: message };
  }
}

export function isGraphError(value: unknown): value is GraphError {
  return typeof value === "object" && value !== null && "error" in value;
}
