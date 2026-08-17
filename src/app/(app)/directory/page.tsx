import { redirect } from "next/navigation";

/**
 * The company directory, which is now the Prospects tab.
 *
 * ---------------------------------------------------------------------------
 * This screen existed to answer one question the accounts list could not: "is
 * this company already somebody's?" Prospects answers it as well and carries
 * the rest of the list with it, so keeping both would mean two search boxes
 * with different behaviour and a coin toss over which one somebody used.
 *
 * A redirect rather than a deletion. There are links to /directory in the
 * accounts list's empty state, in the command palette's results and in the
 * account lock screen, and there are bookmarks. A dead link reads as a broken
 * application; a redirect that keeps the search term reads as a rename.
 *
 * The scope names differ between the two screens -- the directory called it
 * "locked", Prospects calls it "held" -- so they are mapped rather than passed
 * through, which is the whole reason this is a function and not a config entry.
 * ---------------------------------------------------------------------------
 */
export default async function DirectoryRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const one = (key: string) => {
    const v = raw[key];
    return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
  };

  const params = new URLSearchParams();
  if (one("q")) params.set("q", one("q"));
  if (one("state")) params.set("st", one("state"));

  const scope = one("scope");
  if (scope === "locked") params.set("scope", "held");
  else if (scope === "available") params.set("scope", "available");

  const qs = params.toString();
  redirect(qs ? `/prospects?${qs}` : "/prospects");
}
