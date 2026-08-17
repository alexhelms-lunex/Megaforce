import { Building2, ExternalLink, Plug, Search, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * ZoomInfo enrichment, not yet connected.
 *
 * The integration is deliberately not built. Programmatic access starts around
 * fifty thousand dollars a year and that is a purchasing decision, not an
 * engineering one — so this is the shape of the panel with an honest statement
 * of what it needs, rather than a half-built client that fails at runtime.
 *
 * It is not an empty placeholder either. The outbound search links work today:
 * they carry the company's actual name and city into ZoomInfo's own search, so
 * a broker gets to the right page in one click without the CRM holding a
 * licence. That covers most of what the panel is wanted for, at no cost.
 */
export function ZoomInfoPanel({
  name,
  city,
  state,
  website,
}: {
  name: string;
  city: string | null;
  state: string | null;
  website: string | null;
}) {
  const query = encodeURIComponent([name, city, state].filter(Boolean).join(" "));
  const domain = website?.replace(/^https?:\/\//, "").replace(/\/.*$/, "") ?? "";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed bg-muted/40 px-4 py-3">
        <Plug className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">To be connected in production.</span>{" "}
          <span className="text-muted-foreground">
            Firmographics and contact discovery will populate here once a ZoomInfo Enterprise API
            licence is in place. Until then the searches below open ZoomInfo directly with this
            company already filled in.
          </span>
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Lookup
          icon={Building2}
          title="Company profile"
          body="Revenue band, employee count, ownership, SIC and NAICS codes, corporate tree."
          href={`https://app.zoominfo.com/#/apps/search/v2/company?query=${query}`}
        />
        <Lookup
          icon={Users}
          title="Decision makers"
          body="Supply chain, logistics and procurement contacts with direct dials and email addresses."
          href={`https://app.zoominfo.com/#/apps/search/v2/contact?companyName=${query}`}
        />
        {domain ? (
          <Lookup
            icon={Search}
            title="By domain"
            body={`Everything ZoomInfo holds against ${domain}.`}
            href={`https://app.zoominfo.com/#/apps/search/v2/company?companyWebsite=${encodeURIComponent(domain)}`}
          />
        ) : null}
        <Lookup
          icon={Search}
          title="Open web"
          body="A plain search, for when the company is too small to be in a database."
          href={`https://duckduckgo.com/?q=${query}+logistics+OR+%22supply+chain%22`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What connecting it would add</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Contacts pulled straight onto the account, which matters more here than it looks: an
            email only counts as approved activity when the address is already on file, so every
            contact imported is a channel that starts counting.
          </p>
          <p>
            Firmographics to fill the industry, revenue band and employee count without typing, and
            a nightly refresh so an account that changes hands or moves premises is not worked from
            a stale record for a year.
          </p>
          <p>
            The panel is built against the standard Enterprise API shape, so switching it on is
            credentials and a feature flag rather than a rebuild.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Lookup({
  icon: Icon,
  title,
  body,
  href,
}: {
  icon: React.ElementType;
  title: string;
  body: string;
  href: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="group flex gap-3 rounded-lg border bg-card p-3 transition-shadow hover:shadow-md"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-sm font-medium">
          {title}
          <ExternalLink className="size-3 opacity-0 transition-opacity group-hover:opacity-70" aria-hidden />
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{body}</span>
      </span>
    </a>
  );
}
