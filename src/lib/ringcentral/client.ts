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
  deliveryMode?: { address?: string };
}

const WEBHOOK_PATH = "/api/webhooks/ringcentral";

/**
 * The events worth subscribing to.
 *
 * Call Log Sync is the one that carries duration and result, which is what
 * qualification needs. Telephony Sessions fires earlier and is useful for live
 * call state, but a session event alone cannot answer "did this call count".
 */
function eventFilters(): string[] {
  return [
    "/restapi/v1.0/account/~/extension/~/call-log-sync?direction=Inbound&direction=Outbound&type=Voice",
  ];
}

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
export async function ensureSubscription(): Promise<{ id: string; action: string }> {
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
      return { id: existing.id, action: "renewed" };
    }
    log.warn({ status: res.status }, "renewal failed; creating a fresh subscription");
  }

  const res = await fetch(`${env.RC_SERVER}/restapi/v1.0/subscription`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      eventFilters: eventFilters(),
      deliveryMode: {
        transportType: "WebHook",
        address,
        // Echoed back on every delivery so the receiver can reject forgeries.
        verificationToken: env.RC_WEBHOOK_SECRET || undefined,
      },
      expiresIn: 604800, // seven days, the maximum
    }),
  });

  if (!res.ok) {
    throw new Error(`failed to create subscription (${res.status}): ${await res.text()}`);
  }

  const sub = (await res.json()) as Subscription;
  log.info({ subscriptionId: sub.id, address }, "created RingCentral subscription");
  return { id: sub.id, action: "created" };
}
