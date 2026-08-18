import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  BarChart3,
  Building2,
  ClipboardCheck,
  Inbox,
  LayoutDashboard,
  PhoneCall,
  Settings,
  Users,
  ShieldCheck,
} from "lucide-react";

/**
 * The navigation, as data.
 *
 * Kept out of the component so the shell, the command palette and the mobile
 * drawer all show the same list. Three copies of a nav is how one of them ends
 * up missing the screen somebody actually needed.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Roles allowed to see it. Omitted means everyone. */
  roles?: string[];
  /** Which key on the counts object lights up the badge. */
  badge?: "expiring" | "unlogged" | "review" | "requests";
  /** Shown in the command palette to make the item findable by intent. */
  keywords?: string;
}

export interface NavSection {
  heading: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    heading: "Sell",
    items: [
      {
        href: "/",
        label: "Dashboard",
        icon: LayoutDashboard,
        keywords: "home overview today numbers",
      },
      /*
       * The two primary tabs, in the order Alex named them.
       *
       * Prospects is the whole book -- every company in the business, taken or
       * not, customer or not -- and it absorbed both the available pool and the
       * old company directory. Three separate screens that each answered part
       * of "is this company already somebody's" meant the answer depended on
       * which one you happened to open, and the one people opened was whichever
       * came first in this list.
       */
      {
        href: "/prospects",
        label: "Prospects",
        icon: Building2,
        keywords: "companies search every account available unclaimed taken held owner directory pool",
      },
      {
        href: "/customers",
        label: "Your customers",
        icon: BookOpen,
        keywords: "customers converted won accounts mine",
      },
      {
        // The working list: the clock, the columns, the presets. Kept because
        // it answers a different question -- "what do I have to do today" --
        // and neither of the two tabs above is sorted for that.
        href: "/accounts",
        label: "My book",
        icon: Inbox,
        badge: "expiring",
        keywords: "my accounts book clock expiring at risk urgent columns presets",
      },
      {
        href: "/contacts",
        label: "Contacts",
        icon: Users,
        keywords: "people phone email decision maker",
      },
      {
        href: "/activity",
        label: "Activity",
        icon: PhoneCall,
        badge: "unlogged",
        keywords: "calls emails log history timeline",
      },
    ],
  },
  {
    heading: "Manage",
    items: [
      {
        href: "/review",
        label: "Review queue",
        icon: ClipboardCheck,
        badge: "review",
        keywords: "unmatched ambiguous calls resolve",
      },
      {
        href: "/requests",
        label: "Account requests",
        icon: ShieldCheck,
        badge: "requests",
        keywords: "amnesty extension approval exception",
      },
      {
        href: "/reports",
        label: "Reports",
        icon: BarChart3,
        keywords: "analytics leaderboard pipeline industry",
      },
      {
        href: "/admin/users",
        label: "People",
        icon: Users,
        roles: ["admin"],
        keywords: "users staff roles permissions accounts logins add new starter leaver",
      },
      {
        href: "/admin/integrations",
        label: "Phone connection",
        icon: PhoneCall,
        roles: ["admin"],
        keywords: "ringcentral phone calls webhook subscription integration connected logging",
      },
      {
        href: "/admin",
        label: "Admin",
        icon: Settings,
        roles: ["admin"],
        keywords: "settings rules fields thresholds integrations email",
      },
    ],
  },
];

export function visibleNav(role: string): NavSection[] {
  return NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.roles || item.roles.includes(role)),
  })).filter((section) => section.items.length > 0);
}

/** Flattened, for the command palette. */
export function allNavItems(role: string): NavItem[] {
  return visibleNav(role).flatMap((s) => s.items);
}
