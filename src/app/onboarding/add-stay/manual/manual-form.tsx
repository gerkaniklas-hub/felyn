"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Stay } from "@/lib/onboarding/types";
import { saveStay, type ActionState } from "./actions";

const initialState: ActionState = {};

export function ManualStayForm({ stay }: { stay: Stay | null }) {
  const [state, formAction, isPending] = useActionState(saveStay, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="stayId" value={stay?.id ?? ""} />
      <Input
        label="Property or home name"
        name="propertyName"
        defaultValue={stay?.property_name}
        placeholder="Casa Sol"
        required
      />
      <Input
        label="Location"
        name="location"
        defaultValue={stay?.location_text}
        placeholder="La Orotava, Tenerife"
        required
      />
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Check-in"
          name="checkIn"
          type="date"
          defaultValue={stay?.check_in}
          required
        />
        <Input
          label="Check-out"
          name="checkOut"
          type="date"
          defaultValue={stay?.check_out}
          required
        />
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
