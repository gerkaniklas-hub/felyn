import Link from "next/link";
import { Heading } from "@/components/ui/heading";
import { ForgotPasswordForm } from "./forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
      <div className="flex flex-col gap-1 text-center">
        <Heading level={2}>Reset your password</Heading>
        <p className="text-sm text-navy-500">
          We&apos;ll email you a link to set a new one.
        </p>
      </div>
      <ForgotPasswordForm />
      <p className="text-center text-sm text-navy-500">
        <Link href="/login" className="font-medium text-sky-600 hover:text-sky-700">
          Back to login
        </Link>
      </p>
    </div>
  );
}
