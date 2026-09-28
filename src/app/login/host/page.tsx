import Link from "next/link";
import { Heading } from "@/components/ui/heading";
import { Logo } from "@/components/ui/logo";
import { LoginForm } from "../login-form";

/**
 * P0.5: the host entry point into the SAME Supabase Auth email/password
 * flow the guest login uses (see LoginForm's `redirectTo` prop) — only the
 * surrounding page (copy, redirect target, colour treatment) differs.
 * Deliberately no registration here yet; /provider itself is what decides
 * whether a signed-in user actually has a provider profile.
 */
export default function HostLoginPage() {
  return (
    <div className="relative flex flex-1 flex-col bg-navy-950">
      <Link
        href="/login"
        className="absolute top-6 right-6 text-sm font-medium text-sky-300 hover:text-sky-200"
      >
        I&apos;m a guest →
      </Link>
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
        <Logo variant="reverse" size="lg" className="self-center" />
        <p className="text-center text-xs font-medium tracking-wide text-sky-300 uppercase">
          Felyn host
        </p>
        <div className="rounded-2xl border-t-4 border-gold-500 bg-ivory-50 p-6 shadow-xl">
          <Heading level={2} className="text-center">
            Welcome back, host
          </Heading>
          <p className="mt-2 text-center text-sm text-navy-500">
            Log in to manage your Felyn experiences.
          </p>
          <div className="mt-6">
            <LoginForm redirectTo="/provider" />
          </div>
        </div>
        <p className="text-center text-sm text-sky-300">Host registration is coming soon.</p>
      </div>
    </div>
  );
}
