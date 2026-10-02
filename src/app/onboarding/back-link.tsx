"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon } from "@/components/navigation/icons";

/**
 * "← Back / Add a stay" above the Add a stay pages: goes back to wherever
 * the guest came from (Home, Trips, …), or to `fallbackHref` when the page
 * was opened directly.
 */
export function OnboardingBackLink({ fallbackHref }: { fallbackHref: string }) {
  const router = useRouter();
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-navy-500">
      <Link
        href={fallbackHref}
        onClick={(event) => {
          if (window.history.length > 1) {
            event.preventDefault();
            router.back();
          }
        }}
        className="inline-flex items-center gap-1.5 font-medium text-navy-700 hover:text-navy-950"
      >
        <ArrowLeftIcon className="h-4 w-4" />
        Back
      </Link>
      <span aria-hidden="true" className="text-navy-300">
        /
      </span>
      <span>Add a stay</span>
    </nav>
  );
}
