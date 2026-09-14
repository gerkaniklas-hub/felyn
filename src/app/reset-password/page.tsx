import { Suspense } from "react";
import { ResetPasswordContent } from "./reset-password-content";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordContent />
    </Suspense>
  );
}
