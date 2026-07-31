# Megaforce CRM

A CRM that captures phone calls automatically, decides which ones actually
count, and tells you why when one doesn't.

**All data in this project is fake.** Phone numbers use the 555-01xx block that
is reserved for movies and TV. Email domains end in `.test`, which nobody can
register. No real person or company appears anywhere.

---

## What works right now

| Thing | Status |
|---|---|
| Database design, permissions, indexes | Done, tested |
| Fake data: 800 companies, 20,000 calls and emails | Done, runs in 9 seconds |
| Matching a call to the right customer | Done, 85 tests passing |
| Deciding if a call counts, and explaining why | Done |
| Review queue for calls it refused to guess about | Done |
| Account list, account detail, review queue screens | Done |
| Fake call generator (stands in for RingCentral) | Done |
| Pipeline screen, report builder | Not built yet |
| Live RingCentral connection | Code is written, needs your sandbox login |

---

## Try it in 60 seconds, with no setup

You need nothing installed except Node. No database, no accounts, no signups.

```bash
npm install
npm test          # 85 tests against a real Postgres running inside the process
npm run seed      # builds the whole fake company
npm run simulate  # sends 10 fake phone calls through the real pipeline
```

`npm run simulate` prints a table like this:

```
connected call, 4 minutes          matched, QUALIFIED
connected call, 119 seconds        matched, not qualified
connected call, 121 seconds        matched, QUALIFIED
voicemail, 5 minutes               matched, not qualified
number written with an extension   matched, QUALIFIED
unknown number                     review queue (no_contact_match)
number at two accounts             review queue (multiple_accounts)
withheld caller ID                 review queue (unusable_phone_number)
same webhook delivered twice       already processed, ignored
```

That is the whole product in one screen. Every one of those rows is a real
thing that happens to real phone systems.

---

## To see the actual screens, you need a database

The screens need a login system, and the login system is Supabase. There are
three things to do, and only the first one involves any clicking.

### Step 1 — Make a Supabase project and copy five values

1. Go to **supabase.com** and sign up. It is free.
2. Click **New project**. Name it `megaforce-dev`.
3. Pick a database password and **write it down**. You cannot see it again.
4. Wait about two minutes while it builds.

Then click the gear icon (**Project Settings**).

Under **Database → Connection string → URI** there are two strings. Take both:

| Port | Goes in |
|---|---|
| **6543** | `DATABASE_URL` |
| **5432** | `DIRECT_URL` |

> The 6543 one shares connections between visitors. Without it the app runs out
> of database connections almost immediately once it is live.

Under **API**, take three more:

