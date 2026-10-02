import { redirect } from "next/navigation";

/**
 * A booked experience's detail page now lives at /bookings/<itemId>. Kept as
 * a redirect so older notification and message links still open it.
 */
export default async function LegacyBookingDetailPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  redirect(`/bookings/${encodeURIComponent(itemId)}`);
}
