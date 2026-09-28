"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { logout } from "@/app/home/actions";
import { Logo } from "@/components/ui/logo";

/**
 * Task 1: a persistent guest nav bar — none existed before (every guest
 * page rendered its own ad hoc "← Home" link).
 *
 * Phase 3 of the consolidated improvements: "My Trips" is now the first,
 * primary destination — the existing /home stays dashboard (stay overview,
 * dates, planned/requested/confirmed experiences via the existing
 * StayPlanner) rather than a new page. /experiences (the flat cross-stay
 * booking-history list) is no longer a top-level nav item — it's still a
 * real route, reached as a secondary destination from within My Trips (see
 * home/page.tsx), not removed.
 */
const LINKS = [
  { href: "/home", label: "My Trips" },
  { href: "/explore", label: "Explore" },
  { href: "/messages", label: "Messages" },
  { href: "/profile", label: "Profile" },
];

/** "My Trips" also covers the routes reached FROM it (a stay's own overview, its planner) — a guest is still conceptually inside My Trips there, not somewhere new. */
const MY_TRIPS_PREFIXES = ["/home", "/stays", "/recommendations"];

/**
 * `notifications` is passed in by each page (a Server Component) rather
 * than imported here — NotificationBell is itself a Server Component
 * (it reads cookies directly), and a "use client" module can never import
 * one, only receive it as a prop/child from a server-rendered ancestor.
 */
export function GuestNav({ notifications }: { notifications?: ReactNode }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap items-center justify-between gap-4 border-b border-ivory-300 bg-ivory-50 px-4 py-4 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
        <Logo size="sm" />
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {LINKS.map((link) => {
            const active =
              link.href === "/home"
                ? MY_TRIPS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
                : pathname === link.href || pathname.startsWith(`${link.href}/`);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`text-sm font-medium transition-colors ${
                  active ? "text-sky-700" : "text-navy-600 hover:text-navy-950"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-4">
        {notifications}
        <form action={logout}>
          <button type="submit" className="text-sm font-medium text-navy-500 hover:text-navy-900">
            Log out
          </button>
        </form>
      </div>
    </nav>
  );
}
