"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { setProviderServiceLocation } from "@/lib/provider/service-location-actions";

type State = { status: "idle" | "editing" | "pending" } | { status: "error"; message: string };

/**
 * Stage 5 (planner discovery fix): lets a host set the service location
 * guest stay matching actually depends on (see service-location.ts). Shown
 * prominently when missing — this is the exact, root-cause reason a
 * published experience can appear in Explore but never in the planner.
 */
export function ServiceLocationCard({ currentLocationText }: { currentLocationText: string | null }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: currentLocationText ? "idle" : "editing" });
  const [value, setValue] = useState(currentLocationText ?? "");

  async function handleSave() {
    setState({ status: "pending" });
    const result = await setProviderServiceLocation(value);
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }
    setState({ status: "idle" });
    router.refresh();
  }

  const editing = state.status === "editing" || state.status === "pending" || state.status === "error";

  if (!editing) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase">SERVICE LOCATION</p>
          <p className="mt-1 text-navy-900">{currentLocationText}</p>
        </div>
        <button
          type="button"
          onClick={() => setState({ status: "editing" })}
          className="text-sm font-medium text-sky-600 hover:text-sky-700"
        >
          Edit
        </button>
      </Card>
    );
  }

  return (
    <Card className={!currentLocationText ? "border-gold-300 bg-gold-50" : undefined}>
      <p className="text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase">SERVICE LOCATION</p>
      {!currentLocationText ? (
        <p className="mt-1 text-sm text-gold-700">
          Add where you currently offer experiences — guests planning a trip can only find your experiences here
          if this is set.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Input
          label="Location"
          name="serviceLocation"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="La Orotava, Tenerife"
          className="max-w-xs"
        />
        <Button type="button" size="sm" disabled={state.status === "pending"} onClick={handleSave}>
          {state.status === "pending" ? "Saving…" : "Save"}
        </Button>
        {currentLocationText ? (
          <button
            type="button"
            disabled={state.status === "pending"}
            onClick={() => {
              setValue(currentLocationText);
              setState({ status: "idle" });
            }}
            className="text-sm font-medium text-navy-400 hover:text-navy-700 disabled:opacity-40"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {state.status === "error" ? <p className="mt-2 text-sm text-red-600">{state.message}</p> : null}
    </Card>
  );
}
