"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HelpIcon } from "./icons";

/**
 * Help (Contact Felyn) in the navigation utilities, next to Log out — shared by the
 * guest (/help) and host (/provider/help) navigation so it isn't another tab. Styled
 * like the notification bell button, so the utilities read as a set.
 */
export function HelpLink({ href }: { href: string }) {
  const active = usePathname() === href;
  return (
    <Link
      href={href}
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
