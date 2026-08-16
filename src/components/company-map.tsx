import { ExternalLink, MapPin, Navigation } from "lucide-react";

export interface Address {
  street: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
}

/** "281 Clara Street, Charlotte, NC 28202" — skipping whatever is missing. */
export function formatAddress(a: Address): string {
  const cityLine = [a.city, [a.state, a.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return [a.street, cityLine, a.country && a.country !== "United States" ? a.country : null]
    .filter(Boolean)
    .join(", ");
}

/**
 * The location panel: a map, the address, and a route.
 *
 * The map tiles come from OpenStreetMap's embed, which needs no API key and no
 * billing account. That matters more than it sounds: a Google Maps embed would
 * put a key in the client bundle, tie the build to a billing account, and show
 * every viewer a "for development purposes only" watermark the day the quota
 * lapsed. The links out still go to Google and Apple Maps, because that is
 * where a driver actually wants the route to open, and a plain link needs no
 * key at all.
 *
 * Coordinates are optional. Without them there is no tile to draw, but the
 * address links still work perfectly -- both mapping services geocode from the
 * text. So the component degrades to a useful panel rather than to a hole.
 */
export function CompanyMap({ name, address }: { name: string; address: Address }) {
  const text = formatAddress(address);
  const lat = toNumber(address.latitude);
  const lng = toNumber(address.longitude);
  const hasPin = lat !== null && lng !== null;

  if (!text && !hasPin) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center">
        <MapPin className="mx-auto size-5 text-muted-foreground/50" aria-hidden />
        <p className="mt-2 text-sm font-medium">No address on file</p>
        <p className="text-xs text-muted-foreground">
          Add one and the map, the route and the state filter all start working.
        </p>
      </div>
    );
  }

  const query = encodeURIComponent(text || `${lat},${lng}`);

  return (
    <div className="overflow-hidden rounded-lg border">
      {hasPin ? (
        <iframe
          title={`Map of ${name}`}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="block h-52 w-full border-0 bg-muted"
          src={osmEmbed(lat, lng)}
        />
      ) : null}

      <div className="space-y-3 p-3">
        <div className="flex items-start gap-2">
          <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <address className="text-sm not-italic leading-relaxed">
            {address.street ? (
              <>
                {address.street}
                <br />
              </>
            ) : null}
            {[address.city, address.state].filter(Boolean).join(", ")}
            {address.postalCode ? ` ${address.postalCode}` : ""}
            {address.country && address.country !== "United States" ? (
              <>
                <br />
                {address.country}
              </>
            ) : null}
          </address>
        </div>

        <div className="flex flex-wrap gap-2">
          <a
            href={`https://www.google.com/maps/dir/?api=1&destination=${query}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Navigation className="size-3.5" aria-hidden />
            Route here
          </a>
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${query}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors hover:bg-accent"
          >
            Google Maps
            <ExternalLink className="size-3" aria-hidden />
          </a>
          <a
            href={`https://maps.apple.com/?q=${query}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors hover:bg-accent"
          >
            Apple Maps
            <ExternalLink className="size-3" aria-hidden />
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * A small bounding box around the point, which is how OSM's embed expresses
 * zoom. 0.02 degrees is roughly a mile and a half -- close enough to see the
 * industrial park, wide enough to see which highway it sits off.
 */
function osmEmbed(lat: number, lng: number): string {
  const pad = 0.02;
  const bbox = [lng - pad, lat - pad, lng + pad, lat + pad].map((n) => n.toFixed(5)).join("%2C");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(5)}%2C${lng.toFixed(5)}`;
}

function toNumber(value: string | number | null): number | null {
  if (value === null || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}
