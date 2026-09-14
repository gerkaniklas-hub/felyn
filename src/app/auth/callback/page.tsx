import { Suspense } from "react";
import { CallbackContent } from "./callback-content";

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackContent />
    </Suspense>
  );
}
