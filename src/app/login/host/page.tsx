import Link from "next/link";
import { Heading } from "@/components/ui/heading";
import { Logo } from "@/components/ui/logo";
import { RETURN_TO_PARAM, safeReturnTo } from "@/lib/return-to";
import { LoginForm } from "../login-form";

/**
 * P0.5: the host entry point into the SAME Supabase Auth email/password
 * flow the guest login uses (see LoginForm's `redirectTo` prop) — only the
 * surrounding page (copy, redirect target, colour treatment) differs.
 * Entering here selects the HOST journey (proxy.ts / src/lib/journey.ts).
 * Every host login lands on /host/apply, which routes from the DATABASE:
 * an approved host (providers row) -> /provider, an applicant ->
 * /host/application, anyone else -> the application form. The journey
 * itself grants nothing.
 */
export default async function HostLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const returnTo = safeReturnTo((await searchParams)[RETURN_TO_PARAM], "host");
  return (
    <div className="relative flex flex-1 flex-col bg-navy-950">
      <Link
        href="/login"
        prefetch={false}
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
            Log in to manage your experiences or check your host application.
          </p>
          <div className="mt-6">
            <LoginForm redirectTo="/host/apply" returnTo={returnTo} forgotPasswordHref="/host/forgot-password" />
          </div>
        </div>
        <p className="text-center text-sm text-sky-300">
          New to hosting?{" "}
          <Link href="/signup?intent=host" className="font-medium text-ivory-50 underline-offset-4 hover:underline">
            Create a host account
          </Link>{" "}
          or{" "}
          <Link href="/become-a-host" className="font-medium text-ivory-50 underline-offset-4 hover:underline">
            learn how hosting works
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
