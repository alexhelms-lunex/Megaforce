import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Shown when Supabase credentials are absent.
 *
 * The alternative is a stack trace on every page, which tells a person nothing
 * about what to do next. The database, the matcher and the seed all work
 * without these values -- only the browser-facing app needs them, because the
 * app relies on Supabase Auth to identify who is asking.
 */
export function SetupNotice() {
  return (
    <div className="mx-auto flex min-h-screen max-w-2xl items-center p-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Connect a database to continue</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed">
          <p className="text-muted-foreground">
            The pipeline underneath this app already runs. What is missing is the
            connection the browser needs in order to know who you are.
          </p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Create a free project at <span className="font-mono">supabase.com</span>.
            </li>
            <li>
              Copy <span className="font-mono">.env.example</span> to{" "}
              <span className="font-mono">.env.local</span> and fill in the four Supabase
              values.
            </li>
            <li>
              Run the three files in <span className="font-mono">db/migrations/</span> in the
              Supabase SQL editor, in order.
            </li>
            <li>
              Run <span className="font-mono">npm run seed -- --remote</span>.
            </li>
          </ol>
          <p className="text-muted-foreground">
            Full walkthrough in <span className="font-mono">README.md</span>. Meanwhile{" "}
            <span className="font-mono">npm test</span> and{" "}
            <span className="font-mono">npm run simulate</span> both run with no setup at all.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
