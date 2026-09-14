import { Suspense } from "react";
import { CheckEmailContent } from "./check-email-content";

export default function CheckEmailPage() {
  return (
    <Suspense fallback={null}>
      <CheckEmailContent />
    </Suspense>
  );
}
