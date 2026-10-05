"use client";

import { AppSidebar, type SidebarItem } from "@/components/navigation/AppSidebar";
import { HelpLink } from "@/components/navigation/HelpLink";

const LINKS: SidebarItem[] = [
  { href: "/provider", label: "Dashboard", icon: "home", exact: true },
  { href: "/provider/experiences", label: "Experiences", icon: "grid" },
  { href: "/provider/calendar", label: "Calendar", icon: "calendar" },
  { href: "/provider/requests", label: "Requests", icon: "calendarCheck" },
  { href: "/provider/messages", label: "Messages", icon: "chat" },
  { href: "/provider/profile", label: "Profile", icon: "user" },
];

/**
 * The provider (approved host) navigation — same items, routes and order as
 * before, now rendered through the shared AppSidebar so hosts and guests
 * share one navigation layout and icon language. Help (Contact Felyn, /provider/help)
 * sits next to Log out rather than as a 7th item.
 */
export function ProviderNav() {
  return <AppSidebar items={LINKS} ariaLabel="Host" utilities={<HelpLink href="/provider/help" />} />;
}
