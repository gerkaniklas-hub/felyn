/**
 * Content for the eight booking lifecycle emails. The branded HTML comes
 * from src/emails/ (see document.ts); this file decides subject, copy,
 * details and the button for each event.
 *
 * Privacy: only what 0028 snapshots reaches here (title, date, time of day,
 * preferred time, guest count, names, town, structured cancellation reason,
 * and price for guests). No notes, phone numbers, addresses, dietary or
 * occasion data, and no internal ids in visible text — the only id is the
 * item id inside the CTA link, exactly as the app's own URLs use it.
 */
import { getCancelReasonLabel } from "../../matching/booking-status";
import { getPlannedMomentLabel } from "../../matching/plan";
import type { EmailEventType, EmailPayload, EmailPayloadItem } from "../events";
import { renderEmail, type EmailBlock, type EmailDocument, type RenderedEmail } from "./document";

/** "Saturday, 1 June 2030". Dates are calendar dates (no time zone), rendered in UTC so they never shift. */
export function formatEmailDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * Before the host decides, the guest's time is only a preference — the
 * wording must never present it as a confirmed appointment.
 */
function timeLabel(item: EmailPayloadItem, decided: boolean): string {
  const moment = getPlannedMomentLabel(item.plannedMoment);
  if (!item.preferredTime) return moment;
  return decided ? `${moment}, ${item.preferredTime}` : `${moment} (preferred time ${item.preferredTime})`;
}

function guestsLabel(count: number): string {
  return count === 1 ? "1 guest" : `${count} guests`;
}

type ItemDetailOptions = { decided: boolean; showHost: boolean; showPrice: boolean; showGuestName: string | null; stayTown: string | null };

function itemDetails(item: EmailPayloadItem, options: ItemDetailOptions): EmailBlock {
  const rows = [
    { label: "Experience", value: item.title },
    { label: "Date", value: formatEmailDate(item.plannedDate) },
    { label: "Time", value: timeLabel(item, options.decided) },
    { label: "Guests", value: guestsLabel(item.guestCount) },
  ];
  if (options.showGuestName) rows.push({ label: "Guest", value: options.showGuestName });
  if (options.stayTown) rows.push({ label: "Staying in", value: options.stayTown });
  if (options.showHost && item.hostDisplayName) rows.push({ label: "Host", value: item.hostDisplayName });
  if (options.showPrice && item.pricePerPerson != null && item.currency) {
    rows.push({ label: "Estimated price", value: formatMoney(item.pricePerPerson * item.guestCount, item.currency) });
  }
  return { type: "details", rows };
}

function greeting(name: string | null): EmailBlock {
  return { type: "text", text: name ? `Hi ${name},` : "Hi," };
}

/** The structured reason, when it says something useful ("Other" says nothing). Never the free-text note. */
function reasonBlock(payload: EmailPayload): EmailBlock[] {
  if (!payload.cancellationReason || payload.cancellationReason === "OTHER") return [];
  const label = getCancelReasonLabel(payload.cancellationReason);
  return label ? [{ type: "details", rows: [{ label: "Reason given", value: label }] }] : [];
}

function subjectTitle(payload: EmailPayload): string {
  return payload.items.length === 1 ? payload.items[0].title : `${payload.items.length} experiences`;
}

