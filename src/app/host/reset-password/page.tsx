import { Suspense } from "react";
import { ResetPasswordContent } from "@/app/reset-password/reset-password-content";
import { Logo } from "@/components/ui/logo";

/**
 * Host counterpart of /reset-password: the same ResetPasswordContent
 * (Continue -> verifyOtp, legacy ?code=, same_password), framed like
 * /login/host. journey="host" only makes a successful reset continue to
 * /host/apply, which decides from the database where this account belongs.
 * Public (see proxy.ts) so a signed-out host can open the emailed link.
 */
export default function HostResetPasswordPage() {
  return (
    <div className="relative flex flex-1 flex-col bg-navy-950">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
        <Logo variant="reverse" size="lg" className="self-center" />
        <p className="text-center text-xs font-medium tracking-wide text-sky-300 uppercase">
          Felyn host
        </p>
        <div className="flex rounded-2xl border-t-4 border-gold-500 bg-ivory-50 shadow-xl">
          <Suspense fallback={null}>
            <ResetPasswordContent journey="host" />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
