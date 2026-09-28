"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { deleteExperience } from "@/lib/provider/experience-actions";

type State = { status: "idle" } | { status: "confirming" } | { status: "pending" } | { status: "error"; message: string };

/**
 * Stage 3: delete is server-authorized (deleteExperience re-verifies
 * ownership itself; this button is not the security boundary, just the UI
 * for it) — mirrors RemoveStayButton's own confirm-modal pattern. A
 * friendly message from the server (surfaced verbatim here) explains when
 * deletion is blocked by existing booking history (the experience_id
 * foreign key's ON DELETE RESTRICT, 0005) and points at unpublishing
 * instead — this button never has to know that rule itself.
 */
export function DeleteExperienceButton({ experienceId, title }: { experienceId: string; title: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  async function handleDelete() {
    setState({ status: "pending" });
    const result = await deleteExperience(experienceId);
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }
    router.push("/provider/experiences");
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setState({ status: "confirming" })}
        className="text-sm font-medium text-navy-400 hover:text-red-600"
      >
        Delete experience
      </button>

      {state.status !== "idle" ? (
        <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 py-16">
          <div className="w-full max-w-sm rounded-2xl border border-ivory-300 bg-ivory-50 p-6 shadow-xl">
            <Heading level={3}>Delete this experience?</Heading>
            <p className="mt-3 rounded-xl border border-ivory-300 bg-ivory-100 p-3 text-sm text-navy-900">{title}</p>
            <p className="mt-3 text-sm text-navy-500">
              This can&apos;t be undone. If this experience has any booking history, deletion will be blocked
              automatically — unpublish it instead in that case.
            </p>
            {state.status === "error" ? (
              <p className="mt-3 rounded-lg bg-gold-100 px-3 py-2 text-sm font-medium text-gold-700">
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
                Keep experience
              </Button>
              <Button
                type="button"
                className="flex-1"
                disabled={state.status === "pending"}
                onClick={handleDelete}
              >
                {state.status === "pending" ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
