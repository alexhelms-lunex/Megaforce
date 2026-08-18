import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Check, PhoneCall, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/info-tip";
import { currentUser } from "@/lib/supabase/server";
import {
  ringCentralStatus,
  type ArrivedCall,
  type RingCentralStatus,
} from "@/lib/ringcentral/status";
import { formatDateTime } from "@/lib/format";
import { ExtensionList, IntegrationButtons, TestCallButtons } from "./buttons";

export const dynamic = "force-dynamic";

/**
 * Is the phone connected, and are calls arriving?
 *
 * ===========================================================================
 * Every way this integration breaks is silent -- a missing credential, a lapsed
 * subscription, a subscription pointing at the previous deployment, an
 * extension nobody filled in. None of them produce an error on any screen. The
 * application looks exactly as it does on a quiet afternoon, and the first
 * symptom is a broker asking days later why their calls stopped showing up.
 *
 * This screen exists to make each of those a sentence. It is written for
 * somebody setting the integration up for the first time, who has never used
 * RingCentral's developer console, so every credential says what it is and
 * where it comes from rather than only whether it is present.
 *
 * The order is the order things fail in: credentials, then delivery, then what
 * has actually come through. Reading top to bottom is the diagnosis.
 * ===========================================================================
 */
export default async function IntegrationsPage() {
  const me = await currentUser();
  // Not a hidden nav item -- a 404. This page names which credentials exist.
  if (!me || me.role !== "admin") notFound();

  const status = await ringCentralStatus();

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <PhoneCall className="size-5 text-muted-foreground" aria-hidden />
          Phone connection
          <InfoTip
            side="bottom"
            text="Everything that has to be true for a call to end up on an account. Read it top to bottom: each section depends on the one above it."
          />
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Calls only reach an account if all three of these are working, and none of them
          announce it when they stop.
        </p>
      </header>

      <Headline status={status} />

      {/* ---- 0. the part that works with no phone system at all ----
          First on the page deliberately. Until RingCentral is connected this is
          the only section anybody can act on, and burying it under three
          sections about credentials they do not have yet is how somebody
          concludes there is nothing here to see. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Try it without a phone system</CardTitle>
          <p className="text-xs text-muted-foreground">
            These send a call through the real pipeline — the same matching, the same rules, the
            same review queue a live call goes through. Nothing here touches RingCentral, needs
            an account, or leaves this deployment.
          </p>
        </CardHeader>
        <CardContent>
          <TestCallButtons />
        </CardContent>
      </Card>

      {/* ---- 1. credentials ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Credentials</CardTitle>
          <p className="text-xs text-muted-foreground">
            Set in the deployment&apos;s environment variables, not here — a secret typed into a
            web page is a secret in a database. Add them in Vercel, then redeploy.
          </p>
        </CardHeader>
        <CardContent className="space-y-2 px-0">
          {status.credentials.map((c) => (
            <div key={c.key} className="flex items-start gap-3 border-b px-6 py-2.5 last:border-b-0">
              <Mark ok={c.present} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {c.label} <span className="font-mono text-xs text-muted-foreground">{c.key}</span>
                </p>
                <p className="text-xs text-muted-foreground">{c.help}</p>
              </div>
            </div>
          ))}
          <div className="px-6 pt-2">
            <p className="text-xs text-muted-foreground">
              Currently pointing at{" "}
              <span className="font-mono text-foreground">{status.server}</span>
              {status.sandbox ? (
                <span className="ml-2 rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  SANDBOX — test numbers only
                </span>
              ) : (
                <span className="ml-2 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
                  PRODUCTION
                </span>
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      {/*
        Above everything, because nothing below it can work.

        A deploy ships code; database changes are applied by visiting the setup
        page. When those two drift apart, every incoming call is written down
        and then refused on the way to being filed -- and no screen shows an
        error, because from the application's point of view the call arrived
        perfectly well. It simply never becomes anything.
      */}
      {status.schemaGaps.length > 0 ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <p className="font-medium text-destructive">
            The database is behind this deployment. Calls cannot be filed.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            The code was updated but the database changes have not been applied yet, so calls
            arrive, get written down, and then fail on the way to a screen. Nothing is lost — open{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">/api/setup?key=…</code> and
            press <strong>Apply database changes</strong>, then come back and press{" "}
            <strong>File anything waiting</strong> to pick up everything that was stranded.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {status.schemaGaps.map((gap) => (
              <li key={gap.what}>
                <span className="font-mono text-xs">{gap.what}</span>
                <span className="text-muted-foreground"> — {gap.why}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ---- 2. delivery ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. Call delivery</CardTitle>
          <p className="text-xs text-muted-foreground">
            RingCentral has to be told where to send calls, and the instruction expires every
            seven days. The nightly job renews it; these buttons do it now.
          </p>
          <p className="text-xs text-muted-foreground">
            Delivery only carries calls made <em>after</em> it is switched on. To see calls made
            before that — or during any stretch when delivery had lapsed —{" "}
            <strong>Load recent calls now</strong> asks RingCentral for the last 48 hours instead
            of waiting to be told. It also runs on its own: once with the nightly job, and again
            whenever anybody opens the phone dock. Loading the same calls twice adds nothing.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <Delivery status={status} />
          <IntegrationButtons configured={status.configured} />
        </CardContent>
      </Card>

      {/* ---- 2b. who can call ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Who can make calls</CardTitle>
          <p className="text-xs text-muted-foreground">
            Read from RingCentral. A call is credited to whoever made it by matching its extension
            number against the person&apos;s record here — so an extension the CRM does not
            recognise has its calls credited to whoever owns the account instead. That looks
            correct on screen and is not.
          </p>
        </CardHeader>
        <CardContent>
          <ExtensionList />
        </CardContent>
      </Card>

      {/* ---- 3. what arrived ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">3. What has actually arrived</CardTitle>
          <p className="text-xs text-muted-foreground">
            The only proof that matters. Everything above can look correct while nothing comes
            through.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Fact
            label="Last call received"
            value={status.pipeline.lastCallAt ? formatDateTime(status.pipeline.lastCallAt) : "never"}
            tone={status.pipeline.lastCallAt ? "calm" : "warn"}
            help="When RingCentral last posted anything here at all."
          />
          <Fact
            label="Calls in the last 7 days"
            value={status.pipeline.callsLast7Days.toLocaleString()}
            tone="calm"
            help="Every delivery, matched or not."
          />
          <Fact
            label="Waiting to be filed"
            value={status.pipeline.backlog.toLocaleString()}
            tone={status.pipeline.backlog > 20 ? "warn" : "calm"}
            help="Received and written down, but not yet turned into activity. A handful is normal; a growing number means the sweep is not keeping up."
          />
          <Fact
            label="Could not be read"
            value={status.pipeline.failed.toLocaleString()}
            tone={status.pipeline.failed > 0 ? "bad" : "calm"}
            help="Stored, then failed to process. These need a person — they will not retry on their own."
          />
          <Fact
            label="In the review queue"
            value={status.pipeline.unmatchedOpen.toLocaleString()}
            tone={status.pipeline.unmatchedOpen > 0 ? "warn" : "calm"}
            help="Calls that arrived but matched no contact on file. Not a fault — somebody needs to say who they were with."
            href="/review"
          />
          <Fact
            label="People with no extension"
            value={`${status.pipeline.usersWithoutExtension} of ${status.pipeline.totalCallers}`}
            tone={status.pipeline.usersWithoutExtension > 0 ? "warn" : "calm"}
            help="Without an extension number a call is credited to whoever holds the account rather than to whoever made it. That looks like working software and quietly corrupts every leaderboard."
            href="/admin/users"
          />
        </CardContent>
      </Card>

      {/* ---- 4. the calls themselves ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">4. The calls themselves</CardTitle>
          <p className="text-xs text-muted-foreground">
            Every call that has arrived, <strong>whoever it was credited to</strong>. The phone
            dock only ever shows your own calls, so a call credited to the wrong person is
            invisible everywhere else — and &ldquo;nothing arrived&rdquo; and &ldquo;everything
            arrived and went to somebody else&rdquo; look identical from every other screen. Check
            the <em>Credited to</em> column against who actually made the call.
          </p>
        </CardHeader>
        <CardContent>
          <ArrivedCalls calls={status.pipeline.recent} />
        </CardContent>
      </Card>
    </div>
  );
}

function ArrivedCalls({ calls }: { calls: ArrivedCall[] }) {
  if (calls.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing has arrived yet. Press <strong>Load recent calls now</strong> above — it asks
        RingCentral for the last 48 hours, so a call made this morning will appear even though
        delivery has never been switched on.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Number</th>
            <th className="px-3 py-2 font-medium">Ext</th>
            <th className="px-3 py-2 font-medium">Credited to</th>
            <th className="px-3 py-2 font-medium">Where it went</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c, i) => (
            <tr key={`${c.at}-${i}`} className="border-b last:border-b-0">
              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                {c.at ? formatDateTime(c.at) : "—"}
              </td>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                {c.phone ?? "—"}
                <span className="ml-1.5 text-muted-foreground">
                  {c.direction ?? ""}
                  {c.durationSeconds != null ? ` ${c.durationSeconds}s` : ""}
                </span>
              </td>
              <td className="px-3 py-2 font-mono text-xs">{c.extension ?? "—"}</td>
              <td className="px-3 py-2">
                {c.creditedTo ?? (
                  <span className="text-amber-700 dark:text-amber-300">nobody</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs">
                {c.landed === "filed" ? (
                  <span className="text-muted-foreground">{c.company ?? "an account"}</span>
                ) : (
                  <Link href="/review" className="text-amber-700 underline dark:text-amber-300">
                    review queue
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * One sentence at the top saying whether this is working.
 *
 * Somebody opening this screen has one question. Making them assemble the
 * answer from three cards is the difference between a status page and a dump.
 */
function Headline({ status }: { status: RingCentralStatus }) {
  const missing = status.credentials.filter((c) => !c.present && c.key !== "RC_SERVER");

  if (!status.configured) {
    return (
      <Banner tone="idle">
        <strong>Not connected yet.</strong> {missing.length} of the settings below are still
        missing. Nothing is broken — the phone system has simply never been plugged in, and the
        CRM works without it.
      </Banner>
    );
  }
  if (status.subscription.status === "unreachable") {
    return (
      <Banner tone="bad">
        <strong>The credentials are set but RingCentral refused them.</strong>{" "}
        {status.subscription.detail}
      </Banner>
    );
  }
  if (status.subscription.status === "missing") {
    return (
      <Banner tone="bad">
        <strong>Signed in, but no calls are being delivered.</strong> Press{" "}
        <em>Start or renew call delivery</em> below.
      </Banner>
    );
  }
  if (status.subscription.status === "wrong-address") {
    return (
      <Banner tone="bad">
        <strong>Calls are being delivered somewhere else.</strong> This usually means the app
        moved to a new address and the subscription still points at the old one. Pressing{" "}
        <em>Start or renew call delivery</em> repoints it here.
      </Banner>
    );
  }
  if (!status.pipeline.lastCallAt) {
    return (
      <Banner tone="idle">
        <strong>Connected, and nothing has come through yet.</strong> Make a call from a
        RingCentral extension and it should appear here within a few seconds.
      </Banner>
    );
  }
  return (
    <Banner tone="good">
      <strong>Working.</strong> {status.pipeline.callsLast7Days.toLocaleString()} calls in the
      last seven days, the most recent at {formatDateTime(status.pipeline.lastCallAt)}.
    </Banner>
  );
}

function Delivery({ status }: { status: RingCentralStatus }) {
  const s = status.subscription;
  return (
    <dl className="space-y-2 text-sm">
      <Line label="Status" value={<StatusWord status={s.status} />} />
      <Line
        label="Delivering to"
        value={
          <span className="break-all font-mono text-xs">
            {s.deliveringTo ?? "nowhere"}
          </span>
        }
      />
      {s.deliveringTo && s.deliveringTo !== s.shouldDeliverTo ? (
        <Line
          label="Should be"
          value={<span className="break-all font-mono text-xs">{s.shouldDeliverTo}</span>}
        />
      ) : null}
      <Line
        label="Expires"
        value={s.expiresAt ? formatDateTime(s.expiresAt) : "—"}
      />
      {s.detail ? (
        <p className="pt-1 text-xs text-muted-foreground">{s.detail}</p>
      ) : null}
    </dl>
  );
}

function StatusWord({ status }: { status: RingCentralStatus["subscription"]["status"] }) {
  const map: Record<typeof status, { label: string; className: string }> = {
    ok: {
      label: "Active",
      className:
        "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300",
    },
    missing: { label: "None", className: "border-destructive/40 bg-destructive/10 text-destructive" },
    "wrong-address": {
      label: "Pointing elsewhere",
      className: "border-destructive/40 bg-destructive/10 text-destructive",
    },
    unreachable: {
      label: "Could not ask",
      className: "border-destructive/40 bg-destructive/10 text-destructive",
    },
    "not-configured": { label: "Not set up", className: "border-border bg-muted text-muted-foreground" },
  };
  const { label, className } = map[status];
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

function Line({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <dt className="w-28 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 flex-1">{value}</dd>
    </div>
  );
}

function Mark({ ok }: { ok: boolean }) {
  return ok ? (
    <Check className="mt-0.5 size-4 shrink-0 text-brand-600" aria-label="present" />
  ) : (
    <X className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="missing" />
  );
}

function Fact({
  label,
  value,
  tone,
  help,
  href,
}: {
  label: string;
  value: string;
  tone: "calm" | "warn" | "bad";
  help: string;
  href?: string;
}) {
  const body = (
    <div className="rounded-xl border bg-card p-4 transition-colors hover:border-foreground/20">
      <p className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        <InfoTip side="bottom" text={help} />
      </p>
      <p
        className={`mt-1 text-xl font-semibold tabular-nums ${
          tone === "bad" ? "text-destructive" : tone === "warn" ? "text-amber-700 dark:text-amber-300" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function Banner({
  tone,
  children,
}: {
  tone: "good" | "bad" | "idle";
  children: React.ReactNode;
}) {
  const className =
    tone === "good"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100"
      : tone === "bad"
        ? "border-destructive/40 bg-destructive/5 text-destructive"
        : "border-border bg-muted/40 text-foreground";
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${className}`}>
      {tone === "bad" ? (
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      ) : null}
      <p className="leading-relaxed">{children}</p>
    </div>
  );
}
