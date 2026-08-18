import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { asRows } from "@/lib/jobs/registry";

/**
 * Is the phone system actually connected, and are calls actually arriving?
 *
 * ===========================================================================
 * WHY THIS EXISTS
 *
 * Every way this integration fails is silent.
 *
 *   A missing credential means no token, so no subscription, so no calls -- and
 *     the application looks exactly as it does on a quiet afternoon.
 *   A lapsed subscription means calls stop. RingCentral does not tell us; from
 *     our side, nothing happened.
 *   A subscription pointing at the PREVIOUS deployment's URL means calls are
 *     being delivered, successfully, to a dead address.
 *   Extensions not filled in on the users table means calls arrive and are
 *     credited to the account owner rather than to whoever made them, which
 *     looks like working software and quietly corrupts every leaderboard.
 *
 * None of those produce an error anybody sees. The first symptom of all four is
 * a broker saying "my calls aren't showing up", days later.
 *
 * So the point of this file is to turn four invisible failures into four
 * sentences on a screen. Nothing here throws: a status page that crashes when
 * something is wrong is a status page that only works when it is not needed.
 * ===========================================================================
 */

export interface CredentialState {
  key: string;
  label: string;
  present: boolean;
  /** What it is and where it comes from, for somebody setting this up once. */
  help: string;
}

export interface SubscriptionState {
  /** 'ok' | 'missing' | 'wrong-address' | 'unreachable' | 'not-configured' */
  status: "ok" | "missing" | "wrong-address" | "unreachable" | "not-configured";
  id: string | null;
  expiresAt: string | null;
  /** Where RingCentral currently believes it should deliver calls. */
  deliveringTo: string | null;
  /** Where this deployment is actually listening. */
  shouldDeliverTo: string;
  detail: string | null;
}

export interface PipelineState {
  lastCallAt: string | null;
  callsLast7Days: number;
  /** Received and stored, but never turned into activity. */
  backlog: number;
  /** Stored and then failed to process. These need a human. */
  failed: number;
  /** Calls that arrived but matched no contact on file. */
  unmatchedOpen: number;
  /** People who can make calls but have no extension number recorded. */
  usersWithoutExtension: number;
  totalCallers: number;
}

export interface RingCentralStatus {
  configured: boolean;
  /** True when RC_SERVER points at the sandbox rather than production. */
  sandbox: boolean;
  server: string;
  credentials: CredentialState[];
  subscription: SubscriptionState;
  pipeline: PipelineState;
}

const WEBHOOK_PATH = "/api/webhooks/ringcentral";

function credentials(): CredentialState[] {
  return [
    {
      key: "RC_CLIENT_ID",
      label: "Client ID",
      present: Boolean(process.env.RC_CLIENT_ID),
      help: "From the app you created in the RingCentral developer console.",
    },
    {
      key: "RC_CLIENT_SECRET",
      label: "Client secret",
      present: Boolean(process.env.RC_CLIENT_SECRET),
      help: "Shown once when the app is created. Regenerate it if it was not saved.",
    },
    {
      key: "RC_JWT",
      label: "JWT credential",
      present: Boolean(process.env.RC_JWT),
      help:
        "Created under Credentials in the developer console. This is what lets the CRM " +
        "log in without a person clicking Allow.",
    },
    {
      key: "RC_SERVER",
      label: "Server",
      present: Boolean(process.env.RC_SERVER),
      help:
        "The sandbox address while testing, the production one once the app is live. " +
        "Defaults to the sandbox.",
    },
    {
      key: "RC_WEBHOOK_SECRET",
      label: "Webhook secret",
      present: Boolean(process.env.RC_WEBHOOK_SECRET),
      help:
        "Any long random string you choose. RingCentral echoes it on every delivery so " +
        "the receiver can reject calls posted by anybody else who finds the address.",
    },
  ];
}

/**
 * Ask RingCentral what it thinks it is delivering to.
 *
 * The address comparison is the part worth having. A subscription can be
 * perfectly healthy and pointing at a deployment that no longer exists -- which
 * looks identical to a working integration on a quiet day, and is the failure
 * most likely to happen here, since the address changes whenever APP_URL does.
 */
