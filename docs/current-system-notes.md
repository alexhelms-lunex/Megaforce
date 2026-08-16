# Notes on the current system

Captured from screenshots Alex is uploading in batches. This is a record of
WHAT EXISTS TODAY, not a specification of what to build — he will explain the
requirements once the upload is complete.

Kept in the repo rather than in conversation so it survives across sessions.

---

## Batch 1 — Account list: filter bar, filter presets, industry taxonomy

### Page furniture

Document links sitting above the list:

- IntraCanadian Customer Packet PDF
- Company Info Docs Folder
- RFP Submission Form

Buttons on the filter bar:

- **Apply Filters/Search** (primary)
- **Follow** / **Unfollow** — a following concept that is separate from
  ownership. Not something we currently have.
- **National Account Approval** — an approval workflow. Not something we
  currently have.

### Filter controls

| Control | Type |
|---|---|
| Search Accounts Here | free text |
| Select Filter | multi-select of named presets, shown as removable chips |
| Select Industry | single select |
| Search City | free text |
| Select State | single select |
| Search Phone Number | free text |
| Page Size | 100 |

Selected filters appear as chips with an X — the screenshot shows
`My Prospects ✕` and the control reading "1 Option(s) Selected".

### Named filter presets

Two parallel lifecycles, prospects and customers, each with its own set. This
is significant: our model currently has one lifecycle.

**Prospects**
- My Active Prospects
- My Expiring Prospects
- My Prospect Account Follows
- My Prospects

**Customers**
- My Active Customers
- My At Risk Customers
- My Customer Account Follows
- My Customers Expiring
- All At Risk Customers
- All Available Inactive Customers
- All Expiring Customers
- All Inactive Expiring Customer  *(singular in the original)*

Pattern: every preset is scoped **My** or **All**, then by object
(prospect / customer), then by state (active / expiring / at risk / inactive /
follows). Suggests scope and state are independent axes rather than a flat list.

### Result columns

Status ↑ · Last Communicated … · Last Activity In Days · Last L… · Last L… ·
Owner · Owner Location · Ad Owner · Type

Two columns are truncated in the screenshot and need confirming. "Ad Owner" is
unexplained — possibly Additional Owner.

### Industry taxonomy

A long, specific, alphabetical list. Two windows captured:

Animal Feed/Products · Appliances/Electronics · Auto and Auto Parts · Bakery ·
Beauty Products · Beverages – alcoholic · … · Equipment (including rental) ·
Event Staging · Fixtures/Supplies for Hospitality/R… · Food - Dry ·
Food - Frozen · Food Ingredients · …

Heavily food and consumer-goods weighted, which fits a freight book. The full
list is longer than the two windows shown — worth getting in full, since these
are the values a filter and any import have to match exactly.

### Gaps against what we have

- Account **following**, separate from ownership
- **National Account Approval** workflow
- A **customer** lifecycle running alongside the prospect one, with "at risk"
  and "inactive" as distinct states from "expiring"
- **Owner Location** and **Ad Owner** — more than one person attached to an
  account
- Filtering by city, state and phone number
- A controlled industry list, versus our free-text field

---

## Batch 2 — Rest of the industry list, and the Global Actions menu

### The system underneath

The Global Actions menu, the star/favourites control and the `+` button are
Salesforce Lightning furniture. So the thing being replaced is **Salesforce
with heavy customisation**, not a bespoke application. That matters for the
import: the export will carry Salesforce's own field names and Ids.

### Global Actions

- New Task
- New Event
- **New Prospect**  ← the object is called Prospect here, not Account
- **Log a Call**    ← manual call logging, alongside whatever is captured
- Email

Task and Event are Salesforce's standard activity objects. Our `activities`
table currently covers call / email / meeting / note, which maps onto these but
does not yet have Task as a first-class thing with an owner and a due date.

### Industry list, continued

Captured windows, in order:

… Lumber · Meat/Poultry · Medical · Metal · Nuts/Grains · Oil/Oil Products ·
Paper Products · Plastics · Produce · Recycling · Renewable Energy ·
Restaurant (including QSR) · Rubber · Seafood · Textile · Toys · Tubes/Pipes ·
Vitamins/Supplements/Dietary · **TBD**

`TBD` is the final entry — a deliberate "not categorised yet" value, so the
field is effectively required with an escape hatch.

### Assembled list so far

