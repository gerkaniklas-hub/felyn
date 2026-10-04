"use client";

import { useActionState, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { Textarea } from "@/components/ui/textarea";
import { submitHostApplication, type HostApplicationFormState } from "@/app/host/actions";
import { HOST_APPLICATION_CATEGORIES, HOST_APPLICATION_LIMITS as LIMITS } from "@/lib/host-application/constants";
import { validatePhone } from "@/lib/phone";

const initialState: HostApplicationFormState = {};

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-sm text-red-600">{message}</p> : null;
}

/**
 * Uncontrolled inputs whose defaultValue comes from the last submitted values
 * (echoed back by the action) — React resets a form after its action runs,
 * so this is what keeps the applicant's answers in place after a
 * validation error.
 */
export function HostApplicationForm({
  defaults,
}: {
  defaults: { firstName: string; lastName: string; phoneCountry: string; phoneNumber: string };
}) {
  const [state, formAction, isPending] = useActionState(submitHostApplication, initialState);
  const values = state.values ?? {};
  const errors = state.fieldErrors ?? {};
  const [firstNameHint, setFirstNameHint] = useState(values.firstName ?? defaults.firstName);
  // The browser check only gives quick feedback; submitHostApplication validates again.
  const [phoneError, setPhoneError] = useState<{ error: string; field: "country" | "number" } | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const formData = new FormData(event.currentTarget);
    const phone = validatePhone(String(formData.get("phoneCountry") ?? ""), String(formData.get("phoneNumber") ?? ""));
    if (!phone.ok) {
      event.preventDefault();
      setPhoneError({ error: phone.error, field: phone.field });
    } else {
      setPhoneError(null);
    }
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
      <Card className="flex flex-col gap-4">
        <Heading level={3}>About you</Heading>
        <p className="-mt-2 text-sm text-navy-500">Your legal name and phone number are only seen by the Felyn team.</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Input
              label="First name"
              name="firstName"
              autoComplete="given-name"
              required
              maxLength={LIMITS.firstName.max}
              defaultValue={values.firstName ?? defaults.firstName}
              onChange={(event) => setFirstNameHint(event.target.value)}
              aria-invalid={Boolean(errors.firstName)}
            />
            <FieldError message={errors.firstName} />
          </div>
          <div className="flex flex-col gap-1">
            <Input
              label="Last name"
              name="lastName"
              autoComplete="family-name"
              required
              maxLength={LIMITS.lastName.max}
              defaultValue={values.lastName ?? defaults.lastName}
              aria-invalid={Boolean(errors.lastName)}
            />
            <FieldError message={errors.lastName} />
          </div>
        </div>
        {/* Remounted after each server response so it shows the values the action echoed back. */}
        <PhoneInput
          key={state.submittedAt ?? 0}
          defaultCountry={values.phoneCountry ?? defaults.phoneCountry}
          defaultNumber={values.phoneNumber ?? defaults.phoneNumber}
          required
          error={phoneError?.error ?? errors.phone}
          errorField={phoneError?.field ?? state.phoneErrorField}
          hint="This is your account's mobile number: changing it here updates it everywhere on Felyn."
          onChange={() => setPhoneError(null)}
        />
        <div className="flex flex-col gap-1">
          <Input
            label="Where would you host?"
            name="location"
            required
            maxLength={LIMITS.location.max}
            defaultValue={values.location}
            placeholder="e.g. South Tenerife, Spain"
            aria-invalid={Boolean(errors.location)}
          />
          <FieldError message={errors.location} />
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <Heading level={3}>Your experience</Heading>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium text-navy-700">What kind of experience?</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {HOST_APPLICATION_CATEGORIES.map((category) => (
              <label
                key={category.value}
                className="flex cursor-pointer items-center justify-center rounded-xl border border-ivory-400 bg-ivory-50 px-3 py-3 text-center text-sm font-medium text-navy-700 transition-colors has-[:checked]:border-sky-500 has-[:checked]:bg-sky-50 has-[:checked]:text-sky-700 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-200"
              >
                <input
                  type="radio"
                  name="experienceCategory"
                  value={category.value}
                  defaultChecked={values.experienceCategory === category.value}
                  className="sr-only"
                  required
                />
                {category.label}
              </label>
            ))}
          </div>
          <FieldError message={errors.experienceCategory} />
        </fieldset>
        <div className="flex flex-col gap-1">
          <Textarea
            label="What would you like to offer guests?"
            name="experienceDescription"
            required
            minLength={LIMITS.experienceDescription.min}
            maxLength={LIMITS.experienceDescription.max}
            rows={5}
            defaultValue={values.experienceDescription}
            placeholder="A slow Canarian lunch on the terrace, a paella cooked together, a tasting of local wines…"
            aria-invalid={Boolean(errors.experienceDescription)}
          />
          <FieldError message={errors.experienceDescription} />
        </div>
        <div className="flex flex-col gap-1">
          <Textarea
            label="Your background (optional)"
            name="background"
            maxLength={LIMITS.background.max}
            rows={4}
            defaultValue={values.background}
            placeholder="Cooking, hosting or hospitality experience — professional, or simply a lifelong passion."
          />
          <FieldError message={errors.background} />
        </div>
        <div className="flex flex-col gap-1">
          <Input
            label="Website or Instagram (optional)"
            name="websiteOrInstagram"
            maxLength={LIMITS.websiteOrInstagram.max}
            defaultValue={values.websiteOrInstagram}
            placeholder="https://… or @yourname"
            aria-invalid={Boolean(errors.websiteOrInstagram)}
          />
          <FieldError message={errors.websiteOrInstagram} />
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <Heading level={3}>Your public name</Heading>
        <p className="-mt-2 text-sm text-navy-500">
          This is the name guests will see if you are approved — never your full legal name unless you choose it. Leave
          it blank to use your first name. You can change it while your application is being reviewed.
        </p>
        <div className="flex flex-col gap-1">
          <Input
            label="Public display name"
            name="displayName"
            maxLength={LIMITS.displayName.max}
            defaultValue={values.displayName}
            placeholder={firstNameHint.trim() || "Your first name"}
          />
          <FieldError message={errors.displayName} />
        </div>
      </Card>

      {state.error && (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </p>
      )}

      <div className="flex flex-col items-start gap-3">
        <Button type="submit" size="lg" disabled={isPending}>
          {isPending ? "Sending your application…" : "Submit application"}
        </Button>
        <p className="text-sm text-navy-500">
          We review every application personally. Approval isn&apos;t guaranteed, and you&apos;ll only be able to
          publish experiences once your application has been approved.
        </p>
      </div>
    </form>
  );
}