| In Supabase | Goes in |
|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` |
| anon public | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| service_role | `SUPABASE_SERVICE_ROLE_KEY` |

> The service_role key ignores all permission rules. It belongs on the server
> only. If it ever reaches a web page, every record in your database is public.

### Step 2 — Paste them into a file

```bash
cp .env.example .env.local
```

Open `.env.local` and paste your five values in. In **both** connection
strings, replace the word `PASSWORD` with the database password from Step 1 —
forgetting this is the most common mistake, and the setup command below will
tell you if you did.

This file is already ignored by Git and will never be committed.

### Step 3 — Run one command

```bash
npm run setup
```

That is the whole thing. It creates the tables, installs the permission rules,
loads 800 companies and 20,000 calls, creates your login, and prints the email
and password to sign in with. It takes about a minute.

If anything is wrong it stops and tells you which value to fix and where to
find it. It is safe to run again as many times as you need.

Then:

```bash
npm run dev
```

Open **http://localhost:3000** and sign in with the details it printed.

<details>
<summary>Prefer to do it by hand?</summary>

Everything `npm run setup` does can be done manually:

1. In Supabase, **SQL Editor → New query**. Paste and Run each of these, in
   order: `db/migrations/0001_schema.sql`, `0002_rls.sql`,
   `0003_config_defaults.sql`.
2. `npm run seed -- --remote`
3. **Authentication → Users → Add user**, email
   `avery.stone@megaforce.test`, any password, tick "Auto Confirm User". Copy
   the new user's **UID**, then run:

   ```sql
   update users set auth_id = 'PASTE-THE-UID-HERE'
    where email = 'avery.stone@megaforce.test';
   ```

</details>

---

## What to click, in order, when showing this to someone

1. **Accounts** — sorted coldest first. The red numbers on the right are
   companies nobody has had a real conversation with in two months.
2. Click any account. The right-hand panel is **entirely generated from a
   database table**. Nobody wrote code for "Monthly Retainer". Adding a field is
   one row in `field_defs` — no developer, no deploy.
3. Look at the **Activity** tab. Every call says whether it counted, and *why*.
   Find a voicemail: "call result 'Voicemail' is not one of the qualifying
   results". That sentence is the whole pitch. A rep asks "why didn't my call
   log" and you answer in five seconds instead of opening a ticket.
4. **Review queue** — calls the system refused to guess about. Show the one
   labelled "Two possible accounts": the number is on file at two customers, so
   it stopped and asked a human instead of filing it against the wrong one.
   Attach it to an account and watch it appear on that account's timeline.
5. Run `npm run simulate` in a terminal while they watch, then refresh.

---

## The rules, in plain English

**What counts as a real call.** At least 2 minutes, and somebody actually
answered. A five-minute voicemail does not count. A 119-second conversation does
not count; 121 seconds does.

These numbers live in a database table (`qualification_rules`), not in the code.
Changing "2 minutes" to "1 minute" does not require a developer or a new
release. To show this off, run this in the SQL Editor and re-run the simulator:

```sql
update qualification_rules set min_duration_seconds = 60 where activity_type = 'call';
```

**Who sees what.**

- A salesperson sees the companies they own.
- A manager sees everything owned by anyone underneath them on the org chart —
  their people, and their people's people, all the way down.
- An admin sees everything.
- **Only an admin can change who owns a company.** A manager can fix a wrong
  deal amount but cannot quietly move a rep's account to somebody else.

These rules are enforced by the database itself, not by the app. Even if a page
had a bug and asked for every account, the database would return only the ones
that person is allowed to see. There are 16 tests proving it.

**When it refuses to guess.** If a phone number is on file at two different
companies, the call goes to the review queue and no activity is created.
Attaching it to the wrong customer is worse than asking a person.

---

## Connecting real RingCentral

Not needed for a demo — the simulator drives the same pipeline. When you want
the real thing:

1. Register at **developers.ringcentral.com**. The sandbox is free and does not
   involve your company.
2. Create an app: **server-side**, **JWT auth**. Grant it Read Call Log and
   Webhook Subscriptions.
3. Put `RC_CLIENT_ID`, `RC_CLIENT_SECRET`, `RC_JWT` and a `RC_WEBHOOK_SECRET`
   (any long random string you invent) into your environment.
4. Deploy first. **RingCentral will not send calls to a laptop** — it needs a
   public web address.
5. Set `APP_URL` to your live address, then call `ensureSubscription()` from
   `src/lib/ringcentral/client.ts` once.

A scheduled job renews the subscription daily. That is not optional:
subscriptions expire, and when one lapses calls simply stop arriving with no
error anywhere. The first sign is a rep asking why nothing has logged since
Tuesday.

---

## Deploying

1. Push this repository to GitHub.
2. In Vercel, **Add New → Project**, pick the repo.
3. Add every variable from `.env.local` in Vercel's settings. **Never commit
   them.**
4. Deploy.

Anything you have ever pasted into a chat window should be rotated in Supabase
before going live.

---

## How the code is arranged

```
db/migrations/     The SQL. This is the source of truth for the database.
db/seed.ts         Fake data, including deliberate messy cases.
db/local.ts        Real Postgres running inside Node, for tests. No setup.
db/rls.test.ts     Proves the permission rules actually work.

src/lib/phone.ts       Turns any phone format into one canonical form.
src/lib/qualify.ts     Decides if an activity counts. Always says why.
src/lib/matcher.ts     Finds the right customer. Refuses to guess.
src/lib/ingest.ts      Stores incoming webhooks exactly once.

src/app/api/webhooks/  Receives calls and emails. Under 300ms, always.
src/inngest/           Background processing, with retries.
src/app/(app)/         The screens.

scripts/seed.ts            npm run seed
scripts/simulate-calls.ts  npm run simulate
```

### Two ways into the database, on purpose

- **Pages and buttons** use the Supabase client, which carries the signed-in
  user's identity, so the permission rules apply automatically.
- **The webhook worker and the seed script** use a direct connection that
  ignores permission rules — it has to, because it is attributing a phone call
  to a company nobody has told it about yet.

Mixing these up is how a CRM leaks every account to every salesperson, so they
are kept in separate files with the reason written at the top of each.

---

## Commands

```bash
npm run setup                One-command Supabase setup. Re-runnable.
npm run dev                  Start the app
npm test                     Run all 85 tests
npm run seed                 Fake data, local
npm run seed -- --remote     Fake data, Supabase
npm run seed -- --small      A tiny dataset, for quick checks
npm run simulate             Send 10 fake calls through the pipeline
npm run simulate -- --http http://localhost:3000
                             Same, but over real HTTP at the live endpoint
npm run build                Production build
```

---

## Known gaps

- **Pipeline screen and report builder are not built.** Steps 8 and 9 of the
  build plan.
- **The screens need Supabase.** The pipeline, the matcher and the tests all run
  with no setup, but the browser app needs a login system. Without credentials
  it shows setup instructions instead of crashing.
- **`last_activity_at` only updates when activity is added.** Deleting an
  activity leaves the timestamp stale. Fine for a demo; a real deployment wants
  a nightly recompute.
- **International phone numbers are handled simply.** North American numbers are
  exact. For real multi-country use, swap one branch of `src/lib/phone.ts` for
  `libphonenumber-js`. Nothing else changes.
- **Twelve npm audit warnings**, all in the code-checking tools that never ship
  to users. Fixing them requires downgrading ESLint.
