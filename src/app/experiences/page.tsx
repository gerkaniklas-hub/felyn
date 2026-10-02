import { redirect } from "next/navigation";

/**
 * The cross-stay experiences overview (Upcoming / Past / Cancelled tabs)
 * now lives on My trips (/trips). This route stays as a redirect so older
 * links and bookmarks keep working; each booking's own detail page
 * (/experiences/[itemId]) is unchanged.
 */
export default function GuestExperiencesPage() {
  redirect("/trips");
}
