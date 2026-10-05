"use client";

import type { ReactNode } from "react";
import { AppSidebar, type SidebarItem } from "./AppSidebar";
import { HelpLink } from "./HelpLink";

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
          <HelpLink href="/help" />
          {notifications}
        </>
      }
    />
  );
}
