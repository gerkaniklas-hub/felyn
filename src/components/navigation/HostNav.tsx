import Link from "next/link";
import { logout } from "@/app/home/actions";
import { Logo } from "@/components/ui/logo";

/**
 * Navigation for the host journey before approval (applying, pending,
 * rejected). Deliberately contains no guest links or guest notification
 * bell: the host application is its own experience, not a status inside
 * the guest app. Approved hosts use ProviderNav instead.
 */
export function HostNav() {
  return (
    <nav className="flex flex-wrap items-center justify-between gap-4 bg-navy-950 px-4 py-4 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
        <Link href="/become-a-host" aria-label="Felyn hosts">
          <Logo variant="reverse" size="sm" />
        </Link>
        <Link href="/host/application" className="text-sm font-medium text-sky-200 hover:text-ivory-50">
          Your application
        </Link>
      </div>
      <form action={logout}>
        <button type="submit" className="text-sm font-medium text-sky-200 hover:text-ivory-50">
          Log out
        </button>
      </form>
    </nav>
  );
}
