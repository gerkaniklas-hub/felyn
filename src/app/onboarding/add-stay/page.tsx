import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Heading } from "@/components/ui/heading";
import { StepIndicator } from "@/components/ui/step-indicator";

export default function AddStayPage() {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
      <StepIndicator step={1} total={7} />
      <Heading level={2} className="text-center">
        Let&apos;s add your stay
      </Heading>

      <div className="flex flex-col gap-3">
        <div className="flex cursor-not-allowed items-center justify-between rounded-xl border border-ivory-300 bg-ivory-50 px-5 py-4 opacity-50">
          <span className="font-medium text-navy-700">Import booking</span>
          <Badge tone="navy">Coming soon</Badge>
        </div>
        <div className="flex cursor-not-allowed items-center justify-between rounded-xl border border-ivory-300 bg-ivory-50 px-5 py-4 opacity-50">
          <span className="font-medium text-navy-700">Upload booking confirmation</span>
          <Badge tone="navy">Coming soon</Badge>
        </div>
        <Link
          href="/onboarding/add-stay/manual"
          className="flex items-center justify-between rounded-xl border border-navy-900 bg-navy-900 px-5 py-4 font-medium text-ivory-50 transition-colors hover:bg-navy-950"
        >
          Enter manually
          <span aria-hidden>→</span>
        </Link>
      </div>
    </div>
  );
}
