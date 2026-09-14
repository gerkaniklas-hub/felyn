import Link from "next/link";
import { Heading } from "@/components/ui/heading";
import { Logo } from "@/components/ui/logo";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
      <Logo size="lg" className="self-center" />
      <Heading level={2} className="text-center">
        Welcome back
      </Heading>
      <LoginForm />
      <p className="text-center text-sm text-navy-500">
        New to Felyn?{" "}
        <Link href="/signup" className="font-medium text-sky-600 hover:text-sky-700">
          Create new account
        </Link>
      </p>
    </div>
  );
}
