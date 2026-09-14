import type { ReactNode } from "react";

type BadgeProps = {
  tone?: "navy" | "sky" | "gold";
  children: ReactNode;
  className?: string;
};

const tones = {
  navy: "bg-navy-100 text-navy-700",
  sky: "bg-sky-100 text-sky-700",
  gold: "bg-gold-100 text-gold-700",
} as const;

/** Small pill for tags/labels. Use "gold" tone rarely — it should read as a highlight, not a default. */
export function Badge({ tone = "navy", children, className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
