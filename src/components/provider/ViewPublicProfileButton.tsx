"use client";

import { useState } from "react";
import { ProviderFocus } from "@/components/planner/ProviderFocus";
import { getProviderProfileAction } from "@/lib/matching/actions";
import type { ProviderProfile } from "@/lib/matching/provider-profile";

/**
 * P1: lets a provider see exactly what a guest sees — reuses the same
 * on-demand fetch (getProviderProfileAction) and the same ProviderFocus
 * panel the Stay Planner and /explore already use, so nothing beyond the
 * public-safe `provider_public_profiles` view is ever surfaced here.
 */
export function ViewPublicProfileButton({ providerId, providerName }: { providerId: string; providerName: string }) {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<ProviderProfile | "loading" | null>(null);

  async function handleOpen() {
    setOpen(true);
    if (profile === null) {
      setProfile("loading");
      setProfile(await getProviderProfileAction(providerId));
    }
  }

  return (
    <>
      <button type="button" onClick={handleOpen} className="text-sm font-medium text-sky-600 hover:text-sky-700">
        View public profile →
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-ivory-100/95 p-4">
          <div className="mx-auto h-full max-w-lg">
            <ProviderFocus profile={profile} providerName={providerName} onClose={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
