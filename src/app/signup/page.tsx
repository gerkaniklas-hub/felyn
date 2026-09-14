import Link from "next/link";
import { Heading } from "@/components/ui/heading";
import { Logo } from "@/components/ui/logo";
import { SignupForm } from "./signup-form";

export default function SignupPage() {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
      <Logo size="lg" className="self-center" />
      <Heading level={1} className="text-center">
        Make more of the time together.
      </Heading>
      <SignupForm />
      <p className="text-center text-sm text-navy-500">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-sky-600 hover:text-sky-700">
          Log in
        </Link>
      </p>
    </div>
  );
}
