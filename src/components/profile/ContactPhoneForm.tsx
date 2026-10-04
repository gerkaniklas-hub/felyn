"use client";

import { useActionState, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { PhoneInput } from "@/components/ui/phone-input";
import { saveContactPhone, type ContactPhoneFormState } from "@/lib/contact/actions";
import { validatePhone } from "@/lib/phone";

const initialState: ContactPhoneFormState = {};

type FieldError = { error: string; field: "country" | "number" };

/**
 * The account's mobile number (user_contact_details), editable from the
 * guest Profile and the host /provider/profile alike — one record per
 * account. Checked in the browser for quick feedback, then again by
 * saveContactPhone on the server, which is the check that counts.
 */
export function ContactPhoneForm({ defaultCountry, defaultNumber }: { defaultCountry: string; defaultNumber: string }) {
  const [state, formAction, isPending] = useActionState(saveContactPhone, initialState);
  const [clientError, setClientError] = useState<FieldError | null>(null);
  // Edited since the last save attempt: the previous "Saved." / server error no longer applies.
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
        hint="Only you and the Felyn team can see this."
        onChange={() => {
          setClientError(null);
          setEdited(true);
        }}
      />
      {state.savedAt && !edited && !error ? <p className="text-sm text-sky-700">Saved.</p> : null}
      <Button type="submit" variant="secondary" size="sm" className="self-start" disabled={isPending}>
        {isPending ? "Saving…" : "Save mobile number"}
      </Button>
    </form>
  );
}
