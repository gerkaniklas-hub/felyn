"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/app/home/actions";
import { Logo } from "@/components/ui/logo";

const LINKS = [
  { href: "/provider", label: "Dashboard" },
  { href: "/provider/experiences", label: "Experiences" },
  { href: "/provider/calendar", label: "Calendar" },
  { href: "/provider/requests", label: "Requests" },
  { href: "/provider/messages", label: "Messages" },
  { href: "/provider/profile", label: "Profile" },
];

/**
 * P1: the provider area's top bar — a deliberately subtle carry-over of
 * P0.5's host navy/sky/gold treatment (a dark bar, not a whole dark app),
 * so the space still unmistakably reads as Felyn rather than a generic
 * admin console.
 */
export function ProviderNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap items-center justify-between gap-4 bg-navy-950 px-4 py-4 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
        <Logo variant="reverse" size="sm" />
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {LINKS.map((link) => {
            const active = link.href === "/provider" ? pathname === link.href : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`text-sm font-medium transition-colors ${
                  active ? "text-gold-400" : "text-sky-200 hover:text-ivory-50"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </div>
      <form action={logout}>
        <button type="submit" className="text-sm font-medium text-sky-200 hover:text-ivory-50">
          Log out
        </button>
      </form>
    </nav>
  );
}
