import Link from "next/link";
import { Logo } from "@/components/ui/logo";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <Logo size="lg" />
      <p className="max-w-xs text-base text-navy-700">
        Make more of the time together.
      </p>
      <div className="mt-6 flex gap-3">
        <Link
          href="/login"
          className="inline-flex h-11 items-center justify-center rounded-full bg-navy-900 px-6 text-base font-medium text-ivory-50 hover:bg-navy-950"
        >
          Log in
        </Link>
        <Link
          href="/signup"
          className="inline-flex h-11 items-center justify-center rounded-full border border-navy-300 px-6 text-base font-medium text-navy-900 hover:bg-ivory-200"
        >
          Create account
        </Link>
      </div>
    </div>
  );
}
