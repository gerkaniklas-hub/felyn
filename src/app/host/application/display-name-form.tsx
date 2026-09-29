"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateHostDisplayName, type DisplayNameFormState } from "@/app/host/actions";
import { HOST_APPLICATION_LIMITS as LIMITS } from "@/lib/host-application/constants";

const initialState: DisplayNameFormState = {};

/** Edits only the public display name; the server action and 0023's RLS limit this to pending applications. */
export function DisplayNameForm({ currentName }: { currentName: string }) {
  const [state, formAction, isPending] = useActionState(updateHostDisplayName, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input
            label="Public display name"
            name="displayName"
            required
            maxLength={LIMITS.displayName.max}
            defaultValue={currentName}
            key={currentName}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={isPending}>
          {isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      {state.ok && !state.error && (
        <p role="status" className="text-sm text-sky-700">
          Saved.
        </p>
      )}
    </form>
  );
}
