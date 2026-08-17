/**
 * Roles, as the application talks about them.
 *
 * A plain module rather than part of the actions file: a "use server" module
 * may only export async functions, and a constant living there fails the build
 * at page-collection time, long after the code looks correct.
 *
 * The keys here are the four the database's CHECK constraint accepts. Adding a
 * fifth means a migration, not an edit to this list -- which is the right way
 * round, because row level security is written in terms of these names and a
 * role the policies have never heard of is a role that can see nothing.
 */

export interface RoleDefinition {
  key: string;
  label: string;
  summary: string;
  /** Shown on the picker, so the consequence of the choice is visible. */
  scope: string;
}

export const ROLES: RoleDefinition[] = [
  {
    key: "broker",
    label: "Broker",
    summary: "Holds a book of prospects and customers.",
    scope: "Sees their own accounts and nobody else's.",
  },
  {
    key: "manager",
    label: "Manager",
    // Managers hold a book of their own. Describing the role only by what it
    // oversees made it read as a supervisory position with no accounts, which
    // is not the job.
    summary: "Holds their own book, and additionally oversees everyone reporting to them.",
    scope:
      "Their own accounts, plus the accounts of everyone who reports to them, however many levels down.",
  },
  {
    key: "ad",
    label: "Account Director",
    summary: "Opens national accounts and co-owns them with the broker running them.",
    scope:
      "Sees their own book, the national accounts they co-own, and anyone reporting to them. Does not decide other people's requests.",
  },
  {
    key: "credit",
    label: "Customer Credit",
    summary: "Owns credit limits and the duplicate queue. Holds no book.",
    scope: "Sees every account in the company.",
  },
  {
    key: "admin",
    label: "Admin",
    summary: "Everything, including the rules the company runs on.",
    scope: "Sees everything, and can change the clock, the qualification rules and users.",
  },
];

export const ROLE_LABEL: Record<string, string> = Object.fromEntries(
  ROLES.map((r) => [r.key, r.label]),
);

/** Tailwind classes for a role badge. Admin is the only one that shouts. */
export const ROLE_BADGE: Record<string, string> = {
  broker: "border-border bg-muted text-muted-foreground",
  ad: "border-electric-400/60 bg-electric-100 text-electric-900 dark:border-electric-700 dark:bg-electric-950/70 dark:text-electric-200",
  manager: "border-electric-300/60 bg-electric-50 text-electric-800 dark:border-electric-800 dark:bg-electric-950/60 dark:text-electric-200",
  credit: "border-amber-300/70 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
  admin: "border-brand-400/70 bg-brand-50 text-brand-900 dark:border-brand-700 dark:bg-brand-950/60 dark:text-brand-200",
};

export interface NewUser {
  email: string;
  full_name: string;
  role: string;
  manager_id?: string;
  location?: string;
  title?: string;
  phone?: string;
  start_date?: string;
  prospect_limit?: number | null;
  rc_extension_id?: string;
  create_login: boolean;
  /** Blank means one is generated and shown once. */
  password?: string;
}

export interface UserPatch {
  full_name?: string;
  email?: string;
  title?: string;
  phone?: string;
  location?: string;
  start_date?: string;
  prospect_limit?: number | null;
  manager_id?: string;
  rc_extension_id?: string;
  notes?: string;
}

/** One row of the user list, as admin_users() returns it. */
export interface AdminUser {
  id: string;
  email: string;
  full_name: string;
  role: string;
  title: string | null;
  location: string | null;
  phone: string | null;
  start_date: string | null;
  prospect_limit: number | null;
  active: boolean;
  deactivated_at: string | null;
  manager_id: string | null;
  manager_name: string | null;
  has_login: boolean;
  accounts_held: number;
  calls_30d: number;
  created_at: string;
  total_rows: number;
}

export interface Capability {
  capability: string;
  area: string;
  broker: boolean;
  manager: boolean;
  ad: boolean;
  credit: boolean;
  admin: boolean;
  detail: string;
}
