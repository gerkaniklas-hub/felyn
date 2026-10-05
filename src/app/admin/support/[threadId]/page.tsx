import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { StaffTicketWorkspace } from "@/components/support/admin/StaffTicketWorkspace";
import { getItemStatusLabel, NO_TRIP_LINKED_LABEL, type BookingItemStatus } from "@/lib/matching/booking-status";
import { getBookingTimeLabel, type PlannedMoment } from "@/lib/matching/plan";
import {
  formatActivityTime,
  getCustomerDisplayName,
  getCustomerShortName,
  getRequesterRoleLabel,
} from "@/lib/support/admin-format";
import { getStaffTicket } from "@/lib/support/admin-queries";
import { getSupportSubtitle } from "@/lib/support/inbox";
import { requireStaff } from "@/lib/support/staff";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatBookingDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-navy-400">{label}</dt>
      <dd className="text-sm break-words text-navy-900">{children}</dd>
    </div>
  );
}

/**
 * /admin/support/[threadId] — one ticket (staff only; everyone else gets a 404, as
 * does a ticket that doesn't exist). Customer and booking details come live from
 * support_staff_thread_context (0029) — nothing about them is stored on the ticket.
 */
export default async function AdminSupportTicketPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { supabase } = await requireStaff();
  const { threadId } = await params;
  if (!UUID_PATTERN.test(threadId)) notFound();

  const ticket = await getStaffTicket(supabase, threadId);
  if (!ticket) notFound();
  const { context, messages } = ticket;
  const { booking } = context;

  const aside = (
    <>
      <section className="rounded-2xl border border-ivory-300 bg-ivory-50 p-5">
        <h2 className="text-xs font-medium tracking-wide text-navy-300 uppercase">Customer</h2>
        <dl className="mt-3 flex flex-col gap-3">
          <Detail label="Name">{getCustomerDisplayName(context.customer)}</Detail>
          <Detail label="Email">{context.customer.email ?? "—"}</Detail>
          <Detail label="Phone">{context.customer.phone ?? "Not provided"}</Detail>
          <Detail label="Contacted us as">{getRequesterRoleLabel(context.requesterRole)}</Detail>
          {context.customerHostName ? <Detail label="Host profile">{context.customerHostName}</Detail> : null}
        </dl>
      </section>

      {booking ? (
        <section className="rounded-2xl border border-ivory-300 bg-ivory-50 p-5">
          <h2 className="text-xs font-medium tracking-wide text-navy-300 uppercase">Booking</h2>
          <dl className="mt-3 flex flex-col gap-3">
            <Detail label="Experience">{booking.experienceTitle ?? "No longer available"}</Detail>
            {booking.hostName ? <Detail label="Host">{booking.hostName}</Detail> : null}
            {context.requesterRole === "host" && booking.guestFirstName ? (
              <Detail label="Guest">{booking.guestFirstName}</Detail>
            ) : null}
            <Detail label="Date">{formatBookingDate(booking.plannedDate)}</Detail>
            <Detail label="Time">
              {getBookingTimeLabel(booking.plannedMoment as PlannedMoment, booking.preferredTime?.slice(0, 5) ?? null)}
            </Detail>
            <Detail label="Guests">{booking.guestCount}</Detail>
            <Detail label="Booking status">{getItemStatusLabel(booking.status as BookingItemStatus)}</Detail>
            <Detail label="Trip">{booking.stayName ?? NO_TRIP_LINKED_LABEL}</Detail>
          </dl>
        </section>
      ) : null}

      <p className="px-1 text-xs text-navy-400">Started {formatActivityTime(context.createdAt)}</p>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link
          href={`/admin/support?status=${context.status.toLowerCase()}`}
          className="text-sm font-medium text-sky-600 hover:text-sky-700"
        >
          ← Support
        </Link>
        <h1 className="mt-2 font-display text-2xl font-medium tracking-tight text-navy-950">
          {getSupportSubtitle({ category: context.category, isBooking: booking !== null, experienceTitle: booking?.experienceTitle ?? null })}
        </h1>
        <p className="mt-0.5 text-sm text-navy-500">
          {getCustomerDisplayName(context.customer)} · {getRequesterRoleLabel(context.requesterRole)}
        </p>
      </div>
      <StaffTicketWorkspace
        threadId={context.threadId}
        initialStatus={context.status}
        initialMessages={messages}
        customerShortName={getCustomerShortName(context.customer.firstName, context.requesterRole)}
        aside={aside}
      />
    </div>
  );
}
