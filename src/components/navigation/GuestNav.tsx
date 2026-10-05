"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppSidebar, type SidebarItem } from "./AppSidebar";
import { HelpIcon } from "./icons";

/**
 * The guest journey's navigation (rendered through the shared AppSidebar).
 *
 * - Home (/home): the welcome screen after login.
 * - Explore: discovering experiences.
 * - Trips (/trips): the guest's stays; each opens its trip planner.
 * - Experiences (/experiences): every requested/booked experience, with or
 *   without a trip; each opens its booking detail (/bookings/<id>).
 * - Messages, Profile.
 *
 * Help (/help: Contact Felyn) sits with the utilities next to the notification
 * bell rather than as another tab, so the phone tab row stays readable.
 */
const LINKS: SidebarItem[] = [
  { href: "/home", label: "Home", icon: "home" },
  { href: "/explore", label: "Explore", icon: "search" },
  // Trips also covers the pages reached from a trip: its overview and its planner.
  { href: "/trips", label: "Trips", icon: "suitcase", activePrefixes: ["/trips", "/stays", "/recommendations"] },
  // Experiences also covers each booking's own detail page.
  { href: "/experiences", label: "Experiences", icon: "calendarCheck", activePrefixes: ["/experiences", "/bookings"] },
  { href: "/messages", label: "Messages", icon: "chat" },
  { href: "/profile", label: "Profile", icon: "user" },
];

/**
 * `notifications` is passed in by each page (a Server Component) rather
 * than imported here — NotificationBell is itself a Server Component
 * (it reads cookies directly), and a "use client" module can never import
 * one, only receive it as a prop/child from a server-rendered ancestor.
 */
export function GuestNav({ notifications }: { notifications?: ReactNode }) {
  return (
    <AppSidebar
      items={LINKS}
      ariaLabel="Main"
      utilities={
        <>
          <HelpLink />
          {notifications}
        </>
      }
    />
  );
}

/** Styled like the notification bell button, so the two utilities read as a pair. */
function HelpLink() {
  const active = usePathname() === "/help";
  return (
    <Link
      href="/help"
      aria-label="Help"
      title="Help"
      aria-current={active ? "page" : undefined}
      className={`inline-flex h-9 w-9 items-center justify-center gap-3 rounded-full transition-colors md:h-10 md:rounded-xl lg:w-full lg:justify-start lg:px-3 lg:text-sm lg:font-medium ${
        active ? "bg-sky-50 text-sky-700" : "text-navy-500 hover:bg-ivory-200 hover:text-navy-900"
      }`}
    >
      <HelpIcon className="h-5 w-5 shrink-0" />
      <span className="hidden lg:inline">Help</span>
    </Link>
  );
}
