import "server-only";
import { headers } from "next/headers";

/**
 * Where this deployment actually is, as seen from the browser.
 *
 * ---------------------------------------------------------------------------
 * A password reset email carries a link back into the application, so something
 * has to know the address to put in it. That is harder than it looks here,
 * because this project is reached under at least three names: the production
 * domain, the per-branch preview domain, and the per-deployment one. A constant
 * would be wrong on two of them, and a reset link that lands on a different
 * deployment than the one that sent it fails in a way nobody can diagnose.
 *
 * So it is read from the request. The forwarded headers are what Vercel's proxy
 * sets, and they describe the host the person is actually looking at.
 *
 * NEXT_PUBLIC_SITE_URL overrides everything, for when the application sits
 * behind a domain the proxy does not announce.
 * ---------------------------------------------------------------------------
 */
export async function siteOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return "";

  // Local development is the only place this is not https, and getting that
  // wrong sends somebody to a URL their browser refuses to open.
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
