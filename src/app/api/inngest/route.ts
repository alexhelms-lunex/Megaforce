import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";

export const runtime = "nodejs";

/**
 * Where Inngest invokes our background functions.
 *
 * Locally, `npx inngest-cli dev` discovers this endpoint and runs jobs against
 * it with no account required. In production the Inngest cloud calls the same
 * URL, so there is one code path either way.
 */
export const { GET, POST, PUT } = serve({ client: inngest, functions });
