"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type State = { status: "idle" | "pending" | "saved" } | { status: "error"; message: string };

/**
 * Milestone 1: editable first/last name, stored the same place signup already writes them — auth.users.user_metadata.
 * The mobile number is not part of this form: it lives in user_contact_details (ContactPhoneForm).
 */
export function ProfileDetailsForm({ firstName, lastName }: { firstName: string; lastName: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const newFirstName = String(formData.get("firstName") ?? "").trim();
    const newLastName = String(formData.get("lastName") ?? "").trim();

    if (!newFirstName || !newLastName) {
      setState({ status: "error", message: "First and last name can't be empty." });
      return;
    }

    setState({ status: "pending" });
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.updateUser({
      data: { first_name: newFirstName, last_name: newLastName },
    });
    if (error) {
      setState({ status: "error", message: "We couldn't save your details. Please try again." });
      return;
    }

    setState({ status: "saved" });
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <Input label="First name" name="firstName" defaultValue={firstName} autoComplete="given-name" required />
        <Input label="Last name" name="lastName" defaultValue={lastName} autoComplete="family-name" required />
      </div>
      {state.status === "error" ? <p className="text-sm text-red-600">{state.message}</p> : null}
      {state.status === "saved" ? <p className="text-sm text-sky-700">Saved.</p> : null}
      <Button type="submit" variant="secondary" size="sm" className="self-start" disabled={state.status === "pending"}>
        {state.status === "pending" ? "Saving…" : "Save details"}
      </Button>
    </form>
  );
}
