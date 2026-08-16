/**
 * Drizzle mirror of db/migrations/*.sql.
 *
 * The SQL files are the source of truth -- they are what runs against Supabase.
 * This file exists so application code gets types and a query builder. When the
 * two drift, the SQL wins and this file is wrong.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const now = sql`now()`;
const newUuid = sql`uuid_generate_v4()`;

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(newUuid),
    authId: uuid("auth_id").unique(),
    email: text("email").notNull().unique(),
    fullName: text("full_name").notNull(),
    /** 'broker' | 'manager' | 'credit' | 'admin' -- constrained by a CHECK in SQL. */
    role: text("role").notNull(),
    managerId: uuid("manager_id"),
    /** Telephony extension, used to attribute an inbound call event to a rep. */
    rcExtensionId: text("rc_extension_id").unique(),
    /** Branch or office. Shown as a column in the account list. */
    location: text("location"),
    /** Drives the policy's tier: 0-12mo junior, 2-3yr unseasoned, 3yr+ veteran. */
    startDate: date("start_date"),
    /** How many prospects this rep may hold. Null falls back to the tier default. */
    prospectLimit: integer("prospect_limit"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (t) => [index("users_manager_id_idx").on(t.managerId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().default(newUuid),
    name: text("name").notNull(),
    /**
     * Null is not missing data -- it is the available pool, and it is the most
     * important state in the system. An unowned account is one any broker can
     * claim.
     */
    ownerId: uuid("owner_id").references(() => users.id),
    industry: text("industry"),
    /** 'prospect' | 'engaged' | 'customer' | 'do_not_contact' */
    status: text("status").notNull().default("prospect"),
    /** Sales pipeline: Lead | Contact | Pitch | Quote | Closed. */
    stage: text("stage").notNull().default("Lead"),
    domain: text("domain"),
    website: text("website"),
    /** Switchboard number. Always E.164; normalized on write by src/lib/phone.ts. */
    phoneE164: text("phone_e164"),

    // Structured, not a text blob: "State = NC" has to be a filter, and the map
    // needs the parts. Named billing_* to match the Salesforce field names.
    billingStreet: text("billing_street"),
    billingCity: text("billing_city"),
    billingState: text("billing_state"),
    billingPostalCode: text("billing_postal_code"),
    billingCountry: text("billing_country").default("United States"),
    billingLatitude: numeric("billing_latitude", { precision: 9, scale: 6 }),
    billingLongitude: numeric("billing_longitude", { precision: 9, scale: 6 }),

    /** Parent in the corporate hierarchy. Credit rolls up; ownership does not. */
    parentAccountId: uuid("parent_account_id"),
    nationalAccount: boolean("national_account").notNull().default(false),
    nationalAccountInReview: boolean("national_account_in_review").notNull().default(false),
    nationalAccountApprovedBy: uuid("national_account_approved_by").references(() => users.id),
    nationalAccountApprovedAt: timestamp("national_account_approved_at", { withTimezone: true }),

    /**
     * The Account Director who set the customer up, alongside the broker who
     * runs it. Customers only -- a prospect has exactly one owner.
     */
    adOwnerId: uuid("ad_owner_id").references(() => users.id),

    creditLimit: numeric("credit_limit", { precision: 14, scale: 2 }),
    /** 'none' | 'requested' | 'approved' | 'on_hold' | 'revoked' */
    creditStatus: text("credit_status"),

    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /**
     * Granted by an approved account request (amnesty, or a customer
     * extension). While this is in the future the account cannot expire, and
     * account_state() reports 'protected'.
     */
    retentionOverrideUntil: timestamp("retention_override_until", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    lastReleaseReason: text("last_release_reason"),
    /** Maintained by the t_bump_last_activity trigger, never written by hand. */
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    /** Values for admin-defined fields; see fieldDefs. */
    custom: jsonb("custom").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index("accounts_owner_id_idx").on(t.ownerId),
    index("accounts_last_activity_at_idx").on(t.lastActivityAt),
    index("accounts_status_idx").on(t.status),
    index("accounts_parent_idx").on(t.parentAccountId),
    index("accounts_ad_owner_idx").on(t.adOwnerId),
  ],
);

/**
 * Amnesty, extensions, transfers and promotions — one queue.
 *
 * The policy names amnesty on a prospect and an extension on a customer
 * separately, but operationally they are the same transaction: an employee asks
 * to hold an account past its window and somebody above them decides. Modelling
 * them once means the two approval paths cannot drift apart.
 */
export const accountRequests = pgTable(
  "account_requests",
  {
    id: uuid("id").primaryKey().default(newUuid),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    /** 'amnesty' | 'extension' | 'national' | 'release' | 'transfer' */
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    /** Days of protection being asked for. Null for kinds that grant no time. */
    days: integer("days"),
    transferTo: uuid("transfer_to").references(() => users.id),
    /** 'pending' | 'approved' | 'denied' | 'withdrawn' */
    status: text("status").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index("account_requests_account_idx").on(t.accountId),
    index("account_requests_requester_idx").on(t.requestedBy),
  ],
);

export const accountRequestsRelations = relations(accountRequests, ({ one }) => ({
  account: one(accounts, { fields: [accountRequests.accountId], references: [accounts.id] }),
  requester: one(users, { fields: [accountRequests.requestedBy], references: [users.id] }),
  decider: one(users, { fields: [accountRequests.decidedBy], references: [users.id] }),
}));

/**
 * The Salesforce Industry picklist, as a table.
 *
 * A controlled list rather than free text: near-duplicate values ("Food-Dry",
 * "Food - Dry") silently split every report that groups by industry, and the
 * damage is invisible until someone adds the two numbers up by hand.
 */
export const industries = pgTable("industries", {
  name: text("name").primaryKey(),
  sort: integer("sort").notNull().default(0),
});

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().default(newUuid),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email"),
    /** Always E.164. Normalized on write by src/lib/phone.ts, never raw input. */
    phoneE164: text("phone_e164"),
    title: text("title"),
    /** Approved sales-contact type from the prospecting policy. */
    type: text("type"),
    custom: jsonb("custom").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (t) => [index("contacts_account_id_idx").on(t.accountId)],
);

export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid("id").primaryKey().default(newUuid),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    stage: text("stage").notNull(),
    /** numeric, not float. Money in a binary float is a rounding bug waiting. */
    amount: numeric("amount", { precision: 14, scale: 2 }),
    closeDate: date("close_date"),
    custom: jsonb("custom").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (t) => [index("opportunities_owner_stage_idx").on(t.ownerId, t.stage)],
);

