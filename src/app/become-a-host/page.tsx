import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "@/app/home/actions";
import { Heading } from "@/components/ui/heading";
import { Logo } from "@/components/ui/logo";
import { getHostAccess } from "@/lib/host-application/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata = {
  title: "Become a host · Felyn",
  description: "Apply to share your experience with guests staying in holiday homes. Every application is reviewed by the Felyn team.",
};

const primaryLink =
  "inline-flex h-12 items-center justify-center rounded-full bg-navy-900 px-7 text-base font-medium text-ivory-50 transition-colors hover:bg-navy-950";
const secondaryLink =
  "inline-flex h-12 items-center justify-center rounded-full border border-navy-300 px-7 text-base font-medium text-navy-900 transition-colors hover:bg-ivory-200";

const STEPS = [
  {
    number: "01",
    title: "Apply",
    text: "Tell us about yourself, where you would host, and the experience you'd love to share with guests.",
  },
  {
    number: "02",
    title: "We review it personally",
    text: "A member of the Felyn team reads every application. We may get in touch to learn a little more.",
  },
  {
    number: "03",
    title: "Share your experience",
    text: "Once approved, your host space opens and you can start setting up your experience for guests.",
  },
];

/**
 * Public landing point for "Become a Host" (linked from felyn.eu/hosts).
 * The call to action adapts to the visitor's real, server-read status:
 * signed out -> sign up / log in with host intent; signed in -> apply,
 * view the application, or open the host space.
 */
export default async function BecomeAHostPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const access = user ? await getHostAccess(supabase, user.id) : null;

  let actions: ReactNode;
  if (!user) {
    actions = (
      <>
        <Link href="/signup?intent=host" className={primaryLink}>
          Create an account to apply
        </Link>
        <Link href="/login/host" className={secondaryLink}>
          I already have a Felyn account
        </Link>
      </>
    );
  } else if (access?.providerId) {
    actions = (
      <Link href="/provider" className={primaryLink}>
        Go to your host space
      </Link>
    );
  } else if (access?.application) {
    actions = (
      <Link href="/host/application" className={primaryLink}>
        View your application
      </Link>
    );
  } else {
    actions = (
      <Link href="/host/apply" className={primaryLink}>
        Start your application
      </Link>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-ivory-300 bg-ivory-50 px-4 py-4 sm:px-6 lg:px-8">
        <a href="https://felyn.eu" aria-label="Felyn home">
          <Logo size="sm" />
        </a>
        {user ? (
          // Host journey: no guest links here (see src/lib/journey.ts).
          <form action={logout}>
            <button type="submit" className="text-sm font-medium text-navy-600 hover:text-navy-950">
              Log out
            </button>
          </form>
        ) : (
          <Link href="/login/host" className="text-sm font-medium text-navy-600 hover:text-navy-950">
            Log in
          </Link>
        )}
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-14 px-4 py-14 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-5">
          <p className="text-xs font-medium tracking-wide text-gold-700">BECOME A FELYN HOST</p>
          <Heading level={1} className="max-w-2xl">
            Share what you love. Create something memorable.
          </Heading>
          <p className="max-w-2xl text-lg text-navy-600">
            Felyn connects guests staying in holiday homes with people who create special experiences — private dinners,
            cooking together, tastings and relaxed gatherings. If you have something to share, we&apos;d love to hear
            from you.
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">{actions}</div>
          {!user && (
            <p className="text-sm text-navy-500">
              Already a guest with Felyn? Use the same account — there&apos;s no need to create a new one.
            </p>
          )}
        </section>

        <section className="flex flex-col gap-8">
          <Heading level={2}>How becoming a host works</Heading>
          <ol className="grid grid-cols-1 gap-8 sm:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.number} className="flex flex-col gap-3 border-t border-ivory-400 pt-5">
                <span className="font-display text-4xl text-gold-600">{step.number}</span>
                <Heading level={3}>{step.title}</Heading>
                <p className="text-navy-600">{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="rounded-2xl bg-navy-950 px-6 py-10 text-ivory-50 sm:px-10">
          <p className="text-xs font-medium tracking-wide text-gold-400">GOOD EXPERIENCES START WITH TRUST</p>
          <p className="mt-3 max-w-2xl font-display text-2xl leading-snug">
            Host approval is required, and every application is reviewed by hand.
          </p>
          <p className="mt-4 max-w-2xl text-sky-100">
            Submitting an application doesn&apos;t guarantee approval, and you won&apos;t be able to publish experiences
            until your application has been approved. We keep the process personal so guests can trust the people they
            meet through Felyn.
          </p>
        </section>
      </main>
    </div>
  );
}
