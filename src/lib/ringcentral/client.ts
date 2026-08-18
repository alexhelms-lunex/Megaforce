/**
 * RingCentral API client.
 *
 * Not exercised until a sandbox app exists and the app is deployed to a public
 * URL -- RingCentral will not deliver webhooks to localhost. Until then the
 * simulator in scripts/simulate-calls.ts drives the identical pipeline, and
 * this file is what gets switched on afterwards. Nothing downstream changes.
 *
 * Verify scope names and endpoint paths against RingCentral's current
 * documentation before going live; they move.
 */
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "ringcentral" });

interface CachedToken {
  token: string;
  /** Epoch milliseconds after which the token must not be reused. */
  expiresAt: number;
}

let cached: CachedToken | null = null;

/**
 * Fetch an access token, reusing the cached one until it is nearly expired.
 *
 * The JWT flow, not the authorization-code flow: there is no user sitting in a
 * browser to consent, and a server-to-server integration should not pretend
 * otherwise. A long-lived JWT is exchanged for a short-lived access token.
 *
 * Refreshing at 80% of the stated lifetime, rather than at expiry, is the
 * detail that matters. Tokens die mid-request otherwise, and the failure is
 * intermittent, which makes it expensive to diagnose. Hardcoding a token that
 * dies in an hour is the classic version of the same mistake.
 */
export async function rcToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  if (!env.ringCentralConfigured) {
    throw new Error(
      "RingCentral is not configured. Set RC_CLIENT_ID, RC_CLIENT_SECRET and RC_JWT, " +
        "or use the call simulator: npm run simulate",
    );
  }

  const basic = Buffer.from(`${env.RC_CLIENT_ID}:${env.RC_CLIENT_SECRET}`).toString("base64");

  const res = await fetch(`${env.RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: env.RC_JWT,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`RingCentral token request failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = {
    token: json.access_token,
    // 80% of the lifetime, in milliseconds: expires_in is seconds, so
    // expires_in * 1000 * 0.8 === expires_in * 800.
    expiresAt: Date.now() + json.expires_in * 800,
  };

  log.info({ expiresInSeconds: json.expires_in }, "obtained RingCentral access token");
  return cached.token;
}

/** Discard the cached token. Used by tests and after a 401. */
export function resetTokenCache(): void {
  cached = null;
}

interface Subscription {
  id: string;
  status: string;
  expirationTime: string;
  eventFilters?: string[];
  deliveryMode?: { address?: string };
}

const WEBHOOK_PATH = "/api/webhooks/ringcentral";

/**
 * The events worth subscribing to, best first.
 *
 * ===========================================================================
 * THE FILTER THAT WAS HERE DOES NOT EXIST
 *
 * It was:
 *
 *   /restapi/v1.0/account/~/extension/~/call-log-sync?direction=Inbound&...
 *
 * and RingCentral answered every attempt to create it with
 *
 *   400 CMN-101: Parameter [eventFilters] value is invalid
 *
 * because there is no call-log-sync subscription event. Call log sync is a
 * READ API you poll -- which is what lib/ringcentral/pull.ts does -- not
 * something you can be notified about. The supported event index lists
 * telephony sessions, message store, presence and account events, and no call
 * log event at all.
 *
 * TELEPHONY SESSIONS IS ALSO THE ONE ALEX ASKED FOR
 *
 * "If I make a call right now it needs to show there even if the person has
 * not even picked up. with a live second counter."
 *
 * A completed-call notification could never do that -- by definition it arrives
 * after the call. Telephony sessions fire on every state change: the phone
 * starts ringing, somebody answers, somebody hangs up. That is the live call.
 *
 * The account-level filter covers every extension; the extension-level one
 * covers only the handset the JWT belongs to. Account level is tried first
 * because a CRM has to see the whole floor, and the fallback exists because an
 * app without the account-level permission would otherwise get nothing at all
 * rather than something useful.
 *
 * The completed record, with duration and result, still comes from the call log
 * pull. Two sources, each doing the half it can: sessions say what is happening
 * now, the log says what happened and for how long.
 * ===========================================================================
 */
export const EVENT_FILTER_CANDIDATES = [
  // Every call on the account, live.
  ["/restapi/v1.0/account/~/telephony/sessions"],
  // Fallback: only the extension this JWT belongs to.
  ["/restapi/v1.0/account/~/extension/~/telephony/sessions"],
] as const;

async function listSubscriptions(token: string): Promise<Subscription[]> {
  const res = await fetch(`${env.RC_SERVER}/restapi/v1.0/subscription`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`failed to list subscriptions (${res.status})`);
  const json = (await res.json()) as { records?: Subscription[] };
  return json.records ?? [];
}

/**
 * Make sure a live subscription points at this deployment, creating or renewing
 * as needed. Safe to call repeatedly; the daily cron does exactly that.
 *
 * Renewal is not optional. Subscriptions expire, and when one lapses calls just
 * stop arriving -- no error, no failed request, nothing in a log. The first
 * symptom is a rep asking why nothing has logged since Tuesday.
 */