export function buildBookingEmail(type: EmailEventType, payload: EmailPayload, ctaUrl: string): EmailDocument {
  const first = payload.items[0];
  const host = first.hostDisplayName ?? "Your host";
  const guest = payload.guestFirstName ?? "Your guest";
  const many = payload.items.length > 1;

  switch (type) {
    case "request_created_guest":
      return {
        subject: "Request sent – awaiting the host",
        preheader: "Your request has been sent. It is not confirmed yet.",
        blocks: [
          greeting(payload.guestFirstName),
          { type: "heading", text: many ? "Your requests have been sent" : "Your request has been sent" },
          {
            type: "text",
            text: "This is not a confirmation yet. The host will review your request, and we will email you as soon as they respond.",
          },
          ...payload.items.map((item) =>
            itemDetails(item, { decided: false, showHost: true, showPrice: true, showGuestName: null, stayTown: null }),
          ),
          { type: "cta", label: many ? "View your experiences" : "View your request", url: ctaUrl },
        ],
      };

    case "request_created_host":
      return {
        subject: many ? `New requests: ${subjectTitle(payload)}` : `New request: ${first.title}`,
        preheader: `${guest} would like to book with you.`,
        blocks: [
          greeting(first.hostDisplayName),
          { type: "heading", text: many ? "You have new requests" : "You have a new request" },
          { type: "text", text: `${guest} has requested ${many ? "these experiences" : "this experience"}. Please confirm or decline in Felyn.` },
          ...payload.items.map((item) =>
            itemDetails(item, { decided: false, showHost: false, showPrice: false, showGuestName: payload.guestFirstName, stayTown: payload.stayTown }),
          ),
          { type: "cta", label: many ? "Review requests" : "Review request", url: ctaUrl },
        ],
      };

    case "request_confirmed_guest":
      return {
        subject: `You're booked: ${first.title}`,
        preheader: `${host} has confirmed your experience.`,
        blocks: [
          greeting(payload.guestFirstName),
          { type: "heading", text: "Your experience is confirmed" },
          { type: "text", text: `${host} has confirmed your booking.` },
          itemDetails(first, { decided: true, showHost: true, showPrice: true, showGuestName: null, stayTown: null }),
          { type: "cta", label: "View your booking", url: ctaUrl },
        ],
      };

    case "request_declined_guest":
      return {
        subject: `About your ${first.title} request`,
        preheader: "Your host was not able to accept this request.",
        blocks: [
          greeting(payload.guestFirstName),
          { type: "heading", text: "An update on your request" },
          {
            type: "text",
            text: `Unfortunately, ${host === "Your host" ? "your host" : host} is not able to accept this request. You are welcome to choose another time or discover other experiences in Felyn.`,
          },
          itemDetails(first, { decided: false, showHost: true, showPrice: false, showGuestName: null, stayTown: null }),
          { type: "cta", label: "View details", url: ctaUrl },
        ],
      };

    case "booking_cancelled_by_guest_host":
      return {
        subject: `${payload.guestFirstName ?? "A guest"} cancelled ${first.title}`,
        preheader: `${guest} has cancelled their booking.`,
        blocks: [
          greeting(first.hostDisplayName),
          { type: "heading", text: "A guest cancelled their booking" },
          { type: "text", text: `${guest} has cancelled this confirmed booking. The time is free again.` },
          itemDetails(first, { decided: true, showHost: false, showPrice: false, showGuestName: payload.guestFirstName, stayTown: null }),
          ...reasonBlock(payload),
          { type: "cta", label: "View booking", url: ctaUrl },
        ],
      };

    case "booking_cancelled_by_host_guest":
      return {
        subject: `${first.hostDisplayName ?? "Your host"} had to cancel ${first.title}`,
        preheader: `${host} has had to cancel your booking.`,
        blocks: [
          greeting(payload.guestFirstName),
          { type: "heading", text: "Your host had to cancel" },
          {
            type: "text",
            text: `We are sorry: ${host === "Your host" ? "your host" : host} has had to cancel this booking. You are welcome to discover other experiences in Felyn.`,
          },
          itemDetails(first, { decided: true, showHost: true, showPrice: false, showGuestName: null, stayTown: null }),
          ...reasonBlock(payload),
          { type: "cta", label: "View booking", url: ctaUrl },
        ],
      };

    case "booking_cancelled_by_guest_guest":
      return {
        subject: `Cancellation confirmed: ${first.title}`,
        preheader: "Your booking has been cancelled.",
        blocks: [
          greeting(payload.guestFirstName),
          { type: "heading", text: "Your cancellation is confirmed" },
          { type: "text", text: "You have cancelled this booking, and your host has been informed." },
          itemDetails(first, { decided: true, showHost: true, showPrice: false, showGuestName: null, stayTown: null }),
          { type: "cta", label: "View booking", url: ctaUrl },
        ],
      };

    case "booking_cancelled_by_host_host":
      return {
        subject: `Cancellation confirmed: ${first.title}`,
        preheader: "You have cancelled this booking.",
        blocks: [
          greeting(first.hostDisplayName),
          { type: "heading", text: "Your cancellation is confirmed" },
          {
            type: "text",
            text: `You have cancelled this confirmed booking, and ${payload.guestFirstName ?? "your guest"} has been informed.`,
          },
          itemDetails(first, { decided: true, showHost: false, showPrice: false, showGuestName: payload.guestFirstName, stayTown: null }),
          ...reasonBlock(payload),
          { type: "cta", label: "View booking", url: ctaUrl },
        ],
      };
  }
}

export function renderBookingEmail(type: EmailEventType, payload: EmailPayload, ctaUrl: string): Promise<RenderedEmail> {
  return renderEmail(buildBookingEmail(type, payload, ctaUrl));
}
