import { Logo } from "@/components/ui/logo";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <Logo size="lg" />
      <p className="max-w-xs text-base text-navy-700">
        Make more of the time together.
      </p>
      <p className="mt-8 text-xs text-navy-300">
        Design system ready — product screens come next.
      </p>
    </div>
  );
}
