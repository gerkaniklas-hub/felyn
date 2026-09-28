"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

const GENERIC_ERROR = "Something went wrong. Please try again.";

/**
 * Stage 5 (planner discovery fix): sets/updates the caller's OWN CURRENT
 * service location — the missing write path identified in the planner-
 * discovery investigation (see service-location.ts's own comment). Reuses
 * service_locations (0002) exactly as-is, including its existing owner-
 * only RLS; providerId is never trusted from the client, only ever
 * resolved from auth.uid() here.
 *
 * starts_at/ends_at are left null — an unbounded "ongoing" location, per
 * serviceLocationActiveDuring's own documented null-means-unbounded
 * convention (filters.ts) — matching every seeded demo provider's own
 * current location row. Updates the existing current row in place if one
 * exists, rather than accumulating a new row per edit.
 */
export async function setProviderServiceLocation(locationText: string): Promise<ActionResult> {
  const text = locationText.trim();
  if (!text) return { ok: false, error: "Please enter a location." };

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You need to be signed in." };

  const { data: provider } = await supabase.from("providers").select("id").eq("user_id", user.id).maybeSingle();
  const providerId = (provider as { id: string } | null)?.id;
  if (!providerId) return { ok: false, error: "This account isn't linked to a Felyn provider profile yet." };

  const { data: existing } = await supabase
    .from("service_locations")
    .select("id")
    .eq("provider_id", providerId)
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const existingId = (existing as { id: string } | null)?.id;

  if (existingId) {
    const { error } = await supabase
      .from("service_locations")
      .update({ location_text: text, starts_at: null, ends_at: null })
      .eq("id", existingId)
      .eq("provider_id", providerId);
    if (error) return { ok: false, error: GENERIC_ERROR };
    return { ok: true };
  }

  const { error } = await supabase.from("service_locations").insert({
    provider_id: providerId,
    location_text: text,
    is_current: true,
    starts_at: null,
    ends_at: null,
  });
  if (error) return { ok: false, error: GENERIC_ERROR };
  return { ok: true };
}