export async function ensureSubscription(): Promise<{
  id: string;
  action: string;
  /** Which filters RingCentral actually accepted, so the screen can say. */
  filters: string[];
}> {
  const token = await rcToken();
  const address = `${env.APP_URL.replace(/\/$/, "")}${WEBHOOK_PATH}`;

  const existing = (await listSubscriptions(token)).find(
    (s) => s.deliveryMode?.address === address && s.status === "Active",
  );

  if (existing) {
    const res = await fetch(`${env.RC_SERVER}/restapi/v1.0/subscription/${existing.id}/renew`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      log.info({ subscriptionId: existing.id }, "renewed RingCentral subscription");
      return { id: existing.id, action: "renewed", filters: existing.eventFilters ?? [] };
    }
    log.warn({ status: res.status }, "renewal failed; creating a fresh subscription");
  }

  /*
   * Try each candidate, keep the first RingCentral accepts.
   *
   * Not cleverness for its own sake. Whether an app may subscribe at account
   * level depends on permissions granted in the RingCentral console, and the
   * refusal comes back as the same "eventFilters value is invalid" 400 as a
   * genuinely wrong filter. Falling back means an app with only extension-level
   * permission gets working call delivery for the person who set it up rather
   * than a red box and no calls -- and the screen says which one it got, so
   * "why can I only see my own calls" has an answer on the page.
   *
   * Every failure is kept and reported together. One attempt's error alone
   * would hide the fact that the others were tried at all.
   */
  const failures: string[] = [];

  for (const filters of EVENT_FILTER_CANDIDATES) {
    const res = await fetch(`${env.RC_SERVER}/restapi/v1.0/subscription`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        eventFilters: filters,
        deliveryMode: {
          transportType: "WebHook",
          address,
          // Echoed back on every delivery so the receiver can reject forgeries.
          verificationToken: env.RC_WEBHOOK_SECRET || undefined,
        },
        expiresIn: 604800, // seven days, the maximum
      }),
    });

    if (res.ok) {
      const sub = (await res.json()) as Subscription;
      log.info({ subscriptionId: sub.id, address, filters }, "created RingCentral subscription");
      return { id: sub.id, action: "created", filters: [...filters] };
    }

    failures.push(`${filters[0]} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  throw new Error(`RingCentral refused every event filter. ${failures.join("  |  ")}`);
}

// ---------------------------------------------------------------------------
// Reading the phone system: who has an extension, and what numbers exist
// ---------------------------------------------------------------------------

export interface RcExtension {
  id: string;
  /** The number people dial internally. This is what goes on a CRM user. */
  extensionNumber: string;
  name: string;
  email: string | null;
  /** 'User', 'Department', 'Announcement' and so on. Only User can make calls. */
  type: string;
  status: string;
  /** Direct dial for this extension, when it has one. */
  directNumber: string | null;
}

export interface RcPhoneNumber {
  phoneNumber: string;
  /** 'MainCompanyNumber', 'DirectNumber', 'CompanyNumber', 'ForwardedNumber'... */
  usageType: string | null;
  /** The extension it rings, when it rings one. */
  extensionNumber: string | null;
}

/**
 * Every extension on the account.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS WORTH AN API CALL RATHER THAN A DOCUMENTATION LINK
 *
 * A call is credited to whoever made it by looking up its extension number
 * against users.rc_extension_id. Until that mapping is filled in, every call
 * lands on the account owner instead -- which looks like working software and
 * quietly corrupts every leaderboard and every commission argument.
 *
 * Filling it in means somebody reading extension numbers out of RingCentral's
 * admin site and typing them into ours, forty times, without a typo. That is a
 * job nobody does correctly and nobody enjoys, so the numbers come from the
 * horse's mouth instead.
 *
 * It also answers the first question anybody setting this up asks, which is
 * "what number do I actually call to test this".
 * ---------------------------------------------------------------------------
 */
export async function listExtensions(): Promise<RcExtension[]> {
  const token = await rcToken();
  const res = await fetch(
    `${env.RC_SERVER}/restapi/v1.0/account/~/extension?perPage=1000&status=Enabled`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(`could not read extensions (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    records?: {
      id?: number | string;
      extensionNumber?: string;
      name?: string;
      type?: string;
      status?: string;
      contact?: { email?: string; firstName?: string; lastName?: string };
    }[];
  };

  return (json.records ?? []).map((r) => ({
    id: String(r.id ?? ""),
    extensionNumber: String(r.extensionNumber ?? ""),
    // Some extension types carry no name at all; falling back to the number
    // beats rendering an empty row somebody cannot identify.
    name:
      r.name ||
      [r.contact?.firstName, r.contact?.lastName].filter(Boolean).join(" ") ||
      `Extension ${r.extensionNumber ?? "?"}`,
    email: r.contact?.email ?? null,
    type: String(r.type ?? ""),
    status: String(r.status ?? ""),
    directNumber: null,
  }));
}

