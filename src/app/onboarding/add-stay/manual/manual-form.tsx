"use client";

import { useActionState, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Stay } from "@/lib/onboarding/types";
import {
  minCheckOutDate,
  validateStayDates,
  type CheckOutError,
} from "@/lib/onboarding/stay-dates";
import { saveStay, type ActionState } from "./actions";

const initialState: ActionState = {};

export function ManualStayForm({ stay }: { stay: Stay | null }) {
  const [state, formAction, isPending] = useActionState(saveStay, initialState);
  const [checkIn, setCheckIn] = useState(stay?.check_in ?? "");
  const [checkOutError, setCheckOutError] = useState<CheckOutError | null>(null);

  const displayedCheckOutError = checkOutError ?? state.checkOutError ?? null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const formData = new FormData(event.currentTarget);
    const checkInValue = String(formData.get("checkIn") ?? "");
    const checkOutValue = String(formData.get("checkOut") ?? "");

    const dateError = validateStayDates(checkInValue, checkOutValue);
    if (dateError) {
      event.preventDefault();
      setCheckOutError(dateError);
    }
  }

  return (
    <form
      action={formAction}
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="stayId" value={stay?.id ?? ""} />
      <Input
        label="Property or home name"
        name="propertyName"
        defaultValue={stay?.property_name}
        placeholder="Casa Sol"
        required
      />
      <div className="flex flex-col gap-1">
        <Input
          label="Location"
          name="location"
          defaultValue={stay?.location_text}
          placeholder="La Orotava, Tenerife"
          required
        />
        {stay?.latitude != null && stay?.longitude != null ? (
          <p className="text-xs font-medium text-sky-700">✓ Location verified</p>
        ) : (
          <p className="text-xs text-navy-300">
            Location not yet verified — you can still continue with the address you typed.
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Check-in"
          name="checkIn"
          type="date"
          value={checkIn}
          onChange={(e) => {
            setCheckIn(e.target.value);
            setCheckOutError(null);
          }}
          required
        />
        <div className="flex flex-col gap-1.5">
          <Input
            label="Check-out"
            name="checkOut"
            type="date"
            min={minCheckOutDate(checkIn)}
            defaultValue={stay?.check_out ?? undefined}
            onChange={() => setCheckOutError(null)}
            required
          />
          {displayedCheckOutError && (
            <p className="text-sm text-red-600">
              <span className="font-medium">{displayedCheckOutError.title}</span>
              <br />
              {displayedCheckOutError.detail}
            </p>
          )}
        </div>
      </div>
      <Input
        label="Number of guests"
        name="guestCount"
        type="number"
        min={1}
        defaultValue={stay?.guest_count}
        required
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Saving…" : "Continue"}
      </Button>
    </form>
  );
}
