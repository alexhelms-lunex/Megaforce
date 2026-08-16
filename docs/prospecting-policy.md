# MegaCorp Prospecting Policy

Transcribed from the policy document dated 3.19.25. **This is the authoritative
specification.** Where the code disagrees, the code is wrong.

Alex's verbal account and this document agree everywhere they overlap, except
one number, noted below.

---

## 1. Approved methods of communication

An "approved activity" is one of exactly four things. Everything else is
logged but does not reset any clock.

### RingCentral (click-to-call)

- Recorded through the CRM via RingCentral.
- **The call must last 60 seconds or longer.**
- The broker must **choose a stage outcome** in the RingCentral app for the call
  to save correctly.

> ⚠️ **The current build requires 120 seconds. That is wrong — it is 60.**
> It also does not capture a stage outcome at all.

### Email

- Must go to a **sales contact that exists in the CRM**. An email to somebody
  not on file does not count.
- **One contact per activity.** Group sends and multi-contact BCC do not count.
- **Both directions count**: emails the broker sends, and emails received from
  a contact.
- **Confirmed by Alex:** the on-file requirement applies to inbound too. An
  email *from* somebody not in the CRM does not count either. So the rule is
  symmetric — the counterparty must be a known contact whichever way the
  message travelled.

### Text (RingCentral SMS)

- Must go to a sales contact in the CRM, **and the contact must respond.**
  An unanswered text is not an activity.

### Quoting

- Quote templates are for spot load opportunities. They are **not** carrier rate
  confirmations or load tenders.
- Counts as an activity only when the **quote email is sent to a contact on that
  account**.

---

## 2. Required contact

Every sales contact must be in the CRM. The contact **Type** picklist:

Owner · C Suite Level · Director of Supply Chain / Logistics · Procurement ·
Carrier Relations · 4PL Logistics Manager · Logistics Manager ·
Logistics Coordinator · Logistics Operations · Sales · Buyer / Purchasing ·
Other

This is load-bearing, not decoration: an email only counts if it went to a
contact on file, so the contact list is what makes activity verifiable.

---

## 3. The prospect clock

| Day | What happens |
|---|---|
| 0 | Prospect added or claimed |
| 0–7 | Initial contact required via approved method |
| **8** | **Not contacted → released back to available** |
| — | Any approved activity resets the clock to 30 days |
| **21** | Alert bell fires. **Status → Expiring.** Expiring is days 21–30 |
| 21–30 | The "9-day expiration period". Communicate and status returns to Active |
| **31** | **No activity → status Available, back into the pool** |

### Re-acquisition and transfer limits

- A prospect removed for inactivity **cannot be added back by the same broker
  for 30 days.**
- If a broker **assigns** a prospect to another broker, the receiving broker
  **cannot use the assign feature for 30 days**. This exists specifically to
  stop brokers passing prospects between each other to dodge the clock.
- A newly added prospect **cannot be re-assigned to a different broker for 30
  days.**

### Maximum hold

A prospect **cannot be held by the same broker for more than 365 days** without
a Sales Director's approved extension.

---

## 4. Prospect limits by tier

The system calculates each broker's limit from their **start date**.

| Tier | Limit |
|---|---|
| AMTs (post 90 days) | 100 |
| 0–12 month (Junior) brokers | 200 |
| 2–3 year (Unseasoned) brokers | 100 |
| 3 years+ (Veteran) brokers | 15 per customer setup, capped at 100. Reviewed every 6 months |
| National Account Directors | 250, increasable if proven to be working all of them |
| Logistics Managers | 15 |
| Brokers transitioning to Ops | 15, sitting under their broker's max allotment |

Discretion still applies for effective brokers and ADs.

**On a tier change the system must not allow a new prospect until the stored
limit reflects the new tier.** Brokers can request an override; a Sales Director
approves a different limit.

Note the Junior tier (200) is *higher* than the Unseasoned tier (100).
**Confirmed by Alex as correct, not a typo.** Do not "fix" it.

---

## 5. Termination

A terminated broker's prospects and customers pass to their assigned **Sales
Director**, who has **2 weeks** to evaluate them. After that they are released
back to available.

---

## 6. The customer clock — driven by LOADS, not activity

| Day | Status | What happens |
|---|---|---|
| 0–90 | Active | Hauling normally |
| **90** | **→ At Risk** | No load in 90 days and no extension. Bell notification fires |
| 91–150 | At Risk | Broker keeps it, must communicate via approved method |
| **150** | **→ Expiration** | 30 days for final attempts |
| 151–180 | Expiration | |
| **181** | **→ Inactive, released** | Back to available accounts |

**When a customer flips Active → Inactive, credit is removed** on the location
account *and every service account underneath it*. That is the parent/child
hierarchy doing real work.

A broker who loses a customer **cannot take it back for 30 days** without a
Senior Sales Director's help.

---

## 7. Inactive customers — a third clock

**"Once a customer always a customer."** Inactive customers stay in the system
and can be claimed, but are worked **as if they were prospects**.

| Day | What happens |
|---|---|
| 0–7 | Must communicate after taking ownership |
| **8** | **No contact → back to Available Accounts** |
| — | Then every **21 days** via approved method |
| 21–30 | Expiring status |
| **31** | **Released back to Available Accounts** |

Note this differs from the prospect clock: **21 days, not 30.**

To make an inactive customer active again the broker must re-activate with a
**new customer packet** and a **customer billing sheet** (if Customer Credit
requires one) to re-establish credit for the service types.

---

## 8. Commission rules

- **Logistics Managers** earn an additional **5% commission** for connecting
  with a prospect or customer not already affiliated with an account in their
  name. **Not** granted when the account is a referral from an existing account,
  or is affiliated with the Account Director who generated the lead.
- **Account Directors** must communicate with Logistics Managers when an active
  customer is expiring. **The AD's name is removed for inactivity too.**

---

## 9. Three lifecycles, not one

This is the biggest correction to the current build, which has one.

| | Prospect | Active customer | Inactive customer |
|---|---|---|---|
| Clock driven by | approved activity | **loads hauled** | approved activity |
| Initial window | 7 days | — | 7 days |
| Ongoing window | 30 days | 90 → 150 → 180 | 21 days |
| Warning at | 21 days | 90 days (At Risk) | 21 days |
| Released on | day 31 | day 181 | day 31 |
| Cooldown | 30 days | 30 days, Senior Sales Director can waive | — |

---

## Still open

### 1. How does the system learn a load was hauled? — BLOCKING

The entire customer clock keys off load activity, and loads live in the TMS.
Nothing here can currently know. Needs a feed, an API, or a manual marker.
The prospect and inactive-customer clocks are unaffected.

### ~~2. RingCentral stage outcomes~~ ANSWERED

**Lead · Contact · Pitch · Quote · Closed** — the same values as the account's
Stage field, because they are the same field. Logging a call is what advances
the stage.

### 3. Is the Junior tier limit (200) really higher than Unseasoned (100)?

### 4. How is "extension" granted on a customer account?

Section 6 mentions "no extension on the customer account" — presumably the same
amnesty workflow, but worth confirming it is one mechanism rather than two.

### ~~5. Inbound email sender on file?~~ ANSWERED

**Yes.** The counterparty must be a contact in the CRM whichever direction the
message travelled.
