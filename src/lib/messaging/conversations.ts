import type { SupabaseClient } from "@supabase/supabase-js";
import { NO_TRIP_LINKED_LABEL, type BookingItemStatus } from "@/lib/matching/booking-status";
import type { PlannedMoment } from "@/lib/matching/plan";
import { getProviderMessagingItems } from "@/lib/provider/dashboard";
import { getItemIdsWithMessages, getLastMessagesByItem, getUnreadMessageCountsByItem } from "./messages";

/**
 * The Messages inbox's row shape — one per booking_request_item that has at
 * least one message (a fresh "Message host"/"Message guest" launch creates
 * the first message; until then there's nothing to list). Built entirely
 * from the EXISTING messages/booking_request_items/booking_requests/
 * experiences/stays tables and the 0014 RLS policies that already scope
 * `messages` correctly — no new tables, no new policies, no duplicate
 * authorization logic. `viewerRole` only changes which existing route a
 * conversation's "view booking" link points at.
 */
export type ConversationSummary = {
  itemId: string;
  viewerRole: "guest" | "provider";
  otherParticipant: {
    label: string;
    imageUrl: string | null;
    /** Set only for a guest viewing their host — opens the existing ProviderFocus panel (no dedicated profile route exists). Null when there's no existing way to view this participant (e.g. a provider viewing a guest — no guest profile page exists anywhere in the app). */
    providerId: string | null;
  };
  experienceTitle: string;
  experienceImageUrl: string | null;
  plannedDate: string;
  plannedMoment: PlannedMoment;
  itemStatus: BookingItemStatus;
  stayName: string;
  /** Stage 2c-B: anchors for the 30-day post-decision messaging window — see getMessagingWindowState. Null unless the item is DECLINED/CANCELLED respectively. */
  decidedAt: string | null;
  cancelledAt: string | null;
  /** The existing page that shows this booking: guest → their stay's plan; provider → the request detail page. */
  bookingHref: string;
  lastMessage: { body: string; createdAt: string; isMine: boolean } | null;
  unreadCount: number;
};

function sortByRecency(a: ConversationSummary, b: ConversationSummary): number {
  const at = a.lastMessage?.createdAt ?? "";
  const bt = b.lastMessage?.createdAt ?? "";
  return at < bt ? 1 : at > bt ? -1 : 0;
}

/**
 * The signed-in guest's own conversations, across every stay. Ownership is
 * re-checked explicitly against `booking_requests.user_id` (not left to RLS
 * alone) so a dual-role test account that is ALSO a provider elsewhere
 * never sees a provider-side conversation mixed into their guest inbox.
 */
