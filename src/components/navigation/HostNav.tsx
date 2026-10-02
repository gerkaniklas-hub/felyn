"use client";

import { AppSidebar, type SidebarItem } from "./AppSidebar";

const LINKS: SidebarItem[] = [{ href: "/host/application", label: "Your application", icon: "document" }];

/**
 * Navigation for the host journey before approval (applying, pending,
 * rejected). Deliberately contains no guest links or guest notification
 * bell: the host application is its own experience, not a status inside
 * the guest app. Approved hosts use ProviderNav instead.
 */
export function HostNav() {
  return <AppSidebar items={LINKS} ariaLabel="Host" logoHref="/become-a-host" logoLabel="Felyn hosts" />;
}
