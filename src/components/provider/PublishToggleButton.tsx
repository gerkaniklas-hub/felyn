"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { setExperiencePublished } from "@/lib/provider/experience-actions";

type State = { status: "idle" } | { status: "pending" } | { status: "error"; message: string };

/**
 * Stage 3: an instant, single-purpose publish/unpublish toggle — deliberately
 * separate from the edit form (see ExperienceForm). Flipping `published` is
 * all setExperiencePublished does; guests' getPublishedExperiences/hard-
 * filter queries already filter on this exact column, so the effect is
 * immediate everywhere guest-facing, no other change needed.
 */
export function PublishToggleButton({ experienceId, published }: { experienceId: string; published: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  async function handleToggle() {
    setState({ status: "pending" });
    const result = await setExperiencePublished(experienceId, !published);
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }
    setState({ status: "idle" });
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant={published ? "secondary" : "primary"}
        size="sm"
        disabled={state.status === "pending"}
        onClick={handleToggle}
      >
        {state.status === "pending" ? "Updating…" : published ? "Unpublish" : "Publish"}
      </Button>
      {state.status === "error" ? <p className="text-sm text-red-600">{state.message}</p> : null}
    </div>
  );
}
