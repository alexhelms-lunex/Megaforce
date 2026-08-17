import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { asRows } from "@/lib/jobs/registry";

/**
 * Reading and writing what the outside systems need to be talked to.
 *
 * Secrets are encrypted in the database under a key that lives only in the
 * environment, so an administrator can rotate a credential from a screen while
 * the database on its own still cannot read one. The key is passed in per call
 * and never stored.
 */

export type Provider = "ringcentral" | "microsoft" | "zoominfo";

export interface Integration {
  provider: Provider;
  enabled: boolean;
  config: Record<string, string>;
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Whether any secret bundle has been stored. Never the values themselves. */
  hasSecrets: boolean;
}

/**
 * The key everything is encrypted under.
 *
 * Absent means secrets cannot be read or written, and every provider reports
 * itself unconfigured rather than half-working. Refusing loudly here beats
 * storing credentials in the clear because a variable was forgotten.
 */
function encryptionKey(): string | null {
  const key = process.env.APP_ENCRYPTION_KEY?.trim();
  return key && key.length >= 16 ? key : null;
}

export function encryptionConfigured(): boolean {
  return encryptionKey() !== null;
}

export async function listIntegrations(): Promise<Integration[]> {
  const rows = await db.execute(sql`
    select provider, enabled, config, last_ok_at, last_error, last_error_at,
           (secrets is not null) as has_secrets
      from integrations order by provider
  `);
  return asRows<{
    provider: Provider;
    enabled: boolean;
    config: Record<string, string>;
    last_ok_at: string | null;
    last_error: string | null;
    last_error_at: string | null;
    has_secrets: boolean;
  }>(rows).map((r) => ({
    provider: r.provider,
    enabled: r.enabled,
    config: r.config ?? {},
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    hasSecrets: r.has_secrets,
  }));
}

export async function getIntegration(provider: Provider): Promise<Integration | null> {
  return (await listIntegrations()).find((i) => i.provider === provider) ?? null;
}

/**
 * Config and secrets together, for the code that actually makes the API call.
 *
 * Returns null when the key is missing or does not match what is stored, so a
 * caller cannot mistake "cannot decrypt" for "no credentials set" -- those need
 * different fixes and the second one silently loses a working configuration.
 */
export async function credentials(
  provider: Provider,
): Promise<{ config: Record<string, string>; secrets: Record<string, string> } | null> {
  const key = encryptionKey();
  if (!key) return null;

  const rows = await db.execute(sql`
    select config, get_integration_secrets(${provider}, ${key}) as secrets
      from integrations where provider = ${provider}
  `);
  const row = asRows<{ config: Record<string, string>; secrets: Record<string, string> | null }>(
    rows,
  )[0];
  if (!row || row.secrets === null) return null;
  return { config: row.config ?? {}, secrets: row.secrets ?? {} };
}

export async function saveIntegration(
  provider: Provider,
  opts: { enabled?: boolean; config?: Record<string, string>; secrets?: Record<string, string> },
): Promise<{ error?: string }> {
  if (opts.secrets && Object.keys(opts.secrets).length > 0) {
    const key = encryptionKey();
    if (!key) {
      return {
        error:
          "APP_ENCRYPTION_KEY is not set, so secrets cannot be stored. Add it in Vercel " +
          "(any long random string) and redeploy. It is the only value that stays outside the database.",
      };
    }
    // Merge rather than replace: the form only submits the secret fields that
    // were actually typed into, so an admin editing one key must not wipe the
    // other three by leaving them blank.
    const existing = (await credentials(provider))?.secrets ?? {};
    const merged = { ...existing };
    for (const [k, v] of Object.entries(opts.secrets)) {
      if (v.trim()) merged[k] = v.trim();
    }
    await db.execute(
      sql`select set_integration_secrets(${provider}, ${JSON.stringify(merged)}::jsonb, ${key})`,
    );
  }

  if (opts.config) {
    await db.execute(sql`
      update integrations
         set config = config || ${JSON.stringify(opts.config)}::jsonb, updated_at = now()
       where provider = ${provider}
    `);
  }

  if (typeof opts.enabled === "boolean") {
    await db.execute(sql`
      update integrations set enabled = ${opts.enabled}, updated_at = now() where provider = ${provider}
    `);
  }

  return {};
}

/** Record the outcome of a real call, so the settings screen can be honest. */
export async function recordHealth(
  provider: Provider,
  ok: boolean,
  error?: string,
): Promise<void> {
  if (ok) {
    await db.execute(sql`
      update integrations set last_ok_at = now(), last_error = null, last_error_at = null
       where provider = ${provider}
    `);
  } else {
    await db.execute(sql`
      update integrations set last_error = ${error ?? "unknown error"}, last_error_at = now()
       where provider = ${provider}
    `);
  }
}