export async function getGuestConversations(supabase: SupabaseClient): Promise<ConversationSummary[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const itemIds = await getItemIdsWithMessages(supabase);
  if (itemIds.length === 0) return [];

  type ItemRow = {
    id: string;
    booking_request_id: string;
    experience_id: string;
    planned_date: string;
    planned_moment: PlannedMoment;
    status: BookingItemStatus;
    decided_at: string | null;
    cancelled_at: string | null;
  };
  const { data: itemRows } = await supabase
    .from("booking_request_items")
    .select("id, booking_request_id, experience_id, planned_date, planned_moment, status, decided_at, cancelled_at")
    .in("id", itemIds);
  const items = (itemRows as ItemRow[] | null) ?? [];
  if (items.length === 0) return [];

  const requestIds = [...new Set(items.map((i) => i.booking_request_id))];
  type RequestRow = { id: string; user_id: string; stay_id: string | null };
  const { data: requestRows } = await supabase
    .from("booking_requests")
    .select("id, user_id, stay_id")
    .in("id", requestIds);
  const myRequestById = new Map(
    ((requestRows as RequestRow[] | null) ?? []).filter((r) => r.user_id === user.id).map((r) => [r.id, r]),
  );

  const myItems = items.filter((i) => myRequestById.has(i.booking_request_id));
  if (myItems.length === 0) return [];

  const stayIds = [...new Set([...myRequestById.values()].map((r) => r.stay_id).filter((id): id is string => id !== null))];
  const experienceIds = [...new Set(myItems.map((i) => i.experience_id))];

  type StayRow = { id: string; property_name: string };
  type ExperienceRow = { id: string; title: string; provider_id: string };
  type GalleryRow = { experience_id: string; image_url: string };
  type ProviderRow = { id: string; display_name: string; profile_photo_url: string | null };

  const [staysRes, experiencesRes, galleryRes] = await Promise.all([
    stayIds.length > 0
      ? supabase.from("stays").select("id, property_name").in("id", stayIds)
      : Promise.resolve({ data: [] as StayRow[] }),
    supabase.from("experiences").select("id, title, provider_id").in("id", experienceIds),
    supabase
      .from("experience_gallery")
      .select("experience_id, image_url")
      .in("experience_id", experienceIds)
      .order("sort_order", { ascending: true }),
  ]);

  const experiences = (experiencesRes.data as ExperienceRow[] | null) ?? [];
  const providerIds = [...new Set(experiences.map((e) => e.provider_id))];
  const { data: providerRows } = await supabase
    .from("provider_public_profiles")
    .select("id, display_name, profile_photo_url")
    .in("id", providerIds);

  const stayById = new Map(((staysRes.data as StayRow[] | null) ?? []).map((s) => [s.id, s]));
  const experienceById = new Map(experiences.map((e) => [e.id, e]));
  const providerById = new Map(((providerRows as ProviderRow[] | null) ?? []).map((p) => [p.id, p]));
  const imageByExperience = new Map<string, string>();
  for (const row of (galleryRes.data as GalleryRow[] | null) ?? []) {
    if (!imageByExperience.has(row.experience_id)) imageByExperience.set(row.experience_id, row.image_url);
  }

  const myItemIds = myItems.map((i) => i.id);
  const [lastMessages, unreadCounts] = await Promise.all([
    getLastMessagesByItem(supabase, myItemIds),
    getUnreadMessageCountsByItem(supabase, myItemIds),
  ]);

  const results: ConversationSummary[] = [];
  for (const item of myItems) {
    const request = myRequestById.get(item.booking_request_id);
    const experience = experienceById.get(item.experience_id);
    if (!request || !experience) continue;
    const provider = providerById.get(experience.provider_id);
    const stay = request.stay_id ? stayById.get(request.stay_id) : undefined;
    const last = lastMessages.get(item.id);

    results.push({
      itemId: item.id,
      viewerRole: "guest",
      otherParticipant: {
        label: provider?.display_name ?? "Your host",
        imageUrl: provider?.profile_photo_url ?? null,
        providerId: experience.provider_id,
      },
      experienceTitle: experience.title,
      experienceImageUrl: imageByExperience.get(experience.id) ?? null,
      plannedDate: item.planned_date,
      plannedMoment: item.planned_moment,
      itemStatus: item.status,
      decidedAt: item.decided_at,
      cancelledAt: item.cancelled_at,
      stayName: request.stay_id ? (stay?.property_name ?? "Your stay") : NO_TRIP_LINKED_LABEL,
      // A trip's booking opens in its planner (as before); a request without a trip opens its own booking page.
      bookingHref: request.stay_id ? `/recommendations?stay=${request.stay_id}` : `/bookings/${item.id}`,
      lastMessage: last ? { body: last.body, createdAt: last.createdAt, isMine: last.senderId === user.id } : null,
      unreadCount: unreadCounts.get(item.id) ?? 0,
    });
  }

  return results.sort(sortByRecency);
}

/**
 * The signed-in provider's own conversations. Reuses the provider item data
 * wholesale (task 4: no duplicate provider-side data fetching) — the exact
 * same items, guest names, experience info and stay names already shown on
 * the dashboard/Requests/detail pages — and layers only the conversation-
 * specific fields (last message, unread count) on top, filtered down to
 * items that actually have a message. Uses getProviderMessagingItems, which
 * also keeps WITHDRAWN items: their conversations stay readable as closed,
 * read-only history (the messages INSERT policies refuse WITHDRAWN), while
 * the booking surfaces never show them.
 */
export async function getProviderConversations(
  supabase: SupabaseClient,
  providerId: string,
): Promise<ConversationSummary[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const [items, itemIdsWithMessages] = await Promise.all([
    getProviderMessagingItems(supabase, providerId),
    getItemIdsWithMessages(supabase),
  ]);
  const withMessages = itemIdsWithMessages.length > 0 ? new Set(itemIdsWithMessages) : null;
  const conversationItems = withMessages ? items.filter((i) => withMessages.has(i.itemId)) : [];
  if (conversationItems.length === 0) return [];

  const itemIds = conversationItems.map((i) => i.itemId);
  const [lastMessages, unreadCounts] = await Promise.all([
    getLastMessagesByItem(supabase, itemIds),
    getUnreadMessageCountsByItem(supabase, itemIds),
  ]);

  const results: ConversationSummary[] = conversationItems.map((item) => {
    const last = lastMessages.get(item.itemId);
    return {
      itemId: item.itemId,
      viewerRole: "provider",
      otherParticipant: {
        label: item.guestFirstName ?? "Guest",
        imageUrl: null,
        // No guest profile page exists anywhere in the app — never linkable from the provider side.
        providerId: null,
      },
      experienceTitle: item.experienceTitle,
      experienceImageUrl: item.experienceImageUrl,
      plannedDate: item.plannedDate,
      plannedMoment: item.plannedMoment,
      itemStatus: item.status,
      decidedAt: item.decidedAt,
      cancelledAt: item.cancelledAt,
      stayName: item.stayName,
      bookingHref: `/provider/requests/${item.itemId}`,
      lastMessage: last ? { body: last.body, createdAt: last.createdAt, isMine: last.senderId === user.id } : null,
      unreadCount: unreadCounts.get(item.itemId) ?? 0,
    };
  });

  return results.sort(sortByRecency);
}
