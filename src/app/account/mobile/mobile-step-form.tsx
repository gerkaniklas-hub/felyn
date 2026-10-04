"use client";

import { useActionState, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { PhoneInput } from "@/components/ui/phone-input";
import { completeMobileStep, type ContactPhoneFormState } from "@/lib/contact/actions";
import { validatePhone } from "@/lib/phone";

type FieldError = { error: string; field: "country" | "number" };

/** `destination` is bound into the Server Action, which re-checks it against the allow-list. */
export function MobileStepForm({
  destination,
  defaultCountry,
  defaultNumber,
  initialError,
}: {
  destination: string;
  defaultCountry: string;
  defaultNumber: string;
  initialError?: string;
}) {
  const [state, formAction, isPending] = useActionState(
    completeMobileStep.bind(null, destination),
    (initialError ? { error: initialError, errorField: "number" } : {}) satisfies ContactPhoneFormState,
  );
  const [clientError, setClientError] = useState<FieldError | null>(null);
  const [edited, setEdited] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const formData = new FormData(event.currentTarget);
    const result = validatePhone(String(formData.get("phoneCountry") ?? ""), String(formData.get("phoneNumber") ?? ""));
    if (!result.ok) {
      event.preventDefault();
      setClientError({ error: result.error, field: result.field });
      return;
    }
    setClientError(null);
    setEdited(false);
  }

  const serverError = !edited && state.error ? { error: state.error, field: state.errorField ?? "number" } : null;
  const error = clientError ?? serverError;

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <PhoneInput
        defaultCountry={defaultCountry}
        defaultNumber={defaultNumber}
        required
        error={error?.error}
        errorField={error?.field}
        onChange={() => {
          setClientError(null);
          setEdited(true);
        }}
      />
      <Button type="submit" disabled={isPending}>
        {isPending ? "Saving…" : "Continue"}
      </Button>
    </form>
  );
}
