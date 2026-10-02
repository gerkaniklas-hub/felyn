"use client";

import type { ReactNode } from "react";
import { AppSidebar, type SidebarItem } from "./AppSidebar";

/**
 * The guest journey's navigation (rendered through the shared AppSidebar).
 *
 * Five destinations: Home (/home, the welcome screen after login), Explore,
 * Messages, Trips (/trips: the guest's stays and their requested
 * experiences, previously the /home dashboard) and Profile.
 */
const LINKS: SidebarItem[] = [
  { href: "/home", label: "Home", icon: "home" },
  { href: "/explore", label: "Explore", icon: "search" },
  { href: "/messages", label: "Messages", icon: "chat" },
  // Trips also covers the pages reached FROM it: a stay's overview, its
  // planner, and a booking's own detail page.
  { href: "/trips", label: "Trips", icon: "suitcase", activePrefixes: ["/trips", "/stays", "/recommendations", "/experiences"] },
  { href: "/profile", label: "Profile", icon: "user" },
];

/**
 * `notifications` is passed in by each page (a Server Component) rather
 * than imported here — NotificationBell is itself a Server Component
 * (it reads cookies directly), and a "use client" module can never import
 * one, only receive it as a prop/child from a server-rendered ancestor.
 */
export function GuestNav({ notifications }: { notifications?: ReactNode }) {
  return <AppSidebar items={LINKS} ariaLabel="Main" utilities={notifications} />;
}
