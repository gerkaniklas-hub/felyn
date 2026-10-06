"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { formatDateRange } from "@/lib/format";
import { deleteStay } from "@/app/home/actions";

type RemoveState = { status: "idle" } | { status: "confirming" } | { status: "pending" } | { status: "error"; message: string };

/**
 * P1.2: the guest's "Remove stay" action — server-authorized (deleteStay
 * re-verifies ownership and active-request status itself; this button is
 * not the security boundary, just the UI for it).
 */
export function RemoveStayButton({
  stay,
}: {
  stay: { id: string; property_name: string; check_in: string; check_out: string; guest_count: number };
}) {
  const router = useRouter();
  const [state, setState] = useState<RemoveState>({ status: "idle" });

  async function handleDelete() {
    setState({ status: "pending" });
    const result = await deleteStay(stay.id);
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setState({ status: "confirming" })}
        className="text-xs font-medium text-navy-300 hover:text-navy-600"
      >
        Remove stay
      </button>

      {state.status !== "idle" ? (
        <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 py-16">
          <div className="w-full max-w-sm rounded-card border border-ivory-300 bg-ivory-50 p-6 shadow-xl">
            <Heading level={3}>Remove this stay?</Heading>
            <div className="mt-3 rounded-xl border border-ivory-300 bg-ivory-100 p-3 text-sm">
              <p className="font-display text-base text-navy-950">{stay.property_name}</p>
              <p className="text-navy-600">
                {formatDateRange(stay.check_in, stay.check_out)} · {stay.guest_count} guest
                {stay.guest_count === 1 ? "" : "s"}
              </p>
            </div>
            <p className="mt-3 text-sm text-navy-500">
              This will remove this stay and its saved preferences.
            </p>
            {state.status === "error" ? (
              <p className="mt-3 rounded-xl bg-gold-100 px-3 py-2 text-sm font-medium text-gold-700">
                {state.message}
              </p>
            ) : null}
            <div className="mt-4 flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                disabled={state.status === "pending"}
                onClick={() => setState({ status: "idle" })}
              >
                Keep stay
              </Button>
              <Button
                type="button"
                className="flex-1"
                disabled={state.status === "pending"}
                onClick={handleDelete}
              >
                {state.status === "pending" ? "Removing…" : "Remove stay"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
