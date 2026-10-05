import { StaffTicketList } from "@/components/support/admin/StaffTicketList";
import { parseStatusFilter } from "@/lib/support/admin-format";
import { getStaffStatusCounts, getStaffTicketPage, type StaffTicketCursor } from "@/lib/support/admin-queries";
import { requireStaff } from "@/lib/support/staff";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * /admin/support — the Felyn Support inbox (staff only; everyone else gets a 404).
 * `?status=open|resolved|closed` (default open). Pages of 50, most recent activity
 * first; `?before=&beforeId=` is the keyset cursor for older tickets.
 */
export default async function AdminSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; before?: string; beforeId?: string }>;
}) {
  const { supabase } = await requireStaff();
  const params = await searchParams;
  const status = parseStatusFilter(params.status);
  const cursor: StaffTicketCursor | null =
    params.before && params.beforeId && UUID_PATTERN.test(params.beforeId) && !Number.isNaN(Date.parse(params.before))
      ? { at: params.before, id: params.beforeId }
      : null;

  const [page, counts] = await Promise.all([getStaffTicketPage(supabase, status, cursor), getStaffStatusCounts(supabase)]);

  const olderHref = page?.nextCursor
    ? `/admin/support?${new URLSearchParams({
        status: status.toLowerCase(),
        before: page.nextCursor.at,
        beforeId: page.nextCursor.id,
      }).toString()}`
    : null;

  return <StaffTicketList status={status} counts={counts} page={page} olderHref={olderHref} isOlderPage={cursor !== null} />;
}
