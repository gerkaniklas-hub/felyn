import Link from "next/link";
import { CancelExperienceButton } from "@/components/booking/CancelExperienceButton";
import { WithdrawRequestButton } from "@/components/booking/WithdrawRequestButton";
import { MessageLauncherButton } from "@/components/messaging/MessageLauncherButton";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { GetHelpButton } from "@/components/support/GetHelpButton";
import { ExperienceGallery } from "@/components/planner/ExperienceGallery";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { Eyebrow, PageContainer, textLinkClass } from "@/components/ui/page";
import { formatCurrency } from "@/lib/format";
import {
  getCancelReasonLabel,
  getDeclineReasonLabel,
  getItemStatusLabel,
  getItemStatusTone,
  getMessagingClosedLabel,
  getMessagingOpenCaption,
  getMessagingWindowState,
  NO_TRIP_LINKED_LABEL,
} from "@/lib/matching/booking-status";
import { formatCanaryDeadline } from "@/lib/matching/canary-time";
import { getGuestExperienceDetail } from "@/lib/matching/guest-experiences";
import { getUnreadMessageCount } from "@/lib/messaging/messages";
import { getBookingStartTime, getBookingTimeLabel } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";
import { getOpenGuestSupportThreadId } from "@/lib/support/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PayForBookingButton } from "@/components/booking/PayForBookingButton";
import { PaymentStatusRefresher } from "@/components/booking/PaymentStatusRefresher";
import { getGuestPaymentPanel, parseCheckoutReturn, type GuestAttemptStatus } from "@/lib/payments/lifecycle";
import { getPaymentStartMessage } from "@/lib/payments/messages";
import { canStartCheckoutNow, getServerPayments, isPaymentDeadlinePassed } from "@/lib/payments/server";
import { getCheckoutWindowErrorMessage } from "@/lib/payments/timing";