/** Every number on the account, and which extension each one rings. */
export async function listPhoneNumbers(): Promise<RcPhoneNumber[]> {
  const token = await rcToken();
  const res = await fetch(`${env.RC_SERVER}/restapi/v1.0/account/~/phone-number?perPage=1000`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`could not read numbers (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    records?: {
      phoneNumber?: string;
      usageType?: string;
      extension?: { extensionNumber?: string };
    }[];
  };

  return (json.records ?? [])
    .filter((r) => r.phoneNumber)
    .map((r) => ({
      phoneNumber: String(r.phoneNumber),
      usageType: r.usageType ?? null,
      extensionNumber: r.extension?.extensionNumber ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Pulling the call log, rather than waiting to be told
// ---------------------------------------------------------------------------

/**
 * The calls RingCentral already has, fetched rather than delivered.
 *
 * ===========================================================================
 * WHY PULLING MATTERS WHEN A WEBHOOK ALREADY EXISTS
 *
 * Alex: "This needs to load like calls even when the app wasnt open. Just the
 * most recent calls in ring central."
 *
 * A webhook only delivers calls that happen while a live subscription is
 * pointing here. That leaves three holes, and all three are silent:
 *
 *   Before the subscription exists, nothing arrives -- which is the state on
 *     day one, and the state right now.
 *   While a subscription is lapsed or pointing at an old deployment, nothing
 *     arrives, and RingCentral does not resend afterwards.
 *   A delivery that fails is retried for a while and then abandoned.
 *
 * In every one of those the calls are sitting in RingCentral's own log,
 * perfectly intact, and the CRM simply never asked. This asks.
 *
 * IT IS THE SAME PIPELINE
 *
 * Each record is wrapped in the identical envelope the webhook delivers, so the
 * matcher, the qualifier and the review queue cannot tell the difference -- and
 * the external id is the telephony session, so a call that arrives BOTH ways
 * lands once. Pulling is therefore always safe to repeat: re-running it over a
 * window already imported writes nothing.
 * ===========================================================================
 */
export interface PulledCall {
  telephonySessionId: string;
  counterpartyNumber: string;
  ourNumber: string;
  direction: "Inbound" | "Outbound";
  durationSeconds: number;
  result: string;
  startTime: Date;
  extensionId: string | null;
  contactName: string;
}

export async function fetchCallLog(options: {
  /** How far back to look. RingCentral keeps a rolling window of its own. */
  sinceHours?: number;
  /** Cap. The account-wide log on a busy floor is long. */
  limit?: number;
} = {}): Promise<PulledCall[]> {
  const { sinceHours = 24, limit = 250 } = options;
  const token = await rcToken();

  const dateFrom = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
  const url =
    `${env.RC_SERVER}/restapi/v1.0/account/~/call-log` +
    `?view=Detailed&type=Voice&dateFrom=${encodeURIComponent(dateFrom)}` +
    `&perPage=${Math.max(1, Math.min(limit, 1000))}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`could not read the call log (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    records?: {
      id?: string;
      sessionId?: string;
      telephonySessionId?: string;
      startTime?: string;
      duration?: number;
      direction?: string;
      result?: string;
      to?: { phoneNumber?: string; name?: string };
      from?: { phoneNumber?: string; name?: string };
      extension?: { id?: number | string };
    }[];
  };

  const out: PulledCall[] = [];
  for (const r of json.records ?? []) {
    /*
     * The id, in the same order the webhook parser reads it.
     *
     * telephonySessionId first, because that is what a Call Log Sync
     * notification carries -- so the same conversation arriving by both roads
     * collides on the unique index and is stored once. Falling back to the
     * record id keeps a call that has no session id from being dropped, at the
     * cost of it not deduplicating against a webhook. That is the right way
     * round: a duplicate is visible and fixable, a missing call is neither.
     */
    const id = r.telephonySessionId ?? r.sessionId ?? r.id;
    if (!id) continue;

    const outbound = String(r.direction ?? "Outbound") === "Outbound";
    const counterparty = outbound ? r.to?.phoneNumber : r.from?.phoneNumber;
    const ours = outbound ? r.from?.phoneNumber : r.to?.phoneNumber;
    if (!counterparty) continue;

    out.push({
      telephonySessionId: String(id),
      counterpartyNumber: counterparty,
      ourNumber: ours ?? "",
      direction: outbound ? "Outbound" : "Inbound",
      durationSeconds: Number(r.duration ?? 0),
      result: String(r.result ?? "Unknown"),
      startTime: r.startTime ? new Date(r.startTime) : new Date(),
      extensionId: r.extension?.id != null ? String(r.extension.id) : null,
      contactName: (outbound ? r.to?.name : r.from?.name) ?? "",
    });
  }
  return out;
}