Animal Feed/Products · Appliances/Electronics · Auto and Auto Parts · Bakery ·
Beauty Products · Beverages – alcoholic · **[gap]** · Equipment (including
rental) · Event Staging · Fixtures/Supplies for Hospitality/R… · Food - Dry ·
Food - Frozen · Food Ingredients · **[gap]** · Lumber · Meat/Poultry ·
Medical · Metal · Nuts/Grains · Oil/Oil Products · Paper Products · Plastics ·
Produce · Recycling · Renewable Energy · Restaurant (including QSR) · Rubber ·
Seafood · Textile · Toys · Tubes/Pipes · Vitamins/Supplements/Dietary · TBD

Two windows were not captured:

1. Between **Beverages – alcoholic** and **Equipment** (the C–E entries)
2. Between **Food Ingredients** and **Lumber** (the F–L entries)

Also truncated: **Fixtures/Supplies for Hospitality/R…**

These values have to match exactly for a Salesforce import to land in the right
bucket, so the full list is worth getting verbatim rather than reconstructing.
Easiest source is the Salesforce field definition itself rather than more
screenshots — Setup → Object Manager → the field → Values.

---

## Batch 3 — The Account record page

Confirms the platform outright: `megacorp.lightning.force.com/lightning/r/Account/001Vs00000JAR48IAH/view`.
Salesforce Lightning, org "MegaCorp", standard **Account** object (the `001`
prefix), inside a console app called "MegaCorp Sales Co…".

Browser tabs alongside it: **My Shipments – DAT** (twice), **Loadboard –
MegaCorp**, **Posting – MegaCorp**. The DAT loadboard and posting tools are
where freight actually moves, entirely separate from this. Consistent with what
Alex said: no loads in the CRM.

### Record page tabs

Overview · Contacts · Activities · **Account Request** · **Quote** ·
**ZoomInfo** · **Ticket Manager** · More…

Four of those have no equivalent in our build and none are self-explanatory:

- **Account Request** — possibly how a broker asks for an account to be
  assigned or released. Would sit right on top of our claim mechanic.
- **Quote** — pricing, presumably lane or rate quotes.
- **ZoomInfo** — third-party enrichment, already integrated. The original build
  plan anticipated exactly this and stubbed an enrichment interface for it.
- **Ticket Manager** — internal support or issue tracking.

### Account Details, as laid out on screen

| Field | Value in the example | Notes |
|---|---|---|
| Account Name | FakeCustomer Test POC | |
| Parent Account | *(empty)* | **hierarchy** |
| Website | *(empty)* | inline editable |
| **National Account** | ✓ | checkbox |
| Shipping Address | 281 Clara Street, San Francisco, California 94107, United States | rendered with a map |
| **National Account In Review** | ✓ | checkbox — pairs with the National Account Approval button from batch 1 |
| Number of Children Accounts | 0 | rollup |
| Phone | (879) 657-1023 | |
| Parent Account ID | *(empty)* | |
| **Stage** | Lead | |
| **Status** | Inactive | |

A **RingCentral** section header sits below Status, so RingCentral is already
embedded in the record page today.

### What this changes about the model

**1. Accounts form a hierarchy.** Parent Account, Parent Account ID and a
children rollup. National accounts have subsidiaries, and ownership of a parent
almost certainly implies something about its children. Our accounts table is
flat. This is the most structural gap found so far.

**2. Stage and Status are separate axes.** Stage is Lead here while Status is
Inactive. We collapsed both into one `status` column. Stage looks like sales
progression; Status looks like the active/inactive/at-risk lifecycle the filter
presets referred to.

**3. National Account is a flag plus an approval state.** "National Account" and
"National Account In Review" together with the "National Account Approval"
button describe a request-and-approve workflow, not a checkbox.

**4. Addresses are structured and geocoded.** Street, city, state, postal code,
country — which is what makes the city and state filters from batch 1 possible.
We store no address at all.

**5. Enrichment already exists** via ZoomInfo, so the stub interface in the
original plan has a real provider to swap in behind it.

---

## Open questions to resolve before building

Recorded here rather than asked one at a time, since Alex is about to explain
the requirements and may answer several of them already.

1. What is **Account Request**? It may already be the claim/assign flow.
2. Exact meaning of **Ad Owner** and **Owner Location**.
3. The two truncated columns on the list, after "Last Activity In Days".
4. Full **Stage** and **Status** value sets, and which drives expiry.
5. Does owning a parent account confer anything over its children?
6. The two missing windows of the industry list.
7. Whether **Quote** and **Ticket Manager** are in scope at all.
