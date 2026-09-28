"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { Button } from "@/components/ui/button";
import { getProviderProfileAction, type RecommendedExperience } from "@/lib/matching/actions";
import {
  getGuestItemStatusLabel,
  isSlotOccupyingStatus,
} from "@/lib/matching/booking-status";
import { withdrawBookingRequestItem, type ActiveBookingRequest } from "@/lib/matching/booking-requests";
import {
  countActiveFilters,
  createDefaultDiscoveryFilters,
  experienceMatchesFilters,
  getPriceBounds,
  type DiscoveryFiltersState,
} from "@/lib/matching/discovery-filters";
import type { ProviderProfile } from "@/lib/matching/provider-profile";
import {
  PLANNED_MOMENTS,
  findConflictingSelectionIds,
  getPlannableDates,
  getPlannedMomentLabel,
  type PlannedMoment,
  type PlanSelection,
} from "@/lib/matching/plan";
import { isAvailableAt } from "@/lib/matching/slot-availability";
import { formatDayLabel } from "@/lib/matching/timeline";
import { ExperienceConfigModal, type ExperienceConfig } from "./ExperienceConfigModal";
import { ExperienceFocus, type FocusPlanEntry } from "./ExperienceFocus";
import { ExperienceResultList, type ResultCardData } from "./ExperienceResultList";
import { FilterDrawer } from "./FilterDrawer";
import { MomentTabs } from "./MomentTabs";
import { PlanReview } from "./PlanReview";
import { PlanStatus } from "./PlanStatus";
import { PlanSummary, type PlanItem } from "./PlanSummary";
import { ProviderFocus } from "./ProviderFocus";
import { RequestedItemCard } from "./RequestedItemCard";
import { StayDateStrip, EMPTY_DATE_SUMMARY, type DateSummary, type PlannerStay } from "./StayDateStrip";
import type { StayDay } from "@/lib/matching/timeline";

type FocusState =
  | { type: "none" }
  | { type: "experience"; experienceId: string }
  | { type: "provider"; experienceId: string; providerId: string };

/** The configuration step: adding a new experience, or editing a not-yet-requested one already in the plan. */
type ConfigState = { experienceId: string; editSelectionId: string | null };

export type StayPlannerProps = {
  stay: PlannerStay;
  /** M5.2-ranked suggestions, with real AI reasons. */
  recommendations: RecommendedExperience[];
  /** The rest of the M5.1-eligible pool (reason "") — never a new AI call. */
  alternatives: RecommendedExperience[];
  /** The stay's dates (arrival … departure). Only the dates are used here. */
  timeline: StayDay[];
  loadFailed: boolean;
  /** The stay's current active (REQUESTED/CONFIRMED) request, or null. Requested items stay live here; the guest can keep adding more. */
  activeRequest: ActiveBookingRequest | null;
  /** Unread messages per booking_request_items.id, from the OTHER participant — see lib/messaging/messages.ts. */
  unreadMessageCounts: Record<string, number>;
};

function makeSelectionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type SlotConflict = { occupyingTitle: string; date: string; moment: PlannedMoment; onConfirm: () => void };

type WithdrawItemState =
  | { status: "idle" }
  | { status: "confirming"; selectionId: string }
  | { status: "pending"; selectionId: string }
  | { status: "error"; selectionId: string; message: string };

/**
 * The Stay Planner. The guest picks a DATE (compact strip), then a MOMENT,
 * and sees the experiences available for that slot; "View details" →
 * "Add to my plan" → a configuration step (date, moment, preferred time,
 * this experience's own guest count, note for the host) stages it in the
 * plan. The plan is two things merged:
 *
 *  - DRAFTS: `selections`, client state — added but not yet requested.
 *  - REQUEST ITEMS: `activeRequest.items`, straight from the database, each
 *    with its own status (awaiting / confirmed / declined / withdrawn).
 *
 * Requesting always sends only the drafts; the server appends them to the
 * stay's single active request (see submitBookingRequest), so a guest can
 * keep planning after an earlier request without disturbing it. Nothing is
 * globally "locked" any more — only individual items are, by their own
 * status (confirmed = locked, awaiting = withdrawable, declined/withdrawn =
 * slot free again).
 *
 * M6.6 note kept: the plan is keyed by each item's OWN id, never by
 * experience id — the same experience can be planned on two dates.
 */
