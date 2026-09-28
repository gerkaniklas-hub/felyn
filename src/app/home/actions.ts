"use server";

import { redirect } from "next/navigation";
import { getStay } from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function logout() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export type DeleteStayResult = { ok: true } | { ok: false; error: string };

/**
 * P1.2: removes a stay the guest no longer wants, scoped strictly to their
 * own row (via the RLS-scoped getStay, plus an explicit `user_id` filter on
 * the final delete). Deliberately does NOT rely on the `stays ->
 * booking_requests` foreign key alone (that's `on delete restrict` as of
 * 0010, specifically so this can never happen by accident) — instead:
 *
 * Booking-lifecycle milestone: rewritten to decide blocking from each
 * request's ITEM statuses, never from booking_requests.status alone. That
 * column is not reliable proof of "still open" — item-level confirm/
 * decline/withdraw/cancel never touch it (see booking-status.ts's own
 * notes), so a request can sit at status='REQUESTED' forever even after
 * every one of its items has been decided, declined, withdrawn, or
 * cancelled. The previous version trusted that column directly, which
 * meant a stay whose only activity was e.g. a single DECLINED item could
 * never be deleted even though nothing about it was actually still open —
 * that gap is fixed here, generalized rather than special-cased to
 * CANCELLED alone. Per request, using BOTH its own status and its items':
 *
 * 1. The request's own status is still REQUESTED/CONFIRMED (genuinely
 *    active — nothing has withdrawn it) AND it has a still-open item
 *    (REQUESTED or CONFIRMED): blocks with the "active request, withdraw
 *    it" message — the guest can still do exactly that.
 * 2. Otherwise, any CONFIRMED or DECLINED item still blocks deletion with
 *    the "past experience activity" message — real marketplace history
 *    worth keeping, whether or not the parent request itself was ever
 *    withdrawn. This is what distinguishes a genuinely active request
 *    (case 1) from a CONFIRMED item stranded under an already-withdrawn
 *    parent (case 2 — telling the guest to "withdraw" it would be wrong,
 *    since there's nothing left to withdraw; the item itself is what's
 *    still outstanding).
 * 3. Otherwise (every item, if any, is WITHDRAWN and/or CANCELLED — an
 *    orphaned never-decided REQUESTED item under an already-withdrawn
 *    parent counts here too, since nobody ever acted on it) the request is
 *    safe to delete alongside the stay — explicitly deleted first,
 *    cascading its own items via the existing 0005 FK — and only then is
 *    the stay itself deleted, which cascades the purely-onboarding-owned
 *    stay_occasions/stay_preferences/stay_dietary_requirements (0001).
 */
export async function deleteStay(stayId: string): Promise<DeleteStayResult> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You need to be signed in." };
  }

  const stay = await getStay(supabase, stayId);
  if (!stay) {
    return { ok: false, error: "We couldn't find this stay." };
  }

  const { data: requestRows } = await supabase.from("booking_requests").select("id, status").eq("stay_id", stayId);
  const requests = (requestRows as { id: string; status: string }[] | null) ?? [];
  const requestIds = requests.map((row) => row.id);

  const itemStatusesByRequest = new Map<string, string[]>();
  if (requestIds.length > 0) {
    const { data: itemRows } = await supabase
      .from("booking_request_items")
      .select("booking_request_id, status")
      .in("booking_request_id", requestIds);
    for (const row of (itemRows as { booking_request_id: string; status: string }[] | null) ?? []) {
      const list = itemStatusesByRequest.get(row.booking_request_id) ?? [];
      list.push(row.status);
      itemStatusesByRequest.set(row.booking_request_id, list);
    }
  }

  const requestsSafeToDelete: string[] = [];
  for (const request of requests) {
    const itemStatuses = itemStatusesByRequest.get(request.id) ?? [];
    const parentIsActive = request.status === "REQUESTED" || request.status === "CONFIRMED";
    const hasOpenItem = itemStatuses.some((s) => s === "REQUESTED" || s === "CONFIRMED");
    const hasDecidedHistory = itemStatuses.some((s) => s === "CONFIRMED" || s === "DECLINED");

    if (parentIsActive && hasOpenItem) {
      return {
        ok: false,
        error: "This stay has an active experience request. Withdraw it before removing this stay.",
      };
    }

    if (hasDecidedHistory) {
      return {
        ok: false,
        error: "This stay has past experience activity and can't be removed. You're welcome to add a new stay instead.",
      };
    }

    requestsSafeToDelete.push(request.id);
  }

  if (requestsSafeToDelete.length > 0) {
    const { error: deleteRequestsError } = await supabase
      .from("booking_requests")
      .delete()
      .in("id", requestsSafeToDelete);
    if (deleteRequestsError) {
      return { ok: false, error: "We couldn't remove this stay. Please try again." };
    }
  }

  const { error: deleteStayError } = await supabase.from("stays").delete().eq("id", stayId).eq("user_id", user.id);
  if (deleteStayError) {
    return { ok: false, error: "We couldn't remove this stay. Please try again." };
  }

  return { ok: true };
}
