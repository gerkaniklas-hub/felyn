"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDateRange } from "@/lib/format";
import type { GuestStayOption } from "@/lib/matching/explore";
import type { MatchedExperience } from "@/lib/matching/hard-filter";
import { HOST_NOTE_MAX_LENGTH, PLANNED_MOMENTS, type PlannedMoment } from "@/lib/matching/plan";
import { requestExperience } from "@/lib/matching/request-experience";
import { getGuestCountRange, getTimeOptions, isAvailableAt, isAvailableOnDate } from "@/lib/matching/slot-availability";
import { formatDayLabel } from "@/lib/matching/timeline";
import { todayISODate } from "@/lib/onboarding/stay-dates";


const LOOKAHEAD_DAYS = 365;

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

/**
 * "Request experience": date, time of day, optional preferred time, guests
 * and a note, then (only when one of the guest's stays covers the date) an
 * optional trip to add it to. Only dates and times of day the experience is
 * available for can be chosen; the server (requestExperience) re-checks
 * everything with the planner's rules. Every request needs host approval.
 */
export function RequestExperienceModal({
  experience,
  stays,
  onClose,
}: {
  experience: MatchedExperience;
  stays: GuestStayOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const today = todayISODate();

  // The date picker opens on the first date this experience can be requested.
  const firstAvailableDate = useMemo(() => {
    for (let i = 0; i < LOOKAHEAD_DAYS; i++) {
      const candidate = addDays(today, i);
      if (isAvailableOnDate(experience, candidate)) return candidate;
    }
    return "";
  }, [experience, today]);

  const [date, setDate] = useState(firstAvailableDate);
  const [moment, setMoment] = useState<PlannedMoment | null>(null);
  const [preferredTime, setPreferredTime] = useState("");
  const [note, setNote] = useState("");
  const coveringStays = stays.filter((stay) => date >= stay.checkIn && date < stay.checkOut);
  // A trip covering the date is preselected; "Request without a trip" is always one click away.
  const [stayChoice, setStayChoice] = useState<string>(
    () => stays.find((stay) => firstAvailableDate >= stay.checkIn && firstAvailableDate < stay.checkOut)?.id ?? "none",
  );
  const selectedStay = coveringStays.find((stay) => stay.id === stayChoice) ?? null;

  const range = getGuestCountRange(experience, selectedStay ? selectedStay.guestCount : experience.max_guests);
  const [guests, setGuests] = useState(String(Math.max(range.min, Math.min(2, range.max))));
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const dateAvailable = Boolean(date) && date >= today && isAvailableOnDate(experience, date);
  const timeOptions = date && moment ? (getTimeOptions(experience, date, moment) ?? []) : [];

  function chooseDate(next: string) {
    setDate(next);
    setError(null);
    setPreferredTime("");
    if (moment && !(next && isAvailableAt(experience, next, moment))) setMoment(null);
    const stillCovers = stays.some((stay) => stay.id === stayChoice && next >= stay.checkIn && next < stay.checkOut);
    if (!stillCovers) {
      const firstCovering = stays.find((stay) => next >= stay.checkIn && next < stay.checkOut);
      setStayChoice(firstCovering?.id ?? "none");
    }
  }

  async function submit() {
    setError(null);
    const guestCount = Number(guests);
    if (!dateAvailable) return setError("Choose a date this experience is available.");
    if (!moment) return setError("Choose a time of day.");
    if (!Number.isInteger(guestCount) || guestCount < range.min || guestCount > range.max) {
      return setError(`Choose between ${range.min} and ${range.max} guests.`);
    }
    setSending(true);
    const result = await requestExperience({
      experienceId: experience.id,
      stayId: selectedStay?.id ?? null,
      plannedDate: date,
      plannedMoment: moment,
      guestCount,
      preferredTime: preferredTime || null,
      hostNote: note.trim() || null,
    });
    if (!result.ok) {
      setSending(false);
      setError(result.error);
      return;
    }
    router.push(`/bookings/${result.itemId}`);
  }

  const guestCountNumber = Number(guests);
  const total =
    Number.isInteger(guestCountNumber) && guestCountNumber > 0
      ? formatCurrency(experience.price_per_person * guestCountNumber, experience.currency)
      : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-navy-950/40 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="request-title">
      <div className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-y-auto rounded-t-3xl bg-ivory-50 p-6 shadow-xl sm:rounded-3xl sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase">Request experience</p>
            <h2 id="request-title" className="mt-1 font-display text-2xl text-navy-950">
              {experience.title}
            </h2>
            <p className="mt-1 text-sm text-navy-500">Hosted by {experience.provider.display_name}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-2 text-navy-500 hover:bg-ivory-200">
            <span aria-hidden="true" className="text-xl leading-none">×</span>
          </button>
        </div>

        {!firstAvailableDate ? (
          <p className="mt-6 rounded-xl bg-ivory-100 px-4 py-4 text-sm text-navy-700">
            This experience has no available dates right now. Please check back later.
          </p>
        ) : (
          <div className="mt-6 flex flex-col gap-6">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-navy-700">Date</span>
              <input
                type="date"
                min={today}
                value={date}
                onChange={(event) => chooseDate(event.target.value)}
                className="h-11 rounded-full border border-ivory-400 bg-ivory-50 px-4 text-base text-navy-900"
              />
              {date && !dateAvailable ? (
                <span className="text-sm text-red-600">Not available on {formatDayLabel(date)}. Choose another date.</span>
              ) : null}
            </label>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-navy-700">Time of day</legend>
              <div className="grid grid-cols-3 gap-2">
                {PLANNED_MOMENTS.map((option) => {
                  const available = dateAvailable && isAvailableAt(experience, date, option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={!available}
                      aria-pressed={moment === option.value}
                      onClick={() => {
                        setMoment(option.value);
                        setPreferredTime("");
                        setError(null);
                      }}
                      className={`h-11 rounded-xl border text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        moment === option.value ? "border-navy-900 bg-navy-900 text-ivory-50" : "border-ivory-300 bg-ivory-50 text-navy-700 hover:border-navy-300"
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {timeOptions.length > 0 ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-navy-700">Preferred time (optional)</span>
                <select
                  value={preferredTime}
                  onChange={(event) => setPreferredTime(event.target.value)}
                  className="h-11 rounded-full border border-ivory-400 bg-ivory-50 px-4 text-sm text-navy-900"
                >
                  <option value="">No preference</option>
                  {timeOptions.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-navy-700">Guests</span>
              <input
                type="number"
                inputMode="numeric"
                min={range.min}
                max={range.max}
                value={guests}
                onChange={(event) => setGuests(event.target.value)}
                className="h-11 rounded-full border border-ivory-400 bg-ivory-50 px-4 text-base text-navy-900"
              />
              <span className="text-xs text-navy-500">
                {range.min === range.max ? `${range.min} guests` : `${range.min}–${range.max} guests`}
                {selectedStay ? ` (up to your trip's ${selectedStay.guestCount})` : ""}
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-navy-700">Note to the host (optional)</span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value.slice(0, HOST_NOTE_MAX_LENGTH))}
                rows={3}
                placeholder="Anything the host should know?"
                className="resize-none rounded-card border border-ivory-400 bg-ivory-50 px-4 py-2.5 text-sm text-navy-900 placeholder:text-navy-300"
              />
              <span className="self-end text-xs text-navy-300">
                {note.length}/{HOST_NOTE_MAX_LENGTH}
              </span>
            </label>

            {coveringStays.length > 0 ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-navy-700">Add to a trip</legend>
                {coveringStays.map((stay) => (
                  <label
                    key={stay.id}
                    className="flex cursor-pointer items-start gap-3 rounded-xl border border-ivory-300 px-4 py-3 text-sm text-navy-900 has-[:checked]:border-navy-900"
                  >
                    <input type="radio" name="trip" className="mt-1" checked={stayChoice === stay.id} onChange={() => setStayChoice(stay.id)} />
                    <span className="flex flex-col">
                      <span className="font-medium">{stay.name}</span>
                      <span className="text-navy-500">{formatDateRange(stay.checkIn, stay.checkOut)}</span>
                      <span className="mt-0.5 text-xs text-navy-500">Add to this trip</span>
                    </span>
                  </label>
                ))}
                <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-ivory-300 px-4 py-3 text-sm text-navy-900 has-[:checked]:border-navy-900">
                  <input type="radio" name="trip" checked={stayChoice === "none"} onChange={() => setStayChoice("none")} />
                  Request without a trip
                </label>
              </fieldset>
            ) : null}

            {error ? <p className="text-sm text-red-600">{error}</p> : null}

            <div className="flex flex-col gap-2">
              <Button type="button" onClick={submit} disabled={sending}>
                {sending ? "Sending request…" : "Send request"}
              </Button>
              <p className="text-center text-xs text-navy-500">
                {total ? `Estimated ${total}. ` : ""}The host confirms your request.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
