"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { formatCurrency, formatPrice } from "@/lib/format";
import type { MatchedExperience } from "@/lib/matching/hard-filter";
import { HOST_NOTE_MAX_LENGTH, PLANNED_MOMENTS, type PlannedMoment } from "@/lib/matching/plan";
import {
  getBookableDates,
  getGuestCountRange,
  getTimeOptions,
  isAvailableAt,
} from "@/lib/matching/slot-availability";
import { formatLongDayLabel } from "@/lib/matching/timeline";

export type ExperienceConfig = {
  date: string;
  moment: PlannedMoment;
  /** 'HH:MM' or null for "no preference". */
  preferredTime: string | null;
  guestCount: number;
  hostNote: string;
};

const MOMENT_ORDER: PlannedMoment[] = ["morning", "afternoon", "evening"];

/** Picks a valid moment for the date (keeping `wanted` when the experience offers it), and a valid time for that slot. */
function resolveSlot(
  experience: MatchedExperience,
  date: string,
  wanted: PlannedMoment,
  wantedTime: string | null,
): { moment: PlannedMoment; preferredTime: string | null } {
  const moment = isAvailableAt(experience, date, wanted)
    ? wanted
    : (MOMENT_ORDER.find((m) => isAvailableAt(experience, date, m)) ?? wanted);
  const times = getTimeOptions(experience, date, moment);
  // A previously chosen time survives the moment/date change only if it's
  // still one of the new moment's standard times; otherwise it's cleared —
  // never auto-filled, since an unspecified time is a perfectly normal choice.
  const preferredTime = times && wantedTime && times.includes(wantedTime) ? wantedTime : null;
  return { moment, preferredTime };
}

/**
 * "Configure experience" — the step between "Add to my plan" and the plan
 * itself: date, moment, preferred time, THIS experience's guest count, an
 * optional note for the host, and a live price summary. Only ever stages
 * values back through `onConfirm`; it neither submits a request nor
 * decides conflicts (StayPlanner does both). Every choice is limited to
 * what the experience's own data supports, and the server re-validates all
 * of it independently.
 */
