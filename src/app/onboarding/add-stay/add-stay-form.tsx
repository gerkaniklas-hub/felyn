"use client";

import { useActionState, useState, type FormEvent } from "react";
import { LocationPicker } from "@/components/explore/LocationPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Location } from "@/lib/locations";
import type { Stay } from "@/lib/onboarding/types";
import { minCheckOutDate, validateStayDates, type CheckOutError } from "@/lib/onboarding/stay-dates";
import { saveStay, type ActionState } from "./actions";

const initialState: ActionState = {};

const pickerInputClass =
  "h-11 w-full rounded-xl border border-ivory-400 bg-ivory-50 pr-4 pl-12 text-base text-navy-900 outline-none transition-colors placeholder:text-navy-300 focus:border-sky-500 focus:ring-2 focus:ring-sky-100";

/**
 * The simplified Add a stay form: name (optional), canonical location,
 * dates, guests. Location can only be chosen from Felyn's locations
 * (LocationPicker); the chosen id travels in a hidden field and is
 * re-checked by saveStay.
 */
export function AddStayForm({
  stay,
  locations,
  initialLocationId,
  unmatchedLocationText,
}: {
  stay: Stay | null;
  locations: Location[];
  /** The stay's canonical location, or the one its old free text confidently names. */
  initialLocationId: string | null;
  /** An older stay's free-text location that couldn't be matched; shown so the guest knows what to pick. */
  unmatchedLocationText: string | null;
}) {
  const [state, formAction, isPending] = useActionState(saveStay, initialState);
  const [locationId, setLocationId] = useState<string | null>(initialLocationId);
  const [checkIn, setCheckIn] = useState(stay?.check_in ?? "");
  const [checkOutError, setCheckOutError] = useState<CheckOutError | null>(null);
  const [locationMissing, setLocationMissing] = useState(false);

  const displayedCheckOutError = checkOutError ?? state.checkOutError ?? null;
  const locationError = locationMissing ? "Choose where you're staying from the list." : (state.locationError ?? null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (!locationId) {
      event.preventDefault();
      setLocationMissing(true);
      return;
    }
    const formData = new FormData(event.currentTarget);
    const dateError = validateStayDates(String(formData.get("checkIn") ?? ""), String(formData.get("checkOut") ?? ""));
    if (dateError) {
      event.preventDefault();
      setCheckOutError(dateError);
    }
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      <input type="hidden" name="stayId" value={stay?.id ?? ""} />
      <input type="hidden" name="locationId" value={locationId ?? ""} />

      <Input
        label="Property or home name (optional)"
        name="propertyName"
        defaultValue={stay?.property_name}
        placeholder="Casa Sol"
      />

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-navy-700">Where are you staying?</span>
        <LocationPicker
          locations={locations}
          selectedId={locationId}
          onSelect={(id) => {
            setLocationId(id);
            setLocationMissing(false);
          }}
          inputClassName={pickerInputClass}
          stretchList
        />
        {unmatchedLocationText && !locationId ? (
          <p className="text-sm text-navy-500">
            You previously entered “{unmatchedLocationText}”. Choose the matching place from the list.
          </p>
        ) : null}
        {locationError ? <p className="text-sm text-red-600">{locationError}</p> : null}
      </div>

      <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
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
        <Input
          label="Check-out"
          name="checkOut"
          type="date"
          min={minCheckOutDate(checkIn)}
          defaultValue={stay?.check_out ?? undefined}
          onChange={() => setCheckOutError(null)}
          required
        />
      </div>
      {displayedCheckOutError ? (
        <p className="-mt-2 text-sm text-red-600">
          <span className="font-medium">{displayedCheckOutError.title}</span>
          <br />
          {displayedCheckOutError.detail}
        </p>
      ) : null}

      <Input
        label="Number of guests"
        name="guestCount"
        type="number"
        inputMode="numeric"
        min={1}
        defaultValue={stay?.guest_count}
        required
      />

      {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}
      <Button type="submit" disabled={isPending} className="mt-1">
        {isPending ? "Saving…" : stay ? "Save stay" : "Add stay"}
      </Button>
    </form>
  );
}
