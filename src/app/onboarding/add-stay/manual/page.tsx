import { redirect } from "next/navigation";

/**
 * The old "Enter manually" form now lives at /onboarding/add-stay (the
 * simplified one-form Add a stay). Kept as a redirect, including `?stay=`
 * for editing, so older links still land in the right place.
 */
export default async function ManualStayPage({ searchParams }: { searchParams: Promise<{ stay?: string }> }) {
  const { stay } = await searchParams;
  redirect(stay ? `/onboarding/add-stay?stay=${encodeURIComponent(stay)}` : "/onboarding/add-stay");
}
