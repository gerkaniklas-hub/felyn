"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { logout } from "@/app/home/actions";
import { Logo } from "@/components/ui/logo";
import {
  CalendarCheckIcon,
  CalendarIcon,
  ChatIcon,
  DocumentIcon,
  GridIcon,
  HomeIcon,
  LogOutIcon,
  SearchIcon,
  SuitcaseIcon,
  UserIcon,
} from "./icons";

const ICONS = {
  home: HomeIcon,
  search: SearchIcon,
  chat: ChatIcon,
  suitcase: SuitcaseIcon,
  user: UserIcon,
  calendar: CalendarIcon,
  calendarCheck: CalendarCheckIcon,
  grid: GridIcon,
  document: DocumentIcon,
} satisfies Record<string, ComponentType<SVGProps<SVGSVGElement>>>;

export type NavIconName = keyof typeof ICONS;

export type SidebarItem = {
  href: string;
  label: string;
  icon: NavIconName;
  /** Path prefixes that also count as "inside" this item. Defaults to the item's own href and its sub-paths. */
  activePrefixes?: string[];
  /** Only the exact href counts as active (e.g. a dashboard whose sub-pages are separate items). */
  exact?: boolean;
};

function isActive(item: SidebarItem, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  const prefixes = item.activePrefixes ?? [item.href];
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * The shared app navigation for the guest, host-applicant and provider
 * journeys: a left sidebar on desktop (full width with labels), a narrow
 * icon rail on tablet, and a compact top bar with an icon tab row on phones.
 * Presentation only: each journey's nav component decides its own items,
 * routes and active rules, and logout is the same Server Action as before.
 *
 * `data-app-nav` lets globals.css offset the page content by the sidebar's
 * width, so no page needs its own layout change.
 */
export function AppSidebar({
  items,
  ariaLabel,
  logoHref,
  logoLabel,
  utilities,
}: {
  items: SidebarItem[];
  ariaLabel: string;
  /** Optional link target for the logo (only the host-applicant nav links it today). */
  logoHref?: string;
  logoLabel?: string;
  /** Extra controls next to the logout button, e.g. the guest notification bell. */
  utilities?: ReactNode;
}) {
  const pathname = usePathname();

  const fullLogo = <Logo size="md" />;
  const railLogo = (
    <span className="font-display text-2xl font-medium tracking-tight text-navy-950">
      F<span className="text-gold-500">.</span>
    </span>
  );

  const logoutForm = (compact: boolean) => (
    <form action={logout}>
      <button
        type="submit"
        aria-label="Log out"
        title="Log out"
        className={
          compact
            ? "inline-flex h-9 w-9 items-center justify-center rounded-full text-navy-500 hover:bg-ivory-200 hover:text-navy-900"
            : "flex h-10 w-full items-center justify-center gap-3 rounded-xl px-3 text-sm font-medium text-navy-500 transition-colors hover:bg-ivory-200 hover:text-navy-900 lg:justify-start"
        }
      >
        <LogOutIcon className="h-5 w-5 shrink-0" />
        {compact ? null : <span className="hidden lg:inline">Log out</span>}
      </button>
    </form>
  );

  const logoBlock = (content: ReactNode) =>
    logoHref ? (
      <Link href={logoHref} aria-label={logoLabel ?? "Felyn"}>
        {content}
      </Link>
    ) : (
      content
    );

  return (
    <div data-app-nav="">
      {/* Tablet rail + desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-20 flex-col border-r border-ivory-300 bg-ivory-50 px-3 py-7 md:flex lg:w-64 lg:px-5">
        <div className="flex justify-center px-0 lg:justify-start lg:px-3">
          <span className="hidden lg:inline">{logoBlock(fullLogo)}</span>
          <span className="lg:hidden">{logoBlock(railLogo)}</span>
        </div>

        <nav aria-label={ariaLabel} className="mt-10 flex flex-col gap-1.5">
          {items.map((item) => {
            const Icon = ICONS[item.icon];
            const active = isActive(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                aria-current={active ? "page" : undefined}
                className={`flex h-11 items-center justify-center gap-3 rounded-xl px-3 text-[15px] font-medium transition-colors lg:justify-start ${
                  active ? "bg-sky-50 text-sky-700" : "text-navy-600 hover:bg-ivory-200 hover:text-navy-950"
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className="sr-only lg:not-sr-only">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col items-center gap-1.5 border-t border-ivory-300 pt-4 lg:items-stretch">
          {utilities}
          {logoutForm(false)}
        </div>
      </aside>

      {/* Phone: compact top bar + icon tab row */}
      <header className="sticky top-0 z-30 border-b border-ivory-300 bg-ivory-50/95 backdrop-blur md:hidden">
        <div className="flex items-center justify-between px-4 pt-3">
          {logoBlock(<Logo size="sm" />)}
          <div className="flex items-center gap-1">
            {utilities}
            {logoutForm(true)}
          </div>
        </div>
        <nav aria-label={ariaLabel} className={`flex justify-around pt-1 pb-2 ${items.length > 5 ? "px-1" : "gap-1 px-2"}`}>
          {items.map((item) => {
            const Icon = ICONS[item.icon];
            const active = isActive(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-w-0 flex-col items-center gap-0.5 rounded-xl py-1.5 font-medium transition-colors ${
                  items.length > 5 ? "flex-auto px-0.5 text-[10px] tracking-tight" : "flex-1 px-1 text-[11px]"
                } ${
                  active ? "bg-sky-50 text-sky-700" : "text-navy-500 hover:text-navy-900"
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </header>
    </div>
  );
}
