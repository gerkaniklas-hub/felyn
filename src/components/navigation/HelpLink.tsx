"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HelpIcon } from "./icons";
import { navUtilityClass, type NavTone } from "./nav-styles";

/**
 * Help (Contact Felyn) in the navigation utilities, next to Log out — shared by the
 * guest (/help) and host (/provider/help) navigation so it isn't another tab. Styled
 * like the notification bell button, so the utilities read as a set.
 */
export function HelpLink({ href, tone = "light" }: { href: string; tone?: NavTone }) {
  const active = usePathname() === href;
  return (
    <Link
      href={href}
      aria-label="Help"
      title="Help"
      aria-current={active ? "page" : undefined}
      className={navUtilityClass(active, tone)}
    >
      <HelpIcon className="h-5 w-5 shrink-0" />
      <span className="hidden lg:inline">Help</span>
    </Link>
  );
}