export const rawEvents = pgTable(
  "raw_events",
  {
    id: uuid("id").primaryKey().default(newUuid),
    source: text("source").notNull(),
    externalId: text("external_id"),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().default(now),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [index("raw_events_source_idx").on(t.source, t.externalId)],
);

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().default(newUuid),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id),
    /** 'call' | 'email' | 'meeting' | 'note' */
    type: text("type").notNull(),
    /** 'inbound' | 'outbound' | null */
    direction: text("direction"),
    subject: text("subject"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    durationSeconds: integer("duration_seconds"),
    /** Provider outcome verbatim: 'Call connected', 'Voicemail', 'No Answer'. */
    result: text("result"),
    /** Stage the broker selected when logging: Lead, Contact, Pitch, Quote, Closed. */
    stageOutcome: text("stage_outcome"),
    notes: text("notes"),
    loggedBy: uuid("logged_by").references(() => users.id),
    loggedAt: timestamp("logged_at", { withTimezone: true }),
    source: text("source").notNull().default("manual"),
    externalId: text("external_id"),
    qualifies: boolean("qualifies").notNull().default(false),
    /**
     * Written on every row, pass or fail. This is the column that answers "why
     * didn't my call log" without anyone opening a ticket.
     */
    qualificationReason: text("qualification_reason").notNull().default(""),
    rawEventId: uuid("raw_event_id").references(() => rawEvents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index("activities_account_occurred_idx").on(t.accountId, t.occurredAt),
    index("activities_user_occurred_idx").on(t.userId, t.occurredAt),
  ],
);

export const unmatchedActivities = pgTable(
  "unmatched_activities",
  {
    id: uuid("id").primaryKey().default(newUuid),
    rawEventId: uuid("raw_event_id")
      .notNull()
      .references(() => rawEvents.id),
    /** 'no_contact_match' | 'multiple_accounts' */
    reason: text("reason").notNull(),
    candidateAccountIds: uuid("candidate_account_ids").array(),
    phoneE164: text("phone_e164"),
    email: text("email"),
    direction: text("direction"),
    durationSeconds: integer("duration_seconds"),
    result: text("result"),
    subject: text("subject"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedToAccountId: uuid("resolved_to_account_id").references(() => accounts.id),
    resolvedActivityId: uuid("resolved_activity_id").references(() => activities.id),
  },
  (t) => [uniqueIndex("unmatched_raw_event_uniq").on(t.rawEventId)],
);

export const fieldDefs = pgTable(
  "field_defs",
  {
    id: uuid("id").primaryKey().default(newUuid),
    /** 'account' | 'contact' | 'opportunity' */
    object: text("object").notNull(),
    /** The key inside the target row's `custom` jsonb. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    /** 'text' | 'number' | 'date' | 'select' | 'boolean' */
    type: text("type").notNull(),
    /** For type='select': a JSON array of allowed values. */
    options: jsonb("options").$type<string[] | null>(),
    required: boolean("required").notNull().default(false),
    sort: integer("sort").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (t) => [uniqueIndex("field_defs_object_key_uniq").on(t.object, t.key)],
);

export const qualificationRules = pgTable("qualification_rules", {
  id: uuid("id").primaryKey().default(newUuid),
  activityType: text("activity_type").notNull(),
  minDurationSeconds: integer("min_duration_seconds").notNull().default(0),
  /** Empty array means any provider result is acceptable. */
  allowedResults: text("allowed_results").array().notNull().default([]),
  /** null means either direction qualifies. */
  requiredDirection: text("required_direction"),
  /** When true, an outcome must be logged before the activity counts. */
  requiresOutcome: boolean("requires_outcome").notNull().default(false),
  active: boolean("active").notNull().default(true),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
});

export const savedViews = pgTable("saved_views", {
  id: uuid("id").primaryKey().default(newUuid),
  object: text("object").notNull(),
  name: text("name").notNull(),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "cascade" }),
  shared: boolean("shared").notNull().default(false),
  definition: jsonb("definition").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
});