export function StayPlanner({
  stay,
  recommendations,
  alternatives,
  timeline,
  loadFailed,
  activeRequest,
  unreadMessageCounts,
}: StayPlannerProps) {
  const router = useRouter();
  const [selections, setSelections] = useState<PlanSelection[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [focus, setFocus] = useState<FocusState>({ type: "none" });
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [providerProfiles, setProviderProfiles] = useState<Record<string, ProviderProfile | "loading" | null>>({});
  const [slotConflict, setSlotConflict] = useState<SlotConflict | null>(null);
  const [withdrawItemState, setWithdrawItemState] = useState<WithdrawItemState>({ status: "idle" });
  /** Marketplace filters — narrow the already-loaded eligible pool client-side; never re-fetched or re-ranked. Kept across date/moment changes. */
  const [filters, setFilters] = useState<DiscoveryFiltersState>(createDefaultDiscoveryFilters());
  /** Where the results list was scrolled to when a detail panel opened, so "back" returns to the same spot. */
  const [savedScroll, setSavedScroll] = useState(0);

  const dates = useMemo(() => timeline.map((day) => day.date), [timeline]);
  const plannableDates = useMemo(() => getPlannableDates(timeline), [timeline]);
  const [selectedDate, setSelectedDate] = useState(plannableDates[0] ?? dates[0] ?? "");
  const [selectedMoment, setSelectedMoment] = useState<PlannedMoment>("evening");

  const combinedPool = useMemo(() => [...recommendations, ...alternatives], [recommendations, alternatives]);
  const priceBounds = useMemo(() => getPriceBounds(combinedPool.map((item) => item.experience)), [combinedPool]);
  const activeFilterCount = countActiveFilters(filters, priceBounds);

  const experienceById = useMemo(() => {
    const map = new Map<string, RecommendedExperience>();
    for (const item of combinedPool) map.set(item.experience.id, item);
    return map;
  }, [combinedPool]);

  const currency = combinedPool[0]?.experience.currency ?? "EUR";

  // Every item in the plan, drafts and persisted request items alike.
  const planItems: PlanItem[] = useMemo(() => {
    const items: PlanItem[] = [];
    for (const item of activeRequest?.items ?? []) {
      const recommendation = experienceById.get(item.experienceId);
      if (!recommendation) continue;
      items.push({
        selectionId: item.id,
        recommendation,
        slot: { date: item.plannedDate, moment: item.plannedMoment },
        status: item.status,
        guestCount: item.guestCount,
        pricePerPerson: item.pricePerPerson,
        preferredTime: item.preferredTime,
        hostNote: item.hostNote ?? "",
        declineReason: item.declineReason,
        decidedAt: item.decidedAt,
        cancelledAt: item.cancelledAt,
      });
    }
    for (const selection of selections) {
      const recommendation = experienceById.get(selection.experienceId);
      if (!recommendation) continue;
      items.push({
        selectionId: selection.selectionId,
        recommendation,
        slot: selection.slot,
        status: "DRAFT",
        guestCount: selection.guestCount,
        pricePerPerson: recommendation.experience.price_per_person,
        preferredTime: selection.preferredTime,
        hostNote: selection.hostNote,
        declineReason: null,
        decidedAt: null,
        cancelledAt: null,
      });
    }
    return items;
  }, [activeRequest, selections, experienceById]);

  // Items that currently HOLD their date+moment. Declined and withdrawn ones
  // don't — that's what makes their slot available for discovery again.
  const occupyingItems = useMemo(
    () => planItems.filter((item) => isSlotOccupyingStatus(item.status)),
    [planItems],
  );

  const conflictingSelectionIds = useMemo(
    () => findConflictingSelectionIds(occupyingItems.map((item) => ({ selectionId: item.selectionId, slot: item.slot }))),
    [occupyingItems],
  );

  const dateSummaries = useMemo(() => {
    const map = new Map<string, DateSummary>();
    for (const item of planItems) {
      const summary = { ...(map.get(item.slot.date) ?? EMPTY_DATE_SUMMARY) };
      if (item.status === "CONFIRMED") summary.confirmed += 1;
      else if (item.status === "REQUESTED") summary.awaiting += 1;
      else if (item.status === "DRAFT") summary.draft += 1;
      else if (item.status === "DECLINED") summary.declined += 1;
      map.set(item.slot.date, summary);
    }
    return map;
  }, [planItems]);

  const occupiedMoments = useMemo(
    () =>
      new Set(occupyingItems.filter((item) => item.slot.date === selectedDate).map((item) => item.slot.moment)),
    [occupyingItems, selectedDate],
  );

  const requestedTotal = activeRequest?.estimatedTotal ?? 0;
  const draftTotal = planItems
    .filter((item) => item.status === "DRAFT")
    .reduce((sum, item) => sum + item.pricePerPerson * item.guestCount, 0);
  const planTotal = requestedTotal + draftTotal;

  function findOccupyingAt(date: string, moment: PlannedMoment, excludeSelectionId?: string): PlanItem | undefined {
    return occupyingItems.find(
      (item) => item.selectionId !== excludeSelectionId && item.slot.date === date && item.slot.moment === moment,
    );
  }

  // ── discovery for the selected date + moment ──────────────────────────────
  const slotFilter = (item: RecommendedExperience) =>
    isAvailableAt(item.experience, selectedDate, selectedMoment) &&
    experienceMatchesFilters(item.experience, filters, priceBounds);
  const availableForSlot = combinedPool.filter((item) => isAvailableAt(item.experience, selectedDate, selectedMoment));
  const visibleRecommended = recommendations.filter(slotFilter);
  const visibleMore = alternatives.filter(slotFilter);
  const visibleCount = visibleRecommended.length + visibleMore.length;

  const momentsWithResults = PLANNED_MOMENTS.filter(
    (moment) =>
      moment.value !== selectedMoment &&
      combinedPool.some(
        (item) =>
          isAvailableAt(item.experience, selectedDate, moment.value) &&
          experienceMatchesFilters(item.experience, filters, priceBounds),
      ),
  );

  function buildResultCards(items: RecommendedExperience[]): ResultCardData[] {
    return items.map((item) => {
      const inSlot = occupyingItems.find(
        (planItem) =>
          planItem.recommendation.experience.id === item.experience.id &&
          planItem.slot.date === selectedDate &&
          planItem.slot.moment === selectedMoment,
      );
      const label = `${formatDayLabel(selectedDate)} · ${getPlannedMomentLabel(selectedMoment)}`;
      return {
        key: item.experience.id,
        experience: item.experience,
        reason: item.reason,
        selected: Boolean(inSlot),
        plannedLabel: inSlot
          ? inSlot.status === "DRAFT"
            ? `In your plan · ${label}`
            : `${getGuestItemStatusLabel(inSlot.status)} · ${label}`
          : null,
        conflict: inSlot ? conflictingSelectionIds.has(inSlot.selectionId) : false,
        onOpen: () => openExperience(item.experience.id),
      };
    });
  }

  // ── navigation ────────────────────────────────────────────────────────────
  function scrollToId(id: string) {
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /** "Explore experiences →" / "Explore alternatives →": select that slot and show its discovery results. */
  function exploreSlot(date: string, moment: PlannedMoment) {
    setSelectedDate(date);
    setSelectedMoment(moment);
    setFocus({ type: "none" });
    setReviewOpen(false);
    scrollToId("discover-results");
  }

  function openExperience(experienceId: string) {
    setSavedScroll(window.scrollY);
    setFocus({ type: "experience", experienceId });
    window.scrollTo({ top: 0 });
  }

  function closeFocus() {
    setFocus({ type: "none" });
    requestAnimationFrame(() => window.scrollTo({ top: savedScroll }));
  }

  async function openProvider(providerId: string, experienceId: string) {
    setFocus({ type: "provider", providerId, experienceId });
    if (providerProfiles[providerId] === undefined) {
      setProviderProfiles((prev) => ({ ...prev, [providerId]: "loading" }));
      const profile = await getProviderProfileAction(providerId);
      setProviderProfiles((prev) => ({ ...prev, [providerId]: profile }));
    }
  }

  function closeProvider() {
    setFocus((prev) => (prev.type === "provider" ? { type: "experience", experienceId: prev.experienceId } : prev));
  }

  // ── adding / editing a draft ──────────────────────────────────────────────
  function startAdd(experienceId: string) {
    setConfig({ experienceId, editSelectionId: null });
  }

  function startEdit(selectionId: string) {
    const draft = selections.find((s) => s.selectionId === selectionId);
    if (!draft) return;
    setConfig({ experienceId: draft.experienceId, editSelectionId: selectionId });
  }

  function removeDraft(selectionId: string) {
    setSelections((prev) => prev.filter((s) => s.selectionId !== selectionId));
  }

  /**
   * Stages the configured experience. Landing on an already-occupied
   * date+moment asks for explicit confirmation first — never a silent
   * replace, never a new conflict model (P1.4 §4).
   */
  function confirmConfig(values: ExperienceConfig) {
    if (!config) return;
    const { experienceId, editSelectionId } = config;
    const slot = { date: values.date, moment: values.moment };

    const apply = () => {
      if (editSelectionId) {
        setSelections((prev) =>
          prev.map((s) =>
            s.selectionId === editSelectionId
              ? { ...s, slot, guestCount: values.guestCount, preferredTime: values.preferredTime, hostNote: values.hostNote }
              : s,
          ),
        );
      } else {
        setSelections((prev) => [
          ...prev,
          {
            selectionId: makeSelectionId(),
            experienceId,
            slot,
            guestCount: values.guestCount,
            preferredTime: values.preferredTime,
            hostNote: values.hostNote,
          },
        ]);
      }
      setConfig(null);
      setSelectedDate(values.date);
      setSelectedMoment(values.moment);
      setFocus({ type: "none" });
      scrollToId("slot-plan");
    };

    const occupying = findOccupyingAt(values.date, values.moment, editSelectionId ?? undefined);
    if (occupying) {
      setSlotConflict({
        occupyingTitle: occupying.recommendation.experience.title,
        date: values.date,
        moment: values.moment,
        onConfirm: apply,
      });
      return;
    }
    apply();
  }

  // ── request lifecycle ─────────────────────────────────────────────────────
  /** After a confirmed WHOLE-request withdrawal, carry what was requested back into the (now editable) plan as drafts — no data loss. */
  function handleWithdrawn() {
    const carried: PlanSelection[] = (activeRequest?.items ?? [])
      .filter((item) => item.status === "REQUESTED" || item.status === "CONFIRMED")
      .map((item) => ({
        selectionId: makeSelectionId(),
        experienceId: item.experienceId,
        slot: { date: item.plannedDate, moment: item.plannedMoment },
        guestCount: item.guestCount,
        preferredTime: item.preferredTime,
        hostNote: item.hostNote ?? "",
      }));
    setSelections((prev) => [...prev, ...carried]);
    setReviewOpen(false);
    router.refresh();
  }

  /** After items are requested, the drafts are now request items — clear them and refetch so `activeRequest` picks them up. */
  function handleSubmitted() {
    setSelections([]);
    router.refresh();
  }

  function requestWithdrawItem(selectionId: string) {
    setWithdrawItemState({ status: "confirming", selectionId });
  }

  async function confirmWithdrawItem() {
    if (withdrawItemState.status === "idle") return;
    const { selectionId } = withdrawItemState;
    setWithdrawItemState({ status: "pending", selectionId });
    const result = await withdrawBookingRequestItem(selectionId);
    if (!result.ok) {
      setWithdrawItemState({ status: "error", selectionId, message: result.error });
      return;
    }
    setWithdrawItemState({ status: "idle" });
    router.refresh();
  }

  // ── derived view data ─────────────────────────────────────────────────────
  const focusedRecommendation = focus.type !== "none" ? experienceById.get(focus.experienceId) : undefined;

  const focusEntries: FocusPlanEntry[] = focusedRecommendation
    ? planItems
        .filter(
          (item) =>
            item.recommendation.experience.id === focusedRecommendation.experience.id &&
            item.status !== "WITHDRAWN" &&
            item.status !== "CANCELLED",
        )
        .map((item) => ({
          selectionId: item.selectionId,
          label: `${formatDayLabel(item.slot.date)} · ${getPlannedMomentLabel(item.slot.moment)} · ${item.guestCount} guest${
            item.guestCount === 1 ? "" : "s"
          }`,
          status: item.status,
          declineReason: item.declineReason,
          conflict: conflictingSelectionIds.has(item.selectionId),
          onEdit: item.status === "DRAFT" ? () => startEdit(item.selectionId) : undefined,
          onRemove: item.status === "DRAFT" ? () => removeDraft(item.selectionId) : undefined,
        }))
    : [];

  const slotItems = planItems.filter(
    (item) => item.slot.date === selectedDate && item.slot.moment === selectedMoment,
  );
  const slotOccupying = slotItems.filter((item) => isSlotOccupyingStatus(item.status));
  const slotDeclined = slotItems.filter((item) => item.status === "DECLINED");

  const configExperience = config ? experienceById.get(config.experienceId)?.experience : undefined;
  const editingDraft = config?.editSelectionId
    ? selections.find((s) => s.selectionId === config.editSelectionId)
    : undefined;

  const withdrawingItem =
    withdrawItemState.status !== "idle"
      ? planItems.find((item) => item.selectionId === withdrawItemState.selectionId)
      : undefined;

  const slotLabel = `${formatDayLabel(selectedDate)} · ${getPlannedMomentLabel(selectedMoment)}`;

  const focusView =
    focus.type !== "none" && focusedRecommendation ? (
      <div className={`grid grid-cols-1 gap-6 ${focus.type === "provider" ? "lg:grid-cols-2" : "lg:mx-auto lg:max-w-3xl"}`}>
        <div className="fixed inset-0 z-40 overflow-y-auto bg-ivory-100 p-4 lg:static lg:inset-auto lg:z-auto lg:bg-transparent lg:p-0">
          <ExperienceFocus
            recommendation={focusedRecommendation}
            compact={focus.type === "provider"}
            plannedEntries={focusEntries}
            closeLabel="← Back to experiences"
            onAddToPlan={() => startAdd(focus.experienceId)}
            onOpenProvider={() => openProvider(focusedRecommendation.experience.provider_id, focus.experienceId)}
            onClose={closeFocus}
          />
        </div>
        {focus.type === "provider" ? (
          <div className="fixed inset-0 z-50 overflow-y-auto bg-ivory-100 p-4 lg:static lg:inset-auto lg:z-auto lg:bg-transparent lg:p-0">
            <ProviderFocus
              profile={providerProfiles[focus.providerId] ?? "loading"}
              providerName={focusedRecommendation.experience.provider.display_name}
              onClose={closeProvider}
            />
          </div>
        ) : null}
      </div>
    ) : null;

  return (
    <div className="relative">
      {focusView ?? (
        <div className="flex max-w-4xl flex-col gap-6 pb-28">
          <div>
            <p className="text-xs font-medium tracking-wide text-navy-300">YOUR FELYN PLAN</p>
            <div className="mt-2">
              <PlanStatus
                stage={activeRequest?.status ?? "plan"}
                itemStatuses={activeRequest?.items.map((item) => item.status)}
              />
            </div>
            <Heading level={2} className="mt-3">
              {activeRequest ? "Your plan, and what’s next." : "Bring something special to the table."}
            </Heading>
            <p className="mt-2 max-w-xl text-navy-500">
              Pick a date and a time of day, see what&apos;s available, and add experiences one at a time
              {activeRequest ? " — your requested ones stay exactly as they are." : "."}
            </p>
          </div>

          {loadFailed ? (
            <Card className="max-w-md text-center">
              <p className="text-navy-700">We couldn&apos;t put your plan together right now. Please try again shortly.</p>
            </Card>
          ) : (
            <>
              <StayDateStrip
                stay={stay}
                dates={dates}
                selectedDate={selectedDate}
                summaries={dateSummaries}
                onSelect={setSelectedDate}
              />

              <MomentTabs
                date={selectedDate}
                selected={selectedMoment}
                occupied={occupiedMoments}
                onSelect={setSelectedMoment}
              />

              <section id="slot-plan" aria-label={`Your plan for ${slotLabel}`} className="scroll-mt-6">
                <p className="mb-2 text-xs font-medium tracking-wide text-navy-300">YOUR PLAN · {slotLabel.toUpperCase()}</p>
                <div className="flex flex-col gap-3">
                  {[...slotOccupying, ...slotDeclined].map((item) => (
                    <RequestedItemCard
                      key={item.selectionId}
                      experience={item.recommendation.experience}
                      slot={item.slot}
                      status={item.status}
                      declineReason={item.declineReason}
                      decidedAt={item.decidedAt}
                      cancelledAt={item.cancelledAt}
                      guestCount={item.guestCount}
                      pricePerPerson={item.pricePerPerson}
                      preferredTime={item.preferredTime}
                      hostNote={item.hostNote}
                      currency={currency}
                      conflict={conflictingSelectionIds.has(item.selectionId)}
                      itemId={item.status === "DRAFT" ? null : item.selectionId}
                      bookingHref={`/recommendations?stay=${stay.id}`}
                      unreadMessageCount={unreadMessageCounts[item.selectionId] ?? 0}
                      onOpen={() => openExperience(item.recommendation.experience.id)}
                      onWithdraw={item.status === "REQUESTED" ? () => requestWithdrawItem(item.selectionId) : undefined}
                      onEdit={item.status === "DRAFT" ? () => startEdit(item.selectionId) : undefined}
                      onRemove={item.status === "DRAFT" ? () => removeDraft(item.selectionId) : undefined}
                      onExplore={item.status === "DECLINED" ? () => exploreSlot(item.slot.date, item.slot.moment) : undefined}
                    />
                  ))}
                  {slotOccupying.length === 0 && slotDeclined.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-ivory-300 bg-ivory-50/60 px-5 py-5 text-center">
                      <p className="text-navy-500">Nothing planned yet.</p>
                      <button
                        type="button"
                        onClick={() => exploreSlot(selectedDate, selectedMoment)}
                        className="mt-1 h-11 text-sm font-medium text-sky-600 hover:text-sky-700"
                      >
                        Explore experiences →
                      </button>
                    </div>
                  ) : null}
                </div>
              </section>

              <section id="discover-results" aria-label={`Experiences for ${slotLabel}`} className="scroll-mt-6">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs font-medium tracking-wide text-navy-300">
                    EXPERIENCES FOR {slotLabel.toUpperCase()}
                  </p>
                  <FilterDrawer
                    filters={filters}
                    onFiltersChange={setFilters}
                    onClear={() => setFilters(createDefaultDiscoveryFilters())}
                    activeCount={activeFilterCount}
                    priceBounds={priceBounds}
                    currency={currency}
                    resultCount={visibleCount}
                  />
                </div>

                {combinedPool.length === 0 ? (
                  <Card className="max-w-md text-center">
                    <p className="text-navy-700">
                      We don&apos;t have experiences that fit this stay yet — check back soon as more hosts join Felyn.
                    </p>
                  </Card>
                ) : visibleCount === 0 ? (
                  <Card className="max-w-md text-center">
                    {availableForSlot.length === 0 ? (
                      <p className="text-navy-700">No experiences are available for {slotLabel} with your stay details.</p>
                    ) : (
                      <p className="text-navy-700">No experiences match these filters for {slotLabel}.</p>
                    )}
                    {momentsWithResults.length > 0 ? (
                      <div className="mt-3 flex flex-wrap justify-center gap-x-4">
                        {momentsWithResults.map((moment) => (
                          <button
                            key={moment.value}
                            type="button"
                            onClick={() => setSelectedMoment(moment.value)}
                            className="h-11 text-sm font-medium text-sky-600 hover:text-sky-700"
                          >
                            Try {moment.label.toLowerCase()} →
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {activeFilterCount > 0 ? (
                      <Button
                        type="button"
                        variant="secondary"
                        className="mt-2"
                        onClick={() => setFilters(createDefaultDiscoveryFilters())}
                      >
                        Reset filters
                      </Button>
                    ) : null}
                  </Card>
                ) : (
                  <ExperienceResultList
                    recommended={buildResultCards(visibleRecommended)}
                    moreIdeas={buildResultCards(visibleMore)}
                  />
                )}
              </section>
            </>
          )}
        </div>
      )}

      <PlanSummary
        items={planItems}
        estimatedTotal={planTotal}
        currency={currency}
        hasConflicts={conflictingSelectionIds.size > 0}
        onReview={() => setReviewOpen(true)}
      />

      {reviewOpen ? (
        <PlanReview
          stay={stay}
          items={planItems}
          requestedTotal={requestedTotal}
          draftTotal={draftTotal}
          currency={currency}
          conflictingIds={conflictingSelectionIds}
          activeRequest={activeRequest ? { id: activeRequest.id, status: activeRequest.status } : null}
          onEditDraft={startEdit}
          onRemoveDraft={removeDraft}
          onClose={() => setReviewOpen(false)}
          onSubmitted={handleSubmitted}
          onWithdrawn={handleWithdrawn}
          onWithdrawItem={requestWithdrawItem}
          onExplore={exploreSlot}
        />
      ) : null}

      {config && configExperience ? (
        <ExperienceConfigModal
          key={`${config.experienceId}:${config.editSelectionId ?? "new"}`}
          experience={configExperience}
          stayGuestCount={stay.guest_count}
          plannableDates={plannableDates}
          mode={config.editSelectionId ? "edit" : "add"}
          initial={
            editingDraft
              ? {
                  date: editingDraft.slot.date,
                  moment: editingDraft.slot.moment,
                  preferredTime: editingDraft.preferredTime,
                  guestCount: editingDraft.guestCount,
                  hostNote: editingDraft.hostNote,
                }
              : {
                  date: selectedDate,
                  moment: selectedMoment,
                  preferredTime: null,
                  guestCount: stay.guest_count,
                  hostNote: "",
                }
          }
          onConfirm={confirmConfig}
          onClose={() => setConfig(null)}
        />
      ) : null}

      {slotConflict ? (
        <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 py-16">
          <div className="w-full max-w-sm rounded-2xl border border-ivory-300 bg-ivory-50 p-6 shadow-xl">
            <Heading level={3}>You already have something planned</Heading>
            <p className="mt-2 text-navy-700">
              You already have {slotConflict.occupyingTitle} planned for {formatDayLabel(slotConflict.date)} in the{" "}
              {getPlannedMomentLabel(slotConflict.moment).toLowerCase()}.
            </p>
            <p className="mt-2 text-navy-700">Are you sure you want to add another experience at the same time?</p>
            <div className="mt-4 flex gap-2">
              <Button type="button" variant="secondary" className="flex-1" onClick={() => setSlotConflict(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                className="flex-1"
                onClick={() => {
                  slotConflict.onConfirm();
                  setSlotConflict(null);
                }}
              >
                Keep both
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {withdrawItemState.status !== "idle" ? (
        <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 py-16">
          <div className="w-full max-w-sm rounded-2xl border border-ivory-300 bg-ivory-50 p-6 shadow-xl">
            <Heading level={3}>Withdraw this request?</Heading>
            {withdrawingItem ? (
              <div className="mt-3 rounded-xl border border-ivory-300 bg-ivory-100 p-3 text-sm">
                <p className="font-display text-base text-navy-950">{withdrawingItem.recommendation.experience.title}</p>
                <p className="text-navy-700">
                  {formatDayLabel(withdrawingItem.slot.date)} · {getPlannedMomentLabel(withdrawingItem.slot.moment)}
                </p>
              </div>
            ) : null}
            <p className="mt-3 text-sm text-navy-500">
              This experience will be withdrawn, and you can choose something else for that time.
            </p>
            {withdrawItemState.status === "error" ? (
              <p className="mt-3 rounded-lg bg-gold-100 px-3 py-2 text-sm font-medium text-gold-700">
                {withdrawItemState.message}
              </p>
            ) : null}
            <div className="mt-4 flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                disabled={withdrawItemState.status === "pending"}
                onClick={() => setWithdrawItemState({ status: "idle" })}
              >
                Keep request
              </Button>
              <Button
                type="button"
                className="flex-1"
                disabled={withdrawItemState.status === "pending"}
                onClick={confirmWithdrawItem}
              >
                {withdrawItemState.status === "pending" ? "Withdrawing…" : "Withdraw request"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
