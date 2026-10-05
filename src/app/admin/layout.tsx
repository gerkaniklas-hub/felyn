import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "@/app/home/actions";
import { LogOutIcon } from "@/components/navigation/icons";
import { Logo } from "@/components/ui/logo";
import { requireStaff } from "@/lib/support/staff";

export const metadata: Metadata = {
  title: "Felyn Support",
  robots: { index: false, follow: false },
};

/**
 * The internal Felyn staff area. Non-staff (and signed-out — see proxy.ts) get a
 * plain 404, so its existence isn't revealed. This check is a convenience only:
 * layouts don't re-run on every navigation, so every admin page and every staff
 * Server Action checks again itself, and the database (0029) checks once more.
 *
 * A dedicated workspace: no links into the guest/host app, only "Log out" — the
 * same logout Server Action the app's navigation uses.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireStaff();

  return (
    <div className="flex min-h-dvh flex-1 flex-col">
      <header className="border-b border-ivory-300 bg-ivory-50">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Link href="/admin/support" aria-label="Felyn Support">
            <Logo size="md" />
          </Link>
          <span className="rounded-full bg-navy-900 px-3 py-1 text-xs font-medium text-ivory-50">Support</span>
          <form action={logout} className="ml-auto">
            <button
              type="submit"
              className="inline-flex h-9 items-center gap-2 rounded-full border border-ivory-300 px-4 text-sm font-medium text-navy-700 transition-colors hover:bg-ivory-200 hover:text-navy-950"
            >
              <LogOutIcon className="h-4 w-4" />
              Log out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
