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
