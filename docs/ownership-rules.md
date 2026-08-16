# Ownership and expiry rules

Written from Alex's explanation. **This is the specification.** Where it
disagrees with the code, the code is wrong.

Read it back and correct anything misstated — every one of these numbers ends up
compiled into a database function, and a rule that is subtly wrong here is
expensive to find later.

---

## Roles

| Role | Sells? | Can own a prospect | Can own a customer |
|---|---|---|---|
| Broker | yes | yes, alone | yes |
| AD | yes | yes, alone | yes, **alongside** a broker |
| Manager | — | reviews amnesty requests | |
| Credit | — | | |
| Admin | — | | |

**AD** is a specialised sales rep who works with brokers. Both sell.

- **A prospect has exactly one owner.** No exceptions.
- **A customer may have two**: if an AD set the customer up, a broker runs it
  and the AD takes a percentage. So a customer carries a broker owner and,
  optionally, an AD owner.

That is a real structural change: `owner_id` becomes insufficient on its own
once an account converts.

---

## The prospect clock

### On claim — 7 days

Take a prospect from the available pool and you have **7 days** to log a
verified activity. Miss it and the account returns to available.

### After a verified activity — 30 days, rolling

Log one and the clock resets to **30 days from that activity**. Log another
inside that window and it resets again.

A prospect can be held indefinitely this way. That is intended.

### The renewal counter

Every reset increments a counter on the account.

It changes nothing automatically. It exists so a manager can see somebody has
renewed the same prospect twenty-four times over two years without converting
it. **That is a management decision, not a computer decision** — Alex's words,
and the reason the counter must never trigger anything on its own.

### The cooldown — 30 days

When a prospect falls back to available:

- **Anyone who has held it in the last 30 days cannot take it.**
- Anybody else can, immediately.

So losing an account to the clock means genuinely losing it. You cannot let it
lapse and re-grab it from the pool to buy another 30 days, which is precisely
the loophole the rule closes.

Note the wording: *anyone* who held it within 30 days, not just the last owner.

---

## The customer clock

**180 days without running a load** and the account expires — unless amnesty is
in force.

Loads live in the TMS, not here. See the open question below.

---

## Amnesty

The "Account Request" tab in Salesforce today.

- An employee **requests amnesty** on an account.
- It goes to **their manager** for review.
- A manager **approves manually**.
- While in force, the account does not fall out of their name despite the clock.

Needed on the admin side. This is a request/approve workflow with a queue, not
a checkbox.

---

## What counts as a verified activity

Stated as **"Email or RingCentral"**.

⚠️ Unresolved: whether a RingCentral call must still clear a duration
threshold, or whether any connected call counts. The current build requires 120
seconds and a connected result. See open questions.

---

## Parent and child accounts

Hierarchy matters **for credit only**: a parent carries the sum of its
children's credit lines. No ownership implication.

---

## Stage and Status

Two separate fields, as seen on the record page (Stage `Lead`, Status
`Inactive`).

- **Stage** is the sales pipeline. **Quote is a stage**, not a feature — there
  is no quoting tool behind it.
- **Status** is the lifecycle: Active / Inactive / At Risk / Expiring, matching
  the filter presets.

Full value sets still needed.

---

## Explicitly out of scope

- **Ticket Manager** — not needed.
- **Quote as a feature** — it is a stage name and nothing more.
- Loads, carriers, rates — the TMS owns all of it.

---

## Open questions

### 1. How does the CRM learn a load ran? — BLOCKING for customers

The 180-day customer clock depends on load activity, and loads are in the TMS.
Nothing in this system can currently know. Options:

- a feed or nightly export from the TMS,
- an API this system calls,
- or a manual marker somebody sets.

Until one exists, the customer clock cannot run. The prospect clock is
unaffected and can be built now.

### 2. Does a RingCentral call have to be long enough?

"Verified activity: Email or RingCentral." Does a 20-second call count?

This matters more than it sounds: if any connected call counts, a broker keeps
an account by dialling and hanging up. If there is a threshold, what is it —
and does a voicemail count?

### 3. Does an email have to be answered?

Or does sending one count on its own? Same loophole, same question.

### 4. When is an AD owner recorded?

At conversion only, or can one be added to an existing customer? Does the AD
have their own clock, or does the broker's activity cover both?

### 5. How long does amnesty last?

Indefinite until revoked, a fixed extension, or per-request?

### 6. Full Stage and Status value sets.