/**
 * How long a broker may hold an account without working it.
 *
 * Data rather than code, for the same reason the qualification thresholds are:
 * "thirty days" is a commercial decision that will be argued about, and
 * changing it must not require a release.
 */
export const accountRetentionRules = pgTable("account_retention_rules", {
  id: uuid("id").primaryKey().default(newUuid),
  /** 'prospect' | 'engaged' | 'customer' */
  appliesTo: text("applies_to").notNull(),
  /** Amber. Still yours, but it needs attention. */
  warningDays: integer("warning_days").notNull().default(21),
  /** Red. Days away from being taken. */
  expiringDays: integer("expiring_days").notNull().default(30),
  /** Gone. Returns to the pool. */
  releaseDays: integer("release_days").notNull().default(45),
  active: boolean("active").notNull().default(true),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
});

/**
 * Who held what, when, and why they stopped.
 *
 * The audit trail that settles territory arguments. Release is a recorded event
 * rather than a column quietly going null.
 */
export const accountClaims = pgTable(
  "account_claims",
  {
    id: uuid("id").primaryKey().default(newUuid),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().default(now),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    /** 'expired' | 'manual' | 'reassigned' | 'converted' */
    releaseReason: text("release_reason"),
    releasedBy: uuid("released_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (t) => [index("account_claims_account_idx").on(t.accountId, t.claimedAt)],
);

// ---------------------------------------------------------------------------
// Relations -- these power db.query.*.findMany({ with: ... })
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ one, many }) => ({
  manager: one(users, { fields: [users.managerId], references: [users.id], relationName: "org" }),
  reports: many(users, { relationName: "org" }),
  accounts: many(accounts),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  owner: one(users, { fields: [accounts.ownerId], references: [users.id] }),
  adOwner: one(users, { fields: [accounts.adOwnerId], references: [users.id] }),
  parent: one(accounts, {
    fields: [accounts.parentAccountId],
    references: [accounts.id],
    relationName: "hierarchy",
  }),
  children: many(accounts, { relationName: "hierarchy" }),
  claims: many(accountClaims),
  contacts: many(contacts),
  opportunities: many(opportunities),
  activities: many(activities),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  account: one(accounts, { fields: [contacts.accountId], references: [accounts.id] }),
  activities: many(activities),
}));

export const opportunitiesRelations = relations(opportunities, ({ one }) => ({
  account: one(accounts, { fields: [opportunities.accountId], references: [accounts.id] }),
  owner: one(users, { fields: [opportunities.ownerId], references: [users.id] }),
}));

export const activitiesRelations = relations(activities, ({ one }) => ({
  account: one(accounts, { fields: [activities.accountId], references: [accounts.id] }),
  contact: one(contacts, { fields: [activities.contactId], references: [contacts.id] }),
  user: one(users, { fields: [activities.userId], references: [users.id] }),
  rawEvent: one(rawEvents, { fields: [activities.rawEventId], references: [rawEvents.id] }),
}));

export const unmatchedActivitiesRelations = relations(unmatchedActivities, ({ one }) => ({
  rawEvent: one(rawEvents, { fields: [unmatchedActivities.rawEventId], references: [rawEvents.id] }),
  resolvedToAccount: one(accounts, {
    fields: [unmatchedActivities.resolvedToAccountId],
    references: [accounts.id],
  }),
}));

// Convenience types for application code.
export type User = typeof users.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Opportunity = typeof opportunities.$inferSelect;
export type Activity = typeof activities.$inferSelect;
export type RawEvent = typeof rawEvents.$inferSelect;
export type UnmatchedActivity = typeof unmatchedActivities.$inferSelect;
export type FieldDef = typeof fieldDefs.$inferSelect;
export type QualificationRule = typeof qualificationRules.$inferSelect;
export type SavedView = typeof savedViews.$inferSelect;
export type AccountRetentionRule = typeof accountRetentionRules.$inferSelect;
export type AccountClaim = typeof accountClaims.$inferSelect;
export type Industry = typeof industries.$inferSelect;
export type AccountRequest = typeof accountRequests.$inferSelect;

export const accountClaimsRelations = relations(accountClaims, ({ one }) => ({
  account: one(accounts, { fields: [accountClaims.accountId], references: [accounts.id] }),
  user: one(users, { fields: [accountClaims.userId], references: [users.id] }),
}));
