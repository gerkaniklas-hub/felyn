import Link from "next/link";
import { ForgotPasswordForm } from "@/app/forgot-password/forgot-password-form";
import { Heading } from "@/components/ui/heading";
import { Logo } from "@/components/ui/logo";

/**
 * Host counterpart of /forgot-password: the same ForgotPasswordForm, framed
 * like /login/host, and its emailed link opens /host/reset-password so the
 * reset stays in the host journey. Public (see proxy.ts); the URL only
 * selects the experience — host access is decided from the database after
 * the reset (/host/apply).
 */
export default function HostForgotPasswordPage() {
  return (
    <div className="relative flex flex-1 flex-col bg-navy-950">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
        <Logo variant="reverse" size="lg" className="self-center" />
        <p className="text-center text-xs font-medium tracking-wide text-sky-300 uppercase">
          Felyn host
        </p>
        <div className="rounded-2xl border-t-4 border-gold-500 bg-ivory-50 p-6 shadow-xl">
          <Heading level={2} className="text-center">
            Reset your password
          </Heading>
          <p className="mt-2 text-center text-sm text-navy-500">We&apos;ll email you a link to set a new one.</p>
          <div className="mt-6">
            <ForgotPasswordForm resetPath="/host/reset-password" />
          </div>
        </div>
        <p className="text-center text-sm">
          <Link href="/login/host" className="font-medium text-ivory-50 underline-offset-4 hover:underline">
            Back to login
          </Link>
        </p>
      </div>
    </div>
  );
}