async function subscriptionState(): Promise<SubscriptionState> {
  const shouldDeliverTo = `${(env.APP_URL || "").replace(/\/$/, "")}${WEBHOOK_PATH}`;

  if (!env.ringCentralConfigured) {
    return {
      status: "not-configured",
      id: null,
      expiresAt: null,
      deliveringTo: null,
      shouldDeliverTo,
      detail: null,
    };
  }

  try {
    const { rcToken } = await import("./client");
    const token = await rcToken();

    const res = await fetch(`${env.RC_SERVER}/restapi/v1.0/subscription`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        status: "unreachable",
        id: null,
        expiresAt: null,
        deliveringTo: null,
        shouldDeliverTo,
        detail: `RingCentral answered ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }

    const json = (await res.json()) as {
      records?: {
        id: string;
        status: string;
        expirationTime: string;
        deliveryMode?: { address?: string };
      }[];
    };
    const active = (json.records ?? []).filter((r) => r.status === "Active");
    const ours = active.find((r) => r.deliveryMode?.address === shouldDeliverTo);

    if (ours) {
      return {
        status: "ok",
        id: ours.id,
        expiresAt: ours.expirationTime ?? null,
        deliveringTo: ours.deliveryMode?.address ?? null,
        shouldDeliverTo,
        detail: null,
      };
    }

    if (active.length > 0) {
      return {
        status: "wrong-address",
        id: active[0].id,
        expiresAt: active[0].expirationTime ?? null,
        deliveringTo: active[0].deliveryMode?.address ?? null,
        shouldDeliverTo,
        detail:
          "There is a live subscription, but it delivers somewhere else. Calls are being " +
          "sent to an address this deployment is not listening on.",
      };
    }

    return {
      status: "missing",
      id: null,
      expiresAt: null,
      deliveringTo: null,
      shouldDeliverTo,
      detail: "RingCentral has no active subscription, so no calls will be delivered.",
    };
  } catch (err) {
    return {
      status: "unreachable",
      id: null,
      expiresAt: null,
      deliveringTo: null,
      shouldDeliverTo,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * What has actually come through, which is the only proof that matters.
 *
 * Read with one query rather than six. This sits on a screen somebody opens
 * when they already suspect something is wrong, and a status page that takes
 * four seconds to say "everything is fine" gets read as part of the problem.
 */
async function pipelineState(): Promise<PipelineState> {
  const empty: PipelineState = {
    lastCallAt: null,
    callsLast7Days: 0,
    backlog: 0,
    failed: 0,
    unmatchedOpen: 0,
    usersWithoutExtension: 0,
    totalCallers: 0,
  };

  try {
    const rows = asRows<Record<string, string | null>>(
      await db.execute(sql`
        select
          (select max(received_at)::text from raw_events where source = 'ringcentral')     as last_call_at,
          (select count(*)::text from raw_events
            where source = 'ringcentral' and received_at > now() - interval '7 days')      as calls_7d,
          (select count(*)::text from raw_events
            where processed_at is null and error is null)                                  as backlog,
          (select count(*)::text from raw_events where error is not null)                  as failed,
          (select count(*)::text from unmatched_activities where resolved_at is null)      as unmatched_open,
          -- Anybody who might make a prospecting call. Credit hold no book and
          -- make none, so counting them would make the gap look permanent.
          (select count(*)::text from users
            where active and role in ('broker','manager','ad')
              and coalesce(rc_extension_id, '') = '')                                      as no_extension,
          (select count(*)::text from users
            where active and role in ('broker','manager','ad'))                            as callers
      `),
    )[0];

    if (!rows) return empty;
    const n = (v: string | null | undefined) => Number(v ?? 0);
    return {
      lastCallAt: rows.last_call_at ?? null,
      callsLast7Days: n(rows.calls_7d),
      backlog: n(rows.backlog),
      failed: n(rows.failed),
      unmatchedOpen: n(rows.unmatched_open),
      usersWithoutExtension: n(rows.no_extension),
      totalCallers: n(rows.callers),
    };
  } catch {
    // A status page that cannot read the database still has useful things to
    // say about the credentials and the subscription.
    return empty;
  }
}

export async function ringCentralStatus(): Promise<RingCentralStatus> {
  const [subscription, pipeline] = await Promise.all([subscriptionState(), pipelineState()]);
  const server = env.RC_SERVER;

  return {
    configured: env.ringCentralConfigured,
    sandbox: /devtest|sandbox/i.test(server),
    server,
    credentials: credentials(),
    subscription,
    pipeline,
  };
}
