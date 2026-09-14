import Link from "next/link";
import { Heading } from "@/components/ui/heading";

export default function CheckEmailPage() {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <Heading level={2}>Check your email</Heading>
      <p className="text-navy-600">
        We&apos;ve sent a confirmation link to your email address. Click it to
        activate your account, then log in.
      </p>
      <Link href="/login" className="text-sm font-medium text-sky-600 hover:text-sky-700">
        Back to login
      </Link>
    </div>
  );
}
