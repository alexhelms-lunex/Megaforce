"use client";

/**
 * The last resort.
 *
 * ---------------------------------------------------------------------------
 * (app)/error.tsx catches anything a PAGE throws. It cannot catch anything the
 * surrounding LAYOUT throws -- an error boundary never catches its own parent
 * -- and with no global-error.tsx present those failures render Next's own
 * white page reading "Application error: a server-side exception has occurred
 * (see the server logs for more information)".
 *
 * That page is what a user actually met, and it is close to useless: it does
 * not say which screen failed, does not distinguish a database that is behind
 * the code from a genuine bug, and offers nothing to do next. Since the chrome
 * itself (the sidebar, the alert bell, the docks) all query the database on
 * every request, a layout-level failure is not a remote possibility here.
 *
 * A global error replaces the entire document, so this file has to render its
 * own <html> and <body> and cannot use the application's stylesheet -- styles
 * are inline for that reason, not out of preference.
 * ---------------------------------------------------------------------------
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const schemaish = /column|relation|does not exist|schema cache|function|migration/i.test(
    error.message ?? "",
  );

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#0a0a0a",
          color: "#fafaf8",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem 1.25rem",
        }}
      >
        <main style={{ maxWidth: "34rem", width: "100%" }}>
          <p
            style={{
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              fontSize: "0.75rem",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#00ff9c",
              margin: "0 0 0.75rem",
            }}
          >
            Megaforce
          </p>
          <h1
            style={{
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              fontSize: "1.5rem",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              margin: "0 0 0.75rem",
            }}
          >
            The application did not start
          </h1>
          <p style={{ margin: "0 0 1rem", lineHeight: 1.6, color: "#b8b8b4" }}>
            {schemaish
              ? "The database is missing something this version expects. That almost always means setup has not been re-run since the last deploy."
              : "Something failed while building the page frame itself — the sidebar, the alerts or one of the docks."}
          </p>

          {error.message ? (
            <pre
              style={{
                background: "#1a1a1a",
                border: "1px solid #2a2a2a",
                borderRadius: 8,
                padding: "0.75rem",
                fontSize: "0.75rem",
                lineHeight: 1.6,
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                margin: "0 0 0.75rem",
              }}
            >
              {error.message}
            </pre>
          ) : null}

          {error.digest ? (
            <p style={{ fontSize: "0.75rem", color: "#8a8a86", margin: "0 0 1.25rem" }}>
              Reference <code>{error.digest}</code> — quote this if you report it.
            </p>
          ) : null}

          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              onClick={reset}
              style={{
                background: "#1b1bff",
                color: "#fff",
                border: 0,
                borderRadius: 999,
                padding: "0.5rem 1.25rem",
                fontSize: "0.875rem",
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Try again
            </button>
            <a
              href="/api/version"
              style={{
                border: "1px solid #2a2a2a",
                borderRadius: 999,
                padding: "0.5rem 1.25rem",
                fontSize: "0.875rem",
                fontWeight: 600,
                color: "#fafaf8",
                textDecoration: "none",
              }}
            >
              What is deployed?
            </a>
            <a
              href="/api/setup"
              style={{
                borderRadius: 999,
                padding: "0.5rem 1.25rem",
                fontSize: "0.875rem",
                fontWeight: 600,
                color: "#b8b8b4",
                textDecoration: "none",
              }}
            >
              Re-run setup
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