export function ExperienceConfigModal({
  experience,
  stayGuestCount,
  plannableDates,
  initial,
  mode,
  onConfirm,
  onClose,
}: {
  experience: MatchedExperience;
  stayGuestCount: number;
  plannableDates: string[];
  initial: ExperienceConfig;
  mode: "add" | "edit";
  onConfirm: (config: ExperienceConfig) => void;
  onClose: () => void;
}) {
  const bookableDates = getBookableDates(experience, plannableDates);
  const range = getGuestCountRange(experience, stayGuestCount);

  const [config, setConfig] = useState<ExperienceConfig>(() => {
    const date = bookableDates.includes(initial.date) ? initial.date : (bookableDates[0] ?? initial.date);
    const slot = resolveSlot(experience, date, initial.moment, initial.preferredTime);
    return {
      date,
      moment: slot.moment,
      preferredTime: slot.preferredTime,
      guestCount: Math.min(Math.max(initial.guestCount, range.min), range.max),
      hostNote: initial.hostNote,
    };
  });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function changeDate(date: string) {
    const slot = resolveSlot(experience, date, config.moment, config.preferredTime);
    setConfig((prev) => ({ ...prev, date, moment: slot.moment, preferredTime: slot.preferredTime }));
  }

  function changeMoment(moment: PlannedMoment) {
    const slot = resolveSlot(experience, config.date, moment, moment === config.moment ? config.preferredTime : null);
    setConfig((prev) => ({ ...prev, moment: slot.moment, preferredTime: slot.preferredTime }));
  }

  const timeOptions = getTimeOptions(experience, config.date, config.moment);
  const total = experience.price_per_person * config.guestCount;
  const canConfirm = bookableDates.length > 0 && timeOptions !== null && range.max >= range.min;

  return (
    <div className="fixed inset-0 z-[75] flex items-end justify-center bg-navy-950/40 sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Configure ${experience.title}`}
        className="flex max-h-[94dvh] w-full max-w-lg flex-col rounded-t-3xl border border-ivory-300 bg-ivory-50 shadow-xl sm:max-h-[90dvh] sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-ivory-300 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-navy-300">
              {mode === "edit" ? "EDIT YOUR PLAN" : "ADD TO YOUR PLAN"}
            </p>
            <Heading level={3} className="mt-1">
              {experience.title}
            </Heading>
            <p className="text-sm text-navy-500">
              Hosted by {experience.provider.display_name} · {formatPrice(experience.price_per_person, experience.currency)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-11 shrink-0 px-1 text-sm font-medium text-sky-600 hover:text-sky-700"
          >
            Cancel
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-5 sm:px-6">
          {bookableDates.length === 0 ? (
            <p className="rounded-lg bg-gold-100 px-3 py-2 text-sm font-medium text-gold-700">
              This experience isn&apos;t available on any date of your stay.
            </p>
          ) : null}

          <div>
            <label htmlFor="config-date" className="mb-1.5 block text-sm font-medium text-navy-900">
              Date
            </label>
            <select
              id="config-date"
              value={config.date}
              onChange={(event) => changeDate(event.target.value)}
              className="h-11 w-full rounded-xl border border-ivory-400 bg-ivory-50 px-3 text-base text-navy-900"
            >
              {bookableDates.map((date) => (
                <option key={date} value={date}>
                  {formatLongDayLabel(date)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-navy-900">Time of day</p>
            <div role="group" aria-label="Time of day" className="grid grid-cols-3 gap-2">
              {PLANNED_MOMENTS.map((moment) => {
                const offered = isAvailableAt(experience, config.date, moment.value);
                const selected = config.moment === moment.value;
                return (
                  <button
                    key={moment.value}
                    type="button"
                    disabled={!offered}
                    aria-pressed={selected}
                    title={offered ? undefined : "Not offered at this time of day"}
                    onClick={() => changeMoment(moment.value)}
                    className={`h-11 rounded-full border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-40 ${
                      selected
                        ? "border-navy-900 bg-navy-900 text-ivory-50"
                        : "border-navy-300 bg-transparent text-navy-900 hover:bg-ivory-200"
                    }`}
                  >
                    {moment.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="config-time" className="mb-1.5 block text-sm font-medium text-navy-900">
              Preferred time <span className="font-normal text-navy-500">(optional)</span>
            </label>
            <select
              id="config-time"
              value={config.preferredTime ?? ""}
              onChange={(event) =>
                setConfig((prev) => ({ ...prev, preferredTime: event.target.value === "" ? null : event.target.value }))
              }
              className="h-11 w-full rounded-xl border border-ivory-400 bg-ivory-50 px-3 text-base text-navy-900"
            >
              <option value="">No preference</option>
              {(timeOptions ?? []).map((time) => (
                <option key={time} value={time}>
                  {time}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-navy-500">
              Choose your preferred time. The host will review it when confirming your request.
            </p>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-navy-900">Guests for this experience</p>
            <div className="flex items-center gap-4">
              <button
                type="button"
                aria-label="Fewer guests"
                disabled={config.guestCount <= range.min}
                onClick={() => setConfig((prev) => ({ ...prev, guestCount: prev.guestCount - 1 }))}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-navy-300 text-xl text-navy-900 hover:bg-ivory-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                −
              </button>
              <span aria-live="polite" className="min-w-8 text-center font-display text-2xl text-navy-950">
                {config.guestCount}
              </span>
              <button
                type="button"
                aria-label="More guests"
                disabled={config.guestCount >= range.max}
                onClick={() => setConfig((prev) => ({ ...prev, guestCount: prev.guestCount + 1 }))}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-navy-300 text-xl text-navy-900 hover:bg-ivory-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                +
              </button>
            </div>
            <p className="mt-1.5 text-xs text-navy-500">
              This experience takes {experience.min_guests}–{experience.max_guests} guests. Your stay has{" "}
              {stayGuestCount}; choose how many are joining this one.
            </p>
          </div>

          <div>
            <label htmlFor="config-note" className="mb-1.5 block text-sm font-medium text-navy-900">
              Note for the host <span className="font-normal text-navy-500">(optional)</span>
            </label>
            <textarea
              id="config-note"
              value={config.hostNote}
              maxLength={HOST_NOTE_MAX_LENGTH}
              rows={3}
              onChange={(event) => setConfig((prev) => ({ ...prev, hostNote: event.target.value }))}
              placeholder="Anything the host should know? Dietary details, preferences or special requests..."
              className="w-full resize-none rounded-xl border border-ivory-400 bg-ivory-50 px-3 py-2.5 text-base text-navy-900 placeholder:text-navy-300"
            />
            <p className="mt-1 flex justify-between text-xs text-navy-500">
              <span>Only this host will see it.</span>
              <span>
                {config.hostNote.length}/{HOST_NOTE_MAX_LENGTH}
              </span>
            </p>
          </div>

          <dl className="rounded-xl border border-ivory-300 bg-ivory-100 p-4 text-sm">
            <div className="flex justify-between py-0.5">
              <dt className="text-navy-500">Price per person</dt>
              <dd className="text-navy-900">{formatCurrency(experience.price_per_person, experience.currency)}</dd>
            </div>
            <div className="flex justify-between py-0.5">
              <dt className="text-navy-500">Number of guests</dt>
              <dd className="text-navy-900">{config.guestCount}</dd>
            </div>
            <div className="mt-1.5 flex justify-between border-t border-ivory-300 pt-2">
              <dt className="font-medium text-navy-900">Estimated total</dt>
              <dd className="font-display text-lg text-navy-950">{formatCurrency(total, experience.currency)}</dd>
            </div>
          </dl>
        </div>

        <div className="border-t border-ivory-300 px-5 py-4 sm:px-6">
          <Button type="button" className="w-full" disabled={!canConfirm} onClick={() => onConfirm(config)}>
            {mode === "edit" ? "Save changes" : "Add to my plan"}
          </Button>
          <p className="mt-2 text-center text-xs text-navy-500">
            Adding this doesn&apos;t send anything yet — you&apos;ll request it from your plan.
          </p>
        </div>
      </div>
    </div>
  );
}
