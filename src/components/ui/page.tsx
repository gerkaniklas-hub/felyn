import type { ReactNode } from "react";
import { Heading } from "./heading";

/**
 * The content frame every app page sits in, beside the AppSidebar: one
 * maximum width and one set of gutters, so page titles line up in the same
 * place as a guest moves between pages. `measure="reading"` keeps a
 * single-column page (a booking, a stay, Help) at a comfortable line length
 * while staying left-aligned with every other page's title.
 */
export function PageContainer({
  children,
  measure = "full",
  className = "",
}: {
  children: ReactNode;
  measure?: "full" | "reading";
  className?: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-8 sm:px-6 md:py-12 lg:px-12">
      <div className={`flex w-full flex-1 flex-col ${measure === "reading" ? "max-w-3xl" : ""} ${className}`}>
        {children}
      </div>
    </div>
  );
}

/** Page title block: optional eyebrow, the page-title heading, a supporting line and optional actions on the right. */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        {eyebrow ? <Eyebrow className="mb-3">{eyebrow}</Eyebrow> : null}
        <Heading level={1} id={id}>
          {title}
        </Heading>
        {description ? <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-navy-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div> : null}
    </div>
  );
}

/** The small uppercase label above a section or field group ("YOUR STAY", "WHAT TO EXPECT"). */
export function Eyebrow({
  children,
  className = "",
  as: Tag = "p",
}: {
  children: ReactNode;
  className?: string;
  as?: "p" | "h2" | "h3" | "span";
}) {
  return (
    <Tag className={`text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase ${className}`}>{children}</Tag>
  );
}

/** A calm, dashed placeholder for "nothing here yet" — message plus an optional action. */
export function EmptyState({ children, action, className = "" }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div
      className={`flex flex-col items-center gap-3 rounded-card border border-dashed border-ivory-400 bg-ivory-50/70 px-6 py-12 text-center ${className}`}
    >
      <div className="text-[15px] text-navy-600">{children}</div>
      {action}
    </div>
  );
}

/** Segmented tabs (Trips' Upcoming/Past, Experiences' Upcoming/Past/Cancelled): the track and each tab. */
export const segmentedTrackClass = "inline-flex flex-wrap gap-1 self-start rounded-full border border-ivory-300 bg-ivory-50 p-1";

export function segmentedTabClass(active: boolean): string {
  return `inline-flex h-9 items-center rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
    active ? "bg-navy-900 text-ivory-50" : "text-navy-500 hover:bg-ivory-200 hover:text-navy-900"
  }`;
}

export function segmentedCountClass(active: boolean): string {
  return `ml-1.5 text-xs ${active ? "text-ivory-200" : "text-navy-400"}`;
}

/** Text link with an arrow ("See all →", "Trip details") — one weight and color everywhere. */
export const textLinkClass = "text-sm font-medium text-sky-600 transition-colors hover:text-sky-700";
