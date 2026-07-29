/**
 * Structured logging.
 *
 * JSON in production so failures are searchable by field -- "show me every
 * event where matched=false and reason=multiple_accounts" is a query, not a
 * grep. Pretty-printed locally, because nobody debugs by reading JSON.
 */
import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  // Vercel captures stdout; a transport would add a worker thread for nothing.
  ...(isDev
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }
    : {}),
  redact: {
    // Raw payloads carry customer phone numbers and recording URLs. They belong
    // in raw_events, which is access-controlled, not in a log aggregator.
    paths: ["payload", "*.payload", "req.headers.authorization", "*.assertion"],
    censor: "[redacted]",
  },
});

export const webhookLog = logger.child({ component: "webhook" });
export const matcherLog = logger.child({ component: "matcher" });
