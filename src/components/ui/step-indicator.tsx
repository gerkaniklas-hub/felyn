export function StepIndicator({ step, total }: { step: number; total: number }) {
  return (
    <p className="text-center text-xs font-medium tracking-wide text-navy-300">
      STEP {step} OF {total}
    </p>
  );
}
