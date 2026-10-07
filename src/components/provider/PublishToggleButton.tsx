"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { setExperiencePublished } from "@/lib/provider/experience-actions";

type State =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; message: string; reason?: "no_photos" | "no_availability" }
  | { status: "success"; published: boolean };

/**
 * An instant, single-purpose publish/unpublish toggle — deliberately
 * separate from the edit form (see ExperienceForm). The server
 * (setExperiencePublished) is the real authority, including the publish-
 * time photo/availability requirements — this button only reflects what
 * the server actually did. A success modal only ever appears after the
 * server has confirmed the change; the button is disabled for the whole
 * request so a double-click can't fire two overlapping toggles.
 */
export function PublishToggleButton({ experienceId, published }: { experienceId: string; published: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  async function handleToggle() {
    setState({ status: "pending" });
    const result = await setExperiencePublished(experienceId, !published);
    if (!result.ok) {
      setState({ status: "error", message: result.error, reason: result.reason });
      return;
    }
    setState({ status: "success", published: !published });
  }

  function dismissSuccess() {
    setState({ status: "idle" });
    router.refresh();
  }

  if (state.status === "success") {
    return (
      <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 py-16">
        <div className="w-full max-w-sm rounded-card border border-ivory-300 bg-ivory-50 p-6 text-center shadow-xl">
          <Heading level={3}>{state.published ? "Your experience is now live." : "Your experience is unpublished."}</Heading>
          <p className="mt-3 text-sm text-navy-600">
            {state.published
              ? "Guests can now discover it on Felyn and send booking requests."
              : "Guests can no longer discover it in Felyn or send new booking requests."}
          </p>
          <Button type="button" className="mt-5 w-full" onClick={dismissSuccess}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant={published ? "secondary" : "primary"}
        size="sm"
        disabled={state.status === "pending"}
        onClick={handleToggle}
      >
        {state.status === "pending" ? "Updating…" : published ? "Unpublish" : "Publish"}
      </Button>
      {state.status === "error" ? (
        <div className="text-right">
          <p className="text-sm text-red-600">{state.message}</p>
          {state.reason === "no_availability" ? (
            <a href="#availability-section" className="text-sm font-medium text-sky-600 hover:text-sky-700">
              Go to availability →
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