function humanizeCategory(category: string): string {
  return category.replace(/_/g, " & ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Phase 4/5 of the consolidated improvements: one booking's full detail —
 * the actual associated experience (title, host, description, photos)
 * alongside this specific booking's own date/time/guests/price/status.
 * getGuestExperienceDetail is RLS-scoped to the caller's own
 * booking_request_items (0005) — an itemId for someone else's booking
 * simply resolves to "not found" here, never leaking another guest's data.
 * Reuses the same ExperienceGallery/lightbox the catalogue detail view
 * uses (Phase 7.2) rather than a second photo component.
 *
 * "Get help" contacts the Felyn Team about this booking (the booking is attached
 * automatically); `?help=1` opens it straight away ("Contact Felyn again").
 *
 * Payment (Stripe test mode): while the booking is AWAITING_PAYMENT the guest can pay
 * through Stripe Checkout. `?checkout=success|cancelled` (Stripe's return) only changes
 * the wording: the booking is confirmed solely by the database, from Stripe's verified
 * webhook, and this page shows "processing" until then.
 */
export default async function GuestExperienceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<{ help?: string; checkout?: string }>;
}) {
  const { itemId } = await params;
  const { help, checkout } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const item = await getGuestExperienceDetail(supabase, itemId);

  if (!item) {
    return (
      <div className="flex flex-1 flex-col">
        <GuestNav notifications={<NotificationBell />} />
        <PageContainer measure="reading">
          <Card className="max-w-md">
            <Heading level={2}>Booking not found</Heading>
            <p className="mt-2 text-navy-500">This booking doesn&apos;t exist, or isn&apos;t yours to view.</p>
            <Link href="/experiences" className={`mt-4 inline-block ${textLinkClass}`}>
              ← Back to your experiences
            </Link>
          </Card>
        </PageContainer>
      </div>
    );
  }

  const timeLabel = getBookingTimeLabel(item.plannedMoment, getBookingStartTime(item));
  const total = item.pricePerPerson * item.guestCount;
  const [openSupportThreadId, unreadMessageCount] = await Promise.all([
    getOpenGuestSupportThreadId(supabase, item.id),
    getUnreadMessageCount(supabase, item.id),
  ]);
  // The booking's own guest<->host conversation (0014/0021 decide who may still send).
  const messagingWindow = getMessagingWindowState(item.status, item.decidedAt, item.cancelledAt, item.paymentDueAt);

  // Payment, while the booking awaits it: the database's attempt status decides.
  let paymentPanel: ReturnType<typeof getGuestPaymentPanel> = "none";
  if (item.status === "AWAITING_PAYMENT") {
    const { data: attemptStatus } = await supabase.rpc("booking_payment_guest_status", { p_item_id: item.id });
    paymentPanel = getGuestPaymentPanel({
      status: item.status,
      attemptStatus: (typeof attemptStatus === "string" ? attemptStatus : null) as GuestAttemptStatus,
      checkoutReturn: parseCheckoutReturn(checkout),
      paymentsEnabled: getServerPayments().enabled,
      canStartCheckout: canStartCheckoutNow(item.paymentDueAt),
      deadlinePassed: isPaymentDeadlinePassed(item.paymentDueAt),
    });
  }

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <PageContainer measure="reading">
        <Link href="/experiences" className={`self-start ${textLinkClass}`}>
          ← Back to your experiences
        </Link>

        <div className="mt-6 flex flex-col gap-8">
          {/* A container, so the photo frame widens with the reading column like it does in the detail panel. */}
          <div className="@container">
            <ExperienceGallery images={item.experience?.gallery ?? []} title={item.experienceTitle} />
          </div>

          <div>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <Heading level={1}>{item.experienceTitle}</Heading>
              <Badge tone={getItemStatusTone(item.status)} className="mt-2">
                {getItemStatusLabel(item.status)}
              </Badge>
            </div>
            <p className="mt-3 text-[15px] text-navy-600">
              Hosted by {item.providerDisplayName}
              {item.experience ? ` · ${humanizeCategory(item.experience.category)}` : ""}
            </p>
          </div>

          <Card>
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
              <div>
                <Eyebrow>Date</Eyebrow>
                <p className="mt-1.5 text-[15px] font-medium text-navy-900">{formatDayLabel(item.plannedDate)}</p>
              </div>
              <div>
                <Eyebrow>{item.status === "REQUESTED" ? "Requested time" : "Time"}</Eyebrow>
                <p className="mt-1.5 text-[15px] font-medium text-navy-900">{timeLabel}</p>
              </div>
              <div>
                <Eyebrow>Guests</Eyebrow>
                <p className="mt-1.5 text-[15px] font-medium text-navy-900">{item.guestCount}</p>
              </div>
              <div>
                <Eyebrow>{item.status === "CONFIRMED" ? "Total" : "Estimated total"}</Eyebrow>
                <p className="mt-1.5 text-[15px] font-medium text-navy-900">{formatCurrency(total, item.currency)}</p>
              </div>
            </div>
            <p className="mt-5 border-t border-ivory-300 pt-4 text-sm text-navy-500">
              {item.stayPropertyName ?? NO_TRIP_LINKED_LABEL}
            </p>
          </Card>

          {/* Booking actions sit with the booking itself; support ("Get help") stays a separate section below. */}
          <div className="flex flex-wrap items-center gap-3">
            <MessageLauncherButton
              label="Message host"
              unreadCount={unreadMessageCount}
              className={buttonClasses({ variant: "secondary", size: "sm" })}
              handle={{
                itemId: item.id,
                otherParticipant: {
                  label: item.providerDisplayName,
                  imageUrl: item.providerPhotoUrl,
                  providerId: item.providerId,
                },
                experienceTitle: item.experienceTitle,
                experienceImageUrl: item.experienceImageUrl,
                bookingHref: `/bookings/${item.id}`,
                canSend: messagingWindow.canSend,
                closedLabel: getMessagingClosedLabel(item.status, messagingWindow),
                openCaption: getMessagingOpenCaption(messagingWindow),
              }}
            />
            {item.status === "REQUESTED" ? <WithdrawRequestButton itemId={item.id} /> : null}
          </div>

          {item.experience?.description || item.experience?.shortDescription ? (
            <p className="text-base leading-relaxed text-navy-700">
              {item.experience.description ?? item.experience.shortDescription}
            </p>
          ) : !item.experience ? (
            <p className="text-sm text-navy-400">
              This experience&apos;s full details are no longer available, but your booking record is preserved above.
            </p>
          ) : null}

          {item.hostNote ? (
            <p className="text-sm text-navy-600">
              <span className="font-medium text-navy-800">Your note to the host:</span> {item.hostNote}
            </p>
          ) : null}

          {item.status === "AWAITING_PAYMENT" ? (
            <div className="flex flex-col gap-3 rounded-xl bg-sky-50 px-4 py-4 text-sm text-navy-700">
              {paymentPanel === "processing" ? (
                <>
                  <p>
                    Thanks — we&apos;re confirming your payment with our payment provider. Your booking is confirmed only once
                    this page says so; it updates by itself.
                  </p>
                  <PaymentStatusRefresher />
                </>
              ) : paymentPanel === "deadline_passed" ? (
                <p>
                  The payment deadline
                  {item.paymentDueAt ? <> ({formatCanaryDeadline(item.paymentDueAt)}, Tenerife time)</> : null} has passed, so
                  this booking can no longer be paid or confirmed. It will be marked as expired.
                </p>
              ) : (
                <p>
                  Your host accepted this request. It isn&apos;t confirmed until you pay
                  {item.paymentDueAt ? <> — payment is due by {formatCanaryDeadline(item.paymentDueAt)} (Tenerife time)</> : null}.
                </p>
              )}
              {paymentPanel === "pay" || paymentPanel === "pay_after_cancel" ? (
                <>
                  {paymentPanel === "pay_after_cancel" ? <p>Your payment wasn&apos;t completed. You can try again.</p> : null}
                  <PayForBookingButton itemId={item.id} label={`Pay ${formatCurrency(total, item.currency)}`} />
                  <p className="text-xs text-navy-500">
                    Secure payment by Stripe (test mode — no real card is charged). Your card is authorized now and charged
                    once your booking is confirmed.
                  </p>
                </>
              ) : null}
              {paymentPanel === "too_late" ? <p>{getCheckoutWindowErrorMessage("too_late_to_start_checkout")}</p> : null}
              {paymentPanel === "needs_support" ? <p>{getPaymentStartMessage("needs_support")}</p> : null}
              {paymentPanel === "unavailable" ? (
                <p className="text-navy-500">Online payment isn&apos;t available yet.</p>
              ) : null}
            </div>
          ) : null}
          {item.status === "PAYMENT_EXPIRED" ? (
            <p className="text-sm text-navy-500">
              Payment wasn&apos;t completed by the deadline, so this booking wasn&apos;t confirmed and the time is no longer reserved.
            </p>
          ) : null}
          {item.status === "DECLINED" && item.declineReason ? (
            <p className="text-sm text-navy-500">Declined: {getDeclineReasonLabel(item.declineReason)}</p>
          ) : null}
          {item.status === "CANCELLED" ? (
            <p className="text-sm text-navy-500">
              Cancelled by {item.cancelledBy === "provider" ? "the host" : "you"}
              {item.cancellationReason ? ` · Reason: ${getCancelReasonLabel(item.cancellationReason)}` : ""}
              {item.cancellationNote ? ` · "${item.cancellationNote}"` : ""}
            </p>
          ) : null}

          <div className="flex flex-col gap-2 border-t border-ivory-300 pt-5">
            <p className="text-sm text-navy-600">Questions or a problem with this booking? The Felyn Team is here to help.</p>
            <GetHelpButton
              bookingItemId={item.id}
              booking={{
                experienceTitle: item.experienceTitle,
                dateLabel: formatDayLabel(item.plannedDate),
                timeLabel,
                guestCount: item.guestCount,
              }}
              existingThreadId={openSupportThreadId}
              initialOpen={help === "1"}
            />
          </div>

          {item.status === "CONFIRMED" ? <CancelExperienceButton itemId={item.id} stayId={item.stayId ?? undefined} /> : null}
        </div>
      </PageContainer>
    </div>
  );
}
