import { redirect } from "next/navigation";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { StayPlanner } from "@/components/planner/StayPlanner";
import { getRecommendedExperiences, type RecommendedExperience } from "@/lib/matching/actions";
import { getActiveBookingRequest } from "@/lib/matching/booking-requests";
import { getHardFilteredExperiences } from "@/lib/matching/hard-filter";
import { buildStayTimeline } from "@/lib/matching/timeline";
import { getUnreadMessageCountsByItem } from "@/lib/messaging/messages";
import { getStay } from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// A broader spread than the earlier 3-card screen, for variety across the
// stay — still capped to however many actually pass the M5.1 hard filter.
const PLANNER_SUGGESTION_COUNT = 6;

/**
 * "Your Felyn plan" — the M6 Stay Planner workspace (previously a plain
 * 3-card recommendation screen at this same route). Still reads ?stay=,
 * falling back to the guest's latest completed stay when absent, exactly
 * as before M6. The actual matching still runs entirely through the
 * existing M5.1/M5.2 getRecommendedExperiences Server Action; this page
 * only fetches a wider set and organizes it into a day-by-day timeline for
 * the StayPlanner client component to render.
 *
 * M6.4 "Other ideas": calls the unmodified M5.1 getHardFilteredExperiences
 * directly (no schema/filter changes, no extra OpenAI call) to get the
 * full eligible pool, then subtracts the AI-ranked set to get "everything
 * else that's still hard-filter-eligible" for the planner's alternatives
 * panels. Every alternative shown has already passed the same hard
 * constraints as the primary suggestions — nothing bypasses M5.1.
 */
export default async function RecommendationsPage({
  searchParams,
}: {
  searchParams: Promise<{ stay?: string }>;
}) {
  const { stay: stayIdParam } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  let stayId = stayIdParam;
  if (!stayId) {
    const { data: latestStay } = await supabase
      .from("stays")
      .select("id")
      .eq("user_id", user?.id)
      .not("onboarding_completed_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    stayId = latestStay?.id;
  }

  if (!stayId) redirect("/home");

  const stay = await getStay(supabase, stayId);
  if (!stay || !stay.onboarding_completed_at) redirect("/home");

  // M7.2: an active (REQUESTED/CONFIRMED) request locks the planner — a
  // withdrawn one behaves like no request at all, same as before M7.
  const activeRequest = await getActiveBookingRequest(stay.id);

  // Unread messages per item, for the "Message {host}" badges — batched in
  // one query rather than one per item (see getUnreadMessageCountsByItem).
  const unreadCountsByItem = await getUnreadMessageCountsByItem(
    supabase,
    activeRequest?.items.map((item) => item.id) ?? [],
  );

  let recommendations: RecommendedExperience[] = [];
  let loadFailed = false;
  try {
    recommendations = await getRecommendedExperiences(stay.id, PLANNER_SUGGESTION_COUNT);
  } catch {
    loadFailed = true;
  }

  const eligible = await getHardFilteredExperiences(supabase, stay.id);
  const recommendedIds = new Set(recommendations.map((r) => r.experience.id));
  const alternatives: RecommendedExperience[] = eligible
    .filter((experience) => !recommendedIds.has(experience.id))
    .map((experience) => ({ experience, reason: "" }));

  // M6.5 follow-up: spread the FULL eligible pool (AI-ranked picks first,
  // then the rest) across the stay's plannable days, not just the narrow
  // AI top-N. A short AI list no longer means most of the stay goes
  // unpopulated — every day gets a fair shot at a primary suggestion, with
  // no extra OpenAI call (this is still just M5.1's existing eligible set).
  const timeline = buildStayTimeline(
    stay.check_in,
    stay.check_out,
    [...recommendations, ...alternatives].map((r) => r.experience.id),
  );

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
      <StayPlanner
        stay={{
          id: stay.id,
          property_name: stay.property_name,
          location_text: stay.location_text,
          check_in: stay.check_in,
          check_out: stay.check_out,
          guest_count: stay.guest_count,
        }}
        recommendations={recommendations}
        alternatives={alternatives}
        timeline={timeline}
        loadFailed={loadFailed}
        activeRequest={activeRequest}
        unreadMessageCounts={Object.fromEntries(unreadCountsByItem)}
      />
      </div>
    </div>
  );
}
