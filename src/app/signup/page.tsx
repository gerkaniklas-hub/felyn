import Link from "next/link";
import { Heading } from "@/components/ui/heading";
import { Logo } from "@/components/ui/logo";
import { SignupForm } from "./signup-form";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ intent?: string }>;
}) {
  // `intent=host` only changes copy and where the confirmation link lands.
  const hostIntent = (await searchParams).intent === "host";

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
      <Logo size="lg" className="self-center" />
      <div className="flex flex-col gap-2 text-center">
        <Heading level={1}>
          {hostIntent ? "Create your account to apply as a host." : "Make more of the time together."}
        </Heading>
        {hostIntent && (
          <p className="text-sm text-navy-500">
            One Felyn account works for both booking and hosting. After confirming your email, you&apos;ll continue
            straight to your host application.
          </p>
        )}
      </div>
      <SignupForm hostIntent={hostIntent} />
      <p className="text-center text-sm text-navy-500">
        Already have an account?{" "}
        <Link href={hostIntent ? "/login/host" : "/login"} className="font-medium text-sky-600 hover:text-sky-700">
          Log in
        </Link>
      </p>
    </div>
  );
}
